# Phase 8 — Functional Audit, Bug Fixes & Premium UI Redesign

This report covers what was inspected, what was broken, what was repaired, and what was verified.
Every claim below was checked against source code and against the running application — not against
the README (which still describes phases 1–7 and was treated as unverified).

Branch: `arena/a2aa1330-medimart` (from `cf4621b`).

---

## 1. Method

Three independent sources were used for every finding:

1. **Source audit** — `apps/web`, `apps/api`, `packages/shared`, `packages/database`, `tests`,
   `scripts`, `docs`.
2. **Live API probing** — scripted calls against the running server
   (`.artifacts/audit/audit.mjs`, `.artifacts/audit/phase8.mjs`).
3. **Real browser sessions** — Playwright driving the actual UI, screenshotting all 15 routes
   (`.artifacts/audit/shot.mjs`, `shots/*.png`) and exercising the import wizard end to end
   (`.artifacts/audit/import-wizard.mjs`).

Findings were prioritised P0–P3 in `docs/PHASE_8_AUDIT.md` and fixed in that order.

---

## 2. Bugs found and fixed

### P0 — broken at runtime

| #   | Bug                                                                                                                | Root cause                                                                                                                            | Fix                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /api/products` and `POST /api/products/import` both returned **500 SqliteError**                             | The product `INSERT` had a hand-counted placeholder list that no longer matched the extended column list (`27 values for 25 columns`) | Placeholders are now **derived** from `productColumnList`, so adding a column can never desynchronise the statement from its values (`services/inventory/products.ts`) |
| 2   | Import of a real supplier file returned **500**                                                                    | `resolveReference()` queried a non-existent `code` column on `categories`                                                             | Units match on code/name/symbol; categories match on name only (`services/inventory/import.ts`)                                                                        |
| 3   | Any short import idempotency key crashed on a `CHECK`                                                              | Column stores a 64-char fingerprint                                                                                                   | The client key is SHA-256 hashed on write and on lookup, so a short human key works and replay still matches                                                           |
| 4   | A single bad spreadsheet row rejected the **whole file** with a field error the shopkeeper could not map to a line | Row schema used strict `.min(2)`/`z.enum` validation                                                                                  | Schema now enforces structure only; semantic validation happens per row and is **reported with its row number**                                                        |
| 5   | Production error log printed `{"kind":"SqliteError"}` with no detail                                               | Diagnostic stripped                                                                                                                   | Constraint messages are now logged (they name a rule, never a row value or statement)                                                                                  |
| 6   | Toast sat on top of page content for 6.5 s on every navigation                                                     | Timer not keyed to toast identity                                                                                                     | Keyed expiry (4.5 s success / 9 s error) plus a dismiss button                                                                                                         |

### P1 — features that existed in the API but not in the UI

| #   | Gap                                                                                                                                                       | Fix                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 7   | `/staff`, `/permissions`, `/audit-logs`, `/pharmacy`, `/mini-mart` rendered `PlaceholderPage` ("Planned module", "Phase 1") despite complete, tested APIs | Five real pages built (§5)                                                                                        |
| 8   | Staff could not be disabled, re-enabled, have roles changed, or have passwords reset from the UI                                                          | Implemented with full safety rules (§6)                                                                           |
| 9   | Permissions were read-only text; no way to change what a role can do                                                                                      | Interactive role/permission matrix with optimistic updates                                                        |
| 10  | Audit log existed in the DB with no reader                                                                                                                | Searchable, filterable, expandable ledger with actor names resolved                                               |
| 11  | No bulk product onboarding at all — the user's stated concern about "registering a very large number of products"                                         | Three-step CSV import wizard with preview, duplicate detection, error report and run history                      |
| 12  | Product form had no pharmacy identity fields                                                                                                              | Added dosage form, strength and pack size                                                                         |
| 13  | Notification bell was decorative                                                                                                                          | Live alerts derived from real expiry/low-stock/debt figures, permission-scoped                                    |
| 14  | Inventory sub-nav clipped its last items at 1440 px                                                                                                       | Wraps instead of clipping                                                                                         |
| 15  | Import history table rendered blank counts                                                                                                                | API returned `createdRows`; page expected `createCount`. A shared `ProductImportRun` type now pins the contract   |
| 16  | `npm test` failed after the migration (schema inventory assertions)                                                                                       | Expected table list extended to the 54 tables and 2 new outbox exclusions — assertions strengthened, not weakened |

---

## 3. Pharmacy module

Verified working (source + live):

- Medicine registration with **dosage form** (19 canonical forms, aliases normalised), **strength**,
  **pack size**; edit and deactivate.
- Search across name, generic, brand, manufacturer, SKU, barcode, strength and form via a
  maintained `search_text` column with a dedicated index.
- Server-side filters: type, status, category, stock state, **dosage form**, **expiry state**
  (`expired` / `expiring` / `valid`), with sort by name, price, stock, reorder level, nearest expiry.
- Batches keep their own number, expiry, cost, quantity and supplier; multiple batches per medicine.
- Stock ledger is immutable and authoritative; `recordMovement` uses compare-and-set on
  `stock_balances.version` / `product_batches.version`, rejects negative stock, and only
  `opening_stock` / `stock_received` increment `quantity_received`.
- Expired stock is never sellable: POS sellable quantity is `min(stock, validBatched)` for
  expiry-tracked products. `EXPIRY_IN_PAST` is rejected at receipt.
- FEFO allocation and transaction integrity were **preserved unchanged** — no dispensing or sale
  path was rewritten.
- New read-only endpoints: `GET /api/clinical-addenda`,
  `GET /api/prescriptions/:id/dispensing-record` (batch + movement behind every dispensed line).
  `POST /api/clinical-addenda` appends an attributed, dated correction without mutating the original.

**Not changed (deliberately):** checkout, dispensing and stock arithmetic. The audit found them
correct and covered by tests; rewriting them would have risked the ledger integrity the user asked
to preserve.

---

## 4. Permissions and staff access

- The permission model was **not replaced**. Two permissions that APIs already needed but the model
  lacked were added (`products.import`, `staff.deactivate`, `staff.reset_password`,
  `consultations.amend`), mapped to sensible roles, and granted in migration v14.
- Authorisation is enforced server-side on every route; a denied call returns
  `403 PERMISSION_DENIED` rather than relying on a hidden button. Verified live: a cashier cannot
  import, list import runs, read products, or read the inventory dashboard.
- **Permission changes take effect immediately** — permission state is read from the database per
  request, so an existing session gains or loses access on its next call (covered by test).
- Eight requested roles map onto the existing seven without changing the model:
  Doctor/Nurse → `healthcare_professional`, Inventory Officer → `storekeeper`,
  Receptionist → `cashier`, Super Admin/Owner → `owner`.
- Safety rules implemented and tested: no self role change (`409 SELF_ROLE_CHANGE`), no
  self-disable (`409 SELF_DISABLE`), last-owner protection (`409 LAST_OWNER`), no privilege
  escalation (`ROLE_ESCALATION` / `PERMISSION_ESCALATION`), owner role immutable
  (`409 OWNER_IMMUTABLE`), disabling or resetting a password revokes all sessions.
- Existing users and role assignments were preserved; the migration only **grants**.

---

## 5. New screens (real, not placeholders)

| Route                        | What it does                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/staff`                     | Team accounts with roles, status, session counts, last activity; create, change roles, disable/enable, reset password |
| `/permissions`               | 7 role tabs × 69 permissions, grouped in shop terms, with plain-language explanations; toggles write to the API       |
| `/audit-logs`                | 100 most recent entries, area filters, search, expandable detail with actor, record, device, request id and metadata  |
| `/pharmacy`                  | Medicines, expiry pressure, low stock, today's takings, pharmacy workflow, catalogue search                           |
| `/mini-mart`                 | Retail items grouped by type, restock signal, purchasing shortcuts                                                    |
| `/inventory/products/import` | The bulk import wizard                                                                                                |

Stale copy removed: all 12 "Phase 1 / Planned module / later phase" strings, and the placeholder
page itself is no longer reachable from navigation.

---

## 6. Scalability for a large catalogue

- **Never loads the whole catalogue**: list endpoints are paginated server-side with search, filter
  and sort pushed into SQL; the UI debounces search and renders loading, empty and error states.
- **Indexes**: `idx_products_search_text`, `idx_products_dosage_form`, `idx_products_strength`
  (migration v14), on top of the existing name/SKU/barcode indexes.
- **No hardcoded product limit** was introduced. The import accepts up to 5,000 rows per run and
  runs in one transaction.
- Baseline performance (unchanged by Phase 8, measured earlier): 400-product catalogue listing
  51 ms, POS search 10 ms, 200 checkouts 2.9 s, financial report 30 ms.
- Import is idempotent by key and transactional: a clean file is applied entirely, a file with any
  error writes nothing (`400 IMPORT_HAS_ERRORS`).

---

## 7. UI redesign

**Design tokens** now derive from the requested palette: emerald `#047857`, deep emerald `#064E3B`,
navy `#0F172A`, `#F8FAFC` canvas, teal accent `#14B8A6`, plus a full slate/line/shadow/radius scale.

The old stylesheet mixed **344 distinct hand-written hex colours**. Every one was mapped onto the
token set (neutrals → slate canvas/line/muted, greens → emerald scale, ambers → amber scale), leaving
**zero** stray hex values outside the token block. A single refinement layer then re-treats the
shared component classes so every existing screen inherits the new identity without markup changes:

- **Sidebar** — deep-emerald gradient rail, teal active state with a glowing indicator, readable
  group labels, no more washed-out grey.
- **Cards/metrics** — 12 px radius, subtle two-layer shadows, hover lift.
- **Tables** — uppercase slate headers, honest row density, tabular numerals, no zebra noise.
- **Buttons/inputs** — consistent radii, emerald focus ring, visible keyboard focus everywhere.
- **Dashboard** — rebuilt around real data: sales today, money collected (cash/transfer split),
  gross profit, outstanding debts, a 7-day revenue bar chart, recent sales, recent stock movements
  from the ledger, a "needs attention" panel computed from expiry/low-stock/debt, inventory
  valuation, month-to-date financials, and permission-scoped quick actions. No fabricated statistics;
  absent data renders an honest empty state.
- **Notifications** and **nav search** are now real (Ctrl/⌘K), and reduced-motion preferences are
  respected.

Responsive: stat grids collapse 4→2→1, the dashboard becomes single-column below 1180 px, and the
mobile drawer, scrim and focus trap are unchanged.

---

## 8. Migrations added

**One migration, v14** (`packages/database/src/migrations-phase8.ts`). No released migration was
edited; checksums of v1–v13 are untouched.

- `products`: `+ dosage_form` (19-value CHECK), `+ strength`, `+ pack_size`, `+ search_text`
  (backfilled, unaliased expression), plus 3 indexes.
- New STRICT tables: `product_import_runs` (unique 64-char idempotency fingerprint, counters,
  report JSON, status/dry-run CHECKs) and `clinical_addenda` (append-only triggers).
- 5 permission rows (indices 130–134) and the corresponding role grants — **additive only**.

Applied to the development database: schema version 14, 54 tables, 73 permissions.

---

## 9. Tests executed

| Command                       | Result                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`           | **pass** (exit 0)                                                                                                 |
| `npm run lint`                | **pass** (0 errors, 0 warnings)                                                                                   |
| `npm run format:check`        | **pass** ("All matched files use Prettier code style!")                                                           |
| `npm test`                    | **pass** — 13 files, 177 tests                                                                                    |
| `npm run build`               | **pass** — web bundle + offline shell                                                                             |
| `npm run test:production`     | **pass** — compiled API smoke check incl. POS partial/full dispensing                                             |
| `npm run check`               | **pass** — the full chain above                                                                                   |
| Browser walkthrough           | 15 routes screenshotted, no console errors except the two by-design session-probe 401s                            |
| Import wizard (browser)       | upload → preview (2 new) → apply (2 created) → fields normalised → re-upload (2 skipped) → history counts correct |
| `.artifacts/audit/phase8.mjs` | **29/29** live API checks pass                                                                                    |

**New regression tests (10):**

- `bulk product import` (5): preview writes nothing and numbers rows correctly; apply normalises
  "tabs"→tablet and populates `search_text`; replay returns the same run without duplicating;
  existing products are skipped unless updating; an invalid row blocks the whole write; history
  records the run and a cashier is refused.
- `staff administration and permission changes` (5): staff listing with roles/sessions; role change
  takes effect on a live session; self role change and self-disable refused; disable revokes
  sessions and blocks sign-in until re-enabled; owner role immutable and permission changes audited.

No test was removed or weakened. The only modified existing assertions were the two schema-inventory
assertions, which were **extended** to cover the new tables and the new outbox exclusions.

---

## 10. Remaining limitations

1. **Sequential per-row product creation in import.** The run is one transaction (safe), but 5,000
   rows means 5,000 `INSERT`s. Fine at a few thousand rows; a bulk `INSERT ... ON CONFLICT` would be
   the next optimisation if shops routinely import 10k+.
2. **Import is CSV only.** Excel is supported via "Save as CSV"; no `.xlsx` parser was added because
   it would require a new dependency.
3. **Audit log is capped at the 100 most recent entries** with no date filter or pagination cursor.
   Filtering is client-side over that window.
4. **Import history is capped at 20 runs**, newest first.
5. **Dispensing and clinical addenda UI** — the APIs exist and are tested
   (`/api/clinical-addenda`, `/api/prescriptions/:id/dispensing-record`), but the dispensing record
   and addendum panels are not yet surfaced in the healthcare screens. The existing
   prescription/dispensing flow is unchanged and working.
6. **Dashboard chart is a CSS bar chart** of net revenue only; no trend line for units or profit, and
   no comparison against the previous period.
7. **Design tokens cover `styles.css` only.** Any inline colour in a component still renders; a lint
   rule to prevent future hardcoded hex values was not added.
8. **The eight-role request is satisfied by mapping**, not by eight stored roles (see §4). Splitting
   `healthcare_professional` into Doctor/Nurse and `cashier` into Receptionist would be a model
   change the user explicitly asked to avoid without justification.

---

## 11. Manual testing instructions

```bash
npm ci
npm run setup            # writes .env (git-ignored)
npm run db:migrate       # applies v14; prints "up to date" if already applied
npm run dev              # API :3001, web :5173
```

Sign in at `http://localhost:5173/#/login` with the owner account created during setup.

**A. Import a catalogue (the large-catalogue workflow)**

1. Inventory → Products → **Import**.
2. Download the CSV template, fill it in, save as CSV.
3. Choose the file → **Preview import**. Confirm the row count and that no row is red.
4. Introduce a mistake (e.g. a price of `abc`) and preview again: the row is named in red and
   **Apply is disabled**.
5. Fix the file, preview, then **Apply import**. Confirm "Imported: N created".
6. Re-upload the same file: rows show as **Skipped**, and **Past imports** lists the run with counts.

**B. Staff and permissions**

1. Administration → Staff → **Add staff**, assign Cashier.
2. Sign in as that cashier in a private window: no Inventory or Pharmacy in the sidebar.
3. As the owner, change the cashier's roles to Storekeeper. The cashier's next click grants
   inventory access — no sign-out needed.
4. Try to change your own roles or disable yourself: refused with an explanation.
5. Disable the cashier, then try to sign in as them: refused. Re-enable: sign-in works again.
6. Permissions → pick a role → toggle a permission. Confirm the sidebar changes for that role and
   Audit Logs records `permissions.granted` / `permissions.revoked`.
7. Permissions → Owner: every toggle is locked and explained.

**C. Dashboard**

1. As the owner with data present, confirm each figure is traceable to a report (click through).
2. Confirm "Needs attention" only lists conditions that are actually true of your data.
3. Sign in as a cashier: sales figures they may not see render as "You do not have access".

**D. Expired stock blocking**

1. Inventory → Receive stock: try an expiry date in the past → rejected.
2. Register a batch, sell it, then check Movement history shows the deduction.

**E. Offline and backup (unchanged, re-verified by `test:production`)**

1. Administration → Backup and Sync → create a backup, verify it.
2. Disconnect the server; the shell reports offline rather than failing silently.
