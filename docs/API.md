# API — Phases 1–5

Base path: `/api`. All important write inputs use strict shared Zod schemas. Send `Content-Type: application/json`; request-body limit is 64 KiB. Responses are `Cache-Control: no-store`.

## Authentication transports

**Browser:** the API sets an HttpOnly `medimart_session` cookie, path `/api`, SameSite Strict, Secure in production. `login`, `register-owner` and `session` responses contain a `csrfToken`, but never the raw session token. Put that value in `X-CSRF-Token` for every authenticated write. Keep it in memory, not browser storage.

**Native:** `login` must include approved `{ id, secret }` device proof. The response contains an opaque token for `Authorization: Bearer <token>`, stored only in native secure storage. A bearer token cannot be substituted as a browser cookie. Native sessions remain tied to the approved device and staff account.

State-changing origin checks apply independently of permissions. No frontend navigation check replaces a backend permission check.

## Endpoint map

| Method / path                | Access                                                    | Purpose                                                             |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /health`                | Public                                                    | SQLite/API health, phase 2, `sync: not_implemented`                 |
| `GET /auth/bootstrap-status` | Public                                                    | Whether an initial owner is needed and setup is enabled             |
| `POST /auth/register-owner`  | Valid setup token; no users exist                         | Create the one initial owner and a browser session                  |
| `POST /auth/login`           | Valid credentials; device proof for native bearer session | Sign in                                                             |
| `GET /auth/session`          | Authenticated                                             | Current profile, live permissions, expiry; browser CSRF token       |
| `POST /auth/change-password` | Authenticated + current password                          | Change own password and revoke all sessions                         |
| `POST /auth/logout`          | Authenticated                                             | Revoke the current session                                          |
| `POST /auth/logout-all`      | Authenticated                                             | Revoke all sessions for the current account                         |
| `GET /staff`                 | `staff.view`                                              | Up to 100 staff summaries; never password hashes                    |
| `POST /staff`                | `staff.manage` + delegation rules                         | Register an individual staff account                                |
| `GET /permissions`           | `permissions.view`                                        | Seeded roles and their current capability grants                    |
| `POST /devices/register`     | Installation UUID + generated secret; limited             | Register/renew an unapproved installation; return pairing challenge |
| `POST /devices/status`       | Installation ID + secret proof                            | Get pairing status; no secrets returned                             |
| `GET /devices`               | `devices.manage`                                          | Up to 100 registration summaries; no codes/hashes/secrets           |
| `POST /devices/:id/approve`  | `devices.manage` + matching unexpired code                | Approve the physical device                                         |
| `POST /devices/:id/revoke`   | `devices.manage`                                          | Revoke installation and its sessions                                |
| `GET /settings`              | `settings.view`                                           | Business-name setting                                               |
| `PUT /settings`              | `settings.manage`                                         | Save business name transactionally with an audit entry              |
| `GET /audit-logs?limit=50`   | `audit.view`                                              | Read up to 100 immutable event records                              |
| `GET /sync/status`           | `sync.view`                                               | Central queue and open conflict counts; `implemented: false`        |

Inventory (Phase 2), sales/POS and debts (Phase 3), healthcare (Phase 4) and purchasing, supplier
payments, expenses and financial reporting (Phase 5) endpoints exist. Backup execution and push/pull
sync endpoints do not. Unknown API paths return a JSON 404, not the SPA HTML. Healthcare endpoint
details are recorded in [`PHASE_4.md`](PHASE_4.md).

## Inventory endpoints (Phase 2)

`registerInventoryRoutes` mounts these under `/api`. Every route requires an authenticated session
**and** the listed permission; the checks run on the server, so hiding UI is never the control.

| Method / path                                                                  | Access                                                 | Purpose                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `GET /inventory/dashboard`                                                     | `inventory.view`                                       | Counts, cost vs retail value, alerts, recent movements and products |
| `GET /inventory/alerts`                                                        | `inventory.view`                                       | Expired and near-expiry batches within the alert window             |
| `GET /inventory/settings`                                                      | `inventory.view`                                       | Expiry alert window                                                 |
| `PUT /inventory/settings`                                                      | `inventory.settings.manage`                            | Save the alert window (1–365 days) with an audit entry              |
| `GET /inventory/reconciliation`                                                | `inventory.reports.view`                               | Cached `stock_balances` compared with the ledger                    |
| `GET /products`                                                                | `inventory.view`                                       | Search, type/category/status/stock filters, sort, pagination        |
| `POST /products`                                                               | `products.create`                                      | Create a product with unit conversions                              |
| `GET /products/:id`                                                            | `inventory.view`                                       | Product detail with units and recent movements                      |
| `PUT /products/:id`                                                            | `products.edit`                                        | Update; base unit locked once stock exists                          |
| `POST /products/:id/activate` · `/deactivate`                                  | `products.deactivate`                                  | Change status; never deletes history                                |
| `GET /products/:id/batches`                                                    | `batches.view`                                         | Batches with remaining quantities and expiry state                  |
| `GET /products/:id/fefo`                                                       | `stock.view`                                           | Read-only first-expired-first-out allocation preview                |
| `GET /categories` · `POST` · `PUT /:id` · `DELETE /:id`                        | `inventory.view` / `categories.manage`                 | Category tree; delete refused while referenced                      |
| `GET /units` · `POST` · `PUT /:id` · `DELETE /:id`                             | `inventory.view` / `units.manage`                      | Units; built-in units cannot be renamed or removed                  |
| `GET /batches`                                                                 | `batches.view`                                         | Batch and expiry listing with filters                               |
| `GET /stock/movements` · `/stock/movements/:id`                                | `stock.view`                                           | Ledger history and per-movement detail                              |
| `POST /stock/receive`                                                          | `stock.receive`                                        | Receive stock into a new or existing batch                          |
| `POST /stock/adjust`                                                           | `stock.adjust` + `stock.write_off` for damaged/expired | Adjustment with a mandatory reason                                  |
| `GET /stock/fefo/:productId`                                                   | `stock.view`                                           | Same FEFO preview as the product route                              |
| `GET /suppliers` · `GET /:id`                                                  | `suppliers.view`                                       | Suppliers with linked products and receipt history                  |
| `POST /suppliers` · `PUT /:id` · `POST /:id/activate` · `POST /:id/deactivate` | `suppliers.manage`                                     | Manage suppliers, never delete them                                 |

Receiving and adjustment payloads carry an `operationId` (client UUID) plus optional `deviceId`.
Replaying the identical operation returns the stored movement instead of duplicating stock; reusing
the ID for different content returns `409 OPERATION_CONFLICT`.

## Purchasing, supplier payments, expenses and finance endpoints (Phase 5)

All routes require an authenticated session and the listed permission; service transactions re-check
the grant. Amounts are integer kobo.

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

Purchase and expense updates carry a `version`; a stale version returns `409`. Purchase,
receipt, payment, reversal and expense writes carry an `operationId`; replaying the same payload is
idempotent, while a changed payload returns `409 OPERATION_CONFLICT`. Corrections to payments and
recorded expenses use reversal records, never deletes.

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

The device registration endpoint is retry-safe for the **same** ID/secret. A different secret cannot replace an existing registration. A pending retry renews the code and invalidates its predecessor. Approved registrations return approved status without another code; revoked ones cannot re-register.

Approval: `{ pairingCode: string }` with exactly eight decimal digits. Revocation/logout: `{}`. Settings update: `{ businessName: string }`.

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

Validation responses may include `fields: Record<string, string[]>`. They never echo submitted credential values. HTTP statuses: 400 validation/code error, 401 authentication, 403 authorization/origin/CSRF, 404 missing resource, 409 conflict, 410 expired/locked pairing challenge, 413 oversized body, 415 wrong content type, 429 rate limit, 500 generic internal error.

A failed login counter, pairing attempt, or security audit is intentionally committed before its error is returned. A failed business/security write transaction rolls back both its data change and corresponding successful-action audit.

## Boundaries

Role editing, user disabling/reset administration, full pagination/filtering, expired-session cleanup jobs and account recovery are not implemented. The tables/authorization checks prepare for them. Endpoint schemas and bounded responses are intentionally smaller than future operational modules.
