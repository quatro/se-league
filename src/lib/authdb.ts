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
`)
