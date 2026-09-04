/**
 * Watchlist storage: add, remove, list, and the one field that makes this
 * product different - last_viewed_at.
 *
 * The brief says keep this boring, and it is. The interesting behaviour lives
 * in the snapshot log and the freshness layer; this is a keyed set of symbols
 * per user with a timestamp attached.
 */

import { BENCHMARK_SYMBOL, ValidationError, canonicalizeSymbol, isBenchmark } from './symbols.js';

/**
 * Symbol identity lives in ./symbols.js - there must be exactly one definition
 * of "which instrument is this", or the log and the watchlist drift apart.
 * Both names are re-exported because the API layer and the tests import them
 * from here, and `instanceof ValidationError` has to keep working across
 * modules, which it only does if there is a single class.
 */
export { ValidationError, canonicalizeSymbol };

/** Retained name for the canonicaliser; see ./symbols.js for the rule. */
export const normalizeSymbol = canonicalizeSymbol;

export function createWatchlist(db) {
  const statements = {
    /**
     * rowid breaks ties in added_at. Several symbols added in the same
     * millisecond - which is exactly what first-boot seeding does - would
     * otherwise come back in whatever order SQLite found convenient, making
     * the UI's "recently added" sort quietly non-deterministic.
     */
    list: db.prepare(`
      SELECT symbol, added_at, last_viewed_at
      FROM watchlist WHERE user_id = ?
      ORDER BY added_at ASC, rowid ASC
    `),

    get: db.prepare(
      'SELECT symbol, added_at, last_viewed_at FROM watchlist WHERE user_id = ? AND symbol = ?',
    ),

    add: db.prepare(`
      INSERT OR IGNORE INTO watchlist (user_id, symbol, added_at, last_viewed_at)
      VALUES (?, ?, ?, NULL)
    `),

    remove: db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?'),

    markViewed: db.prepare(
      'UPDATE watchlist SET last_viewed_at = ? WHERE user_id = ? AND symbol = ?',
    ),

    /** Union across users: what the ingestion loop needs to poll. */
    symbolsInUse: db.prepare('SELECT DISTINCT symbol FROM watchlist ORDER BY symbol'),

    countForUser: db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?'),
  };

  const toEntry = (row) =>
    row && {
      symbol: row.symbol,
      addedAt: row.added_at,
      lastViewedAt: row.last_viewed_at,
    };

  return {
    list(userId) {
      return statements.list.all(userId).map(toEntry);
    },

    get(userId, symbol) {
      return toEntry(statements.get.get(userId, normalizeSymbol(symbol)));
    },

    /**
     * Idempotent: adding a symbol already on the list is a no-op that reports
     * `added: false` rather than an error. Re-adding is a normal thing for a
     * user to do and does not deserve a failure.
     *
     * Because the symbol is canonicalised first, this is also what enforces
     * one-instrument-one-entry: RELIANCE, reliance and RELIANCE.NS all collapse
     * to the same primary key, so the second and third attempts report
     * `added: false` instead of creating duplicate rows for one instrument.
     * RELIANCE.BO is a different venue at a different price, so it is allowed
     * to coexist as its own entry.
     *
     * A new entry starts with last_viewed_at = NULL, which is meaningfully
     * different from "viewed at the moment it was added": the user has not
     * looked at it yet, so their first visit has no delta to show. Defaulting
     * it to now() would silently claim they had already seen a price.
     */
    add(userId, symbol, at = Date.now()) {
      const normalized = normalizeSymbol(symbol);

      /**
       * The benchmark is ingested for everyone as the market-relative
       * reference, not held as a watchlist row. Letting it be added would put
       * an index in a list of instruments and make it its own benchmark.
       */
      if (isBenchmark(normalized)) {
        throw new ValidationError(
          `${BENCHMARK_SYMBOL} is tracked automatically as the market benchmark and cannot be added to a watchlist.`,
        );
      }

      const result = statements.add.run(userId, normalized, at);
      return { symbol: normalized, added: result.changes > 0 };
    },

    /**
     * Removing a symbol drops the user's interest in it, not its history. The
     * snapshot log keeps every observation, so re-adding the symbol later
     * still has a past to diff against.
     */
    remove(userId, symbol) {
      const normalized = normalizeSymbol(symbol);
      const result = statements.remove.run(userId, normalized);
      return { symbol: normalized, removed: result.changes > 0 };
    },

    /**
     * Stamp "the user has now seen this". Called explicitly by the client
     * rather than as a side effect of listing the watchlist - if merely
     * fetching the page reset the baseline, the deltas would erase themselves
     * on first render and the user could never come back to them.
     */
    markViewed(userId, symbol, at = Date.now()) {
      const normalized = normalizeSymbol(symbol);
      const result = statements.markViewed.run(at, userId, normalized);
      return { symbol: normalized, lastViewedAt: at, updated: result.changes > 0 };
    },

    /**
     * "Mark all as seen" - the same baseline stamp, for every symbol at once.
     *
     * ONE instant for the whole watchlist, and one transaction. Stamping each
     * row with its own Date.now() would leave the rows milliseconds apart, and
     * "how long were you away" is the MINIMUM last_viewed_at across the
     * watchlist - so a partial failure would silently anchor the next visit to
     * whichever row happened to be written first.
     *
     * This moves the user's comparison baseline and nothing else. The snapshot
     * log is not touched, which is not merely a convention here: its
     * append-only triggers would reject the attempt. Market history stays
     * exactly as observed; only the point the user is comparing FROM moves.
     */
    markAllViewed(userId, at = Date.now()) {
      const symbols = statements.list.all(userId).map((row) => row.symbol);

      const stamp = db.transaction(() => {
        for (const symbol of symbols) statements.markViewed.run(at, userId, symbol);
      });
      stamp();

      return { symbols, lastViewedAt: at, updated: symbols.length };
    },

    symbolsInUse() {
      return statements.symbolsInUse.all().map((row) => row.symbol);
    },

    /** Seed a first-boot watchlist so the demo is not an empty page. */
    ensureDefaults(userId, symbols) {
      if (statements.countForUser.get(userId).n > 0) return [];
      return symbols.map((symbol) => this.add(userId, symbol).symbol);
    },
  };
}
