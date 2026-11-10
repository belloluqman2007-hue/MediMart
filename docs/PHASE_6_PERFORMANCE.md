# Phase 6 performance report

**What this is:** timings produced by `tests/performance.test.ts` on the Linux build machine, through
the real HTTP API, against a database with a realistic starting catalogue. **What it is not:** a
measurement on the shop computer (Intel Celeron N3050, 4 GB RAM, Windows 10). That machine is slower;
run the same script there before trusting any figure.

Reproduce:

```bash
npx vitest run tests/performance.test.ts
```

## Dataset

- 400 products (seven of them merchandise with no expiry), 100 units of stock each
- 200 completed cash sales, 1,200 sold line items
- 1 backup file, 1.8 MB

## Results

| Operation                                                      | Time                          |
| -------------------------------------------------------------- | ----------------------------- |
| First owner registration (Argon2id hashing, deliberately slow) | 157 ms                        |
| Create 400 products in one transaction                         | 31 ms                         |
| POS product search across 400 products                         | 8.4 ms                        |
| POS first page (40 products)                                   | 5.7 ms                        |
| 200 checkout requests / 1,200 items                            | 2,109 ms total, ≈10.5 ms each |
| Sales report (today)                                           | 6.7 ms                        |
| Financial report (month)                                       | 31 ms                         |
| Inventory dashboard aggregates                                 | 17 ms                         |
| Stock movement history page                                    | 3.1 ms                        |
| Create and verify a backup                                     | 119 ms                        |

## Interpretation

- Every read a cashier waits for (search, product page, checkout) is in the low milliseconds. Even a
  machine five times slower stays well inside what a person perceives as instant.
- The heaviest single action is a monthly financial report at 31 ms; the heaviest repeated one is a
  checkout at about 10 ms, which is dominated by the transactional writes and the receipt number, not
  by the interface.
- Backups scale with database size, not with the number of rows read: `VACUUM INTO` plus verification
  took 119 ms at 1.8 MB. A year of trading at this volume stays in the tens of megabytes.
- The server has no background workers, no polling and no third-party calls, so an idle shop computer
  uses no CPU between requests.

## Ceilings asserted by the test

The test fails if search exceeds 1.5 s, the monthly finance report 5 s, the dashboard 3 s, or backup
creation 60 s. These are deliberately generous: they catch an accidental full-table scan or an
unbounded payload, not normal variation.

## Not measured

Startup time of the Windows window on the target hardware, steady-state memory over a full trading
day, and long-session stability. None of those can be measured honestly in this environment; they are
listed as known gaps in `PHASE_6_REPORT.md`.
