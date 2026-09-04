/**
 * Alerts: definitions, threshold-crossing state, and fired events.
 *
 * THE CROSSING STATE MACHINE IS THE WHOLE PROBLEM.
 *
 * A naive alert fires on every evaluation where the condition holds, so a
 * ₹1350 threshold with the price sitting at ₹1352 re-fires every fifteen
 * seconds forever. What a user means by "tell me when it crosses 1350" is an
 * edge, not a level. So each alert carries an `armed` flag:
 *
 *     1348  armed, condition false      -> nothing
 *     1350  armed, condition true       -> FIRES, disarms
 *     1351  disarmed                    -> nothing
 *     1352  disarmed                    -> nothing
 *     1348  disarmed, below reset band  -> re-arms, does not fire
 *     1352  armed, condition true       -> FIRES again
 *
 * WITH HYSTERESIS, because re-arming at exactly the threshold is not enough. A
 * price oscillating 1349.9 / 1350.1 around the line would satisfy "crossed"
 * repeatedly and fire on every wobble. Re-arming requires the price to fall a
 * configurable band clear of the threshold, so the alert answers a genuine
 * round trip and not measurement noise.
 *
 * The flag lives in the database, so a restart cannot turn a move the user has
 * already been told about back into news.
 *
 * DATA QUALITY GATES EVERYTHING. An alert is only ever evaluated against an
 * observation the freshness layer calls live or delayed. A stale price must not
 * fire anything, and a closed market is not movement - during it nothing is
 * happening, so nothing should fire. Skipped evaluations record why and leave
 * the crossing state untouched: changing state on data we do not trust would
 * let a stale reading silently arm or disarm a real alert.
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
const NEEDS_THRESHOLD = {
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
const EVALUABLE_STATES = new Set(['live', 'delayed']);

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
function conditionFor(type) {
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
function bandFor(type, threshold, params) {
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

const toAlert = (row) =>
  row && {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    type: row.type,
    threshold: row.threshold,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
    /** False once fired, until the value comes back clear of the threshold. */
    armed: row.armed === 1,
    lastFiredAt: row.last_fired_at,
    fireCount: row.fire_count,
    lastObserved: row.last_observed,
    lastEvaluatedAt: row.last_evaluated_at,
    lastSkippedReason: row.last_skipped_reason,
  };

const toEvent = (row) =>
  row && {
    id: row.id,
    alertId: row.alert_id,
    symbol: row.symbol,
    type: row.type,
    firedAt: row.fired_at,
    observed: row.observed,
    threshold: row.threshold,
    reason: row.reason,
    dataQuality: row.data_quality,
    acknowledged: row.acknowledged === 1,
  };

export function createAlertStore(db, params) {
  const statements = {
    insert: db.prepare(`
      INSERT INTO alerts (user_id, symbol, type, threshold, created_at, enabled, armed)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `),

    /** One alert per (user, symbol, type, threshold) - re-adding is a no-op. */
    existing: db.prepare(`
      SELECT * FROM alerts
      WHERE user_id = ? AND symbol = ? AND type = ? AND IFNULL(threshold, -1) = IFNULL(?, -1)
    `),

    forUser: db.prepare(
      'SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC, id DESC',
    ),

    enabledForUser: db.prepare(
      'SELECT * FROM alerts WHERE user_id = ? AND enabled = 1',
    ),

    byId: db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?'),

    remove: db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?'),

    markFired: db.prepare(`
      UPDATE alerts
      SET armed = 0, last_fired_at = ?, fire_count = fire_count + 1,
          last_observed = ?, last_evaluated_at = ?, last_skipped_reason = NULL
      WHERE id = ?
    `),

    markArmed: db.prepare(`
      UPDATE alerts
      SET armed = 1, last_observed = ?, last_evaluated_at = ?, last_skipped_reason = NULL
      WHERE id = ?
    `),

    markSeen: db.prepare(`
      UPDATE alerts
      SET last_observed = ?, last_evaluated_at = ?, last_skipped_reason = NULL
      WHERE id = ?
    `),

    markSkipped: db.prepare(`
      UPDATE alerts SET last_evaluated_at = ?, last_skipped_reason = ? WHERE id = ?
    `),

    insertEvent: db.prepare(`
      INSERT INTO alert_events
        (alert_id, user_id, symbol, type, fired_at, observed, threshold, reason, data_quality)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    events: db.prepare(`
      SELECT * FROM alert_events WHERE user_id = ?
      ORDER BY fired_at DESC, id DESC LIMIT ?
    `),

    unacknowledged: db.prepare(
      'SELECT COUNT(*) AS n FROM alert_events WHERE user_id = ? AND acknowledged = 0',
    ),

    acknowledgeAll: db.prepare(
      'UPDATE alert_events SET acknowledged = 1 WHERE user_id = ? AND acknowledged = 0',
    ),

    count: db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE user_id = ?'),
  };

  return {
    create(userId, definition, now = Date.now()) {
      const clean = validateDefinition(definition);

      const already = statements.existing.get(
        userId,
        clean.symbol,
        clean.type,
        clean.threshold,
      );
      if (already) return { alert: toAlert(already), created: false };

      const result = statements.insert.run(
        userId,
        clean.symbol,
        clean.type,
        clean.threshold,
        now,
      );
      return { alert: toAlert(statements.byId.get(result.lastInsertRowid, userId)), created: true };
    },

    list(userId) {
      return statements.forUser.all(userId).map(toAlert);
    },

    get(userId, id) {
      return toAlert(statements.byId.get(id, userId));
    },

    remove(userId, id) {
      return statements.remove.run(id, userId).changes > 0;
    },

    events(userId, limit = 20) {
      return statements.events.all(userId, limit).map(toEvent);
    },

    unacknowledgedCount(userId) {
      return statements.unacknowledged.get(userId).n;
    },

    acknowledgeAll(userId) {
      return statements.acknowledgeAll.run(userId).changes;
    },

    count(userId) {
      return statements.count.get(userId).n;
    },

    /**
     * Evaluate every enabled alert against an engine evaluation.
     *
     * Reads the engine's output rather than the log directly, so an alert can
     * never disagree with the row the user is looking at - the price, the
     * freshness state, the change since they looked and the attention level all
     * come from the same computation.
     */
    evaluate({ userId, evaluation, now = Date.now() }) {
      const bySymbol = new Map(evaluation.items.map((item) => [item.symbol, item]));
      const alerts = statements.enabledForUser.all(userId).map(toAlert);

      const fired = [];
      const skipped = [];

      const run = db.transaction(() => {
        for (const alert of alerts) {
          const item = bySymbol.get(alert.symbol);

          if (!item) {
            statements.markSkipped.run(now, 'symbol_not_watched', alert.id);
            skipped.push({ alert, reason: 'symbol_not_watched' });
            continue;
          }

          const state = item.freshness?.state ?? 'no_data';
          if (!EVALUABLE_STATES.has(state)) {
            /**
             * Deliberately does NOT touch `armed`. Arming or disarming from an
             * observation we have just declared untrustworthy would let a stale
             * reading suppress a real crossing later, or manufacture one.
             */
            statements.markSkipped.run(now, `data_quality:${state}`, alert.id);
            skipped.push({ alert, reason: `data_quality:${state}`, state });
            continue;
          }

          const context = {
            price: item.latest?.price ?? null,
            changePct: item.changeSinceViewed?.available
              ? item.changeSinceViewed.percent
              : null,
            level: item.level,
            score: item.meaningfulScore,
            confidence: item.confidence,
            volumeRatio: item.features?.volumeAnomaly?.available
              ? item.features.volumeAnomaly.ratio
              : null,
          };

          const condition = conditionFor(alert.type);
          const value = condition.valueOf(context);

          if (!isFinite_(value)) {
            statements.markSkipped.run(now, 'value_unavailable', alert.id);
            skipped.push({ alert, reason: 'value_unavailable' });
            continue;
          }

          const band = bandFor(alert.type, alert.threshold ?? 0, params);

          // Re-arm first: a value that has come back clear of the threshold is
          // eligible to fire again on the very next evaluation.
          if (!alert.armed) {
            if (condition.reset(value, alert.threshold, band)) {
              statements.markArmed.run(value, now, alert.id);
            } else {
              statements.markSeen.run(value, now, alert.id);
            }
            continue;
          }

          if (!condition.triggered(value, alert.threshold)) {
            statements.markSeen.run(value, now, alert.id);
            continue;
          }

          const reason = `${alert.symbol} ${condition.describe(value, alert.threshold, context)}`;

          statements.insertEvent.run(
            alert.id,
            userId,
            alert.symbol,
            alert.type,
            now,
            value,
            alert.threshold,
            reason,
            item.dataQuality,
          );
          statements.markFired.run(now, value, now, alert.id);

          fired.push({
            alertId: alert.id,
            symbol: alert.symbol,
            type: alert.type,
            observed: value,
            threshold: alert.threshold,
            reason,
            dataQuality: item.dataQuality,
            firedAt: now,
          });
        }
      });

      run();

      return { evaluated: alerts.length, fired, skipped };
    },
  };
}
