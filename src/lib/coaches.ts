import { config } from '../config.js'
import { db } from '../db.js'
import { normEmail, userByEmail } from './auth.js'
import { authDb } from './authdb.js'
import { ageIn, audit, division, divisions, enroll, fitsAge, kid, mustSeason, season, team, updateEnrollment, UserError, type Division, type Season } from './league.js'
import { applyIntent, type Intent } from './outreach.js'
import { mailConfigured, sendBatch } from './mailer.js'

// Coaches: each team's coach (name + email) gets an email when a player registers for their division, and
// signs in with that email to see the division's players — who's registered, who's still expected back,
// who's waiting. Majors and Minors coaches see both (one registration feeds both drafts). Coaches never see
// parents' contact details here.

interface CoachTeam { id: string; name: string; division_id: string; coach: string; coach_email: string }

/** Every team with a coach email this season. */
const coachTeams = (seasonId: string) =>
  db.prepare(`SELECT id, name, division_id, coach, coach_email FROM teams WHERE season_id = ? AND coach_email <> ''`).all(seasonId) as CoachTeam[]

/** A division plus the others it shares a group with (Majors + Minors). */
function withGroup(d: Division): Division[] {
  return d.group_key ? divisions(d.season_id).filter((x) => x.group_key === d.group_key) : [d]
}

/** The divisions this email coaches in a season (with their group), in league order. */
export function coachDivisions(seasonId: string, email: string): Division[] {
  const e = normEmail(email)
  const mine = new Set<string>()
  for (const t of coachTeams(seasonId).filter((t) => t.coach_email === e)) {
    const d = division(t.division_id)
    if (d) for (const x of withGroup(d)) mine.add(x.id)
  }
  return divisions(seasonId).filter((d) => mine.has(d.id))
}

/** Every team this email coaches, newest season first — shown as their Coach role on the Users page. */
export function coachingFor(email: string) {
  return (db.prepare(`SELECT t.season_id, t.name, d.name AS division FROM teams t JOIN divisions d ON d.id = t.division_id
    WHERE t.coach_email = ? ORDER BY t.season_id DESC, d.sort, t.name`).all(normEmail(email)) as { season_id: string; name: string; division: string }[])
}

/** Seasons where this email coaches a team, newest first. */
export function coachSeasons(email: string): string[] {
  return (db.prepare(`SELECT DISTINCT season_id FROM teams WHERE coach_email = ? ORDER BY season_id DESC`).all(normEmail(email)) as { season_id: string }[]).map((r) => r.season_id)
}

/**
 * A coach email can sign in: add them to the user list (plain user, not admin) if they aren't on it.
 * Returns true when a new user was added.
 */
export function ensureCoachUser(email: string, name: string): boolean {
  const e = normEmail(email)
  if (!e || userByEmail(e)) return false
  authDb.prepare(`INSERT INTO users (email, name, role) VALUES (?, ?, 'user')`).run(e, name.trim())
  audit('coaches', 'user_added', null, null, { email: e, role: 'user', why: 'coach' })
  return true
}

type Row = {
  id: string; kid_id: string; name: string; birthdate: string | null; age: number | null; status: string; returner: number; tryout: number
  eff_division_id: string | null; division_id: string | null; eff_team_id: string | null; returning_team_id: string | null; draft_id: string | null
  registered_at: string | null; intent: string; intent_by: string; prior: string
}
export interface CoachPlayer {
  name: string; age: number | null; status: string; division: string; team: string | null; lastTeam: string | null
  returning: boolean; tryout: boolean; registeredAt: string | null; intent: string; intentBy: string
}

/** What a coach sees: their divisions, and the players in them by where they stand. */
export function coachView(seasonId: string, email: string) {
  const s = mustSeason(seasonId)
  const ds = coachDivisions(seasonId, email)
  const ids = new Set(ds.map((d) => d.id))
  const draftIds = new Set((db.prepare(`SELECT id, division_id FROM drafts WHERE season_id = ?`).all(seasonId) as { id: string; division_id: string }[])
    .filter((r) => ids.has(r.division_id)).map((r) => r.id))
  const rows = (db.prepare(`SELECT p.id, p.kid_id, k.name, k.birthdate, p.age, p.status, p.returner, p.tryout, p.eff_division_id, p.division_id, p.eff_team_id,
      p.returning_team_id, p.draft_id, p.registered_at, p.intent, p.intent_by, p.prior
    FROM placements p JOIN kids k ON k.id = p.kid_id WHERE p.season_id = ? ORDER BY k.name`).all(seasonId) as Row[])
    // In their divisions (a 9 drafted to Majors is in both), or trying out for one of their drafts (a 9 playing up).
    .filter((r) => (r.eff_division_id && ids.has(r.eff_division_id)) || (r.division_id && ids.has(r.division_id)) || (r.draft_id && draftIds.has(r.draft_id)))
  const teamName = (id: string | null) => (id ? team(id)?.name ?? null : null)
  const players: CoachPlayer[] = rows.map((r) => ({
    name: r.name, age: ageIn(s, r.birthdate, r.age), status: r.status, division: division(r.eff_division_id ?? r.division_id ?? '')?.name ?? '',
    team: teamName(r.eff_team_id), lastTeam: teamName(r.returning_team_id) ?? (r.prior || null), returning: !!r.returner, tryout: !!r.tryout,
    registeredAt: r.registered_at, intent: r.intent, intentBy: r.intent ? r.intent_by || 'league' : '',
  }))
  const mine = coachTeams(seasonId).filter((t) => t.coach_email === normEmail(email)).map((t) => ({ id: t.id, name: t.name, division: division(t.division_id)?.name ?? '' }))
  return {
    season: { id: s.id, year: s.year, status: s.status }, teams: mine, divisions: ds.map((d) => d.name),
    rosters: mine.map((t) => ({ ...t, keepsTeams: !!division(team(t.id)!.division_id)?.keep_teams, players: teamReturners(s, t.id) })),
    registered: players.filter((p) => p.status === 'Registered'),
    expected: players.filter((p) => p.status === 'Expected' || p.status === 'Need to contact'),
    waitlist: players.filter((p) => p.status === 'Waitlist'),
  }
}

const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))

/** The email coaches get when a player registers (or joins the waitlist) for their division. */
export function registrationMail(enrollmentId: string) {
  const e = db.prepare(`SELECT p.*, k.name, k.birthdate FROM placements p JOIN kids k ON k.id = p.kid_id WHERE p.id = ?`).get(enrollmentId) as (Row & { season_id: string }) | undefined
  if (!e?.division_id) return null
  const d = division(e.eff_division_id ?? e.division_id)
  const s = season(e.season_id)
  if (!d || !s || !d.notify_coaches) return null
  const group = withGroup(d)
  const gids = new Set(group.map((x) => x.id))
  // One message per coach, even if they coach two teams in the group.
  const coaches = new Map<string, { name: string; teams: string[] }>()
  for (const t of coachTeams(e.season_id).filter((t) => gids.has(t.division_id))) {
    const c = coaches.get(t.coach_email) ?? { name: t.coach, teams: [] }
    c.teams.push(t.name)
    coaches.set(t.coach_email, c)
  }
  if (!coaches.size) return null
  const age = ageIn(s, e.birthdate, e.age)
  const waiting = e.status === 'Waitlist'
  const last = e.returning_team_id ? team(e.returning_team_id) : undefined
  const lastDiv = last ? division(last.division_id) : undefined
  const facts = [
    last ? `Returning: played for the ${last.name}${lastDiv ? ` (${lastDiv.name})` : ''} in ${s.year - 1}` : e.returner ? `Returning player` : 'New to the league',
    ...(d.group_key ? [e.tryout ? 'Trying out for Majors' : last && lastDiv?.id === d.id ? `Staying with the ${last.name}` : 'Not trying out for Majors'] : []),
  ]
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN status = 'Registered' THEN 1 ELSE 0 END) reg,
      SUM(CASE WHEN status IN ('Expected','Need to contact') THEN 1 ELSE 0 END) exp
    FROM placements WHERE season_id = ? AND eff_division_id IN (${group.map(() => '?').join(',')})`).get(e.season_id, ...group.map((x) => x.id)) as { reg: number | null; exp: number | null }
  const where = group.map((x) => x.name).join(' + ')
  const subject = `${waiting ? 'Waitlist' : 'New registration'}: ${e.name} — ${d.name}`
  const link = `${config.baseUrl}/coach`
  return [...coaches].map(([to, c]) => {
    const hi = c.name.trim().split(/\s+/)[0] || 'Coach'
    const lines = [
      `Hi ${hi},`,
      '',
      `${e.name}${age != null ? ` (league age ${age})` : ''} ${waiting ? 'joined the waitlist for' : 'just registered for'} ${d.name}.`,
      ...facts.map((f) => `• ${f}`),
      '',
      `${where} now has ${counts.reg ?? 0} registered${counts.exp ? `, and ${counts.exp} returning ${counts.exp === 1 ? 'player hasn’t' : 'players haven’t'} registered yet` : ''}.`,
      '',
      `See your division’s players: ${link}`,
      '',
      `You’re getting this because you coach the ${c.teams.join(' and the ')} in ${config.leagueName}.`,
    ]
    const html = `<p>Hi ${esc(hi)},</p>
<p><b>${esc(e.name)}</b>${age != null ? ` (league age ${age})` : ''} ${waiting ? 'joined the waitlist for' : 'just registered for'} <b>${esc(d.name)}</b>.</p>
<ul>${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
<p>${esc(where)} now has <b>${counts.reg ?? 0}</b> registered${counts.exp ? `, and ${counts.exp} returning ${counts.exp === 1 ? 'player hasn’t' : 'players haven’t'} registered yet` : ''}.</p>
<p><a href="${esc(link)}">See your division’s players</a></p>
<p style="color:#5d6577;font-size:13px">You’re getting this because you coach the ${esc(c.teams.join(' and the '))} in ${esc(config.leagueName)}.</p>`
    return { to, subject, text: lines.join('\n'), html }
  })
}

/** Tell the division's coaches about a registration. Never throws: a mail problem mustn't undo a payment. */
export async function notifyCoaches(enrollmentId: string): Promise<number> {
  try {
    if (!mailConfigured()) return 0
    const mails = registrationMail(enrollmentId)
    if (!mails?.length) return 0
    const sent = await sendBatch(mails)
    const ok = sent.filter((x) => x.ok).length
    const e = db.prepare('SELECT season_id, kid_id FROM enrollments WHERE id = ?').get(enrollmentId) as { season_id: string; kid_id: string } | undefined
    audit('registration', 'coaches_notified', e?.season_id ?? null, e?.kid_id ?? null, { to: mails.map((m) => m.to), sent: ok, errors: sent.filter((x) => !x.ok).map((x) => x.error) })
    return ok
  } catch (err) {
    console.error('coach notification failed', err)
    return 0
  }
}

// ---------- coaches manage their returners ----------
// While families sign up, a coach hears who's coming back before the league does. On their page each team lists
// its returners and the coach records what each family said (coming back / not sure / not returning) — the same
// answer a family gives on an interest email, so it frees or holds the seat the same way. A coach can also slot
// in a returner the import missed: only a kid who played for that same team last season, so nobody uses it to
// skip the draft.

const prevSeason = (s: Season) => db.prepare('SELECT * FROM seasons WHERE year < ? ORDER BY year DESC LIMIT 1').get(s.year) as Season | undefined

export interface Returner { enrollmentId: string; name: string; age: number | null; status: string; intent: string; intentBy: string; registered: boolean; addedByCoach: boolean }

/** Returners held on a team (not drafted picks), by name. */
function teamReturners(s: Season, teamId: string): Returner[] {
  const rows = db.prepare(`SELECT p.id, k.name, k.birthdate, p.age, p.status, p.intent, p.intent_by, p.kid_id FROM placements p JOIN kids k ON k.id = p.kid_id
    WHERE p.season_id = ? AND p.picked_in IS NULL AND (p.returning_team_id = ? OR p.team_id = ?) ORDER BY k.name`).all(s.id, teamId, teamId) as
    { id: string; name: string; birthdate: string | null; age: number | null; status: string; intent: string; intent_by: string; kid_id: string }[]
  const slotted = db.prepare(`SELECT 1 FROM audit WHERE season_id = ? AND kid_id = ? AND action = 'coach_slotted'`)
  return rows.map((r) => ({
    enrollmentId: r.id, name: r.name, age: ageIn(s, r.birthdate, r.age), status: r.status, intent: r.intent || '', intentBy: r.intent ? r.intent_by || 'league' : '',
    registered: r.status === 'Registered', addedByCoach: !!slotted.get(s.id, r.kid_id),
  }))
}

/** The coach's team, or an error: coaches only touch their own teams. */
function myTeam(seasonId: string, email: string, teamId: string) {
  const t = team(teamId)
  if (!t || t.season_id !== seasonId || normEmail(t.coach_email ?? '') !== normEmail(email)) throw new UserError('That isn’t one of your teams')
  const s = mustSeason(seasonId)
  if (s.status === 'complete') throw new UserError(`${s.year} is finished`)
  return { t, s, d: division(t.division_id)! }
}
function myReturner(seasonId: string, email: string, enrollmentId: string) {
  const e = db.prepare('SELECT * FROM placements WHERE id = ? AND season_id = ?').get(enrollmentId, seasonId) as
    { id: string; kid_id: string; team_id: string | null; returning_team_id: string | null; picked_in: string | null; status: string } | undefined
  const tid = e && !e.picked_in ? e.returning_team_id ?? e.team_id : null
  if (!e || !tid) throw new UserError('That player isn’t on your team')
  return { e, ...myTeam(seasonId, email, tid) }
}

/** A coach records what a returner's family said. */
export function coachSetIntent(seasonId: string, email: string, enrollmentId: string, intent: Intent) {
  const { e } = myReturner(seasonId, email, enrollmentId)
  if (e.status === 'Registered') throw new UserError('Already registered — nothing to change')
  applyIntent(seasonId, e.kid_id, intent, `coach:${normEmail(email)}`)
}

/** Last season's players a coach could slot back onto their team: same team, the right age, not held elsewhere. */
export function coachCandidates(seasonId: string, email: string, teamId: string, q: string) {
  const { s, d } = myTeam(seasonId, email, teamId)
  const prev = prevSeason(s)
  const term = q.trim()
  if (!prev || term.length < 2) return []
  const like = `%${term.replace(/[%_]/g, '')}%`
  const rows = db.prepare(`SELECT k.id AS kid_id, k.name, k.birthdate, pp.age AS prev_age, pd.key AS prev_key, pd.name AS prev_div, pt.name AS prev_team,
      cur.id AS cur_id, cur.team_id AS cur_team, cur.returning_team_id AS cur_ret, cur.picked_in AS cur_pick, cur.status AS cur_status
    FROM kids k JOIN placements pp ON pp.kid_id = k.id AND pp.season_id = ?
    LEFT JOIN divisions pd ON pd.id = pp.eff_division_id LEFT JOIN teams pt ON pt.id = pp.eff_team_id
    LEFT JOIN placements cur ON cur.kid_id = k.id AND cur.season_id = ?
    WHERE k.name LIKE ? ORDER BY (pt.name = ?) DESC, k.name LIMIT 60`).all(prev.id, s.id, like, team(teamId)!.name) as
    { kid_id: string; name: string; birthdate: string | null; prev_age: number | null; prev_key: string | null; prev_div: string | null; prev_team: string | null
      cur_id: string | null; cur_team: string | null; cur_ret: string | null; cur_pick: string | null; cur_status: string | null }[]
  return rows.map((r) => {
    const age = ageIn(s, r.birthdate, r.prev_age != null ? r.prev_age + 1 : null)
    const held = r.cur_pick ? 'Drafted this season' : (r.cur_ret ?? r.cur_team) === teamId ? 'Already on your team'
      : r.cur_ret ?? r.cur_team ? `On the ${team((r.cur_ret ?? r.cur_team)!)?.name} this season` : ''
    // Only last season's players on this team: anyone else goes through the draft, so it's the league's call.
    const notMine = r.prev_team !== team(teamId)!.name ? `${r.prev_team ? `Played for the ${r.prev_team}` : 'Wasn’t on a team'} — ask the league` : ''
    const why = held || notMine || (!fitsAge(d, age) ? `Age ${age} — too ${age != null && d.max_age != null && age > d.max_age ? 'old' : 'young'} for ${d.name}` : '')
    return { kidId: r.kid_id, name: r.name, age, last: [r.prev_div, r.prev_team].filter(Boolean).join(' · '), lastYear: prev.year, blocked: why }
  }).filter((c, i) => i < 12 || /ask the league/.test(c.blocked))
}

/** Slot a returner onto the coach's team; they hold a seat as Expected until they register. */
export function coachSlot(seasonId: string, email: string, teamId: string, kidId: string) {
  const c = coachCandidates(seasonId, email, teamId, kid(kidId)?.name ?? '').find((x) => x.kidId === kidId)
  if (!c) throw new UserError('Only players from last season can be added')
  if (c.blocked) throw new UserError(c.blocked)
  const { s, t } = myTeam(seasonId, email, teamId)
  const actor = `coach:${normEmail(email)}`
  const cur = db.prepare('SELECT * FROM enrollments WHERE season_id = ? AND kid_id = ?').get(s.id, kidId) as { id: string; status: string } | undefined
  if (cur) {
    updateEnrollment(cur.id, { teamId: t.id, returner: true, ...(['Not returning', 'Withdrawn'].includes(cur.status) ? { status: 'Expected' as const } : {}) }, actor)
  } else {
    enroll(s.id, kidId, { divisionId: t.division_id, teamId: t.id, returner: true, status: 'Expected', prior: c.last ? `${c.last} (${c.lastYear})` : '' }, actor)
  }
  audit(actor, 'coach_slotted', s.id, kidId, { team: t.name })
}

/** Undo a slot the coach made by mistake (not for anyone who has registered). */
export function coachUnslot(seasonId: string, email: string, enrollmentId: string) {
  const { e, t } = myReturner(seasonId, email, enrollmentId)
  if (e.status === 'Registered') throw new UserError('Already registered — ask the league to move them')
  updateEnrollment(e.id, { teamId: null }, `coach:${normEmail(email)}`)
  audit(`coach:${normEmail(email)}`, 'coach_removed', seasonId, e.kid_id, { team: t.name })
}
