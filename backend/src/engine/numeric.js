/**
 * Numerical safety.
 *
 * Every arithmetic hazard in the scoring engine is handled here, in one place,
 * so the answer to "what happens when the standard deviation is zero" is a
 * function with a test rather than a hope about the call site.
 *
 * The rule the whole engine obeys: NO output is ever NaN or Infinity. A
 * quantity we cannot compute honestly is reported as unavailable with a reason,
 * never as a number that happens to be finite-looking garbage. A score that
 * silently becomes NaN and renders as "-" is a bug the user cannot see; an
 * explicit "not enough history" is information.
 */

/** Is this a real, usable number? Rejects NaN, ±Infinity, null and strings. */
export function isFinite_(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Coerce anything unusable to a stated fallback. */
export function finiteOr(value, fallback = 0) {
  return isFinite_(value) ? value : fallback;
}

export function clamp(value, lo, hi) {
  if (!isFinite_(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Division that cannot explode. Returns null - not zero, and not Infinity -
 * when the denominator is too small to divide by, so the caller has to decide
 * what an unanswerable ratio means rather than being handed a fake answer.
 */
export function safeDiv(numerator, denominator, { minDenominator = 0 } = {}) {
  if (!isFinite_(numerator) || !isFinite_(denominator)) return null;
  if (Math.abs(denominator) <= minDenominator) return null;

  const result = numerator / denominator;
  return isFinite_(result) ? result : null;
}

export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const value of values) {
    if (!isFinite_(value)) continue;
    sum += value;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

/**
 * Sample standard deviation (n-1). The sample form is correct here because
 * these returns are a sample of the stock's behaviour, not its population, and
 * with n near the minimum the difference is not academic.
 *
 * Returns null rather than 0 for n < 2: one observation has no spread, and
 * saying "the spread is zero" would invite a divide-by-zero downstream.
 */
export function stdDev(values, precomputedMean = null) {
  const usable = (values ?? []).filter(isFinite_);
  if (usable.length < 2) return null;

  const mu = precomputedMean ?? mean(usable);
  if (!isFinite_(mu)) return null;

  let sumSquares = 0;
  for (const value of usable) sumSquares += (value - mu) ** 2;

  const variance = sumSquares / (usable.length - 1);
  return isFinite_(variance) && variance >= 0 ? Math.sqrt(variance) : null;
}

/**
 * Z-score with a standard-deviation floor and a hard clamp.
 *
 * THE ZERO-VOLATILITY CASE, which is the one that matters:
 * a stock that has not moved all session has a standard deviation at or near
 * zero. Dividing a one-paisa tick by it produces a z-score in the thousands -
 * technically finite, entirely meaningless, and enough to dominate the score.
 * So the divisor is floored, and the caller is told the floor was used
 * (`flooredStdDev`) so it can lower confidence rather than pretend.
 *
 * @returns {{ z: number, flooredStdDev: boolean, clamped: boolean }}
 */
export function zScore(value, { mean: mu, stdDev: sigma }, { minStdDev, clamp: limit }) {
  if (!isFinite_(value) || !isFinite_(mu)) {
    return { z: 0, flooredStdDev: false, clamped: false, usable: false };
  }

  const rawSigma = isFinite_(sigma) ? Math.abs(sigma) : 0;
  const flooredStdDev = rawSigma < minStdDev;
  const divisor = Math.max(rawSigma, minStdDev);

  const raw = safeDiv(value - mu, divisor);
  if (raw === null) {
    return { z: 0, flooredStdDev: true, clamped: false, usable: false };
  }

  const z = clamp(raw, -limit, limit);
  return { z, flooredStdDev, clamped: Math.abs(raw) > limit, usable: true };
}

/**
 * Map a magnitude onto [0, 1] against the point at which it counts as fully
 * remarkable. Linear and saturating: past the reference point everything is
 * simply "as unusual as this signal can say", which stops one wild value from
 * swamping the other signals.
 */
export function normalizeMagnitude(magnitude, fullContributionAt) {
  const ratio = safeDiv(Math.abs(finiteOr(magnitude, 0)), Math.abs(fullContributionAt));
  return ratio === null ? 0 : clamp(ratio, 0, 1);
}

/**
 * Map a magnitude onto [0, 1) without ever saturating.
 *
 * `normalizeMagnitude` clamps: everything at or beyond the reference point
 * scores exactly 1.0, so a 2% excess return and a 20% one contribute
 * identically - which is wrong, because one of those is a normal afternoon and
 * the other is an event. This curve is strictly increasing over the whole
 * domain and only approaches 1 asymptotically, so bigger is always bigger:
 *
 *     m / (m + halfAt)
 *
 * `halfAt` is the half-contribution point, which makes it a directly meaningful
 * thing to configure: at halfAt the signal contributes 0.5, at 3x halfAt it
 * contributes 0.75, and it never quite reaches 1.
 */
export function saturatingMagnitude(magnitude, halfAt) {
  const m = Math.abs(finiteOr(magnitude, 0));
  const k = Math.abs(finiteOr(halfAt, 0));
  if (k === 0) return m > 0 ? 1 : 0;

  const ratio = safeDiv(m, m + k);
  return ratio === null ? 0 : clamp(ratio, 0, 1);
}

/** Round for presentation without ever emitting a non-finite value. */
export function round(value, decimals = 2) {
  if (!isFinite_(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The last line of defence: walk a result object and assert every number in it
 * is finite. Used by the engine on its own output and asserted directly in the
 * tests, because "no NaN anywhere" is a promise worth enforcing mechanically
 * rather than reviewing by eye.
 */
export function assertAllFinite(value, path = '$') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite number at ${path}: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertAllFinite(item, `${path}[${i}]`));
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertAllFinite(item, `${path}.${key}`);
    }
  }
  return value;
}
