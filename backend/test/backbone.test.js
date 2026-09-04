/**
 * The data backbone: log invariants, watchlist CRUD, freshness semantics, and
 * one end-to-end pass over the HTTP API.
 *
 * Every test runs against an in-memory database and, where a source is needed,
 * a stub - so the suite touches no files, no network, and no clock it does not
 * control.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Fixed config before any module reads it, so thresholds are known constants.
process.env.INGEST_INTERVAL_MS = '15000';
process.env.STALENESS_INTERVALS = '3';
process.env.CONFLICT_TOLERANCE_PCT = '0.5';
process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist, normalizeSymbol, ValidationError } = await import('../src/watchlist.js');
const { computeDelta, NoBaselineReason } = await import('../src/delta.js');
const { assessFreshness, detectConflict, isMarketOpen, FreshnessState } = await import(
  '../src/freshness.js'
);
const { createApi } = await import('../src/api.js');
const { createIngestor } = await import('../src/ingest.js');

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0); // Fri 2026-09-04 10:30 IST, market open
const TOLERANCE_MS = 45_000; // 15s interval * 3

const snap = (over = {}) => ({
  symbol: 'RELIANCE',
  timestamp: T0,
  price: 1400,
  volume: 1000,
  source: 'simulator',
  confidence: 1,
  ...over,
});

const fresh = () => {
  const db = createDatabase(':memory:');
  return { db, log: createSnapshotLog(db), watchlist: createWatchlist(db) };
};

// ------------------------------------------------------------- the log itself

test('history cannot be rewritten, even by raw SQL', () => {
  const { db, log } = fresh();
  log.append(snap());

  assert.throws(() => db.exec('UPDATE snapshots SET price = 1'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM snapshots'), /append-only/);
  assert.equal(log.stats().snapshots, 1);
});

test('a repeated observation is one fact; a changed one is a correction', () => {
  const { log } = fresh();

  assert.equal(log.append(snap()), true, 'first observation is new');
  assert.equal(log.append(snap()), false, 'identical re-observation is a duplicate');
  assert.equal(log.stats().snapshots, 1);

  // Same symbol, same instant, same source, different price: the source has
  // corrected itself, and both halves of that are worth keeping.
  assert.equal(log.append(snap({ price: 1401 })), true);
  assert.equal(log.stats().snapshots, 2);

  // A different source describing the same instant is also its own fact.
  assert.equal(log.append(snap({ source: 'yahoo', confidence: 0.6 })), true);
  assert.equal(log.stats().snapshots, 3);
});

test('bad observations are refused at the boundary', () => {
  const { log } = fresh();

  assert.throws(() => log.append(snap({ price: NaN })), /positive number/);
  assert.throws(() => log.append(snap({ price: 0 })), /positive number/);
  assert.throws(() => log.append(snap({ confidence: 1.5 })), /0\.\.1/);
  assert.throws(() => log.append(snap({ volume: -1 })), /non-negative/);
  assert.throws(() => log.append(snap({ symbol: '' })), /non-empty/);

  // The classic unit error: a seconds timestamp is a valid positive integer
  // that silently means 1970, so it has to be caught by magnitude.
  assert.throws(() => log.append(snap({ timestamp: Math.floor(T0 / 1000) })), /looks like seconds/);
});

test('asOf returns what had been observed by an instant, never later', () => {
  const { log } = fresh();
  log.append(snap({ timestamp: T0, price: 1400 }));
  log.append(snap({ timestamp: T0 + 60_000, price: 1410 }));
  log.append(snap({ timestamp: T0 + 120_000, price: 1420 }));

  assert.equal(log.asOf('RELIANCE', T0 + 90_000).price, 1410, 'the latest at or before');
  assert.equal(log.asOf('RELIANCE', T0 + 60_000).price, 1410, 'inclusive of the instant itself');
  assert.equal(log.asOf('RELIANCE', T0 - 1), null, 'nothing observed yet');
  assert.equal(log.latest('RELIANCE').price, 1420);
});

test('latestForSymbols answers for many symbols in one query', () => {
  const { log } = fresh();
  log.append(snap({ symbol: 'RELIANCE', price: 1400 }));
  log.append(snap({ symbol: 'RELIANCE', timestamp: T0 + 1000, price: 1405 }));
  log.append(snap({ symbol: 'TCS', price: 4000 }));

  const result = log.latestForSymbols(['RELIANCE', 'TCS', 'ABSENT']);
  assert.equal(result.get('RELIANCE').price, 1405, 'newest per symbol');
  assert.equal(result.get('TCS').price, 4000);
  assert.equal(result.has('ABSENT'), false);
  assert.equal(log.latestForSymbols([]).size, 0, 'empty input is not an error');
});

// --------------------------------------------------------------- the watchlist

test('symbols are normalised, and nonsense is rejected', () => {
  assert.equal(normalizeSymbol('  reliance '), 'RELIANCE');
  assert.equal(normalizeSymbol('m&m'), 'M&M');

  /**
   * This assertion previously expected 'RELIANCE.NS' - it was encoding the
   * canonicalisation bug rather than testing correct behaviour. NSE is the
   * implied venue, so its suffix is redundant and now collapses; BSE is a
   * different venue at a different price and stays distinct. The full matrix
   * is covered in symbols.test.js.
   */
  assert.equal(normalizeSymbol('reliance.ns'), 'RELIANCE');
  assert.equal(normalizeSymbol('reliance.bo'), 'RELIANCE.BO');

  for (const bad of ['', '   ', 'A B', 'DROP TABLE', 'TOOLONGSYMBOLNAMEHERE', '<script>']) {
    assert.throws(() => normalizeSymbol(bad), ValidationError, `should reject ${bad}`);
  }
});

test('watchlist CRUD is idempotent and scoped to a user', () => {
  const { watchlist } = fresh();

  assert.deepEqual(watchlist.add('u1', 'reliance'), { symbol: 'RELIANCE', added: true });
  assert.deepEqual(watchlist.add('u1', 'RELIANCE'), { symbol: 'RELIANCE', added: false });
  assert.equal(watchlist.list('u1').length, 1);
  assert.equal(watchlist.list('u2').length, 0, 'users do not see each other');

  assert.equal(watchlist.remove('u1', 'RELIANCE').removed, true);
  assert.equal(watchlist.remove('u1', 'RELIANCE').removed, false, 'removing twice is not an error');
});

test('a new symbol has no baseline until the user actually looks', () => {
  const { watchlist } = fresh();
  watchlist.add('u1', 'RELIANCE');

  assert.equal(watchlist.get('u1', 'RELIANCE').lastViewedAt, null, 'not viewed on add');

  const viewed = watchlist.markViewed('u1', 'RELIANCE', T0);
  assert.equal(viewed.updated, true);
  assert.equal(watchlist.get('u1', 'RELIANCE').lastViewedAt, T0);

  assert.equal(watchlist.markViewed('u1', 'MISSING').updated, false);
});

test('removing a symbol keeps its history for when it comes back', () => {
  const { log, watchlist } = fresh();
  watchlist.add('u1', 'RELIANCE');
  log.append(snap());
  watchlist.remove('u1', 'RELIANCE');

  assert.equal(log.latest('RELIANCE').price, 1400, 'observations outlive interest');
});

// -------------------------------------------------------------------- deltas

test('a delta is two observations and the gap between them', () => {
  const baseline = snap({ timestamp: T0, price: 1400, volume: 1000 });
  const latest = snap({ timestamp: T0 + 3_600_000, price: 1421, volume: 1500 });

  const delta = computeDelta({ baseline, latest, lastViewedAt: T0 + 10 });

  assert.equal(delta.hasBaseline, true);
  assert.equal(delta.absolute, 21);
  assert.equal(delta.percent, 1.5);
  assert.equal(delta.volumeRatio, 1.5);
  assert.equal(delta.spanMs, 3_600_000);
  assert.equal(delta.from.price, 1400);
  assert.equal(delta.to.price, 1421);
});

test('a missing baseline says which kind of missing it is', () => {
  const latest = snap();

  assert.equal(
    computeDelta({ baseline: null, latest, lastViewedAt: null }).reason,
    NoBaselineReason.NEVER_VIEWED,
  );
  assert.equal(
    computeDelta({ baseline: null, latest, lastViewedAt: T0 }).reason,
    NoBaselineReason.NO_OBSERVATION_AT_LAST_VIEW,
  );
  assert.equal(
    computeDelta({ baseline: snap(), latest: null, lastViewedAt: T0 }).reason,
    NoBaselineReason.NO_CURRENT_OBSERVATION,
  );
});

test('a delta is only as trustworthy as its weaker end', () => {
  const delta = computeDelta({
    baseline: snap({ confidence: 0.6, source: 'yahoo' }),
    latest: snap({ timestamp: T0 + 1000, confidence: 1 }),
    lastViewedAt: T0,
  });
  assert.equal(delta.confidence, 0.6);
});

// ----------------------------------------------------------------- freshness

const SYNTHETIC = { name: 'simulator', alwaysOpen: true, delayMs: 0 };
const REAL = { name: 'yahoo', alwaysOpen: false, delayMs: 20 * 60_000 };

test('the market calendar knows the build weekend', () => {
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 4, 5, 0)), true, 'Fri 10:30 IST is open');
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 4, 12, 0)), false, 'Fri 17:30 IST is closed');
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 4, 3, 30)), false, 'Fri 09:00 IST is pre-open');
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 5, 5, 0)), false, 'Saturday is closed');
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 6, 5, 0)), false, 'Sunday is closed');
  assert.equal(isMarketOpen(Date.UTC(2026, 8, 7, 5, 0)), true, 'Monday 10:30 IST is open');
});

test('an always-open source is judged only on our polling cadence', () => {
  const now = T0 + 10 * 60_000;

  const live = assessFreshness(snap({ timestamp: now - 5_000 }), SYNTHETIC, now);
  assert.equal(live.state, FreshnessState.LIVE);
  assert.equal(live.isStale, false);

  const stale = assessFreshness(snap({ timestamp: now - TOLERANCE_MS - 1 }), SYNTHETIC, now);
  assert.equal(stale.state, FreshnessState.STALE);
  assert.equal(stale.isStale, true);
});

test('a delayed source is not stale merely for being delayed', () => {
  const now = Date.UTC(2026, 8, 4, 6, 0); // Fri 11:30 IST, open
  const withinDelay = assessFreshness(snap({ timestamp: now - 15 * 60_000 }), REAL, now);

  assert.equal(withinDelay.state, FreshnessState.DELAYED);
  assert.equal(withinDelay.isStale, false);
  assert.match(withinDelay.label, /Delayed by up to 20 min/);

  const beyondDelay = assessFreshness(
    snap({ timestamp: now - (20 * 60_000 + TOLERANCE_MS + 1) }),
    REAL,
    now,
  );
  assert.equal(beyondDelay.state, FreshnessState.STALE);
});

test("a weekend price is the last traded price, not stale data", () => {
  // Sunday afternoon. The newest real quote is Friday's close, which is the
  // correct answer - flagging it stale for 62 hours would be crying wolf.
  const sunday = Date.UTC(2026, 8, 6, 9, 0);
  const fridayClose = Date.UTC(2026, 8, 4, 10, 0); // 15:30 IST Friday

  const closed = assessFreshness(snap({ timestamp: fridayClose }), REAL, sunday);
  assert.equal(closed.state, FreshnessState.MARKET_CLOSED);
  assert.equal(closed.isStale, false);
  assert.equal(closed.marketOpen, false);
  assert.ok(closed.nextOpenAt > sunday, 'tells the user when to come back');

  // But data that predates the last open session really is missing: the feed
  // was broken *while the market was trading*, and that is still worth saying.
  const weekBefore = assessFreshness(snap({ timestamp: fridayClose - 5 * 86_400_000 }), REAL, sunday);
  assert.equal(weekBefore.state, FreshnessState.STALE);
});

test('no data is never reported as fresh', () => {
  const assessment = assessFreshness(null, SYNTHETIC, T0);
  assert.equal(assessment.state, FreshnessState.NO_DATA);
  assert.equal(assessment.isStale, true);
  assert.equal(assessment.ageMs, null);
});

test('sources that disagree beyond tolerance are reported, not silently picked', () => {
  const now = T0 + 60_000;
  const observations = [
    snap({ source: 'simulator', price: 1400, confidence: 1, timestamp: now - 1000 }),
    snap({ source: 'yahoo', price: 1450, confidence: 0.6, timestamp: now - 2000 }),
  ];

  const conflict = detectConflict(observations, now);
  assert.ok(conflict, 'a 3.5% spread is a conflict');
  assert.equal(conflict.spreadPct, 3.57);
  assert.equal(conflict.preferred, 'simulator', 'the more confident source is offered');
  assert.equal(conflict.observations.length, 2);

  // Within tolerance is rounding, not disagreement.
  assert.equal(
    detectConflict(
      [snap({ source: 'a', price: 1400 }), snap({ source: 'b', price: 1401 })],
      now,
    ),
    null,
  );

  // One source cannot disagree with itself, and stale observations are not
  // evidence about the present.
  assert.equal(detectConflict([snap()], now), null);
  assert.equal(
    detectConflict(
      [
        snap({ source: 'a', price: 1400, timestamp: now - 60 * 60_000 }),
        snap({ source: 'b', price: 1450, timestamp: now - 60 * 60_000 }),
      ],
      now,
    ),
    null,
    'a conflict must be about the same recent instant',
  );
});

// ----------------------------------------------------------------- ingestion

/** A source whose behaviour each test dictates exactly. */
function stubSource(behaviour = {}) {
  return {
    name: 'stub',
    describe: () => ({ name: 'stub', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
    getSymbols: () => [{ symbol: 'RELIANCE', name: 'Reliance' }],
    getLatestSnapshot: behaviour.getLatestSnapshot ?? (async () => snap({ timestamp: Date.now() })),
    getSnapshotAt: behaviour.getSnapshotAt ?? (async (symbol, at) => snap({ symbol, timestamp: at })),
  };
}

test('one broken symbol does not stop the others', async () => {
  const { log, watchlist } = fresh();
  watchlist.add('test-user', 'GOOD');
  watchlist.add('test-user', 'BAD');

  const ingestor = createIngestor({
    source: stubSource({
      getLatestSnapshot: async (symbol) => {
        if (symbol === 'BAD') throw new Error('upstream exploded');
        return snap({ symbol, timestamp: Date.now() });
      },
    }),
    snapshotLog: log,
    watchlist,
    intervalMs: 15_000,
  });

  await ingestor.tick();

  assert.equal(log.latest('GOOD').symbol, 'GOOD', 'the healthy symbol was still recorded');
  assert.equal(log.latest('BAD'), null);

  const stats = ingestor.stats();
  assert.equal(stats.failures, 1);
  assert.equal(stats.failingSymbols.BAD, 1);
  assert.match(stats.lastError.message, /upstream exploded/);
});

test('an absent observation is data, not an error', async () => {
  const { log, watchlist } = fresh();
  watchlist.add('test-user', 'RELIANCE');

  const ingestor = createIngestor({
    source: stubSource({ getLatestSnapshot: async () => null }),
    snapshotLog: log,
    watchlist,
    intervalMs: 15_000,
  });

  await ingestor.tick();
  const stats = ingestor.stats();

  /**
   * Two absences for one watched symbol, because the benchmark is polled on
   * every tick regardless of whether anyone holds it - the market-relative
   * signal needs it on the same cadence as everything else.
   */
  assert.equal(stats.absences, 2);
  assert.equal(stats.failures, 0, 'a dropped tick is not an incident');
  assert.equal(log.stats().snapshots, 0, 'and no price was invented to fill it');
});

test('backfill gives a fresh install a past to diff against', async () => {
  const { log, watchlist } = fresh();
  watchlist.add('test-user', 'RELIANCE');

  const ingestor = createIngestor({
    source: stubSource(),
    snapshotLog: log,
    watchlist,
    intervalMs: 15_000,
  });

  const result = await ingestor.backfill({ hours: 1, now: T0 });

  assert.ok(result.written > 0, 'history was reconstructed');
  assert.ok(log.asOf('RELIANCE', T0 - 30 * 60_000), 'and it is queryable half an hour back');
});

// ----------------------------------------------------------------------- API

/** Mount the real router over an in-memory database on an ephemeral port. */
async function withServer(run) {
  const { db, log, watchlist } = fresh();
  const source = stubSource();
  const ingestor = createIngestor({
    source,
    snapshotLog: log,
    watchlist,
    intervalMs: 15_000,
  });

  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ snapshotLog: log, watchlist, source, ingestor }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  try {
    await run({ base, log, watchlist });
  } finally {
    server.close();
    db.close();
  }
}

test('the API supports the whole user journey', async () => {
  await withServer(async ({ base, log }) => {
    const json = async (path, options) => {
      const response = await fetch(base + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return { status: response.status, body: await response.json() };
    };

    // Add, and adding twice is not an error.
    const added = await json('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'reliance' }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.symbol, 'RELIANCE');
    assert.equal((await json('/watchlist', { method: 'POST', body: JSON.stringify({ symbol: 'RELIANCE' }) })).status, 200);

    // A brand-new symbol has no baseline, and the reason is explicit.
    let list = await json('/watchlist');
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].delta.hasBaseline, false);
    assert.equal(list.body.items[0].delta.reason, 'never_viewed');

    // Observe, look, observe again - then the delta appears.
    log.append(snap({ timestamp: Date.now() - 2000, price: 1400 }));
    assert.equal((await json('/watchlist/RELIANCE/viewed', { method: 'POST' })).status, 200);
    log.append(snap({ timestamp: Date.now(), price: 1414 }));

    list = await json('/watchlist');
    const item = list.body.items[0];
    assert.equal(item.delta.hasBaseline, true);
    assert.equal(item.delta.absolute, 14);
    assert.equal(item.delta.percent, 1);

    /**
     * The audit trail behind that number. Asserted on content rather than an
     * exact row count, because adding a symbol also kicks off a poll in the
     * background - so the log legitimately holds that observation too, and
     * pinning the count would make this test fail for a correct app.
     */
    const history = await json('/snapshots/RELIANCE');
    const prices = history.body.snapshots.map((s) => s.price);
    assert.ok(prices.includes(1400), 'the baseline observation is in the log');
    assert.ok(prices.includes(1414), 'so is the one that produced the delta');
    assert.ok(history.body.snapshots.length >= 2);

    // Bad input is a 400, not a 500.
    const bad = await json('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'not a symbol' }),
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /not a valid ticker/);

    // Removing something absent is a 404.
    assert.equal((await json('/watchlist/NOTTHERE', { method: 'DELETE' })).status, 404);
    assert.equal((await json('/watchlist/NOTTHERE/viewed', { method: 'POST' })).status, 404);

    // Meta reports what the app is actually running.
    const meta = await json('/meta');
    assert.equal(meta.body.source.name, 'stub');
    assert.ok(meta.body.log.snapshots >= 2);

    assert.equal((await json('/watchlist/RELIANCE', { method: 'DELETE' })).status, 200);
    assert.equal((await json('/watchlist')).body.items.length, 0);
  });
});
