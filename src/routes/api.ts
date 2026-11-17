import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import { ageBreakdown } from '../lib/ages.js'
import { clearFailures, login, logout, noteFailure, requireAdmin, requireUser, throttled } from '../lib/auth.js'
import * as U from '../lib/users.js'
import * as CO from '../lib/coaches.js'
import * as D from '../lib/drafts.js'
import * as L from '../lib/league.js'
import { contactsFor, deleteContact, importContacts, saveContact } from '../lib/contacts.js'
import * as O from '../lib/outreach.js'
import { importRosters } from '../lib/rosters.js'
import { previewRollover, rollover } from '../lib/rollover.js'
import { ignoreRegistration, importRegistrationCsv, placeRegistration, processRegistration, storeRegistration } from '../lib/sportsengine.js'
import { STATUSES } from '../lib/text.js'

export const api = Router()
const actor = (req: Request) => req.admin?.username ?? 'unknown'
type H = (req: Request, res: Response) => unknown
const wrap = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (e) {
    if (e instanceof L.UserError || e instanceof z.ZodError) {
      return res.status(400).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message })
    }
    next(e)
  }
}
const asUser = <T>(fn: () => T): T => { try { return fn() } catch (e) { throw e instanceof L.UserError ? e : new L.UserError((e as Error).message) } }
const p = (req: Request, k: string) => String(req.params[k])

type Cell = string | number | null | undefined
function sendCsv(res: Response, name: string, rows: Cell[][]) {
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${name}"`)
  res.send(rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n'))
}

// ---------- session ----------
api.get('/api/me', (req, res) => {
  const u = req.user
  res.json({ user: u ? { email: u.email, name: u.name, role: u.role } : null, admin: req.admin?.username ?? null, board: !!req.board,
    coachSeasons: u ? CO.coachSeasons(u.email) : [] })
})
/** A coach's own divisions and players. An admin can look at any coach's view with ?as=email. */
api.get('/api/coach', requireUser, wrap((req) => {
  const as = typeof req.query.as === 'string' && req.board ? req.query.as : req.user!.email
  const sid = typeof req.query.season === 'string' && req.query.season ? req.query.season : CO.coachSeasons(as)[0] ?? L.currentSeason()?.id
  if (!sid) throw new L.UserError('No season')
  return CO.coachView(sid, as)
}))
// A coach manages their own team's returners (admins can act as any coach with ?as=).
const coachAs = (req: { query: Record<string, unknown>; admin?: unknown; user?: { email: string } }) => (typeof req.query.as === 'string' && req.admin ? req.query.as : req.user!.email)
api.post('/api/coach/intent', requireUser, wrap((req) => {
  const b = z.object({ season: z.string(), enrollmentId: z.string(), intent: z.enum(['yes', 'no', 'unsure']) }).parse(req.body)
  CO.coachSetIntent(b.season, coachAs(req), b.enrollmentId, b.intent)
}))
api.get('/api/coach/candidates', requireUser, wrap((req) => {
  const q = z.object({ season: z.string(), team: z.string(), q: z.string().max(80) }).parse(req.query)
  return CO.coachCandidates(q.season, coachAs(req), q.team, q.q)
}))
api.post('/api/coach/slot', requireUser, wrap((req) => {
  const b = z.object({ season: z.string(), team: z.string(), kidId: z.string() }).parse(req.body)
  CO.coachSlot(b.season, coachAs(req), b.team, b.kidId)
}))
api.post('/api/coach/unslot', requireUser, wrap((req) => {
  const b = z.object({ season: z.string(), enrollmentId: z.string() }).parse(req.body)
  CO.coachUnslot(b.season, coachAs(req), b.enrollmentId)
}))
// Always answers the same way, so the form can't be used to learn who is on the list.
api.post('/api/auth/link', wrap(async (req) => {
  const b = z.object({ email: z.string().max(200), next: z.string().max(300).optional() }).parse(req.body)
  const email = b.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new L.UserError('Enter your email address')
  const key = `link:${req.ip}`, perEmail = `link:${email}`
  if (throttled(key) || throttled(perEmail)) throw new L.UserError('Too many requests. Try again in 15 minutes.')
  noteFailure(key); noteFailure(perEmail) // every request counts toward the limit, found or not
  await U.sendLoginLink(email, U.originFor(req), b.next)
  return { ok: true }
}))
api.post('/api/auth/verify', wrap((req, res) => {
  const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body)
  const next = U.redeem(res, token)
  if (!next) return res.status(400).json({ error: 'This sign-in link has expired or was already used. Request a new one.' })
  return { ok: true, next }
}))
// Break-glass password login for the original admin account.
api.post('/api/login', wrap((req, res) => {
  const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body)
  const key = `login:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
  if (!login(res, username, password)) { noteFailure(key); return res.status(401).json({ error: 'Wrong username or password' }) }
  clearFailures(key)
}))
api.post('/api/logout', wrap((req, res) => { logout(req, res) }))

// ---------- public ----------
// Only enough for the sign-in page to know where it is. Everything else below needs a signed-in user.
/** Where this hostname should land: a specific draft room, or the league home on the current season. */
api.get('/api/home', (req, res) => {
  const route = config.draftHosts[req.hostname]
  const cur = L.currentSeason()
  let draft: string | null = null
  if (route) { const [sid, key] = route.split('/'); draft = (sid && key && D.draftByKey(sid, key)?.id) || null }
  res.json({ league: config.leagueName, leagueUrl: config.draftHosts[req.hostname] ? config.leagueUrl : '', current: cur?.id ?? null, draft })
})

api.get('/api/seasons/:id/state', requireUser, wrap((req) => L.seasonState(p(req, 'id'), !!req.board)))
api.get('/api/seasons/:id/ages', requireUser, wrap((req) => ageBreakdown(p(req, 'id'))))
api.get('/api/drafts/:id/state', requireUser, wrap((req) => D.draftState(p(req, 'id'), !!req.admin)))

api.get('/api/stream', requireUser, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = (v: number) => res.write(`event: change\ndata: ${v}\n\n`)
  send(L.currentVersion())
  L.bus.on('change', send)
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3)
  req.on('close', () => { clearInterval(ping); L.bus.off('change', send) })
})

api.get('/api/seasons/:id/capacity.csv', requireUser, wrap((req, res) => {
  const st = L.seasonState(p(req, 'id'), false)
  sendCsv(res, `${st.season.year}-registration-capacity.csv`, [
    ['Division', 'Teams', 'Roster size', 'Seats', 'Registered', 'Returners registered', 'New registered', 'Returners expected', 'Returners need contact', 'Open seats', 'Waitlist', 'Status'],
    ...st.divisions.map((d) => [d.name, d.teams, d.roster_size, d.seats.capacity, d.seats.registered, d.seats.returnersRegistered, d.seats.newRegistered,
      d.seats.expected, d.seats.atRisk, d.seats.open, d.seats.waitlist, d.seats.state]),
    ...st.groups.map((g) => [`${g.name} (combined)`, '', '', g.seats.capacity, g.seats.registered, g.seats.returnersRegistered, g.seats.newRegistered,
      g.seats.expected, g.seats.atRisk, g.seats.open, g.seats.waitlist, g.seats.state]),
  ])
}))

api.get('/api/drafts/:id/rosters.csv', requireUser, wrap((req, res) => {
  const st = D.draftState(p(req, 'id'), false)
  const byId = new Map(st.players.map((x) => [x.id, x]))
  const rows: Cell[][] = [['Team', 'Player', 'Age', 'How', 'Round', 'Pick']]
  for (const t of st.teams) {
    for (const x of st.players.filter((x) => x.kind === 'returning' && x.teamId === t.id && x.status !== 'Not returning' && x.status !== 'Withdrawn')) rows.push([t.name, x.name, x.age, 'Returning', '', ''])
    for (const pk of st.picks.filter((x) => x.team === t.id)) { const x = byId.get(pk.player); rows.push([t.name, x?.name, x?.age, 'Drafted', pk.round, pk.n]) }
  }
  sendCsv(res, `${st.season.year}-${st.draft.key}-rosters.csv`, rows)
}))

// ---------- admin ----------
const admin = Router()
admin.use(requireAdmin)
api.use('/api/admin', admin)
const optInt = z.union([z.number().int().min(0).max(999), z.null()]).optional()

// seasons
admin.post('/seasons', wrap((req) => {
  const { year } = z.object({ year: z.number().int().min(2000).max(2100) }).parse(req.body)
  if (L.season(String(year))) throw new L.UserError(`${year} already exists`)
  db.prepare(`INSERT INTO seasons (id, year) VALUES (?, ?)`).run(String(year), year)
  L.audit(actor(req), 'season_added', String(year), null)
  L.changed()
  return L.season(String(year))
}))
admin.patch('/seasons/:id', wrap((req) => {
  const b = z.object({ status: z.enum(['planning', 'active', 'complete']).optional(), age_cutoff: z.string().regex(/^\d{2}-\d{2}$/).optional(),
    warn_at: z.number().int().min(0).max(50).optional(), notes: z.string().max(4000).optional() }).parse(req.body)
  L.updateSeason(p(req, 'id'), b, actor(req))
}))
admin.post('/seasons/:id/current', wrap((req) => { L.mustSeason(p(req, 'id')); L.setSetting('currentSeason', p(req, 'id')); L.changed() }))
admin.get('/seasons/:id/rollover', wrap((req) => previewRollover(p(req, 'id'))))
admin.post('/seasons/:id/rollover', wrap((req) => {
  z.object({ confirm: z.string() }).parse(req.body)
  return rollover(p(req, 'id'), actor(req))
}))
admin.post('/seasons/:id/rosters/import', wrap((req) => {
  const b = z.object({ text: z.string().max(4_000_000), divisionId: z.union([z.string(), z.null()]).optional() }).parse(req.body)
  return importRosters(p(req, 'id'), b.text, actor(req), b.divisionId ?? null)
}))

// divisions
const divisionBody = z.object({
  name: z.string().min(1).max(60), teams: z.number().int().min(0).max(60), roster_size: z.number().int().min(1).max(40),
  coaches: optInt, min_age: optInt, max_age: optInt, se_match: z.string().max(300).optional(), group_key: z.string().max(30).optional(),
  keep_teams: z.boolean().optional(), closed: z.boolean().optional(), notes: z.string().max(2000).optional(), notify_coaches: z.boolean().optional(),
})
admin.post('/seasons/:id/divisions', wrap((req) => L.saveDivision(p(req, 'id'), null, divisionBody.parse(req.body), actor(req))))
admin.patch('/divisions/:id', wrap((req) => {
  const d = L.division(p(req, 'id')); if (!d) throw new L.UserError('Unknown division')
  return L.saveDivision(d.season_id, d.id, divisionBody.parse(req.body), actor(req))
}))
admin.delete('/divisions/:id', wrap((req) => { L.deleteDivision(p(req, 'id'), actor(req)) }))
admin.put('/seasons/:id/divisions/order', wrap((req) => { L.reorderDivisions(p(req, 'id'), z.object({ order: z.array(z.string()) }).parse(req.body).order, actor(req)) }))

// teams
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const teamBody = z.object({ name: z.string().min(1).max(60), color: color.optional(), fg: color.optional(), wins: optInt, losses: optInt, ties: optInt,
  coach: z.string().max(80).optional(), coach_email: z.string().max(120).optional(), coach_phone: z.string().max(40).optional() })
/** Save a team; a new coach email can sign in from then on (added to Users as a plain user). */
function saveTeamAndCoach(divisionId: string, id: string | null, body: z.infer<typeof teamBody>, who: string) {
  const t = L.saveTeam(divisionId, id, body, who)
  if (t.coach_email) CO.ensureCoachUser(t.coach_email, t.coach)
  return t
}
admin.post('/divisions/:id/teams', wrap((req) => saveTeamAndCoach(p(req, 'id'), null, teamBody.parse(req.body), actor(req))))
admin.patch('/teams/:id', wrap((req) => {
  const t = L.team(p(req, 'id')); if (!t) throw new L.UserError('Unknown team')
  return saveTeamAndCoach(t.division_id, t.id, teamBody.parse(req.body), actor(req))
}))
/** Name every team in a division and assign coaches in one go. Rows with an id update that team; the rest are added. */
admin.put('/divisions/:id/teams', wrap((req) => {
  const d = L.division(p(req, 'id')); if (!d) throw new L.UserError('Unknown division')
  const rows = z.object({ teams: z.array(teamBody.extend({ id: z.string().optional() })).max(60) }).parse(req.body).teams
  const names = rows.map((r) => r.name.trim().toLowerCase())
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new L.UserError(`Two teams are named “${rows[names.indexOf(dup)]!.name.trim()}”`)
  let added = 0
  db.transaction(() => { for (const r of rows) { const { id, ...b } = r; if (!id) added++; saveTeamAndCoach(d.id, id ?? null, b, actor(req)) } })()
  return { saved: rows.length, added, message: `${rows.length} ${rows.length === 1 ? 'team' : 'teams'} saved` }
}))
admin.delete('/teams/:id', wrap((req) => { L.deleteTeam(p(req, 'id'), actor(req)) }))
admin.put('/divisions/:id/teams/order', wrap((req) => { L.setTeamOrder(p(req, 'id'), z.object({ order: z.array(z.string()) }).parse(req.body).order, actor(req)) }))
admin.post('/divisions/:id/teams/order-by-record', wrap((req) => { L.orderByLastRecord(p(req, 'id'), actor(req)); return { ok: true, message: 'Order set from last season’s records (worst record picks first)' } }))

// drafts
admin.put('/divisions/:id/draft', wrap((req) => {
  const d = L.division(p(req, 'id')); if (!d) throw new L.UserError('Unknown division')
  const b = z.object({ format: z.enum(['standard', 'blind']).optional(), mode: z.enum(['straight', 'snake']).optional(),
    swap: z.tuple([z.string(), z.string()]).optional(), nextId: z.union([z.string(), z.null()]).optional() }).parse(req.body)
  return D.saveDraft(d.season_id, d.id, b, actor(req))
}))
admin.delete('/drafts/:id', wrap((req) => { D.deleteDraft(p(req, 'id'), actor(req)) }))
admin.post('/drafts/:id/pick', wrap((req) => {
  const b = z.object({ playerId: z.string().optional(), number: z.number().int().optional(), slot: z.string().optional() }).parse(req.body)
  return D.makePick(p(req, 'id'), b.playerId ?? null, actor(req), { slot: b.slot, number: b.number })
}))
admin.post('/drafts/:id/sibling', wrap((req) => {
  const b = z.object({ playerId: z.string(), teamId: z.string(), round: z.number().int().min(1).max(40) }).parse(req.body)
  return D.siblingPick(p(req, 'id'), b.playerId, b.teamId, b.round, actor(req))
}))
admin.post('/drafts/:id/undo', wrap((req) => { D.undoLast(p(req, 'id'), actor(req)) }))
admin.post('/drafts/:id/clock/start', wrap((req) => { D.startClock(p(req, 'id'), actor(req)) }))
admin.post('/drafts/:id/picks/clear', wrap((req) => { z.object({ confirm: z.literal('CLEAR') }).parse(req.body); D.clearPicks(p(req, 'id'), actor(req)) }))
admin.delete('/drafts/:id/picks/:slot', wrap((req) => { D.removePick(p(req, 'id'), p(req, 'slot'), actor(req)) }))
admin.put('/drafts/:id/picks/:slot', wrap((req) => { D.replacePick(p(req, 'id'), p(req, 'slot'), z.object({ playerId: z.string() }).parse(req.body).playerId, actor(req)) }))
admin.post('/drafts/:id/close', wrap((req) => {
  const r = D.closeDraft(p(req, 'id'), actor(req))
  return { ...r, message: [r.next ? `Draft closed — ${r.undrafted} undrafted ${r.undrafted === 1 ? 'kid' : 'kids'} moved to the ${r.next} draft` : 'Draft closed',
    r.backToTeam ? `${r.backToTeam} back on their Minors ${r.backToTeam === 1 ? 'team' : 'teams'}` : ''].filter(Boolean).join('; ') }
}))
admin.post('/drafts/:id/reopen', wrap((req) => { D.reopenDraft(p(req, 'id'), actor(req)) }))
admin.post('/drafts/:id/numbers', wrap((req) => { const r = D.assignNumbers(p(req, 'id'), actor(req)); return { ...r, message: `Numbers ${r.from}–${r.to} handed out` } }))
admin.post('/drafts/:id/numbers/clear', wrap((req) => { D.clearNumbers(p(req, 'id'), actor(req)) }))

// kids and enrollments
const enrollBody = z.object({
  divisionId: z.union([z.string(), z.null()]).optional(), teamId: z.union([z.string(), z.null()]).optional(), status: z.enum(STATUSES).optional(),
  locked: z.boolean().optional(), returner: z.boolean().optional(), tryout: z.boolean().optional(), rank: optInt, notes: z.string().max(2000).optional(),
  age: optInt, divisionLocked: z.boolean().optional(),
})
admin.post('/seasons/:id/kids', wrap((req) => {
  const b = enrollBody.extend({ kidId: z.string().optional(), name: z.string().max(120).optional(),
    birthdate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional() }).parse(req.body)
  const k = b.kidId ? L.kid(b.kidId) : b.name?.trim() ? L.createKid(b.name, b.birthdate ?? null) : undefined
  if (!k) throw new L.UserError('Pick a kid or enter a name')
  return L.enroll(p(req, 'id'), k.id, { ...b, divisionLocked: !!b.divisionId }, actor(req))
}))
admin.patch('/enrollments/:id', wrap((req) => L.updateEnrollment(p(req, 'id'), enrollBody.parse(req.body), actor(req))))
admin.delete('/enrollments/:id', wrap((req) => { L.deleteEnrollment(p(req, 'id'), actor(req)) }))
admin.post('/enrollments/move', wrap((req) => {
  const b = z.object({ ids: z.array(z.string()).min(1).max(1000), divisionId: z.union([z.string(), z.null()]), reason: z.string().max(300).optional() }).parse(req.body)
  db.transaction(() => b.ids.forEach((id) => L.moveEnrollment(id, b.divisionId, actor(req), b.reason)))()
  return { ok: true, message: `Moved ${b.ids.length} ${b.ids.length === 1 ? 'kid' : 'kids'} to ${b.divisionId ? L.division(b.divisionId)?.name : 'no division'}` }
}))
admin.get('/kids/search', wrap((req) => {
  const q = `%${String(req.query.q ?? '').trim().toLowerCase()}%`
  return db.prepare('SELECT id, name, birthdate FROM kids WHERE lower(name) LIKE ? ORDER BY name LIMIT 20').all(q)
}))
admin.get('/kids/:id', wrap((req) => ({ ...L.kidHistory(p(req, 'id')), contacts: contactsFor(p(req, 'id')) })))

// parent / guardian contacts
const contactBody = z.object({ name: z.string().max(120).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional(), relation: z.string().max(40).optional() })
admin.post('/kids/:id/contacts', wrap((req) => { saveContact(p(req, 'id'), contactBody.parse(req.body), actor(req)); return { ok: true, message: 'Contact saved' } }))
admin.delete('/contacts/:id', wrap((req) => { deleteContact(p(req, 'id'), actor(req)) }))
admin.post('/contacts/import', wrap((req) => importContacts(z.object({ text: z.string().min(1).max(2_000_000) }).parse(req.body).text, actor(req))))

// outreach: emailing returning families to register early
const outreachBody = z.object({ seasonId: z.string(), campaignId: z.string(), subject: z.string().max(300), body: z.string().max(10_000),
  divisionIds: z.array(z.string()).max(50).default([]), statuses: z.array(z.enum(STATUSES)).max(10).default([]), kind: z.enum(['register', 'interest']).default('register') })
admin.get('/outreach', wrap((req) => ({
  list: O.listOutreach(String(req.query.season ?? '')), defaults: { subject: O.DEFAULT_SUBJECT, body: O.DEFAULT_BODY },
  interest: { subject: O.INTEREST_SUBJECT, body: O.INTEREST_BODY },
})))
admin.post('/outreach/preview', wrap((req) => O.preview(outreachBody.parse(req.body))))
admin.post('/outreach/test', wrap((req) => {
  const b = outreachBody.extend({ to: z.string().max(200) }).parse(req.body)
  return O.sendTest(b, b.to)
}))
// mode 'send' emails every family now; 'export' only records the list and personal links for sending some other way.
admin.post('/outreach', wrap(async (req) => {
  const b = outreachBody.extend({ mode: z.enum(['send', 'export']) }).parse(req.body)
  const id = O.createOutreach(b, actor(req))
  if (b.mode === 'export') return { id }
  const r = await O.sendOutreach(id, actor(req))
  return { id, ...r, message: r.failed ? `Sent ${r.sent}; ${r.failed} failed — ${r.error}` : `Sent to ${r.sent} ${r.sent === 1 ? 'family' : 'families'}` }
}))
admin.post('/outreach/:id/send', wrap(async (req) => {
  const r = await O.sendOutreach(p(req, 'id'), actor(req))
  return { ...r, message: r.failed ? `Sent ${r.sent}; ${r.failed} failed — ${r.error}` : `Sent ${r.sent}` }
}))
admin.get('/outreach/:id', wrap((req) => O.outreachDetail(p(req, 'id'))))
api.get('/api/admin/outreach/:id/export.csv', requireAdmin, wrap((req, res) => sendCsv(res, 'outreach.csv', O.exportOutreach(p(req, 'id')))))
admin.patch('/kids/:id', wrap((req) => {
  const b = z.object({ name: z.string().min(1).max(120).optional(), birthdate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
    notes: z.string().max(4000).optional() }).parse(req.body)
  L.updateKid(p(req, 'id'), b, actor(req))
}))
api.get('/api/admin/seasons/:id/kids.csv', requireAdmin, wrap((req, res) => {
  const st = L.seasonState(p(req, 'id'), true) as ReturnType<typeof L.seasonState> & { kids: (L.Placement & { name: string; league_age: number | null; birthdate: string | null })[] }
  const dn = new Map(st.divisions.map((d) => [d.id, d.name])), tn = new Map(st.teams.map((t) => [t.id, t.name]))
  sendCsv(res, `${st.season.year}-kids.csv`, [
    ['Division', 'Team', 'Kid', 'League age', 'Birthdate', 'Returning', 'Last season', 'Status', 'Trying out', 'SE program', 'Notes'],
    ...st.kids.map((k) => [dn.get(k.eff_division_id ?? ''), tn.get(k.eff_team_id ?? ''), k.name, k.league_age, k.birthdate, k.returner ? 'Yes' : 'No', k.prior,
      k.status, k.tryout ? 'Yes' : '', k.se_program, k.notes]),
  ])
}))

// registrations inbox
const OPEN = `('no_division','ambiguous','error','pending')`
admin.get('/registrations', wrap((req) => {
  const filter = String(req.query.filter ?? 'open')
  const where = filter === 'open' ? `WHERE outcome IN ${OPEN}` : filter === 'all' ? '' : `WHERE outcome = ?`
  const args = ['open', 'all'].includes(filter) ? [] : [filter]
  const rows = db.prepare(`SELECT r.id, r.received_at, r.source, r.event_type, r.verified, r.first_name, r.last_name, r.birthdate, r.reg_year,
      r.program, r.outcome, r.note, r.kid_id, r.season_id, k.name AS kid_name, d.name AS division_name
    FROM registrations r LEFT JOIN kids k ON k.id = r.kid_id LEFT JOIN divisions d ON d.id = r.division_id
    ${where} ORDER BY r.id DESC LIMIT 500`).all(...args)
  const counts = Object.fromEntries((db.prepare('SELECT outcome, COUNT(*) n FROM registrations GROUP BY outcome').all() as { outcome: string; n: number }[]).map((r) => [r.outcome, r.n]))
  const se = config.sportsengine
  return { rows, counts, webhook: { configured: !!se.token, url: se.token ? `${config.baseUrl}/webhooks/sportsengine/${se.token}` : null, signed: !!se.secret, signatureHeader: se.signatureHeader } }
}))
admin.get('/registrations/:id', wrap((req) => db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(p(req, 'id')))))
admin.post('/registrations/:id/reprocess', wrap((req) => processRegistration(Number(p(req, 'id')), actor(req))))
admin.post('/registrations/reprocess-open', wrap((req) => {
  const ids = db.prepare(`SELECT id FROM registrations WHERE outcome IN ${OPEN}`).all() as { id: number }[]
  const tally: Record<string, number> = {}
  for (const { id } of ids) { const r = processRegistration(id, actor(req)); tally[r.outcome] = (tally[r.outcome] ?? 0) + 1 }
  return tally
}))
admin.post('/registrations/:id/place', wrap((req) => {
  const b = z.object({ kidId: z.union([z.string(), z.null()]).optional(), divisionId: z.union([z.string(), z.null()]).optional() }).parse(req.body)
  return asUser(() => placeRegistration(Number(p(req, 'id')), b, actor(req)))
}))
admin.post('/registrations/:id/ignore', wrap((req) => { ignoreRegistration(Number(p(req, 'id')), actor(req)) }))
admin.post('/registrations/import', wrap((req) => {
  const { text } = z.object({ text: z.string().max(4_000_000) }).parse(req.body)
  return asUser(() => importRegistrationCsv(text, actor(req)))
}))
admin.post('/registrations/manual', wrap((req) => {
  const b = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), birthdate: z.string().optional(), program: z.string().optional(),
    season: z.string().optional() }).parse(req.body)
  const payload = { participant: { first_name: b.firstName, last_name: b.lastName, date_of_birth: b.birthdate }, program: b.program, season: b.season ?? L.currentSeason()?.id }
  const { id } = storeRegistration('manual', JSON.stringify(payload), payload, true)
  return processRegistration(id, actor(req))
}))

// people allowed to sign in
const userBody = z.object({ email: z.string().max(200), name: z.string().max(120).optional(), role: z.enum(['user', 'admin']), board: z.boolean().optional() })
admin.get('/users', wrap(() => ({ users: U.listUsers().map((u) => ({ ...u, coaching: CO.coachingFor(u.email) })), mail: U.mailOn() })))
admin.post('/users', wrap(async (req) => {
  const b = userBody.extend({ invite: z.boolean().optional() }).parse(req.body)
  const u = U.addUser(b, actor(req))
  if (b.invite) { await U.sendLoginLink(u.email, U.originFor(req), '/'); return { ok: true, message: `Added ${u.email} and emailed a sign-in link` } }
  return { ok: true, message: `Added ${u.email}` }
}))
admin.patch('/users/:id', wrap((req) => { U.updateUser(Number(p(req, 'id')), userBody.partial().parse(req.body), req, actor(req)) }))
admin.delete('/users/:id', wrap((req) => { U.removeUser(Number(p(req, 'id')), req, actor(req)) }))
// For when email isn't set up (or a message went to spam): the admin hands the link over themselves.
admin.post('/users/:id/link', wrap((req) => ({ url: U.linkFor(Number(p(req, 'id')), U.originFor(req)) })))
admin.post('/users/:id/email-link', wrap(async (req) => {
  const u = U.userById(Number(p(req, 'id'))); if (!u) throw new L.UserError('Unknown user')
  await U.sendLoginLink(u.email, U.originFor(req), '/', true)
  return { ok: true, message: `Sign-in link emailed to ${u.email}` }
}))

admin.get('/audit', wrap((req) => {
  const sid = req.query.season ? String(req.query.season) : null
  return db.prepare(`SELECT a.*, k.name AS kid_name FROM audit a LEFT JOIN kids k ON k.id = a.kid_id
    ${sid ? 'WHERE a.season_id = ? OR a.season_id IS NULL' : ''} ORDER BY a.id DESC LIMIT 400`).all(...(sid ? [sid] : []))
}))
