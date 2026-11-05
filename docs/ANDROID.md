# Android foundation and verification gate

## Current status

**Generated and synchronized, not compiled. No APK has been built, signed, installed or verified here.**

The sandbox has Node/npm and native Node build tools but no Java, Android SDK, Android emulator or system Gradle. Its network allowlist also excludes the usual Google/Maven/Gradle distribution hosts. Successful `cap add`/`cap sync` is not an APK build.

| Item                                | Configuration                                            |
| ----------------------------------- | -------------------------------------------------------- |
| Permanent app ID / Java namespace   | `com.medimart.app`                                       |
| App name                            | `MediMart`                                               |
| App version                         | `0.1.0`, versionCode 1                                   |
| Capacitor core / Android / CLI      | 8.6.0                                                    |
| Native SQLite plugin                | `@capacitor-community/sqlite` 8.1.1                      |
| Native secure storage               | `@aparajita/capacitor-secure-storage` 8.0.1              |
| SQLCipher declared by SQLite plugin | 4.17.0                                                   |
| Java toolchain required             | JDK 21                                                   |
| Android SDK                         | min 24, compile 36, target 36                            |
| Android Gradle Plugin               | 8.13.2 (aligned with the secure-storage plugin)          |
| Gradle wrapper                      | 8.14.3                                                   |
| WebView minimum configured          | 110; bundled non-destructive fallback page               |
| Web assets                          | `apps/web/dist`, copied into native assets by `cap sync` |
| Runtime startup URL                 | **None. No `server.url` configured.**                    |

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

Build on a properly provisioned machine:

```bash
cd apps/web/android
./gradlew --no-daemon assembleDebug
# Windows: gradlew.bat --no-daemon assembleDebug
```

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
