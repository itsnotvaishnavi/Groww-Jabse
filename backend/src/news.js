/**
 * Optional supporting news context.
 *
 * News is deliberately outside the market-data and meaningful-change engine.
 * A provider failure is represented to the caller and never changes scores,
 * snapshots, alerts, or watchlist state.
 */
import { toYahooSymbol } from './sources/yahoo.js';
import { canonicalizeSymbol } from './symbols.js';

const SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
const REQUEST_TIMEOUT_MS = 8_000;
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'application/json',
};

const QUALITY_PUBLISHERS = /reuters|bloomberg|business standard|economic times|moneycontrol|cnbc|livemint|financial times|company newsroom|press release/i;
const EVENT_LANGUAGE = /announc|earnings|quarter|contract|order|partnership|acqui|appoint|invest|launch|regulat|deal|agreement|revenue|profit/i;

function wordBoundary(text, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function aliasesFor(symbol, company) {
  const aliases = new Set([symbol, symbol.replace(/\.(NS|BO|US)$/i, ''), company]);
  if (company) aliases.add(`${company} Limited`);
  return [...aliases].filter((alias) => alias && alias.length >= 4);
}

function scoreArticle(article, { symbol, company, yahooSymbol }) {
  const title = String(article.title ?? '');
  const body = String(article.description ?? article.summary ?? article.content ?? '');
  const publisher = String(article.publisher ?? '');
  const link = String(article.link ?? '');
  const aliases = aliasesFor(symbol, company);
  const related = (article.relatedTickers ?? []).map(String).map((value) => value.toUpperCase());
  let score = 0;
  const matchedBy = [];

  const providerAssociation =
    related.includes(String(yahooSymbol).toUpperCase()) || related.includes(symbol.toUpperCase());
  if (providerAssociation) {
    score += 6;
    matchedBy.push('provider_symbol');
  }

  const titleAlias = aliases.find((alias) => wordBoundary(title, alias));
  if (titleAlias) {
    score += titleAlias.length >= 8 ? 8 : 5;
    matchedBy.push('title_company');
  }

  // A short ticker such as TCS is safe only when the provider independently
  // associates the article with that exact security. Association alone is not
  // enough: Yahoo also attaches tickers to broad ADR/sector roundups.
  const ticker = symbol.replace(/\.(NS|BO|US)$/i, '');
  if (providerAssociation && ticker.length >= 3 && wordBoundary(title, ticker)) {
    score += 5;
    matchedBy.push('title_symbol');
  }

  const bodyAlias = aliases.find((alias) => wordBoundary(body, alias));
  if (bodyAlias) {
    score += 4;
    matchedBy.push('body_company');
  }

  const directCompanyEvidence = Boolean(titleAlias || bodyAlias || matchedBy.includes('title_symbol'));
  if (directCompanyEvidence && (QUALITY_PUBLISHERS.test(publisher) || /\.gov\.|\.nseindia\.|\.bseindia\./i.test(link))) {
    score += 3;
    matchedBy.push('trusted_source');
  }
  if (score > 0 && EVENT_LANGUAGE.test(title)) score += 1;

  return { score, matchedBy };
}

export function relevanceForArticle(article, context) {
  return scoreArticle(article, context);
}

export function createNewsService({ fetcher = fetch, clock = () => Date.now(), source = null } = {}) {
  function companyFor(symbol) {
    return source?.getSymbols?.().find((entry) => entry.symbol === symbol || entry.symbol === symbol?.replace(/\.US$/, ''))?.name ?? null;
  }

  async function latest({ symbol = null, company = companyFor(symbol), limit = 8 } = {}) {
    const query = symbol ? company ?? toYahooSymbol(symbol) : 'Indian stock market';
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
    const rawNews = (body?.news ?? [])
      .filter(
        (item) =>
          typeof item?.title === 'string' &&
          item.title.trim() &&
          typeof item?.providerPublishTime === 'number',
      );
    const scored = symbol
      ? rawNews.map((item) => ({ item, relevance: scoreArticle(item, { symbol, company, yahooSymbol: toYahooSymbol(symbol) }) }))
      : rawNews.map((item) => ({ item, relevance: { score: 0, matchedBy: [] } }));
    const items = scored
      .filter(({ relevance }) => !symbol || relevance.score >= 8)
      .sort((a, b) => b.relevance.score - a.relevance.score || b.item.providerPublishTime - a.item.providerPublishTime)
      .slice(0, Math.min(limit, 6))
      .map(({ item, relevance }) => ({
        source: item.publisher ?? 'Unknown source',
        headline: item.title,
        publishedAt: item.providerPublishTime * 1000,
        url: typeof item.link === 'string' ? item.link : null,
        associatedSymbol: symbol,
        relevance: relevance.score,
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
