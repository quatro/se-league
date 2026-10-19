import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-o-'))
process.env.DB_PATH = path.join(dir, 'league.db')
// Never send real mail or touch Stripe from tests, whatever .env says.
process.env.RESEND_API_KEY = 're_test_fake'
process.env.MAIL_FROM = 'SE Baseball <test@league.test>'
process.env.RESEND_API_BASE = 'https://resend.test'
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.BASE_URL = 'https://league.test'
const batches: { to: string[]; subject: string; text: string; html: string }[][] = []
let failNext = false
globalThis.fetch = (async (url: string, init: { body: string }) => {
  if (String(url).startsWith('https://resend.test/emails/batch')) {
    if (failNext) { failNext = false; return new Response('{"message":"rate limited"}', { status: 429 }) }
    const b = JSON.parse(init.body)
    batches.push(b)
    return new Response(JSON.stringify({ data: b.map((_: unknown, i: number) => ({ id: `em_${batches.length}_${i}` })) }), { status: 200 })
  }
  assert.match(String(url), /^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions/)
  return new Response(JSON.stringify({ id: `cs_${Math.random()}`, url: 'https://checkout.stripe.com/x', status: 'open', payment_status: 'unpaid', metadata: {} }), { status: 200 })
}) as typeof fetch

const L = await import('../src/lib/league.js')
const C = await import('../src/lib/campaigns.js')
const K = await import('../src/lib/contacts.js')
const O = await import('../src/lib/outreach.js')
const { config } = await import('../src/config.js')
const { db } = await import('../src/db.js')
const A = 'test'

const kidId = (name: string) => (db.prepare('SELECT id FROM kids WHERE name = ?').get(name) as { id: string }).id
let campaignId = ''
const input = (extra: Partial<Parameters<typeof O.preview>[0]> = {}) =>
  ({ seasonId: '2027', campaignId, subject: O.DEFAULT_SUBJECT, body: O.DEFAULT_BODY, divisionIds: [], statuses: [], ...extra }) as Parameters<typeof O.preview>[0]

test('setup: 2027 returners on teams, and a campaign', () => {
  db.prepare(`INSERT INTO seasons (id, year, status) VALUES ('2027', 2027, 'planning')`).run()
  const maj = L.saveDivision('2027', null, { key: 'majors', name: 'Majors', teams: 1, roster_size: 12, min_age: 10, max_age: 12, keep_teams: true }, A)
  const rook = L.saveDivision('2027', null, { key: 'rookie', name: 'Rookie', teams: 1, roster_size: 12, min_age: 7, max_age: 8, keep_teams: true }, A)
  const reds = L.saveTeam(maj.id, null, { name: 'Reds' }, A), mets = L.saveTeam(rook.id, null, { name: 'Mets' }, A)
  const add = (name: string, dob: string | null, d: string, t: string, status: L.EnrollInput['status'] = 'Expected') =>
    L.enroll('2027', L.createKid(name, dob).id, { divisionId: d, teamId: t, returner: true, status }, A)
  add('Sam Turner', '2015-06-01', maj.id, reds.id)
  add('Ella Turner', '2019-02-01', rook.id, mets.id)   // Sam's sister: same parents
  add('Max Done', '2015-07-01', maj.id, reds.id, 'Registered')
  add('Nora Nobody', '2015-08-01', maj.id, reds.id)    // no contact on file
  const c = C.saveCampaign(null, { name: '2027 Spring', season_id: '2027' }, A)
  campaignId = c.id
  C.seedDefaults(c.id, A)
  C.programsFromSeason(c.id, A)
})

test('contacts: the SportsEngine parent export layout', () => {
  const csv = [
    '﻿First Name,Last Name,Guardian First Name,Guardian Last Name,Phone Number 1,Phone Number 2,Email,Parent/Guardian 2 First Name,Parent/Guardian 2 Last Name,Parent/Guardian 2 Phone,Parent/Guardian 2 Email',
    'Sam,Turner,Stephen,Turner,,859-111-2222,Steve@Example.com,Michelle,Turner,859-333-4444,michelle@example.com',
    'Ella,Turner,Stephen,Turner,859-111-2222,,steve@example.com,,,,',
    'Max,Done,Dana,Done,859-555-0000,,dana@example.com,,,,',
    'Ghost,Player,Gail,Player,,,gail@example.com,,,,',
    'Nora,Nobody,,,,,,,,,',
  ].join('\n')
  const r = K.importContacts(csv, A)
  assert.equal(r.rows, 5)
  assert.equal(r.kids, 3)
  assert.equal(r.added, 4)
  assert.deepEqual(r.unmatched, ['Ghost Player'])
  assert.deepEqual(r.noContact, ['Nora Nobody'])
  const sam = K.contactsFor(kidId('Sam Turner'))
  assert.deepEqual(sam.map((c) => [c.name, c.email, c.phone]), [['Stephen Turner', 'steve@example.com', '859-111-2222'], ['Michelle Turner', 'michelle@example.com', '859-333-4444']])
  // Importing again changes nothing.
  assert.equal(K.importContacts(csv, A).added, 0)
})

test('audience: one message per parent email covering all their kids; registered kids and kids without contacts left out', () => {
  const a = O.audience('2027', {})
  assert.deepEqual(a.families.map((f) => [f.email, f.kids.map((k) => k.name)]), [
    ['steve@example.com', ['Sam Turner', 'Ella Turner']], ['michelle@example.com', ['Sam Turner']],
  ])
  assert.deepEqual(a.missing.map((k) => k.name), ['Nora Nobody'])
  assert.equal(a.kids, 3) // Max is already Registered
  // Only Rookie: just Ella's family.
  assert.deepEqual(O.audience('2027', { divisionIds: [L.divisionByKey('2027', 'rookie')!.id] }).families.map((f) => f.email), ['steve@example.com'])
  const p = O.preview(input())
  assert.equal(p.families, 2)
  assert.equal(p.sample!.subject, 'Register Sam and Ella for 2027 — returning players first')
  assert.match(p.sample!.text, /^Hi Stephen,/)
  assert.match(p.sample!.text, /• Sam Turner — Majors, Reds\n• Ella Turner — Rookie, Mets/)
})

test('checks: personal link required, unknown fields refused', () => {
  assert.throws(() => O.createOutreach(input({ body: 'Hi {parent_first}, please register.' }), A), /\{link\}/)
  assert.throws(() => O.createOutreach(input({ body: 'Hi {parent_frist} {link}' }), A), /Unknown field \{parent_frist\}/)
})

let first = ''
test('send: one batch, a personal link per family; a failure can be retried', async () => {
  failNext = true
  first = O.createOutreach(input(), A)
  const r1 = await O.sendOutreach(first, A)
  assert.deepEqual([r1.sent, r1.failed], [0, 2])
  assert.match(r1.error, /429/)
  const r2 = await O.sendOutreach(first, A)
  assert.deepEqual([r2.sent, r2.failed], [2, 0])
  const sent = batches.at(-1)!
  assert.deepEqual(sent.map((m) => m.to[0]), ['michelle@example.com', 'steve@example.com'].filter((e) => sent.some((m) => m.to[0] === e)))
  const steve = sent.find((m) => m.to[0] === 'steve@example.com')!
  assert.match(steve.text, /https:\/\/league\.test\/register\/2027-spring\?invite=[\w-]{20,}/)
  assert.match(steve.html, /Register now/)
  assert.equal((await O.sendOutreach(first, A)).sent, 0, 'nothing sent twice')
  const l = O.listOutreach('2027')[0]!
  assert.deepEqual([l.families, l.sent, l.clicked, l.kids, l.registered], [2, 2, 0, 2, 0])
})

test('personal link: pre-fills the family and their returning players, and counts the click', () => {
  const steve = batches.at(-1)!.find((m) => m.to[0] === 'steve@example.com')!
  const tok = /invite=([\w-]+)/.exec(steve.text)![1]!
  const inv = O.invite('2027-spring', tok)
  assert.deepEqual(inv.guardian, { firstName: 'Stephen', lastName: 'Turner', email: 'steve@example.com' })
  assert.deepEqual(inv.players.map((p) => [p.firstName, p.lastName, p.birthdate]), [['Sam', 'Turner', '2015-06-01'], ['Ella', 'Turner', '2019-02-01']])
  assert.throws(() => O.invite('other-campaign', tok), /isn’t valid/)
  assert.throws(() => O.invite('2027-spring', 'nope'), /isn’t valid/)
  assert.equal(O.listOutreach('2027')[0]!.clicked, 1)
})

test('after Sam registers, a reminder only reaches families with someone still unregistered', async () => {
  db.prepare(`UPDATE enrollments SET status = 'Registered' WHERE kid_id = ?`).run(kidId('Sam Turner'))
  const a = O.audience('2027', {})
  assert.deepEqual(a.families.map((f) => [f.email, f.kids.map((k) => k.name)]), [['steve@example.com', ['Ella Turner']]])
  assert.equal(O.listOutreach('2027')[0]!.registered, 1)
  const n = batches.length
  const id = O.createOutreach(input({ subject: 'Reminder: {players}' }), A)
  await O.sendOutreach(id, A)
  assert.equal(batches.length, n + 1)
  assert.deepEqual(batches.at(-1)!.map((m) => [m.to[0], m.subject]), [['steve@example.com', 'Reminder: Ella']])
})

test('export: the list with personal links, for sending elsewhere — and a later send skips them', async () => {
  db.prepare(`UPDATE enrollments SET status = 'Expected' WHERE kid_id = ?`).run(kidId('Sam Turner'))
  const id = O.createOutreach(input(), A)
  const rows = O.exportOutreach(id)
  assert.deepEqual(rows[0], ['Email', 'Parent', 'Players', 'Subject', 'Message', 'Personal link', 'Status'])
  assert.equal(rows.length, 3)
  assert.match(rows[1]![5]!, /\?invite=/)
  const n = batches.length
  assert.equal((await O.sendOutreach(id, A)).sent, 0)
  assert.equal(batches.length, n)
})

test('no email provider: sending is refused, exporting still works', async () => {
  const key = config.mail.resendApiKey
  config.mail.resendApiKey = ''
  try {
    const id = O.createOutreach(input(), A)
    await assert.rejects(() => O.sendOutreach(id, A), /isn’t set up/)
    assert.equal(O.preview(input()).mail, null)
    assert.equal(O.exportOutreach(id).length, 3)
  } finally { config.mail.resendApiKey = key }
})

test('a paid registration remembers the parent for next year', () => {
  const k = L.createKid('New Kid', '2016-01-01')
  K.addContact(k.id, { name: 'Pat Parent', email: 'PAT@example.com', phone: '555' }, 'registration')
  assert.equal(K.addContact(k.id, { name: 'Pat Parent', email: 'pat@example.com' }, 'registration'), 'same')
  assert.deepEqual(K.contactsFor(k.id).map((c) => [c.email, c.source]), [['pat@example.com', 'registration']])
  assert.throws(() => K.addContact(k.id, { name: 'X' }, 'manual'), /email or a phone/)
})
