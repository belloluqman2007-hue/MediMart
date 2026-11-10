import type { Express, Request } from 'express';
import { z } from 'zod';
import type { Database, SqlExecutor, SqlRow } from '@medimart/database';
import {
  patientSchema,
  consultationSchema,
  vitalsSchema,
  prescriptionSchema,
  healthcareQuerySchema,
  sha256,
  type Patient,
  type Prescription,
  type Permission,
} from '@medimart/shared';
import { requireAuth, requirePermission } from '../middleware/security';
import type { AuthService } from '../services/auth';
import { audit } from '../services/audit';
import { ApiError } from '../errors';
import { assertPermission, loadProduct, todayIso } from '../services/inventory/common';
import { fefoAllocation, recordMovement } from '../services/inventory/stock';

const idOf = (req: Request) => z.uuid().parse(req.params.id);
const fail = (code: string, message: string, status = 409): never => {
  throw new ApiError(status, code, message);
};
const unpack = <T>(row: SqlRow) => JSON.parse(String(row.data_json)) as T;
async function patient(tx: SqlExecutor, id: string): Promise<Patient> {
  const row = (await tx.all('SELECT * FROM patients WHERE id=?', [id]))[0];
  if (!row) return fail('PATIENT_NOT_FOUND', 'Patient not found.', 404);
  return {
    ...unpack<Patient>(row),
    id,
    patientCode: String(row.patient_code),
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
  };
}
async function prescription(tx: SqlExecutor, id: string): Promise<Prescription> {
  const row = (
    await tx.all(
      'SELECT p.*,u.full_name AS prescriber_name FROM prescriptions p JOIN users u ON u.id=p.prescriber_id WHERE p.id=?',
      [id],
    )
  )[0];
  if (!row) return fail('PRESCRIPTION_NOT_FOUND', 'Prescription not found.', 404);
  const items = await tx.all(
    'SELECT * FROM prescription_items WHERE prescription_id=? ORDER BY rowid',
    [id],
  );
  return {
    ...unpack<Prescription>(row),
    id,
    prescriberId: String(row.prescriber_id),
    prescriberName: String(row.prescriber_name),
    status: row.status as Prescription['status'],
    authorizedBy: row.authorized_by as string | null,
    cancellationReason: row.cancellation_reason as string | null,
    items: items.map((i) => ({
      ...unpack<Prescription['items'][number]>(i),
      id: String(i.id),
      dispensed: Number(i.dispensed),
    })),
  };
}
async function warnings(tx: SqlExecutor, rx: Prescription) {
  const p = await patient(tx, rx.patientId);
  const productWarnings = await tx.all<{ name: string; description: string | null }>(
    `SELECT name,clinical_warning AS description FROM products WHERE id IN (${rx.items.map(() => '?').join(',')})`,
    rx.items.map((i) => i.productId),
  );
  return {
    allergies: p.allergies,
    conditions: p.conditions,
    medicalHistory: p.medicalHistory,
    medicineWarnings: productWarnings,
    notice:
      'Review all allergies, conditions, interactions and medicine information. This is not an automated interaction checker or clinical decision.',
  };
}
const event = (
  tx: SqlExecutor,
  req: Request,
  action: string,
  entityId?: string,
  metadata?: Record<string, string | number | boolean | string[]>,
) =>
  audit(tx, {
    action: `healthcare.${action}`,
    actorId: req.auth!.user.id,
    deviceId: req.auth!.deviceId,
    requestId: req.requestId,
    entityType: 'healthcare',
    entityId,
    metadata,
  });
async function professional(tx: SqlExecutor, req: Request) {
  const rows = await tx.all(
    `SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id=r.id WHERE ur.user_id=? AND r.code='healthcare_professional'`,
    [req.auth!.user.id],
  );
  if (!rows.length)
    fail(
      'PROFESSIONAL_REQUIRED',
      'A healthcare-professional role is required. Administrative access is not clinical authorization.',
      403,
    );
}
export function registerHealthcareRoutes(app: Express, db: Database, auth: AuthService) {
  const guard = (p: Permission) => [requireAuth(auth), requirePermission(p)];
  const read = async <T>(
    req: Request,
    permission: Permission,
    action: string,
    work: (tx: SqlExecutor) => Promise<T>,
    id?: string,
  ) =>
    db.transaction(async (tx) => {
      await assertPermission(tx, req.auth!, permission);
      const result = await work(tx);
      await event(tx, req, action, id);
      return result;
    });
  app.get('/api/patients', ...guard('patients.view'), async (req, res) => {
    const q = healthcareQuerySchema.parse(req.query);
    res.json(
      await read(req, 'patients.view', 'patients_viewed', async (tx) => {
        const rows = await tx.all(
          `SELECT * FROM patients WHERE (full_name LIKE ? OR phone_normalized LIKE ? OR patient_code LIKE ?) AND (? IS NULL OR date(registered_at)>=?) AND (? IS NULL OR date(registered_at)<=?) ORDER BY registered_at DESC,id LIMIT 50 OFFSET ?`,
          [
            `%${q.search}%`,
            `%${q.search.replace(/\D/g, '') || q.search}%`,
            `%${q.search}%`,
            q.from ?? null,
            q.from ?? null,
            q.to ?? null,
            q.to ?? null,
            (q.page - 1) * 50,
          ],
        );
        return {
          items: await Promise.all(rows.map((r) => patient(tx, String(r.id)))),
          page: q.page,
        };
      }),
    );
  });
  for (const edit of [false, true]) {
    app[edit ? 'put' : 'post'](
      edit ? '/api/patients/:id' : '/api/patients',
      ...guard(edit ? 'patients.edit' : 'patients.register'),
      async (req, res) => {
        const input = patientSchema.parse(req.body);
        const id = edit ? idOf(req) : crypto.randomUUID();
        const result = await db.transaction(async (tx) => {
          await assertPermission(tx, req.auth!, edit ? 'patients.edit' : 'patients.register');
          if (edit) await patient(tx, id);
          if (
            input.customerId &&
            !(
              await tx.all('SELECT id FROM customers WHERE id=? AND deleted_at IS NULL', [
                input.customerId,
              ])
            ).length
          )
            fail('CUSTOMER_NOT_FOUND', 'Linked customer account not found.', 400);
          const normalized = input.phone.replace(/\D/g, '');
          const duplicates = await tx.all(
            `SELECT id FROM patients WHERE id<>? AND ((?<>'' AND phone_normalized=?) OR lower(full_name)=lower(?))`,
            [id, normalized, normalized, input.fullName],
          );
          if (duplicates.length && input.duplicateReason.length < 5)
            fail(
              'POSSIBLE_DUPLICATE',
              'Possible duplicate patient. Search existing records; enter a reason to register or save a distinct patient.',
            );
          const now = new Date().toISOString();
          if (edit)
            await tx.run(
              'UPDATE patients SET full_name=?,phone=?,phone_normalized=?,date_of_birth=?,customer_id=?,data_json=?,updated_at=? WHERE id=?',
              [
                input.fullName,
                input.phone,
                normalized,
                input.dateOfBirth,
                input.customerId,
                JSON.stringify(input),
                now,
                id,
              ],
            );
          else
            await tx.run(
              'INSERT INTO patients(id,patient_code,full_name,phone,phone_normalized,date_of_birth,customer_id,data_json,registered_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
              [
                id,
                `PAT-${id.toUpperCase()}`,
                input.fullName,
                input.phone,
                normalized,
                input.dateOfBirth,
                input.customerId,
                JSON.stringify(input),
                now,
                now,
              ],
            );
          await event(tx, req, edit ? 'patient_updated' : 'patient_registered', id, {
            changedFields: Object.keys(input),
            duplicateOverride: duplicates.length > 0,
          });
          return patient(tx, id);
        });
        res.status(edit ? 200 : 201).json(result);
      },
    );
  }
  app.get('/api/patients/:id', ...guard('patients.view'), async (req, res) => {
    const id = idOf(req);
    res.json(
      await read(
        req,
        'patients.view',
        'profile_viewed',
        async (tx) => {
          const result: Record<string, unknown> = { patient: await patient(tx, id) };
          if (req.auth!.user.permissions.includes('consultations.view')) {
            result.consultations = (
              await tx.all(
                'SELECT data_json FROM consultations WHERE patient_id=? ORDER BY consulted_at DESC',
                [id],
              )
            ).map((r) => unpack(r));
            result.vitals = (
              await tx.all(
                'SELECT data_json FROM patient_vitals WHERE patient_id=? ORDER BY measured_at DESC',
                [id],
              )
            ).map((r) => unpack(r));
          }
          if (req.auth!.user.permissions.includes('prescriptions.view'))
            result.prescriptions = await Promise.all(
              (
                await tx.all(
                  'SELECT id FROM prescriptions WHERE patient_id=? ORDER BY prescribed_at DESC',
                  [id],
                )
              ).map((r) => prescription(tx, String(r.id))),
            );
          return result;
        },
        id,
      ),
    );
  });
  app.post('/api/patients/:id/vitals', ...guard('vitals.record'), async (req, res) => {
    const patientId = idOf(req),
      input = vitalsSchema.parse(req.body);
    res.status(201).json(
      await db.transaction(async (tx) => {
        await assertPermission(tx, req.auth!, 'vitals.record');
        await patient(tx, patientId);
        const value = {
          ...input,
          id: crypto.randomUUID(),
          patientId,
          recordedBy: req.auth!.user.id,
          bmi:
            input.weight !== null && input.height !== null
              ? Math.round((input.weight / (input.height / 100) ** 2) * 10) / 10
              : null,
        };
        await tx.run(
          'INSERT INTO patient_vitals(id,patient_id,recorded_by,measured_at,data_json) VALUES(?,?,?,?,?)',
          [value.id, patientId, value.recordedBy, input.measuredAt, JSON.stringify(value)],
        );
        await event(tx, req, 'vitals_recorded', patientId);
        return value;
      }),
    );
  });
  app.post('/api/consultations', ...guard('consultations.create'), async (req, res) => {
    const input = consultationSchema.parse(req.body);
    res.status(201).json(
      await db.transaction(async (tx) => {
        await assertPermission(tx, req.auth!, 'consultations.create');
        await professional(tx, req);
        await patient(tx, input.patientId);
        const value = {
          ...input,
          id: crypto.randomUUID(),
          professionalId: req.auth!.user.id,
          professionalName: req.auth!.user.fullName,
        };
        await tx.run(
          'INSERT INTO consultations(id,patient_id,professional_id,consulted_at,data_json) VALUES(?,?,?,?,?)',
          [
            value.id,
            input.patientId,
            value.professionalId,
            input.consultedAt,
            JSON.stringify(value),
          ],
        );
        await event(tx, req, 'consultation_created', value.id);
        return value;
      }),
    );
  });
  app.get('/api/consultations', ...guard('consultations.view'), async (req, res) => {
    const q = healthcareQuerySchema.parse(req.query);
    res.json(
      await read(req, 'consultations.view', 'consultations_viewed', async (tx) => ({
        items: (
          await tx.all(
            `SELECT c.data_json FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE (? IS NULL OR c.patient_id=?) AND (? IS NULL OR date(consulted_at)>=?) AND (? IS NULL OR date(consulted_at)<=?) AND (p.full_name LIKE ? OR p.patient_code LIKE ?) ORDER BY consulted_at DESC LIMIT 50 OFFSET ?`,
            [
              q.patientId ?? null,
              q.patientId ?? null,
              q.from ?? null,
              q.from ?? null,
              q.to ?? null,
              q.to ?? null,
              `%${q.search}%`,
              `%${q.search}%`,
              (q.page - 1) * 50,
            ],
          )
        ).map((r) => unpack(r)),
        page: q.page,
      })),
    );
  });
  const saveRx = async (req: Request, edit: boolean) => {
    const input = prescriptionSchema.parse(req.body),
      id = edit ? idOf(req) : crypto.randomUUID();
    return db.transaction(async (tx) => {
      await assertPermission(tx, req.auth!, 'prescriptions.create');
      await professional(tx, req);
      await patient(tx, input.patientId);
      if (edit) {
        const old = await prescription(tx, id);
        if (old.status !== 'draft' || old.prescriberId !== req.auth!.user.id)
          fail('DRAFT_REQUIRED', 'Only the original prescriber may edit their draft.');
      }
      if (
        input.consultationId &&
        !(
          await tx.all('SELECT id FROM consultations WHERE id=? AND patient_id=?', [
            input.consultationId,
            input.patientId,
          ])
        ).length
      )
        fail('CONSULTATION_MISMATCH', 'Consultation does not belong to this patient.', 400);
      const items = [];
      for (const i of input.items) {
        const product = await loadProduct(tx, i.productId);
        if (product.product_type !== 'medicine' || product.status !== 'active')
          fail('MEDICINE_REQUIRED', 'Select an active medicine.', 400);
        items.push({ ...i, id: crypto.randomUUID(), medicineName: product.name, dispensed: 0 });
      }
      if (edit) {
        await tx.run('DELETE FROM prescription_items WHERE prescription_id=?', [id]);
        await tx.run(
          'UPDATE prescriptions SET patient_id=?,consultation_id=?,prescribed_at=?,data_json=? WHERE id=?',
          [input.patientId, input.consultationId, input.prescribedAt, JSON.stringify(input), id],
        );
      } else
        await tx.run(
          "INSERT INTO prescriptions(id,patient_id,consultation_id,prescriber_id,prescribed_at,status,data_json) VALUES(?,?,?,?,?,'draft',?)",
          [
            id,
            input.patientId,
            input.consultationId,
            req.auth!.user.id,
            input.prescribedAt,
            JSON.stringify(input),
          ],
        );
      for (const i of items)
        await tx.run(
          'INSERT INTO prescription_items(id,prescription_id,product_id,quantity,data_json) VALUES(?,?,?,?,?)',
          [i.id, id, i.productId, i.quantity, JSON.stringify(i)],
        );
      await event(tx, req, edit ? 'prescription_updated' : 'prescription_created', id);
      return {
        prescription: await prescription(tx, id),
        warnings: await warnings(tx, { ...input, items } as Prescription),
      };
    });
  };
  app.post('/api/prescriptions', ...guard('prescriptions.create'), async (req, res) =>
    res.status(201).json(await saveRx(req, false)),
  );
  app.put('/api/prescriptions/:id', ...guard('prescriptions.create'), async (req, res) =>
    res.json(await saveRx(req, true)),
  );
  app.get('/api/prescriptions', ...guard('prescriptions.view'), async (req, res) => {
    const q = healthcareQuerySchema.parse(req.query);
    res.json(
      await read(req, 'prescriptions.view', 'prescriptions_viewed', async (tx) => {
        const rows = await tx.all(
          `SELECT r.id FROM prescriptions r JOIN patients p ON p.id=r.patient_id WHERE (? IS NULL OR r.patient_id=?) AND (? IS NULL OR date(prescribed_at)>=?) AND (? IS NULL OR date(prescribed_at)<=?) AND (? IS NULL OR r.status=? OR (?='outstanding' AND r.status IN ('authorized','partial'))) AND (p.full_name LIKE ? OR p.patient_code LIKE ?) ORDER BY prescribed_at DESC LIMIT 50 OFFSET ?`,
          [
            q.patientId ?? null,
            q.patientId ?? null,
            q.from ?? null,
            q.from ?? null,
            q.to ?? null,
            q.to ?? null,
            q.status ?? null,
            q.status ?? null,
            q.status ?? null,
            `%${q.search}%`,
            `%${q.search}%`,
            (q.page - 1) * 50,
          ],
        );
        return {
          items: await Promise.all(rows.map((r) => prescription(tx, String(r.id)))),
          page: q.page,
        };
      }),
    );
  });
  app.get('/api/prescriptions/:id', ...guard('prescriptions.view'), async (req, res) =>
    res.json(
      await read(
        req,
        'prescriptions.view',
        'prescription_viewed',
        async (tx) => {
          const rx = await prescription(tx, idOf(req));
          const person = await patient(tx, rx.patientId);
          return {
            prescription: rx,
            patient: {
              id: person.id,
              fullName: person.fullName,
              patientCode: person.patientCode,
              dateOfBirth: person.dateOfBirth,
              age: person.age,
            },
            warnings: await warnings(tx, rx),
            dispensing: await tx.all(
              'SELECT id,dispensed_by,dispensed_at,result_json FROM prescription_dispensing WHERE prescription_id=? ORDER BY dispensed_at DESC',
              [rx.id],
            ),
          };
        },
        idOf(req),
      ),
    ),
  );
  app.post(
    '/api/prescriptions/:id/authorize',
    ...guard('prescriptions.authorize'),
    async (req, res) => {
      z.object({ reviewedWarnings: z.literal(true) })
        .strict()
        .parse(req.body);
      res.json(
        await db.transaction(async (tx) => {
          await assertPermission(tx, req.auth!, 'prescriptions.authorize');
          await professional(tx, req);
          const rx = await prescription(tx, idOf(req));
          if (rx.status !== 'draft') fail('DRAFT_REQUIRED', 'Only a draft may be authorized.');
          if (rx.prescriberId !== req.auth!.user.id)
            fail(
              'PRESCRIBER_REQUIRED',
              'The responsible prescriber must authorize their prescription.',
              403,
            );
          await tx.run("UPDATE prescriptions SET status='authorized',authorized_by=? WHERE id=?", [
            req.auth!.user.id,
            rx.id,
          ]);
          await event(tx, req, 'prescription_authorized', rx.id, { warningsReviewed: true });
          return prescription(tx, rx.id);
        }),
      );
    },
  );
  app.post('/api/prescriptions/:id/cancel', ...guard('prescriptions.cancel'), async (req, res) => {
    const { reason } = z
      .object({ reason: z.string().trim().min(5).max(500) })
      .strict()
      .parse(req.body);
    res.json(
      await db.transaction(async (tx) => {
        await assertPermission(tx, req.auth!, 'prescriptions.cancel');
        await professional(tx, req);
        const rx = await prescription(tx, idOf(req));
        if (['dispensed', 'cancelled'].includes(rx.status))
          fail('STATUS_CONFLICT', 'This prescription cannot be cancelled.');
        await tx.run(
          "UPDATE prescriptions SET status='cancelled',cancellation_reason=? WHERE id=?",
          [reason, rx.id],
        );
        await event(tx, req, 'prescription_cancelled', rx.id);
        return prescription(tx, rx.id);
      }),
    );
  });
  app.get('/api/healthcare/medicines', ...guard('prescriptions.view'), async (req, res) => {
    const q = healthcareQuerySchema.parse(req.query);
    const prescriptionId = z.uuid().optional().parse(req.query.prescriptionId);
    const rows = await db.all(
      `SELECT id,name,generic_name,clinical_warning AS warnings FROM products WHERE product_type='medicine' AND status='active' AND deleted_at IS NULL AND (name LIKE ? OR generic_name LIKE ?) AND (? IS NULL OR id IN (SELECT product_id FROM prescription_items WHERE prescription_id=?)) ORDER BY name LIMIT 50`,
      [`%${q.search}%`, `%${q.search}%`, prescriptionId ?? null, prescriptionId ?? null],
    );
    res.json({
      items: await Promise.all(
        rows.map(async (r) => {
          const batches = await db.all(
            'SELECT id,batch_number,expiry_date,quantity_remaining FROM product_batches WHERE product_id=? ORDER BY (expiry_date IS NULL),expiry_date',
            [String(r.id)],
          );
          return {
            ...r,
            strength: null,
            batches,
            available: batches.reduce(
              (sum, b) =>
                sum +
                (!b.expiry_date || String(b.expiry_date) >= todayIso()
                  ? Number(b.quantity_remaining)
                  : 0),
              0,
            ),
          };
        }),
      ),
    });
  });
  app.put(
    '/api/healthcare/medicines/:id/warning',
    ...guard('prescriptions.create'),
    async (req, res) => {
      const { warning } = z
        .object({ warning: z.string().trim().max(4000) })
        .strict()
        .parse(req.body);
      const productId = idOf(req);
      await db.transaction(async (tx) => {
        await assertPermission(tx, req.auth!, 'prescriptions.create');
        await professional(tx, req);
        const product = await loadProduct(tx, productId);
        if (product.product_type !== 'medicine')
          fail('MEDICINE_REQUIRED', 'Select a medicine.', 400);
        await tx.run('UPDATE products SET clinical_warning=? WHERE id=?', [
          warning || null,
          productId,
        ]);
        await event(tx, req, 'medicine_warning_updated', productId);
      });
      res.json({ saved: true });
    },
  );
  app.post(
    '/api/prescriptions/:id/dispense',
    ...guard('prescriptions.dispense'),
    async (req, res) => {
      const input = z
        .object({
          operationId: z.uuid(),
          reviewedWarnings: z.literal(true),
          items: z
            .array(
              z
                .object({ itemId: z.uuid(), quantity: z.number().int().positive().max(1000000) })
                .strict(),
            )
            .min(1)
            .max(30),
        })
        .strict()
        .parse(req.body);
      const rxId = idOf(req);
      const fingerprint = await sha256(
        JSON.stringify({
          rxId,
          items: [...input.items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
        }),
      );
      res.json(
        await db.transaction(async (tx) => {
          await assertPermission(tx, req.auth!, 'prescriptions.dispense');
          const prior = (
            await tx.all('SELECT * FROM prescription_dispensing WHERE operation_id=?', [
              input.operationId,
            ])
          )[0];
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              fail('OPERATION_CONFLICT', 'Operation ID already used with different quantities.');
            await event(tx, req, 'dispensing_replayed', rxId);
            return JSON.parse(String(prior.result_json));
          }
          const rx = await prescription(tx, rxId);
          if (!['authorized', 'partial'].includes(rx.status))
            fail('NOT_AUTHORIZED', 'Only an authorized outstanding prescription may be dispensed.');
          if (new Set(input.items.map((i) => i.itemId)).size !== input.items.length)
            fail('DUPLICATE_ITEM', 'Duplicate dispensing item.', 400);
          const dispensingId = crypto.randomUUID();
          const allocations = [];
          for (const requested of input.items) {
            const item = rx.items.find((i) => i.id === requested.itemId);
            if (!item || requested.quantity > item.quantity - item.dispensed)
              fail(
                'QUANTITY_EXCEEDED',
                'Quantity exceeds the remaining prescription quantity.',
                400,
              );
            const actual = item!;
            const product = await loadProduct(tx, actual.productId);
            if (product.status !== 'active')
              fail('INACTIVE_MEDICINE', 'Inactive medicine cannot be dispensed.');
            const plan = await fefoAllocation(tx, actual.productId, requested.quantity);
            if (plan.allocatableQuantity < requested.quantity)
              fail(
                'INSUFFICIENT_UNEXPIRED_STOCK',
                'Insufficient non-expired batched stock. Receive valid batches before dispensing.',
              );
            for (const allocation of plan.allocations) {
              const batch = (
                await tx.all<{ purchase_cost_kobo: number }>(
                  'SELECT purchase_cost_kobo FROM product_batches WHERE id=?',
                  [allocation.batchId],
                )
              )[0]!;
              const movement = await recordMovement(
                tx,
                { auth: req.auth!, requestId: req.requestId },
                {
                  productId: actual.productId,
                  batchId: allocation.batchId,
                  movementType: 'adjustment_decrease',
                  delta: -allocation.quantity,
                  unitCostKobo: batch.purchase_cost_kobo,
                  reason: 'Prescription dispensing',
                  referenceId: rx.id,
                  supplierId: null,
                  operationId: null,
                  operationFingerprint: '',
                  baseQuantity: allocation.quantity,
                },
              );
              allocations.push({
                itemId: actual.id,
                movementId: movement.movement.id,
                batchId: allocation.batchId,
                quantity: allocation.quantity,
              });
            }
            await tx.run('UPDATE prescription_items SET dispensed=dispensed+? WHERE id=?', [
              requested.quantity,
              actual.id,
            ]);
          }
          const remaining = (
            await tx.all<{ remaining: number }>(
              'SELECT SUM(quantity-dispensed) AS remaining FROM prescription_items WHERE prescription_id=?',
              [rx.id],
            )
          )[0]!.remaining;
          await tx.run('UPDATE prescriptions SET status=? WHERE id=?', [
            remaining > 0 ? 'partial' : 'dispensed',
            rx.id,
          ]);
          const result = {
            id: dispensingId,
            prescription: await prescription(tx, rx.id),
            allocations,
          };
          await tx.run(
            'INSERT INTO prescription_dispensing(id,operation_id,fingerprint,prescription_id,patient_id,dispensed_by,dispensed_at,result_json) VALUES(?,?,?,?,?,?,?,?)',
            [
              dispensingId,
              input.operationId,
              fingerprint,
              rx.id,
              rx.patientId,
              req.auth!.user.id,
              new Date().toISOString(),
              JSON.stringify(result),
            ],
          );
          for (const a of allocations)
            await tx.run(
              'INSERT INTO prescription_dispensing_allocations(id,dispensing_id,item_id,movement_id,quantity) VALUES(?,?,?,?,?)',
              [crypto.randomUUID(), dispensingId, a.itemId, a.movementId, a.quantity],
            );
          await event(tx, req, 'prescription_dispensed', rx.id, { warningsReviewed: true });
          return result;
        }),
      );
    },
  );
  app.get('/api/healthcare/reports', ...guard('patients.reports'), async (req, res) => {
    const q = healthcareQuerySchema.parse(req.query);
    res.json(
      await read(req, 'patients.reports', 'reports_viewed', async (tx) => {
        const filters = [
          q.patientId ?? null,
          q.patientId ?? null,
          q.from ?? null,
          q.from ?? null,
          q.to ?? null,
          q.to ?? null,
        ];
        const counts: Record<string, number> = {};
        for (const [name, table, dateColumn, patientColumn, extra] of [
          ['registeredPatients', 'patients', 'registered_at', 'id', '1=1'],
          ['consultations', 'consultations', 'consulted_at', 'patient_id', '1=1'],
          [
            'prescriptionsIssued',
            'prescriptions',
            'prescribed_at',
            'patient_id',
            "status<>'draft' AND status<>'cancelled'",
          ],
          ['dispensed', 'prescriptions', 'prescribed_at', 'patient_id', "status='dispensed'"],
          ['partial', 'prescriptions', 'prescribed_at', 'patient_id', "status='partial'"],
          [
            'outstanding',
            'prescriptions',
            'prescribed_at',
            'patient_id',
            "status IN ('authorized','partial')",
          ],
        ]) {
          const row = (
            await tx.all<{ count: number }>(
              `SELECT COUNT(*) AS count FROM ${table} WHERE (? IS NULL OR ${patientColumn}=?) AND (? IS NULL OR date(${dateColumn})>=?) AND (? IS NULL OR date(${dateColumn})<=?) AND ${extra}`,
              filters,
            )
          )[0]!;
          counts[name!] = row.count;
        }
        return counts;
      }),
    );
  });
}
