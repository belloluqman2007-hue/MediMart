# Phase 6 report: offline sync, backup/restore, Windows desktop, Android readiness

**Branch:** `arena/65b54ec8-medimart` (from `main` at `0dd338a` after Phase 5 was merged)
**Scope:** make MediMart installable and testable in a real shop — Windows application, Android
application, LAN connection, offline operation, backup and restore, end-to-end testing.

> **Read this first.** Every result below was produced by a command run in this environment. Where
> something could **not** be verified here — the Windows window itself, and an Android APK — it is
> listed as **not verified** rather than described as working. No claimed test result is inferred.

---

## 1. What was added in this phase

### Offline capture and synchronization (`apps/api/src/services/sync.ts`, `routes/sync.ts`, `packages/shared/src/offline.ts`, `packages/database/src/migrations-offline.ts`, `apps/web/src/platform/offline.ts`)

- Device-scoped outbox: a phone can capture sales, customers, debt repayments, stock receipts,
  purchase orders and expenses while the shop computer is unreachable.
- Envelopes are signed with a canonical-JSON SHA-256 fingerprint bound to the installation. A
  tampered payload, another installation's device ID, or a clock that is far ahead are rejected
  before any business write.
- One database transaction per envelope, keyed by `operationId`: a replay is recognised as a
  duplicate and changes nothing (no double sale, no double stock movement, no double cash).
- Conflicts and rejections are stored and listed for review — they are never forced through.
- Deliberate offline restrictions, enforced server-side: credit sales, discounts without
  `sales.discount`, and prescriptions are refused when captured offline.
- Automatic push when a phone reconnects with a live session (`AppProvider` effect), plus an explicit
  **Synchronize now** button.

### Backup and restore (`apps/api/src/services/backup.ts`, `routes/sync.ts`, `apps/web/src/features/BackupSyncPage.tsx`)

- Backups are written with SQLite's `VACUUM INTO` — one consistent snapshot even while the shop is
  selling — then **re-opened and verified** (integrity check, checksum, row counts, schema version).
- File names carry millisecond precision, and an existing file is never overwritten.
- Restore is prepare-only while the server runs: the verified copy and a request marker are staged,
  and the swap happens at the next start with a `pre-restore-<timestamp>` safety copy. Swapping the
  file under a live connection would corrupt the database, so this is deliberate.
- Safety rules: a backup folder may not be the live database file, inside it, or a folder that
  contains it. Retention keeps the newest N. `settings.view` / `settings.manage` govern access;
  a cashier is refused.

### Windows desktop application (`apps/desktop/`, `scripts/build-desktop.mjs`)

- Electron 38.4.0 shell, one window on `http://127.0.0.1:4780`, `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, no preload, navigation blocked, new windows
  denied.
- The API runs as a child of the same executable (`ELECTRON_RUN_AS_NODE=1`) and is stopped on close
  before the app quits.
- Data in `%APPDATA%\MediMart\data\medimart.sqlite`; backups in `%APPDATA%\MediMart\backups` plus a
  Documents copy; settings and the generated setup token in `medimart.env` (mode `0600`).
- Portable folder plus a zip — no installer, no Administrator rights, no code signing. See
  [DESKTOP.md](DESKTOP.md) and the verification status there.

### Android (`apps/web/android/`, `scripts/build-apk.mjs`)

- `com.medimart.app`, version `0.2.0` (versionCode 2), name "MediMart".
- Camera declared **optional**, requested at runtime only when the point of sale opens the scanner;
  the request is granted to the WebView for the video-capture resource only.
- Release network policy: cleartext off, system certificate authorities only. Debug builds allow
  cleartext on a private LAN so a shop without internet can test — with the flag documented as
  debug-only.
- `scripts/build-apk.mjs` builds the debug or release APK, checks the package identifier with
  `aapt2`, and refuses to claim a result it did not produce. Release signing is read from environment
  variables; `*.jks`/`*.keystore` are git-ignored.
- See [ANDROID.md](ANDROID.md) for install steps and the honest verification table.

### Interface

- New **Backup and Sync** page (`/backup-sync`): synchronization counters, records from connected
  devices, backup creation, per-file verification, restore with a typed confirmation, and a plain
  explanation of what a backup contains.
- POS: an unreachable shop computer offers **Keep sale on this device** on a phone; a browser says
  plainly that it cannot keep a sale, because it has no safe store.
- POS: **Camera** barcode capture with a graceful "this device cannot decode" message.

---

## 2. Schema

Schema version **13**, **52 tables** (Phase 5 was 49). New: `sync_devices`, `sync_queue`,
`sync_receipts`, `sync_conflicts` and the backup tables. Migration v13 seeds `sync.view` and
`sync.manage` grants. `migrations.ts` is unchanged in behaviour for earlier versions: version 12 is
the Phase 5 schema, and existing databases migrate forward without a rewrite.

---

## 3. Test results (all commands run here)

| Command                                          | Result                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run`                                 | **153 passed / 153**, 11 files, 34.9 s                                                                                                                                                                                                                          |
| `npx vitest run tests/sync.test.ts`              | **9 passed**                                                                                                                                                                                                                                                    |
| `npx vitest run tests/backup.test.ts`            | **6 passed**                                                                                                                                                                                                                                                    |
| `npx vitest run tests/uat.test.ts`               | **15 passed** (the UAT scenarios in section 4)                                                                                                                                                                                                                  |
| `npx vitest run tests/performance.test.ts`       | **1 passed** (measurements in section 6)                                                                                                                                                                                                                        |
| `npx tsc --noEmit`                               | clean                                                                                                                                                                                                                                                           |
| `npm run lint`                                   | clean                                                                                                                                                                                                                                                           |
| `npx prettier --check .`                         | clean                                                                                                                                                                                                                                                           |
| `npm run build`                                  | web + API built (one benign `INEFFECTIVE_DYNAMIC_IMPORT` warning, explained below)                                                                                                                                                                              |
| `npm run test:production`                        | passed — native SQLite startup, migrations, health, bundled UI/assets, service-worker boundary, JSON/asset 404 boundaries, healthcare auth boundaries, synthetic registration/consultation/vitals, authorization, POS partial dispensing/replay/full dispensing |
| `MEDIMART_SANDBOX_BROWSER=1 npx playwright test` | **22 passed / 22**, 1.5 min                                                                                                                                                                                                                                     |
| `npm run desktop:build`                          | package assembled; packaged server verified (section 5)                                                                                                                                                                                                         |
| `npm run android:apk`                            | **not run to completion** — no JDK or Android SDK in this environment (section 7)                                                                                                                                                                               |

The build warning is real and harmless: `src/platform/offline.ts` is dynamically imported in
`AppProvider` and statically imported by two pages, so Rollup cannot split it into its own chunk. The
behaviour is identical; only the chunk layout differs.

### New automated tests in this phase

- `tests/sync.test.ts` (9): exactly-once apply and replay, fingerprint/clock rejection, cross-device
  rejection, insufficient stock without partial application, revoked device 401, browser session
  refused for device push, offline customers/debts/receipts/purchases/expenses, unauthorized offline
  discount, status and record listing, ledger equality after sync.
- `tests/backup.test.ts` (6): verified backup with checksum and row counts, corrupt file refused with
  `BACKUP_CORRUPT`, restore preparation leaves the live database untouched, permission and unsafe
  path refusal, no overwrite within the same second, retention keeps the newest N.
- `tests/uat.test.ts` (15): the fictional trading day below.
- `tests/performance.test.ts` (1): the measurements in section 6.
- Playwright (2 new): backup/sync page create → verify → restore confirmation; browser POS refusing to
  pretend an unreachable sale was saved.

---

## 4. UAT: one fictional trading day (15 scenarios, `tests/uat.test.ts`)

Every name, phone number, patient and product here is invented. No real patient data is used and no
automated test generates a diagnosis or prescribes a medicine — the prescription in scenario 7 is
entered by the fictional clinician, and the system only presents the recorded allergy for review.

| #   | Scenario                                                               | Result                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Opening stock on hand, priced, on the dashboard                        | passed — 100 tablets + 60 bottles, dashboard total 160                                                                                    |
| 2   | Purchase order → partial delivery → second delivery → supplier balance | passed — status `partially_received` → `received`, outstanding equals received value                                                      |
| 3   | Role boundaries (cashier, pharmacist, manager)                         | passed — finance/audit refusal, product creation refused for cashier                                                                      |
| 4   | POS: cash with change, split POS+cash, credit sale                     | passed — ₦6,300 sale with ₦700 change; ₦1,200 credit outstanding                                                                          |
| 5   | Discount refused without supervisor, allowed with credentials          | passed — `DISCOUNT_NOT_AUTHORIZED`/`PERMISSION_DENIED`, then recorded with reason                                                         |
| 6   | Refund restocks and pays back; a second reversal is refused            | passed                                                                                                                                    |
| 7   | Patient → consultation → vitals → prescription → authorize → dispense  | passed — allergy surfaced, no automatic clinical decision, FEFO took the earlier-expiring batch                                           |
| 8   | Expense recorded, posted, in the report                                | passed                                                                                                                                    |
| 9   | Reports and dashboard reconcile with transactions                      | passed — refunds subtracted once, gross = pre-discount subtotals, stock value matches the valuation rule, ledger sum equals stock on hand |
| 10  | Offline phone sale, then sync; replay; revoked device                  | passed — `applied`, then `duplicate`, stock unchanged; revoked device 401                                                                 |
| 11  | Records cannot be silently deleted; audit trail exists                 | passed — no delete route, database triggers refuse it, audit actions recorded                                                             |
| 12  | Backup → list → verify → restore                                       | passed — row counts match the database                                                                                                    |
| 13  | Low-stock and expiry alerts after trading                              | passed                                                                                                                                    |
| 14  | Stock adjustment requires a reason, appears in movement history        | passed                                                                                                                                    |
| 15  | Audit trail leaks no password, token or device secret                  | passed                                                                                                                                    |

---

## 5. Windows desktop build verification

Run: `npm run desktop:build` with `MEDIMART_ELECTRON_DIR` pointing at a stub runtime, because
the Electron download host is not reachable from this environment.

- Assembled `dist/desktop/MediMart-win32-x64/` — `MediMart.exe`, `resources/app/{main.mjs,
package.json, assets/icon*.png}`, `resources/server/{index.js, chunk-*.js, apps/web/dist,
node_modules/{better-sqlite3, argon2, express, …}}`, plus `build-manifest.json` and
  `MediMart-0.1.0-win-x64.zip`.
- **The packaged server was started from the packaged folder** with a fresh database:
  `{"status":"ok","database":"ready","phase":6,"sync":"offline_capture"}`, migrations current, `/` and
  `/api/health` both 200. This is the exact server code the desktop shell launches.
- `node --check` passes for `main.mjs` and `build-desktop.mjs`; the packaging logic ran end to end.
- **Not verified:** launching the real Electron window on Windows, the Windows taskbar icon, and
  shutdown-without-corruption on a real machine. This machine is Linux, and `electron.exe` here was a
  stub. Do not describe the desktop application as tested on Windows until that has been done.

## 6. Performance measurements (this machine, not the shop computer)

Measured by `tests/performance.test.ts` against a database with 400 products, 200 completed sales and
1,200 sold line items, through the real HTTP surface:

| Operation                                   | Time                         |
| ------------------------------------------- | ---------------------------- |
| First owner registration (Argon2id hashing) | 157 ms                       |
| Create 400 products (single transaction)    | 31 ms                        |
| POS product search in 400 products          | 8.4 ms                       |
| POS first page of 40 products               | 5.7 ms                       |
| 200 checkout requests, 1,200 items total    | 2,109 ms (≈10.5 ms per sale) |
| Sales report (today)                        | 6.7 ms                       |
| Financial report (month)                    | 31 ms                        |
| Inventory dashboard aggregates              | 17 ms                        |
| Stock movement history page                 | 3.1 ms                       |
| Create and verify a backup (1.8 MB)         | 119 ms                       |

The test asserts only generous ceilings (search < 1.5 s, monthly finance report < 5 s, dashboard < 3 s,
backup < 60 s), because the target is an Intel Celeron N3050 with 4 GB RAM — a slower machine than
this one. **These numbers are not a measurement on the target hardware.** They show the queries and
payloads are small; the shop computer should still be timed on arrival using the same script.

Long-session stability: not measured. No soak test was run. The server has no background workers, no
polling loops and no external services; memory use is dominated by SQLite's page cache.

## 7. Android status

**No APK was built in this environment.** `java` is absent and there is no Android SDK, so
`scripts/build-apk.mjs` exits non-zero with exactly that message. What _was_ verified:

- The Capacitor project configures `com.medimart.app`, version `0.2.0` (code 2), `minSdk 24`,
  `targetSdk 36`, JDK 21 and Gradle 8.14.3.
- `npm run android:sync` copies the built interface into the native project (run as part of the build).
- The manifest declares `INTERNET`, `ACCESS_NETWORK_STATE` and an **optional** `CAMERA`; there is no
  location, contacts, SMS or background-service permission. `allowBackup="false"`, release
  `usesCleartextTraffic="false"`, release trust anchors are system-only.
- `AppIdentityTest` covers the package id, display name, no-backup flag and camera declaration; the
  GitHub workflow compiles it with `assembleDebugAndroidTest`.
- `node --check` passes for the build script; `.github/workflows/android.yml` compiles the debug
  application, checks the identifier and now also checks the camera permission and absence of
  location/contacts/SMS permissions.

**Not verified:** native compilation, an installed APK, SQLCipher encryption on a real phone, Keystore
behaviour, camera scanning on a real device, and LAN pairing between a real phone and a real Windows
computer. Build one where the SDK exists with `npm run android:apk`.

---

## 8. Security and data-integrity review

Fixed in this phase:

1. **Backup permission mismatch (high).** Backup create/restore/settings required `sync.manage`, which
   managers hold for device synchronization; they could therefore replace the entire database. Backup
   operations now require `settings.view` / `settings.manage`, matching what the interface shows.
2. **Backup folder could contain the live database (high).** A directory equal to a parent of the
   database file was accepted, so a backup could be written next to (or a restore staged over) live
   data. Both directions are now refused with `PATH_INVALID`.
3. **Backup overwrite within the same second (medium).** Two backups in one second produced the same
   file name and the older file was silently removed. Names now include milliseconds and an existing
   file is never replaced.
4. **Corrupt backup crashed verification (medium).** A file that is not a database returned a 500
   instead of "failed verification". It now reports `integrityOk: false`.
5. **Restore could not find the default folder (medium).** Restore refused with
   `BACKUP_DIRECTORY_MISSING` when no custom folder had been set, even though a verified backup
   existed in the default folder. The default folder is now used.
6. **Camera permission unusable on Android (medium).** The WebView was never granted camera access, so
   the scanner could not work. The activity now requests the runtime permission for video capture
   only, and refuses non-HTTPS origins.
7. **Debug network policy blocked LAN testing (low).** The debug build inherited the release
   cleartext prohibition, so a shop without internet could not test on a LAN. Debug now permits
   cleartext; release remains TLS-only.

Reviewed and confirmed:

- **Unauthorized access / permission bypass:** every new endpoint is behind `requireAuth` plus a
  permission; grants are re-read per request inside the writing transaction. Covered by the role
  scenarios in UAT and by `tests/api.test.ts`.
- **Session and device auth:** a browser cookie cannot push device records (`DEVICE_REQUIRED`); a
  push is bound to the approved installation (`DEVICE_MISMATCH`); revocation is immediate (401).
  Device secrets are stored in Android Keystore-backed storage, never in the web build.
- **Patient data exposure:** patient endpoints refuse cashiers; `/api/sync/*` returns counters and
  record statuses, not patient payloads; audit JSON contains no passwords, tokens or secrets (asserted
  in UAT scenario 15). Backups contain the whole database including password hashes, so the backup
  folder must be private — stated in the interface and the docs.
- **Financial manipulation and duplicates:** sales and ledger writes are transactional and
  operation-keyed; replayed operations return the original result. Deletion of sales is refused at
  the database-trigger level.
- **Stock consistency:** no negative stock; an offline sale that exceeds stock is rejected whole
  rather than partially applied.
- **Unsafe migrations:** migrations are checksummed and forward-only; the packaged server refuses to
  start rather than mutate a mismatched schema.
- **Restore failures:** a corrupt or truncated backup fails verification and cannot be restored; a
  restore never happens under a live connection.
- **Sensitive logs:** the API logs request ids and error kinds only; no debug field echoes messages.

Residual risks (accepted, documented): there is no code signing, so SmartScreen warns on first run;
the local API is HTTP on the loopback address and HTTP on the LAN in the debug APK profile; the
database is not encrypted at rest on the Windows computer (Windows account permissions only); and
backups are unencrypted files, so the operator must keep the folder and its USB copies private.

---

## 9. Known limitations

1. The Windows window has not been launched on Windows (see section 5).
2. No APK exists yet (section 7); the shop cannot install anything until one is built on a machine
   with the Android SDK, or by the manual workflow.
3. No Windows Installer, no auto-update, no code signing.
4. The desktop `.exe` keeps the runtime's icon resource; the window and taskbar icon are MediMart's.
5. Offline mode is Android-only by design. A browser cannot safely keep a sale, and says so.
6. Offline credit sales, unverified discounts and prescriptions are refused — deliberate.
7. Restore requires closing and reopening MediMart (deliberate, to avoid corruption).
8. Performance was measured on this machine, not on the Celeron N3050 target.
9. No soak/long-session test was run.
10. `apps/desktop` is a new folder with no automated test of its own; its shell logic is reviewed and
    syntax-checked, not unit-tested (it needs a live Electron binary).

---

## 10. Deliverables in this branch

- `apps/api/src/services/sync.ts`, `apps/api/src/routes/sync.ts`, `apps/api/src/services/backup.ts`
- `packages/shared/src/offline.ts`, `permissions.ts`, `contracts.ts`, `sync.ts`
- `packages/database/src/migrations-offline.ts`, `migrations-device.ts`, `migrations.ts`
- `apps/web/src/platform/offline.ts`, `features/BackupSyncPage.tsx`, `components/CameraScanner.tsx`,
  POS offline offer, `styles.css`
- `apps/desktop/{main.mjs, package.json, assets/icon*.png}`, `scripts/{build-desktop.mjs,
build-apk.mjs, generate-icons.mjs, capture-phase6.ts}`
- `tests/{sync,backup,uat,performance}.test.ts`, two new Playwright scenarios
- `docs/{DESKTOP.md, ANDROID.md, PHASE_6_REPORT.md, PHASE_6_PERFORMANCE.md, PHASE_6_UAT.md,
PHASE_6_TEST_RESULTS.md}`, `docs/screenshots/phase6/*`, updated `README.md`

Installers and APKs are build outputs (`dist/`), which is git-ignored: they must be attached to a
GitHub release or workflow artifact, never committed.
