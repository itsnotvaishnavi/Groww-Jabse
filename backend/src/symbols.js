/**
 * Symbol identity: the single definition of "which instrument is this".
 *
 * THE BUG THIS FIXES
 * Previously `RELIANCE` and `reliance.ns` filed as two different keys in the
 * snapshot log. They are the same instrument on the same exchange, so a
 * watchlist entry under one would never match observations under the other -
 * the row would sit at "no data" forever while its prices piled up under the
 * other spelling.
 *
 * THE RULE
 *   NSE is the default venue and carries no suffix.
 *     RELIANCE, reliance, RELIANCE.NS, reliance.ns  ->  RELIANCE
 *   BSE is a genuinely different venue that trades at a genuinely different
 *   price, so its suffix is preserved and it stays a separate instrument.
 *     RELIANCE.BO, reliance.bo                      ->  RELIANCE.BO
 *
 * Canonicalisation is applied at the boundaries - watchlist writes and
 * snapshot writes - so the database only ever contains canonical keys and no
 * reader has to remember to normalise.
 */

/** Marks the errors that are the caller's fault, so the API layer can map
 *  them to 400 instead of letting everything become a 500. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * The benchmark's canonical key.
 *
 * One internal name, and each source maps it to whatever it calls the thing:
 * Yahoo serves NIFTY 50 as `^NSEI`, the simulator generates it as its shared
 * market series. That mapping belongs to the source adapters, exactly like
 * every other wire detail, so nothing above them has to know.
 */
export const BENCHMARK_SYMBOL = 'NIFTY';

/** Spellings of the benchmark that all mean the same index. */
const BENCHMARK_ALIASES = new Set(['NIFTY', 'NIFTY50', '^NSEI', 'NSEI', 'MARKET']);

/** Letters, digits, & and - (M&M, BAJAJ-AUTO), optionally a venue suffix. */
const TICKER = /^[A-Z0-9&\-]{1,18}(\.(NS|BO|US))?$/;

/**
 * Canonicalise a user- or source-supplied symbol.
 *
 * @throws {ValidationError} when the input could not be a ticker at all.
 */
export function canonicalizeSymbol(input) {
  if (typeof input !== 'string') {
    throw new TypeError('symbol must be a string');
  }

  const upper = input.trim().toUpperCase();

  // Benchmark aliases resolve first: `^NSEI` would never pass the ticker
  // pattern, and it should not have to.
  if (BENCHMARK_ALIASES.has(upper)) return BENCHMARK_SYMBOL;

  if (!TICKER.test(upper)) {
    throw new ValidationError(
      `"${input}" is not a valid ticker. Use letters, digits, & or -, optionally with a .NS/.BO/.US suffix.`,
    );
  }

  // NSE is implied, so its suffix is redundant and gets dropped. BSE's is not.
  return upper.endsWith('.NS') ? upper.slice(0, -3) : upper;
}

/** True when this canonical key is the benchmark rather than a user holding. */
export function isBenchmark(symbol) {
  return canonicalizeSymbol(symbol) === BENCHMARK_SYMBOL;
}

/**
 * Resolve what a person typed into one instrument.
 *
 * "TCS", "tcs" and "Tata Consultancy" all mean the same company, and a search
 * box that only accepts the first is a search box that assumes the user has
 * memorised tickers.
 *
 * @param universe [{ symbol, name }] from the active source. The names live in
 *        the source rather than here because they are the source's facts -
 *        this function is given them so it can stay pure and testable.
 *
 * The order is deliberate, and each step exists for a reason:
 *
 *   1. A TICKER THE SOURCE KNOWS wins outright. If someone types a ticker they
 *      mean that instrument, even when another company's NAME contains the
 *      same letters.
 *   2. An EXACT NAME, case-insensitively. "itc" is both a ticker and a name and
 *      resolves the same way either route, which is the point.
 *   3. A UNIQUE SUBSTRING of one name. Simple `includes`, not fuzzy matching:
 *      no library, no scoring, no surprises about why one result beat another.
 *   4. AMBIGUITY IS REPORTED, NOT GUESSED. "tata" is Tata Consultancy and Tata
 *      Motors, and silently picking one would put the wrong stock on someone's
 *      watchlist. The candidates come back so the caller can ask.
 *   5. Anything still ticker-SHAPED passes through unresolved, which preserves
 *      the existing ability to watch an instrument the source has not listed
 *      (Yahoo knows thousands; `getSymbols` returns a handful).
 */
export function resolveSymbolQuery(input, universe = []) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ValidationError('Type a ticker or a company name.');
  }

  const query = input.trim();
  const folded = query.toLowerCase();

  const byTicker = universe.find((entry) => entry.symbol.toLowerCase() === folded);
  if (byTicker) return { symbol: byTicker.symbol, name: byTicker.name, matchedOn: 'symbol' };

  const byName = universe.filter((entry) => (entry.name ?? '').toLowerCase() === folded);
  if (byName.length === 1) {
    return { symbol: byName[0].symbol, name: byName[0].name, matchedOn: 'name' };
  }

  const partial = universe.filter((entry) => (entry.name ?? '').toLowerCase().includes(folded));
  if (partial.length === 1) {
    return { symbol: partial[0].symbol, name: partial[0].name, matchedOn: 'name' };
  }
  if (partial.length > 1) {
    throw new ValidationError(
      `"${query}" matches ${partial.length} companies: ${partial
        .map((entry) => `${entry.symbol} (${entry.name})`)
        .join(', ')}. Type the ticker to pick one.`,
    );
  }

  /**
   * Not in the universe. If it could be a ticker, let it through - and let
   * canonicalizeSymbol be the one to reject it if it could not, so there is
   * still exactly one place that decides what a ticker looks like.
   */
  return { symbol: canonicalizeSymbol(query), name: null, matchedOn: 'ticker' };
}

/**
 * The venue a canonical key trades on. Useful for explaining to a user why
 * RELIANCE and RELIANCE.BO are two rows rather than one.
 */
export function venueOf(canonicalSymbol) {
  if (canonicalSymbol.endsWith('.BO')) return 'BSE';
  if (canonicalSymbol.endsWith('.US')) return 'US';
  return 'NSE';
}
