import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { config, isProd } from '../config.js'
import { authDb as db } from './authdb.js'

const SESSION_DAYS = 14
export const ADMIN_COOKIE = 'league_admin'   // shared by every league tool
export const VIEWER_COOKIE = 'sereg_view'

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
  const t = cookies(req)[ADMIN_COOKIE]
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t))
  setCookie(res, ADMIN_COOKIE, '', 0, config.cookieDomain)
}

declare global {
  namespace Express {
    interface Request { admin?: { id: number; username: string }; viewer?: boolean }
  }
}

export function loadAuth(req: Request, _res: Response, next: NextFunction) {
  const c = cookies(req)
  if (c[ADMIN_COOKIE]) {
    const row = db.prepare(`SELECT a.id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(c[ADMIN_COOKIE]), Date.now()) as { id: number; username: string } | undefined
    if (row) req.admin = row
  }
  req.viewer = !!req.admin || !config.viewerPassword || c[VIEWER_COOKIE] === viewerToken()
  next()
}

/** Cookie value proving the viewer code was entered; rotates whenever the code changes. */
export const viewerToken = () => sha(`viewer:${config.viewerPassword}`)
export function grantViewer(res: Response) { setCookie(res, VIEWER_COOKIE, viewerToken(), 30 * 86400) }

export function requireViewer(req: Request, res: Response, next: NextFunction) {
  if (req.viewer) return next()
  res.status(401).json({ error: 'viewer_code_required' })
}

/**
 * Admin API guard. Mutations are JSON-only and must come from our own origin,
 * which (with SameSite=Lax) is the CSRF defence — a cross-site form can't send
 * application/json, and a cross-site fetch carries a foreign Origin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.admin) return res.status(401).json({ error: 'login_required' })
  if (req.method !== 'GET') {
    const origin = req.headers.origin
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    if (origin && new URL(origin).host !== host) return res.status(403).json({ error: 'bad_origin' })
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' })
  }
  next()
}

// Tiny in-memory throttle for the login and viewer-code forms.
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
