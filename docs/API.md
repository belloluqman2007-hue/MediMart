# Phase 1 API

Base path: `/api`. All important write inputs use strict shared Zod schemas. Send `Content-Type: application/json`; request-body limit is 64 KiB. Responses are `Cache-Control: no-store`.

## Authentication transports

**Browser:** the API sets an HttpOnly `medimart_session` cookie, path `/api`, SameSite Strict, Secure in production. `login`, `register-owner` and `session` responses contain a `csrfToken`, but never the raw session token. Put that value in `X-CSRF-Token` for every authenticated write. Keep it in memory, not browser storage.

**Native:** `login` must include approved `{ id, secret }` device proof. The response contains an opaque token for `Authorization: Bearer <token>`, stored only in native secure storage. A bearer token cannot be substituted as a browser cookie. Native sessions remain tied to the approved device and staff account.

State-changing origin checks apply independently of permissions. No frontend navigation check replaces a backend permission check.

## Endpoint map

| Method / path                | Access                                                    | Purpose                                                             |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /health`                | Public                                                    | SQLite/API health, phase 1, `sync: not_implemented`                 |
| `GET /auth/bootstrap-status` | Public                                                    | Whether an initial owner is needed and setup is enabled             |
| `POST /auth/register-owner`  | Valid setup token; no users exist                         | Create the one initial owner and a browser session                  |
| `POST /auth/login`           | Valid credentials; device proof for native bearer session | Sign in                                                             |
| `GET /auth/session`          | Authenticated                                             | Current profile, live permissions, expiry; browser CSRF token       |
| `POST /auth/change-password` | Authenticated + current password                          | Change own password and revoke all sessions                         |
| `POST /auth/logout`          | Authenticated                                             | Revoke the current session                                          |
| `POST /auth/logout-all`      | Authenticated                                             | Revoke all sessions for the current account                         |
| `GET /staff`                 | `staff.view`                                              | Up to 100 staff summaries; never password hashes                    |
| `POST /staff`                | `staff.manage` + delegation rules                         | Register an individual staff account                                |
| `GET /permissions`           | `permissions.view`                                        | Seeded roles and their current capability grants                    |
| `POST /devices/register`     | Installation UUID + generated secret; limited             | Register/renew an unapproved installation; return pairing challenge |
| `POST /devices/status`       | Installation ID + secret proof                            | Get pairing status; no secrets returned                             |
| `GET /devices`               | `devices.manage`                                          | Up to 100 registration summaries; no codes/hashes/secrets           |
| `POST /devices/:id/approve`  | `devices.manage` + matching unexpired code                | Approve the physical device                                         |
| `POST /devices/:id/revoke`   | `devices.manage`                                          | Revoke installation and its sessions                                |
| `GET /settings`              | `settings.view`                                           | Business-name setting                                               |
| `PUT /settings`              | `settings.manage`                                         | Save business name transactionally with an audit entry              |
| `GET /audit-logs?limit=50`   | `audit.view`                                              | Read up to 100 immutable event records                              |
| `GET /sync/status`           | `sync.view`                                               | Pending central queue count and explicit `implemented: false`       |

No products, inventory, sales, purchases, prescriptions, patients, financial posting, backup execution, or push/pull sync endpoints exist. Unknown API paths return a JSON 404, not the SPA HTML.

## Main payload shapes

First owner:

```ts
{
  fullName: string; // trimmed, 2–120 characters
  email: string; // validated, trimmed and lowercase
  password: string; // 12–128 characters, preserved exactly
  bootstrapToken: string; // private server setup token, never put in a URL
}
```

Login:

```ts
{
  email: string;
  password: string;
  device?: { id: string; secret: string }; // native only; non-nil UUID + 64 hex chars
}
```

Staff registration:

```ts
{
  fullName: string;
  email: string;
  password: string;
  roles: Array<
    | 'administrator'
    | 'manager'
    | 'pharmacist'
    | 'healthcare_professional'
    | 'cashier'
    | 'storekeeper'
  >; // nonempty, unique; owner excluded
}
```

Change password:

```ts
{
  currentPassword: string;
  newPassword: string;
} // new must differ and meet the policy
```

Device registration:

```ts
{
  id: string; // persistent installation UUID, not a hardware identifier
  secret: string; // 32 random bytes as hex, saved securely before sending
  name: string; // recognizable physical-device name
  platform: 'android' | 'desktop';
}
```

The device registration endpoint is retry-safe for the **same** ID/secret. A different secret cannot replace an existing registration. A pending retry renews the code and invalidates its predecessor. Approved registrations return approved status without another code; revoked ones cannot re-register.

Approval: `{ pairingCode: string }` with exactly eight decimal digits. Revocation/logout: `{}`. Settings update: `{ businessName: string }`.

## Error contract

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Your account does not have permission to perform this action.",
    "requestId": "a server-generated correlation UUID"
  }
}
```

Validation responses may include `fields: Record<string, string[]>`. They never echo submitted credential values. HTTP statuses: 400 validation/code error, 401 authentication, 403 authorization/origin/CSRF, 404 missing resource, 409 conflict, 410 expired/locked pairing challenge, 413 oversized body, 415 wrong content type, 429 rate limit, 500 generic internal error.

A failed login counter, pairing attempt, or security audit is intentionally committed before its error is returned. A failed business/security write transaction rolls back both its data change and corresponding successful-action audit.

## Foundation boundaries

Role editing, user disabling/reset administration, full pagination/filtering, expired-session cleanup jobs and account recovery are not implemented. The tables/authorization checks prepare for them. Endpoint schemas and bounded responses are intentionally smaller than future operational modules.
