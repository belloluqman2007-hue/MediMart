# Phase 6 test results — commands and output

Every row is a command that was run in this environment on the Phase 6 branch. Nothing is inferred.

| Command                                          | Result                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npx tsc --noEmit`                               | clean                                                                                                                                                                                      |
| `npm run lint` (`eslint .`)                      | clean, 0 problems                                                                                                                                                                          |
| `npx prettier --check .`                         | clean                                                                                                                                                                                      |
| `npx vitest run`                                 | **11 files, 153 tests passed**, 34.9 s                                                                                                                                                     |
| `MEDIMART_SANDBOX_BROWSER=1 npx playwright test` | **22 tests passed**, 1.5 min                                                                                                                                                               |
| `npm run build`                                  | web + API built; one `INEFFECTIVE_DYNAMIC_IMPORT` warning (harmless, explained below)                                                                                                      |
| `npm run test:production`                        | passed: native SQLite startup, migrations, health, bundled UI/assets, service worker, JSON/asset 404 boundaries, healthcare auth boundaries, synthetic patient flow, POS dispensing replay |
| `node scripts/build-desktop.mjs`                 | package assembled; packaged server started and answered health + UI                                                                                                                        |
| `node scripts/build-apk.mjs --profile debug`     | **not completed**: no JDK/Android SDK here (reported, not hidden)                                                                                                                          |

## Test files

| File                          | Tests | Covers                                                           |
| ----------------------------- | ----- | ---------------------------------------------------------------- |
| `tests/api.test.ts`           | 40    | auth, sessions, roles, permissions, devices, security headers    |
| `tests/database.test.ts`      | 20    | schema, migrations, integrity, triggers                          |
| `tests/inventory.test.ts`     | 21    | products, batches, ledger, reconciliation                        |
| `tests/sales.test.ts`         | 27    | POS, payments, credit, refunds, receipts                         |
| `tests/healthcare.test.ts`    | 15    | patients, consultations, prescriptions, dispensing               |
| `tests/finance.test.ts`       | 21    | purchases, receiving, supplier payments, expenses, reports       |
| `tests/platform.test.ts`      | 8     | Android adapter, storage, startup gates                          |
| `tests/sync.test.ts`          | 9     | offline capture, exactly-once sync, rejections, revocation       |
| `tests/backup.test.ts`        | 6     | backup creation, verification, restore preparation, retention    |
| `tests/uat.test.ts`           | 15    | the fictional trading day (15 scenarios)                         |
| `tests/performance.test.ts`   | 1     | timings in `PHASE_6_PERFORMANCE.md`                              |
| `tests/e2e/workspace.spec.ts` | 22    | real browser journeys, including backup/sync and offline refusal |

## The one build warning

```text
[INEFFECTIVE_DYNAMIC_IMPORT] src/platform/offline.ts is dynamically imported by
src/components/AppProvider.tsx but also statically imported by
src/features/BackupSyncPage.tsx, src/features/sales/PosTerminalPage.tsx
```

Rollup cannot move the module into its own chunk, so the dynamic import in the auto-sync effect loads
from an existing chunk. Behaviour is unchanged; only chunk boundaries differ. Left in place because
the alternative is to make every consumer dynamic for no user-visible benefit.

## Not run here (and therefore not claimed)

- Launching the Electron window on Windows 10.
- Building, installing or running an Android APK; SQLCipher, Keystore and camera behaviour on a phone.
- Pairing a real phone with a real Windows computer over a real Wi-Fi router.
- A long-session (full trading day) stability run.
- Performance on the Celeron N3050 target hardware.
