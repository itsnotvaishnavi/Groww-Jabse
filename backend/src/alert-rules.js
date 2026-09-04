/**
 * The alert rules themselves: types, thresholds, conditions, resets and bands.
 *
 * Extracted into their own module so that the evaluator (alerts.js) and the
 * explainer (alert-diagnostics.js) can BOTH read them without importing each
 * other. That cycle is not merely an inconvenience - it would have forced one
 * of the two to keep a private copy of the rules, and an audit trail that
 * describes a rule differently from the code that fires it is worse than no
 * audit at all.
 *
 * There is exactly one definition of each condition, and it lives here.
 */
import { ValidationError, canonicalizeSymbol } from './symbols.js';
import { isFinite_, round } from './engine/numeric.js';

export const AlertType = {
  PRICE_CROSSES_ABOVE: 'price_crosses_above',
  PRICE_FALLS_BELOW: 'price_falls_below',
  CHANGE_SINCE_VIEWED_EXCEEDS: 'change_since_viewed_exceeds',
  ATTENTION_HIGH: 'attention_high',
  UNUSUAL_VOLUME: 'unusual_volume',
};

/** Which types need a threshold from the user, and how it is validated. */
export const NEEDS_THRESHOLD = {
  [AlertType.PRICE_CROSSES_ABOVE]: { min: 0, label: 'a price' },
  [AlertType.PRICE_FALLS_BELOW]: { min: 0, label: 'a price' },
  [AlertType.CHANGE_SINCE_VIEWED_EXCEEDS]: { min: 0, label: 'a percentage' },
  [AlertType.UNUSUAL_VOLUME]: { min: 1, label: 'a volume multiple above 1' },
  [AlertType.ATTENTION_HIGH]: null,
};

/**
 * Freshness states an alert may be evaluated against.
 *
 * `stale` and `no_data` are excluded because the observation cannot be trusted;
 * `market_closed` is excluded because nothing is moving - treating a closed
 * period as movement is exactly the false positive the brief rules out.
 */
export const EVALUABLE_STATES = new Set(['live', 'delayed']);

export function validateDefinition({ symbol, type, threshold }) {
  const canonical = canonicalizeSymbol(symbol);

  if (!Object.values(AlertType).includes(type)) {
    throw new ValidationError(
      `type must be one of: ${Object.values(AlertType).join(', ')}`,
    );
  }

  const spec = NEEDS_THRESHOLD[type];

  if (spec === null) {
    // A level alert has no threshold; silently accepting one would imply it
    // did something.
    if (threshold != null) {
      throw new ValidationError(`${type} takes no threshold`);
    }
    return { symbol: canonical, type, threshold: null };
  }

  const value = Number(threshold);
  if (!isFinite_(value) || value <= spec.min) {
    throw new ValidationError(`${type} needs a threshold above ${spec.min} (${spec.label})`);
  }

  return { symbol: canonical, type, threshold: value };
}

/**
 * The condition, and its reset.
 *
 * Each type answers two questions separately: is the condition true now, and
 * has the value moved far enough clear of the threshold to count as having come
 * back. Keeping them apart is what makes the hysteresis band explicit rather
 * than an accident of comparison operators.
 */
/**
 * Exported so the "why wasn't I alerted?" diagnosis reads the SAME condition
 * and reset functions that evaluation does. A second, parallel description of
 * each rule would eventually disagree with the one that fires - and an audit
 * trail that disagrees with the thing it audits is worse than none.
 */
export function conditionFor(type) {
  switch (type) {
    case AlertType.PRICE_CROSSES_ABOVE:
      return {
        valueOf: (ctx) => ctx.price,
        triggered: (value, threshold) => value >= threshold,
        reset: (value, threshold, band) => value < threshold - band,
        describe: (value, threshold) =>
          `crossed above ₹${threshold} — observed ₹${round(value, 2)}`,
      };

    case AlertType.PRICE_FALLS_BELOW:
      return {
        valueOf: (ctx) => ctx.price,
        triggered: (value, threshold) => value <= threshold,
        reset: (value, threshold, band) => value > threshold + band,
        describe: (value, threshold) =>
          `fell below ₹${threshold} — observed ₹${round(value, 2)}`,
      };

    case AlertType.CHANGE_SINCE_VIEWED_EXCEEDS:
      return {
        valueOf: (ctx) => ctx.changePct,
        // Magnitude, so a fall of 3% satisfies "changes by more than 2%".
        triggered: (value, threshold) => Math.abs(value) >= threshold,
        reset: (value, threshold, band) => Math.abs(value) < Math.max(0, threshold - band),
        describe: (value, threshold) =>
          `changed ${round(value, 2)}% since you last looked, beyond the ${threshold}% you set`,
      };

    case AlertType.ATTENTION_HIGH:
      return {
        // 1 for HIGH, 0 otherwise: the same machine handles a level as handles
        // a price, so there is one crossing implementation and not two.
        valueOf: (ctx) => (ctx.level === 'HIGH' ? 1 : 0),
        triggered: (value) => value === 1,
        reset: (value) => value === 0,
        describe: (_value, _threshold, ctx) =>
          `attention level became HIGH (score ${ctx.score}, confidence ${ctx.confidence})`,
      };

    case AlertType.UNUSUAL_VOLUME:
      return {
        valueOf: (ctx) => ctx.volumeRatio,
        triggered: (value, threshold) => value >= threshold,
        reset: (value, threshold, band) => value < threshold - band,
        describe: (value, threshold) =>
          `traded at ${round(value, 2)}x normal volume, above the ${threshold}x you set`,
      };

    default:
      throw new ValidationError(`unsupported alert type: ${type}`);
  }
}

/**
 * The hysteresis band, in the units of the value being compared.
 *
 * Proportional for prices - a fixed rupee band would be far too wide for a
 * ₹275 stock and far too narrow for a ₹4,000 one - and absolute for the
 * ratio and percentage types, where the number is already scale-free.
 */
export function bandFor(type, threshold, params) {
  switch (type) {
    case AlertType.PRICE_CROSSES_ABOVE:
    case AlertType.PRICE_FALLS_BELOW:
      return Math.abs(threshold) * params.hysteresisPricePct;
    case AlertType.CHANGE_SINCE_VIEWED_EXCEEDS:
      return params.hysteresisChangePct;
    case AlertType.UNUSUAL_VOLUME:
      return params.hysteresisVolumeRatio;
    default:
      return 0;
  }
}

/**
 * The values every rule is evaluated against, pulled from one engine item.
 *
 * Shared with the diagnosis so "current value" in an explanation is literally
 * the number the condition was tested with.
 */
export function contextFor(item) {
  return {
    price: item?.latest?.price ?? null,
    changePct: item?.changeSinceViewed?.available ? item.changeSinceViewed.percent : null,
    level: item?.level ?? null,
    score: item?.meaningfulScore ?? null,
    confidence: item?.confidence ?? null,
    volumeRatio: item?.features?.volumeAnomaly?.available
      ? item.features.volumeAnomaly.ratio
      : null,
  };
}
