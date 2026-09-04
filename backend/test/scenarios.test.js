/**
 * Named demo scenarios.
 *
 * The load-bearing test here is the cold open: `stock_outperforms` must produce
 * a HIGH attention result WITH the sector signal available. A judge opening the
 * app to a column of LOW cannot see the engine work at all, and the first
 * version of that scenario silently failed - its move completed an hour before
 * the end, outside the engine's fifteen-minute anomaly horizon, so it scored
 * 0.29 and LOW. This test is what stopped that shipping, and what will catch it
 * again if a weight or a threshold moves.
 *
 * Fixed clock, in-memory database, no network.
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
const { createEngine } = await import('../src/engine/index.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { createSummaryService } = await import('../src/summary.js');
const { createAlertStore, AlertType } = await import('../src/alerts.js');
const {
  applyScenario,
  scenarioCatalogue,
  CONDITIONS,
  TIME_AWAY,
  findCondition,
  findTimeAway,
} = await import('../src/demo/scenarios.js');
const { BENCHMARK_SYMBOL } = await import('../src/symbols.js');

const USER = 'test-user';
/** Friday 2026-09-04, 14:00 IST. Fixed, so every scenario is reproducible. */
const NOW = Date.UTC(2026, 8, 4, 8, 30, 0);

/** The scenario source: continuous, undelayed - freshness reflects data age. */
const scenarioSource = () => ({
  name: 'scenario',
  describe: () => ({ name: 'scenario', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
});

function run({ condition, timeAwayId = '6h', now = NOW }) {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);

  const applied = applyScenario({
    snapshotLog,
    watchlist,
    userId: USER,
    condition,
    timeAwayId,
    now,
  });

  const engine = createEngine({
    snapshotLog,
    watchlist,
    surfacedStore,
    source: scenarioSource(),
    clock: () => now,
  });
  const summaryService = createSummaryService({
    engine,
    watchlist,
    surfacedStore,
    clock: () => now,
  });

  const evaluation = engine.evaluate({ userId: USER, now });

  return {
    db,
    snapshotLog,
    watchlist,
    engine,
    summaryService,
    applied,
    evaluation,
    bySymbol: new Map(evaluation.items.map((i) => [i.symbol, i])),
    levels: evaluation.items.reduce((acc, i) => {
      acc[i.level] = (acc[i.level] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

// ================================================== THE COLD-OPEN REQUIREMENT

test('stock_outperforms produces HIGH with the sector signal available', () => {
  const { bySymbol, applied } = run({ condition: 'stock_outperforms' });
  const subject = bySymbol.get(applied.subject);

  assert.equal(subject.level, 'HIGH', `expected HIGH, got ${subject.level}`);
  assert.ok(subject.meaningfulScore >= 0.7, `score ${subject.meaningfulScore}`);

  /**
   * The half of the requirement that is easy to miss. A HIGH reached on three
   * signals with the sector renormalised away does not demonstrate the sector
   * comparison at all - and the sector signal is the one most likely to be
   * unavailable in real use.
   */
  assert.equal(
    subject.features.sectorRelative.available,
    true,
    'the sector signal must be AVAILABLE, not renormalised away',
  );
  assert.equal(subject.availableWeight, 1, 'all four signals measurable');

  for (const feature of ['priceAnomaly', 'volumeAnomaly', 'marketRelative', 'sectorRelative']) {
    assert.equal(subject.features[feature].available, true, `${feature} must be available`);
  }

  // And the engine is not merely scoring - it is explaining.
  assert.ok(subject.reasons.includes('unusual_price_movement'));
  assert.ok(subject.reasons.includes('high_volume'));
  assert.ok(subject.reasons.includes('market_outperformance'));
  assert.ok(subject.reasons.includes('sector_outperformance'));

  // Not stale: only the data_delay scenario is.
  assert.equal(subject.dataQuality, 'LIVE');
  assert.ok(subject.confidence >= 0.8, `confidence ${subject.confidence}`);
});

test('the cold open holds at every time-away setting', () => {
  /**
   * The move sits inside the engine's anomaly horizon, so the level must not
   * depend on how long the user was away - that only changes the reported
   * change-since-viewed and the summary's phrasing.
   */
  for (const away of TIME_AWAY) {
    const { bySymbol, applied } = run({ condition: 'stock_outperforms', timeAwayId: away.id });
    const subject = bySymbol.get(applied.subject);
    assert.equal(subject.level, 'HIGH', `${away.id}: expected HIGH, got ${subject.level}`);
    assert.equal(subject.features.sectorRelative.available, true, `${away.id}: sector`);
  }
});

// ============================================================ each condition

test('normal is a quiet tape', () => {
  const { levels } = run({ condition: 'normal' });

  assert.equal(levels.HIGH ?? 0, 0);
  assert.equal(levels.MODERATE ?? 0, 0);
  assert.ok(levels.LOW >= 4, 'all four symbols LOW - the baseline to read the others against');
});

test('high_volume reaches MODERATE on turnover, not on price', () => {
  const { bySymbol, applied } = run({ condition: 'high_volume' });
  const subject = bySymbol.get(applied.subject);

  assert.equal(subject.level, 'MODERATE');
  assert.ok(subject.features.volumeAnomaly.ratio >= 3, `ratio ${subject.features.volumeAnomaly.ratio}`);
  assert.ok(subject.reasons.includes('high_volume'));

  /**
   * The case a percentage-change watchlist always misses: the price move is
   * unremarkable and the turnover is the entire story.
   */
  assert.ok(
    Math.abs(subject.changeSinceViewed.percent) < 1.5,
    `the price move stays modest: ${subject.changeSinceViewed.percent}%`,
  );
});

test('a market-wide move is not treated as news about one stock', () => {
  const wide = run({ condition: 'market_wide' });
  const alone = run({ condition: 'stock_outperforms' });

  const wideSubject = wide.bySymbol.get(wide.applied.subject);
  const aloneSubject = alone.bySymbol.get(alone.applied.subject);

  // Both stocks moved unusually for themselves.
  assert.ok(Math.abs(wideSubject.features.priceAnomaly.z) > 2);
  assert.ok(Math.abs(aloneSubject.features.priceAnomaly.z) > 2);

  // But only one of them moved differently from everything else.
  assert.ok(
    Math.abs(wideSubject.features.marketRelative.excessPct) < 0.5,
    `market-wide leaves no excess: ${wideSubject.features.marketRelative.excessPct}%`,
  );

  assert.ok(
    wideSubject.meaningfulScore < aloneSubject.meaningfulScore,
    `${wideSubject.meaningfulScore} must be under ${aloneSubject.meaningfulScore}`,
  );
  assert.notEqual(wideSubject.level, 'HIGH', 'a rising tide is not a discovery');
});

test('data_delay produces stale data and refuses to fire alerts', () => {
  const { bySymbol, applied, db } = run({ condition: 'data_delay' });
  const subject = bySymbol.get(applied.subject);

  assert.equal(applied.delayMs, 25 * 60_000);
  assert.equal(subject.dataQuality, 'STALE');
  assert.equal(subject.freshness.isStale, true);
  assert.ok(subject.confidence <= 0.5, `confidence drops: ${subject.confidence}`);

  /**
   * And the consequence that matters: a price alert well past its threshold
   * still does not fire, because the observation cannot be trusted.
   */
  const store = createAlertStore(db, {
    hysteresisPricePct: 0.001,
    hysteresisChangePct: 0.25,
    hysteresisVolumeRatio: 0.2,
    feedLimit: 20,
  });
  store.create(
    USER,
    { symbol: applied.subject, type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1 },
    NOW,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: { items: [subject] },
    now: NOW,
  });

  assert.equal(result.fired.length, 0);
  assert.equal(result.skipped[0].reason, 'data_quality:stale');
});

test('source_conflict reports the disagreement rather than picking a side', () => {
  const { bySymbol, applied, snapshotLog } = run({ condition: 'source_conflict' });
  const subject = bySymbol.get(applied.subject);

  assert.ok(subject.conflict, 'the conflict is surfaced');
  assert.ok(subject.conflict.spreadPct > 0.5, `beyond tolerance: ${subject.conflict.spreadPct}%`);
  assert.deepEqual(
    subject.conflict.observations.map((o) => o.source).sort(),
    ['alt-feed', 'scenario'],
  );

  /**
   * The conflicting row is written first so it takes a lower id and does not
   * become the primary price - otherwise the disagreement itself would read as
   * a large price move and the scenario would demonstrate an anomaly instead of
   * a conflict.
   */
  assert.equal(subject.latest.source, 'scenario');
  const perSource = snapshotLog.latestPerSource(applied.subject, NOW - 10 * 60_000);
  assert.equal(perSource.length, 2, 'both feeds are in the log');
});

// ============================================================= time away

test('time away is stamped into last_viewed_at and drives the summary', () => {
  for (const away of TIME_AWAY) {
    const { summaryService, applied } = run({ condition: 'normal', timeAwayId: away.id });
    const summary = summaryService.build({ userId: USER, now: NOW, record: false });

    assert.equal(applied.timeAwayMs, away.ms);
    assert.ok(summary.away.ms != null, `${away.id}: an absence is reported`);

    /**
     * Past a day the summary aggregates rather than enumerating, which is the
     * behavioural difference these settings exist to demonstrate.
     */
    const expectLong = away.ms >= 24 * 60 * 60_000;
    assert.equal(summary.away.long, expectLong, `${away.id}: long=${expectLong}`);
    if (expectLong) assert.ok(summary.aggregate, `${away.id}: aggregate present`);
    else assert.equal(summary.aggregate, null, `${away.id}: enumerated`);
  }
});

test('a delta always exists, even when the feed stopped before now', () => {
  /**
   * The viewing time is set relative to the END OF THE WRITTEN HISTORY, not to
   * `now`. Anchored to `now`, a 1-hour absence against a feed that stopped 25
   * minutes ago would put the visit AFTER the last observation - leaving no
   * newer observation to diff against and no change to show, which would make
   * the delayed scenario silently useless.
   */
  const { bySymbol, applied } = run({ condition: 'data_delay', timeAwayId: '1h' });
  const subject = bySymbol.get(applied.subject);

  assert.ok(applied.viewedAt < applied.historyEndsAt, 'the visit precedes the last observation');
  assert.equal(subject.changeSinceViewed.available, true);
  assert.ok(Number.isFinite(subject.changeSinceViewed.percent));
});

// ============================================================ determinism

test('every scenario is byte-identical across runs', () => {
  for (const condition of CONDITIONS) {
    const a = run({ condition: condition.id });
    const b = run({ condition: condition.id });

    assert.equal(
      JSON.stringify(a.evaluation),
      JSON.stringify(b.evaluation),
      `${condition.id} must be reproducible`,
    );
    assert.equal(a.applied.observations, b.applied.observations);
    assert.equal(a.applied.seed, b.applied.seed);
  }
});

test('each condition is a distinct market, not the same one relabelled', () => {
  const fingerprints = new Map();

  for (const condition of CONDITIONS) {
    const { evaluation } = run({ condition: condition.id });
    const shape = evaluation.items
      .map((i) => `${i.symbol}:${i.level}:${i.meaningfulScore}`)
      .sort()
      .join('|');
    fingerprints.set(condition.id, shape);
  }

  assert.equal(
    new Set(fingerprints.values()).size,
    CONDITIONS.length,
    'six conditions must produce six different markets',
  );
});

test('the same scenario at a different instant keeps its shape', () => {
  // A demo run tomorrow must show the same scenario, not a stale one.
  const later = run({ condition: 'stock_outperforms', now: NOW + 3 * 86_400_000 });
  const subject = later.bySymbol.get(later.applied.subject);

  assert.equal(subject.level, 'HIGH');
  assert.equal(subject.features.sectorRelative.available, true);
});

test('the simulator is untouched and still reproducible', async () => {
  /**
   * Scenarios write crafted history into the log; they must not have changed
   * the deterministic simulator, which is a separate source and the default.
   */
  const { TICK_MS, __testing } = await import('../src/sources/simulator.js');
  const anchor = Date.UTC(2026, 8, 4, 5, 0, 0);
  const tick = Math.floor(anchor / TICK_MS);

  const first = __testing.snapshotForTick('RELIANCE', tick);
  const again = __testing.snapshotForTick('RELIANCE', tick);

  assert.deepEqual(first, again, 'same seed, same tick, same snapshot');
  assert.ok(first.price > 0);
});

// ============================================================== catalogue

test('the catalogue describes every scenario it offers', () => {
  const catalogue = scenarioCatalogue();

  assert.equal(catalogue.conditions.length, CONDITIONS.length);
  assert.equal(catalogue.timeAway.length, 4);
  assert.deepEqual(
    catalogue.timeAway.map((t) => t.id),
    ['1h', '6h', '24h', '2d'],
  );

  for (const condition of catalogue.conditions) {
    assert.ok(condition.label, `${condition.id} needs a label`);
    assert.ok(condition.description, `${condition.id} needs a description`);
    assert.ok(condition.expect, `${condition.id} must state what it demonstrates`);
    assert.match(condition.command, /npm run demo/, `${condition.id} needs a runnable command`);
  }

  assert.ok(findCondition('stock_outperforms'));
  assert.equal(findCondition('nope'), null);
  assert.equal(findTimeAway('6h').ms, 6 * 60 * 60_000);
  assert.equal(findTimeAway('nope'), null);
});

test('an unknown condition is refused rather than silently defaulted', () => {
  const db = createDatabase(':memory:');
  assert.throws(
    () =>
      applyScenario({
        snapshotLog: createSnapshotLog(db),
        watchlist: createWatchlist(db),
        userId: USER,
        condition: 'nonsense',
        now: NOW,
      }),
    /unknown scenario/i,
  );
  db.close();
});

test('every scenario writes the benchmark, so the market signal can exist', () => {
  for (const condition of CONDITIONS) {
    const { snapshotLog } = run({ condition: condition.id });
    const benchmark = snapshotLog.latest(BENCHMARK_SYMBOL);
    assert.ok(benchmark, `${condition.id} must ingest ${BENCHMARK_SYMBOL}`);
    assert.ok(benchmark.price > 15_000, `${condition.id}: an index level`);
  }
});
