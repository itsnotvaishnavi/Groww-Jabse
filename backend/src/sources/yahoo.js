/**
 * Real NSE/BSE data, via Yahoo Finance's chart endpoint.
 *
 * Deliberately a raw `fetch` against one documented-by-observation URL rather
 * than an npm wrapper. Two reasons: the endpoint needs no auth and no
 * cookie/crumb dance, so a wrapper would be buying very little; and every line
 * of the request, the parse, and the confidence assignment is something I can
 * defend, which a third-party abstraction over an unofficial API is not.
 *
 * HONESTY ABOUT THIS DATA
 * Yahoo's Indian-market quotes are typically delayed 15-20 minutes and the
 * endpoint carries no uptime promise. The app never presents this as real-time:
 * the snapshot's `timestamp` is the instant Yahoo attributes the price to (not
 * the instant we fetched it), and `confidence` is capped well below 1. See
 * ../freshness.js for how that is surfaced to the user.
 */
import { BENCHMARK_SYMBOL, canonicalizeSymbol } from '../symbols.js';

const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Yahoo rejects requests without a browser-ish User-Agent. Sending one is what
 * makes the endpoint usable at all, so it is set explicitly and visibly rather
 * than hidden inside a dependency.
 */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
};

/**
 * Confidence scale for this source. Both values are below 1 because a delayed
 * third-party feed is a weaker observation than an exact one, and the number
 * should say so.
 *   LATEST     - the live-ish quote, 15-20 min delayed, unofficial endpoint.
 *   HISTORICAL - a settled candle, no longer subject to delay, so stronger.
 */
const CONFIDENCE = { LATEST: 0.6, HISTORICAL: 0.85 };
/** Applied when the nearest candle is not actually near the instant asked for. */
const DISTANCE_PENALTY = 0.7;

/** Yahoo's name for the NIFTY 50 index. */
const YAHOO_BENCHMARK = '^NSEI';

/**
 * Canonical key -> Yahoo's wire symbol.
 *
 * The canonical form has no NSE suffix because NSE is implied (see
 * ../symbols.js), but Yahoo needs it explicitly, so it is added back here.
 * `.BO` passes through, and the benchmark becomes `^NSEI`. This is the only
 * place in the codebase that knows any of that.
 */
export function toYahooSymbol(symbol) {
  const canonical = canonicalizeSymbol(symbol);
  if (canonical === BENCHMARK_SYMBOL) return YAHOO_BENCHMARK;
  if (canonical.endsWith('.US')) return canonical.slice(0, -3);
  return canonical.endsWith('.BO') ? canonical : `${canonical}.NS`;
}

function canonicalSearchSymbol(symbol) {
  if (typeof symbol !== 'string' || symbol.trim() === '') return null;
  const raw = symbol.trim().toUpperCase();
  if (raw.endsWith('.NS') || raw.endsWith('.BO')) return canonicalizeSymbol(raw);
  try {
    return canonicalizeSymbol(`${raw}.US`);
  } catch {
    return null;
  }
}

/**
 * The symbol a snapshot is filed under is its canonical key, never the wire
 * symbol.
 *
 * This matters more than it looks. Handing back Yahoo's spelling would file
 * RELIANCE.NS observations separately from RELIANCE - the exact bug that
 * canonicalisation exists to prevent - while stripping `.BO` would instead
 * merge BSE prices into the NSE series and then report the result as a source
 * conflict with itself. One canonical key on both sides keeps the log and the
 * watchlist addressing the same instrument.
 */
function callerSymbol(symbol) {
  return canonicalizeSymbol(symbol);
}

async function fetchChart(params) {
  // encodeURIComponent matters for the benchmark: a raw `^` in a URL path is
  // not something to rely on a server tolerating.
  const url = `${BASE_URL}/${encodeURIComponent(params.symbol)}?${params.query}`;

  let response;
  try {
    response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    // Network failure and timeout both land here. Rethrow as one recognisable
    // shape so the ingestion loop does not need to know about AbortError.
    throw new Error(`yahoo: request failed for ${params.symbol}: ${cause.message}`, { cause });
  }

  if (!response.ok) {
    throw new Error(`yahoo: HTTP ${response.status} for ${params.symbol}`);
  }

  const body = await response.json();

  if (body?.chart?.error) {
    throw new Error(`yahoo: ${body.chart.error.description ?? 'unknown API error'}`);
  }

  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`yahoo: empty result for ${params.symbol}`);

  return result;
}

async function fetchSearch(query) {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=25&newsCount=0`;
  let response;
  try {
    response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new Error(`yahoo: search failed: ${cause.message}`, { cause });
  }

  if (!response.ok) throw new Error(`yahoo: search HTTP ${response.status}`);
  const body = await response.json();
  return body?.quotes ?? [];
}

/**
 * Interval and window sizing.
 *
 * Yahoo only serves 1-minute candles for roughly the last week, so the
 * interval has to be chosen from how far back the question reaches. The window
 * is snapped to a fixed boundary on purpose: a backfill asking about 400
 * consecutive instants then produces the same handful of cache keys instead of
 * 400 distinct ones.
 */
function windowFor(timestamp) {
  const ageMs = Date.now() - timestamp;
  const DAY = 86_400_000;

  if (ageMs < 6 * DAY) return { interval: '1m', intervalMs: 60_000, alignMs: DAY, padMs: DAY };
  if (ageMs < 55 * DAY)
    return { interval: '15m', intervalMs: 900_000, alignMs: 7 * DAY, padMs: 7 * DAY };
  return { interval: '1d', intervalMs: DAY, alignMs: 30 * DAY, padMs: 30 * DAY };
}

/**
 * Cache of parsed candle windows. Without it, backfilling N historical instants
 * would mean N HTTP calls to an unofficial endpoint - rude, slow, and a good
 * way to get rate-limited. With it, a whole backfill is a few requests.
 */
const windowCache = new Map();
const WINDOW_TTL_MS = 5 * 60_000;

async function loadCandleWindow(symbol, timestamp) {
  const { interval, intervalMs, alignMs, padMs } = windowFor(timestamp);
  const anchor = Math.floor(timestamp / alignMs) * alignMs;
  const key = `${symbol}|${interval}|${anchor}`;

  const cached = windowCache.get(key);
  if (cached && Date.now() - cached.loadedAt < WINDOW_TTL_MS) return cached;

  const period1 = Math.floor((anchor - padMs) / 1000);
  const period2 = Math.floor((anchor + alignMs + padMs) / 1000);
  const result = await fetchChart({
    symbol,
    query: `interval=${interval}&period1=${period1}&period2=${period2}`,
  });

  const stamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};

  // Yahoo pads its arrays with nulls for instants that had no trade. Those are
  // not zero-price moments, they are absent ones, so they are dropped here
  // rather than carried forward as data.
  const candles = [];
  for (let i = 0; i < stamps.length; i += 1) {
    const close = quote.close?.[i];
    if (typeof close !== 'number') continue;
    candles.push({
      timestamp: stamps[i] * 1000,
      price: close,
      volume: typeof quote.volume?.[i] === 'number' ? quote.volume[i] : 0,
    });
  }

  const window = { candles, intervalMs, loadedAt: Date.now() };
  windowCache.set(key, window);
  return window;
}

/**
 * A curated suggestion list. Yahoo has no free "list the NSE" endpoint, so this
 * is a hand-picked set of liquid large caps for the UI's suggestions - it is
 * not a limit on what can be looked up. It intentionally mirrors the
 * simulator's featured names so switching sources does not change the UI.
 */
const FEATURED = [
  { symbol: 'RELIANCE', name: 'Reliance Industries' },
  { symbol: 'TCS', name: 'Tata Consultancy Services' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank' },
  { symbol: 'INFY', name: 'Infosys' },
  { symbol: 'ITC', name: 'ITC' },
  { symbol: 'SBIN', name: 'State Bank of India' },
  { symbol: 'TATAMOTORS', name: 'Tata Motors' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel' },
  { symbol: 'LT', name: 'Larsen & Toubro' },
  { symbol: 'ZOMATO', name: 'Eternal (Zomato)' },
];

export const yahoo = {
  name: 'yahoo',

  describe() {
    return {
      name: 'yahoo',
      kind: 'real',
      /** Real exchange hours apply, so freshness must consult the calendar. */
      alwaysOpen: false,
      /** Nominal delay, stated so the UI can say it out loud. */
      delayMs: 20 * 60_000,
      endpoint: `${BASE_URL}/{symbol}.NS`,
      note: 'Unofficial endpoint. Quotes typically delayed 15-20 minutes.',
      /** The benchmark this source can serve, for the ingestor to poll. */
      benchmarkSymbol: BENCHMARK_SYMBOL,
    };
  },

  getSymbols() {
    return FEATURED;
  },

  async searchSymbols(query) {
    const quotes = await fetchSearch(query);
    const seen = new Set();
    const results = [];

    for (const quote of quotes) {
      if (!['EQUITY', 'ETF', 'MUTUALFUND'].includes(quote.quoteType)) continue;
      const symbol = canonicalSearchSymbol(quote.symbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      results.push({
        symbol,
        name: quote.longname ?? quote.shortname ?? symbol,
        exchange: quote.fullExchangeName ?? quote.exchange ?? 'Market unavailable',
        market: quote.exchange ?? null,
      });
    }

    return results;
  },

  /**
   * The latest quote Yahoo will admit to. Note the two-tier volume read: a
   * 1-minute candle's volume is comparable to the simulator's per-tick volume,
   * whereas meta.regularMarketVolume is cumulative for the day. Mixing those
   * silently would corrupt any volume comparison, so falling back to the
   * cumulative figure also lowers confidence.
   */
  async getLatestSnapshot(symbol) {
    const yahooSymbol = toYahooSymbol(symbol);
    const result = await fetchChart({ symbol: yahooSymbol, query: 'interval=1m&range=1d' });

    const meta = result.meta ?? {};
    const price = meta.regularMarketPrice;
    if (typeof price !== 'number') return null;

    const stamps = result.timestamp ?? [];
    const volumes = result.indicators?.quote?.[0]?.volume ?? [];
    let volume = null;
    for (let i = stamps.length - 1; i >= 0; i -= 1) {
      if (typeof volumes[i] === 'number' && volumes[i] > 0) {
        volume = volumes[i];
        break;
      }
    }

    const usedCumulativeVolume = volume === null;
    if (usedCumulativeVolume) volume = meta.regularMarketVolume ?? 0;

    return {
      symbol: callerSymbol(symbol),
      /**
       * Yahoo's own attribution of when this price held - not Date.now(). The
       * gap between the two IS the delay, and preserving it is what lets the
       * app report freshness truthfully instead of restamping stale data.
       */
      timestamp: (meta.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
      price: Math.round(price * 100) / 100,
      volume: Math.max(0, Math.round(volume)),
      source: 'yahoo',
      confidence: usedCumulativeVolume
        ? Math.round(CONFIDENCE.LATEST * DISTANCE_PENALTY * 100) / 100
        : CONFIDENCE.LATEST,
    };
  },

  /**
   * The price at an arbitrary past instant: the nearest candle at or before it.
   * Looking backwards is the honest direction - a candle after the instant
   * asked about is information that did not exist yet - so a forward match is
   * used only as a last resort and says so through a lower confidence.
   */
  async getSnapshotAt(symbol, timestamp) {
    const yahooSymbol = toYahooSymbol(symbol);
    const { candles, intervalMs } = await loadCandleWindow(yahooSymbol, timestamp);
    if (candles.length === 0) return null;

    let match = null;
    for (const candle of candles) {
      if (candle.timestamp <= timestamp) match = candle;
      else break;
    }

    const lookedForward = match === null;
    if (lookedForward) match = candles[0];

    const distance = Math.abs(match.timestamp - timestamp);
    let confidence = CONFIDENCE.HISTORICAL;
    if (lookedForward) confidence = CONFIDENCE.LATEST;
    if (distance > 2 * intervalMs) confidence *= DISTANCE_PENALTY;

    return {
      symbol: callerSymbol(symbol),
      timestamp: match.timestamp,
      price: Math.round(match.price * 100) / 100,
      volume: Math.max(0, Math.round(match.volume)),
      source: 'yahoo',
      confidence: Math.round(confidence * 100) / 100,
    };
  },
};

export const __testing = { windowFor, callerSymbol, windowCache, canonicalSearchSymbol };
