/**
 * The demo fixture: one reproducible scenario that is also the regression
 * baseline.
 *
 * Everything here is a deterministic function of `now` and a fixed seed, so
 * the same scenario is reproduced exactly on every run and on every machine.
 * Prices are synthetic and every row says so through its `source` field -
 * except the two observations that are genuinely real, which are labelled
 * `yahoo-observed` and are noted below.
 *
 * WHAT IT GUARANTEES
 *   INFY        HIGH      - large idiosyncratic move, heavy volume, market flat
 *   SBIN        MODERATE  - volume spike on a modest price move
 *   TCS/WIPRO/
 *   HCLTECH     LOW       - calm, and INFY's sector peers
 *   HDFCBANK    conflict  - two sources disagreeing beyond tolerance
 *   RELIANCE +
 *   RELIANCE.BO cross-venue - the real NSE/BSE pair, correctly NOT a conflict
 *   ITC         missing volume    - the feature reports unavailable
 *   MARUTI      thin history      - anomaly features report unavailable
 *
 * A NOTE ON THE CONFLICT CASE, because the brief and the data disagree.
 *
 * The suggestion was to use a real captured pair - RELIANCE at 1327.60 on NSE
 * and 1329.10 on BSE, seconds apart - as the conflicting-source case. It cannot
 * serve as one, for two independent reasons:
 *
 *   1. Those are different instruments. Since the canonicalisation fix, NSE
 *      RELIANCE and BSE RELIANCE.BO are deliberately separate series, because
 *      they are separate listings that trade at separate prices. Filing them as
 *      one symbol is the bug that fix removed.
 *   2. They agree. The spread is 0.113%, comfortably inside the 0.5% conflict
 *      tolerance, so flagging it would be the false positive the tolerance
 *      exists to prevent.
 *
 * Forcing it - by lowering the tolerance until real, agreeing data trips the
 * alarm - would be tuning the product to make a demo fire. So the real pair is
 * used for what it genuinely demonstrates (two venues, correctly separate,
 * correctly not in conflict) and the conflict path is demonstrated by a clearly
 * labelled constructed disagreement on a single symbol, which is the shape a
 * real conflict actually takes.
 */
import { channel, fnv1a, hashUnit } from '../sources/noise.js';

export const DEMO_SEED = 'jabse-demo-2026';

/** One minute per bar, three hours of history: comfortably past minReturns. */
const BAR_MS = 60_000;
const BARS = 180;

/**
 * Deterministic wiggle in [-1, 1] for (symbol, bar). Its own hash channel, so
 * no symbol's path depends on another's and the whole fixture is reproducible
 * from DEMO_SEED alone.
 */
function wiggle(symbol, i) {
  const h = channel(fnv1a(DEMO_SEED), `demo:${symbol}`);
  return hashUnit(h, i) * 2 - 1;
}

/**
 * A price path.
 *
 * @param amplitude fractional size of the ordinary wiggle - this is what sets
 *        the stock's normal volatility, and therefore how many sigma a given
 *        final move is worth.
 * @param finalMove fractional move applied to the last bar only.
 */
function path({ symbol, base, amplitude, finalMove = 0 }) {
  return (i) => {
    const drift = amplitude * wiggle(symbol, i);
    const shock = i === BARS ? finalMove : 0;
    return Math.round(base * (1 + drift + shock) * 100) / 100;
  };
}

/** Volume path: flat, with an optional multiplier on the final bar. */
function volumePath({ symbol, base, finalMultiplier = 1 }) {
  return (i) => {
    const jitter = 1 + 0.15 * wiggle(`${symbol}:vol`, i);
    const spike = i === BARS ? finalMultiplier : 1;
    return Math.max(1, Math.round(base * jitter * spike));
  };
}

/**
 * The scenario. Amplitudes and final moves are chosen so each symbol lands in
 * its intended band - and the test asserts they still do, so a change to the
 * weights or thresholds fails loudly here rather than silently degrading the
 * demo.
 */
const SPEC = [
  {
    // HIGH: a big move for a normally-calm stock, on heavy volume, while the
    // market does nothing. All four signals fire.
    symbol: 'INFY',
    base: 1845,
    amplitude: 0.0008,
    finalMove: 0.032,
    volume: 12_000,
    volumeMultiplier: 5,
    viewedMinutesAgo: 45,
  },
  {
    // MODERATE: a modest move, but on 2.5x volume. Its baseline volatility is
    // higher, so the same move is only about 1.5 sigma - which is exactly the
    // case a percentage-change watchlist gets wrong in both directions.
    symbol: 'SBIN',
    base: 812,
    amplitude: 0.004,
    finalMove: 0.0055,
    volume: 30_000,
    volumeMultiplier: 2.5,
    viewedMinutesAgo: 45,
  },
  { symbol: 'TCS', base: 4080, amplitude: 0.0009, volume: 9_000, viewedMinutesAgo: 45 },
  { symbol: 'WIPRO', base: 545, amplitude: 0.0011, volume: 14_000, viewedMinutesAgo: 45 },
  { symbol: 'HCLTECH', base: 1690, amplitude: 0.001, volume: 8_000, viewedMinutesAgo: 45 },
  {
    // ITC reports no volume at all, so the volume feature must say
    // "unavailable" rather than reading it as a collapse to zero.
    symbol: 'ITC',
    base: 465,
    amplitude: 0.0012,
    volume: 0,
    viewedMinutesAgo: 45,
  },
  {
    /**
     * The conflict case. The disagreeing observation is written FIRST (see
     * below) so it takes a lower row id and therefore does not become the
     * primary price - which keeps the conflict the story rather than dragging
     * the symbol into MODERATE on the strength of the disagreement itself.
     */
    symbol: 'HDFCBANK',
    base: 1710,
    amplitude: 0.0015,
    volume: 11_000,
    viewedMinutesAgo: 45,
  },
];

/** Real observations. These two numbers were captured from live Yahoo. */
export const REAL_OBSERVATION = {
  nse: { symbol: 'RELIANCE', price: 1327.6, volume: 15_947 },
  bse: { symbol: 'RELIANCE.BO', price: 1329.1, volume: 260 },
  note:
    'Captured from Yahoo on 2026-09-04 while NSE was open. The 0.113% spread is ' +
    'a genuine cross-venue difference, and is correctly NOT reported as a source ' +
    'conflict: it is inside the 0.5% tolerance, and the two listings are separate ' +
    'instruments by design.',
};

/**
 * Apply the fixture to a database.
 *
 * @param now the reference instant everything is measured back from. Injected
 *        rather than read from the clock, so the fixture is reproducible and
 *        the tests over it are stable.
 */
export function applyDemoFixture({ snapshotLog, watchlist, userId, now }) {
  const endAt = Math.floor(now / BAR_MS) * BAR_MS;
  const rows = [];

  const push = (symbol, i, price, volume, source, confidence) => {
    const timestamp = endAt - (BARS - i) * BAR_MS;
    rows.push({
      symbol,
      timestamp,
      price,
      volume,
      source,
      confidence,
      // Set explicitly: the fixture must not embed a wall-clock value, or two
      // runs of the same scenario would differ.
      ingestedAt: timestamp,
    });
  };

  /**
   * THE CONFLICT, written first on purpose.
   *
   * Rows are inserted in array order, so this one takes the lowest id. Both
   * `latest()` and the bar resampler break same-timestamp ties by id, so the
   * primary series below wins the "current price" while this row remains a
   * second, disagreeing observation of the same instant - which is exactly
   * what a conflict is. Detection reads the newest row PER SOURCE, so it still
   * finds both.
   *
   * Constructed, and labelled as such by its source name. See the note at the
   * top of this file for why the real NSE/BSE pair cannot play this role.
   */
  const hdfcbank = SPEC.find((s) => s.symbol === 'HDFCBANK');
  const hdfcbankLatest = path(hdfcbank)(BARS);
  // 0.9% apart: beyond the 0.5% tolerance, and a plausible size for two feeds
  // genuinely disagreeing rather than an implausible gulf.
  rows.push({
    symbol: 'HDFCBANK',
    timestamp: endAt,
    price: Math.round(hdfcbankLatest * 1.009 * 100) / 100,
    volume: 11_000,
    source: 'alt-feed',
    confidence: 0.6,
    ingestedAt: endAt,
  });

  for (const spec of SPEC) {
    const priceAt = path(spec);
    const volumeAt = volumePath({
      symbol: spec.symbol,
      base: spec.volume,
      finalMultiplier: spec.volumeMultiplier ?? 1,
    });

    for (let i = 0; i <= BARS; i += 1) {
      push(spec.symbol, i, priceAt(i), spec.volume === 0 ? 0 : volumeAt(i), 'demo-fixture', 1);
    }
  }

  // The benchmark: deliberately calm, so INFY's move is its own and the
  // market-relative signal has something to say.
  const benchmarkPrice = path({ symbol: 'NIFTY', base: 24_200, amplitude: 0.0006 });
  for (let i = 0; i <= BARS; i += 1) {
    push('NIFTY', i, benchmarkPrice(i), 0, 'demo-fixture', 1);
  }

  /**
   * THIN HISTORY: four observations only. Enough to have a price, nowhere near
   * enough to estimate a distribution from - the anomaly features must decline
   * to answer rather than producing a z-score from four points.
   */
  const maruti = path({ symbol: 'MARUTI', base: 12_400, amplitude: 0.002 });
  for (let i = BARS - 3; i <= BARS; i += 1) {
    push('MARUTI', i, maruti(i), 4_200, 'demo-fixture', 1);
  }

  /**
   * THE REAL PAIR. Two venues, two prices, seconds apart, both genuine. They
   * are separate instruments and they agree within tolerance, so no conflict is
   * reported - which is the correct behaviour and worth showing.
   */
  for (const venue of [REAL_OBSERVATION.nse, REAL_OBSERVATION.bse]) {
    // A short history so the row has a price and a freshness state; the
    // anomaly features will report insufficient history, honestly.
    for (let i = BARS - 2; i <= BARS; i += 1) {
      push(venue.symbol, i, venue.price, venue.volume, 'yahoo-observed', 0.6);
    }
  }

  snapshotLog.appendMany(rows);

  // Watchlist: everything in the scenario, with viewing history where the spec
  // asks for it so "since you last checked" has something to say.
  const watched = [
    ...SPEC.map((s) => ({ symbol: s.symbol, viewedMinutesAgo: s.viewedMinutesAgo })),
    { symbol: 'MARUTI', viewedMinutesAgo: 45 },
    { symbol: 'RELIANCE', viewedMinutesAgo: 45 },
    { symbol: 'RELIANCE.BO', viewedMinutesAgo: null },
  ];

  for (const { symbol, viewedMinutesAgo } of watched) {
    watchlist.add(userId, symbol, now - 24 * 3_600_000);
    if (viewedMinutesAgo != null) {
      watchlist.markViewed(userId, symbol, now - viewedMinutesAgo * 60_000);
    }
  }

  return {
    seed: DEMO_SEED,
    now: endAt,
    symbols: watched.map((w) => w.symbol),
    observations: rows.length,
    realObservation: REAL_OBSERVATION,
  };
}
