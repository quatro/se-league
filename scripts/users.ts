// pnpm users list
// pnpm users add <email> [user|admin] [name...]
// pnpm users role <email> <user|admin>
// pnpm users remove <email>
// pnpm users link <email>          — print a one-time sign-in link (for when email isn't set up)
import { config } from '../src/config.js'
import { createLoginLink, endSessions, normEmail, userByEmail } from '../src/lib/auth.js'
import { authDb as db } from '../src/lib/authdb.js'

const [cmd, email, ...rest] = process.argv.slice(2)
const role = (r?: string) => { if (r !== 'user' && r !== 'admin') { console.error('Role is user or admin'); process.exit(1) } return r }
const must = () => { const u = email && userByEmail(email); if (!u) { console.error('No such user'); process.exit(1) } return u }

if (cmd === 'list') {
  console.table(db.prepare('SELECT id, email, name, role, last_login_at FROM users ORDER BY role DESC, email').all())
} else if (cmd === 'add' && email) {
  const r = role(rest[0] ?? 'user')
  db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(normEmail(email), rest.slice(1).join(' '), r)
  console.log(`Added ${normEmail(email)} as ${r}`)
} else if (cmd === 'role' && email) {
  const u = must(); db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role(rest[0]), u.id); endSessions(u.id)
  console.log(`${u.email} is now ${rest[0]}`)
} else if (cmd === 'remove' && email) {
  const u = must(); db.prepare('DELETE FROM users WHERE id = ?').run(u.id); console.log(`Removed ${u.email}`)
} else if (cmd === 'link' && email) {
  console.log(`${config.baseUrl}/signin?token=${createLoginLink(must().id, '/')}`)
} else {
  console.log('usage: pnpm users list | add <email> [user|admin] [name] | role <email> <user|admin> | remove <email> | link <email>')
}
