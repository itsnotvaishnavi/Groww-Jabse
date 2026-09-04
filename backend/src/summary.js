/**
 * "Since you were away".
 *
 * The thing a user actually wants on returning: how long they were gone, how
 * much changed, how much of it deserves attention, and then the few things
 * that do - ranked by the engine, never by raw percentage change.
 *
 * Ranking by raw change is the trap this whole product exists to avoid. The
 * biggest mover is frequently the most volatile stock having an ordinary day,
 * while the genuinely interesting event is a normally-placid one moving 1% on
 * four times its usual volume.
 *
 * TIME AWAY is derived from the user's own last_viewed_at timestamps, and
 * last_viewed_at is still only written by an explicit "Mark seen". Loading this
 * summary does not consume it - if it did, the summary would be empty the
 * moment after you read it and there would be no way back to it.
 */
import { config } from './config.js';
import { Level } from './engine/score.js';

/** Human phrasing for a duration. Deterministic, no locale surprises. */
export function describeDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'an unknown time';

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * How long the user has been away.
 *
 * The oldest last_viewed_at across the watchlist, because that is the earliest
 * point any of the current state could have been seen from. Symbols never
 * viewed are excluded rather than treated as "away forever" - they have no
 * "last time" at all, which is a different situation and is reported as such.
 */
export function timeAway({ entries, now, overrideMs = null }) {
  if (overrideMs != null && Number.isFinite(overrideMs) && overrideMs >= 0) {
    return { awayMs: overrideMs, since: now - overrideMs, simulated: true };
  }

  const viewed = entries.map((e) => e.lastViewedAt).filter((t) => t != null);
  if (viewed.length === 0) {
    return { awayMs: null, since: null, simulated: false, firstVisit: true };
  }

  const since = Math.min(...viewed);
  return { awayMs: Math.max(0, now - since), since, simulated: false };
}

export function createSummaryService({ engine, watchlist, surfacedStore, clock = () => Date.now() }) {
  const params = engine.params();

  /**
   * @param awayOverrideMs dev/demo affordance. A long-absence experience
   *        cannot otherwise be shown in a five-minute demo without waiting two
   *        days, and a reviewer should not have to take it on trust.
   * @param record whether to mark the presented signals as surfaced. The
   *        endpoint does; a dry run for tests or a preview does not.
   */
  function build({
    userId = config.devUserId,
    now = clock(),
    awayOverrideMs = null,
    record = false,
  } = {}) {
    const evaluation = engine.evaluate({ userId, now });
    const entries = watchlist.list(userId);
    const away = timeAway({ entries, now, overrideMs: awayOverrideMs });

    /**
     * "Changed" means the user has a baseline and the price is not identical to
     * it. Symbols they have never opened are counted separately: nothing has
     * changed for them *since last time* because there was no last time.
     */
    const changed = evaluation.items.filter(
      (item) => item.changeSinceViewed.available && item.changeSinceViewed.percent !== 0,
    );

    const needsAttention = evaluation.items.filter(
      (item) => item.level === Level.HIGH || item.level === Level.MODERATE,
    );

    const unseen = evaluation.items.filter((item) => item.lastViewedAt == null);

    const isLongAbsence = away.awayMs != null && away.awayMs >= params.longAbsenceMs;

    // Already ranked by the engine; the summary only truncates.
    const top = needsAttention.slice(0, params.summaryTopN);

    if (record && surfacedStore) {
      surfacedStore.markSurfaced(
        userId,
        top.map((item) => ({
          symbol: item.symbol,
          fingerprint: item.signal.fingerprint,
          level: item.level,
          epoch: item.lastViewedAt ?? 0,
        })),
        now,
      );
    }

    return {
      userId,
      generatedAt: now,

      away: {
        ms: away.awayMs,
        label: away.awayMs == null ? null : describeDuration(away.awayMs),
        since: away.since,
        simulated: away.simulated === true,
        firstVisit: away.firstVisit === true,
        /**
         * Past the threshold the summary aggregates instead of enumerating.
         * After two days away nobody wants a tick-by-tick account; they want to
         * know which handful of things mattered.
         */
        long: isLongAbsence,
      },

      counts: {
        watched: evaluation.items.length,
        changed: changed.length,
        needsAttention: needsAttention.length,
        neverViewed: unseen.length,
        high: evaluation.items.filter((i) => i.level === Level.HIGH).length,
        moderate: evaluation.items.filter((i) => i.level === Level.MODERATE).length,
        low: evaluation.items.filter((i) => i.level === Level.LOW).length,
        alreadySurfaced: needsAttention.filter((i) => i.alreadySurfaced).length,
      },

      /**
       * One line, assembled server-side so the phrasing is deterministic and
       * testable rather than reassembled differently by every client.
       */
      headline: headlineFor({ away, changed, needsAttention, unseen, isLongAbsence }),

      /** The signals themselves, engine-ranked and truncated. */
      top: top.map((item) => ({
        symbol: item.symbol,
        level: item.level,
        meaningfulScore: item.meaningfulScore,
        confidence: item.confidence,
        changeSinceViewed: item.changeSinceViewed,
        reasons: item.reasons,
        reasonText: item.reasonText,
        dataQuality: item.dataQuality,
        alreadySurfaced: item.alreadySurfaced,
        latest: item.latest,
      })),

      /**
       * On a long absence, a per-level roll-up replaces the enumeration. This
       * is the aggregate view: what mattered, not every tick that happened.
       */
      aggregate: isLongAbsence
        ? {
            byLevel: {
              HIGH: summariseLevel(evaluation.items, Level.HIGH),
              MODERATE: summariseLevel(evaluation.items, Level.MODERATE),
              LOW: summariseLevel(evaluation.items, Level.LOW),
            },
            biggestMove: biggestMove(changed),
          }
        : null,
    };
  }

  return { build };
}

function summariseLevel(items, level) {
  const matching = items.filter((item) => item.level === level);
  return {
    count: matching.length,
    symbols: matching.map((item) => item.symbol),
  };
}

function biggestMove(changed) {
  if (changed.length === 0) return null;
  const winner = [...changed].sort(
    (a, b) =>
      Math.abs(b.changeSinceViewed.percent) - Math.abs(a.changeSinceViewed.percent) ||
      a.symbol.localeCompare(b.symbol),
  )[0];
  return {
    symbol: winner.symbol,
    percent: winner.changeSinceViewed.percent,
    level: winner.level,
  };
}

/**
 * The headline sentence.
 *
 * Descriptive only: it reports counts and says what "deserves attention". It
 * never advises, predicts, or names an action - the product has no view on what
 * anyone should do with their money, and its language must not imply one.
 */
export function headlineFor({ away, changed, needsAttention, unseen, isLongAbsence }) {
  if (away.firstVisit) {
    return unseen.length === 1
      ? 'First look at this symbol — mark it seen to start tracking what changes.'
      : `First look at these ${unseen.length} symbols — mark them seen to start tracking what changes.`;
  }

  const duration = describeDuration(away.awayMs);
  const lead = isLongAbsence
    ? `You were away for ${duration}. Here is what mattered.`
    : `You were away for ${duration}.`;

  if (changed.length === 0) {
    return `${lead} Nothing on your watchlist changed.`;
  }

  const thing = changed.length === 1 ? 'thing' : 'things';
  const attention =
    needsAttention.length === 0
      ? 'None of it needs your attention.'
      : `${needsAttention.length} ${needsAttention.length === 1 ? 'deserves' : 'deserve'} your attention.`;

  return `${lead} ${changed.length} ${thing} changed. ${attention}`;
}
