import type { SqlExecutor } from '@medimart/database';
import type { AuthContext } from './auth';
import { assertPermission } from './inventory/common';
import { ApiError } from '../errors';
import { audit } from './audit';

type CheckoutLine = {
  productId: string;
  baseQuantity: number;
  allocations: { movementId: string; batchId: string | null; baseQuantity: number }[];
};
/** Runs inside the existing sale transaction: no second stock deduction or second payment. */
export async function completePrescriptionCheckout(
  tx: SqlExecutor,
  auth: AuthContext,
  requestId: string,
  prescriptionId: string,
  saleId: string,
  operationId: string,
  fingerprint: string,
  lines: CheckoutLine[],
) {
  await assertPermission(tx, auth, 'prescriptions.dispense');
  const rx = (
    await tx.all<{ patient_id: string; status: string }>(
      'SELECT patient_id,status FROM prescriptions WHERE id=?',
      [prescriptionId],
    )
  )[0];
  if (!rx || !['authorized', 'partial'].includes(rx.status))
    throw new ApiError(409, 'NOT_AUTHORIZED', 'Select an authorized outstanding prescription.');
  const items = await tx.all<{
    id: string;
    product_id: string;
    quantity: number;
    dispensed: number;
  }>('SELECT id,product_id,quantity,dispensed FROM prescription_items WHERE prescription_id=?', [
    prescriptionId,
  ]);
  const dispensingId = crypto.randomUUID();
  const allocations = [];
  for (const line of lines) {
    const item = items.find((i) => i.product_id === line.productId);
    if (!item || line.baseQuantity > item.quantity - item.dispensed)
      throw new ApiError(
        409,
        'PRESCRIPTION_QUANTITY_EXCEEDED',
        'POS quantities must match prescribed medicines and cannot exceed remaining base units.',
      );
    // Prescription checkout requires traceable batches, even for non-expiry-tracked products.
    if (line.allocations.some((a) => !a.batchId))
      throw new ApiError(
        409,
        'BATCH_REQUIRED',
        'Prescription dispensing requires received, traceable batches.',
      );
    item.dispensed += line.baseQuantity;
    await tx.run('UPDATE prescription_items SET dispensed=? WHERE id=?', [item.dispensed, item.id]);
    allocations.push(
      ...line.allocations.map((a) => ({
        itemId: item.id,
        movementId: a.movementId,
        quantity: a.baseQuantity,
      })),
    );
  }
  const status = items.some((i) => i.dispensed < i.quantity) ? 'partial' : 'dispensed';
  await tx.run('UPDATE prescriptions SET status=? WHERE id=?', [status, prescriptionId]);
  await tx.run(
    'INSERT INTO prescription_dispensing(id,operation_id,fingerprint,prescription_id,patient_id,dispensed_by,dispensed_at,result_json,sale_id) VALUES(?,?,?,?,?,?,?,?,?)',
    [
      dispensingId,
      operationId,
      fingerprint,
      prescriptionId,
      rx.patient_id,
      auth.user.id,
      new Date().toISOString(),
      JSON.stringify({ id: dispensingId, saleId, status, allocations }),
      saleId,
    ],
  );
  for (const a of allocations)
    await tx.run(
      'INSERT INTO prescription_dispensing_allocations(id,dispensing_id,item_id,movement_id,quantity) VALUES(?,?,?,?,?)',
      [crypto.randomUUID(), dispensingId, a.itemId, a.movementId, a.quantity],
    );
  await audit(tx, {
    action: 'healthcare.prescription_dispensed',
    actorId: auth.user.id,
    deviceId: auth.deviceId,
    requestId,
    entityType: 'healthcare',
    entityId: prescriptionId,
    metadata: { saleId, warningsReviewed: true },
  });
}
export async function protectClinicalSaleReversal(tx: SqlExecutor, saleId: string) {
  if ((await tx.all('SELECT id FROM prescription_dispensing WHERE sale_id=?', [saleId])).length)
    throw new ApiError(
      409,
      'CLINICAL_REVIEW_REQUIRED',
      'Prescription-linked dispensing cannot be automatically returned to saleable stock. Contact the responsible healthcare professional for review.',
    );
}
