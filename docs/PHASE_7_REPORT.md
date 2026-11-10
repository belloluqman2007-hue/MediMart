# Phase 7 report: final testing, Android APK, Windows application and release preparation

**Branch:** `arena/4ea764d7-medimart` (from `main` at `f49aac9`, the merged Phase 6 commit)
**Scope:** complete the Android and Windows builds, resolve the Phase 6 outstanding issues, run the
full verification suite, and prepare release material — with every claim tied to a command that ran.

> **Read this first.** Every number below is from a command run in this environment on
> 2026-11-10. Where something could **not** be verified here — a physical Android phone, the target
> HP Stream laptop, a human clicking through the Windows window — it is listed as **not verified**.
> Verification levels are separated deliberately (source build ≠ packaged build ≠ emulator test ≠
> physical-device test).

---

## 1. What was done in this phase

### A. Stock valuation inconsistency (Phase 6 issue A) — fixed

Phase 6 found `/api/inventory/dashboard` valuing stock at product cost prices
(`quantity × products.purchase_cost_kobo`) while `/api/reports/finance` valued it at actual batch
acquisition costs. The two surfaces could disagree by a wide margin whenever delivered cost differed
from the catalogue cost price.

- **New single source of truth:** `apps/api/src/services/inventory/valuation.ts`. The accounting
  treatment (documented at the top of that file and below): **on-hand stock is valued at actual
  batch acquisition cost wherever batch cost data exists** (`product_batches.purchase_cost_kobo`,
  the per-base-unit cost really paid at receiving/correction time); **quantities with no batch
  record fall back to the product's current cost price**; expired batches stay valued at cost until
  an expiry write-off movement removes them; retail value is informational and shown separately.
  Historical transactions are never restated — every sale keeps the COGS recorded at its own
  (FEFO batch) acquisition cost when it happened.
- **Consumers unified on that SQL:** the inventory dashboard, the product list's cost-value column
  (`services/inventory/common.ts`), and the financial reports (`services/finance/reports.ts`, whose
  private valuation function was replaced by the shared one).
- **Regression tests** (`tests/valuation.test.ts`, 3 tests): products with cost price ≠ batch
  acquisition cost, unbatched fallback, mixed batched/unbatched stock, agreement of all surfaces
  (dashboard, `/api/reports/finance` totals + rows, product list), COGS at batch cost with history
  untouched after the change, and fallback behaviour when the cost price is edited later. The one
  pre-existing test that asserted the old dashboard formula (`tests/inventory.test.ts`) was updated
  with a comment explaining the change — its fixture receives a ₦45 pack of 10 tablets, so the
  honest valuation is ₦4.50/tablet delivered cost, not the ₦50 catalogue cost price.

### B. API documentation (Phase 6 issue B) — rewritten

`docs/API.md` no longer says backup and synchronization are "not implemented". It now documents,
verified line-by-line against `apps/api/src/app.ts` and `apps/api/src/routes/*.ts`: the core,
inventory, sales/POS/debts, healthcare, purchasing/finance endpoints, and the **implemented**
offline synchronization (`/sync/status`, `/sync/summary`, `/sync/records`, `/sync/push` with the
envelope/fingerprint/exactly-once behaviour) and **backup/restore** (`/backups`, verify, settings,
prepare-restore with `RESTORE_REQUIRES_STOP`) endpoints, plus the error contract and representative
machine codes. Payload shapes were corrected against the shared Zod schemas (sale lines carry no
`batchId` — FEFO allocates; patient routes use `patients.register`/`patients.edit`;
`prescriptions.dispense`; the sync batch response shape).

### C. Test count discrepancy (Phase 6 issue C) — reconciled

| Source                                    | Count                   | Explanation                                                                                             |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Phase 6 report / PR #9 checks at the time | 153 tests, 11 files     | Checks ran against an earlier commit of the PR                                                          |
| Merged Phase 6 tree (`f49aac9`)           | **155 tests, 12 files** | Two tests landed after the last check run (follow-up PR commits, including `tests/sync-status.test.ts`) |
| After Phase 7                             | **158 tests, 13 files** | Phase 7 added 3 valuation regression tests in `tests/valuation.test.ts`                                 |
| Playwright (Phase 6 and now)              | **22 tests**            | Unchanged; re-run in Phase 7                                                                            |

Actual run today: `npx vitest run` → **13 files, 158 tests, all passing** (≈35 s).
`MEDIMART_SANDBOX_BROWSER=1 npx playwright test` → **22 tests, all passing** (1.6 min).

### D. README and documentation (Phase 6 issue D) — updated

`README.md` status, build, and limitations sections describe Phase 7: the valuation rule, the fixed
Windows packaging, the CI build/verification workflows, and the remaining honest limits. Per the
task, a full shop-owner manual (first owner setup, staff, pairing, offline operation, backup and
restore, troubleshooting) lives in `docs/DESKTOP.md` and `docs/ANDROID.md`, which were already
written in Phase 6 for that audience and are linked from the README's "Install it in the shop" table.

### E. Windows desktop application — packaging fixed, build and verification on Windows CI

Reviewing the Phase 6 packaging exposed real defects that would have broken a shop computer even
though `scripts/build-desktop.mjs` reported success:

1. **Incomplete runtime closure.** Only a named list of packages was copied into
   `resources/server/node_modules`. The API bundle externalizes `express`, `helmet`, `zod`, etc.,
   and express's **transitive** runtime dependencies (`body-parser`, `cookie`, `send`, …) were never
   copied — the packaged server would have crashed on startup with `Cannot find module`. The script
   now walks the dependency closure (82 packages staged, verified) and copies it dereferenced.
2. **Unix-only shell commands** (`cp -RL`, `unzip`, `zip`) — the script could not run on Windows at
   all. Replaced with Node `fs.cpSync` and `tar`-based zip handling (Windows ships bsdtar).
3. **Native addon verification.** `better-sqlite3@13` and `argon2@0.45` are ABI-stable **N-API**
   addons that ship per-platform prebuilds inside their packages (including `win32-x64`), which the
   loader (`lib/win32-x64.js`, `prebuilds/win32-x64/`) resolves at runtime. The staged tree is now
   checked for a loadable **win32-x64** addon before anything is zipped; distribution is refused
   otherwise. Output built on a non-Windows host is labelled `verified: false` in
   `build-manifest.json`.
4. **Verification on a real Windows runner.** New workflow `.github/workflows/desktop.yml`
   (`windows-latest`): `npm ci`, typecheck, ESLint, the **full test suite on Windows**, production
   build + compiled-server smoke test, Playwright end-to-end tests, `node scripts/build-desktop.mjs`,
   then a **packaged smoke test through the exact runtime path** (`ELECTRON_RUN_AS_NODE=1
MediMart.exe resources\server\index.js` serving `/api/health` and the app shell), a window launch
   with screenshot, and artifact upload (portable zip + manifest).

### F. Android APK — build and verification on CI + emulator

`scripts/build-apk.mjs` requires JDK 21 and Android SDK 36. This sandbox can only reach
github.com, registry.npmjs.org and pypi.org: **`dl.google.com`, `maven.google.com` and
`services.gradle.org` are blocked, and GitHub release-asset downloads are blocked by the egress
proxy**, so neither the Android SDK/Gradle/AGP nor a JDK binary can be fetched here. A local APK
compile is therefore impossible in this environment (the script's own toolchain check reports
exactly that). The build path is the CI runner, which has open internet:

- `.github/workflows/android.yml` (existing job, extended): builds `com.medimart.app` with
  `assembleDebug`, verifies the application id, the optional camera permission (and the absence of
  location/contacts/SMS permissions), version name/code, and that no `.env`, keystore or token is
  embedded in the APK.
- New **emulator job**: installs the APK on an Android 30 x86_64 emulator (KVM-enabled runner),
  verifies `package:com.medimart.app`, launches `com.medimart.app.MainActivity`, and captures
  screenshots + `dumpsys package` + logcat as artifacts.

## 2. Verification results (commands run in this environment, 2026-11-10)

| Check                                                                                                           | Result                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm ci` (native modules compiled from source against local headers)                                            | 484 packages, ok                                                                                           |
| `npm run typecheck`                                                                                             | pass                                                                                                       |
| `npm run lint` (ESLint)                                                                                         | pass                                                                                                       |
| `npm run format:check` (Prettier)                                                                               | pass                                                                                                       |
| `npx vitest run`                                                                                                | **13 files, 158/158 passed**, ≈35 s                                                                        |
| `npm run build` (API bundle + web build)                                                                        | pass                                                                                                       |
| `npm run test:production` (compiled-server smoke)                                                               | pass (native SQLite startup, migrations, health, UI assets, auth/POS/healthcare boundaries, replay safety) |
| `MEDIMART_SANDBOX_BROWSER=1 npx playwright test`                                                                | **22/22 passed**, 1.6 min                                                                                  |
| `node scripts/build-desktop.mjs` packaging pipeline (layout/closure/zip/manifest checks, stub Electron runtime) | pass — 82-module closure, win32-x64 addons present, 14.7 MB zip                                            |

## 3. Verification levels (what is proven where)

| Level                                                 | Status in Phase 7                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Source-code build (Node 22, Linux sandbox)            | ✅ verified here (tests, build, smoke)                                                             |
| Packaged desktop pipeline (layout, closure, manifest) | ✅ verified here with a stub runtime                                                               |
| Packaged **Windows** application build                | ⏳ `windows-latest` CI workflow (build + full tests + packaged smoke + window launch + screenshot) |
| Android APK compile + package verification            | ⏳ Ubuntu CI workflow (apkanalyzer checks, secret scan)                                            |
| Android **emulator** install/launch                   | ⏳ CI emulator job (install, launch, screenshot, dumpsys)                                          |
| Physical Android device                               | ❌ **not tested** — no device available here                                                       |
| Actual Windows computer / target HP Stream 11 Pro     | ❌ **not tested** — no Windows machine here; the CI runner is not the HP laptop                    |

Workflows are dispatched from this branch and re-run on `main` when the PR merges; artifacts (APK,
Windows zip, screenshots) appear on the workflow runs in the repository's **Actions** tab and should
be attached to a GitHub Release before shop deployment. Nothing large is committed to the
repository.

## 4. Performance measurements (development sandbox only)

The Phase 6 performance harness (`tests/performance.test.ts`, 400 products / 1,200 sales) re-ran as
part of the suite on this sandbox (2 vCPU, 3.8 GB RAM, Linux): POS 200 checkouts × 6 items ≈ 2.2 s
(≈11 ms/checkout), sales report 7.6 ms, financial report (month) 24 ms, inventory dashboard
aggregates 4.7 ms (batch-aware valuation included), stock movement page 3.5 ms, backup create +
verify 80 ms. **These are development-computer measurements, not measurements from the HP Stream
11 Pro (Celeron N3050, 4 GB RAM, Windows 10). The target laptop has not been tested.** Its
limitations should be checked with the real packaged application before trading.

## 5. Phase 6 outstanding issues — status

| Issue                                        | Status                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| A. Stock valuation inconsistency             | ✅ fixed + 3 regression tests + accounting treatment documented         |
| B. API documentation outdated                | ✅ rewritten against the real routes (sync + backup included)           |
| C. Test count discrepancy (155 vs 153 vs 22) | ✅ reconciled (table above); current: 158 unit/integration + 22 browser |
| D. README and documentation                  | ✅ updated (Phase 7 status, limits, CI verification paths)              |

## 6. Remaining issues (known, not fixed)

1. **No physical Android device test and no HP Stream test.** Before real trading, install the APK
   on the shop's phones and run the portable Windows zip on the shop computer; walk the UAT script
   (`docs/PHASE_6_UAT.md`) with fake data.
2. **CI artifacts need attaching to a GitHub Release** (or an internal share) for shop owners to
   download; the workflows produce them but this repository has no release automation yet.
3. **No code signing** (Android release keystore, Windows certificate) — debug/unsigned builds only.
   Release signing must use environment-supplied secrets (`scripts/build-apk.mjs --profile release`),
   never committed keys.
4. **No Windows Installer** — the distribution is a portable folder + zip by design (no admin
   rights needed). An installer can be added later if owners want shortcuts.
5. **A paired Android installation cannot change servers** (safe rebind not implemented).
6. **The central database and backups are unencrypted at rest** — they rely on Windows account
   permissions; keep backups private.
7. **No offline authentication** — phones must sign in while connected at least once.
8. **Automatic backup scheduling** is configurable (`/api/backups/settings`) but not verified
   end-to-end over long periods.

**Stop after Phase 7.** Phase 8 has not been started.
