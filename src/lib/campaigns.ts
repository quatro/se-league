import { db } from '../db.js'
import { config } from '../config.js'
import {
  ageIn, audit, changed, createKid, divisions, enroll, fitsAge, isDraftOnly, mustSeason, refreshPools, season, seasonState, slugOk,
  UserError, type Kid, type Season,
} from './league.js'
import { createCheckout, getCheckout, stripeConfigured, stripeMode, type LineItem } from './stripe.js'
import { leagueAge, nameKey, normDate, uid } from './text.js'

// Registration campaigns: our own signup page and Stripe checkout.
//
// A campaign ("2027 Spring") offers programs — usually the season's divisions,
// with Majors + Minors as one "Major/Minor" program — plus priced items charged
// per kid and extra questions, all built in admin. A family fills in the form,
// pays on Stripe's hosted page, and the moment Stripe confirms payment each
// kid becomes Registered in their division (seat counts, draft pools and kid
// history update with it). Kids whose program is full go on a free waitlist;
// an admin can later offer them the spot with a payment link.

export interface Campaign { id: string; slug: string; name: string; season_id: string | null; status: 'draft' | 'open' | 'closed'; opens_at: string | null; closes_at: string | null; intro: string; confirmation: string; created_at: string }
export interface Offering { id: string; campaign_id: string; division_id: string | null; name: string; description: string; min_age: number | null; max_age: number | null; capacity: number | null; waitlist: number; sort: number; active: number }
export interface Item { id: string; campaign_id: string; name: string; description: string; price_cents: number; required: number; max_qty: number; offering_ids: string; tag: string; sort: number; active: number }
export interface Question { id: string; campaign_id: string; scope: 'player' | 'family'; label: string; help: string; type: QType; options: string; required: number; offering_ids: string; sort: number; active: number }
export type QType = 'text' | 'textarea' | 'number' | 'date' | 'yesno' | 'select' | 'multi' | 'agreement'
export interface Order { id: string; campaign_id: string; status: 'pending' | 'paid' | 'waitlisted' | 'cancelled' | 'refunded'; guardian: string; answers: string; total_cents: number; stripe_session_id: string | null; stripe_payment_id: string | null; stripe_mode: string | null; created_at: string; paid_at: string | null; se_synced_at: string | null; admin_notes: string }
export interface OrderPlayer { id: string; order_id: string; first_name: string; last_name: string; birthdate: string; gender: string; offering_id: string; status: 'pending' | 'registered' | 'waitlisted' | 'offered' | 'cancelled'; answers: string; kid_id: string | null; enrollment_id: string | null; offer_session_id: string | null }

const J = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T } catch { return d } }
const appliesTo = (ids: string, offeringId: string) => { const l = J<string[]>(ids, []); return !l.length || l.includes(offeringId) }

// ---------- reads ----------
export const campaigns = () => db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() as Campaign[]
export const campaign = (id: string) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined
export const campaignBySlug = (s: string) => db.prepare('SELECT * FROM campaigns WHERE slug = ?').get(s) as Campaign | undefined
export function mustCampaign(id: string): Campaign { const c = campaign(id); if (!c) throw new UserError('Unknown campaign'); return c }
export const offerings = (cid: string) => db.prepare('SELECT * FROM offerings WHERE campaign_id = ? ORDER BY sort, name').all(cid) as Offering[]
export const items = (cid: string) => db.prepare('SELECT * FROM items WHERE campaign_id = ? ORDER BY sort, name').all(cid) as Item[]
export const questions = (cid: string) => db.prepare('SELECT * FROM questions WHERE campaign_id = ? ORDER BY scope DESC, sort, label').all(cid) as Question[]
export const order = (id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Order | undefined
const players = (orderId: string) => db.prepare('SELECT * FROM order_players WHERE order_id = ?').all(orderId) as OrderPlayer[]

/** Season used for league ages: the campaign's season, else a stand-in for the current year. */
function ageSeason(c: Campaign): Season {
  if (c.season_id) { const s = season(c.season_id); if (s) return s }
  const y = new Date().getFullYear()
  return { id: String(y), year: y, status: 'planning', age_cutoff: '04-30', warn_at: 4, rolled_from: null, notes: '' }
}

/** Seats left for a program: its division's (or Majors+Minors group's) open seats, or a standalone cap. */
export function availability(o: Offering): { open: number | null; full: boolean } {
  if (o.division_id) {
    const d = db.prepare('SELECT * FROM divisions WHERE id = ?').get(o.division_id) as { season_id: string; group_key: string; closed: number } | undefined
    if (!d) return { open: null, full: false }
    const st = seasonState(d.season_id, false)
    const seats = d.group_key ? st.groups.find((g) => g.key === d.group_key)?.seats : st.divisions.find((x) => x.id === o.division_id)?.seats
    if (!seats || !seats.capacity) return { open: null, full: !!d.closed }
    return { open: seats.open, full: seats.open <= 0 || !!d.closed }
  }
  if (o.capacity == null) return { open: null, full: false }
  const n = (db.prepare(`SELECT COUNT(*) n FROM order_players WHERE offering_id = ? AND status = 'registered'`).get(o.id) as { n: number }).n
  return { open: o.capacity - n, full: n >= o.capacity }
}

function isOpen(c: Campaign): string | null {
  if (c.status !== 'open') return c.status === 'draft' ? 'Registration hasn’t opened yet.' : 'Registration is closed.'
  const now = new Date().toISOString()
  if (c.opens_at && now < c.opens_at) return `Registration opens ${c.opens_at.slice(0, 10)}.`
  if (c.closes_at && now > c.closes_at) return 'Registration is closed.'
  return null
}

/** What the public form needs. Never includes other families' data. */
export function publicCampaign(slugStr: string, preview = false) {
  const c = campaignBySlug(slugStr)
  if (!c || (c.status === 'draft' && !preview)) throw new UserError('No registration here')
  const s = ageSeason(c)
  return {
    campaign: { name: c.name, slug: c.slug, intro: c.intro, closedReason: isOpen(c), year: s.year, ageCutoff: s.age_cutoff },
    offerings: offerings(c.id).filter((o) => o.active).map((o) => {
      const a = availability(o)
      return { id: o.id, name: o.name, description: o.description, min_age: o.min_age, max_age: o.max_age, full: a.full, waitlist: !!o.waitlist, left: a.open != null && a.open <= 10 ? Math.max(0, a.open) : null }
    }),
    items: items(c.id).filter((i) => i.active).map((i) => ({ id: i.id, name: i.name, description: i.description, price_cents: i.price_cents, required: !!i.required, max_qty: i.max_qty, offering_ids: J<string[]>(i.offering_ids, []) })),
    questions: questions(c.id).filter((q) => q.active).map((q) => ({ id: q.id, scope: q.scope, label: q.label, help: q.help, type: q.type, options: J<string[]>(q.options, []), required: !!q.required, offering_ids: J<string[]>(q.offering_ids, []) })),
    stripe: stripeConfigured() ? stripeMode() : null,
  }
}

// ---------- admin: building a campaign ----------
export interface CampaignInput { name: string; slug?: string; season_id?: string | null; status?: Campaign['status']; opens_at?: string | null; closes_at?: string | null; intro?: string; confirmation?: string }
export function saveCampaign(id: string | null, p: CampaignInput, actor: string): Campaign {
  const name = p.name.trim()
  if (!name) throw new UserError('Campaign needs a name')
  const slugStr = (p.slug?.trim() || nameKey(name).replace(/ /g, '-')).toLowerCase()
  if (!slugOk(slugStr)) throw new UserError('Web address can only use letters, numbers and dashes')
  const clash = campaignBySlug(slugStr)
  if (clash && clash.id !== id) throw new UserError(`/register/${slugStr} is already used by ${clash.name}`)
  if (p.season_id) mustSeason(p.season_id)
  if (id) {
    const c = mustCampaign(id)
    db.prepare(`UPDATE campaigns SET name=?, slug=?, season_id=?, status=?, opens_at=?, closes_at=?, intro=?, confirmation=? WHERE id=?`)
      .run(name, slugStr, p.season_id !== undefined ? p.season_id : c.season_id, p.status ?? c.status, p.opens_at !== undefined ? p.opens_at : c.opens_at,
        p.closes_at !== undefined ? p.closes_at : c.closes_at, p.intro ?? c.intro, p.confirmation ?? c.confirmation, id)
    audit(actor, 'campaign_saved', p.season_id ?? c.season_id, null, { campaign: name, status: p.status ?? c.status })
  } else {
    id = uid()
    db.prepare(`INSERT INTO campaigns (id, slug, name, season_id, status, opens_at, closes_at, intro, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, slugStr, name, p.season_id ?? null, p.status ?? 'draft', p.opens_at ?? null, p.closes_at ?? null, p.intro ?? '', p.confirmation ?? '')
    audit(actor, 'campaign_added', p.season_id ?? null, null, { campaign: name })
  }
  changed()
  return campaign(id)!
}

/**
 * One program per season division families can register for. Divisions that
 * share a group (Majors + Minors) become one program pointing at the
 * division families actually register into; draft-only divisions are skipped.
 */
export function programsFromSeason(campaignId: string, actor: string): number {
  const c = mustCampaign(campaignId)
  if (!c.season_id) throw new UserError('Pick the season this campaign registers for first')
  const have = new Set(offerings(c.id).map((o) => o.division_id).filter(Boolean))
  const ds = divisions(c.season_id)
  let n = 0, sort = offerings(c.id).length
  const doneGroups = new Set<string>()
  for (const d of ds) {
    if (isDraftOnly(d)) continue
    if (d.group_key) {
      if (doneGroups.has(d.group_key)) continue
      doneGroups.add(d.group_key)
    }
    if (have.has(d.id)) continue
    const members = d.group_key ? ds.filter((x) => x.group_key === d.group_key) : [d]
    const name = members.length > 1 ? members.slice().reverse().map((x) => x.name.replace(/s$/, '')).join('/') : d.name
    const min = Math.min(...members.map((x) => x.min_age ?? 0)), max = Math.max(...members.map((x) => x.max_age ?? 99))
    db.prepare('INSERT INTO offerings (id, campaign_id, division_id, name, description, min_age, max_age, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid(), c.id, d.id, name, members.length > 1 ? 'Tryouts and the draft decide which league each player is placed in.' : '', min || null, max === 99 ? null : max, ++sort)
    n++
  }
  audit(actor, 'campaign_programs_added', c.season_id, null, { campaign: c.name, added: n })
  changed()
  return n
}

export interface OfferingInput { name: string; description?: string; division_id?: string | null; min_age?: number | null; max_age?: number | null; capacity?: number | null; waitlist?: boolean; sort?: number; active?: boolean }
export function saveOffering(campaignId: string, id: string | null, p: OfferingInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.name.trim()) throw new UserError('Program needs a name')
  if (p.division_id && !divisions(c.season_id ?? '').some((d) => d.id === p.division_id)) throw new UserError('That division isn’t in this campaign’s season')
  const vals = [p.name.trim(), p.description ?? '', p.division_id ?? null, p.min_age ?? null, p.max_age ?? null, p.capacity ?? null, p.waitlist === false ? 0 : 1, p.sort ?? 0, p.active === false ? 0 : 1]
  if (id) db.prepare('UPDATE offerings SET name=?, description=?, division_id=?, min_age=?, max_age=?, capacity=?, waitlist=?, sort=?, active=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO offerings (name, description, division_id, min_age, max_age, capacity, waitlist, sort, active, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_program_saved', c.season_id, null, { campaign: c.name, program: p.name })
  changed()
}
export function deleteOffering(id: string, actor: string) {
  if (db.prepare('SELECT 1 FROM order_players WHERE offering_id = ?').get(id)) throw new UserError('Families have registered for this program — turn it off instead')
  db.prepare('DELETE FROM offerings WHERE id = ?').run(id)
  audit(actor, 'campaign_program_deleted', null, null, { id })
  changed()
}

export interface ItemInput { name: string; description?: string; price_cents: number; required?: boolean; max_qty?: number; offering_ids?: string[]; tag?: string; sort?: number; active?: boolean }
export function saveItem(campaignId: string, id: string | null, p: ItemInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.name.trim()) throw new UserError('Item needs a name')
  const vals = [p.name.trim(), p.description ?? '', p.price_cents, p.required ? 1 : 0, p.required ? 1 : Math.max(1, p.max_qty ?? 1), JSON.stringify(p.offering_ids ?? []), (p.tag ?? '').trim(), p.sort ?? 0, p.active === false ? 0 : 1]
  if (id) db.prepare('UPDATE items SET name=?, description=?, price_cents=?, required=?, max_qty=?, offering_ids=?, tag=?, sort=?, active=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO items (name, description, price_cents, required, max_qty, offering_ids, tag, sort, active, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_item_saved', c.season_id, null, { campaign: c.name, item: p.name, price: p.price_cents })
  changed()
}
export function deleteItem(id: string, actor: string) {
  if (db.prepare('SELECT 1 FROM order_lines WHERE item_id = ?').get(id)) throw new UserError('Families have bought this — turn it off instead')
  db.prepare('DELETE FROM items WHERE id = ?').run(id)
  audit(actor, 'campaign_item_deleted', null, null, { id })
  changed()
}

export interface QuestionInput { scope: 'player' | 'family'; label: string; help?: string; type: QType; options?: string[]; required?: boolean; offering_ids?: string[]; sort?: number; active?: boolean }
export function saveQuestion(campaignId: string, id: string | null, p: QuestionInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.label.trim()) throw new UserError('Question needs a label')
  const opts = (p.options ?? []).map((o) => o.trim()).filter(Boolean)
  if ((p.type === 'select' || p.type === 'multi') && opts.length < 2) throw new UserError('Give at least two choices')
  const vals = [p.scope, p.label.trim(), p.help ?? '', p.type, JSON.stringify(opts), p.required || p.type === 'agreement' ? 1 : 0, JSON.stringify(p.offering_ids ?? []), p.sort ?? 0, p.active === false ? 0 : 1]
  if (id) db.prepare('UPDATE questions SET scope=?, label=?, help=?, type=?, options=?, required=?, offering_ids=?, sort=?, active=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO questions (scope, label, help, type, options, required, offering_ids, sort, active, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_question_saved', c.season_id, null, { campaign: c.name, question: p.label })
  changed()
}
export function deleteQuestion(id: string, actor: string) {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id)
  audit(actor, 'campaign_question_deleted', null, null, { id })
  changed()
}

// ---------- checkout ----------
export interface CheckoutInput {
  guardian: { firstName: string; lastName: string; email: string; phone: string; address?: string; city?: string; state?: string; zip?: string }
  answers: Record<string, unknown>
  players: { firstName: string; lastName: string; birthdate: string; gender?: string; offeringId: string; items: Record<string, number>; answers: Record<string, unknown> }[]
}

function checkAnswer(q: Question, v: unknown, who: string): unknown {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (q.type === 'agreement' && v !== true)
  if (empty) { if (q.required) throw new UserError(q.type === 'agreement' ? `${who}: please agree to “${q.label}”` : `${who}: “${q.label}” is required`); return undefined }
  const opts = J<string[]>(q.options, [])
  switch (q.type) {
    case 'yesno': if (v !== 'Yes' && v !== 'No') throw new UserError(`${who}: answer “${q.label}” with Yes or No`); return v
    case 'select': if (!opts.includes(String(v))) throw new UserError(`${who}: pick one of the choices for “${q.label}”`); return v
    case 'multi': if (!Array.isArray(v) || v.some((x) => !opts.includes(String(x)))) throw new UserError(`${who}: pick from the choices for “${q.label}”`); return v
    case 'number': if (!Number.isFinite(Number(v))) throw new UserError(`${who}: “${q.label}” should be a number`); return Number(v)
    case 'date': if (!normDate(String(v))) throw new UserError(`${who}: “${q.label}” should be a date`); return normDate(String(v))
    case 'agreement': return true
    default: return String(v).slice(0, 4000)
  }
}

export interface Quote {
  campaign: Campaign; season: Season
  guardian: CheckoutInput['guardian']; answers: Record<string, unknown>
  players: { input: CheckoutInput['players'][number]; offering: Offering; age: number | null; waitlisted: boolean; answers: Record<string, unknown>; lines: { item: Item; qty: number }[] }[]
  total: number
}

/** Validate a form submission and price it. Throws a family-readable error on anything wrong. */
export function quote(slugStr: string, inp: CheckoutInput): Quote {
  const c = campaignBySlug(slugStr)
  if (!c) throw new UserError('No registration here')
  const closed = isOpen(c)
  if (closed) throw new UserError(closed)
  const g = inp.guardian
  if (!g.firstName?.trim() || !g.lastName?.trim()) throw new UserError('Parent/guardian name is required')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g.email ?? '')) throw new UserError('A valid email is required for the receipt')
  if ((g.phone ?? '').replace(/\D/g, '').length < 10) throw new UserError('A phone number is required')
  if (!inp.players.length) throw new UserError('Add at least one player')
  if (inp.players.length > 8) throw new UserError('Register up to 8 players at a time')
  const s = ageSeason(c)
  const offs = offerings(c.id).filter((o) => o.active), its = items(c.id).filter((i) => i.active), qs = questions(c.id).filter((q) => q.active)
  const familyAnswers: Record<string, unknown> = {}
  for (const q of qs.filter((q) => q.scope === 'family')) { const v = checkAnswer(q, inp.answers?.[q.id], 'Family'); if (v !== undefined) familyAnswers[q.id] = v }
  const seen = new Set<string>()
  const taken = new Map<string, number>() // seats this order would use per program
  const out: Quote['players'] = []
  for (const p of inp.players) {
    const name = `${p.firstName?.trim() ?? ''} ${p.lastName?.trim() ?? ''}`.trim()
    if (!p.firstName?.trim() || !p.lastName?.trim()) throw new UserError('Each player needs a first and last name')
    const dob = normDate(p.birthdate)
    if (!dob) throw new UserError(`${name}: birthdate is required`)
    const key = `${nameKey(name)}|${dob}`
    if (seen.has(key)) throw new UserError(`${name} is listed twice`)
    seen.add(key)
    const o = offs.find((x) => x.id === p.offeringId)
    if (!o) throw new UserError(`${name}: pick a program`)
    const age = leagueAge(dob, s.year, s.age_cutoff)
    if (!fitsAge({ min_age: o.min_age, max_age: o.max_age }, age)) throw new UserError(`${name} is league age ${age} for ${s.year}; ${o.name} is for ages ${o.min_age ?? '?'}–${o.max_age ?? '?'}`)
    if (c.season_id) {
      const already = db.prepare(`SELECT e.status FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = ? AND k.name_key = ? AND (k.birthdate IS NULL OR k.birthdate = ?)
        AND e.status = 'Registered'`).get(c.season_id, nameKey(name), dob)
      if (already) throw new UserError(`${name} is already registered for ${s.year}`)
    }
    const a = availability(o)
    const used = (taken.get(o.id) ?? 0) + 1
    const waitlisted = a.full || (a.open != null && a.open - used < 0)
    if (waitlisted && !o.waitlist) throw new UserError(`${o.name} is full`)
    if (!waitlisted) taken.set(o.id, used)
    const lines: { item: Item; qty: number }[] = []
    for (const it of its.filter((i) => appliesTo(i.offering_ids, o.id))) {
      let qty = Math.floor(Number(p.items?.[it.id] ?? 0)) || 0
      if (it.required) qty = 1
      if (qty < 0 || qty > it.max_qty) throw new UserError(`${name}: ${it.name} — choose up to ${it.max_qty}`)
      if (qty) lines.push({ item: it, qty })
    }
    const answers: Record<string, unknown> = {}
    for (const q of qs.filter((q) => q.scope === 'player' && appliesTo(q.offering_ids, o.id))) { const v = checkAnswer(q, p.answers?.[q.id], name); if (v !== undefined) answers[q.id] = v }
    out.push({ input: { ...p, birthdate: dob }, offering: o, age, waitlisted, answers, lines })
  }
  const total = out.filter((p) => !p.waitlisted).reduce((a, p) => a + p.lines.reduce((b, l) => b + l.item.price_cents * l.qty, 0), 0)
  return { campaign: c, season: s, guardian: g, answers: familyAnswers, players: out, total }
}

/** Save the order and start Stripe checkout. Returns where to send the family next. */
export async function startCheckout(slugStr: string, inp: CheckoutInput, baseUrl: string): Promise<{ orderId: string; url: string }> {
  const q = quote(slugStr, inp)
  if (q.total > 0 && !stripeConfigured()) throw new UserError('Online payment isn’t set up yet — please try again later')
  const orderId = uid() + uid()
  const allWaitlisted = q.players.every((p) => p.waitlisted)
  db.transaction(() => {
    db.prepare(`INSERT INTO orders (id, campaign_id, status, guardian, answers, total_cents, stripe_mode) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, q.campaign.id, q.total > 0 ? 'pending' : allWaitlisted ? 'waitlisted' : 'pending', JSON.stringify(q.guardian), JSON.stringify(q.answers), q.total, q.total > 0 ? stripeMode() : null)
    for (const p of q.players) {
      const pid = uid()
      db.prepare(`INSERT INTO order_players (id, order_id, first_name, last_name, birthdate, gender, offering_id, status, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pid, orderId, p.input.firstName.trim(), p.input.lastName.trim(), p.input.birthdate, p.input.gender ?? '', p.offering.id, p.waitlisted ? 'waitlisted' : 'pending', JSON.stringify(p.answers))
      for (const l of p.lines) db.prepare('INSERT INTO order_lines (order_id, order_player_id, item_id, name, tag, unit_cents, qty, charged) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(orderId, pid, l.item.id, l.item.name, l.item.tag, l.item.price_cents, l.qty, p.waitlisted ? 0 : 1)
    }
  })()
  const done = `${baseUrl}/register/${q.campaign.slug}/done?order=${orderId}`
  if (q.total === 0) {
    // Nothing to pay (every kid waitlisted, or a free program): record it now.
    fulfill(orderId, null)
    return { orderId, url: done }
  }
  const lines: LineItem[] = q.players.filter((p) => !p.waitlisted).flatMap((p) => p.lines.map((l) => ({
    name: `${l.item.name} — ${p.input.firstName.trim()} ${p.input.lastName.trim()}`, description: p.offering.name, unitCents: l.item.price_cents, qty: l.qty,
  })))
  const session = await createCheckout({
    lines, email: q.guardian.email.trim(), orderId, idempotencyKey: `order-${orderId}`,
    successUrl: `${done}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${baseUrl}/register/${q.campaign.slug}?cancelled=${orderId}`,
    description: `${q.campaign.name} registration — ${q.players.map((p) => `${p.input.firstName} ${p.input.lastName}`).join(', ')}`,
  })
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId)
  return { orderId, url: session.url }
}

/** Find or create the kid for a registered player, matching name + birthdate so their history stays in one place. */
function kidFor(p: OrderPlayer): Kid {
  const name = `${p.first_name} ${p.last_name}`
  const cands = (db.prepare('SELECT * FROM kids WHERE name_key = ?').all(nameKey(name)) as Kid[]).filter((k) => !k.birthdate || k.birthdate === p.birthdate)
  const exact = cands.find((k) => k.birthdate === p.birthdate) ?? (cands.length === 1 ? cands[0] : undefined)
  if (exact) { if (!exact.birthdate) db.prepare('UPDATE kids SET birthdate = ? WHERE id = ?').run(p.birthdate, exact.id); return exact }
  return createKid(name, p.birthdate)
}

/** Put one paid (or waitlisted) player into the season. */
function place(o: Order, p: OrderPlayer, c: Campaign, status: 'Registered' | 'Waitlist') {
  const off = db.prepare('SELECT * FROM offerings WHERE id = ?').get(p.offering_id) as Offering
  const k = kidFor(p)
  let enrollmentId: string | null = null
  const bought = (db.prepare('SELECT name, qty, tag FROM order_lines WHERE order_player_id = ?').all(p.id) as { name: string; qty: number; tag: string }[])
  if (c.season_id && off.division_id) {
    const e = db.prepare('SELECT * FROM enrollments WHERE season_id = ? AND kid_id = ?').get(c.season_id, k.id) as { id: string; status: string; division_id: string | null } | undefined
    if (e) {
      // Usually an expected returner. A real registration wins over Expected / Need to contact / Waitlist.
      if (status === 'Registered' || e.status !== 'Registered')
        db.prepare(`UPDATE enrollments SET status = ?, se_program = ?, registered_at = CASE WHEN ? = 'Registered' THEN ? ELSE registered_at END, division_id = COALESCE(division_id, ?), updated_at = datetime('now') WHERE id = ?`)
          .run(status, off.name, status, new Date().toISOString(), off.division_id, e.id)
      enrollmentId = e.id
    } else {
      const div = db.prepare('SELECT group_key FROM divisions WHERE id = ?').get(off.division_id) as { group_key: string }
      enrollmentId = enroll(c.season_id, k.id, { divisionId: off.division_id, status, tryout: !!div.group_key, age: null }, 'registration').id
      db.prepare('UPDATE enrollments SET se_program = ?, division_locked = 0 WHERE id = ?').run(off.name, enrollmentId)
    }
  }
  db.prepare('UPDATE order_players SET kid_id = ?, enrollment_id = ? WHERE id = ?').run(k.id, enrollmentId, p.id)
  db.prepare(`INSERT INTO registrations (source, verified, raw, first_name, last_name, birthdate, reg_year, program, season_id, outcome, kid_id, enrollment_id, division_id, note)
    VALUES ('web', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(JSON.stringify({ order: o.id, player: p.id, campaign: c.slug }), p.first_name, p.last_name, p.birthdate,
    c.season_id ? Number(c.season_id) : null, off.name, c.season_id, status === 'Registered' ? 'placed' : 'waitlist', k.id, enrollmentId, off.division_id,
    `${c.name}: ${status === 'Registered' ? 'paid' : 'waitlisted'}${bought.length ? ` — ${bought.map((b) => `${b.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`).join(', ')}` : ''}`)
  audit('registration', status === 'Registered' ? 'registered_online' : 'waitlisted_online', c.season_id, k.id,
    { campaign: c.name, program: off.name, order: o.id, bought: bought.map((b) => `${b.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`) })
}

/** Payment confirmed (or nothing to pay): register every pending player. Safe to call twice. */
export function fulfill(orderId: string, paymentId: string | null) {
  const res = db.transaction(() => {
    const o = order(orderId)
    if (!o) throw new Error(`no order ${orderId}`)
    const c = mustCampaign(o.campaign_id)
    const ps = players(orderId)
    let did = 0
    for (const p of ps) {
      if (p.status === 'pending') { place(o, p, c, 'Registered'); db.prepare(`UPDATE order_players SET status = 'registered' WHERE id = ?`).run(p.id); did++ }
      else if (p.status === 'waitlisted' && !p.enrollment_id && !p.kid_id) { place(o, p, c, 'Waitlist'); did++ }
    }
    if (o.status === 'pending' || o.status === 'waitlisted') {
      const paid = ps.some((p) => p.status === 'pending' || p.status === 'registered')
      db.prepare(`UPDATE orders SET status = ?, paid_at = COALESCE(paid_at, ?), stripe_payment_id = COALESCE(?, stripe_payment_id) WHERE id = ?`)
        .run(paid ? 'paid' : 'waitlisted', paid ? new Date().toISOString() : null, paymentId, orderId)
    }
    return { did, seasonId: c.season_id }
  })()
  if (res.seasonId) refreshPools(res.seasonId)
  changed()
  return res
}

/** A waitlisted kid's spot was paid for through an offer link. */
function fulfillOffer(orderPlayerId: string, paymentId: string | null) {
  const res = db.transaction(() => {
    const p = db.prepare('SELECT * FROM order_players WHERE id = ?').get(orderPlayerId) as OrderPlayer | undefined
    if (!p || p.status === 'registered') return null
    const o = order(p.order_id)!, c = mustCampaign(o.campaign_id)
    place(o, p, c, 'Registered')
    db.prepare(`UPDATE order_players SET status = 'registered' WHERE id = ?`).run(p.id)
    const amt = (db.prepare('SELECT COALESCE(SUM(unit_cents * qty), 0) s FROM order_lines WHERE order_player_id = ? AND charged = 0').get(p.id) as { s: number }).s
    db.prepare('UPDATE order_lines SET charged = 1 WHERE order_player_id = ?').run(p.id)
    db.prepare(`UPDATE orders SET status = 'paid', total_cents = total_cents + ?, paid_at = COALESCE(paid_at, ?), admin_notes = TRIM(admin_notes || ' ' || ?) WHERE id = ?`)
      .run(amt, new Date().toISOString(), `Waitlist spot paid for ${p.first_name}${paymentId ? ` (${paymentId})` : ''}.`, o.id)
    return c.season_id
  })()
  if (res) refreshPools(res)
  changed()
}

/** Admin offers a waitlisted kid their spot: a Stripe link for that kid's items (sent to the family by the admin). */
export async function offerSpot(orderPlayerId: string, baseUrl: string, actor: string): Promise<{ url: string | null; registered: boolean }> {
  const p = db.prepare('SELECT * FROM order_players WHERE id = ?').get(orderPlayerId) as OrderPlayer | undefined
  if (!p || !['waitlisted', 'offered'].includes(p.status)) throw new UserError('That player isn’t on the waitlist')
  const o = order(p.order_id)!, c = mustCampaign(o.campaign_id), g = J<CheckoutInput['guardian']>(o.guardian, {} as CheckoutInput['guardian'])
  const lines = db.prepare('SELECT * FROM order_lines WHERE order_player_id = ?').all(p.id) as { name: string; unit_cents: number; qty: number }[]
  const total = lines.reduce((a, l) => a + l.unit_cents * l.qty, 0)
  audit(actor, 'waitlist_spot_offered', c.season_id, p.kid_id, { campaign: c.name, player: `${p.first_name} ${p.last_name}` })
  if (!total) { fulfillOffer(p.id, null); return { url: null, registered: true } }
  if (!stripeConfigured()) throw new UserError('Stripe is not configured')
  const session = await createCheckout({
    lines: lines.map((l) => ({ name: `${l.name} — ${p.first_name} ${p.last_name}`, unitCents: l.unit_cents, qty: l.qty })),
    email: g.email, orderId: o.id, idempotencyKey: `offer-${p.id}-${Date.now()}`, extraMetadata: { order_player_id: p.id },
    successUrl: `${baseUrl}/register/${c.slug}/done?order=${o.id}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${baseUrl}/register/${c.slug}`,
    description: `${c.name} registration — ${p.first_name} ${p.last_name} (waitlist spot)`,
  })
  db.prepare(`UPDATE order_players SET status = 'offered', offer_session_id = ? WHERE id = ?`).run(session.id, p.id)
  changed()
  return { url: session.url, registered: false }
}

/** Stripe webhook events. Returns a short note for the log. */
export function handleStripeEvent(ev: { type: string; data: { object: Record<string, unknown> } }): string {
  const obj = ev.data.object
  const meta = (obj.metadata ?? {}) as Record<string, string>
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status !== 'paid') return 'not paid yet'
    const pi = (obj.payment_intent as string | null) ?? null
    if (meta.order_player_id) { fulfillOffer(meta.order_player_id, pi); return `waitlist spot paid ${meta.order_player_id}` }
    const o = meta.order_id ? order(meta.order_id) : (db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(obj.id) as Order | undefined)
    if (!o) return 'unknown order'
    return `fulfilled ${o.id}: ${fulfill(o.id, pi).did} players`
  }
  if (ev.type === 'checkout.session.expired') {
    if (meta.order_player_id) { db.prepare(`UPDATE order_players SET status = 'waitlisted', offer_session_id = NULL WHERE id = ? AND status = 'offered'`).run(meta.order_player_id); changed(); return 'offer expired' }
    const n = db.prepare(`UPDATE orders SET status = 'cancelled' WHERE stripe_session_id = ? AND status = 'pending'`).run(obj.id).changes
    if (n) { db.prepare(`UPDATE order_players SET status = 'cancelled' WHERE order_id = (SELECT id FROM orders WHERE stripe_session_id = ?) AND status = 'pending'`).run(obj.id); changed() }
    return n ? 'abandoned checkout cancelled' : 'nothing to cancel'
  }
  if (ev.type === 'charge.refunded') {
    const pi = obj.payment_intent as string
    const full = obj.amount_refunded === obj.amount
    const o = db.prepare('SELECT * FROM orders WHERE stripe_payment_id = ?').get(pi) as Order | undefined
    if (!o) return 'refund for an unknown payment'
    // Refunds are flagged, not acted on: an admin decides whether the kid is withdrawn.
    db.prepare(`UPDATE orders SET status = CASE WHEN ? THEN 'refunded' ELSE status END, admin_notes = TRIM(admin_notes || ' ' || ?) WHERE id = ?`)
      .run(full ? 1 : 0, `${full ? 'Fully' : 'Partly'} refunded in Stripe (${((obj.amount_refunded as number) / 100).toFixed(2)}).`, o.id)
    audit('stripe', full ? 'order_refunded' : 'order_partly_refunded', null, null, { order: o.id })
    changed()
    return 'refund noted'
  }
  return 'ignored'
}

/** The thank-you page asks Stripe directly too, so a slow or missing webhook never leaves a paid family unregistered. */
export async function confirmFromReturn(orderId: string, sessionId: string | null) {
  const o = order(orderId)
  if (!o) throw new UserError('Unknown registration')
  if (sessionId && stripeConfigured()) {
    try {
      const s = await getCheckout(sessionId)
      if (s.payment_status === 'paid' && (s.metadata?.order_id === o.id)) {
        if (s.metadata.order_player_id) fulfillOffer(s.metadata.order_player_id, s.payment_intent)
        else if (o.status === 'pending') fulfill(o.id, s.payment_intent)
      }
    } catch (e) { console.error('[stripe] confirm on return failed', e) }
  }
  const fresh = order(orderId)!, c = mustCampaign(fresh.campaign_id)
  return {
    status: fresh.status, campaign: c.name, confirmation: c.confirmation, total_cents: fresh.total_cents,
    players: players(orderId).map((p) => ({ name: `${p.first_name} ${p.last_name}`, status: p.status, program: (db.prepare('SELECT name FROM offerings WHERE id = ?').get(p.offering_id) as { name: string }).name })),
  }
}

// ---------- admin: orders ----------
export function adminCampaign(id: string) {
  const c = mustCampaign(id)
  const os = db.prepare('SELECT * FROM orders WHERE campaign_id = ? ORDER BY created_at DESC').all(id) as Order[]
  const ps = db.prepare('SELECT op.* FROM order_players op JOIN orders o ON o.id = op.order_id WHERE o.campaign_id = ?').all(id) as OrderPlayer[]
  const lines = db.prepare('SELECT ol.* FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.campaign_id = ?').all(id) as { order_player_id: string; name: string; qty: number; unit_cents: number; charged: number; tag: string }[]
  const offs = offerings(id)
  return {
    campaign: c, url: `${config.baseUrl}/register/${c.slug}`, stripe: stripeConfigured() ? stripeMode() : null, webhook: !!config.stripe.webhookSecret,
    offerings: offs.map((o) => ({ ...o, ...availability(o), registered: ps.filter((p) => p.offering_id === o.id && p.status === 'registered').length, waitlisted: ps.filter((p) => p.offering_id === o.id && ['waitlisted', 'offered'].includes(p.status)).length })),
    items: items(id).map((i) => ({ ...i, offering_ids: J<string[]>(i.offering_ids, []), sold: lines.filter((l) => l.name === i.name && l.charged).reduce((a, l) => a + l.qty, 0) })),
    questions: questions(id).map((q) => ({ ...q, options: J<string[]>(q.options, []), offering_ids: J<string[]>(q.offering_ids, []) })),
    totals: {
      paid: os.filter((o) => o.status === 'paid').reduce((a, o) => a + o.total_cents, 0),
      orders: os.filter((o) => o.status === 'paid').length, players: ps.filter((p) => p.status === 'registered').length,
      waitlisted: ps.filter((p) => ['waitlisted', 'offered'].includes(p.status)).length, pending: os.filter((o) => o.status === 'pending').length,
      unsynced: os.filter((o) => o.status === 'paid' && !o.se_synced_at).length,
    },
    orders: os.map((o) => ({
      ...o, guardian: J(o.guardian, {}), answers: J(o.answers, {}),
      players: ps.filter((p) => p.order_id === o.id).map((p) => ({ ...p, answers: J(p.answers, {}), program: offs.find((x) => x.id === p.offering_id)?.name, lines: lines.filter((l) => l.order_player_id === p.id) })),
    })),
  }
}
export function markSynced(orderIds: string[], on: boolean, actor: string) {
  const up = db.prepare('UPDATE orders SET se_synced_at = ? WHERE id = ?')
  db.transaction(() => orderIds.forEach((id) => up.run(on ? new Date().toISOString() : null, id)))()
  audit(actor, on ? 'orders_marked_in_sportsengine' : 'orders_unmarked_sportsengine', null, null, { count: orderIds.length })
  changed()
}
export function setOrderNotes(id: string, notes: string) { db.prepare('UPDATE orders SET admin_notes = ? WHERE id = ?').run(notes, id); changed() }

/** One row per player with every answer and purchase, laid out for entering into SportsEngine. */
export function exportRows(id: string, onlyUnsynced: boolean): (string | number | null)[][] {
  const a = adminCampaign(id)
  const pq = a.questions.filter((q) => q.scope === 'player'), fq = a.questions.filter((q) => q.scope === 'family')
  const itemNames = a.items.map((i) => i.name)
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v === true ? 'Yes' : v == null ? '' : String(v))
  const head = ['Order', 'Order status', 'Paid at', 'In SportsEngine', 'Player first name', 'Player last name', 'Birthdate', 'Gender', 'Program', 'Player status',
    'Parent first name', 'Parent last name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', ...itemNames, 'Amount paid', ...fq.map((q) => q.label), ...pq.map((q) => q.label)]
  const rows: (string | number | null)[][] = [head]
  for (const o of a.orders) {
    if (!['paid', 'waitlisted'].includes(o.status) || (onlyUnsynced && o.se_synced_at)) continue
    const g = o.guardian as CheckoutInput['guardian']
    for (const p of o.players) {
      if (p.status === 'cancelled') continue
      const ans = p.answers as Record<string, unknown>, fans = o.answers as Record<string, unknown>
      rows.push([o.id, o.status, o.paid_at, o.se_synced_at ? 'Yes' : '', p.first_name, p.last_name, p.birthdate, p.gender, p.program ?? '', p.status,
        g.firstName, g.lastName, g.email, g.phone, g.address ?? '', g.city ?? '', g.state ?? '', g.zip ?? '',
        ...itemNames.map((n) => p.lines.filter((l) => l.name === n).reduce((s, l) => s + l.qty, 0) || ''),
        (p.lines.filter((l) => l.charged).reduce((s, l) => s + l.unit_cents * l.qty, 0) / 100).toFixed(2),
        ...fq.map((q) => fmt(fans[q.id])), ...pq.map((q) => fmt(ans[q.id]))])
    }
  }
  return rows
}

/** Seed a new campaign with the usual items and questions so admins start from something, not a blank page. */
export function seedDefaults(campaignId: string, actor: string) {
  const c = mustCampaign(campaignId)
  if (items(c.id).length || questions(c.id).length) return
  saveItem(c.id, null, { name: 'Registration fee', price_cents: 20000, required: true, sort: 1 }, actor)
  saveItem(c.id, null, { name: 'Value cards', description: 'Fundraiser value cards, $60 each', price_cents: 6000, max_qty: 10, sort: 2 }, actor)
  saveItem(c.id, null, { name: 'Volunteer fee', description: 'Pay this instead of volunteering — no turf-maintenance volunteer expectation for this family.', price_cents: 10000, tag: 'volunteer-exempt', sort: 3 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'select', label: 'Baseball experience', options: ['First season', '1–2 seasons', '3+ seasons', 'Travel / select ball'], required: true, sort: 1 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'text', label: 'Last team played for (if any)', sort: 2 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'select', label: 'Shirt size', options: ['Youth XS', 'Youth S', 'Youth M', 'Youth L', 'Youth XL', 'Adult S', 'Adult M', 'Adult L'], required: true, sort: 3 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'textarea', label: 'Medical conditions or allergies coaches should know about', sort: 4 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'multi', label: 'How can your family help this season?', options: ['Head coach', 'Assistant coach', 'Team parent', 'Concessions', 'Field / turf maintenance', 'Umpire', 'Fundraising', 'Photography'], sort: 1 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'text', label: 'Coaching or umpiring experience', help: 'Levels coached, certifications, years', sort: 2 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'agreement', label: 'I agree to the league’s participation waiver and code of conduct', required: true, sort: 9 }, actor)
}

export { ageIn }
