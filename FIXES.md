# Pay. 1.3.0 — Original dashboard is back

- The top of the dashboard looks like before: the black card with **Switch metric ⇄**
  and the **Accounts & Flow** tiles (Income, Savings & Assets, Debt & Liabilities, Expenses).
- **Switch metric** cycles the card between Cash Balance, Net Worth and End-of-Month Forecast.
- The row under the card shows Opening Cash plus the two numbers the card is not showing,
  so no number appears twice. (Received / Paid Out / Cash Now were removed because the
  tiles and the card already show them.)
- The Savings and Debt pages are now titled **Savings & Assets** and **Debt & Liabilities**.
- All money rules, the one-row-per-bill list, recurring rules drawer, and money effects
  from 1.2.0 are kept. Opening cash is edited from the profile menu.

# Pay. 1.2.0 — Simpler dashboard

Fixes the "5 weird things" review. The money rules from 1.1.0 are unchanged; what you
see is simpler.

1. **One row per paycheck or bill.** Recurring rules no longer sit in the list. They live
   in a small **Recurring rules** drawer (button next to the filters). Each month shows
   one row per bill or paycheck. When you mark it received/paid, that same row turns
   *Completed* — no second or third row.
2. **Balances are separate from cash flow.** Savings/investments (Luno, ASB) and debts
   (Atome) are in a **Balances** panel, not in the transaction list, which is now called
   **Monthly Cash Flow**. A bank balance that was logged as income (e.g. Maybank +RM50)
   can be fixed with **⋮ → Move to Opening Cash**: your cash stays the same, but it no
   longer counts as money earned this month. Opening cash is also editable from the
   **Edit opening cash** link.
3. **Three different numbers, each shown once.** Black card = **Cash Balance**. Below it:
   **Net Worth** and **End-of-Month Forecast**. The old 5-box strip and "Switch metric"
   are gone.
4. **Savings goal uses your real savings.** The goal card shows total savings &
   investments vs your goal (e.g. RM4,015.43 / RM10k = 40%). Percentages are never
   rounded up (0.5% shows as 0.5%). The right panel's default is renamed **Monthly Net
   Cash Flow**.
5. **Only three statuses:** *Pending* (not received/paid yet, no effect on cash),
   *Completed* (money moved, updates cash), *Scheduled* (repeats monthly).

The three formulas:

- Cash Balance = Opening Cash + Completed Income − Completed Expenses
- Forecast = Cash Balance + Pending Income − Pending Bills
- Net Worth = Cash Balance + Savings/Investments − Remaining Debt

**Money effects:** notes and coins fall and a cash sound plays whenever money moves —
a "ka-ching" when income is received, coins dropping when something is paid. Turn the
sound off in the profile menu (**Money Sounds: On/Off**). The falling animation is
skipped if your computer is set to reduce motion.

Tests: `npm test` → 21/21 pass (6 new: one row per paycheck, balances kept out of cash
flow, the three formulas with your numbers — cash RM50, forecast RM2,350, net worth
RM3,922.44 — opening-cash move, three status words, no rounding up).

Your saved data needs no upgrade; nothing is changed or deleted when you open 1.2.0.

---

# Pay. 1.1.0 — Financial logic audit & fix

The look, the six main views, navigation, search, currency selector, month
switcher, quick-add, analytics, settings, privacy toggle and local saving are
unchanged. The money logic underneath was rebuilt so every number agrees.

## What was wrong (root causes)

All screens used one function (`computeMonthMetrics` in the old `index.html`) that added
every record of a month together and only used the status label for display:

1. **Pending income counted as money you had.** Any income in the month, Pending or
   Recurring, was added to cash flow and net worth.
2. **Debt was subtracted from cash as soon as it was entered.** The full debt amount was
   deducted like a payment, and was never tracked as a liability you still owe.
3. **Recurring items counted as paid every month.** A Recurring bill (or salary) was
   applied to every month from its start, as if paid/received, with no record of whether
   it actually happened.
4. **Pending bills were deducted.** Expenses were subtracted whatever their status.
5. **Status could be flipped freely.** "Cycle status" turned Pending into Active without
   creating any real transaction, so history and totals could change silently.
6. **Net worth mixed things up.** Net worth = this month's savings + this month's cash
   flow. Savings didn't carry over between months, there was no opening balance and no
   rollover from one month to the next.
7. **Made-up chart values.** Months with no data were filled with invented numbers in the
   analytics chart.
8. **Fixed "today".** Today was hard-coded to 16 Nov 2026.
9. **Unreadable saved data was replaced by sample data** without keeping a copy.
10. Budgets and debt repayment history did not exist, so they couldn't be tracked.

## The rules now (one engine for every screen: `app/finance-engine.js`)

| Record | Cash impact |
|---|---|
| Pending income / pending daily earning | none |
| Received income / received daily earning | + amount |
| Outstanding debt | none — counted as a liability |
| Debt payment | − amount, and reduces the remaining debt |
| Unpaid bill | none |
| Paid bill / paid expense | − amount |
| Monthly budget | none — it is a limit |
| Spending recorded with **+ Pay** on a budget | − amount |
| Planned savings | none |
| Active savings | counted in assets (− cash only if you tick "moved from my cash balance") |

- **Cash Now** = opening cash + income received − expenses paid − bills paid − debt payments − savings moved from cash.
- **Net Worth** = cash now + active savings − remaining debt.
- **Expected** = cash now + pending income − unpaid bills − instalments still due.
- **Budget remaining** = budget − actual spending.
- **Opening cash** of a month = the closing cash of the month before (set your starting
  cash in *Edit Profile & Monthly Goal*).

Note: the brief's formula has no line for savings. When savings are activated from
cash, that money is moved out of cash; otherwise it would be counted twice (once as
cash, once as savings).

## How completing works

Completing a pending/planned item never edits it. The original is kept (shown as
*Completed*) and a separate, linked transaction is created on the date you choose:
Pending income → Received income, pending daily earning → received earning, unpaid bill
→ paid expense, instalment → debt payment, planned savings → active savings. Every
completion has a reference, so the same item can't be completed twice. Deleting the
actual transaction re-opens the original.

- **Recurring** entries are templates. They create one scheduled entry per month
  (unpaid bill, pending income, instalment or planned savings) and never create two for
  the same month. Deleting a generated month stops it from coming back.
- **Debts** keep the original amount, remaining amount, partial/full payments, payment
  history and an Outstanding / Partial / Paid status. Overpaying is blocked.
- **Budgets** (Expenses tab) show Budget, Spent, Remaining and progress with a **+ Pay**
  button. A budget can be for one month or repeat every month.
- **Daily earnings** support several entries per day, Pending/Received, and day, week
  and month totals. Days without entries show RM0.

## Data upgrade (your existing entries)

On first launch the old data is copied as-is to a safety backup
(`payflow_backup_v1_…`, downloadable from Settings → *Download Safety Backup*), then
upgraded. Nothing is deleted. Duplicate IDs get a new ID instead of being dropped.

| Old entry | Becomes |
|---|---|
| Income Active / Pending | Received / Pending |
| Expense Active / Pending | Paid / Unpaid bill |
| Savings Active / Pending | Active asset (not taken from cash) / Planned |
| Daily earning | Received (the old app counted every entry as earned) |
| Any Recurring | Recurring template that starts this month |
| Debt Active or Pending | Outstanding debt — **flagged "to check"** |
| Debt Recurring | Recurring instalment — **flagged "to check"** |

Past months were **not** back-filled from Recurring templates, because the old data
can't say whether those months were paid. Debt entries were ambiguous (debt or
payment?), so they are kept as outstanding debts with no cash impact. The bell icon lists
them until you open and save each one. Upgrading twice changes nothing.

## Files changed

- `app/finance-engine.js` — new. All calculations, migration and duplicate prevention.
- `app/index.html` — screens now use the engine. New: cash summary row, budgets panel,
  pay/receive window, debt history, daily earning status, import/safety backup.
  Date pickers replace month pickers so transactions keep their real dates.
- `app/styles.css` — rebuilt with `npm run build:css`.
- `tests/finance-engine.test.js` — new. 15 checks.
- `package.json` — version 1.1.0, `npm test` script. `README.md` — updated.

## Test results

`npm test` → 15/15 pass: pending vs received income; unpaid vs paid bills; debt
creation, partial and full repayment, overpay blocked; budgets and + Pay; repeating
budgets; recurring bill generation without duplicates; irregular daily earnings
(several per day, pending/received, empty days 0, week/month totals); no double counting
of daily vs monthly income; savings activation; monthly rollover; net worth matching the
dashboard; instalments linked to a debt; deleting re-opens the original; old-data
upgrade; linked entries can't change type.

The screens were also tested in a browser: receive, pay, + Pay, debt payment, savings
activation, adding a recurring bill, moving to the next month, reloading, and opening
data saved by the old version.

## v1.3.1 — Page titles & layout
- Page titles: **Income & Daily Earnings**, **Expenses, Bills & Budgets**, **Savings & Assets**, **Debt & Liabilities**, each followed by a small month label (e.g. "Nov 2026").
- Expenses page: Monthly Budgets now sits above the quick-add row.
- Dashboard Accounts & Flow tiles use short names: Income, Savings, Debt, Expenses.
- No calculation changes.
