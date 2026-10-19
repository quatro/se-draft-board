import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

mkdirSync(path.dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#14213d',
  fg          TEXT NOT NULL DEFAULT '#FFFFFF',
  draft_order INTEGER NOT NULL
);

-- One table for every kid: returning players (kind='returning', team_id set)
-- and the draft pool (kind='pool'). A drafted pool player keeps kind='pool';
-- the pick row is what puts them on a team.
CREATE TABLE IF NOT EXISTS players (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  name_key           TEXT NOT NULL,
  age                INTEGER,
  birthdate          TEXT,           -- YYYY-MM-DD
  kind               TEXT NOT NULL CHECK (kind IN ('returning','pool')),
  team_id            TEXT REFERENCES teams(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'Not registered',
  status_locked      INTEGER NOT NULL DEFAULT 0,   -- 1 = webhooks never change status
  status_source      TEXT NOT NULL DEFAULT 'manual',
  rank               INTEGER,
  notes              TEXT NOT NULL DEFAULT '',
  se_profile_id      TEXT,
  se_registration_id TEXT,
  registered_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS players_name_key ON players(name_key);
CREATE UNIQUE INDEX IF NOT EXISTS players_se_profile ON players(se_profile_id) WHERE se_profile_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS picks (
  slot_key  TEXT PRIMARY KEY,        -- "{round}-{teamId}"
  n         INTEGER NOT NULL,
  round     INTEGER NOT NULL,
  team_id   TEXT NOT NULL REFERENCES teams(id),
  player_id TEXT NOT NULL UNIQUE REFERENCES players(id),
  at        INTEGER NOT NULL,        -- epoch ms
  took_ms   INTEGER,
  actor     TEXT
);

-- Every SportsEngine delivery (and CSV import row), stored before processing
-- so a mapping fix can be replayed against what actually arrived.
CREATE TABLE IF NOT EXISTS registrations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  source             TEXT NOT NULL,    -- 'webhook' | 'csv' | 'manual'
  event_id           TEXT,
  event_type         TEXT,
  verified           INTEGER NOT NULL DEFAULT 0,
  raw                TEXT NOT NULL,
  first_name         TEXT,
  last_name          TEXT,
  birthdate          TEXT,
  reg_year           INTEGER,
  se_profile_id      TEXT,
  se_registration_id TEXT,
  outcome            TEXT NOT NULL DEFAULT 'pending',  -- matched|unmatched|ambiguous|wrong_year|locked|ignored|error|pending
  player_id          TEXT REFERENCES players(id) ON DELETE SET NULL,
  note               TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_event ON registrations(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  player_id TEXT,
  detail    TEXT NOT NULL DEFAULT ''
);

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

const DEFAULT_SETTINGS: Record<string, unknown> = {
  season: '2027',
  registrationYear: 2027,
  rosterSize: 12,
  mode: 'straight',
  swap: ['', ''],
  ageCutoff: '04-30',   // league age = age on this MM-DD of the season year
  clockStart: null,
  startedAt: null,
}
const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, JSON.stringify(v))
