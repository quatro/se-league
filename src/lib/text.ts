// Returners start Expected; anyone Registered, Expected or Need to contact holds a seat.
export const STATUSES = ['Registered', 'Expected', 'Need to contact', 'Waitlist', 'Not returning', 'Withdrawn'] as const
export type Status = (typeof STATUSES)[number]
export const HOLDS_SEAT: readonly Status[] = ['Registered', 'Expected', 'Need to contact']

/** Normalised name used to match SportsEngine registrations to players. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function slug(s: string): string {
  return nameKey(s).replace(/ /g, '') || 'team'
}

export function uid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** League age: the player's age on {cutoff MM-DD} of the season year. */
export function leagueAge(birthdate: string, seasonYear: number, cutoff = '04-30'): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate)
  if (!m) return null
  const [cm, cd] = cutoff.split('-').map(Number) as [number, number]
  const by = +m[1]!, bm = +m[2]!, bd = +m[3]!
  let age = seasonYear - by
  if (bm > cm || (bm === cm && bd > cd)) age--
  return age
}

/** Accepts YYYY-MM-DD, M/D/YYYY, or an ISO timestamp; returns YYYY-MM-DD or null. */
export function normDate(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  return null
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas/newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++ }
      else if (c === '"') q = false
      else f += c
    } else if (c === '"') q = true
    else if (c === ',' || c === '\t') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(f); f = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else f += c
  }
  row.push(f)
  if (row.some((x) => x.trim())) rows.push(row)
  return rows
}
