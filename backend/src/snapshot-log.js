/**
 * The snapshot log: the only way anything writes to or reads from `snapshots`.
 *
 * There is no update method and no delete method. That is not an oversight -
 * the table's triggers would reject them anyway (see ./db.js). The log grows,
 * and every question about the past is a query, never a mutation.
 *
 * Symbols are canonicalised on write and on read (see ./symbols.js), so
 * `RELIANCE`, `reliance` and `RELIANCE.NS` are one series rather than three.
 * Doing it here rather than in each caller is the point: the log is the
 * boundary, and a boundary that trusts its callers to normalise will
 * eventually be handed something that was not.
 */
import { canonicalizeSymbol } from './symbols.js';

/** DB rows are snake_case; the rest of the app speaks camelCase. */
function toSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    symbol: row.symbol,
    timestamp: row.timestamp,
    price: row.price,
    volume: row.volume,
    source: row.source,
    confidence: row.confidence,
    ingestedAt: row.ingested_at,
  };
}

/**
 * Validated at the boundary rather than trusting callers. A source adapter
 * parsing someone else's JSON is exactly the place a NaN price or a
 * seconds-instead-of-milliseconds timestamp gets in, and a log that promises
 * never to rewrite itself cannot afford to accept a bad row and fix it later.
 */
function assertValid(snapshot) {
  const { symbol, timestamp, price, volume, source, confidence } = snapshot ?? {};

  if (typeof symbol !== 'string' || symbol.length === 0) {
    throw new TypeError('snapshot.symbol must be a non-empty string');
  }
  /**
   * The lower bound is what actually catches the classic mistake. Every one of
   * these APIs quotes time in seconds, and a seconds value is still a perfectly
   * valid positive integer - it just silently means 1970. Anything before
   * 2000-01-01 in milliseconds is therefore a unit error, not a real
   * observation, and is rejected rather than logged as a 55-year-old price.
   */
  const YEAR_2000_MS = 946_684_800_000;
  if (!Number.isInteger(timestamp) || timestamp < YEAR_2000_MS) {
    throw new TypeError(
      `snapshot.timestamp must be epoch milliseconds, got ${timestamp}` +
        (timestamp > 0 && timestamp < YEAR_2000_MS ? ' (looks like seconds)' : ''),
    );
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new TypeError(`snapshot.price must be a positive number, got ${price}`);
  }
  if (!Number.isFinite(volume) || volume < 0) {
    throw new TypeError(`snapshot.volume must be a non-negative number, got ${volume}`);
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('snapshot.source must be a non-empty string');
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError(`snapshot.confidence must be within 0..1, got ${confidence}`);
  }
}

export function createSnapshotLog(db) {
  // Statements are prepared once and reused. With the ingestion loop writing
  // every few seconds, re-parsing this SQL each time would be pure waste.
  const statements = {
    insert: db.prepare(`
      INSERT OR IGNORE INTO snapshots
        (symbol, timestamp, price, volume, source, confidence, ingested_at)
      VALUES (@symbol, @timestamp, @price, @volume, @source, @confidence, @ingestedAt)
    `),

    latest: db.prepare(`
      SELECT * FROM snapshots
      WHERE symbol = ?
      ORDER BY timestamp DESC, ingested_at DESC, id DESC
      LIMIT 1
    `),

    /**
     * The most recent observation at or before an instant. This is the query
     * behind every "since I last looked" baseline: the user's delta must be
     * measured against what this app had actually observed by then, not
     * against a value reconstructed with hindsight.
     */
    asOf: db.prepare(`
      SELECT * FROM snapshots
      WHERE symbol = ? AND timestamp <= ?
      ORDER BY timestamp DESC, ingested_at DESC, id DESC
      LIMIT 1
    `),

    history: db.prepare(`
      SELECT * FROM snapshots
      WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `),

    /**
     * The newest observation from each source that has spoken recently. Window
     * function rather than a correlated subquery: one pass, and it reads the
     * way the question is asked.
     */
    latestPerSource: db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY source ORDER BY timestamp DESC, ingested_at DESC, id DESC
        ) AS rn
        FROM snapshots
        WHERE symbol = ? AND timestamp >= ?
      ) WHERE rn = 1
    `),

    distinctSymbols: db.prepare('SELECT DISTINCT symbol FROM snapshots ORDER BY symbol'),

    count: db.prepare('SELECT COUNT(*) AS n FROM snapshots'),

    oldest: db.prepare('SELECT MIN(timestamp) AS t FROM snapshots'),
  };

  const insertMany = db.transaction((snapshots) => {
    let inserted = 0;
    for (const snapshot of snapshots) {
      inserted += statements.insert.run(snapshot).changes;
    }
    return inserted;
  });

  /** Validate, canonicalise the symbol, and round the numeric fields once. */
  function toRow(snapshot, ingestedAt) {
    assertValid(snapshot);
    return {
      ...snapshot,
      symbol: canonicalizeSymbol(snapshot.symbol),
      timestamp: Math.round(snapshot.timestamp),
      volume: Math.round(snapshot.volume),
      ingestedAt: snapshot.ingestedAt ?? ingestedAt,
    };
  }

  return {
    /**
     * Record one observation. Returns false when the row was a duplicate,
     * which callers use to distinguish "the feed gave us something new" from
     * "the feed repeated itself" without treating the latter as an error.
     */
    append(snapshot) {
      return statements.insert.run(toRow(snapshot, Date.now())).changes > 0;
    },

    /** Bulk append in a single transaction - used by the boot backfill. */
    appendMany(snapshots) {
      const now = Date.now();
      return insertMany(snapshots.map((snapshot) => toRow(snapshot, now)));
    },

    latest(symbol) {
      return toSnapshot(statements.latest.get(canonicalizeSymbol(symbol)));
    },

    /**
     * Latest snapshot for many symbols in one query. A watchlist page asking
     * per symbol would be a textbook N+1; partitioning once is the same work
     * for one symbol and far less for twenty.
     */
    latestForSymbols(symbols) {
      const result = new Map();
      if (symbols.length === 0) return result;

      const keys = symbols.map(canonicalizeSymbol);
      const placeholders = keys.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (
               PARTITION BY symbol ORDER BY timestamp DESC, ingested_at DESC, id DESC
             ) AS rn
             FROM snapshots
             WHERE symbol IN (${placeholders})
           ) WHERE rn = 1`,
        )
        .all(keys);

      for (const row of rows) result.set(row.symbol, toSnapshot(row));
      return result;
    },

    asOf(symbol, timestamp) {
      return toSnapshot(statements.asOf.get(canonicalizeSymbol(symbol), timestamp));
    },

    history(symbol, { from = 0, to = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
      return statements.history
        .all(canonicalizeSymbol(symbol), from, to, limit)
        .map(toSnapshot);
    },

    /**
     * History for many symbols in ONE query, oldest first per symbol.
     *
     * This is what keeps the scoring engine off the N+1 path: every feature for
     * every symbol is derived from this single result set in memory, rather
     * than each symbol issuing its own query for each of its features. See
     * engine/index.js for the batching contract that depends on it.
     */
    historyForSymbols(symbols, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      const result = new Map();
      if (symbols.length === 0) return result;

      const keys = [...new Set(symbols.map(canonicalizeSymbol))];
      for (const key of keys) result.set(key, []);

      const placeholders = keys.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT * FROM snapshots
           WHERE symbol IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
           ORDER BY symbol ASC, timestamp ASC, ingested_at ASC, id ASC`,
        )
        .all(...keys, from, to);

      for (const row of rows) result.get(row.symbol).push(toSnapshot(row));
      return result;
    },

    /**
     * The highest row id currently in the log, per symbol. The engine memoises
     * on this: if no symbol has gained an observation, nothing can have
     * changed, so nothing needs recomputing.
     */
    maxIdForSymbols(symbols) {
      const result = new Map();
      if (symbols.length === 0) return result;

      const keys = [...new Set(symbols.map(canonicalizeSymbol))];
      const placeholders = keys.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT symbol, MAX(id) AS max_id FROM snapshots
           WHERE symbol IN (${placeholders}) GROUP BY symbol`,
        )
        .all(keys);

      for (const row of rows) result.set(row.symbol, row.max_id);
      return result;
    },

    latestPerSource(symbol, since = 0) {
      return statements.latestPerSource
        .all(canonicalizeSymbol(symbol), since)
        .map(toSnapshot);
    },

    distinctSymbols() {
      return statements.distinctSymbols.all().map((row) => row.symbol);
    },

    stats() {
      return {
        snapshots: statements.count.get().n,
        oldestTimestamp: statements.oldest.get().t ?? null,
      };
    },
  };
}
