import { db } from '../db.js'
import { slots, type EngineInput } from './engine.js'
import {
  ageIn, audit, changed, currentVersion, division, divisionTeams, draftFor, enrollment, mustSeason, refreshPools, season,
  UserError, type Draft, type Placement,
} from './league.js'

// Draft rooms, one per division per season.
//
//   standard  Majors, Minors, Rookie: returners stay on their teams, each team
//             owes (roster size − returners) picks, so teams that lost more
//             players get the later "comp" rounds. Straight or snake order.
//   blind     T-Ball: every kid in the pool gets a hidden random number; a
//             coach calls a number and that reveals the kid.
//
// A draft can hand off to a next one (Majors → Minors). Closing it moves every
// undrafted kid in its pool to the next draft, and the next draft can't make
// picks until the one before it is closed.

const OUT = ['Not returning', 'Withdrawn']

export const draft = (id: string) => db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Draft | undefined
export const draftByKey = (seasonId: string, key: string) =>
  db.prepare('SELECT * FROM drafts WHERE season_id = ? AND key = ?').get(seasonId, key) as Draft | undefined
export function mustDraft(id: string): Draft {
  const r = draft(id)
  if (!r) throw new UserError('Unknown draft')
  return r
}
const prevDraft = (r: Draft) => db.prepare('SELECT * FROM drafts WHERE next_id = ?').get(r.id) as Draft | undefined

interface PickRow { draft_id: string; slot_key: string; n: number; round: number; team_id: string; enrollment_id: string; at: number; took_ms: number | null; actor: string | null }
const picksOf = (draftId: string) => db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY n').all(draftId) as PickRow[]

function board(r: Draft) {
  const d = division(r.division_id)!
  const ts = divisionTeams(d.id)
  const keepers = db.prepare(`SELECT * FROM placements WHERE team_id IS NOT NULL AND division_id = ? AND picked_in IS NULL`).all(d.id) as Placement[]
  const keepersByTeam: Record<string, number> = {}
  for (const p of keepers) if (!OUT.includes(p.status) && p.team_id) keepersByTeam[p.team_id] = (keepersByTeam[p.team_id] ?? 0) + 1
  const input: EngineInput = { order: ts.map((t) => t.id), mode: r.mode, swap: JSON.parse(r.swap), rosterSize: d.roster_size, keepersByTeam }
  const sl = slots(input)
  const pk = picksOf(r.id)
  const taken = new Set(pk.map((p) => p.slot_key))
  const valid = new Set(sl.list.map((x) => x.key))
  return { d, ts, keepers, sl, pk, current: sl.list.find((x) => !taken.has(x.key)) ?? null, orphans: pk.filter((p) => !valid.has(p.slot_key)) }
}

/** Why picks can't be made right now, if they can't. */
function blocked(r: Draft): string | null {
  if (r.status === 'closed') return 'This draft is closed'
  const prev = prevDraft(r)
  if (prev && prev.status !== 'closed') return `Waiting for the ${division(prev.division_id)?.name ?? prev.key} draft to close`
  return null
}

/** Shape sent to draft rooms. Notes are admin-only; a blind draft hides who is behind each number until it's picked. */
export function draftState(id: string, isAdmin: boolean) {
  const r = mustDraft(id)
  const s = mustSeason(r.season_id)
  const b = board(r)
  const pool = db.prepare(`SELECT * FROM placements WHERE draft_id = ?`).all(r.id) as Placement[]
  const picked = db.prepare(`SELECT * FROM placements WHERE picked_in = ?`).all(r.id) as Placement[]
  const seen = new Map<string, Placement>()
  for (const p of [...b.keepers, ...pool, ...picked]) seen.set(p.id, p)
  const kids = new Map((db.prepare(`SELECT k.id, k.name, k.birthdate FROM kids k JOIN enrollments e ON e.kid_id = k.id WHERE e.season_id = ?`).all(s.id) as { id: string; name: string; birthdate: string | null }[]).map((k) => [k.id, k]))
  const numbers = new Map((db.prepare('SELECT number, enrollment_id FROM blind_numbers WHERE draft_id = ?').all(r.id) as { number: number; enrollment_id: string }[]).map((n) => [n.enrollment_id, n.number]))
  const pickedIds = new Set(b.pk.map((p) => p.enrollment_id))
  const prev = prevDraft(r), next = r.next_id ? draft(r.next_id) : undefined
  return {
    version: currentVersion(), canWrite: isAdmin, serverNow: Date.now(),
    season: { id: s.id, year: s.year },
    draft: {
      id: r.id, key: r.key, divisionId: b.d.id, name: b.d.name, format: r.format, status: r.status, mode: r.mode, swap: JSON.parse(r.swap), rosterSize: b.d.roster_size,
      blocked: blocked(r), prev: prev ? division(prev.division_id)?.name ?? prev.key : null, next: next ? division(next.division_id)?.name ?? next.key : null,
    },
    clock: { clockStart: r.clock_start, startedAt: r.started_at },
    teams: b.ts.map(({ id, name, color, fg, wins, losses, ties }) => ({ id, name, color, fg, record: wins != null && losses != null ? `${wins}–${losses}${ties ? `–${ties}` : ''}` : null })),
    players: [...seen.values()].map((p) => {
      const k = kids.get(p.kid_id)
      const kind = b.keepers.some((x) => x.id === p.id) ? 'returning' : 'pool'
      const hide = r.format === 'blind' && kind === 'pool' && !pickedIds.has(p.id)
      return {
        id: p.id, kind, teamId: kind === 'returning' ? p.team_id : null, number: numbers.get(p.id) ?? null,
        ...(hide ? { name: null, age: null, status: null, rank: null, hidden: true } : {
          name: k?.name ?? '?', age: ageIn(s, k?.birthdate ?? null, p.age), status: p.status, rank: p.rank, tryout: !!p.tryout, prior: p.prior,
          ...(isAdmin ? { notes: p.notes } : {}),
        }),
      }
    }),
    picks: b.pk.map((p) => ({ key: p.slot_key, n: p.n, round: p.round, team: p.team_id, player: p.enrollment_id, at: p.at, took: p.took_ms })),
    slots: b.sl.list, open: b.sl.open, maxRound: b.sl.max, minRound: b.sl.min,
    current: b.current, orphans: b.orphans.map((p) => p.slot_key),
    unnumbered: r.format === 'blind' ? pool.filter((p) => !numbers.has(p.id) && !OUT.includes(p.status)).length : 0,
  }
}

function touch(r: Draft, patch: Partial<Pick<Draft, 'clock_start' | 'started_at'>>) {
  db.prepare('UPDATE drafts SET clock_start = ?, started_at = ? WHERE id = ?').run(
    patch.clock_start !== undefined ? patch.clock_start : r.clock_start, patch.started_at !== undefined ? patch.started_at : r.started_at, r.id)
}

export function makePick(draftId: string, enrollmentId: string | null, actor: string, opts: { slot?: string; number?: number } = {}) {
  const res = db.transaction(() => {
    const r = mustDraft(draftId)
    const why = blocked(r)
    if (why) throw new UserError(why)
    const b = board(r)
    if (!b.ts.length) throw new UserError(`Add ${b.d.name} teams before drafting`)
    const slot = opts.slot ? b.sl.list.find((x) => x.key === opts.slot) : b.current
    if (!slot) throw new UserError(opts.slot ? 'That pick slot does not exist' : 'The draft is complete')
    if (b.pk.some((p) => p.slot_key === slot.key)) throw new UserError('That pick has already been made')
    if (opts.number != null) {
      const row = db.prepare('SELECT enrollment_id FROM blind_numbers WHERE draft_id = ? AND number = ?').get(r.id, opts.number) as { enrollment_id: string } | undefined
      if (!row) throw new UserError(`There is no number ${opts.number}`)
      enrollmentId = row.enrollment_id
    }
    const e = enrollmentId ? enrollment(enrollmentId) : undefined
    if (!e) throw new UserError('Unknown player')
    const name = (db.prepare('SELECT name FROM kids WHERE id = ?').get(e.kid_id) as { name: string }).name
    if (e.draft_id !== r.id) throw new UserError(`${name} isn't in this draft's pool`)
    if (OUT.includes(e.status)) throw new UserError(`${name} is marked ${e.status}`)
    if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ?').get(e.id)) throw new UserError(`${name} has already been drafted`)
    const now = Date.now()
    db.prepare('INSERT INTO picks (draft_id, slot_key, n, round, team_id, enrollment_id, at, took_ms, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, slot.key, slot.n, slot.round, slot.team, e.id, now, r.clock_start ? now - r.clock_start : null, actor)
    touch(r, { clock_start: now, started_at: r.started_at ?? now })
    const t = b.ts.find((x) => x.id === slot.team)!
    audit(actor, 'drafted', r.season_id, e.kid_id, { draft: b.d.name, team: t.name, round: slot.round, pick: slot.n, number: opts.number })
    return { message: opts.number != null ? `#${opts.number} is ${name} — ${t.name}` : `${t.name} take ${name}` }
  })()
  changed()
  return res
}

export function removePick(draftId: string, slotKey: string, actor: string) {
  const r = mustDraft(draftId)
  if (r.status === 'closed') throw new UserError('Reopen the draft to change picks')
  const p = db.prepare('SELECT * FROM picks WHERE draft_id = ? AND slot_key = ?').get(draftId, slotKey) as PickRow | undefined
  if (!p) throw new UserError('No pick in that slot')
  db.prepare('DELETE FROM picks WHERE draft_id = ? AND slot_key = ?').run(draftId, slotKey)
  touch(r, { clock_start: Date.now() })
  audit(actor, 'pick_removed', r.season_id, enrollment(p.enrollment_id)?.kid_id ?? null, { draft: r.key, slot: slotKey, n: p.n })
  refreshPools(r.season_id)
  changed()
}
export function undoLast(draftId: string, actor: string) {
  const last = db.prepare('SELECT * FROM picks WHERE draft_id = ? ORDER BY at DESC LIMIT 1').get(draftId) as PickRow | undefined
  if (!last) throw new UserError('No picks to undo')
  removePick(draftId, last.slot_key, actor)
}
export function replacePick(draftId: string, slotKey: string, enrollmentId: string, actor: string) {
  db.transaction(() => {
    const r = mustDraft(draftId)
    if (r.status === 'closed') throw new UserError('Reopen the draft to change picks')
    const p = db.prepare('SELECT * FROM picks WHERE draft_id = ? AND slot_key = ?').get(draftId, slotKey) as PickRow | undefined
    if (!p) throw new UserError('No pick in that slot')
    const e = enrollment(enrollmentId)
    if (!e || e.draft_id !== draftId) throw new UserError('Pick a player from this draft\'s pool')
    if (db.prepare('SELECT 1 FROM picks WHERE enrollment_id = ? AND NOT (draft_id = ? AND slot_key = ?)').get(enrollmentId, draftId, slotKey)) throw new UserError('Already drafted')
    db.prepare('UPDATE picks SET enrollment_id = ?, actor = ? WHERE draft_id = ? AND slot_key = ?').run(enrollmentId, actor, draftId, slotKey)
    audit(actor, 'pick_replaced', r.season_id, e.kid_id, { draft: r.key, slot: slotKey, previous: p.enrollment_id })
  })()
  refreshPools(mustDraft(draftId).season_id)
  changed()
}
export function clearPicks(draftId: string, actor: string) {
  const r = mustDraft(draftId)
  if (r.status === 'closed') throw new UserError('Reopen the draft first')
  const n = db.prepare('DELETE FROM picks WHERE draft_id = ?').run(draftId).changes
  touch(r, { clock_start: null, started_at: null })
  audit(actor, 'picks_cleared', r.season_id, null, { draft: r.key, count: n })
  refreshPools(r.season_id)
  changed()
}
export function startClock(draftId: string, actor: string) {
  const r = mustDraft(draftId), now = Date.now()
  touch(r, { clock_start: now, started_at: r.started_at ?? now })
  audit(actor, 'clock_started', r.season_id, null, { draft: r.key })
  changed()
}

export interface DraftInput { format?: 'standard' | 'blind'; mode?: 'straight' | 'snake'; swap?: [string, string]; nextId?: string | null }
export function saveDraft(seasonId: string, divisionId: string, p: DraftInput, actor: string) {
  const d = division(divisionId)
  if (!d || d.season_id !== seasonId) throw new UserError('Unknown division')
  let r = draftFor(divisionId)
  if (p.nextId && (p.nextId === r?.id || draft(p.nextId)?.season_id !== seasonId)) throw new UserError('Pick another draft in this season to hand off to')
  if (!r) {
    db.prepare('INSERT INTO drafts (id, season_id, division_id, key, format, mode, swap, next_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${seasonId}-${d.key}`, seasonId, divisionId, d.key, p.format ?? 'standard', p.mode ?? 'straight', JSON.stringify(p.swap ?? ['', '']), p.nextId ?? null)
    audit(actor, 'draft_added', seasonId, null, { division: d.name, format: p.format ?? 'standard' })
  } else {
    if (p.format && p.format !== r.format && picksOf(r.id).length) throw new UserError('Clear the picks before changing the draft format')
    db.prepare('UPDATE drafts SET format = ?, mode = ?, swap = ?, next_id = ? WHERE id = ?').run(p.format ?? r.format, p.mode ?? r.mode,
      p.swap ? JSON.stringify(p.swap) : r.swap, p.nextId !== undefined ? p.nextId : r.next_id, r.id)
    audit(actor, 'draft_saved', seasonId, null, { division: d.name, ...p })
  }
  r = draftFor(divisionId)!
  refreshPools(seasonId)
  changed()
  return r
}
export function deleteDraft(id: string, actor: string) {
  const r = mustDraft(id)
  if (picksOf(id).length) throw new UserError('This draft has picks — clear them first')
  db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
  audit(actor, 'draft_deleted', r.season_id, null, { draft: r.key })
  refreshPools(r.season_id)
  changed()
}

/**
 * Close a draft. Kids still in its pool move to the next draft (Majors →
 * Minors) — refreshPools does that, since a closed draft is skipped.
 */
export function closeDraft(id: string, actor: string) {
  const r = mustDraft(id)
  if (r.status === 'closed') throw new UserError('Already closed')
  const left = (db.prepare(`SELECT COUNT(*) n FROM enrollments WHERE draft_id = ? AND status NOT IN ('Not returning','Withdrawn')
    AND id NOT IN (SELECT enrollment_id FROM picks)`).get(id) as { n: number }).n
  db.prepare(`UPDATE drafts SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(id)
  refreshPools(r.season_id)
  const next = r.next_id ? draft(r.next_id) : undefined
  audit(actor, 'draft_closed', r.season_id, null, { draft: r.key, undrafted: left, movedTo: next?.key ?? null })
  changed()
  return { undrafted: left, next: next ? division(next.division_id)?.name ?? next.key : null }
}
export function reopenDraft(id: string, actor: string) {
  const r = mustDraft(id)
  if (r.status === 'open') throw new UserError('Already open')
  const next = r.next_id ? draft(r.next_id) : undefined
  if (next && picksOf(next.id).length) throw new UserError(`The ${division(next.division_id)?.name} draft has already started — clear its picks before reopening this one`)
  db.prepare(`UPDATE drafts SET status = 'open', closed_at = NULL WHERE id = ?`).run(id)
  refreshPools(r.season_id)
  audit(actor, 'draft_reopened', r.season_id, null, { draft: r.key })
  changed()
}

/**
 * Blind draft: give every kid in the pool without a number a random one,
 * continuing after the highest number already handed out (so a late
 * registration never changes anyone else's number).
 */
export function assignNumbers(id: string, actor: string) {
  const r = mustDraft(id)
  if (r.format !== 'blind') throw new UserError('Numbers are only for blind drafts')
  const pool = db.prepare(`SELECT id FROM enrollments WHERE draft_id = ? AND status NOT IN ('Not returning','Withdrawn')
    AND id NOT IN (SELECT enrollment_id FROM blind_numbers WHERE draft_id = ?)`).all(id, id) as { id: string }[]
  if (!pool.length) throw new UserError('Every kid in the pool already has a number')
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
  const start = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM blind_numbers WHERE draft_id = ?').get(id) as { m: number }).m
  const ins = db.prepare('INSERT INTO blind_numbers (draft_id, number, enrollment_id) VALUES (?, ?, ?)')
  db.transaction(() => pool.forEach((p, i) => ins.run(id, start + i + 1, p.id)))()
  audit(actor, 'numbers_assigned', r.season_id, null, { draft: r.key, count: pool.length, from: start + 1 })
  changed()
  return { assigned: pool.length, from: start + 1, to: start + pool.length }
}
/** Start the numbering over (only before the first pick). */
export function clearNumbers(id: string, actor: string) {
  const r = mustDraft(id)
  if (picksOf(id).length) throw new UserError('Picks have been made — numbers can no longer be reshuffled')
  db.prepare('DELETE FROM blind_numbers WHERE draft_id = ?').run(id)
  audit(actor, 'numbers_cleared', r.season_id, null, { draft: r.key })
  changed()
}

export { season }
