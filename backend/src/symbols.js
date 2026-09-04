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
const TICKER = /^[A-Z0-9&\-]{1,18}(\.(NS|BO))?$/;

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
      `"${input}" is not a valid ticker. Use letters, digits, & or -, optionally with a .NS/.BO suffix.`,
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
 * The venue a canonical key trades on. Useful for explaining to a user why
 * RELIANCE and RELIANCE.BO are two rows rather than one.
 */
export function venueOf(canonicalSymbol) {
  return canonicalSymbol.endsWith('.BO') ? 'BSE' : 'NSE';
}
