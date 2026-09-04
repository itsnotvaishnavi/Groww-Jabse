/**
 * The demo fixture as a regression baseline.
 *
 * The fixture is the demo script, so these assertions are what stop a change
 * to a weight or a threshold from quietly degrading the demo. If a signal
 * stops firing, or a level shifts, this fails here rather than in front of an
 * audience.
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
const { createEngine } = await import('../src/engine/index.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { createSummaryService } = await import('../src/summary.js');
const { applyDemoFixture, REAL_OBSERVATION } = await import('../src/demo/fixture.js');

const NOW = Date.UTC(2026, 8, 4, 5, 0, 0);
const USER = 'test-user';

const fixtureSource = () => ({
  name: 'demo-fixture',
  describe: () => ({ name: 'demo-fixture', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
});

function scenario(now = NOW) {
  const db = createDatabase(':memory:');
  const snapshotLog = createSnapshotLog(db);
  const watchlist = createWatchlist(db);
  const surfacedStore = createSurfacedStore(db);

  const applied = applyDemoFixture({ snapshotLog, watchlist, userId: USER, now });

  const engine = createEngine({
    snapshotLog,
    watchlist,
    surfacedStore,
    source: fixtureSource(),
    clock: () => now,
  });
  const summaryService = createSummaryService({
    engine,
    watchlist,
    surfacedStore,
    clock: () => now,
  });

  const evaluation = engine.evaluate({ userId: USER, now });
  const bySymbol = new Map(evaluation.items.map((i) => [i.symbol, i]));

  return { db, snapshotLog, watchlist, engine, summaryService, evaluation, bySymbol, applied };
}

test('the fixture produces the demo mix it promises', () => {
  const { evaluation, bySymbol } = scenario();

  const levels = evaluation.items.reduce((acc, item) => {
    acc[item.level] = (acc[item.level] ?? 0) + 1;
    return acc;
  }, {});

  assert.equal(levels.HIGH, 1, 'exactly one HIGH');
  assert.equal(levels.MODERATE, 1, 'exactly one MODERATE');
  assert.ok(levels.LOW >= 5, `several LOW, got ${levels.LOW}`);

  // The HIGH is the large idiosyncratic move on heavy volume.
  const high = bySymbol.get('INFY');
  assert.equal(high.level, 'HIGH');
  assert.ok(high.meaningfulScore >= 0.7);
  assert.deepEqual(
    [...high.reasons].sort(),
    [
      'change_since_viewed',
      'high_volume',
      'market_outperformance',
      'sector_outperformance',
      'unusual_price_movement',
    ],
    'all four signals fire, plus the user-facing change',
  );

  // The MODERATE is the volume spike on a modest price move - precisely the
  // case a percentage-change watchlist mishandles.
  const moderate = bySymbol.get('SBIN');
  assert.equal(moderate.level, 'MODERATE');
  assert.ok(moderate.reasons.includes('high_volume'));
  assert.ok(
    Math.abs(moderate.changeSinceViewed.percent) < 1.5,
    `the price move is modest: ${moderate.changeSinceViewed.percent}%`,
  );
});

test('the fixture demonstrates the conflicting-source path', () => {
  const { bySymbol } = scenario();
  const disputed = bySymbol.get('HDFCBANK');

  assert.ok(disputed.conflict, 'the disagreement is reported');
  assert.ok(
    disputed.conflict.spreadPct > 0.5,
    `beyond tolerance: ${disputed.conflict.spreadPct}%`,
  );
  assert.deepEqual(
    disputed.conflict.observations.map((o) => o.source).sort(),
    ['alt-feed', 'demo-fixture'],
  );

  /**
   * The conflicting row is written first so it takes a lower id and does not
   * become the primary price. Otherwise the disagreement itself would read as
   * a large price move and drag the symbol out of LOW, making the conflict
   * case indistinguishable from a genuine anomaly.
   */
  assert.equal(disputed.latest.source, 'demo-fixture');
  assert.equal(disputed.level, 'LOW');
});

test('the real cross-venue pair is two instruments, and is not a conflict', () => {
  const { bySymbol, snapshotLog } = scenario();

  const nse = bySymbol.get('RELIANCE');
  const bse = bySymbol.get('RELIANCE.BO');

  assert.ok(nse && bse, 'both venues are present as separate rows');
  assert.equal(nse.latest.price, REAL_OBSERVATION.nse.price);
  assert.equal(bse.latest.price, REAL_OBSERVATION.bse.price);
  assert.notEqual(nse.latest.price, bse.latest.price, 'they genuinely differ');

  /**
   * The two reasons the real pair cannot be the conflict case, asserted:
   * they are different instruments, and they agree within tolerance.
   */
  assert.equal(nse.conflict, null, 'a 0.113% cross-venue spread is not a conflict');
  assert.equal(bse.conflict, null);

  const spreadPct =
    ((REAL_OBSERVATION.bse.price - REAL_OBSERVATION.nse.price) / REAL_OBSERVATION.nse.price) * 100;
  assert.ok(spreadPct < 0.5, `the real spread is inside tolerance: ${spreadPct.toFixed(3)}%`);

  // Two separate series in the log, not one merged one.
  assert.ok(snapshotLog.latest('RELIANCE').price !== snapshotLog.latest('RELIANCE.BO').price);
});

test('the fixture demonstrates missing volume and thin history', () => {
  const { bySymbol } = scenario();

  // Missing volume: unavailable, and the weight is renormalised away.
  const noVolume = bySymbol.get('ITC');
  assert.equal(noVolume.features.volumeAnomaly.available, false);
  assert.equal(noVolume.features.volumeAnomaly.reason, 'volume_not_reported');
  assert.ok(!noVolume.reasons.includes('high_volume'));
  assert.equal(noVolume.availableWeight, 0.55, '1.00 - 0.25 volume - 0.20 sector');

  // Thin history: nothing is measurable, and the row says exactly that rather
  // than warning about a signal it does not have.
  const thin = bySymbol.get('MARUTI');
  assert.equal(thin.features.priceAnomaly.available, false);
  assert.equal(thin.features.volumeAnomaly.available, false);
  assert.equal(thin.availableWeight, 0);
  assert.equal(thin.meaningfulScore, 0);
  assert.deepEqual(thin.reasons, ['insufficient_data']);
  assert.ok(!thin.reasons.includes('low_confidence'), 'nothing to caution about');
});

test('the fixture summary reports the scenario correctly', () => {
  const { summaryService } = scenario();
  const summary = summaryService.build({ userId: USER, now: NOW, record: false });

  assert.equal(summary.counts.high, 1);
  assert.equal(summary.counts.moderate, 1);
  assert.equal(summary.counts.needsAttention, 2);
  assert.equal(summary.away.label, '45m');
  assert.match(summary.headline, /You were away for 45m\./);
  assert.match(summary.headline, /2 deserve your attention/);

  // Engine-ranked, not sorted by raw percentage change.
  assert.equal(summary.top[0].symbol, 'INFY');
  assert.equal(summary.top[1].symbol, 'SBIN');
});

test('the fixture is reproducible from its seed', () => {
  const a = scenario();
  const b = scenario();

  /**
   * The whole point of a fixture: byte-identical from the same seed and the
   * same reference instant, so it is a regression baseline rather than a
   * scenario that happens to look right today.
   */
  assert.equal(JSON.stringify(a.evaluation), JSON.stringify(b.evaluation));
  assert.equal(a.applied.observations, b.applied.observations);
  assert.equal(a.applied.seed, b.applied.seed);
});

test('the fixture shifts with the reference instant but keeps its shape', () => {
  // A demo run tomorrow must produce the same scenario, not a stale one.
  const later = scenario(NOW + 3 * 86_400_000);
  const levels = later.evaluation.items.reduce((acc, item) => {
    acc[item.level] = (acc[item.level] ?? 0) + 1;
    return acc;
  }, {});

  assert.equal(levels.HIGH, 1);
  assert.equal(levels.MODERATE, 1);
  assert.equal(later.bySymbol.get('INFY').level, 'HIGH');
  assert.ok(later.bySymbol.get('HDFCBANK').conflict);
});
