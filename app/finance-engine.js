/*
 * Pay. — Central financial calculation engine.
 *
 * Every number the app shows (dashboard, cards, tabs, calendar, analytics,
 * notifications) is computed here, so all views always agree.
 *
 * Works in the browser (window.FinanceEngine) and in Node (require) for tests.
 *
 * Accounting rules
 * ----------------
 *  Record                  Cash impact
 *  Pending income          none
 *  Received income         + amount
 *  Outstanding debt        none (counted as a liability)
 *  Debt payment (Paid)     - amount (and reduces remaining principal)
 *  Unpaid bill / expense   none
 *  Paid bill / expense     - amount
 *  Monthly budget          none (a limit, never an expense)
 *  Planned savings         none
 *  Active savings asset    counted in assets; - amount only when moved from cash
 *  Recurring template      none (generates one scheduled record per month)
 *  Completed original      none (its linked actual transaction carries the impact)
 *
 * Three formulas drive the dashboard:
 *  Cash Balance  = Opening Cash + Completed Income - Completed Expenses
 *  Forecast Cash = Cash Balance + Pending Income - Pending Bills
 *  Net Worth     = Cash Balance + Savings/Investments - Remaining Debt
 *
 * Only three status words are shown to the user (see simpleStatus):
 *  Pending   - not yet received or paid (no effect on cash)
 *  Completed - money actually moved (updates cash)
 *  Scheduled - repeats monthly (a background rule)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinanceEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const MAX_GENERATED_MONTHS = 240;

  const KIND = {
    INCOME: 'income',
    EXPENSE: 'expense',
    BILL: 'bill',
    BUDGET: 'budget',
    DEBT: 'debt',
    DEBT_PAYMENT: 'debt_payment',
    SAVINGS: 'savings'
  };

  const CATEGORY_OF_KIND = {
    income: 'income',
    expense: 'expenses',
    bill: 'expenses',
    budget: 'expenses',
    debt: 'debt',
    debt_payment: 'debt',
    savings: 'savings'
  };

  // Scheduled ("open") status per kind and the status of its completed actual transaction.
  const SETTLE_RULES = {
    income: { open: 'Pending', done: 'Received' },
    expense: { open: 'Unpaid', done: 'Paid' },
    bill: { open: 'Unpaid', done: 'Paid' },
    debt_payment: { open: 'Unpaid', done: 'Paid' },
    savings: { open: 'Planned', done: 'Active' }
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const round2 = v => Math.round(num(v) * 100) / 100;
  const pad = n => String(n).padStart(2, '0');
  const isYm = s => /^\d{4}-\d{2}$/.test(String(s || ''));
  const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

  function localDateStr(d) {
    const dt = d || new Date();
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }
  function monthOf(date) {
    return String(date || '').slice(0, 7);
  }
  function addMonths(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function daysInMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }
  function endOfMonth(ym) {
    return `${ym}-${pad(daysInMonth(ym))}`;
  }
  function clampDay(ym, day) {
    return `${ym}-${pad(Math.max(1, Math.min(num(day) || 1, daysInMonth(ym))))}`;
  }
  function monthRange(from, to) {
    const out = [];
    let cur = from;
    while (cur <= to && out.length < MAX_GENERATED_MONTHS) {
      out.push(cur);
      cur = addMonths(cur, 1);
    }
    return out;
  }
  function weekRange(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const offset = (dt.getDay() + 6) % 7; // Monday = 0
    const mon = new Date(y, m - 1, d - offset);
    const sun = new Date(y, m - 1, d - offset + 6);
    return { start: localDateStr(mon), end: localDateStr(sun) };
  }
  let idSeq = 0;
  function newId(prefix) {
    idSeq += 1;
    return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  const sum = (list, fn) => round2(list.reduce((s, x) => s + num(fn ? fn(x) : x), 0));

  // ---------------------------------------------------------------------------
  // Record classification
  // ---------------------------------------------------------------------------
  const isTemplate = r => r && r.status === 'Recurring';
  const recordDate = r => (isYmd(r.date) ? r.date : `${isYm(r.month) ? r.month : '2000-01'}-01`);
  const startMonthOf = r => r.generateFrom || r.month || monthOf(recordDate(r));

  function openStatusFor(kind) {
    return SETTLE_RULES[kind] ? SETTLE_RULES[kind].open : null;
  }

  /** Signed effect of one record on actual cash. */
  function cashDelta(r) {
    if (!r || isTemplate(r) || r.status === 'Completed') return 0;
    const amt = round2(r.amount);
    switch (r.kind) {
      case KIND.INCOME:
        return r.status === 'Received' ? amt : 0;
      case KIND.EXPENSE:
      case KIND.BILL:
      case KIND.DEBT_PAYMENT:
        return r.status === 'Paid' ? -amt : 0;
      case KIND.SAVINGS:
        return r.status === 'Active' && r.fromCash ? -amt : 0;
      default:
        return 0; // debt liabilities, budgets, unknown legacy records
    }
  }
  function dailyCashDelta(d) {
    return d && d.status === 'Received' ? round2(d.amount) : 0;
  }

  /** Broad group used by the All / Actual / Pending / Recurring filters. */
  function statusGroup(r) {
    if (!r) return 'other';
    if (r.status === 'Recurring') return 'recurring';
    if (r.status === 'Completed') return 'done';
    if (r.kind === KIND.BUDGET) return 'recurring';
    if (r.kind === KIND.DEBT) return r.status === 'Paid' ? 'done' : 'pending';
    if (r.status === 'Received' || r.status === 'Paid' || r.status === 'Active') return 'actual';
    if (r.status === 'Pending' || r.status === 'Unpaid' || r.status === 'Planned') return 'pending';
    return 'other';
  }

  function budgetAppliesTo(b, ym) {
    if (!b || b.kind !== KIND.BUDGET) return false;
    if (b.status === 'Recurring') return startMonthOf(b) <= ym && (!b.endMonth || ym <= b.endMonth);
    return (b.month || monthOf(b.date)) === ym;
  }

  function findRecord(state, id) {
    return state.records.find(r => r.id === id) || null;
  }

  // ---------------------------------------------------------------------------
  // Debts
  // ---------------------------------------------------------------------------
  function debtPayments(state, debtId, asOf) {
    const limit = asOf || '9999-12-31';
    return state.records
      .filter(r => r.kind === KIND.DEBT_PAYMENT && r.status === 'Paid' && r.debtId === debtId && recordDate(r) <= limit)
      .sort((a, b) => recordDate(b).localeCompare(recordDate(a)));
  }

  function debtInfo(state, debt, asOf) {
    const principal = round2(debt.principal != null ? debt.principal : debt.amount);
    const payments = debtPayments(state, debt.id, asOf);
    const paid = sum(payments, p => p.amount);
    const remaining = Math.max(0, round2(principal - paid));
    const status = remaining <= 0.004 ? 'Paid' : paid > 0 ? 'Partial' : 'Outstanding';
    return { debt, principal, paid, remaining, status, payments };
  }

  function syncDebtStatuses(state) {
    state.records.forEach(r => {
      if (r.kind !== KIND.DEBT || isTemplate(r)) return;
      if (r.principal == null) r.principal = round2(r.amount);
      r.amount = round2(r.principal);
      r.status = debtInfo(state, r).status;
    });
  }

  // ---------------------------------------------------------------------------
  // Monthly metrics — the single source of truth for every view.
  // ---------------------------------------------------------------------------
  function computeMonthMetrics(state, ym) {
    const start = `${ym}-01`;
    const end = endOfMonth(ym);
    const records = state.records || [];
    const daily = state.dailyEarnings || [];

    let before = 0;
    const t = {
      incomeReceived: 0,
      dailyReceived: 0,
      expensesPaid: 0,
      billsPaid: 0,
      debtPayments: 0,
      savingsTransfers: 0,
      pendingIncome: 0,
      dailyPending: 0,
      unpaidBills: 0,
      expectedDebtPayments: 0,
      plannedSavings: 0
    };
    let savingsAssets = 0;
    let activeSavingsCount = 0;

    for (const r of records) {
      if (isTemplate(r)) continue;
      const d = recordDate(r);
      const delta = cashDelta(r);
      if (delta && d < start) before += delta;

      if (r.kind === KIND.SAVINGS && r.status === 'Active' && d <= end) {
        savingsAssets += num(r.amount);
        activeSavingsCount += 1;
      }
      if (d < start || d > end || r.status === 'Completed') continue;

      const amt = num(r.amount);
      if (r.kind === KIND.INCOME) {
        if (r.status === 'Received') t.incomeReceived += amt;
        else if (r.status === 'Pending') t.pendingIncome += amt;
      } else if (r.kind === KIND.EXPENSE || r.kind === KIND.BILL) {
        if (r.status === 'Paid') t[r.kind === KIND.BILL ? 'billsPaid' : 'expensesPaid'] += amt;
        else if (r.status === 'Unpaid') t.unpaidBills += amt;
      } else if (r.kind === KIND.DEBT_PAYMENT) {
        if (r.status === 'Paid') t.debtPayments += amt;
        else if (r.status === 'Unpaid') t.expectedDebtPayments += amt;
      } else if (r.kind === KIND.SAVINGS) {
        if (r.status === 'Active' && r.fromCash) t.savingsTransfers += amt;
        else if (r.status === 'Planned') t.plannedSavings += amt;
      }
    }

    const monthDailyEntries = [];
    for (const e of daily) {
      const d = e.date || '';
      const delta = dailyCashDelta(e);
      if (delta && d < start) before += delta;
      if (d >= start && d <= end) {
        monthDailyEntries.push(e);
        if (e.status === 'Received') t.dailyReceived += num(e.amount);
        else if (e.status === 'Pending') t.dailyPending += num(e.amount);
      }
    }

    Object.keys(t).forEach(k => (t[k] = round2(t[k])));

    const openingCash = round2(num(state.openingBalance) + before);
    const totalIncomeReceived = round2(t.incomeReceived + t.dailyReceived);
    const spentPaid = round2(t.expensesPaid + t.billsPaid);
    const outflow = round2(spentPaid + t.debtPayments);
    const closingCash = round2(openingCash + totalIncomeReceived - outflow - t.savingsTransfers);

    const debts = records
      .filter(r => r.kind === KIND.DEBT && !isTemplate(r) && recordDate(r) <= end)
      .map(r => debtInfo(state, r, end));
    const liabilities = sum(debts, x => x.remaining);
    savingsAssets = round2(savingsAssets);

    const budgets = records
      .filter(r => budgetAppliesTo(r, ym))
      .map(b => {
        const spends = records.filter(
          x => x.kind === KIND.EXPENSE && x.status === 'Paid' && x.budgetId === b.id && recordDate(x) >= start && recordDate(x) <= end
        );
        const limit = round2(b.amount);
        const spent = sum(spends, x => x.amount);
        return {
          budget: b,
          limit,
          spent,
          remaining: round2(limit - spent),
          pct: limit > 0 ? Math.round((spent / limit) * 100) : 0,
          spends
        };
      });

    return {
      ym,
      ...t,
      openingCash,
      totalIncomeReceived,
      spentPaid,
      outflow,
      closingCash,
      actualCash: closingCash,
      netCashFlow: round2(closingCash - openingCash),
      savedThisMonth: Math.max(0, round2(totalIncomeReceived - outflow)),
      expectedCash: round2(closingCash + t.pendingIncome + t.dailyPending - t.unpaidBills - t.expectedDebtPayments),
      savingsAssets,
      activeSavingsCount,
      totalAssets: round2(closingCash + savingsAssets),
      liabilities,
      netWorth: round2(closingCash + savingsAssets - liabilities),
      debts,
      openDebts: debts.filter(x => x.remaining > 0),
      budgets,
      budgetLimitTotal: sum(budgets, x => x.limit),
      budgetSpentTotal: sum(budgets, x => x.spent),
      budgetRemainingTotal: sum(budgets, x => x.remaining),
      monthDailyEntries
    };
  }

  /** Records shown in month lists (budgets live in their own panel). */
  function monthRecords(state, ym) {
    const end = endOfMonth(ym);
    return state.records.filter(r => {
      if (r.kind === KIND.BUDGET) return false;
      if (isTemplate(r)) return startMonthOf(r) <= ym && (!r.endMonth || ym <= r.endMonth);
      return monthOf(recordDate(r)) === ym || (r.kind === KIND.DEBT && recordDate(r) <= end && debtInfo(state, r, end).remaining > 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Daily earnings
  // ---------------------------------------------------------------------------
  function dailySummary(state, date) {
    const entries = state.dailyEarnings || [];
    const wk = weekRange(date);
    const ym = monthOf(date);
    const received = e => e.status === 'Received';
    const pending = e => e.status === 'Pending';
    const onDay = entries.filter(e => e.date === date);
    const inWeek = entries.filter(e => e.date >= wk.start && e.date <= wk.end);
    const inMonth = entries.filter(e => monthOf(e.date) === ym);
    return {
      date,
      week: wk,
      day: sum(onDay.filter(received), e => e.amount),
      dayPending: sum(onDay.filter(pending), e => e.amount),
      weekTotal: sum(inWeek.filter(received), e => e.amount),
      weekPending: sum(inWeek.filter(pending), e => e.amount),
      monthTotal: sum(inMonth.filter(received), e => e.amount),
      monthPending: sum(inMonth.filter(pending), e => e.amount),
      activeDays: new Set(inMonth.filter(received).map(e => e.date)).size
    };
  }

  /** Per-day totals for a month. Days without entries are simply 0. */
  function dailyTotalsByDay(state, ym) {
    const map = {};
    for (let d = 1; d <= daysInMonth(ym); d++) map[`${ym}-${pad(d)}`] = { received: 0, pending: 0 };
    (state.dailyEarnings || []).forEach(e => {
      const slot = map[e.date];
      if (!slot) return;
      if (e.status === 'Received') slot.received = round2(slot.received + num(e.amount));
      else if (e.status === 'Pending') slot.pending = round2(slot.pending + num(e.amount));
    });
    return map;
  }

  function addDailyEarning(state, { date, amount, note, status, time }) {
    const amt = round2(amount);
    if (!isYmd(date)) return { ok: false, error: 'Pick a valid date.' };
    if (!(amt > 0)) return { ok: false, error: 'Enter an amount above zero.' };
    const entry = {
      id: newId('de'),
      date,
      amount: amt,
      note: String(note || '').trim() || 'Daily Earning',
      time: time || '',
      status: status === 'Pending' ? 'Pending' : 'Received'
    };
    state.dailyEarnings.unshift(entry);
    return { ok: true, entry };
  }

  function receiveDailyEarning(state, id, opts) {
    const o = opts || {};
    const src = state.dailyEarnings.find(e => e.id === id);
    if (!src) return { ok: false, error: 'Entry not found.' };
    if (src.status !== 'Pending') return { ok: false, error: 'This earning is already received.' };
    const ref = `settle:${src.id}`;
    if (state.dailyEarnings.some(e => e.ref === ref)) return { ok: false, error: 'Already received.' };
    const date = isYmd(o.date) ? o.date : src.date;
    const amt = o.amount != null ? round2(o.amount) : round2(src.amount);
    if (!(amt > 0)) return { ok: false, error: 'Enter an amount above zero.' };
    const entry = {
      id: newId('de'),
      date,
      amount: amt,
      note: src.note,
      time: o.time || src.time || '',
      status: 'Received',
      sourceId: src.id,
      ref
    };
    state.dailyEarnings.unshift(entry);
    src.status = 'Completed';
    src.settledTxId = entry.id;
    src.completedAt = date;
    return { ok: true, entry };
  }

  function deleteDailyEarning(state, id) {
    const e = state.dailyEarnings.find(x => x.id === id);
    if (!e) return false;
    if (e.sourceId) {
      const src = state.dailyEarnings.find(x => x.id === e.sourceId);
      if (src && src.settledTxId === e.id) {
        src.status = 'Pending';
        delete src.settledTxId;
        delete src.completedAt;
      }
    }
    if (e.settledTxId) {
      const tx = state.dailyEarnings.find(x => x.id === e.settledTxId);
      if (tx) tx.sourceNote = e.note;
    }
    state.dailyEarnings = state.dailyEarnings.filter(x => x.id !== id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Recurring templates -> one scheduled record per period (idempotent)
  // ---------------------------------------------------------------------------
  function generateRecurring(state, uptoYm) {
    if (!isYm(uptoYm)) return 0;
    let added = 0;
    const templates = state.records.filter(r => isTemplate(r) && r.kind !== KIND.BUDGET && openStatusFor(r.kind));
    for (const t of templates) {
      const start = startMonthOf(t);
      const end = t.endMonth && t.endMonth < uptoYm ? t.endMonth : uptoYm;
      if (!isYm(start) || start > end) continue;
      const day = Number(String(t.date || '').slice(8, 10)) || 1;
      const existing = new Set(state.records.filter(r => r.templateId === t.id).map(r => r.period));
      const skipped = new Set(t.skippedPeriods || []);
      for (const ym of monthRange(start, end)) {
        if (existing.has(ym) || skipped.has(ym)) continue;
        const id = `${t.id}__${ym}`;
        if (state.records.some(r => r.id === id)) continue;
        const rec = {
          id,
          category: CATEGORY_OF_KIND[t.kind],
          kind: t.kind,
          name: t.name,
          amount: round2(t.amount),
          date: clampDay(ym, day),
          month: ym,
          status: openStatusFor(t.kind),
          templateId: t.id,
          period: ym
        };
        if (t.debtId) rec.debtId = t.debtId;
        if (t.kind === KIND.SAVINGS) rec.fromCash = t.fromCash !== false;
        state.records.push(rec);
        existing.add(ym);
        added += 1;
      }
    }
    return added;
  }

  /** After editing a template, refresh its still-open instances from fromYm onwards. */
  function syncTemplateInstances(state, templateId, fromYm) {
    const t = findRecord(state, templateId);
    if (!t) return 0;
    let n = 0;
    state.records.forEach(r => {
      if (r.templateId !== templateId || r.status !== openStatusFor(r.kind) || (fromYm && r.period < fromYm)) return;
      r.name = t.name;
      r.amount = round2(t.amount);
      const day = Number(String(t.date || '').slice(8, 10)) || 1;
      r.date = clampDay(r.period, day);
      if (t.debtId) r.debtId = t.debtId;
      n += 1;
    });
    return n;
  }

  // ---------------------------------------------------------------------------
  // Adding / editing / settling / deleting records
  // ---------------------------------------------------------------------------
  function validateAmountDate(amount, date) {
    const amt = round2(amount);
    if (!(amt > 0)) return { error: 'Enter an amount above zero.' };
    if (!isYmd(date)) return { error: 'Pick a valid date.' };
    return { amt };
  }

  function addRecord(state, input) {
    const { kind, status, name } = input;
    if (!CATEGORY_OF_KIND[kind]) return { ok: false, error: 'Unknown entry type.' };
    if (!String(name || '').trim()) return { ok: false, error: 'Enter a title.' };
    const v = validateAmountDate(input.amount, input.date);
    if (v.error) return { ok: false, error: v.error };
    const rec = {
      id: newId('rec'),
      category: CATEGORY_OF_KIND[kind],
      kind,
      name: String(name).trim(),
      amount: v.amt,
      date: input.date,
      month: monthOf(input.date),
      status
    };
    if (kind === KIND.DEBT) {
      rec.principal = v.amt;
      rec.status = 'Outstanding';
    }
    if (kind === KIND.SAVINGS && status !== 'Recurring') rec.fromCash = !!input.fromCash;
    if (kind === KIND.SAVINGS && status === 'Recurring') rec.fromCash = input.fromCash !== false;
    if (input.budgetId) rec.budgetId = input.budgetId;
    if (kind === KIND.DEBT_PAYMENT && input.debtId) {
      const debt = findRecord(state, input.debtId);
      if (!debt || debt.kind !== KIND.DEBT) return { ok: false, error: 'Linked debt not found.' };
      rec.debtId = debt.id;
      if (status === 'Paid') {
        const info = debtInfo(state, debt);
        if (v.amt > info.remaining + 0.004) return { ok: false, error: `Payment is more than the remaining ${info.remaining}.` };
      }
    }
    if (status === 'Recurring') rec.generateFrom = rec.month;
    state.records.unshift(rec);
    syncDebtStatuses(state);
    return { ok: true, record: rec };
  }

  /** Whether a record's type (category/kind/status) may be changed without breaking links. */
  function isTypeLocked(state, r) {
    if (!r) return true;
    if (r.status === 'Completed' || r.sourceId || r.settledTxId || r.templateId) return true;
    if (r.kind === KIND.DEBT && debtPayments(state, r.id).length) return true;
    if (r.kind === KIND.BUDGET && state.records.some(x => x.budgetId === r.id)) return true;
    if (isTemplate(r) && state.records.some(x => x.templateId === r.id)) return true;
    return false;
  }

  function updateRecord(state, id, patch) {
    const r = findRecord(state, id);
    if (!r) return { ok: false, error: 'Entry not found.' };
    if (!String(patch.name || '').trim()) return { ok: false, error: 'Enter a title.' };
    const v = validateAmountDate(patch.amount, patch.date);
    if (v.error) return { ok: false, error: v.error };
    const sameKind = !patch.kind || patch.kind === r.kind;
    const statusChange = !!patch.status && patch.status !== r.status;
    // Debt status is derived from payments; a budget may switch between one month and every month.
    const benign = sameKind && (r.kind === KIND.DEBT || (r.kind === KIND.BUDGET && (patch.status === 'Budget' || patch.status === 'Recurring')));
    const typeChanged = !sameKind || (statusChange && !benign);
    if (typeChanged && isTypeLocked(state, r)) {
      return { ok: false, error: 'This entry is linked to other records, so its type can’t change. Edit the title, amount or date instead.' };
    }
    if (r.kind === KIND.DEBT_PAYMENT && r.status === 'Paid' && r.debtId) {
      const debt = findRecord(state, r.debtId);
      if (debt) {
        const info = debtInfo(state, debt);
        if (v.amt - num(r.amount) > info.remaining + 0.004) return { ok: false, error: 'Payment would be more than the remaining debt.' };
      }
    }
    r.name = String(patch.name).trim();
    r.amount = v.amt;
    r.date = patch.date;
    if (typeChanged) {
      r.kind = patch.kind;
      r.category = CATEGORY_OF_KIND[patch.kind];
      r.status = patch.status;
    } else if (r.kind === KIND.BUDGET && statusChange && benign) {
      r.status = patch.status;
      r.generateFrom = monthOf(patch.date);
    }
    if (isTemplate(r)) {
      if (!r.generateFrom || typeChanged) r.generateFrom = monthOf(patch.date);
      r.month = r.generateFrom;
    } else {
      r.month = monthOf(patch.date);
    }
    if (r.kind === KIND.DEBT) r.principal = v.amt;
    if (r.kind === KIND.SAVINGS && patch.fromCash != null) r.fromCash = !!patch.fromCash;
    if (patch.debtId !== undefined && r.kind === KIND.DEBT_PAYMENT && !isTypeLocked(state, r)) r.debtId = patch.debtId || undefined;
    syncDebtStatuses(state);
    return { ok: true, record: r };
  }

  /**
   * Complete a scheduled record (pending income, unpaid bill, expected debt
   * payment, planned savings). The original stays as history (status
   * "Completed") and a separate linked actual transaction is created.
   */
  function settleRecord(state, id, opts) {
    const o = opts || {};
    const src = findRecord(state, id);
    if (!src) return { ok: false, error: 'Entry not found.' };
    const rule = SETTLE_RULES[src.kind];
    if (src.status === 'Completed' || (src.settledTxId && findRecord(state, src.settledTxId))) {
      return { ok: false, error: 'This entry was already completed.' };
    }
    if (!rule || src.status !== rule.open) return { ok: false, error: 'This entry can’t be completed.' };
    const v = validateAmountDate(o.amount != null ? o.amount : src.amount, o.date || src.date);
    if (v.error) return { ok: false, error: v.error };
    const ref = `settle:${src.id}`;
    if (state.records.some(r => r.ref === ref)) return { ok: false, error: 'This entry was already completed.' };
    if (src.kind === KIND.DEBT_PAYMENT && src.debtId) {
      const debt = findRecord(state, src.debtId);
      if (debt) {
        const info = debtInfo(state, debt);
        if (v.amt > info.remaining + 0.004) return { ok: false, error: `Only ${info.remaining} is left on this debt.` };
      }
    }
    const date = o.date || src.date;
    const tx = {
      id: newId('tx'),
      category: src.category,
      kind: src.kind,
      name: src.name,
      amount: v.amt,
      date,
      month: monthOf(date),
      status: rule.done,
      sourceId: src.id,
      ref
    };
    if (src.debtId) tx.debtId = src.debtId;
    if (src.budgetId) tx.budgetId = src.budgetId;
    if (src.kind === KIND.SAVINGS) tx.fromCash = o.fromCash != null ? !!o.fromCash : src.fromCash !== false;
    state.records.unshift(tx);
    src.status = 'Completed';
    src.settledTxId = tx.id;
    src.completedAt = date;
    syncDebtStatuses(state);
    return { ok: true, tx };
  }

  /** Partial or full repayment of a debt liability. Cash is deducted once, by the payment record. */
  function recordDebtPayment(state, debtId, opts) {
    const o = opts || {};
    const debt = findRecord(state, debtId);
    if (!debt || debt.kind !== KIND.DEBT) return { ok: false, error: 'Debt not found.' };
    const v = validateAmountDate(o.amount, o.date);
    if (v.error) return { ok: false, error: v.error };
    const info = debtInfo(state, debt);
    if (info.remaining <= 0) return { ok: false, error: 'This debt is already fully paid.' };
    if (v.amt > info.remaining + 0.004) return { ok: false, error: `Only ${info.remaining} is left on this debt.` };
    const tx = {
      id: newId('tx'),
      category: 'debt',
      kind: KIND.DEBT_PAYMENT,
      name: o.name ? String(o.name).trim() : `Payment · ${debt.name}`,
      amount: v.amt,
      date: o.date,
      month: monthOf(o.date),
      status: 'Paid',
      debtId: debt.id
    };
    state.records.unshift(tx);
    syncDebtStatuses(state);
    return { ok: true, tx, remaining: debtInfo(state, debt).remaining };
  }

  /** Actual spending against a budget: a Paid expense linked to the budget. */
  function recordBudgetSpend(state, budgetId, opts) {
    const o = opts || {};
    const b = findRecord(state, budgetId);
    if (!b || b.kind !== KIND.BUDGET) return { ok: false, error: 'Budget not found.' };
    const v = validateAmountDate(o.amount, o.date);
    if (v.error) return { ok: false, error: v.error };
    if (!budgetAppliesTo(b, monthOf(o.date))) return { ok: false, error: 'That date is outside this budget’s month.' };
    const tx = {
      id: newId('tx'),
      category: 'expenses',
      kind: KIND.EXPENSE,
      name: String(o.name || '').trim() || b.name,
      amount: v.amt,
      date: o.date,
      month: monthOf(o.date),
      status: 'Paid',
      budgetId: b.id
    };
    state.records.unshift(tx);
    return { ok: true, tx };
  }

  function deleteRecord(state, id) {
    const r = findRecord(state, id);
    if (!r) return false;
    if (r.sourceId) {
      const src = findRecord(state, r.sourceId);
      if (src && src.settledTxId === r.id) {
        src.status = openStatusFor(src.kind) || src.status;
        delete src.settledTxId;
        delete src.completedAt;
      }
    }
    if (r.templateId && r.period) {
      const t = findRecord(state, r.templateId);
      if (t) t.skippedPeriods = Array.from(new Set([...(t.skippedPeriods || []), r.period]));
    }
    if (r.settledTxId) {
      const tx = findRecord(state, r.settledTxId);
      if (tx) tx.sourceName = r.name; // keep the actual transaction as history
    }
    state.records = state.records.filter(x => x.id !== id);
    syncDebtStatuses(state);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Migration from the original (v1) data format
  // ---------------------------------------------------------------------------
  function migrateV1(raw, todayYmd) {
    const todayYm = monthOf(todayYmd);
    const review = [];
    const records = (Array.isArray(raw.records) ? raw.records : []).map(r => {
      const amount = round2(r.amount);
      const month = isYm(r.month) ? r.month : monthOf(r.date) || todayYm;
      // v1 placed one-off records by `month`; keep them in that month.
      const placedDate = isYmd(r.date) && monthOf(r.date) === month ? r.date : `${month}-01`;
      const base = { ...r, amount, legacyStatus: r.status || null };
      const template = kind => {
        const day = isYmd(r.date) ? r.date.slice(8, 10) : '01';
        const generateFrom = month > todayYm ? month : todayYm;
        return { ...base, kind, status: 'Recurring', month, generateFrom, date: clampDay(generateFrom, day) };
      };
      const oneOff = (kind, status, extra) => ({ ...base, kind, status, date: placedDate, month, ...(extra || {}) });

      switch (r.category) {
        case 'income':
          if (r.status === 'Active') return oneOff(KIND.INCOME, 'Received');
          if (r.status === 'Pending') return oneOff(KIND.INCOME, 'Pending');
          if (r.status === 'Recurring') return template(KIND.INCOME);
          break;
        case 'expenses':
          if (r.status === 'Active') return oneOff(KIND.EXPENSE, 'Paid');
          if (r.status === 'Pending') return oneOff(KIND.BILL, 'Unpaid');
          if (r.status === 'Recurring') return template(KIND.BILL);
          break;
        case 'savings':
          if (r.status === 'Active') return oneOff(KIND.SAVINGS, 'Active', { fromCash: false });
          if (r.status === 'Pending') return oneOff(KIND.SAVINGS, 'Planned', { fromCash: true });
          if (r.status === 'Recurring') return { ...template(KIND.SAVINGS), fromCash: true };
          break;
        case 'debt':
          if (r.status === 'Active' || r.status === 'Pending') {
            review.push(r.id);
            return oneOff(KIND.DEBT, 'Outstanding', { principal: amount, needsReview: true });
          }
          if (r.status === 'Recurring') {
            review.push(r.id);
            return { ...template(KIND.DEBT_PAYMENT), needsReview: true };
          }
          break;
        default:
          break;
      }
      // Unknown category or status: keep as-is, no cash impact, flag for review.
      review.push(r.id);
      return { ...base, kind: base.kind || null, needsReview: true };
    });

    const dailyEarnings = (Array.isArray(raw.dailyEarnings) ? raw.dailyEarnings : []).map(d => ({
      ...d,
      amount: round2(d.amount),
      // v1 only logged money that was earned; it counted every entry as income.
      status: d.status === 'Pending' ? 'Pending' : 'Received',
      legacyStatus: d.status || null
    }));

    return {
      ...raw,
      schemaVersion: SCHEMA_VERSION,
      openingBalance: round2(raw.openingBalance),
      records,
      dailyEarnings,
      migration: {
        from: raw.schemaVersion || 1,
        at: new Date().toISOString(),
        reviewIds: review,
        note: 'Recurring items now create one scheduled record per month starting this month. Past months were not back-filled because their paid/unpaid status was unknown.'
      }
    };
  }

  /** Bring any stored data up to the current schema without losing or duplicating records. */
  function normalizeState(parsed, opts) {
    const today = (opts && opts.today) || localDateStr();
    if (!parsed || typeof parsed !== 'object') return null;
    let s = parsed;
    let migrated = false;
    if (s.schemaVersion !== SCHEMA_VERSION) {
      s = migrateV1(s, today);
      migrated = true;
    } else {
      s = { ...s, records: Array.isArray(s.records) ? s.records : [], dailyEarnings: Array.isArray(s.dailyEarnings) ? s.dailyEarnings : [] };
    }
    const seen = new Set();
    s.records = s.records.filter(r => r && typeof r === 'object').map(r => {
      const rec = { ...r };
      if (!rec.id || seen.has(rec.id)) rec.id = newId('rec'); // keep both, never drop
      seen.add(rec.id);
      if (!rec.category && rec.kind) rec.category = CATEGORY_OF_KIND[rec.kind];
      if (!isTemplate(rec) && rec.kind !== KIND.BUDGET && isYmd(rec.date)) rec.month = monthOf(rec.date);
      return rec;
    });
    const seenDaily = new Set();
    s.dailyEarnings = s.dailyEarnings.filter(d => d && typeof d === 'object').map(d => {
      const e = { ...d, amount: round2(d.amount) };
      if (!e.id || seenDaily.has(e.id)) e.id = newId('de');
      seenDaily.add(e.id);
      if (!e.status) e.status = 'Received';
      return e;
    });
    s.openingBalance = round2(s.openingBalance);
    syncDebtStatuses(s);
    return { state: s, migrated };
  }

  /** Convert every stored money value with fn(amount). */
  function convertMoney(state, fn) {
    state.records = state.records.map(r => {
      const out = { ...r, amount: fn(r.amount) };
      if (r.principal != null) out.principal = fn(r.principal);
      return out;
    });
    state.dailyEarnings = state.dailyEarnings.map(d => ({ ...d, amount: fn(d.amount) }));
    state.monthlyGoalTarget = fn(state.monthlyGoalTarget);
    state.openingBalance = fn(state.openingBalance);
    return state;
  }

  // ---------------------------------------------------------------------------
  // Simple view model: 3 statuses, cash-flow list vs balances, recurring rules
  // ---------------------------------------------------------------------------
  const SIMPLE = { PENDING: 'Pending', COMPLETED: 'Completed', SCHEDULED: 'Scheduled' };

  /** Pending | Completed | Scheduled — the only status words the user sees. */
  function simpleStatus(state, r) {
    if (!r) return SIMPLE.PENDING;
    if (isTemplate(r) || r.kind === KIND.BUDGET) return SIMPLE.SCHEDULED;
    if (r.kind === KIND.DEBT) return debtInfo(state, r).remaining > 0 ? SIMPLE.PENDING : SIMPLE.COMPLETED;
    if (r.status === 'Completed' || r.status === 'Received' || r.status === 'Paid' || r.status === 'Active') return SIMPLE.COMPLETED;
    return SIMPLE.PENDING;
  }

  /** Balances (savings you hold, money you owe) are accounts, not monthly transactions. */
  function isBalanceRecord(r) {
    if (!r || isTemplate(r)) return false;
    if (r.kind === KIND.DEBT) return true;
    return r.kind === KIND.SAVINGS && r.status === 'Active' && !r.fromCash;
  }

  /**
   * One actionable row per bill or paycheck for the month: no recurring rules,
   * no balances, and a completed scheduled item is represented only by its
   * linked actual transaction.
   */
  function cashFlowRecords(state, ym) {
    return monthRecords(state, ym).filter(r => !isTemplate(r) && r.status !== 'Completed' && !isBalanceRecord(r));
  }

  /** Recurring rules that are active in the month. */
  function recurringRules(state, ym) {
    return state.records.filter(r => isTemplate(r) && r.kind !== KIND.BUDGET && startMonthOf(r) <= ym && (!r.endMonth || ym <= r.endMonth));
  }

  /** Savings/investment accounts and open debts as of the end of the month. */
  function accountBalances(state, ym) {
    const end = endOfMonth(ym);
    const savings = state.records
      .filter(r => r.kind === KIND.SAVINGS && r.status === 'Active' && recordDate(r) <= end)
      .map(r => ({ record: r, amount: round2(r.amount) }));
    const debts = state.records
      .filter(r => r.kind === KIND.DEBT && !isTemplate(r) && recordDate(r) <= end)
      .map(r => debtInfo(state, r, end))
      .filter(x => x.remaining > 0)
      .map(x => ({ record: x.debt, amount: x.remaining, principal: x.principal, paid: x.paid }));
    return { savings, debts, savingsTotal: sum(savings, x => x.amount), debtTotal: sum(debts, x => x.amount) };
  }

  /** Share of a target reached, never rounded up (0.5% stays 0.5%, not 1%). */
  function goalProgress(value, target) {
    const t = num(target);
    if (!(t > 0)) return { pct: 0, label: '0%' };
    const raw = Math.max(0, Math.min(100, (num(value) / t) * 100));
    const pct = Math.floor(raw * 10) / 10;
    const label = pct >= 10 || Number.isInteger(pct) ? `${Math.floor(pct)}%` : `${pct.toFixed(1)}%`;
    return { pct, label };
  }

  /**
   * A "received income" that is really money you already had (e.g. a bank
   * balance logged as income) becomes part of the opening cash instead.
   * Cash Balance stays the same; it just stops counting as earned this month.
   */
  function moveIncomeToOpeningBalance(state, id) {
    const r = findRecord(state, id);
    if (!r || r.kind !== KIND.INCOME || r.status !== 'Received') return { ok: false, error: 'Only received income can become opening cash.' };
    if (r.sourceId || r.templateId) return { ok: false, error: 'This income came from a scheduled item, so it can’t become opening cash.' };
    state.openingBalance = round2(num(state.openingBalance) + num(r.amount));
    state.records = state.records.filter(x => x.id !== id);
    return { ok: true, openingBalance: state.openingBalance };
  }

  return {
    SIMPLE,
    simpleStatus,
    isBalanceRecord,
    cashFlowRecords,
    recurringRules,
    accountBalances,
    goalProgress,
    moveIncomeToOpeningBalance,
    SCHEMA_VERSION,
    KIND,
    CATEGORY_OF_KIND,
    SETTLE_RULES,
    round2,
    localDateStr,
    monthOf,
    addMonths,
    daysInMonth,
    endOfMonth,
    clampDay,
    weekRange,
    isTemplate,
    recordDate,
    cashDelta,
    statusGroup,
    openStatusFor,
    budgetAppliesTo,
    findRecord,
    debtInfo,
    debtPayments,
    syncDebtStatuses,
    computeMonthMetrics,
    monthRecords,
    dailySummary,
    dailyTotalsByDay,
    addDailyEarning,
    receiveDailyEarning,
    deleteDailyEarning,
    generateRecurring,
    syncTemplateInstances,
    addRecord,
    updateRecord,
    isTypeLocked,
    settleRecord,
    recordDebtPayment,
    recordBudgetSpend,
    deleteRecord,
    migrateV1,
    normalizeState,
    convertMoney
  };
});
