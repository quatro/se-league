import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-g-'))
process.env.DB_PATH = path.join(dir, 'league.db')
// Never touch a real Stripe account or send real email from tests, whatever .env says.
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
process.env.RESEND_API_KEY = ''
globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })) as typeof fetch

const L = await import('../src/lib/league.js')
const C = await import('../src/lib/campaigns.js')
const O = await import('../src/lib/outreach.js')
const { addContact } = await import('../src/lib/contacts.js')
const { db } = await import('../src/db.js')
const A = 'test'
const base = 'https://league.test'

let cid = ''
const pub = () => C.publicCampaign('2027-spring')
const rookie = () => C.offerings(cid).find((o) => o.name === 'Rookie')!
const q = (label: string) => pub().questions.find((x) => x.label.startsWith(label))!.id
const family = (players: object[]) => ({ guardian: { firstName: 'Pat', lastName: 'Parent', email: 'pat@example.com', phone: '555-123-4567' }, answers: { [q('I agree')]: true }, players })
const kid = (first: string, dob: string) => ({ firstName: first, lastName: 'Kid', birthdate: dob, offeringId: rookie().id, items: {},
  answers: { [q('Baseball experience')]: 'First season', [q('Shirt size')]: 'Youth M' } })
const enr = (name: string) => db.prepare(`SELECT e.* FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = '2027' AND k.name = ?`).get(name) as L.Enrollment & { intent: string }
const setProtect = (n: number | null) => { const o = rookie(); C.saveOffering(cid, o.id, { name: o.name, division_id: o.division_id, min_age: o.min_age, max_age: o.max_age, capacity: o.capacity, reg_mode: o.reg_mode, protect_at: n }, A) }

test('setup: Rookie has 10 seats and 5 returners still to register', () => {
  db.prepare(`INSERT INTO seasons (id, year) VALUES ('2027', 2027)`).run()
  L.saveDivision('2027', null, { key: 'rookie', name: 'Rookie', teams: 1, roster_size: 10, min_age: 7, max_age: 8 }, A)
  const d = L.divisionByKey('2027', 'rookie')!
  for (const [i, n] of ['Ann', 'Bo', 'Cy', 'Di', 'Ed'].entries()) {
    const k = L.createKid(`${n} Kid`, `2019-0${i + 1}-15`)
    L.enroll('2027', k.id, { divisionId: d.id, returner: true }, A)
    addContact(k.id, { name: 'Pat Parent', email: 'pat@example.com', phone: '' }, 'manual')
  }
  const c = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027', status: 'open' }, A)
  cid = c.id
  assert.equal(c.kind, 'spring', 'a registration tied to a season is the spring league')
  C.seedDefaults(cid, A)
  C.programsFromSeason(cid, A)
  const a = C.availability(rookie())
  assert.equal(a.guard!.buffer, 5, '10 seats − 5 returners outstanding')
  assert.equal(a.phase, 'open', 'protection is off until turned on')
})

test('protection: at or under the line, new players wait and returners still register', async () => {
  setProtect(5)
  assert.equal(C.availability(rookie()).phase, 'protected')
  assert.equal(pub().offerings.find((o) => o.name === 'Rookie')!.protected, true)
  const n = await C.startCheckout('2027-spring', family([kid('Nia', '2019-08-01')]), base)
  assert.equal(C.order(n.orderId)!.status, 'waitlisted', 'a new player joins the waitlist')
  assert.equal(C.availability(rookie()).guard!.buffer, 4, 'the waitlist is already in line')
  const r = await C.startCheckout('2027-spring', family([{ ...kid('Ann', '2019-01-15'), returning: enr('Ann Kid').kid_id }]), base)
  assert.equal(C.order(r.orderId)!.status, 'pending', 'a returner goes straight to payment')
  setProtect(3)
  assert.equal(C.availability(rookie()).phase, 'open', 'a buffer of 4 is above a line of 3')
})

test('interest check: one click per kid moves the seat math', async () => {
  const id = O.createOutreach({ seasonId: '2027', campaignId: cid, subject: O.INTEREST_SUBJECT, body: O.INTEREST_BODY, divisionIds: [], statuses: ['Expected', 'Need to contact'], kind: 'interest' }, A)
  const m = db.prepare('SELECT * FROM outreach_messages WHERE outreach_id = ?').get(id) as { token: string; kid_ids: string; email: string }
  assert.equal((JSON.parse(m.kid_ids) as string[]).length, 5, 'one message to the parent, all five kids')
  // The email has three answer links per kid.
  const mail = O.compose(O.INTEREST_SUBJECT, O.INTEREST_BODY, { email: m.email, name: 'Pat Parent', kids: [{ id: 'k1', name: 'Bo Kid', division: 'Rookie', team: null, status: 'Expected' }] }, 'x', 2027, m.token)
  assert.equal(mail.subject, 'Is Bo playing in 2027?')
  for (const a of ['yes', 'no', 'unsure']) assert.match(mail.text, new RegExp(`/interest/${m.token}\\?kid=k1&a=${a}`))
  assert.equal((mail.html.match(/<a href=/g) ?? []).length, 3)
  assert.throws(() => O.createOutreach({ seasonId: '2027', campaignId: cid, subject: 'x', body: 'no buttons', divisionIds: [], statuses: [], kind: 'interest' }, A), /answer_buttons/)

  const page = O.interestPage(m.token)
  assert.equal(page.kids.length, 5)
  const bo = enr('Bo Kid').kid_id, cy = enr('Cy Kid').kid_id, di = enr('Di Kid').kid_id
  const before = C.availability(rookie()).guard!.buffer
  O.answerInterest(m.token, [{ kidId: bo, intent: 'no' }, { kidId: cy, intent: 'unsure' }, { kidId: di, intent: 'yes' }])
  assert.equal(enr('Bo Kid').status, 'Not returning', 'no → the held seat is freed')
  assert.equal(enr('Cy Kid').status, 'Need to contact')
  assert.equal(enr('Di Kid').status, 'Expected')
  assert.equal(enr('Di Kid').intent, 'yes')
  assert.equal(C.availability(rookie()).guard!.buffer, before + 1)
  // Changed their mind: back to Expected.
  O.answerInterest(m.token, [{ kidId: bo, intent: 'yes' }])
  assert.equal(enr('Bo Kid').status, 'Expected')
  assert.throws(() => O.answerInterest(m.token, [{ kidId: 'someone-else', intent: 'no' }]), /isn’t on this link/)
  const list = O.listOutreach('2027').find((x) => x.id === id)!
  assert.equal(list.kind, 'interest')
  assert.equal(list.answers.yes, 2)
  assert.equal(list.answers.unsure, 1)
})

test('summer and fall registrations stay simple: no protection, no held seats', () => {
  const c = C.saveCampaign(null, { name: 'Fall Ball', season_id: '2027', kind: 'standard' }, A)
  assert.equal(c.kind, 'standard')
  C.programsFromSeason(c.id, A)
  const o = C.offerings(c.id).find((x) => x.name === 'Rookie')!
  C.saveOffering(c.id, o.id, { name: o.name, division_id: o.division_id, min_age: o.min_age, max_age: o.max_age, protect_at: 50 }, A)
  const a = C.availability(C.offerings(c.id).find((x) => x.name === 'Rookie')!)
  assert.equal(a.guard, null)
  assert.equal(a.phase, 'open')
})
