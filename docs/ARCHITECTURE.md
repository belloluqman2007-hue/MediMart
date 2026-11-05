# Architecture — Phase 1

## Decision

A small TypeScript workspace with three boundaries: **presentation**, **authority/security**, and **platform-neutral persistence contracts**. Avoid microservices, event brokers, an ORM, and cloud dependencies until there is a demonstrated requirement.

```text
Android installation                              Central computer / LAN server
┌────────────────────────────┐                    ┌────────────────────────────┐
│ Bundled React application  │  HTTPS on local LAN │ Express API                │
│ Native SQLite/SQLCipher    │◀───────────────────▶│ Auth / permission checks   │
│ Installation UUID         │  Identity/pairing   │ Authoritative SQLite DB    │
│ Keystore-backed secrets   │  endpoints now      │ Audit and migration ledger │
│ Local outbox/conflict DB   │                    └────────────────────────────┘
└────────────────────────────┘                                  ▲
          No remote startup URL                                 │ same-origin /api
                                                       ┌────────┴───────────────┐
                                                       │ Browser React client   │
                                                       │ HttpOnly cookie session│
                                                       │ No primary browser DB  │
                                                       └────────────────────────┘
```

The sync arrow is **not a synchronization engine**: only authentication, pairing, configuration, and health communication currently exist. There are no business-record push/pull endpoints.

## Workspace boundaries

- `apps/web`: UI and platform selection. Business screens are placeholders. The API client never embeds a loopback backend URL.
- `apps/api`: Express transport, validated configuration, error mapping, authorization middleware, authentication/device/audit services. The API is the authority for current server permissions.
- `packages/shared`: strict Zod contracts, role/capability vocabulary, UUID normalization, safe integer-kobo type, canonical operation fingerprints, and server-origin validation. No database driver or platform APIs here.
- `packages/database`: SQL interfaces, serialized transaction boundary, immutable migration plan, settings access, local outbox and receipt/conflict primitives. The default export is platform-neutral; `@medimart/database/node` is the explicit Node-only adapter.
- The native adapter is loaded dynamically only for a native runtime. The secure-storage plugin's browser fallback is never invoked.

The API build bundles the shared workspaces but leaves native `better-sqlite3` and `argon2` packages external. Deploy with their installed production dependencies; the API bundle is not a standalone executable. `npm run test:production` starts the compiled entry point against an isolated temporary database to catch native-loader and static-serving regressions.

## Persistence contract

`SqlExecutor` exposes parameterized `run` and `all`. `Database` adds `transaction` and `close`. `SerializedDatabase` serializes **the entire asynchronous transaction**, not just individual SQL statements. Otherwise another request could inadvertently run inside a transaction held across an `await`.

Only use the callback's `tx` inside a transaction. Calling the outer database from inside its transaction would deadlock. Keep expensive hashing and remote I/O outside a transaction. Security-sensitive writes recheck session/grants inside their transaction after password hashing.

- Central driver: `better-sqlite3`, WAL, foreign keys, `synchronous=FULL`, 5-second busy timeout.
- Android driver: maintained Capacitor community SQLite plugin, requesting SQLCipher encryption, the same migration SQL, foreign keys, WAL and FULL synchronization.
- Rollback errors close the connection rather than allowing writes with an unknown transaction state.
- No persistent domain records use `localStorage`. Browser state is transient; browser credentials are in an HttpOnly cookie.

## Identity and authority

- All record primary keys are non-nil RFC UUIDs, not database auto-increments.
- Each Android installation creates one random UUID in local SQLite. It is not an IMEI, MAC address, or cross-app tracking identifier.
- A separate random registration secret goes into OS-backed secure storage. The central server stores only its hash.
- Pairing codes are short-lived human-verification challenges. Only authorized staff with `devices.manage` can approve them.
- Native bearer sessions are bound to approved devices; revocation is checked on each API request.
- Browser accounts intentionally sign in using cookies without native device pairing. Pairing is not hardware attestation or a network-wide access-control firewall.
- No browser/native cached role list becomes a server authorization decision.

## Local operation envelope — ready for future domain handlers

An operation carries a UUID, source installation UUID, entity UUID/type, mutation kind, **base version**, and a JSON payload. The fingerprint covers the complete canonical envelope, not only the payload.

A future domain handler must:

1. Authorize the staff member using an approved online/offline access policy.
2. Validate domain input, including integer-kobo money fields.
3. Generate the operation UUID once and retain it for retries.
4. Call `commitLocalOperation(database, operation, async tx => { ...domain write... })`.
5. Persist the domain change and outbox entry **atomically**.

The helper returns an exact replay without applying the callback again. Reusing an ID with a changed envelope throws an idempotency conflict. The callback is not allowed to perform remote I/O or irreversible side effects.

Future central application must similarly check/store a receipt and apply a mutation within **one transaction**. A stale `baseVersion` must capture both sides into `sync_conflicts` and await explicit resolution. There is no last-write-wins fallback.

The outbox is durable but currently idle. There is no retry scheduler, queue leasing, batch API, push/pull cursor protocol, deletion propagation, cross-device reconciliation, or conflict-resolution UI. Do not interpret a populated queue as synchronized data.

## Offline behavior today versus the eventual product

| Situation                                                   | Phase 1 behavior                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No internet, central server reachable on LAN                | Bundled/self-hosted app and authentication continue to use the LAN; no external runtime services |
| Native app opens with no network                            | Its bundled shell and local database initialize; settings/connection UI remains available        |
| Native app has no configured server                         | Opens normally and offers configuration; does not attempt a hardcoded address                    |
| Native database fails to open/migrate                       | Blocks with a non-destructive error; never substitutes in-memory/localStorage data               |
| Disconnected native sign-in / cold session restore          | No authenticated privileges; offline credential enrollment/leases are not implemented            |
| Native app backgrounds                                      | In-memory authenticated view locks; foreground restoration revalidates with the server           |
| Browser disconnected after a production secure-origin visit | Public shell can reopen from service-worker cache; API responses and records are not cached      |
| Browser first visit without its local server                | Not promised; use the independently bundled Android shell for installation-independent startup   |
| Future offline writes                                       | Atomic queue foundation available to future handlers; no actual business writes exposed now      |

`connection` reports API health/session reachability, not merely the browser's internet indicator. Synchronization is separately labeled **not implemented**.

## Expansion paths, not implemented features

- **Desktop:** a future desktop wrapper can use the shared React shell, migration plan and storage contract with an IPC-protected local adapter. Do not import Node modules into browser-facing UI code.
- **Multiple phones:** independent local files and installation identities, shared protocol vocabulary, explicit central-server binding. Rebinding enrolled/unsynchronized installations is deliberately refused until a safe migration procedure exists.
- **Cloud backup/sync:** optional later transport, never a startup or daily-operation prerequisite. Credentials and encryption-key recovery require a separate design.
- **New business module:** add a domain package/service, a new migration, explicit permissions, strict API contracts, and tests before replacing its placeholder.

## Release review gates

Real Android build/install/airplane-mode tests, certificate/pairing validation on multiple phones, offline authorization policy, production backup/restore drills, patient-data controls, and an operational threat review must precede real clinical or financial use. Phase 1 is not a production-certified pharmacy or medical-records system.
