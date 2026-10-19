import { config } from '../config.js'

// Outreach email through Resend's REST API (no SDK), in batches of up to 100.

export interface Mail { to: string; subject: string; text: string; html: string }
export interface Sent { ok: boolean; id: string | null; error: string }

export const mailConfigured = () => !!(config.mail.resendApiKey && config.mail.from)

/** Send one batch. Resend accepts or rejects a batch as a whole, so every message shares the outcome. */
export async function sendBatch(mails: Mail[]): Promise<Sent[]> {
  if (!mailConfigured()) throw new Error('Email is not set up (RESEND_API_KEY and MAIL_FROM)')
  if (mails.length > 100) throw new Error('At most 100 messages per batch')
  const body = mails.map((m) => ({
    from: config.mail.from, to: [m.to], subject: m.subject, text: m.text, html: m.html,
    ...(config.mail.replyTo ? { reply_to: config.mail.replyTo } : {}),
  }))
  try {
    const res = await fetch(`${config.mail.apiBase}/emails/batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.mail.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) { const error = `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`; return mails.map(() => ({ ok: false, id: null, error })) }
    const out = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null
    return mails.map((_, i) => ({ ok: true, id: out?.data?.[i]?.id ?? null, error: '' }))
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return mails.map(() => ({ ok: false, id: null, error }))
  }
}
