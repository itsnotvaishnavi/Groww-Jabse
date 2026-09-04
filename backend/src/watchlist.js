/**
 * Watchlist storage: add, remove, list, and the one field that makes this
 * product different - last_viewed_at.
 *
 * The brief says keep this boring, and it is. The interesting behaviour lives
 * in the snapshot log and the freshness layer; this is a keyed set of symbols
 * per user with a timestamp attached.
 */

/** Marks the errors that are the caller's fault, so the API layer can map
 *  them to 400 instead of letting everything become a 500. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Tickers are normalised on the way in so that "reliance", "RELIANCE " and
 * "Reliance" are one watchlist entry rather than three. `&` and `-` are
 * allowed for names like M&M and BAJAJ-AUTO, and a `.NS`/`.BO` suffix is
 * permitted so a user can pin a specific exchange.
 */
export function normalizeSymbol(input) {
  if (typeof input !== 'string') {
    throw new TypeError('symbol must be a string');
  }

  const symbol = input.trim().toUpperCase();

  if (!/^[A-Z0-9&\-]{1,18}(\.(NS|BO))?$/.test(symbol)) {
    throw new ValidationError(
      `"${input}" is not a valid ticker. Use letters, digits, & or -, optionally with a .NS/.BO suffix.`,
    );
  }

  return symbol;
}

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
     * A new entry starts with last_viewed_at = NULL, which is meaningfully
     * different from "viewed at the moment it was added": the user has not
     * looked at it yet, so their first visit has no delta to show. Defaulting
     * it to now() would silently claim they had already seen a price.
     */
    add(userId, symbol) {
      const normalized = normalizeSymbol(symbol);
      const result = statements.add.run(userId, normalized, Date.now());
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
