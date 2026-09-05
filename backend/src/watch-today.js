/**
 * "What to Watch Today" — market-wide signal discovery.
 *
 * Distinct from "You might want to watch" (which is personalized to the user's
 * existing watchlist and opened sectors), this service evaluates the broader
 * market universe using the existing meaningful-change engine and surfaces up to
 * 3 candidates where multiple observable signals (price anomaly, unusual volume,
 * relative strength) confirm notable market activity.
 *
 * Strict invariants:
 *   - Purely observable market signals; never predictions, expected returns, or advice.
 *   - Reuses existing engine scoring and feature functions; zero duplicate math.
 *   - Appearing here does NOT set needsAttention = true on the user's watchlist.
 *   - Appearing here does NOT update last_viewed_at.
 *   - If no candidates cross the evidence bar, no arbitrary filler is shown.
 *   - Deterministic: same snapshot + same config => same candidates.
 */

import { createEngine } from './engine/index.js';
import { config } from './config.js';

function directionOf(returnPct) {
  if (returnPct == null || Math.abs(returnPct) < 0.05) return 'flat';
  return returnPct > 0 ? 'up' : 'down';
}

function describeSignal(item, activeSignals) {
  const f = item.features;
  const hasPrice = activeSignals.includes('price_anomaly');
  const hasVol = activeSignals.includes('volume_anomaly');
  const hasMkt = activeSignals.includes('market_relative');
  const hasSec = activeSignals.includes('sector_relative');

  if (hasPrice && hasVol && (hasMkt || hasSec)) {
    return 'Meaningful move · unusual volume · relative strength';
  }
  if (hasPrice && hasVol) {
    return 'Meaningful move · unusual volume';
  }
  if (hasPrice && hasMkt) {
    const direction = (f.marketRelative?.excessPct ?? 0) >= 0 ? 'Outperforming market' : 'Market divergence';
    return `${direction} · notable move`;
  }
  if (hasVol && hasMkt) {
    const direction = (f.marketRelative?.excessPct ?? 0) >= 0 ? 'Market outperformance' : 'Market divergence';
    return `${direction} · unusual volume`;
  }
  if (hasSec && hasMkt) {
    return 'Sector & market relative strength';
  }
  if (hasSec) {
    return 'Strong sector-relative movement';
  }
  if (hasMkt) {
    return (f.marketRelative?.excessPct ?? 0) >= 0 ? 'Outperforming market' : 'Market-relative movement';
  }
  if (hasVol) {
    return 'Unusual volume activity';
  }
  if (hasPrice) {
    return 'Notable price movement';
  }
  return 'Meaningful market signal';
}

export function createWatchTodayService({
  snapshotLog,
  source,
  newsService = null,
  clock = () => Date.now(),
}) {
  const candidateWatchlist = {
    list() {
      return (source.getSymbols?.() ?? []).map((entry) => ({
        symbol: entry.symbol,
        addedAt: 0,
        lastViewedAt: null,
      }));
    },
  };

  const candidateEngine = createEngine({
    snapshotLog,
    watchlist: candidateWatchlist,
    surfacedStore: null,
    source,
    clock,
  });

  async function build({ now = clock(), limit = 3 } = {}) {
    const universe = source.getSymbols?.() ?? [];
    if (universe.length === 0) {
      return {
        status: 'ok',
        marketState: 'stale',
        subtitle: 'Market signals unavailable',
        candidates: [],
        generatedAt: now,
      };
    }

    const evaluation = candidateEngine.evaluate({ userId: 'market-discovery', now });
    const bySymbol = new Map(evaluation.items.map((item) => [item.symbol, item]));

    const items = evaluation.items;
    const states = items.map((i) => i.freshness?.state).filter(Boolean);
    const staleCount = states.filter((s) => s === 'stale' || s === 'no_data').length;

    let marketState = 'live';
    let subtitle = 'Signals worth keeping an eye on';

    if (states.length > 0 && staleCount === states.length) {
      marketState = 'stale';
      subtitle = 'Market signals unavailable';
    } else if (states.some((s) => s === 'market_closed')) {
      marketState = 'market_closed';
      subtitle = 'Latest available signals';
    } else if (states.some((s) => s === 'delayed')) {
      marketState = 'delayed';
      subtitle = 'Signals may be delayed';
    }

    if (marketState === 'stale') {
      return {
        status: 'ok',
        marketState,
        subtitle,
        candidates: [],
        generatedAt: now,
      };
    }

    const qualified = [];

    for (const entry of universe) {
      const item = bySymbol.get(entry.symbol);
      if (!item || !item.latest) continue;

      if (!['live', 'delayed', 'market_closed'].includes(item.freshness?.state)) {
        continue;
      }

      if ((item.confidence ?? 0) < 0.35) {
        continue;
      }

      const f = item.features ?? {};

      const activeSignals = [];
      const hasPriceAnomaly = f.priceAnomaly?.available && Math.abs(f.priceAnomaly.z) >= 1.4;
      const hasVolumeAnomaly = f.volumeAnomaly?.available && f.volumeAnomaly.ratio >= 1.3;
      const hasMarketRelative = f.marketRelative?.available && Math.abs(f.marketRelative.excessPct) >= 0.75;
      const hasSectorRelative = f.sectorRelative?.available && Math.abs(f.sectorRelative.excessPct) >= 0.75;

      if (hasPriceAnomaly) activeSignals.push('price_anomaly');
      if (hasVolumeAnomaly) activeSignals.push('volume_anomaly');
      if (hasMarketRelative) activeSignals.push('market_relative');
      if (hasSectorRelative) activeSignals.push('sector_relative');

      const meaningful = (item.meaningfulScore ?? 0) >= 0.38;
      const multipleSignals = activeSignals.length >= 2;
      const isHighAttention = item.level === 'HIGH';

      if ((!multipleSignals && !isHighAttention) || !meaningful) {
        continue;
      }

      let hasNews = false;
      if (newsService) {
        try {
          const articles = await newsService.latest({ symbol: item.symbol, limit: 1 });
          hasNews = Array.isArray(articles?.articles) && articles.articles.length > 0;
        } catch {
          hasNews = false;
        }
      }

      const signalBonus = (activeSignals.length / 4) * 0.35;
      const rankScore = (item.meaningfulScore ?? 0) * 0.5 + signalBonus + (item.confidence ?? 0) * 0.15;
      const returnPct = f.priceAnomaly?.available ? f.priceAnomaly.returnPct : 0;

      qualified.push({
        symbol: item.symbol,
        name: entry.name ?? item.symbol,
        exchange: entry.exchange ?? (item.symbol.endsWith('.BO') ? 'BSE' : item.symbol.endsWith('.US') ? 'US' : 'NSE'),
        signal: describeSignal(item, activeSignals),
        direction: directionOf(returnPct),
        score: Math.round(rankScore * 100) / 100,
        confidence: Math.round((item.confidence ?? 0) * 100) / 100,
        freshness: item.freshness?.state ?? 'live',
        hasNews,
        signals: activeSignals,
        agreeingCount: activeSignals.length,
      });
    }

    qualified.sort(
      (a, b) =>
        b.score - a.score ||
        b.agreeingCount - a.agreeingCount ||
        b.confidence - a.confidence ||
        a.symbol.localeCompare(b.symbol),
    );

    return {
      status: 'ok',
      marketState,
      subtitle,
      candidates: qualified.slice(0, limit).map(({ agreeingCount, ...rest }) => rest),
      generatedAt: now,
    };
  }

  return { build };
}
