import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

mkdirSync(path.dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// The league, season by season.
//
//   kids         one row per child, forever (name, birthdate, SportsEngine id)
//   seasons      2026, 2027, ... — finishing one rolls it into the next
//   divisions    per season: Wee Ball ... Majors, with seats = teams x roster
//   teams        per season and division, with that season's record
//   enrollments  a kid in a season: division, team, status, how they got there
//   drafts       per season and division: standard (like Majors) or blind (T-Ball)
//   picks        a draft pick puts an enrollment on a team
//
// A kid's history is simply their enrollments across seasons.
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS seasons (
  id          TEXT PRIMARY KEY,                 -- '2027'
  year        INTEGER NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','complete')),
  age_cutoff  TEXT NOT NULL DEFAULT '04-30',    -- league age = age on this MM-DD of the season year
  warn_at     INTEGER NOT NULL DEFAULT 4,       -- open seats at or below this = "closing soon"
  rolled_from TEXT REFERENCES seasons(id),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kids (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_key      TEXT NOT NULL,
  birthdate     TEXT,
  se_profile_id TEXT,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS kids_name_key ON kids(name_key);
CREATE UNIQUE INDEX IF NOT EXISTS kids_se_profile ON kids(se_profile_id) WHERE se_profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS divisions (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                  -- stable across seasons: 'majors'
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  teams       INTEGER NOT NULL DEFAULT 0,     -- planned team count (from fields + coaches)
  roster_size INTEGER NOT NULL DEFAULT 12,
  coaches     INTEGER,
  min_age     INTEGER,
  max_age     INTEGER,
  se_match    TEXT NOT NULL DEFAULT '',       -- comma-separated words matched against the SE program name
  group_key   TEXT NOT NULL DEFAULT '',       -- divisions sharing one registration program (Majors + Minors = '10-12')
  keep_teams  INTEGER NOT NULL DEFAULT 0,     -- 1 = last season's players return to the same team
  closed      INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  UNIQUE (season_id, key)
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  division_id TEXT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#14213D',
  fg          TEXT NOT NULL DEFAULT '#FFFFFF',
  draft_order INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER,
  losses      INTEGER,
  ties        INTEGER,
  coach       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS teams_division ON teams(division_id);

CREATE TABLE IF NOT EXISTS enrollments (
  id                 TEXT PRIMARY KEY,
  season_id          TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  kid_id             TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  division_id        TEXT REFERENCES divisions(id) ON DELETE SET NULL,
  team_id            TEXT REFERENCES teams(id) ON DELETE SET NULL,   -- team before any draft pick (returners)
  returning_team_id  TEXT REFERENCES teams(id) ON DELETE SET NULL,   -- the team a returner goes back to
  age                INTEGER,             -- league age this season when there's no birthdate
  returner           INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  status_locked      INTEGER NOT NULL DEFAULT 0,
  division_locked    INTEGER NOT NULL DEFAULT 0,   -- 1 = an admin placed them; registrations never move them
  tryout             INTEGER NOT NULL DEFAULT 0,   -- trying out for the group's first draft (Majors)
  draft_id           TEXT REFERENCES drafts(id) ON DELETE SET NULL,  -- draft pool they are in, if any
  rank               INTEGER,             -- evaluation rank for the draft
  prior              TEXT NOT NULL DEFAULT '',     -- "Majors · Reds (2026)"
  notes              TEXT NOT NULL DEFAULT '',
  se_program         TEXT,
  se_registration_id TEXT,
  registered_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (season_id, kid_id)
);
CREATE INDEX IF NOT EXISTS enrollments_division ON enrollments(division_id);
CREATE INDEX IF NOT EXISTS enrollments_draft ON enrollments(draft_id);

CREATE TABLE IF NOT EXISTS drafts (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  division_id TEXT NOT NULL UNIQUE REFERENCES divisions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                   -- same as the division key
  format      TEXT NOT NULL DEFAULT 'standard' CHECK (format IN ('standard','blind')),
  mode        TEXT NOT NULL DEFAULT 'straight' CHECK (mode IN ('straight','snake')),
  swap        TEXT NOT NULL DEFAULT '["",""]', -- coin-flip pair that swaps every other round
  next_id     TEXT REFERENCES drafts(id) ON DELETE SET NULL,  -- undrafted kids move here when this closes
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  clock_start INTEGER,
  started_at  INTEGER,
  closed_at   TEXT,
  UNIQUE (season_id, key)
);

CREATE TABLE IF NOT EXISTS picks (
  draft_id      TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  slot_key      TEXT NOT NULL,                 -- "{round}-{teamId}"
  n             INTEGER NOT NULL,
  round         INTEGER NOT NULL,
  team_id       TEXT NOT NULL REFERENCES teams(id),
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollments(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  took_ms       INTEGER,
  actor         TEXT,
  PRIMARY KEY (draft_id, slot_key)
);

-- Blind (T-Ball style) drafts: each kid in the pool gets a hidden number.
CREATE TABLE IF NOT EXISTS blind_numbers (
  draft_id      TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES enrollments(id) ON DELETE CASCADE,
  PRIMARY KEY (draft_id, number)
);

-- Where a kid actually ended up: a pick wins over the pre-draft placement.
CREATE VIEW IF NOT EXISTS placements AS
  SELECT e.*,
         COALESCE(d.division_id, e.division_id) AS eff_division_id,
         COALESCE(p.team_id, e.team_id)         AS eff_team_id,
         p.draft_id AS picked_in, p.n AS pick_n, p.round AS pick_round
  FROM enrollments e
  LEFT JOIN picks p  ON p.enrollment_id = e.id
  LEFT JOIN drafts d ON d.id = p.draft_id;

-- Every SportsEngine delivery (and CSV import row), stored before processing.
CREATE TABLE IF NOT EXISTS registrations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source             TEXT NOT NULL,
  event_id           TEXT,
  event_type         TEXT,
  verified           INTEGER NOT NULL DEFAULT 0,
  raw                TEXT NOT NULL,
  signature          TEXT,
  batched            INTEGER NOT NULL DEFAULT 0,
  first_name         TEXT,
  last_name          TEXT,
  birthdate          TEXT,
  reg_year           INTEGER,
  program            TEXT,
  se_profile_id      TEXT,
  se_registration_id TEXT,
  season_id          TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  outcome            TEXT NOT NULL DEFAULT 'pending',
  kid_id             TEXT REFERENCES kids(id) ON DELETE SET NULL,
  enrollment_id      TEXT REFERENCES enrollments(id) ON DELETE SET NULL,
  division_id        TEXT REFERENCES divisions(id) ON DELETE SET NULL,
  note               TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_event ON registrations(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  season_id TEXT,
  kid_id    TEXT,
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_kid ON audit(kid_id);

-- Registration campaigns: our own signup + Stripe checkout ("2027 Spring",
-- a summer team, a fall league...). Each has programs (usually a season's
-- divisions), priced items, and extra questions, all built in admin.
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,         -- /register/<slug>
  name         TEXT NOT NULL,
  season_id    TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opens_at     TEXT,                         -- optional ISO timestamps
  closes_at    TEXT,
  intro        TEXT NOT NULL DEFAULT '',     -- shown at the top of the form
  confirmation TEXT NOT NULL DEFAULT '',     -- shown after payment
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What a family can sign a kid up for. A league program points at a season
-- division (Majors + Minors share one program pointing at Minors, the home of
-- the 10–12 pool); a standalone one (a summer team) has its own ages and cap.
CREATE TABLE IF NOT EXISTS offerings (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  division_id TEXT REFERENCES divisions(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  min_age     INTEGER,
  max_age     INTEGER,
  capacity    INTEGER,                        -- standalone only; league programs use division seats
  waitlist    INTEGER NOT NULL DEFAULT 1,     -- 1 = free waitlist when full, 0 = hide when full
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

-- Priced items charged per kid: the registration fee, value cards, a volunteer buyout...
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  required    INTEGER NOT NULL DEFAULT 0,
  max_qty     INTEGER NOT NULL DEFAULT 1,     -- >1 lets families buy several (value cards)
  offering_ids TEXT NOT NULL DEFAULT '[]',    -- JSON; empty = every program
  tag         TEXT NOT NULL DEFAULT '',       -- e.g. 'volunteer-exempt', copied onto what the kid bought
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'player' CHECK (scope IN ('player','family')),
  label        TEXT NOT NULL,
  help         TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL CHECK (type IN ('text','textarea','number','date','yesno','select','multi','agreement')),
  options      TEXT NOT NULL DEFAULT '[]',    -- JSON list for select / multi
  required     INTEGER NOT NULL DEFAULT 0,
  offering_ids TEXT NOT NULL DEFAULT '[]',
  sort         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

-- One checkout. Stays 'pending' until Stripe confirms payment.
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','waitlisted','cancelled','refunded')),
  guardian          TEXT NOT NULL,            -- JSON: name, email, phone, address
  answers           TEXT NOT NULL DEFAULT '{}',
  total_cents       INTEGER NOT NULL DEFAULT 0,
  stripe_session_id TEXT,
  stripe_payment_id TEXT,
  stripe_mode       TEXT,                     -- 'test' | 'live'
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at           TEXT,
  se_synced_at      TEXT,                     -- marked once entered into SportsEngine
  admin_notes       TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_session ON orders(stripe_session_id) WHERE stripe_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_players (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  birthdate     TEXT NOT NULL,
  gender        TEXT NOT NULL DEFAULT '',
  offering_id   TEXT NOT NULL REFERENCES offerings(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','registered','waitlisted','offered','cancelled')),
  answers       TEXT NOT NULL DEFAULT '{}',
  kid_id        TEXT REFERENCES kids(id) ON DELETE SET NULL,
  enrollment_id TEXT REFERENCES enrollments(id) ON DELETE SET NULL,
  offer_session_id TEXT                       -- Stripe session for a waitlist spot being offered
);

CREATE TABLE IF NOT EXISTS order_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_player_id TEXT NOT NULL REFERENCES order_players(id) ON DELETE CASCADE,
  item_id         TEXT REFERENCES items(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  tag             TEXT NOT NULL DEFAULT '',
  unit_cents      INTEGER NOT NULL,
  qty             INTEGER NOT NULL,
  charged         INTEGER NOT NULL DEFAULT 1   -- 0 = waitlisted kid, not charged yet
);
`)

// Parents and guardians, per kid, kept across seasons. Pasted from a contact
// list, typed in by an admin, or learned from every paid registration.
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id         TEXT PRIMARY KEY,
  kid_id     TEXT NOT NULL REFERENCES kids(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',     -- lower-cased
  phone      TEXT NOT NULL DEFAULT '',
  relation   TEXT NOT NULL DEFAULT '',     -- Mother, Father, Guardian...
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('import','registration','manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS contacts_kid ON contacts(kid_id);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_kid_email ON contacts(kid_id, email) WHERE email <> '';

-- Outreach: an email asking returning families to register early. One
-- message per parent email address, covering all of their kids, with a
-- personal link that pre-fills the registration form.
CREATE TABLE IF NOT EXISTS outreach (
  id          TEXT PRIMARY KEY,
  season_id   TEXT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  filter      TEXT NOT NULL DEFAULT '{}',   -- JSON: divisionIds, statuses
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id          TEXT PRIMARY KEY,
  outreach_id TEXT NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  kid_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON
  token       TEXT NOT NULL UNIQUE,         -- the personal registration link
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','exported')),
  provider_id TEXT,
  error       TEXT NOT NULL DEFAULT '',
  sent_at     TEXT,
  clicked_at  TEXT,
  UNIQUE (outreach_id, email)
);
`)

// Columns added after a table first shipped.
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}
// What the family said about last year's player: a kid id (yes, that's them),
// 'new' (no, not them), or '' (no one matched).
addColumn('order_players', 'prior_match', `TEXT NOT NULL DEFAULT ''`)
// 1 = only asked of players new to the league; skipped once a family confirms last season's player.
addColumn('questions', 'new_only', `INTEGER NOT NULL DEFAULT 0`)
