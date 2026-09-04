/**
 * "Why wasn't I alerted?" — and its mirror, "why was I?"
 *
 * An alert system that only ever says nothing is unauditable. The user set a
 * rule, the rule did not fire, and the honest answer is a specific one: the
 * price is ₹37 below your threshold; the score reached 0.43 and HIGH needs
 * 0.70; the feed went stale so nothing was evaluated at all; it already fired
 * and is waiting for the price to come back. A generic "conditions not met"
 * teaches the user nothing and hides genuine faults - a permanently stale feed
 * looks exactly like a quiet market.
 *
 * TWO RULES THIS MODULE OBEYS.
 *
 * First, it reads the SAME condition functions, hysteresis bands and evaluation
 * context that the evaluator fires from - both import them from
 * ./alert-rules.js, which exists precisely so neither has to keep a private
 * copy. A parallel re-implementation would eventually disagree with the thing
 * it audits, which is worse than no audit at all.
 *
 * Second, every statement is a real feature value. "Price movement is not
 * unusual for this stock" is only ever emitted with the z-score that says so
 * beside it. Nothing is inferred, nothing is generated, and there is no LLM
 * anywhere in this path - the deterministic engine is the only source of truth.
 */
import {
  AlertType,
  EVALUABLE_STATES,
  bandFor,
  conditionFor,
  contextFor,
} from './alert-rules.js';
import { isFinite_, round } from './engine/numeric.js';

/** Why an alert did not fire. Ordered from most to least fundamental. */
export const BlockerCode = {
  /** The observation itself was not trustworthy enough to evaluate. */
  DATA_QUALITY: 'data_quality',
  /** The engine could not produce the value the rule compares. */
  VALUE_UNAVAILABLE: 'value_unavailable',
  /** Already fired; waiting for the value to come back clear of the line. */
  AWAITING_RESET: 'awaiting_reset',
  /** Evaluated, trusted, and simply not there yet. */
  CONDITION_NOT_MET: 'condition_not_met',
  /** No engine item at all - the symbol is not on the watchlist. */
  SYMBOL_NOT_WATCHED: 'symbol_not_watched',
};

export const DiagnosisStatus = {
  WOULD_FIRE: 'would_fire',
  NOT_MET: 'not_met',
  AWAITING_RESET: 'awaiting_reset',
  BLOCKED: 'blocked',
};

const UNIT = {
  [AlertType.PRICE_CROSSES_ABOVE]: '₹',
  [AlertType.PRICE_FALLS_BELOW]: '₹',
  [AlertType.CHANGE_SINCE_VIEWED_EXCEEDS]: '%',
  [AlertType.UNUSUAL_VOLUME]: '×',
  [AlertType.ATTENTION_HIGH]: '',
};

/** The rule, in the user's own terms. */
export function describeRule(alert) {
  switch (alert.type) {
    case AlertType.PRICE_CROSSES_ABOVE:
      return `Price crosses above ₹${alert.threshold}`;
    case AlertType.PRICE_FALLS_BELOW:
      return `Price falls below ₹${alert.threshold}`;
    case AlertType.CHANGE_SINCE_VIEWED_EXCEEDS:
      return `Change since you last looked exceeds ${alert.threshold}%`;
    case AlertType.ATTENTION_HIGH:
      return 'Attention level becomes HIGH';
    case AlertType.UNUSUAL_VOLUME:
      return `Volume exceeds ${alert.threshold}× normal`;
    default:
      return alert.type;
  }
}

/** The current value, formatted in the rule's own units. */
function describeValue(type, value) {
  if (!isFinite_(value)) return 'unavailable';
  switch (type) {
    case AlertType.PRICE_CROSSES_ABOVE:
    case AlertType.PRICE_FALLS_BELOW:
      return `₹${round(value, 2)}`;
    case AlertType.CHANGE_SINCE_VIEWED_EXCEEDS:
      return `${value > 0 ? '+' : ''}${round(value, 2)}%`;
    case AlertType.UNUSUAL_VOLUME:
      return `${round(value, 2)}×`;
    case AlertType.ATTENTION_HIGH:
      return value === 1 ? 'HIGH' : 'not HIGH';
    default:
      return String(round(value, 2));
  }
}

/**
 * How far the value is from the line, stated as a distance rather than a
 * verdict. "₹37.70 below your threshold" is checkable; "not met" is not.
 */
function describeGap(alert, value) {
  if (!isFinite_(value) || alert.threshold == null) return null;

  const distance = Math.abs(alert.threshold - value);

  switch (alert.type) {
    case AlertType.PRICE_CROSSES_ABOVE:
      return {
        distance: round(distance, 2),
        text: `₹${round(distance, 2)} below your ₹${alert.threshold} threshold`,
      };
    case AlertType.PRICE_FALLS_BELOW:
      return {
        distance: round(distance, 2),
        text: `₹${round(distance, 2)} above your ₹${alert.threshold} threshold`,
      };
    case AlertType.CHANGE_SINCE_VIEWED_EXCEEDS:
      return {
        distance: round(alert.threshold - Math.abs(value), 2),
        text: `${round(alert.threshold - Math.abs(value), 2)} percentage points short of the ${
          alert.threshold
        }% you set`,
      };
    case AlertType.UNUSUAL_VOLUME:
      return {
        distance: round(alert.threshold - value, 2),
        text: `${round(alert.threshold - value, 2)}× short of the ${alert.threshold}× you set`,
      };
    default:
      return null;
  }
}

/**
 * The engine facts behind an attention level.
 *
 * This is the heart of the feature. When the rule is "attention becomes HIGH"
 * and it did not, the useful answer is not the score - it is WHY the score is
 * what it is, one signal at a time, each with the number that produced it. A
 * signal that was measured and found ordinary reads differently from one that
 * could not be measured at all, and both read differently from one that did
 * contribute.
 */
export function explainSignals({ item, engineParams }) {
  const facts = [];
  if (!item) return facts;

  const f = item.features ?? {};
  const b = item.scoreBreakdown ?? {};
  const push = (code, text, value) => facts.push({ code, text, ...value });

  // --- price movement ---
  const price = f.priceAnomaly;
  if (!price?.available) {
    push('price_anomaly_unavailable', `Price movement could not be measured (${price?.reason})`, {
      available: false,
      reason: price?.reason,
    });
  } else {
    const magnitude = Math.abs(price.z);
    const notable = magnitude >= (engineParams?.reasonMinZ ?? 1);
    push(
      notable ? 'price_movement_unusual' : 'price_movement_not_unusual',
      notable
        ? `Price movement is unusual for this stock (${magnitude.toFixed(1)}σ)`
        : `Price movement is not unusual for this stock (${magnitude.toFixed(1)}σ)`,
      { available: true, z: price.z, contribution: b.priceAnomaly?.weighted ?? 0 },
    );
  }

  // --- volume ---
  const volume = f.volumeAnomaly;
  if (!volume?.available) {
    push('volume_unavailable', `Volume could not be measured (${volume?.reason})`, {
      available: false,
      reason: volume?.reason,
    });
  } else {
    const heavy = volume.ratio >= (engineParams?.reasonMinVolumeRatio ?? 1.5);
    push(
      heavy ? 'volume_elevated' : 'volume_normal',
      heavy
        ? `Volume is ${volume.ratio.toFixed(1)}× its normal level`
        : `Volume is normal (${volume.ratio.toFixed(1)}×)`,
      { available: true, ratio: volume.ratio, contribution: b.volumeAnomaly?.weighted ?? 0 },
    );
  }

  // --- market ---
  const market = f.marketRelative;
  if (!market?.available) {
    push('market_unavailable', `Market comparison unavailable (${market?.reason})`, {
      available: false,
      reason: market?.reason,
    });
  } else {
    const material = Math.abs(market.excessPct) >= (engineParams?.reasonMinRelativePct ?? 0.4);
    push(
      material ? 'diverged_from_market' : 'moved_with_market',
      material
        ? `Moved ${market.excessPct > 0 ? 'ahead of' : 'behind'} the market by ${Math.abs(
            market.excessPct,
          ).toFixed(2)}%`
        : `The market moved similarly (${market.symbolReturnPct > 0 ? '+' : ''}${
            market.symbolReturnPct
          }% vs ${market.benchmarkReturnPct > 0 ? '+' : ''}${market.benchmarkReturnPct}%)`,
      {
        available: true,
        excessPct: market.excessPct,
        contribution: b.marketRelative?.weighted ?? 0,
      },
    );
  }

  // --- sector ---
  const sector = f.sectorRelative;
  if (!sector?.available) {
    push('sector_unavailable', `Sector comparison unavailable (${sector?.reason})`, {
      available: false,
      reason: sector?.reason,
    });
  } else {
    const material = Math.abs(sector.excessPct) >= (engineParams?.reasonMinRelativePct ?? 0.4);
    push(
      material ? 'diverged_from_sector' : 'moved_with_sector',
      material
        ? `Moved ${sector.excessPct > 0 ? 'ahead of' : 'behind'} ${
            sector.sector
          } peers by ${Math.abs(sector.excessPct).toFixed(2)}%`
        : `${sector.sector} peers moved similarly (${sector.excessPct > 0 ? '+' : ''}${
            sector.excessPct
          }% apart)`,
      {
        available: true,
        excessPct: sector.excessPct,
        contribution: b.sectorRelative?.weighted ?? 0,
      },
    );
  }

  /**
   * The level floor, when it applied. Without this line a user whose score
   * reads 0.44 while the level reads LOW has been told two contradictory
   * things - and the floor is a deliberate product rule, not a rounding.
   */
  if (item.levelFloor) {
    push(
      'level_capped_by_floor',
      `Level capped at LOW: the stock's own move (${item.levelFloor.zMagnitude}σ), your change since looking (${item.levelFloor.changeMagnitude}%) and its turnover (${item.levelFloor.volumeRatio}×) were all negligible, so the relative signals alone do not earn attention`,
      { available: true, cappedFrom: item.levelFloor.cappedFrom },
    );
  }

  return facts;
}

/**
 * Diagnose one alert against one engine item.
 *
 * Deterministic: the same alert, the same item and the same params produce the
 * same diagnosis, which is what makes it testable.
 */
export function diagnoseAlert({ alert, item, alertParams, engineParams }) {
  const rule = {
    text: describeRule(alert),
    type: alert.type,
    threshold: alert.threshold,
    unit: UNIT[alert.type] ?? '',
  };

  if (!item) {
    return {
      alertId: alert.id,
      symbol: alert.symbol,
      rule,
      status: DiagnosisStatus.BLOCKED,
      current: { available: false, reason: 'symbol_not_watched' },
      blockers: [
        {
          code: BlockerCode.SYMBOL_NOT_WATCHED,
          text: `${alert.symbol} is not on your watchlist, so nothing is being evaluated`,
        },
      ],
      signals: [],
    };
  }

  const context = contextFor(item);
  const condition = conditionFor(alert.type);
  const value = condition.valueOf(context);
  const band = bandFor(alert.type, alert.threshold ?? 0, alertParams);

  const state = item.freshness?.state ?? 'no_data';
  const evaluable = EVALUABLE_STATES.has(state);
  const valueUsable = isFinite_(value);
  const met = valueUsable && condition.triggered(value, alert.threshold);

  const current = {
    available: valueUsable,
    value: valueUsable ? round(value, 4) : null,
    text: describeValue(alert.type, value),
    dataQuality: item.dataQuality,
    freshness: item.freshness?.label ?? null,
  };

  const signals = explainSignals({ item, engineParams });
  const blockers = [];

  /**
   * Ordered deliberately. A stale feed is reported FIRST and on its own,
   * because when nothing was evaluated the state of the condition is not the
   * explanation - and listing "condition not met" beside it would imply the
   * rule had been checked and found wanting when it was never checked at all.
   */
  if (!evaluable) {
    blockers.push({
      code: BlockerCode.DATA_QUALITY,
      text: `Not evaluated: the newest observation is ${state.replace('_', ' ')}${
        item.freshness?.ageMs != null
          ? ` (${Math.round(item.freshness.ageMs / 1000)}s old)`
          : ''
      }. Alerts only run against live or delayed data.`,
      state,
    });

    return {
      alertId: alert.id,
      symbol: alert.symbol,
      rule,
      status: DiagnosisStatus.BLOCKED,
      current,
      met: null,
      armed: alert.armed,
      blockers,
      signals,
    };
  }

  if (!valueUsable) {
    blockers.push({
      code: BlockerCode.VALUE_UNAVAILABLE,
      text: unavailableValueText(alert, item),
    });
  } else if (!alert.armed && met) {
    /**
     * The non-obvious case, and the one users most often mistake for a bug:
     * the condition IS true, but the alert already fired on this crossing and
     * is waiting for the value to come back clear of the line.
     */
    blockers.push({
      code: BlockerCode.AWAITING_RESET,
      text: `Already fired at ${describeValue(alert.type, alert.lastObserved)}. It will not fire again until the value comes back past ${resetText(
        alert,
        band,
      )}, so one crossing is reported once.`,
      resetsAt: resetBoundary(alert, band),
    });
  } else if (!met) {
    const gap = describeGap(alert, value);
    blockers.push({
      code: BlockerCode.CONDITION_NOT_MET,
      text:
        alert.type === AlertType.ATTENTION_HIGH
          ? `Attention is ${item.level}, not HIGH: the score is ${item.meaningfulScore} and HIGH needs ${engineParams?.levels?.high ?? 0.7}`
          : `Currently ${current.text} — ${gap?.text ?? 'short of your threshold'}`,
      gap,
    });
  }

  const status = blockers.length === 0
    ? DiagnosisStatus.WOULD_FIRE
    : blockers[0].code === BlockerCode.AWAITING_RESET
      ? DiagnosisStatus.AWAITING_RESET
      : blockers[0].code === BlockerCode.CONDITION_NOT_MET
        ? DiagnosisStatus.NOT_MET
        : DiagnosisStatus.BLOCKED;

  return {
    alertId: alert.id,
    symbol: alert.symbol,
    rule,
    status,
    current,
    met,
    armed: alert.armed,
    blockers,
    /**
     * The signal facts are attached to every diagnosis, not just the
     * level-based ones. A price alert that has not fired is often best
     * explained by what the stock is actually doing, and the user should not
     * have to open a second panel to find out.
     */
    signals,
    /** Which signals actually carried the score, largest first. */
    contributing: contributingSignals(item),
  };
}

function unavailableValueText(alert, item) {
  if (alert.type === AlertType.CHANGE_SINCE_VIEWED_EXCEEDS) {
    const reason = item.changeSinceViewed?.reason ?? 'unknown';
    return reason === 'never_viewed'
      ? 'There is no change to measure yet: you have not opened this symbol, so there is no baseline to compare against.'
      : `There is no change to measure (${reason.replace(/_/g, ' ')}).`;
  }
  if (alert.type === AlertType.UNUSUAL_VOLUME) {
    return `Volume could not be measured (${
      item.features?.volumeAnomaly?.reason ?? 'unknown'
    }), so a multiple of normal cannot be formed.`;
  }
  return 'The value this rule compares is not currently available.';
}

function resetBoundary(alert, band) {
  if (alert.threshold == null) return null;
  return alert.type === AlertType.PRICE_FALLS_BELOW
    ? round(alert.threshold + band, 2)
    : round(alert.threshold - band, 2);
}

function resetText(alert, band) {
  if (alert.type === AlertType.ATTENTION_HIGH) return 'a level below HIGH';
  const boundary = resetBoundary(alert, band);
  const unit = UNIT[alert.type] ?? '';
  return alert.type === AlertType.PRICE_FALLS_BELOW
    ? `${unit}${boundary}`
    : `${unit}${boundary}`;
}

/** The signals that carried the score, largest contribution first. */
export function contributingSignals(item) {
  const breakdown = item?.scoreBreakdown ?? {};
  return Object.entries(breakdown)
    .filter(([, entry]) => entry.available && entry.weighted > 0)
    .map(([name, entry]) => ({
      signal: name,
      contribution: entry.weighted,
      weight: entry.weight,
      share: entry.contribution,
    }))
    .sort((a, b) => b.contribution - a.contribution || a.signal.localeCompare(b.signal));
}

/**
 * The mirror: why an alert DID fire.
 *
 * Captured at fire time rather than recomputed later, because by the time
 * anyone reads it the market has moved and a recomputed explanation would
 * describe a different moment than the one that triggered.
 */
export function explainFiring({ alert, item, value, engineParams }) {
  return {
    rule: describeRule(alert),
    type: alert.type,
    threshold: alert.threshold,
    crossedWith: {
      value: round(value, 4),
      text: describeValue(alert.type, value),
      dataQuality: item?.dataQuality ?? null,
      freshness: item?.freshness?.label ?? null,
      observedAt: item?.latest?.timestamp ?? null,
    },
    level: item?.level ?? null,
    score: item?.meaningfulScore ?? null,
    confidence: item?.confidence ?? null,
    contributing: contributingSignals(item),
    signals: explainSignals({ item, engineParams }),
  };
}
