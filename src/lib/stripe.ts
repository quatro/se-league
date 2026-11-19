import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

// Just enough of Stripe for hosted Checkout: create a session, read it back,
// and check webhook signatures. Talks to the REST API directly so there's no
// SDK to keep current. Test vs live is decided by which secret key is in .env.

export const stripeMode = () => (config.stripe.secretKey.startsWith('sk_live_') || config.stripe.secretKey.startsWith('rk_live_') ? 'live' : 'test')
export const stripeConfigured = () => !!config.stripe.secretKey

/** Stripe's form encoding: nested objects and arrays as a[b][0][c]=v. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    const key = prefix ? `${prefix}[${k}]` : k
    if (Array.isArray(v)) v.forEach((x, i) => {
      if (x && typeof x === 'object') out.push(...formEncode(x as Record<string, unknown>, `${key}[${i}]`))
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(x))}`)
    })
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key))
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`)
  }
  return out
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  if (!config.stripe.secretKey) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY)')
  const headers: Record<string, string> = { Authorization: `Bearer ${config.stripe.secretKey}`, 'Stripe-Version': '2024-06-20' }
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const r = await fetch(`${config.stripe.apiBase}/v1${path}`, { method, headers, body: body ? formEncode(body).join('&') : undefined, signal: AbortSignal.timeout(20_000) })
  const data = (await r.json()) as T & { error?: { message: string } }
  if (!r.ok) throw new Error(`Stripe: ${data.error?.message ?? r.status}`)
  return data
}

export interface LineItem { name: string; description?: string; unitCents: number; qty: number }
export interface CheckoutSession { id: string; url: string; status: string; payment_status: string; payment_intent: string | null; amount_total: number; metadata: Record<string, string>; mode?: string; setup_intent?: string | null }

export function createCheckout(p: {
  lines: LineItem[]; email: string; orderId: string; successUrl: string; cancelUrl: string; description: string; idempotencyKey: string; extraMetadata?: Record<string, string>
  /** Keep the card for later installments (a payment plan). */ saveCard?: boolean
  /** An existing Stripe customer (a plan family paying a balance). */ customer?: string | null
}) {
  return api<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'payment',
    ...(p.customer ? { customer: p.customer } : { customer_email: p.email, ...(p.saveCard ? { customer_creation: 'always' } : {}) }),
    client_reference_id: p.orderId,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    // Stripe's minimum; an unpaid session releases nothing we hold, it just expires.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    metadata: { order_id: p.orderId, ...p.extraMetadata },
    payment_intent_data: { description: p.description, metadata: { order_id: p.orderId, ...p.extraMetadata }, ...(p.saveCard ? { setup_future_usage: 'off_session' } : {}) },
    line_items: p.lines.map((l) => ({
      quantity: l.qty,
      price_data: { currency: 'usd', unit_amount: l.unitCents, product_data: { name: l.name, ...(l.description ? { description: l.description } : {}) } },
    })),
  }, p.idempotencyKey)
}

/** A Stripe customer to keep a card on (an early sign-up saves a card before anything is charged). */
export const createCustomer = (p: { email: string; name: string; orderId: string }) =>
  api<{ id: string }>('POST', '/customers', { email: p.email, name: p.name, metadata: { order_id: p.orderId } }, `cust-${p.orderId}`)

/** Hosted Checkout that only saves a card for later — nothing is charged now. */
export function createSetupCheckout(p: { customer: string; orderId: string; successUrl: string; cancelUrl: string; description: string; idempotencyKey: string }) {
  return api<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'setup', currency: 'usd', payment_method_types: ['card'], customer: p.customer,
    client_reference_id: p.orderId, success_url: p.successUrl, cancel_url: p.cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    metadata: { order_id: p.orderId },
    setup_intent_data: { description: p.description, metadata: { order_id: p.orderId } },
  }, p.idempotencyKey)
}

export interface SetupIntent { id: string; status: string; customer: string | null; payment_method: PaymentIntent['payment_method'] }
export const getSetupIntent = (id: string) => api<SetupIntent>('GET', `/setup_intents/${encodeURIComponent(id)}?expand[]=payment_method`)

export const getCheckout = (id: string) => api<CheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(id)}`)

export interface PaymentIntent {
  id: string; status: string; amount: number; customer: string | null
  payment_method: string | { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } } | null
}
/** A payment with its card details (for "Visa •••• 4242" and charging the same card later). */
export const getPaymentIntent = (id: string) => api<PaymentIntent>('GET', `/payment_intents/${encodeURIComponent(id)}?expand[]=payment_method`)

/** Charge a saved card with no one at the keyboard (a scheduled installment). Throws with the bank's reason on a decline. */
export function chargeSavedCard(p: { customer: string; paymentMethod: string; cents: number; description: string; metadata: Record<string, string>; idempotencyKey: string; receiptEmail?: string }) {
  return api<PaymentIntent>('POST', '/payment_intents', {
    amount: p.cents, currency: 'usd', customer: p.customer, payment_method: p.paymentMethod, off_session: true, confirm: true,
    description: p.description, metadata: p.metadata, ...(p.receiptEmail ? { receipt_email: p.receiptEmail } : {}),
  }, p.idempotencyKey)
}

/** Create the webhook endpoint in the Stripe account (setup script); returns its signing secret. */
export function createWebhookEndpoint(url: string) {
  return api<{ id: string; secret: string }>('POST', '/webhook_endpoints', {
    url, enabled_events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'charge.refunded'],
    description: 'SE Baseball league registrations',
  })
}

/** Stripe-Signature: t=timestamp,v1=hex(HMAC-SHA256(secret, `${t}.${body}`)). Rejects anything older than 5 minutes. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]))
  const sigs = header.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3))
  const t = Number(parts.t)
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false
  const want = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')
  return sigs.some((s) => s.length === want.length && timingSafeEqual(Buffer.from(s), Buffer.from(want)))
}
