/**
 * Staleness and source conflict.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO MAKE
 * An old price is not automatically a stale price. If it is Sunday afternoon,
 * the newest real quote for RELIANCE is from Friday 15:30 IST and that is
 * *correct* - it is the last traded price, not a bug, and flagging it as stale
 * would be crying wolf for 62 hours straight. Whereas a price from four
 * minutes ago during a live session, when we poll every fifteen seconds, is
 * genuinely wrong and the user deserves to know.
 *
 * So "how old is too old" is a function of the source's own delay and the
 * exchange calendar, not a single global threshold.
 */
import { config } from './config.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** NSE/BSE continuous session: 09:15-15:30 IST, Monday to Friday. */
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const DAY_MS = 86_400_000;

/**
 * IST is a fixed UTC+5:30 with no daylight saving, so the offset arithmetic is
 * exact and needs no timezone database. Reading the shifted instant with
 * getUTC* keeps the host machine's own timezone out of the answer entirely.
 */
function istParts(timestamp) {
  const shifted = new Date(timestamp + IST_OFFSET_MS);
  return {
    weekday: shifted.getUTCDay(), // 0 = Sunday
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    midnightUtc: Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - IST_OFFSET_MS,
  };
}

const isWeekday = (weekday) => weekday >= 1 && weekday <= 5;

/**
 * KNOWN LIMITATION, stated rather than papered over: trading holidays are not
 * modelled. A hardcoded 2026 NSE holiday list would be invented data, and
 * getting it wrong would be worse than admitting the gap - on a holiday this
 * reports "open" and the freshness layer will call the (correctly unchanging)
 * price stale. Wiring in a real exchange calendar is the fix.
 */
export function isMarketOpen(at = Date.now()) {
  const { weekday, minuteOfDay } = istParts(at);
  return (
    isWeekday(weekday) && minuteOfDay >= SESSION_OPEN_MIN && minuteOfDay <= SESSION_CLOSE_MIN
  );
}

/** The most recent session close at or before `at`. */
export function lastMarketClose(at = Date.now()) {
  let cursor = at;
  for (let i = 0; i < 10; i += 1) {
    const { weekday, minuteOfDay, midnightUtc } = istParts(cursor);
    const closeAt = midnightUtc + SESSION_CLOSE_MIN * 60_000;
    if (isWeekday(weekday) && closeAt <= at) return closeAt;
    // Step back to the previous IST day and retry.
    cursor = midnightUtc - 1;
  }
  return at - 3 * DAY_MS; // Unreachable in practice; a sane floor regardless.
}

/** The next session open after `at`, for telling the user when to come back. */
export function nextMarketOpen(at = Date.now()) {
  for (let i = 0; i < 10; i += 1) {
    const { weekday, midnightUtc } = istParts(at + i * DAY_MS);
    const openAt = midnightUtc + SESSION_OPEN_MIN * 60_000;
    if (isWeekday(weekday) && openAt > at) return openAt;
  }
  return null;
}

/** The NSE continuous session is 6h 15m long. */
export const SESSION_LENGTH_MS = (SESSION_CLOSE_MIN - SESSION_OPEN_MIN) * 60_000;

/**
 * The trading session that `at` falls in, or the last completed one.
 *
 * Lives here because this module already owns the market calendar - a second
 * copy of the session hours would be a second thing to get wrong. Used by the
 * intraday analysis to bound its window, which is why it reports the session's
 * own open and close alongside the queryable window: mid-session the window
 * ends at `now`, not at the close, and conflating the two would silently
 * measure a partial session as though it were a whole one.
 */
export function sessionWindow(at = Date.now()) {
  const { weekday, minuteOfDay, midnightUtc } = istParts(at);

  if (isWeekday(weekday) && minuteOfDay >= SESSION_OPEN_MIN && minuteOfDay <= SESSION_CLOSE_MIN) {
    const open = midnightUtc + SESSION_OPEN_MIN * 60_000;
    return {
      from: open,
      to: at,
      sessionOpen: open,
      sessionClose: midnightUtc + SESSION_CLOSE_MIN * 60_000,
      isOpen: true,
      complete: false,
    };
  }

  // Outside a session: the last one that finished.
  const close = lastMarketClose(at);
  const closeDay = istParts(close);

  return {
    from: closeDay.midnightUtc + SESSION_OPEN_MIN * 60_000,
    to: close,
    sessionOpen: closeDay.midnightUtc + SESSION_OPEN_MIN * 60_000,
    sessionClose: close,
    isOpen: false,
    complete: true,
  };
}

/**
 * Freshness states, in the order of "the user should worry":
 *   no_data       - we have never observed this symbol
 *   live          - as current as the source is capable of being
 *   delayed       - within the source's own stated delay window (Yahoo)
 *   market_closed - exchange shut; the last traded price is the right answer
 *   stale         - the source should have given us something newer and did not
 */
export const FreshnessState = {
  NO_DATA: 'no_data',
  LIVE: 'live',
  DELAYED: 'delayed',
  MARKET_CLOSED: 'market_closed',
  STALE: 'stale',
};

/**
 * Assess the newest observation for a symbol.
 *
 * @param snapshot  newest row from the log, or null
 * @param sourceInfo the active source's describe() output
 */
export function assessFreshness(snapshot, sourceInfo, now = Date.now()) {
  const tolerance = config.ingestIntervalMs * config.stalenessIntervals;

  if (!snapshot) {
    return {
      state: FreshnessState.NO_DATA,
      label: 'No data yet',
      ageMs: null,
      expectedMaxAgeMs: tolerance,
      isStale: true,
      marketOpen: isMarketOpen(now),
    };
  }

  const ageMs = now - snapshot.timestamp;
  const sourceDelayMs = sourceInfo.delayMs ?? 0;

  // A source that never closes (the simulator) is judged purely on our own
  // polling cadence: there is always a newer tick to be had.
  if (sourceInfo.alwaysOpen) {
    const expectedMaxAgeMs = sourceDelayMs + tolerance;
    const isStale = ageMs > expectedMaxAgeMs;
    return {
      state: isStale ? FreshnessState.STALE : FreshnessState.LIVE,
      label: isStale ? 'Stale - feed may be down' : 'Live',
      ageMs,
      expectedMaxAgeMs,
      isStale,
      marketOpen: true,
      sourceDelayMs,
    };
  }

  if (isMarketOpen(now)) {
    const expectedMaxAgeMs = sourceDelayMs + tolerance;
    if (ageMs > expectedMaxAgeMs) {
      return {
        state: FreshnessState.STALE,
        label: 'Stale - market is open but the feed has not updated',
        ageMs,
        expectedMaxAgeMs,
        isStale: true,
        marketOpen: true,
        sourceDelayMs,
      };
    }
    return {
      state: sourceDelayMs > 0 ? FreshnessState.DELAYED : FreshnessState.LIVE,
      label:
        sourceDelayMs > 0
          ? `Delayed by up to ${Math.round(sourceDelayMs / 60_000)} min`
          : 'Live',
      ageMs,
      expectedMaxAgeMs,
      isStale: false,
      marketOpen: true,
      sourceDelayMs,
    };
  }

  /**
   * Market closed. The newest snapshot should date from around the last close;
   * if it predates that by more than a session's worth of tolerance we really
   * did miss data - the feed was broken *while the market was open* - and that
   * is worth flagging even now.
   */
  const closedAt = lastMarketClose(now);
  const expectedMaxAgeMs = now - closedAt + sourceDelayMs + tolerance;
  const isStale = ageMs > expectedMaxAgeMs;

  return {
    state: isStale ? FreshnessState.STALE : FreshnessState.MARKET_CLOSED,
    label: isStale
      ? 'Stale - no data from the last open session'
      : 'Market closed - last traded price',
    ageMs,
    expectedMaxAgeMs,
    isStale,
    marketOpen: false,
    sourceDelayMs,
    lastCloseAt: closedAt,
    nextOpenAt: nextMarketOpen(now),
  };
}

/**
 * Do the sources disagree about this symbol right now?
 *
 * Running one source at a time means the common case is no conflict at all.
 * The case that does arise is real and worth catching: switch DATA_SOURCE from
 * simulator to yahoo and the log suddenly holds two series describing the same
 * minutes with very different prices. Silently serving whichever row sorted
 * first would be exactly the "presenting one source's number as the truth"
 * failure the brief warns about.
 *
 * @param perSource output of snapshotLog.latestPerSource()
 */
export function detectConflict(perSource, now = Date.now()) {
  const recent = perSource.filter((s) => now - s.timestamp <= config.conflictWindowMs);
  if (recent.length < 2) return null;

  let low = recent[0];
  let high = recent[0];
  for (const snapshot of recent) {
    if (snapshot.price < low.price) low = snapshot;
    if (snapshot.price > high.price) high = snapshot;
  }

  // Percentage of the lower price, so the tolerance means the same thing for a
  // 275-rupee stock and a 4,000-rupee one.
  const spreadPct = ((high.price - low.price) / low.price) * 100;
  if (spreadPct <= config.conflictTolerancePct) return null;

  return {
    spreadPct: Math.round(spreadPct * 100) / 100,
    tolerancePct: config.conflictTolerancePct,
    /**
     * The higher-confidence side is offered as the one to believe - and when
     * confidence ties, neither is promoted. The disagreement is reported
     * either way; picking a winner is not the same as hiding the argument.
     */
    preferred:
      high.confidence === low.confidence
        ? null
        : (high.confidence > low.confidence ? high : low).source,
    observations: recent.map((s) => ({
      source: s.source,
      price: s.price,
      timestamp: s.timestamp,
      confidence: s.confidence,
    })),
  };
}
