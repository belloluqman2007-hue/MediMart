# Phase 6 UAT script — walk it in the shop

A paper script for the owner. Do this on the shop computer and one test phone, with **fake** products
and **fake** patients, before any real trading. Every step below has also been automated in
`tests/uat.test.ts`, which is why the expected behaviour is known.

**Rules while testing:** use invented names and phone numbers (`UAT Test Customer`, `0800 000 0000`),
never a real customer's details. Never type a real diagnosis into a test consultation. Keep a notebook
of anything that surprises you — that is the point of UAT.

| #   | Do this                                                                                                       | You should see                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Install on Windows, create the owner, add a pharmacist and a cashier                                          | Dashboard opens, no error; staff list shows both                                             |
| 2   | Add two products: "UAT Amoxicillin 500mg" (expiry tracked, pack of 10) and "UAT Water 75cl"                   | Both listed with prices; stock 0                                                             |
| 3   | Receive 10 packs + 5 cartons of stock with batch numbers and expiry dates                                     | Stock shows 100 tablets and 60 bottles; movement history has two entries                     |
| 4   | Record a supplier, order 20 packs and 24 bottles, deliver 10 packs only                                       | Order shows "partially received"; stock rises by 100 tablets only                            |
| 5   | Deliver the rest                                                                                              | Order shows "received"; supplier account shows the amount owed equal to what was received    |
| 6   | Sign in as the cashier, sell 10 tablets + 2 bottles, tender more cash than the total                          | Receipt with a change figure; stock falls by 10 and 2                                        |
| 7   | As the cashier, try a discount with no supervisor                                                             | Refused, with an explanation. Retry with the manager's credentials and a reason: accepted    |
| 8   | Sell to a registered customer on credit with a due date                                                       | Outstanding balance appears in Debts                                                         |
| 9   | Refund two bottles as the manager                                                                             | Stock rises by 2, money is paid back, the sale shows "refunded"                              |
| 10  | Register a patient with a penicillin allergy, record a consultation and vitals, write a prescription yourself | The allergy is shown for your review. Nothing is prescribed or diagnosed by MediMart         |
| 11  | Sign in as the pharmacist, dispense the prescription                                                          | Stock falls; the batch with the earliest expiry is used first                                |
| 12  | Sign in as the cashier and open Patients                                                                      | Refused with a permission message                                                            |
| 13  | Record a fictional expense (e.g. "UAT shop rent") and post it                                                 | Expense shows "recorded"                                                                     |
| 14  | Open Financial reports for today                                                                              | Sales, refunds, purchases, expenses and profit agree with the receipts in your notebook      |
| 15  | Register the phone, approve the pairing code, sign in                                                         | Phone shows "Connected"                                                                      |
| 16  | Switch off the shop computer's Wi-Fi (or stop MediMart), then sell on the phone                               | **Keep sale on this device**; the receipt number starts with `OFF-`                          |
| 17  | Close and reopen the phone app                                                                                | The kept sale is still listed under Backup and Sync                                          |
| 18  | Restore the connection, tap **Synchronize now**                                                               | The sale is applied; stock on the computer falls; pressing synchronize again changes nothing |
| 19  | On the computer, revoke the phone, then try to synchronize again                                              | Refused; records stay on the phone but cannot be sent                                        |
| 20  | Create a backup, then verify it                                                                               | "Verified"; the file name contains the date and time; size and record counts are shown       |
| 21  | Truncate a copy of a backup in a scratch folder and try to restore it                                         | Refused as corrupt; the current data is untouched                                            |
| 22  | Restore the real backup, type `RESTORE`, close and reopen MediMart                                            | The data from the backup is back; a safety copy of the previous database exists              |

Anything that does not behave as described above is a defect: write down the step number, what you
saw, and the time, then report it before using MediMart for real trading.
