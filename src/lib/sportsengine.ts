import { db } from '../db.js'
import {
  ageIn, audit, changed, createKid, currentSeason, division, divisionForProgram, enrollment, fitsAge, kid, refreshPools, season,
  seasonState, type Division, type Enrollment, type Kid, type Season,
} from './league.js'
import { extract, type Extracted } from './sepayload.js'
import { nameKey, parseCsv, uid } from './text.js'

// SportsEngine registrations → kids and season enrollments.
//
// A registration finds its season by the year in the payload (else the
// current season), finds the kid (SportsEngine id, then name + birthdate),
// and places them by the program the family picked. Majors and Minors share
// one program, so those kids land in the shared pool and the drafts decide.
// An admin's move wins over the program; a returner on a team stays on it.

export { extract, verifySignature } from './sepayload.js'
export type Outcome = 'placed' | 'returner' | 'no_division' | 'wrong_year' | 'ambiguous' | 'withdrawn' | 'ignored' | 'error'
type Result = { outcome: Outcome; note: string; kidId?: string; enrollmentId?: string; divisionId?: string; seasonId?: string }

export function matchKid(seasonId: string, x: Pick<Extracted, 'firstName' | 'lastName' | 'birthdate' | 'seProfileId'>): { kid?: Kid; ambiguous?: string } {
  if (x.seProfileId) {
    const k = db.prepare('SELECT * FROM kids WHERE se_profile_id = ?').get(x.seProfileId) as Kid | undefined
    if (k) return { kid: k }
  }
  if (!x.firstName || !x.lastName) return {}
  let cands = db.prepare('SELECT * FROM kids WHERE name_key = ?').all(nameKey(`${x.firstName} ${x.lastName}`)) as Kid[]
  if (x.birthdate) cands = cands.filter((c) => !c.birthdate || c.birthdate === x.birthdate)
  if (cands.length > 1) {
    // Two kids with the same name: the one already expected this season is the likely match.
    const here = cands.filter((c) => db.prepare('SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ?').get(seasonId, c.id))
    if (here.length === 1) return { kid: here[0] }
    return { ambiguous: `${cands.length} kids named ${x.firstName} ${x.lastName}` }
  }
  return { kid: cands[0] }
}

function overNote(s: Season, d: Division): string {
  const st = seasonState(s.id, false)
  const g = d.group_key ? st.groups.find((x) => x.key === d.group_key) : undefined
  const v = g?.seats ?? st.divisions.find((x) => x.id === d.id)?.seats
  return v && v.capacity && v.open < 0 ? ` — ${g?.name ?? d.name} is now ${-v.open} over capacity` : ''
}
function ageNote(s: Season, d: Division, birthdate: string | null, fallback: number | null): string {
  const age = ageIn(s, birthdate, fallback)
  if (age == null || fitsAge(d, age)) return ''
  return ` — league age ${age} is outside ${d.name} (${d.min_age ?? '?'}–${d.max_age ?? '?'})`
}

/** Put a registration on a kid's enrollment for the season (creating either as needed). */
function apply(regId: number, s: Season, k: Kid | undefined, x: Extracted, target: Division | undefined, actor: string, pin = false): Result {
  const e = k ? db.prepare('SELECT * FROM enrollments WHERE season_id = ? AND kid_id = ?').get(s.id, k.id) as Enrollment | undefined : undefined
  const link = (kidId: string, enrId: string | null, divId: string | null) =>
    db.prepare('UPDATE registrations SET kid_id = ?, enrollment_id = ?, division_id = ?, season_id = ? WHERE id = ?').run(kidId, enrId, divId, s.id, regId)

  if (x.cancelled) {
    if (!k || !e) return { outcome: 'ignored', note: `cancellation for a kid not enrolled in ${s.year}` }
    link(k.id, e.id, e.division_id)
    if (e.status_locked) return { outcome: 'withdrawn', note: `cancellation — status locked at "${e.status}", not changed`, kidId: k.id }
    db.prepare(`UPDATE enrollments SET status = 'Withdrawn', updated_at = datetime('now') WHERE id = ?`).run(e.id)
    audit(actor, 'withdrawn_in_sportsengine', s.id, k.id, { registration: regId, from: e.status })
    return { outcome: 'withdrawn', note: `${e.status} → Withdrawn (seat released)`, kidId: k.id, enrollmentId: e.id, divisionId: e.division_id ?? undefined }
  }

  // Keep the kid's record current.
  if (k) {
    const takenId = x.seProfileId && db.prepare('SELECT 1 FROM kids WHERE se_profile_id = ? AND id <> ?').get(x.seProfileId, k.id) ? null : x.seProfileId
    db.prepare(`UPDATE kids SET se_profile_id = COALESCE(se_profile_id, ?), birthdate = COALESCE(birthdate, ?), updated_at = datetime('now') WHERE id = ?`)
      .run(takenId, x.birthdate, k.id)
  }

  if (!e) {
    if (!target) return { outcome: 'no_division', note: x.program ? `no division matches program "${x.program}"` : 'no program found in payload', kidId: k?.id }
    if (!k && (!x.firstName || !x.lastName)) return { outcome: 'error', note: 'no participant name found in payload' }
    const kk = k ?? createKid(`${x.firstName} ${x.lastName}`, x.birthdate, x.seProfileId)
    const id = uid()
    // New to a shared group (Majors/Minors): they try out for the first draft unless an admin switches it off.
    db.prepare(`INSERT INTO enrollments (id, season_id, kid_id, division_id, division_locked, status, tryout, se_program, se_registration_id, registered_at)
      VALUES (?, ?, ?, ?, ?, 'Registered', ?, ?, ?, ?)`).run(id, s.id, kk.id, target.id, pin ? 1 : 0, target.group_key ? 1 : 0, x.program, x.seRegistrationId, new Date().toISOString())
    audit(actor, k ? 'registered_returning_kid' : 'registered_new', s.id, kk.id, { registration: regId, division: target.name })
    link(kk.id, id, target.id)
    return {
      outcome: 'placed', note: `${k ? 'known kid' : 'new kid'} in ${target.name}${target.group_key ? ' pool' : ''}${ageNote(s, target, x.birthdate ?? kk.birthdate, null)}${overNote(s, target)}`,
      kidId: kk.id, enrollmentId: id, divisionId: target.id,
    }
  }

  // Already expected this season (usually a returner).
  const cur = e.division_id ? division(e.division_id) : undefined
  let dest = cur
  let note = ''
  const sameGroup = !!(cur && target && cur.group_key && cur.group_key === target.group_key)
  if (target && cur && target.id !== cur.id && !sameGroup) {
    if (pin) dest = target
    else if (e.division_locked) note += ` — registered for ${target.name}, kept in ${cur.name} (placed by an admin)`
    else if (e.team_id) note += ` — registered for ${target.name}, but still on a ${cur.name} team; move them by hand if that's right`
    else { dest = target; note += ` — moved from ${cur.name} to ${target.name} per their program` }
  } else if (!cur && target) dest = target
  if (dest?.id !== e.division_id) {
    db.prepare('UPDATE enrollments SET division_id = ?, team_id = NULL, returning_team_id = NULL, division_locked = MAX(division_locked, ?) WHERE id = ?')
      .run(dest?.id ?? null, pin ? 1 : 0, e.id)
  }
  db.prepare(`UPDATE enrollments SET se_program = COALESCE(?, se_program), se_registration_id = COALESCE(?, se_registration_id), updated_at = datetime('now') WHERE id = ?`)
    .run(x.program, x.seRegistrationId, e.id)
  if (!dest) note += ' — not in a division yet; place them from Kids'
  if (e.status_locked) note = `status locked at "${e.status}" by an admin — not changed${note}`
  else if (e.status === 'Registered') note = `already Registered${note}`
  else {
    db.prepare(`UPDATE enrollments SET status = 'Registered', registered_at = ? WHERE id = ?`).run(new Date().toISOString(), e.id)
    audit(actor, 'registered', s.id, k!.id, { registration: regId, from: e.status, division: dest?.name ?? null })
    note = `${e.status} → Registered${note}`
  }
  if (dest) note += ageNote(s, dest, x.birthdate ?? k!.birthdate, e.age) + overNote(s, dest)
  link(k!.id, e.id, dest?.id ?? null)
  return { outcome: e.returner ? 'returner' : 'placed', note, kidId: k!.id, enrollmentId: e.id, divisionId: dest?.id }
}

interface RegRow { id: number; raw: string; source: string }

function seasonFor(x: Extracted): Season | undefined {
  if (x.regYear) return db.prepare('SELECT * FROM seasons WHERE year = ?').get(x.regYear) as Season | undefined
  return currentSeason()
}

export function processRegistration(regId: number, actor = 'sportsengine'): Result {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as RegRow | undefined
  if (!r) throw new Error('no such registration')
  let x: Extracted
  try { x = extract(JSON.parse(r.raw)) } catch (e) {
    db.prepare(`UPDATE registrations SET outcome = 'error', note = ? WHERE id = ?`).run(String(e), regId)
    return { outcome: 'error', note: String(e) }
  }
  db.prepare(`UPDATE registrations SET event_type=?, first_name=?, last_name=?, birthdate=?, reg_year=?, program=?, se_profile_id=?, se_registration_id=? WHERE id=?`)
    .run(x.eventType, x.firstName, x.lastName, x.birthdate, x.regYear, x.program, x.seProfileId, x.seRegistrationId, regId)
  const s = seasonFor(x)
  let res: Result
  if (!s) res = { outcome: 'wrong_year', note: x.regYear ? `there is no ${x.regYear} season` : 'no season set up yet' }
  else if (s.status === 'complete') res = { outcome: 'wrong_year', note: `the ${s.year} season is finished` }
  else {
    const m = matchKid(s.id, x)
    if (m.ambiguous) res = { outcome: 'ambiguous', note: m.ambiguous }
    else res = db.transaction(() => apply(regId, s, m.kid, x, divisionForProgram(s.id, x.program), actor))()
    if (!x.regYear) res.note += ` (season not in payload — filed under ${s.year})`
    res.seasonId = s.id
    refreshPools(s.id)
  }
  db.prepare('UPDATE registrations SET outcome = ?, note = ?, season_id = COALESCE(?, season_id) WHERE id = ?').run(res.outcome, res.note, res.seasonId ?? null, regId)
  changed()
  return res
}

export function storeRegistration(source: 'webhook' | 'csv' | 'manual', raw: string, payload: unknown, verified: boolean,
  signature: string | null = null, batched = false): { id: number; duplicate: boolean } {
  const x = extract(payload)
  if (x.eventId) {
    const dup = db.prepare('SELECT id FROM registrations WHERE event_id = ?').get(`${source}:${x.eventId}`) as { id: number } | undefined
    if (dup) return { id: dup.id, duplicate: true }
  }
  const id = Number(db.prepare('INSERT INTO registrations (source, event_id, verified, raw, signature, batched) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source, x.eventId ? `${source}:${x.eventId}` : null, verified ? 1 : 0, raw, signature, batched ? 1 : 0).lastInsertRowid)
  return { id, duplicate: false }
}

/** Admin resolves an inbox item: attach it to a known kid and/or a chosen division (which pins them there). */
export function placeRegistration(regId: number, opts: { kidId?: string | null; divisionId?: string | null }, actor: string): Result {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as RegRow | undefined
  if (!r) throw new Error('no such registration')
  const x = extract(JSON.parse(r.raw))
  const s = seasonFor(x) ?? currentSeason()
  if (!s) throw new Error('no season set up yet')
  const k = opts.kidId ? kid(opts.kidId) : undefined
  if (opts.kidId && !k) throw new Error('unknown kid')
  const target = opts.divisionId ? division(opts.divisionId) : divisionForProgram(s.id, x.program)
  if (opts.divisionId && target?.season_id !== s.id) throw new Error('unknown division')
  if (!target && !(k && db.prepare('SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ?').get(s.id, k.id))) throw new Error('pick a division for this kid')
  const res = db.transaction(() => apply(regId, s, k, { ...x, cancelled: false }, target, actor, !!opts.divisionId))()
  res.note += ` (placed by ${actor})`
  audit(actor, 'registration_placed', s.id, res.kidId ?? null, { registration: regId, division: target?.name ?? null })
  db.prepare('UPDATE registrations SET outcome = ?, note = ? WHERE id = ?').run(res.outcome, res.note, regId)
  refreshPools(s.id)
  changed()
  return res
}

export function ignoreRegistration(regId: number, actor: string) {
  db.prepare(`UPDATE registrations SET outcome = 'ignored', note = ? WHERE id = ?`).run(`ignored by ${actor}`, regId)
  changed()
}

/** SportsEngine registration report export (CSV). Each row runs through the same placement as a webhook. */
export function importRegistrationCsv(text: string, actor: string) {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('Expected a header row and at least one registration')
  const header = rows[0]!.map((h) => h.trim())
  const tally: Record<string, number> = {}
  for (const row of rows.slice(1)) {
    const obj = { participant: Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])) }
    const { id } = storeRegistration('csv', JSON.stringify(obj), obj, true)
    const res = processRegistration(id, actor)
    tally[res.outcome] = (tally[res.outcome] ?? 0) + 1
  }
  audit(actor, 'registrations_imported', currentSeason()?.id ?? null, null, tally)
  return tally
}

export { enrollment, season }
