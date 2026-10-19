import { createHmac, timingSafeEqual } from 'node:crypto'
import { normDate } from './text.js'

// Reading a SportsEngine registration payload.
//
// SportsEngine's webhook schema isn't confirmed yet, so extract() is
// deliberately tolerant: it walks the payload for the usual spellings of
// participant name, birthdate, ids, season and program. Every delivery is
// stored raw first, so once real payloads arrive the mapping can be tightened
// and the inbox replayed.

export interface Extracted {
  eventId: string | null
  eventType: string | null
  firstName: string | null
  lastName: string | null
  birthdate: string | null
  regYear: number | null
  program: string | null
  seProfileId: string | null
  seRegistrationId: string | null
  cancelled: boolean
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

const FIRST = ['firstname', 'first', 'givenname', 'participantfirstname', 'playerfirstname', 'athletefirstname']
const LAST = ['lastname', 'last', 'familyname', 'surname', 'participantlastname', 'playerlastname', 'athletelastname']
const FULL = ['fullname', 'name', 'participantname', 'playername', 'athletename']
const DOB = ['dateofbirth', 'dob', 'birthdate', 'birthday', 'birthdt', 'participantdob', 'playerdob']
const PROFILE = ['profileid', 'personid', 'participantid', 'athleteid', 'playerid', 'personaid', 'userid']
const REGID = ['registrationresultid', 'registrationid', 'resultid', 'submissionid', 'orderid']
const YEAR = ['season', 'seasonname', 'registrationyear', 'year', 'seasonyear']
// Most specific first: a "division" answer beats the registration form's title.
const PROGRAM = ['division', 'divisionname', 'program', 'programname', 'offering', 'offeringname', 'level', 'league', 'agegroup',
  'productname', 'itemname', 'registrationname', 'formname', 'surveyname', 'title']
const LABEL = ['registrationname', 'formname', 'programname', 'surveyname', 'title', 'name', 'season', 'seasonname']
const PERSON_KEYS = ['participant', 'player', 'athlete', 'registrant', 'profile', 'person', 'child', 'member']

function walk(o: unknown, fn: (k: string, v: unknown, path: string[]) => void, path: string[] = [], depth = 0) {
  if (depth > 8) return
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, [...path, String(i)], depth + 1))
  else if (isObj(o)) for (const [k, v] of Object.entries(o)) { fn(k, v, path); walk(v, fn, [...path, k], depth + 1) }
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return null
}

/** First value under any of `keys`. Person fields prefer participant-like paths; others (program) prefer the rest. */
function find(payload: unknown, keys: string[], prefer: 'person' | 'other' = 'person'): string | null {
  let best: { v: string; score: number } | null = null
  walk(payload, (k, v, path) => {
    const s = scalar(v)
    if (!s) return
    const i = keys.indexOf(norm(k))
    if (i < 0) return
    const inPerson = path.some((p) => PERSON_KEYS.includes(norm(p)))
    const person = prefer === 'person' ? (inPerson ? 0 : 100) : (inPerson ? 100 : 0)
    const guardian = path.some((p) => /guardian|parent|contact|billing|purchaser|account/.test(norm(p))) ? 1000 : 0
    const score = guardian + person + i * 2 + path.length
    if (!best || score < best.score) best = { v: s, score }
  })
  return (best as { v: string } | null)?.v ?? null
}

export function extract(payload: unknown): Extracted {
  let firstName = find(payload, FIRST)
  let lastName = find(payload, LAST)
  if (!firstName || !lastName) {
    const full = find(payload, FULL)
    if (full && /\s/.test(full)) {
      const parts = full.split(/\s+/)
      firstName ??= parts.slice(0, -1).join(' ')
      lastName ??= parts.at(-1)!
    }
  }
  let regYear: number | null = null
  const y = find(payload, YEAR)
  if (y && /^(20\d\d)$/.test(y)) regYear = +y
  if (!regYear) {
    for (const k of [...YEAR, ...LABEL]) {
      const m = /\b(20\d\d)\b/.exec(find(payload, [k], 'other') ?? '')
      if (m) { regYear = +m[1]!; break }
    }
  }
  const eventType = find(payload, ['type', 'event', 'eventtype', 'topic', 'action'], 'other')
  return {
    eventId: isObj(payload) ? scalar(payload.id) ?? scalar(payload.event_id) ?? scalar(payload.eventId) ?? null : null,
    eventType,
    firstName, lastName,
    birthdate: normDate(find(payload, DOB)),
    regYear,
    program: find(payload, PROGRAM, 'other'),
    seProfileId: find(payload, PROFILE),
    seRegistrationId: find(payload, REGID),
    cancelled: /cancel|withdraw|refund|delete|void/i.test(eventType ?? ''),
  }
}

export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false
  const given = header.replace(/^sha256=/i, '').trim()
  const hex = createHmac('sha256', secret).update(raw).digest('hex')
  const b64 = Buffer.from(hex, 'hex').toString('base64')
  for (const want of [hex, b64]) {
    const a = Buffer.from(given), b = Buffer.from(want)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

