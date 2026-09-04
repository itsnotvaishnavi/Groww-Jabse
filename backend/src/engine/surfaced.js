/**
 * "Have we already told them this?"
 *
 * A change the user has already been shown is not a discovery. Without a
 * persisted record, a server restart turns every ongoing move back into
 * breaking news and the summary re-announces the same three things forever.
 *
 * THE FINGERPRINT IDENTIFIES THE EVENT, NOT THE SCORE
 * Keying on the score would refire on every tick, because the score moves
 * continuously. Keying on nothing but the symbol would never refire, so a move
 * that grew from 2% to 9% would stay silent. So the key is the shape of the
 * event: its level, its reason set, its direction, and its magnitude rounded
 * into a coarse bucket. A drift within the bucket is the same event; crossing a
 * bucket is a new one.
 */
import { createHash } from 'node:crypto';
import { ReasonCode } from './reasons.js';

/** Percentage width of one magnitude bucket. */
const BUCKET_PCT = 1;

/**
 * Caveats are not part of the event. `low_confidence` describes our data, not
 * the market, so including it would make a signal refire simply because the
 * feed got fresher.
 */
const NON_EVENT_CODES = new Set([ReasonCode.LOW_CONFIDENCE]);

/**
 * The stable identity of one signal for one user.
 *
 * @param lastViewedAt the user's viewing epoch; a new one lets a signal
 *        surface again, because the user has explicitly acknowledged the old
 *        state by pressing "Mark seen".
 */
export function fingerprintFor({ symbol, level, reasons, features, lastViewedAt }) {
  const codes = reasons
    .map((r) => r.code)
    .filter((code) => !NON_EVENT_CODES.has(code))
    .sort();

  // Magnitude and direction come from whichever measurement is available,
  // preferring the user-facing one.
  const change = features.changeSinceViewed;
  const price = features.priceAnomaly;

  const magnitudePct = change.available
    ? change.percent
    : price.available
      ? price.returnPct
      : 0;

  const direction = magnitudePct > 0 ? 'up' : magnitudePct < 0 ? 'down' : 'flat';
  const bucket = Math.trunc(Math.abs(magnitudePct) / BUCKET_PCT);

  const material = [
    symbol,
    level,
    codes.join(','),
    direction,
    `b${bucket}`,
    `e${lastViewedAt ?? 0}`,
  ].join('|');

  return {
    fingerprint: createHash('sha256').update(material).digest('hex').slice(0, 16),
    /** Kept for debugging and for the detail view - opaque hashes are hostile. */
    material,
    bucket,
    direction,
  };
}

export function createSurfacedStore(db) {
  const statements = {
    get: db.prepare(
      `SELECT * FROM surfaced_signals
       WHERE user_id = ? AND symbol = ? AND fingerprint = ?`,
    ),

    forUser: db.prepare('SELECT * FROM surfaced_signals WHERE user_id = ?'),

    insert: db.prepare(
      `INSERT INTO surfaced_signals
         (user_id, symbol, fingerprint, level, epoch,
          first_surfaced_at, last_surfaced_at, surface_count, reasons, change_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (user_id, symbol, fingerprint) DO UPDATE SET
         last_surfaced_at = excluded.last_surfaced_at,
         surface_count = surface_count + 1`,
    ),

    /**
     * The change history, newest first.
     *
     * first_surfaced_at, not last: the timeline records when a signal BECAME
     * news, and re-presenting the same unchanged event on a later page load is
     * not a second event. The ON CONFLICT above deliberately leaves
     * first_surfaced_at alone for exactly this reason.
     *
     * Symbol breaks ties so the order is total: several signals surfaced in the
     * same millisecond - which is what one page load does - would otherwise
     * come back in whatever order SQLite found convenient.
     */
    history: db.prepare(
      `SELECT * FROM surfaced_signals
       WHERE user_id = ?
       ORDER BY first_surfaced_at DESC, symbol ASC
       LIMIT ?`,
    ),

    countForUser: db.prepare(
      'SELECT COUNT(*) AS n FROM surfaced_signals WHERE user_id = ?',
    ),
  };

  const markMany = db.transaction((userId, records, at) => {
    for (const record of records) {
      statements.insert.run(
        userId,
        record.symbol,
        record.fingerprint,
        record.level,
        record.epoch ?? 0,
        at,
        at,
        /**
         * Stored as JSON because it is a list, and read back by exactly one
         * consumer. A join table for a handful of reason codes per event
         * would be schema for its own sake.
         */
        record.reasons ? JSON.stringify(record.reasons) : null,
        record.changePct ?? null,
      );
    }
    return records.length;
  });

  /** Never let a malformed stored value take the timeline down with it. */
  function parseReasons(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return {
    /**
     * Every fingerprint this user has been shown, as a Set. One query for the
     * whole page rather than one per row - the same batching discipline the
     * rest of the engine follows.
     */
    fingerprintsFor(userId) {
      return new Set(statements.forUser.all(userId).map((row) => row.fingerprint));
    },

    isSurfaced(userId, symbol, fingerprint) {
      return statements.get.get(userId, symbol, fingerprint) !== undefined;
    },

    detail(userId, symbol, fingerprint) {
      const row = statements.get.get(userId, symbol, fingerprint);
      return row
        ? {
            symbol: row.symbol,
            fingerprint: row.fingerprint,
            level: row.level,
            epoch: row.epoch,
            firstSurfacedAt: row.first_surfaced_at,
            lastSurfacedAt: row.last_surfaced_at,
            surfaceCount: row.surface_count,
          }
        : null;
    },

    /**
     * Record that these signals were presented.
     *
     * Called by the "since you were away" summary, which is the moment a
     * signal is genuinely surfaced as news. Merely listing the watchlist does
     * NOT mark anything - the same reasoning as last_viewed_at: a read must not
     * quietly consume the thing it is reading.
     */
    markSurfaced(userId, records, at = Date.now()) {
      if (records.length === 0) return 0;
      return markMany(userId, records, at);
    },

    /**
     * The meaningful-event timeline for one user.
     *
     * Only signals that were actually SURFACED are here, which is what makes
     * this a change history rather than a tick log: the store is written by the
     * summary when it presents something, so an entry means "the user was told
     * about this". There are no "stable" entries because nothing quiet is ever
     * surfaced - the absence of change is not an event.
     *
     * @param level optional filter on the engine's own level.
     */
    history(userId, { limit = 50, level = null } = {}) {
      const rows = statements.history.all(userId, Math.max(1, Math.min(limit, 200)));

      return rows
        .filter((row) => level == null || row.level === level)
        .map((row) => ({
          symbol: row.symbol,
          level: row.level,
          /** When it became news. */
          at: row.first_surfaced_at,
          /** And when it was last still being shown, if that differs. */
          lastSeenAt: row.last_surfaced_at,
          surfaceCount: row.surface_count,
          /**
           * The baseline this was measured against - the viewing epoch the
           * fingerprint was cut with. Marking seen starts a new epoch, so an
           * event recorded afterwards is genuinely a new one.
           */
          baselineAt: row.epoch || null,
          changePct: row.change_pct,
          reasons: parseReasons(row.reasons),
          fingerprint: row.fingerprint,
        }));
    },

    count(userId) {
      return statements.countForUser.get(userId).n;
    },
  };
}
