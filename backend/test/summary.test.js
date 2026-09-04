/**
 * The product behaviours on top of the engine: "since you were away", the
 * surfaced-signal memory, determinism, and the extended API contract.
 *
 * Fixed clock, in-memory database, stub source. No network, no filesystem, no
 * wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';
process.env.INGEST_INTERVAL_MS = '15000';
process.env.STALENESS_INTERVALS = '3';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createEngine } = await import('../src/engine/index.js');
const { createSurfacedStore, fingerprintFor } = await import('../src/engine/surfaced.js');
const { createSummaryService, describeDuration, timeAway } = await import('../src/summary.js');
const { createApi } = await import('../src/api.js');
const { BENCHMARK_SYMBOL } = await import('../src/symbols.js');

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const BAR = 60_000;
const USER = 'test-user';
const OVERRIDES = { barMs: BAR, anomalyHorizonMs: BAR, sectorMap: {} };

const synthSource = () => ({
  name: 'test',
  describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
});

function harness({ now = T0, overrides = {} } = {}) {
  const db = createDatabase(':memory:');
  const log = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);
  const clock = () => now;

  const engine = createEngine({
    snapshotLog: log,
    watchlist,
    surfacedStore,
    source: synthSource(),
    clock,
    overrides: { ...OVERRIDES, ...overrides },
  });

  const summaryService = createSummaryService({ engine, watchlist, surfacedStore, clock });

  return { db, log, watchlist, surfacedStore, engine, summaryService, now };
}

function seed(log, symbol, { bars = 150, price, volume = () => 1000, endAt = T0 }) {
  const rows = [];
  for (let i = bars; i >= 0; i -= 1) {
    const t = endAt - i * BAR;
    rows.push({
      symbol,
      timestamp: t,
      price: price(bars - i, t),
      volume: volume(bars - i, t),
      source: 'test',
      confidence: 1,
      ingestedAt: t,
    });
  }
  log.appendMany(rows);
}

const calm = (base) => (i) =>
  Math.round(base * (1 + 0.0004 * Math.sin(i * 2.3) + 0.0002 * Math.cos(i * 5.1)) * 100) / 100;

const calmThenJump = (base, pct, bars = 150) => (i) =>
  i === bars ? Math.round(base * (1 + pct) * 100) / 100 : calm(base)(i);

// ============================================================== time away

test('durations read the way a person would say them', () => {
  assert.equal(describeDuration(0), 'less than a minute');
  assert.equal(describeDuration(45 * 1000), 'less than a minute');
  assert.equal(describeDuration(6 * 60_000), '6m');
  assert.equal(describeDuration(90 * 60_000), '1h 30m');
  assert.equal(describeDuration(6 * 3_600_000 + 24 * 60_000), '6h 24m');
  assert.equal(describeDuration(2 * 86_400_000 + 3 * 3_600_000), '2d 3h');
  assert.equal(describeDuration(null), 'an unknown time');
  assert.equal(describeDuration(NaN), 'an unknown time');
});

test('time away comes from the oldest last-viewed, and a first visit has none', () => {
  const entries = [
    { symbol: 'A', lastViewedAt: T0 - 3_600_000 },
    { symbol: 'B', lastViewedAt: T0 - 7_200_000 },
    { symbol: 'C', lastViewedAt: null },
  ];

  const away = timeAway({ entries, now: T0 });
  assert.equal(away.awayMs, 7_200_000, 'the earliest point the state could have been seen from');

  // Never-viewed symbols are excluded rather than counted as "away forever".
  const firstVisit = timeAway({ entries: [{ symbol: 'C', lastViewedAt: null }], now: T0 });
  assert.equal(firstVisit.awayMs, null);
  assert.equal(firstVisit.firstVisit, true);

  // The dev override wins, and says that it did.
  const simulated = timeAway({ entries, now: T0, overrideMs: 50 * 3_600_000 });
  assert.equal(simulated.awayMs, 50 * 3_600_000);
  assert.equal(simulated.simulated, true);
});

// ======================================================= the summary itself

test('a first visit says so instead of reporting a change of zero', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'STOCK');
  seed(log, 'STOCK', { price: calm(100) });

  const summary = summaryService.build({ userId: USER });

  assert.equal(summary.away.firstVisit, true);
  assert.equal(summary.away.ms, null);
  assert.equal(summary.counts.neverViewed, 1);
  assert.equal(summary.counts.changed, 0, 'nothing has changed *since last time* - there was none');
  assert.match(summary.headline, /First look/);
});

test('a short absence enumerates what changed and what deserves attention', () => {
  const { log, watchlist, summaryService } = harness();

  watchlist.add(USER, 'MOVER');
  watchlist.add(USER, 'SLEEPER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.02), volume: (i) => (i === 150 ? 5000 : 1000) });
  seed(log, 'SLEEPER', { price: calm(100) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });

  // Both seen 30 minutes ago.
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);
  watchlist.markViewed(USER, 'SLEEPER', T0 - 30 * 60_000);

  const summary = summaryService.build({ userId: USER, record: false });

  assert.equal(summary.away.long, false);
  assert.equal(summary.away.label, '30m');
  assert.ok(summary.counts.changed >= 1);
  assert.ok(summary.counts.needsAttention >= 1);
  assert.match(summary.headline, /You were away for 30m\./);
  assert.match(summary.headline, /deserves? your attention/);

  // The ranked signal is the engine's choice, not the biggest raw percentage.
  assert.equal(summary.top[0].symbol, 'MOVER');
  assert.ok(summary.top[0].reasonText.length > 0);
  assert.equal(summary.aggregate, null, 'a short absence enumerates');
});

test('a long absence aggregates instead of enumerating', () => {
  const { log, watchlist, summaryService } = harness();

  for (const symbol of ['A', 'B', 'C']) {
    watchlist.add(USER, symbol);
    seed(log, symbol, { price: calm(100) });
    watchlist.markViewed(USER, symbol, T0 - 30 * 60_000);
  }
  seed(log, 'A', { price: calmThenJump(100, 0.03), volume: (i) => (i === 150 ? 6000 : 1000) });

  const summary = summaryService.build({
    userId: USER,
    // The dev override: a two-day absence is otherwise undemonstrable without
    // waiting two days.
    awayOverrideMs: 50 * 3_600_000,
    record: false,
  });

  assert.equal(summary.away.long, true);
  assert.equal(summary.away.simulated, true);
  assert.equal(summary.away.label, '2d 2h');
  assert.match(summary.headline, /Here is what mattered/);

  assert.ok(summary.aggregate, 'a long absence rolls up');
  const total =
    summary.aggregate.byLevel.HIGH.count +
    summary.aggregate.byLevel.MODERATE.count +
    summary.aggregate.byLevel.LOW.count;
  assert.equal(total, 3, 'every watched symbol appears in exactly one bucket');
  assert.ok(summary.aggregate.biggestMove);
});

test('nothing changed is stated plainly rather than padded', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'FROZEN');
  seed(log, 'FROZEN', { price: () => 100 });
  watchlist.markViewed(USER, 'FROZEN', T0 - 20 * 60_000);

  const summary = summaryService.build({ userId: USER, record: false });

  assert.equal(summary.counts.changed, 0);
  /**
   * Wording updated in the polish pass: "no meaningful changes since you last
   * checked" says the same thing in the product's own terms, and matches the
   * phrasing used when things DID move but none of it mattered.
   */
  assert.match(summary.headline, /No meaningful changes since you last checked/);
});

test('an empty watchlist says what to do next, not "these 0 symbols"', () => {
  const { summaryService } = harness();

  const summary = summaryService.build({ userId: USER, record: false });

  /**
   * The first-visit branch used to count its way to "First look at these 0
   * symbols - mark them seen to start tracking what changes": a sentence
   * addressed to nobody about nothing.
   */
  assert.equal(summary.counts.watched, 0);
  assert.match(summary.headline, /watchlist is empty/i);
  assert.match(summary.headline, /Add a symbol/i);
  assert.ok(!summary.headline.includes('0 symbols'));
});

test('things moving without mattering is its own answer', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'DRIFTER');
  /**
   * A real but unremarkable move, placed AFTER the visit at bar 120 - a step at
   * bar 100 would sit before it and leave nothing to diff, which is what the
   * first version of this test got wrong.
   */
  seed(log, 'DRIFTER', { price: (i) => (i < 135 ? 100 : 100.05) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'DRIFTER', T0 - 30 * 60_000);

  const summary = summaryService.build({ userId: USER, record: false });

  assert.ok(summary.counts.changed >= 1, 'something did change');
  assert.equal(summary.counts.needsAttention, 0, 'but none of it is meaningful');
  assert.match(summary.headline, /changed, but no meaningful changes/);
});

test('the summary never gives advice or predicts a price', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'MOVER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.05), volume: (i) => (i === 150 ? 9000 : 1000) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

  const summary = summaryService.build({ userId: USER, record: false });
  const allText = [summary.headline, ...summary.top.flatMap((t) => t.reasonText)]
    .join(' ')
    .toLowerCase();

  for (const forbidden of [
    'buy',
    'sell',
    'should',
    'will rise',
    'will fall',
    'target',
    'recommend',
    'undervalued',
    'overvalued',
    'profit',
    'invest',
  ]) {
    assert.ok(!allText.includes(forbidden), `advice-like word leaked: "${forbidden}"`);
  }

  // And no unevidenced causes.
  for (const forbidden of ['earnings', 'news', 'sentiment', 'because of', 'due to']) {
    assert.ok(!allText.includes(forbidden), `unevidenced cause leaked: "${forbidden}"`);
  }
});

// ================================================ surfaced signals (P0.7)

test('a signal is not re-announced as new once it has been surfaced', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'MOVER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.02), volume: (i) => (i === 150 ? 5000 : 1000) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

  const first = summaryService.build({ userId: USER, record: true });
  assert.equal(first.top[0].alreadySurfaced, false, 'the first time, it is news');

  const second = summaryService.build({ userId: USER, record: true });
  assert.equal(second.top[0].alreadySurfaced, true, 'the second time, it is not');
  assert.equal(second.counts.alreadySurfaced, 1);
});

test('surfaced state survives a restart', () => {
  const { db, log, watchlist, surfacedStore, summaryService } = harness();
  watchlist.add(USER, 'MOVER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.02), volume: (i) => (i === 150 ? 5000 : 1000) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

  summaryService.build({ userId: USER, record: true });
  const fingerprints = surfacedStore.fingerprintsFor(USER);
  assert.equal(fingerprints.size, 1);

  /**
   * Rebuild every object over the SAME database - which is what a process
   * restart is. Without persistence, an ongoing move becomes breaking news
   * every time the server comes up.
   */
  const reopened = createSurfacedStore(db);
  assert.deepEqual([...reopened.fingerprintsFor(USER)], [...fingerprints]);
  assert.equal(reopened.count(USER), 1);
});

test('the fingerprint tracks the event, not the exact score', () => {
  const features = {
    changeSinceViewed: { available: true, percent: 2.1 },
    priceAnomaly: { available: true, returnPct: 2.1 },
  };
  const reasons = [{ code: 'unusual_price_movement' }, { code: 'high_volume' }];
  const base = { symbol: 'X', level: 'HIGH', reasons, features, lastViewedAt: 1000 };

  const original = fingerprintFor(base);

  // Drift within the same 1% bucket is the same event.
  assert.equal(
    fingerprintFor({
      ...base,
      features: {
        changeSinceViewed: { available: true, percent: 2.4 },
        priceAnomaly: { available: true, returnPct: 2.4 },
      },
    }).fingerprint,
    original.fingerprint,
  );

  // A materially larger move is a new event and may surface again.
  assert.notEqual(
    fingerprintFor({
      ...base,
      features: {
        changeSinceViewed: { available: true, percent: 3.6 },
        priceAnomaly: { available: true, returnPct: 3.6 },
      },
    }).fingerprint,
    original.fingerprint,
  );

  // A different reason set is a different event.
  assert.notEqual(
    fingerprintFor({ ...base, reasons: [{ code: 'unusual_price_movement' }] }).fingerprint,
    original.fingerprint,
  );

  // Reason ORDER is not part of the identity.
  assert.equal(
    fingerprintFor({ ...base, reasons: [...reasons].reverse() }).fingerprint,
    original.fingerprint,
  );

  // The low-confidence caveat describes our data, not the market, so a feed
  // getting fresher must not make a signal refire.
  assert.equal(
    fingerprintFor({ ...base, reasons: [...reasons, { code: 'low_confidence' }] }).fingerprint,
    original.fingerprint,
  );

  // A new viewing epoch lets it surface again: the user has acknowledged the
  // old state by pressing "Mark seen".
  assert.notEqual(
    fingerprintFor({ ...base, lastViewedAt: 2000 }).fingerprint,
    original.fingerprint,
  );

  // Direction matters: a fall is not the same event as a rise.
  assert.notEqual(
    fingerprintFor({
      ...base,
      features: {
        changeSinceViewed: { available: true, percent: -2.1 },
        priceAnomaly: { available: true, returnPct: -2.1 },
      },
    }).fingerprint,
    original.fingerprint,
  );
});

test('marking seen lets the signal surface again', () => {
  const { log, watchlist, summaryService } = harness();
  watchlist.add(USER, 'MOVER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.02), volume: (i) => (i === 150 ? 5000 : 1000) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

  summaryService.build({ userId: USER, record: true });
  assert.equal(summaryService.build({ userId: USER, record: false }).top[0].alreadySurfaced, true);

  // The user explicitly acknowledges the current state.
  watchlist.markViewed(USER, 'MOVER', T0 - 5 * 60_000);

  const after = summaryService.build({ userId: USER, record: false });
  assert.equal(
    after.top[0].alreadySurfaced,
    false,
    'a new viewing epoch means the next change is legitimately new',
  );
});

// ========================================================= determinism (P0.6)

test('identical inputs produce byte-identical output', () => {
  const build = () => {
    const h = harness();
    for (const symbol of ['AAA', 'BBB']) {
      h.watchlist.add(USER, symbol, T0 - 3_600_000);
      seed(h.log, symbol, {
        price: symbol === 'AAA' ? calmThenJump(100, 0.02) : calm(250),
        volume: (i) => (i === 150 ? 4000 : 1000),
      });
      h.watchlist.markViewed(USER, symbol, T0 - 30 * 60_000);
    }
    seed(h.log, BENCHMARK_SYMBOL, { price: calm(20_000) });
    return h;
  };

  const a = build();
  const b = build();

  const first = JSON.stringify(a.engine.evaluate({ userId: USER }));
  const second = JSON.stringify(b.engine.evaluate({ userId: USER }));

  /**
   * Two separately-constructed databases, seeded identically, evaluated at the
   * same reference instant. Byte-identical - which is only possible because
   * there is no randomness in the engine and every "now" arrives through the
   * injected clock.
   */
  assert.equal(first, second);

  // And re-evaluating the same state is stable.
  assert.equal(JSON.stringify(a.engine.evaluate({ userId: USER })), first);

  // Summaries too.
  assert.equal(
    JSON.stringify(a.summaryService.build({ userId: USER, record: false })),
    JSON.stringify(b.summaryService.build({ userId: USER, record: false })),
  );
});

test('a different reference timestamp is allowed to change the answer', () => {
  const h = harness();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: calmThenJump(100, 0.02) });

  const atT0 = h.engine.evaluate({ userId: USER, now: T0 });
  const later = h.engine.evaluate({ userId: USER, now: T0 + 30 * 60_000 });

  // Determinism is "same inputs, same output" - not "the clock is ignored".
  // Half an hour later the same data is stale, and the result must say so.
  assert.equal(atT0.items[0].dataQuality, 'LIVE');
  assert.equal(later.items[0].dataQuality, 'STALE');
});

test('the memo avoids recomputation but not correctness', () => {
  const h = harness();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: calm(100) });

  h.engine.evaluate({ userId: USER });
  const keyAfterFirst = h.engine.__memoKey();
  h.engine.evaluate({ userId: USER });
  assert.equal(h.engine.__memoKey(), keyAfterFirst, 'no new data, no new work');

  // A new observation must invalidate it.
  h.log.append({
    symbol: 'STOCK',
    timestamp: T0,
    price: 123.45,
    volume: 1000,
    source: 'test',
    confidence: 1,
    ingestedAt: T0,
  });
  h.engine.evaluate({ userId: USER });
  assert.notEqual(h.engine.__memoKey(), keyAfterFirst, 'new data, fresh evaluation');
  assert.equal(h.engine.evaluate({ userId: USER }).items[0].latest.price, 123.45);
});

// =============================================================== the API

async function withServer(run) {
  const h = harness();
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createApi({
      snapshotLog: h.log,
      watchlist: h.watchlist,
      source: synthSource(),
      ingestor: null,
      engine: h.engine,
      summaryService: h.summaryService,
      surfacedStore: h.surfacedStore,
    }),
  );

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  try {
    await run({ base, ...h });
  } finally {
    server.close();
    h.db.close();
  }
}

test('the API extends the old contract rather than replacing it', async () => {
  await withServer(async ({ base, log, watchlist }) => {
    watchlist.add(USER, 'MOVER');
    seed(log, 'MOVER', {
      price: calmThenJump(100, 0.02),
      volume: (i) => (i === 150 ? 5000 : 1000),
    });
    seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
    watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

    const response = await fetch(`${base}/watchlist`);
    const body = await response.json();
    const item = body.items[0];

    // Every field the previous contract promised is still present.
    for (const key of ['latest', 'freshness', 'conflict', 'delta']) {
      assert.ok(key in item, `the original contract kept its "${key}"`);
    }
    assert.deepEqual(item.delta, item.changeSinceViewed, 'delta is retained as an alias');

    // And the engine's fields are alongside it.
    for (const key of [
      'meaningfulScore',
      'level',
      'confidence',
      'changeSinceViewed',
      'reasons',
      'features',
      'dataQuality',
      'alreadySurfaced',
    ]) {
      assert.ok(key in item, `the engine contributed "${key}"`);
    }

    assert.ok(item.meaningfulScore >= 0 && item.meaningfulScore <= 1);
    assert.ok(['LOW', 'MODERATE', 'HIGH'].includes(item.level));
    assert.ok(Array.isArray(item.reasons));
    assert.equal(typeof item.reasons[0], 'string', 'reasons are machine codes');
  });
});

test('the summary endpoint takes a dev time-away override and validates it', async () => {
  await withServer(async ({ base, log, watchlist }) => {
    watchlist.add(USER, 'STOCK');
    seed(log, 'STOCK', { price: calm(100) });
    watchlist.markViewed(USER, 'STOCK', T0 - 10 * 60_000);

    const short = await (await fetch(`${base}/summary?record=false`)).json();
    assert.equal(short.away.long, false);

    const long = await (await fetch(`${base}/summary?awayMs=180000000&record=false`)).json();
    assert.equal(long.away.long, true);
    assert.equal(long.away.simulated, true);
    assert.ok(long.aggregate);

    // Nonsense is a 400, not a 500 and not a silent default.
    for (const bad of ['-1', 'abc']) {
      const response = await fetch(`${base}/summary?awayMs=${bad}`);
      assert.equal(response.status, 400, `awayMs=${bad}`);
    }
  });
});
