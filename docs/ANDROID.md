# MediMart on an Android phone

This page is written so a shop owner can install and use the phone application, and so a developer
can rebuild it. The verification table states exactly what has been checked, because "the code is
there" and "the APK works on a phone" are different claims.

## Current status

**The APK is built, installed and launched by CI, not by this documentation.**

`.github/workflows/android.yml` (job _apk_) compiles the real debug APK with Gradle, verifies its
package id, permissions and contents from the APK file itself, and uploads it as
**`MediMart-Android`**. Job _device_ installs that exact APK in an Android 8.1 emulator, launches it,
captures the screen and the logcat, fails on any `FATAL EXCEPTION`, and runs
`scripts/test-android-pairing.ts` against a live server on the emulator's host (`10.0.2.2`) so the
pairing code, device session, offline push, replay and revocation paths are exercised over a network
that is _not_ `localhost`.

A build on a developer machine uses the same command:

```bash
node scripts/build-apk.mjs --profile debug     # → dist/android/medimart-debug.apk
```

| Item                                | Configuration                                                       |
| ----------------------------------- | ------------------------------------------------------------------- |
| Permanent app ID / Java namespace   | `com.medimart.app`                                                  |
| App name                            | `MediMart`                                                          |
| App version                         | `0.3.0`, versionCode 3 (must equal the root `package.json` version) |
| Capacitor core / Android / CLI      | 8.6.0                                                               |
| Native SQLite plugin                | `@capacitor-community/sqlite` 8.1.1                                 |
| Native secure storage               | `@aparajita/capacitor-secure-storage` 8.0.1                         |
| SQLCipher declared by SQLite plugin | 4.17.0                                                              |
| Java toolchain required             | JDK 21                                                              |
| Android SDK                         | min 24, compile 36, target 36                                       |
| Android Gradle Plugin               | 8.13.2 (aligned with the secure-storage plugin)                     |
| Gradle wrapper                      | 8.14.3                                                              |
| WebView minimum configured          | 104; bundled non-destructive fallback page                          |
| Web assets                          | `apps/web/dist`, copied into native assets by `cap sync`            |
| Runtime startup URL                 | **None. No `server.url` configured.**                               |

Node package compatibility, TypeScript types, plugin discovery and generated project files were checked. Native Gradle dependency resolution and APK/runtime compatibility are still a release gate.

An actual `./gradlew --no-daemon assembleDebug` attempt stopped before compilation with:

```text
ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH.
```

Both `npm run android:sync:dev` and `npm run android:sync` completed here. The **default, release-safe sync was run last**; its generated configuration has no remote startup URL or cleartext/mixed-content permission. Eighteen Android XML files were parsed successfully. None of these checks proves native compilation or device behavior.

## Development machine setup

Install Node 22.x/npm, Android Studio, JDK 21, Android SDK platform 36, build tools 36.0.0, platform tools and an emulator or physical test phone. Ensure `JAVA_HOME` and `ANDROID_HOME` point at those local installations. Android Studio can create the ignored `local.properties` file.

From the repository root:

```bash
npm ci
npm run android:sync
npm run android:open
```

`android:sync` builds the production frontend, adds the public shell cache, and copies local assets/plugin configuration into the existing Android shell. It never replaces the permanent application ID or adds a remote startup URL.

Build on a properly provisioned machine. The convenience script builds the assets, runs Gradle,
checks the package identifier and copies the result to `dist/android/`:

```bash
ANDROID_HOME=$HOME/Android/Sdk node scripts/build-apk.mjs --profile debug
```

Or run Gradle directly:

```bash
npm run android:sync            # ---- or: npm run android:sync:dev for cleartext LAN testing
cd apps/web/android
./gradlew --no-daemon assembleDebug
# Windows: gradlew.bat --no-daemon assembleDebug
```

`scripts/build-apk.mjs` fails loudly and explains what is missing if the JDK or SDK is absent; it
never reports an APK it did not produce. Release signing reads the keystore and passwords from
`MEDIMART_STORE_FILE`, `MEDIMART_STORE_PASSWORD`, `MEDIMART_KEY_ALIAS` and `MEDIMART_KEY_PASSWORD` at
build time. Keystores (`*.jks`, `*.keystore`) and APKs are git-ignored; never commit them.

Expected APK path **only after a successful build**:

```text
apps/web/android/app/build/outputs/apk/debug/app-debug.apk
```

Inspect and install using your SDK tools:

```bash
apkanalyzer manifest application-id app/build/outputs/apk/debug/app-debug.apk
# Must print: com.medimart.app
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.medimart.app/.MainActivity
```

If a phone already has this app with another signing key, do not casually uninstall it to fix the installation error: that deletes its local data. Use a disposable test device and a reviewed migration/signing plan.

The generated Capacitor example tests were removed. A device-side `AppIdentityTest` now checks the permanent app ID, display name and no-backup manifest flag. It has **not been compiled or executed here**. With a compatible test device connected, run from `apps/web/android`:

```bash
./gradlew --no-daemon connectedDebugAndroidTest
```

This identity/manifest smoke check does not replace the physical-device encryption, offline and recovery checklist below.

A manual **Android debug verification** workflow under `.github/workflows/android.yml` installs the SDK, compiles the debug application/device-test harness, checks the app APK identifier, and uploads a temporary artifact. It has **not been run here**. A successful future workflow is evidence of compilation/package-ID verification, not on-device offline/security testing.

## Installing the APK on a shop phone (non-programmer steps)

1. Get the file `medimart-debug.apk` (or `medimart-release.apk`) and put it on the phone: send it to
   yourself by USB cable, Bluetooth, or a file-sharing app you already trust.
2. On the phone open **Settings → Apps → Special access → Install unknown apps**, and allow the app
   you are using to open the file (Files, Chrome, WhatsApp…). Android requires this for anything not
   downloaded from Play Store.
3. Tap the APK file and choose **Install**. If Chrome warns "this type of file can harm your device",
   choose **OK** — that warning appears for every APK downloaded outside Play Store.
4. Open **MediMart** from the app drawer. First start creates the encrypted local database.
5. Follow [Connect a phone to the shop computer](#connect-a-phone-to-the-shop-computer) below.

The phone app asks for only two things: network access (to reach the shop computer) and — only when
you tap **Camera** on the point-of-sale screen — the camera, to read a barcode. It never asks for
location, contacts, storage-wide access, SMS or the ability to run in the background.

### Camera barcode scanning

Tap **Camera** next to the scan field on the point-of-sale screen. The phone asks for camera
permission the first time; allow it. Point the camera at the barcode. The decoded number is added to
the cart exactly as if you had typed it, and the camera closes.

- Nothing is saved, uploaded or logged. Only the decoded number leaves the scanner.
- Not every Android phone can decode barcodes from the camera. If yours cannot, MediMart says so and
  you keep using the scan field, a Bluetooth/USB scanner, or the on-screen search.
- A phone without a camera can still install and run MediMart; the camera is declared optional.

## Connect a phone to the shop computer

1. The Windows computer must be running MediMart (see [DESKTOP.md](DESKTOP.md)) and both devices must
   be on the same Wi-Fi router. Internet is not needed.
2. On the computer open **Settings → Connection & storage** and note the address, for example
   `https://192.168.1.20:4780`.
3. On the phone open **Settings → Connection & storage**, type that address, name the phone (e.g.
   "Counter phone"), and request a pairing code.
4. On the computer open **Settings → Device pairing**, check the phone name, and type the eight-digit
   code.
5. On the phone tap **Check approval**, then sign in with that person's own staff account.

Codes expire after ten minutes. An approved phone still needs a real staff login; the device alone
grants nothing. If a phone is lost, revoke it on the computer: it keeps the records already captured
on it but can no longer push anything, and it is refused with a session error.

## Working without a connection

When the phone cannot reach the shop computer (Wi-Fi dropped, computer asleep, router restarted):

- The point of sale offers **Keep sale on this device** instead of failing. The sale is written to the
  phone's own encrypted database with a provisional receipt number such as `OFF-20261110-0001`.
- **Backup and Sync** on the phone lists everything waiting, and **Synchronize now** sends it when the
  connection returns. MediMart also tries automatically when a signed-in session reconnects.
- The shop computer re-checks every kept record before it counts: the device fingerprint, the device
  state, the clock, the stock, the price and the permissions. Anything it cannot verify is rejected or
  parked as a conflict and listed for a human to review — never forced through.
- Sending the same record twice is safe: the second attempt is recognised as a duplicate and changes
  nothing.
- Deliberate restrictions: credit sales, unverified discounts and prescriptions cannot be completed
  offline, because they need an online decision that the phone cannot make safely.

---

## What start-up does, and what happens when it fails

See [ANDROID_STARTUP_FIX.md](ANDROID_STARTUP_FIX.md) for the full investigation. In short:

1. Before the WebView exists, `StartupSelfCheck` writes the **installed APK version**
   (`version=<versionName>/<versionCode>`), the device and WebView versions, and proves the Android
   Keystore can generate and use an AES-256/GCM key, and that the SQLCipher library loads (logcat tag
   **`MediMartStartup`**). It never logs a key and cannot crash the application.
2. The bundle then logs its own compiled identity as its first line —
   `[MediMart] [build] MediMart 0.3.0 · a1b2c3d4 · 2026-11-11 · production` — so even a failure on
   the next line still says which build produced it. The same line is printed on the failure screen.
3. The app then generates a 256-bit passphrase on first launch, or reuses the stored one on every
   later launch, and **reads it back** before the first write. A key that cannot be read back is
   reported, never replaced.
4. The encrypted database is opened, foreign-key enforcement is read back and migrations run; the
   app logs `[MediMart] [database] Encrypted database ready` with the schema version.
5. If anything in that chain fails, the failure screen shows a **diagnostic code** such as
   `database:keystore-key-unusable` or `database:database-key-mismatch` and says explicitly that
   nothing was deleted, recreated or stored unencrypted. Collect the code plus
   `adb logcat -s MediMartStartup Capacitor/Console` for support; neither contains keys or business
   data.

Supporting an existing installation: **install the new APK over the old one.** Uninstalling or
clearing app data destroys the only copy of the encrypted database and the Keystore key that
decrypts it.

### If the phone shows "Local storage needs attention"

That screen is the application **refusing to guess**. Start-up needs an encrypted database it can
prove it opened with the right key; when it cannot, it stops and says so instead of falling back to
an unencrypted or in-memory store, and instead of recreating the file. Two facts are on the screen
and both are needed by whoever fixes it:

| On the screen                     | What it answers                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `Diagnostic code: <stage>:<code>` | **What** failed — Keystore, passphrase store, plugin load, key/file mismatch, migration. |
| `Build: <version> · <commit> · …` | **Which code** was running — the exact commit the APK was built from.                    |

Work through it in this order:

1. **Read the build line.** If it is missing, the installed APK is older than `0.3.0` (versionCode 3)
   and predates the diagnostics entirely: install the current `MediMart-Android` artifact over the
   top and look again. This is the single most common reason a report cannot be answered — two APKs
   once shared `versionName 0.2.0` / `versionCode 2` while containing different start-up code.
2. **Read the diagnostic code** and match it against `classifyDatabaseError` in
   `apps/web/src/platform/diagnostics.ts`. `database:keystore-key-unusable` and
   `database:keystore-key-unreadable` mean the device's Keystore cannot use the key that encrypts the
   database; `database:database-key-mismatch` means the file and the stored key disagree;
   `database:plugin-load-failed` means the SQLite plugin never finished loading.
3. **Capture logcat with a computer** — `adb logcat -s MediMartStartup Capacitor/Console`. It holds
   the native self-check result (`self-check ok` or `self-check failed keystore=… sqlcipher=…`), the
   build identity and the redacted error. No key, no patient data, no business data.
4. **Never** clear app data, never uninstall, never "just reinstall fresh" as a workaround. Each of
   those destroys the only copy of the encrypted database and/or the key that decrypts it.

CI asserts both identity channels on a real Android runtime (`scripts/android-emulator.sh` fails the
run if the native version line or the bundle stamp is missing), so a build that cannot say what it is
never reaches a phone.

## Native storage lifecycle

1. Load the SQLite and secure-storage plugins only in a native runtime.
2. Initialize a random SQLCipher secret if no secret exists; never use a hardcoded password.
3. Reconcile the plugin connection state before opening/retrieving the local connection.
4. Open encrypted `medimart` SQLite, enable FK/WAL/FULL synchronization and run the shared migrations.
5. Create an installation UUID and local device/sync-device rows once; preserve them over restarts.
6. Keep central URL and installation ID in SQLite. Keep session/pairing secrets in Keystore-backed storage keyed by installation + origin.
7. Block startup if the database/crypto/migration initialization fails. Never delete or recreate an existing database automatically.

The adapter is covered by tests against a mocked Capacitor bridge using real desktop SQLite. Those tests prove adapter calls, SQL/migration behavior, UUID persistence, token separation and fail-closed behavior, **not actual Android encryption or Keystore semantics**.

## Connect and pair on local Wi-Fi

1. Start the central API and local HTTPS endpoint. Create the first owner using a central-server browser.
2. Connect the phone to the same reachable LAN; internet access is not needed for normal local communication.
3. Open native **Settings → Connection & storage**.
4. Enter the actual central server HTTPS origin. Do not use the central computer's `localhost` address on a physical phone.
5. Give the phone a recognizable name and request a pairing code.
6. The secret is saved before sending registration. If a response is lost, retrying preserves installation identity. A new pending code invalidates the old code.
7. On the central browser, an authorized operator opens **Settings → Device pairing**, verifies the phone, and enters its eight-digit code.
8. On the phone, check approval, then sign in with a staff account.

Codes last 10 minutes, with five incorrect approval attempts. A device secret alone is not a staff login. An approved device still requires a valid individual account and appropriate permissions.

An enrolled installation cannot change servers through the basic settings form. Pending records or enrollment need a separately designed rebind/export procedure. Revoked installations cannot silently re-enroll.

## Explicit HTTP development mode

Prefer trusted development HTTPS. For a disposable private-LAN setup only:

```bash
# Repository root
npm run android:sync:dev
cd apps/web/android
./gradlew assembleDebug
```

This build mode sets the native-only HTTP development flag and Capacitor mixed-content setting; the debug manifest/network config allows cleartext. The URL validator still limits HTTP to private/local addresses. Never use real credentials or patient/business data in this mode.

Before any release build, run **`npm run android:sync` again**. Release Android's manifest/network config prohibits cleartext regardless of debug configuration. No release signing key, keystore password, signing service, or signed artifact is created in Phase 1.

## Security configuration in source

- Release cleartext disabled; release trusts system CAs only.
- Debug-only trust of user CAs for controlled local testing.
- Backup disabled and explicit cloud/device-transfer exclusions for the app's data stores.
- `FLAG_SECURE` set to protect future sensitive views in screenshots/recent-app previews.
- File provider limited to a dedicated app-private export cache path; no generic database exposure.
- Local MediMart icons/splash, bundled fonts and error page; no remote font/image/CDN requests.
- Unused Google-services/Firebase configuration removed from the generated template.
- Build output, machine settings, copied web assets, signing keys and APKs are ignored by Git.

## Required physical-device checklist (not performed here)

- [ ] Gradle debug and release builds succeed; inspect app ID, label, permissions and signing certificate.
- [ ] Fresh install launches in airplane mode with no remote assets and no configured server.
- [ ] Database is actually SQLCipher encrypted, correct native PRAGMAs apply, and migrations survive app restarts/upgrades.
- [ ] Installation UUID and Keystore secrets persist through ordinary app updates and reboots without being copied to another phone.
- [ ] Trusted HTTPS works; untrusted/self-signed certificates and HTTP fail in a release build.
- [ ] Pairing, wrong codes, expiration, renewal, two independent phones and revocation work on a real LAN.
- [ ] Session expiry, background lock, reconnect and lost-server behavior match documented restrictions.
- [ ] Local transaction/outbox crash recovery is verified under process kill/power-loss scenarios using disposable fixtures.
- [ ] Backup/device-transfer exclusions and `FLAG_SECURE` behavior are checked on supported Android/OEM versions.
- [ ] Minimum WebView fallback, touch targets, keyboard/safe-area behavior and accessibility are checked on phones/tablets.
- [ ] A key-loss, uninstall, backup/restore and account-recovery procedure is approved before storing real records.

Do not mark any of these complete based only on a mocked adapter test or `cap sync` output.
