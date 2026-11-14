# Phase 8 — audit findings (verified against the running application)

Every item below was reproduced against a running API and a real browser, not inferred from the
README. "Verified" means an actual request or click produced the described result.

## Baseline

| Check               | Result before Phase 8                        |
| ------------------- | -------------------------------------------- |
| `npm run typecheck` | pass                                         |
| `npm test`          | pass — 13 files, 167 tests                   |
| Browser console     | 2 × `401` on anonymous startup (expected)    |
| Seeded database     | 7 roles, 259 grants, 11 units, 11 categories |

## P0 — broken or missing functionality

1. **Permissions page is a placeholder.** `/permissions` renders `PlaceholderPage`; `permissions.manage`
   is seeded and granted to the owner but no endpoint exists to change a grant. Verified: the page
   shows "FOUNDATION · PHASE 01".
2. **Staff page is a placeholder.** `/staff` renders `PlaceholderPage`. Verified: `/api/staff`
   returns only `id, full_name, email, status, created_at`, so role, last sign-in and lockout state
   are not readable and there is no way to change a role, disable an account or reset a password.
3. **Pharmacy module is a placeholder.** `/pharmacy` and `/mini-mart` render `PlaceholderPage`
   although the medicine, batch, expiry, POS and prescription features they describe are implemented.
   Verified: both pages show "A space for what comes next".
4. **Audit Logs page is a placeholder.** `/audit-logs` renders `PlaceholderPage`; `raw /api/audit-logs`
   is implemented but is not used by any screen.
5. **No bulk product import.** 404 on every `/api/products/import*` route. Registering thousands of
   products one form at a time is the only supported path.
6. **No product activation/deactivation control in the UI.** `POST /api/products/:id/activate|
deactivate` and `products.deactivate` exist; no screen calls them.
7. **No product expiry filter.** `GET /api/products?expiry=expiring` → `400 VALIDATION_ERROR`.
   Batches can be filtered by expiry; products cannot.
8. **No dispensing record exported from a prescription.** Verified working: FEFO, exactly-once
   dispensing, expired-batch blocking. Verified missing: a printable dispensing record and a way to
   continue a partially dispensed prescription from the list.

## P1 — data model gaps for a real pharmacy

9. **No dosage form or strength on a product.** Verified: `dosageForm` and `strength` are absent from
   every product response. A pharmacy cannot distinguish "Paracetamol 500 mg tablet" from
   "Paracetamol 120 mg/5 ml syrup" except by free text in the name. Prescription lines therefore
   carry a free-text `strength` that is not checked against the catalogue.
10. **No generic-substitution search.** `generic_name` is searchable but not returned as a distinct
    field in POS results beyond the name.
11. **Medical records are fully editable.** Verified: no `patients.record.merge`, no clinical
    addendum, no correction path. A clinical record can be rewritten in place, which contradicts the
    append-only discipline used by the stock ledger and the audit log.

## P2 — correctness / integrity findings (checked, not broken)

Verified working and left untouched: FEFO allocation order, exactly-once dispensing through
`operation_id` + fingerprint, duplicate-receipt rejection, expired-batch blocking in POS, negative
stock prevention (`INSUFFICIENT_STOCK`), compare-and-set stock balances, append-only audit triggers,
backup/restore verification, offline outbox contracts.

The following were checked and are **not** bugs:

- Anonymous startup makes two `401` requests; that is the session probe.
- `POST /api/consultations` and `POST /api/prescriptions` returning `PROFESSIONAL_REQUIRED` for the
  owner role is intended: administrative access is not clinical authorization.

## P3 — UI/UX findings

12. Dashboard is dominated by empty-state cards, a "Phase 05 · Purchasing & finance" hero banner, a
    3-step "Let's make it yours" setup wizard, a "Planned module" grid and a "Connection & storage"
    panel that still says "Not active in Phase 1". These are not business information.
13. Six pages still say "Phase 1", "FOUNDATION · PHASE 01" or "will be introduced in a later phase".
14. Sidebar has no searchable navigation, no breadcrumbs beyond "Workspace › Page", and the module
    grouping puts `Point of Sale` under "Workspace" rather than with trading.
15. Inventory sub-navigation overflows horizontally at 1440 px (the "Reconciliation" tab is cut off).
16. Tables have no row-level actions, no sticky headers and no skeleton loading state.
17. No charts anywhere, so trends (daily sales, stock value, expiry exposure) are unreadable.

## Product scalability review (findings)

- Server already paginates, filters, sorts and searches on the server (`productListQuerySchema`,
  page size capped at 100). Confirmed: 400 products measured, POS search 10 ms.
- `idx_products_name` is `name` only; `LIKE '%term%'` cannot use it. Searches fall back to a scan of
  `products`. Acceptable at 10 000 rows, but there is no FTS index and no covering index for the
  default `ORDER BY created_at, id` plus status filter.
- No import path, so a 10 000-product catalogue can only be built through 10 000 form submissions.
- No `products.import` capability exists, which matters because import is a bulk write that must be
  authorized separately from single-product creation.
