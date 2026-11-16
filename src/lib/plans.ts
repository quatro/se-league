import { randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { audit, changed, UserError } from './league.js'
import { mailConfigured, sendBatch, type Mail } from './mailer.js'
import { chargeSavedCard, createCheckout, getPaymentIntent, stripeConfigured, type PaymentIntent } from './stripe.js'
import { uid } from './text.js'

// Payment plans: the league's own interest-free installments. The family pays the
// first installment at checkout and Stripe keeps the card; the rest are charged to
// it automatically on their due dates. The league carries the balance, so this
// file is also its accounts receivable: reminders before each payment, retries and
// a "pay now / update your card" link when a card fails, and the admin view of who
// owes what and how late it is.

export interface Installment {
  id: string; order_id: string; seq: number; due_date: string; amount_cents: number
  status: 'due' | 'paid' | 'failed' | 'waived' | 'void'; paid_at: string | null; method: string; stripe_payment_id: string | null
  attempts: number; last_attempt_at: string | null; next_attempt_at: string | null; last_error: string; reminded_at: string | null; note: string
}
interface PlanOrder {
  id: string; campaign_id: string; status: string; guardian: string; total_cents: number; plan: number; created_at: string; paid_at: string | null
  stripe_customer_id: string | null; stripe_pm_id: string | null; card_label: string; pay_token: string | null; last_reminder_at: string | null; admin_notes: string
}
interface PlanCampaign { id: string; slug: string; name: string; plan_installments: number; plan_final_date: string | null; plan_min_cents: number }

/** Automatic charge attempts before it's left to the family's pay link and the league's follow-up. */
export const MAX_ATTEMPTS = 3
const RETRY_DAYS = 3
const REMIND_DAYS = 3

// ---------- dates (league time zone, YYYY-MM-DD) ----------
export const today = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: config.timeZone })
const toUtc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10))
const fromUtc = (t: number) => new Date(t).toISOString().slice(0, 10)
export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * 864e5)
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / 864e5)
function addMonths(d: string, n: number) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + n, day = +d.slice(8, 10)
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate() // the 31st becomes the 30th (or the 28th)
  return fromUtc(Date.UTC(y, m, Math.min(day, last)))
}
export const niceDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`

/**
 * The payments for a plan: the first today, the rest monthly on the same day of the month —
 * or, when the months don't fit before the last-payment date, spaced evenly up to it.
 * Even split; any odd cents go on the first payment. Null when no plan fits.
 */
export function planSchedule(totalCents: number, n: number, finalDate: string | null, start = today()): { due: string; cents: number }[] | null {
  if (!n || n < 2 || !finalDate || totalCents <= 0) return null
  const span = daysBetween(start, finalDate)
  if (span < 7 * (n - 1)) return null // less than a week between payments: too late for this plan
  const base = Math.floor(totalCents / n), first = totalCents - base * (n - 1)
  const monthly = addMonths(start, n - 1) <= finalDate
  const out = [{ due: start, cents: first }]
  for (let k = 1; k < n; k++) out.push({ due: monthly ? addMonths(start, k) : addDays(start, Math.round((span * k) / (n - 1))), cents: base })
  return out
}

/** The plan a family could choose for this total, if the campaign offers one. */
export function planFor(c: PlanCampaign, totalCents: number, start = today()) {
  if (!c.plan_installments || totalCents < (c.plan_min_cents || 0)) return null
  return planSchedule(totalCents, c.plan_installments, c.plan_final_date, start)
}

// ---------- collections history ----------
export type Channel = 'email' | 'text' | 'call' | 'note' | 'charge' | 'payment'
export function logContact(orderId: string, channel: Channel, kind: string, actor: string, x: { subject?: string; body?: string; ok?: boolean; error?: string } = {}) {
  db.prepare('INSERT INTO collection_log (order_id, at, channel, kind, subject, body, actor, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, new Date().toISOString(), channel, kind, x.subject ?? '', x.body ?? '', actor, x.ok === false ? 0 : 1, x.error ?? '')
}
export const contactLog = (orderId: string) =>
  db.prepare('SELECT * FROM collection_log WHERE order_id = ? ORDER BY at DESC, id DESC').all(orderId) as { id: number; at: string; channel: Channel; kind: string; subject: string; body: string; actor: string; ok: number; error: string }[]

// ---------- reads ----------
// The latest time anyone reached the family (an email, text or call — automatic or by an admin).
const lastContact = (orderId: string) => db.prepare(`SELECT at, channel FROM collection_log WHERE order_id = ? AND channel IN ('email','text','call') AND ok = 1 ORDER BY at DESC, id DESC LIMIT 1`)
  .get(orderId) as { at: string; channel: string } | undefined ?? null
const planOrder = (id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as PlanOrder | undefined
const campaignOf = (o: PlanOrder) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(o.campaign_id) as PlanCampaign
export const installmentsFor = (orderId: string) => db.prepare('SELECT * FROM installments WHERE order_id = ? ORDER BY seq').all(orderId) as Installment[]
const installment = (id: string) => db.prepare('SELECT * FROM installments WHERE id = ?').get(id) as Installment | undefined
const guardianOf = (o: PlanOrder) => { try { return JSON.parse(o.guardian) as { firstName?: string; lastName?: string; email?: string; phone?: string } } catch { return {} } }
const playerNames = (orderId: string) => (db.prepare(`SELECT first_name || ' ' || last_name n FROM order_players WHERE order_id = ? AND status != 'cancelled'`).all(orderId) as { n: string }[]).map((r) => r.n)
const isOpen = (i: Installment) => i.status === 'due' || i.status === 'failed'

/** Record the schedule when the order is created. The first payment is what checkout charges. */
export function createPlan(orderId: string, schedule: { due: string; cents: number }[]) {
  const ins = db.prepare('INSERT INTO installments (id, order_id, seq, due_date, amount_cents) VALUES (?, ?, ?, ?, ?)')
  schedule.forEach((s, i) => ins.run(uid(), orderId, i + 1, s.due, s.cents))
  db.prepare('UPDATE orders SET plan = 1 WHERE id = ?').run(orderId)
}

/** Checkout went through: the first payment is in. */
export function firstPaymentIn(orderId: string, paymentId: string | null) {
  db.prepare(`UPDATE installments SET status = 'paid', paid_at = COALESCE(paid_at, ?), method = 'card', stripe_payment_id = COALESCE(stripe_payment_id, ?)
    WHERE order_id = ? AND seq = 1 AND status != 'paid'`).run(new Date().toISOString(), paymentId, orderId)
}

/** Keep the card the family just paid with, so later installments can be charged to it. */
export async function saveCard(orderId: string, paymentIntentId: string | null) {
  if (!paymentIntentId || !stripeConfigured()) return
  const pi = await getPaymentIntent(paymentIntentId)
  const pm = typeof pi.payment_method === 'string' ? { id: pi.payment_method } : pi.payment_method
  if (!pi.customer || !pm?.id) return
  const card = typeof pm === 'object' && 'card' in pm ? pm.card : undefined
  const label = card ? `${card.brand[0]!.toUpperCase()}${card.brand.slice(1)} •••• ${card.last4} (exp ${card.exp_month}/${String(card.exp_year).slice(-2)})` : 'Card on file'
  db.prepare('UPDATE orders SET stripe_customer_id = ?, stripe_pm_id = ?, card_label = ? WHERE id = ?').run(pi.customer, pm.id, label, orderId)
  changed()
}

function markPaidRow(i: Installment, method: string, paymentId: string | null, note = '') {
  db.prepare(`UPDATE installments SET status = 'paid', paid_at = ?, method = ?, stripe_payment_id = COALESCE(?, stripe_payment_id), next_attempt_at = NULL,
    note = TRIM(note || ' ' || ?) WHERE id = ?`).run(new Date().toISOString(), method, paymentId, note, i.id)
}

// ---------- charging ----------
/**
 * Charge one installment to the saved card. Automatic runs retry a decline every few days, up
 * to MAX_ATTEMPTS, and email the family a link to pay or update the card. An admin's
 * "Charge now" always tries. Returns what happened.
 */
export async function chargeInstallment(id: string, actor: string, auto = false): Promise<{ ok: boolean; message: string }> {
  const i = installment(id)
  if (!i) throw new UserError('Unknown payment')
  if (!isOpen(i)) throw new UserError(i.status === 'paid' ? 'Already paid' : 'Nothing to charge — this payment was waived or cancelled')
  const o = planOrder(i.order_id)!
  if (!o.stripe_customer_id || !o.stripe_pm_id) throw new UserError('No card on file — send the family a pay link instead')
  const c = campaignOf(o), n = installmentsFor(o.id).length
  const attempt = i.attempts + 1
  let pi: PaymentIntent | null = null, error = ''
  try {
    pi = await chargeSavedCard({
      customer: o.stripe_customer_id, paymentMethod: o.stripe_pm_id, cents: i.amount_cents,
      description: `${c.name} registration — payment ${i.seq} of ${n} (${playerNames(o.id).join(', ')})`,
      metadata: { order_id: o.id, installment_id: i.id }, idempotencyKey: `inst-${i.id}-${attempt}`,
    })
    if (pi.status !== 'succeeded') error = pi.status === 'requires_action' ? 'The bank wants the cardholder to confirm this payment' : `Payment ${pi.status}`
  } catch (e) { error = (e instanceof Error ? e.message : String(e)).replace(/^Stripe: /, '') }
  const now = new Date()
  if (!error && pi) {
    markPaidRow(i, auto ? 'auto' : 'card', pi.id)
    db.prepare('UPDATE installments SET attempts = ?, last_attempt_at = ?, last_error = ? WHERE id = ?').run(attempt, now.toISOString(), '', i.id)
    audit(actor, 'installment_charged', null, null, { order: o.id, payment: i.seq, cents: i.amount_cents })
    logContact(o.id, 'charge', 'charged', actor, { subject: `Payment ${i.seq} of ${n}: ${money(i.amount_cents)} charged to ${o.card_label || 'card on file'}` })
    changed()
    return { ok: true, message: `Charged ${money(i.amount_cents)} to ${o.card_label || 'the card on file'}` }
  }
  const next = attempt < MAX_ATTEMPTS ? new Date(now.getTime() + RETRY_DAYS * 864e5).toISOString() : null
  db.prepare(`UPDATE installments SET status = 'failed', attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
    .run(attempt, now.toISOString(), next, error, i.id)
  audit(actor, 'installment_failed', null, null, { order: o.id, payment: i.seq, cents: i.amount_cents, error })
  logContact(o.id, 'charge', 'declined', actor, { subject: `Payment ${i.seq} of ${n}: ${money(i.amount_cents)} declined (attempt ${attempt})`, ok: false, error })
  changed()
  if (auto) await emailFamily(o, 'failed', { error, retry: next }).catch((e) => console.error('[plans] failed-payment email', e))
  return { ok: false, message: `Declined: ${error}` }
}

/** Admin: the family paid another way (cash, check, Venmo...). */
export function recordPayment(id: string, method: string, note: string, actor: string) {
  const i = installment(id)
  if (!i) throw new UserError('Unknown payment')
  if (!isOpen(i)) throw new UserError('This payment isn’t open')
  markPaidRow(i, method, null, note)
  audit(actor, 'installment_recorded', null, null, { order: i.order_id, payment: i.seq, method, cents: i.amount_cents, note })
  logContact(i.order_id, 'payment', 'recorded', actor, { subject: `Payment ${i.seq}: ${money(i.amount_cents)} received by ${method}`, body: note })
  changed()
}

/** Admin: forgive a payment (hardship, scholarship, sibling discount...). */
export function waiveInstallment(id: string, note: string, actor: string) {
  const i = installment(id)
  if (!i) throw new UserError('Unknown payment')
  if (!isOpen(i)) throw new UserError('This payment isn’t open')
  db.prepare(`UPDATE installments SET status = 'waived', next_attempt_at = NULL, note = TRIM(note || ' ' || ?) WHERE id = ?`).run(note, i.id)
  audit(actor, 'installment_waived', null, null, { order: i.order_id, payment: i.seq, cents: i.amount_cents, note })
  logContact(i.order_id, 'payment', 'waived', actor, { subject: `Payment ${i.seq}: ${money(i.amount_cents)} waived`, body: note })
  changed()
}

/** Admin: move a payment's due date (a family asked for a few more weeks). */
export function moveDueDate(id: string, due: string, actor: string) {
  const i = installment(id)
  if (!i) throw new UserError('Unknown payment')
  if (!isOpen(i)) throw new UserError('This payment isn’t open')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new UserError('Pick a date')
  // A new date is a fresh start: automatic attempts begin again on it.
  db.prepare(`UPDATE installments SET due_date = ?, status = 'due', attempts = 0, next_attempt_at = NULL, reminded_at = NULL WHERE id = ?`).run(due, i.id)
  audit(actor, 'installment_moved', null, null, { order: i.order_id, payment: i.seq, from: i.due_date, to: due })
  logContact(i.order_id, 'note', 'moved', actor, { subject: `Payment ${i.seq} moved from ${niceDate(i.due_date)} to ${niceDate(due)}` })
  changed()
}

// ---------- the family's pay link: pay what's due now (and save a new card) ----------
export function payLink(orderId: string): string {
  const o = planOrder(orderId)
  if (!o?.plan) throw new UserError('Not a payment plan')
  let token = o.pay_token
  if (!token) { token = randomBytes(18).toString('base64url'); db.prepare('UPDATE orders SET pay_token = ? WHERE id = ?').run(token, o.id) }
  return `${config.baseUrl}/register/${campaignOf(o).slug}/balance/${token}`
}

/** What the pay link charges: everything past due, or else the next payment (paying early is fine). */
function payNow(orderId: string) {
  const open = installmentsFor(orderId).filter(isOpen)
  const due = open.filter((i) => i.due_date <= today())
  return due.length ? due : open.slice(0, 1)
}

/** The family opened their pay link: off to Stripe for what's due, or a reason why not. */
export async function startBalanceCheckout(slugStr: string, token: string): Promise<string> {
  const o = token ? (db.prepare('SELECT * FROM orders WHERE pay_token = ?').get(token) as PlanOrder | undefined) : undefined
  const c = o ? campaignOf(o) : undefined
  if (!o || !c || c.slug !== slugStr) throw new UserError('This link isn’t valid. Please check the email we sent, or contact the league.')
  const pay = payNow(o.id)
  if (!pay.length) throw new UserError('You’re all paid up — thank you! There’s nothing left to pay on this registration.')
  const n = installmentsFor(o.id).length, g = guardianOf(o)
  const done = `${config.baseUrl}/register/${c.slug}/done?order=${o.id}`
  const s = await createCheckout({
    lines: pay.map((i) => ({ name: `Payment ${i.seq} of ${n} — ${c.name} registration`, description: `Due ${niceDate(i.due_date)} · ${playerNames(o.id).join(', ')}`, unitCents: i.amount_cents, qty: 1 })),
    email: g.email ?? '', customer: o.stripe_customer_id, saveCard: true, orderId: o.id, idempotencyKey: `balance-${o.id}-${Date.now()}`,
    extraMetadata: { installment_ids: pay.map((i) => i.id).join(',') },
    successUrl: `${done}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: done,
    description: `${c.name} registration — ${pay.length === 1 ? `payment ${pay[0]!.seq}` : `payments ${pay.map((i) => i.seq).join(', ')}`} of ${n}`,
  })
  return s.url
}

/** A pay-link checkout was paid (webhook or the return page). Safe to call twice. The new card becomes the one on file. */
export function balancePaid(ids: string[], paymentId: string | null): number {
  let n = 0
  for (const id of ids) {
    const i = installment(id)
    if (i && isOpen(i)) { markPaidRow(i, 'link', paymentId); n++ }
  }
  if (n) {
    const first = installment(ids[0]!)
    if (first) logContact(first.order_id, 'payment', 'paid_link', 'family', { subject: `${n} payment${n === 1 ? '' : 's'} paid through the pay link` })
    audit('stripe', 'installments_paid_by_link', null, null, { installments: ids.length }); changed()
  }
  return n
}

// ---------- emails ----------
type Kind = 'upcoming' | 'failed' | 'reminder'
async function emailFamily(o: PlanOrder, kind: Kind, x: { error?: string; retry?: string | null; due?: Installment; actor?: string } = {}): Promise<boolean> {
  const g = guardianOf(o)
  if (!mailConfigured() || !g.email) return false
  const c = campaignOf(o), all = installmentsFor(o.id), link = payLink(o.id)
  const owed = all.filter(isOpen), pastDue = owed.filter((i) => i.due_date <= today())
  const kids = playerNames(o.id).join(' and ')
  const hi = `Hi ${g.firstName || 'there'},`
  let subject = '', body = '', button = ''
  if (kind === 'upcoming' && x.due) {
    subject = `Your next payment for ${c.name}: ${money(x.due.amount_cents)} on ${niceDate(x.due.due_date)}`
    body = `Just a heads-up: payment ${x.due.seq} of ${all.length} for ${kids}'s registration, ${money(x.due.amount_cents)}, will be charged on ${niceDate(x.due.due_date)} to ${o.card_label || 'the card you used to register'}.\n\nNothing to do if that card is still good. To use a different card or pay now:`
    button = 'Pay now or change card'
  } else if (kind === 'failed') {
    subject = `Payment didn't go through — ${c.name}`
    body = `We tried to charge ${money(pastDue.reduce((a, i) => a + i.amount_cents, 0) || owed[0]?.amount_cents || 0)} for ${kids}'s registration to ${o.card_label || 'your card'}, but it didn't go through${x.error ? ` (${x.error.replace(/\.$/, '')})` : ''}.\n\n${x.retry ? `We'll try again on ${new Date(x.retry).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: config.timeZone })}. ` : ''}To pay now or use a different card:`
    button = 'Pay now'
  } else {
    const amt = pastDue.reduce((a, i) => a + i.amount_cents, 0)
    subject = amt ? `Payment due for ${kids} — ${c.name}` : `Your payment plan for ${c.name}`
    body = amt
      ? `Our records show ${money(amt)} past due on ${kids}'s registration (${pastDue.map((i) => `payment ${i.seq} of ${all.length}, due ${niceDate(i.due_date)}`).join('; ')}). You can pay it here, and update your card for the rest of the plan:`
      : `Here's the link to make a payment or update the card for ${kids}'s registration. Your next payment is ${owed[0] ? `${money(owed[0].amount_cents)} on ${niceDate(owed[0].due_date)}` : 'not scheduled'}.`
    button = amt ? 'Pay now' : 'Pay or update card'
  }
  const sched = all.map((i) => `${i.seq}. ${niceDate(i.due_date)} — ${money(i.amount_cents)} — ${i.status === 'paid' ? 'paid' : i.status === 'waived' ? 'waived' : i.status === 'failed' ? 'didn’t go through' : i.due_date < today() ? 'past due' : 'scheduled'}`).join('\n')
  const text = `${hi}\n\n${body}\n${link}\n\nYour plan:\n${sched}\n\nQuestions or need a different arrangement? Just reply to this email.\n\n${config.leagueName}`
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:560px">
<p>${esc(hi)}</p>${body.split('\n\n').map((p) => `<p>${esc(p)}</p>`).join('')}
<p><a href="${esc(link)}" style="display:inline-block;background:#14213D;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">${esc(button)}</a></p>
<p style="margin-bottom:4px"><b>Your plan</b></p><table style="border-collapse:collapse;font-size:14px">${all.map((i) => `<tr><td style="padding:2px 12px 2px 0">${i.seq}.</td><td style="padding:2px 12px 2px 0">${esc(niceDate(i.due_date))}</td><td style="padding:2px 12px 2px 0">${money(i.amount_cents)}</td><td style="padding:2px 0;color:#5d6577">${i.status === 'paid' ? 'paid' : i.status === 'waived' ? 'waived' : i.status === 'failed' ? 'didn’t go through' : i.due_date < today() ? 'past due' : 'scheduled'}</td></tr>`).join('')}</table>
<p style="color:#5d6577;font-size:13px">Questions or need a different arrangement? Just reply to this email.</p></div>`
  return sendLogged(o, { to: g.email, subject, text, html }, kind, kind === 'reminder' ? x.actor ?? 'admin' : 'plans')
}

async function sendLogged(o: PlanOrder, mail: Mail, kind: string, actor: string): Promise<boolean> {
  const [r] = await sendBatch([mail])
  logContact(o.id, 'email', kind, actor, { subject: `To ${mail.to}: ${mail.subject}`, body: mail.text, ok: !!r?.ok, error: r?.ok ? '' : r?.error ?? 'Email failed' })
  if (!r?.ok) throw new UserError(`Email failed: ${r?.error ?? 'unknown error'}`)
  db.prepare('UPDATE orders SET last_reminder_at = ? WHERE id = ?').run(new Date().toISOString(), o.id)
  changed()
  return true
}

const fill = (s: string, o: PlanOrder) => {
  const g = guardianOf(o), owed = installmentsFor(o.id).filter(isOpen), late = owed.filter((i) => i.due_date <= today())
  return s.replace(/\{(\w+)\}/g, (m, k: string) => ({
    first: g.firstName || 'there', players: playerNames(o.id).join(' and '), link: payLink(o.id),
    due: money(late.reduce((a, i) => a + i.amount_cents, 0)), balance: money(owed.reduce((a, i) => a + i.amount_cents, 0)),
    next: owed[0] ? `${money(owed[0].amount_cents)} on ${niceDate(owed[0].due_date)}` : 'nothing',
  } as Record<string, string>)[k] ?? m)
}
/** Merge fields an admin can use in a custom email or text. */
export const MERGE_FIELDS = ['{first}', '{players}', '{due}', '{balance}', '{next}', '{link}']

/** Admin: a custom email to the family. {link} and the other merge fields are filled in; the pay link is added if they left it out. */
export async function sendCustomEmail(orderId: string, subject: string, body: string, actor: string) {
  const o = planOrder(orderId)
  if (!o) throw new UserError('Unknown order')
  const g = guardianOf(o)
  if (!g.email) throw new UserError('No email address for this family')
  if (!mailConfigured()) throw new UserError('Email isn’t set up yet')
  if (!subject.trim() || !body.trim()) throw new UserError('Write a subject and a message')
  let text = fill(body.trim(), o)
  const link = o.plan ? payLink(o.id) : ''
  if (link && !text.includes(link)) text += `\n\nPay or update your card here:\n${link}`
  text += `\n\n${config.leagueName}`
  const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:560px">${text.split(/\n{2,}/).map((p) =>
    `<p>${p.split('\n').map((line) => (line === link ? `<a href="${esc(link)}" style="display:inline-block;background:#14213D;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Pay now</a>` : esc(line))).join('<br>')}</p>`).join('')}</div>`
  await sendLogged(o, { to: g.email, subject: fill(subject.trim(), o), text, html }, 'custom', actor)
  return { emailed: g.email }
}

/** A ready-to-send text with the pay link, for the admin to send from their phone (and log). */
export function textFor(orderId: string, template?: string) {
  const o = planOrder(orderId)
  if (!o) throw new UserError('Unknown order')
  const g = guardianOf(o)
  const msg = fill(template?.trim() || (installmentsFor(o.id).some((i) => isOpen(i) && i.due_date <= today())
    ? `Hi {first}, this is ${config.leagueName}. {players}'s registration has {due} past due. You can pay or update your card here: {link}`
    : `Hi {first}, this is ${config.leagueName}. Your next registration payment is {next}. Pay early or update your card here: {link}`), o)
  return { phone: g.phone ?? '', message: msg }
}

/** Admin: send the family their pay link now. */
export async function remindFamily(orderId: string, actor: string): Promise<{ emailed: string | null; url: string }> {
  const o = planOrder(orderId)
  if (!o?.plan) throw new UserError('Not a payment plan')
  const url = payLink(o.id)
  const sent = await emailFamily(o, 'reminder', { actor })
  audit(actor, 'plan_reminder', null, null, { order: o.id, emailed: sent })
  changed()
  return { emailed: sent ? guardianOf(o).email ?? null : null, url }
}

// ---------- the scheduler ----------
let running = false
/** Charge what's due and send the "coming up" emails. Runs every few minutes; safe to call any time. */
export async function runPlans(now = new Date()): Promise<{ charged: number; failed: number; reminded: number }> {
  if (running || !stripeConfigured()) return { charged: 0, failed: 0, reminded: 0 }
  running = true
  const out = { charged: 0, failed: 0, reminded: 0 }
  try {
    const t = today(now)
    const due = db.prepare(`SELECT i.id FROM installments i JOIN orders o ON o.id = i.order_id
      WHERE o.plan = 1 AND o.status = 'paid' AND o.stripe_pm_id IS NOT NULL AND i.status IN ('due','failed') AND i.due_date <= ?
        AND i.attempts < ? AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= ?) ORDER BY i.due_date LIMIT 50`).all(t, MAX_ATTEMPTS, now.toISOString()) as { id: string }[]
    for (const { id } of due) {
      try { (await chargeInstallment(id, 'plans', true)).ok ? out.charged++ : out.failed++ }
      catch (e) { if (!(e instanceof UserError)) console.error('[plans] charge', id, e) }
    }
    if (mailConfigured()) {
      const soon = db.prepare(`SELECT i.* FROM installments i JOIN orders o ON o.id = i.order_id
        WHERE o.plan = 1 AND o.status = 'paid' AND i.status = 'due' AND i.seq > 1 AND i.reminded_at IS NULL AND i.due_date > ? AND i.due_date <= ? LIMIT 50`).all(t, addDays(t, REMIND_DAYS)) as Installment[]
      for (const i of soon) {
        try {
          if (await emailFamily(planOrder(i.order_id)!, 'upcoming', { due: i })) out.reminded++
          db.prepare('UPDATE installments SET reminded_at = ? WHERE id = ?').run(now.toISOString(), i.id)
        } catch (e) { console.error('[plans] reminder', i.id, e) }
      }
    }
  } finally { running = false }
  if (out.charged || out.failed) console.log(`[plans] ${out.charged} charged, ${out.failed} declined, ${out.reminded} reminders`)
  return out
}

// ---------- accounts receivable ----------
export type PlanState = 'paid_off' | 'on_track' | 'due_today' | 'past_due' | 'card_failed' | 'no_card'
export function receivables(campaignId?: string | null) {
  const t = today()
  const os = db.prepare(`SELECT * FROM orders WHERE plan = 1 AND status IN ('paid','refunded') ${campaignId ? 'AND campaign_id = ?' : ''} ORDER BY created_at`).all(...(campaignId ? [campaignId] : [])) as PlanOrder[]
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61: 0 }
  const k = { contracted: 0, collected: 0, waived: 0, outstanding: 0, pastDue: 0, next30: 0, plans: os.length, families: 0 }
  const plans = os.map((o) => {
    const ins = installmentsFor(o.id).filter((i) => i.status !== 'void')
    const g = guardianOf(o), c = campaignOf(o)
    const paid = ins.filter((i) => i.status === 'paid').reduce((a, i) => a + i.amount_cents, 0)
    const waived = ins.filter((i) => i.status === 'waived').reduce((a, i) => a + i.amount_cents, 0)
    const open = ins.filter(isOpen)
    const owed = open.reduce((a, i) => a + i.amount_cents, 0)
    const late = open.filter((i) => i.due_date < t)
    const lateAmt = late.reduce((a, i) => a + i.amount_cents, 0)
    const daysLate = late.length ? daysBetween(late[0]!.due_date, t) : 0
    for (const i of open) {
      const d = daysBetween(i.due_date, t)
      if (d <= 0) aging.current += i.amount_cents; else if (d <= 30) aging.d1_30 += i.amount_cents; else if (d <= 60) aging.d31_60 += i.amount_cents; else aging.d61 += i.amount_cents
      if (d <= 0 && d > -30) k.next30 += i.amount_cents
    }
    k.contracted += paid + waived + owed; k.collected += paid; k.waived += waived; k.outstanding += owed; k.pastDue += lateAmt
    const state: PlanState = !open.length ? 'paid_off' : open.some((i) => i.status === 'failed') ? 'card_failed' : !o.stripe_pm_id ? 'no_card'
      : late.length ? 'past_due' : open.some((i) => i.due_date === t) ? 'due_today' : 'on_track'
    const next = open[0]
    return {
      order_id: o.id, campaign: c.name, family: `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim(), email: g.email ?? '', phone: g.phone ?? '', players: playerNames(o.id),
      total_cents: paid + waived + owed, paid_cents: paid, waived_cents: waived, owed_cents: owed, past_due_cents: lateAmt, days_late: daysLate,
      paid_count: ins.filter((i) => i.status === 'paid' || i.status === 'waived').length, count: ins.length,
      next: next ? { id: next.id, due: next.due_date, cents: next.amount_cents, status: next.status } : null,
      state, card: o.card_label, last_error: open.find((i) => i.last_error)?.last_error ?? '', last_reminder_at: o.last_reminder_at, last_contact: lastContact(o.id), notes: o.admin_notes, refunded: o.status === 'refunded',
      installments: ins.map((i) => ({ id: i.id, seq: i.seq, due: i.due_date, cents: i.amount_cents, status: i.status, paid_at: i.paid_at, method: i.method, attempts: i.attempts,
        next_attempt_at: i.next_attempt_at, last_error: i.last_error, note: i.note, late: isOpen(i) && i.due_date < t })),
    }
  })
  k.families = new Set(plans.map((p) => p.email.toLowerCase())).size
  return { today: t, kpis: k, aging, plans, maxAttempts: MAX_ATTEMPTS, mail: mailConfigured(), stripe: stripeConfigured() }
}

/** CSV: one row per payment, for the treasurer. */
export function receivablesCsv(campaignId?: string | null): (string | number)[][] {
  const r = receivables(campaignId)
  const rows: (string | number)[][] = [['Campaign', 'Family', 'Email', 'Phone', 'Players', 'Payment', 'Of', 'Due', 'Amount', 'Status', 'Paid at', 'Method', 'Attempts', 'Last error', 'Note']]
  for (const p of r.plans) for (const i of p.installments)
    rows.push([p.campaign, p.family, p.email, p.phone, p.players.join('; '), i.seq, p.count, i.due, (i.cents / 100).toFixed(2), i.late ? 'past due' : i.status, i.paid_at ?? '', i.method, i.attempts, i.last_error, i.note])
  return rows
}
