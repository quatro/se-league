import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { ageSeason, offerings, type Campaign } from './campaigns.js'
import { audit, changed, UserError, type Kid } from './league.js'
import { mailConfigured, sendBatch } from './mailer.js'
import { applyIntent, type Intent } from './outreach.js'
import { leagueAge, uid } from './text.js'

/*
 * Family look-up on the registration form. A parent types their email; if it's one we have for kids who
 * played last season, we offer to email a 6-digit code. The code unlocks their players, filled in for
 * them, and lets them say who isn't coming back. Nothing about the kids is shown before the code — an
 * email alone isn't proof, since anyone can type a neighbour's.
 */

const CODE_MINUTES = 15, SESSION_HOURS = 2, MAX_TRIES = 5, CODES_PER_15MIN = 3
const norm = (e: string) => e.trim().toLowerCase()
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()

/** Kids who share this parent email (from imports, registrations, or the office). */
const kidIdsFor = (email: string) => (db.prepare('SELECT DISTINCT kid_id FROM contacts WHERE email = ?').all(norm(email)) as { kid_id: string }[]).map((r) => r.kid_id)

/** This family's kids who played last season and still fit a program here. */
export function familyKids(c: Campaign, email: string) {
  const s = ageSeason(c)
  const prior = db.prepare('SELECT id, year FROM seasons WHERE year = ?').get(s.year - 1) as { id: string; year: number } | undefined
  if (!prior) return []
  const progs = offerings(c.id).filter((o) => o.active && o.reg_mode !== 'closed')
  const out: { kidId: string; firstName: string; lastName: string; birthdate: string; division: string | null; team: string | null; year: number; registered: boolean; notReturning: boolean }[] = []
  for (const id of kidIdsFor(email)) {
    const r = db.prepare(`SELECT k.*, d.name AS division, t.name AS team FROM placements p JOIN kids k ON k.id = p.kid_id
      LEFT JOIN divisions d ON d.id = p.eff_division_id LEFT JOIN teams t ON t.id = p.eff_team_id
      WHERE p.season_id = ? AND p.kid_id = ? AND (p.status = 'Registered' OR p.eff_team_id IS NOT NULL)`).get(prior.id, id) as (Kid & { division: string | null; team: string | null }) | undefined
    if (!r) continue
    const age = r.birthdate ? leagueAge(r.birthdate, s.year, s.age_cutoff) : null
    // Aged out (or too young for anything offered): not part of this registration.
    if (age != null && !progs.some((o) => (o.min_age == null || age >= o.min_age) && (o.max_age == null || age <= o.max_age))) continue
    const cur = c.season_id ? (db.prepare('SELECT status FROM enrollments WHERE season_id = ? AND kid_id = ?').get(c.season_id, id) as { status: string } | undefined) : undefined
    if (cur?.status === 'Withdrawn') continue
    const [firstName = '', ...rest] = r.name.trim().split(/\s+/)
    out.push({ kidId: id, firstName, lastName: rest.join(' '), birthdate: r.birthdate ?? '', division: r.division, team: r.team, year: prior.year,
      registered: cur?.status === 'Registered', notReturning: cur?.status === 'Not returning' })
  }
  return out.sort((a, b) => (a.birthdate || '9').localeCompare(b.birthdate || '9'))
}

/**
 * Resend's shared test sender (onboarding@resend.dev) only delivers to the Resend account's own address,
 * so families would never get their code. Until the league's domain is verified, only admins (previewing
 * the form) see the look-up.
 */
export const familyMailReady = (admin = false) => mailConfigured() && (admin || !/@resend\.dev>?\s*$/i.test(config.mail.from))

/** Is this an email we could send a code to? (Only says yes when email is set up and there are kids to show.) */
export function familyKnown(c: Campaign, email: string, admin = false): boolean {
  if (!familyMailReady(admin) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(norm(email))) return false
  return familyKids(c, email).length > 0
}

export async function sendFamilyCode(c: Campaign, email: string, admin = false): Promise<{ sent: boolean }> {
  const to = norm(email)
  if (!familyKnown(c, to, admin)) return { sent: false }
  const recent = (db.prepare(`SELECT COUNT(*) n FROM family_codes WHERE email = ? AND created_at > datetime('now', '-15 minutes')`).get(to) as { n: number }).n
  if (recent >= CODES_PER_15MIN) throw new UserError('We’ve sent a few codes already — check your inbox (and spam), or wait a few minutes and try again.')
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  db.prepare('INSERT INTO family_codes (id, email, code_hash, expires_at) VALUES (?, ?, ?, ?)').run(uid(), to, hash(`${to}:${code}`), iso(CODE_MINUTES * 60e3))
  const text = `Your ${config.leagueName} code is ${code}\n\nEnter it on the registration form to fill in your returning players. It expires in ${CODE_MINUTES} minutes.\n\nDidn't ask for this? You can ignore this email.`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:480px">
    <p>Your ${config.leagueName} code is</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px">${code}</p>
    <p>Enter it on the registration form to fill in your returning players. It expires in ${CODE_MINUTES} minutes.</p>
    <p style="color:#5d6577;font-size:13px">Didn’t ask for this? You can ignore this email.</p></div>`
  const [r] = await sendBatch([{ to, subject: `${code} is your ${config.leagueName} registration code`, text, html }])
  if (!r?.ok) throw new UserError('We couldn’t send the email just now — please try again, or add your players below.')
  return { sent: true }
}

/** Check the code; on success, a short-lived token and the family's players. */
export function verifyFamilyCode(c: Campaign, email: string, code: string) {
  const to = norm(email), digits = code.replace(/\D/g, '')
  const row = db.prepare(`SELECT * FROM family_codes WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1`).get(to, new Date().toISOString()) as
    { id: string; code_hash: string; attempts: number } | undefined
  if (!row) throw new UserError('That code has expired — send a new one.')
  if (row.attempts >= MAX_TRIES) throw new UserError('Too many tries — send a new code.')
  db.prepare('UPDATE family_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id)
  const want = Buffer.from(row.code_hash, 'hex'), got = Buffer.from(hash(`${to}:${digits}`), 'hex')
  if (digits.length !== 6 || !timingSafeEqual(want, got)) throw new UserError('That code doesn’t match — check the email and try again.')
  db.prepare('UPDATE family_codes SET used = 1 WHERE id = ?').run(row.id)
  const token = randomBytes(24).toString('base64url')
  db.prepare('INSERT INTO family_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)').run(hash(token), to, iso(SESSION_HOURS * 3600e3))
  db.prepare('DELETE FROM family_tokens WHERE expires_at < ?').run(new Date().toISOString())
  // The parent's name and phone as we have them, to save typing.
  const g = db.prepare(`SELECT name, phone FROM contacts WHERE email = ? AND name <> '' ORDER BY created_at DESC LIMIT 1`).get(to) as { name: string; phone: string } | undefined
  const [firstName = '', ...rest] = (g?.name ?? '').trim().split(/\s+/)
  audit(`family:${to}`, 'family_verified', c.season_id, null, { campaign: c.slug })
  return { token, guardian: { firstName, lastName: rest.join(' '), phone: g?.phone ?? '' }, kids: familyKids(c, to) }
}

/** "Not this year" (or back to "Playing") from the form, for a family that verified their email. */
export function familyIntent(c: Campaign, token: string, kidId: string, intent: Intent) {
  const t = db.prepare('SELECT email FROM family_tokens WHERE token_hash = ? AND expires_at > ?').get(hash(token), new Date().toISOString()) as { email: string } | undefined
  if (!t) throw new UserError('Your session expired — send yourself a new code.')
  if (!c.season_id) throw new UserError('This registration isn’t tied to a season')
  if (!familyKids(c, t.email).some((k) => k.kidId === kidId)) throw new UserError('That player isn’t on this family')
  const saved = applyIntent(c.season_id, kidId, intent, `family:${t.email}`)
  changed()
  return { saved }
}
