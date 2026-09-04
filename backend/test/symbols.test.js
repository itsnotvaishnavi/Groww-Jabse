/**
 * Symbol identity, and the market factor that makes the relative signals
 * demonstrable at all.
 *
 * No network, no filesystem, no wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SIM_SEED = 'groww-code-2026';
process.env.SIM_GAP_PROBABILITY = '0.03';
process.env.SIM_OUTAGE_PROBABILITY = '0.02';

const { canonicalizeSymbol, isBenchmark, venueOf, BENCHMARK_SYMBOL, ValidationError } =
  await import('../src/symbols.js');
const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { TICK_MS, simulator, __testing: SIM } = await import('../src/sources/simulator.js');
const { toYahooSymbol } = await import('../src/sources/yahoo.js');

// ------------------------------------------------------- P0.0 canonical keys

test('NSE is implied, so every NSE spelling is one instrument', () => {
  for (const spelling of ['RELIANCE', 'reliance', ' Reliance ', 'RELIANCE.NS', 'reliance.ns']) {
    assert.equal(canonicalizeSymbol(spelling), 'RELIANCE', `spelling: "${spelling}"`);
  }
});

test('BSE is a different venue and keeps its suffix', () => {
  for (const spelling of ['RELIANCE.BO', 'reliance.bo', ' Reliance.Bo ']) {
    assert.equal(canonicalizeSymbol(spelling), 'RELIANCE.BO', `spelling: "${spelling}"`);
  }

  // The two are deliberately NOT the same instrument: they trade at different
  // prices on different exchanges.
  assert.notEqual(canonicalizeSymbol('RELIANCE'), canonicalizeSymbol('RELIANCE.BO'));
  assert.equal(venueOf('RELIANCE'), 'NSE');
  assert.equal(venueOf('RELIANCE.BO'), 'BSE');
});

test('the benchmark answers to every name it is known by', () => {
  for (const alias of ['NIFTY', 'nifty', 'NIFTY50', '^NSEI', 'nsei', 'MARKET']) {
    assert.equal(canonicalizeSymbol(alias), BENCHMARK_SYMBOL, `alias: "${alias}"`);
    assert.equal(isBenchmark(alias), true);
  }
  assert.equal(isBenchmark('RELIANCE'), false);
});

test('nonsense is still rejected', () => {
  for (const bad of ['', '   ', 'A B', 'DROP TABLE', 'TOOLONGSYMBOLNAMEHERE', '<script>']) {
    assert.throws(() => canonicalizeSymbol(bad), ValidationError, `should reject "${bad}"`);
  }
  assert.throws(() => canonicalizeSymbol(null), TypeError);
});

test('the log stores canonical keys, so one instrument is one series', () => {
  const db = createDatabase(':memory:');
  const log = createSnapshotLog(db);
  const at = Date.UTC(2026, 8, 4, 5, 0, 0);

  const snap = (symbol, price, offset) => ({
    symbol,
    timestamp: at + offset,
    price,
    volume: 100,
    source: 'test',
    confidence: 1,
  });

  log.append(snap('RELIANCE', 1400, 0));
  log.append(snap('reliance.ns', 1401, 1000));
  log.append(snap('RELIANCE.NS', 1402, 2000));

  /**
   * This is the bug that P0.0 fixed: before canonicalisation these three wrote
   * to three separate keys, so a watchlist entry under any one of them saw a
   * third of its own history.
   */
  assert.equal(log.distinctSymbols().length, 1);
  assert.deepEqual(log.distinctSymbols(), ['RELIANCE']);
  assert.equal(log.history('RELIANCE', { limit: 10 }).length, 3);
  assert.equal(log.latest('reliance.ns').price, 1402, 'any spelling reads the one series');

  // BSE stays separate.
  log.append(snap('RELIANCE.BO', 1405, 0));
  assert.deepEqual(log.distinctSymbols(), ['RELIANCE', 'RELIANCE.BO']);
});

test('a user cannot add the same instrument twice under two spellings', () => {
  const db = createDatabase(':memory:');
  const watchlist = createWatchlist(db);

  assert.equal(watchlist.add('u1', 'RELIANCE').added, true);
  assert.equal(watchlist.add('u1', 'reliance').added, false);
  assert.equal(watchlist.add('u1', 'RELIANCE.NS').added, false);
  assert.equal(watchlist.add('u1', 'reliance.ns').added, false);
  assert.equal(watchlist.list('u1').length, 1);

  // The BSE listing is a genuinely different instrument and is allowed.
  assert.equal(watchlist.add('u1', 'RELIANCE.BO').added, true);
  assert.deepEqual(
    watchlist.list('u1').map((e) => e.symbol),
    ['RELIANCE', 'RELIANCE.BO'],
  );
});

test('the benchmark cannot be added to a watchlist', () => {
  const db = createDatabase(':memory:');
  const watchlist = createWatchlist(db);

  // It is ingested for everyone as the market reference; holding it as a row
  // would make it its own benchmark.
  assert.throws(() => watchlist.add('u1', 'NIFTY'), ValidationError);
  assert.throws(() => watchlist.add('u1', '^NSEI'), ValidationError);
  assert.equal(watchlist.list('u1').length, 0);
});

test('the Yahoo adapter maps canonical keys onto wire symbols', () => {
  assert.equal(toYahooSymbol('RELIANCE'), 'RELIANCE.NS');
  assert.equal(toYahooSymbol('reliance.ns'), 'RELIANCE.NS');
  assert.equal(toYahooSymbol('RELIANCE.BO'), 'RELIANCE.BO');
  assert.equal(toYahooSymbol('NIFTY'), '^NSEI');
  assert.equal(toYahooSymbol('^NSEI'), '^NSEI');
});

// --------------------------------------------------- P0.1 the market factor

const ANCHOR = Date.UTC(2026, 8, 4, 5, 0, 0);

/** 1-minute price series straight from the simulator, no database involved. */
function priceSeries(symbol, count = 300) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const t = ANCHOR + i * 60_000;
    const snapshot = SIM.snapshotForTick(symbol, Math.floor(t / TICK_MS));
    out.push(snapshot ? snapshot.price : null);
  }
  return out;
}

function returnsOf(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i += 1) {
    if (prices[i] == null || prices[i - 1] == null) {
      out.push(null);
      continue;
    }
    out.push(prices[i] / prices[i - 1] - 1);
  }
  return out;
}

function correlation(a, b) {
  const pairs = a.map((x, i) => [x, b[i]]).filter(([x, y]) => x != null && y != null);
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

test('the benchmark is its own addressable series at index level', () => {
  const bench = SIM.snapshotForTick(BENCHMARK_SYMBOL, Math.floor(ANCHOR / TICK_MS));
  assert.ok(bench, 'the benchmark has observations');
  assert.ok(bench.price > 15_000 && bench.price < 40_000, `index level, got ${bench.price}`);
  assert.equal(bench.symbol, BENCHMARK_SYMBOL);

  // And it is still deterministic and randomly addressable.
  assert.deepEqual(bench, SIM.snapshotForTick(BENCHMARK_SYMBOL, Math.floor(ANCHOR / TICK_MS)));
});

test('betas are fixed per symbol and in a plausible range', () => {
  const base = SIM.seedHash();
  const betas = new Map();

  for (const { symbol } of SIM.UNIVERSE) {
    const beta = SIM.betaFor(symbol, base);
    assert.ok(beta >= 0.6 && beta <= 1.5, `${symbol} beta out of range: ${beta}`);
    assert.equal(beta, SIM.betaFor(symbol, base), 'beta is stable');
    betas.set(symbol, beta);
  }

  // Not every symbol may share one beta, or there would be no dispersion to
  // distinguish a market move from a stock-specific one.
  assert.ok(new Set([...betas.values()].map((b) => b.toFixed(2))).size > 3);
});

test('symbols now share a market component instead of being independent', () => {
  const marketReturns = returnsOf(priceSeries(BENCHMARK_SYMBOL));

  const correlations = SIM.UNIVERSE.map(({ symbol }) =>
    correlation(returnsOf(priceSeries(symbol)), marketReturns),
  );

  /**
   * Before the market factor every one of these was ~0 by construction, which
   * made "the whole market moved together" impossible to generate and the
   * market-relative signal impossible to demonstrate on a closed-market
   * weekend. They must now be materially positive on average.
   */
  const meanCorrelation = correlations.reduce((s, c) => s + c, 0) / correlations.length;
  assert.ok(meanCorrelation > 0.3, `expected shared market component, got ${meanCorrelation}`);

  // But not perfectly correlated, or there would be no idiosyncratic signal.
  assert.ok(meanCorrelation < 0.95, `expected idiosyncratic variance too, got ${meanCorrelation}`);
});

test('the simulator schedules a price shock and a volume shock on different symbols', () => {
  const base = SIM.seedHash();
  const events = SIM.eventSymbols(base);

  assert.notEqual(
    events.priceShock,
    events.volumeShock,
    'a volume spike on a modest price move must be a distinct case',
  );
  assert.deepEqual(events, SIM.eventSymbols(base), 'event assignment is deterministic');

  // Find the peak of each event window within a period.
  const peakOf = (key) => {
    let best = { pulse: -1, t: null };
    for (let i = 0; i < 4000; i += 1) {
      const t = ANCHOR + i * TICK_MS;
      const pulse = SIM.eventPulse(t, base, key);
      if (pulse > best.pulse) best = { pulse, t };
    }
    return best;
  };

  const pricePeak = peakOf('price');
  assert.ok(pricePeak.pulse > 0.95, 'a price event occurs within any recent window');

  // The shocked symbol moves far more over the event than just before it.
  const priceAt = (symbol, t) => SIM.snapshotForTick(symbol, Math.floor(t / TICK_MS))?.price;
  const before = priceAt(events.priceShock, pricePeak.t - 4 * 60_000);
  const at = priceAt(events.priceShock, pricePeak.t);
  assert.ok(before && at, 'both observations exist');
  const move = Math.abs(at / before - 1);
  assert.ok(move > 0.015, `expected a large idiosyncratic move, got ${(move * 100).toFixed(2)}%`);

  const volumePeak = peakOf('volume');
  const volumeAt = (symbol, t) => SIM.snapshotForTick(symbol, Math.floor(t / TICK_MS))?.volume;
  const quiet = volumeAt(events.volumeShock, volumePeak.t - 6 * 60_000);
  const spike = volumeAt(events.volumeShock, volumePeak.t);
  assert.ok(quiet && spike, 'both observations exist');
  assert.ok(spike / quiet > 2, `expected a volume spike, got ${(spike / quiet).toFixed(2)}x`);
});

test('the market factor did not cost the simulator its other guarantees', () => {
  // Still gapping.
  let gaps = 0;
  for (let i = 0; i < 3000; i += 1) {
    if (!SIM.snapshotForTick('SBIN', Math.floor(ANCHOR / TICK_MS) + i)) gaps += 1;
  }
  assert.ok(gaps > 20 && gaps < 900, `gaps still occur: ${gaps}`);

  // Still O(1) into the distant past.
  const startedAt = process.hrtime.bigint();
  simulator.getSnapshotAt('INFY', ANCHOR - 10 * 365 * 86_400_000);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 50, `still O(1) addressable, took ${elapsedMs.toFixed(2)}ms`);

  // Still in a believable band.
  for (let i = 0; i < 500; i += 1) {
    const snapshot = SIM.snapshotForTick('RELIANCE', Math.floor(ANCHOR / TICK_MS) + i * 40);
    if (!snapshot) continue;
    assert.ok(
      snapshot.price > 1420 * 0.6 && snapshot.price < 1420 * 1.4,
      `implausible price ${snapshot.price}`,
    );
  }
});
