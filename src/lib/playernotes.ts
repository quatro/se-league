import { db } from '../db.js'
import { contactsFor } from './contacts.js'
import { audit, changed, enrollment, kid, kidHistory, mustSeason, UserError, division, team } from './league.js'
import { applyIntent, type Intent } from './outreach.js'

// The player sheet in a draft room: what's happening with one kid this season.
// The decision goes through applyIntent, so a family's own answer can't be overwritten.
// Notes go only into the audit log, so every entry keeps who wrote it and when.

export const NOTE_MAX = 1000

/** Latest note per kid for a season: kid_id -> { text, by, at }. */
export function lastNotes(seasonId: string) {
  const rows = db.prepare(`SELECT kid_id, actor, at, detail FROM audit WHERE action = 'player_note' AND season_id = ? ORDER BY id`).all(seasonId) as { kid_id: string; actor: string; at: string; detail: string }[]
  const out = new Map<string, { text: string; by: string; at: string }>()
  for (const r of rows) { try { out.set(r.kid_id, { text: JSON.parse(r.detail).text, by: r.actor, at: r.at }) } catch { /* skip bad row */ } }
  return out
}

export function playerSheet(enrollmentId: string) {
  const e = enrollment(enrollmentId) as (ReturnType<typeof enrollment> & { intent?: string | null; intent_at?: string | null; intent_by?: string | null }) | undefined
  if (!e) throw new UserError('Unknown player')
  const k = kid(e.kid_id)!, s = mustSeason(e.season_id)
  const back = e.returning_team_id ? team(e.returning_team_id) : e.team_id ? team(e.team_id) : undefined
  const hist = kidHistory(e.kid_id)
  return {
    id: e.id, kidId: k.id, name: k.name, season: { id: s.id, year: s.year },
    status: e.status, statusLocked: !!e.status_locked, returner: !!e.returner, prior: e.prior, notes: e.notes,
    division: e.division_id ? division(e.division_id)?.name ?? null : null, team: back?.name ?? null,
    intent: e.intent ?? null, intentBy: e.intent_by ?? null, intentAt: e.intent_at ?? null,
    contacts: contactsFor(k.id).map(({ name, email, phone, relation }) => ({ name, email, phone, relation })),
    seasons: hist.seasons.filter((x) => x.season !== s.id),
    // This season's trail, newest first.
    history: (hist.audit as { at: string; actor: string; action: string; season_id: string | null; detail: string }[])
      .filter((a) => a.season_id === s.id || a.season_id == null).slice(0, 100)
      .map((a) => { let d: unknown = a.detail; try { d = JSON.parse(a.detail) } catch { /* plain text */ } return { at: a.at, by: a.actor, action: a.action, detail: d } }),
  }
}

export function playerUpdate(enrollmentId: string, p: { decision?: Intent; note?: string }, actor: string, where = '') {
  const e = enrollment(enrollmentId)
  if (!e) throw new UserError('Unknown player')
  const note = (p.note ?? '').trim()
  if (!p.decision && !note) throw new UserError('Choose a decision or write a note')
  if (note.length > NOTE_MAX) throw new UserError(`Keep notes under ${NOTE_MAX} characters`)
  const run = db.transaction(() => {
    if (p.decision) {
      if (e.status === 'Registered') throw new UserError('Already registered — nothing to decide')
      applyIntent(e.season_id, e.kid_id, p.decision, actor)
    }
    if (note) audit(actor, 'player_note', e.season_id, e.kid_id, { text: note, ...(where ? { where } : {}) })
  })
  run()
  changed()
  return playerSheet(enrollmentId)
}
