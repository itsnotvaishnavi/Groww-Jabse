/**
 * The Meaningful Change Engine: scoring mechanics, missing-signal
 * renormalisation, numerical safety, and data-quality passthrough.
 *
 * Every test runs against an in-memory database, a stub source and a FIXED
 * clock. Nothing here touches the network, the filesystem or the wall clock -
 * which is what makes the determinism claim checkable rather than rhetorical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';
process.env.INGEST_INTERVAL_MS = '15000';
process.env.STALENESS_INTERVALS = '3';
process.env.CONFLICT_TOLERANCE_PCT = '0.5';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createEngine, rank } = await import('../src/engine/index.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { Level } = await import('../src/engine/score.js');
const { assertAllFinite, zScore, stdDev, safeDiv, normalizeMagnitude, saturatingMagnitude } =
  await import('../src/engine/numeric.js');
const { createSummaryService } = await import('../src/summary.js');
const { BENCHMARK_SYMBOL } = await import('../src/symbols.js');

/** Friday 2026-09-04 10:30 IST - inside the NSE session, and a whole minute. */
const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const BAR = 60_000;
const USER = 'test-user';

/**
 * Engine parameters used by every test here.
 *
 * The anomaly horizon is set to exactly one bar so the "current return" under
 * test is a single, hand-checkable bar-to-bar return rather than a 15-bar
 * compound. Everything else is left at production defaults.
 */
const OVERRIDES = { barMs: BAR, anomalyHorizonMs: BAR, carryForwardBars: 2 };

/** A source with no delay that never closes: freshness depends only on age. */
const synthSource = (over = {}) => ({
  name: 'test',
  describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0, ...over }),
});

function harness({ overrides = {}, source = synthSource(), now = T0 } = {}) {
  const db = createDatabase(':memory:');
  const log = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);

  const engine = createEngine({
    snapshotLog: log,
    watchlist,
    surfacedStore,
    source,
    // A fixed clock. Every "now" in the engine arrives through this.
    clock: () => now,
    overrides: { ...OVERRIDES, ...overrides },
  });

  return { db, log, watchlist, surfacedStore, engine, now };
}

/**
 * Write a deterministic price/volume path ending at `endAt`.
 *
 * `ingestedAt` is set explicitly rather than defaulting to Date.now, or the
 * output would embed a real wall-clock value and the byte-identical
 * determinism test could never pass.
 */
function seed(log, symbol, { bars = 150, price, volume = () => 1000, endAt = T0, source = 'test', confidence = 1 }) {
  const rows = [];
  for (let i = bars; i >= 0; i -= 1) {
    const step = bars - i;
    const t = endAt - i * BAR;
    rows.push({
      symbol,
      timestamp: t,
      price: price(step, t),
      volume: volume(step, t),
      source,
      confidence,
      ingestedAt: t,
    });
  }
  log.appendMany(rows);
  return rows;
}

/** A calm, non-degenerate path: small returns with a real, non-zero spread. */
const calm = (base) => (i) =>
  Math.round(base * (1 + 0.0004 * Math.sin(i * 2.3) + 0.0002 * Math.cos(i * 5.1)) * 100) / 100;

/** The same path, but the final bar jumps by `pct`. */
const calmThenJump = (base, pct, bars = 150) => (i) =>
  i === bars ? Math.round(base * (1 + pct) * 100) / 100 : calm(base)(i);

const itemFor = (evaluation, symbol) => evaluation.items.find((i) => i.symbol === symbol);

// =============================================================== the signals

test('an unusual move scores far above an ordinary one', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'CALM');
  watchlist.add(USER, 'JUMPY');

  seed(log, 'CALM', { price: calm(100) });
  seed(log, 'JUMPY', { price: calmThenJump(100, 0.02) });

  const evaluation = engine.evaluate({ userId: USER });
  const quiet = itemFor(evaluation, 'CALM');
  const jumpy = itemFor(evaluation, 'JUMPY');

  assert.equal(quiet.features.priceAnomaly.available, true);
  assert.equal(jumpy.features.priceAnomaly.available, true);

  // The point of the z-score: both moved, only one moved unusually FOR ITSELF.
  assert.ok(
    Math.abs(jumpy.features.priceAnomaly.z) > 5,
    `jump should be extreme, got ${jumpy.features.priceAnomaly.z}`,
  );
  assert.ok(
    Math.abs(quiet.features.priceAnomaly.z) < 3,
    `calm should be ordinary, got ${quiet.features.priceAnomaly.z}`,
  );
  assert.ok(jumpy.meaningfulScore > quiet.meaningfulScore);
  assert.ok(jumpy.reasons.includes('unusual_price_movement'));
  assert.ok(!quiet.reasons.includes('unusual_price_movement'));
});

test('a volume spike on a small price move is caught on its own', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'QUIETPRICE');

  // Price does nothing remarkable; the last bar trades at 4x normal volume.
  seed(log, 'QUIETPRICE', {
    price: calm(100),
    volume: (i) => (i === 150 ? 4000 : 1000),
  });

  const item = itemFor(engine.evaluate({ userId: USER }), 'QUIETPRICE');

  assert.equal(item.features.volumeAnomaly.available, true);
  assert.ok(
    item.features.volumeAnomaly.ratio > 3.5,
    `expected ~4x, got ${item.features.volumeAnomaly.ratio}`,
  );
  assert.ok(item.reasons.includes('high_volume'));
  assert.ok(
    !item.reasons.includes('unusual_price_movement'),
    'the price did nothing worth reporting',
  );
  assert.ok(item.meaningfulScore > 0.2, 'volume alone is a real signal');
});

test('a large move on normal volume is caught without a volume claim', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'BIGMOVE');

  seed(log, 'BIGMOVE', { price: calmThenJump(100, 0.02), volume: () => 1000 });

  const item = itemFor(engine.evaluate({ userId: USER }), 'BIGMOVE');

  assert.ok(item.reasons.includes('unusual_price_movement'));
  assert.equal(item.features.volumeAnomaly.available, true);
  assert.ok(Math.abs(item.features.volumeAnomaly.ratio - 1) < 0.01, 'volume was normal');
  assert.ok(!item.reasons.includes('high_volume'), 'and is not claimed to be high');
});

test('a market-wide move scores lower than the same move alone', () => {
  // Case 1: the stock jumps 2% and the market is flat.
  const alone = harness();
  alone.watchlist.add(USER, 'STOCK');
  seed(alone.log, 'STOCK', { price: calmThenJump(100, 0.02) });
  seed(alone.log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  const idiosyncratic = itemFor(alone.engine.evaluate({ userId: USER }), 'STOCK');

  // Case 2: the stock jumps 2% and so does the whole market.
  const together = harness();
  together.watchlist.add(USER, 'STOCK');
  seed(together.log, 'STOCK', { price: calmThenJump(100, 0.02) });
  seed(together.log, BENCHMARK_SYMBOL, { price: calmThenJump(20_000, 0.02) });
  const marketWide = itemFor(together.engine.evaluate({ userId: USER }), 'STOCK');

  // The stock's own move is identical in both. Only the context differs.
  assert.equal(
    idiosyncratic.features.priceAnomaly.z,
    marketWide.features.priceAnomaly.z,
    'same stock-level move',
  );

  assert.ok(
    Math.abs(marketWide.features.marketRelative.excessPct) < 0.1,
    `market-wide: no excess, got ${marketWide.features.marketRelative.excessPct}`,
  );
  assert.ok(
    idiosyncratic.features.marketRelative.excessPct > 1,
    `alone: real outperformance, got ${idiosyncratic.features.marketRelative.excessPct}`,
  );

  /**
   * The headline assertion of the whole engine: "everything went up" is not
   * news about any one stock.
   */
  assert.ok(
    marketWide.meaningfulScore < idiosyncratic.meaningfulScore,
    `market-wide ${marketWide.meaningfulScore} should be < alone ${idiosyncratic.meaningfulScore}`,
  );
  assert.ok(marketWide.reasons.includes('moved_with_market'));
  assert.ok(idiosyncratic.reasons.includes('market_outperformance'));
});

test('sector-relative needs a sector and enough watched peers', () => {
  const sectorMap = { AAA: 'IT', BBB: 'IT', CCC: 'IT', LONELY: 'PHARMA' };
  const { log, watchlist, engine } = harness({ overrides: { sectorMap, sectorMinPeers: 2 } });

  for (const symbol of ['AAA', 'BBB', 'CCC', 'LONELY', 'NOSECTOR']) {
    watchlist.add(USER, symbol);
    seed(log, symbol, { price: calm(100) });
  }

  const evaluation = engine.evaluate({ userId: USER });

  // Three watched IT names: each has two peers, which is the floor.
  const aaa = itemFor(evaluation, 'AAA');
  assert.equal(aaa.features.sectorRelative.available, true);
  assert.equal(aaa.features.sectorRelative.sector, 'IT');
  assert.deepEqual(aaa.features.sectorRelative.peers.sort(), ['BBB', 'CCC']);

  // One watched pharma name has no peers at all.
  assert.equal(itemFor(evaluation, 'LONELY').features.sectorRelative.available, false);
  assert.equal(
    itemFor(evaluation, 'LONELY').features.sectorRelative.reason,
    'insufficient_peers',
  );

  // A symbol absent from the map has no sector, and none is invented for it.
  const nosector = itemFor(evaluation, 'NOSECTOR');
  assert.equal(nosector.features.sectorRelative.available, false);
  assert.equal(nosector.features.sectorRelative.reason, 'no_sector_mapping');
  assert.equal(nosector.sector, null);
});

// ================================================= renormalisation (P0.5)

/** Recompute the score by hand from the breakdown, as the spec describes it. */
function handComputedScore(item) {
  let weighted = 0;
  let availableWeight = 0;
  for (const entry of Object.values(item.scoreBreakdown)) {
    if (!entry.available) continue;
    weighted += entry.weight * entry.contribution;
    availableWeight += entry.weight;
  }
  return availableWeight > 0 ? weighted / availableWeight : 0;
}

test('a missing signal is renormalised away, never scored as a zero', () => {
  // No benchmark and no sector: only price and volume are available.
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'ORPHAN');
  seed(log, 'ORPHAN', { price: calmThenJump(100, 0.02) });

  const item = itemFor(engine.evaluate({ userId: USER }), 'ORPHAN');

  assert.equal(item.features.marketRelative.available, false);
  assert.equal(item.features.marketRelative.reason, 'benchmark_unavailable');
  assert.equal(item.features.sectorRelative.available, false);

  // 0.35 (price) + 0.25 (volume) = 0.60 of the total weight is measurable.
  assert.equal(item.availableWeight, 0.6);

  /**
   * The published breakdown must reproduce the published score. The tolerance
   * is the score's own rounding (4 decimal places) and nothing more - if this
   * ever needs loosening, the audit trail has stopped being checkable.
   */
  assert.ok(
    Math.abs(item.meaningfulScore - handComputedScore(item)) < 1e-4,
    `breakdown recomputes to ${handComputedScore(item)}, score is ${item.meaningfulScore}`,
  );

  /**
   * The failure this guards against: dividing by the FULL weight instead of
   * the available weight. A 2% jump with no benchmark and no sector would then
   * be capped at 60% of the score it earns, and every unsectored symbol would
   * be permanently under-reported.
   */
  const naive =
    item.scoreBreakdown.priceAnomaly.weighted + item.scoreBreakdown.volumeAnomaly.weighted;
  assert.ok(
    item.meaningfulScore > naive,
    `renormalised ${item.meaningfulScore} must exceed un-renormalised ${naive}`,
  );
});

test('each missing signal removes exactly its own weight', () => {
  const sectorMap = { AAA: 'IT', BBB: 'IT', CCC: 'IT' };

  // Everything available: all four signals.
  const full = harness({ overrides: { sectorMap } });
  for (const s of ['AAA', 'BBB', 'CCC']) {
    full.watchlist.add(USER, s);
    seed(full.log, s, { price: calm(100) });
  }
  seed(full.log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  assert.equal(itemFor(full.engine.evaluate({ userId: USER }), 'AAA').availableWeight, 1);

  // Sector missing -> 1.00 - 0.20 = 0.80.
  const noSector = harness({ overrides: { sectorMap: {} } });
  noSector.watchlist.add(USER, 'AAA');
  seed(noSector.log, 'AAA', { price: calm(100) });
  seed(noSector.log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  assert.equal(itemFor(noSector.engine.evaluate({ userId: USER }), 'AAA').availableWeight, 0.8);

  // Market missing -> 1.00 - 0.20 = 0.80.
  const noMarket = harness({ overrides: { sectorMap } });
  for (const s of ['AAA', 'BBB', 'CCC']) {
    noMarket.watchlist.add(USER, s);
    seed(noMarket.log, s, { price: calm(100) });
  }
  assert.equal(itemFor(noMarket.engine.evaluate({ userId: USER }), 'AAA').availableWeight, 0.8);

  // Volume missing -> 1.00 - 0.25 = 0.75.
  const noVolume = harness({ overrides: { sectorMap } });
  for (const s of ['AAA', 'BBB', 'CCC']) {
    noVolume.watchlist.add(USER, s);
    seed(noVolume.log, s, { price: calm(100), volume: () => 0 });
  }
  seed(noVolume.log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  const volumeless = itemFor(noVolume.engine.evaluate({ userId: USER }), 'AAA');
  assert.equal(volumeless.features.volumeAnomaly.available, false);
  assert.equal(volumeless.features.volumeAnomaly.reason, 'volume_not_reported');
  assert.equal(volumeless.availableWeight, 0.75);
});

test('missing volume is unavailable, not a collapse to zero volume', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'NOVOL');
  seed(log, 'NOVOL', { price: calm(100), volume: () => 0 });

  const item = itemFor(engine.evaluate({ userId: USER }), 'NOVOL');

  assert.equal(item.features.volumeAnomaly.available, false);
  /**
   * If missing volume were treated as zero, the ratio would be 0 - which reads
   * as a dramatic collapse in trading activity, i.e. a signal, invented out of
   * an absence of data.
   */
  assert.equal(item.features.volumeAnomaly.ratio, undefined);
  assert.ok(!item.reasons.includes('high_volume'));
});

test('no signal at all is a zero score that says so', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'BARELY');
  // Two observations: not enough for any statistic.
  seed(log, 'BARELY', { bars: 1, price: () => 100, volume: () => 0 });

  const item = itemFor(engine.evaluate({ userId: USER }), 'BARELY');

  assert.equal(item.meaningfulScore, 0);
  assert.equal(item.level, Level.LOW);
  assert.equal(item.availableWeight, 0);
  // Zero score AND zero available weight: "nothing measurable" is
  // distinguishable from "measured, and calm".
  assert.equal(item.confidence, 0);
});

// ============================================ numerical safety (P0.4)

test('insufficient history is unavailable rather than a z-score from noise', () => {
  const { log, watchlist, engine } = harness({ overrides: { minReturns: 20 } });
  watchlist.add(USER, 'THIN');
  seed(log, 'THIN', { bars: 5, price: calm(100) });

  const item = itemFor(engine.evaluate({ userId: USER }), 'THIN');

  assert.equal(item.features.priceAnomaly.available, false);
  assert.equal(item.features.priceAnomaly.reason, 'insufficient_history');
  assert.ok(item.features.priceAnomaly.sampleSize < 20);
  assert.equal(item.features.priceAnomaly.z, undefined, 'no number is offered');
});

test('zero volatility does not divide by zero', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'FROZEN');
  // Literally never moves: standard deviation is exactly zero.
  seed(log, 'FROZEN', { price: () => 100 });

  const item = itemFor(engine.evaluate({ userId: USER }), 'FROZEN');
  const anomaly = item.features.priceAnomaly;

  assert.equal(anomaly.available, true);
  assert.equal(anomaly.baselineStdDevPct, 0);
  assert.equal(anomaly.flooredStdDev, true, 'the floor was applied and is reported');
  assert.equal(anomaly.z, 0, 'no move against no volatility is not an anomaly');
  assert.ok(Number.isFinite(anomaly.z));
  assert.ok(Number.isFinite(item.meaningfulScore));
});

test('near-zero volatility is floored and clamped, and lowers confidence', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'STIFF');

  /**
   * Flat for the entire window, then one paisa of movement. Without a floor
   * this is the classic blow-up: a tiny numerator over a vanishing denominator
   * produces a z-score in the thousands and dominates the score.
   */
  seed(log, 'STIFF', { price: (i) => (i === 150 ? 100.01 : 100) });

  const item = itemFor(engine.evaluate({ userId: USER }), 'STIFF');
  const anomaly = item.features.priceAnomaly;

  assert.equal(anomaly.flooredStdDev, true);
  assert.ok(Math.abs(anomaly.z) <= 6, `z must be clamped, got ${anomaly.z}`);
  assert.ok(Number.isFinite(anomaly.z));

  // Halved because the statistics were not trustworthy, not because the
  // arithmetic failed.
  assert.ok(anomaly.confidence <= 0.5, `confidence should be reduced, got ${anomaly.confidence}`);
});

test('the numeric primitives refuse to produce NaN or Infinity', () => {
  assert.equal(safeDiv(1, 0), null, 'division by zero has no answer, not Infinity');
  assert.equal(safeDiv(0, 0), null);
  assert.equal(safeDiv(NaN, 1), null);
  /**
   * 1/Infinity is 0 in arithmetic, but Infinity is not a real measurement -
   * it can only have arrived from an earlier failure. Refusing it stops a
   * corrupted upstream value from laundering itself into a plausible 0.
   */
  assert.equal(safeDiv(1, Infinity), null);

  assert.equal(stdDev([]), null);
  assert.equal(stdDev([5]), null, 'one sample has no spread');
  assert.equal(stdDev([5, 5, 5]), 0);

  // The blow-up case, guarded.
  const scored = zScore(0.5, { mean: 0, stdDev: 0 }, { minStdDev: 0.0004, clamp: 6 });
  assert.ok(Number.isFinite(scored.z));
  assert.equal(scored.z, 6, 'clamped, not astronomical');
  assert.equal(scored.flooredStdDev, true);

  for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'x']) {
    assert.ok(Number.isFinite(normalizeMagnitude(bad, 3)), `normalizeMagnitude(${bad})`);
    const z = zScore(bad, { mean: 0, stdDev: 1 }, { minStdDev: 0.0004, clamp: 6 });
    assert.ok(Number.isFinite(z.z), `zScore(${bad})`);
  }
});

test('adversarial histories never produce a non-finite number anywhere', () => {
  const cases = {
    SINGLE: { bars: 0, price: () => 100, volume: () => 0 },
    FLAT: { bars: 150, price: () => 100, volume: () => 1000 },
    ZEROVOL: { bars: 150, price: calm(100), volume: () => 0 },
    HUGEJUMP: { bars: 150, price: (i) => (i === 150 ? 1e6 : 100), volume: () => 1000 },
    TINYPRICE: { bars: 150, price: () => 0.01, volume: () => 1 },
    HUGEVOLUME: { bars: 150, price: calm(100), volume: (i) => (i === 150 ? 1e12 : 1) },
    ONEPAISA: { bars: 150, price: (i) => (i % 2 === 0 ? 100 : 100.01), volume: () => 1000 },
  };

  const { log, watchlist, engine } = harness();
  for (const [symbol, spec] of Object.entries(cases)) {
    watchlist.add(USER, symbol);
    seed(log, symbol, spec);
  }

  const evaluation = engine.evaluate({ userId: USER });

  // The engine already asserts this internally; asserting it again here is the
  // point - this is the promise, and it is enforced mechanically.
  assert.doesNotThrow(() => assertAllFinite(evaluation.items));

  for (const item of evaluation.items) {
    assert.ok(Number.isFinite(item.meaningfulScore), `${item.symbol} score`);
    assert.ok(item.meaningfulScore >= 0 && item.meaningfulScore <= 1, `${item.symbol} in range`);
    assert.ok(Number.isFinite(item.confidence), `${item.symbol} confidence`);
    assert.ok(item.confidence >= 0 && item.confidence <= 1, `${item.symbol} confidence range`);
    assert.ok(['LOW', 'MODERATE', 'HIGH'].includes(item.level), `${item.symbol} level`);
  }
});

/**
 * THE PRESENTATION GROUPS ARE A VIEW, NOT A SECOND ENGINE.
 *
 * Every assertion here is about which bucket a row is reported in. None of
 * them may change a score or a level - that is the whole premise of the
 * grouping, and the last assertion checks it directly.
 */
test('rows are grouped by the engine, and grouping changes no score', () => {
  const { log, watchlist, engine } = harness();

  // A big move on heavy volume: over the attention bar.
  watchlist.add(USER, 'LOUD');
  seed(log, 'LOUD', {
    price: calmThenJump(100, 0.05),
    volume: (i) => (i >= 148 ? 9_000 : 1_000),
  });

  // A calm stock, marked seen: measured, and nothing to report.
  watchlist.add(USER, 'QUIET');
  seed(log, 'QUIET', { price: calm(100) });

  // Never marked seen: no baseline, so no comparison exists.
  watchlist.add(USER, 'UNSEEN');
  seed(log, 'UNSEEN', { price: calm(200) });

  watchlist.markViewed(USER, 'LOUD', T0 - 30 * BAR);
  watchlist.markViewed(USER, 'QUIET', T0 - 30 * BAR);

  const evaluation = engine.evaluate({ userId: USER, now: T0 });
  const group = (symbol) => itemFor(evaluation, symbol).attentionGroup;

  assert.equal(group('LOUD'), 'needs_attention');
  assert.equal(group('QUIET'), 'stable');

  /**
   * The one that matters most. A symbol with no baseline must never be filed
   * as stable: "stable" reports a measurement, and for this row no measurement
   * was made. Reporting it as stable would be the app inventing a comparison.
   */
  assert.equal(group('UNSEEN'), 'unseen');
  assert.equal(itemFor(evaluation, 'UNSEEN').changeSinceViewed.available, false);

  // Groups partition the watchlist: every row lands in exactly one.
  const counts = {};
  for (const item of evaluation.items) counts[item.attentionGroup] = 1 + (counts[item.attentionGroup] ?? 0);
  assert.equal(
    Object.values(counts).reduce((a, b) => a + b, 0),
    evaluation.items.length,
  );

  // And the group agrees with the field the banner and chip already read.
  for (const item of evaluation.items) {
    assert.equal(
      item.needsAttention,
      item.attentionGroup === 'needs_attention',
      `${item.symbol}: needsAttention and the group must not disagree`,
    );
  }
});

test('the meaningful group is real movement that did not reach the bar', () => {
  const { log, watchlist, engine } = harness();

  /**
   * A move large enough that the level floor's "nothing notable" test does not
   * fire, but not large enough to be scored MODERATE. This is the group an
   * ordinary percentage-change watchlist cannot express, so it is asserted to
   * exist rather than assumed.
   */
  watchlist.add(USER, 'MILD');
  seed(log, 'MILD', { price: calmThenJump(100, 0.001) });
  watchlist.markViewed(USER, 'MILD', T0 - 30 * BAR);

  const item = itemFor(engine.evaluate({ userId: USER, now: T0 }), 'MILD');

  assert.equal(item.needsAttention, false, 'below the attention bar');
  assert.equal(item.level, Level.LOW);
  assert.equal(item.attentionGroup, 'meaningful', 'but not nothing, so not stable');
  assert.ok(item.meaningfulScore > 0, 'and it scored something');

  /**
   * The reason it is not stable: its own move is well clear of the floor's
   * negligibility threshold. Asserted so the test fails loudly if the group
   * ever starts being decided by something other than that test.
   */
  assert.ok(
    Math.abs(item.features.priceAnomaly.z) > engine.params().levelFloorMinZ,
    'the stock did move notably for itself',
  );
});

test('levels are absolute, not a ranking within the watchlist', () => {
  const withOne = harness();
  withOne.watchlist.add(USER, 'STOCK');
  seed(withOne.log, 'STOCK', { price: calmThenJump(100, 0.02) });
  const alone = itemFor(withOne.engine.evaluate({ userId: USER }), 'STOCK');

  // The same stock, in a watchlist that also holds a far more dramatic one.
  const withTwo = harness();
  withTwo.watchlist.add(USER, 'STOCK');
  withTwo.watchlist.add(USER, 'WILD');
  seed(withTwo.log, 'STOCK', { price: calmThenJump(100, 0.02) });
  seed(withTwo.log, 'WILD', {
    price: calmThenJump(100, 0.25),
    volume: (i) => (i === 150 ? 50_000 : 1000),
  });
  const alongside = itemFor(withTwo.engine.evaluate({ userId: USER }), 'STOCK');

  /**
   * Under percentile ranking, adding WILD would demote STOCK - its label would
   * describe the watchlist rather than the instrument, and the surfaced-signal
   * fingerprint would churn every time the list changed.
   */
  assert.equal(alone.meaningfulScore, alongside.meaningfulScore);
  assert.equal(alone.level, alongside.level);
});

// ==================================== data quality flows through (P0.13)

test('stale data lowers confidence and is labelled, not hidden', () => {
  const fresh = harness();
  fresh.watchlist.add(USER, 'STOCK');
  seed(fresh.log, 'STOCK', { price: calmThenJump(100, 0.02) });
  const live = itemFor(fresh.engine.evaluate({ userId: USER }), 'STOCK');

  // Identical history, but it stops ten minutes before "now".
  const old = harness();
  old.watchlist.add(USER, 'STOCK');
  seed(old.log, 'STOCK', { price: calmThenJump(100, 0.02), endAt: T0 - 10 * 60_000 });
  const stale = itemFor(old.engine.evaluate({ userId: USER }), 'STOCK');

  assert.equal(live.dataQuality, 'LIVE');
  assert.equal(stale.dataQuality, 'STALE');
  assert.equal(stale.freshness.isStale, true);
  assert.ok(
    stale.confidence < live.confidence,
    `stale ${stale.confidence} should be under live ${live.confidence}`,
  );
  assert.equal(stale.confidenceComponents.freshness, 0.5);
});

test('a delayed source is reflected in confidence without being called stale', () => {
  const delayed = harness({
    source: synthSource({ alwaysOpen: true, delayMs: 20 * 60_000 }),
  });
  delayed.watchlist.add(USER, 'STOCK');
  seed(delayed.log, 'STOCK', { price: calm(100), confidence: 0.6 });

  const item = itemFor(delayed.engine.evaluate({ userId: USER }), 'STOCK');

  assert.equal(item.freshness.isStale, false);
  // The source's own confidence in each observation propagates into the score's.
  assert.equal(item.confidenceComponents.observation, 0.6);
  assert.ok(item.confidence < 0.7);
});

test('a closed market is not treated as a failure', () => {
  // A real source, evaluated on the Sunday of the build weekend, with history
  // ending at Friday's close.
  const sunday = Date.UTC(2026, 8, 6, 9, 0, 0);
  const fridayClose = Date.UTC(2026, 8, 4, 10, 0, 0);

  const { log, watchlist, engine } = harness({
    source: synthSource({ kind: 'real', alwaysOpen: false, delayMs: 20 * 60_000 }),
    now: sunday,
  });
  watchlist.add(USER, 'STOCK');
  seed(log, 'STOCK', { price: calm(100), endAt: fridayClose });

  const item = itemFor(engine.evaluate({ userId: USER, now: sunday }), 'STOCK');

  assert.equal(item.dataQuality, 'MARKET_CLOSED');
  assert.equal(item.freshness.isStale, false);
  assert.equal(item.confidenceComponents.freshness, 0.85);
});

test('a source conflict is reported alongside the score', () => {
  const { log, watchlist, engine } = harness();
  watchlist.add(USER, 'DISPUTED');

  seed(log, 'DISPUTED', { price: calm(100), source: 'alpha' });
  // A second source, seconds apart, disagreeing by ~3%.
  log.append({
    symbol: 'DISPUTED',
    timestamp: T0 - 2000,
    price: 103,
    volume: 1000,
    source: 'beta',
    confidence: 0.6,
    ingestedAt: T0 - 2000,
  });

  const item = itemFor(engine.evaluate({ userId: USER }), 'DISPUTED');

  assert.ok(item.conflict, 'the disagreement is surfaced, not silently resolved');
  assert.ok(item.conflict.spreadPct > 0.5);
  assert.deepEqual(item.conflict.observations.map((o) => o.source).sort(), ['alpha', 'beta']);
  assert.ok(Number.isFinite(item.meaningfulScore), 'and the score is still computed');
});

// ============================================ the four fixes (P0 follow-up)

test('relative contributions scale with the excess instead of saturating', () => {
  // The bug: a clamped mapping gave 1.0 to everything past the reference, so
  // these two were indistinguishable.
  const small = saturatingMagnitude(2.08, 1.5);
  const large = saturatingMagnitude(20, 1.5);

  assert.ok(small < large, `-2.08% (${small}) must contribute less than -20% (${large})`);
  assert.ok(small < 0.7, `2.08% should not be near-maximal, got ${small}`);
  assert.ok(large > 0.9, `20% should be near-maximal, got ${large}`);
  assert.ok(large < 1, 'and never actually reach 1');

  // Strictly increasing across the whole range, and sign-blind.
  let previous = -1;
  for (const m of [0, 0.1, 0.5, 1.5, 3, 8, 20, 100]) {
    const value = saturatingMagnitude(m, 1.5);
    assert.ok(value > previous, `must keep rising at ${m}%`);
    assert.equal(value, saturatingMagnitude(-m, 1.5), 'direction does not change magnitude');
    previous = value;
  }

  // The configured value is the half-contribution point.
  assert.ok(Math.abs(saturatingMagnitude(1.5, 1.5) - 0.5) < 1e-9);
});

test('a bigger excess return produces a bigger score, end to end', () => {
  const build = (benchmarkMove) => {
    const h = harness({ overrides: { sectorMap: {} } });
    h.watchlist.add(USER, 'STOCK');
    // The stock is flat; only the benchmark moves, so the excess is entirely
    // the benchmark's doing and scales with it.
    seed(h.log, 'STOCK', { price: calm(100) });
    seed(h.log, BENCHMARK_SYMBOL, { price: calmThenJump(20_000, benchmarkMove) });
    return itemFor(h.engine.evaluate({ userId: USER }), 'STOCK');
  };

  const modest = build(0.02);
  const huge = build(0.2);

  assert.ok(Math.abs(modest.features.marketRelative.excessPct) > 1);
  assert.ok(Math.abs(huge.features.marketRelative.excessPct) > 15);
  assert.ok(
    huge.scoreBreakdown.marketRelative.contribution >
      modest.scoreBreakdown.marketRelative.contribution,
    'a 20% excess must contribute more than a 2% one',
  );
});

test('relative signals alone cannot lift a symbol above LOW', () => {
  /**
   * Relative-heavy weights, so the relative signals CAN reach MODERATE and the
   * floor has something to actually cap. With the default 0.20/0.20 they
   * cannot: the non-saturating curve keeps each below 1.0, so market plus
   * sector tops out under the 0.40 MODERATE threshold on its own - which is
   * the belt to the floor's braces, asserted separately below.
   */
  const { log, watchlist, engine } = harness({
    overrides: {
      sectorMap: { BYSTANDER: 'IT', PEER1: 'IT', PEER2: 'IT' },
      weights: { priceAnomaly: 0.1, volumeAnomaly: 0.1, marketRelative: 0.4, sectorRelative: 0.4 },
    },
  });

  // Flat price, flat volume: nothing whatsoever happened to THIS stock.
  watchlist.add(USER, 'BYSTANDER');
  seed(log, 'BYSTANDER', { price: () => 100 });
  watchlist.markViewed(USER, 'BYSTANDER', T0 - 30 * 60_000);

  // Its sector peers and the index, however, both ripped - so both relative
  // signals are large and negative for the bystander.
  for (const peer of ['PEER1', 'PEER2']) {
    watchlist.add(USER, peer);
    seed(log, peer, { price: calmThenJump(100, 0.2) });
    watchlist.markViewed(USER, peer, T0 - 30 * 60_000);
  }
  seed(log, BENCHMARK_SYMBOL, { price: calmThenJump(20_000, 0.2) });

  const item = itemFor(engine.evaluate({ userId: USER }), 'BYSTANDER');

  assert.ok(
    Math.abs(item.features.marketRelative.excessPct) > 10,
    'the relative signal really is large',
  );
  assert.ok(Math.abs(item.features.priceAnomaly.z) < 0.75, 'the stock itself did nothing');
  assert.ok(item.features.volumeAnomaly.ratio < 1.5, 'and nor did its turnover');
  assert.ok(
    item.meaningfulScore >= 0.4,
    `the score genuinely reaches MODERATE territory: ${item.meaningfulScore}`,
  );

  assert.equal(item.level, 'LOW', 'but the level is capped');
  assert.ok(item.levelFloor, 'and the cap is reported rather than silent');
  assert.notEqual(item.levelFloor.cappedFrom, 'LOW');
  assert.equal(item.levelFloor.reason, 'nothing_notable_about_this_stock');
  assert.equal(item.needsAttention, false);

  /**
   * The score is NOT rewritten - it stays the honest output of the formula, so
   * the published breakdown still reproduces it. Only the level is capped.
   */
  assert.ok(Math.abs(item.meaningfulScore - handComputedScore(item)) < 1e-4);
});

test('with default weights, relative signals cannot reach MODERATE at all', () => {
  const { log, watchlist, engine } = harness({
    overrides: { sectorMap: { STOCK: 'IT', PEER1: 'IT', PEER2: 'IT' } },
  });

  for (const symbol of ['STOCK', 'PEER1', 'PEER2']) {
    watchlist.add(USER, symbol);
    seed(log, symbol, { price: () => 100 });
  }
  seed(log, BENCHMARK_SYMBOL, { price: calmThenJump(20_000, 0.5) });

  const item = itemFor(engine.evaluate({ userId: USER }), 'STOCK');

  /**
   * A consequence of the non-saturating curve worth pinning down: market and
   * sector carry 0.20 each and neither contribution can reach 1.0, so together
   * they stay under the 0.40 MODERATE threshold however violently the index
   * moves. The floor is the explicit guarantee; this is the arithmetic one.
   */
  assert.ok(
    item.meaningfulScore < 0.4,
    `relative signals alone stay under MODERATE: ${item.meaningfulScore}`,
  );
  assert.equal(item.level, 'LOW');
});

test('the floor does not suppress a volume spike on a small move', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'HEAVYTAPE');

  /**
   * The product's signature case, and the reason the floor tests turnover as
   * well as price: a barely-moving stock trading at three times its normal
   * volume. Gating the floor on the price z-score and the change alone would
   * have capped exactly the finding this engine exists to surface.
   */
  seed(log, 'HEAVYTAPE', {
    price: calm(100),
    volume: (i) => (i === 150 ? 3200 : 1000),
  });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'HEAVYTAPE', T0 - 30 * 60_000);

  const item = itemFor(engine.evaluate({ userId: USER }), 'HEAVYTAPE');

  assert.ok(item.features.volumeAnomaly.ratio >= 1.5, 'turnover is genuinely heavy');
  assert.equal(item.levelFloor, null, 'so the floor stays out of the way');
  assert.ok(item.reasons.includes('high_volume'));
});

test('the floor does not touch a symbol that genuinely moved', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'MOVER');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.02), volume: (i) => (i === 150 ? 5000 : 1000) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  watchlist.markViewed(USER, 'MOVER', T0 - 30 * 60_000);

  const item = itemFor(engine.evaluate({ userId: USER }), 'MOVER');

  assert.ok(Math.abs(item.features.priceAnomaly.z) >= 0.75, 'its own move is notable');
  assert.notEqual(item.level, 'LOW');
  assert.equal(item.levelFloor, null, 'no cap applied');
  assert.equal(item.needsAttention, true);
});

test('needsAttention is one field, so nothing can disagree about it', () => {
  const { log, watchlist, engine, surfacedStore } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'MOVER');
  watchlist.add(USER, 'QUIET');
  seed(log, 'MOVER', { price: calmThenJump(100, 0.03), volume: (i) => (i === 150 ? 6000 : 1000) });
  seed(log, 'QUIET', { price: calm(100) });
  seed(log, BENCHMARK_SYMBOL, { price: calm(20_000) });
  for (const s of ['MOVER', 'QUIET']) watchlist.markViewed(USER, s, T0 - 30 * 60_000);

  const evaluation = engine.evaluate({ userId: USER });

  // The flag agrees with the level for every item, by construction.
  for (const item of evaluation.items) {
    assert.equal(
      item.needsAttention,
      item.level === 'HIGH' || item.level === 'MODERATE',
      `${item.symbol}: flag must match level`,
    );
  }

  // And the summary counts the same set the UI chip would filter on.
  const summaryService = createSummaryService({
    engine,
    watchlist,
    surfacedStore,
    clock: () => T0,
  });
  const summary = summaryService.build({ userId: USER, record: false });
  const chipCount = evaluation.items.filter((i) => i.needsAttention).length;

  assert.equal(
    summary.counts.needsAttention,
    chipCount,
    'the banner and the chip must never disagree on one screen',
  );
});

test('the benchmark reports its own value and change', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'STOCK');
  seed(log, 'STOCK', { price: calm(100) });
  seed(log, BENCHMARK_SYMBOL, { price: calmThenJump(20_000, 0.01) });

  const { benchmark } = engine.evaluate({ userId: USER });

  assert.equal(benchmark.symbol, BENCHMARK_SYMBOL);
  assert.ok(benchmark.latest, 'the current index level is surfaced');
  assert.ok(benchmark.latest.price > 15_000);
  assert.ok(Number.isFinite(benchmark.returnPct), 'and its change');
  assert.ok(benchmark.returnPct > 0.5, `expected roughly +1%, got ${benchmark.returnPct}`);
  assert.equal(benchmark.horizonMs, BAR, 'measured over the horizon the rows were scored against');

  // It is the same figure the per-symbol comparison used.
  const item = itemFor(engine.evaluate({ userId: USER }), 'STOCK');
  assert.equal(item.features.marketRelative.benchmarkReturnPct, benchmark.returnPct);
});

test('with no new observation there is no delta, not a delta of zero', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'FROZENFEED');

  // History stops well before "now", so the feed is stale...
  seed(log, 'FROZENFEED', { price: calm(100), endAt: T0 - 20 * 60_000 });
  // ...and the user looked AFTER the last observation arrived.
  watchlist.markViewed(USER, 'FROZENFEED', T0 - 5 * 60_000);

  const item = itemFor(engine.evaluate({ userId: USER }), 'FROZENFEED');

  assert.equal(item.dataQuality, 'STALE');

  /**
   * The bug this guards: baseline and latest are the same observation, so the
   * arithmetic yields 0.00 (0.00%) - which reads as "we checked, the price is
   * unchanged". The data does not support that. It supports "nothing new has
   * been observed", which is a different fact leading to a different
   * conclusion about whether the market is quiet or the feed is broken.
   */
  assert.equal(item.changeSinceViewed.available, false);
  assert.equal(item.changeSinceViewed.reason, 'no_new_observation_since_view');
  assert.equal(item.changeSinceViewed.percent, undefined, 'no 0.00% is emitted');
  assert.equal(item.changeSinceViewed.absolute, undefined);

  // The last known price is still reported, with its age.
  assert.equal(item.changeSinceViewed.lastKnownPrice, item.latest.price);
  assert.ok(item.freshness.ageMs >= 20 * 60_000);
  assert.ok(!item.reasons.includes('change_since_viewed'));
});

test('a genuinely unchanged price with a new observation still reports zero', () => {
  const { log, watchlist, engine } = harness({ overrides: { sectorMap: {} } });
  watchlist.add(USER, 'FLATBUTLIVE');

  // The price never moves, but observations keep arriving - so we DID check.
  seed(log, 'FLATBUTLIVE', { price: () => 100 });
  watchlist.markViewed(USER, 'FLATBUTLIVE', T0 - 30 * 60_000);

  const item = itemFor(engine.evaluate({ userId: USER }), 'FLATBUTLIVE');

  /**
   * The distinction that makes the previous test meaningful: "we looked and it
   * is the same" is a real measurement and must still be reported as 0.00%.
   * Suppressing this one too would throw away information.
   */
  assert.equal(item.changeSinceViewed.available, true);
  assert.equal(item.changeSinceViewed.percent, 0);
  assert.equal(item.changeSinceViewed.absolute, 0);
});

// ================================================================= ranking

test('ranking follows score, then confidence, then novelty, then surfaced', () => {
  const base = {
    changeSinceViewed: { available: false },
    alreadySurfaced: false,
  };

  const ordered = rank([
    { ...base, symbol: 'D', meaningfulScore: 0.1, confidence: 0.9 },
    { ...base, symbol: 'A', meaningfulScore: 0.9, confidence: 0.5 },
    { ...base, symbol: 'C', meaningfulScore: 0.5, confidence: 0.5 },
    { ...base, symbol: 'B', meaningfulScore: 0.5, confidence: 0.9 },
  ]);
  assert.deepEqual(
    ordered.map((i) => i.symbol),
    ['A', 'B', 'C', 'D'],
    'score first, then confidence',
  );

  // Novelty breaks a score+confidence tie.
  const byNovelty = rank([
    {
      symbol: 'SMALL',
      meaningfulScore: 0.5,
      confidence: 0.5,
      changeSinceViewed: { available: true, percent: 0.4 },
      alreadySurfaced: false,
    },
    {
      symbol: 'BIG',
      meaningfulScore: 0.5,
      confidence: 0.5,
      changeSinceViewed: { available: true, percent: -3.2 },
      alreadySurfaced: false,
    },
  ]);
  assert.deepEqual(
    byNovelty.map((i) => i.symbol),
    ['BIG', 'SMALL'],
    'novelty is magnitude, direction-blind',
  );

  // Already-surfaced is the last tiebreak: unseen signals come first.
  const bySurfaced = rank([
    { ...base, symbol: 'SEEN', meaningfulScore: 0.5, confidence: 0.5, alreadySurfaced: true },
    { ...base, symbol: 'NEW', meaningfulScore: 0.5, confidence: 0.5, alreadySurfaced: false },
  ]);
  assert.deepEqual(
    bySurfaced.map((i) => i.symbol),
    ['NEW', 'SEEN'],
  );
});
