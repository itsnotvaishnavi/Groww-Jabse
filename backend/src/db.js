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
  return db;
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
