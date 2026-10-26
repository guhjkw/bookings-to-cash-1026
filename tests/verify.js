// tests/verify.js: node tests for src/cashEngine.js, the same file the page loads. Run: node tests/verify.js
const E = require('../src/cashEngine.js');
const RAW = require('../data/bookings.json');

let pass = 0, fail = 0;
function sec(t) { console.log('\n' + t); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
const fresh = (mut) => { const d = JSON.parse(JSON.stringify(RAW)); if (mut) mut(d); return E.newState(E.prepare(d).data); };
const code = (s, id) => E.statusOf(s, s.bookings.find((b) => b.id === id)).code;
const st = (s, id) => E.statusOf(s, s.bookings.find((b) => b.id === id));

sec('1. Data check: bad rows are skipped and reported, never a crash');
{
  const p = E.prepare(RAW);
  ok('sample data loads with no problems', p.problems.length === 0, p.problems);
  const bad = JSON.parse(JSON.stringify(RAW));
  bad.bookings.push({ id: 'BK-24051', activity: 'LAGOON', tripDate: '2026-11-01', amount: 9500, status: 'confirmed' });
  bad.bookings.push({ id: 'BK-99001', activity: 'JETSKI', tripDate: '2026-11-01', amount: 9500, status: 'confirmed' });
  bad.bookings.push({ id: 'BK-99002', activity: 'LAGOON', tripDate: '1 Nov', amount: 9500, status: 'confirmed' });
  bad.bookings.push({ id: 'BK-99003', activity: 'LAGOON', tripDate: '2026-11-01', amount: 0, status: 'confirmed' });
  bad.invoices.push({ number: 'INV-9999', bookingId: 'BK-00000', amount: 1, status: 'PAID' });
  bad.payments.push({ id: 'PZ-88190', bookingId: 'BK-24051', amount: 19000, status: 'PAID', createdAt: '2026-10-18', paidAt: '2026-10-20' });
  bad.payments.push({ id: 'PZ-99999', bookingId: 'BK-24058', amount: 48000, status: 'PAID', createdAt: '2026-10-18', paidAt: null });
  delete bad.company.today;
  const q = E.prepare(bad);
  ok('a duplicate booking number is skipped', q.problems.some((t) => /BK-24051.*duplicate/.test(t)));
  ok('an unknown activity is skipped', q.problems.some((t) => /BK-99001.*unknown activity/.test(t)));
  ok('a trip date that is not a date is skipped', q.problems.some((t) => /BK-99002.*trip date/.test(t)));
  ok('a zero amount is skipped', q.problems.some((t) => /BK-99003.*amount/.test(t)));
  ok('an invoice for an unknown booking is skipped', q.problems.some((t) => /INV-9999/.test(t)));
  ok('a duplicate payment id is skipped', q.problems.some((t) => /Payment row 18 \(PZ-88190\)/.test(t)));
  ok('a PAID payment with no paid date is skipped', q.problems.some((t) => /PZ-99999/.test(t)) && q.data.payments.length === 17);
  ok('a missing "today" falls back and says so', q.data.company.today === '2026-10-26' && q.problems.some((t) => /today/.test(t)));
}

sec('2. Every booking gets the right status');
{
  const s = fresh();
  const want = {
    'BK-24051': 'OK', 'BK-24055': 'PAID_XERO_OPEN', 'BK-24058': 'REMINDER_DUE', 'BK-24060': 'LINK_FAILED', 'BK-24061': 'OK', 'BK-24063': 'REMINDER_DUE',
    'BK-24064': 'NO_INVOICE', 'BK-24066': 'UNPAID_WAITING', 'BK-24067': 'CANCELLED_PAID', 'BK-24069': 'PART_PAID', 'BK-24070': 'OVERPAID', 'BK-24072': 'PAST_UNPAID',
    'BK-24073': 'UNPAID_WAITING', 'BK-24074': 'OK', 'BK-24075': 'CANCELLED_INVOICE_OPEN', 'BK-24076': 'LINK_FAILED'
  };
  const wrong = Object.keys(want).filter((id) => code(s, id) !== want[id]).map((id) => id + ' ' + code(s, id));
  ok('all 16 statuses as expected', wrong.length === 0, wrong);
  ok('paid on PayZen but open in Xero is caught (BK-24055)', /INV-0421/.test(st(s, 'BK-24055').detail));
  ok('a refused card the day before the trip is urgent (BK-24076 is red)', st(s, 'BK-24076').level === 'bad' && st(s, 'BK-24076').label === 'Card refused');
  ok('an expired link 3 days out is amber (BK-24060)', st(s, 'BK-24060').level === 'warn' && st(s, 'BK-24060').label === 'Payment link expired');
  ok('paid twice shows the refund amount (42,000 XPF)', /refund 42,000 XPF/.test(st(s, 'BK-24070').detail));
  ok('a part payment shows the balance (12,000 of 24,000)', st(s, 'BK-24069').label === 'Paid 12,000 XPF of 24,000 XPF');
  ok('a trip 17 days out waits, with its first reminder date (Thu 5 Nov)', /Thu 5 Nov/.test(st(s, 'BK-24066').detail));
}

sec('3. The board and the money');
{
  const s = fresh();
  const b = E.board(s);
  ok('11 bookings need action', b.need.length === 11, b.need.length);
  ok('red items come first, then amber', b.rows[0].status.level === 'bad' && b.rows[4].status.level === 'warn' && b.rows[3].status.level === 'bad');
  const c = E.cash(s);
  ok('172,500 XPF received in the last 7 days', c.receivedWeek === 172500, c.receivedWeek);
  ok('232,500 XPF unpaid on upcoming trips, 137,500 of it in the next 7 days', c.unpaidUpcoming === 232500 && c.unpaidWeek === 137500, c);
  ok('16,500 XPF overdue on a trip already done', c.overdue === 16500);
  ok('61,000 XPF of refunds due', c.refundsDue === 61000);
  ok('10 trips in the next 14 days, 45% of their value paid', c.trips === 10 && c.paidPct === 45, c);
}

sec('4. Reminders, in the customer\'s language');
{
  const s = fresh();
  const r = E.remindersDue(s);
  ok('2 reminders due today: BK-24058 (3-day stage) and BK-24063 (7-day stage)', r.length === 2 && r[0].booking.id === 'BK-24058' && r[0].stage === 3 && r[1].stage === 7);
  ok('the French reminder uses the French date and spacing', /mercredi 28 octobre/.test(r[0].text) && /48 000 XPF/.test(r[0].text) && /n'est pas encore réglée/.test(r[0].text));
  ok('the English reminder uses the English date', /Mon 2 Nov \(2 guests\)/.test(r[1].text) && /28,000 XPF/.test(r[1].text));
  const res = E.sendReminder(s, 'BK-24058');
  ok('sending it records the stage and the booking waits', res.ok && code(s, 'BK-24058') === 'UNPAID_REMINDED');
  ok('the same reminder cannot go twice', !E.sendReminder(s, 'BK-24058').ok);
  ok('a booking with nothing due cannot be reminded', !E.sendReminder(s, 'BK-24051').ok);
  ok('the English message can be drafted for a French customer on request', /^Hi Hinano/.test(E.message(s, s.bookings.find((b) => b.id === 'BK-24058'), 'reminder', 'en')));
  const s3 = fresh();
  const en = E.sendReminder(s3, 'BK-24058', 'en');
  ok('and sent in English when chosen, which the log records', en.ok && en.lang === 'en' && /^Hi Hinano/.test(en.text) && /EN\) sent to Hinano/.test(s3.log[0]));
}

sec('5. Fixes that write back');
{
  const s = fresh();
  ok('marking INV-0421 paid moves BK-24055 on to the Bookeo step', E.markXeroPaid(s, 'BK-24055').ok && code(s, 'BK-24055') === 'PAID_BOOKEO_UNPAID');
  ok('marking Bookeo paid finishes it', E.markBookeoPaid(s, 'BK-24055').ok && code(s, 'BK-24055') === 'OK');
  ok('an unpaid booking cannot be marked paid in Xero', /Not fully paid/.test(E.markXeroPaid(s, 'BK-24058').problems.join()));
  const inv = E.createInvoice(s, 'BK-24064');
  ok('the missing invoice for BK-24064 is created as INV-0439 and it waits', inv.ok && inv.number === 'INV-0439' && code(s, 'BK-24064') === 'UNPAID_WAITING');
  ok('a second invoice is refused', !E.createInvoice(s, 'BK-24064').ok);
  const nl = E.sendNewLink(s, 'BK-24060');
  ok('a new link replaces the expired one and counts as this stage\'s reminder', nl.ok && nl.id === 'PZ-88232' && code(s, 'BK-24060') === 'UNPAID_REMINDED');
  ok('the new-link message says the link expired', /lien de paiement a expiré/.test(nl.text));
  const rf = E.sendNewLink(s, 'BK-24076');
  ok('for a refused card it says the card was refused, not that the new link failed', rf.ok && /carte a été refusée/.test(rf.text));
  ok('a second link while one is open is refused', /already open/.test(E.sendNewLink(s, 'BK-24060').problems.join()));
  ok('voiding before refunding is refused', /Refund the 19,000 XPF first/.test(E.voidInvoice(s, 'BK-24067').problems.join()));
  ok('recording the refund leaves the open invoice to void', E.recordRefund(s, 'BK-24067').ok && code(s, 'BK-24067') === 'CANCELLED_INVOICE_OPEN');
  ok('voiding it clears the cancellation', E.voidInvoice(s, 'BK-24067').ok && code(s, 'BK-24067') === 'CANCELLED_CLEAR');
  ok('refunding the double payment leaves BK-24070 paid and matched', E.recordRefund(s, 'BK-24070').ok && code(s, 'BK-24070') === 'OK');
  ok('no refund on a booking that is fine', !E.recordRefund(s, 'BK-24051').ok);
  const bal = E.sendNewLink(s, 'BK-24069');
  ok('the balance link is for 12,000 XPF', bal.ok && s.payments.find((p) => p.id === bal.id).amount === 12000 && /merci pour votre acompte|thanks for your deposit/.test(bal.text));
  ok('when the customer pays it, the booking is paid and matched', E.customerPays(s, bal.id).ok && code(s, 'BK-24069') === 'OK');
  ok('every one of the 10 actions is logged', s.log.length === 10, s.log.length);
}

sec('6. Payments that arrive, with and without the sync working');
{
  const s = fresh();
  ok('a normal payment marks Xero and Bookeo too (BK-24058 is matched at once)', E.customerPays(s, 'PZ-88205').ok && code(s, 'BK-24058') === 'OK');
  ok('a payment whose sync fails is caught as "open in Xero" (BK-24063)', E.customerPays(s, 'PZ-88212', true).ok && code(s, 'BK-24063') === 'PAID_XERO_OPEN');
  ok('an expired link cannot be paid', /expired, not open/.test(E.customerPays(s, 'PZ-88207').problems.join()));
}

sec('7. Moving the clock');
{
  const s = fresh();
  E.advance(s, 3);
  ok('three days on, the unpaid sunset trip of the 28th is overdue', s.company.today === '2026-10-29' && code(s, 'BK-24058') === 'PAST_UNPAID');
  const s2 = fresh();
  E.advance(s2, 10);
  ok('on Thu 5 Nov the dive on the 12th reaches its 7-day reminder', code(s2, 'BK-24066') === 'REMINDER_DUE');
  ok('moving 0 or 40 days is refused', !E.advance(fresh(), 0).ok && !E.advance(fresh(), 40).ok);
}

sec('8. Adding a booking (what the existing automation does)');
{
  const s = fresh();
  const r = E.addBooking(s, { customer: '', email: 'not-an-email', activity: 'X', pax: 0, tripDate: '2026-10-01' });
  ok('name, email, activity, guests and a past date are all refused', !r.ok && r.problems.length === 5, r.problems);
  const ok2 = E.addBooking(s, { customer: 'Hanna Berg', email: 'hanna@example.com', lang: 'en', activity: 'DIVE', pax: 2, tripDate: '2026-10-29' });
  ok('a valid booking gets BK-24077, INV-0439 and link PZ-88232', ok2.ok && ok2.booking.id === 'BK-24077' && s.invoices.some((v) => v.number === 'INV-0439') && s.payments.some((p) => p.id === 'PZ-88232'));
  ok('its amount is the activity price times guests (33,000 XPF)', ok2.booking.amount === 33000);
  ok('a trip in 3 days is due its reminder straight away', code(s, 'BK-24077') === 'REMINDER_DUE');
}

sec('9. Tunable rules');
{
  const s = fresh();
  ok('reminder days 14 and 2 are accepted and sorted', E.setRules(s, { reminderDays: [2, 14] }).ok && s.rules.reminderDays.join() === '14,2');
  ok('with a 14-day stage, the whale trip 7 days out counts against the 14-day reminder', st(s, 'BK-24063').facts.stage === 14 && code(s, 'BK-24063') === 'REMINDER_DUE');
  E.setRules(s, { reminderDays: [5] });
  ok('with one 5-day reminder it waits instead, first reminder Wed 28 Oct', code(s, 'BK-24063') === 'UNPAID_WAITING' && /Wed 28 Oct/.test(st(s, 'BK-24063').detail));
  ok('repeated, zero or 40-day reminders are refused', !E.setRules(s, { reminderDays: [5, 5] }).ok && !E.setRules(s, { reminderDays: [0] }).ok && !E.setRules(s, { reminderDays: [40] }).ok);
  const t = fresh((d) => { d.payments.find((p) => p.id === 'PZ-88219').amount = 23950; });
  ok('a payment 50 XPF short is a part payment with no tolerance', code(t, 'BK-24069') === 'PART_PAID');
  E.setRules(t, { tolerance: 100 });
  ok('with a 100 XPF tolerance it counts as paid (and the open invoice shows)', code(t, 'BK-24069') === 'PAID_XERO_OPEN');
}

sec('10. Export');
{
  const s = fresh();
  const c = E.csv(s);
  ok('CSV has a header and 16 bookings', c.split('\n').length === 17 && /^Booking,Customer,Trip date/.test(c));
  ok('fields with commas are quoted', /"Received 84,000 XPF for a 42,000 XPF booking: refund 42,000 XPF."/.test(c));
}

console.log('\n' + (pass + fail) + ' checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
