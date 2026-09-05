import test from 'node:test';
import assert from 'node:assert/strict';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { createEngine } = await import('../src/engine/index.js');
const { createDiscoveryService } = await import('../src/discovery.js');

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const BAR = 60_000;
const USER = 'discovery-user';

function calm(base) {
  return (index) => Math.round(base * (1 + 0.0004 * Math.sin(index * 2.3)) * 100) / 100;
}

function jump(base, pct) {
  return (index) => (index === 150 ? Math.round(base * (1 + pct) * 100) / 100 : calm(base)(index));
}

function setup() {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);
  const source = {
    getSymbols: () => [
      { symbol: 'TCS', name: 'Tata Consultancy Services' },
      { symbol: 'INFY', name: 'Infosys' },
      { symbol: 'HDFCBANK', name: 'HDFC Bank' },
    ],
    describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
  };
  const engine = createEngine({
    snapshotLog,
    watchlist,
    surfacedStore,
    source,
    clock: () => T0,
  });
  const discovery = createDiscoveryService({
    engine,
    snapshotLog,
    watchlist,
    source,
    clock: () => T0,
  });

  return { db, snapshotLog, watchlist, discovery };
}

function seed(log, symbol, price, endAt = T0) {
  const rows = [];
  for (let index = 0; index <= 150; index += 1) {
    rows.push({
      symbol,
      timestamp: endAt - (150 - index) * BAR,
      price: price(index),
      volume: 1000,
      source: 'test',
      confidence: 1,
      ingestedAt: endAt,
    });
  }
  log.appendMany(rows);
}

test('discovery excludes watched symbols and ranks followed-sector activity with reasons', () => {
  const { db, snapshotLog, watchlist, discovery } = setup();
  watchlist.add(USER, 'TCS');
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', jump(100, 0.02));
  seed(snapshotLog, 'HDFCBANK', calm(100));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const result = discovery.build({ userId: USER, now: T0 });
  assert.ok(result.suggestions.length <= 4);
  assert.ok(!result.suggestions.some((item) => item.symbol === 'TCS'));
  const infosys = result.suggestions.find((item) => item.symbol === 'INFY');
  assert.ok(infosys);
  assert.match(infosys.why, /IT stocks you already follow/);
  assert.ok(infosys.activity);
  db.close();
});

test('stale and unobserved candidates are excluded', () => {
  const { db, snapshotLog, watchlist, discovery } = setup();
  watchlist.add(USER, 'TCS');
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', jump(100, 0.02));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const result = discovery.build({ userId: USER, now: T0 + 60 * 60_000 });
  assert.ok(!result.suggestions.some((item) => item.symbol === 'INFY'));
  assert.ok(!result.suggestions.some((item) => item.symbol === 'HDFCBANK'));
  db.close();
});

test('adding a discovery candidate does not establish a viewing baseline', () => {
  const { db, snapshotLog, watchlist, discovery } = setup();
  watchlist.add(USER, 'TCS');
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', jump(100, 0.02));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const suggestion = discovery.build({ userId: USER, now: T0 }).suggestions.find((item) => item.symbol === 'INFY');
  assert.ok(suggestion);
  watchlist.add(USER, suggestion.symbol);
  assert.equal(watchlist.get(USER, 'INFY').lastViewedAt, null);
  db.close();
});

test('empty discovery returns no arbitrary filler', () => {
  const { db, watchlist, discovery } = setup();
  watchlist.add(USER, 'TCS');
  const result = discovery.build({ userId: USER, now: T0 });
  assert.deepEqual(result.suggestions, []);
  db.close();
});
