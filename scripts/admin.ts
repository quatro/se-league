// pnpm admin add <username>        — create an admin (prompts for password)
// pnpm admin passwd <username>     — reset a password
// pnpm admin list | remove <username>
import { createInterface } from 'node:readline/promises'
import { authDb as db } from '../src/lib/authdb.js'
import { hashPassword } from '../src/lib/auth.js'

const [cmd, user] = process.argv.slice(2)
async function ask(q: string) {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const a = await rl.question(q); rl.close(); return a
}
if (cmd === 'list') {
  console.table(db.prepare('SELECT id, username, created_at FROM admins').all())
} else if ((cmd === 'add' || cmd === 'passwd') && user) {
  const pw = await ask(`Password for ${user}: `)
  if (pw.length < 10) { console.error('Use at least 10 characters.'); process.exit(1) }
  if (cmd === 'add') db.prepare('INSERT INTO admins (username, pw_hash) VALUES (?, ?)').run(user, hashPassword(pw))
  else if (!db.prepare('UPDATE admins SET pw_hash = ? WHERE username = ?').run(hashPassword(pw), user).changes) { console.error('No such admin'); process.exit(1) }
  else db.prepare('DELETE FROM sessions WHERE admin_id = (SELECT id FROM admins WHERE username = ?)').run(user)
  console.log(`${cmd === 'add' ? 'Created' : 'Updated'} admin ${user}`)
} else if (cmd === 'remove' && user) {
  console.log(db.prepare('DELETE FROM admins WHERE username = ?').run(user).changes ? `Removed ${user}` : 'No such admin')
} else {
  console.log('usage: pnpm admin add|passwd|remove <username> | pnpm admin list')
}
