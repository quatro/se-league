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
export interface CheckoutSession { id: string; url: string; status: string; payment_status: string; payment_intent: string | null; amount_total: number; metadata: Record<string, string> }

export function createCheckout(p: { lines: LineItem[]; email: string; orderId: string; successUrl: string; cancelUrl: string; description: string; idempotencyKey: string; extraMetadata?: Record<string, string> }) {
  return api<CheckoutSession>('POST', '/checkout/sessions', {
    mode: 'payment',
    customer_email: p.email,
    client_reference_id: p.orderId,
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    // Stripe's minimum; an unpaid session releases nothing we hold, it just expires.
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    metadata: { order_id: p.orderId, ...p.extraMetadata },
    payment_intent_data: { description: p.description, metadata: { order_id: p.orderId, ...p.extraMetadata } },
    line_items: p.lines.map((l) => ({
      quantity: l.qty,
      price_data: { currency: 'usd', unit_amount: l.unitCents, product_data: { name: l.name, ...(l.description ? { description: l.description } : {}) } },
    })),
  }, p.idempotencyKey)
}

export const getCheckout = (id: string) => api<CheckoutSession>('GET', `/checkout/sessions/${encodeURIComponent(id)}`)

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
