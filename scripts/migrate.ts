// One-time import from the first two league tools into the league app:
//
//   pnpm migrate <draft-board.db> <registration.db>
//
// 1. Builds 2026 as a finished season: the six divisions (from the
//    registration app's setup), the eight Majors teams in draft order with
//    their colors, and the 62 kids on those teams (the draft board's returning
//    players, who all played Majors in 2026), at last year's league age.
// 2. Sets up each division's draft room: Majors → Minors (one 10–12 pool),
//    Rookie (standard, straight), T-Ball (blind numbers).
// 3. Rolls 2026 into 2027, which makes every Majors kid an expected returner
//    on the same team.
// 4. Copies this year's statuses and notes from the draft board onto 2027
//    (Not returning stays locked).
import Database from 'better-sqlite3'
import { db } from '../src/db.js'
import * as D from '../src/lib/drafts.js'
import * as L from '../src/lib/league.js'
import { rollover } from '../src/lib/rollover.js'
import { nameKey } from '../src/lib/text.js'

const [boardPath, regPath] = process.argv.slice(2)
if (!boardPath || !regPath) { console.error('usage: pnpm migrate <draft-board.db> <registration.db>'); process.exit(1) }
if (L.seasons().length) { console.error('This database already has seasons — migrate into an empty one.'); process.exit(1) }

const board = new Database(boardPath, { readonly: true })
const reg = new Database(regPath, { readonly: true })
const ACT = 'migration'
const setting = (k: string) => JSON.parse((board.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string }).value)

// League structure. Keys are stable across seasons; names and numbers come from the registration app.
const SHAPE: Record<string, { key: string; se_match?: string; group_key?: string; keep_teams?: boolean; min_age?: number; max_age?: number; draft?: 'standard' | 'blind' }> = {
  weeball: { key: 'weeball' },
  tball: { key: 'tball', draft: 'blind' },
  coachpitch: { key: 'rookie', keep_teams: true, draft: 'standard' },
  '9yearoldleague': { key: 'nine' },
  // Families register once for "Major/Minor"; it lands in the shared 10–12 pool and the drafts decide.
  minors: { key: 'minors', se_match: 'minor, minors, minor league, major, majors, major league', group_key: '10-12', keep_teams: true, min_age: 10, max_age: 12, draft: 'standard' },
  // Nobody registers into Majors directly: it fills from returners and the Majors draft.
  majors: { key: 'majors', se_match: '-', group_key: '10-12', keep_teams: true, min_age: 10, max_age: 12, draft: 'standard' },
}

const regDivs = reg.prepare('SELECT * FROM divisions ORDER BY sort').all() as { id: string; name: string; sort: number; teams: number; roster_size: number; coaches: number | null; min_age: number | null; max_age: number | null; se_match: string }[]
const boardTeams = board.prepare('SELECT * FROM teams ORDER BY draft_order').all() as { name: string; color: string; fg: string }[]
const boardKids = board.prepare(`SELECT p.*, t.name AS team_name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.kind = 'returning' ORDER BY t.draft_order, p.name`).all() as
  { name: string; age: number | null; birthdate: string | null; status: string; status_locked: number; notes: string; rank: number | null; se_profile_id: string | null; team_name: string }[]

db.prepare(`INSERT INTO seasons (id, year, status, age_cutoff, warn_at, notes) VALUES ('2026', 2026, 'complete', ?, 4, ?)`)
  .run(setting('ageCutoff'), 'Imported from the 2027 Majors draft board: only 2026 Majors rosters (kids still eligible in 2027) are recorded so far.')

const byKey: Record<string, L.Division> = {}
for (const r of regDivs) {
  const s = SHAPE[r.id]
  if (!s) throw new Error(`No shape for division ${r.id}`)
  byKey[s.key] = L.saveDivision('2026', null, {
    key: s.key, name: s.key === 'rookie' ? 'Rookie (Coach Pitch)' : r.name, teams: r.teams, roster_size: r.roster_size, coaches: r.coaches,
    min_age: s.min_age ?? r.min_age, max_age: s.max_age ?? r.max_age, se_match: s.se_match ?? r.se_match, group_key: s.group_key ?? '',
    keep_teams: !!s.keep_teams, sort: r.sort,
  }, ACT)
}

const teamIds: Record<string, string> = {}
for (const t of boardTeams) teamIds[t.name] = L.saveTeam(byKey.majors!.id, null, { name: t.name, color: t.color, fg: t.fg }, ACT).id

// The kids who played 2026 Majors, one year younger than on the 2027 board.
for (const k of boardKids) {
  const kid = L.createKid(k.name, k.birthdate, k.se_profile_id)
  db.prepare(`INSERT INTO enrollments (id, season_id, kid_id, division_id, team_id, returning_team_id, age, returner, status)
    VALUES (?, '2026', ?, ?, ?, ?, ?, 1, 'Registered')`).run(`m26-${kid.id}`, kid.id, byKey.majors!.id, teamIds[k.team_name], teamIds[k.team_name], k.age != null ? k.age - 1 : null)
}

// Draft rooms.
for (const s of Object.values(SHAPE)) if (s.draft) D.saveDraft('2026', byKey[s.key]!.id, { format: s.draft, mode: 'straight' }, ACT)
D.saveDraft('2026', byKey.majors!.id, { mode: setting('mode'), swap: setting('swap'), nextId: D.draftByKey('2026', 'minors')!.id }, ACT)
db.prepare(`UPDATE drafts SET status = 'closed', closed_at = datetime('now') WHERE season_id = '2026'`).run()

// 2026 → 2027.
const summary = rollover('2026', ACT)

// This year's statuses and notes from the draft board.
let applied = 0
for (const k of boardKids) {
  if (k.status === 'Not registered' && !k.notes && k.rank == null) continue
  const e = db.prepare(`SELECT e.id FROM enrollments e JOIN kids kd ON kd.id = e.kid_id WHERE e.season_id = '2027' AND kd.name_key = ?`).get(nameKey(k.name)) as { id: string } | undefined
  if (!e) { console.warn('not carried into 2027:', k.name); continue }
  L.updateEnrollment(e.id, {
    ...(k.status !== 'Not registered' ? { status: k.status as L.Enrollment['status'] } : {}),
    locked: !!k.status_locked || k.status === 'Not returning', notes: k.notes, rank: k.rank,
  }, ACT)
  applied++
}
L.setSetting('currentSeason', '2027')

const st = L.seasonState('2027', true) as ReturnType<typeof L.seasonState> & { kids: unknown[] }
console.log('2026 → 2027 rollover:', summary)
console.log(`Applied ${applied} statuses/notes from the draft board.`)
for (const d of st.divisions) console.log(`  ${d.name.padEnd(22)} ${String(d.teams).padStart(2)} × ${d.roster_size} = ${String(d.seats.capacity).padStart(3)} seats · held ${d.seats.held} · open ${d.seats.open}${d.draft ? ` · ${d.draft.format} draft` : ''}`)
for (const g of st.groups) console.log(`  [${g.name}] combined: ${g.seats.capacity} seats, open ${g.seats.open}`)
