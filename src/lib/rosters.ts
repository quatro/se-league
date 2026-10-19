import { db } from '../db.js'
import {
  audit, changed, createKid, divisions, divisionTeams, mustSeason, refreshPools, saveTeam, UserError, type Division, type Kid,
} from './league.js'
import { carryForward } from './rollover.js'
import { nameKey, normDate, parseCsv, uid } from './text.js'

// Pasting a season's rosters (from a spreadsheet or CSV, header row required):
//   Name (or First + Last), Birthdate or Age, Division, Team
// Kids are matched to existing records by name (and birthdate when both have
// one) so the same child keeps one history; anyone new gets a record. Teams
// are created on the fly. For a finished season the kids are recorded as
// having played, and if the next season already exists they carry into it
// as returners, exactly as a rollover would have done.

const H = {
  name: ['name', 'player', 'playername', 'participant', 'participantname', 'athlete', 'fullname', 'kid'],
  first: ['first', 'firstname', 'playerfirstname', 'participantfirstname'],
  last: ['last', 'lastname', 'playerlastname', 'participantlastname'],
  dob: ['dob', 'birthdate', 'dateofbirth', 'birthday'],
  age: ['age', 'leagueage'],
  division: ['division', 'league', 'program', 'level'],
  team: ['team', 'teamname'],
}
const hk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export interface RosterResult { added: number; updated: number; newKids: number; teamsCreated: number; skipped: string[]; carried: number }

export function importRosters(seasonId: string, text: string, actor: string, defaultDivisionId: string | null = null): RosterResult {
  const s = mustSeason(seasonId)
  const rows = parseCsv(text)
  if (rows.length < 2) throw new UserError('Paste a header row (e.g. Name, Birthdate, Division, Team) and at least one kid')
  const head = rows[0]!.map(hk)
  const col = (keys: string[]) => head.findIndex((h) => keys.includes(h))
  const c = { name: col(H.name), first: col(H.first), last: col(H.last), dob: col(H.dob), age: col(H.age), division: col(H.division), team: col(H.team) }
  if (c.name < 0 && (c.first < 0 || c.last < 0)) throw new UserError('Need a Name column, or First and Last name columns')
  const divs = divisions(seasonId)
  const byName = (v: string): Division | undefined => {
    const k = nameKey(v)
    return divs.find((d) => nameKey(d.name) === k || d.key === k.replace(/ /g, '')) ?? divs.find((d) => (d.se_match || d.name).split(',').some((w) => nameKey(w) && ` ${k} `.includes(` ${nameKey(w)} `)))
  }
  const played = s.status === 'complete'
  const res: RosterResult = { added: 0, updated: 0, newKids: 0, teamsCreated: 0, skipped: [], carried: 0 }
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
      const name = (c.name >= 0 ? get(c.name) : `${get(c.first)} ${get(c.last)}`).replace(/\s+/g, ' ').trim()
      if (!name) continue
      const dob = normDate(get(c.dob))
      const age = parseInt(get(c.age), 10) || null
      const div = (get(c.division) && byName(get(c.division))) || divs.find((d) => d.id === defaultDivisionId)
      if (!div) { res.skipped.push(`${name}: no division "${get(c.division)}" in ${s.year}`); continue }
      let teamId: string | null = null
      const teamName = get(c.team)
      if (teamName) {
        teamId = divisionTeams(div.id).find((t) => nameKey(t.name) === nameKey(teamName))?.id ?? null
        if (!teamId) { teamId = saveTeam(div.id, null, { name: teamName }, actor).id; res.teamsCreated++ }
      }
      let cands = db.prepare('SELECT * FROM kids WHERE name_key = ?').all(nameKey(name)) as Kid[]
      if (dob) cands = cands.filter((k) => !k.birthdate || k.birthdate === dob)
      if (cands.length > 1) { res.skipped.push(`${name}: more than one kid with that name — add them by hand`); continue }
      let kid = cands[0]
      if (!kid) { kid = createKid(name, dob); res.newKids++ } else if (dob && !kid.birthdate) db.prepare('UPDATE kids SET birthdate = ? WHERE id = ?').run(dob, kid.id)
      const e = db.prepare('SELECT id FROM enrollments WHERE season_id = ? AND kid_id = ?').get(seasonId, kid.id) as { id: string } | undefined
      if (e) {
        db.prepare(`UPDATE enrollments SET division_id = ?, team_id = ?, returning_team_id = ?, age = COALESCE(?, age), updated_at = datetime('now') WHERE id = ?`)
          .run(div.id, teamId, teamId, age, e.id)
        res.updated++
      } else {
        db.prepare(`INSERT INTO enrollments (id, season_id, kid_id, division_id, team_id, returning_team_id, age, returner, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid(), seasonId, kid.id, div.id, teamId, teamId, age, played ? 0 : 1, played ? 'Registered' : 'Expected')
        res.added++
      }
    }
  })()
  audit(actor, 'rosters_imported', seasonId, null, { ...res, skipped: res.skipped.length })
  refreshPools(seasonId)
  if (played) res.carried = carryForward(seasonId, actor)
  changed()
  return res
}
