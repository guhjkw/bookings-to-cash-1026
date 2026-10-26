// src/cashEngine.js: the logic behind the bookings-to-cash checker.
// The page and the node tests load this same file. It matches every Bookeo booking to its Xero
// invoice and its PayZen payments, decides what (if anything) needs doing, and drafts the message.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cash = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const PAY_STATUSES = ['PAID', 'PENDING', 'EXPIRED', 'REFUSED'];
  const INV_STATUSES = ['AUTHORISED', 'PAID', 'VOIDED'];
  // Severity drives sorting and colour: bad first, then warn, info, waiting, ok.
  const RANK = { bad: 0, warn: 1, info: 2, grey: 3, ok: 4 };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => fmt(new Date(toDate(s).getTime() + n * DAY));
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function money(n, lang) {
    const s = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'fr' ? ' ' : ',');
    return s + ' XPF';
  }
  function dayLabel(s, lang) {
    return toDate(s).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: lang === 'fr' ? 'long' : 'short', day: 'numeric', month: lang === 'fr' ? 'long' : 'short', timeZone: 'UTC' });
  }

  // ---------- data check: bad rows are skipped and reported, never a crash ----------
  function prepare(raw) {
    const problems = [];
    const src = raw || {};
    const company = Object.assign({ name: 'Your company', currency: 'XPF' }, src.company || {});
    if (!isDate(company.today)) { problems.push('No valid "today" date in the data, so 2026-10-26 is used.'); company.today = '2026-10-26'; }
    const rules = Object.assign({ reminderDays: [7, 3, 1], tolerance: 0, horizonDays: 14 }, src.rules || {});
    const activities = (src.activities || []).filter((a, i) => {
      const ok = a && a.id && a.name && typeof a.price === 'number' && a.price > 0;
      if (!ok) problems.push('Activity row ' + (i + 1) + ': needs an id, a name and a price above 0, skipped.');
      return ok;
    });
    const actIds = new Set(activities.map((a) => a.id));
    const bookings = [], seen = new Set();
    (src.bookings || []).forEach((b, i) => {
      const row = 'Booking row ' + (i + 1);
      if (!b || !b.id) return problems.push(row + ': no booking number, skipped.');
      if (seen.has(b.id)) return problems.push(row + ' (' + b.id + '): duplicate booking number, skipped.');
      if (!actIds.has(b.activity)) return problems.push(row + ' (' + b.id + '): unknown activity, skipped.');
      if (!isDate(b.tripDate)) return problems.push(row + ' (' + b.id + '): no valid trip date, skipped.');
      if (!(typeof b.amount === 'number' && b.amount > 0)) return problems.push(row + ' (' + b.id + '): amount must be above 0, skipped.');
      if (!['confirmed', 'cancelled'].includes(b.status)) return problems.push(row + ' (' + b.id + '): status must be confirmed or cancelled, skipped.');
      seen.add(b.id);
      bookings.push({ id: b.id, customer: String(b.customer || 'Customer'), email: b.email || '', lang: b.lang === 'fr' ? 'fr' : 'en', activity: b.activity, tripDate: b.tripDate,
        pax: Number.isInteger(b.pax) && b.pax > 0 ? b.pax : 1, amount: b.amount, bookeoPaid: !!b.bookeoPaid, status: b.status });
    });
    const ids = new Set(bookings.map((b) => b.id));
    const invoices = (src.invoices || []).filter((v, i) => {
      const ok = v && v.number && ids.has(v.bookingId) && INV_STATUSES.includes(v.status) && typeof v.amount === 'number';
      if (!ok) problems.push('Invoice row ' + (i + 1) + (v && v.number ? ' (' + v.number + ')' : '') + ': needs a number, a known booking, an amount and a Xero status, skipped.');
      return ok;
    }).map((v) => ({ number: v.number, bookingId: v.bookingId, amount: v.amount, status: v.status }));
    const payIds = new Set();
    const payments = (src.payments || []).filter((p, i) => {
      const ok = p && p.id && !payIds.has(p.id) && ids.has(p.bookingId) && PAY_STATUSES.includes(p.status) && typeof p.amount === 'number' && p.amount > 0 && isDate(p.createdAt) && (p.status !== 'PAID' || isDate(p.paidAt));
      if (!ok) problems.push('Payment row ' + (i + 1) + (p && p.id ? ' (' + p.id + ')' : '') + ': needs a unique id, a known booking, an amount, a PayZen status and dates, skipped.');
      else payIds.add(p.id);
      return ok;
    }).map((p) => ({ id: p.id, bookingId: p.bookingId, amount: p.amount, status: p.status, createdAt: p.createdAt, paidAt: p.paidAt || null }));
    return { data: { company, rules, activities, bookings, invoices, payments }, problems };
  }

  function newState(data) {
    const d = clone(data);
    return { company: d.company, rules: d.rules, activities: d.activities, bookings: d.bookings, invoices: d.invoices, payments: d.payments,
      reminded: {}, refunds: {}, log: [] };
  }

  // ---------- the money picture for one booking ----------
  function facts(state, b) {
    const inv = state.invoices.find((v) => v.bookingId === b.id && v.status !== 'VOIDED') || null;
    const voided = state.invoices.find((v) => v.bookingId === b.id && v.status === 'VOIDED') || null;
    const pays = state.payments.filter((p) => p.bookingId === b.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
    const paid = pays.filter((p) => p.status === 'PAID');
    const refunded = state.refunds[b.id] ? state.refunds[b.id].amount : 0;
    const net = paid.reduce((s, p) => s + p.amount, 0) - refunded;
    const pending = pays.filter((p) => p.status === 'PENDING');
    const last = pays[pays.length - 1] || null;
    const days = daysBetween(state.company.today, b.tripDate);
    const due = b.status === 'confirmed' ? Math.max(0, b.amount - Math.max(net, 0)) : 0;
    // The most recent reminder stage reached: e.g. with stages 7/3/1 and a trip in 2 days, stage 3.
    const stages = state.rules.reminderDays.slice().sort((x, y) => x - y);
    const stage = days >= 0 ? stages.find((d) => d >= days) : undefined;
    return { inv, voided, pays, paid, refunded, net, pending, last, days, due, stage, fully: net >= b.amount - state.rules.tolerance };
  }

  function statusOf(state, b) {
    const f = facts(state, b);
    const tol = state.rules.tolerance;
    const s = (code, level, label, action, detail) => ({ code, level, label, action: action || null, detail: detail || '', facts: f });
    if (b.status === 'cancelled') {
      if (f.net > tol) return s('CANCELLED_PAID', 'bad', 'Cancelled but paid ' + money(f.net), 'refund', 'Refund or credit ' + money(f.net) + ', then void the invoice.');
      if (f.inv && f.inv.status === 'AUTHORISED') return s('CANCELLED_INVOICE_OPEN', 'warn', 'Cancelled: invoice still open', 'void', f.inv.number + ' still asks for ' + money(f.inv.amount) + ' in Xero.');
      return s('CANCELLED_CLEAR', 'grey', 'Cancelled, nothing owed', null, f.refunded ? 'Refunded ' + money(f.refunded) + '.' : '');
    }
    if (f.net > b.amount + tol) {
      const extra = f.net - b.amount;
      return s('OVERPAID', 'bad', f.paid.length > 1 ? 'Paid twice' : 'Overpaid', 'refundExtra', 'Received ' + money(f.net) + ' for a ' + money(b.amount) + ' booking: refund ' + money(extra) + '.');
    }
    if (f.net > tol && !f.fully) {
      return s('PART_PAID', 'warn', 'Paid ' + money(f.net) + ' of ' + money(b.amount), f.pending.length ? (f.stage !== undefined && !(state.reminded[b.id] || {})[f.stage] ? 'remind' : null) : 'balanceLink',
        f.pending.length ? 'Balance link sent; ' + money(f.due) + ' still to come.' : 'Send a link for the balance of ' + money(f.due) + '.');
    }
    if (f.fully) {
      if (!f.inv) return s('NO_INVOICE', 'warn', 'Paid, but no invoice in Xero', 'createInvoice', 'The booking never reached Xero.');
      if (f.inv.status === 'AUTHORISED') return s('PAID_XERO_OPEN', 'warn', 'Paid on PayZen, invoice still open in Xero', 'xeroPaid', 'The payment did not sync back: ' + f.inv.number + ' still shows as owed.');
      if (!b.bookeoPaid) return s('PAID_BOOKEO_UNPAID', 'warn', 'Paid, but Bookeo still says unpaid', 'bookeoPaid', 'The front desk would chase a customer who has paid.');
      return s('OK', 'ok', 'Paid and matched', null, f.inv.number + ' paid · ' + f.paid.map((p) => p.id).join(', '));
    }
    // Nothing (net) paid yet.
    if (!f.inv) return s('NO_INVOICE', 'warn', 'No invoice in Xero', 'createInvoice', 'The booking never reached Xero, so the payment link has nothing to settle.');
    if (f.days < 0) return s('PAST_UNPAID', 'bad', 'Trip done, still unpaid', 'newLink', 'Trip was ' + dayLabel(b.tripDate) + '. ' + money(f.due) + ' outstanding.');
    if (!f.pending.length) {
      const why = !f.last ? 'No payment link sent' : f.last.status === 'REFUSED' ? 'Card refused' : 'Payment link expired';
      return s('LINK_FAILED', f.days <= 1 ? 'bad' : 'warn', why, 'newLink', (f.days === 0 ? 'Trip is today. ' : f.days === 1 ? 'Trip is tomorrow. ' : 'Trip in ' + f.days + ' days. ') + 'Send a new link for ' + money(f.due) + '.');
    }
    if (f.stage !== undefined) {
      const sent = (state.reminded[b.id] || {})[f.stage];
      if (!sent) return s('REMINDER_DUE', f.days <= 1 ? 'bad' : 'warn', f.days <= 1 ? 'Last call: unpaid, trip ' + (f.days === 0 ? 'today' : 'tomorrow') : 'Unpaid, trip in ' + f.days + ' days: reminder due', 'remind', money(f.due) + ' on link ' + f.pending[f.pending.length - 1].id + '.');
      return s('UNPAID_REMINDED', 'info', 'Reminder sent ' + dayLabel(sent) + ', waiting', null, 'Next reminder at the next stage.');
    }
    const first = addDays(b.tripDate, -Math.max.apply(null, state.rules.reminderDays));
    return s('UNPAID_WAITING', 'grey', 'Link sent, not due yet', null, 'First reminder ' + dayLabel(first) + '.');
  }

  // ---------- the board: every booking, worst first ----------
  function board(state) {
    const rows = state.bookings.map((b) => ({ booking: b, activity: state.activities.find((a) => a.id === b.activity), status: statusOf(state, b) }))
      .sort((x, y) => RANK[x.status.level] - RANK[y.status.level] || x.booking.tripDate.localeCompare(y.booking.tripDate));
    const need = rows.filter((r) => ['bad', 'warn'].includes(r.status.level));
    return { rows, need, counts: rows.reduce((o, r) => { o[r.status.code] = (o[r.status.code] || 0) + 1; return o; }, {}) };
  }

  // ---------- cash summary ----------
  function cash(state) {
    const T = state.company.today, H = state.rules.horizonDays;
    let receivedWeek = 0, unpaidUpcoming = 0, unpaidWeek = 0, overdue = 0, refundsDue = 0, tripsValue = 0, tripsPaid = 0, trips = 0;
    state.payments.forEach((p) => { if (p.status === 'PAID' && p.paidAt >= addDays(T, -6) && p.paidAt <= T) receivedWeek += p.amount; });
    state.bookings.forEach((b) => {
      const st = statusOf(state, b), f = st.facts;
      if (st.code === 'CANCELLED_PAID') refundsDue += f.net;
      if (st.code === 'OVERPAID') refundsDue += f.net - b.amount;
      if (b.status !== 'confirmed') return;
      if (f.days < 0 && f.due > 0) overdue += f.due;
      if (f.days >= 0 && f.due > 0) { unpaidUpcoming += f.due; if (f.days <= 7) unpaidWeek += f.due; }
      if (f.days >= 0 && f.days <= H) { trips++; tripsValue += b.amount; tripsPaid += Math.min(b.amount, Math.max(0, f.net)); }
    });
    return { receivedWeek, unpaidUpcoming, unpaidWeek, overdue, refundsDue, trips, tripsValue, tripsPaid, paidPct: tripsValue ? Math.round((tripsPaid / tripsValue) * 100) : 100 };
  }

  // ---------- messages, in the customer's language ----------
  function message(state, b, kind, langOverride) {
    const lang = langOverride || b.lang;
    const act = state.activities.find((a) => a.id === b.activity);
    const f = facts(state, b);
    const first = b.customer.split(' ')[0];
    const amt = money(f.due || b.amount, lang);
    const when = dayLabel(b.tripDate, lang);
    const co = state.company.name;
    if (lang === 'fr') {
      const what = 'réservation « ' + act.nameFr + ' » du ' + when + ' (' + b.pax + ' pers.)';
      if (kind === 'lastcall') return 'Bonjour ' + first + ', votre ' + what + ' approche et le paiement de ' + amt + ' n\'est pas encore reçu. Pour garder vos places, merci de régler ici : [lien PayZen]. Mauruuru, ' + co;
      if (kind === 'newlink') return 'Bonjour ' + first + ', ' + (f.last && f.last.status === 'REFUSED' ? 'votre carte a été refusée' : 'votre lien de paiement a expiré') + '. Voici un nouveau lien pour régler ' + amt + ' pour votre ' + what + ' : [lien PayZen]. Mauruuru, ' + co;
      if (kind === 'balance') return 'Bonjour ' + first + ', merci pour votre acompte. Il reste ' + amt + ' à régler pour votre ' + what + ' : [lien PayZen]. Mauruuru, ' + co;
      return 'Bonjour ' + first + ', petit rappel : votre ' + what + ' n\'est pas encore réglée. Vous pouvez payer ' + amt + ' en toute sécurité ici : [lien PayZen]. Mauruuru, ' + co;
    }
    const what = 'booking for ' + act.name + ' on ' + when + ' (' + b.pax + (b.pax === 1 ? ' guest' : ' guests') + ')';
    if (kind === 'lastcall') return 'Hi ' + first + ', your ' + what + ' is coming up and we haven\'t received the ' + amt + ' yet. To keep your places, please pay here: [PayZen link]. Mauruuru, ' + co;
    if (kind === 'newlink') return 'Hi ' + first + ', ' + (f.last && f.last.status === 'REFUSED' ? 'your card was declined' : 'your payment link expired') + '. Here is a new link to pay ' + amt + ' for your ' + what + ': [PayZen link]. Mauruuru, ' + co;
    if (kind === 'balance') return 'Hi ' + first + ', thanks for your deposit. ' + amt + ' is still to pay for your ' + what + ': [PayZen link]. Mauruuru, ' + co;
    return 'Hi ' + first + ', a quick reminder that your ' + what + ' isn\'t paid yet. You can pay ' + amt + ' securely here: [PayZen link]. Mauruuru, ' + co;
  }
  function kindFor(state, b) {
    const st = statusOf(state, b);
    if (st.action === 'newLink') return 'newlink';
    if (st.action === 'balanceLink' || (st.code === 'PART_PAID')) return 'balance';
    return st.facts.days <= 1 ? 'lastcall' : 'reminder';
  }
  function remindersDue(state) {
    return state.bookings.map((b) => ({ b, st: statusOf(state, b) })).filter((x) => x.st.action === 'remind')
      .map((x) => ({ booking: x.b, stage: x.st.facts.stage, kind: kindFor(state, x.b), text: message(state, x.b, kindFor(state, x.b)) }));
  }

  // ---------- fixes (each one changes the data the board is computed from) ----------
  const find = (state, id) => state.bookings.find((b) => b.id === id);
  const fail = (t) => ({ ok: false, problems: [t] });
  function nextNumber(list, key, prefix, pad) {
    const n = list.reduce((m, x) => Math.max(m, parseInt(String(x[key]).replace(/\D/g, ''), 10) || 0), 0) + 1;
    return prefix + String(n).padStart(pad, '0');
  }
  function markXeroPaid(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    const f = facts(state, b);
    if (!f.inv) return fail('There is no invoice to mark.');
    if (!f.fully) return fail('Not fully paid on PayZen yet, so the invoice stays open.');
    if (f.inv.status === 'PAID') return fail(f.inv.number + ' is already paid.');
    f.inv.status = 'PAID'; state.log.push('Xero: ' + f.inv.number + ' marked paid (' + id + ')');
    return { ok: true };
  }
  function markBookeoPaid(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    if (!facts(state, b).fully) return fail('Not fully paid yet, so Bookeo stays unpaid.');
    if (b.bookeoPaid) return fail('Bookeo already shows it paid.');
    b.bookeoPaid = true; state.log.push('Bookeo: ' + id + ' marked paid');
    return { ok: true };
  }
  function createInvoice(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    if (b.status !== 'confirmed') return fail('Cancelled bookings do not get an invoice.');
    const f = facts(state, b);
    if (f.inv) return fail(id + ' already has ' + f.inv.number + '.');
    const number = nextNumber(state.invoices, 'number', 'INV-', 4);
    state.invoices.push({ number, bookingId: id, amount: b.amount, status: f.fully ? 'PAID' : 'AUTHORISED' });
    state.log.push('Xero: ' + number + ' created for ' + id + (f.fully ? ' and marked paid' : ''));
    return { ok: true, number };
  }
  function voidInvoice(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    if (b.status !== 'cancelled') return fail('Only cancelled bookings have their invoice voided.');
    const f = facts(state, b);
    if (f.net > state.rules.tolerance) return fail('Refund the ' + money(f.net) + ' first.');
    if (!f.inv) return fail('No open invoice.');
    f.inv.status = 'VOIDED'; state.log.push('Xero: ' + f.inv.number + ' voided (' + id + ' cancelled)');
    return { ok: true };
  }
  function sendNewLink(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    if (b.status !== 'confirmed') return fail('Cancelled bookings do not get a payment link.');
    const f = facts(state, b);
    if (f.due <= 0) return fail('Nothing left to pay.');
    if (f.pending.length) return fail('A link (' + f.pending[0].id + ') is already open.');
    // Draft the message first: it explains why the last link failed (expired or refused card).
    const text = message(state, b, f.net > 0 ? 'balance' : 'newlink');
    const pid = nextNumber(state.payments, 'id', 'PZ-', 5);
    state.payments.push({ id: pid, bookingId: id, amount: f.due, status: 'PENDING', createdAt: state.company.today, paidAt: null });
    // The new-link email doubles as this stage's reminder, so it is not sent twice.
    if (f.stage !== undefined) (state.reminded[id] = state.reminded[id] || {})[f.stage] = state.company.today;
    state.log.push('PayZen: new link ' + pid + ' for ' + money(f.due) + ' sent to ' + b.customer);
    return { ok: true, id: pid, text };
  }
  // `lang` lets someone send the other language on purpose; the default is the customer's own.
  function sendReminder(state, id, lang) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    const st = statusOf(state, b);
    if (st.action !== 'remind') return fail('No reminder is due for ' + id + '.');
    const used = lang === 'fr' || lang === 'en' ? lang : b.lang;
    const text = message(state, b, kindFor(state, b), used);
    (state.reminded[id] = state.reminded[id] || {})[st.facts.stage] = state.company.today;
    state.log.push('Reminder (' + st.facts.stage + '-day stage, ' + used.toUpperCase() + ') sent to ' + b.customer);
    return { ok: true, text, lang: used };
  }
  function recordRefund(state, id) {
    const b = find(state, id); if (!b) return fail('No booking ' + id + '.');
    const st = statusOf(state, b), f = st.facts;
    let amount = 0;
    if (st.code === 'CANCELLED_PAID') amount = f.net;
    else if (st.code === 'OVERPAID') amount = f.net - b.amount;
    else return fail('No refund is due on ' + id + '.');
    const prev = state.refunds[id] ? state.refunds[id].amount : 0;
    state.refunds[id] = { amount: prev + amount, date: state.company.today };
    state.log.push('Refund of ' + money(amount) + ' recorded for ' + b.customer);
    return { ok: true, amount };
  }
  // Simulates the customer paying an open link. The existing automation normally marks Xero and
  // Bookeo paid at once; `syncFails` leaves them unmarked, which is exactly what the checker catches.
  function customerPays(state, paymentId, syncFails) {
    const p = state.payments.find((x) => x.id === paymentId);
    if (!p) return fail('No payment ' + paymentId + '.');
    if (p.status !== 'PENDING') return fail(paymentId + ' is ' + p.status.toLowerCase() + ', not open.');
    p.status = 'PAID'; p.paidAt = state.company.today;
    const b = find(state, p.bookingId);
    const f = facts(state, b);
    if (!syncFails && f.fully) {
      if (f.inv && f.inv.status === 'AUTHORISED') f.inv.status = 'PAID';
      b.bookeoPaid = true;
    }
    state.log.push(b.customer + ' paid ' + money(p.amount) + ' on ' + paymentId + (syncFails ? ' (sync to Xero/Bookeo failed)' : ''));
    return { ok: true };
  }
  function addBooking(state, x) {
    const problems = [];
    const act = state.activities.find((a) => a.id === (x && x.activity));
    if (!x || !String(x.customer || '').trim()) problems.push('Customer name is required.');
    if (!x || !EMAIL.test(String(x.email || '').trim())) problems.push('A valid email is required for the payment link.');
    if (!act) problems.push('Pick an activity.');
    const pax = Number(x && x.pax);
    if (!Number.isInteger(pax) || pax < 1 || pax > 20) problems.push('Guests must be a whole number from 1 to 20.');
    if (!x || !isDate(x.tripDate)) problems.push('Pick a trip date.');
    else if (x.tripDate < state.company.today) problems.push('The trip date is in the past.');
    if (problems.length) return { ok: false, problems };
    const id = nextNumber(state.bookings, 'id', 'BK-', 5);
    const b = { id, customer: String(x.customer).trim(), email: String(x.email).trim(), lang: x.lang === 'fr' ? 'fr' : 'en', activity: act.id, tripDate: x.tripDate, pax, amount: act.price * pax, bookeoPaid: false, status: 'confirmed' };
    state.bookings.push(b);
    // What the existing Bookeo → Xero → PayZen automation does on every new booking.
    const number = nextNumber(state.invoices, 'number', 'INV-', 4);
    state.invoices.push({ number, bookingId: id, amount: b.amount, status: 'AUTHORISED' });
    const pid = nextNumber(state.payments, 'id', 'PZ-', 5);
    state.payments.push({ id: pid, bookingId: id, amount: b.amount, status: 'PENDING', createdAt: state.company.today, paidAt: null });
    state.log.push('New booking ' + id + ' for ' + b.customer + ': ' + number + ' and link ' + pid + ' created');
    return { ok: true, booking: b };
  }
  function setRules(state, patch) {
    const R = Object.assign({}, state.rules, patch || {});
    const problems = [];
    const days = R.reminderDays;
    if (!Array.isArray(days) || !days.length || days.length > 4 || days.some((d) => !Number.isInteger(d) || d < 1 || d > 30) || new Set(days).size !== days.length) problems.push('Reminder days must be 1 to 4 different whole numbers from 1 to 30.');
    if (!Number.isFinite(R.tolerance) || R.tolerance < 0 || R.tolerance > 1000) problems.push('Tolerance must be between 0 and 1,000 XPF.');
    if (problems.length) return { ok: false, problems };
    R.reminderDays = days.slice().sort((a, b) => b - a);
    state.rules = R;
    return { ok: true };
  }
  function advance(state, n) {
    const k = n == null ? 1 : n;
    if (!Number.isInteger(k) || k < 1 || k > 30) return fail('Move forward 1 to 30 days.');
    state.company.today = addDays(state.company.today, k);
    state.log.push('Moved to ' + dayLabel(state.company.today));
    return { ok: true };
  }

  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function csv(state) {
    const rows = ['Booking,Customer,Trip date,Amount XPF,Status,What to do'];
    board(state).rows.forEach((r) => rows.push([r.booking.id, r.booking.customer, r.booking.tripDate, r.booking.amount, r.status.label, r.status.detail].map(q).join(',')));
    return rows.join('\n');
  }

  return { prepare, newState, facts, statusOf, board, cash, message, remindersDue, markXeroPaid, markBookeoPaid, createInvoice, voidInvoice,
    sendNewLink, sendReminder, recordRefund, customerPays, addBooking, setRules, advance, csv, money, dayLabel, addDays, daysBetween };
});
