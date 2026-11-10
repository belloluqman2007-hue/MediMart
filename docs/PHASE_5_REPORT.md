# Phase 5 — Purchasing, Supplier Payments, Expenses & Financial Management

**Status:** implemented on `arena/d3e8b1fa-medimart`, integrated with the Phase 4 branch from `main`, ready for review. Phase 6 was not started.

This phase extends the existing MediMart workspace without rebuilding Phases 1–4. Supplier records, products, units, batches, the stock ledger, sales, payments, debts, patient/prescription workflows and the existing UI patterns are reused. No existing data is deleted or reset by the new migrations.

> **Phase 4 integration note:** no Phase 4 code was present when this branch started (`a730f2b`). Phase 4 landed on `main` during review and is merged here; migration versions were renumbered so healthcare is v9, finance core is v10 and finance permissions/categories are v11. Healthcare, sales, inventory and finance test suites all pass together.

---

## 1. Features implemented

### Purchase management

- Create purchase orders for existing suppliers with any number of product lines.
- Select the product's base unit or a configured purchase unit (pack, carton, etc.); the purchase unit factor is snapshotted on each line.
- Integer-kobo unit costs, line discounts, an order-level discount with a mandatory reason, and additional charges (delivery/handling) with a mandatory description.
- Computed subtotal, line-discount total, order total, expected delivery date and notes.
- Statuses: `draft`, `ordered`, `partially_received`, `received`, `cancelled`.
- Draft editing with optimistic version checks; ordered/partially received orders are locked.
- Search and filters for supplier, date range, status and reference number.
- Cancellation keeps the order in history and cannot be applied after receiving has started.
- **Creating an order never moves stock or creates a payable.**

### Goods receiving

- Receive against an existing purchase order, including partial deliveries.
- Accepted, damaged/missing (rejected) quantities per line, with mandatory rejection reasons.
- Batch number, manufacturing date and expiry date capture for medicines.
- Actual purchase cost per unit, independent of the ordered cost; integer base-unit costs are derived with rounding.
- Multiple units and conversions: accepted quantity x conversion factor = base quantity.
- Stock increases only through the existing `recordMovement` inventory ledger (`stock_received`), tied to `goods_receipt_items.stock_movement_id`.
- Duplicate receiving is prevented by idempotency (`operationId` + payload fingerprint) and by an outstanding-quantity cap.
- Receiving is atomic: a failure on any line rolls back receipts, items, batches, ledger movements, purchase-line quantities and audit writes.
- Expired medicine is rejected before any stock is created; already-expired expiry dates return `EXPIRED_GOODS_BLOCKED`.
- Batch reuse is allowed when the cost and dates match; a mismatch is refused so cost layers stay accurate.
- Purchase status automatically becomes `partially_received` or `received`.

### Supplier management

- Existing suppliers are reused; no duplicate supplier records are created by purchasing.
- Supplier account screen shows contact and business details, goods received, net paid, outstanding balance, open invoices, purchase history, receiving history and payments.
- Date-ranged supplier statement with opening balance, debits, credits, running balance and closing balance.
- Supplier balance list across all suppliers, with search and an outstanding-only filter.
- Supplier rows link directly to the account screen when the user has `supplier_debts.view`.

### Supplier payments and payables

- Record full or partial payments against a specific received invoice.
- Methods: cash, bank transfer and POS.
- Payment date, reference, notes and invoice allocation.
- Outstanding balance is **goods received − (payments − reversals)**. Ordered but undelivered goods are never a payable.
- Duplicate payment submissions are idempotent; reusing a payment reference for the same supplier/method is rejected.
- Over-allocation beyond an invoice's outstanding value is rejected.
- Corrections are append-only reversal records (`payment_kind = reversal`, `reversal_of_payment_id`, reversed allocations). Original payments remain visible and auditable.
- Supplier payments are never counted as customer collections or as sale cash.

### Expense management

- Twelve seeded operating categories: rent, electricity, water, internet/communication, transportation, staff salaries, repairs & maintenance, packaging, cleaning materials, security, licences & permits and other operating.
- Create drafts or record immediately, with description, category, amount, payment method, expense date, payee, reference and notes.
- Optional receipt/document attachment (JPEG, PNG, WebP or PDF, 36 KB max, stored as base64 in SQLite).
- Search and filters for search text, category, status, method and date range.
- Draft editing with audit records and version checks; recorded expenses cannot be edited.
- Recorded expenses can be reversed with a mandatory reason. Reversals are separate append-only records and do not delete the expense.
- Only `recorded` (and not reversed) expenses reduce operating profit; drafts never do.

### Financial dashboard

The dashboard now includes a month-to-date financial overview for users with `reports.view`, keeping these pillars separate:

- Sales: gross, discounts, refunds, net revenue, transaction count, average sale.
- Collections: cash, bank transfer, POS, debt repayments, refunds paid and total received.
- Purchases: ordered value, goods received, paid to suppliers, reversals and outstanding supplier balance.
- Expenses: recorded gross, reversed, net and category breakdown.
- Inventory: stock at cost, stock at retail, units on hand and COGS.
- Profitability: net sales revenue − COGS = gross profit; gross profit − operating expenses = operating profit.

Profit is never calculated as sales minus purchases. COGS comes from the inventory cost allocated to sale items, net of refunds.

### Financial reports

- Date-range filters with today / week / month / last month / year presets.
- Daily, weekly or monthly grouping.
- Sales trend: transactions, gross, discounts, refunds, net revenue, money received, COGS and gross profit.
- Purchase report: ordered value, received value, paid and outstanding per order.
- Supplier payment report and live outstanding supplier balances.
- Expense report and expense-category breakdown.
- Inventory valuation at cost and retail, using batch cost layers where present.
- COGS by product and gross/operating profit summaries.
- Actual cash movement including sale payments, refunds, debt repayments, supplier payments, supplier-payment reversals, expenses and expense reversals.
- CSV export for 12 report types, protected by `reports.export`.
- Printable report layout (print CSS hides filters/actions and avoids breaking report cards).

### Cash and payment tracking

- Cash register screen for sales-side movement: cash, bank transfer, POS, refunds paid and customer debt repayments.
- Money is separated by method; actual cash movement is distinguished from credit sales and unpaid supplier invoices.
- No opening cash balance is assumed, so the screen reports movement rather than a misleading cash balance.
- Full financial-report cash movement adds supplier payments, supplier reversals, expenses and expense reversals.

### Permissions and security

- Twelve new permissions, enforced by backend route guards and re-checked inside transactional services.
- Cashiers receive none of the new purchasing, supplier-payment, supplier-debt, expense or export permissions by default.
- Storekeepers receive only `purchases.create`, `purchases.edit` and `purchases.receive`.
- Sensitive actions write audit records with actor, device, request ID, entity and metadata: purchase created/updated/ordered/cancelled, goods received, supplier payment recorded/reversed, expense created/updated/recorded/reversed, and report exports.
- No monetary value is stored as a float; all money is integer kobo.

---

## 2. Migrations added

| Version | Name                                                  | Responsibility                                                                                                                                                                                                                                                                                          |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9       | `purchasing_receiving_supplier_payments_and_expenses` | Nine tables: `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`, `supplier_payments`, `supplier_payment_allocations`, `expense_categories`, `expenses`, `expense_reversals`, plus indexes, STRICT typing, integer-kobo checks, version columns and append-only triggers |
| 10      | `finance_permissions_and_expense_categories`          | Twelve permissions (`purchases.*`, `supplier_payments.*`, `supplier_debts.view`, `expenses.*`, `reports.export`), role grants, and twelve operating expense categories                                                                                                                                  |

Key constraints:

- `purchase_orders.total_kobo = subtotal_kobo - discount_total_kobo + additional_charges_kobo`.
- `purchase_order_items.line_subtotal_kobo = unit_cost_kobo * quantity` and `base_quantity = quantity * conversion_factor`.
- `purchase_order_items.received_base_quantity` is capped at `base_quantity`.
- `goods_receipt_items` has `UNIQUE (goods_receipt_id, purchase_order_item_id)` and a nullable stock-movement link.
- `supplier_payments` is append-only; `reversal_of_payment_id` is unique for reversals; a payment reference is unique per supplier/method for real payments.
- `supplier_payment_allocations` is append-only, with `direction` (`apply`/`reverse`) and a positive amount.
- `expenses` prohibits deletion, uses a version counter, and enforces attachment/status consistency.
- `expense_reversals` is append-only, one per expense, with an operation fingerprint.
- Draft purchase lines can be replaced on update; the line table is intentionally not append-only. The order itself cannot be deleted.

`tests/database.test.ts` now expects **49 tables** (23 before Phase 3 + 10 sales tables + 7 healthcare tables + 9 finance tables). Migration versions are contiguous and checksummed.

---

## 3. API endpoints

Every endpoint requires an authenticated session and the permission shown. All paths are under `/api`.

### Purchases

| Method / path                 | Permission         | Purpose                                  |
| ----------------------------- | ------------------ | ---------------------------------------- |
| `GET /purchases`              | `purchases.view`   | Search, supplier/status/date filters     |
| `POST /purchases`             | `purchases.create` | Create draft or ordered purchase         |
| `GET /purchases/:id`          | `purchases.view`   | Detail with lines, receipts and payments |
| `PUT /purchases/:id`          | `purchases.edit`   | Edit a draft with version check          |
| `POST /purchases/:id/order`   | `purchases.edit`   | Mark a draft as ordered                  |
| `POST /purchases/:id/cancel`  | `purchases.cancel` | Cancel draft/ordered with a reason       |
| `GET /purchases/:id/receipts` | `purchases.view`   | Receipts for an order                    |

### Goods receiving

| Method / path                  | Permission          | Purpose                                     |
| ------------------------------ | ------------------- | ------------------------------------------- |
| `GET /goods-receipts`          | `purchases.view`    | Delivery history with date/supplier filters |
| `GET /goods-receipts/:id`      | `purchases.view`    | Receipt with accepted/rejected lines        |
| `POST /purchases/:id/receipts` | `purchases.receive` | Atomic receipt, stock ledger and batches    |

`purchases.receive` is checked together with `stock.receive` inside the receiving service.

### Supplier accounts and payables

| Method / path                         | Permission                  | Purpose                                   |
| ------------------------------------- | --------------------------- | ----------------------------------------- |
| `GET /suppliers/:id/account`          | `supplier_debts.view`       | Summary, invoices, payments, statement    |
| `GET /suppliers/:id/statement`        | `supplier_debts.view`       | Date-ranged running statement             |
| `GET /supplier-balances`              | `supplier_debts.view`       | All supplier balances, search/outstanding |
| `GET /supplier-payments`              | `supplier_payments.view`    | Payment history with filters              |
| `POST /supplier-payments`             | `supplier_payments.record`  | Record payment with allocations           |
| `GET /supplier-payments/:id`          | `supplier_payments.view`    | Payment detail                            |
| `POST /supplier-payments/:id/reverse` | `supplier_payments.reverse` | Append a reversal record                  |

### Expenses

| Method / path                | Permission         | Purpose                          |
| ---------------------------- | ------------------ | -------------------------------- |
| `GET /expense-categories`    | `expenses.view`    | Seeded operating categories      |
| `GET /expenses`              | `expenses.view`    | Search/filter expense list       |
| `POST /expenses`             | `expenses.create`  | Create draft or recorded expense |
| `GET /expenses/:id`          | `expenses.view`    | Detail including attachment      |
| `PUT /expenses/:id`          | `expenses.edit`    | Edit a draft with version check  |
| `POST /expenses/:id/record`  | `expenses.edit`    | Post a draft expense             |
| `POST /expenses/:id/reverse` | `expenses.reverse` | Reverse a recorded expense       |

### Financial dashboard, reports and cash

| Method / path                 | Permission           | Purpose                                       |
| ----------------------------- | -------------------- | --------------------------------------------- |
| `GET /finance/dashboard`      | `reports.view`       | Month/date-ranged financial summary           |
| `GET /reports/finance`        | `reports.view`       | Full financial report with 12 detail sections |
| `GET /reports/finance/export` | `reports.export`     | CSV export (`report`, `from`, `to`, `period`) |
| `GET /cash-register`          | `cash_register.view` | Sales-side cash movement by method            |

All list endpoints return `{ items, page, pageSize, total, totalPages }`. Error responses use the existing `{ error: { code, message, requestId } }` shape. Operation IDs provide idempotent replay; a changed payload returns `409 OPERATION_CONFLICT`.

---

## 4. Files changed

### Shared contracts

- `packages/shared/src/finance.ts` (new): Phase 5 vocabularies, Zod input schemas, DTOs and report types.
- `packages/shared/src/index.ts`: exports the finance contract.
- `packages/shared/src/permissions.ts`: twelve new permission codes and role grants.
- `packages/shared/src/contracts.ts`: health phase is now `5`.
- `packages/shared/src/sync.ts`: Phase 5 business tables denied by the outbox.

### Database

- `packages/database/src/migrations-finance.ts` (new): migrations 9 and 10.
- `packages/database/src/migrations.ts`: appends the finance migrations.

### API

- `apps/api/src/routes/finance.ts` (new): all Phase 5 routes and permission guards.
- `apps/api/src/services/finance/common.ts` (new): kobo/date/CSV/supplier helpers.
- `apps/api/src/services/finance/records.ts` (new): SQL projections and DTO mappers.
- `apps/api/src/services/finance/purchases.ts` (new): purchase create/update/order/cancel/detail/list.
- `apps/api/src/services/finance/receiving.ts` (new): atomic goods receiving.
- `apps/api/src/services/finance/invoices.ts` (new): supplier invoice balances.
- `apps/api/src/services/finance/accounts.ts` (new): supplier accounts, statements and balances.
- `apps/api/src/services/finance/supplierPayments.ts` (new): payment recording and reversal.
- `apps/api/src/services/finance/expenses.ts` (new): expense categories, drafts, posting and reversal.
- `apps/api/src/services/finance/reports.ts` (new): financial report, dashboard, CSV export and cash register.
- `apps/api/src/services/sales/common.ts`: sequence prefixes now include `PO`, `GRN`, `SP` and `EXP`.
- `apps/api/src/app.ts`: registers the finance router and reports health phase 5.

### Web

- `apps/web/src/features/finance/` (new): purchases list/form/detail, goods receiving, receipt history, supplier account, supplier payments, supplier balances, expenses, cash register, financial reports, shared finance UI/helpers.
- `apps/web/src/App.tsx`: Phase 5 routes; existing placeholders preserved for unrelated modules.
- `apps/web/src/features/Dashboard.tsx`: financial overview section and Phase 5 banner label.
- `apps/web/src/features/inventory/SuppliersPage.tsx`: supplier-account link in the row and detail modal.
- `apps/web/src/features/sales/ReportsPage.tsx`: link to the new financial reports workspace.
- `apps/web/src/styles.css`: finance table/metric/statement styles and print rules.

### Tests and tooling

- `tests/finance.test.ts` (new): 16 API/database integration tests covering all Phase 5 behaviours.
- `tests/database.test.ts`: 49-table expectation across Phase 1–5 migrations.
- `tests/e2e/workspace.spec.ts`: extended timeout for the existing long financial-report WCAG scenario (no assertion changes).
- `scripts/capture-phase5.ts` (new): disposable-database screenshot capture used for this report.
- `docs/screenshots/phase5/` (new): eight screenshots.

---

## 5. Permissions added

| Code                        | Owner | Administrator | Manager | Storekeeper | Pharmacist | Cashier |
| --------------------------- | :---: | :-----------: | :-----: | :---------: | :--------: | :-----: |
| `purchases.create`          |  yes  |      yes      |   yes   |     yes     |     no     |   no    |
| `purchases.edit`            |  yes  |      yes      |   yes   |     yes     |     no     |   no    |
| `purchases.cancel`          |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `purchases.receive`         |  yes  |      yes      |   yes   |     yes     |     no     |   no    |
| `supplier_payments.view`    |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `supplier_payments.record`  |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `supplier_payments.reverse` |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `supplier_debts.view`       |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `expenses.create`           |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `expenses.edit`             |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `expenses.reverse`          |  yes  |      yes      |   yes   |     no      |     no     |   no    |
| `reports.export`            |  yes  |      yes      |   yes   |     no      |     no     |   no    |

The pre-existing `purchases.view`, `expenses.view`, `reports.view`, `cash_register.view` and `supplier`-adjacent view permissions are reused rather than re-created. `purchases.view` was already granted to the storekeeper.
`reports.view` and `cash_register.view` already existed from the Phase 1/3 catalog. Cashiers therefore keep register access but receive no purchasing, supplier-payment, supplier-debt, expense or export capability.

Existing grants were not removed. Role grants use IDs starting at `31000000-0000-4000-8000-000000000097`; migration 8 ended at 96.

---

## 6. Tests executed and results

| Command                   | Result                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run typecheck`       | Pass                                                                                      |
| `npm run lint`            | Pass (0 errors, 0 warnings)                                                               |
| `npm run format:check`    | Pass                                                                                      |
| `npm run test`            | **122 passed** in 7 files (106 baseline including Phase 4 + 16 Phase 5 integration tests) |
| `npm run build`           | Pass (API + web; offline shell prepared)                                                  |
| `npm run test:production` | Pass (native SQLite startup, migrations, health, bundled assets, service worker, 404s)    |
| `npm run test:e2e`        | **20 passed** (Playwright, `MEDIMART_SANDBOX_BROWSER=1`, serial worker)                   |

The Phase 5 integration suite covers:

- Draft PO creation, integer-kobo totals, unit conversions, no stock/ledger movement.
- Idempotent replay and changed-payload conflict.
- Order/cancel lifecycle and filtering.
- Partial receiving, batch creation/reuse, ledger movement, duplicate-receipt no-op, over-receipt refusal.
- Rejected/damaged goods without stock or payable.
- Expired-medicine blocking and atomic rollback across multiple lines.
- Supplier account balances and statements.
- Partial/full payments, overpayment refusal, duplicate reference refusal, duplicate submission replay.
- Payment reversal append-only history and double-reversal refusal.
- Expense categories, draft edit, post, reverse, audit metadata and attachment validation.
- Report calculations for sales, collections, purchases, expenses, inventory, COGS, gross profit, operating profit and cash movement.
- Date-range filtering, daily/weekly/monthly trends and invalid ranges.
- CSV export permission separation.
- Cashier/storekeeper permission boundaries.
- Audit actions without credentials or CSRF material.

The Playwright suite verifies the existing Phase 1–3 UI, the 22-item navigation, Phase 4 patient/dispensing flows, responsive layout, accessibility (WCAG A/AA), offline shell, POS sale/refund/debt flows, the separated sales report, and a runtime-error-free smoke pass across the new purchases, expenses, cash register and financial-report routes. The long financial-report scenario now has a 60-second test timeout because the added workspace assertions legitimately take longer on the sandbox browser.

---

## 7. Production verification

`npm run test:production` passed against the compiled production server:

- Native SQLite opened, all migrations applied, `/api/health` returned phase 5.
- Bundled web app and static assets served with the expected cache headers.
- Service worker/offline shell present; no API responses cached by the shell.
- Unknown API paths return JSON 404 rather than SPA HTML.
- Finance routes are part of the compiled API bundle.

The Android/Capacitor runtime was not exercised in this environment. Phase 5 screens remain online-only, consistent with the existing sales/inventory write policy.

---

## 8. Screenshots

All screenshots were captured from the built web app against a disposable database seeded through the public API:

- [Purchases list](screenshots/phase5/01-purchases.png)
- [Purchase detail with receipts and payments](screenshots/phase5/02-purchase-detail.png)
- [Goods receiving form with batch/expiry capture](screenshots/phase5/03-goods-receiving.png)
- [Supplier account, invoices, payments and statement](screenshots/phase5/04-supplier-account.png)
- [Supplier payment modal](screenshots/phase5/05-supplier-payment.png)
- [Expense management](screenshots/phase5/06-expenses.png)
- [Financial reports (full printable page)](screenshots/phase5/07-financial-reports.png)
- [Cash register](screenshots/phase5/08-cash-register.png)

Reproduce them with:

```bash
npm run build
MEDIMART_SANDBOX_BROWSER=1 node --import=tsx scripts/capture-phase5.ts
```

---

## 9. Known issues and incomplete features

1. **Phase 4 arrived after this branch started.** It is merged and renumbered, but the combined migration path (healthcare v9, finance v10/v11) should be reviewed as a unit before release.
2. **Purchase-order PDF is not provided.** Reports and lists are printable and CSV-exportable, but there is no dedicated PO PDF template.
3. **Expense attachments are intentionally small.** Base64 storage is capped at 48,000 characters (36 KB file); larger scans need external document storage, which is outside this phase.
4. **Report inventory valuation is a live balance.** Stock at cost/retail reflects the current on-hand position for any selected period; COGS and movements are period-based.
5. **Supplier payment UI allocates one invoice per payment.** The API supports multiple allocations, but the account screen opens the payment modal from a specific invoice. Multi-invoice allocation would be a UI enhancement.
6. **Recorded financial records cannot be edited.** This is by design: corrections use reversal records so history remains auditable.
7. **Cash register is movement, not a physical till count.** It intentionally does not invent an opening balance; cash-up/reconciliation against counted cash is not in this phase.
8. **Phase 5 Playwright coverage is UI smoke-level.** API integration tests cover the business rules in depth; the new screens are exercised by a route/heading/no-runtime-error smoke test and the screenshot run rather than dedicated assertion-heavy e2e scenarios.
9. **No Phase 6 work was started.**

---

## Review checklist

- [ ] Confirm the combined Phase 4 + Phase 5 migration order and role grants.
- [ ] Review migration 10/11 DDL and the deliberate absence of a delete trigger on `purchase_order_items`.
- [ ] Review supplier-payment and expense reversal semantics.
- [ ] Confirm storekeeper `purchases.create/edit/receive` is the intended default.
- [ ] Confirm the 36 KB attachment limit is acceptable.
- [ ] Run `npm run check` and `MEDIMART_SANDBOX_BROWSER=1 npm run test:e2e` in CI.
