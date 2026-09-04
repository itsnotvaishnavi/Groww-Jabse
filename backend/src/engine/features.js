/**
 * Feature extraction: five measurements, no decisions.
 *
 * Nothing here scores, ranks or judges. Each feature reports what the data
 * says, whether it could say it at all, and how much it should be trusted -
 * and those are three separate fields, on purpose. Collapsing "unavailable"
 * into "zero" is the single easiest way to make an anomaly engine lie, because
 * a missing signal then looks exactly like a calm one.
 *
 * Every feature therefore carries:
 *   available   - could this be computed honestly?
 *   reason      - if not, why not (a code, not prose)
 *   confidence  - 0..1, how much the number deserves to be believed
 */
import { clamp, isFinite_, mean, round, safeDiv } from './numeric.js';
import { anomaly, latestSpanReturn, spanReturns, toBars, volumeRatio } from './returns.js';

/** A feature that could not be computed. Never carries a numeric value. */
const unavailable = (reason, extra = {}) => ({
  available: false,
  reason,
  confidence: 0,
  ...extra,
});

/**
 * Confidence from sample size: nothing below the minimum, ramping linearly to
 * full at `fullConfidenceReturns`. A z-score from 21 samples and one from 400
 * are both computable; only one of them is worth much.
 */
function sampleConfidence(n, { minReturns, fullConfidenceReturns }) {
  if (n < minReturns) return 0;
  const span = Math.max(1, fullConfidenceReturns - minReturns);
  return clamp((n - minReturns) / span, 0, 1) * 0.5 + 0.5;
}

/**
 * FEATURE A - Change since the user last viewed this symbol.
 *
 * The baseline must be an observation the application actually recorded at or
 * before the user's last visit. Reconstructing what the price "really was"
 * then, using data that arrived afterwards, would produce a change the user
 * could not possibly have seen - which is the one thing this product must not
 * do, because its entire claim is that the diff is honest.
 *
 * Never viewed is unavailable, not zero: "nothing has changed" and "there is no
 * before" are different statements.
 */
export function changeSinceViewed({ latest, baseline, lastViewedAt }) {
  if (!latest) return unavailable('no_current_observation');
  if (lastViewedAt == null) return unavailable('never_viewed');
  if (!baseline) return unavailable('no_observation_at_last_view', { lastViewedAt });

  const absolute = latest.price - baseline.price;
  const percent = safeDiv(absolute, baseline.price);
  if (percent === null) return unavailable('unusable_baseline_price');

  return {
    available: true,
    absolute: round(absolute, 2),
    percent: round(percent * 100, 2),
    fromPrice: baseline.price,
    toPrice: latest.price,
    fromTimestamp: baseline.timestamp,
    toTimestamp: latest.timestamp,
    spanMs: latest.timestamp - baseline.timestamp,
    lastViewedAt,
    /** A diff is only as good as its weaker end. */
    confidence: Math.min(baseline.confidence, latest.confidence),
  };
}

/**
 * FEATURE B - Price anomaly.
 *
 * Answers "is this movement unusual *for this stock*", which is a different
 * question from "did the price move". A 0.4% move is unremarkable for ZOMATO
 * and remarkable for HDFCBANK, and only the stock's own recent distribution
 * knows which.
 */
export function priceAnomaly(bars, engine) {
  const spanBars = Math.max(1, Math.round(engine.anomalyHorizonMs / engine.barMs));
  const returns = spanReturns(bars, spanBars);
  const result = anomaly(returns, engine);

  if (!result.available) {
    return unavailable(result.reason, { sampleSize: result.sampleSize });
  }

  /**
   * A floored standard deviation means the stock had essentially no measurable
   * volatility to compare against, so the z-score is arithmetically valid but
   * evidentially weak. Halving confidence says so instead of hiding it.
   */
  const confidence =
    sampleConfidence(result.sampleSize, engine) * (result.flooredStdDev ? 0.5 : 1);

  return {
    available: true,
    z: round(result.z, 2),
    returnPct: round(result.currentReturn * 100, 3),
    baselineMeanPct: round(result.baselineMean * 100, 4),
    baselineStdDevPct: round(result.baselineStdDev * 100, 4),
    horizonMs: spanBars * engine.barMs,
    sampleSize: result.sampleSize,
    flooredStdDev: result.flooredStdDev,
    clamped: result.clamped,
    confidence: round(confidence, 3),
  };
}

/**
 * FEATURE C - Volume anomaly, as a ratio to the trailing average.
 *
 * A ratio rather than a difference because raw share counts are not comparable
 * across instruments, and because the sources do not always measure volume the
 * same way (see sources/yahoo.js on its day-cumulative fallback).
 */
export function volumeAnomaly(bars, engine) {
  const result = volumeRatio(bars, engine);
  if (!result.available) {
    return unavailable(result.reason, { sampleSize: result.sampleSize });
  }

  return {
    available: true,
    ratio: round(result.ratio, 2),
    latestVolume: result.latestVolume,
    averageVolume: round(result.averageVolume, 0),
    sampleSize: result.sampleSize,
    confidence: round(sampleConfidence(result.sampleSize, engine), 3),
  };
}

/**
 * FEATURE D - Market-relative move: the symbol's return minus the benchmark's,
 * over the same window.
 *
 * This is what stops a market-wide rally from being reported as four separate
 * exciting discoveries. If everything rose 2%, no individual stock did anything
 * that deserves the user's attention.
 */
export function marketRelative({ symbolBars, benchmarkBars }, engine) {
  const spanBars = Math.max(1, Math.round(engine.anomalyHorizonMs / engine.barMs));

  const symbolReturn = latestSpanReturn(spanReturns(symbolBars, spanBars));
  if (symbolReturn === null) return unavailable('insufficient_history');

  /**
   * Two distinct failures, reported distinctly. `toBars` returns a dense grid
   * padded with nulls, so a benchmark that was never ingested still yields a
   * non-empty array - checking length alone would misreport "we have no
   * benchmark at all" as "the benchmark has a gap here". The first is a
   * configuration or ingestion problem worth fixing; the second is ordinary
   * missing data.
   */
  const benchmarkHasAnyData = (benchmarkBars ?? []).some((bar) => bar !== null);
  if (!benchmarkHasAnyData) return unavailable('benchmark_unavailable');

  const benchmarkReturn = latestSpanReturn(spanReturns(benchmarkBars, spanBars));
  if (benchmarkReturn === null) return unavailable('benchmark_no_data_for_window');

  const excess = symbolReturn - benchmarkReturn;

  return {
    available: true,
    excessPct: round(excess * 100, 3),
    symbolReturnPct: round(symbolReturn * 100, 3),
    benchmarkReturnPct: round(benchmarkReturn * 100, 3),
    benchmarkSymbol: engine.benchmarkSymbol,
    horizonMs: spanBars * engine.barMs,
    /**
     * Full confidence: this is a difference of two directly measured returns
     * over the same window, with no distributional estimate involved. The
     * uncertainty that remains is in the observations themselves, and the
     * engine folds that in separately via data freshness.
     */
    confidence: 1,
  };
}

/**
 * FEATURE E - Sector-relative move: the symbol's return minus the mean return
 * of its watched sector peers.
 *
 * Requires a sector AND at least `sectorMinPeers` peers with data. One peer is
 * not a sector, and a symbol absent from the static map has no sector at all -
 * a fabricated classification would produce a confidently wrong signal, which
 * is worse than an honest gap.
 */
export function sectorRelative({ symbol, symbolBars, peerBarsBySymbol, sector }, engine) {
  if (!sector) return unavailable('no_sector_mapping');

  const spanBars = Math.max(1, Math.round(engine.anomalyHorizonMs / engine.barMs));

  const symbolReturn = latestSpanReturn(spanReturns(symbolBars, spanBars));
  if (symbolReturn === null) return unavailable('insufficient_history', { sector });

  const peerReturns = [];
  for (const [peer, bars] of peerBarsBySymbol) {
    if (peer === symbol) continue;
    const r = latestSpanReturn(spanReturns(bars, spanBars));
    if (r !== null) peerReturns.push({ peer, r });
  }

  if (peerReturns.length < engine.sectorMinPeers) {
    return unavailable('insufficient_peers', {
      sector,
      peersWithData: peerReturns.length,
      peersRequired: engine.sectorMinPeers,
    });
  }

  const peerMean = mean(peerReturns.map((p) => p.r));
  if (!isFinite_(peerMean)) return unavailable('unusable_peer_returns', { sector });

  const excess = symbolReturn - peerMean;

  return {
    available: true,
    sector,
    excessPct: round(excess * 100, 3),
    symbolReturnPct: round(symbolReturn * 100, 3),
    sectorReturnPct: round(peerMean * 100, 3),
    peers: peerReturns.map((p) => p.peer),
    peersWithData: peerReturns.length,
    horizonMs: spanBars * engine.barMs,
    /**
     * A sector mean from two peers is a weaker statement than one from six, so
     * confidence scales with peer count and tops out at five.
     */
    confidence: round(clamp(peerReturns.length / 5, 0.4, 1), 3),
  };
}

/**
 * Build every feature for one symbol.
 *
 * `bars` for the symbol, its benchmark and its sector peers are all passed in
 * already resampled - the caller does that once from a single batched query,
 * rather than each feature going back to the database.
 */
export function extractFeatures({
  symbol,
  entry,
  latest,
  baseline,
  bars,
  benchmarkBars,
  peerBarsBySymbol,
  sector,
  engine,
}) {
  return {
    changeSinceViewed: changeSinceViewed({
      latest,
      baseline,
      lastViewedAt: entry?.lastViewedAt ?? null,
    }),
    priceAnomaly: priceAnomaly(bars, engine),
    volumeAnomaly: volumeAnomaly(bars, engine),
    marketRelative: marketRelative({ symbolBars: bars, benchmarkBars }, engine),
    sectorRelative: sectorRelative(
      { symbol, symbolBars: bars, peerBarsBySymbol, sector },
      engine,
    ),
  };
}

export { toBars };
