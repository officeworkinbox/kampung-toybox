const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'toybox.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  postal_code     TEXT NOT NULL,
  address_line    TEXT NOT NULL,
  planning_area   TEXT NOT NULL,
  verified_at     TEXT,
  otp_hash        TEXT,
  otp_expires_at  TEXT,
  otp_attempts    INTEGER NOT NULL DEFAULT 0,
  suspended_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS toys (
  id             INTEGER PRIMARY KEY,
  giver_id       INTEGER NOT NULL REFERENCES users(id),
  planning_area  TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  condition      TEXT NOT NULL,
  age_range      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'available', -- available | reserved | given | withdrawn
  hidden_at      TEXT,                              -- set when community reports pass the threshold
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS toys_area_status ON toys(planning_area, status);

CREATE TABLE IF NOT EXISTS toy_photos (
  id         INTEGER PRIMARY KEY,
  toy_id     INTEGER NOT NULL REFERENCES toys(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id              INTEGER PRIMARY KEY,
  toy_id          INTEGER NOT NULL REFERENCES toys(id),
  requester_id    INTEGER NOT NULL REFERENCES users(id),
  note            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | declined | cancelled | completed | no_show
  handover_code   TEXT,                            -- 6-digit code shown to the requester once approved
  decided_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (toy_id, requester_id)
);
CREATE INDEX IF NOT EXISTS requests_requester ON requests(requester_id, status);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id),
  from_id     INTEGER NOT NULL REFERENCES users(id),
  to_id       INTEGER NOT NULL REFERENCES users(id),
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, from_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  reporter_id  INTEGER NOT NULL REFERENCES users(id),
  toy_id       INTEGER REFERENCES toys(id),
  user_id      INTEGER REFERENCES users(id),
  reason       TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_toy  ON reports(reporter_id, toy_id)  WHERE toy_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_once_user ON reports(reporter_id, user_id) WHERE user_id IS NOT NULL;
`;

function open(dbPath = DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

const db = open();

/** Run fn inside a transaction; rolls back on throw. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, tx, DATA_DIR, UPLOAD_DIR, DB_PATH };
