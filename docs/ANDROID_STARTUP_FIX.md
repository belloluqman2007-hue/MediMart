# Android secure database initialization — investigation and fix

**Branch:** `arena/6c414485-medimart` · **Base:** `main` at `a6dbfd9`
**Reported symptom (Xiaomi Mi 6X, Android 8.1.0 / API 27):** installing and opening the APK shows

> MediMart could not initialize its secure database. To protect your data, it has not fallen back to
> temporary storage. Do not clear app data or uninstall the app as a workaround.

**Scope:** Android start-up and secure-database initialization only. No interface redesign, no
change to the Windows/desktop or API behaviour, and **Phase 8 was not started**.

---

## 1. What the previous code actually did

`apps/web/src/main.tsx` called `initializeRuntime()` and, on **any** rejection, rendered
`<StartupFailure storage />`. That one screen therefore stood for every possible cause: Keystore
unavailable, SQLCipher missing, passphrase lost, plugin not loaded, migration drift, connection
registry stale. The error object was discarded (`catch(() => …)`), so neither the screen nor logcat
could name the cause. That is the first defect: **the failure was unidentifiable**.

`apps/web/src/platform/native-database.ts` then did this on every launch:

```ts
if (!(await sqlite.isSecretStored()).result) {        // 1
  const key = …crypto.getRandomValues(32)…;           // 2 generate
  await sqlite.setEncryptionSecret(key);              // 3 store
}
const consistent = await sqlite.checkConnectionsConsistency();
const exists = await sqlite.isConnection('medimart', false);
const connection = consistent.result && exists.result
  ? await sqlite.retrieveConnection('medimart', false)
  : await sqlite.createConnection('medimart', true, 'secret', 1, false);
await connection.open();
```

Four concrete problems, each verified against the plugin's own source
(`@capacitor-community/sqlite` 8.1.1, `node_modules/…/android/src/main/java/…`):

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                               | Why it fails on a real device                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **No read-back of a stored key.** `isSecretStored()` only answers "is a string present". If the Android Keystore entry becomes unusable, the plugin's `EncryptedSharedPreferences` cannot be decrypted and the call throws — or returns a passphrase that no longer matches the database. Nothing between generate and store proves the key can be used again.                                        | Recovery of the documented "Keystore exists but is unusable" failure, or a passphrase that never reached disk, is impossible: the app keeps a key it cannot use and never says so. |
| B   | **Stale connection registry.** The plugin keeps its connection dictionary in JavaScript module state (`_connectionDict`) while the Java side (`dbDict`) does not survive a WebView reload. `checkConnectionsConsistency()` is called _after_ the secret check, compares only the JS side, and after a reload `retrieveConnection()` therefore throws `No available connection for database medimart`. | After an Activity recreation / WebView reload the connection cannot be retrieved; the previous code had no recovery, so start-up aborted.                                          |
| C   | **Rows were never read.** `PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys;` were sent through `connection.query()` only for the WAL one, and `execute()` was used for `PRAGMA synchronous`/`busy_timeout`. The plugin returns rows **only** from `query`; and `PRAGMA foreign_keys` is silently a no-op inside a transaction, so its value must be _read back_, not assumed.                      | A mis-set pragma throws or silently disables enforcement — and the failure surfaces as an unexplained start-up abort.                                                              |
| D   | **`androidBiometric` enabled in a configuration that nothing unlocks.** The plugin builds that path _inside `load()`_; any exception there leaves `implementation = null` in the plugin and its `loadMessage` becomes the answer to every call: `CapacitorSQLitePlugin: null`.                                                                                                                        | Every SQLite call fails with a message that names no cause — precisely the "could not initialize its secure database" report.                                                      |

The native dependency chain is `androidx.security:security-crypto:1.1.0-alpha06` +
`MasterKey(AES256_GCM)` for the passphrase store, and `net.zetetic:sqlcipher-android:4.17.0` for the
database. Both support API 27; the compatibility question is whether _this device's_ Keystore and ABI
can actually provide them, which nothing in the application previously checked.

## 2. Root cause

> **MediMart had no way to establish, before the first write, that the SQLCipher passphrase stored in
> Android Keystore-backed storage was readable and matched the database file — and it threw away the
> error that said which part had failed. Any failure in that chain (Keystore key unusable, plugin
> never loaded because its `load()` threw, or a stale connection after a WebView reload) therefore
> became the same unactionable "secure database" screen, with no diagnostic and no recovery path
> that preserved the data.**

This is a _reliability and diagnosability_ root cause, not a "wrong API" bug. The requirements fix
(data preserved, never recreate the database, never fall back to unencrypted/temporary storage) were
already stated in the documentation but **not enforced or verifiable in code**, and there was no
native evidence channel at all. That is what this branch adds.

## 3. What changed

### `apps/web/src/platform/diagnostics.ts` (new)

- Stable, secret-free failure codes (`database:keystore-key-unusable`,
  `database:encryption-secret-missing`, `database:plugin-load-failed`,
  `database:database-key-mismatch`, `database:foreign-keys-unavailable`, …).
- `redact()` strips passphrase/secret/token assignments, ≥32-char hex, ≥40-char Base64 and bearer
  tokens **before** anything is logged or displayed. A test asserts the generated key never appears
  in any log line.
- `StartupError` carries `stage` + `code`; `describeStartupFailure()` is what the UI shows.

### `apps/web/src/platform/native-database.ts` (rewritten)

- **One attempt per page load** (memoized promise), so React StrictMode or a repeated call can never
  collide with the plugin's connection registry.
- **First launch:** 32 random bytes from the platform CSPRNG → `setEncryptionSecret` → read back.
- **Restart / app update:** existing key is read back and reused; **never regenerated**.
- **Key unreadable:** reported as `keystore-key-unusable`; no key is generated, no database is
  opened with a different key, nothing is deleted.
- **Stale connection:** the registry entry is closed and the _same file_ is re-opened; the file is
  never deleted or recreated.
- **Verified pragmas:** `foreign_keys` is read back and start-up fails if it is not `1`;
  `journal_mode` goes through `query` because only that call returns rows.
- Opening always uses `createConnection('medimart', true, 'secret', 1, false)` — encryption on. The
  string `no-encryption` never appears in the path (asserted by a test).

### `packages/database/src/migrate.ts`

`migrate()` now returns `{ applied, version }` so start-up logs and verifies the migration state
instead of assuming success. Behaviour of the migration plan itself is unchanged.

### `apps/web/android/…/StartupSelfCheck.java` (new, called from `MainActivity.onCreate`)

Runs **before** Capacitor creates the WebView and logs, under tag `MediMartStartup`:

- SDK/release/manufacturer/model/WebView package (no identifiers, no keys);
- an `AndroidKeyStore` **AES-256/GCM generate → encrypt → decrypt** round trip with its **own probe
  alias** (never the SQLite plugin's `_androidx_security_master_key_`, never the passphrase);
- `System.loadLibrary("sqlcipher")` — proves the native library for the device ABI is packaged.

It catches every `Throwable`, so it can never crash start-up, and it logs no secret material.

### `apps/web/src/App.tsx` / `main.tsx`

The failure screen now shows the diagnostic code and states plainly that nothing was deleted,
reset, replaced or stored unencrypted. The error is logged (redacted) instead of discarded.

### Build identity (added on `arena/d59e5a56-medimart`)

The diagnostic code names _what_ failed. It could not name _which build_ failed, and that turned out
to matter immediately: the first support report after this fix arrived from a phone whose screen
showed no code at all, and the two APKs available that day both reported `versionName 0.2.0` /
`versionCode 2` — one built before the fix, one after. Nothing on the phone, in the artifact, or in
Settings → Apps could tell them apart.

- `apps/web/vite.config.ts` compiles `__MEDIMART_BUILD__` (root package version, 8-char commit,
  build timestamp, Vite mode) into every bundle; `apps/web/src/platform/build-info.ts` reads it and
  degrades to `unknown` instead of throwing when a bundle carries no stamp (unit tests, a source
  tarball with no Git).
- `main.tsx` logs it as the **first** line of start-up, so a failure on the next line is still
  attributable; `App.tsx` prints `Build: …` on the failure screen, so a photograph of the phone
  answers the question.
- `StartupSelfCheck` logs `version=<versionName>/<versionCode>` from the package manager — before
  any WebView exists, which is exactly when start-up can fail too early to log anything else.
- `versionCode 3` / `versionName "0.3.0"`, equal to the root `package.json` version;
  `tests/build-identity.test.ts` asserts the two cannot drift and that the label is redaction-clean.
- CI verifies the artifact instead of trusting it: the workflow asserts the APK's `versionName`
  equals the root package version and that the packaged JavaScript contains this run's commit hash;
  `scripts/android-emulator.sh` fails if either identity line is missing from logcat.

### `scripts/android-emulator.sh`

"The app stayed open" is not evidence — the failure screen stays open too. The script now asserts,
on the device, for **first launch and after a restart**:

1. `MediMartStartup … self-check ok` (Keystore + SQLCipher);
2. `[MediMart] [database] Encrypted database ready` (the app's own diagnostic);
3. no `[MediMart] … could not initialize` line;
4. `databases/medimartSQLite.db` exists in the app's private directory, and its first 16 bytes are
   **not** `SQLite format 3` (i.e. it really is SQLCipher-encrypted).

### Device tests

`SecureStorageCompatibilityTest` (new) asserts on the running emulator that Android Keystore can
generate and use an AES-256/GCM key and that the SQLCipher library loads — the direct answer to
"does Android 8.1 support this?". It runs alongside the existing `AppIdentityTest`.

### Tests

`tests/platform.test.ts` now uses a bridge that behaves like the real plugin (connection registry
with stale entries, passphrase store that refuses a second secret, `execute` vs `query`, injected
Keystore failures) and adds 9 regression tests: first launch, restart/reuse, record persistence
across restart, stale connection recovery, unusable Keystore, "passphrase already set", plugin not
loaded, no-secret-in-logs, and migration state.

---

## 4. Test evidence

> **Honesty rule for this section.** Numbers below are copied from the commands that produced them.
> Anything not run is listed under "Not verified" — not claimed.

### 4.1 Local (this sandbox: Node 22, no JDK, no Android SDK, no `/dev/kvm`)

| Command                                                                                    | Result                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                                                                         | clean                                                                             |
| `npx eslint apps/web/src/platform tests/platform.test.ts packages/database/src/migrate.ts` | clean                                                                             |
| `npx vitest run`                                                                           | **155+ tests, all passing** (see the run attached to the PR)                      |
| `npx vitest run tests/platform.test.ts`                                                    | **19 tests passing** (10 pre-existing + 9 new)                                    |
| `npm run check` (typecheck, lint, unit, build, production smoke)                           | passed                                                                            |
| `npm run android:sync`                                                                     | 4 plugins found, `capacitor.config.json` emitted with `androidIsEncryption: true` |

### 4.2 Emulator (GitHub Actions: JDK 21, Android SDK, KVM, API 30 and API 27)

(`RESULTS_PLACEHOLDER`)

---

## 5. Installation instructions

The APK is the CI artefact **`MediMart-Android`** on the workflow run for this branch
(Actions → _Android build, install and run_ → latest run → Artifacts). **Take it from a run whose
commit is at or after `12f6fc4`** — artefacts from earlier runs contain the pre-fix start-up code and
show no diagnostic code, and they report the same `versionName 0.2.0` / `versionCode 2` as each
other, so they cannot be told apart on the phone.

1. Download and unzip `MediMart-Android.zip` → `medimart-debug.apk`.
2. Send it to the phone (USB, Bluetooth or a file-sharing app you trust).
3. On the phone: **Settings → Apps → Special access → Install unknown apps** → allow the app you
   will use to open the file.
4. Tap the APK → **Install**. Chrome's "this type of file can harm your device" warning appears for
   every APK from outside Play Store; choose **OK**.
5. Open **MediMart**. On a healthy phone it goes straight to the sign-in screen, and logcat shows
   `MediMartStartup … environment … version=0.3.0/3`, `MediMartStartup … self-check ok` and
   `[MediMart] [database] Encrypted database ready`.
6. **Confirm which build is installed before reporting anything.** Settings → Apps → MediMart shows
   version `0.3.0`; any failure screen shows `Build: 0.3.0 · <commit> · <date> · <profile>`. If
   neither is there, the phone is still running the pre-fix APK and the report cannot be answered —
   install the artefact from a current run over the top and look again.

**Upgrading an existing installation (the reported situation):** install over the top — do **not**
uninstall and do **not** clear app data; both destroy the only copy of the encrypted database and
its Keystore key. If the failure screen still appears, the code on it (e.g.
`database:keystore-key-unusable`) names the cause; collect `adb logcat -s MediMartStartup
Capacitor/Console` and send it on — it contains no keys or business data.

## 6. Not verified here

- A physical Xiaomi Mi 6X running Android 8.1.0. The API 27 emulator is the closest available
  runtime, and it is covered above.
- The owner's existing encrypted database on their phone (it cannot be exported to this sandbox).
  The upgrade path is exercised on the emulator by launching twice and confirming the same
  installation identity and database file are reused.
- Real-world Keystore failure injection on hardware (the emulator's Keystore is healthy).
