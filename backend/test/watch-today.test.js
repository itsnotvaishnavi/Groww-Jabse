import test from 'node:test';
import assert from 'node:assert/strict';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { createAlertStore } = await import('../src/alerts.js');
const { createEngine } = await import('../src/engine/index.js');
const { createDiscoveryService } = await import('../src/discovery.js');
const { createWatchTodayService } = await import('../src/watch-today.js');
const { createApi } = await import('../src/api.js');

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const BAR = 60_000;
const USER = 'dev';

function calm(base) {
  return (index) => Math.round(base * (1 + 0.0004 * Math.sin(index * 2.3)) * 100) / 100;
}

function jump(base, pct) {
  return (index) => (index === 150 ? Math.round(base * (1 + pct) * 100) / 100 : calm(base)(index));
}

function setup(sourceOverrides = {}) {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);
  const alertStore = createAlertStore(db);
  const source = {
    getSymbols: () => [
      { symbol: 'TCS', name: 'Tata Consultancy Services' },
      { symbol: 'INFY', name: 'Infosys' },
      { symbol: 'HDFCBANK', name: 'HDFC Bank' },
      { symbol: 'RELIANCE', name: 'Reliance Industries' },
    ],
    describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0, ...sourceOverrides }),
  };
  const engine = createEngine({
    snapshotLog,
    watchlist,
    surfacedStore,
    source,
    clock: () => T0,
  });
  const discoveryService = createDiscoveryService({
    engine,
    snapshotLog,
    watchlist,
    source,
    clock: () => T0,
  });
  const watchTodayService = createWatchTodayService({
    snapshotLog,
    source,
    newsService: null,
    clock: () => T0,
  });

  return { db, snapshotLog, watchlist, alertStore, engine, discoveryService, watchTodayService, source };
}

function seed(log, symbol, price, { volume = 1000, endAt = T0, confidence = 1 } = {}) {
  const rows = [];
  for (let index = 0; index <= 150; index += 1) {
    const vol = typeof volume === 'function' ? volume(index) : volume;
    rows.push({
      symbol,
      timestamp: endAt - (150 - index) * BAR,
      price: price(index),
      volume: vol,
      source: 'test',
      confidence,
      ingestedAt: endAt,
    });
  }
  log.appendMany(rows);
}

// 1. Strong candidates appear
test('1. strong candidates with multi-signal confirmation appear in what to watch today', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  // TCS has calm baseline
  seed(snapshotLog, 'TCS', calm(100));
  // INFY has a 2% jump with 3x volume spike (confirming price + volume anomaly)
  seed(snapshotLog, 'INFY', jump(100, 0.02), {
    volume: (idx) => (idx === 150 ? 3000 : 1000),
  });
  seed(snapshotLog, 'HDFCBANK', calm(100));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const result = await watchTodayService.build({ now: T0 });
  assert.equal(result.status, 'ok');
  assert.ok(result.candidates.length >= 1);
  const infy = result.candidates.find((c) => c.symbol === 'INFY');
  assert.ok(infy, 'INFY should appear as a strong candidate');
  assert.match(infy.signal, /Meaningful move|volume/i);
  assert.equal(infy.direction, 'up');
  db.close();
});

// 2. Weak candidates are excluded
test('2. weak candidates without sufficient confirming evidence are excluded', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  // All symbols are completely calm, no anomalies
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', calm(100));
  seed(snapshotLog, 'HDFCBANK', calm(100));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const result = await watchTodayService.build({ now: T0 });
  assert.equal(result.candidates.length, 0, 'No candidate should be surfaced when market is calm');
  db.close();
});

// 3 & 4. Raw percentage change alone does NOT determine ranking; multiple signals strengthen ranking
test('3 & 4. multi-signal confirmation ranks ahead of purely high raw percentage gain', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  // Benchmark
  seed(snapshotLog, 'NIFTY', calm(20_000));

  // TCS: Massive raw jump (+8%) but flat/declining volume, no other confirming signals
  seed(snapshotLog, 'TCS', jump(100, 0.08), { volume: 500 });

  // INFY: Moderate move (+2.5%), but huge volume spike (4x) and massive outperformance
  seed(snapshotLog, 'INFY', jump(100, 0.025), {
    volume: (idx) => (idx === 150 ? 4000 : 1000),
  });

  const result = await watchTodayService.build({ now: T0 });
  assert.ok(result.candidates.length >= 1);
  // INFY with multi-signal agreement (price anomaly + volume anomaly + market relative)
  // should rank ahead of TCS despite TCS having a higher raw percentage gain
  const infyIndex = result.candidates.findIndex((c) => c.symbol === 'INFY');
  const tcsIndex = result.candidates.findIndex((c) => c.symbol === 'TCS');
  assert.ok(infyIndex !== -1, 'INFY must qualify');
  if (tcsIndex !== -1) {
    assert.ok(infyIndex < tcsIndex, 'INFY (multi-signal) must rank ahead of TCS (pure raw move)');
  }
  db.close();
});

// 5. Missing data is handled correctly
test('5. missing data for unobserved symbols is declined cleanly without throwing', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  // Only NIFTY is observed, others have no data
  seed(snapshotLog, 'NIFTY', calm(20_000));

  const result = await watchTodayService.build({ now: T0 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.candidates, []);
  db.close();
});

// 6. Stale data is handled correctly
test('6. stale data triggers stale market state and suppresses candidates', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  seed(snapshotLog, 'NIFTY', calm(20_000), { endAt: T0 - 2 * 3600_000 });
  seed(snapshotLog, 'INFY', jump(100, 0.03), { endAt: T0 - 2 * 3600_000 });

  // Evaluation 2 hours later
  const result = await watchTodayService.build({ now: T0 });
  assert.equal(result.marketState, 'stale');
  assert.match(result.subtitle, /unavailable/i);
  assert.equal(result.candidates.length, 0);
  db.close();
});

// 7. Market-closed state works
test('7. market-closed state produces appropriate subtitle and latest available signals', async () => {
  const { db, snapshotLog, watchTodayService } = setup({ alwaysOpen: false });
  // Nighttime instant (market closed)
  const NIGHT_T0 = Date.UTC(2026, 8, 4, 18, 0, 0);
  seed(snapshotLog, 'NIFTY', calm(20_000), { endAt: NIGHT_T0 });
  seed(snapshotLog, 'INFY', jump(100, 0.025), {
    volume: (idx) => (idx === 150 ? 3000 : 1000),
    endAt: NIGHT_T0,
  });

  const result = await watchTodayService.build({ now: NIGHT_T0 });
  assert.equal(result.marketState, 'market_closed');
  assert.match(result.subtitle, /Latest available signals/i);
  db.close();
});

// 8. No candidates shows empty state
test('8. empty state when no stock meets criteria returns clean empty array', async () => {
  const { db, watchTodayService } = setup();
  const result = await watchTodayService.build({ now: T0 });
  assert.deepEqual(result.candidates, []);
  db.close();
});

// 9. Ranking is deterministic
test('9. repeated builds on the same snapshot produce byte-identical candidate rankings', async () => {
  const { db, snapshotLog, watchTodayService } = setup();
  seed(snapshotLog, 'NIFTY', calm(20_000));
  seed(snapshotLog, 'INFY', jump(100, 0.02), { volume: (idx) => (idx === 150 ? 3000 : 1000) });
  seed(snapshotLog, 'TCS', jump(100, 0.018), { volume: (idx) => (idx === 150 ? 2500 : 1000) });

  const run1 = await watchTodayService.build({ now: T0 });
  const run2 = await watchTodayService.build({ now: T0 });
  assert.deepEqual(run1, run2, 'Must produce identical output');
  db.close();
});

// 10. Existing needsAttention logic is unchanged
test('10. what to watch today does not modify or set user needsAttention flag', async () => {
  const { db, snapshotLog, watchlist, engine, watchTodayService } = setup();
  // User watches TCS
  watchlist.add(USER, 'TCS');
  seed(snapshotLog, 'TCS', calm(100));
  // INFY has huge movement and is candidate for What to Watch Today
  seed(snapshotLog, 'INFY', jump(100, 0.03), { volume: (idx) => (idx === 150 ? 3500 : 1000) });
  seed(snapshotLog, 'NIFTY', calm(20_000));

  await watchTodayService.build({ now: T0 });

  // Evaluate user watchlist
  const evalBefore = engine.evaluate({ userId: USER, now: T0 });
  const tcsItem = evalBefore.items.find((i) => i.symbol === 'TCS');
  assert.equal(tcsItem.needsAttention, false, 'User watchlist item attention must not change');
  assert.equal(evalBefore.items.some((i) => i.symbol === 'INFY'), false, 'INFY must not leak into user watchlist');
  db.close();
});

// 11. Existing alerts are unchanged
test('11. existing alert evaluation is unaffected by what to watch today', async () => {
  const { db, snapshotLog, watchlist, alertStore, engine, watchTodayService } = setup();
  watchlist.add(USER, 'TCS');
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'NIFTY', calm(20_000));

  alertStore.create(USER, { symbol: 'TCS', type: 'attention_high' });

  await watchTodayService.build({ now: T0 });

  const alertEval = alertStore.evaluate({
    userId: USER,
    evaluation: engine.evaluate({ userId: USER, now: T0 }),
    now: T0,
    engineParams: engine.params(),
  });
  assert.equal(alertEval.fired.length, 0, 'No false alert should fire');
  db.close();
});

// 12. Existing last_viewed_at behavior is unchanged
test('12. building what to watch today does not touch last_viewed_at timestamps', async () => {
  const { db, snapshotLog, watchlist, watchTodayService } = setup();
  watchlist.add(USER, 'TCS');
  const initialViewed = watchlist.get(USER, 'TCS').lastViewedAt;

  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', jump(100, 0.02), { volume: 3000 });
  seed(snapshotLog, 'NIFTY', calm(20_000));

  await watchTodayService.build({ now: T0 });

  assert.equal(watchlist.get(USER, 'TCS').lastViewedAt, initialViewed);
  db.close();
});

// 13. Adding to watchlist does not mark stock as viewed
test('13. adding a candidate to watchlist leaves last_viewed_at as null', async () => {
  const { db, snapshotLog, watchlist, watchTodayService } = setup();
  seed(snapshotLog, 'NIFTY', calm(20_000));
  seed(snapshotLog, 'INFY', jump(100, 0.02), { volume: 3000 });

  const result = await watchTodayService.build({ now: T0 });
  const candidate = result.candidates[0];
  assert.ok(candidate);

  watchlist.add(USER, candidate.symbol);
  const entry = watchlist.get(USER, candidate.symbol);
  assert.equal(entry.lastViewedAt, null, 'Adding to watchlist must not establish viewed baseline');
  db.close();
});

// 14. Clicking/opening detail still establishes viewed baseline
test('14. explicitly marking viewed updates last_viewed_at timestamp', async () => {
  const { db, watchlist } = setup();
  watchlist.add(USER, 'INFY');
  assert.equal(watchlist.get(USER, 'INFY').lastViewedAt, null);

  watchlist.markViewed(USER, 'INFY');
  assert.ok(watchlist.get(USER, 'INFY').lastViewedAt > 0, 'Opening detail sets viewed baseline');
  db.close();
});

// 15. Existing "You might want to watch" continues working
test('15. discoveryService ("You might want to watch") continues functioning normally', async () => {
  const { db, snapshotLog, watchlist, discoveryService, watchTodayService } = setup();
  watchlist.add(USER, 'TCS'); // IT sector
  seed(snapshotLog, 'TCS', calm(100));
  seed(snapshotLog, 'INFY', jump(100, 0.02), { volume: 2000 }); // IT peer
  seed(snapshotLog, 'NIFTY', calm(20_000));

  // Run watchTodayService
  await watchTodayService.build({ now: T0 });

  // Run discoveryService
  const discoveryResult = discoveryService.build({ userId: USER, now: T0 });
  assert.ok(Array.isArray(discoveryResult.suggestions));
  const infySuggestion = discoveryResult.suggestions.find((s) => s.symbol === 'INFY');
  assert.ok(infySuggestion, 'Personalized discovery still finds INFY based on sector interest');
  db.close();
});

// 16. News failure does not break the sidebar
test('16. news provider failure is isolated and does not break what to watch today', async () => {
  const failingNews = {
    latest: async () => {
      throw new Error('Provider 500 error');
    },
  };
  const { db, snapshotLog, source } = setup();
  seed(snapshotLog, 'NIFTY', calm(20_000));
  seed(snapshotLog, 'INFY', jump(100, 0.02), { volume: 3000 });

  const watchTodayWithNews = createWatchTodayService({
    snapshotLog,
    source,
    newsService: failingNews,
    clock: () => T0,
  });

  const result = await watchTodayWithNews.build({ now: T0 });
  assert.equal(result.status, 'ok');
  assert.ok(result.candidates.length >= 1);
  assert.equal(result.candidates[0].hasNews, false, 'hasNews safely defaults to false on failure');
  db.close();
});

// 17. Main dashboard still works if this endpoint fails
test('17. api endpoint /api/watch-today handles missing service with 503 while other routes work', async () => {
  const { db, snapshotLog, watchlist, source, engine } = setup();
  const apiWithoutWatchToday = createApi({
    snapshotLog,
    watchlist,
    source,
    engine,
    watchTodayService: null,
  });

  // Test route handler directly
  const req = { query: {} };
  let status = 200;
  let jsonBody = null;
  const res = {
    status: (code) => {
      status = code;
      return res;
    },
    json: (body) => {
      jsonBody = body;
    },
  };

  // Find the watch-today route in the router stack
  const route = apiWithoutWatchToday.stack.find((layer) => layer.route?.path?.includes?.('/watch-today'));
  assert.ok(route, 'Route must exist');
  route.route.stack[0].handle(req, res, () => {});

  assert.equal(status, 503, 'Should respond 503 when service is disabled');
  assert.deepEqual(jsonBody, { error: 'watch-today is disabled' });
  db.close();
});
