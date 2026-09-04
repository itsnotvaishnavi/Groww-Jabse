/**
 * Named demo scenarios.
 *
 * A demo aid, not randomness. Every scenario is a pure function of its own seed
 * and the reference instant, so the same name produces the same market on every
 * run and on every machine - which is what makes it usable in front of an
 * audience and testable in CI. The deterministic simulator is untouched and
 * still available; these are crafted histories written straight into the
 * snapshot log, for when a demo needs a specific condition on demand rather
 * than whatever the simulator happens to be doing.
 *
 * TWO AXES, because the product has two independent stories to tell:
 *
 *   TIME AWAY       how long the user was gone - 1h, 6h, 24h, 2d. This is the
 *                   existing absence override, now named. It changes the
 *                   headline and whether the summary enumerates or aggregates.
 *
 *   MARKET CONDITION what the market did while they were gone. This needs real
 *                   observations, so it is a seeding operation.
 *
 * THE COLD-OPEN REQUIREMENT. `stock_outperforms` must reliably produce a HIGH
 * attention result with the sector signal AVAILABLE, so that a judge opening
 * the app sees the whole engine work rather than a column of LOW. That is
 * asserted in scenarios.test.js rather than assumed - the numbers below were
 * tuned until the test passed, and the test is what keeps them honest if a
 * weight or threshold ever changes.
 */
import { channel, fnv1a, hashUnit } from '../sources/noise.js';
import { BENCHMARK_SYMBOL } from '../symbols.js';
import { FrozenSource } from '../freshness.js';

const MIN = 60_000;

/** One observation a minute for 12 hours: a window plus its own baseline. */
const BAR_MS = MIN;
const BARS = 720;

/**
 * A SPARSE OLDER TAIL, reaching back two days at fifteen-minute spacing.
 *
 * Without it the 24h and 2d time-away settings were silently clamped to the
 * twelve hours of dense history and both reported "11h 59m" - two named
 * scenarios quietly not doing what they said. A visit two days ago needs an
 * observation from two days ago to diff against.
 *
 * Deliberately coarse, and deliberately outside the engine's six-hour stats
 * window, so it gives `asOf` a baseline for a long absence without touching any
 * of the statistics. Real backfill thins out with age in the same way.
 */
const TAIL_SPACING_MS = 15 * MIN;
const TAIL_SPAN_MS = 48 * 60 * MIN;

export const TIME_AWAY = [
  { id: '1h', label: '1 hour', ms: 60 * MIN },
  { id: '6h', label: '6 hours', ms: 6 * 60 * MIN },
  { id: '24h', label: '24 hours', ms: 24 * 60 * MIN },
  { id: '2d', label: '2 days', ms: 48 * 60 * MIN },
];

/**
 * The IT names carry every scenario.
 *
 * Four watched peers in one sector means the sector signal is available in all
 * of them - which is the only way the sector-relative contribution can be
 * demonstrated at all, and the reason the HIGH scenario can reach a full
 * four-signal score.
 */
const CORE = ['INFY', 'TCS', 'WIPRO', 'HCLTECH'];
/** The symbol each scenario does something to, when it does something. */
const SUBJECT = 'INFY';

export const CONDITIONS = [
  {
    id: 'normal',
    label: 'Normal',
    description: 'A quiet tape. Everything calm, nothing worth surfacing.',
    expect: 'All LOW — the baseline the other scenarios are read against.',
  },
  {
    id: 'high_volume',
    label: 'High volume',
    description: `${SUBJECT} trades at four times normal turnover on an ordinary price move.`,
    expect: 'MODERATE on volume alone — the case a percentage-change watchlist misses.',
  },
  {
    id: 'stock_outperforms',
    label: 'Stock outperforms market',
    description: `${SUBJECT} rises sharply on heavy volume while its peers and the index stay flat.`,
    expect: 'HIGH with all four signals available, including sector.',
  },
  {
    id: 'market_wide',
    label: 'Market-wide move',
    description: 'Every stock AND the index rise together by the same amount.',
    expect: 'Not highly meaningful — the relative signals correctly cancel.',
  },
  {
    id: 'data_delay',
    label: 'Data delay',
    description: 'The feed stops 25 minutes before now.',
    expect: 'STALE data quality, reduced confidence, alerts refusing to fire.',
  },
  {
    id: 'source_conflict',
    label: 'Source conflict',
    description: `Two feeds disagree about ${SUBJECT} by nearly 1%.`,
    expect: 'A conflict reported rather than one source silently preferred.',
  },
];

const CONDITION_IDS = new Set(CONDITIONS.map((c) => c.id));

/** Per-scenario seed, so each condition is reproducible and distinct. */
const seedFor = (condition) => fnv1a(`jabse-scenario:${condition}`);

/** Deterministic wiggle in [-1, 1] for (condition, symbol, bar). */
function wiggle(seed, symbol, i) {
  return hashUnit(channel(seed, `w:${symbol}`), i) * 2 - 1;
}

/**
 * A price path.
 *
 * `rampFrom` is where a move begins, as a bar index, so the change lands well
 * inside the analysis windows rather than at their edge where it would be
 * invisible.
 */
/**
 * `moveBars` is the number of FINAL bars the move happens over, and getting it
 * wrong is the mistake that made the first version of the cold-open scenario
 * score LOW.
 *
 * The engine judges the price anomaly over its anomaly horizon - fifteen
 * one-minute bars by default. A move that completes an hour before the end is
 * a finished move: the last-fifteen-minute return is flat, so the z-score is
 * flat, and the same is true of the market- and sector-relative signals, which
 * use the same span. Only the change-since-viewed feature would still see it.
 * So a scenario that wants the engine to react has to put the move INSIDE the
 * horizon.
 */
function pricePath({ seed, symbol, base, amplitude, move = 0, moveBars = 15 }) {
  const rampFrom = BARS - moveBars;
  return (i) => {
    const drift = amplitude * wiggle(seed, symbol, i);
    const progress = move === 0 ? 0 : Math.max(0, Math.min(1, (i - rampFrom) / moveBars));
    return Math.round(base * (1 + drift + move * progress) * 100) / 100;
  };
}

/**
 * The volume spike covers only the last few bars, for a related reason: the
 * volume feature compares the newest bar against the trailing average, so a
 * spike spread over an hour raises that average and dilutes its own ratio.
 */
function volumePath({ seed, symbol, base, multiplier = 1, volumeBars = 5 }) {
  const rampFrom = BARS - volumeBars;
  return (i) => {
    const jitter = 1 + 0.12 * wiggle(seed, `${symbol}:v`, i);
    const spike = i >= rampFrom ? multiplier : 1;
    return Math.max(1, Math.round(base * jitter * spike));
  };
}

const BASE_PRICE = { INFY: 1845, TCS: 4080, WIPRO: 545, HCLTECH: 1690 };
const BASE_VOLUME = { INFY: 12_000, TCS: 9_000, WIPRO: 14_000, HCLTECH: 8_000 };

/**
 * Per-condition shape for one symbol: how volatile it is, how far it moves, and
 * how heavily it trades.
 *
 * The amplitudes matter as much as the moves. A stock whose ordinary wiggle is
 * large needs a big move to look unusual; one that is placid does not. These
 * are the numbers the cold-open test pins down.
 */
function shapeFor(condition, symbol) {
  const isSubject = symbol === SUBJECT;

  switch (condition) {
    case 'normal':
      return { amplitude: 0.0009, move: 0, volumeMultiplier: 1 };

    case 'high_volume':
      // A modest move on four times the turnover: volume is the whole signal.
      return isSubject
        ? { amplitude: 0.0035, move: 0.004, volumeMultiplier: 4 }
        : { amplitude: 0.0009, move: 0, volumeMultiplier: 1 };

    case 'stock_outperforms':
      /**
       * The cold-open scenario. A placid stock (small amplitude, so the move is
       * many sigma), a large move, and heavy volume - while peers and the index
       * stay flat, which is what makes both relative signals large.
       */
      return isSubject
        ? { amplitude: 0.0007, move: 0.035, volumeMultiplier: 5 }
        : { amplitude: 0.0008, move: 0, volumeMultiplier: 1 };

    case 'market_wide':
      // Everything moves together, including the benchmark below.
      return { amplitude: 0.0009, move: 0.03, volumeMultiplier: 1 };

    case 'data_delay':
      return { amplitude: 0.001, move: 0.006, volumeMultiplier: 1 };

    case 'source_conflict':
      return { amplitude: 0.0012, move: 0, volumeMultiplier: 1 };

    default:
      return { amplitude: 0.001, move: 0, volumeMultiplier: 1 };
  }
}

export function findCondition(id) {
  return CONDITIONS.find((c) => c.id === id) ?? null;
}

export function findTimeAway(id) {
  return TIME_AWAY.find((t) => t.id === id) ?? null;
}

/**
 * Apply a scenario to a database.
 *
 * @param now the reference instant. Injected, so the scenario is reproducible
 *        and the tests can hold the clock still.
 * @param timeAwayId which named absence to stamp into last_viewed_at. The
 *        viewing time is set relative to the END OF THE WRITTEN HISTORY rather
 *        than to `now`, so a delta always exists even in the delayed scenario -
 *        otherwise "24 hours away" against a feed that stopped 25 minutes ago
 *        would leave no observation after the visit and no change to show.
 */
export function applyScenario({
  snapshotLog,
  watchlist,
  userId,
  condition = 'normal',
  timeAwayId = '6h',
  now = Date.now(),
}) {
  if (!CONDITION_IDS.has(condition)) {
    throw new Error(
      `unknown scenario "${condition}". Available: ${[...CONDITION_IDS].join(', ')}`,
    );
  }

  const away = findTimeAway(timeAwayId) ?? findTimeAway('6h');
  const seed = seedFor(condition);

  /**
   * The delayed scenario stops its feed short of now. Everything else runs up
   * to the current bar.
   */
  const delayMs = condition === 'data_delay' ? 25 * MIN : 0;

  /**
   * The newest observation lands exactly on `now`, NOT floored to the bar grid.
   *
   * Flooring left it up to a full bar old, and the staleness tolerance is three
   * fifteen-second polls - so every scenario read as STALE and every row
   * carried a "limited or delayed data" caveat with confidence halved. Only
   * `data_delay` is supposed to be stale, and it earns that honestly by
   * stopping its feed twenty-five minutes short.
   *
   * The resampler works from arbitrary timestamps, so nothing needs the data
   * itself to sit on the grid.
   */
  const endAt = now - delayMs;

  const rows = [];
  const push = (symbol, timestamp, price, volume, source, confidence) => {
    rows.push({ symbol, timestamp, price, volume, source, confidence, ingestedAt: timestamp });
  };

  /**
   * THE CONFLICT, written first so it takes a lower row id and does not become
   * the primary price. Otherwise the disagreement itself would read as a large
   * price move and the scenario would demonstrate an anomaly rather than a
   * conflict. Same reasoning as the demo fixture.
   */
  if (condition === 'source_conflict') {
    const shape = shapeFor(condition, SUBJECT);
    const path = pricePath({ seed, symbol: SUBJECT, base: BASE_PRICE[SUBJECT], ...shape });
    push(SUBJECT, endAt, Math.round(path(BARS) * 1.009 * 100) / 100, 11_000, 'alt-feed', 0.6);
  }

  for (const symbol of CORE) {
    const shape = shapeFor(condition, symbol);
    const price = pricePath({ seed, symbol, base: BASE_PRICE[symbol], ...shape });
    const volume = volumePath({
      seed,
      symbol,
      base: BASE_VOLUME[symbol],
      multiplier: shape.volumeMultiplier,
      volumeBars: shape.volumeBars,
    });

    /**
     * The tail first, oldest to newest. Bar indices go negative here, which the
     * hash-based wiggle handles as readily as positive ones - so the sparse
     * history is a continuation of the same deterministic path, not a
     * differently-shaped stub bolted on.
     */
    const denseFrom = endAt - BARS * BAR_MS;
    for (let t = endAt - TAIL_SPAN_MS; t < denseFrom; t += TAIL_SPACING_MS) {
      const i = Math.round((t - endAt) / BAR_MS) + BARS;
      push(symbol, t, price(i), volume(i), FrozenSource.SCENARIO, 1);
    }

    for (let i = 0; i <= BARS; i += 1) {
      push(symbol, endAt - (BARS - i) * BAR_MS, price(i), volume(i), FrozenSource.SCENARIO, 1);
    }
  }

  /**
   * The benchmark. Flat in every scenario EXCEPT market_wide, where it rises
   * with everything else - which is what makes the relative signals cancel and
   * the score correctly stay low despite a large move.
   */
  const benchmarkShape =
    condition === 'market_wide'
      ? { amplitude: 0.0006, move: 0.03 }
      : { amplitude: 0.0006, move: 0 };
  const benchmark = pricePath({
    seed,
    symbol: BENCHMARK_SYMBOL,
    base: 24_200,
    ...benchmarkShape,
  });
  const benchmarkDenseFrom = endAt - BARS * BAR_MS;
  for (let t = endAt - TAIL_SPAN_MS; t < benchmarkDenseFrom; t += TAIL_SPACING_MS) {
    const i = Math.round((t - endAt) / BAR_MS) + BARS;
    push(BENCHMARK_SYMBOL, t, benchmark(i), 0, FrozenSource.SCENARIO, 1);
  }
  for (let i = 0; i <= BARS; i += 1) {
    push(BENCHMARK_SYMBOL, endAt - (BARS - i) * BAR_MS, benchmark(i), 0, FrozenSource.SCENARIO, 1);
  }

  snapshotLog.appendMany(rows);

  // Watchlist: the core four, each viewed the scenario's time-away ago.
  /**
   * Clamped to the sparse tail rather than to the dense window, so 24h and 2d
   * are honoured instead of being quietly shortened to twelve hours.
   */
  const viewedAt = Math.max(endAt - away.ms, endAt - TAIL_SPAN_MS + TAIL_SPACING_MS);
  for (const symbol of CORE) {
    watchlist.add(userId, symbol, now - 7 * 24 * 60 * MIN);
    watchlist.markViewed(userId, symbol, viewedAt);
  }

  return {
    condition,
    conditionLabel: findCondition(condition).label,
    timeAwayId: away.id,
    timeAwayMs: away.ms,
    symbols: CORE,
    subject: SUBJECT,
    observations: rows.length,
    historyEndsAt: endAt,
    viewedAt,
    delayMs,
    seed: `jabse-scenario:${condition}`,
  };
}

/** The catalogue, for the API and the UI. */
export function scenarioCatalogue() {
  return {
    timeAway: TIME_AWAY,
    conditions: CONDITIONS.map((c) => ({
      ...c,
      command: `npm run demo -- ${c.id} 6h`,
    })),
    note:
      'Market conditions are a seeding operation, so they are applied to a fresh database by the CLI. Time away is an override and switches instantly.',
  };
}
