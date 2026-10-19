import { EventEmitter } from 'node:events'
import { db } from '../db.js'
import { seats, type Seats } from './capacity.js'
import { HOLDS_SEAT, leagueAge, nameKey, slug, STATUSES, uid, type Status } from './text.js'

// ---------- change feed ----------
// Every mutation bumps the version; open pages and draft rooms refetch on the event.
export const bus = new EventEmitter()
bus.setMaxListeners(0)
let version = Date.now()
export function changed() {
  version++
  bus.emit('change', version)
}
export const currentVersion = () => version

export class UserError extends Error {}

export function audit(actor: string, action: string, seasonId: string | null, kidId: string | null, detail: unknown = '') {
  db.prepare('INSERT INTO audit (actor, action, season_id, kid_id, detail) VALUES (?, ?, ?, ?, ?)')
    .run(actor, action, seasonId, kidId, typeof detail === 'string' ? detail : JSON.stringify(detail))
}

// ---------- rows ----------
export interface Season { id: string; year: number; status: 'planning' | 'active' | 'complete'; age_cutoff: string; warn_at: number; rolled_from: string | null; notes: string }
export interface Division {
  id: string; season_id: string; key: string; name: string; sort: number; teams: number; roster_size: number; coaches: number | null
  min_age: number | null; max_age: number | null; se_match: string; group_key: string; keep_teams: number; closed: number; notes: string
}
export interface Team {
  id: string; season_id: string; division_id: string; name: string; color: string; fg: string; draft_order: number
  wins: number | null; losses: number | null; ties: number | null; coach: string
}
export interface Kid { id: string; name: string; name_key: string; birthdate: string | null; se_profile_id: string | null; notes: string }
export interface Enrollment {
  id: string; season_id: string; kid_id: string; division_id: string | null; team_id: string | null; returning_team_id: string | null
  age: number | null; returner: number; status: Status; status_locked: number; division_locked: number; tryout: number
  draft_id: string | null; rank: number | null; prior: string; notes: string; se_program: string | null
  se_registration_id: string | null; registered_at: string | null; created_at: string; updated_at: string
}
/** An enrollment with where it actually landed (a draft pick wins over the pre-draft placement). */
export interface Placement extends Enrollment {
  eff_division_id: string | null; eff_team_id: string | null; picked_in: string | null; pick_n: number | null; pick_round: number | null
}
export interface Draft {
  id: string; season_id: string; division_id: string; key: string; format: 'standard' | 'blind'; mode: 'straight' | 'snake'
  swap: string; next_id: string | null; status: 'open' | 'closed'; clock_start: number | null; started_at: number | null; closed_at: string | null
}

// ---------- settings ----------
export function getSetting<T>(key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return r ? (JSON.parse(r.value) as T) : fallback
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

// ---------- seasons ----------
export const seasons = () => db.prepare('SELECT * FROM seasons ORDER BY year').all() as Season[]
export const season = (id: string) => db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) as Season | undefined
/** The season being organized: the setting if set, else the newest one. */
export function currentSeason(): Season | undefined {
  const id = getSetting<string | null>('currentSeason', null)
  return (id && season(id)) || (db.prepare('SELECT * FROM seasons ORDER BY year DESC LIMIT 1').get() as Season | undefined)
}
export function mustSeason(id: string): Season {
  const s = season(id)
  if (!s) throw new UserError(`No ${id} season`)
  return s
}
export function updateSeason(id: string, p: Partial<Pick<Season, 'status' | 'age_cutoff' | 'warn_at' | 'notes'>>, actor: string) {
  const s = mustSeason(id)
  const next = { ...s, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) }
  db.prepare('UPDATE seasons SET status = ?, age_cutoff = ?, warn_at = ?, notes = ? WHERE id = ?').run(next.status, next.age_cutoff, next.warn_at, next.notes, id)
  audit(actor, 'season_updated', id, null, p)
  changed()
}

// ---------- divisions ----------
export const divisions = (seasonId: string) => db.prepare('SELECT * FROM divisions WHERE season_id = ? ORDER BY sort, name').all(seasonId) as Division[]
export const division = (id: string) => db.prepare('SELECT * FROM divisions WHERE id = ?').get(id) as Division | undefined
export const divisionByKey = (seasonId: string, key: string) =>
  db.prepare('SELECT * FROM divisions WHERE season_id = ? AND key = ?').get(seasonId, key) as Division | undefined

export function fitsAge(d: Pick<Division, 'min_age' | 'max_age'>, age: number | null): boolean {
  if (age == null) return true
  return (d.min_age == null || age >= d.min_age) && (d.max_age == null || age <= d.max_age)
}

/** Division for an SE program name: the first division (by sort) any of whose match words appear in it. */
export function divisionForProgram(seasonId: string, program: string | null): Division | undefined {
  if (!program) return undefined
  const hay = ` ${nameKey(program)} `
  for (const d of divisions(seasonId)) {
    const words = (d.se_match || d.name).split(',').map((w) => nameKey(w)).filter(Boolean)
    if (words.some((w) => hay.includes(` ${w} `))) return d
  }
  return undefined
}

/**
 * Next season's division for a kid by league age: stay put while still
 * eligible, otherwise the next level up that fits. Within a shared group
 * (Majors + Minors) the lowest-sorted division is the home for new arrivals.
 */
export function divisionForAge(list: Division[], age: number | null, priorKey: string | null): Division | undefined {
  if (age == null) return priorKey ? list.find((d) => d.key === priorKey) : undefined
  const fits = list.filter((d) => (d.min_age != null || d.max_age != null) && fitsAge(d, age))
  if (!fits.length) return undefined
  const prior = priorKey ? list.find((d) => d.key === priorKey) : undefined
  if (prior && fits.some((d) => d.id === prior.id)) return prior
  const above = prior ? fits.filter((d) => d.sort > prior.sort) : fits
  const pool = above.length ? above : fits
  // Prefer a division that families can register for directly over a draft-only one (Majors).
  return pool.find((d) => !isDraftOnly(d)) ?? pool[0]
}
/** A division nobody registers into directly — it fills from returners and its draft (Majors). */
export const isDraftOnly = (d: Division) => d.se_match.trim() === '-'

export interface DivisionInput {
  name: string; teams: number; roster_size: number; coaches?: number | null; min_age?: number | null; max_age?: number | null
  se_match?: string; group_key?: string; keep_teams?: boolean; closed?: boolean; notes?: string; key?: string; sort?: number
}
export function saveDivision(seasonId: string, id: string | null, d: DivisionInput, actor: string): Division {
  mustSeason(seasonId)
  const name = d.name.trim()
  if (!name) throw new UserError('Division needs a name')
  if (d.min_age != null && d.max_age != null && d.min_age > d.max_age) throw new UserError('Youngest age is above oldest age')
  const vals = [name, d.teams, d.roster_size, d.coaches ?? null, d.min_age ?? null, d.max_age ?? null, (d.se_match ?? '').trim(),
    (d.group_key ?? '').trim(), d.keep_teams ? 1 : 0, d.closed ? 1 : 0, (d.notes ?? '').trim()]
  if (id) {
    if (!division(id)) throw new UserError('Unknown division')
    db.prepare(`UPDATE divisions SET name=?, teams=?, roster_size=?, coaches=?, min_age=?, max_age=?, se_match=?, group_key=?, keep_teams=?,
      closed=?, notes=?, sort = COALESCE(?, sort) WHERE id = ?`).run(...vals, d.sort ?? null, id)
    audit(actor, 'division_saved', seasonId, null, { division: name, teams: d.teams, roster: d.roster_size })
  } else {
    let key = d.key || slug(name)
    while (divisionByKey(seasonId, key)) key = `${slug(name)}${uid().slice(0, 3)}`
    const sort = d.sort ?? ((db.prepare('SELECT MAX(sort) AS m FROM divisions WHERE season_id = ?').get(seasonId) as { m: number | null }).m ?? 0) + 1
    id = `${seasonId}-${key}`
    db.prepare(`INSERT INTO divisions (name, teams, roster_size, coaches, min_age, max_age, se_match, group_key, keep_teams, closed, notes,
      sort, id, season_id, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, sort, id, seasonId, key)
    audit(actor, 'division_added', seasonId, null, { division: name })
  }
  refreshPools(seasonId)
  changed()
  return division(id)!
}
export function deleteDivision(id: string, actor: string) {
  const d = division(id)
  if (!d) throw new UserError('Unknown division')
  if (db.prepare('SELECT 1 FROM picks p JOIN drafts r ON r.id = p.draft_id WHERE r.division_id = ?').get(id)) throw new UserError('This division has draft picks — clear them first')
  db.prepare('DELETE FROM divisions WHERE id = ?').run(id)
  audit(actor, 'division_deleted', d.season_id, null, { division: d.name })
  refreshPools(d.season_id)
  changed()
}
export function reorderDivisions(seasonId: string, ids: string[], actor: string) {
  const up = db.prepare('UPDATE divisions SET sort = ? WHERE id = ? AND season_id = ?')
  db.transaction(() => ids.forEach((id, i) => up.run(i + 1, id, seasonId)))()
  audit(actor, 'divisions_reordered', seasonId, null, ids)
  changed()
}

// ---------- teams ----------
export const teams = (seasonId: string) => db.prepare('SELECT * FROM teams WHERE season_id = ? ORDER BY draft_order, name').all(seasonId) as Team[]
export const divisionTeams = (divisionId: string) => db.prepare('SELECT * FROM teams WHERE division_id = ? ORDER BY draft_order, name').all(divisionId) as Team[]
export const team = (id: string) => db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Team | undefined

export interface TeamInput { name: string; color?: string; fg?: string; wins?: number | null; losses?: number | null; ties?: number | null; coach?: string }
export function saveTeam(divisionId: string, id: string | null, t: TeamInput, actor: string): Team {
  const d = division(divisionId)
  if (!d) throw new UserError('Unknown division')
  const name = t.name.trim()
  if (!name) throw new UserError('Team name is required')
  if (id) {
    const cur = team(id)
    if (!cur || cur.division_id !== divisionId) throw new UserError('Unknown team')
    db.prepare('UPDATE teams SET name=?, color=?, fg=?, wins=?, losses=?, ties=?, coach=? WHERE id=?').run(name, t.color ?? cur.color, t.fg ?? cur.fg,
      t.wins !== undefined ? t.wins : cur.wins, t.losses !== undefined ? t.losses : cur.losses, t.ties !== undefined ? t.ties : cur.ties, t.coach ?? cur.coach, id)
  } else {
    id = uid()
    const max = (db.prepare('SELECT COALESCE(MAX(draft_order), 0) m FROM teams WHERE division_id = ?').get(divisionId) as { m: number }).m
    db.prepare('INSERT INTO teams (id, season_id, division_id, name, color, fg, draft_order, wins, losses, ties, coach) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.season_id, divisionId, name, t.color ?? '#14213D', t.fg ?? '#FFFFFF', max + 1, t.wins ?? null, t.losses ?? null, t.ties ?? null, t.coach ?? '')
  }
  audit(actor, 'team_saved', d.season_id, null, { division: d.name, team: name })
  changed()
  return team(id)!
}
export function deleteTeam(id: string, actor: string) {
  const t = team(id)
  if (!t) throw new UserError('Unknown team')
  if (db.prepare('SELECT 1 FROM enrollments WHERE team_id = ? OR returning_team_id = ?').get(id, id) || db.prepare('SELECT 1 FROM picks WHERE team_id = ?').get(id))
    throw new UserError(`Move ${t.name}'s players and picks off it first`)
  db.prepare('DELETE FROM teams WHERE id = ?').run(id)
  audit(actor, 'team_deleted', t.season_id, null, { team: t.name })
  changed()
}
export function setTeamOrder(divisionId: string, order: string[], actor: string) {
  const ids = divisionTeams(divisionId).map((t) => t.id)
  if (order.length !== ids.length || !ids.every((i) => order.includes(i))) throw new UserError('Order must list every team once')
  const up = db.prepare('UPDATE teams SET draft_order = ? WHERE id = ?')
  db.transaction(() => order.forEach((id, i) => up.run(i + 1, id)))()
  audit(actor, 'draft_order_changed', division(divisionId)?.season_id ?? null, null, { division: division(divisionId)?.name, order })
  changed()
}
/**
 * Draft order from last season's records: worst record picks first. Teams are
 * matched to last season by name; a team with no record goes last.
 */
export function orderByLastRecord(divisionId: string, actor: string) {
  const d = division(divisionId)
  if (!d) throw new UserError('Unknown division')
  const prevSeason = db.prepare('SELECT * FROM seasons WHERE year < (SELECT year FROM seasons WHERE id = ?) ORDER BY year DESC LIMIT 1').get(d.season_id) as Season | undefined
  if (!prevSeason) throw new UserError('There is no earlier season to take records from')
  const prev = divisionByKey(prevSeason.id, d.key)
  const prevTeams = prev ? divisionTeams(prev.id) : []
  const pct = (t?: Team) => {
    if (!t || t.wins == null || t.losses == null) return null
    const g = t.wins + t.losses + (t.ties ?? 0)
    return g ? (t.wins + (t.ties ?? 0) / 2) / g : null
  }
  const mine = divisionTeams(divisionId).map((t) => ({ t, p: pct(prevTeams.find((x) => nameKey(x.name) === nameKey(t.name))) }))
  if (!mine.some((m) => m.p != null)) throw new UserError(`No ${prevSeason.year} records entered for ${d.name} teams`)
  mine.sort((a, b) => (a.p ?? 2) - (b.p ?? 2) || a.t.draft_order - b.t.draft_order)
  setTeamOrder(divisionId, mine.map((m) => m.t.id), actor)
}

// ---------- kids ----------
export const kid = (id: string) => db.prepare('SELECT * FROM kids WHERE id = ?').get(id) as Kid | undefined
export function createKid(name: string, birthdate: string | null, seProfileId: string | null = null): Kid {
  const id = uid()
  db.prepare('INSERT INTO kids (id, name, name_key, birthdate, se_profile_id) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), nameKey(name), birthdate, seProfileId)
  return kid(id)!
}
export function updateKid(id: string, p: { name?: string; birthdate?: string | null; notes?: string }, actor: string) {
  const k = kid(id)
  if (!k) throw new UserError('Unknown kid')
  const name = p.name?.trim() || k.name
  db.prepare(`UPDATE kids SET name = ?, name_key = ?, birthdate = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(name, nameKey(name), p.birthdate !== undefined ? p.birthdate : k.birthdate, p.notes ?? k.notes, id)
  audit(actor, 'kid_updated', null, id, p)
  changed()
}

/** League age in a season: from the birthdate when known, else the age recorded on the enrollment. */
export function ageIn(s: Season, birthdate: string | null, fallback: number | null): number | null {
  return birthdate ? leagueAge(birthdate, s.year, s.age_cutoff) : fallback
}

// ---------- enrollments ----------
export const enrollment = (id: string) => db.prepare('SELECT * FROM enrollments WHERE id = ?').get(id) as Enrollment | undefined
export const placements = (seasonId: string) => db.prepare('SELECT * FROM placements WHERE season_id = ?').all(seasonId) as Placement[]
export const placement = (id: string) => db.prepare('SELECT * FROM placements WHERE id = ?').get(id) as Placement | undefined
export const drafts = (seasonId: string) =>
  db.prepare('SELECT r.* FROM drafts r JOIN divisions d ON d.id = r.division_id WHERE r.season_id = ? ORDER BY d.sort').all(seasonId) as Draft[]
export const draftFor = (divisionId: string) => db.prepare('SELECT * FROM drafts WHERE division_id = ?').get(divisionId) as Draft | undefined

const OUT: readonly Status[] = ['Not returning', 'Withdrawn']

/** The group drafts in the order they run (Majors, then Minors), following next_id. */
function groupChain(seasonId: string, groupKey: string): Draft[] {
  const ds = drafts(seasonId).filter((r) => division(r.division_id)?.group_key === groupKey)
  const first = ds.find((r) => !ds.some((o) => o.next_id === r.id))
  const chain: Draft[] = []
  for (let r = first; r && !chain.includes(r); r = ds.find((o) => o.id === r!.next_id)) chain.push(r)
  return chain
}

/**
 * Which draft pool a kid belongs in right now. Kids on a team (returners) are
 * in no pool. Inside a group, a kid trying out starts in the first open draft
 * (Majors); everyone else in the group waits for their home division's draft
 * (Minors). A 9-year-old trying out joins the group that fits their age.
 */
export function poolFor(e: Enrollment, s: Season, birthdate: string | null): string | null {
  // Waitlisted kids haven't got a seat yet, so they aren't draftable.
  if (e.team_id || OUT.includes(e.status) || e.status === 'Waitlist' || !e.division_id) return null
  const home = division(e.division_id)
  if (!home) return null
  const own = draftFor(home.id)
  let groupKey = home.group_key
  if (e.tryout && !groupKey) {
    // Playing up (a 9 trying out for the 10–12 drafts): the first group they're not too old for.
    const age = ageIn(s, birthdate, e.age)
    groupKey = divisions(s.id).find((d) => d.group_key && (age == null || d.max_age == null || age <= d.max_age) && d.sort > home.sort)?.group_key ?? ''
  }
  if (groupKey && (e.tryout || home.group_key)) {
    const chain = groupChain(s.id, groupKey)
    if (e.tryout) {
      const open = chain.find((r) => r.status === 'open')
      // A 9 trying out who goes undrafted in every group draft stays in their own division.
      return open?.id ?? (own?.status === 'open' ? own.id : null)
    }
    // Not trying out: the home division's draft, once the drafts before it have closed.
    if (own) return own.status === 'open' ? own.id : null
    return null
  }
  return own?.status === 'open' ? own.id : null
}

/** Recompute every unpicked kid's draft pool for a season. Cheap, so call it after anything that could change one. */
export function refreshPools(seasonId: string) {
  const s = season(seasonId)
  if (!s) return
  const rows = db.prepare(`SELECT e.*, k.birthdate AS kid_birthdate FROM enrollments e JOIN kids k ON k.id = e.kid_id
    WHERE e.season_id = ? AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.enrollment_id = e.id)`).all(seasonId) as (Enrollment & { kid_birthdate: string | null })[]
  const up = db.prepare('UPDATE enrollments SET draft_id = ? WHERE id = ?')
  db.transaction(() => { for (const e of rows) { const want = poolFor(e, s, e.kid_birthdate); if (want !== e.draft_id) up.run(want, e.id) } })()
}

export interface EnrollInput {
  divisionId?: string | null; teamId?: string | null; status?: Status; locked?: boolean; returner?: boolean
  tryout?: boolean; rank?: number | null; notes?: string; age?: number | null; divisionLocked?: boolean
}

export function enroll(seasonId: string, kidId: string, p: EnrollInput & { prior?: string; seProgram?: string | null }, actor: string): Enrollment {
  mustSeason(seasonId)
  if (db.prepare('SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ?').get(seasonId, kidId)) throw new UserError('Already enrolled this season')
  if (p.divisionId && division(p.divisionId)?.season_id !== seasonId) throw new UserError('Unknown division')
  const id = uid()
  const returner = p.returner ?? false
  db.prepare(`INSERT INTO enrollments (id, season_id, kid_id, division_id, team_id, returning_team_id, age, returner, status, status_locked,
    division_locked, tryout, rank, prior, notes, se_program, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, seasonId, kidId, p.divisionId ?? null, p.teamId ?? null, returner ? p.teamId ?? null : null, p.age ?? null, returner ? 1 : 0,
      p.status ?? (returner ? 'Expected' : 'Registered'), p.locked ? 1 : 0, p.divisionLocked ? 1 : 0, p.tryout ? 1 : 0, p.rank ?? null,
      p.prior ?? '', p.notes ?? '', p.seProgram ?? null, (p.status ?? (returner ? 'Expected' : 'Registered')) === 'Registered' ? new Date().toISOString() : null)
  audit(actor, 'enrolled', seasonId, kidId, { division: p.divisionId ? division(p.divisionId)?.name : null })
  refreshPools(seasonId)
  changed()
  return enrollment(id)!
}

export function updateEnrollment(id: string, p: EnrollInput, actor: string): Enrollment {
  const e = enrollment(id)
  if (!e) throw new UserError('Unknown enrollment')
  if (p.status && !STATUSES.includes(p.status)) throw new UserError('Unknown status')
  const fields: Record<string, unknown> = {}
  if (p.status !== undefined) fields.status = p.status
  if (p.locked !== undefined) fields.status_locked = p.locked ? 1 : 0
  if (p.returner !== undefined) fields.returner = p.returner ? 1 : 0
  if (p.rank !== undefined) fields.rank = p.rank
  if (p.notes !== undefined) fields.notes = p.notes
  if (p.age !== undefined) fields.age = p.age
  if (p.divisionLocked !== undefined) fields.division_locked = p.divisionLocked ? 1 : 0
  if (p.teamId !== undefined) {
    if (p.teamId && team(p.teamId)?.season_id !== e.season_id) throw new UserError('Unknown team')
    if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ?').get(id)) throw new UserError('This kid was drafted — change the pick in the draft room')
    fields.team_id = p.teamId
    fields.returning_team_id = p.teamId
    if (p.teamId) fields.division_id = team(p.teamId)!.division_id
  }
  if (p.status === 'Registered' && e.status !== 'Registered') fields.registered_at = new Date().toISOString()
  const keys = Object.keys(fields)
  if (keys.length) {
    db.prepare(`UPDATE enrollments SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id })
    audit(actor, 'enrollment_edited', e.season_id, e.kid_id, Object.fromEntries(keys.map((k) => [k, { from: (e as unknown as Record<string, unknown>)[k], to: fields[k] }])))
  }
  if (p.divisionId !== undefined && p.divisionId !== e.division_id) moveEnrollment(id, p.divisionId, actor)
  if (p.tryout !== undefined && !!p.tryout !== !!e.tryout) setTryout(id, p.tryout, actor)
  refreshPools(e.season_id)
  changed()
  return enrollment(id)!
}

/**
 * Admin moves a kid to another division (wrong program picked, playing up...).
 * The move is pinned so a resent SportsEngine registration won't undo it.
 */
export function moveEnrollment(id: string, divisionId: string | null, actor: string, reason = ''): Enrollment {
  const e = enrollment(id)
  if (!e) throw new UserError('Unknown enrollment')
  const to = divisionId ? division(divisionId) : undefined
  if (divisionId && to?.season_id !== e.season_id) throw new UserError('Unknown division')
  if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ?').get(id)) throw new UserError('This kid was drafted — remove the pick in the draft room first')
  const from = e.division_id ? division(e.division_id) : undefined
  // Leaving the division means leaving its team too.
  const keepTeam = e.team_id && team(e.team_id)?.division_id === divisionId
  db.prepare(`UPDATE enrollments SET division_id = ?, division_locked = ?, team_id = ?, returning_team_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(divisionId, divisionId ? 1 : 0, keepTeam ? e.team_id : null, keepTeam ? e.returning_team_id : null, id)
  audit(actor, 'division_moved', e.season_id, e.kid_id, { from: from?.name ?? null, to: to?.name ?? null, reason: reason || undefined })
  refreshPools(e.season_id)
  changed()
  return enrollment(id)!
}

/**
 * Trying out for the group's first draft (Majors). A returner with a team
 * (last year's Minors) gives up that team to try out — if they aren't drafted
 * they go into the Minors draft, not back to the old team. Switching the
 * tryout off again before any pick puts them back on it.
 */
export function setTryout(id: string, on: boolean, actor: string) {
  const e = enrollment(id)
  if (!e) throw new UserError('Unknown enrollment')
  if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ?').get(id)) throw new UserError('This kid was already drafted')
  const home = e.division_id ? division(e.division_id) : undefined
  if (on && home && isDraftOnly(home)) throw new UserError(`Already in ${home.name} — there's nothing to try out for`)
  db.prepare(`UPDATE enrollments SET tryout = ?, team_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(on ? 1 : 0, on ? null : e.returning_team_id, id)
  audit(actor, on ? 'tryout_on' : 'tryout_off', e.season_id, e.kid_id, e.returning_team_id ? { team: team(e.returning_team_id)?.name } : '')
  refreshPools(e.season_id)
  changed()
}

export function deleteEnrollment(id: string, actor: string) {
  const e = enrollment(id)
  if (!e) throw new UserError('Unknown enrollment')
  if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ?').get(id)) throw new UserError('This kid was drafted — remove the pick first')
  db.prepare('DELETE FROM enrollments WHERE id = ?').run(id)
  audit(actor, 'unenrolled', e.season_id, e.kid_id)
  changed()
}

// ---------- season view ----------
export interface DivisionView extends Division { seats: Seats; draft: { id: string; key: string; format: string; status: string } | null; ageMismatches?: number; ageExceptions?: number }
export interface GroupView { key: string; name: string; divisions: string[]; seats: Seats }

export function seasonState(seasonId: string, isAdmin: boolean) {
  const s = mustSeason(seasonId)
  const ps = placements(seasonId)
  const kidRows = db.prepare('SELECT k.* FROM kids k JOIN enrollments e ON e.kid_id = k.id WHERE e.season_id = ?').all(seasonId) as Kid[]
  const kids = new Map(kidRows.map((k) => [k.id, k]))
  const ds = divisions(seasonId)
  const views: DivisionView[] = ds.map((d) => {
    const mine = ps.filter((p) => p.eff_division_id === d.id)
    const r = draftFor(d.id)
    const v: DivisionView = { ...d, seats: seats(d, mine, s.warn_at), draft: r ? { id: r.id, key: r.key, format: r.format, status: r.status } : null }
    if (isAdmin) {
      // Kids an admin placed here on purpose (a 4-year-old moved up to T-Ball) are exceptions, not mistakes.
      const outside = mine.filter((p) => !OUT.includes(p.status) && !fitsAge(d, ageIn(s, kids.get(p.kid_id)?.birthdate ?? null, p.age)))
      v.ageMismatches = outside.filter((p) => !p.division_locked).length
      v.ageExceptions = outside.length - v.ageMismatches
    } else { v.se_match = ''; v.notes = '' }
    return v
  })
  // Divisions sharing a registration program (Majors + Minors) are counted together:
  // families sign up once and the drafts decide which one a kid lands in.
  const groups: GroupView[] = []
  for (const key of [...new Set(ds.map((d) => d.group_key).filter(Boolean))]) {
    const members = ds.filter((d) => d.group_key === key)
    const pool = ps.filter((p) => members.some((d) => d.id === p.eff_division_id))
    const cap = { teams: 1, roster_size: members.reduce((a, d) => a + d.teams * d.roster_size, 0), coaches: null, closed: members.every((d) => d.closed) ? 1 : 0 }
    groups.push({ key, name: members.map((d) => d.name).join(' + '), divisions: members.map((d) => d.id), seats: seats(cap, pool, s.warn_at) })
  }
  const ts = teams(seasonId)
  const total = views.reduce((a, d) => ({
    capacity: a.capacity + d.seats.capacity, registered: a.registered + d.seats.registered,
    held: a.held + d.seats.held, open: a.open + Math.max(0, d.seats.open), waitlist: a.waitlist + d.seats.waitlist,
  }), { capacity: 0, registered: 0, held: 0, open: 0, waitlist: 0 })
  const base = {
    season: s, seasons: seasons().map(({ id, year, status }) => ({ id, year, status })), current: currentSeason()?.id ?? null,
    divisions: views, groups, total,
    teams: ts.map(({ id, division_id, name, color, fg, draft_order, wins, losses, ties }) => ({ id, division_id, name, color, fg, draft_order, wins, losses, ties })),
    drafts: drafts(seasonId).map((r) => ({ id: r.id, key: r.key, division_id: r.division_id, format: r.format, status: r.status, next_id: r.next_id,
      picks: (db.prepare('SELECT COUNT(*) n FROM picks WHERE draft_id = ?').get(r.id) as { n: number }).n,
      pool: ps.filter((p) => p.draft_id === r.id && !p.picked_in && !OUT.includes(p.status)).length })),
    unplaced: ps.filter((p) => !p.eff_division_id && !OUT.includes(p.status)).length,
  }
  if (!isAdmin) return base
  // What each kid bought at registration (e.g. the volunteer fee), from paid signups.
  const bought = new Map<string, string[]>()
  for (const r of db.prepare(`SELECT op.enrollment_id, ol.name, ol.qty, ol.tag FROM order_lines ol JOIN order_players op ON op.id = ol.order_player_id
    JOIN enrollments e ON e.id = op.enrollment_id WHERE e.season_id = ? AND ol.charged = 1 AND op.status = 'registered'`).all(seasonId) as { enrollment_id: string; name: string; qty: number; tag: string }[]) {
    const list = bought.get(r.enrollment_id) ?? []
    list.push(`${r.name}${r.qty > 1 ? ` ×${r.qty}` : ''}${r.tag ? ` [${r.tag}]` : ''}`)
    bought.set(r.enrollment_id, list)
  }
  return {
    ...base,
    kids: ps.map((p) => {
      const k = kids.get(p.kid_id)!
      return {
        ...p, name: k.name, birthdate: k.birthdate, se_profile_id: k.se_profile_id, kid_notes: k.notes,
        league_age: ageIn(s, k.birthdate, p.age), bought: bought.get(p.id) ?? [],
      }
    }),
    openRegistrations: (db.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE outcome IN ('no_division','ambiguous','error','pending')`).get() as { n: number }).n,
  }
}

/** Every season a kid has played or been enrolled in, oldest first. */
export function kidHistory(kidId: string) {
  const k = kid(kidId)
  if (!k) throw new UserError('Unknown kid')
  const rows = db.prepare(`SELECT p.*, s.year, d.name AS division_name, t.name AS team_name, t.wins, t.losses, t.ties
    FROM placements p JOIN seasons s ON s.id = p.season_id
    LEFT JOIN divisions d ON d.id = p.eff_division_id LEFT JOIN teams t ON t.id = p.eff_team_id
    WHERE p.kid_id = ? ORDER BY s.year`).all(kidId) as (Placement & { year: number; division_name: string | null; team_name: string | null; wins: number | null; losses: number | null; ties: number | null })[]
  return {
    kid: k,
    seasons: rows.map((r) => ({
      season: r.season_id, year: r.year, division: r.division_name, team: r.team_name, status: r.status, returner: !!r.returner,
      how: r.picked_in ? `Drafted · round ${r.pick_round}, pick #${r.pick_n}` : r.returning_team_id && r.team_id ? 'Returned to team' : r.eff_team_id ? 'Placed on team' : r.returner ? 'Returning' : 'New',
      record: r.wins != null && r.losses != null ? `${r.wins}–${r.losses}${r.ties ? `–${r.ties}` : ''}` : null,
      age: ageIn(season(r.season_id)!, k.birthdate, r.age),
    })),
    audit: db.prepare('SELECT * FROM audit WHERE kid_id = ? ORDER BY id DESC LIMIT 200').all(kidId),
    registrations: db.prepare('SELECT id, received_at, source, program, outcome, note, season_id FROM registrations WHERE kid_id = ? ORDER BY id DESC').all(kidId),
  }
}

export { HOLDS_SEAT }

/** Campaign web addresses: /register/<slug>. */
export const slugOk = (s: string) => /^[a-z0-9][a-z0-9-]{1,59}$/.test(s)
