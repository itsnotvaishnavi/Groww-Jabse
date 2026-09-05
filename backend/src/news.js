/**
 * Optional supporting news context.
 *
 * News is deliberately outside the market-data and meaningful-change engine.
 * A provider failure is represented to the caller and never changes scores,
 * snapshots, alerts, or watchlist state.
 */
import { toYahooSymbol } from './sources/yahoo.js';

const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const REQUEST_TIMEOUT_MS = 8_000;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
};

export function createNewsService({ fetcher = fetch, clock = () => Date.now() } = {}) {
  async function latest({ symbol = null, limit = 8 } = {}) {
    const query = symbol ? toYahooSymbol(symbol) : 'Indian stock market';
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=${limit}`;

    let response;
    try {
      response = await fetcher(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new Error(`news provider unavailable: ${cause.message}`, { cause });
    }

    if (!response.ok) throw new Error(`news provider returned HTTP ${response.status}`);
    const body = await response.json();
    const items = (body?.news ?? [])
      .filter(
        (item) =>
          typeof item?.title === 'string' &&
          item.title.trim() &&
          typeof item?.providerPublishTime === 'number',
      )
      .map((item) => ({
        source: item.publisher ?? 'Unknown source',
        headline: item.title,
        publishedAt: item.providerPublishTime * 1000,
        url: typeof item.link === 'string' ? item.link : null,
        associatedSymbol: symbol,
      }));

    return {
      provider: 'Yahoo Finance search news',
      fetchedAt: clock(),
      symbol,
      items,
    };
  }

  return { latest };
}
