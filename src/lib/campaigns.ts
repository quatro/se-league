import { db } from '../db.js'
import { config } from '../config.js'
import {
  ageIn, audit, canTryOut, changed, HOLDS_SEAT, createKid, division, divisions, enroll, fitsAge, isDraftOnly, mustSeason, refreshPools, season, seasonState, setTryout, slugOk, team,
  UserError, type Kid, type Season,
} from './league.js'
import { addContact } from './contacts.js'
import { notifyCoaches } from './coaches.js'
import { balancePaid, createPlan, firstPaymentIn, installmentsFor, payDays, payLink, planFor, saveCard, today } from './plans.js'
import { mailConfigured, sendBatch } from './mailer.js'
import { createCheckout, getCheckout, stripeConfigured, stripeMode, type LineItem } from './stripe.js'
import { leagueAge, nameKey, normDate, uid } from './text.js'
import { randomBytes } from 'node:crypto'

// Registration campaigns: our own signup page and Stripe checkout.
//
// A campaign ("2027 Spring") offers programs — usually the season's divisions,
// with Majors + Minors as one "Major/Minor" program — plus priced items charged
// per kid and extra questions, all built in admin. A family fills in the form,
// pays on Stripe's hosted page, and the moment Stripe confirms payment each
// kid becomes Registered in their division (seat counts, draft pools and kid
// history update with it). Kids whose program is full (or that an admin has
// switched to "waitlist only") go on a free waitlist, first come first served;
// an admin later offers a spot with a personal pay link that has a deadline.

export interface Campaign { id: string; slug: string; name: string; season_id: string | null; status: 'draft' | 'open' | 'closed'; opens_at: string | null; closes_at: string | null; intro: string; confirmation: string; created_at: string
  plan_installments: number; plan_final_date: string | null; plan_min_cents: number; kind: CampaignKind }
export type CampaignKind = 'spring' | 'standard'
export interface Offering { id: string; campaign_id: string; division_id: string | null; name: string; description: string; min_age: number | null; max_age: number | null; capacity: number | null; waitlist: number; sort: number; active: number; reg_mode: RegMode; when_full: WhenFull; protect_at: number | null }
export type WhenFull = 'waitlist' | 'close'
export type RegMode = 'open' | 'waitlist' | 'closed'
export interface Item { id: string; campaign_id: string; name: string; description: string; price_cents: number; required: number; max_qty: number; offering_ids: string; tag: string; sort: number; active: number }
export interface Question { id: string; campaign_id: string; scope: 'player' | 'family'; label: string; help: string; type: QType; options: string; required: number; offering_ids: string; sort: number; active: number; new_only: number }
export type QType = 'text' | 'textarea' | 'number' | 'date' | 'yesno' | 'select' | 'multi' | 'agreement'
export interface Order { id: string; campaign_id: string; status: 'pending' | 'paid' | 'waitlisted' | 'cancelled' | 'refunded'; guardian: string; answers: string; total_cents: number; stripe_session_id: string | null; stripe_payment_id: string | null; stripe_mode: string | null; created_at: string; paid_at: string | null; se_synced_at: string | null; admin_notes: string }
export interface OrderPlayer { id: string; order_id: string; first_name: string; last_name: string; birthdate: string; gender: string; offering_id: string; status: 'pending' | 'registered' | 'waitlisted' | 'offered' | 'cancelled'; answers: string; kid_id: string | null; enrollment_id: string | null; offer_session_id: string | null; prior_match: string; held_seat: number; offer_token: string | null; offer_expires_at: string | null }

const J = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T } catch { return d } }
const appliesTo = (ids: string, offeringId: string) => { const l = J<string[]>(ids, []); return !l.length || l.includes(offeringId) }

// ---------- reads ----------
export const campaigns = () => db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all() as Campaign[]
export const campaign = (id: string) => db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined
export const campaignBySlug = (s: string) => db.prepare('SELECT * FROM campaigns WHERE slug = ?').get(s) as Campaign | undefined
export function mustCampaign(id: string): Campaign { const c = campaign(id); if (!c) throw new UserError('Unknown registration'); return c }
export const offerings = (cid: string) => db.prepare('SELECT * FROM offerings WHERE campaign_id = ? ORDER BY sort, name').all(cid) as Offering[]
export const items = (cid: string) => db.prepare('SELECT * FROM items WHERE campaign_id = ? ORDER BY sort, name').all(cid) as Item[]
export const questions = (cid: string) => db.prepare('SELECT * FROM questions WHERE campaign_id = ? ORDER BY scope DESC, sort, label').all(cid) as Question[]
export const order = (id: string) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Order | undefined
const players = (orderId: string) => db.prepare('SELECT * FROM order_players WHERE order_id = ?').all(orderId) as OrderPlayer[]

/** Season used for league ages: the campaign's season, else a stand-in for the current year. */
export function ageSeason(c: Campaign): Season {
  if (c.season_id) { const s = season(c.season_id); if (s) return s }
  const y = new Date().getFullYear()
  return { id: String(y), year: y, status: 'planning', age_cutoff: '04-30', warn_at: 4, rolled_from: null, notes: '' }
}

/**
 * Spots a new player can take in this program: the program's own limit (set per program on the
 * Registration tab), less every new player already registered or waiting — a spot that opens goes to
 * the families waiting in line, not to whoever registers next. Returners holding their seat don't
 * count. No limit = never full. "Waitlist only" makes it full outright.
 */
export type Phase = 'open' | 'protected' | 'full' | 'waitlist'
export interface Guard { capacity: number; registered: number; outstanding: number; waitlist: number; buffer: number; protectAt: number | null }
export function availability(o: Offering): { open: number | null; full: boolean; taken: number; phase: Phase; guard: Guard | null } {
  const taken = (db.prepare(`SELECT COUNT(*) n FROM order_players WHERE offering_id = ? AND held_seat = 0 AND status IN ('registered','waitlisted','offered')`).get(o.id) as { n: number }).n
  const capFull = o.capacity != null && taken >= o.capacity
  const guard = guardOf(o)
  // Returner protection: once the buffer is down to the line, new players wait while returners register.
  const guarding = !!guard && guard.protectAt != null && guard.buffer <= guard.protectAt
  const phase: Phase = o.reg_mode === 'waitlist' ? 'waitlist' : capFull || (guarding && guard!.buffer <= 0) ? 'full' : guarding ? 'protected' : 'open'
  return { open: o.capacity == null ? null : o.capacity - taken, full: phase !== 'open', taken, phase, guard }
}
/**
 * Spring league only: the division's (or Majors+Minors group's) buffer — seats not yet taken by registered
 * players or held for returners still to register, less the waitlist already in line. 50 open with 40
 * returners outstanding is a buffer of 10.
 */
function guardOf(o: Offering): Guard | null {
  if (!o.division_id) return null
  const c = campaign(o.campaign_id)
  if (!c || c.kind !== 'spring') return null
  const d = db.prepare('SELECT season_id, group_key FROM divisions WHERE id = ?').get(o.division_id) as { season_id: string; group_key: string } | undefined
  if (!d) return null
  const st = seasonState(d.season_id, false)
  const seats = d.group_key ? st.groups.find((g) => g.key === d.group_key)?.seats : st.divisions.find((x) => x.id === o.division_id)?.seats
  if (!seats || !seats.capacity) return null
  return { capacity: seats.capacity, registered: seats.registered, outstanding: seats.held, waitlist: seats.waitlist, buffer: seats.open - seats.waitlist, protectAt: o.protect_at }
}
/** Full and not keeping a waitlist: new players can't register for it at all. (Protection always waitlists — spots may still open.) */
export const shutFor = (o: Offering, a: { phase: Phase }) => a.phase === 'full' && o.when_full === 'close'

// An admin may run test checkouts on a draft campaign while Stripe is in test mode, so the form can be tried end to end before families see it.
const adminTest = (c: Campaign, admin: boolean) => admin && c.status === 'draft' && stripeMode() === 'test'

function isOpen(c: Campaign, admin = false): string | null {
  if (adminTest(c, admin)) return null
  if (c.status !== 'open') return c.status === 'draft' ? 'Registration hasn’t opened yet.' : 'Registration is closed.'
  const now = new Date().toISOString()
  if (c.opens_at && now < c.opens_at) return `Registration opens ${c.opens_at.slice(0, 10)}.`
  if (c.closes_at && now > c.closes_at) return 'Registration is closed.'
  return null
}

/** What the public form needs. Never includes other families' data. */
export function publicCampaign(slugStr: string, preview = false) {
  const c = campaignBySlug(slugStr)
  if (!c || (c.status === 'draft' && !preview)) throw new UserError('No registration here')
  const s = ageSeason(c)
  return {
    campaign: { name: c.name, slug: c.slug, intro: c.intro, closedReason: isOpen(c, preview), preview: preview && c.status === 'draft', year: s.year, ageCutoff: s.age_cutoff },
    offerings: offerings(c.id).filter((o) => o.reg_mode !== 'closed').map((o) => {
      const a = availability(o)
      return { id: o.id, name: o.name, description: o.description, min_age: o.min_age, max_age: o.max_age, full: a.full, waitlist: !shutFor(o, a), protected: a.phase === 'protected', left: a.open != null && a.open <= 10 ? Math.max(0, a.open) : null,
        tryout: offeringTryout(o) }
    }),
    items: items(c.id).filter((i) => i.active).map((i) => ({ id: i.id, name: i.name, description: i.description, price_cents: i.price_cents, required: !!i.required, max_qty: i.max_qty, offering_ids: J<string[]>(i.offering_ids, []) })),
    questions: questions(c.id).filter((q) => q.active).map((q) => ({ id: q.id, scope: q.scope, label: q.label, help: q.help, type: q.type, options: J<string[]>(q.options, []), required: !!q.required, offering_ids: J<string[]>(q.offering_ids, []), new_only: !!q.new_only })),
    stripe: stripeConfigured() ? stripeMode() : null,
    // Interest-free installments the family can choose at checkout (the form shows the schedule; checkout re-checks it).
    plan: c.plan_installments >= 2 && c.plan_final_date ? { installments: c.plan_installments, finalDate: c.plan_final_date, minCents: c.plan_min_cents, today: today(), payDays: payDays(c.plan_installments, c.plan_final_date) } : null,
  }
}

/**
 * Kids who played last season and could be this player: the same name, or the
 * same birthdate and last name (Will / William). Most older records have no
 * birthdate, so for those the age has to fit what they played. The family
 * confirms which one it is, or says it's a new player.
 */
export function returningMatches(c: Campaign, first: string, last: string, dob: string) {
  const s = ageSeason(c)
  const prior = db.prepare('SELECT * FROM seasons WHERE year = ?').get(s.year - 1) as Season | undefined
  const born = normDate(dob)
  const priorAge = born && prior ? leagueAge(born, prior.year, prior.age_cutoff) : null
  if (!prior || !first.trim() || !last.trim() || !born || priorAge == null) return []
  const fullKey = nameKey(`${first} ${last}`), firstKey = nameKey(first), lastKey = nameKey(last)
  if (!firstKey || !lastKey) return []
  // Everyone on last season's rosters with this last name, or this exact full name.
  const rows = (db.prepare(`SELECT k.id, k.name, k.name_key, k.birthdate, k.gender, p.status, p.age, p.eff_team_id, d.name AS division, d.min_age, d.max_age, t.name AS team
    FROM placements p JOIN kids k ON k.id = p.kid_id LEFT JOIN divisions d ON d.id = p.eff_division_id LEFT JOIN teams t ON t.id = p.eff_team_id
    WHERE p.season_id = ? AND (k.name_key = ? OR k.name_key LIKE ?)`)
    .all(prior.id, fullKey, `% ${lastKey}`) as { id: string; name: string; name_key: string; birthdate: string | null; gender: string; status: string; age: number | null; eff_team_id: string | null; division: string | null; min_age: number | null; max_age: number | null; team: string | null }[])
    .filter((r) => r.status === 'Registered' || r.eff_team_id)
  const firstOf = (r: { name_key: string }) => r.name_key.slice(0, r.name_key.length - lastKey.length - 1)
  const full = (r: typeof rows[number]) => ({
    id: r.id, name: r.name, year: prior.year, division: r.division, team: r.team, suggestOfferingId: suggestedOffering(c, r.id),
    // The program where a seat is already held for them: full or not, they register and pay there.
    seatOfferingId: offerings(c.id).find((o) => o.active && holdsSeatIn(c, r.id, o))?.id ?? null,
    tryoutTeam: tryoutTeam(c, r.id), groupCase: groupCase(c, r.id), dobDiffers: false, gender: r.gender || '',
  })
  // 1. Exact: the full name, and the birthdate (or, with none on file, an age that fits).
  const exact = rows.filter((r) => r.name_key === fullKey).filter((r) => {
    if (r.birthdate) return r.birthdate === born
    if (r.age != null) return Math.abs(r.age - priorAge) <= 1
    return (r.min_age == null || priorAge >= r.min_age - 1) && (r.max_age == null || priorAge <= r.max_age + 1)
  })
  if (exact.length) return exact.slice(0, 3).map(full)
  // 2. Same last name and birthdate, first name a near miss (Will/William, Jon/John, a typo). The birthdate
  //    and last name check out, so they're shown in full. A twin with a different first name isn't a near miss.
  const nick = rows.filter((r) => r.birthdate === born && r.name_key !== fullKey && firstClose(firstKey, firstOf(r)))
  if (nick.length) return nick.slice(0, 3).map(full)
  // 3. The full name, birthdate a little off (a day, a month, a year, or day and month swapped). Ask — but
  //    say nothing about their team or program, since the birthdate didn't check out; the office sees the
  //    mismatch when they register.
  return rows.filter((r) => r.name_key === fullKey && r.birthdate && dobClose(r.birthdate, born))
    .slice(0, 1).map((r) => ({ id: r.id, name: r.name, year: prior.year, division: null, team: null, suggestOfferingId: null, seatOfferingId: null, tryoutTeam: null, groupCase: groupCase(c, r.id), dobDiffers: true }))
}

/** A birthdate that's probably a slip: one or two parts off by a little, or the day and month swapped. */
export function dobClose(a: string, b: string): boolean {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number)
  if ([y1, m1, d1, y2, m2, d2].some((n) => !Number.isFinite(n))) return false
  if (a === b) return true
  if (y1 === y2 && m1 === d2 && d1 === m2) return true
  const dy = Math.abs(y1! - y2!), dm = Math.abs(m1! - m2!), dd = Math.abs(d1! - d2!)
  // Up to two of year / month / day can be off, each by a little: a year, a month or two, a few days
  // (06/27 for 07/26 is a slip on both month and day). All three off is a different kid.
  const parts = [dy, dm, dd].filter((n) => n > 0).length
  if (parts <= 2 && dy <= 1 && dm <= 2 && dd <= 3) return true
  // Or simply within a couple of weeks (e.g. 31 Jan vs 2 Feb).
  return Math.abs(Date.parse(a) - Date.parse(b)) <= 14 * 864e5
}

/** A first name that's probably the same kid: a short form (Will/William), or a typo or two. */
export function firstClose(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (s.length >= 3 && l.startsWith(s)) return true
  const NICK: Record<string, string[]> = { william: ['bill', 'billy', 'liam'], robert: ['bob', 'bobby', 'rob'], richard: ['rick', 'dick', 'ricky'], james: ['jim', 'jimmy', 'jamie'],
    john: ['jack', 'johnny', 'jon'], jonathan: ['jon', 'jonny'], edward: ['ed', 'eddie', 'ted', 'ned'], elizabeth: ['liz', 'beth', 'eliza', 'lizzie'], katherine: ['kate', 'katie', 'kat'],
    catherine: ['cate', 'cathy', 'katie'], margaret: ['maggie', 'meg', 'peggy'], michael: ['mike', 'mikey'], nicholas: ['nick', 'nicky', 'cole'], christopher: ['chris', 'topher'],
    alexander: ['alex', 'xander', 'zander'], benjamin: ['ben', 'benny'], samuel: ['sam', 'sammy'], joseph: ['joe', 'joey'], daniel: ['dan', 'danny'], matthew: ['matt'],
    anthony: ['tony'], thomas: ['tom', 'tommy'], charles: ['charlie', 'chuck', 'chaz'], henry: ['hank'], theodore: ['theo', 'teddy', 'ted'], zachary: ['zach', 'zack'], andrew: ['drew', 'andy'] }
  for (const [n, short] of Object.entries(NICK)) if ((a === n && short.includes(b)) || (b === n && short.includes(a)) || (short.includes(a) && short.includes(b))) return true
  return lev(a, b) <= (s.length >= 5 ? 2 : 1)
}
function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/**
 * Brothers and sisters of a returning player, offered so the family can add them in one click.
 * Only when the details are right on both counts: the player matches a kid on last season's
 * rosters (exactly, or a near miss the family confirmed), and the parent's email or mobile is one
 * we have on file for that kid. Anyone else gets nothing, so a stranger can't use a name to see who else is in a family.
 * Siblings are the other kids under the same parent email or phone who played last season.
 */
export function siblingMatches(c: Campaign, first: string, last: string, dob: string, email: string, phone: string) {
  const born = normDate(dob)
  const mail = email.trim().toLowerCase(), tel = phone.replace(/\D/g, '').slice(-10)
  if (!born || (!mail && tel.length < 10)) return []
  // The player they confirmed — an exact match or a near miss (a birthdate slip, a nickname). What proves
  // it's this family is the parent's email or phone below, not the birthdate.
  const kid = returningMatches(c, first, last, dob).map((m) => db.prepare('SELECT * FROM kids WHERE id = ?').get(m.id) as Kid | undefined).find(Boolean)
  if (!kid) return []
  const mine = db.prepare('SELECT email, phone FROM contacts WHERE kid_id = ?').all(kid.id) as { email: string; phone: string }[]
  const telOf = (p: string) => p.replace(/\D/g, '').slice(-10)
  const mailOk = !!mail && mine.some((x) => x.email === mail)
  const telOk = tel.length === 10 && mine.some((x) => telOf(x.phone) === tel)
  if (!mailOk && !telOk) return []
  const emails = [...new Set(mine.map((x) => x.email).filter(Boolean))], phones = new Set(mine.map((x) => telOf(x.phone)).filter((p) => p.length === 10))
  const ids = new Set<string>()
  for (const r of db.prepare(`SELECT kid_id, email, phone FROM contacts WHERE kid_id != ?`).all(kid.id) as { kid_id: string; email: string; phone: string }[])
    if ((r.email && emails.includes(r.email)) || phones.has(telOf(r.phone))) ids.add(r.kid_id)
  const s = ageSeason(c)
  const out: { kidId: string; firstName: string; lastName: string; birthdate: string; gender: string; division: string | null; team: string | null; year: number; registered: boolean }[] = []
  for (const id of ids) {
    const k = db.prepare('SELECT * FROM kids WHERE id = ?').get(id) as Kid | undefined
    if (!k?.birthdate) continue
    const parts = k.name.trim().split(/\s+/), firstName = parts[0] ?? '', lastName = parts.slice(1).join(' ')
    // Must have played last season (the same check as the returning-player lookup) and still fit a program here.
    const m = returningMatches(c, firstName, lastName, k.birthdate).find((x) => x.id === id)
    if (!m) continue
    const age = leagueAge(k.birthdate, s.year, s.age_cutoff)
    if (!offerings(c.id).some((o) => o.active && (o.min_age == null || age == null || age >= o.min_age) && (o.max_age == null || age == null || age <= o.max_age))) continue
    const cur = c.season_id ? (db.prepare('SELECT status FROM enrollments WHERE season_id = ? AND kid_id = ?').get(c.season_id, id) as { status: string } | undefined) : undefined
    if (cur && (cur.status === 'Not returning' || cur.status === 'Withdrawn')) continue
    out.push({ kidId: id, firstName, lastName, birthdate: k.birthdate, gender: k.gender || '', division: m.division, team: m.team, year: m.year, registered: cur?.status === 'Registered' })
  }
  return out.sort((a, b) => a.birthdate.localeCompare(b.birthdate)).slice(0, 6)
}

/**
 * The team this kid holds in a shared group's later division (a Minors team), if any. Those are the
 * players registration asks "trying out for Majors?" — the answer decides whether they keep it.
 */
export function tryoutTeam(c: Campaign, kidId: string): string | null {
  if (!c.season_id) return null
  const e = db.prepare(`SELECT e.returning_team_id, e.division_id FROM enrollments e WHERE e.season_id = ? AND e.kid_id = ?`).get(c.season_id, kidId) as { returning_team_id: string | null; division_id: string | null } | undefined
  const d = e?.division_id ? division(e.division_id) : undefined
  if (!e?.returning_team_id || !d?.group_key || isDraftOnly(d)) return null
  return team(e.returning_team_id)?.name ?? null
}

/** What the form shows about tryouts for this division: 'playup' (the 9s), 'group' (Major/Minor), or nothing. */
function offeringTryout(o: Offering): 'playup' | 'group' | null {
  const d = o.division_id ? division(o.division_id) : undefined
  return !d ? null : d.group_key ? (isDraftOnly(d) ? null : 'group') : canTryOut(d) ? 'playup' : null
}

/**
 * Where a known player stands in the Majors/Minors group this season:
 *  - 'majors': back on their Majors team — no tryout, nothing to choose.
 *  - 'minors': back on their Minors team — stay on it, or try out for Majors (and return to it if not drafted).
 *  - 'rising': moving up from the 9-Year-Old League — tryouts required; Majors and Minors, or Minors only.
 *  - null: not a returner to the group (a new 10–12 player tries out, no choice).
 */
export type GroupCase = 'majors' | 'minors' | 'rising' | null
export function groupCase(c: Campaign, kidId: string): GroupCase {
  if (!c.season_id) return null
  const e = db.prepare(`SELECT e.division_id, e.returning_team_id FROM enrollments e WHERE e.season_id = ? AND e.kid_id = ?`).get(c.season_id, kidId) as { division_id: string | null; returning_team_id: string | null } | undefined
  const d = e?.division_id ? division(e.division_id) : undefined
  if (d?.group_key) return isDraftOnly(d) ? (e!.returning_team_id ? 'majors' : null) : e!.returning_team_id ? 'minors' : 'rising'
  // Not rolled over: last season in the division just below the group (the 9s) still counts as moving up.
  const s = season(c.season_id), prior = s ? db.prepare('SELECT id FROM seasons WHERE year = ?').get(s.year - 1) as { id: string } | undefined : undefined
  const pd = prior ? (db.prepare('SELECT eff_division_id FROM placements WHERE season_id = ? AND kid_id = ?').get(prior.id, kidId) as { eff_division_id: string | null } | undefined)?.eff_division_id : null
  const pdiv = pd ? division(pd) : undefined
  return pdiv && !pdiv.group_key && canTryOut(pdiv) ? 'rising' : null
}

/** A returner expected back in this program's division (or Majors+Minors group) already holds a seat there: it's theirs to claim. */
function holdsSeatIn(c: Campaign, kidId: string, o: Offering): boolean {
  if (!c.season_id || !o.division_id || c.kind !== 'spring') return false
  const e = db.prepare(`SELECT e.status, e.division_id, d.group_key FROM enrollments e JOIN divisions d ON d.id = e.division_id WHERE e.season_id = ? AND e.kid_id = ?`)
    .get(c.season_id, kidId) as { status: string; division_id: string; group_key: string } | undefined
  if (!e || !(HOLDS_SEAT as readonly string[]).includes(e.status)) return false
  const og = (db.prepare('SELECT group_key FROM divisions WHERE id = ?').get(o.division_id) as { group_key: string } | undefined)?.group_key
  return e.division_id === o.division_id || (!!e.group_key && e.group_key === og)
}

/** The program a returner is already expected in this season (e.g. back on their Majors team). */
function suggestedOffering(c: Campaign, kidId: string): string | null {
  if (!c.season_id) return null
  const e = db.prepare(`SELECT e.division_id, d.group_key FROM enrollments e JOIN divisions d ON d.id = e.division_id WHERE e.season_id = ? AND e.kid_id = ?`)
    .get(c.season_id, kidId) as { division_id: string; group_key: string } | undefined
  if (!e) return null
  const groupOf = (id: string | null) => (id ? (db.prepare('SELECT group_key FROM divisions WHERE id = ?').get(id) as { group_key: string } | undefined)?.group_key : undefined)
  return offerings(c.id).find((o) => o.active && (o.division_id === e.division_id || (e.group_key && groupOf(o.division_id) === e.group_key)))?.id ?? null
}

// ---------- admin: building a campaign ----------
export interface CampaignInput { name: string; slug?: string; season_id?: string | null; status?: Campaign['status']; opens_at?: string | null; closes_at?: string | null; intro?: string; confirmation?: string
  plan_installments?: number; plan_final_date?: string | null; plan_min_cents?: number; kind?: CampaignKind }
export function saveCampaign(id: string | null, p: CampaignInput, actor: string): Campaign {
  const name = p.name.trim()
  if (!name) throw new UserError('Give the registration a name')
  // Keep the existing web address unless a new one is given (links already sent must keep working).
  const slugStr = (p.slug?.trim() || (id ? mustCampaign(id).slug : '') || nameKey(name).replace(/ /g, '-')).toLowerCase()
  if (!slugOk(slugStr)) throw new UserError('Web address can only use letters, numbers and dashes')
  const clash = campaignBySlug(slugStr)
  if (clash && clash.id !== id) throw new UserError(`/register/${slugStr} is already used by ${clash.name}`)
  if (p.season_id) mustSeason(p.season_id)
  if (id) {
    const c = mustCampaign(id)
    db.prepare(`UPDATE campaigns SET name=?, slug=?, season_id=?, status=?, opens_at=?, closes_at=?, intro=?, confirmation=? WHERE id=?`)
      .run(name, slugStr, p.season_id !== undefined ? p.season_id : c.season_id, p.status ?? c.status, p.opens_at !== undefined ? p.opens_at : c.opens_at,
        p.closes_at !== undefined ? p.closes_at : c.closes_at, p.intro ?? c.intro, p.confirmation ?? c.confirmation, id)
    if (p.kind && p.kind !== c.kind) db.prepare('UPDATE campaigns SET kind = ? WHERE id = ?').run(p.kind, id)
    if (p.plan_installments !== undefined || p.plan_final_date !== undefined || p.plan_min_cents !== undefined) {
      const n = p.plan_installments ?? c.plan_installments, fin = p.plan_final_date !== undefined ? p.plan_final_date : c.plan_final_date
      if (n && (n < 2 || n > 12)) throw new UserError('A payment plan has 2 to 12 payments')
      if (n && !fin) throw new UserError('Pick the date the last plan payment is due')
      if (fin && !/^\d{4}-\d{2}-\d{2}$/.test(fin)) throw new UserError('Last payment date should be a date')
      if (n && fin && (p.plan_final_date !== undefined || p.plan_installments !== undefined) && fin <= today()) throw new UserError('The last plan payment date has to be in the future')
      db.prepare('UPDATE campaigns SET plan_installments = ?, plan_final_date = ?, plan_min_cents = ? WHERE id = ?').run(n || 0, fin || null, Math.max(0, p.plan_min_cents ?? c.plan_min_cents), id)
    }
    audit(actor, 'campaign_saved', p.season_id ?? c.season_id, null, { campaign: name, status: p.status ?? c.status })
  } else {
    id = uid()
    // The spring league is the one tied to a season unless told otherwise.
    db.prepare(`INSERT INTO campaigns (id, slug, name, season_id, status, opens_at, closes_at, intro, confirmation, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, slugStr, name, p.season_id ?? null, p.status ?? 'draft', p.opens_at ?? null, p.closes_at ?? null, p.intro ?? '', p.confirmation ?? '', p.kind ?? (p.season_id ? 'spring' : 'standard'))
    audit(actor, 'campaign_added', p.season_id ?? null, null, { campaign: name })
  }
  changed()
  return campaign(id)!
}

/**
 * One program per season division families can register for. Divisions that
 * share a group (Majors + Minors) become one program pointing at the
 * division families actually register into; draft-only divisions are skipped.
 */
export function programsFromSeason(campaignId: string, actor: string): number {
  const c = mustCampaign(campaignId)
  if (!c.season_id) throw new UserError('Pick the season this registration is for first')
  const have = new Set(offerings(c.id).map((o) => o.division_id).filter(Boolean))
  const ds = divisions(c.season_id)
  let n = 0, sort = offerings(c.id).length
  const doneGroups = new Set<string>()
  for (const d of ds) {
    if (isDraftOnly(d)) continue
    if (d.group_key) {
      if (doneGroups.has(d.group_key)) continue
      doneGroups.add(d.group_key)
    }
    if (have.has(d.id)) continue
    const members = d.group_key ? ds.filter((x) => x.group_key === d.group_key) : [d]
    const name = members.length > 1 ? members.slice().reverse().map((x) => x.name.replace(/s$/, '')).join('/') : d.name
    const min = Math.min(...members.map((x) => x.min_age ?? 0)), max = Math.max(...members.map((x) => x.max_age ?? 99))
    db.prepare('INSERT INTO offerings (id, campaign_id, division_id, name, description, min_age, max_age, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid(), c.id, d.id, name, '', min || null, max === 99 ? null : max, ++sort)
    n++
  }
  audit(actor, 'campaign_programs_added', c.season_id, null, { campaign: c.name, added: n })
  changed()
  return n
}

export interface OfferingInput { name: string; description?: string; division_id?: string | null; min_age?: number | null; max_age?: number | null; capacity?: number | null; reg_mode?: RegMode; when_full?: WhenFull; protect_at?: number | null; sort?: number }
export function saveOffering(campaignId: string, id: string | null, p: OfferingInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.name.trim()) throw new UserError('Division needs a name')
  if (p.division_id && !divisions(c.season_id ?? '').some((d) => d.id === p.division_id)) throw new UserError('That division isn’t in this registration’s season')
  const was = id ? (db.prepare('SELECT reg_mode, sort, when_full, protect_at FROM offerings WHERE id = ?').get(id) as { reg_mode: RegMode; sort: number; when_full: WhenFull; protect_at: number | null } | undefined) : undefined
  if (p.capacity != null && p.capacity < 0) throw new UserError('Spots can’t be negative')
  const mode = p.reg_mode ?? was?.reg_mode ?? 'open'
  // active mirrors reg_mode for the code that only asks "is it offered at all".
  const vals = [p.name.trim(), p.description ?? '', p.division_id ?? null, p.min_age ?? null, p.max_age ?? null, p.capacity ?? null, mode, p.sort ?? was?.sort ?? 0, mode === 'closed' ? 0 : 1, p.when_full ?? was?.when_full ?? 'waitlist', p.protect_at !== undefined ? p.protect_at : was?.protect_at ?? null]
  if (id) db.prepare('UPDATE offerings SET name=?, description=?, division_id=?, min_age=?, max_age=?, capacity=?, reg_mode=?, sort=?, active=?, when_full=?, protect_at=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO offerings (name, description, division_id, min_age, max_age, capacity, reg_mode, sort, active, when_full, protect_at, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_program_saved', c.season_id, null, { campaign: c.name, program: p.name, registration: mode, spots: p.capacity ?? null, when_full: p.when_full ?? was?.when_full ?? 'waitlist' })
  changed()
}
export function deleteOffering(id: string, actor: string) {
  if (db.prepare('SELECT 1 FROM order_players WHERE offering_id = ?').get(id)) throw new UserError('Families have registered for this division — turn it off instead')
  db.prepare('DELETE FROM offerings WHERE id = ?').run(id)
  audit(actor, 'campaign_program_deleted', null, null, { id })
  changed()
}

export interface ItemInput { name: string; description?: string; price_cents: number; required?: boolean; max_qty?: number; offering_ids?: string[]; tag?: string; sort?: number; active?: boolean }
export function saveItem(campaignId: string, id: string | null, p: ItemInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.name.trim()) throw new UserError('Item needs a name')
  const vals = [p.name.trim(), p.description ?? '', p.price_cents, p.required ? 1 : 0, p.required ? 1 : Math.max(1, p.max_qty ?? 1), JSON.stringify(p.offering_ids ?? []), (p.tag ?? '').trim(), p.sort ?? 0, p.active === false ? 0 : 1]
  if (id) db.prepare('UPDATE items SET name=?, description=?, price_cents=?, required=?, max_qty=?, offering_ids=?, tag=?, sort=?, active=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO items (name, description, price_cents, required, max_qty, offering_ids, tag, sort, active, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_item_saved', c.season_id, null, { campaign: c.name, item: p.name, price: p.price_cents })
  changed()
}
export function deleteItem(id: string, actor: string) {
  if (db.prepare('SELECT 1 FROM order_lines WHERE item_id = ?').get(id)) throw new UserError('Families have bought this — turn it off instead')
  db.prepare('DELETE FROM items WHERE id = ?').run(id)
  audit(actor, 'campaign_item_deleted', null, null, { id })
  changed()
}

export interface QuestionInput { scope: 'player' | 'family'; label: string; help?: string; type: QType; options?: string[]; required?: boolean; offering_ids?: string[]; sort?: number; active?: boolean; new_only?: boolean }
export function saveQuestion(campaignId: string, id: string | null, p: QuestionInput, actor: string) {
  const c = mustCampaign(campaignId)
  if (!p.label.trim()) throw new UserError('Question needs a label')
  const opts = (p.options ?? []).map((o) => o.trim()).filter(Boolean)
  if ((p.type === 'select' || p.type === 'multi') && opts.length < 2) throw new UserError('Give at least two choices')
  const vals = [p.scope, p.label.trim(), p.help ?? '', p.type, JSON.stringify(opts), p.required || p.type === 'agreement' ? 1 : 0, JSON.stringify(p.offering_ids ?? []), p.sort ?? 0, p.active === false ? 0 : 1, p.new_only ? 1 : 0]
  if (id) db.prepare('UPDATE questions SET scope=?, label=?, help=?, type=?, options=?, required=?, offering_ids=?, sort=?, active=?, new_only=? WHERE id=? AND campaign_id=?').run(...vals, id, c.id)
  else db.prepare('INSERT INTO questions (scope, label, help, type, options, required, offering_ids, sort, active, new_only, id, campaign_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, uid(), c.id)
  audit(actor, 'campaign_question_saved', c.season_id, null, { campaign: c.name, question: p.label })
  changed()
}
export function deleteQuestion(id: string, actor: string) {
  db.prepare('DELETE FROM questions WHERE id = ?').run(id)
  audit(actor, 'campaign_question_deleted', null, null, { id })
  changed()
}

// ---------- checkout ----------
export interface CheckoutInput {
  guardian: { firstName: string; lastName: string; email: string; phone: string; address?: string; city?: string; state?: string; zip?: string }
  answers: Record<string, unknown>
  players: { firstName: string; lastName: string; birthdate: string; gender?: string; offeringId: string; items: Record<string, number>; answers: Record<string, unknown>; returning?: string; tryout?: boolean }[]
  /** Pay in installments (when the campaign offers a plan). */ plan?: boolean
  /** The day of the month for payments 2 onward. */ payDay?: number
}
/** Where a player's tryout answer is kept among their answers (not a campaign question; built in for Minors returners). */
export const TRYOUT_ANSWER = '_tryout'

function checkAnswer(q: Question, v: unknown, who: string): unknown {
  const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (q.type === 'agreement' && v !== true)
  if (empty) { if (q.required) throw new UserError(q.type === 'agreement' ? `${who}: please agree to “${q.label}”` : `${who}: “${q.label}” is required`); return undefined }
  const opts = J<string[]>(q.options, [])
  switch (q.type) {
    case 'yesno': if (v !== 'Yes' && v !== 'No') throw new UserError(`${who}: answer “${q.label}” with Yes or No`); return v
    case 'select': if (!opts.includes(String(v))) throw new UserError(`${who}: pick one of the choices for “${q.label}”`); return v
    case 'multi': if (!Array.isArray(v) || v.some((x) => !opts.includes(String(x)))) throw new UserError(`${who}: pick from the choices for “${q.label}”`); return v
    case 'number': if (!Number.isFinite(Number(v))) throw new UserError(`${who}: “${q.label}” should be a number`); return Number(v)
    case 'date': if (!normDate(String(v))) throw new UserError(`${who}: “${q.label}” should be a date`); return normDate(String(v))
    case 'agreement': return true
    default: return String(v).slice(0, 4000)
  }
}

export interface Quote {
  campaign: Campaign; season: Season
  guardian: CheckoutInput['guardian']; answers: Record<string, unknown>
  players: { input: CheckoutInput['players'][number]; returning: string; offering: Offering; age: number | null; waitlisted: boolean; heldSeat: boolean; answers: Record<string, unknown>; lines: { item: Item; qty: number }[] }[]
  total: number
  plan: { due: string; cents: number }[] | null
}

/** Validate a form submission and price it. Throws a family-readable error on anything wrong. */
export function quote(slugStr: string, inp: CheckoutInput, admin = false): Quote {
  const c = campaignBySlug(slugStr)
  if (!c) throw new UserError('No registration here')
  const closed = isOpen(c, admin)
  if (closed) throw new UserError(closed)
  const g = inp.guardian
  if (!g.firstName?.trim() || !g.lastName?.trim()) throw new UserError('Parent/guardian name is required')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(g.email ?? '')) throw new UserError('A valid email is required for the receipt')
  if ((g.phone ?? '').replace(/\D/g, '').length < 10) throw new UserError('A phone number is required')
  if (!inp.players.length) throw new UserError('Add at least one player')
  if (inp.players.length > 8) throw new UserError('Register up to 8 players at a time')
  const s = ageSeason(c)
  const offs = offerings(c.id).filter((o) => o.active), its = items(c.id).filter((i) => i.active), qs = questions(c.id).filter((q) => q.active)
  const familyAnswers: Record<string, unknown> = {}
  for (const q of qs.filter((q) => q.scope === 'family')) { const v = checkAnswer(q, inp.answers?.[q.id], 'Family'); if (v !== undefined) familyAnswers[q.id] = v }
  const seen = new Set<string>()
  const taken = new Map<string, number>() // seats this order would use per program
  const out: Quote['players'] = []
  for (const p of inp.players) {
    const name = `${p.firstName?.trim() ?? ''} ${p.lastName?.trim() ?? ''}`.trim()
    if (!p.firstName?.trim() || !p.lastName?.trim()) throw new UserError('Each player needs a first and last name')
    const dob = normDate(p.birthdate)
    if (!dob) throw new UserError(`${name}: birthdate is required`)
    const key = `${nameKey(name)}|${dob}`
    if (seen.has(key)) throw new UserError(`${name} is listed twice`)
    seen.add(key)
    const o = offs.find((x) => x.id === p.offeringId)
    if (!o) throw new UserError(`${name}: pick a division`)
    const age = leagueAge(dob, s.year, s.age_cutoff)
    if (!fitsAge({ min_age: o.min_age, max_age: o.max_age }, age)) throw new UserError(`${name} is league age ${age} for ${s.year}; ${o.name} is for ages ${o.min_age ?? '?'}–${o.max_age ?? '?'}`)
    // Last season's player: the family has to say whether it's them, and can only pick one we offered.
    const matches = returningMatches(c, p.firstName, p.lastName, dob)
    let returning = ''
    if (matches.length) {
      if (!p.returning) throw new UserError(`${name}: tell us whether this is the player who played in ${matches[0]!.year}`)
      if (p.returning !== 'new' && !matches.some((m) => m.id === p.returning)) throw new UserError(`${name}: please re-check the returning player question`)
      returning = p.returning
    }
    if (c.season_id) {
      if (returning && returning !== 'new' && db.prepare(`SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ? AND status = 'Registered'`).get(c.season_id, returning))
        throw new UserError(`${name} is already registered for ${s.year}`)
      const already = db.prepare(`SELECT e.status FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = ? AND k.name_key = ? AND (k.birthdate IS NULL OR k.birthdate = ?)
        AND e.status = 'Registered'`).get(c.season_id, nameKey(name), dob)
      if (already) throw new UserError(`${name} is already registered for ${s.year}`)
    }
    // An expected returner fills the seat already held for them, so a full program doesn't waitlist them.
    // (No roster match to confirm — say a kid with no 2026 birthdate — falls back to an exact name + birthdate.)
    const kidId = returning && returning !== 'new' ? returning
      : (db.prepare('SELECT id FROM kids WHERE name_key = ? AND birthdate = ?').get(nameKey(name), dob) as { id: string } | undefined)?.id
    const ownSeat = !!kidId && holdsSeatIn(c, kidId, o)
    const a = availability(o)
    const used = (taken.get(o.id) ?? 0) + 1
    const waitlisted = !ownSeat && (a.full || (a.open != null && a.open - used < 0))
    if (waitlisted && shutFor(o, a)) throw new UserError(`${o.name} is full for ${s.year} and isn’t taking more registrations — please contact the league`)
    if (!waitlisted && !ownSeat) taken.set(o.id, used)
    const lines: { item: Item; qty: number }[] = []
    for (const it of its.filter((i) => appliesTo(i.offering_ids, o.id))) {
      let qty = Math.floor(Number(p.items?.[it.id] ?? 0)) || 0
      if (it.required) qty = 1
      if (qty < 0 || qty > it.max_qty) throw new UserError(`${name}: ${it.name} — choose up to ${it.max_qty}`)
      if (qty) lines.push({ item: it, qty })
    }
    const answers: Record<string, unknown> = {}
    // A confirmed returner already told us about their baseball last season.
    const returner = !!returning && returning !== 'new'
    for (const q of qs.filter((q) => q.scope === 'player' && appliesTo(q.offering_ids, o.id) && !(q.new_only && returner))) { const v = checkAnswer(q, p.answers?.[q.id], name); if (v !== undefined) answers[q.id] = v }
    // Majors tryouts. Every 9 chooses. In Major/Minor: a Majors returner stays put; a Minors returner chooses
    // (stay on their team, or try out and come back to it if not drafted); a player moving up from the 9s
    // chooses Majors-and-Minors or Minors only; a player new to the league tries out — no choice.
    const tc = offeringTryout(o)
    const gc = tc === 'group' && returner ? groupCase(c, returning) : null
    if (tc === 'playup' || gc === 'minors' || gc === 'rising') {
      if (typeof p.tryout !== 'boolean') throw new UserError(`${name}: ${gc === 'minors' ? 'say whether they’ll try out for Majors' : 'say whether they want to be considered for Majors'}`)
      answers[TRYOUT_ANSWER] = p.tryout
    } else if (tc === 'group' && !gc) answers[TRYOUT_ANSWER] = true
    out.push({ input: { ...p, birthdate: dob }, returning, offering: o, age, waitlisted, heldSeat: ownSeat, answers, lines })
  }
  const total = out.filter((p) => !p.waitlisted).reduce((a, p) => a + p.lines.reduce((b, l) => b + l.item.price_cents * l.qty, 0), 0)
  let plan: Quote['plan'] = null
  if (inp.plan && total > 0) {
    if (inp.payDay && !payDays(c.plan_installments, c.plan_final_date).includes(inp.payDay)) throw new UserError('That payment day doesn’t fit this plan — please pick an earlier day of the month')
    plan = planFor(c, total, today(), inp.payDay)
    if (!plan) throw new UserError('A payment plan isn’t available for this registration — please pay in full, or contact the league')
  }
  return { campaign: c, season: s, guardian: g, answers: familyAnswers, players: out, total, plan }
}

/** Save the order and start Stripe checkout. Returns where to send the family next. */
export async function startCheckout(slugStr: string, inp: CheckoutInput, baseUrl: string, admin = false): Promise<{ orderId: string; url: string }> {
  const q = quote(slugStr, inp, admin)
  if (q.total > 0 && !stripeConfigured()) throw new UserError('Online payment isn’t set up yet — please try again later')
  const orderId = uid() + uid()
  const allWaitlisted = q.players.every((p) => p.waitlisted)
  db.transaction(() => {
    db.prepare(`INSERT INTO orders (id, campaign_id, status, guardian, answers, total_cents, stripe_mode) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(orderId, q.campaign.id, q.total > 0 ? 'pending' : allWaitlisted ? 'waitlisted' : 'pending', JSON.stringify(q.guardian), JSON.stringify(q.answers), q.total, q.total > 0 ? stripeMode() : null)
    for (const p of q.players) {
      const pid = uid()
      db.prepare(`INSERT INTO order_players (id, order_id, first_name, last_name, birthdate, gender, offering_id, status, answers, prior_match, held_seat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(pid, orderId, p.input.firstName.trim(), p.input.lastName.trim(), p.input.birthdate, p.input.gender ?? '', p.offering.id, p.waitlisted ? 'waitlisted' : 'pending', JSON.stringify(p.answers), p.returning, p.heldSeat ? 1 : 0)
      for (const l of p.lines) db.prepare('INSERT INTO order_lines (order_id, order_player_id, item_id, name, tag, unit_cents, qty, charged) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(orderId, pid, l.item.id, l.item.name, l.item.tag, l.item.price_cents, l.qty, p.waitlisted ? 0 : 1)
    }
    if (q.plan) createPlan(orderId, q.plan)
  })()
  const done = `${baseUrl}/register/${q.campaign.slug}/done?order=${orderId}`
  if (q.total === 0) {
    // Nothing to pay (every kid waitlisted, or a free program): record it now.
    fulfill(orderId, null)
    return { orderId, url: done }
  }
  const lines: LineItem[] = q.players.filter((p) => !p.waitlisted).flatMap((p) => p.lines.map((l) => ({
    name: `${l.item.name} — ${p.input.firstName.trim()} ${p.input.lastName.trim()}`, description: p.offering.name, unitCents: l.item.price_cents, qty: l.qty,
  })))
  const names = q.players.filter((p) => !p.waitlisted).map((p) => `${p.input.firstName.trim()} ${p.input.lastName.trim()}`).join(', ')
  // A plan charges the first payment now and keeps the card for the rest.
  const planLines: LineItem[] | null = q.plan ? [{ name: `Payment 1 of ${q.plan.length} — ${q.campaign.name} registration`,
    description: `${names}. Then ${q.plan.slice(1).map((x) => `$${(x.cents / 100).toFixed(2)} on ${x.due}`).join(', ')} — charged to this card.`, unitCents: q.plan[0]!.cents, qty: 1 }] : null
  const session = await createCheckout({
    lines: planLines ?? lines, saveCard: !!q.plan, email: q.guardian.email.trim(), orderId, idempotencyKey: `order-${orderId}`,
    successUrl: `${done}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${baseUrl}/register/${q.campaign.slug}?cancelled=${orderId}`,
    description: `${q.campaign.name} registration — ${q.players.map((p) => `${p.input.firstName} ${p.input.lastName}`).join(', ')}`,
  })
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId)
  return { orderId, url: session.url }
}

/**
 * Find or create the kid for a registered player so their history stays in one
 * place: the returning player the family confirmed, else a name + birthdate match.
 */
function kidFor(p: OrderPlayer): Kid {
  const confirmed = p.prior_match && p.prior_match !== 'new' ? (db.prepare('SELECT * FROM kids WHERE id = ?').get(p.prior_match) as Kid | undefined) : undefined
  if (confirmed) {
    if (!confirmed.birthdate) db.prepare('UPDATE kids SET birthdate = ? WHERE id = ?').run(p.birthdate, confirmed.id)
    else if (confirmed.birthdate !== p.birthdate) {
      // The family said "same player" with a different birthdate: keep ours, flag it for the office to check.
      const note = `Registration gave birthdate ${p.birthdate} (on file: ${confirmed.birthdate}) — check which is right.`
      db.prepare(`UPDATE kids SET notes = TRIM(notes || ' ' || ?) WHERE id = ? AND instr(notes, ?) = 0`).run(note, confirmed.id, note)
      audit('registration', 'birthdate_differs', null, confirmed.id, { given: p.birthdate, onFile: confirmed.birthdate })
    }
    return confirmed
  }
  const name = `${p.first_name} ${p.last_name}`
  const cands = (db.prepare('SELECT * FROM kids WHERE name_key = ?').all(nameKey(name)) as Kid[]).filter((k) => !k.birthdate || k.birthdate === p.birthdate)
  // A family that said "not this player" only gets an exact birthdate match, never a guess.
  const exact = cands.find((k) => k.birthdate === p.birthdate) ?? (cands.length === 1 && p.prior_match !== 'new' ? cands[0] : undefined)
  if (exact) { if (!exact.birthdate) db.prepare('UPDATE kids SET birthdate = ? WHERE id = ?').run(p.birthdate, exact.id); return exact }
  return createKid(name, p.birthdate)
}

/** Put one paid (or waitlisted) player into the season. */
function place(o: Order, p: OrderPlayer, c: Campaign, status: 'Registered' | 'Waitlist') {
  const off = db.prepare('SELECT * FROM offerings WHERE id = ?').get(p.offering_id) as Offering
  const k = kidFor(p)
  if ((p.gender === 'Boy' || p.gender === 'Girl') && k.gender !== p.gender) db.prepare('UPDATE kids SET gender = ? WHERE id = ?').run(p.gender, k.id)
  let enrollmentId: string | null = null
  const bought = (db.prepare('SELECT name, qty, tag FROM order_lines WHERE order_player_id = ?').all(p.id) as { name: string; qty: number; tag: string }[])
  if (c.season_id && off.division_id) {
    const e = db.prepare('SELECT * FROM enrollments WHERE season_id = ? AND kid_id = ?').get(c.season_id, k.id) as { id: string; status: string; division_id: string | null } | undefined
    if (e) {
      // Usually an expected returner. A real registration wins over Expected / Need to contact / Waitlist.
      if (status === 'Registered' || e.status !== 'Registered')
        db.prepare(`UPDATE enrollments SET status = ?, se_program = ?, registered_at = CASE WHEN ? = 'Registered' THEN ? ELSE registered_at END, division_id = COALESCE(division_id, ?), updated_at = datetime('now') WHERE id = ?`)
          .run(status, off.name, status, new Date().toISOString(), off.division_id, e.id)
      enrollmentId = e.id
    } else {
      const div = db.prepare('SELECT group_key FROM divisions WHERE id = ?').get(off.division_id) as { group_key: string }
      enrollmentId = enroll(c.season_id, k.id, { divisionId: off.division_id, status, tryout: !!div.group_key, age: null }, 'registration').id
      db.prepare('UPDATE enrollments SET se_program = ?, division_locked = 0 WHERE id = ?').run(off.name, enrollmentId)
    }
  }
  db.prepare('UPDATE order_players SET kid_id = ?, enrollment_id = ? WHERE id = ?').run(k.id, enrollmentId, p.id)
  // Their tryout answer replaces the "assumed trying out" Minors returners and 9s start the season with.
  const tryout = J<Record<string, unknown>>(p.answers, {})[TRYOUT_ANSWER]
  const ed = enrollmentId ? (db.prepare('SELECT division_id FROM enrollments WHERE id = ?').get(enrollmentId) as { division_id: string | null }).division_id : null
  const edDiv = ed ? division(ed) : undefined
  if (enrollmentId && typeof tryout === 'boolean' && edDiv && canTryOut(edDiv)) {
    try { setTryout(enrollmentId, tryout, 'registration') } catch (e) { if (!(e instanceof UserError)) throw e }
  }
  // Remember the parent for next year's returning-player outreach.
  const g = J<CheckoutInput['guardian']>(o.guardian, { firstName: '', lastName: '', email: '', phone: '' })
  try { addContact(k.id, { name: `${g.firstName} ${g.lastName}`, email: g.email, phone: g.phone }, 'registration') } catch (e) { if (!(e instanceof UserError)) throw e }
  db.prepare(`INSERT INTO registrations (source, verified, raw, first_name, last_name, birthdate, reg_year, program, season_id, outcome, kid_id, enrollment_id, division_id, note)
    VALUES ('web', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(JSON.stringify({ order: o.id, player: p.id, campaign: c.slug }), p.first_name, p.last_name, p.birthdate,
    c.season_id ? Number(c.season_id) : null, off.name, c.season_id, status === 'Registered' ? 'placed' : 'waitlist', k.id, enrollmentId, off.division_id,
    `${c.name}: ${status === 'Registered' ? 'paid' : 'waitlisted'}${bought.length ? ` — ${bought.map((b) => `${b.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`).join(', ')}` : ''}`)
  audit('registration', status === 'Registered' ? 'registered_online' : 'waitlisted_online', c.season_id, k.id,
    { campaign: c.name, program: off.name, order: o.id, bought: bought.map((b) => `${b.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`) })
  // Tell the division's coaches — after this transaction commits, and never holding up the payment.
  if (enrollmentId) { const id = enrollmentId; setImmediate(() => { void notifyCoaches(id) }) }
}

/** Payment confirmed (or nothing to pay): register every pending player. Safe to call twice. */
export function fulfill(orderId: string, paymentId: string | null) {
  const res = db.transaction(() => {
    const o = order(orderId)
    if (!o) throw new Error(`no order ${orderId}`)
    const c = mustCampaign(o.campaign_id)
    const ps = players(orderId)
    let did = 0
    for (const p of ps) {
      if (p.status === 'pending') { place(o, p, c, 'Registered'); db.prepare(`UPDATE order_players SET status = 'registered' WHERE id = ?`).run(p.id); did++ }
      else if (p.status === 'waitlisted' && !p.enrollment_id && !p.kid_id) { place(o, p, c, 'Waitlist'); did++ }
    }
    if ((o as Order & { plan?: number }).plan && paymentId) firstPaymentIn(orderId, paymentId)
    if (o.status === 'pending' || o.status === 'waitlisted') {
      const paid = ps.some((p) => p.status === 'pending' || p.status === 'registered')
      db.prepare(`UPDATE orders SET status = ?, paid_at = COALESCE(paid_at, ?), stripe_payment_id = COALESCE(?, stripe_payment_id) WHERE id = ?`)
        .run(paid ? 'paid' : 'waitlisted', paid ? new Date().toISOString() : null, paymentId, orderId)
    }
    return { did, seasonId: c.season_id }
  })()
  if (res.seasonId) refreshPools(res.seasonId)
  changed()
  return res
}

/** A waitlisted kid's spot was paid for through an offer link. */
function fulfillOffer(orderPlayerId: string, paymentId: string | null) {
  const res = db.transaction(() => {
    const p = db.prepare('SELECT * FROM order_players WHERE id = ?').get(orderPlayerId) as OrderPlayer | undefined
    if (!p || p.status === 'registered') return null
    const o = order(p.order_id)!, c = mustCampaign(o.campaign_id)
    place(o, p, c, 'Registered')
    db.prepare(`UPDATE order_players SET status = 'registered' WHERE id = ?`).run(p.id)
    const amt = (db.prepare('SELECT COALESCE(SUM(unit_cents * qty), 0) s FROM order_lines WHERE order_player_id = ? AND charged = 0').get(p.id) as { s: number }).s
    db.prepare('UPDATE order_lines SET charged = 1 WHERE order_player_id = ?').run(p.id)
    db.prepare(`UPDATE orders SET status = 'paid', total_cents = total_cents + ?, paid_at = COALESCE(paid_at, ?), admin_notes = TRIM(admin_notes || ' ' || ?) WHERE id = ?`)
      .run(amt, new Date().toISOString(), `Waitlist spot paid for ${p.first_name}${paymentId ? ` (${paymentId})` : ''}.`, o.id)
    return c.season_id
  })()
  if (res) refreshPools(res)
  changed()
}

export const OFFER_HOURS = [24, 48, 72, 168] as const
const offerLink = (c: Campaign, token: string, baseUrl: string) => `${baseUrl}/register/${c.slug}/spot/${token}`
const offerExpired = (p: OrderPlayer, now = new Date().toISOString()) => p.status === 'offered' && !!p.offer_expires_at && p.offer_expires_at < now
const playerItems = (id: string) => db.prepare('SELECT * FROM order_lines WHERE order_player_id = ?').all(id) as { name: string; unit_cents: number; qty: number }[]
const longDate = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: config.timeZone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function offerEmail(c: Campaign, p: OrderPlayer, g: CheckoutInput['guardian'], link: string, total: number, expires: string) {
  const program = (db.prepare('SELECT name FROM offerings WHERE id = ?').get(p.offering_id) as { name: string }).name
  const when = longDate(expires)
  const text = `Hi ${g.firstName || 'there'},

Good news — a spot opened up in ${program} for ${p.first_name}, and it's yours if you'd like it.

To claim it, pay the $${(total / 100).toFixed(2)} registration by ${when}:
${link}

If we don't hear from you by then, we'll offer the spot to the next family on the waitlist. If ${p.first_name} won't be playing this season after all, just reply and let us know.

${config.leagueName}`
  const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:560px">${text.split(/\n{2,}/).map((para) =>
    `<p>${para.split('\n').map((line) => line === link ? `<a href="${esc(link)}" style="display:inline-block;margin-top:6px;background:#14213D;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Claim ${esc(p.first_name)}’s spot</a>` : esc(line)).join('<br>')}</p>`).join('')}</div>`
  return { to: g.email, subject: `A spot opened up for ${p.first_name} — ${c.name}`, text, html }
}

/**
 * Admin offers a waitlisted kid their spot: a personal pay link good until a deadline.
 * Emailed to the family when email is set up; the admin can always copy it too.
 * Offering again (after a deadline passes, or to extend it) makes a new link.
 */
export async function offerSpot(orderPlayerId: string, hours: number, baseUrl: string, actor: string): Promise<{ url: string | null; expiresAt: string | null; emailed: string | null; emailError: string; registered: boolean }> {
  const p = db.prepare('SELECT * FROM order_players WHERE id = ?').get(orderPlayerId) as OrderPlayer | undefined
  if (!p || !['waitlisted', 'offered'].includes(p.status)) throw new UserError('That player isn’t on the waitlist')
  if (!(OFFER_HOURS as readonly number[]).includes(hours)) throw new UserError('Pick how long the family has to pay')
  const o = order(p.order_id)!, c = mustCampaign(o.campaign_id), g = J<CheckoutInput['guardian']>(o.guardian, {} as CheckoutInput['guardian'])
  const total = playerItems(p.id).reduce((a, l) => a + l.unit_cents * l.qty, 0)
  audit(actor, 'waitlist_spot_offered', c.season_id, p.kid_id, { campaign: c.name, player: `${p.first_name} ${p.last_name}`, hours })
  if (!total) { fulfillOffer(p.id, null); return { url: null, expiresAt: null, emailed: null, emailError: '', registered: true } }
  if (!stripeConfigured()) throw new UserError('Stripe is not configured')
  const token = randomBytes(18).toString('base64url')
  const expiresAt = new Date(Date.now() + hours * 3600e3).toISOString()
  db.prepare(`UPDATE order_players SET status = 'offered', offer_token = ?, offer_expires_at = ?, offer_session_id = NULL WHERE id = ?`).run(token, expiresAt, p.id)
  changed()
  const url = offerLink(c, token, baseUrl)
  let emailed: string | null = null, emailError = ''
  if (mailConfigured() && g.email) {
    const [r] = await sendBatch([offerEmail(c, p, g, url, total, expiresAt)])
    if (r?.ok) emailed = g.email
    else emailError = r?.error ?? 'Email failed'
  }
  return { url, expiresAt, emailed, emailError, registered: false }
}

/** The family opened their pay link: start a fresh Stripe checkout for that kid, or say why not. */
export async function payOffer(slugStr: string, token: string, baseUrl: string): Promise<string> {
  const c = campaignBySlug(slugStr)
  const p = c && token ? (db.prepare('SELECT * FROM order_players WHERE offer_token = ?').get(token) as OrderPlayer | undefined) : undefined
  const o = p ? order(p.order_id) : undefined
  if (!c || !p || !o || o.campaign_id !== c.id) throw new UserError('This link isn’t valid. Please check the email we sent, or contact the league.')
  const done = `${baseUrl}/register/${c.slug}/done?order=${o.id}`
  if (p.status === 'registered') return done
  if (p.status !== 'offered') throw new UserError(`This offer for ${p.first_name} is no longer available. Please contact the league if you have questions.`)
  if (offerExpired(p)) throw new UserError(`This offer for ${p.first_name} expired on ${longDate(p.offer_expires_at!)}. Please contact the league — ${p.first_name} may still be on the waitlist.`)
  const g = J<CheckoutInput['guardian']>(o.guardian, {} as CheckoutInput['guardian'])
  const session = await createCheckout({
    lines: playerItems(p.id).map((l) => ({ name: `${l.name} — ${p.first_name} ${p.last_name}`, unitCents: l.unit_cents, qty: l.qty })),
    email: g.email, orderId: o.id, idempotencyKey: `offer-${p.id}-${Date.now()}`, extraMetadata: { order_player_id: p.id },
    successUrl: `${done}&session_id={CHECKOUT_SESSION_ID}`, cancelUrl: done, // the done page shows the offer still open, with its pay link
    description: `${c.name} registration — ${p.first_name} ${p.last_name} (waitlist spot)`,
  })
  db.prepare('UPDATE order_players SET offer_session_id = ? WHERE id = ?').run(session.id, p.id)
  return session.url
}

/** Take a kid off the waitlist (the family declined, or let the offer lapse). Frees their place in line. */
export function removeFromWaitlist(orderPlayerId: string, actor: string) {
  const res = db.transaction(() => {
    const p = db.prepare('SELECT * FROM order_players WHERE id = ?').get(orderPlayerId) as OrderPlayer | undefined
    if (!p || !['waitlisted', 'offered'].includes(p.status)) throw new UserError('That player isn’t on the waitlist')
    const o = order(p.order_id)!, c = mustCampaign(o.campaign_id)
    db.prepare(`UPDATE order_players SET status = 'cancelled', offer_token = NULL, offer_expires_at = NULL WHERE id = ?`).run(p.id)
    if (p.enrollment_id) db.prepare(`UPDATE enrollments SET status = 'Withdrawn', updated_at = datetime('now') WHERE id = ? AND status = 'Waitlist'`).run(p.enrollment_id)
    if (o.status === 'waitlisted' && players(o.id).every((x) => x.status === 'cancelled')) db.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).run(o.id)
    audit(actor, 'removed_from_waitlist', c.season_id, p.kid_id, { campaign: c.name, player: `${p.first_name} ${p.last_name}` })
    return c.season_id
  })()
  if (res) refreshPools(res)
  changed()
}

/** Stripe webhook events. Returns a short note for the log. */
export function handleStripeEvent(ev: { type: string; data: { object: Record<string, unknown> } }): string {
  const obj = ev.data.object
  const meta = (obj.metadata ?? {}) as Record<string, string>
  if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status !== 'paid') return 'not paid yet'
    const pi = (obj.payment_intent as string | null) ?? null
    if (meta.order_player_id) { fulfillOffer(meta.order_player_id, pi); return `waitlist spot paid ${meta.order_player_id}` }
    if (meta.installment_ids) {
      const n = balancePaid(meta.installment_ids.split(','), pi)
      if (meta.order_id) saveCard(meta.order_id, pi).catch((e) => console.error('[plans] save card', e))
      return `plan payments ${n}`
    }
    const o = meta.order_id ? order(meta.order_id) : (db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(obj.id) as Order | undefined)
    if (!o) return 'unknown order'
    const res = `fulfilled ${o.id}: ${fulfill(o.id, pi).did} players`
    if ((o as Order & { plan?: number }).plan) saveCard(o.id, pi).catch((e) => console.error('[plans] save card', e))
    return res
  }
  if (ev.type === 'checkout.session.expired') {
    // A pay-link checkout left unfinished; the offer itself stands until its deadline.
    if (meta.order_player_id) { db.prepare('UPDATE order_players SET offer_session_id = NULL WHERE id = ? AND offer_session_id = ?').run(meta.order_player_id, obj.id); return 'offer checkout expired' }
    const n = db.prepare(`UPDATE orders SET status = 'cancelled' WHERE stripe_session_id = ? AND status = 'pending'`).run(obj.id).changes
    if (n) { db.prepare(`UPDATE order_players SET status = 'cancelled' WHERE order_id = (SELECT id FROM orders WHERE stripe_session_id = ?) AND status = 'pending'`).run(obj.id); changed() }
    return n ? 'abandoned checkout cancelled' : 'nothing to cancel'
  }
  if (ev.type === 'charge.refunded') {
    const pi = obj.payment_intent as string
    const full = obj.amount_refunded === obj.amount
    const inst = db.prepare('SELECT order_id, seq FROM installments WHERE stripe_payment_id = ?').get(pi) as { order_id: string; seq: number } | undefined
    const o = (db.prepare('SELECT * FROM orders WHERE stripe_payment_id = ?').get(pi) ?? (inst ? order(inst.order_id) : undefined)) as Order | undefined
    if (!o) return 'refund for an unknown payment'
    if (inst && inst.seq > 1) {
      db.prepare(`UPDATE orders SET admin_notes = TRIM(admin_notes || ' ' || ?) WHERE id = ?`).run(`Plan payment ${inst.seq} ${full ? 'refunded' : 'partly refunded'} in Stripe (${((obj.amount_refunded as number) / 100).toFixed(2)}).`, o.id)
      changed()
      return 'plan payment refund noted'
    }
    // Refunds are flagged, not acted on: an admin decides whether the kid is withdrawn.
    db.prepare(`UPDATE orders SET status = CASE WHEN ? THEN 'refunded' ELSE status END, admin_notes = TRIM(admin_notes || ' ' || ?) WHERE id = ?`)
      .run(full ? 1 : 0, `${full ? 'Fully' : 'Partly'} refunded in Stripe (${((obj.amount_refunded as number) / 100).toFixed(2)}).`, o.id)
    audit('stripe', full ? 'order_refunded' : 'order_partly_refunded', null, null, { order: o.id })
    changed()
    return 'refund noted'
  }
  return 'ignored'
}

/** The thank-you page asks Stripe directly too, so a slow or missing webhook never leaves a paid family unregistered. */
export async function confirmFromReturn(orderId: string, sessionId: string | null) {
  const o = order(orderId)
  if (!o) throw new UserError('Unknown registration')
  if (sessionId && stripeConfigured()) {
    try {
      const s = await getCheckout(sessionId)
      if (s.payment_status === 'paid' && (s.metadata?.order_id === o.id)) {
        if (s.metadata.order_player_id) fulfillOffer(s.metadata.order_player_id, s.payment_intent)
        else if (s.metadata.installment_ids) { balancePaid(s.metadata.installment_ids.split(','), s.payment_intent); await saveCard(o.id, s.payment_intent).catch(() => {}) }
        else if (o.status === 'pending') { fulfill(o.id, s.payment_intent); if ((o as Order & { plan?: number }).plan) await saveCard(o.id, s.payment_intent).catch((e) => console.error('[plans] save card', e)) }
      }
    } catch (e) { console.error('[stripe] confirm on return failed', e) }
  }
  const fresh = order(orderId)!, c = mustCampaign(fresh.campaign_id)
  return {
    status: fresh.status, campaign: c.name, confirmation: c.confirmation, total_cents: fresh.total_cents,
    plan: (fresh as Order & { plan?: number; card_label?: string }).plan ? {
      card: (fresh as Order & { card_label?: string }).card_label || '', pay_url: payLink(fresh.id),
      installments: installmentsFor(fresh.id).map((i) => ({ seq: i.seq, due: i.due_date, cents: i.amount_cents, status: i.status })),
    } : null,
    players: players(orderId).map((p) => ({
      name: `${p.first_name} ${p.last_name}`, status: offerExpired(p) ? 'expired' : p.status, program: (db.prepare('SELECT name FROM offerings WHERE id = ?').get(p.offering_id) as { name: string }).name,
      ...(p.status === 'offered' && p.offer_token && !offerExpired(p) ? { pay_url: offerLink(c, p.offer_token, config.baseUrl), pay_by: longDate(p.offer_expires_at!) } : {}),
    })),
  }
}

// ---------- admin: orders ----------
export function adminCampaign(id: string) {
  const c = mustCampaign(id)
  const os = db.prepare('SELECT * FROM orders WHERE campaign_id = ? ORDER BY created_at DESC').all(id) as Order[]
  const ps = db.prepare('SELECT op.* FROM order_players op JOIN orders o ON o.id = op.order_id WHERE o.campaign_id = ?').all(id) as OrderPlayer[]
  const lines = db.prepare('SELECT ol.* FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.campaign_id = ?').all(id) as { order_player_id: string; name: string; qty: number; unit_cents: number; charged: number; tag: string }[]
  const offs = offerings(id)
  // Each program's waitlist, first come first served.
  const signedUp = new Map(os.map((o) => [o.id, o.created_at]))
  const now = new Date().toISOString()
  const waitlist = offs.map((o) => ({
    offering_id: o.id, program: o.name,
    players: ps.filter((p) => p.offering_id === o.id && ['waitlisted', 'offered'].includes(p.status))
      .sort((a, b) => (signedUp.get(a.order_id)! < signedUp.get(b.order_id)! ? -1 : signedUp.get(a.order_id)! > signedUp.get(b.order_id)! ? 1 : 0))
      .map((p, i) => {
        const g = J<CheckoutInput['guardian']>(os.find((x) => x.id === p.order_id)!.guardian, {} as CheckoutInput['guardian'])
        return { id: p.id, pos: i + 1, name: `${p.first_name} ${p.last_name}`, kid_id: p.kid_id, family: `${g.firstName} ${g.lastName}`, email: g.email, phone: g.phone,
          signed_up: signedUp.get(p.order_id), status: offerExpired(p, now) ? 'expired' : p.status, offer_expires_at: p.offer_expires_at,
          offer_url: p.status === 'offered' && p.offer_token ? offerLink(c, p.offer_token, config.baseUrl) : null,
          due_cents: lines.filter((l) => l.order_player_id === p.id).reduce((a, l) => a + l.unit_cents * l.qty, 0) }
      }),
  })).filter((w) => w.players.length)
  const pos = new Map(waitlist.flatMap((w) => w.players.map((p) => [p.id, p.pos] as const)))
  return {
    campaign: c, waitlist, mail: mailConfigured(), offerHours: OFFER_HOURS, url: `${config.baseUrl}/register/${c.slug}`, stripe: stripeConfigured() ? stripeMode() : null, webhook: !!config.stripe.webhookSecret,
    offerings: offs.map((o) => {
      const mine = ps.filter((p) => p.offering_id === o.id), reg = mine.filter((p) => p.status === 'registered')
      return { ...o, ...availability(o), registered: reg.length, new_registered: reg.filter((p) => !p.held_seat).length, returning_registered: reg.filter((p) => p.held_seat).length,
        waitlisted: mine.filter((p) => ['waitlisted', 'offered'].includes(p.status)).length, in_checkout: mine.filter((p) => p.status === 'pending').length }
    }),
    items: items(id).map((i) => ({ ...i, offering_ids: J<string[]>(i.offering_ids, []), sold: lines.filter((l) => l.name === i.name && l.charged).reduce((a, l) => a + l.qty, 0) })),
    questions: questions(id).map((q) => ({ ...q, options: J<string[]>(q.options, []), offering_ids: J<string[]>(q.offering_ids, []) })),
    totals: {
      paid: os.filter((o) => o.status === 'paid').reduce((a, o) => a + o.total_cents, 0),
      orders: os.filter((o) => o.status === 'paid').length, players: ps.filter((p) => p.status === 'registered').length,
      waitlisted: ps.filter((p) => ['waitlisted', 'offered'].includes(p.status)).length, pending: os.filter((o) => o.status === 'pending').length,
      unsynced: os.filter((o) => o.status === 'paid' && !o.se_synced_at).length,
    },
    orders: os.map((o) => ({
      ...o, guardian: J(o.guardian, {}), answers: J(o.answers, {}),
      players: ps.filter((p) => p.order_id === o.id).map((p) => ({ ...p, offer_token: undefined, wait_pos: pos.get(p.id) ?? null, answers: J(p.answers, {}), program: offs.find((x) => x.id === p.offering_id)?.name, lines: lines.filter((l) => l.order_player_id === p.id) })),
    })),
  }
}
export function markSynced(orderIds: string[], on: boolean, actor: string) {
  const up = db.prepare('UPDATE orders SET se_synced_at = ? WHERE id = ?')
  db.transaction(() => orderIds.forEach((id) => up.run(on ? new Date().toISOString() : null, id)))()
  audit(actor, on ? 'orders_marked_in_sportsengine' : 'orders_unmarked_sportsengine', null, null, { count: orderIds.length })
  changed()
}
export function setOrderNotes(id: string, notes: string) { db.prepare('UPDATE orders SET admin_notes = ? WHERE id = ?').run(notes, id); changed() }

/** One row per player with every answer and purchase, laid out for entering into SportsEngine. */
export function exportRows(id: string, onlyUnsynced: boolean): (string | number | null)[][] {
  const a = adminCampaign(id)
  const pq = a.questions.filter((q) => q.scope === 'player'), fq = a.questions.filter((q) => q.scope === 'family')
  const itemNames = a.items.map((i) => i.name)
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v === true ? 'Yes' : v == null ? '' : String(v))
  const head = ['Order', 'Order status', 'Paid at', 'In SportsEngine', 'Player first name', 'Player last name', 'Birthdate', 'Gender', 'Program', 'Player status', 'Played last season',
    'Parent first name', 'Parent last name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', ...itemNames, 'Amount paid', 'Trying out for Majors', ...fq.map((q) => q.label), ...pq.map((q) => q.label)]
  const rows: (string | number | null)[][] = [head]
  for (const o of a.orders) {
    if (!['paid', 'waitlisted'].includes(o.status) || (onlyUnsynced && o.se_synced_at)) continue
    const g = o.guardian as CheckoutInput['guardian']
    for (const p of o.players) {
      if (p.status === 'cancelled') continue
      const ans = p.answers as Record<string, unknown>, fans = o.answers as Record<string, unknown>
      rows.push([o.id, o.status, o.paid_at, o.se_synced_at ? 'Yes' : '', p.first_name, p.last_name, p.birthdate, p.gender, p.program ?? '', p.status, p.prior_match === 'new' ? 'No (family said new)' : p.prior_match ? 'Yes' : '',
        g.firstName, g.lastName, g.email, g.phone, g.address ?? '', g.city ?? '', g.state ?? '', g.zip ?? '',
        ...itemNames.map((n) => p.lines.filter((l) => l.name === n).reduce((s, l) => s + l.qty, 0) || ''),
        (p.lines.filter((l) => l.charged).reduce((s, l) => s + l.unit_cents * l.qty, 0) / 100).toFixed(2),
        ans[TRYOUT_ANSWER] === true ? 'Yes' : ans[TRYOUT_ANSWER] === false ? 'No' : '',
        ...fq.map((q) => fmt(fans[q.id])), ...pq.map((q) => fmt(ans[q.id]))])
    }
  }
  return rows
}

export const FAMILY_INTERESTS = ['Head coaching', 'Assistant coaching', 'Being a team mom', 'Sponsoring a capital project at the park — investing in the league’s future']

// All or nothing: one card, prepaid now or paid later — never a quantity.
export const VALUE_CARD = 'Prepay your $60 fundraiser value card now, or leave this unchecked and pay later.'

/** Seed a new campaign with the usual items and questions so admins start from something, not a blank page. */
export function seedDefaults(campaignId: string, actor: string) {
  const c = mustCampaign(campaignId)
  if (items(c.id).length || questions(c.id).length) return
  saveItem(c.id, null, { name: 'Registration fee', price_cents: 20000, required: true, sort: 1 }, actor)
  saveItem(c.id, null, { name: 'LFUCG', price_cents: 500, required: true, sort: 2 }, actor)
  saveItem(c.id, null, { name: 'Value card', description: VALUE_CARD, price_cents: 6000, sort: 3 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'select', label: 'Baseball experience', options: ['First season', '1–2 seasons', '3+ seasons', 'Travel / select ball'], required: true, new_only: true, sort: 1 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'text', label: 'Last team played for (if any)', new_only: true, sort: 2 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'select', label: 'Shirt size', options: ['Youth XS', 'Youth S', 'Youth M', 'Youth L', 'Youth XL', 'Adult S', 'Adult M', 'Adult L'], required: true, sort: 3 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'textarea', label: 'Medical conditions or allergies coaches should know about', sort: 4 }, actor)
  saveQuestion(c.id, null, { scope: 'player', type: 'textarea', label: 'Tell us a little about this player', help: 'Positions they like, what they want to work on, anything that helps their coach get to know them', sort: 5 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'multi', label: 'Are you interested in…', options: FAMILY_INTERESTS, sort: 1 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'text', label: 'Coaching or umpiring experience', help: 'Levels coached, certifications, years', sort: 2 }, actor)
  saveQuestion(c.id, null, { scope: 'family', type: 'agreement', label: 'I agree to the league’s participation waiver and code of conduct', required: true, sort: 9 }, actor)
}

export { ageIn }
