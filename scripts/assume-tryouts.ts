// One-off (2026-10-19): until families register and answer, assume every Minors returner and
// rising 9 is trying out for Majors. New seasons get this from the rollover.
//   pnpm tsx scripts/assume-tryouts.ts <season>
import { db } from '../src/db.js'
import { canTryOut, division, setTryout } from '../src/lib/league.js'

const season = process.argv[2]
if (!season) { console.error('usage: tsx scripts/assume-tryouts.ts <season>'); process.exit(1) }
const rows = db.prepare(`SELECT e.id, e.division_id, e.team_id, e.returning_team_id FROM enrollments e
  WHERE e.season_id = ? AND e.tryout = 0 AND e.status NOT IN ('Registered', 'Not returning', 'Withdrawn', 'Waitlist')
  AND NOT EXISTS (SELECT 1 FROM picks p WHERE p.enrollment_id = e.id)`).all(season) as { id: string; division_id: string | null; team_id: string | null; returning_team_id: string | null }[]
let minors = 0, nines = 0
db.transaction(() => {
  for (const e of rows) {
    const d = e.division_id ? division(e.division_id) : undefined
    if (!d || !canTryOut(d)) continue
    if (d.group_key && !e.returning_team_id) continue // only returners holding a team
    setTryout(e.id, true, 'assumed until they register')
    if (d.group_key) minors++; else nines++
  }
})()
console.log(`Assumed trying out: ${minors} Minors returners, ${nines} rising 9s`)
process.exit(0) // the app modules keep the event loop alive
