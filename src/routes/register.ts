import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { requireAdmin, throttled, noteFailure } from '../lib/auth.js'
import * as C from '../lib/campaigns.js'
import * as O from '../lib/outreach.js'
import { UserError } from '../lib/league.js'
import { verifyStripeSignature } from '../lib/stripe.js'

// Public registration pages, the Stripe webhook, and the campaign builder API.

export const stripeWebhook = Router()
// Raw body: Stripe signs exactly the bytes it sends.
stripeWebhook.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!config.stripe.webhookSecret) return res.status(503).json({ error: 'webhook not configured' })
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (!verifyStripeSignature(raw, req.get('stripe-signature'), config.stripe.webhookSecret)) return res.status(400).json({ error: 'bad signature' })
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
register.get('/api/register/:slug/returning', wrap((req, res) => {
  const now = Date.now(), a = lookups.get(req.ip ?? '')
  const fresh = !a || a.until < now
  lookups.set(req.ip ?? '', { n: fresh ? 1 : a!.n + 1, until: fresh ? now + 15 * 60e3 : a!.until })
  if (!fresh && a!.n >= 120) return res.status(429).json({ error: 'Too many lookups — please wait a few minutes.' })
  if (lookups.size > 5000) for (const [k, v] of lookups) if (v.until < now) lookups.delete(k)
  const c = C.campaignBySlug(p(req, 'slug'))
  if (!c || (c.status === 'draft' && !req.admin)) throw new UserError('No registration here')
  const q = (k: string) => String(req.query[k] ?? '').slice(0, 80)
  return { matches: C.returningMatches(c, q('first'), q('last'), q('dob')) }
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
    returning: z.string().max(40).optional(),
  })).max(8),
})
register.post('/api/register/:slug/checkout', wrap(async (req, res) => {
  const key = `checkout:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again.' })
  if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' })
  const out = await C.startCheckout(p(req, 'slug'), checkoutBody.parse(req.body), config.baseUrl, !!req.admin)
  noteFailure(key) // counts checkouts started: 8 per 15 minutes per address is plenty for a family
  return out
}))
register.get('/api/register/order/:id', wrap((req) => C.confirmFromReturn(p(req, 'id'), req.query.session_id ? String(req.query.session_id) : null)))

// ---------- admin ----------
const admin = Router()
admin.use(requireAdmin)
register.use('/api/admin/campaigns', admin)

admin.get('/', wrap(() => C.campaigns()))
const campaignBody = z.object({
  name: z.string().min(1).max(80), slug: z.string().max(60).optional(), season_id: z.union([z.string(), z.null()]).optional(),
  status: z.enum(['draft', 'open', 'closed']).optional(), opens_at: z.union([z.string().max(40), z.null()]).optional(), closes_at: z.union([z.string().max(40), z.null()]).optional(),
  intro: z.string().max(10000).optional(), confirmation: z.string().max(10000).optional(),
})
admin.post('/', wrap((req) => {
  const c = C.saveCampaign(null, campaignBody.parse(req.body), actor(req))
  C.seedDefaults(c.id, actor(req))
  if (c.season_id) C.programsFromSeason(c.id, actor(req))
  return c
}))
admin.get('/:id', wrap((req) => C.adminCampaign(p(req, 'id'))))
admin.patch('/:id', wrap((req) => C.saveCampaign(p(req, 'id'), campaignBody.parse(req.body), actor(req))))
admin.post('/:id/programs-from-season', wrap((req) => { const n = C.programsFromSeason(p(req, 'id'), actor(req)); return { added: n, message: n ? `Added ${n} programs` : 'Every division already has a program' } }))

const ids = z.array(z.string().max(40)).max(50).optional()
const offeringBody = z.object({ name: z.string().min(1).max(80), description: z.string().max(2000).optional(), division_id: z.union([z.string(), z.null()]).optional(),
  min_age: z.union([z.number().int().min(0).max(99), z.null()]).optional(), max_age: z.union([z.number().int().min(0).max(99), z.null()]).optional(),
  capacity: z.union([z.number().int().min(0).max(10000), z.null()]).optional(), waitlist: z.boolean().optional(), sort: z.number().int().optional(), active: z.boolean().optional() })
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
  const r = await C.offerSpot(p(req, 'pid'), config.baseUrl, actor(req))
  return { ...r, message: r.registered ? 'Nothing to pay — registered' : 'Payment link created — send it to the family' }
}))
admin.get('/:id/export.csv', wrap((req, res) => {
  const c = C.mustCampaign(p(req, 'id'))
  const rows = C.exportRows(c.id, req.query.unsynced === '1')
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${c.slug}-registrations${req.query.unsynced === '1' ? '-not-in-sportsengine' : ''}.csv"`)
  res.send(rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n'))
}))
