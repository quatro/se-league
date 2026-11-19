import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { requireAdmin, throttled, noteFailure } from '../lib/auth.js'
import * as C from '../lib/campaigns.js'
import * as F from '../lib/family.js'
import * as O from '../lib/outreach.js'
import * as P from '../lib/plans.js'
import { revenue } from '../lib/finance.js'
import { UserError } from '../lib/league.js'
import { verifyStripeSignature, webhookSecrets } from '../lib/stripe.js'

// Public registration pages, the Stripe webhook, and the campaign builder API.

export const stripeWebhook = Router()
// Raw body: Stripe signs exactly the bytes it sends.
stripeWebhook.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  // Test and live endpoints both send here, each signed with its own secret.
  const secrets = webhookSecrets()
  if (!secrets.length) return res.status(503).json({ error: 'webhook not configured' })
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!secrets.some((s) => verifyStripeSignature(raw, req.get('stripe-signature'), s))) return res.status(400).json({ error: 'bad signature' })
  try {
    const ev = JSON.parse(raw.toString('utf8'))
    const note = C.handleStripeEvent(ev)
    console.log(`[stripe] ${ev.type} ${ev.id}: ${note}`)
    res.json({ received: true })
  } catch (e) {
    console.error('[stripe] webhook failed', e)
    // 500 so Stripe retries; every handler is safe to run twice.
    res.status(500).json({ error: 'processing failed' })
  }
})

export const register = Router()
type H = (req: Request, res: Response) => unknown
const wrap = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (e) {
    if (e instanceof UserError || e instanceof z.ZodError) {
      return res.status(400).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message })
    }
    next(e)
  }
}
const p = (req: Request, k: string) => String(req.params[k])
const actor = (req: Request) => req.admin?.username ?? 'unknown'

// ---------- public ----------
register.get('/api/register/:slug', wrap((req) => C.publicCampaign(p(req, 'slug'), !!req.admin)))

// "Did this player play last year?" Runs as families type, so it has its own, looser limit.
const lookups = new Map<string, { n: number; until: number }>()
function tooManyLookups(req: Request): boolean {
  const now = Date.now(), a = lookups.get(req.ip ?? '')
  const fresh = !a || a.until < now
  lookups.set(req.ip ?? '', { n: fresh ? 1 : a!.n + 1, until: fresh ? now + 15 * 60e3 : a!.until })
  if (lookups.size > 5000) for (const [k, v] of lookups) if (v.until < now) lookups.delete(k)
  return !fresh && a!.n >= 120
}
const openCampaign = (req: Request) => {
  const c = C.campaignBySlug(p(req, 'slug'))
  if (!c || (c.status === 'draft' && !req.admin)) throw new UserError('No registration here')
  return c
}
register.get('/api/register/:slug/returning', wrap((req, res) => {
  if (tooManyLookups(req)) return res.status(429).json({ error: 'Too many lookups — please wait a few minutes.' })
  const c = openCampaign(req)
  const q = (k: string) => String(req.query[k] ?? '').slice(0, 80)
  return { matches: C.returningMatches(c, q('first'), q('last'), q('dob')) }
}))

// Brothers and sisters of a returning player, when the parent's email or phone is on file for them.
// A POST so the parent's email and phone stay out of URLs and logs.
const siblingsBody = z.object({ first: z.string().max(80), last: z.string().max(80), dob: z.string().max(20), email: z.string().max(200).default(''), phone: z.string().max(40).default('') })
register.post('/api/register/:slug/siblings', wrap((req, res) => {
  if (tooManyLookups(req)) return res.status(429).json({ error: 'Too many lookups — please wait a few minutes.' })
  const c = openCampaign(req)
  const b = siblingsBody.parse(req.body)
  return { siblings: C.siblingMatches(c, b.first, b.last, b.dob, b.email, b.phone) }
}))

// Family look-up: a parent's email → a 6-digit code → their returning players filled in. Nothing about the
// kids is shown until the code checks out; "known" only says a code can be sent.
const famEmail = z.string().trim().max(200)
register.post('/api/register/:slug/family/lookup', wrap((req, res) => {
  if (tooManyLookups(req)) return res.status(429).json({ error: 'Too many lookups — please wait a few minutes.' })
  return { known: F.familyKnown(openCampaign(req), z.object({ email: famEmail }).parse(req.body).email, !!req.admin) }
}))
register.post('/api/register/:slug/family/code', wrap(async (req, res) => {
  const key = `famcode:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many codes requested — please wait a few minutes.' })
  noteFailure(key) // counts codes sent: 8 per 15 minutes per connection
  return F.sendFamilyCode(openCampaign(req), z.object({ email: famEmail }).parse(req.body).email, !!req.admin)
}))
register.post('/api/register/:slug/family/verify', wrap((req, res) => {
  const key = `famverify:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many tries — please wait a few minutes.' })
  const b = z.object({ email: famEmail, code: z.string().max(20) }).parse(req.body)
  try { return F.verifyFamilyCode(openCampaign(req), b.email, b.code) } catch (e) { noteFailure(key); throw e }
}))
register.post('/api/register/:slug/family/intent', wrap((req) => {
  const b = z.object({ token: z.string().max(100), kidId: z.string().max(40), intent: z.enum(['yes', 'no', 'unsure']) }).parse(req.body)
  return F.familyIntent(openCampaign(req), b.token, b.kidId, b.intent)
}))

// Interest check: a family answering "is your player coming back?" from their email. Public; the token is the key.
register.get('/api/interest/:token', wrap((req) => O.interestPage(p(req, 'token').slice(0, 64))))
register.post('/api/interest/:token', wrap((req, res) => {
  const key = `interest:${req.ip}`
  if (throttled(key)) { res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' }); return }
  if (!req.is('application/json')) { res.status(415).json({ error: 'json_required' }); return }
  noteFailure(key)
  const b = z.object({ answers: z.array(z.object({ kidId: z.string().max(40), intent: z.enum(['yes', 'no', 'unsure']) })).min(1).max(12) }).parse(req.body)
  return O.answerInterest(p(req, 'token').slice(0, 64), b.answers)
}))

// A personal link from an outreach email: pre-fill the form for that family.
register.get('/api/register/:slug/invite/:token', wrap((req) => {
  const c = C.campaignBySlug(p(req, 'slug'))
  if (!c || (c.status === 'draft' && !req.admin)) throw new UserError('No registration here')
  return O.invite(p(req, 'slug'), p(req, 'token').slice(0, 64))
}))

const answer = z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50), z.null()])
const checkoutBody = z.object({
  guardian: z.object({
    firstName: z.string().max(80), lastName: z.string().max(80), email: z.string().max(200), phone: z.string().max(40),
    address: z.string().max(200).optional(), city: z.string().max(80).optional(), state: z.string().max(40).optional(), zip: z.string().max(20).optional(),
  }),
  answers: z.record(z.string(), answer).default({}),
  players: z.array(z.object({
    firstName: z.string().max(80), lastName: z.string().max(80), birthdate: z.string().max(20), gender: z.string().max(20).optional(),
    offeringId: z.string().max(40), items: z.record(z.string(), z.number().int().min(0).max(99)).default({}), answers: z.record(z.string(), answer).default({}),
    returning: z.string().max(40).optional(), tryout: z.boolean().optional(),
  })).max(8),
  plan: z.boolean().optional(),
  payDay: z.number().int().min(1).max(28).optional(),
})
register.post('/api/register/:slug/checkout', wrap(async (req, res) => {
  const key = `checkout:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' })
  if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' })
  const out = await C.startCheckout(p(req, 'slug'), checkoutBody.parse(req.body), config.baseUrl, !!req.admin)
  noteFailure(key) // counts checkouts started: 8 per 15 minutes per address is plenty for a family
  return out
}))
// A waitlist family's pay link: straight on to Stripe, or a plain page saying why not.
register.get('/register/:slug/spot/:token', async (req, res, next) => {
  try {
    res.redirect(303, await C.payOffer(p(req, 'slug'), p(req, 'token').slice(0, 64), config.baseUrl))
  } catch (e) {
    if (!(e instanceof UserError)) return next(e)
    const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
    res.status(410).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Waitlist spot</title>
<link rel="stylesheet" href="/css/app.css"></head><body><main class="reg"><header class="top"><h1><small>${esc(config.leagueName)}</small><span>Waitlist spot</span></h1></header>
<section class="regsec"><p>${esc(e.message)}</p></section></main></body></html>`)
  }
})
// A payment-plan family's link: pay what's due (and save a new card), or a plain page saying why not.
register.get('/register/:slug/balance/:token', async (req, res, next) => {
  try {
    res.redirect(303, await P.startBalanceCheckout(p(req, 'slug'), p(req, 'token').slice(0, 64)))
  } catch (e) {
    if (!(e instanceof UserError)) return next(e)
    const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
    res.status(200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registration payment</title>
<link rel="stylesheet" href="/css/app.css"></head><body><main class="reg"><header class="top"><h1><small>${esc(config.leagueName)}</small><span>Registration payment</span></h1></header>
<section class="regsec"><p>${esc(e.message)}</p></section></main></body></html>`)
  }
})
register.get('/api/register/order/:id', wrap((req) => C.confirmFromReturn(p(req, 'id'), req.query.session_id ? String(req.query.session_id) : null)))

// ---------- admin ----------
const admin = Router()
admin.use(requireAdmin)
register.use('/api/admin/campaigns', admin)

admin.get('/', wrap(() => C.campaigns()))
const campaignBody = z.object({
  name: z.string().min(1).max(80), slug: z.string().max(60).optional(), season_id: z.union([z.string(), z.null()]).optional(),
  status: z.enum(['draft', 'open', 'closed']).optional(),
  intro: z.string().max(10000).optional(), confirmation: z.string().max(10000).optional(),
  kind: z.enum(['spring', 'standard']).optional(),
  plan_installments: z.number().int().min(0).max(12).optional(), plan_final_date: z.union([z.string().max(10), z.null()]).optional(), plan_min_cents: z.number().int().min(0).max(10_000_000).optional(),
  churn: z.object({ up: z.number().min(0).max(100), stay: z.number().min(0).max(100), div: z.record(z.string().max(40), z.object({ up: z.number().min(0).max(100), stay: z.number().min(0).max(100) })).optional() }).optional(),
  line_card: z.boolean().optional(), line_message: z.string().max(1000).optional(),
})
admin.post('/', wrap((req) => {
  const c = C.saveCampaign(null, campaignBody.parse(req.body), actor(req))
  C.seedDefaults(c.id, actor(req))
  if (c.season_id) C.programsFromSeason(c.id, actor(req))
  return c
}))
admin.get('/:id', wrap((req) => C.adminCampaign(p(req, 'id'))))
admin.patch('/:id', wrap((req) => C.saveCampaign(p(req, 'id'), campaignBody.parse(req.body), actor(req))))
admin.post('/:id/programs-from-season', wrap((req) => { const n = C.programsFromSeason(p(req, 'id'), actor(req)); return { added: n, message: n ? `Added ${n} divisions` : 'Every season division is already here' } }))

const ids = z.array(z.string().max(40)).max(50).optional()
const offeringBody = z.object({ name: z.string().min(1).max(80), description: z.string().max(2000).optional(), division_id: z.union([z.string(), z.null()]).optional(),
  min_age: z.union([z.number().int().min(0).max(99), z.null()]).optional(), max_age: z.union([z.number().int().min(0).max(99), z.null()]).optional(),
  capacity: z.union([z.number().int().min(0).max(10000), z.null()]).optional(), reg_mode: z.enum(['open', 'waitlist', 'closed']).optional(), when_full: z.enum(['waitlist', 'close']).optional(), protect_at: z.union([z.number().int().min(0).max(500), z.null()]).optional(), sort: z.number().int().optional() })
admin.post('/:id/programs', wrap((req) => { C.saveOffering(p(req, 'id'), null, offeringBody.parse(req.body), actor(req)) }))
admin.patch('/:id/programs/:oid', wrap((req) => { C.saveOffering(p(req, 'id'), p(req, 'oid'), offeringBody.parse(req.body), actor(req)) }))
admin.delete('/:id/programs/:oid', wrap((req) => { C.deleteOffering(p(req, 'oid'), actor(req)) }))

const itemBody = z.object({ name: z.string().min(1).max(80), description: z.string().max(2000).optional(), price_cents: z.number().int().min(0).max(1_000_000),
  required: z.boolean().optional(), max_qty: z.number().int().min(1).max(99).optional(), offering_ids: ids, tag: z.string().max(40).optional(), sort: z.number().int().optional(), active: z.boolean().optional() })
admin.post('/:id/items', wrap((req) => { C.saveItem(p(req, 'id'), null, itemBody.parse(req.body), actor(req)) }))
admin.patch('/:id/items/:iid', wrap((req) => { C.saveItem(p(req, 'id'), p(req, 'iid'), itemBody.parse(req.body), actor(req)) }))
admin.delete('/:id/items/:iid', wrap((req) => { C.deleteItem(p(req, 'iid'), actor(req)) }))

const questionBody = z.object({ scope: z.enum(['player', 'family']), label: z.string().min(1).max(300), help: z.string().max(1000).optional(),
  type: z.enum(['text', 'textarea', 'number', 'date', 'yesno', 'select', 'multi', 'agreement']), options: z.array(z.string().max(200)).max(50).optional(),
  required: z.boolean().optional(), offering_ids: ids, sort: z.number().int().optional(), active: z.boolean().optional(), new_only: z.boolean().optional() })
admin.post('/:id/questions', wrap((req) => { C.saveQuestion(p(req, 'id'), null, questionBody.parse(req.body), actor(req)) }))
admin.patch('/:id/questions/:qid', wrap((req) => { C.saveQuestion(p(req, 'id'), p(req, 'qid'), questionBody.parse(req.body), actor(req)) }))
admin.delete('/:id/questions/:qid', wrap((req) => { C.deleteQuestion(p(req, 'qid'), actor(req)) }))

admin.post('/:id/orders/synced', wrap((req) => {
  const b = z.object({ ids: z.array(z.string()).min(1).max(2000), on: z.boolean() }).parse(req.body)
  C.markSynced(b.ids, b.on, actor(req))
  return { message: b.on ? `Marked ${b.ids.length} as entered in SportsEngine` : 'Unmarked' }
}))
admin.patch('/:id/orders/:oid', wrap((req) => { C.setOrderNotes(p(req, 'oid'), z.object({ admin_notes: z.string().max(4000) }).parse(req.body).admin_notes) }))
admin.post('/:id/players/:pid/offer', wrap(async (req) => {
  const { hours } = z.object({ hours: z.number().int() }).parse(req.body)
  const r = await C.offerSpot(p(req, 'pid'), hours, config.baseUrl, actor(req))
  return { ...r, message: r.registered ? 'Nothing to pay — registered' : r.emailed ? `Offer emailed to ${r.emailed}` : 'Pay link created — send it to the family' }
}))
admin.post('/:id/players/:pid/remove', wrap((req) => { C.removeFromWaitlist(p(req, 'pid'), actor(req)); return { message: 'Removed from the waitlist' } }))
// Early sign-ups (new players from the returners-only window): charge the saved card and register, or take them out.
// Let a family in from the line: charge their saved card and register the player.
admin.post('/:id/line/:pid/accept', wrap(async (req) => C.acceptFromLine(p(req, 'pid'), actor(req))))
admin.get('/:id/export.csv', wrap((req, res) => {
  const c = C.mustCampaign(p(req, 'id'))
  const rows = C.exportRows(c.id, req.query.unsynced === '1')
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${c.slug}-registrations${req.query.unsynced === '1' ? '-not-in-sportsengine' : ''}.csv"`)
  res.send(rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n'))
}))

// ---------- finance: revenue and payment-plan receivables ----------
const fin = Router()
fin.use(requireAdmin)
register.use('/api/admin/finance', fin)
const campaignQ = (req: Request) => (req.query.campaign ? String(req.query.campaign).slice(0, 40) : null)
fin.get('/', wrap((req) => revenue(campaignQ(req))))
fin.get('/payments.csv', wrap((req, res) => {
  const rows = P.receivablesCsv(campaignQ(req))
  const cell = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  res.type('text/csv').attachment('plan-payments.csv').send(rows.map((r) => r.map(cell).join(',')).join('\n'))
}))
fin.get('/orders/:id', wrap((req) => {
  const id = p(req, 'id')
  const plan = P.receivables().plans.find((x) => x.order_id === id)
  if (!plan) throw new UserError('Unknown payment plan')
  return { plan, log: P.contactLog(id), text: P.textFor(id), payUrl: P.payLink(id), mergeFields: P.MERGE_FIELDS }
}))
fin.post('/orders/:id/remind', wrap(async (req) => P.remindFamily(p(req, 'id'), actor(req))))
fin.post('/orders/:id/email', wrap(async (req) => {
  const b = z.object({ subject: z.string().max(200), body: z.string().max(10000) }).parse(req.body)
  return P.sendCustomEmail(p(req, 'id'), b.subject, b.body, actor(req))
}))
fin.post('/orders/:id/text-preview', wrap((req) => P.textFor(p(req, 'id'), z.object({ template: z.string().max(1000).optional() }).parse(req.body).template)))
// The admin texted (or called) from their own phone: keep it in the collections history.
fin.post('/orders/:id/log', wrap((req) => {
  const b = z.object({ channel: z.enum(['text', 'call', 'note', 'email']), body: z.string().max(4000) }).parse(req.body)
  P.logContact(p(req, 'id'), b.channel, 'manual', actor(req), { subject: b.channel === 'text' ? 'Text sent' : b.channel === 'call' ? 'Phone call' : b.channel === 'email' ? 'Email (sent outside the app)' : 'Note', body: b.body })
  return { ok: true }
}))
fin.post('/installments/:id/charge', wrap(async (req) => P.chargeInstallment(p(req, 'id'), actor(req))))
fin.post('/installments/:id/record', wrap((req) => {
  const b = z.object({ method: z.enum(['cash', 'check', 'venmo', 'other']), note: z.string().max(500).default('') }).parse(req.body)
  P.recordPayment(p(req, 'id'), b.method, b.note, actor(req)); return { ok: true }
}))
fin.post('/installments/:id/waive', wrap((req) => { P.waiveInstallment(p(req, 'id'), z.object({ note: z.string().max(500).default('') }).parse(req.body).note, actor(req)); return { ok: true } }))
fin.post('/installments/:id/move', wrap((req) => { P.moveDueDate(p(req, 'id'), z.object({ due: z.string().max(10) }).parse(req.body).due, actor(req)); return { ok: true } }))
fin.post('/run', wrap(async () => P.runPlans()))
