# MediMart — Phase 1 completion and review report

- **Date:** 5 November 2026 (UTC)
- **Application version:** 0.1.0
- **Repository:** `belloluqman2007-hue/MediMart`
- **Working branch:** `arena/0fa59216-medimart`

> **Ready for foundation review, not operational deployment.** Phase 1 source, database/authentication foundations, responsive interface, and Android project configuration are implemented. Local automated checks pass. **No APK was compiled, signed, installed, or verified.** Native compilation and physical-device security/offline checks remain outstanding. Business modules and complete synchronization are deliberately absent.
>
> **Phase 2 has not started. Work stops here for your review and explicit approval.**

## 1. Starting point and delivery summary

The local checkout and GitHub repository were inspected before implementation. The starting commit, `a581d910af62f233721a24aaee521ddf098f3aad`, contained a README rather than an existing application. The proposed workspace structure, technology choices, and missing Android toolchain were identified before building the foundation. No functioning application was replaced.

Delivered:

- A TypeScript npm-workspace project separating React UI, Express API, shared contracts, and database logic.
- A responsive dashboard, login and controlled owner-registration screens, keyboard-accessible search/dialogs, mobile navigation, and all **20 requested destinations**.
- Central SQLite persistence and a maintained Capacitor SQLite/SQLCipher adapter for a separate database on each Android installation.
- **14 tables, three migrations, seven roles, and 25 permissions.** The requested table list contains 14 tables, not 15.
- Individual accounts, Argon2id hashing, guarded staff creation, live backend authorization, revocable sessions, password changes, device pairing/revocation, and audit logging.
- Durable local-write/outbox helpers, UUID replay protection, authoritative-receipt primitives, and explicit conflict evidence — **not a synchronization engine**.
- Locally bundled Android assets/fonts, fixed application ID, secure-storage integration, configurable server origin, and release-safe source configuration.
- Automated database/API/platform/browser checks, a compiled-server smoke check, setup scripts, documentation, and unexecuted GitHub quality/manual Android workflows.

The public workspace contains no fabricated sales, stock, patients, or operational statistics. Protected information requires a valid authorized server session.

## 2. Versions and compatibility

Direct dependencies are pinned; `package-lock.json` records the complete dependency graph.

| Layer                                         | Version used                                          |
| --------------------------------------------- | ----------------------------------------------------- |
| Node.js / npm                                 | **22.22.3 / 10.9.8** in this environment              |
| TypeScript                                    | 5.9.3                                                 |
| React / React DOM                             | 19.3.1 / 19.3.1                                       |
| React Router DOM                              | 7.18.5                                                |
| Vite / React plugin                           | 8.3.6 / 6.2.1                                         |
| Express                                       | 5.3.0                                                 |
| better-sqlite3 / actual central SQLite engine | 13.0.3 / **3.53.4**, queried from the running library |
| Argon2 / Zod                                  | 0.45.2 / 4.6.7                                        |
| Capacitor core / CLI / Android                | 8.6.0 / 8.6.0 / 8.6.0                                 |
| Capacitor Community SQLite                    | 8.1.1                                                 |
| Capacitor secure storage (`@aparajita`)       | 8.0.1                                                 |
| Capacitor App / Network                       | 8.1.2 / 8.0.1                                         |
| Lucide React                                  | 1.69.0                                                |
| Local Inter / Plus Jakarta Sans fonts         | Fontsource Variable 5.3.0 / 5.3.0                     |
| Vitest / Playwright / axe integration         | 5.1.0 / 1.64.1 / 4.14.0                               |
| ESLint / TypeScript ESLint / Prettier         | 10.14.0 / 8.72.1 / 3.9.10                             |
| tsup / tsx                                    | 9.0.0 / 4.23.15                                       |
| Restricted-sandbox Chromium                   | `@sparticuz/chromium` 153.0.0, test-only              |
| Security override                             | `minimatch` 11.0.4                                    |

Android **source requirements**, not installed/verified build tools here:

- Permanent application ID and namespace: **`com.medimart.app`**; display name **MediMart**.
- Version name `0.1.0`, version code `1`.
- JDK **21**, Gradle wrapper **8.14.3**, Android Gradle Plugin **8.13.2**.
- Minimum Android SDK **24**; compile/target SDK **36**.
- Configured minimum WebView **110**, with a bundled, non-destructive unsupported-WebView page.
- SQLite plugin declares SQLCipher **4.17.0**. This is a dependency/source observation, **not a measured Android runtime version**.

The selected stack uses modern Node/Android requirements rather than legacy Capacitor/Cordova SQLite adapters. Native Node addons need compatible binaries/tooling and matching Node headers. API compilation deliberately leaves `better-sqlite3` and `argon2` external so their native loaders resolve correctly. The server bundle must be deployed with its production dependencies; it is not a standalone executable.

## 3. Created structure

```text
apps/
  api/                  Express application, security middleware, services, API build
  web/                  React UI, reusable components, runtime adapters, local assets
    android/            Capacitor Android source project
packages/
  shared/               Validation, API contracts, role catalog, UUID/kobo/sync rules
  database/             Driver boundary, serialized transactions, migrations, outbox
scripts/                Safe setup, migrations, builds/sync helpers, runtime smoke check
tests/                 Database, API, native-adapter, and browser tests
docs/                  Architecture, database, security, API, Android, this report
.github/workflows/      Quality workflow and manual Android build/ID verification
```

`var/` contains the local development database after setup; it is ignored. `.env` is private and ignored. Build output, APKs, generated Capacitor assets/configuration, test reports, screenshots, and scratch files are also excluded from Git. The Android wrapper and required source resources are retained.

Detailed ownership and extension boundaries: [Architecture](ARCHITECTURE.md).

## 4. Database foundation

| Table                  | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `users`                | Individual accounts, password hashes, status, lockout and version fields |
| `roles`                | Seven stable role definitions                                            |
| `permissions`          | Capability definitions                                                   |
| `user_roles`           | Account-to-role assignments                                              |
| `role_permissions`     | Explicit capability grants                                               |
| `devices`              | Installations, hashed pairing proof, approval/revocation                 |
| `user_sessions`        | Hashed opaque tokens, transport, expiry and revocation                   |
| `audit_logs`           | Append-only application audit events                                     |
| `application_settings` | Versioned, scoped settings                                               |
| `database_migrations`  | Ordered, checksummed migration history                                   |
| `sync_devices`         | Per-device authority/cursor foundation                                   |
| `sync_queue`           | Durable operations and future retry state                                |
| `sync_receipts`        | Unique operation receipts and result/version evidence                    |
| `sync_conflicts`       | Local/authoritative snapshots and explicit resolution fields             |

Migration sequence:

1. `identity_security_and_settings`: accounts, permissions, devices, sessions, audit and settings.
2. `offline_outbox_receipts_and_conflicts`: queue, device cursors, receipts and conflicts.
3. `least_privilege_role_seeds`: seven roles and 25 permissions; **no default user accounts**.

All tables use SQLite `STRICT` typing, UUID identifiers, appropriate constraints, foreign keys and indexes. Timestamps use UTC ISO-8601 strings. UUID checks cover layout/version/variant and normalization; join uniqueness prevents duplicate assignments. Audit triggers reject ordinary UPDATE/DELETE operations.

The shared migration runner verifies contiguous versions, names and SHA-256 checksums, rejects drift/newer unknown schemas, and commits pending DDL and ledger entries atomically. Historical seeds are frozen separately from the live role catalog. **Future changes require new migrations; do not edit a released migration to bypass drift.**

Serialized transactions use `BEGIN IMMEDIATE`; callbacks receive their transaction executor. The Node adapter enables foreign keys, WAL, FULL synchronization, and a 5-second busy timeout. Native initialization requests equivalent settings and checks FK enforcement. Rollback failure closes the driver and preserves both errors; closing is idempotent. New central database files/directories have restrictive POSIX permissions.

The monetary contract is **safe integer kobo**, not floating-point naira. There are no monetary business tables or calculations in Phase 1. Future tables and domain validators must enforce that contract.

The central adapter does **not** encrypt the server database. Native encryption is configured but unverified on hardware. Operational backup, restore and key recovery are not implemented. Do not copy only a live WAL-mode database file or clear an Android app's data to repair a migration problem.

See [Database](DATABASE.md) for constraints, secret separation, and recovery limitations.

## 5. Authentication, roles and security

The seven roles are **Owner, Administrator, Manager, Pharmacist, Healthcare Professional, Cashier, and Storekeeper**. Grants are explicit, not a client-side assumption that all staff can access all modules.

Implemented controls:

- One-time owner creation requires a private setup token and a transactionally checked empty-user state. Concurrent registration cannot create two first owners. There is no shared/default account or password.
- Staff creation requires live `staff.manage`; only an Owner may create an Administrator. Staff registration cannot create an Owner or delegate capabilities the actor does not have.
- Argon2id uses **64 MiB memory, time cost 3, parallelism 1**. Passwords are validated at 12–128 characters. Unknown-account verification uses a dummy hash; null-hash local profile mirrors cannot authenticate.
- Five failed password attempts lock the account for 15 minutes. Endpoint rate limits also bound expensive authentication requests.
- Session secrets are random 256-bit opaque tokens; the database stores hashes. Default lifetime is a fixed eight hours, configurable up to 24 hours.
- Browser sessions use HttpOnly, SameSite=Strict, `/api` cookies, Secure in production, and CSRF checks for authenticated mutations. Raw browser session tokens are not returned to JavaScript.
- Native bearer login requires an approved installation and possession of its pairing secret. Device/session revocation and current account status/grants are checked by the server.
- Sensitive writes recheck the live session, token hash/transport and capabilities inside the write transaction, including after asynchronous password hashing.
- Logout, logout-all, and current-password-verified password changes are implemented. Password changes revoke every session for that account.
- Device registration has retry-safe proof, an eight-digit ten-minute pairing code, five-attempt limits, authorized approval, and revocation. Pairing is **not** hardware attestation or a firewall: ordinary authenticated browser sessions are also supported.
- Parameterized SQL, strict input schemas, bounded JSON bodies, explicit origin/CORS checks, Helmet headers, no-store API responses, and sanitized errors are in place.
- Audit events record important actions without passwords, raw tokens, pairing secrets, or request bodies.

Production still needs correctly configured HTTPS, a protected server/OS/disk, a reviewed trust/proxy policy, and recovery procedures. Application audit triggers do not prevent a database administrator from altering files. There is no MFA, account-recovery workflow, offline authorization lease, penetration-test certification, or healthcare compliance certification in this foundation.

See [Security](SECURITY.md) and [API](API.md).

## 6. Offline and synchronization boundaries

**Implemented foundation:**

- Android uses locally bundled UI/fonts, not a remote startup website; no startup `server.url` is configured.
- Each installation initializes its own SQLite database and stable UUID. Normal startup does not delete/recreate existing data.
- Native server origin and installation settings persist in SQLite; session/device secrets use secure storage. The SQLCipher secret uses the SQLite plugin's protected secret store.
- Central URL validation is shared. Release configuration requires HTTPS; private-LAN HTTP is an explicit development-only mode. Rebinding an enrolled device or one with pending operations is guarded.
- Local domain callbacks and outbox insertion can commit together. Complete-envelope fingerprints bind UUID, device, entity, mutation, base version, and payload; exact replay does not reapply the callback, while changed-content UUID reuse is rejected.
- Receipt helpers prepare atomic authoritative deduplication. Conflict helpers preserve both versions instead of silently replacing evidence.
- Queue payloads are bounded, and authentication/configuration entities are excluded from the business outbox contract.
- The production browser can cache the **public static shell only** on a secure origin. Browser offline reopening was tested; API responses and authenticated state are not cached by the service worker.

**Not implemented:** network push/pull, retry workers, acknowledgments, authoritative business mutation handlers, cursor exchange, conflict resolution UI, offline staff authorization, or actual offline sales/inventory/clinical operations. Local durable queue behavior is tested at the library level, not exposed as a working business workflow.

The central server is the intended future authority. Internet access will not be required for a correctly deployed LAN server and bundled Android client, but Phase 1 protected actions still require a reachable server session. No cloud service was provisioned and no paid service is required.

## 7. User interface

All requested navigation entries exist: **Dashboard, Point of Sale, Pharmacy, Mini-Mart, Inventory, Purchases, Suppliers, Customers, Patients, Consultations, Prescriptions, Expenses, Cash Register, Debts, Reports, Staff, Permissions, Audit Logs, Backup and Sync, Settings**.

- Dashboard readiness/connection state is real; unbuilt business metrics explicitly say “Not available yet.”
- Business destinations are placeholders. Missing permissions show an explicit boundary, not protected module content.
- Settings provides business-name configuration, account/password/session controls, native connection/pairing, and permission-guarded staff/device setup. These are foundation controls, not complete Staff/Permissions/Backup modules.
- Search, responsive navigation, keyboard focus/dialog behavior, skip navigation, route titles and keyboard-operated settings tabs are implemented.
- Fonts and artwork are local. Selected third-party license notices are bundled; a complete transitive/native release-license inventory remains a release task.

Desktop dashboard, desktop login and 390-pixel mobile screenshots were refreshed and visually reviewed from the compiled server. Browser tests also check widths **1440, 1024, 768, 390 and 320** without horizontal overflow. Screenshots are local review artifacts, not Android-device evidence.

## 8. Verification results

Checks were performed locally on this branch on 5 November 2026.

| Check                                          | Result                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Clean dependency installation                  | **Passed**, using matching local Node headers: `npm_config_nodedir=/usr/local npm ci --no-fund --no-audit`  |
| Prettier check                                 | **Passed**                                                                                                  |
| TypeScript type checking                       | **Passed**                                                                                                  |
| ESLint                                         | **Passed**                                                                                                  |
| Database tests                                 | **18 passed**                                                                                               |
| API/auth/security tests                        | **23 passed**                                                                                               |
| Native-platform adapter tests                  | **10 passed**                                                                                               |
| Total unit/integration tests                   | **51 passed**                                                                                               |
| Production API + web builds                    | **Passed**                                                                                                  |
| Compiled-server smoke check                    | **Passed**: native SQLite startup, migrations, health, static UI/assets, service worker and 404 boundaries  |
| Playwright browser tests                       | **14 passed**, including three axe checks for WCAG A/AA violations                                          |
| npm audit, complete graph                      | **0 known vulnerabilities reported**                                                                        |
| npm audit, runtime graph                       | **0 known vulnerabilities reported**                                                                        |
| Development Android asset sync                 | **Passed**; explicit development settings checked                                                           |
| Default Android asset sync                     | **Passed, run last**; no remote startup URL or cleartext/mixed-content allowance in generated configuration |
| Android source/config inspection               | Fixed ID/version, four plugins discovered, **18 XML files well-formed**                                     |
| Git whitespace checks                          | **Passed**                                                                                                  |
| APK compilation / installation / runtime tests | **Not completed** — see next section                                                                        |
| GitHub workflow runs                           | **Not executed**; workflow source is provided                                                               |

That is **65 passing unit/integration/browser test cases plus the compiled-server smoke check**, not 65 Android-device tests.

Database checks cover migration drift/rollback/restart, FK/UUID constraints, frozen seeds, transaction isolation, idempotent close, outbox atomicity, replay/collision handling, receipts and conflicts. API checks cover owner setup/concurrency, hashing/lockout, revocation/expiry, permission escalation, live transactional authorization, live-grant delegation, CSRF/origins, production cookie/headers, native CORS, device pairing and secret-safe audit events.

Browser checks cover owner setup, login errors, all navigation destinations, responsive layout, keyboard/mobile interaction, guarded settings/staff/device controls, password changes, permission boundaries, public-only offline reopening and automated accessibility scans. Automated axe results are not a complete manual accessibility certification.

Native-adapter tests use a **mock Capacitor/secure-storage bridge backed by real desktop SQLite**. They verify initialization/migrations, identity persistence, secret separation, rebind protection and fail-closed behavior — **not actual SQLCipher encryption, Android Keystore behavior, or native plugin compatibility**.

Final release-safe web shell: **21 versioned public assets**. The service worker does not cache APIs. Audit JSON and browser evidence live in ignored local artifact/report directories; they are time-specific observations, not a guarantee against unknown vulnerabilities.

## 9. Errors resolved and outstanding gates

### Resolved during verification

- Normal `npm ci` attempted to download Node headers from a host unavailable in this restricted environment. Matching 22.22.3 headers already existed at `/usr/local`; the documented environment-specific install flag completed a clean installation without changing project portability.
- Starting the compiled ESM API exposed an incorrectly bundled native SQLite loader (`Dynamic require of "fs" is not supported`). Native addons are now explicitly externalized, and a compiled-entry-point smoke check is part of `npm run check` to prevent recurrence.
- A development-tool transitive `minimatch` advisory was addressed with the pinned 11.0.4 override; full and runtime audits now report zero known findings. No forced dependency downgrade was used.
- Production frontend environment handling, local-font imports, accessibility labels and keyboard/focus behavior were corrected and retested. The browser test fallback keeps web security enabled.

### Outstanding Android gate — no APK

An actual command was attempted:

```bash
cd apps/web/android
./gradlew --no-daemon assembleDebug
```

It exited before compilation with:

```text
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

This environment has no usable Java/Android SDK toolchain. **Asset sync is not compilation. No APK exists from this work, and no signing, installation, package inspection, native migration/encryption test, airplane-mode cold start, or device-to-LAN pairing test was completed.**

On an equipped machine, use [Android instructions](ANDROID.md) to build and verify `com.medimart.app`. Then complete its physical-device checklist, including first-launch offline behavior, restart/migration durability, SQLCipher/Keystore persistence, multiple independent devices, TLS/certificate behavior, approved/revoked pairing, lifecycle/background session invalidation, app upgrades, WebView compatibility and recovery behavior. Default release policy disables cleartext, backup/device transfer, broad file exports and screenshots; those source controls still require runtime validation.

The generated example tests were replaced by a device-side identity/display-name/no-backup manifest smoke test; it is uncompiled and unexecuted here. The manual GitHub workflow is a future application/test-harness compilation and package-ID check, not a substitute for running these device tests. Production release also requires signing-key stewardship, verified backup/key recovery, deployment hardening and a full license review.

## 10. Exact run instructions

Run from the repository root **containing these Phase 1 changes**, on Node 22.x (22.22.3 recommended).

### Install and initialize

```bash
npm ci
npm run setup
```

In this restricted Arena environment, use the available headers for the install instead:

```bash
npm_config_nodedir=/usr/local npm ci
npm run setup
```

`setup` creates a private `.env` and random bootstrap token if needed, preserves existing configuration, and runs migrations. It does not seed users or business data. Never post the token/passwords in chat or commit `.env`.

### Development — two terminals

```bash
# Terminal 1, repository root
npm run dev:api
```

```bash
# Terminal 2, repository root
npm run dev:web
```

Open `http://localhost:5173` on your development computer, or use Arena's live preview. Vite forwards relative `/api` calls to the API at port 3001; browser-facing code does not call a hardcoded localhost backend. Both servers bind to `0.0.0.0` for the preview/LAN configuration.

Choose **Create owner account**, read the setup token privately from your local `.env`, and supply your own full name, email and password. After successful setup, remove/empty `BOOTSTRAP_TOKEN` and restart the API. Create individual staff accounts through authorized Settings controls. Use throwaway accounts/data with development HTTP.

### Build and run the compiled server

```bash
npm run build
npm run test:production
npm start
```

Open `http://localhost:3001` locally. `npm start` serves the built UI and API together and reads `.env`; **it does not automatically make the configuration production-safe**. Follow the [README production configuration](../README.md#production-configuration-before-real-deployment) and [security guide](SECURITY.md) before real deployment. Do not start a second API on port 3001 while the development API is still running.

### Re-run verification

```bash
npm run format:check
npm run check

# Ordinary development / CI browser installation:
npx playwright install --with-deps chromium
npm run test:e2e

# Instead, in this restricted Linux sandbox:
MEDIMART_SANDBOX_BROWSER=1 npm run test:e2e

npm audit
npm audit --omit=dev
```

`npm run check` includes type checking, lint, 51 unit/integration tests, both builds and the compiled-server smoke check. Browser tests use a dedicated disposable `.artifacts/e2e/server.sqlite`, never the configured application database. The compiled smoke check uses its own temporary database.

### Android, once the toolchain is installed

```bash
npm run android:sync
npm run android:open

# Or, from the repository root:
cd apps/web/android
./gradlew --no-daemon assembleDebug
# Windows: gradlew.bat --no-daemon assembleDebug
```

Check the resulting APK with `apkanalyzer manifest application-id` before installation; it must report `com.medimart.app`. `npm run android:sync:dev` is only for explicit private-LAN HTTP development. Run the default `npm run android:sync` again before any release build. See [Android](ANDROID.md) for full prerequisites, commands and verification steps.

## 11. Deferred work and review decision

No implementation has begun for inventory/product/stock operations, POS/sales, purchases, supplier/customer/patient records, consultations, prescriptions, financial calculations, reports, operational backup/restore, desktop packaging or cloud hosting. Their navigation entries are placeholders.

After your explicit approval, the next phase must be scoped rather than assuming all of these modules are authorized at once. Remaining work includes:

1. Complete the outstanding Android build/device verification and deployment/recovery gates before relying on native data.
2. Agree the first business module, its integer-kobo/domain schemas, permission boundaries, tests and append-only migrations.
3. Design and implement approved offline authorization and authoritative sync transport/handlers with atomic receipts, bounded retries, schema/version negotiation and visible conflict resolution.
4. Add operational backup/key recovery with tested restores before real records; scope other business modules, desktop packaging and optional cloud backup separately.

**Review requested:** approve or request changes to this Phase 1 foundation and its documented limitations. **Phase 2 remains paused until you explicitly authorize it.**
