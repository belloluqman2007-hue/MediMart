# API reference (Phases 1–6, verified against the routes in Phase 7)

Base path: `/api`. All important write inputs use strict shared Zod schemas. Send
`Content-Type: application/json`; request-body limit is 64 KiB. Responses are
`Cache-Control: no-store`. Money is always **integer kobo**. Every table below was checked against
the route registrations in `apps/api/src/app.ts` and `apps/api/src/routes/*.ts` — where this
document and the code disagree, the code wins and the document is the bug.

## Authentication transports

**Browser:** the API sets an HttpOnly `medimart_session` cookie, path `/api`, SameSite Strict,
Secure in production. `login`, `register-owner` and `session` responses contain a `csrfToken`, but
never the raw session token. Put that value in `X-CSRF-Token` for every authenticated write. Keep it
in memory, not browser storage.

**Native (Android):** `login` must include approved `{ id, secret }` device proof. The response
contains an opaque token for `Authorization: Bearer <token>`, stored only in native secure storage
(Android Keystore-backed). A bearer token cannot be substituted as a browser cookie. Native
sessions remain tied to the approved device and staff account; revoking the device ends them.

State-changing origin checks apply independently of permissions. No frontend navigation check
replaces a backend permission check.

## Core endpoints

| Method / path                | Access                                                    | Purpose                                                                      |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /health`                | Public                                                    | SQLite/API health: `{ status, database, phase: 6, sync: 'offline_capture' }` |
| `GET /auth/bootstrap-status` | Public                                                    | Whether an initial owner is needed and setup is enabled                      |
| `POST /auth/register-owner`  | Valid setup token; no users exist                         | Create the one initial owner and a browser session                           |
| `POST /auth/login`           | Valid credentials; device proof for native bearer session | Sign in                                                                      |
| `GET /auth/session`          | Authenticated                                             | Current profile, live permissions, expiry; browser CSRF token                |
| `POST /auth/change-password` | Authenticated + current password                          | Change own password and revoke all sessions                                  |
| `POST /auth/logout`          | Authenticated                                             | Revoke the current session                                                   |
| `POST /auth/logout-all`      | Authenticated                                             | Revoke all sessions for the current account                                  |
| `GET /staff`                 | `staff.view`                                              | Up to 100 staff summaries; never password hashes                             |
| `POST /staff`                | `staff.manage` + delegation rules                         | Register an individual staff account                                         |
| `GET /permissions`           | `permissions.view`                                        | Seeded roles and their current capability grants                             |
| `POST /devices/register`     | Installation UUID + generated secret; rate-limited        | Register/renew an unapproved installation; return pairing challenge          |
| `POST /devices/status`       | Installation ID + secret proof                            | Get pairing status; no secrets returned                                      |
| `GET /devices`               | `devices.manage`                                          | Up to 100 registration summaries; no codes/hashes/secrets                    |
| `POST /devices/:id/approve`  | `devices.manage` + matching unexpired code                | Approve the physical device                                                  |
| `POST /devices/:id/revoke`   | `devices.manage`                                          | Revoke installation and its sessions                                         |
| `GET /settings`              | `settings.view`                                           | Business-name setting                                                        |
| `PUT /settings`              | `settings.manage`                                         | Save business name transactionally with an audit entry                       |
| `GET /audit-logs?limit=50`   | `audit.view`                                              | Read up to 100 immutable event records                                       |

Unknown API paths return a JSON 404, not the SPA HTML.

## Inventory endpoints (Phase 2)

`registerInventoryRoutes` mounts these under `/api`. Every route requires an authenticated session
**and** the listed permission; the checks run on the server, so hiding UI is never the control.

| Method / path                                                                  | Access                                                 | Purpose                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `GET /inventory/dashboard`                                                     | `inventory.view`                                       | Counts, stock value (batch acquisition cost) vs retail value, alerts |
| `GET /inventory/alerts`                                                        | `inventory.view`                                       | Expired and near-expiry batches within the alert window              |
| `GET /inventory/settings`                                                      | `inventory.view`                                       | Expiry alert window                                                  |
| `PUT /inventory/settings`                                                      | `inventory.settings.manage`                            | Save the alert window (1–365 days) with an audit entry               |
| `GET /inventory/reconciliation`                                                | `inventory.reports.view`                               | Cached `stock_balances` compared with the ledger                     |
| `GET /products`                                                                | `inventory.view`                                       | Search, type/category/status/stock filters, sort, pagination         |
| `POST /products`                                                               | `products.create`                                      | Create a product with unit conversions                               |
| `GET /products/:id`                                                            | `inventory.view`                                       | Product detail with units and recent movements                       |
| `PUT /products/:id`                                                            | `products.edit`                                        | Update; base unit locked once stock exists                           |
| `POST /products/:id/activate` · `/deactivate`                                  | `products.deactivate`                                  | Change status; never deletes history                                 |
| `GET /products/:id/batches`                                                    | `batches.view`                                         | Batches with remaining quantities and expiry state                   |
| `GET /products/:id/fefo`                                                       | `stock.view`                                           | Read-only first-expired-first-out allocation preview                 |
| `GET /categories` · `POST` · `PUT /:id` · `DELETE /:id`                        | `inventory.view` / `categories.manage`                 | Category tree; delete refused while referenced                       |
| `GET /units` · `POST` · `PUT /:id` · `DELETE /:id`                             | `inventory.view` / `units.manage`                      | Units; built-in units cannot be renamed or removed                   |
| `GET /batches`                                                                 | `batches.view`                                         | Batch and expiry listing with filters                                |
| `GET /stock/movements` · `/stock/movements/:id`                                | `stock.view`                                           | Ledger history and per-movement detail                               |
| `POST /stock/receive`                                                          | `stock.receive`                                        | Receive stock into a new or existing batch                           |
| `POST /stock/adjust`                                                           | `stock.adjust` + `stock.write_off` for damaged/expired | Adjustment with a mandatory reason                                   |
| `GET /stock/fefo/:productId`                                                   | `stock.view`                                           | Same FEFO preview as the product route                               |
| `GET /suppliers` · `GET /:id`                                                  | `suppliers.view`                                       | Suppliers with linked products and receipt history                   |
| `POST /suppliers` · `PUT /:id` · `POST /:id/activate` · `POST /:id/deactivate` | `suppliers.manage`                                     | Manage suppliers, never delete them                                  |

Receiving and adjustment payloads carry an optional `operationId` (client UUID). Replaying the
identical operation returns the stored movement instead of duplicating stock; reusing the ID for
different content returns `409 OPERATION_CONFLICT`.

**Stock valuation (Phase 7).** `stockValueCostKobo` on `/inventory/dashboard`, `/products` and
`/reports/finance` is the same number everywhere: on-hand stock is valued at **actual batch
acquisition cost** where batch cost data exists, falling back to the product cost price only for
quantities with no batch record. Historical COGS is never restated.

## Sales, POS and debts (Phase 3)

| Method / path                       | Permission                            | Purpose                                                    |
| ----------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `GET /pos/bootstrap`                | `pos.access`                          | POS session data (settings, categories, payment methods)   |
| `GET /pos/products`                 | `pos.access`                          | Fast catalogue slice for the till                          |
| `GET /pos/lookup`                   | `pos.access`                          | Barcode/SKU lookup for scanning                            |
| `GET /sales/summary`                | `sales.view`                          | Today's takings summary                                    |
| `GET /sales`                        | `sales.view`                          | Sale list with filters and pagination                      |
| `POST /sales`                       | `sales.create`                        | Checkout: items, discounts, split payments, credit         |
| `GET /sales/receipt/:receiptNumber` | `sales.view`                          | Receipt by its human number                                |
| `GET /sales/:id`                    | `sales.view`                          | Sale detail with payments and stock effects                |
| `POST /sales/:id/void`              | `sales.void`                          | Void an unreferenced sale, restoring stock                 |
| `POST /sales/:id/refund`            | `sales.refund`                        | Partial/full refund with optional batch restoration        |
| `GET /customers` · `POST`           | `customers.view` / `customers.manage` | Customer search and creation                               |
| `GET /customers/:id` · `PUT /:id`   | `customers.view` / `customers.manage` | Customer profile, debts, history                           |
| `POST /customers/:id/repayments`    | `debts.repay`                         | Debt repayment for a customer                              |
| `GET /debts` · `GET /debts/report`  | `debts.view`                          | Open debts and ageing summary                              |
| `GET /debts/:id`                    | `debts.view`                          | Debt detail                                                |
| `POST /debts/:id/repayments`        | `debts.repay`                         | Partial/full repayment (idempotent per `operationId`)      |
| `GET /reports/sales`                | `reports.view`                        | Sales report with separated revenue/cash/COGS/gross profit |

Sales payloads carry a required `operationId`; a replay returns the original sale instead of
charging twice. Discounts above staff limits fail with `DISCOUNT_TOO_LARGE`/authorization errors;
credit sales require a customer and respect the credit limit (`CREDIT_LIMIT_EXCEEDED`).

## Healthcare (Phase 4)

Clinical history is only visible to authorized healthcare roles; cashiers get `403` on clinical
reads. Details and payload shapes are also recorded in [`PHASE_4.md`](PHASE_4.md).

| Method / path                                    | Permission                                    | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------- | --------------------------------------------------- |
| `GET /patients` · `POST /patients`               | `patients.view` / `patients.register`         | Search (duplicate detection) and register           |
| `GET /patients/:id` · `PUT /patients/:id`        | `patients.view` / `patients.edit`             | Profile and chronological timeline                  |
| `POST /patients/:id/vitals`                      | `vitals.record`                               | Record vital signs with explicit measurements       |
| `POST /consultations` · `GET /consultations`     | `consultations.create` / `consultations.view` | Consultations                                       |
| `POST /prescriptions` · `PUT /prescriptions/:id` | `prescriptions.create`                        | Draft and edit prescriptions                        |
| `GET /prescriptions` · `GET /prescriptions/:id`  | `prescriptions.view`                          | Prescription list and detail                        |
| `POST /prescriptions/:id/authorize`              | `prescriptions.authorize`                     | Authorize after allergy/clinical review             |
| `POST /prescriptions/:id/cancel`                 | `prescriptions.cancel`                        | Cancel a prescription                               |
| `POST /prescriptions/:id/dispense`               | `prescriptions.dispense`                      | FEFO dispensing, exactly once per line              |
| `GET /healthcare/medicines`                      | `prescriptions.view`                          | Medicine list for prescribing                       |
| `PUT /healthcare/medicines/:id/warning`          | `prescriptions.create`                        | Store an allergy/interaction warning for a medicine |
| `GET /healthcare/reports`                        | `patients.reports`                            | Healthcare activity reports                         |

## Purchasing, supplier payments, expenses and finance (Phase 5)

All routes require an authenticated session and the listed permission; service transactions re-check
the grant.

| Method / path                         | Permission                              | Purpose                                     |
| ------------------------------------- | --------------------------------------- | ------------------------------------------- |
| `GET /purchases`                      | `purchases.view`                        | Search/filter purchase orders               |
| `POST /purchases`                     | `purchases.create`                      | Create a draft or ordered purchase          |
| `GET /purchases/:id`                  | `purchases.view`                        | Detail with lines, receipts and payments    |
| `PUT /purchases/:id`                  | `purchases.edit`                        | Edit a draft with a version check           |
| `POST /purchases/:id/order`           | `purchases.edit`                        | Mark a draft as ordered                     |
| `POST /purchases/:id/cancel`          | `purchases.cancel`                      | Cancel with a mandatory reason              |
| `GET /purchases/:id/receipts`         | `purchases.view`                        | Receipts for one order                      |
| `GET /goods-receipts` · `/:id`        | `purchases.view`                        | Delivery history and detail                 |
| `POST /purchases/:id/receipts`        | `purchases.receive` (+ `stock.receive`) | Atomic receipt, stock movements and batches |
| `GET /suppliers/:id/account`          | `supplier_debts.view`                   | Balances, invoices, payments and statement  |
| `GET /suppliers/:id/statement`        | `supplier_debts.view`                   | Date-ranged running statement               |
| `GET /supplier-balances`              | `supplier_debts.view`                   | Supplier balance list                       |
| `GET /supplier-payments` · `/:id`     | `supplier_payments.view`                | Payment history and detail                  |
| `POST /supplier-payments`             | `supplier_payments.record`              | Record a payment and allocations            |
| `POST /supplier-payments/:id/reverse` | `supplier_payments.reverse`             | Append a reversal record                    |
| `GET /expense-categories`             | `expenses.view`                         | Seeded operating categories                 |
| `GET /expenses` · `/:id`              | `expenses.view`                         | Expense list and detail                     |
| `POST /expenses`                      | `expenses.create`                       | Create a draft or recorded expense          |
| `PUT /expenses/:id`                   | `expenses.edit`                         | Edit a draft with a version check           |
| `POST /expenses/:id/record`           | `expenses.edit`                         | Post a draft expense                        |
| `POST /expenses/:id/reverse`          | `expenses.reverse`                      | Reverse a recorded expense                  |
| `GET /finance/dashboard`              | `reports.view`                          | Financial overview for a date range         |
| `GET /reports/finance`                | `reports.view`                          | Full separated financial report             |
| `GET /reports/finance/export`         | `reports.export`                        | CSV export for 12 report types              |
| `GET /cash-register`                  | `cash_register.view`                    | Sales-side money movement                   |

Purchase and expense updates carry a `version`; a stale version returns `409`. Purchase, receipt,
payment, reversal and expense writes carry an `operationId`; replaying the same payload is
idempotent, while a changed payload returns `409 OPERATION_CONFLICT`. Corrections to payments and
recorded expenses use reversal records, never deletes.

## Offline synchronization (Phase 6)

| Method / path       | Permission    | Purpose                                                                        |
| ------------------- | ------------- | ------------------------------------------------------------------------------ |
| `GET /sync/status`  | `sync.view`   | Queue counts for this installation (or the central queue in a browser session) |
| `GET /sync/summary` | `sync.view`   | Aggregate counters and recent records                                          |
| `GET /sync/records` | `sync.view`   | Paginated captured records with `pending/synced/rejected/conflict` status      |
| `POST /sync/push`   | `sync.manage` | Submit a batch of captured envelopes; returns per-record outcomes              |

**Envelope.** Each captured record is wrapped in an envelope (see `packages/shared/src/offline.ts`):
`schemaVersion`, `operationId` (UUID, generated once at capture), `deviceId`, `clientCreatedAt`,
`clientDate`, `capturedByUserId`, `record` (one of `sale`, `customer`, `customer_repayment`,
`stock_receipt`, `purchase_order`, `expense`), and `fingerprint` — a SHA-256 of the canonical JSON
of the envelope, bound to the installation. A tampered payload, another installation's device ID or
a fingerprint mismatch is rejected before any business write.

**Batch push.** `POST /sync/push` accepts `{ envelopes: OfflineEnvelope[] }` (bounded) and returns
`{ protocolVersion, serverTime, accepted[], rejected[], conflicts[], remaining }` with one outcome
per envelope (`applied` | `duplicate` with the authoritative receipt number, or a rejection
reason/conflict snapshot; `remaining` counts records over the batch limit that the device keeps
pending). Every accepted envelope is applied in **one database transaction keyed by
`operationId`**: a replay is recognised as a duplicate and changes nothing — no double sale, no
double stock movement, no double cash. Everything is re-checked server-side inside that
transaction: installation fingerprint, device state (revoked devices are refused), clock skew,
stock, prices and the capturing user's permissions. Anything unverifiable is stored as
`rejected` or `conflict` for human review — it is never forced through.

**Deliberate offline limits** (also enforced when the envelope arrives): credit sales, discounts for
users without `sales.discount`, and prescriptions cannot be captured offline.

**Record states:** `pending` (captured, not yet applied), `syncing`, `synced` (applied),
`rejected` (needs attention), `conflict` (needs review). Failed and conflicting operations remain
listed in `/sync/records` until a human resolves them.

## Backup and restore (Phase 6)

| Method / path                   | Permission        | Purpose                                                     |
| ------------------------------- | ----------------- | ----------------------------------------------------------- |
| `GET /backups`                  | `settings.view`   | List stored backups with dates, sizes, checksums, contents  |
| `PUT /backups/settings`         | `settings.manage` | Backup directory and retention (kept newest N)              |
| `POST /backups`                 | `settings.manage` | Create a verified backup (`VACUUM INTO` snapshot)           |
| `GET /backups/:fileName/verify` | `settings.view`   | Re-verify one file: integrity, checksum, row counts, schema |
| `POST /backups/restore`         | `settings.manage` | Prepare a restore of a verified backup                      |

Backups are written with SQLite's `VACUUM INTO` (one consistent snapshot even while selling) and
re-opened to verify integrity check, checksum, business row counts and schema version. File names
carry millisecond precision; an existing file is never overwritten. A backup folder that is, sits
inside, or contains the live database file is refused.

Restore is **prepare-only while the server runs**: the verified copy and a request marker are
staged, and the swap happens at the next controlled start with a `pre-restore-<timestamp>` safety
copy beside the live database. In production (non-desktop) the endpoint refuses with
`RESTORE_REQUIRES_STOP` instead — stop the server and copy the file, as the desktop guide says.
Unsynchronized offline records live on the phones, not in the database, so a restore cannot lose
them.

## Main payload shapes

First owner:

```ts
{
  fullName: string; // trimmed, 2–120 characters
  email: string; // validated, trimmed and lowercase
  password: string; // 12–128 characters, preserved exactly
  bootstrapToken: string; // private server setup token, never put in a URL
}
```

Login:

```ts
{
  email: string;
  password: string;
  device?: { id: string; secret: string }; // native only; non-nil UUID + 64 hex chars
}
```

Staff registration:

```ts
{
  fullName: string;
  email: string;
  password: string;
  roles: Array<
    | 'administrator'
    | 'manager'
    | 'pharmacist'
    | 'healthcare_professional'
    | 'cashier'
    | 'storekeeper'
  >; // nonempty, unique; owner excluded
}
```

Change password:

```ts
{
  currentPassword: string;
  newPassword: string;
} // new must differ and meet the policy
```

Device registration:

```ts
{
  id: string; // persistent installation UUID, not a hardware identifier
  secret: string; // 32 random bytes as hex, saved securely before sending
  name: string; // recognizable physical-device name
  platform: 'android' | 'desktop';
}
```

The device registration endpoint is retry-safe for the **same** ID/secret. A different secret
cannot replace an existing registration. A pending retry renews the code and invalidates its
predecessor. Approved registrations return approved status without another code; revoked ones
cannot re-register.

Approval: `{ pairingCode: string }` with exactly eight decimal digits. Revocation/logout: `{}`.
Settings update: `{ businessName: string }`. Backup creation: `{ note?: string, directory?: string }`
(both optional). Backup settings: `{ directory: string, automaticEnabled: boolean,
intervalHours: 1–168, retentionCount: 1–90 }`. Restore: `{ fileName: string }` matching the backup
file-name pattern.

Sale checkout (abridged — the shared schema is authoritative):

```ts
{
  operationId: string; // UUID; replaying returns the original sale
  prescription?: { id: string; reviewedWarnings: true }; // ties the sale to a prescription
  customerId?: string; // required for credit sales
  items: Array<{ productId: string; unitId: string; quantity: number; lineDiscountKobo: number }>;
  // FEFO batch allocation is automatic; batches are never chosen by hand at the till.
  cartDiscountKobo: number;
  discountReason?: string; // required (3+ characters) when any discount is granted
  discountAuthorization?: { email: string; password: string }; // supervisor override
  payments: Array<{ method: 'cash' | 'bank_transfer' | 'pos' | 'credit'; amountKobo: number; reference?: string }>;
  dueDate?: string;
  notes?: string;
}
```

## Error contract

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Your account does not have permission to perform this action.",
    "requestId": "a server-generated correlation UUID"
  }
}
```

Validation responses may include `fields: Record<string, string[]>`. They never echo submitted
credential values. HTTP statuses: 400 validation/code error, 401 authentication, 403
authorization/origin/CSRF, 404 missing resource, 409 conflict, 410 expired/locked pairing
challenge, 413 oversized body, 415 wrong content type, 429 rate limit, 500 generic internal error.

Representative machine codes (the full list lives in the service layer):

- **Auth/devices:** `INVALID_CREDENTIALS`, `SESSION_INVALID`, `SIGN_IN_REQUIRED`, `CSRF_INVALID`,
  `SETUP_COMPLETE`, `SETUP_TOKEN_INVALID`, `DEVICE_NOT_PAIRED`, `DEVICE_REVOKED`,
  `DEVICE_ID_IN_USE`, `DEVICE_MISMATCH`, `ROLE_ESCALATION`.
- **Inventory:** `PRODUCT_NOT_FOUND`, `SKU_IN_USE`, `BARCODE_IN_USE`, `BATCH_REQUIRED`,
  `BATCH_EXISTS`, `INSUFFICIENT_STOCK`, `INSUFFICIENT_BATCH_STOCK`, `EXPIRED_STOCK_UNAVAILABLE`,
  `EXPIRY_REQUIRED`, `BASE_UNIT_LOCKED`, `OPERATION_CONFLICT`.
- **Sales/debts:** `SALE_NOT_FOUND`, `SALE_ALREADY_VOIDED`, `SALE_ALREADY_REFUNDED`,
  `CREDIT_LIMIT_EXCEEDED`, `CUSTOMER_REQUIRED_FOR_CREDIT`, `REPAYMENT_EXCEEDS_DEBT`,
  `DISCOUNT_EXCEEDS_SUBTOTAL`.
- **Healthcare:** `CLINICAL_REVIEW_REQUIRED`, `PRESCRIPTION_QUANTITY_EXCEEDED`,
  `POSSIBLE_DUPLICATE` (patient duplicate detection with a mandatory override reason),
  `DUPLICATE_ITEM`; dispensing is exactly once per prescription line.
- **Finance:** `PURCHASE_NOT_DRAFT`, `RECEIVE_EXCEEDS_ORDER`, `BATCH_COST_MISMATCH`,
  `DUPLICATE_PAYMENT_REFERENCE`, `EXPENSE_ALREADY_REVERSED`, `BACKUP_CORRUPT`,
  `BACKUP_NAME_INVALID`, `RESTORE_REQUIRES_STOP`.
- **Sync:** `OPERATION_CONFLICT`, `SYNC_ATTEMPTS_EXHAUSTED`, `DEVICE_REVOKED`, `STOCK_CONFLICT`,
  `DEBT_CONFLICT`, `SALE_CONFLICT`, `EXPENSE_CONFLICT`, `PURCHASE_CONFLICT`.

A failed login counter, pairing attempt, or security audit is intentionally committed before its
error is returned. A failed business/security write transaction rolls back both its data change and
corresponding successful-action audit.

## Boundaries

Role editing, user disabling/reset administration, full pagination/filtering beyond the provided
query parameters, expired-session cleanup jobs and account recovery are not implemented. The
tables/authorization checks prepare for them. Synchronization requires a live server session to
sign in first — there is **no offline authentication**. Endpoint schemas and bounded responses are
intentionally smaller than future operational modules.
