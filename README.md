# MediMart

**Business, in good health.** A local-first foundation for pharmacy, mini-mart, and patient-management software.

> **Phases 1–7 complete — ready for review, not business use yet.** Inventory, POS/sales, debts, patient records, consultations, prescriptions/dispensing, purchasing, goods receiving, supplier payments, expenses, separated financial reporting, offline capture and synchronization, and verified backup/restore are implemented. Phase 7 unified stock valuation on actual batch acquisition costs, rebuilt the Windows packaging so it carries the full runtime and verified native addons, updated [docs/API.md](docs/API.md), and added GitHub Actions workflows that build and smoke-test the **Android APK** and the **Windows application** on real Windows/Android CI runners. **Read the honest limits before relying on this:** no physical Android phone or target HP laptop has been tested in this environment. See the [Phase 7 report](docs/PHASE_7_REPORT.md).

### Install it in the shop

| I want to…                                                         | Read                                       |
| ------------------------------------------------------------------ | ------------------------------------------ |
| Install on the shop's Windows computer and run the first setup     | [docs/DESKTOP.md](docs/DESKTOP.md)         |
| Install on a phone and connect it to the shop computer             | [docs/ANDROID.md](docs/ANDROID.md)         |
| Walk through acceptance testing with fake data before real trading | [docs/PHASE_6_UAT.md](docs/PHASE_6_UAT.md) |
| Understand backups and how to restore one                          | [DESKTOP.md §7](docs/DESKTOP.md#7-backups) |

Quick version: extract the Windows zip, open `MediMart.exe`, use the setup token it shows to create the owner, then add products and staff. Phones on the same Wi-Fi pair with the code from **Settings → Device pairing**. Nothing needs internet.

## Architecture and technology

The central computer runs a Node.js/Express API with a `better-sqlite3` authoritative database. The React/TypeScript/Vite web app calls that API; Android packages the same UI in a Capacitor shell and initializes a separate SQLCipher SQLite database with Keystore-backed secrets. Shared validation, permissions and migrations live in `packages/`. The Android shell holds an encrypted local copy of the catalogue and an outbox for offline capture; a central connection is still required to sign in, so there is no offline authentication. No paid service or cloud connection is required to run the central application on a local network.

## What works now

- Responsive React dashboard, professional sign-in/owner-setup screens, module search, phone navigation, and 20 module destinations.
- Explicit read-only preview: no fabricated business metrics or exposed protected records.
- One-time, setup-token-protected first-owner registration; individual staff registration by authorized users.
- Argon2id passwords, current-password-verified password changes, revocable sessions, CSRF/origin protection, rate limits, and persistent account lockout.
- Seven seeded roles and backend-enforced permissions. Administrative writes recheck live grants and session validity inside their transaction.
- Device registration, expiring pairing codes, authorized approval, proof-bound native sessions, and revocation.
- Central SQLite database; shared, checksummed migrations for **52 tables** (thirteen migrations, schema v13); append-only application audit logs.
- Android SQLite/SQLCipher initialization, installation UUIDs, Keystore-backed secret storage, configurable server address, and lifecycle/network hooks.
- Atomic local-write/outbox primitives, receipt deduplication, conflict snapshots, permission-gated aggregate queue diagnostics, and a working synchronization push with business handlers for sales, customers, debts, receipts, purchase orders and expenses.
- Locally bundled Android assets and fonts. A production browser build can cache its **public shell only** on a secure origin; API responses are never cached.

### Sales and POS (Phase 3)

- Product search/barcode scanning, cart quantities, unit conversions, FEFO batch allocation, split payments (cash, transfer, POS), change calculation and credit sales.
- Customer credit limits, outstanding debts, partial/full repayments, void and partial/full refund flows with batch restoration.
- Separated revenue, cash received, outstanding credit, COGS and gross profit; receipt printing and sales reports.

### Healthcare (Phase 4)

- Patient registration with duplicate detection, search, editable profiles and a chronological timeline.
- Consultations and vitals with explicit, non-invented measurements; clinical history visible only to authorized healthcare roles.
- Prescriptions with draft/authorize/cancel flow, allergy and clinical warnings, and FEFO dispensing that is exactly-once across prescription lines and the stock ledger.
- Prescription checkout through the existing POS, retaining separated payments, stock and audit records.

### Purchasing and finance (Phase 5)

- **Purchases:** existing suppliers, multi-line orders, purchase units, integer-kobo discounts and charges, expected delivery dates, draft/ordered/partially received/received/cancelled statuses, search and date filters.
- **Goods receiving:** partial deliveries, accepted/rejected quantities, batch and expiry capture, actual unit cost, atomic stock-ledger integration, duplicate-receipt prevention and expired-goods blocking.
- **Supplier accounts:** received value, payments, outstanding invoices, statements and balances. Ordered but undelivered goods are never a payable.
- **Supplier payments:** cash/transfer/POS, full or partial invoice allocations, duplicate-reference prevention, and append-only reversals.
- **Expenses:** twelve operating categories, drafts, posting, attachments, audit records and reversals.
- **Financial reporting:** separated sales, collections, purchases, expenses, inventory, COGS, gross profit and operating profit; daily/weekly/monthly ranges, CSV export, print layout and a sales-side cash register.

### Inventory (Phase 2)

- **Products:** five types (medicine, foodstuff, drinks, snacks, general merchandise), SKU/barcode uniqueness, prices in integer kobo, reorder levels, search, filters, sorting, pagination, activate/deactivate. Products with history are never hard-deleted.
- **Categories:** two-level tree with 11 seeded examples under Pharmacy and Mini-Mart; delete is refused while products or children reference a category.
- **Batches and expiry:** multiple batches per product, manufacturing/expiry dates, remaining quantities, supplier references, expired stock blocked from future sale, configurable near-expiry alerts, and products that do not expire.
- **Stock ledger:** append-only movements (opening stock, receipt, adjustment increase/decrease, damaged, expired, correction) with previous/new balance proof, mandatory reasons, user/device/reference IDs, and idempotent operation IDs. No negative stock; every write is one database transaction.
- **Units:** 11 built-in units plus custom units and per-product conversions (for example 1 carton = 12 packs, 1 pack = 10 tablets) with integer base-unit arithmetic.
- **Suppliers:** contact and business details, linked products, and stock-receiving history — no purchasing or payments.
- **Dashboard and reconciliation:** active products, stock value at cost, retail value shown separately, below-reorder, out-of-stock, expired, nearing expiry, recent movements, newest products, and cached-vs-ledger drift detection.
- **Permissions:** 69 permissions in total, including 16 inventory, 9 healthcare and 12 Phase 5 finance permissions, enforced by the API. Cashiers get no inventory, purchasing, supplier-payment, expense or export access by default.

### Offline work, backup and installation (Phase 6)

- **Offline capture:** a paired Android phone keeps selling when the shop computer is unreachable. Each kept sale gets a provisional receipt (`OFF-20261110-0001`) and is written to the phone's encrypted local database.
- **Synchronization:** the shop computer re-checks every kept record — installation fingerprint, device state, clock, stock, price and permissions — inside one transaction. A replay is recognised as a duplicate and changes nothing; anything unverifiable is rejected or parked as a conflict for a human, never forced through.
- **Deliberate offline limits:** credit sales, discounts without `sales.discount`, and prescriptions cannot be completed offline.
- **Backup and Sync page:** synchronization counters, records from connected devices, backup creation, per-file verification, and restore behind a typed confirmation. Backups are written with SQLite's snapshot mechanism and re-opened to verify integrity, checksum, row counts and schema version.
- **Windows desktop application:** Electron shell around the same interface and the same API, one window, sandboxed, no remote content, database in `%APPDATA%\MediMart`. Portable — no installer, no Administrator rights, no internet.
- **Android:** `com.medimart.app`, optional camera for barcode scanning only, release builds TLS-only, `scripts/build-apk.mjs` for a debug APK and environment-supplied release signing.

See the [Phase 2 report](docs/PHASE_2_REPORT.md), [Phase 1 report](docs/PHASE_1_REPORT.md), [Phase 6 report](docs/PHASE_6_REPORT.md), [Phase 6 test results](docs/PHASE_6_TEST_RESULTS.md), [Phase 6 UAT script](docs/PHASE_6_UAT.md), [Phase 6 performance](docs/PHASE_6_PERFORMANCE.md), [architecture](docs/ARCHITECTURE.md), [database](docs/DATABASE.md), [security](docs/SECURITY.md), [API](docs/API.md), [Windows](docs/DESKTOP.md), and [Android guide](docs/ANDROID.md).

## Prerequisites

- **Node.js 22.12+ within the 22.x line** (tested with 22.22.3; `.nvmrc` provided).
- **npm 10+** (lockfile generated with npm 10.9.8).
- Initial dependency installation needs package-registry access. Normal application startup does not use a public website or CDN.
- `better-sqlite3` and `argon2` are native Node modules. Have a Python/C/C++ build toolchain available for source builds (Linux build tools or the Windows C++ build tools). Native installation may need matching Node headers.
- Android additionally requires **JDK 21**, Android Studio/SDK 36, and Gradle access. See [Android](docs/ANDROID.md).

## Run this checkout

Run commands from the repository root:

```bash
npm ci
npm run setup
npm run db:migrate
npm run dev
```

`setup` creates a git-ignored `.env` with a random 256-bit setup token and restrictive file permissions. It never overwrites an existing file. Migrations also run automatically when the API starts.

- UI: **http://localhost:5173**
- API health: **http://localhost:3001/api/health**
- Both development processes bind to `0.0.0.0`.
- Browser code calls relative `/api` URLs; Vite proxies those requests to the API.
- On another LAN computer, open `http://<central-computer-LAN-IP>:5173`. `localhost` on a phone means the phone, not your computer.
- In Arena, use the **MediMart workspace** live preview. The exact preview host is supported without disabling host checks or trusting unrelated preview origins.

**Development HTTP is for throwaway test accounts only. Do not enter real patient or operational data.** Production needs HTTPS, explicit origins, and secure cookies.

**Restricted Arena installation note:** the normal Node-header download host is outside this sandbox's allowlist. Matching Node 22.22.3 headers are already installed locally, so a clean installation here uses:

```bash
npm_config_nodedir=/usr/local npm ci
```

This environment-specific flag avoids a network download. It is not a hardcoded project requirement; ordinary development/CI machines can use `npm ci` with their normal toolchain/network access.

### Create the first owner

1. Start the server and open **Set up your workspace** or `/#/register`.
2. Read `BOOTSTRAP_TOKEN` privately from your local `.env` file. Do not commit it, send it in chat, or put it in a URL.
3. Enter your name, email, a unique password of at least 12 characters, and that setup token.
4. Once any user exists, public owner registration is closed. There are **no default accounts or passwords**.
5. Remove the setup token from the server environment after setup and restart the API; existing login continues to work.
6. In **Settings → Staff access**, an owner/authorized administrator can create individual accounts. Staff should change their initial password in **Settings → General → Account & security**. A password change signs out all sessions.

If `.env` already existed with an empty token, `npm run setup` deliberately leaves it alone. Generate a value locally:

```bash
node --input-type=module -e "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('hex'))"
```

Put that value in `BOOTSTRAP_TOKEN` in `.env`, then restart the API. Never share the value.

## Build and serve the bundled web application

```bash
npm run build
npm start
```

The API now also serves the built UI at **http://localhost:3001**. This command does **not** automatically change your `.env` from development to production.

The build creates self-hosted assets and a versioned shell service worker. It keeps API/server environment variables separate from frontend build variables. Browser offline caching requires HTTPS or a browser-trusted localhost origin. An ordinary HTTP LAN IP is **not** a secure service-worker origin. Android does not rely on a service worker: its assets are inside the APK shell.

### Production configuration, before real deployment

Provision a local HTTPS reverse proxy and a certificate trusted by the clients; see [security](docs/SECURITY.md). Example **values to adapt**, not a provisioned endpoint:

```dotenv
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=3001
DATABASE_PATH=./var/medimart.sqlite
BOOTSTRAP_TOKEN=
ALLOWED_ORIGINS=https://medimart.your-business.example,https://localhost
COOKIE_SECURE=true
TRUST_PROXY_HOPS=1
SESSION_HOURS=8
```

Use `TRUST_PROXY_HOPS=1` **only** behind exactly one trusted proxy, with direct backend access blocked by your firewall. Keep `0` without that deployment arrangement. `https://localhost` in `ALLOWED_ORIGINS` is the Capacitor WebView's bundled origin, **not** an API destination.

The API rejects insecure production cookie/origin settings. TLS termination, certificate provisioning, firewall configuration, and operational backups are deployment responsibilities and have not been set up here.

## Configuration reference

| Variable           | Default / purpose                                                                      |
| ------------------ | -------------------------------------------------------------------------------------- |
| `NODE_ENV`         | `development`; production enables stricter headers and configuration checks            |
| `API_HOST`         | `0.0.0.0`                                                                              |
| `API_PORT`         | `3001`                                                                                 |
| `DATABASE_PATH`    | `./var/medimart.sqlite`, relative to the repository root                               |
| `BOOTSTRAP_TOKEN`  | Random value generated by `npm run setup`; needed only for initial owner registration  |
| `ALLOWED_ORIGINS`  | Explicit comma-separated browser/native origins; HTTPS-only in production              |
| `COOKIE_SECURE`    | `false` in the example development file; must be `true` in production                  |
| `TRUST_PROXY_HOPS` | `0`; do not increase unless your trusted reverse-proxy topology requires it            |
| `SESSION_HOURS`    | `8`, allowed range 1–24; fixed lifetime, not sliding                                   |
| `API_PROXY_TARGET` | `http://127.0.0.1:3001`; read **only by Vite's Node process**, never a browser API URL |

Android stores its server address in its own SQLite settings after the user configures it. Tokens and pairing secrets never go into that settings table.

## Android and Windows builds

Permanent application ID: **`com.medimart.app`**. Application name: **MediMart**.

```bash
# Android debug APK (needs JDK 21 + Android SDK 36)
npm run android:apk                            # → dist/android/medimart-debug.apk

# Windows portable desktop package (needs internet once, or MEDIMART_ELECTRON_DIR)
npm run desktop:build                          # → dist/desktop/MediMart-win32-x64/ + zip

# Application icons (only if you change the mark)
node scripts/generate-icons.mjs
```

Both scripts refuse to claim a result they did not produce: if the JDK, SDK or Electron runtime is
missing they say exactly that and exit non-zero. Built binaries belong in a GitHub release or workflow
artifact — `dist/`, `*.apk` and `*.aab` are git-ignored.

- `android:sync` builds and copies **release-safe bundled assets**; it does not compile an APK.
- For explicit **private-LAN HTTP development only**, use `npm run android:sync:dev` and an Android **debug** build. Never distribute these assets as a release or use real credentials over HTTP.
- On the phone: **Settings → Connection & storage** → server address → request pairing code.
- On an authorized central browser: **Settings → Device pairing** → enter the phone's code → approve.
- Back on the phone: check approval, then sign in with an individual account.

See [Android setup and the remaining verification gate](docs/ANDROID.md) and the [Windows guide](docs/DESKTOP.md). Both applications are built and verified by GitHub Actions — `Android debug verification` (APK + emulator launch) and `Windows desktop application` (portable zip + packaged smoke test on `windows-latest`). The APK and Windows zip appear as workflow artifacts; they are never committed to the repository.

## Quality checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:production
# Or: typecheck + lint + unit/integration tests + builds + compiled-server smoke check
npm run check

# One-time browser installation on an ordinary development machine / CI
npx playwright install --with-deps chromium
npm run test:e2e

# Optional supply-chain checks (require registry access)
npm audit
npm audit --omit=dev
```

Browser tests run against a disposable `.artifacts/e2e/server.sqlite`, **never your configured application database**. Native-adapter tests use a mock Capacitor bridge backed by real desktop SQLite; they are not Android device tests.

In this restricted sandbox, Playwright's normal browser-download hosts are unavailable. A pinned, npm-distributed Chromium alternative is provided:

```bash
MEDIMART_SANDBOX_BROWSER=1 npm run test:e2e
```

This is a test-only Linux fallback; it does not ship in the application. Web security remains enabled in that test browser.

`minimatch` is overridden to `11.0.4` for the development toolchain to address GHSA-g3hv-75wg-m249. Type checking, ESLint, tests, and builds are verified with this override. Re-evaluate it when upstream tools adopt the fixed major; do not run a forced audit fix that downgrades maintained tooling.

## Folder structure

```text
apps/
  api/
    src/                  Express composition, configuration, security middleware, services
  desktop/                Electron shell (main.mjs) and application icons
  web/
    src/
      components/         Shared UI, shell, application/session provider
      features/           Dashboard, authentication, settings, inventory, module placeholders
      lib/                API client, context, navigation definitions
      platform/           Browser/native runtime and native SQLite adapter
    public/               Local icon and WebView fallback page
    android/              Native project; no compiled APKs or web build artifacts tracked
packages/
  shared/src/             Validation schemas, permissions, UUID/money/sync contracts
  database/src/           Shared migrations, adapters, settings and outbox primitives
scripts/                  Setup, migration, native sync, offline-shell and test helpers
tests/                    API, database, platform contracts, browser tests
docs/                     Design, API/security/Android guides, completion report
.github/workflows/        Foundation CI and manual Android verification workflow
var/                      Local development DB (ignored)
```

## Data safety and scope

- Do not edit released migrations or their frozen seed snapshot. Add a new migration; checksum drift blocks startup.
- Never synchronize password hashes, sessions, device secrets, or bootstrap tokens through the business outbox.
- Do not copy a live SQLite file alone as a backup while WAL writes are in progress. Use **Backup and Sync → Create backup now**, which writes a consistent snapshot, re-opens and verifies it. See the [database guide](docs/DATABASE.md).
- Do not clear Android app data or uninstall to fix a connection error. This removes installation identity and local records.
- A cached shell is **not** offline authentication. Disconnected browsers do not receive protected privileges. Offline capture exists only in the Android application, only for a device with an approved pairing and a valid individual session.
- Catalogue, supplier, category and unit changes remain online-only; the offline outbox accepts sales, customers, debt repayments, stock receipts, purchase orders and expenses. Credit sales, unverified discounts and prescriptions are refused offline by design. The stock ledger is authoritative; cached balances are compared by the reconciliation report, never silently overwritten.
- A backup contains the whole database, including password hashes. Keep the backup folder, and any USB copy, private.
- Never store money as floating point. Amounts are integer kobo from form input through the database.
- No paid services, public hosting, or cloud synchronization are required or configured.

## Phase 7 status and remaining limitations

Phase 7 (final testing, packaging and release preparation) did the following:

- **Stock valuation unified.** `/api/inventory/dashboard`, the product list and `/api/reports/finance`
  now value stock one way: actual batch acquisition cost where batch cost data exists, product cost
  price only for quantities with no batch record. Historical COGS is never restated. Regression
  tests in `tests/valuation.test.ts` pin the rule; the accounting treatment is documented in
  `apps/api/src/services/inventory/valuation.ts` and the Phase 7 report.
- **Windows packaging fixed and verified.** `scripts/build-desktop.mjs` now stages the full runtime
  module closure (the Phase 6 script missed transitive dependencies such as `body-parser`), checks
  that loadable win32-x64 native addons are present, and runs cross-platform. The `Windows desktop
application` workflow builds the portable zip on `windows-latest`, runs the whole test suite on
  Windows, smoke-tests the packaged server through the exact `ELECTRON_RUN_AS_NODE` runtime path,
  and launches the window for a screenshot.
- **Android APK built by CI.** The `Android debug verification` workflow compiles
  `com.medimart.app`, verifies package id/permissions/versions and the absence of embedded secrets,
  then installs and launches the APK in an Android emulator with a screenshot.
- **Documentation.** [docs/API.md](docs/API.md) documents every implemented endpoint, including the
  backup and synchronization APIs that earlier drafts wrongly described as missing.

This is **not** a claim of production readiness:

- The Windows application is verified on a GitHub-hosted Windows runner (build, full test suite,
  packaged smoke test, window launch) — **not** on the target HP Stream 11 Pro, and not by a human
  clicking through it.
- The Android APK is verified by CI and an emulator — **not** on a physical phone.
- Offline mode is Android-only and deliberately limited: credit sales, unverified discounts and
  prescriptions are refused offline.
- A restore is applied only at the next controlled start, and requires the application to be closed.
- No code signing, no Windows Installer, no automatic update. The local API is HTTP on loopback, and
  HTTP on a private LAN only in the documented debug APK profile.
- The central database is not encrypted at rest; it relies on Windows account permissions. Backups are
  unencrypted files and must be kept private.
- A paired Android installation cannot change servers; a safe rebind is not implemented.
- There is no local TLS provisioning, firewall configuration or public-internet exposure protection;
  an administrator must configure them.

See [`docs/PHASE_7_REPORT.md`](docs/PHASE_7_REPORT.md) for the exact test results, verification
levels and the remaining-issue list.

## Third-party assets

Fonts and icons are bundled locally, with selected package license texts in [`THIRD_PARTY_NOTICES.txt`](apps/web/public/THIRD_PARTY_NOTICES.txt). A complete native/backend/transitive license inventory and release-signing review are still needed before distributing a production application. No project-wide source license has been selected on the repository owner's behalf.
