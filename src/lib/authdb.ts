import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

// Admin accounts and sessions are shared by every league tool (draft board,
// registration, ...) so one login works on all of them. Each app keeps its own
// league data in its own database.
mkdirSync(path.dirname(config.authDbPath), { recursive: true })
export const authDb = new Database(config.authDbPath)
authDb.pragma('journal_mode = WAL')
authDb.pragma('busy_timeout = 5000')
authDb.pragma('foreign_keys = ON')

authDb.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- People allowed in, by email. Signing in is by emailed link only; nobody off
-- this list can see anything but the public registration form.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS login_links (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next       TEXT NOT NULL DEFAULT '/',
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- Extra roles a person holds, beyond users.role (which other league tools read, so admin stays there).
-- One person, many hats: 'board' = Board of Directors (sees the admin areas, changes nothing).
-- Coaching isn't stored here: you coach because a team names your email.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    TEXT NOT NULL CHECK (role IN ('board')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`)
