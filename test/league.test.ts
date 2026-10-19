import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-'))
process.env.DB_PATH = path.join(dir, 'league.db')
const L = await import('../src/lib/league.js')
const D = await import('../src/lib/drafts.js')
const SE = await import('../src/lib/sportsengine.js')
const { rollover, previewRollover, nextDivision: next } = await import('../src/lib/rollover.js')
const { importRosters } = await import('../src/lib/rosters.js')
const { db } = await import('../src/db.js')

const A = 'test'
const div = (s: string, key: string) => L.divisionByKey(s, key)!
const enr = (s: string, name: string) => db.prepare('SELECT e.* FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.season_id = ? AND k.name = ?').get(s, name) as L.Enrollment
const place = (s: string, name: string) => L.placement(enr(s, name).id)!
const draft = (s: string, key: string) => D.draftByKey(s, key)!
const pool = (s: string, key: string) => (db.prepare(`SELECT k.name FROM enrollments e JOIN kids k ON k.id = e.kid_id WHERE e.draft_id = ?
  AND e.id NOT IN (SELECT enrollment_id FROM picks) ORDER BY k.name`).all(draft(s, key).id) as { name: string }[]).map((r) => r.name)
const register = (first: string, last: string, program: string, dob?: string) => {
  const payload = { id: `e-${first}-${last}-${Math.random()}`, season: '2027', program_name: program, participant: { first_name: first, last_name: last, date_of_birth: dob } }
  const { id } = SE.storeRegistration('webhook', JSON.stringify(payload), payload, false)
  return SE.processRegistration(id)
}

test('2026: league structure, rosters and records', () => {
  db.prepare(`INSERT INTO seasons (id, year, status) VALUES ('2026', 2026, 'complete')`).run()
  const mk = (key: string, name: string, min: number, max: number, extra: Partial<L.DivisionInput> = {}) =>
    L.saveDivision('2026', null, { key, name, teams: 2, roster_size: 3, min_age: min, max_age: max, ...extra }, A)
  mk('tball', 'T-Ball', 5, 6)
  mk('rookie', 'Rookie', 7, 8, { keep_teams: true, se_match: 'rookie' })
  mk('nine', '9-Year-Old League', 9, 9)
  mk('minors', 'Minors', 10, 12, { keep_teams: true, group_key: '10-12', se_match: 'minor, major' })
  mk('majors', 'Majors', 10, 12, { keep_teams: true, group_key: '10-12', se_match: '-' })
  for (const k of ['tball', 'rookie', 'minors', 'majors']) D.saveDraft('2026', div('2026', k).id, { format: k === 'tball' ? 'blind' : 'standard' }, A)
  D.saveDraft('2026', div('2026', 'majors').id, { nextId: draft('2026', 'minors').id }, A)
  const r = importRosters('2026', [
    'Name,Birthdate,Division,Team',
    'Tee Six,2020-01-01,T-Ball,Bees',        // 6 in 2026 → 7: Rookie, no team (T-Ball doesn't keep teams)
    'Rook Seven,2019-01-01,Rookie,Cubs',     // 7 → 8: stays on Cubs
    'Rook Eight,2018-01-01,Rookie,Cubs',     // 8 → 9: 9-Year-Old League
    'Nina Nine,2017-01-01,9-Year-Old League,', // 9 → 10: Minors/Majors pool, trying out
    'Min Eleven,2015-06-01,Minors,Tigers',   // 10 → 11: stays on Tigers
    'Min Try,2015-07-01,Minors,Tigers',      // 10 → 11: stays on Tigers (will try out in 2027)
    'Maj Twelve,2014-06-01,Majors,Reds',     // 11 → 12: stays on Reds
    'Maj Old,2013-06-01,Majors,Reds',        // 12 → 13: graduates
  ].join('\n'), A)
  assert.equal(r.added, 8)
  assert.equal(r.teamsCreated, 4)
  const cubs = L.divisionTeams(div('2026', 'rookie').id).find((t) => t.name === 'Cubs')!
  L.saveTeam(cubs.division_id, cubs.id, { name: 'Cubs', wins: 10, losses: 2 }, A)
  L.saveTeam(cubs.division_id, null, { name: 'Sox', wins: 3, losses: 9 }, A)
})

test('rollover 2026 → 2027: returners keep teams, others move up by age, too old graduate', () => {
  const p = previewRollover('2026')
  assert.deepEqual({ r: p.returning, up: p.movingUp, grad: p.graduating }, { r: 4, up: 3, grad: 1 })
  rollover('2026', A)
  assert.equal(L.season('2026')!.status, 'complete')
  assert.equal(L.currentSeason()!.id, '2027')
  const teamName = (e: L.Enrollment) => (e.team_id ? L.team(e.team_id)!.name : null)
  assert.equal(teamName(enr('2027', 'Rook Seven')), 'Cubs')
  assert.equal(enr('2027', 'Rook Eight').division_id, div('2027', 'nine').id)
  assert.equal(enr('2027', 'Tee Six').division_id, div('2027', 'rookie').id)
  assert.equal(enr('2027', 'Tee Six').draft_id, draft('2027', 'rookie').id)
  assert.equal(teamName(enr('2027', 'Min Eleven')), 'Tigers')
  assert.equal(teamName(enr('2027', 'Maj Twelve')), 'Reds')
  assert.equal(enr('2027', 'Maj Old'), undefined)
  // A 9 turning 10 lands in the shared pool and tries out for Majors first.
  assert.equal(enr('2027', 'Nina Nine').division_id, div('2027', 'minors').id)
  assert.equal(enr('2027', 'Nina Nine').tryout, 1)
  assert.equal(enr('2027', 'Nina Nine').draft_id, draft('2027', 'majors').id)
  assert.equal(enr('2027', 'Rook Seven').prior, 'Rookie · Cubs (2026)')
  assert.equal(enr('2027', 'Rook Seven').status, 'Expected')
})

test('Wee Ball is a one-year stop: a returner still Wee Ball age moves up to T-Ball, at risk', () => {
  const d = (key: string, min: number, max: number, keep = 0) => ({ id: key, key, name: key, min_age: min, max_age: max, keep_teams: keep, se_match: '', group_key: '' }) as unknown as L.Division
  const wee = d('wee', 3, 4), tee = d('tee', 5, 6, 1), rook = d('rook', 7, 8, 1), divs = [wee, tee, rook]
  assert.deepEqual(next(wee, divs, 4, false), { target: tee, stays: false, early: true })
  assert.deepEqual(next(wee, divs, null, false), { target: tee, stays: false, early: true }, 'no age on file: still no repeat year')
  assert.deepEqual(next(wee, divs, 5, false), { target: tee, stays: false, early: false })
  assert.deepEqual(next(tee, divs, 6, true), { target: tee, stays: true, early: false }, 'T-Ball keeps teams: a 6 stays')
  assert.deepEqual(next(tee, divs, 7, true), { target: rook, stays: false, early: false })
})

test('draft order from last season’s records: worst record first', () => {
  L.orderByLastRecord(div('2027', 'rookie').id, A)
  assert.deepEqual(L.divisionTeams(div('2027', 'rookie').id).map((t) => t.name), ['Sox', 'Cubs'])
})

test('registration: "Major/Minor" goes to the shared pool and tries out; other programs place directly', () => {
  assert.equal(register('New', 'Ten', 'Major/Minor 2027', '2016-06-01').outcome, 'placed')
  assert.equal(enr('2027', 'New Ten').division_id, div('2027', 'minors').id)
  assert.equal(enr('2027', 'New Ten').draft_id, draft('2027', 'majors').id)
  assert.equal(register('Rook', 'Seven', 'Rookie').outcome, 'returner')
  assert.equal(enr('2027', 'Rook Seven').status, 'Registered')
  // A Majors returner registering for "Major/Minor" stays on their Majors team.
  register('Maj', 'Twelve', 'Major/Minor')
  assert.equal(L.team(enr('2027', 'Maj Twelve').team_id!)!.name, 'Reds')
})

test('tryouts: a Minors returner trying out leaves their team; one who doesn’t stays', () => {
  const tigers = enr('2027', 'Min Try').team_id!
  L.setTryout(enr('2027', 'Min Try').id, true, A)
  assert.equal(enr('2027', 'Min Try').team_id, null)
  assert.equal(enr('2027', 'Min Try').returning_team_id, tigers)
  assert.equal(enr('2027', 'Min Eleven').draft_id, null)
  // A 9 in the 9-Year-Old League can try out too.
  L.setTryout(enr('2027', 'Rook Eight').id, true, A)
  assert.deepEqual(pool('2027', 'majors'), ['Min Try', 'New Ten', 'Nina Nine', 'Rook Eight'])
  // Minors draft is waiting on Majors.
  assert.throws(() => D.makePick(draft('2027', 'minors').id, enr('2027', 'Min Eleven').id, A), /Waiting for the Majors draft/)
})

test('Majors draft: picks move kids to Majors; closing sends the rest to the Minors draft', () => {
  const maj = draft('2027', 'majors').id
  L.saveTeam(div('2027', 'majors').id, null, { name: 'Cards' }, A)
  const st = D.draftState(maj, true)
  // Reds have one returner, the other Majors team none → 2 + 3 picks owed.
  assert.equal(st.slots.length, 5)
  D.makePick(maj, enr('2027', 'Nina Nine').id, A)
  assert.equal(place('2027', 'Nina Nine').eff_division_id, div('2027', 'majors').id)
  assert.throws(() => D.makePick(maj, enr('2027', 'Min Eleven').id, A), /isn't in this draft's pool/)
  const g = L.seasonState('2027', false).groups[0]!
  assert.equal(g.seats.capacity, 12)
  const r = D.closeDraft(maj, A)
  assert.equal(r.undrafted, 3)
  // Undrafted tryouts (including the Minors returner) go to the Minors draft, not back to the old team; the 9 goes too.
  assert.deepEqual(pool('2027', 'minors'), ['Min Try', 'New Ten', 'Rook Eight'])
  assert.equal(enr('2027', 'Min Try').team_id, null)
})

test('Minors draft: undrafted 9s stay in their own league', () => {
  const min = draft('2027', 'minors').id
  D.makePick(min, enr('2027', 'Min Try').id, A)
  assert.equal(place('2027', 'Min Try').eff_division_id, div('2027', 'minors').id)
  assert.throws(() => D.reopenDraft(draft('2027', 'majors').id, A), /already started/)
  D.closeDraft(min, A)
  assert.equal(enr('2027', 'Rook Eight').draft_id, null)
  assert.equal(place('2027', 'Rook Eight').eff_division_id, div('2027', 'nine').id)
})

test('blind draft: numbers hide the kid until picked', () => {
  const tb = draft('2027', 'tball').id
  register('Tee', 'One', 'T-Ball'); register('Tee', 'Two', 'T-Ball'); register('Tee', 'Three', 'T-Ball')
  const a = D.assignNumbers(tb, A)
  assert.deepEqual([a.from, a.to], [1, 3])
  const before = D.draftState(tb, true)
  assert.ok(before.players.filter((x) => x.kind === 'pool').every((x) => x.hidden && x.name === null && x.number))
  const res = D.makePick(tb, null, A, { number: 2 })
  assert.match(res.message, /^#2 is Tee (One|Two|Three) — /)
  const after = D.draftState(tb, true)
  assert.equal(after.players.filter((x) => !x.hidden && x.kind === 'pool').length, 1)
  // A late registration gets the next number; nobody else's changes.
  register('Tee', 'Late', 'T-Ball')
  assert.deepEqual(D.assignNumbers(tb, A), { assigned: 1, from: 4, to: 4 })
  assert.throws(() => D.clearNumbers(tb, A), /no longer be reshuffled/)
})

test('admin move is pinned against a re-run registration', () => {
  const r = register('Wrong', 'Pick', 'Rookie', '2021-02-01') // a 6-year-old registered for Rookie
  assert.match(r.note, /outside Rookie/)
  L.moveEnrollment(enr('2027', 'Wrong Pick').id, div('2027', 'tball').id, A, 'picked the wrong program')
  const regId = (db.prepare(`SELECT id FROM registrations WHERE first_name = 'Wrong'`).get() as { id: number }).id
  const again = SE.processRegistration(regId)
  assert.equal(enr('2027', 'Wrong Pick').division_id, div('2027', 'tball').id)
  assert.match(again.note, /kept in T-Ball \(placed by an admin\)/)
})

test('kid history spans seasons', () => {
  const k = enr('2027', 'Min Try').kid_id
  const h = L.kidHistory(k)
  assert.deepEqual(h.seasons.map((s) => [s.year, s.division, s.team]), [[2026, 'Minors', 'Tigers'], [2027, 'Minors', h.seasons[1]!.team]])
  assert.match(h.seasons[1]!.how, /^Drafted/)
})

test('late 2026 rosters carry into 2027 as returners', () => {
  const r = importRosters('2026', 'Name,Birthdate,Division,Team\nLate Minor,2016-02-01,Minors,Tigers', A)
  assert.equal(r.carried, 1)
  assert.equal(L.team(enr('2027', 'Late Minor').team_id!)!.name, 'Tigers')
})

test('late rosters create returners\' teams the next season lacks, and playing-up kids keep the higher team', () => {
  const r = importRosters('2026', [
    'Name,Birthdate,Division,Team',
    'Young Rookie,2019-03-01,Rookie,Mudcats',
    'Up Nine,2017-02-01,9-Year-Old League,Cubs',
    'Up Nine,2017-02-01,Majors,Reds',
  ].join('\n'), A)
  assert.equal(r.carried, 2)
  assert.deepEqual(r.playingUp, ['Up Nine: Majors · Reds (also 9-Year-Old League · Cubs)'])
  assert.equal(L.team(enr('2027', 'Young Rookie').team_id!)!.name, 'Mudcats')
  assert.equal(L.team(enr('2027', 'Young Rookie').team_id!)!.division_id, div('2027', 'rookie').id)
  assert.equal(place('2026', 'Up Nine').eff_division_id, div('2026', 'majors').id)
  assert.match(enr('2026', 'Up Nine').notes, /Also on 9-Year-Old League · Cubs/)
  assert.equal(L.team(enr('2027', 'Up Nine').team_id!)!.name, 'Reds')
})

test('an admin can move a 4-year-old up to T-Ball as an exception', () => {
  L.saveDivision('2027', null, { key: 'weeball', name: 'Wee Ball', teams: 1, roster_size: 3, min_age: 3, max_age: 4, se_match: 'wee ball', sort: -1 }, A)
  const k = L.createKid('Tiny Upper', '2022-09-01')   // league age 4 in 2027
  const e = L.enroll('2027', k.id, { divisionId: div('2027', 'weeball').id, status: 'Registered' }, A)
  L.moveEnrollment(e.id, div('2027', 'tball').id, A, 'age exception')
  assert.equal(enr('2027', 'Tiny Upper').draft_id, draft('2027', 'tball').id)
  const r = register('Tiny', 'Upper', 'Wee Ball', '2022-09-01')
  assert.match(r.note, /kept in T-Ball \(placed by an admin\)/)
  const tb = (L.seasonState('2027', true) as { divisions: L.DivisionView[] }).divisions.find((d) => d.key === 'tball')!
  assert.equal(tb.ageExceptions, 1)
  assert.equal(enr('2027', 'Tiny Upper').division_id, div('2027', 'tball').id)
})
