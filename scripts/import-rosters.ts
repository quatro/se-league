// Paste a season's rosters from a CSV file, the same as Divisions & Teams → Paste rosters.
//   tsx scripts/import-rosters.ts <season> <file.csv>
import { readFileSync } from 'node:fs'
import { importRosters } from '../src/lib/rosters.js'

const [seasonId, file] = process.argv.slice(2)
if (!seasonId || !file) { console.error('usage: tsx scripts/import-rosters.ts <season> <file.csv>'); process.exit(1) }
console.log(JSON.stringify(importRosters(seasonId, readFileSync(file, 'utf8'), 'roster-import'), null, 2))
