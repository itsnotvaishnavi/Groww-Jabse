import test from 'node:test';
import assert from 'node:assert/strict';

const { createExplanationService } = await import('../src/explanation.js');

function makeItem(overrides = {}) {
  return {
    symbol: 'TCS',
    meaningfulScore: 0.72,
    level: 'HIGH',
    needsAttention: true,
    confidence: 0.81,
    freshness: { state: 'live', label: 'Live' },
    changeSinceViewed: { available: true, percent: -4.2, absolute: -180 },
    features: {
      priceAnomaly: { available: true, z: -3.4, returnPct: -4.2, horizonMs: 900000 },
      volumeAnomaly: { available: true, ratio: 2.3 },
      marketRelative: {
        available: true,
        excessPct: -2.8,
        symbolReturnPct: -4.2,
        benchmarkReturnPct: -1.4,
        benchmarkSymbol: 'NIFTY',
      },
      sectorRelative: {
        available: true,
        excessPct: -1.7,
        symbolReturnPct: -4.2,
        sectorReturnPct: -2.5,
        sector: 'IT',
        peers: ['INFY'],
      },
    },
    ...overrides,
  };
}

function createHarness({ item = makeItem(), news = [], provider = null, newsFails = false } = {}) {
  return {
    item,
    service: createExplanationService({
      engine: { evaluate: () => ({ items: [item] }) },
      source: { getSymbols: () => [{ symbol: 'TCS', name: 'Tata Consultancy Services' }] },
      newsService: {
        latest: async () => {
          if (newsFails) throw new Error('offline');
          return { items: news };
        },
      },
      provider,
      clock: () => 1_800_000_000_000,
    }),
  };
}

const related = {
  source: 'Example Wire',
  headline: 'TCS shares slide as Tata Consultancy Services faces a reported slowdown',
  publishedAt: 1_799_999_000_000,
  url: 'https://example.test/tcs',
  associatedSymbol: 'TCS',
  relevance: 10,
};

const unrelated = {
  source: 'Example Wire',
  headline: 'Oil prices rise as global inventories tighten',
  publishedAt: 1_799_999_000_000,
  url: 'https://example.test/oil',
  associatedSymbol: 'TCS',
};

test('ordinary movement does not invoke contextual AI', async () => {
  let called = false;
  const { service } = createHarness({
    item: makeItem({
      meaningfulScore: 0.12,
      level: 'LOW',
      needsAttention: false,
      attentionGroup: 'meaningful',
      changeSinceViewed: { available: true, percent: 0.4, absolute: 4 },
    }),
    provider: async () => {
      called = true;
      return { summary: 'Should not be used.', confidence: 'Low' };
    },
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.equal(result.reason, 'not_meaningful');
  assert.equal(called, false);
});

test('explanation includes only reliably related news and structured evidence', async () => {
  let received;
  const { service } = createHarness({
    news: [related, unrelated],
    provider: async (evidence) => {
      received = evidence;
      return { summary: 'The available evidence suggests a stock-specific move.', confidence: 'Medium' };
    },
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.equal(result.available, true);
  assert.equal(result.evidence.relevantNews.length, 1);
  assert.equal(received.priceSignal.z, -3.4);
  assert.equal(received.volumeSignal.ratio, 2.3);
  assert.equal(received.marketRelativeSignal.excessPct, -2.8);
  assert.equal(received.sectorRelativeSignal.excessPct, -1.7);
});

test('no relevant news produces an explicit no-catalyst explanation', async () => {
  const { service } = createHarness({
    news: [unrelated],
    provider: async () => assert.fail('AI should not run without major relevant news'),
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_major_news');
  assert.equal(result.evidence.relevantNews.length, 0);
  assert.ok(result.fallbackSummary.length <= 2);
});

test('conflicting evidence can be described without changing the engine verdict', async () => {
  const item = makeItem({
    features: {
      ...makeItem().features,
      marketRelative: { ...makeItem().features.marketRelative, excessPct: 1.2 },
      sectorRelative: { ...makeItem().features.sectorRelative, excessPct: -1.7 },
    },
  });
  const before = { score: item.meaningfulScore, level: item.level, attention: item.needsAttention };
  const { service } = createHarness({
    item,
    news: [related],
    provider: async () => ({
      summary: 'Signals conflict: the stock underperformed its sector while outperforming the market.',
      confidence: 'Low',
      catalystConfirmed: false,
    }),
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.match(result.summary, /Signals conflict/);
  assert.deepEqual(
    { score: item.meaningfulScore, level: item.level, attention: item.needsAttention },
    before,
  );
});

test('AI provider failure is isolated and exposes no fabricated fallback', async () => {
  const { service } = createHarness({
    news: [related],
    provider: async () => {
      throw new Error('provider offline');
    },
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'AI explanation unavailable');
  assert.equal(result.summary, undefined);
  assert.equal(result.evidence.relevantNews.length, 1);
});

test('news failure still leaves the deterministic evidence available', async () => {
  const { service } = createHarness({
    newsFails: true,
    provider: async () => assert.fail('AI should not run when news is unavailable'),
  });

  const result = await service.explain({ userId: 'u1', symbol: 'TCS' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'no_major_news');
  assert.equal(result.evidence.relevantNews.length, 0);
  assert.equal(result.evidence.sinceLastViewedChange.percent, -4.2);
});
