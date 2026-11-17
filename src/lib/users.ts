import type { Request, Response } from 'express'
import { config } from '../config.js'
import { createLoginLink, endSessions, hasRole, linkMinutes, normEmail, redeemLoginLink, safeNext, userByEmail, type Role } from './auth.js'
import { authDb as db } from './authdb.js'
import { audit, UserError } from './league.js'
import { mailConfigured, sendBatch } from './mailer.js'

// Who may sign in, and the emailed sign-in links. Users and admins live in the
// shared auth database, so the same list works on every league tool.

export interface User { id: number; email: string; name: string; role: Role; board: boolean; created_at: string; last_login_at: string | null }

export const mailOn = mailConfigured
const withRoles = (u: Omit<User, 'board'> | undefined) => (u ? { ...u, board: hasRole(u.id, 'board') } as User : undefined)
export const listUsers = () => (db.prepare('SELECT * FROM users ORDER BY role DESC, email').all() as Omit<User, 'board'>[]).map((u) => withRoles(u)!)
export const userById = (id: number) => withRoles(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Omit<User, 'board'> | undefined)

/** Put someone on or off the Board of Directors (view-only access to the admin areas). */
function setBoard(id: number, on: boolean) {
  if (on) db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'board')`).run(id)
  else db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = 'board'`).run(id)
}
const adminCount = () => (db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin'`).get() as { n: number }).n
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

export function addUser(b: { email: string; name?: string; role: Role; board?: boolean }, actor: string): User {
  const email = normEmail(b.email)
  if (!validEmail(email)) throw new UserError('Enter a valid email address')
  if (userByEmail(email)) throw new UserError(`${email} is already on the list`)
  const id = Number(db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(email, (b.name ?? '').trim(), b.role).lastInsertRowid)
  if (b.board) setBoard(id, true)
  audit(actor, 'user_added', null, null, { email, role: b.role, ...(b.board ? { board: true } : {}) })
  return userById(id)!
}

/** The signed-in person's own users.id, if they signed in by link (the password admin has none). */
const selfId = (req: Request) => (req.user && req.user.id > 0 ? req.user.id : null)

export function updateUser(id: number, b: { email?: string; name?: string; role?: Role; board?: boolean }, req: Request, actor: string) {
  const u = userById(id); if (!u) throw new UserError('Unknown user')
  if (b.role && b.role !== u.role && u.role === 'admin') {
    if (selfId(req) === id) throw new UserError('You can’t remove your own admin access')
    if (adminCount() <= 1) throw new UserError('Keep at least one admin')
  }
  const email = b.email !== undefined ? normEmail(b.email) : u.email
  if (!validEmail(email)) throw new UserError('Enter a valid email address')
  if (email !== u.email && userByEmail(email)) throw new UserError(`${email} is already on the list`)
  db.prepare('UPDATE users SET email = ?, name = ?, role = ? WHERE id = ?').run(email, b.name !== undefined ? b.name.trim() : u.name, b.role ?? u.role, id)
  // A new role or address takes effect right away: they sign in again.
  const boardChanged = b.board !== undefined && b.board !== u.board
  if (boardChanged) setBoard(id, b.board!)
  if ((b.role && b.role !== u.role) || email !== u.email) endSessions(id)
  audit(actor, 'user_changed', null, null, { email, ...(b.role && b.role !== u.role ? { role: b.role } : {}), ...(boardChanged ? { board: b.board } : {}), ...(email !== u.email ? { was: u.email } : {}) })
}

export function removeUser(id: number, req: Request, actor: string) {
  const u = userById(id); if (!u) throw new UserError('Unknown user')
  if (selfId(req) === id) throw new UserError('You can’t remove yourself')
  if (u.role === 'admin' && adminCount() <= 1) throw new UserError('Keep at least one admin')
  db.prepare('DELETE FROM users WHERE id = ?').run(id) // sessions and links cascade
  audit(actor, 'user_removed', null, null, { email: u.email })
}

/**
 * The site address a sign-in link should point at: the host they asked from when it's
 * one of ours (so a link requested on the draft-room domain lands back there), else BASE_URL.
 */
export function originFor(req: Request): string {
  const host = req.hostname
  for (const u of [config.baseUrl, config.leagueUrl]) if (u && new URL(u).hostname === host) return u
  if (config.draftHosts[host]) return `${new URL(config.baseUrl).protocol}//${host}`
  return config.baseUrl
}

export const linkFor = (userId: number, origin: string, next = '/') => {
  if (!userById(userId)) throw new UserError('Unknown user')
  return `${origin}/signin?token=${createLoginLink(userId, next)}`
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/**
 * Email a sign-in link if this address is on the list; silently does nothing otherwise.
 * With email not set up, the link goes to the server log instead so the operator can hand it over.
 * `loud` (an admin pressing "Email link") reports send failures instead of hiding them.
 */
export async function sendLoginLink(email: string, origin: string, next?: string, loud = false) {
  const u = userByEmail(email)
  if (!u) return
  const url = linkFor(u.id, origin, safeNext(next))
  if (!mailConfigured()) {
    console.log(`[signin] email is off — sign-in link for ${u.email}: ${url}`)
    if (loud) throw new UserError('Email isn’t set up yet — use “Copy link” and send it yourself')
    return
  }
  const site = new URL(origin).hostname
  const text = `Here is your sign-in link for ${config.leagueName}:\n\n${url}\n\nIt works once and expires in ${linkMinutes} minutes. If you didn't ask for it, ignore this email.`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:520px">
<p>Here is your sign-in link for <b>${esc(config.leagueName)}</b> (${esc(site)}).</p>
<p><a href="${esc(url)}" style="display:inline-block;background:#14213D;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">Sign in</a></p>
<p style="color:#5b6577;font-size:13px">It works once and expires in ${linkMinutes} minutes. If you didn’t ask for it, ignore this email.</p></div>`
  const [r] = await sendBatch([{ to: u.email, subject: `Sign in to ${config.leagueName}`, text, html }])
  if (!r?.ok) {
    console.error(`[signin] email to ${u.email} failed: ${r?.error}`)
    if (loud) throw new UserError(`Email failed: ${r?.error}`)
  }
}

export const redeem = (res: Response, token: string) => redeemLoginLink(res, token)
