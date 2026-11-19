import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-p-'))
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
  if (u.includes('/checkout/sessions')) return new Response(JSON.stringify({ id: `cs_${calls.length}`, url: `https://checkout.stripe.com/c/pay/cs_${calls.length}`, status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })
  if (u.includes('/payment_intents/') && (init.method ?? 'GET') === 'GET')
    return new Response(JSON.stringify({ id: 'pi_x', status: 'succeeded', amount: 1, customer: 'cus_1', payment_method: { id: 'pm_1', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 } } }), { status: 200 })
  if (u.endsWith('/payment_intents')) {
    if (decline) return new Response(JSON.stringify({ error: { message: 'Your card was declined.' } }), { status: 402 })
    return new Response(JSON.stringify({ id: `pi_off_${calls.length}`, status: 'succeeded', amount: 1, customer: 'cus_1', payment_method: 'pm_1' }), { status: 200 })
  }
  throw new Error(`unexpected fetch ${u}`)
}) as typeof fetch

const L = await import('../src/lib/league.js')
const C = await import('../src/lib/campaigns.js')
const P = await import('../src/lib/plans.js')
const F = await import('../src/lib/finance.js')
const { db } = await import('../src/db.js')
const A = 'test'
const base = 'https://league.test'

test('schedule: monthly when it fits, else evenly spaced; odd cents on the first payment', () => {
  assert.deepEqual(P.planSchedule(50000, 4, '2027-03-01', '2026-11-16'), [
    { due: '2026-11-16', cents: 12500 }, { due: '2026-12-16', cents: 12500 }, { due: '2027-01-16', cents: 12500 }, { due: '2027-02-16', cents: 12500 }])
  assert.deepEqual(P.planSchedule(41000, 3, '2027-01-31', '2026-10-31').map((x) => x.due), ['2026-10-31', '2026-11-30', '2026-12-31'], 'the 31st becomes the last day of a short month')
  const even = P.planSchedule(20500, 3, '2026-12-20', '2026-11-20')!
  assert.deepEqual(even.map((x) => x.due), ['2026-11-20', '2026-12-05', '2026-12-20'])
  assert.deepEqual(even.map((x) => x.cents), [6834, 6833, 6833])
  assert.equal(even.reduce((a, x) => a + x.cents, 0), 20500, 'the family pays exactly the total')
  assert.equal(P.planSchedule(20500, 4, '2026-11-25', '2026-11-20'), null, 'less than a week between payments: no plan')
})

test('schedule: the family picks the day of the month for the later payments', () => {
  assert.deepEqual(P.planSchedule(22500, 3, '2027-01-18', '2026-11-18', 1), [
    { due: '2026-11-18', cents: 7500 }, { due: '2026-12-01', cents: 7500 }, { due: '2027-01-01', cents: 7500 }])
  assert.equal(P.planSchedule(22500, 3, '2027-01-18', '2026-11-18', 20), null, 'the last payment would land after the final date')
  assert.deepEqual(P.payDays(3, '2027-01-18', '2026-11-18'), Array.from({ length: 18 }, (_, i) => i + 1))
  assert.deepEqual(P.payDays(3, '2027-03-01', '2026-11-18').length, 28)
  assert.deepEqual(P.payDays(3, '2026-12-20', '2026-11-20'), [], 'not monthly: no day to pick')
})

let cid = ''
let orderId = ''
test('checkout with a plan: first payment now, card saved, rest scheduled', async () => {
  db.prepare(`INSERT INTO seasons (id, year) VALUES ('2027', 2027)`).run()
  L.saveDivision('2027', null, { key: 'tball', name: 'T-Ball', teams: 2, roster_size: 10, min_age: 5, max_age: 6 }, A)
  const c = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027', status: 'open' }, A)
  cid = c.id
  C.seedDefaults(cid, A)
  C.programsFromSeason(cid, A)
  const pub = () => C.publicCampaign('2027-spring')
  assert.equal(pub().plan, null, 'no plan until the league turns it on')
  const fin = P.addDays(P.today(), 100)
  assert.throws(() => C.saveCampaign(cid, { name: '2027 Spring', plan_installments: 4 }, A), /last plan payment/)
  C.saveCampaign(cid, { name: '2027 Spring', plan_installments: 4, plan_final_date: fin, plan_min_cents: 15000 }, A)
  assert.equal(pub().plan?.installments, 4)
  const q = (label: string) => pub().questions.find((x) => x.label.startsWith(label))!.id
  const t = pub().offerings.find((o) => o.name === 'T-Ball')!.id
  const fam = (players: object[], plan: boolean) => ({ guardian: { firstName: 'Pat', lastName: 'Parent', email: 'pat@example.com', phone: '(555) 123-4567' }, answers: { [q('I agree')]: true }, plan,
    players })
  const kid = (first: string) => ({ firstName: first, lastName: 'Kid', birthdate: '2021-01-15', offeringId: t, items: {}, answers: { [q('Baseball experience')]: 'First season', [q('Shirt size')]: 'Youth M' } })
  const r = await C.startCheckout('2027-spring', fam([kid('Ann'), kid('Bo')], true), base)
  orderId = r.orderId
  const sess = calls.filter((x) => x.url.includes('/checkout/sessions')).at(-1)!.body
  assert.match(sess, /setup_future_usage\]=off_session/)
  assert.match(sess, /customer_creation=always/)
  assert.match(sess, /unit_amount\]=10250/, '$410 over 4 = $102.50 now')
  const ins = P.installmentsFor(orderId)
  assert.deepEqual(ins.map((i) => i.amount_cents), [10250, 10250, 10250, 10250])
  assert.equal(ins[0]!.due_date, P.today())
  // Paid: the kids are registered in full, the first payment is in and the card is kept.
  C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_x', payment_status: 'paid', payment_intent: 'pi_first', metadata: { order_id: orderId } } } })
  await new Promise((res) => setTimeout(res, 20))
  assert.equal(C.order(orderId)!.status, 'paid')
  assert.equal(P.installmentsFor(orderId)[0]!.status, 'paid')
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as { stripe_customer_id: string; stripe_pm_id: string; card_label: string }
  assert.deepEqual([o.stripe_customer_id, o.stripe_pm_id, o.card_label], ['cus_1', 'pm_1', 'Visa •••• 4242 (exp 4/30)'])
  assert.equal(L.placements('2027').filter((p) => p.status === 'Registered').length, 2)
  // A one-kid T-Ball total ($205) is above the $150 minimum too; a plan the campaign doesn't offer is refused.
  C.saveCampaign(cid, { name: '2027 Spring', plan_min_cents: 50000 }, A)
  assert.throws(() => C.quote('2027-spring', fam([kid('Cy')], true)), /isn’t available/)
  C.saveCampaign(cid, { name: '2027 Spring', plan_min_cents: 15000 }, A)
})

test('the scheduler charges what’s due; a decline retries, emails the family a pay link, and shows as A/R', async () => {
  // Make payment 2 due today.
  const [, two, three] = P.installmentsFor(orderId)
  db.prepare('UPDATE installments SET due_date = ? WHERE id = ?').run(P.today(), two!.id)
  let r = await P.runPlans()
  assert.equal(r.charged, 1)
  assert.equal(P.installmentsFor(orderId)[1]!.status, 'paid')
  assert.equal(P.installmentsFor(orderId)[1]!.method, 'auto')
  // Payment 3 a few days out: a "coming up" email, once.
  db.prepare('UPDATE installments SET due_date = ? WHERE id = ?').run(P.addDays(P.today(), 2), three!.id)
  mails.length = 0
  r = await P.runPlans()
  assert.equal(r.reminded, 1)
  assert.match(mails[0]!.subject, /Your next payment/)
  assert.match(mails[0]!.text, /Visa •••• 4242/)
  assert.match(mails[0]!.text, /\/register\/2027-spring\/balance\//)
  assert.equal((await P.runPlans()).reminded, 0, 'only one heads-up per payment')
  // Due and declined: failed, retry in a few days, family emailed.
  db.prepare('UPDATE installments SET due_date = ? WHERE id = ?').run(P.addDays(P.today(), -1), three!.id)
  decline = true; mails.length = 0
  r = await P.runPlans()
  assert.equal(r.failed, 1)
  const failed = P.installmentsFor(orderId)[2]!
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 1)
  assert.ok(failed.next_attempt_at && failed.next_attempt_at > new Date().toISOString())
  assert.match(mails[0]!.subject, /didn't go through/)
  assert.equal((await P.runPlans()).failed, 0, 'no retry before the retry date')
  // A/R: one plan, card failed, past due by a day.
  const ar = P.receivables(cid)
  assert.equal(ar.plans[0]!.state, 'card_failed')
  assert.equal(ar.kpis.collected, 20500)
  assert.equal(ar.kpis.outstanding, 20500)
  assert.equal(ar.kpis.pastDue, 10250)
  assert.equal(ar.aging.d1_30, 10250)
  // History has the charge, the heads-up, the decline and its email.
  const log = P.contactLog(orderId).map((x) => `${x.channel}:${x.kind}`)
  for (const k of ['charge:charged', 'email:upcoming', 'charge:declined', 'email:failed']) assert.ok(log.includes(k), k)
  decline = false
})

test('collections tools: pay link, cash, waive, move, custom email and text', async () => {
  const [, , three, four] = P.installmentsFor(orderId)
  // The family's pay link charges what's past due and saves the card they use.
  const url = await P.startBalanceCheckout('2027-spring', P.payLink(orderId).split('/').at(-1)!)
  assert.match(url, /checkout\.stripe\.com/)
  const sess = calls.filter((x) => x.url.includes('/checkout/sessions')).at(-1)!.body
  assert.match(sess, /customer=cus_1/)
  assert.match(sess, new RegExp(`installment_ids\\]=${three!.id}`))
  C.handleStripeEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_b', payment_status: 'paid', payment_intent: 'pi_link', metadata: { order_id: orderId, installment_ids: three!.id } } } })
  assert.equal(P.installmentsFor(orderId)[2]!.status, 'paid')
  assert.equal(P.installmentsFor(orderId)[2]!.method, 'link')
  // Move, then record a check for the last one.
  P.moveDueDate(four!.id, P.addDays(P.today(), 40), A)
  P.recordPayment(four!.id, 'check', '#1042', A)
  assert.equal(P.receivables(cid).plans[0]!.state, 'paid_off')
  await assert.rejects(P.startBalanceCheckout('2027-spring', P.payLink(orderId).split('/').at(-1)!), /all paid up/)
  assert.throws(() => P.waiveInstallment(four!.id, '', A), /isn’t open/)
  // Custom email: merge fields filled, pay link always included, logged.
  mails.length = 0
  await P.sendCustomEmail(orderId, 'About {players}', 'Hi {first}, thanks — balance is {balance}.', A)
  assert.equal(mails[0]!.subject, 'About Ann Kid and Bo Kid')
  assert.match(mails[0]!.text, /Hi Pat, thanks — balance is \$0\./)
  assert.match(mails[0]!.text, /balance\//)
  const t = P.textFor(orderId)
  assert.equal(t.phone, '(555) 123-4567')
  assert.match(t.message, /balance\//)
  P.logContact(orderId, 'text', 'manual', A, { body: t.message })
  assert.ok(P.contactLog(orderId).some((x) => x.channel === 'text'))
})

test('finance: booked vs collected, by program and fee', () => {
  const f = F.revenue(cid)
  assert.equal(f.totals.booked, 41000)
  assert.equal(f.totals.collected, 41000)
  assert.equal(f.totals.outstanding, 0)
  assert.equal(f.totals.planOrders, 1)
  assert.deepEqual(f.byProgram.map((x) => [x.name, x.cents, x.players]), [['T-Ball', 41000, 2]])
  assert.deepEqual(f.byItem.map((x) => [x.name, x.cents]), [['Registration fee', 40000], ['LFUCG', 1000]])
  assert.equal(f.testOnly, true)
})
