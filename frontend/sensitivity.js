/**
 * ATTENTION SENSITIVITY — a display threshold, and nothing more.
 *
 * How aggressively already-computed results are surfaced. Every predicate here
 * reads a verdict the engine published (`level`, `needsAttention`,
 * `attentionGroup`) and selects on it. Nothing is recomputed: no score, no
 * weight, no confidence, no threshold of its own, and no percentage anywhere.
 * The scale is the engine's own published levels.
 *
 *   low    - only HIGH, the engine's top level
 *   medium - the engine's own attention bar, exactly as it computes it
 *   high   - the bar, plus the meaningful-but-below-bar group
 *
 * WHY THIS IS ITS OWN FILE
 * It has no DOM in it, which means the test suite can import it and assert the
 * property that matters: that changing sensitivity changes which rows are
 * surfaced and changes no number attached to any of them. A rule of this kind
 * buried in a file that touches `document` at load time would be untestable,
 * and an untested claim that "this cannot affect scores" is worth very little.
 *
 * In-session only, by decision: a single display preference does not warrant a
 * settings table, and persisting it would mean a returning user could be shown
 * less than the engine found without remembering they had asked for that.
 */

export const SENSITIVITY_LEVELS = ['low', 'medium', 'high'];

export const DEFAULT_SENSITIVITY = 'medium';

export const SENSITIVITY = {
  low: {
    prominent: (item) => item.level === 'HIGH',
    note: 'At low sensitivity: HIGH only.',
  },
  medium: {
    /** The engine's own bar, read from the field it publishes. */
    prominent: (item) => item.needsAttention === true,
    note: null, // nothing to explain: this IS the engine's answer
  },
  high: {
    prominent: (item) => item.needsAttention === true || item.attentionGroup === 'meaningful',
    note: 'At high sensitivity: also includes results below the bar.',
  },
};

/**
 * Which band a row is DISPLAYED in, once sensitivity is taken into account.
 *
 * The engine's `attentionGroup` is the input and is never overwritten. At
 * medium this returns the engine's own answer unchanged; the other two settings
 * move rows between the attention band and the meaningful band, and nothing
 * else. A row's badge still shows its real level either way, so a promoted row
 * is never dressed up as something it is not.
 */
export function displayGroupFor(item, sensitivity = DEFAULT_SENSITIVITY) {
  const setting = SENSITIVITY[sensitivity] ?? SENSITIVITY[DEFAULT_SENSITIVITY];

  /**
   * No baseline stays no baseline at every setting. Sensitivity decides how
   * much of what was MEASURED to surface; this row was not measured, and no
   * setting can turn an absent comparison into a quiet one.
   */
  if (item.attentionGroup === 'unseen') return 'unseen';

  if (setting.prominent(item)) return 'needs_attention';

  // Demoted by a low setting, or genuinely below the bar: both are "something
  // happened here, but you asked not to be shown it prominently".
  if (item.needsAttention || item.attentionGroup === 'meaningful') return 'meaningful';

  return 'stable';
}
