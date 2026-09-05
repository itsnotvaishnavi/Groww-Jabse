/**
 * Optional explanation layer.
 *
 * The deterministic engine remains the only authority for scores, levels,
 * confidence, ranking, alerts, and baselines. This module receives a compact
 * evidence object and can only add presentation text around that verdict.
 */

const CAUSAL_LANGUAGE = /\b(because|caused by|due to|resulted from|reason for)\b/i;

function symbolBase(symbol) {
  return symbol.replace(/\.(NS|BO|US)$/i, '').toLowerCase();
}

function companyTokens(company, symbol) {
  const values = `${company ?? ''} ${symbolBase(symbol)}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  return [...new Set(values)];
}

function relatedNewsFor({ symbol, company, newsItems = [] }) {
  // News service filtering has already required strong provider/company
  // evidence. Do not apply a second weaker substring filter here.
  return newsItems.filter((item) => item.associatedSymbol === symbol && item.relevance >= 8);
}

function changeEvidence(change) {
  if (!change?.available) return { available: false, reason: change?.reason ?? 'unavailable' };
  return {
    available: true,
    percent: change.percent,
    absolute: change.absolute,
    direction: change.absolute > 0 ? 'up' : change.absolute < 0 ? 'down' : 'flat',
  };
}

function signalEvidence(feature, fields) {
  if (!feature?.available) return { available: false, reason: feature?.reason ?? 'unavailable' };
  return Object.fromEntries(fields.map((field) => [field, feature[field]]));
}

function evidenceSummary(item) {
  const lines = (item.reasonText ?? [])
    .filter((line) => !/limited or delayed data|not enough observations/i.test(line))
    .slice(0, 2);
  return lines.length > 0
    ? lines
    : ['Jabse detected a meaningful movement, but the available signals do not identify a clear catalyst.'];
}

function isMeaningful(item) {
  // Contextual explanation is reserved for the engine's attention band. A
  // below-bar meaningful row keeps its deterministic reasons without adding
  // an AI affordance to every modest movement.
  return item.needsAttention === true;
}

export function buildExplanationEvidence({ item, company, relevantNews }) {
  const features = item.features ?? {};
  return {
    symbol: item.symbol,
    company: company ?? item.symbol,
    direction: item.changeSinceViewed?.available
      ? item.changeSinceViewed.absolute > 0
        ? 'up'
        : item.changeSinceViewed.absolute < 0
          ? 'down'
          : 'flat'
      : 'unknown',
    sinceLastViewedChange: changeEvidence(item.changeSinceViewed),
    priceSignal: signalEvidence(features.priceAnomaly, ['z', 'returnPct', 'horizonMs']),
    volumeSignal: signalEvidence(features.volumeAnomaly, ['ratio']),
    marketRelativeSignal: signalEvidence(features.marketRelative, [
      'excessPct',
      'symbolReturnPct',
      'benchmarkReturnPct',
      'benchmarkSymbol',
    ]),
    sectorRelativeSignal: signalEvidence(features.sectorRelative, [
      'excessPct',
      'symbolReturnPct',
      'sectorReturnPct',
      'sector',
      'peers',
    ]),
    confidence: item.confidence,
    freshness: {
      state: item.freshness?.state,
      label: item.freshness?.label,
    },
    evidenceSummary: evidenceSummary(item),
    relevantNews: relevantNews.map((news) => ({
      source: news.source,
      headline: news.headline,
      publishedAt: news.publishedAt,
      url: news.url,
    })),
  };
}

function parseProviderResult(result) {
  const value = typeof result === 'string' ? JSON.parse(result) : result;
  if (!value || typeof value.summary !== 'string' || value.summary.trim() === '') {
    throw new Error('AI provider returned no summary');
  }
  return {
    summary: value.summary.trim(),
    confidence: ['High', 'Medium', 'Low'].includes(value.confidence) ? value.confidence : 'Low',
    catalystConfirmed: value.catalystConfirmed === true,
  };
}

export function createExplanationService({
  engine,
  source,
  newsService,
  provider = null,
  clock = () => Date.now(),
}) {
  function companyFor(symbol) {
    return source
      .getSymbols()
      .find((entry) => entry.symbol === symbol || entry.symbol === symbol.replace(/\.US$/, ''))?.name ?? symbol;
  }

  async function explain({ userId, symbol, now = clock() }) {
    const evaluation = engine.evaluate({ userId, now });
    const item = evaluation.items.find((candidate) => candidate.symbol === symbol);
    if (!item) throw new Error('symbol is not on the watchlist');

    const company = companyFor(symbol);
    if (!isMeaningful(item)) {
      return {
        available: false,
        reason: 'not_meaningful',
        generatedAt: now,
        evidence: buildExplanationEvidence({ item, company, relevantNews: [] }),
      };
    }

    let newsItems = [];
    try {
      newsItems = (await newsService.latest({ symbol, limit: 8 })).items ?? [];
    } catch {
      // News is supporting context. Its failure leaves the evidence path usable.
    }

    const relevantNews = relatedNewsFor({ symbol, company, newsItems });
    const evidence = buildExplanationEvidence({ item, company, relevantNews });
    const majorNews = relevantNews.length > 0 &&
      (Math.abs(item.changeSinceViewed?.percent ?? 0) >= 2 || item.needsAttention === true);

    if (!majorNews) {
      return {
        available: false,
        reason: 'no_major_news',
        generatedAt: now,
        fallbackSummary: evidence.evidenceSummary,
        evidence,
      };
    }

    if (!provider) {
      return {
        available: false,
        reason: 'AI explanation unavailable',
        generatedAt: now,
        fallbackSummary: null,
        evidence,
      };
    }

    try {
      const generated = parseProviderResult(await provider(evidence));
      if (CAUSAL_LANGUAGE.test(generated.summary) && relevantNews.length === 0) {
        throw new Error('AI returned an unsupported causal claim');
      }
      return {
        available: true,
        generatedAt: now,
        fallbackSummary: null,
        evidence,
        ...generated,
      };
    } catch {
      return {
        available: false,
        reason: 'AI explanation unavailable',
        generatedAt: now,
        evidence,
      };
    }
  }

  return { explain };
}

export function createOpenAiCompatibleProvider({
  apiKey,
  endpoint = 'https://api.openai.com/v1/chat/completions',
  model = 'gpt-4o-mini',
  fetcher = fetch,
}) {
  if (!apiKey) return null;

  return async (evidence) => {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You explain observed stock movement, never decide attention. Return JSON with summary, confidence (High/Medium/Low), and catalystConfirmed (boolean). Only call a catalyst confirmed when the supplied news headline directly supports it. Otherwise say: No confirmed catalyst was identified from the available data. Separate observed facts, reported news, and inference. Never give investment advice.',
          },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    return parseProviderResult(content);
  };
}
