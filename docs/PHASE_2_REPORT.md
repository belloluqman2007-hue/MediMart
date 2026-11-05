# MediMart — Phase 2 completion and review report

- **Date:** 5 November 2026 (UTC)
- **Application version:** 0.1.0 (no version bump; no APK was built)
- **Repository:** `belloluqman2007-hue/MediMart`
- **Working branch:** `arena/c0eeabaa-medimart`
- **Scope implemented:** Inventory management only

> **Ready for Phase 2 review.** Products, categories, batches and expiry, the stock ledger,
> units and conversions, suppliers, the inventory dashboard, and reconciliation are implemented
> against the existing Phase 1 foundation. Every automated check listed in §11 was executed in
> this environment and passed.
>
> **Deliberately absent:** Point of Sale, sales transactions, customer debts, purchase orders,
> supplier payments, patients, consultations, prescriptions, expenses, accounting reports, a
> synchronization engine, and cloud deployment. **Work stops here for your review and explicit
> approval before any Phase 3 work begins.**

## 1. Starting point

Phase 2 began from commit `07f3d15274facc2762bbf12c6fcffe1bc460a5b1` on `main`, whose tree already
contained the complete Phase 1 foundation (workspace layout, SQLite persistence with migrations
v1–v3, Argon2id authentication, seven roles, revocable sessions, device pairing, audit logging,
service-worker offline shell, and the React design system).

The existing structure was inspected before any file was written — migration runner and checksum
handling, `schema-helpers.ts`, permission constants and role grants, the API error contract, the
audit service, the request-validation convention (Zod schemas shared through `@medimart/shared`),
the outbox deny-list, and the frontend design tokens/route table. Phase 2 extended those
conventions; nothing from Phase 1 was replaced, and no existing table, row, or endpoint was
renamed or dropped.

**Existing data is preserved.** Migration v4 only adds tables, indexes, and triggers; migration v5
only inserts new permissions, role grants, and reference rows. Both are additive and idempotent —
running `migrate()` on an existing Phase 1 database creates the inventory schema in place.

## 2. What was delivered

| Area             | Delivered                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Products         | Full catalogue CRUD, five product types, search, filters (type, category, stock state, status), six sort keys, pagination, activate/deactivate, duplicate SKU/barcode rejection, soft delete only       |
| Categories       | Two-level parent/child tree, product counts, create/edit/delete, delete refused while products or children reference it, search, 11 seeded categories                                                   |
| Batches & expiry | One row per product/batch, manufacturing + expiry dates, received/remaining quantity, cost per unit, supplier reference, recorded date, duplicate-batch protection, expiry rules, near-expiry alerts    |
| Stock ledger     | Append-only movements (opening, receipt, adjustment ±, damaged, expired, correction), per-movement balance proof, reasons, user/device/reference IDs, idempotent operation IDs, FEFO allocation preview |
| Units            | 11 built-in units, custom units, per-product conversion factors, integer base-unit arithmetic, invalid-factor rejection, base-unit lock once stock exists                                               |
| Suppliers        | CRUD, contact/business details, notes, status, linked products, receipt history                                                                                                                         |
| Dashboard        | Active products, cost value, retail value, below-reorder, out-of-stock, expired, nearing expiry, recent movements, recently added products, configurable alert window                                   |
| Reconciliation   | Cached `stock_balances` compared with the ledger sum, drift detection, permission-gated report                                                                                                          |
| Security         | 16 new permissions enforced by backend guards, audit entries for every mutating action, no sensitive payloads logged                                                                                    |
| Frontend         | 12 inventory routes under the existing design system, loading/error/empty states, confirmations, validation, responsive to 320 px                                                                       |

## 3. Database

### 3.1 Migrations

| Version | Name              | Contents                                                   | Checksum (first 8) |
| ------- | ----------------- | ---------------------------------------------------------- | ------------------ |
| v1      | `foundation`      | Phase 1 tables — **unchanged**                             | `84921e43`         |
| v2      | `device-pairing`  | Phase 1 device tables — **unchanged**                      | `ce275cd3`         |
| v3      | `seeds`           | Phase 1 roles/permissions — **unchanged**                  | `46ee48e9`         |
| v4      | `inventory_core`  | 9 tables, 17 indexes, 4 append-only triggers               | `f90e2098`         |
| v5      | `inventory_seeds` | 14 permissions, 5 role-grant sets, 11 units, 11 categories | `e956b08b`         |

`migrations.length` is now **5**; the database has **23 tables** (14 Phase 1 + 9 inventory).

### 3.2 New tables (v4)

| Table               | Purpose and notable constraints                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `units`             | Unit code (unique, case-insensitive), name, symbol, `is_system`; system units are protected from rename/delete                                                                                                                                                          |
| `categories`        | Self-referencing `parent_id`, `kind` (`pharmacy`/`minimart`), unique name per parent, cycle protection in the service layer                                                                                                                                             |
| `suppliers`         | Name, contact person, phone, email, address, business info, notes, status; soft status changes only                                                                                                                                                                     |
| `products`          | UUID PK, type, status, SKU and barcode unique (case-insensitive, nullable), category FK, `purchase_cost_kobo`/`selling_price_kobo` INTEGER with `CHECK (selling >= purchase)`, base-unit FK, expiry-tracking flag, reorder level, `created_by`/`updated_by`, timestamps |
| `product_units`     | Per-product conversions, unique `(product_id, unit_id)`, `CHECK (factor >= 2)`, product cannot convert to its own base unit                                                                                                                                             |
| `product_batches`   | Batch number, manufacturing/expiry dates, received and remaining quantity, cost per unit, supplier FK, recorded timestamp; unique `(product_id, batch_number)`; `CHECK (remaining >= 0)`                                                                                |
| `stock_balances`    | Cached per product/batch balance with a version counter for optimistic concurrency                                                                                                                                                                                      |
| `stock_movements`   | Append-only ledger: type, quantity, previous/new balance with `CHECK (new = previous + quantity)`, reason, user, device ID, reference ID, `operation_id` UNIQUE for replay safety                                                                                       |
| `stock_adjustments` | One row per adjustment with direction, reason, and permission evidence — kept separate from the ledger row                                                                                                                                                              |

### 3.3 Seed data (v5)

- **11 units:** Piece, Pack, Carton, Bottle, Sachet, Tablet, Capsule, Kilogram, Gram, Litre,
  Millilitre.
- **11 categories:** Pharmacy → Antibiotics, Analgesics, Antimalarials, Vitamins, Antihistamines,
  First Aid; Mini-Mart → Drinks, Snacks, Foodstuff, Household Items, Personal Care.
- **14 permissions** (indices 26–39 in the deterministic UUID scheme) and role grants for owner,
  administrator, manager, pharmacist, and storekeeper.

Deterministic IDs: permissions `20000000-0000-4000-8000-<idx>`, units
`41000000-0000-4000-8000-<idx>`, categories `51000000-0000-4000-8000-<idx>`.

### 3.4 Integrity and rollback strategy

- Every quantity-changing operation runs inside a single SQLite transaction that inserts the
  movement row, updates the batch/balance row, writes the audit entry, and commits — or rolls the
  whole thing back. Partial writes are impossible.
- `stock_movements` is append-only: triggers reject `UPDATE` and `DELETE`.
- Negative stock is refused at the service layer **and** by `CHECK (remaining >= 0)`.
- Balances are never silently overwritten: the ledger is authoritative, `stock_balances` is a cache
  compared by `/api/inventory/reconciliation`.
- Migrations v4/v5 are forward-only and additive. A failed plan is rolled back as a whole (covered
  by a test that aborts a plan part-way and confirms no tables survive).

## 4. Money and quantity handling

- Money is `INTEGER` **kobo** end to end: form input → `nairaToKobo` → schema → database → render.
  No floating-point value is ever stored or compared. Prices with more than two decimals are
  rejected, and selling below purchase cost is rejected.
- Quantities are whole numbers of the product's **base unit**. Conversions are integer factors
  (`1 carton = 12 packs`, `1 pack = 10 tablets`), and the API refuses a factor below 2, a duplicate
  unit, or the base unit itself. Unit cost is converted as
  `Math.round(unitCostKobo × quantity / baseQuantity)`, so `₦500 per pack of 10 tablets` becomes
  `5 000 kobo/tablet` with no rounding drift.

## 5. API endpoints

All routes below are mounted by `registerInventoryRoutes` in `apps/api/src/routes/inventory.ts` and
require an authenticated session plus the listed permission on the **server**.

| Method | Path                            | Permission                  |
| ------ | ------------------------------- | --------------------------- |
| GET    | `/api/inventory/dashboard`      | `inventory.view`            |
| GET    | `/api/inventory/alerts`         | `inventory.view`            |
| GET    | `/api/inventory/settings`       | `inventory.view`            |
| PUT    | `/api/inventory/settings`       | `inventory.settings.manage` |
| GET    | `/api/inventory/reconciliation` | `inventory.reports.view`    |
| GET    | `/api/products`                 | `inventory.view`            |
| POST   | `/api/products`                 | `products.create`           |
| GET    | `/api/products/:id`             | `inventory.view`            |
| PUT    | `/api/products/:id`             | `products.edit`             |
| POST   | `/api/products/:id/activate`    | `products.deactivate`       |
| POST   | `/api/products/:id/deactivate`  | `products.deactivate`       |
| GET    | `/api/products/:id/batches`     | `batches.view`              |
| GET    | `/api/products/:id/fefo`        | `stock.view`                |
| GET    | `/api/categories`               | `inventory.view`            |
| POST   | `/api/categories`               | `categories.manage`         |
| PUT    | `/api/categories/:id`           | `categories.manage`         |
| DELETE | `/api/categories/:id`           | `categories.manage`         |
| GET    | `/api/units`                    | `inventory.view`            |
| POST   | `/api/units`                    | `units.manage`              |
| PUT    | `/api/units/:id`                | `units.manage`              |
| DELETE | `/api/units/:id`                | `units.manage`              |
| GET    | `/api/batches`                  | `batches.view`              |
| GET    | `/api/stock/movements`          | `stock.view`                |
| GET    | `/api/stock/movements/:id`      | `stock.view`                |
| POST   | `/api/stock/receive`            | `stock.receive`             |
| POST   | `/api/stock/adjust`             | `stock.adjust`              |
| GET    | `/api/stock/fefo/:productId`    | `stock.view`                |
| GET    | `/api/suppliers`                | `suppliers.view`            |
| POST   | `/api/suppliers`                | `suppliers.manage`          |
| GET    | `/api/suppliers/:id`            | `suppliers.view`            |
| PUT    | `/api/suppliers/:id`            | `suppliers.manage`          |
| POST   | `/api/suppliers/:id/activate`   | `suppliers.manage`          |
| POST   | `/api/suppliers/:id/deactivate` | `suppliers.manage`          |

`POST /api/stock/adjust` additionally requires `stock.write_off` when the movement type is
`damaged` or `expired`. Write-offs (`damaged`, `expired`, `adjustment_decrease`, `correction`
downward) also demand a 3–500 character reason, and every adjustment stores a
`stock_adjustments` row.

### Error codes introduced

`BARCODE_IN_USE`, `SKU_IN_USE`, `CATEGORY_IN_USE`, `CATEGORY_CYCLE`, `UNIT_EXISTS`,
`UNIT_IN_USE`, `UNIT_NOT_CONFIGURED`, `BASE_UNIT_LOCKED`, `BATCH_EXISTS`, `BATCH_REQUIRED`,
`EXPIRY_REQUIRED`, `EXPIRY_IN_PAST`, `EXPIRY_BEFORE_MANUFACTURE`, `INSUFFICIENT_STOCK`,
`INSUFFICIENT_BATCH_STOCK`, `STOCK_CONFLICT`, `OPERATION_CONFLICT`, `PRODUCT_INACTIVE`,
`OPENING_STOCK_CLOSED`.

## 6. Frontend

New routes under the existing shell, all inside `InventoryLayout` (its own section tabs, hidden
when the account lacks `inventory.view`):

| Route                          | Page                 | Highlights                                                                                       |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------ |
| `/inventory`                   | Inventory dashboard  | Metric cards with LIVE values, cost vs retail value explained, recent movements, newest products |
| `/inventory/products`          | Product list         | Search, type/category/stock filters, sort, pagination, row actions                               |
| `/inventory/products/new`      | Add product          | Validation, live margin preview, conversion editor                                               |
| `/inventory/products/:id`      | Product detail       | Prices, stock, batch table, movement history, edit/deactivate/receive links                      |
| `/inventory/products/:id/edit` | Edit product         | Same form, keyed per product; base-unit select locked once stock exists                          |
| `/inventory/categories`        | Categories           | Tree with product counts, create/edit/delete with confirmation, search                           |
| `/inventory/batches`           | Batches & expiry     | Expiry status pills, expired/near-expiry filters, supplier and quantity columns                  |
| `/inventory/receive`           | Receive stock        | Product/batch/unit selection, cost per unit, supplier, expiry validation, receipt summary        |
| `/inventory/adjustments`       | Adjust stock         | Direction, movement type, mandatory reason, write-off permission gate, confirmation              |
| `/inventory/movements`         | Movement history     | Filters (product, type, date range), pagination, per-movement balance proof, detail drawer       |
| `/inventory/units`             | Units                | Built-in vs custom units, add/edit, delete guarded by usage                                      |
| `/inventory/suppliers`         | Suppliers            | List/search/create/edit, linked products and receiving history, activate/deactivate              |
| `/inventory/reconciliation`    | Reconciliation       | Cached vs ledger totals, drift rows, permission-gated for `inventory.reports.view`               |
| `/suppliers`                   | Supplier entry point | Reuses the supplier workspace so the Phase 1 sidebar destination is real                         |

Design reuse: the existing card, table, badge, button, dialog, and form primitives plus the Phase 1
design tokens. The Phase 2 CSS is appended to `styles.css` (no Phase 1 rule was rewritten) with
breakpoints at 1000 px and 760 px; the e2e suite asserts no horizontal overflow at 1440/768/390 px.

Every control performs a real action — no placeholder buttons. Buttons that a role cannot use are
rendered as disabled/absent **and** the API rejects the call regardless.

## 7. Permissions and roles

16 inventory permissions were added (39 total). Grants by role:

| Role                    | Inventory permissions                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Owner                   | 16 / 16                                                                                 |
| Administrator           | 16 / 16                                                                                 |
| Manager                 | 16 / 16                                                                                 |
| Storekeeper             | 14 / 16 (no `products.deactivate`, no `inventory.settings.manage`)                      |
| Pharmacist              | 10 / 16 (view, create/edit products, batches, receive/adjust/write-off, suppliers view) |
| Cashier                 | 0 / 16                                                                                  |
| Healthcare professional | 0 / 16                                                                                  |

`inventory.view`, `inventory.reports.view`, and `inventory.settings.manage` are the three
inventory-wide capabilities; the remaining thirteen are the per-area permissions you requested
(`products.*`, `categories.manage`, `units.manage`, `batches.*`, `stock.*`, `suppliers.*`).

Enforcement is server-side: `tests/inventory.test.ts` proves a cashier receives 403 on products,
stock, batches, suppliers, dashboard, and reconciliation even with the UI bypassed, and that the
`stock.write_off` capability is checked independently of `stock.adjust`.

## 8. Audit logging and offline boundaries

- Every mutation writes an audit entry with the actor, entity, entity ID, action, request ID, and a
  sanitised detail object. A test asserts no password, token, or secret value appears in audit
  detail rows.
- Stock movements carry `operation_id` (client-generated UUID), `device_id`, `reference_id`,
  `user_id`, and timestamps, so a replay of the same operation returns the stored movement instead
  of duplicating it, and reuse of the ID for different content returns `409 OPERATION_CONFLICT`.
- Cached balances are never treated as truth: reconciliation compares them to the ledger and reports
  drift rather than silently overwriting newer central stock.
- `packages/shared/src/sync.ts` puts `product*`, `stock_*`, `supplier*`, `category*`, `unit*`, and
  `product_batch*` entities on the outbox deny-list, because inventory writes are server-validated
  in this phase. **No sync engine was added** — this is a boundary, not an implementation.

## 9. Files created

| Path                                                     | Lines | Purpose                                                     |
| -------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| `packages/shared/src/inventory.ts`                       | 495   | Enums, Zod input schemas, query schemas, DTOs               |
| `packages/database/src/schema-helpers.ts`                | 46    | Shared `timestamp`/`uuid`/`kobo` column builders            |
| `packages/database/src/migrations-inventory.ts`          | 291   | Migration v4 (`inventory_core`) and v5 (seeds)              |
| `apps/api/src/services/inventory/common.ts`              | 196   | Row mappers, permission helpers, reference guards           |
| `apps/api/src/services/inventory/products.ts`            | 383   | Product CRUD, duplicate checks, status, base-unit lock      |
| `apps/api/src/services/inventory/stock.ts`               | 673   | Ledger engine, receiving, adjustments, FEFO, reconciliation |
| `apps/api/src/services/inventory/catalog.ts`             | 595   | Categories, units, suppliers                                |
| `apps/api/src/services/inventory/dashboard.ts`           | 115   | Dashboard aggregates and alerts                             |
| `apps/api/src/routes/inventory.ts`                       | 247   | Route registration and permission guards                    |
| `apps/web/src/features/inventory/lib.ts`                 | 133   | Money/date/query helpers, `useAsync`, pagination            |
| `apps/web/src/features/inventory/shared.tsx`             | 201   | Shared components only (no helpers)                         |
| `apps/web/src/features/inventory/InventoryLayout.tsx`    | 89    | Section tabs and permission gate                            |
| `apps/web/src/features/inventory/InventoryDashboard.tsx` | 392   | Dashboard page                                              |
| `apps/web/src/features/inventory/ProductsPage.tsx`       | 295   | Product list                                                |
| `apps/web/src/features/inventory/ProductFormPage.tsx`    | 475   | Add/edit product                                            |
| `apps/web/src/features/inventory/ProductDetailPage.tsx`  | 393   | Product detail                                              |
| `apps/web/src/features/inventory/BatchesPage.tsx`        | 254   | Batches and expiry                                          |
| `apps/web/src/features/inventory/StockReceivePage.tsx`   | 361   | Receive stock                                               |
| `apps/web/src/features/inventory/AdjustmentsPage.tsx`    | 351   | Stock adjustments                                           |
| `apps/web/src/features/inventory/MovementsPage.tsx`      | 197   | Movement history                                            |
| `apps/web/src/features/inventory/CategoriesPage.tsx`     | 308   | Categories                                                  |
| `apps/web/src/features/inventory/UnitsPage.tsx`          | 212   | Units                                                       |
| `apps/web/src/features/inventory/SuppliersPage.tsx`      | 442   | Suppliers                                                   |
| `apps/web/src/features/inventory/ReconciliationPage.tsx` | 112   | Reconciliation report                                       |
| `tests/inventory.test.ts`                                | 906   | 30 API/database tests against a real SQLite database        |

## 10. Files modified

| Path                                  | Change                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/shared/src/permissions.ts`  | 16 new permission codes plus role grants                                                     |
| `packages/shared/src/index.ts`        | Re-exports the inventory contracts                                                           |
| `packages/shared/src/contracts.ts`    | Health response `phase: 2`                                                                   |
| `packages/shared/src/sync.ts`         | Outbox deny-list entries for inventory entities                                              |
| `packages/database/src/migrations.ts` | Appends `...inventoryMigrations` after v3                                                    |
| `apps/api/src/app.ts`                 | Mounts inventory routes; adds `DELETE` to allowed CORS methods; configurable auth rate limit |
| `apps/api/src/config.ts`              | Optional `authRateLimit` (default 10, unchanged in production)                               |
| `apps/api/src/middleware/security.ts` | Permits CORS `DELETE` for category/unit removal                                              |
| `apps/web/src/App.tsx`                | Nested `/inventory/*` route tree plus `/suppliers`; placeholder list reduced                 |
| `apps/web/src/features/Dashboard.tsx` | Two live inventory metrics replace placeholder cards; Phase 2 banner                         |
| `apps/web/src/styles.css`             | Appended Phase 2 component and responsive block (~600 lines)                                 |
| `tests/database.test.ts`              | Table list updated to 23 tables                                                              |
| `tests/platform.test.ts`              | Migration count derived from `migrations.length`                                             |
| `tests/e2e/workspace.spec.ts`         | Two new inventory scenarios; rate-limit-safe ordering                                        |
| `scripts/test-server.ts`              | Test-only `authRateLimit` so the browser suite can sign in per scenario                      |

## 11. Verification results (executed in this environment)

| Command                                          | Result                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npx vitest run`                                 | **4 files, 81 tests passed** (30 of them inventory, all against a real SQLite database)                |
| `npx tsc --noEmit`                               | Clean                                                                                                  |
| `npm run lint`                                   | 0 problems (0 errors, 0 warnings)                                                                      |
| `npm run format:check`                           | All files Prettier-clean                                                                               |
| `npm run build`                                  | Succeeded; offline shell prepared with 21 assets, no API caching                                       |
| `npm run test:production`                        | Passed: compiled SQLite startup, migrations, health, bundled UI/assets, service worker, 404 boundaries |
| `MEDIMART_SANDBOX_BROWSER=1 npx playwright test` | **16 browser tests passed** (54.5 s) including the two new inventory scenarios                         |

Behavioural coverage worth calling out, all executed:

- Product create/edit, duplicate barcode and duplicate SKU rejection (case-insensitive), required
  price rules, search/filter/sort/pagination, activate/deactivate with audit entries.
- **Optional SKU and barcode may be blank** — a regression test now covers the form payload that
  the browser test exposed (see §12).
- Category trees, inherited kind, duplicate refusal, cycle refusal, unsafe-delete refusal.
- Batch creation, expiry required for expiry-tracked products, past expiry rejected, expiry before
  manufacture rejected, products without expiry supported, duplicate batch refused.
- Receiving writes batch + movement + balance atomically; FEFO ordering excludes expired batches;
  integer carton → pack → tablet conversion.
- Adjustments require a reason and a batch for reductions; negative stock is refused and the ledger
  is left untouched; corrections work in both directions; idempotent replay returns the stored
  movement and conflicting reuse is rejected.
- Cached balances reconcile against the ledger, including a deliberately corrupted cache.
- Cashier and healthcare-professional accounts get 403 from every inventory endpoint; write-off
  capability is enforced separately; audit rows contain no secrets.
- Browser: owner creates a product through the UI, receives a batch, sees the ledger row, the batch
  row, a new category, and no horizontal overflow at desktop/tablet/phone widths; a cashier sees the
  permission boundary and gets 403 from `/api/products` and `/api/inventory/dashboard`.

## 12. Errors found and resolved during verification

1. **Blank SKU/barcode rejected by the API.** The shared `optionalCode` schema accepted `''` but not
   `null`, while its own transform emits `null` — so any product saved from the form without an SKU
   returned `400 VALIDATION_ERROR` (`sku: "Invalid input"`). Unit tests had always generated an SKU,
   so only the browser test caught it. Fixed in `packages/shared/src/inventory.ts`; a regression
   test now posts both `null` and `''`.
2. **Batch quantity double-scaling.** Receiving initially applied the conversion twice. Fixed by
   inserting the batch with zero quantities and letting `recordMovement` be the single source of
   quantity truth.
3. **Adjustments needed a batch even for increases.** The API now requires `batchId` for every
   adjustment on a batch-tracked product (`BATCH_REQUIRED`), matching the UI.
4. **React 19 `set-state-in-effect` lint error.** Loading and selection state are now derived from a
   request key/snapshot (`{key, data, error}`) instead of being set inside effects; the product form
   is split into a loader plus a form keyed by product ID.
5. **`react-refresh/only-export-components`.** Helpers/hooks moved to `inventory/lib.ts`, leaving
   `shared.tsx` component-only.
6. **Browser suite exhausted the 10-per-15-minute auth limiter**, so the existing password-change
   test was throttled. The limiter is now configurable (`authRateLimit`), production keeps the
   default of 10, and the disposable test server raises it. No production guarantee was weakened.
7. **e2e locator ambiguity** (`Base unit` vs a reorder-level hint, and a hidden `<option>` matching a
   product name): assertions now use roles and table scoping.

## 13. Known limitations

- **No purchasing module.** Supplier references on receipts are free-form links; there are no
  purchase orders, supplier invoices, or payments (out of scope by instruction).
- **FEFO is advisory.** Allocation is computed and returned for the caller; nothing consumes it yet
  because POS/sales are Phase 3+.
- **No sync engine.** Inventory writes are online-only and denied by the outbox deny-list.
- **Reconciliation is read-only.** Drift is reported, not auto-repaired.
- **Two category levels.** Parent/child is supported; deeper nesting is not offered in the UI.
- **No reports module.** The dashboard and reconciliation endpoints exist; they are not wired into
  the Phase 3 `/reports` destination.
- **No barcode scanning UI.** Barcodes are stored, searched, and uniqueness-checked only.
- **No APK.** The Android project was not compiled, signed, or installed; no physical-device check
  was performed. Browser tests ran in the restricted sandbox Chromium.
- Bulk import/export and product images are not implemented.

## 14. Commands to run

```bash
# from the repository root
npm install --ignore-scripts --no-audit --no-fund   # this sandbox; native build scripts are blocked

npm run dev:api      # terminal 1 — API on :3001, migrations run automatically
npm run dev:web      # terminal 2 — Vite UI

npm run build && npm run start:api                   # compiled server serving the built UI
npm run test:production                              # compiled-server smoke check

npx vitest run                                       # 81 tests
npx tsc --noEmit && npm run lint && npm run format:check
MEDIMART_SANDBOX_BROWSER=1 npx playwright test        # 16 browser tests in this sandbox
npx playwright install chromium && npx playwright test  # on an ordinary machine
```

## 15. Manual setup

Nothing manual is required to try inventory features: open the app, sign in as the owner (or an
administrator), follow **Inventory → Overview**, and the seeded units and categories are ready.

Optional steps:

1. **Expiry alert window** — Inventory dashboard → save a value between 1 and 365 days (default 90).
   Requires `inventory.settings.manage`.
2. **Opening stock** — Receive stock for an existing product, or record an opening balance through
   the same endpoint; opening balances are locked once a product has movements.
3. **Role review** — Settings → Staff access and Settings → Permissions to confirm which of your
   staff should hold `stock.adjust` / `stock.write_off` before go-live.
4. **Existing Phase 1 database** — no manual migration step; start the API once and v4/v5 apply.

## 16. Review decision

Phase 2 is complete and verified as described above. **No Phase 3 work has started**, and none will
begin until you review this report and approve the next phase.
