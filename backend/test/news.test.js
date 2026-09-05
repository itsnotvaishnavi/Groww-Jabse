import test from 'node:test';
import assert from 'node:assert/strict';

const { createNewsService } = await import('../src/news.js');
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
      assert.match(url, /AAPL/);
      return response({
        news: [
          {
            title: 'Apple reports quarterly results',
            publisher: 'Example Wire',
            providerPublishTime: 1_799_999_000,
            link: 'https://example.test/story',
          },
          { title: 'Missing timestamp is ignored', publisher: 'Example Wire' },
        ],
      });
    },
  });

  const result = await service.latest({ symbol: 'AAPL.US', limit: 6 });
  assert.equal(result.symbol, 'AAPL.US');
  assert.deepEqual(result.items, [
    {
      source: 'Example Wire',
      headline: 'Apple reports quarterly results',
      publishedAt: 1_799_999_000_000,
      url: 'https://example.test/story',
      associatedSymbol: 'AAPL.US',
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