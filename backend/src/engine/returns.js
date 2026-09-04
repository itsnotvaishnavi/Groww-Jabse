/**
 * Turning an irregular observation log into comparable returns.
 *
 * THE PROBLEM THIS SOLVES
 * The log is not evenly spaced. Live ticks land every 15 seconds, boot backfill
 * lands roughly every 54, a dropped tick leaves a hole, and a blackout window
 * leaves a ten-minute one. Computing returns between consecutive rows therefore
 * mixes a 15-second return and a ten-minute return into the same standard
 * deviation - which inflates it, and an inflated standard deviation *suppresses*
 * exactly the anomalies this engine exists to find. The bug would be silent and
 * would look like "the engine is just conservative".
 *
 * So observations are projected onto a fixed bar grid first, using the same
 * as-of rule the rest of the app uses ("the latest observation at or before
 * this instant"), and every return is then measured over the same elapsed time.
 *
 * Carry-forward is capped. Without a cap, a ten-minute outage would fill ten
 * bars with one stale price and produce a run of fake zero returns - which
 * deflates volatility and makes whatever happens next look anomalous. Past the
 * cap the bar is *missing*, and a missing bar produces no return at all.
 */
import { isFinite_, mean, stdDev, zScore } from './numeric.js';

/**
 * Project snapshots onto a fixed grid of bars ending at `to`.
 *
 * @param snapshots ascending by timestamp (as historyForSymbols returns them)
 * @returns array of `{ t, price, volume, stale, sourceTimestamp } | null`,
 *          oldest first, one slot per bar, null where the bar is missing.
 */
export function toBars(snapshots, { from, to, barMs, carryForwardBars }) {
  const bars = [];
  if (!Number.isFinite(barMs) || barMs <= 0) return bars;

  const maxAgeMs = Math.max(1, carryForwardBars) * barMs;
  const firstBar = Math.ceil(from / barMs) * barMs;
  const lastBar = Math.floor(to / barMs) * barMs;

  // One forward pointer over the (already sorted) snapshots: the whole
  // resampling is a single linear pass, not a scan per bar.
  let index = 0;
  let current = null;

  for (let t = firstBar; t <= lastBar; t += barMs) {
    while (index < snapshots.length && snapshots[index].timestamp <= t) {
      current = snapshots[index];
      index += 1;
    }

    if (!current || !isFinite_(current.price) || current.price <= 0) {
      bars.push(null);
      continue;
    }

    const ageMs = t - current.timestamp;
    if (ageMs > maxAgeMs) {
      // The last thing we knew is too old to speak for this bar.
      bars.push(null);
      continue;
    }

    bars.push({
      t,
      price: current.price,
      volume: isFinite_(current.volume) ? current.volume : null,
      /** True when this bar is a carried-forward price rather than a fresh one. */
      stale: ageMs > 0,
      sourceTimestamp: current.timestamp,
      confidence: current.confidence,
      source: current.source,
    });
  }

  return bars;
}

/**
 * Returns measured over a fixed span of `spanBars` bars.
 *
 * Only pairs where BOTH ends exist contribute, so a missing bar removes the
 * returns that would have spanned it rather than silently stretching one.
 *
 * These windows overlap (a return ending at every bar), which makes the samples
 * autocorrelated - the estimate of the standard deviation is still sound, but
 * its own standard error is larger than the raw count suggests. The alternative,
 * non-overlapping windows, would leave roughly 24 samples over a six-hour
 * window at a 15-minute horizon, which is too few to estimate a spread from at
 * all. Documented in the README as a known statistical caveat.
 */
export function spanReturns(bars, spanBars) {
  const out = [];
  if (!Number.isInteger(spanBars) || spanBars < 1) return out;

  for (let i = spanBars; i < bars.length; i += 1) {
    const end = bars[i];
    const start = bars[i - spanBars];
    if (!end || !start || start.price <= 0) continue;

    const r = end.price / start.price - 1;
    if (!isFinite_(r)) continue;

    out.push({ t: end.t, r, from: start, to: end });
  }

  return out;
}

/**
 * The anomaly measurement: the newest span return, z-scored against the
 * distribution of every earlier span return in the window.
 *
 * The current return is excluded from its own baseline. Including it would let
 * an extreme value drag the mean and inflate the standard deviation it is being
 * judged against, biasing every anomaly toward "normal" - most visibly in the
 * small-sample case, which is precisely when the engine is least sure.
 */
export function anomaly(returns, { minReturns, minStdDev, zClamp }) {
  if (returns.length < 1) {
    return { available: false, reason: 'no_returns', sampleSize: 0 };
  }

  const current = returns[returns.length - 1];
  const baseline = returns.slice(0, -1).map((x) => x.r);

  if (baseline.length < minReturns) {
    return {
      available: false,
      reason: 'insufficient_history',
      sampleSize: baseline.length,
      currentReturn: current.r,
    };
  }

  const mu = mean(baseline);
  const sigma = stdDev(baseline, mu);
  const scored = zScore(current.r, { mean: mu, stdDev: sigma }, { minStdDev, clamp: zClamp });

  if (!scored.usable) {
    return {
      available: false,
      reason: 'unusable_statistics',
      sampleSize: baseline.length,
      currentReturn: current.r,
    };
  }

  return {
    available: true,
    z: scored.z,
    currentReturn: current.r,
    baselineMean: mu,
    baselineStdDev: sigma ?? 0,
    /** The stated spread was below the floor - see numeric.js zScore. */
    flooredStdDev: scored.flooredStdDev,
    clamped: scored.clamped,
    sampleSize: baseline.length,
    measuredAt: current.t,
    fromTimestamp: current.from.t,
  };
}

/**
 * Volume of the newest bar against the trailing average of the rest.
 *
 * MISSING VOLUME IS NOT ZERO VOLUME. A source that does not report volume is a
 * gap in our knowledge; a stock that genuinely did not trade is a fact about
 * the market. Conflating them would let the first masquerade as a dramatic
 * volume collapse. Since the log stores volume as a non-negative integer, the
 * distinguishable case is "nothing in this window reported any volume at all",
 * or "the trailing average is zero so no ratio exists" - both of which report
 * unavailable rather than inventing a ratio.
 */
export function volumeRatio(bars, { minReturns }) {
  const present = bars.filter((bar) => bar && isFinite_(bar.volume));
  if (present.length < 2) {
    return { available: false, reason: 'insufficient_history', sampleSize: present.length };
  }

  const latest = present[present.length - 1];
  const trailing = present.slice(0, -1).map((bar) => bar.volume);

  /**
   * The same minimum as the price anomaly, for the same reason and for
   * consistency: "today's volume is 3x the average" computed from a
   * three-observation average is not a finding. Reporting it as available with
   * zero confidence would be worse than declining - it would contribute its
   * full 0.25 of the weight while deserving none of it.
   */
  if (trailing.length < minReturns) {
    return { available: false, reason: 'insufficient_history', sampleSize: trailing.length };
  }

  if (trailing.every((v) => v === 0) && latest.volume === 0) {
    return { available: false, reason: 'volume_not_reported', sampleSize: trailing.length };
  }

  const average = mean(trailing);
  if (average === null || average <= 0) {
    return { available: false, reason: 'no_trailing_volume', sampleSize: trailing.length };
  }

  const ratio = latest.volume / average;
  if (!isFinite_(ratio)) {
    return { available: false, reason: 'unusable_statistics', sampleSize: trailing.length };
  }

  return {
    available: true,
    ratio,
    latestVolume: latest.volume,
    averageVolume: average,
    sampleSize: trailing.length,
    lowSample: trailing.length < minReturns,
  };
}

/** The plain return over the span, without the statistics. Used for the
 *  market- and sector-relative differences. */
export function latestSpanReturn(returns) {
  if (returns.length === 0) return null;
  const last = returns[returns.length - 1];
  return isFinite_(last.r) ? last.r : null;
}
