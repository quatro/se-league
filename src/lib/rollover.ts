import { db } from '../db.js'
import {
  ageIn, audit, changed, divisionForAge, divisions, divisionTeams, drafts, isDraftOnly, mustSeason, placements, refreshPools,
  season, setSetting, UserError, type Division, type Placement, type Season, type Team,
} from './league.js'
import { uid } from './text.js'

// Rolling a finished season into the next one.
//
// The new season starts as a copy of the old one's setup: the same divisions
// (team counts, roster sizes, ages, SportsEngine words), the same teams in the
// same draft order, and the same draft rooms. Then every kid who played gets
// an "Expected" spot in the new season:
//
//   - still young enough for a keep-teams division (Majors, Minors, Rookie, T-Ball):
//     back on the same team as a returner
//   - otherwise: the division their new league age fits, with no team, so they
//     go into that division's draft (T-Ball → Rookie, 9s → Majors/Minors pool)
//   - too old for every division: graduated, not carried forward
//   - a division that doesn't keep teams (Wee Ball) is a one-year stop: nobody
//     repeats it. A Wee Baller still young enough for it moves up to the next
//     division (T-Ball as a 4-year-old) as "Need to contact" — most of these
//     families drop out, so the seat is flagged as at risk rather than counted on.
//
// Kids who registered but never played (Not returning, Withdrawn) aren't
// carried forward; they come back through registration like anyone new.

export interface RolloverPlan {
  from: string; to: string
  returning: number; movingUp: number; graduating: number; skipped: number
  byDivision: Record<string, { returning: number; new: number }>
}

const PLAYED = ['Registered', 'Expected', 'Need to contact']

/** Where a kid who played in `cur` goes next season, and whether they're moving up early (a Wee Baller who is still Wee Ball age). */
export function nextDivision(cur: Division, divs: Division[], age: number | null, onTeam: boolean): { target: Division | undefined; stays: boolean; early: boolean } {
  const fits = (d: Division) => (d.min_age == null || age == null || age >= d.min_age) && (d.max_age == null || age == null || age <= d.max_age)
  if (cur.keep_teams && onTeam && fits(cur)) return { target: cur, stays: true, early: false }
  const target = divisionForAge(divs.filter((d) => !isDraftOnly(d) || d.id === cur.id), age, cur.key)
  if (cur.keep_teams || (target && target.id !== cur.id)) return { target, stays: false, early: false }
  // Still fits a division that doesn't keep teams (or their age is unknown): no repeat year, up to the next division.
  const up = divs.filter((d) => !isDraftOnly(d) && d.id !== cur.id && (d.min_age ?? 0) > (cur.min_age ?? 0)).sort((a, b) => (a.min_age ?? 0) - (b.min_age ?? 0))[0]
  return up ? { target: up, stays: false, early: true } : { target, stays: false, early: false }
}

function plan(from: Season, toYear: number) {
  const fromDivs = divisions(from.id)
  const toSeason: Season = { ...from, id: String(toYear), year: toYear }
  const kids = new Map((db.prepare('SELECT id, birthdate FROM kids').all() as { id: string; birthdate: string | null }[]).map((k) => [k.id, k.birthdate]))
  const rows: { p: Placement; target: Division | undefined; keepTeam: string | null; age: number | null; early: boolean }[] = []
  let skipped = 0
  for (const p of placements(from.id)) {
    if (!PLAYED.includes(p.status) || !p.eff_division_id) { skipped++; continue }
    const cur = fromDivs.find((d) => d.id === p.eff_division_id)!
    const birthdate = kids.get(p.kid_id) ?? null
    const ageNow = ageIn(from, birthdate, p.age)
    const age = birthdate ? ageIn(toSeason, birthdate, null) : ageNow != null ? ageNow + 1 : null
    const { target, stays, early } = nextDivision(cur, fromDivs, age, !!p.eff_team_id)
    rows.push({ p, target, keepTeam: stays ? p.eff_team_id : null, age, early })
  }
  return { rows, skipped }
}

export function previewRollover(fromId: string): RolloverPlan {
  const from = mustSeason(fromId)
  const { rows, skipped } = plan(from, from.year + 1)
  const out: RolloverPlan = { from: from.id, to: String(from.year + 1), returning: 0, movingUp: 0, graduating: 0, skipped, byDivision: {} }
  for (const r of rows) {
    if (!r.target) { out.graduating++; continue }
    const b = (out.byDivision[r.target.name] ??= { returning: 0, new: 0 })
    if (r.keepTeam) { out.returning++; b.returning++ } else { out.movingUp++; b.new++ }
  }
  return out
}

/** Create next season from this one. The old season is marked complete. */
export function rollover(fromId: string, actor: string): RolloverPlan {
  const from = mustSeason(fromId)
  const toId = String(from.year + 1)
  if (season(toId)) throw new UserError(`The ${toId} season already exists`)
  const summary = previewRollover(fromId)
  const { rows } = plan(from, from.year + 1)
  if (!divisions(from.id).length) throw new UserError(`${from.year} has no divisions to carry forward`)
  db.transaction(() => {
    db.prepare(`INSERT INTO seasons (id, year, status, age_cutoff, warn_at, rolled_from) VALUES (?, ?, 'planning', ?, ?, ?)`)
      .run(toId, from.year + 1, from.age_cutoff, from.warn_at, from.id)
    const divMap = new Map<string, string>(), teamMap = new Map<string, string>(), draftMap = new Map<string, string>()
    for (const d of divisions(from.id)) {
      const nid = `${toId}-${d.key}`
      divMap.set(d.id, nid)
      db.prepare(`INSERT INTO divisions (id, season_id, key, name, sort, teams, roster_size, coaches, min_age, max_age, se_match, group_key, keep_teams, closed, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(nid, toId, d.key, d.name, d.sort, d.teams, d.roster_size, d.coaches, d.min_age, d.max_age,
        d.se_match, d.group_key, d.keep_teams, d.notes)
      for (const t of divisionTeams(d.id)) {
        const tid = uid()
        teamMap.set(t.id, tid)
        db.prepare('INSERT INTO teams (id, season_id, division_id, name, color, fg, draft_order, coach) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(tid, toId, nid, t.name, t.color, t.fg, t.draft_order, t.coach)
      }
    }
    const oldDrafts = drafts(from.id)
    for (const r of oldDrafts) draftMap.set(r.id, `${toId}-${r.key}`)
    for (const r of oldDrafts) {
      db.prepare('INSERT INTO drafts (id, season_id, division_id, key, format, mode, swap, next_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(draftMap.get(r.id), toId, divMap.get(r.division_id), r.key, r.format, r.mode, r.swap)
    }
    for (const r of oldDrafts) if (r.next_id) db.prepare('UPDATE drafts SET next_id = ? WHERE id = ?').run(draftMap.get(r.next_id) ?? null, draftMap.get(r.id))
    carry(from, toId, rows)
    db.prepare(`UPDATE seasons SET status = 'complete' WHERE id = ?`).run(from.id)
    setSetting('currentSeason', toId)
  })()
  refreshPools(toId)
  audit(actor, 'season_rolled_over', toId, null, summary)
  changed()
  return summary
}

/** Give each planned kid an Expected spot next season, matching divisions by key and teams by name. Kids already there are left alone. */
function carry(from: Season, toId: string, rows: ReturnType<typeof plan>['rows']): number {
  const toDivs = divisions(toId)
  const toTeams = db.prepare('SELECT id, division_id, name FROM teams WHERE season_id = ?').all(toId) as { id: string; division_id: string; name: string }[]
  const fromNames = new Map(divisions(from.id).map((d) => [d.id, d.name]))
  const fromTeams = new Map((db.prepare('SELECT * FROM teams WHERE season_id = ?').all(from.id) as Team[]).map((t) => [t.id, t]))
  const teamNames = new Map([...fromTeams].map(([id, t]) => [id, t.name]))
  const there = new Set((db.prepare('SELECT kid_id FROM enrollments WHERE season_id = ?').all(toId) as { kid_id: string }[]).map((r) => r.kid_id))
  const ins = db.prepare(`INSERT INTO enrollments (id, season_id, kid_id, division_id, team_id, returning_team_id, age, returner, status, prior, tryout, division_locked, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
  // A returner's team that the next season doesn't have yet (rosters pasted after the rollover) is created there.
  const teamFor = (divId: string, old: Team) => {
    const found = toTeams.find((t) => t.division_id === divId && t.name === old.name)
    if (found) return found.id
    const id = uid()
    const max = (db.prepare('SELECT COALESCE(MAX(draft_order), 0) m FROM teams WHERE division_id = ?').get(divId) as { m: number }).m
    db.prepare('INSERT INTO teams (id, season_id, division_id, name, color, fg, draft_order, coach) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, toId, divId, old.name, old.color, old.fg, max + 1, old.coach)
    toTeams.push({ id, division_id: divId, name: old.name })
    return id
  }
  let n = 0
  for (const r of rows) {
    if (!r.target || there.has(r.p.kid_id)) continue
    const div = toDivs.find((d) => d.key === r.target!.key)
    if (!div) continue
    const oldTeam = r.keepTeam ? fromTeams.get(r.keepTeam) : undefined
    const tid = oldTeam ? teamFor(div.id, oldTeam) : null
    const prior = [fromNames.get(r.p.eff_division_id!), r.p.eff_team_id ? teamNames.get(r.p.eff_team_id) : null].filter(Boolean).join(' · ') + ` (${from.year})`
    // Kids arriving in a shared group without a team (9s turning 10) go through its drafts from the top, like new registrants.
    // Moved up early (Wee Ball → T-Ball at 4): pinned so it reads as an exception, and at risk because most don't come back.
    ins.run(uid(), toId, r.p.kid_id, div.id, tid, tid, r.age, r.early ? 'Need to contact' : 'Expected', prior, !tid && div.group_key ? 1 : 0, r.early ? 1 : 0,
      r.early ? `Played ${fromNames.get(r.p.eff_division_id!)} in ${from.year}; no repeat year, so moved up to ${div.name}. Likely to drop out — confirm with the family.` : '')
    n++
  }
  return n
}

/**
 * Carry kids added to a finished season after it was rolled over (e.g. last
 * year's Minors rosters entered late) into the season that follows it.
 */
export function carryForward(fromId: string, actor: string): number {
  const from = mustSeason(fromId)
  const next = db.prepare('SELECT * FROM seasons WHERE rolled_from = ?').get(fromId) as Season | undefined
  if (!next) return 0
  const n = db.transaction(() => carry(from, next.id, plan(from, next.year).rows))()
  if (n) { refreshPools(next.id); audit(actor, 'carried_forward', next.id, null, { from: from.id, kids: n }); changed() }
  return n
}
