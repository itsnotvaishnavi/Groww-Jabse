/**
 * The ingestion loop: poll the active source, append what it says to the log.
 *
 * Three things this is careful about, all of them failure-shaped:
 *   1. One symbol's error must not stop the other symbols, and must not kill
 *      the loop. A feed that 404s on one ticker is a normal Tuesday.
 *   2. `null` (the source has no observation for that instant) and a thrown
 *      error (the source is broken) are recorded differently, because the
 *      first is data and the second is an incident.
 *   3. A slow poll must not stack up behind the next one. If a tick is still
 *      running when the timer fires again, the new one is skipped rather than
 *      run concurrently against the same rows.
 */
import { config } from './config.js';

export function createIngestor({ source, snapshotLog, watchlist, intervalMs }) {
  const sourceInfo = source.describe();

  const stats = {
    source: source.name,
    ticks: 0,
    written: 0,
    duplicates: 0,
    absences: 0,
    failures: 0,
    skippedOverlaps: 0,
    lastTickAt: null,
    lastTickDurationMs: null,
    lastError: null,
    /** Consecutive failures per symbol - a symbol that is reliably broken. */
    failingSymbols: {},
  };

  let timer = null;
  let running = false;

  /**
   * Symbols worth polling: what someone is watching, plus the benchmark.
   *
   * The benchmark is always polled even though nobody holds it, because the
   * market-relative signal is worthless without it - and it has to be ingested
   * on the same cadence as everything else, or "symbol return minus benchmark
   * return over the same window" would be comparing two different windows.
   */
  function symbolsToPoll() {
    const watched = watchlist.symbolsInUse();
    const base = watched.length > 0 ? watched : config.defaultSymbols;
    return [...new Set([...base, config.benchmarkSymbol])];
  }

  function recordFailure(symbol, error) {
    stats.failures += 1;
    stats.failingSymbols[symbol] = (stats.failingSymbols[symbol] ?? 0) + 1;
    stats.lastError = {
      symbol,
      message: error.message,
      at: Date.now(),
    };
  }

  function recordSuccess(symbol) {
    delete stats.failingSymbols[symbol];
  }

  /** Poll every watched symbol once. Never throws. */
  async function tick() {
    if (running) {
      stats.skippedOverlaps += 1;
      return { skipped: true };
    }

    running = true;
    const startedAt = Date.now();
    let written = 0;

    try {
      for (const symbol of symbolsToPoll()) {
        try {
          const snapshot = await source.getLatestSnapshot(symbol);

          if (!snapshot) {
            // A real absence: a dropped tick, or a symbol with no trades. Not
            // an error, and emphatically not a reason to invent a price.
            stats.absences += 1;
            recordSuccess(symbol);
            continue;
          }

          if (snapshotLog.append(snapshot)) written += 1;
          else stats.duplicates += 1;

          recordSuccess(symbol);
        } catch (error) {
          recordFailure(symbol, error);
        }
      }
    } finally {
      running = false;
      stats.ticks += 1;
      stats.written += written;
      stats.lastTickAt = Date.now();
      stats.lastTickDurationMs = Date.now() - startedAt;
    }

    return { written, durationMs: stats.lastTickDurationMs };
  }

  /**
   * Reconstruct recent history into the log.
   *
   * A "what changed since you last looked" product is useless on a fresh clone
   * with an empty log - there is no past to diff against, so every symbol
   * reads "no baseline" until enough wall-clock time has passed. Rather than
   * ask the demo to wait, we ask the source what the recent past looked like.
   * This is the concrete reason getSnapshotAt is on the DataSource interface
   * and not just on the log.
   *
   * Points are spread evenly across the window and capped, so a large
   * backfillHours widens coverage instead of lengthening boot.
   */
  async function backfill({ hours = config.backfillHours, now = Date.now() } = {}) {
    if (hours <= 0) return { points: 0, written: 0 };

    const spanMs = hours * 60 * 60 * 1000;
    const idealPoints = Math.floor(spanMs / intervalMs);
    const points = Math.max(1, Math.min(config.backfillMaxPoints, idealPoints));
    const stepMs = Math.floor(spanMs / points);

    let written = 0;
    let requested = 0;

    for (const symbol of symbolsToPoll()) {
      const batch = [];

      for (let i = points; i >= 1; i -= 1) {
        const at = now - i * stepMs;
        requested += 1;
        try {
          const snapshot = await source.getSnapshotAt(symbol, at);
          if (snapshot) batch.push(snapshot);
        } catch (error) {
          // Backfill is best-effort by nature: it is a convenience for the
          // demo, not a correctness requirement. Give up on this symbol rather
          // than hammering a failing endpoint several hundred more times.
          recordFailure(symbol, error);
          break;
        }
      }

      if (batch.length > 0) written += snapshotLog.appendMany(batch);
    }

    return { points: requested, written };
  }

  return {
    stats: () => ({ ...stats, intervalMs, sourceInfo }),
    tick,
    backfill,

    start() {
      if (timer) return;
      // Fire immediately so the app has current data without waiting out one
      // interval, then settle into the cadence.
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      // Do not hold the event loop open on the timer's account: the HTTP
      // server is what keeps this process alive, and a test that forgets to
      // stop the ingestor should still exit.
      timer.unref?.();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
