import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config, isProd } from '../config.js'
import { authDb as db } from './authdb.js'

const SESSION_DAYS = 14
// Break-glass password login for the original `admin` account (pnpm admin); everyone else signs in by emailed link.
export const ADMIN_COOKIE = 'league_admin'   // shared by every league tool

export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`
}
export function checkPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const a = scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function setCookie(res: Response, name: string, value: string, maxAgeSec: number, domain = '') {
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${domain ? `; Domain=${domain}` : ''}${isProd && config.baseUrl.startsWith('https') ? '; Secure' : ''}`)
}

export function login(res: Response, username: string, password: string): boolean {
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as { id: number; pw_hash: string } | undefined
  // Hash anyway on unknown users so response time doesn't reveal which usernames exist.
  const ok = checkPassword(password, a?.pw_hash ?? 'scrypt$00$00')
  if (!a || !ok) return false
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(sha(token), a.id, Date.now() + SESSION_DAYS * 864e5)
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now())
  setCookie(res, ADMIN_COOKIE, token, SESSION_DAYS * 86400, config.cookieDomain)
  return true
}
export function logout(req: Request, res: Response) {
  const c = cookies(req)
  if (c[ADMIN_COOKIE]) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(c[ADMIN_COOKIE]))
  if (c[SESSION_COOKIE]) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha(c[SESSION_COOKIE]))
  setCookie(res, ADMIN_COOKIE, '', 0, config.cookieDomain)
  setCookie(res, SESSION_COOKIE, '', 0, config.cookieDomain)
}

declare global {
  namespace Express {
    interface Request {
      /** Anyone signed in: an emailed-link user (either role) or the break-glass password admin. */
      user?: { id: number; email: string; name: string; role: Role }
      /** Set only for admins; username is what the audit log records. */
      admin?: { id: number; username: string }
    }
  }
}
export type Role = 'user' | 'admin'
export const SESSION_COOKIE = 'league_session'   // emailed-link sessions, shared by every league tool
const LINK_MINUTES = 20
const LINK_SESSION_DAYS = 30

export function loadAuth(req: Request, _res: Response, next: NextFunction) {
  const c = cookies(req)
  if (c[SESSION_COOKIE]) {
    const u = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM user_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(c[SESSION_COOKIE]), Date.now()) as Request['user'] | undefined
    if (u) {
      req.user = u
      if (u.role === 'admin') req.admin = { id: u.id, username: u.email }
    }
  }
  if (!req.user && c[ADMIN_COOKIE]) {
    const row = db.prepare(`SELECT a.id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(c[ADMIN_COOKIE]), Date.now()) as { id: number; username: string } | undefined
    if (row) { req.admin = row; req.user = { id: -row.id, email: row.username, name: row.username, role: 'admin' } }
  }
  next()
}

// ---------- emailed sign-in links ----------
export const normEmail = (e: string) => e.trim().toLowerCase()
export const userByEmail = (email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail(email)) as { id: number; email: string; name: string; role: Role } | undefined

/** Only same-site paths, so a link can't bounce someone to another site after signing in. */
export const safeNext = (n: unknown) => (typeof n === 'string' && /^\/(?![/\\])/.test(n) ? n.slice(0, 300) : '/')

/** A one-time sign-in token for this user, valid LINK_MINUTES. Returns the raw token (only its hash is stored). */
export function createLoginLink(userId: number, next: string): string {
  const token = randomBytes(32).toString('base64url')
  db.prepare('DELETE FROM login_links WHERE expires_at < ?').run(Date.now() - 864e5)
  db.prepare('INSERT INTO login_links (token_hash, user_id, next, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), userId, safeNext(next), Date.now() + LINK_MINUTES * 60e3)
  return token
}
export const linkMinutes = LINK_MINUTES

/** Spend a sign-in token and start a session. Returns where to go next, or null if the link is bad, used or expired. */
export function redeemLoginLink(res: Response, token: string): string | null {
  const row = db.prepare('SELECT * FROM login_links WHERE token_hash = ?').get(sha(token)) as { user_id: number; next: string; expires_at: number; used_at: number | null } | undefined
  if (!row || row.used_at || row.expires_at < Date.now()) return null
  // Mark used first so the same link can't start two sessions.
  if (!db.prepare('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(Date.now(), sha(token)).changes) return null
  const sess = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(sess), row.user_id, Date.now() + LINK_SESSION_DAYS * 864e5)
  db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(Date.now())
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(row.user_id)
  setCookie(res, SESSION_COOKIE, sess, LINK_SESSION_DAYS * 86400, config.cookieDomain)
  return row.next
}
/** Sign someone out everywhere (removed, or role changed). */
export function endSessions(userId: number) { db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId) }

export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (req.user) return next()
  res.status(401).json({ error: 'login_required' })
}

/**
 * Admin API guard. Mutations are JSON-only and must come from our own origin,
 * which (with SameSite=Lax) is the CSRF defence — a cross-site form can't send
 * application/json, and a cross-site fetch carries a foreign Origin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'login_required' })
  if (!req.admin) return res.status(403).json({ error: 'Admins only' })
  if (req.method !== 'GET') {
    const origin = req.headers.origin
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    if (origin && new URL(origin).host !== host) return res.status(403).json({ error: 'bad_origin' })
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' })
  }
  next()
}

// Tiny in-memory throttle for the password and sign-in-link forms.
const attempts = new Map<string, { n: number; until: number }>()
export function throttled(key: string): boolean {
  const a = attempts.get(key)
  return !!a && a.n >= 8 && a.until > Date.now()
}
export function noteFailure(key: string) {
  const a = attempts.get(key)
  const fresh = !a || a.until < Date.now()
  attempts.set(key, { n: fresh ? 1 : a!.n + 1, until: Date.now() + 15 * 60e3 })
}
export function clearFailures(key: string) { attempts.delete(key) }
