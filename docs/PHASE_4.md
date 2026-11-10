# Phase 4 — Patient management, consultations and prescriptions

## Scope and architecture

Continues commit `a730f2b` (the latest main at the start of this work). No project replacement, database reset, production-data access, or Phase 5 functionality. Uses the existing Express application, SQLite adapter/serialized transactions, additive checksum-verified migrations, shared Zod contracts, cookie/CSRF or bearer authentication, live permission checks, audit service, React workspace, inventory FEFO allocator and stock ledger.

Clinical records are central-server-only. They are not stored in the service-worker cache or sent through the generic unimplemented synchronization outbox. Roles are clinic-wide in this existing single-business application: authorized clinicians may access the clinic's patient records; there is no patient self-service API or new multi-tenant ownership model.

## Features

- Patient registration with unique `PAT-<UUID>` identifiers, birth date or reported age, personal details, emergency contact, medical history, allergies, conditions and notes.
- Search by name, normalized phone or patient code; edit and audited access. Matching name or normalized phone produces a duplicate conflict. A documented distinct-patient reason permits intentional overrides. Customer payment accounts are optional links, never patient identifiers.
- Patient profiles with newest-first consultations, recorded vital signs and prescription/medication history.
- Professional consultation workspace with date/time, complaints/history, examination, impression, plan, follow-up and responsible professional. No diagnosis generation or treatment recommendations.
- Nullable vital measurements with explicit units/time, paired BP validation, range checks and BMI when weight and height are present. Unmeasured values stay null; BMI requires professional interpretation, particularly in children/pregnancy.
- Professional prescription drafts, original-prescriber editing and authorization, cancellation reason, patient/consultation consistency checks, printable identity/medicine instructions and status history.
- Allergy, condition, relevant medical-history and catalogue medicine-warning review. Professionals can maintain catalogue-wide medicine clinical warnings. There is no automated allergy cross-reactivity, interaction or dosage decision engine.
- Catalogue/batch availability, expiry visibility, direct stock-only dispensing, remaining quantities and partial/full status.
- Prescription-linked existing POS checkout: load remaining medicines into the cart, adjust quantities for partial dispensing, review warnings, use existing payments/credit and complete sale plus prescription dispensing atomically. Payment-account selection remains explicit and independent of patient identity.
- Registered-patient, consultation, issued/fully dispensed/partially dispensed/outstanding-prescription counts with patient/date filters, plus searchable consultation/prescription history. Reports default to today; prescription counts filter by prescription issue date (not dispensing-event date).
- Responsive healthcare navigation and permission boundaries, preserving the existing workspace controls and POS/inventory design.

## Migration 9

`patients_consultations_prescriptions_dispensing` in `packages/database/src/migrations-healthcare.ts`:

- Adds nullable `products.clinical_warning` without changing existing products.
- Adds `patients`, `consultations`, `patient_vitals`, `prescriptions`, `prescription_items`, `prescription_dispensing` and `prescription_dispensing_allocations`.
- Adds patient/name/phone/history indexes, foreign keys, quantity/status/JSON constraints and healthcare capability grants.
- Leaves migrations 1–8 and their checksums unchanged. Existing stock, customers, debts, payments, sales and accounts are preserved.

Back up the existing database using the established operational procedure before applying migrations. Run `npm run db:migrate` through the existing release process. Do not point test fixtures at a real application database.

## API endpoints

All endpoints require authenticated access and the listed capability; mutations retain existing CSRF/origin protection. Healthcare reads and important writes are audited without putting clinical contents into application logs or audit metadata.

| Method | Endpoint                                                                     | Capability                                                            |
| ------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/api/patients`                                                              | `patients.view`                                                       |
| POST   | `/api/patients`                                                              | `patients.register`                                                   |
| GET    | `/api/patients/:id`                                                          | `patients.view`                                                       |
| PUT    | `/api/patients/:id`                                                          | `patients.edit`                                                       |
| POST   | `/api/patients/:id/vitals`                                                   | `vitals.record`                                                       |
| GET    | `/api/consultations`                                                         | `consultations.view`                                                  |
| POST   | `/api/consultations`                                                         | `consultations.create` + professional role                            |
| GET    | `/api/prescriptions`                                                         | `prescriptions.view`                                                  |
| POST   | `/api/prescriptions`                                                         | `prescriptions.create` + professional role                            |
| GET    | `/api/prescriptions/:id`                                                     | `prescriptions.view`                                                  |
| PUT    | `/api/prescriptions/:id`                                                     | `prescriptions.create` + original professional prescriber; draft only |
| POST   | `/api/prescriptions/:id/authorize`                                           | `prescriptions.authorize` + original professional prescriber          |
| POST   | `/api/prescriptions/:id/cancel`                                              | `prescriptions.cancel` + professional role                            |
| POST   | `/api/prescriptions/:id/dispense`                                            | `prescriptions.dispense`                                              |
| GET    | `/api/healthcare/medicines`                                                  | `prescriptions.view`                                                  |
| PUT    | `/api/healthcare/medicines/:id/warning`                                      | `prescriptions.create` + professional role                            |
| GET    | `/api/healthcare/reports`                                                    | `patients.reports`                                                    |
| POST   | Existing `/api/sales`, optional `prescription: {id, reviewedWarnings: true}` | Existing sale/payment permissions + `prescriptions.dispense`          |

List endpoints accept `search`, `patientId` where applicable, `from`, `to`, `page`; pages hold up to 50 records. Prescription lists also accept `status`, including `outstanding` (authorized or partial).

Dispensing body: `{operationId, reviewedWarnings: true, items: [{itemId, quantity}]}`. Quantities are positive integer inventory **base units**. The server checks prescription membership, authorization, remaining quantities and non-expired batched availability. Operation IDs are mandatory UUIDs: identical replays return the original result; changed payloads conflict.

## Permissions and privacy

New capabilities: `patients.register`, `patients.edit`, `consultations.create`, `vitals.record`, `prescriptions.create`, `prescriptions.authorize`, `prescriptions.dispense`, `prescriptions.cancel`, `patients.reports`. Existing view permissions are reused.

- Owner/administrator receive operational capability grants so existing staff-provisioning anti-escalation rules still work. These grants **do not** make an owner/administrator a clinical professional: consultation creation, prescription creation/authorization/cancellation and medicine-warning changes also check the live `healthcare_professional` role.
- Healthcare professionals receive registration/editing, consultation, vital-sign, prescribing and patient-report access. They do not receive inventory-management permissions or dispensing simply by being clinicians.
- Pharmacists receive dispensing and existing patient/prescription-view access, not consultation history or consultation/vital creation. A staff member can hold both professional and pharmacist roles after qualification checks.
- Cashiers, storekeepers and managers receive no additional clinical access. Cashiers cannot use a prescription-linked POS sale to bypass dispensing permissions.
- Qualification/registration verification remains the clinic's responsibility before assigning the professional role. Software roles do not verify professional licensing.
- Patient-profile responses omit consultation/vital history when the caller lacks `consultations.view`. Customer receipts and financial records do not acquire consultation notes.
- Patient access, registration, updates, consultations, vital signs, prescription edits/authorization/cancellation, warning changes, dispensing/replays and reports are audited. Audit metadata records actors, identifiers and changed field names, not submitted medical text.

## Stock and financial invariants

Creating, editing or authorizing a prescription never deducts stock. Direct dispensing reuses FEFO and `recordMovement` within one serialized SQLite transaction. Its ledger classification is the existing `adjustment_decrease`, with a prescription reference and batch cost; it is a stock-only clinical issue, not a fictitious sale. All allocations link dispensing, prescription item and immutable stock movement.

For paid dispensing, use the **Dispense and pay through POS** link _before_ issuing stock. Existing sale allocations are linked to prescription dispensing in that same transaction: there is no second movement, payment or receipt. A retry uses existing sale idempotency. Ordinary POS/sale/customer/debt behavior is unchanged.

Both paths require traceable received batches. Insufficient/expired-only stock, unapproved/cancelled prescriptions, extra items and excess quantities fail atomically. Never create an ordinary POS sale for stock already issued through direct dispensing.

For safety, automatic void/refund restocking of the **new prescription-linked sales** is blocked pending professional review. An issued medication is not automatically made saleable again. A dedicated clinically reviewed return/reversal workflow is not included in this phase; existing non-prescription sale reversals remain unchanged and tested.

## Verification and screenshots

See `docs/PHASE_4_VERIFICATION.md` for final executed results. Browser screenshots in `docs/screenshots/phase4-*.png` contain only explicitly synthetic data and are generated by the Phase 4 Playwright journey. Production verification here means the compiled application and disposable SQLite database in the sandbox, not a deployed production patient database or a Vercel deployment.

## Limitations / operational review

- Professional licensing checks, clinical governance and prescribing legality must be reviewed by the clinic before live use.
- Warning notes are professional-maintained, not an exhaustive licensed drug-information database or automated clinical decision support.
- POS checkout deliberately keeps customer payment identity separate; it does not automatically assign a patient to an unrelated customer account.
- Prescription-linked return/void review workflow is not implemented; automatic restocking is safely blocked as described above.
- Clinical offline sync, patient self-service, attachments, billing for consultations and Phase 5 are not implemented.
