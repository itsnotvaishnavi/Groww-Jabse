/**
 * Watchlist discovery built on the existing engine.
 *
 * Candidates are evaluated by a read-only engine view containing the current
 * watchlist plus source-known symbols. The production watchlist and engine are
 * never mutated, and no discovery-specific score is introduced.
 */
import { createEngine } from './engine/index.js';
import { config } from './config.js';

const ACTIVITY_REASONS = new Set([
  'unusual_price_movement',
  'high_volume',
  'market_outperformance',
  'market_underperformance',
  'moved_with_market',
  'sector_outperformance',
  'sector_underperformance',
]);

export function createDiscoveryService({
  engine,
  snapshotLog,
  watchlist,
  source,
  clock = () => Date.now(),
}) {
  const candidates = new Set();
  const candidateWatchlist = {
    list(userId) {
      return [
        ...watchlist.list(userId),
        ...[...candidates].map((symbol) => ({
          symbol,
          addedAt: 0,
          lastViewedAt: null,
        })),
      ];
    },
  };

  // This is a second engine instance, not a second scoring implementation. It
  // calls the same feature, score, freshness, and reason functions as the main
  // watchlist engine, but never receives a writable watchlist or surfaced store.
  const candidateEngine = createEngine({
    snapshotLog,
    watchlist: candidateWatchlist,
    surfacedStore: null,
    source,
  });

  function interestFor(symbol, entries) {
    const sector = config.sectorMap[symbol] ?? null;
    const followedSectors = new Set(
      entries.map((entry) => config.sectorMap[entry.symbol]).filter(Boolean),
    );
    const openedSectors = new Set(
      entries
        .filter((entry) => entry.lastViewedAt != null)
        .map((entry) => config.sectorMap[entry.symbol])
        .filter(Boolean),
    );

    if (sector && followedSectors.has(sector)) {
      return { relevance: 2, text: `Similar to ${sector} stocks you already follow.` };
    }
    if (sector && openedSectors.has(sector)) {
      return { relevance: 1, text: `Related to ${sector} stocks you have opened.` };
    }
    return null;
  }

  function activityFor(item) {
    const reasons = item.reasonText.filter((_, index) => ACTIVITY_REASONS.has(item.reasons[index]));
    const fallback = item.features?.priceAnomaly?.available
      ? 'Unusual movement for this stock.'
      : null;
    return reasons[0] ?? fallback;
  }

  function build({ userId = config.devUserId, now = clock(), limit = 4 } = {}) {
    const entries = watchlist.list(userId);
    const watched = new Set(entries.map((entry) => entry.symbol));
    const universe = source.getSymbols();

    candidates.clear();
    for (const entry of universe) {
      if (entry?.symbol && !watched.has(entry.symbol)) candidates.add(entry.symbol);
    }

    const evaluation = candidateEngine.evaluate({ userId, now });
    const bySymbol = new Map(evaluation.items.map((item) => [item.symbol, item]));
    const suggestions = [];

    for (const entry of universe) {
      if (!entry?.symbol || watched.has(entry.symbol)) continue;
      const item = bySymbol.get(entry.symbol);
      const interest = interestFor(entry.symbol, entries);
      const activity = item ? activityFor(item) : null;

      // A suggestion must be both relevant to the user's watchlist and have a
      // current engine attention verdict. Missing, stale, or closed data stays
      // out rather than being filled with arbitrary movers.
      if (
        !item ||
        !interest ||
        !item.needsAttention ||
        !['live', 'delayed'].includes(item.freshness.state) ||
        !activity
      ) {
        continue;
      }

      const priceSignal = item.features.priceAnomaly;
      const currentMove = priceSignal.available ? priceSignal.returnPct : null;
      suggestions.push({
        symbol: item.symbol,
        name: entry.name ?? item.symbol,
        exchange: entry.exchange ?? (item.symbol.endsWith('.BO') ? 'BSE' : 'NSE'),
        sector: item.sector,
        currentMove,
        why: `${interest.text} ${activity}`,
        activity,
        freshness: item.freshness,
        level: item.level,
        relevance: interest.relevance,
        meaningfulness: item.meaningfulScore,
      });
    }

    suggestions.sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.meaningfulness - a.meaningfulness ||
        a.symbol.localeCompare(b.symbol),
    );

    return {
      generatedAt: now,
      suggestions: suggestions.slice(0, limit),
    };
  }

  return { build };
}
