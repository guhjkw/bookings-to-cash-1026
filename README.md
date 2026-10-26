# Bookings to cash (live demo)

A working checker for tour and activity operators running **Bookeo** bookings, **Xero** invoices and **OSB PayZen** payment links joined by Make. Every morning it matches each booking to its invoice and its payments, shows only the bookings that need something, offers one-click fixes, and drafts customer messages in French or English. The company and all data are invented.

## Try it
Open `index.html` (works off disk too) and:
- Work down "Needs action": mark the Xero invoice paid, then Bookeo; send a new link for the refused card; record the cancelled refund, then void its invoice.
- Open "Reminders due", switch a message between FR and EN, and send it.
- In "All bookings", tick the sync-failure box and let a customer pay: the checker catches the open invoice.
- Try to break it: void an invoice before refunding, book a trip in the past, or set a 0-day reminder.

## Files
```
index.src.html            page source (build.py embeds the data for file://)
index.html                built page
src/cashEngine.js         matching, statuses, cash summary, messages, fixes
data/bookings.json        invented activities, bookings, invoices, payments
tests/verify.js           66 logic checks (node)
tests/test-output.txt     the saved passing run
tests/browser-check.py    25 checks driving the real page (Playwright)
```
The page and the tests load the same `src/cashEngine.js`.

## Run the tests
```
node tests/verify.js             # 66 checks: 66 passed, 0 failed
python3 build.py                 # rebuild index.html after editing index.src.html or the data
python3 tests/browser-check.py   # 25 browser checks: 25 passed, 0 failed
```

## How the logic works
| Situation | Status | Fix |
|---|---|---|
| Cancelled, money received | Cancelled but paid | Record refund, then void the invoice |
| Cancelled, invoice open | Invoice still open | Void it in Xero |
| More received than the booking | Paid twice / overpaid | Record refund of the extra |
| Part received | Paid X of Y | Send a link for the balance |
| Paid, invoice open in Xero | Sync failed | Mark the invoice paid |
| Paid, Bookeo unpaid | Bookeo behind | Mark paid in Bookeo |
| No invoice | Never reached Xero | Create it (paid if already paid) |
| Unpaid, trip passed | Overdue | New link |
| Unpaid, link expired or card refused | Link failed (red if the trip is today or tomorrow) | New link, which counts as that stage's reminder |
| Unpaid, open link, reminder stage reached | Reminder due (last call at 1 day) | Send reminder in the customer's language |
| Unpaid, open link, before the first stage | Waiting | Nothing; shows the first reminder date |

Reminder stages (default 7, 3 and 1 days) and the shortfall tolerance are tunable on the page.

## What the delivered version adds
Reads Bookeo, Xero and PayZen through their APIs each morning, writes the fixes back, sends the messages from your address, and emails the exception list before you open.

Built by Taiwo, Pathfinder Automation Solutions.
