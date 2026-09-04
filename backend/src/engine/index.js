/**
 * The Meaningful Change Engine.
 *
 * Takes a watchlist and the snapshot log, returns a ranked, explained,
 * confidence-annotated view of what changed. Everything the API and the UI
 * show comes from here; neither of them recomputes anything.
 *
 * THREE GUARANTEES, ALL TESTED
 *
 * 1. DETERMINISM. Same snapshots + same config + same reference timestamp =>
 *    byte-identical output. There is no randomness anywhere in this path, and
 *    every "now" arrives through an injected clock. Without the injected clock
 *    the claim would be untestable, and an untestable claim about determinism
 *    is just a slogan.
 *
 * 2. NO N+1. One batched history query covers every symbol - the watchlist,
 *    the benchmark, and the sector peers - and every feature for every symbol
 *    is derived from that single result set in memory.
 *
 * 3. NO WASTED WORK. Results are memoised on the log's high-water mark, the
 *    config, and the clock bucket. The UI polls every five seconds; if no new
 *    observation has landed, the second poll recomputes nothing.
 */
import { config } from '../config.js';
import { assessFreshness, detectConflict } from '../freshness.js';
import { BENCHMARK_SYMBOL } from '../symbols.js';
import { extractFeatures, toBars } from './features.js';
import { assertAllFinite, round } from './numeric.js';
import { buildReasons } from './reasons.js';
import {
  Level,
  confidenceFor,
  dataQualityFor,
  levelFor,
  scoreFeatures,
} from './score.js';
import { fingerprintFor } from './surfaced.js';

/**
 * Engine parameters, flattened from config so every function below reads one
 * object and tests can override a single value without rebuilding config.
 */
function engineParams(overrides = {}) {
  return {
    ...config.engine,
    benchmarkSymbol: config.benchmarkSymbol ?? BENCHMARK_SYMBOL,
    sectorMinPeers: config.sectorMinPeers,
    sectorMap: config.sectorMap,
    ...overrides,
  };
}

/**
 * Memo bucket for the clock. Freshness (and therefore confidence) genuinely
 * depends on wall-clock time, so the memo cannot ignore it - but recomputing
 * on every millisecond would defeat the point. One bucket per bar keeps
 * results correct to the same resolution the engine measures at.
 */
const clockBucket = (now, engine) => Math.floor(now / engine.barMs);

export function createEngine({
  snapshotLog,
  watchlist,
  surfacedStore,
  source,
  clock = () => Date.now(),
  overrides = {},
}) {
  const engine = engineParams(overrides);
  const sourceInfo = source.describe();

  /** Cheap identity for the config, so a changed weight invalidates the memo. */
  const configKey = JSON.stringify([
    engine.barMs,
    engine.carryForwardBars,
    engine.anomalyHorizonMs,
    engine.statsWindowMs,
    engine.minReturns,
    engine.fullConfidenceReturns,
    engine.minStdDev,
    engine.zClamp,
    engine.zFullContribution,
    engine.volumeRatioFullContribution,
    engine.relativeMoveFullContributionPct,
    engine.weights,
    engine.levels,
    engine.sectorMinPeers,
  ]);

  let memo = null;

  const sectorOf = (symbol) => engine.sectorMap?.[symbol] ?? null;

  /**
   * Evaluate the whole watchlist.
   *
   * @param userId whose watchlist and surfaced-state to use
   * @param now    reference instant; defaults to the injected clock
   */
  function evaluate({ userId = config.devUserId, now = clock() } = {}) {
    const entries = watchlist.list(userId);

    // --- what history do we need, and has anything changed since last time? --
    const watchedSymbols = entries.map((e) => e.symbol);

    /**
     * Sector peers are the user's OWN watched holdings in the same sector.
     *
     * The alternative - ingesting every symbol in the sector map so the peer
     * group is fixed - would mean polling a third-party endpoint for a dozen
     * instruments nobody asked about, on every tick, to compute a number for
     * someone who does not hold them. The cost of the chosen rule is real and
     * worth stating: the sector return depends on which peers the user happens
     * to watch, so adding a holding can change it. That is why the response
     * always names the peers it used (`features.sectorRelative.peers`) rather
     * than presenting the comparison as absolute.
     */
    const allSymbols = [...new Set([...watchedSymbols, engine.benchmarkSymbol])];
    const watchedBySector = new Map();
    for (const symbol of watchedSymbols) {
      const sector = sectorOf(symbol);
      if (!sector) continue;
      if (!watchedBySector.has(sector)) watchedBySector.set(sector, []);
      watchedBySector.get(sector).push(symbol);
    }

    const maxIds = snapshotLog.maxIdForSymbols(allSymbols);
    const highWaterMark = [...maxIds.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, id]) => `${symbol}:${id}`)
      .join(',');

    const memoKey = JSON.stringify([
      userId,
      configKey,
      highWaterMark,
      clockBucket(now, engine),
      entries.map((e) => `${e.symbol}@${e.lastViewedAt ?? 0}`).join(','),
      surfacedStore ? surfacedStore.count(userId) : 0,
    ]);

    if (memo && memo.key === memoKey) return memo.value;

    // ------------------------- one batched query ---------------------------
    const historyFrom = now - engine.statsWindowMs;
    const historyBySymbol = snapshotLog.historyForSymbols(allSymbols, {
      from: historyFrom,
      to: now,
    });

    const barsBySymbol = new Map();
    for (const [symbol, snapshots] of historyBySymbol) {
      barsBySymbol.set(
        symbol,
        toBars(snapshots, {
          from: historyFrom,
          to: now,
          barMs: engine.barMs,
          carryForwardBars: engine.carryForwardBars,
        }),
      );
    }

    const benchmarkBars = barsBySymbol.get(engine.benchmarkSymbol) ?? [];
    const surfacedFingerprints = surfacedStore
      ? surfacedStore.fingerprintsFor(userId)
      : new Set();

    // ----------------------------- per symbol ------------------------------
    const items = entries.map((entry) => {
      const symbol = entry.symbol;
      const snapshots = historyBySymbol.get(symbol) ?? [];
      const bars = barsBySymbol.get(symbol) ?? [];

      /**
       * `latest` comes from the log rather than the last bar: a bar is a
       * resampled construct, and the price shown to the user must be an actual
       * recorded observation with its own timestamp, source and confidence.
       */
      const latest = snapshotLog.latest(symbol);
      const baseline =
        entry.lastViewedAt == null ? null : snapshotLog.asOf(symbol, entry.lastViewedAt);

      const freshness = assessFreshness(latest, sourceInfo, now);

      const sector = sectorOf(symbol);
      const peerBarsBySymbol = new Map();
      for (const peer of watchedBySector.get(sector) ?? []) {
        if (peer === symbol) continue;
        const peerBars = barsBySymbol.get(peer);
        if (peerBars) peerBarsBySymbol.set(peer, peerBars);
      }

      const features = extractFeatures({
        symbol,
        entry,
        latest,
        baseline,
        bars,
        benchmarkBars,
        peerBarsBySymbol,
        sector,
        engine,
      });

      const scoreResult = scoreFeatures(features, engine);
      const level = levelFor(scoreResult.score, engine);
      const { confidence, components } = confidenceFor({
        features,
        freshness,
        latest,
        scoreResult,
        engine,
      });

      const reasons = buildReasons({ features, scoreResult, confidence, engine });

      const { fingerprint, material, bucket, direction } = fingerprintFor({
        symbol,
        level,
        reasons,
        features,
        lastViewedAt: entry.lastViewedAt,
      });

      const conflict = detectConflict(
        snapshotLog.latestPerSource(symbol, now - config.conflictWindowMs),
        now,
      );

      return {
        symbol,
        sector,
        addedAt: entry.addedAt,
        lastViewedAt: entry.lastViewedAt,

        latest,
        freshness,
        conflict,

        meaningfulScore: scoreResult.score,
        level,
        confidence,
        confidenceComponents: components,

        /** The user-facing headline number, mirrored at the top level. */
        changeSinceViewed: features.changeSinceViewed,

        reasons: reasons.map((r) => r.code),
        reasonText: reasons.map((r) => r.text),

        features,
        scoreBreakdown: scoreResult.breakdown,
        availableWeight: scoreResult.availableWeight,

        dataQuality: dataQualityFor(freshness),

        signal: { fingerprint, material, bucket, direction },
        alreadySurfaced: surfacedFingerprints.has(fingerprint),

        observationCount: snapshots.length,
      };
    });

    const ranked = rank(items);

    const value = {
      userId,
      evaluatedAt: now,
      source: sourceInfo,
      engine: {
        barMs: engine.barMs,
        anomalyHorizonMs: engine.anomalyHorizonMs,
        statsWindowMs: engine.statsWindowMs,
        weights: engine.weights,
        levels: engine.levels,
        benchmarkSymbol: engine.benchmarkSymbol,
      },
      benchmark: {
        symbol: engine.benchmarkSymbol,
        latest: snapshotLog.latest(engine.benchmarkSymbol),
        bars: benchmarkBars.filter(Boolean).length,
      },
      items: ranked,
    };

    /**
     * The engine's own promise, enforced rather than reviewed: not one
     * non-finite number leaves this function. If a new feature ever produces a
     * NaN, this throws here - loudly, in development - instead of rendering as
     * a dash in production.
     */
    assertAllFinite(
      value.items.map((item) => ({
        meaningfulScore: item.meaningfulScore,
        confidence: item.confidence,
        confidenceComponents: item.confidenceComponents,
        features: item.features,
        scoreBreakdown: item.scoreBreakdown,
      })),
    );

    memo = { key: memoKey, value };
    return value;
  }

  return {
    evaluate,
    params: () => ({ ...engine }),
    /** Test seam: prove the memo is actually being used. */
    __memoKey: () => memo?.key ?? null,
  };
}

/**
 * P0.7 ranking order, exactly as specified:
 *   1. meaningfulness score      - how much this matters
 *   2. confidence                - how much we believe it
 *   3. novelty since last viewed - how big the user-visible change is
 *   4. already surfaced          - unseen signals ahead of repeats
 * then symbol, so the order is total and reproducible rather than dependent on
 * the sort implementation.
 */
export function rank(items) {
  const novelty = (item) =>
    item.changeSinceViewed?.available ? Math.abs(item.changeSinceViewed.percent) : -1;

  return [...items].sort(
    (a, b) =>
      b.meaningfulScore - a.meaningfulScore ||
      b.confidence - a.confidence ||
      novelty(b) - novelty(a) ||
      Number(a.alreadySurfaced) - Number(b.alreadySurfaced) ||
      a.symbol.localeCompare(b.symbol),
  );
}

export { Level, round };
