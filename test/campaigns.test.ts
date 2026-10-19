import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-c-'))
process.env.DB_PATH = path.join(dir, 'league.db')
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
  assert.equal(C.publicCampaign('2027-spring', true).campaign.closedReason, 'Registration hasn’t opened yet.')
  assert.throws(() => C.quote('2027-spring', { guardian: { firstName: 'P', lastName: 'P', email: 'p@x.co', phone: '5551234567' }, answers: {}, players: [] }), /hasn’t opened/)
  C.saveCampaign(cid, { name: '2027 Spring', status: 'open' }, A)
  assert.deepEqual(pub().items.map((i) => [i.name, i.price_cents, i.required, i.max_qty]), [['Registration fee', 20000, true, 1], ['Value cards', 6000, false, 10], ['Volunteer fee', 10000, false, 1]])
})

test('validation: waiver, required answers, age fit, duplicate kids', () => {
  assert.throws(() => C.quote('2027-spring', { ...family([kid('Al', '2016-03-01', 'Major/Minor')]), answers: {} }), /agree/)
  assert.throws(() => C.quote('2027-spring', family([{ ...kid('Al', '2016-03-01', 'Major/Minor'), answers: {} }])), /Baseball experience/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2021-03-01', 'Major/Minor')])), /league age 6.*ages 10–12/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2016-03-01', 'Major/Minor'), kid('Al', '2016-03-01', 'Major/Minor')])), /listed twice/)
  assert.throws(() => C.quote('2027-spring', family([kid('Al', '2016-03-01', 'Major/Minor', { [item('Value cards')]: 11 })])), /up to 10/)
})

test('checkout: fees per kid, required fee forced, Stripe session created', async () => {
  const r = await C.startCheckout('2027-spring', family([
    kid('Ann', '2016-03-01', 'Major/Minor', { [item('Value cards')]: 3, [item('Volunteer fee')]: 1 }),
    kid('Ben', '2021-03-01', 'T-Ball', { [item('Registration fee')]: 0 }),
  ]), base)
  assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1')
  const o = C.order(r.orderId)!
  assert.equal(o.status, 'pending')
  assert.equal(o.total_cents, 20000 + 18000 + 10000 + 20000)
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
  assert.match(reg.note, /Value cards ×3, Volunteer fee/)
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

test('full program: free waitlist, no charge, not draftable; an offered spot registers when paid', async () => {
  // T-Ball: 1 team × 2 = 2 seats; Ben has one.
  await C.startCheckout('2027-spring', family([kid('Cal', '2021-02-01', 'T-Ball')]), base).then((r) => paid(r.orderId))
  assert.equal(pub().offerings.find((o) => o.name === 'T-Ball')!.full, true)
  const before = sessions.length
  const r = await C.startCheckout('2027-spring', family([kid('Dee', '2021-01-01', 'T-Ball')]), base)
  assert.equal(sessions.length, before, 'no Stripe session for a waitlist-only order')
  assert.equal(C.order(r.orderId)!.status, 'waitlisted')
  assert.equal(enr('Dee Kid').status, 'Waitlist')
  assert.equal(L.seasonState('2027', false).divisions.find((d) => d.key === 'tball')!.seats.waitlist, 1)
  const pid = (db.prepare(`SELECT id FROM order_players WHERE first_name = 'Dee'`).get() as { id: string }).id
  const offer = await C.offerSpot(pid, base, A)
  assert.match(offer.url!, /checkout\.stripe\.com/)
  assert.match(sessions.at(-1)!.body, /metadata\[order_player_id\]=/)
  paid(r.orderId, { order_player_id: pid })
  assert.equal(enr('Dee Kid').status, 'Registered')
  assert.equal(C.order(r.orderId)!.total_cents, 20000)
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
  assert.equal(cal[h.indexOf('Amount paid')], '200.00')
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
  assert.deepEqual(C.returningMatches(c, 'Will', 'Dob', '2015-02-03'), [], 'a recorded birthdate has to match')
  assert.deepEqual(C.returningMatches(c, 'Newbie', 'Kid', '2015-05-01'), [])

  const samP = { ...kid('Sam', '2015-05-01', 'Major/Minor'), lastName: 'Old' }
  assert.throws(() => C.quote('2027-spring', family([samP])), /played in 2026/)
  assert.throws(() => C.quote('2027-spring', family([{ ...samP, returning: tom.id }])), /re-check/)

  const kids = () => (db.prepare('SELECT COUNT(*) n FROM kids').get() as { n: number }).n
  const n0 = kids()
  const r = await C.startCheckout('2027-spring', family([{ ...samP, returning: sam.id }]), base)
  paid(r.orderId)
  assert.equal(kids(), n0, 'no duplicate kid')
  assert.equal(L.kid(sam.id)!.birthdate, '2015-05-01', 'the birthdate is learned for next year')
  const e = db.prepare(`SELECT * FROM enrollments WHERE season_id = '2027' AND kid_id = ?`).get(sam.id) as L.Enrollment
  assert.equal(e.status, 'Registered')
  assert.equal(L.kidHistory(sam.id).seasons.length, 2)
  assert.deepEqual(C.returningMatches(c, 'Sam', 'Old', '2016-05-01'), [], 'now that we know his birthdate, a different one doesn’t match')

  // "No, that's not my kid": a new record, never merged into the 2026 Tom.
  const t = await C.startCheckout('2027-spring', family([{ ...kid('Tom', '2015-07-07', 'Major/Minor'), lastName: 'Twin', returning: 'new' }]), base)
  paid(t.orderId)
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM kids WHERE name_key = 'tom twin'`).get() as { n: number }).n, 2)
  assert.equal(L.kid(tom.id)!.birthdate, null)
  const row = C.exportRows(cid, false).find((x) => x[4] === 'Tom')!
  assert.equal(row[C.exportRows(cid, false)[0]!.indexOf('Played last season')], 'No (family said new)')
})
