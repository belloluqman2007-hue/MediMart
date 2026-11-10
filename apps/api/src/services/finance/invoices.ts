import type { SqlExecutor } from '@medimart/database';
import type { SupplierInvoiceSummary } from '@medimart/shared';
import { ApiError } from '../../errors';

/**
 * A supplier invoice in MediMart is a purchase order with goods actually received.
 * Ordering goods never creates a payable; receiving them does. Allocations against the
 * invoice are net of reversal records.
 */
export async function listSupplierInvoices(
  db: SqlExecutor,
  supplierId: string,
  outstandingOnly = false,
): Promise<SupplierInvoiceSummary[]> {
  const rows = await db.all<{
    id: string;
    reference_number: string;
    status: SupplierInvoiceSummary['status'];
    expected_delivery_date: string | null;
    total_kobo: number;
    received_value: number;
    allocated_paid: number;
    last_receipt_date: string | null;
  }>(
    `SELECT po.id, po.reference_number, po.status, po.expected_delivery_date, po.total_kobo,
      COALESCE((
        SELECT SUM(gri.total_cost_kobo) FROM goods_receipt_items gri
        JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
        WHERE gr.purchase_order_id = po.id
      ), 0) AS received_value,
      COALESCE((
        SELECT SUM(CASE WHEN a.direction = 'apply' THEN a.amount_kobo ELSE -a.amount_kobo END)
        FROM supplier_payment_allocations a WHERE a.purchase_order_id = po.id
      ), 0) AS allocated_paid,
      (SELECT MAX(gr.received_date) FROM goods_receipts gr WHERE gr.purchase_order_id = po.id) AS last_receipt_date
    FROM purchase_orders po
    WHERE po.supplier_id = ?
    ORDER BY po.created_at ASC, po.id ASC`,
    [supplierId],
  );
  return rows
    .map((row) => {
      const received = Number(row.received_value);
      const paid = Number(row.allocated_paid);
      const outstanding = Math.max(0, received - paid);
      return {
        purchaseOrderId: row.id,
        referenceNumber: row.reference_number,
        status: row.status,
        expectedDeliveryDate: row.expected_delivery_date,
        orderedValueKobo: Number(row.total_kobo),
        receivedValueKobo: received,
        allocatedPaidKobo: paid,
        outstandingKobo: outstanding,
        lastReceiptDate: row.last_receipt_date,
        paymentStatus: outstanding === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
      } satisfies SupplierInvoiceSummary;
    })
    .filter((invoice) => invoice.receivedValueKobo > 0)
    .filter((invoice) => !outstandingOnly || invoice.outstandingKobo > 0);
}

export async function assertInvoiceOutstanding(
  db: SqlExecutor,
  supplierId: string,
  purchaseOrderId: string,
  amountKobo: number,
) {
  const invoices = await listSupplierInvoices(db, supplierId, false);
  const invoice = invoices.find((entry) => entry.purchaseOrderId === purchaseOrderId);
  if (!invoice)
    throw new ApiError(
      400,
      'INVOICE_NOT_FOUND',
      'A selected invoice does not belong to this supplier or has no received goods.',
    );
  if (amountKobo > invoice.outstandingKobo)
    throw new ApiError(
      409,
      'PAYMENT_EXCEEDS_INVOICE',
      `The allocation to ${invoice.referenceNumber} exceeds its outstanding balance of ${invoice.outstandingKobo} kobo.`,
    );
  return invoice;
}
