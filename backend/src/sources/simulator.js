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
 * A symbol outside the featured list still gets a stable, plausible identity
 * derived from its own name. This keeps the simulator from being the reason you
 * cannot type a ticker into the box, and it costs nothing: the hash of the
 * string is as good a seed as a hand-written table entry.
 */
function paramsFor(symbol) {
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

/** Build the snapshot for an exact tick index. Pure: no clock, no state. */
function snapshotForTick(symbol, tickIndex) {
  const timestamp = tickIndex * TICK_MS;
  if (!isTickAvailable(symbol, tickIndex, timestamp)) return null;

  const params = paramsFor(symbol);
  const base = seedHash();

  const trend = fbm(channel(base, `trend:${symbol}`), timestamp / TREND_PERIOD_MS, 5);
  const chop = fbm(channel(base, `chop:${symbol}`), timestamp / CHOP_PERIOD_MS, 3);

  const deviation = params.swing * trend + params.swing * 0.25 * chop;
  // Exchanges quote in paise, so the price a consumer sees is 2dp - and it is
  // rounded once, here, rather than drifting through downstream arithmetic.
  const price = Math.round(params.basePrice * (1 + deviation) * 100) / 100;

  // Volume tracks volatility: the busier the tape, the more shares change
  // hands. Log-normal keeps it positive with a believable long right tail.
  const volumeNoise = gaussian(channel(base, `volume:${symbol}`), tickIndex);
  const volatilityKick = 1 + 2 * Math.abs(chop);
  const volume = Math.max(
    1,
    Math.round(
      Math.exp(9 + 0.45 * volumeNoise) * intradayVolumeFactor(timestamp) * volatilityKick,
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

export const __testing = { snapshotForTick, paramsFor, intradayVolumeFactor };
