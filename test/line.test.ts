import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-l-'))
process.env.DB_PATH = path.join(dir, 'league.db')
process.env.AUTH_DB_PATH = path.join(dir, 'auth.db') // never the real shared login database
// Never touch a real Stripe account or send real email from tests, whatever .env says.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
process.env.RESEND_API_KEY = 're_fake'
process.env.MAIL_FROM = 'League <league@example.com>'

// A pretend Stripe + Resend. `decline` makes the next off-session charge fail.
const calls: { url: string; body: string }[] = []
const mails: { to: string[]; subject: string; text: string }[] = []
let decline = false
globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
  const u = String(url), body = init.body ? decodeURIComponent(init.body) : ''
  calls.push({ url: u, body })
  if (u.includes('/emails/batch')) { const m = JSON.parse(init.body!) as typeof mails; mails.push(...m); return new Response(JSON.stringify({ data: m.map((_, i) => ({ id: `em_${i}` })) }), { status: 200 }) }
  if (u.endsWith('/customers')) return new Response(JSON.stringify({ id: 'cus_line' }), { status: 200 })
  if (u.includes('/checkout/sessions')) return new Response(JSON.stringify({ id: `cs_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_${calls.length}`, status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })
  if (u.includes('/setup_intents/'))
    return new Response(JSON.stringify({ id: 'seti_1', status: 'succeeded', customer: 'cus_line', payment_method: { id: 'pm_line', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } }), { status: 200 })
  if (u.endsWith('/payment_intents')) {
    if (decline) return new Response(JSON.stringify({ error: { message: 'Your card was declined.' } }), { status: 402 })
    return new Response(JSON.stringify({ id: `pi_line_${calls.length}`, status: 'succeeded', amount: 1, customer: 'cus_line', payment_method: 'pm_line' }), { status: 200 })
  }
  throw new Error(`unexpected fetch ${u}`)
}) as typeof fetch

const L = await import('../src/lib/league.js')
const C = await import('../src/lib/campaigns.js')
const { db } = await import('../src/db.js')
const A = 'test'
const base = 'https://league.test'

let cid = ''
const rookie = () => C.offerings(cid).find((o) => o.name === 'Rookie')!
const pubRookie = () => C.publicCampaign('2027-spring').offerings.find((o) => o.name === 'Rookie')!
const fam = (first: string, kid: string) => ({
  guardian: { firstName: first, lastName: 'Parent', email: `${first.toLowerCase()}@example.com`, phone: '(555) 123-4567' }, answers: {},
  players: [{ firstName: kid, lastName: 'New', birthdate: '2019-09-15', offeringId: rookie().id, items: {}, answers: {} }],
})
const card = async (orderId: string) => {
  C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_x', mode: 'setup', status: 'complete', setup_intent: 'seti_1', metadata: { order_id: orderId } } } })
  await new Promise((res) => setTimeout(res, 20))
}
const op = (orderId: string) => db.prepare('SELECT * FROM order_players WHERE order_id = ?').get(orderId) as { id: string; status: string; charge_id: string | null; early_error: string }

test('setup: Rookie is spoken for — 10 seats, 10 returners (6 moving up from T-Ball, 4 staying)', () => {
  db.prepare(`INSERT INTO seasons (id, year) VALUES ('2027', 2027)`).run()
  L.saveDivision('2027', null, { key: 'tball', name: 'T-Ball', teams: 1, roster_size: 10, min_age: 5, max_age: 6 }, A)
  L.saveDivision('2027', null, { key: 'rookie', name: 'Rookie', teams: 1, roster_size: 10, min_age: 7, max_age: 8 }, A)
  const d = L.divisionByKey('2027', 'rookie')!
  for (let i = 0; i < 10; i++) {
    const k = L.createKid(`Ret${i} Kid`, `2019-0${(i % 9) + 1}-1${i % 9}`)
    const e = L.enroll('2027', k.id, { divisionId: d.id, returner: true }, A)
    db.prepare('UPDATE enrollments SET prior = ? WHERE id = ?').run(i < 6 ? `T-Ball · Reds (2026)` : `Rookie · Cubs (2026)`, e.id)
  }
  cid = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027', status: 'open' }, A).id
  C.programsFromSeason(cid, A)
  C.saveItem(cid, null, { name: 'Registration fee', price_cents: 20000, required: true }, A)
  assert.equal(rookie().protect_at, 0)
  assert.equal(C.availability(rookie()).phase, 'full', 'no seat left that a returner isn’t counting on')
})

test('anticipated churn: moving up and staying rates, per division; a "yes" on the interest check counts as coming back', () => {
  let ch = C.adminCampaign(cid).churn!
  const r = ch.divisions.find((x) => x.name === 'Rookie')!
  assert.deepEqual([ch.up, ch.stay, r.up, r.stay, r.expectedOut], [10, 10, 6, 4, 1], '10% of 10 returners')
  C.saveCampaign(cid, { name: '2027 Spring', churn: { up: 10, stay: 10, div: { [r.divisionId]: { up: 50, stay: 25 } } } }, A)
  ch = C.adminCampaign(cid).churn!
  assert.equal(ch.divisions.find((x) => x.name === 'Rookie')!.expectedOut, 4, '50% of 6 moving up + 25% of 4 staying')
  const f = C.forecast(rookie(), C.availability(rookie()).guard)!
  assert.deepEqual([f.open, f.expectedOut, f.room], [0, 4, 4])
  assert.deepEqual(pubRookie().line, { ahead: 0, likely: 4 })
  // One family moving up says yes: they're coming.
  db.prepare(`UPDATE enrollments SET intent = 'yes' WHERE id = (SELECT e.id FROM enrollments e WHERE e.prior LIKE 'T-Ball%' LIMIT 1)`).run()
  assert.equal(C.forecast(rookie(), C.availability(rookie()).guard)!.expectedOut, 3, '50% of 5 → 2, + 1')
  assert.throws(() => C.saveCampaign(cid, { name: '2027 Spring', churn: { up: 120, stay: 10 } }, A), /0 to 100/)
})

let ids: string[] = []
test('new families join the line with a card saved — nothing charged, and they see their place', async () => {
  for (const [f, k] of [['Ann', 'Ava'], ['Bo', 'Ben'], ['Cy', 'Cal'], ['Di', 'Dee']]) {
    const q = C.quote('2027-spring', fam(f!, k!))
    assert.equal(q.total, 0)
    assert.ok(q.players[0]!.waitlisted && q.players[0]!.early)
    const r = await C.startCheckout('2027-spring', fam(f!, k!), base)
    assert.match(calls.filter((x) => x.url.includes('/checkout/sessions')).at(-1)!.body, /mode=setup/)
    assert.equal(op(r.orderId).status, 'held', 'waiting on the card')
    await card(r.orderId)
    assert.equal(op(r.orderId).status, 'waitlisted')
    assert.equal(C.order(r.orderId)!.card_label, 'Visa •••• 4242 (exp 4/30)')
    ids.push(r.orderId)
  }
  assert.equal(calls.filter((x) => x.url.endsWith('/payment_intents')).length, 0, 'nobody charged')
  const back = (await C.confirmFromReturn(ids[2]!, null)).players[0]!
  assert.deepEqual(back.line, { pos: 3, likely: true, card: true }, 'Cal is #3; we expect room for 3')
  assert.deepEqual((await C.confirmFromReturn(ids[3]!, null)).players[0]!.line, { pos: 4, likely: false, card: true })
  const w = C.adminCampaign(cid).waitlist.find((x) => x.program === 'Rookie')!
  assert.deepEqual(w.players.map((p) => [p.pos, p.name, p.card, p.due_cents]), [[1, 'Ava New', 'Visa •••• 4242 (exp 4/30)', 20000], [2, 'Ben New', 'Visa •••• 4242 (exp 4/30)', 20000], [3, 'Cal New', 'Visa •••• 4242 (exp 4/30)', 20000], [4, 'Dee New', 'Visa •••• 4242 (exp 4/30)', 20000]])
  assert.equal(w.forecast!.room, 3)
  assert.equal(pubRookie().line!.ahead, 4)
})

test('Accept: charges the saved card and registers; the line moves up; a decline sends a pay link', async () => {
  const w = () => C.adminCampaign(cid).waitlist.find((x) => x.program === 'Rookie')!
  const ok = await C.acceptFromLine(w().players[0]!.id, A)
  assert.equal(ok.result, 'registered')
  assert.equal(op(ids[0]!).status, 'registered')
  assert.match(op(ids[0]!).charge_id!, /^pi_line_/)
  assert.equal(C.order(ids[0]!)!.status, 'paid')
  assert.equal(C.order(ids[0]!)!.total_cents, 20000)
  const charge = calls.filter((x) => x.url.endsWith('/payment_intents'))[0]!.body
  assert.match(charge, /amount=20000/)
  assert.match(charge, /off_session=true/)
  assert.match(charge, /receipt_email=ann@example.com/)
  const e = db.prepare(`SELECT e.status FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE k.name = 'Ava New'`).get() as { status: string }
  assert.equal(e.status, 'Registered', 'on the season roster')
  assert.deepEqual(w().players.map((p) => p.pos), [1, 2, 3])
  assert.equal(w().forecast!.room, 2, 'Ava used one of the 3 expected openings')
  decline = true; mails.length = 0
  const bad = await C.acceptFromLine(w().players[0]!.id, A)
  decline = false
  assert.equal(bad.result, 'declined')
  assert.match(bad.url!, /\/register\/2027-spring\/spot\//)
  assert.equal(op(ids[1]!).status, 'offered')
  assert.match(op(ids[1]!).early_error, /declined/)
  assert.match(mails[0]!.subject, /Action needed: Ben/)
  assert.match(mails[0]!.text, /a spot opened up for Ben in Rookie/)
  await assert.rejects(C.acceptFromLine(op(ids[0]!).id, A), /isn’t waiting in line/)
  C.removeFromWaitlist(op(ids[3]!).id, A)
  assert.equal(op(ids[3]!).status, 'cancelled')
})

test('Players tab: one row per player with registration and payment status, plus returners still to register', () => {
  const r = C.adminCampaign(cid).roster
  const row = (name: string) => r.players.find((p) => p.name === name)!
  assert.deepEqual([row('Ava New').status, row('Ava New').pay.state, row('Ava New').returning], ['registered', 'paid', false])
  assert.equal(row('Ben New').status, 'offered', 'declined card: holding the spot with a pay link')
  assert.ok(row('Ben New').offer_url)
  assert.deepEqual([row('Cal New').status, row('Cal New').line_pos, row('Cal New').pay.state, row('Cal New').pay.owed], ['waitlisted', 2, 'card', 20000])
  assert.equal(r.players.find((p) => p.name === 'Dee New'), undefined, 'removed from the line')
  assert.equal(r.returners.length, 10, 'all ten Rookie returners still to register')
  assert.ok(r.returners.every((x) => x.offering_id === rookie().id && x.division === 'Rookie'))
  assert.equal(r.returners.filter((x) => x.intent === 'yes').length, 1)
})

test('a family that joined without a card (line card off) gets Offer spot, not a charge', async () => {
  C.saveCampaign(cid, { name: '2027 Spring', line_card: false }, A)
  const r = await C.startCheckout('2027-spring', fam('Ed', 'Eli'), base)
  assert.equal(C.order(r.orderId)!.status, 'waitlisted', 'no card page')
  await assert.rejects(C.acceptFromLine(op(r.orderId).id, A), /didn’t save a card/)
})

test('one opening date: new families take the seats returners aren’t holding, told when it’s tight, then the line', async () => {
  C.saveCampaign(cid, { name: '2027 Spring', line_card: true }, A)
  // T-Ball: 10 seats, no returners. Fill it down to 2.
  const d = L.divisionByKey('2027', 'tball')!
  for (let i = 0; i < 8; i++) L.enroll('2027', L.createKid(`Reg${i} Kid`, `2021-0${i + 1}-02`).id, { divisionId: d.id, status: 'Registered' }, A)
  const tball = () => C.publicCampaign('2027-spring').offerings.find((o) => o.name === 'T-Ball')!
  assert.equal(tball().full, false)
  assert.equal(tball().left, 2, 'tight: families are told 2 spots are left')
  const kid = (first: string) => ({ firstName: first, lastName: 'New', birthdate: '2021-09-15', offeringId: tball().id, items: {}, answers: {} })
  // A family with three: two take the last seats, the third waits in line.
  const q = C.quote('2027-spring', { ...fam('Fay', 'x'), players: [kid('Tia'), kid('Tom'), { ...kid('Ted'), birthdate: '2021-10-01' }] })
  assert.deepEqual(q.players.map((p) => p.waitlisted), [false, false, true])
  assert.equal(q.total, 40000)
  assert.ok(q.players[2]!.early, 'the third saves a card in line')
  // Two returners still to register would hold seats too: a returner Expected in T-Ball makes it tighter.
  const r = L.createKid('Late Returner', '2021-03-03')
  L.enroll('2027', r.id, { divisionId: d.id, returner: true }, A)
  assert.equal(tball().left, 1)
})

test('the message to families in line: a standard one, or the league’s own', async () => {
  assert.equal(C.publicCampaign('2027-spring').campaign.lineMessage, C.DEFAULT_LINE_MESSAGE)
  assert.match(C.DEFAULT_LINE_MESSAGE, /record sign-ups.*turf fields.*patience.*coming days/)
  C.saveCampaign(cid, { name: '2027 Spring', line_message: 'Hang tight — we’ll be in touch.' }, A)
  assert.equal(C.publicCampaign('2027-spring').campaign.lineMessage, 'Hang tight — we’ll be in touch.')
  assert.equal((await C.confirmFromReturn(ids[2]!, null)).lineMessage, 'Hang tight — we’ll be in touch.')
  C.saveCampaign(cid, { name: '2027 Spring', line_message: C.DEFAULT_LINE_MESSAGE }, A)
  assert.equal(C.campaign(cid)!.line_message, '', 'saving the standard wording keeps following the standard')
})
