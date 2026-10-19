import { db } from '../db.js'
import { ageIn, divisions, HOLDS_SEAT, mustSeason, seasons, type Season } from './league.js'

// How many kids of each league age play each season, and what each division is
// made of: for Rookie, how many are 7s moving up from T-Ball and how many are 8s
// coming back. A finished season counts the kids who played; a season still
// being planned counts every kid holding a seat (registered or expected back).

interface Row { kid_id: string; status: string; age: number | null; birthdate: string | null; division_id: string | null; group_key: string | null; division: string | null }

const counted = (s: Season, status: string) => (s.status === 'complete' ? status === 'Registered' : (HOLDS_SEAT as readonly string[]).includes(status))

function rows(s: Season): Row[] {
  return db.prepare(`SELECT p.kid_id, p.status, p.age, k.birthdate, p.eff_division_id division_id, d.group_key, d.name division
    FROM placements p JOIN kids k ON k.id = p.kid_id LEFT JOIN divisions d ON d.id = p.eff_division_id WHERE p.season_id = ?`).all(s.id) as Row[]
}

export function ageBreakdown(seasonId: string) {
  const s = mustSeason(seasonId)
  // This season and up to three before it, oldest first.
  const all = seasons().filter((x) => x.year <= s.year).slice(-4)
  const byAge = all.map((x) => {
    const n = new Map<number | null, number>()
    for (const r of rows(x)) if (counted(x, r.status)) { const a = ageIn(x, r.birthdate, r.age); n.set(a, (n.get(a) ?? 0) + 1) }
    return {
      id: x.id, year: x.year, kind: x.status === 'complete' ? 'played' : 'projected',
      ages: [...n].filter(([a]) => a != null).map(([age, count]) => ({ age: age!, count })).sort((a, b) => a.age - b.age),
      unknown: n.get(null) ?? 0,
    }
  })

  // What each seat unit (a division, or the Majors + Minors group) is made of, by age and by where the kids played last season.
  const prev = all.at(-2)
  const before = new Map(prev ? rows(prev).filter((r) => counted(prev, r.status)).map((r) => [r.kid_id, r.division]) : [])
  const ds = divisions(s.id)
  const units: { key: string; name: string; divisionIds: string[]; capacity: number; min_age: number | null; max_age: number | null }[] = []
  for (const d of ds) {
    const k = d.group_key ? `g:${d.group_key}` : d.id
    const u = units.find((x) => x.key === k)
    if (u) { u.name += ` + ${d.name}`; u.divisionIds.push(d.id); u.capacity += d.teams * d.roster_size; continue }
    units.push({ key: k, name: d.name, divisionIds: [d.id], capacity: d.teams * d.roster_size, min_age: d.min_age, max_age: d.max_age })
  }
  const mine = rows(s).filter((r) => counted(s, r.status))
  const composition = units.map((u) => {
    const kids = mine.filter((r) => r.division_id && u.divisionIds.includes(r.division_id))
    const groups = new Map<number | null, Map<string, number>>()
    for (const r of kids) {
      const a = ageIn(s, r.birthdate, r.age)
      const from = !prev ? '' : before.get(r.kid_id) ?? 'new'
      const m = groups.get(a) ?? new Map<string, number>()
      m.set(from, (m.get(from) ?? 0) + 1)
      groups.set(a, m)
    }
    return {
      name: u.name, capacity: u.capacity, min_age: u.min_age, max_age: u.max_age, total: kids.length,
      ages: [...groups].sort(([a], [b]) => (a ?? 99) - (b ?? 99)).map(([age, m]) => ({
        age, count: [...m.values()].reduce((x, y) => x + y, 0),
        // Biggest source first; '' when there's no earlier season to compare with, 'new' for kids who didn't play last season.
        from: [...m].map(([division, count]) => ({ division, count })).sort((a, b) => b.count - a.count),
      })),
    }
  })
  return { season: { id: s.id, year: s.year, kind: s.status === 'complete' ? 'played' : 'projected' }, prevYear: prev?.year ?? null, byAge, composition }
}
