import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-c-'))
process.env.DB_PATH = path.join(dir, 'league.db')
process.env.AUTH_DB_PATH = path.join(dir, 'auth.db') // never the real shared login database
// Never touch a real Stripe account from tests, whatever .env says.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
const sessions: { body: string }[] = []
globalThis.fetch = (async (url: string, init: { body: string }) => {
  assert.match(String(url), /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions/)
  sessions.push({ body: decodeURIComponent(init.body) })
  const n = sessions.length
  return new Response(JSON.stringify({ id: `cs_test_${n}`, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })
}) as typeof fetch

const L = await import('../src/lib/league.js')
const D = await import('../src/lib/drafts.js')
const C = await import('../src/lib/campaigns.js')
const { verifyStripeSignature } = await import('../src/lib/stripe.js')
const { db } = await import('../src/db.js')
const { addContact } = await import('../src/lib/contacts.js')
const A = 'test'
const base = 'https://league.test'

let cid = ''
const pub = () => C.publicCampaign('2027-spring')
const off = (name: string) => pub().offerings.find((o) => o.name === name)!.id
const item = (name: string) => pub().items.find((i) => i.name === name)!.id
const q = (label: string) => pub().questions.find((x) => x.label.startsWith(label))!.id
const enr = (name: string) => db.prepare(`SELECT e.* FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = '2027' AND k.name = ?`).get(name) as L.Enrollment
const family = (players: object[], extra: Record<string, unknown> = {}) => ({
  guardian: { firstName: 'Pat', lastName: 'Parent', email: 'pat@example.com', phone: '555-123-4567' },
  answers: { [q('I agree')]: true, ...extra }, players,
})
const kid = (first: string, dob: string, program: string, items: Record<string, number> = {}) => ({
  firstName: first, lastName: 'Kid', birthdate: dob, offeringId: off(program), items,
  answers: { [q('Baseball experience')]: 'First season', [q('Shirt size')]: 'Youth M' },
})
const paid = (orderId: string, extra: Record<string, string> = {}) =>
  C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: C.order(orderId)?.stripe_session_id ?? 'x', payment_status: 'paid', payment_intent: `pi_${orderId}`, metadata: { order_id: orderId, ...extra } } } })

test('setup: 2027 divisions and a campaign built from them', () => {
  db.prepare(`INSERT INTO seasons (id, year) VALUES ('2027', 2027)`).run()
  L.saveDivision('2027', null, { key: 'tball', name: 'T-Ball', teams: 1, roster_size: 2, min_age: 5, max_age: 6 }, A)
  L.saveDivision('2027', null, { key: 'minors', name: 'Minors', teams: 1, roster_size: 10, min_age: 10, max_age: 12, group_key: '10-12', keep_teams: true }, A)
  L.saveDivision('2027', null, { key: 'majors', name: 'Majors', teams: 1, roster_size: 2, min_age: 10, max_age: 12, group_key: '10-12', keep_teams: true, se_match: '-' }, A)
  D.saveDraft('2027', L.divisionByKey('2027', 'minors')!.id, {}, A)
  D.saveDraft('2027', L.divisionByKey('2027', 'majors')!.id, { nextId: D.draftByKey('2027', 'minors')!.id }, A)
  const c = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027' }, A)
  cid = c.id
  assert.equal(c.slug, '2027-spring')
  C.seedDefaults(cid, A)
  assert.equal(C.programsFromSeason(cid, A), 2)
  assert.deepEqual(C.offerings(cid).map((o) => o.name), ['T-Ball', 'Major/Minor'])
  // A draft campaign is invisible to families and refuses checkouts.
  assert.throws(() => C.publicCampaign('2027-spring'), /No registration here/)
  assert.throws(() => C.quote('2027-spring', { guardian: { firstName: 'P', lastName: 'P', email: 'p@x.co', phone: '5551234567' }, answers: {}, players: [] }), /hasn’t opened/)
  C.saveCampaign(cid, { name: '2027 Spring', status: 'open' }, A)
  assert.deepEqual(pub().items.map((i) => [i.name, i.price_cents, i.required, i.max_qty]), [['Registration fee', 20000, true, 1], ['LFUCG', 500, true, 1], ['Value card', 6000, false, 1]])
  // While Stripe is in test mode, an admin can try a draft form end to end; families still can't.
  const al = family([kid('Al', '2016-03-01', 'Major/Minor')])
  C.saveCampaign(cid, { name: '2027 Spring', status: 'draft' }, A)
  assert.equal(C.publicCampaign('2027-spring', true).campaign.closedReason, null)
  assert.equal(C.quote('2027-spring', al, true).total, 20500)
  assert.throws(() => C.quote('2027-spring', al), /hasn’t opened/)
  C.saveCampaign(cid, { name: '2027 Spring', status: 'open' }, A)
})

test('validation: waiver, required answers, age fit, duplicate kids', () => {
  assert.throws(() => C.quote('2027-spring', { ...family([kid('Al', '2016-03-01', 'Major/Minor')]), answers: {} }), /agree/)
  assert.throws(() => C.quote('2027-spring', family([{ ...kid('Al', '2016-03-01', 'Major/Minor'), answers: {} }])), /Baseball experience/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2021-03-01', 'Major/Minor')])), /league age 6.*ages 10–12/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2016-03-01', 'Major/Minor'), kid('Al', '2016-03-01', 'Major/Minor')])), /listed twice/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2016-03-01', 'Major/Minor', { [item('Value card')]: 2 })])), /up to 1/)
})

test('checkout: fees per kid, required fee forced, Stripe session created', async () => {
  const r = await C.startCheckout('2027-spring', family([
    kid('Ann', '2016-03-01', 'Major/Minor', { [item('Value card')]: 1 }),
    kid('Ben', '2021-03-01', 'T-Ball', { [item('Registration fee')]: 0 }),
  ]), base)
  assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1')
  const o = C.order(r.orderId)!
  assert.equal(o.status, 'pending')
  assert.equal(o.total_cents, 20000 + 500 + 6000 + 20000 + 500)
  assert.match(sessions[0]!.body, /line_items\[0\]\[price_data\]\[unit_amount\]=20000/)
  assert.match(sessions[0]!.body, /success_url=https:\/\/league\.test\/register\/2027-spring\/done\?order=/)
  // Nothing is placed until Stripe says it's paid.
  assert.equal(enr('Ann Kid'), undefined)
  cid && assert.equal(C.adminCampaign(cid).totals.pending, 1)
  ;(globalThis as Record<string, unknown>).annOrder = r.orderId
})

test('payment confirmed: kids are Registered in their division, Major/Minor kids try out for Majors', () => {
  const orderId = (globalThis as Record<string, unknown>).annOrder as string
  paid(orderId)
  paid(orderId) // Stripe retries — nothing doubles
  assert.equal(C.order(orderId)!.status, 'paid')
  const ann = enr('Ann Kid')
  assert.equal(ann.status, 'Registered')
  assert.equal(ann.division_id, L.divisionByKey('2027', 'minors')!.id)
  assert.equal(ann.tryout, 1)
  assert.equal(ann.draft_id, D.draftByKey('2027', 'majors')!.id)
  assert.equal(enr('Ben Kid').division_id, L.divisionByKey('2027', 'tball')!.id)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE season_id = '2027'`).get() as { n: number }).n, 2)
  const reg = db.prepare(`SELECT * FROM registrations WHERE source = 'web' AND first_name = 'Ann'`).get() as { note: string; outcome: string }
  assert.match(reg.note, /LFUCG, Value card$/)
  assert.throws(() => C.quote('2027-spring', family([kid('Ann', '2016-03-01', 'Major/Minor')])), /already registered/)
})

test('an expected returner who registers flips to Registered on their team', async () => {
  const k = L.createKid('Ret Kid', '2015-06-01')
  const team = L.saveTeam(L.divisionByKey('2027', 'majors')!.id, null, { name: 'Reds' }, A)
  L.enroll('2027', k.id, { divisionId: L.divisionByKey('2027', 'majors')!.id, teamId: team.id, returner: true }, A)
  const r = await C.startCheckout('2027-spring', family([kid('Ret', '2015-06-01', 'Major/Minor')]), base)
  paid(r.orderId)
  const e = enr('Ret Kid')
  assert.equal(e.status, 'Registered')
  assert.equal(e.team_id, team.id)
  assert.equal(e.tryout, 0)
})

// A program's own limit on new players (division seats don't decide it).
const setSpots = (name: string, spots: number | null, whenFull?: 'waitlist' | 'close') => {
  const o = C.offerings(cid).find((x) => x.name === name)!
  C.saveOffering(cid, o.id, { name: o.name, division_id: o.division_id, min_age: o.min_age, max_age: o.max_age, capacity: spots, reg_mode: o.reg_mode, when_full: whenFull }, A)
}
test('full program: free waitlist, no charge, not draftable; an offered spot registers when paid', async () => {
  // T-Ball takes 2 new players; Ben has one spot.
  setSpots('T-Ball', 2)
  await C.startCheckout('2027-spring', family([kid('Cal', '2021-02-01', 'T-Ball')]), base).then((r) => paid(r.orderId))
  assert.equal(pub().offerings.find((o) => o.name === 'T-Ball')!.full, true)
  const before = sessions.length
  const r = await C.startCheckout('2027-spring', family([kid('Dee', '2021-01-01', 'T-Ball')]), base)
  assert.equal(sessions.length, before, 'no Stripe session for a waitlist-only order')
  assert.equal(C.order(r.orderId)!.status, 'waitlisted')
  assert.equal(enr('Dee Kid').status, 'Waitlist')
  assert.equal(L.seasonState('2027', false).divisions.find((d) => d.key === 'tball')!.seats.waitlist, 1)
  const pid = (db.prepare(`SELECT id FROM order_players WHERE first_name = 'Dee'`).get() as { id: string }).id
  await assert.rejects(C.offerSpot(pid, 5, base, A), /how long/)
  const offer = await C.offerSpot(pid, 48, base, A)
  // Our own pay link with a deadline; Stripe is only asked when the family opens it.
  assert.match(offer.url!, /^https:\/\/league\.test\/register\/2027-spring\/spot\//)
  assert.equal(offer.emailed, null, 'email is not set up in tests')
  const hrs = (Date.parse(offer.expiresAt!) - Date.now()) / 3600e3
  assert.ok(hrs > 47.9 && hrs <= 48)
  const token = offer.url!.split('/').at(-1)!
  const n = sessions.length
  assert.match(await C.payOffer('2027-spring', token, base), /checkout\.stripe\.com/)
  assert.equal(sessions.length, n + 1)
  assert.match(sessions.at(-1)!.body, /metadata\[order_player_id\]=/)
  // A Stripe checkout left unfinished doesn't end the offer; the deadline does.
  C.handleStripeEvent({ type: 'checkout.session.expired', data: { object: { id: `cs_test_${n + 1}`, metadata: { order_id: r.orderId, order_player_id: pid } } } })
  assert.equal((db.prepare('SELECT status FROM order_players WHERE id = ?').get(pid) as { status: string }).status, 'offered')
  await assert.rejects(C.payOffer('2027-spring', 'nope', base), /isn’t valid/)
  paid(r.orderId, { order_player_id: pid })
  assert.equal(enr('Dee Kid').status, 'Registered')
  assert.equal(C.order(r.orderId)!.total_cents, 20500)
  // Paid already: the link just shows the confirmation.
  assert.match(await C.payOffer('2027-spring', token, base), /\/done\?order=/)
})

test('waitlist only, first come first served, expired offers, removing a family', async () => {
  const tball = () => C.offerings(cid).find((o) => o.name === 'T-Ball')!
  const save = (mode: 'open' | 'waitlist' | 'closed') => { const o = tball(); C.saveOffering(cid, o.id, { name: o.name, division_id: o.division_id, min_age: o.min_age, max_age: o.max_age, capacity: o.capacity, reg_mode: mode }, A) }
  const sort = tball().sort
  // Ben, Cal and Dee hold three seats; a fourth opens. Gus is waiting, so it's Gus's, not the next signup's.
  setSpots('T-Ball', 4)
  assert.equal(C.availability(tball()).open, 1)
  save('waitlist')
  assert.equal(tball().sort, sort, 'saving a row keeps its order')
  assert.equal(tball().active, 1)
  const pubT = () => pub().offerings.find((o) => o.name === 'T-Ball')!
  assert.equal(pubT().full, true, 'waitlist only, though a seat is open')
  const g = await C.startCheckout('2027-spring', family([kid('Gus', '2021-03-01', 'T-Ball')]), base)
  assert.equal(C.order(g.orderId)!.status, 'waitlisted')
  save('open')
  assert.equal(C.availability(tball()).open, 0)
  assert.equal(pubT().full, true, 'the open seat is Gus’s: he is first in line')
  const h = await C.startCheckout('2027-spring', family([kid('Hal', '2021-04-01', 'T-Ball')]), base)
  assert.equal(C.order(h.orderId)!.status, 'waitlisted')
  const w = C.adminCampaign(cid).waitlist.find((x) => x.program === 'T-Ball')!
  assert.deepEqual(w.players.map((p) => [p.pos, p.name]), [[1, 'Gus Kid'], [2, 'Hal Kid']])
  // Gus's offer lapses.
  const gus = w.players[0]!.id
  const offer = await C.offerSpot(gus, 24, base, A)
  db.prepare(`UPDATE order_players SET offer_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(gus)
  assert.equal(C.adminCampaign(cid).waitlist.find((x) => x.program === 'T-Ball')!.players[0]!.status, 'expired')
  await assert.rejects(C.payOffer('2027-spring', offer.url!.split('/').at(-1)!, base), /expired/)
  // Removing him frees his place: Hal moves to #1 and his enrollment is withdrawn.
  C.removeFromWaitlist(gus, A)
  assert.equal(enr('Gus Kid').status, 'Withdrawn')
  assert.equal(C.order(g.orderId)!.status, 'cancelled')
  assert.deepEqual(C.adminCampaign(cid).waitlist.find((x) => x.program === 'T-Ball')!.players.map((p) => [p.pos, p.name]), [[1, 'Hal Kid']])
  assert.equal(pubT().full, true, 'still Hal’s seat')
  C.removeFromWaitlist(C.adminCampaign(cid).waitlist[0]!.players[0]!.id, A)
  assert.equal(pubT().full, false, 'nobody waiting: the open seat is for anyone')
  save('closed')
  assert.equal(pub().offerings.some((o) => o.name === 'T-Ball'), false)
  await assert.rejects(C.startCheckout('2027-spring', family([{ ...kid('Ivy', '2021-05-01', 'Major/Minor'), offeringId: tball().id }]), base), /pick a division/)
  save('open')
  setSpots('T-Ball', 2)
  // Full (over, even) — but a returner expected back in T-Ball already holds a seat, so they pay and register.
  const rae = L.createKid('Rae Kid', '2021-06-01')
  L.enroll('2027', rae.id, { divisionId: L.divisionByKey('2027', 'tball')!.id, returner: true }, A)
  assert.equal(pubT().full, true)
  const r = await C.startCheckout('2027-spring', family([kid('Rae', '2021-06-01', 'T-Ball'), kid('Sid', '2021-07-01', 'T-Ball')]), base)
  assert.equal(C.order(r.orderId)!.total_cents, 20500, 'Rae pays; Sid, new, is waitlisted')
  paid(r.orderId)
  assert.equal(enr('Rae Kid').status, 'Registered')
  assert.equal(enr('Sid Kid').status, 'Waitlist')
  // The Registration tab counts this registration's new and returning players separately.
  const t = C.adminCampaign(cid).offerings.find((o) => o.name === 'T-Ball')!
  assert.deepEqual([t.new_registered, t.returning_registered, t.waitlisted], [3, 1, 1])
})

test('per-program limits: one program can stop when full while the others keep going', async () => {
  // T-Ball is full and stops taking new players: no waitlist, a clear message.
  setSpots('T-Ball', 2, 'close')
  assert.equal(pub().offerings.find((o) => o.name === 'T-Ball')!.waitlist, false)
  await assert.rejects(C.startCheckout('2027-spring', family([kid('Tia', '2021-08-01', 'T-Ball')]), base), /T-Ball is full for 2027 and isn’t taking more/)
  // A returner expected back still gets in — their seat is held.
  const ray = L.createKid('Ray Kid', '2021-09-01')
  L.enroll('2027', ray.id, { divisionId: L.divisionByKey('2027', 'tball')!.id, returner: true }, A)
  const r = await C.startCheckout('2027-spring', family([kid('Ray', '2021-09-01', 'T-Ball')]), base)
  assert.equal(C.order(r.orderId)!.status, 'pending')
  // Major/Minor has no limit: never full, whatever the division seats say.
  setSpots('Major/Minor', null)
  assert.equal(pub().offerings.find((o) => o.name === 'Major/Minor')!.full, false)
  setSpots('T-Ball', 2, 'waitlist')
})

test('abandoned checkout is cancelled when Stripe expires the session', async () => {
  const r = await C.startCheckout('2027-spring', family([kid('Eve', '2016-01-01', 'Major/Minor')]), base)
  C.handleStripeEvent({ type: 'checkout.session.expired', data: { object: { id: C.order(r.orderId)!.stripe_session_id!, metadata: { order_id: r.orderId } } } })
  assert.equal(C.order(r.orderId)!.status, 'cancelled')
  assert.equal(enr('Eve Kid'), undefined)
})

test('refund is flagged for an admin, not acted on', async () => {
  const orderId = (globalThis as Record<string, unknown>).annOrder as string
  C.handleStripeEvent({ type: 'charge.refunded', data: { object: { payment_intent: `pi_${orderId}`, amount: 68000, amount_refunded: 68000 } } })
  assert.equal(C.order(orderId)!.status, 'refunded')
  assert.equal(enr('Ann Kid').status, 'Registered')
})

test('SportsEngine export: one row per kid with purchases and answers; synced flag filters', () => {
  const rows = C.exportRows(cid, false)
  const h = rows[0]!
  // Refunded and cancelled orders are left out (Ann and Ben's order was refunded above).
  assert.equal(rows.find((r) => r[4] === 'Ben'), undefined)
  const cal = rows.find((r) => r[4] === 'Cal')!
  assert.equal(cal[h.indexOf('Program')], 'T-Ball')
  assert.equal(cal[h.indexOf('Registration fee')], 1)
  assert.equal(cal[h.indexOf('LFUCG')], 1)
  assert.equal(cal[h.indexOf('Amount paid')], '205.00')
  assert.equal(cal[h.indexOf('Shirt size')], 'Youth M')
  assert.equal(cal[h.indexOf('I agree to the league’s participation waiver and code of conduct')], 'Yes')
  const ids = C.adminCampaign(cid).orders.filter((o) => o.status === 'paid').map((o) => o.id)
  C.markSynced(ids, true, A)
  assert.equal(C.exportRows(cid, true).length, 1) // just the header: everything paid is now marked as entered in SportsEngine
})

test('Stripe webhook signatures', () => {
  const raw = Buffer.from('{"id":"evt_1"}'), t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.`).update(raw).digest('hex')
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'whsec_test'), true)
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'whsec_other'), false)
  assert.equal(verifyStripeSignature(raw, `t=${t - 600},v1=${sig}`, 'whsec_test'), false)
})

test('returning players: matched from last season, confirmed by the family, kept on one record', async () => {
  // 2026: the only records are names without birthdates (like the imported Majors rosters).
  db.prepare(`INSERT INTO seasons (id, year, status) VALUES ('2026', 2026, 'complete')`).run()
  const maj26 = L.saveDivision('2026', null, { key: 'majors', name: 'Majors', teams: 1, roster_size: 12, min_age: 10, max_age: 12 }, A)
  const astros = L.saveTeam(L.divisionByKey('2026', 'majors')!.id, null, { name: 'Astros' }, A)
  void maj26
  const sam = L.createKid('Sam Old', null)
  L.enroll('2026', sam.id, { divisionId: L.divisionByKey('2026', 'majors')!.id, teamId: astros.id, status: 'Registered' }, A)
  const will = L.createKid('Will Dob', '2015-02-02')
  L.enroll('2026', will.id, { divisionId: L.divisionByKey('2026', 'majors')!.id, teamId: astros.id, status: 'Registered' }, A)
  const tom = L.createKid('Tom Twin', null)
  L.enroll('2026', tom.id, { divisionId: L.divisionByKey('2026', 'majors')!.id, teamId: astros.id, status: 'Registered' }, A)
  // Sam is expected back on his Majors team in 2027.
  L.enroll('2027', sam.id, { divisionId: L.divisionByKey('2027', 'majors')!.id, returner: true }, A)
  const c = C.mustCampaign(cid)

  const m = C.returningMatches(c, 'Sam', 'Old', '2015-05-01')
  assert.deepEqual(m.map((x) => [x.name, x.division, x.team, x.year]), [['Sam Old', 'Majors', 'Astros', 2026]])
  assert.equal(m[0]!.suggestOfferingId, off('Major/Minor'))
  assert.deepEqual(C.returningMatches(c, 'Sam', 'Old', '2020-05-01'), [], 'a 5-year-old Sam Old is not the 2026 Majors player')
  assert.deepEqual(C.returningMatches(c, 'William', 'Dob', '2015-02-02').map((x) => x.name), ['Will Dob'], 'same birthdate + last name')
  // Same name, different birthdate: still asked (the dates can be wrong), but nothing about their team or program.
  const diff = C.returningMatches(c, 'Will', 'Dob', '2015-02-03')
  assert.equal(diff.length, 1)
  assert.equal(diff[0]!.dobDiffers, true)
  assert.equal(diff[0]!.team, null)
  assert.equal(diff[0]!.division, null)
  assert.deepEqual(C.returningMatches(c, 'Newbie', 'Kid', '2015-05-01'), [])
  // Near misses on the birthdate still ask; a different kid's birthdate doesn't.
  for (const d of ['2015-02-05', '2015-04-02', '2016-02-02', '2015-01-30', '2015-01-03', '2016-03-02']) assert.equal(C.returningMatches(c, 'Will', 'Dob', d).length, 1, `close: ${d}`)
  for (const d of ['2015-02-20', '2015-08-02', '2013-02-02', '2016-06-14', '2016-03-03']) assert.deepEqual(C.returningMatches(c, 'Will', 'Dob', d), [], `not close: ${d}`)
  // Same last name + birthdate, a first name that's a near miss: a full match (team and all).
  for (const f of ['Wil', 'Willy', 'Wiill']) assert.deepEqual(C.returningMatches(c, f, 'Dob', '2015-02-02').map((x) => [x.name, x.team, x.dobDiffers]), [['Will Dob', 'Astros', false]], f)
  // …but a brother or sister with the same birthdate (a twin) is not.
  assert.deepEqual(C.returningMatches(c, 'Grace', 'Dob', '2015-02-02'), [])
  assert.ok(C.firstClose('jack', 'john') && C.firstClose('zack', 'zach') && !C.firstClose('ava', 'mia'))
  assert.ok(C.dobClose('2015-03-04', '2015-04-03'), 'day and month swapped')
  // Brothers and sisters: found through the parent's email or phone on file — also when the family
  // confirmed a near-miss birthdate — and never for someone who doesn't know the parent's contact.
  const grace = L.createKid('Grace Dob', '2015-09-09')
  L.enroll('2026', grace.id, { divisionId: L.divisionByKey('2026', 'majors')!.id, teamId: astros.id, status: 'Registered' }, A)
  for (const k of [will.id, grace.id]) addContact(k, { name: 'Pat Dob', email: 'pat.dob@example.com', phone: '859-555-0101' }, 'import')
  const sibs = (dob: string, email: string, phone = '') => C.siblingMatches(c, 'Will', 'Dob', dob, email, phone).map((x) => x.firstName)
  assert.deepEqual(sibs('2015-02-02', 'pat.dob@example.com'), ['Grace'])
  assert.deepEqual(sibs('2015-03-03', 'PAT.DOB@example.com'), ['Grace'], 'near-miss birthdate, parent email on file')
  assert.deepEqual(sibs('2015-02-02', '', '(859) 555-0101'), ['Grace'], 'or the parent phone')
  assert.deepEqual(sibs('2015-02-02', 'someone@example.com'), [], 'not their parent')
  assert.deepEqual(sibs('2019-08-08', 'pat.dob@example.com'), [], 'not the player')

  // Parent first: their email → a code by email → their players. Nothing about the kids before the code.
  const { config } = await import('../src/config.js')
  const F = await import('../src/lib/family.js')
  const O = await import('../src/lib/outreach.js')
  void O
  L.enroll('2027', grace.id, { divisionId: L.divisionByKey('2027', 'majors')!.id, returner: true }, A)
  assert.equal(F.familyKnown(c, 'pat.dob@example.com'), false, 'email not set up: no look-up')
  const realFetch = globalThis.fetch, mails: string[] = []
  Object.assign(config.mail, { resendApiKey: 're_test', from: 'League <x@example.com>' })
  globalThis.fetch = (async (_u: string, init: { body: string }) => { mails.push(init.body); return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }) }) as typeof fetch
  try {
    assert.equal(F.familyKnown(c, ' Pat.Dob@Example.com '), true)
    assert.equal(F.familyKnown(c, 'stranger@example.com'), false)
    Object.assign(config.mail, { from: 'League <onboarding@resend.dev>' })
    assert.equal(F.familyKnown(c, 'pat.dob@example.com'), false, 'Resend’s test sender can’t reach families')
    assert.equal(F.familyKnown(c, 'pat.dob@example.com', true), true, '…but an admin previewing can try it')
    Object.assign(config.mail, { from: 'League <x@example.com>' })
    assert.deepEqual(await F.sendFamilyCode(c, 'stranger@example.com'), { sent: false }, 'no email to addresses we don’t know')
    assert.equal(mails.length, 0)
    assert.deepEqual(await F.sendFamilyCode(c, 'pat.dob@example.com'), { sent: true })
    const code = /is (\d{6})/.exec(JSON.parse(mails[0]!)[0].text)![1]!
    assert.throws(() => F.verifyFamilyCode(c, 'pat.dob@example.com', code === '000000' ? '111111' : '000000'), /doesn’t match/)
    const v = F.verifyFamilyCode(c, 'PAT.DOB@example.com', code)
    assert.equal(v.guardian.firstName, 'Pat')
    assert.deepEqual(v.kids.map((k) => [k.firstName, k.team, k.registered]), [['Will', 'Astros', false], ['Grace', 'Astros', false]])
    assert.throws(() => F.verifyFamilyCode(c, 'pat.dob@example.com', code), /expired/, 'a code works once')
    // "Not this year" from the form frees Grace's seat; a kid from another family can't be touched.
    F.familyIntent(c, v.token, grace.id, 'no')
    assert.equal((db.prepare(`SELECT status FROM enrollments WHERE season_id = '2027' AND kid_id = ?`).get(grace.id) as { status: string }).status, 'Not returning')
    F.familyIntent(c, v.token, grace.id, 'yes')
    assert.equal((db.prepare(`SELECT status FROM enrollments WHERE season_id = '2027' AND kid_id = ?`).get(grace.id) as { status: string }).status, 'Expected')
    assert.throws(() => F.familyIntent(c, v.token, sam.id, 'no'), /isn’t on this family/)
    assert.throws(() => F.familyIntent(c, 'not-a-token', grace.id, 'no'), /expired/)
    // At most 3 codes per 15 minutes per email.
    await F.sendFamilyCode(c, 'pat.dob@example.com'); await F.sendFamilyCode(c, 'pat.dob@example.com')
    await assert.rejects(F.sendFamilyCode(c, 'pat.dob@example.com'), /a few codes already/)
  } finally {
    globalThis.fetch = realFetch
    Object.assign(config.mail, { resendApiKey: '', from: '' })
  }

  const samP = { ...kid('Sam', '2015-05-01', 'Major/Minor'), lastName: 'Old' }
  assert.throws(() => C.quote('2027-spring', family([samP])), /played in 2026/)
  assert.throws(() => C.quote('2027-spring', family([{ ...samP, returning: tom.id }])), /re-check/)

  const kids = () => (db.prepare('SELECT COUNT(*) n FROM kids').get() as { n: number }).n
  const n0 = kids()
  // A confirmed returner isn't asked the new-player questions (baseball experience, last team).
  const noExp = { ...samP, answers: { [q('Shirt size')]: 'Youth M' } }
  assert.throws(() => C.quote('2027-spring', family([{ ...noExp, returning: 'new' }])), /Baseball experience/)
  const r = await C.startCheckout('2027-spring', family([{ ...noExp, returning: sam.id }]), base)
  paid(r.orderId)
  assert.equal(kids(), n0, 'no duplicate kid')
  assert.equal(L.kid(sam.id)!.birthdate, '2015-05-01', 'the birthdate is learned for next year')
  const e = db.prepare(`SELECT * FROM enrollments WHERE season_id = '2027' AND kid_id = ?`).get(sam.id) as L.Enrollment
  assert.equal(e.status, 'Registered')
  assert.equal(L.kidHistory(sam.id).seasons.length, 2)
  assert.deepEqual(C.returningMatches(c, 'Sam', 'Old', '2016-05-01').map((x) => [x.dobDiffers, x.team]), [[true, null]], 'now that we know his birthdate, a different one is only a “same player?” question')

  // "No, that's not my kid": a new record, never merged into the 2026 Tom.
  const t = await C.startCheckout('2027-spring', family([{ ...kid('Tom', '2015-07-07', 'Major/Minor'), lastName: 'Twin', returning: 'new' }]), base)
  paid(t.orderId)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM kids WHERE name_key = 'tom twin'`).get() as { n: number }).n, 2)
  assert.equal(L.kid(tom.id)!.birthdate, null)
  const row = C.exportRows(cid, false).find((x) => x[4] === 'Tom')!
  assert.equal(row[C.exportRows(cid, false)[0]!.indexOf('Played last season')], 'No (family said new)')
})

test('Majors tryouts by where the player stands: Majors returner, Minors returner, up from the 9s, new', async () => {
  const c = C.mustCampaign(cid)
  const div = (s: string, k: string) => L.divisionByKey(s, k)!.id
  L.saveDivision('2026', null, { key: 'nine', name: '9-Year-Old League', teams: 1, roster_size: 12, min_age: 9, max_age: 9 }, A)
  L.saveDivision('2026', null, { key: 'minors', name: 'Minors', teams: 1, roster_size: 12, min_age: 10, max_age: 12 }, A)
  const t26 = (k: string, name: string) => L.saveTeam(div('2026', k), null, { name }, A).id
  const cubs = L.saveTeam(div('2027', 'minors'), null, { name: 'Cubs' }, A).id
  const reds = L.divisionTeams(div('2027', 'majors')).find((t) => t.name === 'Reds')!.id
  const make = (name: string, dob: string, d26: string, team26: string, d27: string, team27: string | null) => {
    const k = L.createKid(`${name} Kid`, dob)
    L.enroll('2026', k.id, { divisionId: div('2026', d26), teamId: team26, status: 'Registered' }, A)
    L.enroll('2027', k.id, { divisionId: div('2027', d27), teamId: team27, returner: true, tryout: d27 === 'minors' }, A)
    if (d27 === 'minors' && team27) db.prepare('UPDATE enrollments SET team_id = NULL WHERE kid_id = ?').run(k.id) // rollover: assumed trying out
    return k.id
  }
  const maj = make('Max', '2015-04-04', 'majors', L.divisionTeams(div('2026', 'majors'))[0]!.id, 'majors', reds)
  const min = make('Mo', '2016-01-06', 'minors', t26('minors', 'Cubs'), 'minors', cubs)
  const ris = make('Ria', '2017-03-03', 'nine', t26('nine', 'Bats'), 'minors', null)
  assert.deepEqual([maj, min, ris].map((id) => C.groupCase(c, id)), ['majors', 'minors', 'rising'])
  assert.equal(C.returningMatches(c, 'Mo', 'Kid', '2016-01-06')[0]!.groupCase, 'minors')
  assert.equal(pub().offerings.find((o) => o.name === 'Major/Minor')!.tryout, 'group')
  assert.equal(pub().offerings.find((o) => o.name === 'Major/Minor')!.description, '', 'no blanket “tryouts” hint')

  const p = (first: string, dob: string, returning?: string, tryout?: boolean) => ({ ...kid(first, dob, 'Major/Minor'), answers: { [q('Shirt size')]: 'Youth M', [q('Baseball experience')]: 'First season' }, returning, tryout })
  const answer = (pl: object) => C.quote('2027-spring', family([pl])).players[0]!.answers[C.TRYOUT_ANSWER]
  // Back on a Majors team: nothing to answer.
  assert.equal(answer(p('Max', '2015-04-04', maj)), undefined)
  // Back on a Minors team: must choose.
  assert.throws(() => answer(p('Mo', '2016-01-06', min)), /try out for Majors/)
  assert.equal(answer(p('Mo', '2016-01-06', min, false)), false)
  // Up from the 9s: tryouts, and Majors-and-Minors or Minors only.
  assert.throws(() => answer(p('Ria', '2017-03-03', ris)), /considered for Majors/)
  assert.equal(answer(p('Ria', '2017-03-03', ris, false)), false)
  // New to the league: tryouts, no choice.
  assert.equal(answer(p('Nell', '2016-08-08')), true)
  assert.equal(answer(p('Nell', '2016-08-08', undefined, false)), true, 'a new player can’t opt out')

  // Mo stays with the Cubs: paid → back on the team, not in any draft.
  const r = await C.startCheckout('2027-spring', family([p('Mo', '2016-01-06', min, false)]), base)
  paid(r.orderId)
  const e = db.prepare(`SELECT * FROM enrollments WHERE season_id = '2027' AND kid_id = ?`).get(min) as L.Enrollment
  assert.deepEqual([e.status, e.tryout, e.team_id, e.draft_id], ['Registered', 0, cubs, null])
})

test('coaches: named with an email, told when a player registers, and see their division', async () => {
  const CO = await import('../src/lib/coaches.js')
  const { userByEmail } = await import('../src/lib/auth.js')
  const minors = L.divisionByKey('2027', 'minors')!.id, majors = L.divisionByKey('2027', 'majors')!.id
  const cubs = L.divisionTeams(minors).find((t) => t.name === 'Cubs')!
  assert.throws(() => L.saveTeam(minors, cubs.id, { name: 'Cubs', coach_email: 'not-an-email' }, A), /coach email/)
  L.saveTeam(minors, cubs.id, { name: 'Cubs', coach: 'Lee Coach', coach_email: 'Lee@Example.com', coach_phone: '555-0101' }, A)
  assert.equal(L.team(cubs.id)!.coach_email, 'lee@example.com')
  const reds = L.divisionTeams(majors).find((t) => t.name === 'Reds')!
  L.saveTeam(majors, reds.id, { name: 'Reds', coach: 'Rae Red', coach_email: 'rae@example.com' }, A)
  // A coach can sign in: they're added as a plain user.
  assert.equal(CO.ensureCoachUser('lee@example.com', 'Lee Coach'), true)
  assert.equal(userByEmail('lee@example.com')!.role, 'user')
  assert.equal(CO.ensureCoachUser('lee@example.com', 'Lee Coach'), false)
  // Majors and Minors coaches each see both divisions (one registration feeds both drafts).
  assert.deepEqual(CO.coachDivisions('2027', 'lee@example.com').map((d) => d.key), ['minors', 'majors'])
  assert.deepEqual(CO.coachSeasons('LEE@example.com'), ['2027'])
  const v = CO.coachView('2027', 'lee@example.com')
  assert.deepEqual(v.teams.map((t) => [t.name, t.division]), [['Cubs', 'Minors']])
  assert.ok(v.registered.some((p) => p.name === 'Mo Kid' && p.lastTeam === 'Cubs' && p.team === 'Cubs'))
  assert.ok(v.registered.every((p) => !('email' in p) && !('phone' in p)), 'no family contact details')
  assert.deepEqual(CO.coachView('2027', 'nobody@example.com').divisions, [])
  // The registration email: one per coach in the group, about the player, linking to their page.
  const mo = db.prepare(`SELECT e.id FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = '2027' AND k.name = 'Mo Kid'`).get() as { id: string }
  const mails = CO.registrationMail(mo.id)!
  assert.deepEqual(mails.map((m) => m.to).sort(), ['lee@example.com', 'rae@example.com'])
  const lee = mails.find((m) => m.to === 'lee@example.com')!
  assert.equal(lee.subject, 'New registration: Mo Kid — Minors')
  assert.match(lee.text, /^Hi Lee,/)
  assert.match(lee.text, /played for the Cubs \(Minors\) in 2026/)
  assert.match(lee.text, /Staying with the Cubs/)
  assert.match(lee.text, /\/coach$/m)
  assert.match(lee.text, /you coach the Cubs/)
  // A division can turn the emails off.
  const d = L.division(minors)!
  L.saveDivision('2027', minors, { ...d, keep_teams: !!d.keep_teams, closed: !!d.closed, notify_coaches: false }, A)
  assert.equal(CO.registrationMail(mo.id), null)
  L.saveDivision('2027', minors, { ...d, keep_teams: !!d.keep_teams, closed: !!d.closed, notify_coaches: true }, A)
})

test('coaches record what returners’ families said, and slot in last season’s players — only their own', async () => {
  const CO = await import('../src/lib/coaches.js')
  const O = await import('../src/lib/outreach.js')
  const div = (s: string, k: string) => L.divisionByKey(s, k)!.id
  const minors26 = div('2026', 'minors'), minors = div('2027', 'minors')
  const cubs26 = L.divisionTeams(minors26).find((t) => t.name === 'Cubs')!.id
  const cubs = L.divisionTeams(minors).find((t) => t.name === 'Cubs')!
  const lee = 'lee@example.com'
  // Last season's Cubs: one the rollover missed, and one on another team.
  const miss = L.createKid('Missed Cub', '2015-07-07')
  L.enroll('2026', miss.id, { divisionId: minors26, teamId: cubs26, status: 'Registered' }, A)
  const other = L.createKid('Other Team Kid', '2015-08-08')
  const bears26 = L.saveTeam(minors26, null, { name: 'Bears' }, A).id
  L.enroll('2026', other.id, { divisionId: minors26, teamId: bears26, status: 'Registered' }, A)

  // Search: last season's Cub can be added; another team's player can't.
  const hits = CO.coachCandidates('2027', lee, cubs.id, 'Cub')
  assert.equal(hits.find((h) => h.name === 'Missed Cub')!.blocked, '')
  assert.match(CO.coachCandidates('2027', lee, cubs.id, 'Other Team')[0]!.blocked, /Played for the Bears — ask the league/)
  assert.throws(() => CO.coachSlot('2027', lee, cubs.id, other.id), /ask the league/)
  assert.throws(() => CO.coachSlot('2027', 'rae@example.com', cubs.id, miss.id), /isn’t one of your teams/)
  CO.coachSlot('2027', lee, cubs.id, miss.id)
  const e = enr('Missed Cub') as L.Enrollment & { intent: string; intent_by: string }
  assert.deepEqual([e.status, e.returner, e.returning_team_id, e.division_id], ['Expected', 1, cubs.id, minors])
  let roster = CO.coachView('2027', lee).rosters.find((t) => t.id === cubs.id)!
  const p = roster.players.find((x) => x.name === 'Missed Cub')!
  assert.deepEqual([p.intent, p.addedByCoach], ['', true])

  // A coach's answer is stored as the coach's, and frees the seat on "not returning".
  CO.coachSetIntent('2027', lee, e.id, 'no')
  assert.deepEqual(Object.values(db.prepare('SELECT status, intent, intent_by FROM enrollments WHERE id = ?').get(e.id)!), ['Not returning', 'no', 'coach'])
  CO.coachSetIntent('2027', lee, e.id, 'yes')
  assert.equal(L.enrollment(e.id)!.status, 'Expected')
  assert.throws(() => CO.coachSetIntent('2027', 'rae@example.com', e.id, 'no'), /isn’t one of your teams/)

  // The family's own answer (interest check) is stored as theirs, and a coach can't overrule it.
  O.applyIntent('2027', miss.id, 'yes', 'family:parent@example.com')
  assert.equal((db.prepare('SELECT intent_by FROM enrollments WHERE id = ?').get(e.id) as { intent_by: string }).intent_by, 'family')
  assert.throws(() => CO.coachSetIntent('2027', lee, e.id, 'no'), /family already answered/)
  roster = CO.coachView('2027', lee).rosters.find((t) => t.id === cubs.id)!
  assert.deepEqual([roster.players.find((x) => x.name === 'Missed Cub')!.intent, roster.players.find((x) => x.name === 'Missed Cub')!.intentBy], ['yes', 'family'])

  // Undo a mistaken slot.
  CO.coachUnslot('2027', lee, e.id)
  assert.equal(L.enrollment(e.id)!.returning_team_id, null)
})
