/**
 * Intraday analysis.
 *
 * The assertions that matter most are the boundaries: that a session number is
 * a session number, that an unavailable metric stays unavailable rather than
 * borrowing from a neighbouring window, and that nothing here is ever phrased
 * as a forecast.
 *
 * Fixed clock, in-memory database, stub source. No network, no wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';
process.env.INGEST_INTERVAL_MS = '15000';
process.env.STALENESS_INTERVALS = '3';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { buildIntraday, resolveWindow, PatternCode } = await import('../src/intraday.js');
const { sessionWindow, SESSION_LENGTH_MS } = await import('../src/freshness.js');
const { BENCHMARK_SYMBOL } = await import('../src/symbols.js');

const MIN = 60_000;
/** Friday 2026-09-04, 14:00 IST - inside the NSE session. */
const MID_SESSION = Date.UTC(2026, 8, 4, 8, 30, 0);
/** Sunday 2026-09-06, 14:30 IST - exchanges shut. */
const WEEKEND = Date.UTC(2026, 8, 6, 9, 0, 0);
const USER = 'test-user';

const PARAMS = {
  barMs: MIN,
  carryForwardBars: 2,
  minBars: 8,
  baselineWindowMs: 6 * 60 * 60_000,
  sectorMap: { STOCK: 'IT', PEER1: 'IT', PEER2: 'IT', LONELY: 'PHARMA' },
  sectorMinPeers: 2,
  benchmarkSymbol: BENCHMARK_SYMBOL,
  minStdDev: 0.0004,
  volatilityTrimShare: 0.1,
  patternVolumeRatio: 1.8,
  patternLargeMoveSigma: 1.5,
  patternSustainedShare: 0.62,
  patternReversalRetrace: 0.6,
  patternReversalMinSwingPct: 0.4,
  patternVolatilityIncrease: 1.6,
  patternDivergencePct: 0.75,
  patternNearExtremeShare: 0.12,
};

const SIM_SOURCE = { name: 'simulator', kind: 'synthetic', alwaysOpen: true, delayMs: 0 };
const REAL_SOURCE = { name: 'yahoo', kind: 'real', alwaysOpen: false, delayMs: 20 * MIN };

function fresh() {
  const db = createDatabase(':memory:');
  return { db, log: createSnapshotLog(db), watchlist: createWatchlist(db) };
}

/** One observation per minute across [endAt - minutes*MIN, endAt]. */
function seed(log, symbol, { minutes, price, volume = () => 1000, endAt }) {
  const rows = [];
  for (let i = minutes; i >= 0; i -= 1) {
    const step = minutes - i;
    const t = endAt - i * MIN;
    rows.push({
      symbol,
      timestamp: t,
      price: price(step),
      volume: volume(step),
      source: 'test',
      confidence: 1,
      ingestedAt: t,
    });
  }
  log.appendMany(rows);
}

const flat = (base) => () => base;
const wobble = (base, amp = 0.0006) => (i) =>
  Math.round(base * (1 + amp * Math.sin(i * 1.7)) * 100) / 100;

const build = ({ log, watchlist }, symbol, { sourceInfo = SIM_SOURCE, now, params = {} } = {}) =>
  buildIntraday({
    snapshotLog: log,
    symbol,
    watchedSymbols: watchlist.list(USER).map((e) => e.symbol),
    engineItem: null,
    sourceInfo,
    params: { ...PARAMS, ...params },
    now,
  });

// ============================================================ the window

test('a real source uses the exchange session and names it', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { minutes: 600, price: wobble(100), endAt: MID_SESSION });

  const result = build(h, 'STOCK', { sourceInfo: REAL_SOURCE, now: MID_SESSION });
  const session = sessionWindow(MID_SESSION);

  assert.equal(result.window.kind, 'session');
  assert.equal(result.window.isSession, true);
  assert.equal(result.window.from, session.sessionOpen, 'starts at 09:15 IST');
  assert.equal(result.window.to, MID_SESSION, 'and runs to now, not to the close');
  assert.equal(result.window.isOpen, true);
  assert.match(result.window.label, /session/i);
});

test('a closed market analyses the last completed session', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { minutes: 300, price: wobble(100), endAt: Date.UTC(2026, 8, 4, 10, 0) });

  const result = build(h, 'STOCK', { sourceInfo: REAL_SOURCE, now: WEEKEND });

  assert.equal(result.window.isOpen, false);
  assert.equal(result.window.complete, true);
  assert.equal(result.window.to, Date.UTC(2026, 8, 4, 10, 0), "Friday's 15:30 IST close");
  assert.match(result.window.label, /last completed session/i);
  // The window is a full session long, not the 48 hours since it ended.
  assert.equal(result.window.lengthMs, SESSION_LENGTH_MS);
});

test('the simulator has no session, and says so rather than inventing one', () => {
  const window = resolveWindow({ sourceInfo: SIM_SOURCE, now: WEEKEND });

  assert.equal(window.kind, 'recent');
  assert.equal(window.isSession, false);
  assert.equal(window.lengthMs, SESSION_LENGTH_MS, 'the equivalent recent window');
  assert.equal(window.to, WEEKEND);
  assert.equal(window.from, WEEKEND - SESSION_LENGTH_MS);

  /**
   * The synthetic market runs continuously - that is why it can be demoed while
   * NSE is shut - so bounding it by an invented open and close would fabricate
   * a boundary the data does not have.
   */
  assert.match(window.note, /no exchange session/i);
  assert.equal(window.sessionOpen, undefined, 'no session boundary is asserted');
});

// ============================================================== the metrics

test('session high, low and return come from the window alone', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');

  /**
   * A deliberate trap: the extreme prices sit OUTSIDE the window. If the
   * analysis reached past its own boundary - into the 1D range, say - it would
   * report 999 as the session high.
   */
  seed(h.log, 'STOCK', {
    minutes: 700,
    price: (i) => (i === 5 ? 999 : i === 10 ? 1 : i === 690 ? 120 : i === 660 ? 80 : 100),
    endAt: MID_SESSION,
  });

  const result = build(h, 'STOCK', { now: MID_SESSION });
  const { high, low, return: ret } = result.metrics;

  assert.equal(high.available, true);
  assert.equal(low.available, true);
  assert.equal(high.price, 120, 'the in-window peak, not the 999 outside it');
  assert.equal(low.price, 80, 'the in-window trough, not the 1 outside it');
  assert.ok(high.timestamp >= result.window.from && high.timestamp <= result.window.to);
  assert.ok(low.timestamp >= result.window.from && low.timestamp <= result.window.to);

  assert.equal(ret.available, true);
  assert.equal(ret.fromTimestamp >= result.window.from, true, 'measured inside the window');
});

test('session return is first to last within the window', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  /**
    * The window is 375 minutes, so with 400 seeded the oldest 25 steps fall
    * OUTSIDE it - a transition there would be invisible, which is exactly what
    * the window boundary is supposed to do. The rise is placed well inside.
    */
  seed(h.log, 'STOCK', {
    minutes: 400,
    price: (i) => (i < 200 ? 100 : 102),
    endAt: MID_SESSION,
  });

  const { return: ret } = build(h, 'STOCK', { now: MID_SESSION }).metrics;

  assert.equal(ret.available, true);
  assert.equal(ret.percent, 2);
  assert.equal(ret.fromPrice, 100);
  assert.equal(ret.toPrice, 102);
});

test('volatility is the window\'s own, with its sample count', () => {
  const h = fresh();
  h.watchlist.add(USER, 'CALM');
  h.watchlist.add(USER, 'WILD');
  seed(h.log, 'CALM', { minutes: 400, price: wobble(100, 0.0004), endAt: MID_SESSION });
  seed(h.log, 'WILD', { minutes: 400, price: wobble(100, 0.02), endAt: MID_SESSION });

  const calm = build(h, 'CALM', { now: MID_SESSION }).metrics.volatility;
  const wild = build(h, 'WILD', { now: MID_SESSION }).metrics.volatility;

  assert.equal(calm.available, true);
  assert.equal(wild.available, true);
  assert.ok(wild.perBarPct > calm.perBarPct * 5, 'the volatile name measures as volatile');
  assert.ok(calm.samples > 10, 'and reports how many intervals it used');
  assert.equal(calm.barMs, MIN);
  assert.ok(Number.isFinite(calm.typicalWindowPct) && Number.isFinite(calm.perBarPct));
  assert.ok(Number.isFinite(calm.robustPerBarPct));
});

test('volume vs normal compares the window with the stretch before it', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');

  // 1000 per bar historically, 3000 per bar inside the window.
  seed(h.log, 'STOCK', {
    minutes: 700,
    price: flat(100),
    volume: (i) => (i > 700 - 376 ? 3000 : 1000),
    endAt: MID_SESSION,
  });

  const { volume } = build(h, 'STOCK', { now: MID_SESSION }).metrics;

  assert.equal(volume.available, true);
  assert.ok(volume.ratio > 2.5, `expected roughly 3x, got ${volume.ratio}`);

  /**
   * "Normal" is named explicitly, and it is the stretch immediately BEFORE the
   * window - never the 1D chart's range and never the user's own horizon.
   */
  assert.equal(volume.baselineTo, build(h, 'STOCK', { now: MID_SESSION }).window.from);
  assert.ok(volume.baselineFrom < volume.baselineTo);
  assert.ok(volume.baselineBars >= PARAMS.minBars);
});

test('missing volume is unavailable, not a ratio of zero', () => {
  const h = fresh();
  h.watchlist.add(USER, 'NOVOL');
  seed(h.log, 'NOVOL', { minutes: 700, price: wobble(100), volume: () => 0, endAt: MID_SESSION });

  const { volume } = build(h, 'NOVOL', { now: MID_SESSION }).metrics;

  assert.equal(volume.available, false);
  assert.equal(volume.reason, 'volume_not_reported');
  assert.equal(volume.ratio, undefined, 'no number is offered');
});

test('market-relative uses the same window for both sides', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { minutes: 400, price: (i) => (i < 200 ? 100 : 103), endAt: MID_SESSION });
  seed(h.log, BENCHMARK_SYMBOL, {
    minutes: 400,
    price: (i) => (i < 200 ? 20_000 : 20_200),
    endAt: MID_SESSION,
  });

  const { vsMarket } = build(h, 'STOCK', { now: MID_SESSION }).metrics;

  assert.equal(vsMarket.available, true);
  assert.equal(vsMarket.benchmarkSymbol, BENCHMARK_SYMBOL);
  assert.equal(vsMarket.symbolReturnPct, 3);
  assert.equal(vsMarket.benchmarkReturnPct, 1);
  assert.equal(vsMarket.excessPct, 2, 'the difference of two same-window returns');
});

test('market-relative is unavailable without a benchmark, never substituted', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { minutes: 400, price: wobble(100), endAt: MID_SESSION });

  const { vsMarket } = build(h, 'STOCK', { now: MID_SESSION }).metrics;

  assert.equal(vsMarket.available, false);
  assert.equal(vsMarket.reason, 'benchmark_no_data_for_window');
  assert.equal(vsMarket.excessPct, undefined);
});

test('sector-relative needs a sector and enough watched peers', () => {
  const h = fresh();
  for (const symbol of ['STOCK', 'PEER1', 'PEER2', 'LONELY', 'NOSECTOR']) {
    h.watchlist.add(USER, symbol);
    seed(h.log, symbol, {
      minutes: 400,
      price: symbol === 'STOCK' ? (i) => (i < 200 ? 100 : 104) : flat(100),
      endAt: MID_SESSION,
    });
  }

  const stock = build(h, 'STOCK', { now: MID_SESSION }).metrics.vsSector;
  assert.equal(stock.available, true);
  assert.equal(stock.sector, 'IT');
  assert.deepEqual(stock.peers.sort(), ['PEER1', 'PEER2']);
  assert.equal(stock.sectorReturnPct, 0, 'the peers were flat');
  assert.equal(stock.excessPct, 4);

  const lonely = build(h, 'LONELY', { now: MID_SESSION }).metrics.vsSector;
  assert.equal(lonely.available, false);
  assert.equal(lonely.reason, 'insufficient_peers');

  const none = build(h, 'NOSECTOR', { now: MID_SESSION }).metrics.vsSector;
  assert.equal(none.available, false);
  assert.equal(none.reason, 'no_sector_mapping');
});

test('insufficient data declines every derived metric', () => {
  const h = fresh();
  h.watchlist.add(USER, 'THIN');
  // Three observations against a minimum of eight bars.
  seed(h.log, 'THIN', { minutes: 2, price: flat(100), endAt: MID_SESSION });

  const result = build(h, 'THIN', { now: MID_SESSION });

  for (const key of ['high', 'low', 'return', 'volatility', 'volume']) {
    assert.equal(result.metrics[key].available, false, `${key} must decline`);
    assert.equal(result.metrics[key].reason, 'insufficient_data');
  }

  /**
   * The current price is still shown - it is an observation, not a statistic -
   * and it reports whether it even falls inside the analysed window.
   */
  assert.equal(result.metrics.currentPrice.available, true);
  assert.equal(result.metrics.currentPrice.price, 100);
  assert.equal(result.metrics.currentPrice.inWindow, true);
  assert.equal(result.patterns.length, 0, 'and no pattern is claimed');
});

test('an observation outside the window is flagged rather than folded in', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');

  // History inside Friday's session, analysed on Sunday with a real source:
  // the newest observation predates the window only if it is older than the
  // session, so here it sits inside. Then add an after-hours print.
  seed(h.log, 'STOCK', { minutes: 300, price: flat(100), endAt: Date.UTC(2026, 8, 4, 10, 0) });
  h.log.append({
    symbol: 'STOCK',
    timestamp: Date.UTC(2026, 8, 5, 6, 0), // Saturday, well after the close
    price: 111,
    volume: 10,
    source: 'test',
    confidence: 1,
    ingestedAt: Date.UTC(2026, 8, 5, 6, 0),
  });

  const result = build(h, 'STOCK', { sourceInfo: REAL_SOURCE, now: WEEKEND });

  assert.equal(result.metrics.currentPrice.price, 111);
  assert.equal(
    result.metrics.currentPrice.inWindow,
    false,
    'the newest print is outside the session, and the panel says so',
  );
  // And the session high is unaffected by it.
  assert.equal(result.metrics.high.price, 100);
});

// ============================================================== the patterns

test('a volume spike is observed where the data supports it', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', {
    minutes: 700,
    price: wobble(100),
    volume: (i) => (i > 700 - 376 ? 4000 : 1000),
    endAt: MID_SESSION,
  });

  const { patterns } = build(h, 'STOCK', { now: MID_SESSION });
  const spike = patterns.find((p) => p.code === PatternCode.VOLUME_SPIKE);

  assert.ok(spike, 'the spike is reported');
  assert.ok(spike.evidence.ratio >= 1.8, 'with the evidence that produced it');
  assert.match(spike.text, /normal volume/i);
});

test('a large move is measured against the window\'s own volatility', () => {
  const h = fresh();
  h.watchlist.add(USER, 'CALMTHENJUMP');
  // Very placid, then a single 3% step: large relative to its own behaviour.
  seed(h.log, 'CALMTHENJUMP', {
    minutes: 400,
    price: (i) => (i < 380 ? 100 : 103),
    endAt: MID_SESSION,
  });

  const { patterns } = build(h, 'CALMTHENJUMP', { now: MID_SESSION });
  const large = patterns.find((p) => p.code === PatternCode.LARGE_MOVEMENT);

  assert.ok(large, 'reported for a placid name moving 3%');
  assert.ok(large.evidence.sigmas >= 1.5);
  /**
   * Judged against the TRIMMED scale, not the realised volatility. Against the
   * latter a single jump scores exactly 1 sigma by construction and could never
   * be reported - see intraday.js.
   */
  assert.ok(large.evidence.typicalWindowPct < Math.abs(large.evidence.returnPct));
});

test('sustained movement is distinguished from a single jump', () => {
  const h = fresh();
  h.watchlist.add(USER, 'GRIND');
  h.watchlist.add(USER, 'JUMP');

  // A steady climb: nearly every interval moves the same way.
  seed(h.log, 'GRIND', {
    minutes: 400,
    price: (i) => Math.round((100 + i * 0.01) * 100) / 100,
    endAt: MID_SESSION,
  });
  // The same total move delivered in one step.
  seed(h.log, 'JUMP', {
    minutes: 400,
    price: (i) => (i < 399 ? 100 : 104),
    endAt: MID_SESSION,
  });

  const grind = build(h, 'GRIND', { now: MID_SESSION }).patterns.map((p) => p.code);
  const jump = build(h, 'JUMP', { now: MID_SESSION }).patterns.map((p) => p.code);

  assert.ok(grind.includes(PatternCode.SUSTAINED_MOVEMENT));
  assert.ok(
    !jump.includes(PatternCode.SUSTAINED_MOVEMENT),
    'one step is not sustained movement',
  );
});

test('a reversal is observed from the extremes and their order', () => {
  const h = fresh();
  h.watchlist.add(USER, 'ROUNDTRIP');

  // Up 3%, then all the way back.
  seed(h.log, 'ROUNDTRIP', {
    minutes: 400,
    price: (i) => (i < 150 ? Math.round((100 + i * 0.02) * 100) / 100 : 100.1),
    endAt: MID_SESSION,
  });

  const { patterns } = build(h, 'ROUNDTRIP', { now: MID_SESSION });
  const reversal = patterns.find((p) => p.code === PatternCode.SUDDEN_REVERSAL);

  assert.ok(reversal, 'the round trip is reported');
  assert.ok(reversal.evidence.swingPct > 0.4);
  assert.match(reversal.text, /gave back|recovered/i);
});

test('volatility increase is only claimed against a prior stretch', () => {
  const h = fresh();
  h.watchlist.add(USER, 'CALMING');

  // Placid history, then a much choppier window.
  seed(h.log, 'CALMING', {
    minutes: 700,
    price: (i) => (i > 700 - 376 ? wobble(100, 0.01)(i) : wobble(100, 0.0002)(i)),
    endAt: MID_SESSION,
  });

  const result = build(h, 'CALMING', { now: MID_SESSION });
  const increase = result.patterns.find((p) => p.code === PatternCode.VOLATILITY_INCREASE);

  assert.ok(increase, 'reported when the prior stretch was calmer');
  assert.ok(result.metrics.volatility.increaseRatio >= 1.6);
  assert.ok(result.metrics.volatility.priorPerBarPct != null, 'with the prior figure alongside');

  // Without a prior stretch there is nothing to compare, so nothing is claimed.
  const short = fresh();
  short.watchlist.add(USER, 'SHORT');
  seed(short.log, 'SHORT', { minutes: 380, price: wobble(100, 0.01), endAt: MID_SESSION });
  const shortResult = build(short, 'SHORT', { now: MID_SESSION });

  assert.equal(shortResult.metrics.volatility.increaseRatio, null);
  assert.ok(
    !shortResult.patterns.some((p) => p.code === PatternCode.VOLATILITY_INCREASE),
    'no baseline, no claim',
  );
});

test('divergence from market and sector are reported separately', () => {
  const h = fresh();
  for (const symbol of ['STOCK', 'PEER1', 'PEER2']) {
    h.watchlist.add(USER, symbol);
    seed(h.log, symbol, {
      minutes: 400,
      price: symbol === 'STOCK' ? (i) => (i < 200 ? 100 : 103) : flat(100),
      endAt: MID_SESSION,
    });
  }
  seed(h.log, BENCHMARK_SYMBOL, { minutes: 400, price: flat(20_000), endAt: MID_SESSION });

  const codes = build(h, 'STOCK', { now: MID_SESSION }).patterns.map((p) => p.code);

  assert.ok(codes.includes(PatternCode.DIVERGENCE_FROM_MARKET));
  assert.ok(codes.includes(PatternCode.DIVERGENCE_FROM_SECTOR));
});

test('near the window high or low, but never both', () => {
  const h = fresh();
  h.watchlist.add(USER, 'ATHIGH');
  seed(h.log, 'ATHIGH', {
    minutes: 400,
    price: (i) => Math.round((100 + i * 0.005) * 100) / 100,
    endAt: MID_SESSION,
  });

  const codes = build(h, 'ATHIGH', { now: MID_SESSION }).patterns.map((p) => p.code);
  assert.ok(codes.includes(PatternCode.NEAR_WINDOW_HIGH));
  assert.ok(!codes.includes(PatternCode.NEAR_WINDOW_LOW));

  // A flat series has no meaningful extreme, so neither is claimed.
  const flatH = fresh();
  flatH.watchlist.add(USER, 'FLAT');
  seed(flatH.log, 'FLAT', { minutes: 400, price: flat(100), endAt: MID_SESSION });
  const flatCodes = build(flatH, 'FLAT', { now: MID_SESSION }).patterns.map((p) => p.code);

  assert.ok(!flatCodes.includes(PatternCode.NEAR_WINDOW_HIGH));
  assert.ok(!flatCodes.includes(PatternCode.NEAR_WINDOW_LOW));
});

// =========================================================== the guarantees

test('nothing in the output is advice or a forecast', () => {
  const h = fresh();
  for (const symbol of ['STOCK', 'PEER1', 'PEER2']) {
    h.watchlist.add(USER, symbol);
    seed(h.log, symbol, {
      minutes: 700,
      price: symbol === 'STOCK' ? (i) => (i < 400 ? 100 : 106) : flat(100),
      volume: (i) => (i > 600 ? 5000 : 1000),
      endAt: MID_SESSION,
    });
  }
  seed(h.log, BENCHMARK_SYMBOL, { minutes: 700, price: flat(20_000), endAt: MID_SESSION });

  const result = build(h, 'STOCK', { now: MID_SESSION });
  const text = [
    result.window.label,
    result.window.note,
    ...result.patterns.map((p) => p.text),
  ]
    .join(' ')
    .toLowerCase();

  assert.ok(result.patterns.length > 0, 'there is output to check');

  for (const forbidden of [
    'buy',
    'sell',
    'hold',
    'target',
    'should',
    'will rise',
    'will fall',
    'expect',
    'forecast',
    'predict',
    'recommend',
    'undervalued',
    'overvalued',
    'opportunity',
  ]) {
    assert.ok(!text.includes(forbidden), `forward-looking or advisory word: "${forbidden}"`);
  }
});

test('engine values are segregated and labelled, not mixed into the session', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { minutes: 400, price: wobble(100), endAt: MID_SESSION });

  const engineItem = {
    level: 'MODERATE',
    needsAttention: true,
    meaningfulScore: 0.55,
    confidence: 0.8,
    dataQuality: 'LIVE',
    freshness: { state: 'live', label: 'Live', ageMs: 3000, isStale: false },
    features: { priceAnomaly: { horizonMs: 15 * MIN } },
  };

  const result = buildIntraday({
    snapshotLog: h.log,
    symbol: 'STOCK',
    watchedSymbols: ['STOCK'],
    engineItem,
    sourceInfo: SIM_SOURCE,
    params: PARAMS,
    now: MID_SESSION,
  });

  /**
   * The attention level, confidence and freshness are the engine's, on the
   * engine's horizon - so they live under `engine` with a note. Presenting them
   * flat beside the session metrics would invite exactly the cross-window
   * confusion this module exists to prevent.
   */
  assert.equal(result.engine.attentionLevel, 'MODERATE');
  assert.equal(result.engine.confidence, 0.8);
  assert.equal(result.engine.freshness.state, 'live');
  assert.match(result.engine.note, /not the session window/i);
  assert.equal(result.engine.anomalyHorizonMs, 15 * MIN);

  // And none of them leaked into the session metrics.
  assert.equal(result.metrics.attentionLevel, undefined);
  assert.equal(result.metrics.confidence, undefined);
  assert.equal(result.metrics.freshness, undefined);
});

test('the session window and the 1D chart give different answers, as they must', async () => {
  const { buildChart, ChartRange } = await import('../src/chart.js');

  const h = fresh();
  h.watchlist.add(USER, 'STOCK');

  /**
   * A price path with its extremes deliberately OUTSIDE the 6h15m window but
   * inside the 24 hours the chart covers. The two features are then asked the
   * same question - "what was the high?" - and must give different answers.
   */
  seed(h.log, 'STOCK', {
    minutes: 900,
    price: (i) => (i === 100 ? 999 : i === 120 ? 11 : i === 800 ? 150 : i === 700 ? 60 : 100),
    endAt: MID_SESSION,
  });

  const intraday = build(h, 'STOCK', { now: MID_SESSION });
  const chart = buildChart({
    snapshotLog: h.log,
    symbol: 'STOCK',
    entry: h.watchlist.get(USER, 'STOCK'),
    rangeKey: ChartRange.ONE_DAY,
    now: MID_SESSION,
  });

  assert.equal(intraday.metrics.high.price, 150, 'the window sees only its own peak');
  assert.equal(intraday.metrics.low.price, 60);
  assert.equal(chart.high.price, 999, 'the 1D range sees the earlier extreme');
  assert.equal(chart.low.price, 11);

  /**
   * The point of the whole module: a session high is a session high. If either
   * feature reached into the other's window these would agree, and a user
   * reading "session high" would be reading a 1D figure.
   */
  assert.notEqual(intraday.metrics.high.price, chart.high.price);
  assert.notEqual(intraday.metrics.low.price, chart.low.price);
  assert.ok(intraday.window.from > chart.range.from, 'and the windows really do differ');
});

test('the analysis is deterministic for a fixed clock', () => {
  const make = () => {
    const h = fresh();
    h.watchlist.add(USER, 'STOCK', MID_SESSION - 86_400_000);
    seed(h.log, 'STOCK', { minutes: 700, price: wobble(100), endAt: MID_SESSION });
    seed(h.log, BENCHMARK_SYMBOL, { minutes: 700, price: wobble(20_000), endAt: MID_SESSION });
    return build(h, 'STOCK', { now: MID_SESSION });
  };

  assert.equal(JSON.stringify(make()), JSON.stringify(make()));
});
