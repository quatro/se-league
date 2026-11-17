import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = mkdtempSync(path.join(tmpdir(), 'seleague-r-'))
process.env.DB_PATH = path.join(dir, 'league.db')
process.env.AUTH_DB_PATH = path.join(dir, 'auth.db') // never the real shared login database
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'
process.env.RESEND_API_KEY = ''

const U = await import('../src/lib/users.js')
const L = await import('../src/lib/league.js')
const CO = await import('../src/lib/coaches.js')
const { requireAdmin, hasRole } = await import('../src/lib/auth.js')
const { authDb } = await import('../src/lib/authdb.js')

type Req = Parameters<typeof requireAdmin>[0]
/** Run the admin guard for a signed-in person; returns the status it answered with, or 'next'. */
function guard(user: { id: number; email: string; role: 'user' | 'admin' }, method: string): number | 'next' {
  const req = { method, user: { ...user, name: '' }, admin: user.role === 'admin' ? { id: user.id, username: user.email } : undefined,
    board: user.role === 'admin' || hasRole(user.id, 'board'), headers: { host: 'x' }, is: () => true } as unknown as Req
  let code: number | 'next' = 'next'
  const res = { status: (c: number) => ({ json: () => { code = c } }) } as unknown as Parameters<typeof requireAdmin>[1]
  requireAdmin(req, res, () => {})
  return code
}

test('one person, several hats: Board sees admin areas but changes nothing, and can coach too', async () => {
  const A = 'test'
  const boss = U.addUser({ email: 'boss@example.com', role: 'admin' }, A)
  const pat = U.addUser({ email: 'Pat@Example.com', name: 'Pat', role: 'user', board: true }, A)
  const kim = U.addUser({ email: 'kim@example.com', role: 'user' }, A)
  assert.equal(U.userById(pat.id)!.board, true)
  assert.equal(U.userById(kim.id)!.board, false)

  // Board: every admin GET, no changes. Plain members: neither.
  assert.equal(guard(pat, 'GET'), 'next')
  assert.equal(guard(pat, 'POST'), 403)
  assert.equal(guard(pat, 'PATCH'), 403)
  assert.equal(guard(kim, 'GET'), 403)
  assert.equal(guard(boss, 'POST'), 'next')

  // Hats change independently; one row per person.
  U.updateUser(kim.id, { board: true }, { user: boss } as never, A)
  assert.equal(guard(U.userById(kim.id)!, 'GET'), 'next')
  U.updateUser(kim.id, { board: false }, { user: boss } as never, A)
  assert.equal(guard(U.userById(kim.id)!, 'GET'), 403)
  assert.equal((authDb.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get('pat@example.com') as { n: number }).n, 1)

  // The same person coaches a team: that hat comes from the team, not a second account.
  ;(await import('../src/db.js')).db.prepare(`INSERT INTO seasons (id, year, status) VALUES ('2027', 2027, 'planning')`).run()
  const d = L.saveDivision('2027', null, { key: 'minors', name: 'Minors', teams: 1, roster_size: 12 }, A)
  L.saveTeam(d.id, null, { name: 'Cubs', coach: 'Pat', coach_email: 'pat@example.com' }, A)
  assert.equal(CO.ensureCoachUser('pat@example.com', 'Pat'), false, 'already on the list — no duplicate')
  assert.deepEqual(CO.coachingFor('pat@example.com').map((c) => c.name), ['Cubs'])
  assert.equal(U.userById(pat.id)!.board, true)

  // Removing someone takes their hats with them.
  U.removeUser(pat.id, { user: boss } as never, A)
  assert.equal(hasRole(pat.id, 'board'), false)
})
