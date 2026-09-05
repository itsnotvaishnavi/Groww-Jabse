import test from 'node:test';
import assert from 'node:assert/strict';

const { createNewsService, relevanceForArticle } = await import('../src/news.js');
const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { createEngine } = await import('../src/engine/index.js');

const response = (body, ok = true, status = 200) => ({
  ok,
  status,
  async json() {
    return body;
  },
});

test('news maps reliable provider fields without inventing content', async () => {
  const service = createNewsService({
    clock: () => 1_800_000_000_000,
    fetcher: async (url) => {
      assert.match(url, /Apple/);
      return response({
        news: [
          {
            title: 'Apple reports quarterly results',
            publisher: 'Example Wire',
            providerPublishTime: 1_799_999_000,
            link: 'https://example.test/story',
            relatedTickers: ['AAPL'],
          },
          { title: 'Missing timestamp is ignored', publisher: 'Example Wire' },
        ],
      });
    },
  });

  const result = await service.latest({ symbol: 'AAPL.US', company: 'Apple', limit: 6 });
  assert.equal(result.symbol, 'AAPL.US');
  assert.deepEqual(result.items, [
    {
      source: 'Example Wire',
      headline: 'Apple reports quarterly results',
      publishedAt: 1_799_999_000_000,
      url: 'https://example.test/story',
      associatedSymbol: 'AAPL.US',
      relevance: 12,
    },
  ]);
});

test('news provider failures are surfaced to the caller', async () => {
  const service = createNewsService({
    fetcher: async () => {
      throw new Error('offline');
    },
  });

  await assert.rejects(() => service.latest(), /news provider unavailable: offline/);
});

test('news has no path into meaningful-change evaluation', async () => {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);
  const engine = createEngine({
    snapshotLog,
    watchlist,
    surfacedStore,
    source: { describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }) },
    clock: () => 1_800_000_000_000,
  });
  const service = createNewsService({ fetcher: async () => response({ news: [] }) });

  const before = engine.evaluate({ userId: 'news-user', now: 1_800_000_000_000 });
  await service.latest();
  const after = engine.evaluate({ userId: 'news-user', now: 1_800_000_000_000 });

  assert.deepEqual(after, before);
});

const tcsContext = { symbol: 'TCS', company: 'Tata Consultancy Services', yahooSymbol: 'TCS.NS' };

test('TCS relevance accepts company mentions and provider symbol associations', () => {
  assert.ok(relevanceForArticle({ title: 'Tata Consultancy Services wins a new contract' }, tcsContext).score >= 8);
  assert.ok(relevanceForArticle({ title: 'TCS contract update', relatedTickers: ['TCS.NS'] }, tcsContext).score >= 8);
});

test('generic technology, pet, hotel, university, and billionaire articles are excluded', () => {
  const headlines = [
    'Attack Shark partners with Cloud9 in esports deal',
    'Dreama Pet launches a new care subscription',
    'Marriott expands its global hotel portfolio',
    'Thurgood Marshall College announces campus plans',
    'Billionaire wealth rises as markets rally',
    'AI software stocks lead technology shares higher',
  ];
  for (const title of headlines) {
    assert.equal(relevanceForArticle({ title }, tcsContext).score, 0, title);
  }

  assert.equal(
    relevanceForArticle(
      { title: 'Asian equities traded in the US as ADRs rise', relatedTickers: ['TCS.NS'] },
      tcsContext,
    ).score,
    6,
    'a broad provider basket association is not sufficient',
  );
});

test('a short ticker substring alone is not sufficient relevance', () => {
  assert.equal(relevanceForArticle({ title: 'Markets react to TCS trends' }, tcsContext).score, 0);
  assert.equal(relevanceForArticle({ title: 'Tata Consultancy Services reports results' }, tcsContext).score >= 8, true);
});

test('stock news endpoint filters and ranks instead of returning generic provider news', async () => {
  const service = createNewsService({
    fetcher: async () =>
      response({
        news: [
          { title: 'AI software stocks rally', publisher: 'Example', providerPublishTime: 100 },
          { title: 'Tata Consultancy Services wins a new contract', publisher: 'Business Standard', providerPublishTime: 90 },
          { title: 'Marriott expands hotels', publisher: 'Example', providerPublishTime: 110 },
        ],
      }),
  });
  const result = await service.latest({ symbol: 'TCS', company: 'Tata Consultancy Services' });
  assert.deepEqual(result.items.map((item) => item.headline), ['Tata Consultancy Services wins a new contract']);
});