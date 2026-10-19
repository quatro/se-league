import { db } from '../db.js'
import { audit, changed, UserError, type Kid } from './league.js'
import { nameKey, normDate, parseCsv, uid } from './text.js'

// Parents and guardians, per kid. One kid can have several (mom and dad), and
// one email can cover several kids (siblings) — outreach groups by email.

export interface Contact { id: string; kid_id: string; name: string; email: string; phone: string; relation: string; source: 'import' | 'registration' | 'manual'; created_at: string }
export interface ContactInput { name?: string; email?: string; phone?: string; relation?: string }

export const normEmail = (s: string | undefined) => (s ?? '').trim().toLowerCase()
const emailOk = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
const digits = (s: string) => s.replace(/\D/g, '')

export const contactsFor = (kidId: string) =>
  db.prepare('SELECT * FROM contacts WHERE kid_id = ? ORDER BY created_at, rowid').all(kidId) as Contact[]

/** Add a contact, or fill in what an existing one (same kid + email, or same kid + phone) is missing. Returns 'added' | 'updated' | 'same'. */
export function addContact(kidId: string, p: ContactInput, source: Contact['source']): 'added' | 'updated' | 'same' {
  const email = normEmail(p.email), phone = (p.phone ?? '').trim(), name = (p.name ?? '').replace(/\s+/g, ' ').trim(), relation = (p.relation ?? '').trim()
  if (email && !emailOk(email)) throw new UserError(`“${p.email}” isn't an email address`)
  if (!email && !digits(phone)) throw new UserError('A contact needs an email or a phone number')
  const cur = (email
    ? db.prepare('SELECT * FROM contacts WHERE kid_id = ? AND email = ?').get(kidId, email)
    : (db.prepare(`SELECT * FROM contacts WHERE kid_id = ? AND email = ''`).all(kidId) as Contact[]).find((c) => digits(c.phone) === digits(phone))) as Contact | undefined
  if (!cur) {
    db.prepare('INSERT INTO contacts (id, kid_id, name, email, phone, relation, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid(), kidId, name, email, phone, relation, source)
    return 'added'
  }
  const next = { name: cur.name || name, phone: cur.phone || phone, relation: cur.relation || relation }
  if (next.name === cur.name && next.phone === cur.phone && next.relation === cur.relation) return 'same'
  db.prepare('UPDATE contacts SET name = ?, phone = ?, relation = ? WHERE id = ?').run(next.name, next.phone, next.relation, cur.id)
  return 'updated'
}

export function saveContact(kidId: string, p: ContactInput, actor: string) {
  if (!db.prepare('SELECT 1 FROM kids WHERE id = ?').get(kidId)) throw new UserError('Unknown kid')
  const r = addContact(kidId, p, 'manual')
  audit(actor, 'contact_saved', null, kidId, { name: p.name, email: normEmail(p.email) })
  changed()
  return r
}

export function deleteContact(id: string, actor: string) {
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Contact | undefined
  if (!c) throw new UserError('Unknown contact')
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id)
  audit(actor, 'contact_removed', null, c.kid_id, { name: c.name, email: c.email })
  changed()
}

// ---------- pasting a contact list ----------
//
// One row per player, any number of parents per row. Player columns: Name (or
// First + Last), optional Birthdate. Parent columns are recognized by prefix —
// "Parent 1 Email", "Guardian Name", "Mother Phone", "Parent/Guardian 2 First
// Name", "Primary Contact Email" — and a bare "Email" / "Phone" belongs to the
// first parent. "Parent", "Guardian" and "Parent/Guardian" with no number are
// all that first parent, and "Phone Number 2" is their second phone (the
// SportsEngine parent export lays it out that way).

const hk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const PLAYER = {
  name: ['name', 'player', 'playername', 'playerfullname', 'participant', 'participantname', 'athlete', 'athletename', 'fullname', 'kid', 'child', 'childname'],
  first: ['first', 'firstname', 'playerfirstname', 'participantfirstname', 'athletefirstname', 'childfirstname'],
  last: ['last', 'lastname', 'playerlastname', 'participantlastname', 'athletelastname', 'childlastname'],
  dob: ['dob', 'birthdate', 'dateofbirth', 'birthday', 'playerdob', 'playerbirthdate', 'participantdateofbirth', 'playerdateofbirth'],
}
const PARENT = /^(parentguardian|parent|guardian|primarycontact|secondarycontact|contact|mother|father|mom|dad|primary|secondary)?(\d?)(firstname|first|lastname|last|fullname|name|emailaddress|email|phonenumber|cellphone|phone|cell|mobile|relationship|relation)\d?$/
const FIELD: Record<string, 'first' | 'last' | 'name' | 'email' | 'phone' | 'relation'> = {
  first: 'first', firstname: 'first', last: 'last', lastname: 'last', name: 'name', fullname: 'name', email: 'email', emailaddress: 'email',
  phone: 'phone', phonenumber: 'phone', cell: 'phone', cellphone: 'phone', mobile: 'phone', relation: 'relation', relationship: 'relation',
}
const RELATION: Record<string, string> = { mother: 'Mother', mom: 'Mother', father: 'Father', dad: 'Father' }

export interface ContactImport { rows: number; added: number; updated: number; kids: number; unmatched: string[]; ambiguous: string[]; noContact: string[] }

export function importContacts(text: string, actor: string): ContactImport {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new UserError('Paste a header row (e.g. Player Name, Birthdate, Parent Name, Parent Email, Parent Phone) and at least one row')
  const head = rows[0]!.map(hk)
  const find = (keys: string[]) => head.findIndex((h) => keys.includes(h))
  const pc = { name: find(PLAYER.name), first: find(PLAYER.first), last: find(PLAYER.last), dob: find(PLAYER.dob) }
  if (pc.name < 0 && (pc.first < 0 || pc.last < 0)) throw new UserError('Need a player Name column, or player First and Last name columns')
  const used = new Set(Object.values(pc).filter((i) => i >= 0))
  // Group the remaining columns into parents: "parent1", "mother", "" (bare Email/Phone)...
  const parents = new Map<string, Partial<Record<'first' | 'last' | 'name' | 'email' | 'phone' | 'relation', number[]>> & { relation0?: string }>()
  head.forEach((h, i) => {
    if (used.has(i)) return
    const m = PARENT.exec(h)
    if (!m) return
    const [, prefix = '', n = '', f] = m
    const field = FIELD[f!]!
    if (!prefix && (field === 'first' || field === 'last' || field === 'name')) return // a bare name is the player's
    // "Email", "Parent Email" and "Parent 1 Email" are all the first parent.
    const key = `${RELATION[prefix] ?? 'p'}${n || (prefix.startsWith('secondary') ? '2' : '1')}`
    const g = parents.get(key) ?? { relation0: RELATION[prefix] }
    ;(g[field] ??= []).push(i)
    parents.set(key, g)
  })
  if (![...parents.values()].some((g) => g.email !== undefined || g.phone !== undefined)) throw new UserError('Need at least one parent Email or Phone column')

  const res: ContactImport = { rows: 0, added: 0, updated: 0, kids: 0, unmatched: [], ambiguous: [], noContact: [] }
  const latest = db.prepare(`SELECT e.kid_id FROM enrollments e JOIN seasons s ON s.id = e.season_id WHERE e.kid_id = ? ORDER BY s.year DESC LIMIT 1`)
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
      // A parent field can have several columns (Phone Number 1, Phone Number 2): the first one filled in.
      const get = (i: number | number[] | undefined) => (i === undefined ? '' : typeof i === 'number' ? cell(i) : i.map(cell).find(Boolean) ?? '')
      const name = (pc.name >= 0 ? get(pc.name) : `${get(pc.first)} ${get(pc.last)}`).replace(/\s+/g, ' ').trim()
      if (!name) continue
      res.rows++
      const dob = normDate(get(pc.dob))
      let cands = db.prepare('SELECT * FROM kids WHERE name_key = ?').all(nameKey(name)) as Kid[]
      if (dob) cands = cands.filter((k) => !k.birthdate || k.birthdate === dob)
      // Two kids with one name: the one who has played is the one families are writing about.
      if (cands.length > 1) { const active = cands.filter((k) => latest.get(k.id)); if (active.length === 1) cands = active }
      if (!cands.length) { res.unmatched.push(name); continue }
      if (cands.length > 1) { res.ambiguous.push(name); continue }
      const kid = cands[0]!
      let any = false
      for (const g of parents.values()) {
        const email = get(g.email), phone = get(g.phone)
        if (!email && !digits(phone)) continue
        const pname = get(g.name) || `${get(g.first)} ${get(g.last)}`.trim()
        try {
          const out = addContact(kid.id, { name: pname, email, phone, relation: get(g.relation) || g.relation0 || '' }, 'import')
          if (out === 'added') res.added++
          else if (out === 'updated') res.updated++
          any = true
        } catch (e) { if (!(e instanceof UserError)) throw e; res.unmatched.push(`${name}: ${e.message}`) }
      }
      if (any) res.kids++
      else res.noContact.push(name)
    }
  })()
  audit(actor, 'contacts_imported', null, null, { ...res, unmatched: res.unmatched.length, ambiguous: res.ambiguous.length, noContact: res.noContact.length })
  changed()
  return res
}
