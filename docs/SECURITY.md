# Security model and release gates

## Implemented controls

### Accounts and passwords

- There are no seeded users, shared passwords, or hardcoded application credentials.
- Owner bootstrap requires a cryptographically random server setup token, at least 32 characters long. `npm run setup` generates 32 random bytes encoded as hex. A transactional user-count check permits exactly one initial owner, including under concurrent requests.
- Later registration requires `staff.manage`. The owner role cannot be assigned through that endpoint. Only an owner can create administrators, and no caller can delegate a permission they do not currently possess.
- Password policy: 12–128 characters for new credentials; passwords are not silently trimmed or normalized.
- Passwords use **Argon2id**, version 19, 64 MiB memory, 3 iterations, parallelism 1, and 32-byte hashes with library-generated salts.
- Unknown accounts still incur Argon2 verification work. Login failure messages do not distinguish nonexistent, disabled, locked, or incorrect-password accounts.
- Five unsuccessful attempts lock an existing account for 15 minutes. Counter and audit updates survive the returned authentication failure. Limits also apply per IP: 10 expensive authentication/registration requests per 15 minutes, 20 pairing registrations per 15 minutes, and 300 API requests per minute.
- A user can change their own password only after verifying their current password. The update increments the account version and revokes **all** sessions atomically. There is no email/cloud dependency.
- Forgotten-password recovery, administrator password reset, MFA and full account lifecycle management are not implemented. Never bypass this by deleting users or resetting the migration ledger.

### Sessions and browser security

- Sessions use random **256-bit opaque tokens**, not JWTs or client-asserted role claims. The server stores only SHA-256 token hashes.
- Default lifetime is a fixed eight hours; the configurable range is 1–24 hours. It does not slide indefinitely on activity.
- Every protected request checks user status, expiry, revocation, approved device status when applicable, and current database role grants.
- Security-sensitive write transactions recheck active session/grants after asynchronous hashing to prevent a stale authorization decision from authorizing a write.
- Browser cookies are host-only, HttpOnly, `SameSite=Strict`, scoped to `/api`, and Secure in production. Raw browser tokens never enter JavaScript, localStorage, sessionStorage or IndexedDB.
- Cookie-authenticated writes require a session-bound CSRF header. Origin checks reject untrusted origins, including preflights. Public JSON writes cannot be submitted as cross-origin HTML forms.
- Native clients receive bearer tokens only after approved installation-secret proof. Tokens are stored using the native secure-storage plugin. Browser code never uses that plugin's insecure browser fallback.
- Logout revokes the current session; logout-all revokes every session for that account. Password changes and device revocation invalidate affected server sessions immediately.
- If native logout cannot reach the server, the local token is removed and the user receives an explicit warning: the remote session remains valid until expiry. The app does **not** claim it was revoked. Browser logout failure does not falsely erase an HttpOnly server session.
- Native backgrounding locks the in-memory authenticated view. Foreground/cold restoration must verify with the central server. No offline password verifier or cached authorization lease is implemented.
- Helmet adds production security headers; the production web/native bundle carries a no-unsafe-eval CSP. Zod is configured without JIT evaluation. The native build permits HTTPS connections to configurable origins; a production browser's response header narrows connections to its same origin.
- API bodies are limited to 64 KiB. Zod validates important inputs and rejects unknown fields. SQL is parameterized. Error responses expose stable codes and correlation IDs, not stacks, SQL, passwords or hashes.

### Device pairing

1. Installation UUID is persisted in the device's SQLite database.
2. The phone generates a separate 32-byte registration secret and saves it securely **before** making a registration request, allowing a safe retry after a dropped response.
3. The server stores its hash and issues an eight-digit code valid for 10 minutes.
4. An authorized operator verifies the physical phone and enters that code in the central settings UI. Five wrong code attempts lock the request until renewed by the secret-holding device.
5. Native login proves the approved installation's secret in addition to the staff password.
6. Revocation invalidates that device's sessions. A revoked device cannot register itself again. Re-enrollment is an intentionally unfinished administrative recovery flow.

Pairing is a trust foundation, **not hardware attestation**. Browser sign-in with a valid individual account is separately allowed; pairing is not a substitute for LAN/firewall controls. Do not accept a code sent by an unknown person without verifying the device and server identity.

### Data and audit

- Central SQLite uses WAL, full synchronization, enforced foreign keys and restrictive file permissions. It is **not SQLCipher-encrypted**; use full-disk encryption and a dedicated OS account before real deployment.
- Android is configured to request SQLCipher encryption. The SQLite plugin protects its encryption secret using Android Keystore-backed storage. Separate session/pairing secrets use `@aparajita/capacitor-secure-storage`.
- No default encryption secret or raw device token is placed in source, the database settings table, or application logs.
- Android backup and device-transfer exclusions prevent accidental migration of database/identity/secret stores to another phone. `FLAG_SECURE` protects app screenshots/recent-app previews. Actual hardware behavior remains a required verification step.
- Audit records cover owner/staff registration, successful/failed login, logout, password changes, settings changes, pairing, approval failures, approval and revocation. Critical successful mutations and their audit entry share one transaction.
- Audit triggers reject UPDATE/DELETE through ordinary SQL access. This is **not tamper-proof protection against an OS administrator who can modify the database file or drop triggers**.
- Public shell caching explicitly excludes `/api/`. No API response, credential, or business/patient record is cached by the service worker.

## Transport deployment

Normal LAN operations must not require a public website, but they still require **transport security**. Wi-Fi membership alone does not make plaintext passwords or patient data safe.

Production requires HTTPS with a certificate trusted by the Android/browser clients and explicit `ALLOWED_ORIGINS`. The Node server itself is HTTP; put a trusted, locally deployed HTTPS reverse proxy in front of it. A publicly trusted certificate with split/local DNS is one option; it can be provisioned separately from normal LAN operation. A private-CA deployment requires deliberate trust provisioning/security review, not bypassing certificate validation.

Release Android trusts system CAs and rejects cleartext. Debug builds alone allow user CAs; explicit `android:sync:dev` additionally enables private-LAN HTTP for throwaway development. Never disable TLS validation or use real credentials with this mode. The `.local` UI examples are illustrative, not provisioned certificates.

If `TRUST_PROXY_HOPS=1`, there must be exactly one trusted proxy and firewall rules must prevent direct access to the backend port. Otherwise forwarded client addresses can be forged and rate limits weakened. Default is `0`.

## Known limits / production gates

- Android compilation, installation, SQLCipher/Keystore persistence, certificate validation, and physical airplane-mode behavior remain **unverified** in this sandbox.
- The maintained SQLite plugin currently depends on AndroidX security-crypto 1.1.0-alpha06 internally. Its native dependencies and device behavior must be reviewed during the Android build gate; npm auditing does not audit Maven/Gradle artifacts.
- The minimum Android SDK is 24, but this is a packaging compatibility floor, not a recommendation to deploy unsupported Android versions. The app requires WebView 110+ and recommends a currently security-supported OS/device.
- No offline authentication enrollment, authorization lease, multi-device business synchronization or conflict resolution is implemented.
- No encrypted backup workflow, key escrow/recovery, lost-device recovery, account-recovery procedure, remote wipe, consent/retention policy or clinical-data compliance certification is supplied.
- Rate limiting is in-memory for one central API process; account lockout persists in SQLite. Restarting the API resets IP rate buckets. A future multiprocess deployment needs a deliberately designed limiter, not a cloud dependency added by accident.
- Staff/device/audit listing endpoints are bounded foundation views (maximum 100 rows), not full paginated administration modules.
- Browser accessibility checks are automated A/AA checks, not a full screen-reader or usability certification.
- `npm audit` reports known npm advisories at the time run, not proof that the system is vulnerability-free. The current tested minimatch override fixes a development-only advisory; keep the lockfile and review upstream updates.

Do not use this phase for real pharmacy dispensing, prescribing, clinical decisions, financial processing, or patient records. Review and approve the foundation and its outstanding deployment gates first.
