import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-s-'))
process.env.DB_PATH = path.join(dir, 'league.db')
process.env.AUTH_DB_PATH = path.join(dir, 'auth.db') // never the real shared login database
// Fake keys only — fetch below is a pretend Stripe that records which key each call used.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
process.env.STRIPE_LIVE_SECRET_KEY = 'sk_live_fake'
process.env.STRIPE_LIVE_WEBHOOK_SECRET = 'whsec_live'
process.env.RESEND_API_KEY = ''

const calls: { url: string; key: string }[] = []
globalThis.fetch = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
  const u = String(url), key = (init.headers?.Authorization ?? '').replace('Bearer ', '')
  calls.push({ url: u, key })
  const live = key.startsWith('sk_live_') ? 'live' : 'test'
  if (u.endsWith('/customers')) return new Response(JSON.stringify({ id: `cus_${live}` }), { status: 200 })
  if (u.includes('/checkout/sessions')) return new Response(JSON.stringify({ id: `cs_${live}_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_${calls.length}`, status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })
  if (u.includes('/setup_intents/')) return new Response(JSON.stringify({ id: 'seti_1', status: 'succeeded', customer: `cus_${live}`, payment_method: { id: `pm_${live}`, card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } }), { status: 200 })
  if (u.endsWith('/payment_intents')) return new Response(JSON.stringify({ id: `pi_${live}_${calls.length}`, status: 'succeeded', amount: 1, customer: `cus_${live}`, payment_method: `pm_${live}` }), { status: 200 })
  throw new Error(`unexpected fetch ${u}`)
}) as typeof fetch

const L = await import('../src/lib/league.js')
const C = await import('../src/lib/campaigns.js')
const S = await import('../src/lib/stripe.js')
const { db } = await import('../src/db.js')
const A = 'test'
const base = 'https://league.test'
let cid = ''
const rookie = () => C.offerings(cid).find((o) => o.name === 'Rookie')!
const fam = (first: string) => ({ guardian: { firstName: first, lastName: 'Parent', email: `${first.toLowerCase()}@example.com`, phone: '(555) 123-4567' }, answers: {},
  players: [{ firstName: first + 'kid', lastName: 'New', birthdate: '2019-09-15', offeringId: rookie().id, items: {}, answers: {} }] })
const keyOf = (re: RegExp) => calls.filter((c) => re.test(c.url)).at(-1)!.key

test('setup: Rookie spoken for by returners, so new families join the line', () => {
  db.prepare(`INSERT INTO seasons (id, year) VALUES ('2027', 2027)`).run()
  L.saveDivision('2027', null, { key: 'rookie', name: 'Rookie', teams: 1, roster_size: 2, min_age: 7, max_age: 8 }, A)
  const d = L.divisionByKey('2027', 'rookie')!
  for (const n of ['Ann', 'Bo']) L.enroll('2027', L.createKid(`${n} Kid`, '2019-02-02').id, { divisionId: d.id, returner: true }, A)
  cid = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027', status: 'open' }, A).id
  C.programsFromSeason(cid, A)
  C.saveItem(cid, null, { name: 'Registration fee', price_cents: 20000, required: true }, A)
})

let testOrder = ''
test('test mode until someone switches: new checkouts use the test key', async () => {
  assert.deepEqual(S.stripeKeys(), { test: 'sk_test_fake', live: 'sk_live_fake' })
  assert.equal(S.stripeMode(), 'test')
  assert.equal(S.liveReady(), null, 'live key and live webhook are both there')
  testOrder = (await C.startCheckout('2027-spring', fam('Tess'), base)).orderId
  assert.equal(keyOf(/\/customers$/), 'sk_test_fake')
  assert.equal(keyOf(/checkout\/sessions/), 'sk_test_fake')
  assert.equal(C.order(testOrder)!.stripe_mode, 'test')
  C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', mode: 'setup', status: 'complete', setup_intent: 'seti_1', metadata: { order_id: testOrder } } } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(keyOf(/setup_intents/), 'sk_test_fake', 'its card is read from the test account')
})

test('going live: new checkouts use the live key; a test order’s card stays in the test account', async () => {
  S.setStripeMode('live')
  assert.equal(S.stripeMode(), 'live')
  const liveOrder = (await C.startCheckout('2027-spring', fam('Liv'), base)).orderId
  assert.equal(keyOf(/checkout\/sessions/), 'sk_live_fake')
  assert.equal(C.order(liveOrder)!.stripe_mode, 'live')
  const p = db.prepare('SELECT id FROM order_players WHERE order_id = ?').get(testOrder) as { id: string }
  await C.acceptFromLine(p.id, A)
  assert.equal(keyOf(/payment_intents$/), 'sk_test_fake', 'never charge a test card with the live key')
  assert.equal(S.sessionMode('cs_live_abc'), 'live')
  assert.equal(S.sessionMode('cs_test_abc'), 'test')
  assert.deepEqual(S.webhookSecrets(), ['whsec_test', 'whsec_live'], 'both endpoints’ signatures accepted')
  S.setStripeMode('test')
  assert.equal(S.stripeMode(), 'test')
})
