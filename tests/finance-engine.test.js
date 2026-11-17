// Run with: npm test   (uses Node's built-in test runner, no extra installs)
// Every test builds its own in-memory data, so real saved data is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const FE = require('../app/finance-engine.js');

const TODAY = '2026-11-17';
const NOV = '2026-11';
const DEC = '2026-12';

function freshState(extra) {
  return { schemaVersion: 2, openingBalance: 1000, records: [], dailyEarnings: [], ...(extra || {}) };
}
const add = (s, r) => {
  const res = FE.addRecord(s, r);
  assert.ok(res.ok, res.error);
  return res.record;
};

test('pending income does not change cash or net worth; receiving it does, once', () => {
  const s = freshState();
  const p = add(s, { kind: 'income', status: 'Pending', name: 'Bonus', amount: 500, date: '2026-11-10' });
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 1000);
  assert.equal(m.netWorth, 1000);
  assert.equal(m.pendingIncome, 500);
  assert.equal(m.expectedCash, 1500);

  const r = FE.settleRecord(s, p.id, { date: '2026-11-12' });
  assert.ok(r.ok);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 1500);
  assert.equal(m.netWorth, 1500);
  assert.equal(m.pendingIncome, 0);
  // original preserved as history and linked
  const original = FE.findRecord(s, p.id);
  assert.equal(original.status, 'Completed');
  assert.equal(original.settledTxId, r.tx.id);
  assert.equal(r.tx.sourceId, p.id);
  // duplicate prevention
  assert.equal(FE.settleRecord(s, p.id, { date: '2026-11-12' }).ok, false);
  assert.equal(FE.computeMonthMetrics(s, NOV).actualCash, 1500);
});

test('unpaid bill does not deduct cash; paying deducts exactly once', () => {
  const s = freshState();
  const bill = add(s, { kind: 'bill', status: 'Unpaid', name: 'Electric', amount: 120, date: '2026-11-20' });
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 1000);
  assert.equal(m.unpaidBills, 120);
  assert.equal(m.expectedCash, 880);
  assert.ok(FE.settleRecord(s, bill.id, { date: '2026-11-21' }).ok);
  assert.equal(FE.settleRecord(s, bill.id, { date: '2026-11-21' }).ok, false);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 880);
  assert.equal(m.billsPaid, 120);
  assert.equal(m.unpaidBills, 0);
});

test('new debt is a liability without touching cash; partial and full repayment', () => {
  const s = freshState();
  const debt = add(s, { kind: 'debt', status: 'Outstanding', name: 'Laptop loan', amount: 900, date: '2026-11-02' });
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 1000);
  assert.equal(m.liabilities, 900);
  assert.equal(m.netWorth, 100);
  assert.equal(FE.findRecord(s, debt.id).status, 'Outstanding');

  assert.ok(FE.recordDebtPayment(s, debt.id, { amount: 300, date: '2026-11-15' }).ok);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 700);
  assert.equal(m.liabilities, 600);
  assert.equal(m.netWorth, 100); // paying debt moves money, net worth unchanged
  const info = FE.debtInfo(s, FE.findRecord(s, debt.id));
  assert.equal(info.principal, 900);
  assert.equal(info.remaining, 600);
  assert.equal(info.status, 'Partial');
  assert.equal(info.payments.length, 1);

  assert.equal(FE.recordDebtPayment(s, debt.id, { amount: 601, date: '2026-11-16' }).ok, false, 'cannot overpay');
  assert.ok(FE.recordDebtPayment(s, debt.id, { amount: 600, date: '2026-11-16' }).ok);
  assert.equal(FE.findRecord(s, debt.id).status, 'Paid');
  assert.equal(FE.computeMonthMetrics(s, NOV).actualCash, 100);
});

test('budgets are limits, not expenses; + Pay records real spending', () => {
  const s = freshState();
  const b = add(s, { kind: 'budget', status: 'Budget', name: 'Groceries', amount: 400, date: '2026-11-01' });
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 1000);
  assert.equal(m.budgets[0].spent, 0);
  assert.equal(m.budgets[0].remaining, 400);

  assert.ok(FE.recordBudgetSpend(s, b.id, { name: 'Market', amount: 150, date: '2026-11-05' }).ok);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.budgets[0].spent, 150);
  assert.equal(m.budgets[0].remaining, 250);
  assert.equal(m.budgets[0].pct, 38);
  assert.equal(m.actualCash, 850);
  assert.equal(m.expensesPaid, 150);
  assert.equal(FE.recordBudgetSpend(s, b.id, { amount: 10, date: '2026-12-01' }).ok, false, 'one-month budget');
});

test('recurring budget applies every month from its start', () => {
  const s = freshState();
  add(s, { kind: 'budget', status: 'Recurring', name: 'Fuel', amount: 200, date: '2026-10-01' });
  assert.equal(FE.computeMonthMetrics(s, '2026-09').budgets.length, 0);
  assert.equal(FE.computeMonthMetrics(s, DEC).budgets.length, 1);
});

test('recurring bill makes one unpaid bill per month, never duplicated, cash only on payment', () => {
  const s = freshState();
  const t = add(s, { kind: 'bill', status: 'Recurring', name: 'Rent', amount: 800, date: '2026-10-05' });
  assert.equal(FE.computeMonthMetrics(s, NOV).actualCash, 1000, 'template alone has no cash impact');
  assert.equal(FE.generateRecurring(s, NOV), 2);
  assert.equal(FE.generateRecurring(s, NOV), 0, 'second run adds nothing');
  assert.equal(FE.generateRecurring(s, DEC), 1);
  const inst = s.records.filter(r => r.templateId === t.id);
  assert.deepEqual(inst.map(r => r.period).sort(), ['2026-10', '2026-11', '2026-12']);
  assert.ok(inst.every(r => r.status === 'Unpaid'));
  const nov = inst.find(r => r.period === NOV);
  assert.equal(nov.date, '2026-11-05');
  assert.equal(FE.computeMonthMetrics(s, NOV).unpaidBills, 800);

  assert.ok(FE.settleRecord(s, nov.id, { date: '2026-11-05' }).ok);
  assert.equal(FE.computeMonthMetrics(s, NOV).actualCash, 200);
  // deleting a generated month stops it from coming back
  const dec = inst.find(r => r.period === DEC);
  FE.deleteRecord(s, dec.id);
  assert.equal(FE.generateRecurring(s, DEC), 0);
});

test('irregular daily earnings: multiple per day, pending vs received, empty days are 0', () => {
  const s = freshState();
  FE.addDailyEarning(s, { date: '2026-11-02', amount: 100, note: 'A', status: 'Received' });
  FE.addDailyEarning(s, { date: '2026-11-02', amount: 50, note: 'B', status: 'Received' });
  const p = FE.addDailyEarning(s, { date: '2026-11-04', amount: 70, note: 'C', status: 'Pending' }).entry;
  FE.addDailyEarning(s, { date: '2026-11-20', amount: 30, note: 'D', status: 'Received' });

  const days = FE.dailyTotalsByDay(s, NOV);
  assert.equal(days['2026-11-02'].received, 150);
  assert.equal(days['2026-11-03'].received, 0);
  assert.equal(days['2026-11-04'].pending, 70);

  let sum = FE.dailySummary(s, '2026-11-04'); // week Mon 2 – Sun 8
  assert.equal(sum.weekTotal, 150);
  assert.equal(sum.weekPending, 70);
  assert.equal(sum.monthTotal, 180);
  assert.equal(sum.activeDays, 2);

  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.dailyReceived, 180);
  assert.equal(m.actualCash, 1180);

  assert.ok(FE.receiveDailyEarning(s, p.id, { date: '2026-11-06' }).ok);
  assert.equal(FE.receiveDailyEarning(s, p.id).ok, false);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.dailyReceived, 250);
  assert.equal(m.actualCash, 1250);
  assert.equal(s.dailyEarnings.find(e => e.id === p.id).status, 'Completed');
});

test('daily earnings and monthly income are counted once each', () => {
  const s = freshState({ openingBalance: 0 });
  add(s, { kind: 'income', status: 'Received', name: 'Salary', amount: 3000, date: '2026-11-01' });
  FE.addDailyEarning(s, { date: '2026-11-03', amount: 200, status: 'Received' });
  const m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.totalIncomeReceived, 3200);
  assert.equal(m.actualCash, 3200);
});

test('activating planned savings creates a linked asset; moving from cash keeps net worth equal', () => {
  const s = freshState();
  const plan = add(s, { kind: 'savings', status: 'Planned', name: 'Emergency', amount: 300, date: '2026-11-08' });
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.savingsAssets, 0);
  assert.equal(m.netWorth, 1000);
  const r = FE.settleRecord(s, plan.id, { date: '2026-11-09', fromCash: true });
  assert.ok(r.ok);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.savingsAssets, 300);
  assert.equal(m.actualCash, 700);
  assert.equal(m.netWorth, 1000);
  // an existing account added as Active (not from cash) raises assets only
  add(s, { kind: 'savings', status: 'Active', name: 'Old ASB', amount: 2000, date: '2026-11-01', fromCash: false });
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 700);
  assert.equal(m.netWorth, 3000);
});

test('monthly rollover: closing cash becomes next opening; pending stays separate', () => {
  const s = freshState({ openingBalance: 500 });
  add(s, { kind: 'income', status: 'Received', name: 'Pay', amount: 2000, date: '2026-11-01' });
  add(s, { kind: 'expense', status: 'Paid', name: 'Food', amount: 300, date: '2026-11-30' });
  add(s, { kind: 'income', status: 'Pending', name: 'Invoice', amount: 999, date: '2026-11-25' });
  add(s, { kind: 'bill', status: 'Unpaid', name: 'Phone', amount: 50, date: '2026-11-28' });
  FE.addDailyEarning(s, { date: '2026-12-01', amount: 40, status: 'Received' });

  const nov = FE.computeMonthMetrics(s, NOV);
  const dec = FE.computeMonthMetrics(s, DEC);
  assert.equal(nov.openingCash, 500);
  assert.equal(nov.closingCash, 2200);
  assert.equal(dec.openingCash, nov.closingCash);
  assert.equal(dec.closingCash, 2240);
  assert.equal(dec.pendingIncome, 0);
  assert.equal(dec.dailyReceived, 40);
  assert.equal(FE.computeMonthMetrics(s, '2026-10').closingCash, 500);
});

test('net worth and dashboard figures agree', () => {
  const s = freshState({ openingBalance: 2000 });
  add(s, { kind: 'income', status: 'Received', name: 'Pay', amount: 1000, date: '2026-11-01' });
  add(s, { kind: 'savings', status: 'Active', name: 'FD', amount: 5000, date: '2026-10-01', fromCash: false });
  const d = add(s, { kind: 'debt', status: 'Outstanding', name: 'Card', amount: 1500, date: '2026-11-03' });
  FE.recordDebtPayment(s, d.id, { amount: 500, date: '2026-11-10' });
  const m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 2500);
  assert.equal(m.totalAssets, 7500);
  assert.equal(m.liabilities, 1000);
  assert.equal(m.netWorth, m.totalAssets - m.liabilities);
  assert.equal(m.netWorth, 6500);
});

test('scheduled debt payment linked to a debt reduces principal once', () => {
  const s = freshState();
  const debt = add(s, { kind: 'debt', status: 'Outstanding', name: 'Car', amount: 1000, date: '2026-10-01' });
  add(s, { kind: 'debt_payment', status: 'Recurring', name: 'Car instalment', amount: 250, date: '2026-11-15', debtId: debt.id });
  FE.generateRecurring(s, NOV);
  const inst = s.records.find(r => r.templateId && r.period === NOV);
  let m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.expectedDebtPayments, 250);
  assert.equal(m.actualCash, 1000);
  assert.ok(FE.settleRecord(s, inst.id).ok);
  m = FE.computeMonthMetrics(s, NOV);
  assert.equal(m.actualCash, 750);
  assert.equal(m.liabilities, 750);
  assert.equal(FE.findRecord(s, debt.id).status, 'Partial');
});

test('deleting an actual transaction re-opens its original instead of losing it', () => {
  const s = freshState();
  const p = add(s, { kind: 'income', status: 'Pending', name: 'Gig', amount: 80, date: '2026-11-03' });
  const { tx } = FE.settleRecord(s, p.id, {});
  FE.deleteRecord(s, tx.id);
  assert.equal(FE.findRecord(s, p.id).status, 'Pending');
  assert.equal(FE.computeMonthMetrics(s, NOV).actualCash, 1000);
});

test('migration from the original format: backed-up meaning, no cash guesses, no duplicates', () => {
  const v1 = {
    userName: 'Alex', currency: 'MYR', activeMonth: NOV,
    records: [
      { id: 'a', category: 'income', name: 'Salary', amount: 5000, month: '2026-06', date: '2026-11-01', status: 'Recurring' },
      { id: 'b', category: 'income', name: 'Retainer', amount: 1000, month: NOV, date: '2026-11-10', status: 'Active' },
      { id: 'c', category: 'income', name: 'Bonus', amount: 300, month: NOV, date: '2026-11-16', status: 'Pending' },
      { id: 'd', category: 'debt', name: 'Gear', amount: 1800, month: NOV, date: '2026-11-13', status: 'Active' },
      { id: 'e', category: 'expenses', name: 'Groceries', amount: 200, month: NOV, date: '2026-11-14', status: 'Active' },
      { id: 'f', category: 'expenses', name: 'Flight', amount: 400, month: NOV, date: '2026-11-16', status: 'Pending' },
      { id: 'g', category: 'savings', name: 'Vault', amount: 9000, month: NOV, date: '2026-11-03', status: 'Active' },
      { id: 'h', category: 'savings', name: 'Top-up', amount: 100, month: NOV, date: '2026-11-12', status: 'Pending' },
      { id: 'b', category: 'income', name: 'Dup id', amount: 1, month: NOV, date: '2026-11-11', status: 'Active' }
    ],
    dailyEarnings: [{ id: 'x', date: '2026-11-02', amount: 150, note: 'Sale' }]
  };
  const { state: s, migrated } = FE.normalizeState(JSON.parse(JSON.stringify(v1)), { today: TODAY });
  assert.ok(migrated);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.records.length, 9, 'nothing dropped');
  assert.equal(new Set(s.records.map(r => r.id)).size, 9, 'duplicate ids made unique');
  const by = id => s.records.find(r => r.id === id);
  assert.equal(by('a').status, 'Recurring');
  assert.equal(by('a').generateFrom, NOV, 'no back-filling of unknown past months');
  assert.equal(by('b').status, 'Received');
  assert.equal(by('c').status, 'Pending');
  assert.equal(by('d').kind, 'debt');
  assert.equal(by('d').status, 'Outstanding');
  assert.equal(by('d').needsReview, true);
  assert.equal(by('f').status, 'Unpaid');
  assert.equal(by('h').status, 'Planned');
  assert.equal(s.dailyEarnings[0].status, 'Received');

  FE.generateRecurring(s, NOV);
  const m = FE.computeMonthMetrics(s, NOV);
  // cash = retainer 1000 + dup 1 + daily 150 - groceries 200 ; debt NOT deducted, pending NOT added
  assert.equal(m.actualCash, 951);
  assert.equal(m.liabilities, 1800);
  assert.equal(m.savingsAssets, 9000);
  assert.equal(m.pendingIncome, 5300); // bonus + generated November salary
  assert.equal(m.unpaidBills, 400);
  assert.equal(m.netWorth, 951 + 9000 - 1800);

  // running normalize again changes nothing
  const again = FE.normalizeState(JSON.parse(JSON.stringify(s)), { today: TODAY });
  assert.equal(again.migrated, false);
  assert.equal(again.state.records.length, s.records.length);
});

test('linked records cannot change type; plain ones can', () => {
  const s = freshState();
  const p = add(s, { kind: 'income', status: 'Pending', name: 'Gig', amount: 80, date: '2026-11-03' });
  FE.settleRecord(s, p.id, {});
  const res = FE.updateRecord(s, p.id, { name: 'Gig', amount: 80, date: '2026-11-03', kind: 'income', status: 'Received' });
  assert.equal(res.ok, false);
  const q = add(s, { kind: 'income', status: 'Pending', name: 'Other', amount: 10, date: '2026-11-03' });
  assert.ok(FE.updateRecord(s, q.id, { name: 'Other', amount: 10, date: '2026-11-03', kind: 'income', status: 'Received' }).ok);
});

// ---------------------------------------------------------------------------
// v1.2 — simpler dashboard rules (the "5 weird things" review)
// ---------------------------------------------------------------------------
function reviewState() {
  const s = freshState({ openingBalance: 0 });
  add(s, { kind: 'income', status: 'Received', name: 'Maybank Savings Account', amount: 50, date: '2026-11-17' });
  add(s, { kind: 'income', status: 'Recurring', name: 'Reasearch Engineer', amount: 2450, date: '2026-11-25' });
  add(s, { kind: 'bill', status: 'Recurring', name: 'House Rental', amount: 150, date: '2026-11-05' });
  add(s, { kind: 'savings', status: 'Active', name: 'Luno', amount: 1515, date: '2026-11-01', fromCash: false });
  add(s, { kind: 'savings', status: 'Active', name: 'ASB', amount: 2500.43, date: '2026-11-01', fromCash: false });
  add(s, { kind: 'debt', status: 'Outstanding', name: 'Atome Pay Later', amount: 36.59, date: '2026-11-01' });
  add(s, { kind: 'debt', status: 'Outstanding', name: 'Atome Pay Later', amount: 106.4, date: '2026-11-02' });
  FE.generateRecurring(s, NOV);
  return s;
}

test('cash flow list shows one row per paycheck/bill — no recurring rules, no balances', () => {
  const s = reviewState();
  const names = FE.cashFlowRecords(s, NOV).map(r => r.name).sort();
  assert.deepEqual(names, ['House Rental', 'Maybank Savings Account', 'Reasearch Engineer']);
  assert.equal(FE.recurringRules(s, NOV).length, 2);
  const acc = FE.accountBalances(s, NOV);
  assert.equal(acc.savingsTotal, 4015.43);
  assert.equal(acc.debtTotal, 142.99);
});

test('receiving a recurring paycheck still leaves exactly one row for it', () => {
  const s = reviewState();
  const pending = FE.cashFlowRecords(s, NOV).find(r => r.name === 'Reasearch Engineer');
  assert.ok(FE.settleRecord(s, pending.id, { date: '2026-11-25' }).ok);
  const rows = FE.cashFlowRecords(s, NOV).filter(r => r.name === 'Reasearch Engineer');
  assert.equal(rows.length, 1);
  assert.equal(FE.simpleStatus(s, rows[0]), 'Completed');
});

test('three formulas: cash 50, forecast 2,350, net worth 3,922.44', () => {
  const m = FE.computeMonthMetrics(reviewState(), NOV);
  assert.equal(m.actualCash, 50);
  assert.equal(m.expectedCash, 2350); // 50 + 2,450 pending - 150 unpaid
  assert.equal(m.netWorth, 3922.44); // 50 + 4,015.43 - 142.99
});

test('a balance logged as income can become opening cash without changing cash', () => {
  const s = reviewState();
  const mb = s.records.find(r => r.name === 'Maybank Savings Account');
  assert.ok(FE.moveIncomeToOpeningBalance(s, mb.id).ok);
  const m = FE.computeMonthMetrics(s, NOV);
  assert.equal(s.openingBalance, 50);
  assert.equal(m.actualCash, 50);
  assert.equal(m.totalIncomeReceived, 0);
  const recurringPay = s.records.find(r => r.templateId);
  assert.equal(FE.moveIncomeToOpeningBalance(s, recurringPay.id).ok, false);
});

test('only three status words: Pending, Completed, Scheduled', () => {
  const s = reviewState();
  const words = new Set(s.records.map(r => FE.simpleStatus(s, r)));
  assert.deepEqual([...words].sort(), ['Completed', 'Pending', 'Scheduled']);
  const rule = FE.recurringRules(s, NOV)[0];
  assert.equal(FE.simpleStatus(s, rule), 'Scheduled');
});

test('goal progress is never rounded up', () => {
  assert.equal(FE.goalProgress(50, 10000).label, '0.5%');
  assert.equal(FE.goalProgress(4015.43, 10000).label, '40%');
  assert.equal(FE.goalProgress(12000, 10000).label, '100%');
});
