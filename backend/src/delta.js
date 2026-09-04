/**
 * "What changed since I last looked."
 *
 * This is the product's whole thesis reduced to arithmetic: a per-user,
 * per-symbol time delta between the snapshot the user could have seen when
 * they last visited and the newest one now.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * There is no scoring here - no z-scores, no sector-relative normalisation, no
 * volume-anomaly detection, no ranking of which change "matters most". That
 * engine is the next phase, and building it before the data backbone was solid
 * would have meant tuning a formula on top of a log I could not yet trust.
 * What this returns is the raw, checkable difference: two observations, both
 * timestamped, and the gap between them. A user could verify every number here
 * by hand, which is the standard the eventual scoring layer has to meet too.
 */

/** Why a delta could not be computed - each case means something different. */
export const NoBaselineReason = {
  /** The symbol was added but never opened: there is no "last time" yet. */
  NEVER_VIEWED: 'never_viewed',
  /** They looked, but we had observed nothing by then (e.g. just-added symbol). */
  NO_OBSERVATION_AT_LAST_VIEW: 'no_observation_at_last_view',
  /** We have no current observation to compare against. */
  NO_CURRENT_OBSERVATION: 'no_current_observation',
  /** The newest observation IS the one they saw - no change is computable. */
  NO_NEW_OBSERVATION_SINCE_VIEW: 'no_new_observation_since_view',
};

/**
 * @param baseline  log.asOf(symbol, lastViewedAt) - what they could have seen
 * @param latest    log.latest(symbol) - what we know now
 * @param lastViewedAt epoch ms, or null if never viewed
 */
export function computeDelta({ baseline, latest, lastViewedAt }) {
  if (!latest) {
    return { hasBaseline: false, reason: NoBaselineReason.NO_CURRENT_OBSERVATION };
  }

  if (lastViewedAt == null) {
    return { hasBaseline: false, reason: NoBaselineReason.NEVER_VIEWED, current: latest.price };
  }

  if (!baseline) {
    return {
      hasBaseline: false,
      reason: NoBaselineReason.NO_OBSERVATION_AT_LAST_VIEW,
      current: latest.price,
      lastViewedAt,
    };
  }

  /**
   * The same guard as engine/features.js: if the newest observation is the one
   * the user already saw, there is no delta to report - diffing it against
   * itself would claim "unchanged" when the truth is "nothing new observed".
   * Kept in step deliberately, so the degraded path cannot contradict the
   * engine about the same question.
   */
  if (latest.timestamp <= baseline.timestamp) {
    return {
      hasBaseline: false,
      reason: NoBaselineReason.NO_NEW_OBSERVATION_SINCE_VIEW,
      current: latest.price,
      lastViewedAt,
    };
  }

  const absolute = latest.price - baseline.price;

  return {
    hasBaseline: true,
    lastViewedAt,
    from: {
      price: baseline.price,
      timestamp: baseline.timestamp,
      source: baseline.source,
      confidence: baseline.confidence,
    },
    to: {
      price: latest.price,
      timestamp: latest.timestamp,
      source: latest.source,
      confidence: latest.confidence,
    },
    absolute: Math.round(absolute * 100) / 100,
    percent: Math.round((absolute / baseline.price) * 10_000) / 100,

    /**
     * Volume is reported as a ratio rather than a difference because the
     * absolute figures are only comparable when both came from the same kind
     * of measurement - and they are not always (Yahoo's fallback is a
     * day-cumulative number, see sources/yahoo.js). A ratio at least states
     * the shape of the change; the scoring phase is where volume anomalies get
     * treated rigorously.
     */
    volumeRatio:
      baseline.volume > 0 ? Math.round((latest.volume / baseline.volume) * 100) / 100 : null,

    /**
     * The real elapsed time between the two *observations* - not between the
     * user's visits. If the feed was down for an hour, the user should be told
     * that their comparison spans a different period than they might assume.
     */
    spanMs: latest.timestamp - baseline.timestamp,

    /**
     * The weaker of the two observations bounds how much the delta itself can
     * be trusted: diffing a confident price against a shaky one produces a
     * shaky difference.
     */
    confidence: Math.min(baseline.confidence, latest.confidence),
  };
}
