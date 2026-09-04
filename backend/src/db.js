/**
 * Database connection and schema.
 *
 * The schema is created idempotently on open, so there is no migration step to
 * run and a fresh clone works immediately. The data directory is gitignored
 * because the snapshot log is regenerable - with a fixed seed the simulator
 * reproduces it exactly, which is a nice side effect of determinism.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

const SCHEMA = `
-- The append-only observation log. Everything else in the app reads from here.
--
-- TWO TIMESTAMPS, ON PURPOSE:
--   timestamp   - the instant the price is *about* (attributed by the source)
--   ingested_at - the instant we *learned* it
-- A delayed feed makes these differ by 15-20 minutes, and collapsing them into
-- one column would destroy the app's ability to tell the user how fresh a
-- number really is. Keeping both is what makes "delayed" reportable instead of
-- invisible.
CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    NOT NULL,
  timestamp   INTEGER NOT NULL,
  price       REAL    NOT NULL CHECK (price > 0),
  volume      INTEGER NOT NULL CHECK (volume >= 0),
  source      TEXT    NOT NULL,
  confidence  REAL    NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  ingested_at INTEGER NOT NULL
);

-- Append-only does not mean append-duplicates. One source restating the same
-- price for the same instant is the same fact, and INSERT OR IGNORE collapses
-- it. Note that the price column is part of the key: if a source ever reports a
-- *different* price for an instant it already reported, that is a correction,
-- and a correction is new information worth keeping both halves of.
CREATE UNIQUE INDEX IF NOT EXISTS snapshots_observation
  ON snapshots (symbol, timestamp, source, price);

CREATE INDEX IF NOT EXISTS snapshots_symbol_time
  ON snapshots (symbol, timestamp DESC);

-- The event-sourcing invariant, enforced by the database rather than by good
-- intentions. Any code that tries to mutate history - now or in six months -
-- fails loudly instead of quietly overwriting a price a user already saw.
-- Resetting means deleting the database file, which is the honest cost of a
-- log you promised never to rewrite.
CREATE TRIGGER IF NOT EXISTS snapshots_no_update
BEFORE UPDATE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS snapshots_no_delete
BEFORE DELETE ON snapshots
BEGIN
  SELECT RAISE(ABORT, 'snapshots is append-only: DELETE is not permitted');
END;

-- User state, which IS mutable - and that contrast is deliberate. Observations
-- about the world are facts that accumulate; a user's "I have now looked at
-- this" is a single current value that legitimately gets overwritten.
CREATE TABLE IF NOT EXISTS watchlist (
  user_id        TEXT    NOT NULL,
  symbol         TEXT    NOT NULL,
  added_at       INTEGER NOT NULL,
  last_viewed_at INTEGER,
  PRIMARY KEY (user_id, symbol)
);

-- Which signals have already been shown to which user.
--
-- Without this, a restart makes every ongoing change look like a brand-new
-- discovery, and the "3 things deserve your attention" summary re-announces
-- the same move every time the process comes up. That is the difference
-- between a product that remembers what it told you and one that shouts.
--
-- The fingerprint identifies the underlying EVENT rather than the exact score
-- (see engine/surfaced.js): level, reason set, direction and a coarse
-- magnitude bucket. So an ongoing move stays surfaced as it drifts, while a
-- materially larger move is a new event and fires again.
--
-- The epoch column is the user's last_viewed_at at the time of surfacing.
-- "Mark seen" therefore starts a fresh epoch and everything may legitimately
-- surface once more - which is correct, because the user has explicitly said
-- they have absorbed the current state.
--
-- Deliberately mutable, unlike snapshots: this is a record of what we did, not
-- an observation about the market.
CREATE TABLE IF NOT EXISTS surfaced_signals (
  user_id           TEXT    NOT NULL,
  symbol            TEXT    NOT NULL,
  fingerprint       TEXT    NOT NULL,
  level             TEXT    NOT NULL,
  epoch             INTEGER NOT NULL,
  first_surfaced_at INTEGER NOT NULL,
  last_surfaced_at  INTEGER NOT NULL,
  surface_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, symbol, fingerprint)
);

CREATE INDEX IF NOT EXISTS surfaced_user_symbol
  ON surfaced_signals (user_id, symbol);

-- Alert definitions, and their threshold-crossing state.
--
-- The armed column is the whole point. Without it a 1350 threshold with the price at
-- 1352 re-fires on every poll; with it the alert answers an EDGE rather than a
-- level - it fires on the crossing, disarms, and only re-arms once the price
-- has come back a hysteresis band clear of the threshold. See alerts.js.
--
-- It lives in the database rather than in memory so that a restart cannot turn
-- a crossing the user has already been told about back into news.
CREATE TABLE IF NOT EXISTS alerts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT    NOT NULL,
  symbol              TEXT    NOT NULL,
  type                TEXT    NOT NULL,
  threshold           REAL,
  created_at          INTEGER NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  armed               INTEGER NOT NULL DEFAULT 1,
  last_fired_at       INTEGER,
  fire_count          INTEGER NOT NULL DEFAULT 0,
  last_observed       REAL,
  last_evaluated_at   INTEGER,
  -- Why the last evaluation declined to act: a stale price, a closed market, an
  -- unavailable value. Recorded so a silent alert can be explained.
  last_skipped_reason TEXT
);

CREATE INDEX IF NOT EXISTS alerts_user ON alerts (user_id, symbol);

-- Fired alerts. Append-only in practice but NOT trigger-locked like snapshots:
-- these are records of what this app did, not observations about the market, and
-- a user acknowledging one is a legitimate update.
CREATE TABLE IF NOT EXISTS alert_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id     INTEGER NOT NULL,
  user_id      TEXT    NOT NULL,
  symbol       TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  fired_at     INTEGER NOT NULL,
  observed     REAL,
  threshold    REAL,
  -- The sentence shown to the user: what fired, and on what observation.
  reason       TEXT    NOT NULL,
  data_quality TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS alert_events_user
  ON alert_events (user_id, fired_at DESC);
`;

/**
 * Open a database and ensure the schema exists. Pass ':memory:' for tests -
 * every test then gets a private database with no cleanup and no shared state.
 */
export function createDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  // WAL lets the ingestion loop write while requests read, without either
  // blocking the other. NORMAL synchronous is the standard WAL pairing: a
  // power cut can cost the last few snapshots, which for a regenerable
  // observation log is a fair trade for not fsyncing every tick.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(SCHEMA);
  addColumns(db);
  return db;
}

/**
 * Columns added after a table first shipped.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * database created by an earlier version keeps its old shape. These are applied
 * idempotently by checking the live column list first - which is the whole
 * migration story this project needs, since the observation log is regenerable
 * and everything else is small.
 */
function addColumns(db) {
  const additions = [
    {
      table: 'alert_events',
      column: 'diagnosis',
      // Why the alert fired, captured AT fire time. Recomputing it later would
      // describe whatever the market is doing now rather than the moment that
      // actually triggered.
      ddl: 'ALTER TABLE alert_events ADD COLUMN diagnosis TEXT',
    },

    /**
     * What a surfaced signal actually SAID, captured at surface time.
     *
     * The change history reads these. Recomputing the reasons and the delta
     * when the timeline is rendered would describe whatever the market is
     * doing now rather than the moment the user was told about - the same
     * reasoning as alert_events.diagnosis above, and the reason both are
     * stored rather than derived.
     *
     * Two columns on an existing table rather than a second history system:
     * surfaced_signals already records which signals were presented and when,
     * so it already IS the event log. It was only missing their content.
     */
    {
      table: 'surfaced_signals',
      column: 'reasons',
      ddl: 'ALTER TABLE surfaced_signals ADD COLUMN reasons TEXT',
    },
    {
      table: 'surfaced_signals',
      column: 'change_pct',
      ddl: 'ALTER TABLE surfaced_signals ADD COLUMN change_pct REAL',
    },
  ];

  for (const { table, column, ddl } of additions) {
    const existing = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table);
    if (existing.length === 0) continue;
    if (existing.some((row) => row.name === column)) continue;
    db.exec(ddl);
  }
}

let instance;

/** The process-wide connection. SQLite is single-file; one handle is correct. */
export function getDb() {
  instance ??= createDatabase();
  return instance;
}

export function closeDb() {
  instance?.close();
  instance = undefined;
}
