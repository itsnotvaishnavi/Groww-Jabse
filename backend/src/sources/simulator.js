/**
 * Synthetic market simulator.
 *
 * This is the source of truth for the demo, not a fallback. The build window
 * is Sep 4-7 2026, which is mostly a weekend: NSE and BSE are shut, real prices
 * do not move, and a watchlist whose entire premise is "what changed since you
 * last looked" would have nothing to show. So the simulator came first and the
 * real feed came second, behind the same interface.
 *
 * Properties it guarantees:
 *   - Deterministic: same seed + same symbol + same instant => same snapshot,
 *     byte for byte, across processes and machines.
 *   - Randomly addressable: any instant can be priced in O(1) without
 *     replaying history (see ./noise.js for why that mattered).
 *   - Imperfect on purpose: it drops ticks and occasionally goes dark for
 *     minutes at a time, because a source that never fails cannot demonstrate
 *     that the staleness handling works.
 */
import { config } from '../config.js';
import { BENCHMARK_SYMBOL } from '../symbols.js';
import { bernoulli, channel, fbm, fnv1a, gaussian, hashUnit } from './noise.js';

/**
 * Observations are quantised onto a fixed grid. Without a grid, "the price at
 * 10:03:07.412" and "the price at 10:03:07.413" would be different numbers and
 * the log would never dedupe. A tick is the smallest instant the simulated
 * market distinguishes, exactly like a real 1-minute candle but finer.
 */
export const TICK_MS = 15_000;

/** Slow component: a symbol's multi-day story. */
const TREND_PERIOD_MS = 5 * 24 * 60 * 60 * 1000;
/** Fast component: minute-to-minute chop around that story. */
const CHOP_PERIOD_MS = 20 * 60 * 1000;

/**
 * The featured universe. Base prices are illustrative starting points for a
 * synthetic market, chosen to sit in the right order of magnitude for each
 * name - they are not a claim about any real quote. `swing` is the fractional
 * amplitude of the slow trend, so a higher number is a more volatile name.
 */
const UNIVERSE = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', basePrice: 1420, swing: 0.09 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', basePrice: 4080, swing: 0.07 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', basePrice: 1710, swing: 0.06 },
  { symbol: 'INFY', name: 'Infosys', basePrice: 1845, swing: 0.08 },
  { symbol: 'ITC', name: 'ITC', basePrice: 465, swing: 0.05 },
  { symbol: 'SBIN', name: 'State Bank of India', basePrice: 812, swing: 0.1 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors', basePrice: 695, swing: 0.14 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', basePrice: 1655, swing: 0.08 },
  { symbol: 'LT', name: 'Larsen & Toubro', basePrice: 3620, swing: 0.09 },
  { symbol: 'ZOMATO', name: 'Eternal (Zomato)', basePrice: 275, swing: 0.19 },
];

const BY_SYMBOL = new Map(UNIVERSE.map((s) => [s.symbol, s]));

/**
 * THE MARKET FACTOR
 *
 * Previously every symbol was an independent noise field, which made the whole
 * market moving together literally impossible - and that in turn made the
 * market-relative and sector-relative signals impossible to demonstrate at
 * all during a weekend when the real exchanges are shut.
 *
 * So a symbol's deviation now decomposes the way a real one does:
 *
 *     symbol_deviation = beta * market_deviation + idiosyncratic_deviation
 *
 * Because price = base * (1 + deviation), a linear relationship in levels
 * gives the same linear relationship in returns - which is the form the
 * scoring engine consumes. Both components are still pure functions of
 * (seed, symbol, tick), so the whole thing stays O(1) addressable at any
 * instant with no sequential replay.
 *
 * The consequence worth stating plainly: a market-wide move should NOT score
 * as highly meaningful for an individual stock, and now it genuinely can be
 * generated and tested rather than argued about.
 */
const MARKET_SWING = 0.05;
/** A plausible spread of betas: defensive names near 0.6, racy ones near 1.5. */
const BETA_RANGE = [0.6, 1.5];

/** The benchmark's own parameters - an index level, not a share price. */
const BENCHMARK_PARAMS = {
  symbol: BENCHMARK_SYMBOL,
  name: 'NIFTY 50 (simulated)',
  basePrice: 24_200,
  swing: MARKET_SWING,
  isBenchmark: true,
};

/** Deterministic beta for a symbol. Same seed and symbol, same beta, forever. */
function betaFor(symbol, base) {
  const [lo, hi] = BETA_RANGE;
  return lo + hashUnit(channel(base, `beta:${symbol}`), 0) * (hi - lo);
}

/**
 * The shared market deviation at an instant: one series every symbol leans on.
 * Addressable on its own so it can be ingested as the benchmark.
 */
function marketDeviation(timestamp, base) {
  const trend = fbm(channel(base, 'market:trend'), timestamp / TREND_PERIOD_MS, 5);
  const chop = fbm(channel(base, 'market:chop'), timestamp / CHOP_PERIOD_MS, 3);
  return MARKET_SWING * trend + MARKET_SWING * 0.25 * chop;
}

/**
 * A symbol outside the featured list still gets a stable, plausible identity
 * derived from its own name. This keeps the simulator from being the reason you
 * cannot type a ticker into the box, and it costs nothing: the hash of the
 * string is as good a seed as a hand-written table entry.
 */
function paramsFor(symbol) {
  if (symbol === BENCHMARK_SYMBOL) return BENCHMARK_PARAMS;

  const known = BY_SYMBOL.get(symbol);
  if (known) return known;

  const h = fnv1a(symbol);
  return {
    symbol,
    name: symbol,
    basePrice: 100 + Math.round(hashUnit(h, 1) * 3900),
    swing: 0.05 + hashUnit(h, 2) * 0.15,
    synthesizedParams: true,
  };
}

/** Probability an individual tick is simply missing from the feed. */
const TICK_GAP_PROBABILITY = Number(process.env.SIM_GAP_PROBABILITY ?? 0.03);
/** Probability a whole 10-minute block is dark, modelling a feed outage. */
const OUTAGE_PROBABILITY = Number(process.env.SIM_OUTAGE_PROBABILITY ?? 0.02);
const OUTAGE_BLOCK_MS = 10 * 60 * 1000;

const seedHash = () => fnv1a(config.simSeed);

/**
 * Is the feed carrying this tick at all?
 *
 * Two independent failure modes, because they have different shapes and the
 * freshness layer should be able to tell them apart: single dropped ticks
 * (noise, recovers immediately) and multi-minute outages (the kind that should
 * actually mark a symbol stale).
 */
function isTickAvailable(symbol, tickIndex, timestamp) {
  const base = seedHash();

  if (OUTAGE_PROBABILITY > 0) {
    const outageChannel = channel(base, `outage:${symbol}`);
    const block = Math.floor(timestamp / OUTAGE_BLOCK_MS);
    if (bernoulli(outageChannel, block, OUTAGE_PROBABILITY)) return false;
  }

  if (TICK_GAP_PROBABILITY > 0) {
    const gapChannel = channel(base, `gap:${symbol}`);
    if (bernoulli(gapChannel, tickIndex, TICK_GAP_PROBABILITY)) return false;
  }

  return true;
}

/**
 * Intraday volume seasonality: real markets trade in a U - heavy at the open,
 * quiet mid-session, heavy into the close. Expressed in IST because that is the
 * market being simulated. Price is deliberately left out of this: the simulated
 * market runs around the clock (see `describe()`), so shaping price by session
 * would reintroduce the flat weekend this module exists to solve.
 */
function intradayVolumeFactor(timestamp) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istMinutes = Math.floor(((timestamp + IST_OFFSET_MS) % 86_400_000) / 60_000);
  // 09:15 -> 15:30 IST as minutes past midnight.
  const fromOpen = (istMinutes - 555) / (930 - 555);
  if (fromOpen < 0 || fromOpen > 1) return 0.35; // outside session hours
  // Parabola: 1.6x at the bell, ~0.6x at midday.
  return 0.6 + 1.0 * (2 * fromOpen - 1) ** 2;
}

/**
 * DEMONSTRABLE ANOMALIES
 *
 * The engine's whole job is spotting the unusual, so the simulator has to be
 * able to produce some. Two events recur on a deterministic schedule whose
 * phase comes from the seed: one symbol gets a large idiosyncratic price move,
 * a different symbol gets a volume spike while its price does nothing special.
 *
 * Recurring rather than one-shot is what makes the demo reliable: the period is
 * short enough that any recent window contains an instance, so the scenario
 * works whenever it is run - while the events stay pure functions of absolute
 * time, which is what keeps the series replayable.
 */
const EVENT_PERIOD_MS = 40 * 60 * 1000;
const EVENT_DURATION_MS = 3 * 60 * 1000;
/** Peak size of the idiosyncratic price event, as a fraction of base price. */
const PRICE_SHOCK = 0.035;
/** Peak volume multiplier for the volume event (1 + this). */
const VOLUME_SHOCK = 3;

/** Which symbols carry the events. Deterministic from the seed. */
function eventSymbols(base) {
  const priceIndex = Math.floor(hashUnit(channel(base, 'event:price'), 0) * UNIVERSE.length);
  let volumeIndex = Math.floor(hashUnit(channel(base, 'event:volume'), 0) * UNIVERSE.length);
  // The volume spike must land on a *different* symbol, or "volume spike on a
  // modest price move" would not be a distinct case from the price shock.
  if (volumeIndex === priceIndex) volumeIndex = (volumeIndex + 1) % UNIVERSE.length;

  return {
    priceShock: UNIVERSE[priceIndex].symbol,
    volumeShock: UNIVERSE[volumeIndex].symbol,
  };
}

/**
 * A raised-cosine pulse: 0 at the window's edges, 1 at its centre. Smooth in
 * and smooth out, so the event has no discontinuity that would look like a
 * data error rather than a market move.
 */
function eventPulse(timestamp, base, key) {
  const phase = hashUnit(channel(base, `phase:${key}`), 0) * EVENT_PERIOD_MS;
  const position = (((timestamp - phase) % EVENT_PERIOD_MS) + EVENT_PERIOD_MS) % EVENT_PERIOD_MS;
  if (position > EVENT_DURATION_MS) return 0;
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * position) / EVENT_DURATION_MS);
}

/**
 * How much of a symbol's own variance is idiosyncratic rather than shared.
 * Scaling the idiosyncratic component keeps total volatility close to what the
 * per-symbol `swing` implied before the market factor was added, so prices stay
 * in the same believable band.
 */
const IDIO_SHARE = 0.7;

/** Build the snapshot for an exact tick index. Pure: no clock, no state. */
function snapshotForTick(symbol, tickIndex) {
  const timestamp = tickIndex * TICK_MS;
  if (!isTickAvailable(symbol, tickIndex, timestamp)) return null;

  const params = paramsFor(symbol);
  const base = seedHash();
  const events = eventSymbols(base);

  const market = marketDeviation(timestamp, base);

  let deviation;
  let chop;

  if (params.isBenchmark) {
    // The index *is* the market factor - it has no idiosyncratic component and
    // carries no single-stock events.
    deviation = market;
    chop = fbm(channel(base, 'market:chop'), timestamp / CHOP_PERIOD_MS, 3);
  } else {
    const trend = fbm(channel(base, `trend:${symbol}`), timestamp / TREND_PERIOD_MS, 5);
    chop = fbm(channel(base, `chop:${symbol}`), timestamp / CHOP_PERIOD_MS, 3);

    const idiosyncratic =
      IDIO_SHARE * (params.swing * trend + params.swing * 0.25 * chop) +
      (symbol === events.priceShock ? PRICE_SHOCK * eventPulse(timestamp, base, 'price') : 0);

    deviation = betaFor(symbol, base) * market + idiosyncratic;
  }

  // Exchanges quote in paise, so the price a consumer sees is 2dp - and it is
  // rounded once, here, rather than drifting through downstream arithmetic.
  const price = Math.round(params.basePrice * (1 + deviation) * 100) / 100;

  // Volume tracks volatility: the busier the tape, the more shares change
  // hands. Log-normal keeps it positive with a believable long right tail.
  const volumeNoise = gaussian(channel(base, `volume:${symbol}`), tickIndex);
  const volatilityKick = 1 + 2 * Math.abs(chop);
  const volumeEvent =
    symbol === events.volumeShock
      ? 1 + VOLUME_SHOCK * eventPulse(timestamp, base, 'volume')
      : 1;
  const volume = Math.max(
    1,
    Math.round(
      Math.exp(9 + 0.45 * volumeNoise) *
        intradayVolumeFactor(timestamp) *
        volatilityKick *
        volumeEvent,
    ),
  );

  return {
    symbol,
    timestamp,
    price,
    volume,
    source: 'simulator',
    /**
     * 1.0 is not bravado about realism. Confidence answers "how accurately does
     * this row reflect what the named source reported for that instant" - and
     * for a generator we evaluate exactly, with no delay and no transport. That
     * the source is synthetic is communicated by `source`, not by confidence.
     */
    confidence: 1,
  };
}

export const simulator = {
  name: 'simulator',

  describe() {
    return {
      name: 'simulator',
      kind: 'synthetic',
      /**
       * The simulated market never closes. That is the entire reason this
       * module leads the build: a weekend demo needs movement. Real session
       * hours still matter, but they belong to the freshness layer, which has
       * to decide whether an old price is a bug or a closed exchange.
       */
      alwaysOpen: true,
      delayMs: 0,
      seed: config.simSeed,
      tickMs: TICK_MS,
      universeSize: UNIVERSE.length,
      /** The benchmark this source can serve, for the ingestor to poll. */
      benchmarkSymbol: BENCHMARK_SYMBOL,
      marketFactor: { swing: MARKET_SWING, betaRange: BETA_RANGE, idioShare: IDIO_SHARE },
      /** Which symbols carry the scheduled anomalies, for the demo script. */
      events: eventSymbols(seedHash()),
    };
  },

  /** Featured symbols, for the UI's suggestion list. Any ticker still works. */
  getSymbols() {
    return UNIVERSE.map(({ symbol, name }) => ({ symbol, name }));
  },

  /**
   * The most recent completed tick. Returns null when the feed has nothing for
   * that instant - a real absence, which callers must handle rather than a
   * fabricated last-known value.
   */
  async getLatestSnapshot(symbol) {
    return snapshotForTick(symbol, Math.floor(Date.now() / TICK_MS));
  },

  /**
   * The price as of an arbitrary instant, rounded down to the tick containing
   * it. Works for any timestamp in the past or the future at the same cost as
   * asking for the present.
   */
  async getSnapshotAt(symbol, timestamp) {
    return snapshotForTick(symbol, Math.floor(timestamp / TICK_MS));
  },
};

export const __testing = {
  snapshotForTick,
  paramsFor,
  intradayVolumeFactor,
  marketDeviation,
  betaFor,
  eventSymbols,
  eventPulse,
  seedHash,
  UNIVERSE,
  EVENT_PERIOD_MS,
  EVENT_DURATION_MS,
};
