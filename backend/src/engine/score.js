/**
 * The Meaningful Change Score.
 *
 * WHY THIS IS ARITHMETIC AND NOT A MODEL
 * There is no ML library here, and that is a decision rather than a shortfall.
 * A weighted sum of rolling statistics is deterministic, unit-testable,
 * dependency-free, runs in microseconds, and can be explained line by line to
 * a user who asks "why did you show me this". An Isolation Forest would score
 * this data no better, could not be justified to the person reading the row,
 * and would make the "identical inputs produce identical output" guarantee
 * dependent on someone else's random_state. The README states the tradeoff.
 *
 * SCORE AND CONFIDENCE ARE DIFFERENT THINGS
 * The score says how much this change matters. The confidence says how much
 * the score itself deserves to be believed. A 3-sigma move measured off a
 * stale feed with twenty samples is high-score and low-confidence, and
 * collapsing those into one number would throw away the more actionable half.
 */
import { clamp, normalizeMagnitude, round, saturatingMagnitude } from './numeric.js';

export const Level = {
  LOW: 'LOW',
  MODERATE: 'MODERATE',
  HIGH: 'HIGH',
};

/**
 * How much each available feature contributes, on a 0..1 scale.
 *
 * Each returns null when its feature is unavailable, which is what drives
 * renormalisation - a null is excluded from both the numerator and the
 * denominator, so it neither helps nor penalises.
 */
const CONTRIBUTORS = {
  priceAnomaly(features, engine) {
    const f = features.priceAnomaly;
    if (!f.available) return null;
    // Direction is irrelevant to whether a move is unusual: a 3-sigma fall is
    // exactly as much of an event as a 3-sigma rise.
    return normalizeMagnitude(f.z, engine.zFullContribution);
  },

  volumeAnomaly(features, engine) {
    const f = features.volumeAnomaly;
    if (!f.available) return null;
    /**
     * Only volume ABOVE normal counts. A quiet day is not an event, so the
     * excess over 1.0 is what is measured - otherwise a ratio of 0.2 would
     * score as strongly as a ratio of 1.8.
     */
    const excess = Math.max(0, f.ratio - 1);
    return normalizeMagnitude(excess, engine.volumeRatioFullContribution - 1);
  },

  /**
   * The relative signals scale with the size of the excess rather than
   * clamping. A clamped mapping reported 1.0 for anything past 1.5%, so a
   * -2.08% excess and a -20% excess contributed identically - and those are not
   * remotely the same event. See numeric.js saturatingMagnitude.
   */
  marketRelative(features, engine) {
    const f = features.marketRelative;
    if (!f.available) return null;
    return saturatingMagnitude(f.excessPct, engine.relativeMoveHalfContributionPct);
  },

  sectorRelative(features, engine) {
    const f = features.sectorRelative;
    if (!f.available) return null;
    return saturatingMagnitude(f.excessPct, engine.relativeMoveHalfContributionPct);
  },
};

/**
 * Combine the available signals into a score in [0, 1].
 *
 * RENORMALISATION IS THE IMPORTANT PART. If the sector signal is unavailable,
 * the weighted sum is divided by 0.80 rather than by 1.00. Dividing by 1.00
 * would treat "we could not measure the sector" as "the sector said nothing
 * was happening", which silently caps an unsectored stock at 80% of the score
 * it deserves - and every symbol outside the static map is in that position.
 */
export function scoreFeatures(features, engine) {
  const breakdown = {};
  let weighted = 0;
  let availableWeight = 0;

  for (const [name, contribute] of Object.entries(CONTRIBUTORS)) {
    const weight = engine.weights[name] ?? 0;
    const contribution = contribute(features, engine);

    if (contribution === null) {
      breakdown[name] = {
        available: false,
        reason: features[name]?.reason ?? 'unavailable',
        weight,
      };
      continue;
    }

    weighted += weight * contribution;
    availableWeight += weight;
    /**
     * Six decimal places, not three. The breakdown exists so that someone can
     * recompute the score by hand and get the same answer - if the published
     * components only reproduce it to two places, the audit trail is decorative
     * and the "transparent formula" claim is not quite true. There is a test
     * that recomputes the score from these fields.
     */
    breakdown[name] = {
      available: true,
      weight,
      contribution: round(contribution, 6),
      weighted: round(weight * contribution, 6),
    };
  }

  /**
   * No signal at all is score 0 - but note it is 0 with `availableWeight: 0`,
   * so a caller can tell "nothing was measurable" apart from "everything was
   * measured and nothing was happening". Those look identical in the score and
   * must not look identical in the explanation.
   */
  const score = availableWeight > 0 ? clamp(weighted / availableWeight, 0, 1) : 0;

  return {
    score: round(score, 4),
    availableWeight: round(availableWeight, 3),
    totalWeight: round(
      Object.values(engine.weights).reduce((sum, w) => sum + w, 0),
      3,
    ),
    breakdown,
  };
}

/**
 * Absolute thresholds, deliberately not percentile ranking within the
 * watchlist. Under percentile ranking a stock's level would change because the
 * user added an unrelated stock - the label would describe the watchlist rather
 * than the instrument, and the already-surfaced fingerprint would churn every
 * time the list did.
 */
export function levelFor(score, engine) {
  if (score >= engine.levels.high) return Level.HIGH;
  if (score >= engine.levels.moderate) return Level.MODERATE;
  return Level.LOW;
}

/**
 * The level floor: relative signals alone cannot carry a symbol above LOW.
 *
 * If the stock's own movement is unremarkable AND the user has seen nothing
 * change since their last visit, then whatever the index or the sector did,
 * nothing much happened to *their* stock - and telling them it deserves
 * attention would be the engine mistaking context for news.
 *
 * An unavailable signal counts as negligible on purpose: if we could not
 * measure the stock's own move, we have no evidence it did anything notable,
 * and absence of evidence must not be promoted to a MODERATE.
 *
 * The score is deliberately NOT altered - it is the honest output of the
 * formula, and silently rewriting it would break the published breakdown that
 * is supposed to reproduce it. Only the level is capped, and the caller is told.
 */
export function applyLevelFloor({ level, features, engine }) {
  if (level === Level.LOW) return { level, capped: false };

  const price = features.priceAnomaly;
  const change = features.changeSinceViewed;
  const volume = features.volumeAnomaly;

  const zMagnitude = price.available ? Math.abs(price.z) : 0;
  const changeMagnitude = change.available ? Math.abs(change.percent) : 0;
  const volumeRatio = volume.available ? volume.ratio : 1;

  /**
   * Volume is part of the test, and that is a deliberate reading of "on
   * relative signals alone".
   *
   * Gating on the price z-score and the user-visible change ONLY would have
   * suppressed the volume-spike case - a stock moving 0.4% on three times its
   * normal turnover - which is the single most valuable thing this engine
   * finds and the one an ordinary percentage-change watchlist always misses.
   * Volume is a fact about THIS stock, not about the index, so heavy trading
   * means something did happen here and the floor must not fire.
   */
  const ownMoveNegligible = zMagnitude < engine.levelFloorMinZ;
  const userVisibleChangeNegligible = changeMagnitude < engine.levelFloorMinChangePct;
  const turnoverNegligible = volumeRatio < engine.levelFloorMinVolumeRatio;

  if (ownMoveNegligible && userVisibleChangeNegligible && turnoverNegligible) {
    return {
      level: Level.LOW,
      capped: true,
      cappedFrom: level,
      reason: 'nothing_notable_about_this_stock',
      zMagnitude: round(zMagnitude, 2),
      changeMagnitude: round(changeMagnitude, 2),
      volumeRatio: round(volumeRatio, 2),
    };
  }

  return { level, capped: false };
}

/**
 * ONE definition of attention-worthy, used by the watchlist chip, the summary
 * banner and the ranking alike.
 *
 * These had drifted apart: the summary counted HIGH and MODERATE while the UI
 * chip counted stale-or-conflicting rows, so the same screen could show
 * "Needs attention 0" beside "2 deserve your attention". Two definitions of one
 * word is a bug however each is individually defensible, so the engine computes
 * it once per item and everything else reads that field.
 *
 * Note it is deliberately about MEANINGFULNESS, not data health: a stale feed
 * is reported through `dataQuality` and the freshness pill, which is a separate
 * question from whether the market did something worth looking at.
 */
export function needsAttentionFor(level) {
  return level === Level.HIGH || level === Level.MODERATE;
}

/**
 * Confidence in the score, from four independent sources of doubt, multiplied
 * because they compound: a stale feed AND thin history is worse than either.
 *
 *   observation - the source's own confidence in the latest price
 *   freshness   - how current that observation is (the freshness state)
 *   depth       - how much history the statistics had to work with
 *   coverage    - how much of the total signal weight was measurable at all
 */
const FRESHNESS_FACTOR = {
  live: 1,
  delayed: 0.9,
  market_closed: 0.85,
  stale: 0.5,
  no_data: 0,
};

export function confidenceFor({ features, freshness, latest, scoreResult, engine }) {
  const observation = clamp(latest?.confidence ?? 0, 0, 1);
  const fresh = FRESHNESS_FACTOR[freshness?.state] ?? 0.5;

  // Depth: the mean confidence of the features that were actually available,
  // which already encode their own sample sizes and floored-sd penalties.
  const availableConfidences = Object.entries(features)
    .filter(([name, f]) => f.available && name !== 'changeSinceViewed')
    .map(([, f]) => clamp(f.confidence ?? 0, 0, 1));

  const depth =
    availableConfidences.length === 0
      ? 0
      : availableConfidences.reduce((sum, c) => sum + c, 0) / availableConfidences.length;

  const coverage =
    scoreResult.totalWeight > 0 ? scoreResult.availableWeight / scoreResult.totalWeight : 0;

  const confidence = observation * fresh * depth * coverage;

  return {
    confidence: round(clamp(confidence, 0, 1), 3),
    components: {
      observation: round(observation, 3),
      freshness: round(fresh, 3),
      depth: round(depth, 3),
      coverage: round(coverage, 3),
    },
  };
}

/** Which data-quality bucket the result was computed under, for the API. */
export function dataQualityFor(freshness) {
  return (freshness?.state ?? 'no_data').toUpperCase();
}
