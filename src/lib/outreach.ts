import { randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { campaign, mustCampaign, returningMatches } from './campaigns.js'
import { audit, changed, mustSeason, updateEnrollment, UserError, type Enrollment, type Kid } from './league.js'
import { mailConfigured, sendBatch, type Mail } from './mailer.js'
import { STATUSES, uid, type Status } from './text.js'

// Outreach: asking returning families to register early, so the league knows
// its numbers sooner. Pick a season's divisions and which returners (usually
// Expected and Need to contact — anyone already Registered drops out on their
// own), and every parent email on file gets one message covering all of their
// kids, with a personal link that opens the registration form already filled
// in. Sending again later only reaches families who still haven't registered.

export interface Filter { divisionIds: string[]; statuses: Status[] }
export type Kind = 'register' | 'interest'
export interface OutreachInput extends Filter { seasonId: string; campaignId: string; subject: string; body: string; kind?: Kind }

export const DEFAULT_SUBJECT = 'Register {players} for {season} — returning players first'
export const DEFAULT_BODY = `Hi {parent_first},

Registration for the {season} season is open, and we're asking returning families to sign up first. The sooner we hear from you, the better we can plan teams for everyone.

{player_details}

Your personal link fills in the form for you:
{link}

If {players} won't be playing this year, just reply and let us know.

Thank you,
{league}`

// The interest check: one click per kid — no form, no payment — so the league hears early who's coming back.
export const INTEREST_SUBJECT = 'Is {players} playing in {season}?'
export const INTEREST_BODY = `Hi {parent_first},

We're planning teams for the {season} season and want to save a spot for every returning player. Will {players} be playing?

{answer_buttons}

One click is all it takes — registration comes later. Changed your mind? Just click again.

Thank you,
{league}`

const FIELDS = ['parent_first', 'parent', 'players', 'player_details', 'link', 'answer_buttons', 'season', 'league']
export type Intent = 'yes' | 'no' | 'unsure'
export const INTENT_LABEL: Record<Intent, string> = { yes: 'Yes, playing', no: 'Not this year', unsure: 'Not sure yet' }
const answerUrl = (token: string, kidId: string, a: Intent) => `${config.baseUrl}/interest/${token}?kid=${encodeURIComponent(kidId)}&a=${a}`

interface AudienceKid { id: string; name: string; division: string; team: string | null; status: Status }
export interface Family { email: string; name: string; kids: AudienceKid[] }

function filterOf(f: Partial<Filter>): Filter {
  const statuses = (f.statuses?.length ? f.statuses : ['Expected', 'Need to contact']).filter((s) => (STATUSES as readonly string[]).includes(s)) as Status[]
  return { divisionIds: f.divisionIds ?? [], statuses }
}

/** Who a filter reaches: families by email, plus the kids it matches who have no email on file. */
export function audience(seasonId: string, f: Partial<Filter>) {
  mustSeason(seasonId)
  const { divisionIds, statuses } = filterOf(f)
  const rows = db.prepare(`SELECT k.id, k.name, d.name AS division, t.name AS team, e.status, d.sort
    FROM enrollments e JOIN kids k ON k.id = e.kid_id JOIN divisions d ON d.id = e.division_id LEFT JOIN teams t ON t.id = e.team_id
    WHERE e.season_id = ? AND e.returner = 1 AND e.status IN (${statuses.map(() => '?').join(',')})
      ${divisionIds.length ? `AND e.division_id IN (${divisionIds.map(() => '?').join(',')})` : ''}
    ORDER BY d.sort, t.name, k.name`).all(seasonId, ...statuses, ...divisionIds) as (AudienceKid & { sort: number })[]
  const contacts = db.prepare(`SELECT name, email FROM contacts WHERE kid_id = ? AND email <> '' ORDER BY created_at, rowid`)
  const fams = new Map<string, Family>()
  const missing: AudienceKid[] = []
  for (const r of rows) {
    const kid: AudienceKid = { id: r.id, name: r.name, division: r.division, team: r.team, status: r.status }
    const cs = contacts.all(r.id) as { name: string; email: string }[]
    if (!cs.length) { missing.push(kid); continue }
    for (const c of cs) {
      const fam = fams.get(c.email) ?? { email: c.email, name: c.name, kids: [] }
      if (!fam.name) fam.name = c.name
      fam.kids.push(kid)
      fams.set(c.email, fam)
    }
  }
  return { families: [...fams.values()], missing, kids: rows.length }
}

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? ''
const listNames = (ns: string[]) => (ns.length <= 1 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`)
const linkFor = (slug: string, token: string) => `${config.baseUrl}/register/${encodeURIComponent(slug)}?invite=${token}`

function vars(fam: Family, link: string, year: number) {
  return {
    parent_first: firstName(fam.name) || 'there',
    parent: fam.name || 'there',
    players: listNames(fam.kids.map((k) => firstName(k.name))),
    player_details: fam.kids.map((k) => `• ${k.name} — ${k.division}${k.team ? `, ${k.team}` : ''}`).join('\n'),
    link, season: String(year), league: config.leagueName,
  } as Record<string, string>
}
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k]! : m))
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/** Plain text plus a simple HTML version: paragraphs, line breaks, and the personal link as a button. An interest check's {answer_buttons} becomes three buttons per kid. */
export function compose(subject: string, body: string, fam: Family, link: string, year: number, token = 'personal-link'): Mail {
  const v = vars(fam, link, year)
  const btn = (href: string, label: string, bg: string) => `<a href="${escHtml(href)}" style="display:inline-block;margin:4px 6px 4px 0;background:${bg};color:#fff;padding:9px 14px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">${escHtml(label)}</a>`
  const answersText = fam.kids.map((k) => `${k.name}:\n  ${INTENT_LABEL.yes} — ${answerUrl(token, k.id, 'yes')}\n  ${INTENT_LABEL.no} — ${answerUrl(token, k.id, 'no')}\n  ${INTENT_LABEL.unsure} — ${answerUrl(token, k.id, 'unsure')}`).join('\n\n')
  const answersHtml = fam.kids.map((k) => `<div style="margin:0 0 14px"><b>${escHtml(k.name)}</b> <span style="color:#5d6577">${escHtml(k.division)}${k.team ? ` · ${escHtml(k.team)}` : ''}</span><br>${
    btn(answerUrl(token, k.id, 'yes'), INTENT_LABEL.yes, '#1f7a4d')}${btn(answerUrl(token, k.id, 'no'), INTENT_LABEL.no, '#5d6577')}${btn(answerUrl(token, k.id, 'unsure'), INTENT_LABEL.unsure, '#b5651d')}</div>`).join('')
  const MARK = '\u0000answers\u0000'
  const text = fill(body, { ...v, answer_buttons: answersText })
  const forHtml = fill(body, { ...v, answer_buttons: MARK })
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213D;max-width:560px">${
    forHtml.split(/\n{2,}/).map((p) => p.trim() === MARK ? answersHtml : `<p>${p.trim().split('\n').map((line) => {
      // A line that is just the link becomes a button; elsewhere it's an ordinary link.
      if (line.trim() === link) return `<a href="${escHtml(link)}" style="display:inline-block;margin-top:6px;background:#14213D;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Register now</a>`
      return escHtml(line).replace(escHtml(link), `<a href="${escHtml(link)}">${escHtml(link)}</a>`)
    }).join('<br>')}</p>`).join('')}</div>`
  return { to: fam.email, subject: fill(subject, v).replace(/\s+/g, ' ').trim(), text, html }
}

function check(inp: OutreachInput) {
  const s = mustSeason(inp.seasonId)
  const c = mustCampaign(inp.campaignId)
  if (c.season_id !== s.id) throw new UserError(`${c.name} isn't a ${s.year} registration`)
  if (!inp.subject.trim() || !inp.body.trim()) throw new UserError('Write a subject and a message')
  if (inp.kind === 'interest') { if (!inp.body.includes('{answer_buttons}')) throw new UserError('Put {answer_buttons} in the message — it’s where each family clicks their answer') }
  else if (!inp.body.includes('{link}')) throw new UserError('Put {link} in the message — it is each family’s personal registration link')
  const unknown = [...inp.body.matchAll(/\{(\w+)\}/g), ...inp.subject.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => !FIELDS.includes(k))
  if (unknown.length) throw new UserError(`Unknown field {${unknown[0]}} — use ${FIELDS.map((f) => `{${f}}`).join(', ')}`)
  return { s, c }
}

/** What the admin sees before sending: counts, the kids with no email on file, and the first family's message. */
export function preview(inp: OutreachInput) {
  const s = mustSeason(inp.seasonId)
  const a = audience(inp.seasonId, inp)
  const c = inp.campaignId ? campaign(inp.campaignId) : undefined
  const sample = a.families[0] && c ? compose(inp.subject, inp.body, a.families[0], linkFor(c.slug, 'personal-link'), s.year) : null
  return {
    families: a.families.length, kids: a.kids, reached: a.kids - a.missing.length, missing: a.missing,
    sample, mail: mailConfigured() ? { from: config.mail.from } : null,
  }
}

const token = () => randomBytes(18).toString('base64url')

/** Record an outreach and one message per family. Nothing is sent yet. */
export function createOutreach(inp: OutreachInput, actor: string): string {
  check(inp)
  const a = audience(inp.seasonId, inp)
  if (!a.families.length) throw new UserError(a.kids ? 'None of these families have an email on file yet' : 'No returning players match — everyone may already be registered')
  const id = uid()
  db.transaction(() => {
    db.prepare('INSERT INTO outreach (id, season_id, campaign_id, subject, body, filter, created_by, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, inp.seasonId, inp.campaignId, inp.subject.trim(), inp.body, JSON.stringify(filterOf(inp)), actor, inp.kind ?? 'register')
    const ins = db.prepare('INSERT INTO outreach_messages (id, outreach_id, email, name, kid_ids, token) VALUES (?, ?, ?, ?, ?, ?)')
    for (const f of a.families) ins.run(uid(), id, f.email, f.name, JSON.stringify(f.kids.map((k) => k.id)), token())
  })()
  return id
}

interface Msg { id: string; outreach_id: string; email: string; name: string; kid_ids: string; token: string; status: string; error: string; sent_at: string | null; clicked_at: string | null }
interface Outreach { id: string; season_id: string; campaign_id: string; subject: string; body: string; filter: string; created_by: string; created_at: string; kind: Kind }
const outreach = (id: string) => db.prepare('SELECT * FROM outreach WHERE id = ?').get(id) as Outreach | undefined
function mustOutreach(id: string) { const o = outreach(id); if (!o) throw new UserError('Unknown outreach'); return o }

/** A message's family as it stands now (kids who registered since are left out of a retry). */
function familyOf(m: Msg): Family {
  const ids = JSON.parse(m.kid_ids) as string[]
  const o = outreach(m.outreach_id)!
  const kids = ids.map((id) => db.prepare(`SELECT k.id, k.name, d.name AS division, t.name AS team, e.status FROM enrollments e JOIN kids k ON k.id = e.kid_id
    JOIN divisions d ON d.id = e.division_id LEFT JOIN teams t ON t.id = e.team_id WHERE e.season_id = ? AND e.kid_id = ?`).get(o.season_id, id) as AudienceKid | undefined).filter(Boolean) as AudienceKid[]
  return { email: m.email, name: m.name, kids }
}

const sending = new Set<string>()

/** Send every message not yet sent (new ones, and any that failed before). Exported ones are left alone — those families were mailed some other way. */
export async function sendOutreach(id: string, actor: string) {
  const o = mustOutreach(id)
  if (!mailConfigured()) throw new UserError('Email isn’t set up yet — export the list with personal links instead')
  if (sending.has(id)) throw new UserError('Already sending — give it a moment')
  sending.add(id)
  try {
    const s = mustSeason(o.season_id), c = mustCampaign(o.campaign_id)
    const todo = (db.prepare(`SELECT * FROM outreach_messages WHERE outreach_id = ? AND status IN ('queued','failed')`).all(id) as Msg[])
      .map((m) => ({ m, fam: familyOf(m) })).filter((x) => x.fam.kids.some((k) => k.status !== 'Registered'))
    let sent = 0, failed = 0
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100)
      const out = await sendBatch(chunk.map(({ m, fam }) => compose(o.subject, o.body, fam, linkFor(c.slug, m.token), s.year, m.token)))
      db.transaction(() => chunk.forEach(({ m, fam }, j) => {
        const r = out[j]!
        db.prepare(`UPDATE outreach_messages SET status = ?, provider_id = ?, error = ?, sent_at = CASE WHEN ? THEN datetime('now') ELSE sent_at END WHERE id = ?`)
          .run(r.ok ? 'sent' : 'failed', r.id, r.error, r.ok ? 1 : 0, m.id)
        if (r.ok) { sent++; for (const k of fam.kids) audit(actor, 'outreach_emailed', o.season_id, k.id, { to: m.email, subject: o.subject }) } else failed++
      }))()
    }
    audit(actor, 'outreach_sent', o.season_id, null, { outreach: id, sent, failed })
    changed()
    return { sent, failed, error: failed ? (db.prepare(`SELECT error FROM outreach_messages WHERE outreach_id = ? AND status = 'failed' LIMIT 1`).get(id) as { error: string }).error : '' }
  } finally { sending.delete(id) }
}

/** One message to an admin's own address, with the first family's details, to check how it reads. */
export async function sendTest(inp: OutreachInput, to: string) {
  const { s, c } = check(inp)
  if (!mailConfigured()) throw new UserError('Email isn’t set up yet')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new UserError('Enter the address to send the test to')
  const fam = audience(inp.seasonId, inp).families[0] ?? { email: to, name: 'Pat Parent', kids: [{ id: '', name: 'Sample Player', division: 'Majors', team: 'Reds', status: 'Expected' as Status }] }
  const mail = compose(inp.subject, inp.body, { ...fam, email: to }, linkFor(c.slug, 'test-link'), s.year)
  const [r] = await sendBatch([{ ...mail, subject: `[Test] ${mail.subject}` }])
  if (!r!.ok) throw new UserError(`Test didn’t send: ${r!.error}`)
  return { ok: true, message: `Test sent to ${to}` }
}

/** The list as CSV — email, parent, players, message, personal link — for sending from another tool. Marks unsent messages as exported. */
export function exportOutreach(id: string): string[][] {
  const o = mustOutreach(id), s = mustSeason(o.season_id), c = mustCampaign(o.campaign_id)
  const msgs = db.prepare('SELECT * FROM outreach_messages WHERE outreach_id = ? ORDER BY email').all(id) as Msg[]
  db.prepare(`UPDATE outreach_messages SET status = 'exported' WHERE outreach_id = ? AND status = 'queued'`).run(id)
  const rows = [['Email', 'Parent', 'Players', 'Subject', 'Message', 'Personal link', 'Status']]
  for (const m of msgs) {
    const fam = familyOf(m), link = linkFor(c.slug, m.token), mail = compose(o.subject, o.body, fam, link, s.year, m.token)
    rows.push([m.email, m.name, fam.kids.map((k) => k.name).join('; '), mail.subject, mail.text, o.kind === 'interest' ? `${config.baseUrl}/interest/${m.token}` : link, m.status === 'queued' ? 'exported' : m.status])
  }
  return rows
}

/** Sent outreach for a season, newest first, with how it's doing. */
export function listOutreach(seasonId: string) {
  const os = db.prepare('SELECT * FROM outreach WHERE season_id = ? ORDER BY created_at DESC, rowid DESC').all(seasonId) as Outreach[]
  return os.map((o) => {
    const ms = db.prepare('SELECT * FROM outreach_messages WHERE outreach_id = ?').all(o.id) as Msg[]
    const kidIds = [...new Set(ms.flatMap((m) => JSON.parse(m.kid_ids) as string[]))]
    const registered = kidIds.filter((k) => db.prepare(`SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ? AND status = 'Registered'`).get(o.season_id, k)).length
    const n = (st: string) => ms.filter((m) => m.status === st).length
    // An interest check's answers, kid by kid (answered on or after the day it was sent; later answers win).
    const answers = { yes: 0, no: 0, unsure: 0, none: 0 }
    if (o.kind === 'interest') for (const k of kidIds) {
      const e = db.prepare('SELECT intent, intent_at FROM enrollments WHERE season_id = ? AND kid_id = ?').get(o.season_id, k) as { intent: string; intent_at: string | null } | undefined
      const a = e?.intent && e.intent_at && e.intent_at >= o.created_at.replace(' ', 'T') ? e.intent as Intent : null
      answers[a ?? 'none']++
    }
    return {
      id: o.id, kind: o.kind, answers, subject: o.subject, created_at: o.created_at, created_by: o.created_by, campaign: campaign(o.campaign_id)?.name ?? '', filter: JSON.parse(o.filter) as Filter,
      families: ms.length, sent: n('sent'), failed: n('failed'), exported: n('exported'), queued: n('queued'),
      clicked: ms.filter((m) => m.clicked_at).length, kids: kidIds.length, registered,
    }
  })
}

/** One outreach, family by family. */
export function outreachDetail(id: string) {
  const o = mustOutreach(id)
  const ms = db.prepare('SELECT * FROM outreach_messages WHERE outreach_id = ? ORDER BY email').all(id) as Msg[]
  return {
    ...listOutreach(o.season_id).find((x) => x.id === id)!, body: o.body,
    messages: ms.map((m) => {
      const kids = (JSON.parse(m.kid_ids) as string[]).map((k) => {
        const r = db.prepare(`SELECT k.name, e.status, e.intent, e.intent_at FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = ? AND e.kid_id = ?`).get(o.season_id, k) as { name: string; status: string; intent: string; intent_at: string | null } | undefined
        return { id: k, name: r?.name ?? '?', status: r?.status ?? '', intent: r?.intent ?? '', intent_at: r?.intent_at ?? null }
      })
      return { email: m.email, name: m.name, status: m.status, error: m.error, sent_at: m.sent_at, clicked_at: m.clicked_at, kids }
    }),
  }
}

/**
 * A family opening their personal link: what to pre-fill the form with. Only
 * kids not yet registered; the form still asks them to confirm each returning
 * player, exactly as if they had typed the names in themselves.
 */
export function invite(slugStr: string, tok: string) {
  const m = db.prepare('SELECT * FROM outreach_messages WHERE token = ?').get(tok) as Msg | undefined
  const o = m && outreach(m.outreach_id)
  const c = o && campaign(o.campaign_id)
  if (!m || !c || c.slug !== slugStr) throw new UserError('This registration link isn’t valid — you can still register below')
  if (!m.clicked_at) db.prepare(`UPDATE outreach_messages SET clicked_at = datetime('now') WHERE id = ?`).run(m.id)
  const [gFirst = '', ...gRest] = m.name.trim().split(/\s+/)
  const players = (JSON.parse(m.kid_ids) as string[]).flatMap((kidId) => {
    const k = db.prepare('SELECT * FROM kids WHERE id = ?').get(kidId) as Kid | undefined
    if (!k || db.prepare(`SELECT 1 FROM enrollments WHERE season_id = ? AND kid_id = ? AND status = 'Registered'`).get(o.season_id, kidId)) return []
    const [first = '', ...rest] = k.name.split(/\s+/)
    const returning = k.birthdate && returningMatches(c, first, rest.join(' '), k.birthdate).some((x) => x.id === k.id) ? k.id : undefined
    return [{ firstName: first, lastName: rest.join(' '), birthdate: k.birthdate ?? '', returning }]
  })
  return { guardian: { firstName: gFirst, lastName: gRest.join(' '), email: m.email }, players }
}

/* ---------- interest check: the family's answers ---------- */
const msgByToken = (tok: string) => db.prepare('SELECT * FROM outreach_messages WHERE token = ?').get(tok) as Msg | undefined

/** The answer page: this family's kids and what they've said so far. */
export function interestPage(tok: string) {
  const m = msgByToken(tok), o = m && outreach(m.outreach_id)
  if (!m || !o) throw new UserError('This link isn’t valid. Please check the email we sent, or contact the league.')
  if (!m.clicked_at) db.prepare(`UPDATE outreach_messages SET clicked_at = datetime('now') WHERE id = ?`).run(m.id)
  const s = mustSeason(o.season_id), c = campaign(o.campaign_id)
  const kids = (JSON.parse(m.kid_ids) as string[]).flatMap((id) => {
    const r = db.prepare(`SELECT k.id, k.name, d.name AS division, t.name AS team, e.status, e.intent FROM enrollments e JOIN kids k ON k.id = e.kid_id
      LEFT JOIN divisions d ON d.id = e.division_id LEFT JOIN teams t ON t.id = e.team_id WHERE e.season_id = ? AND e.kid_id = ?`).get(o.season_id, id) as
      { id: string; name: string; division: string | null; team: string | null; status: string; intent: string } | undefined
    return r ? [{ id: r.id, name: r.name, division: r.division, team: r.team, registered: r.status === 'Registered', intent: r.intent || null }] : []
  })
  return { league: config.leagueName, season: s.year, parent: firstName(m.name), kids,
    // Registration open? Then the thank-you can offer their personal link straight away.
    register: c && c.status === 'open' ? linkFor(c.slug, m.token) : null }
}

/**
 * Record a family's answers. "Not this year" frees the seat held for them (Not returning); "Yes" puts a
 * Need-to-contact kid back to Expected; "Not sure" marks them Need to contact. An admin-locked status is
 * left alone (only the answer is kept), and so is anyone already Registered.
 */
export function answerInterest(tok: string, answers: { kidId: string; intent: Intent }[]) {
  const m = msgByToken(tok), o = m && outreach(m.outreach_id)
  if (!m || !o) throw new UserError('This link isn’t valid. Please check the email we sent, or contact the league.')
  const mine = new Set(JSON.parse(m.kid_ids) as string[])
  let saved = 0
  db.transaction(() => {
    for (const a of answers) {
      if (!mine.has(a.kidId)) throw new UserError('That player isn’t on this link')
      if (applyIntent(o.season_id, a.kidId, a.intent, `family:${m.email}`)) saved++
    }
  })()
  changed()
  return { saved }
}

/**
 * A family's answer for one kid, from an interest email or the registration form. "Not this year" frees the
 * seat held for them; "Yes" puts a Need-to-contact kid back to Expected; "Not sure" marks Need to contact.
 * An admin-locked status keeps only the answer; anyone already Registered is left alone.
 */
export function applyIntent(seasonId: string, kidId: string, intent: Intent, actor: string): boolean {
  const e = db.prepare('SELECT * FROM enrollments WHERE season_id = ? AND kid_id = ?').get(seasonId, kidId) as (Enrollment & { intent: string }) | undefined
  if (!e || e.status === 'Registered') return false
  const prev = e.intent
  const by = actor.startsWith('family:') ? 'family' : actor.startsWith('coach:') ? 'coach' : 'league'
  // A coach or the league passing on an answer never overwrites what the family told us directly.
  if (by !== 'family' && (e as { intent_by?: string }).intent_by === 'family' && prev && prev !== intent) throw new UserError('The family already answered this themselves — ask the league to change it')
  db.prepare(`UPDATE enrollments SET intent = ?, intent_at = ?, intent_by = ? WHERE id = ?`).run(intent, new Date().toISOString(), by, e.id)
  const undoNo = e.status === 'Not returning' && prev === 'no'
  const to = intent === 'no' ? (['Expected', 'Need to contact'].includes(e.status) ? 'Not returning' : null)
    : intent === 'yes' ? (e.status === 'Need to contact' || undoNo ? 'Expected' : null)
    : (e.status === 'Expected' || undoNo ? 'Need to contact' : null)
  if (to && !e.status_locked) updateEnrollment(e.id, { status: to }, actor)
  audit(actor, 'interest_answered', seasonId, kidId, { answer: intent, status: to ?? e.status })
  return true
}
