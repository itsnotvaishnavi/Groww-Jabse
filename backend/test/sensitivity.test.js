/**
 * Attention sensitivity: a display threshold over the engine's own verdicts.
 *
 * The claim being tested is narrow and important: changing sensitivity changes
 * WHICH already-computed results are surfaced prominently, and changes NOTHING
 * about any of them. No score, no level, no confidence, no reason.
 *
 * The rule under test lives in frontend/sensitivity.js. It is imported here
 * directly - it has no DOM in it, which is exactly why it is its own module.
 * Testing it against real engine output rather than hand-written objects is
 * the point: the fields it selects on have to be the fields the engine
 * actually publishes.
 *
 * Fixed clock, in-memory database, stub source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { createEngine } = await import('../src/engine/index.js');
const { createSurfacedStore } = await import('../src/engine/surfaced.js');
const { Level } = await import('../src/engine/score.js');
const { SENSITIVITY, SENSITIVITY_LEVELS, DEFAULT_SENSITIVITY, displayGroupFor } = await import(
  '../../frontend/sensitivity.js'
);

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const BAR = 60_000;
const USER = 'test-user';

const calm = (base) => (i) =>
  Math.round(base * (1 + 0.0004 * Math.sin(i * 2.3) + 0.0002 * Math.cos(i * 5.1)) * 100) / 100;

const jump = (base, pct, bars = 150) => (i) =>
  i === bars ? Math.round(base * (1 + pct) * 100) / 100 : calm(base)(i);

const stubSource = () => ({
  name: 'test',
  describe: () => ({ name: 'test', kind: 'synthetic', alwaysOpen: true, delayMs: 0 }),
  getSymbols: () => [],
  getLatestSnapshot: async () => null,
  getSnapshotAt: async () => null,
});

/**
 * One row per outcome the grouping can produce, so every branch of the
 * sensitivity rule is exercised against a real evaluation:
 *
 *   LOUD - HIGH,     over the bar on any setting
 *   MID  - MODERATE, over the engine's bar but not the top level
 *   MILD - LOW,      notable for itself, below the bar
 *   CALM - LOW,      measured, nothing to report
 *   NEW  - no baseline at all
 */
function evaluated() {
  const db = createDatabase(':memory:');
  const log = createSnapshotLog(db);
  const watchlist = createWatchlist(db);

  const engine = createEngine({
    snapshotLog: log,
    watchlist,
    surfacedStore: createSurfacedStore(db),
    source: stubSource(),
    clock: () => T0,
    overrides: { barMs: BAR, anomalyHorizonMs: BAR, carryForwardBars: 2 },
  });

  const paths = {
    LOUD: { price: jump(100, 0.05), volume: (i) => (i >= 148 ? 9_000 : 1_000) },
    MID: { price: jump(100, 0.0015), volume: () => 1_000 },
    MILD: { price: jump(100, 0.001), volume: () => 1_000 },
    CALM: { price: calm(100), volume: () => 1_000 },
    NEW: { price: calm(200), volume: () => 1_000 },
  };

  for (const [symbol, path] of Object.entries(paths)) {
    watchlist.add(USER, symbol);
    for (let i = 0; i <= 150; i += 1) {
      const t = T0 - (150 - i) * BAR;
      log.append({
        symbol,
        timestamp: t,
        price: path.price(i),
        volume: path.volume(i),
        source: 'test',
        confidence: 1,
        ingestedAt: t,
      });
    }
    // NEW is deliberately left unviewed: it has no baseline.
    if (symbol !== 'NEW') watchlist.markViewed(USER, symbol, T0 - 30 * BAR);
  }

  return engine.evaluate({ userId: USER, now: T0 }).items;
}

const partition = (items, sensitivity) => {
  const out = {};
  for (const item of items) {
    const group = displayGroupFor(item, sensitivity);
    (out[group] ??= []).push(item.symbol);
  }
  for (const symbols of Object.values(out)) symbols.sort();
  return out;
};

test('the fixture really does produce one row per outcome', () => {
  const items = evaluated();
  const by = (symbol) => items.find((i) => i.symbol === symbol);

  // Asserted rather than assumed: if the engine's thresholds move, this test
  // must fail loudly rather than quietly stop covering three of its branches.
  assert.equal(by('LOUD').level, Level.HIGH);
  assert.equal(by('MID').level, Level.MODERATE);
  assert.equal(by('MILD').attentionGroup, 'meaningful');
  assert.equal(by('CALM').attentionGroup, 'stable');
  assert.equal(by('NEW').attentionGroup, 'unseen');
});

test('sensitivity changes which rows are surfaced prominently', () => {
  const items = evaluated();

  assert.deepEqual(
    partition(items, 'low'),
    {
      needs_attention: ['LOUD'],
      meaningful: ['MID', 'MILD'],
      stable: ['CALM'],
      unseen: ['NEW'],
    },
    'low surfaces only the engine\'s top level; MODERATE steps down a band',
  );

  assert.deepEqual(
    partition(items, 'medium'),
    {
      needs_attention: ['LOUD', 'MID'],
      meaningful: ['MILD'],
      stable: ['CALM'],
      unseen: ['NEW'],
    },
    'medium is the engine\'s own bar, unchanged',
  );

  assert.deepEqual(
    partition(items, 'high'),
    {
      needs_attention: ['LOUD', 'MID', 'MILD'],
      stable: ['CALM'],
      unseen: ['NEW'],
    },
    'high also surfaces the meaningful-but-below-bar row',
  );
});

test('medium is exactly the engine\'s own verdict, not a reinterpretation', () => {
  for (const item of evaluated()) {
    assert.equal(
      displayGroupFor(item, DEFAULT_SENSITIVITY),
      item.attentionGroup,
      `${item.symbol}: the default must not move anything`,
    );
  }
});

/**
 * THE LOAD-BEARING ASSERTION.
 *
 * Sensitivity is allowed to change what is shown. It is not allowed to change
 * anything about what is shown - and since it reads a frozen evaluation, the
 * proof is that the items are byte-identical before and after every setting is
 * applied.
 */
test('no sensitivity changes a score, a level or a confidence', () => {
  const items = evaluated();
  const before = JSON.stringify(items);

  for (const setting of SENSITIVITY_LEVELS) {
    for (const item of items) displayGroupFor(item, setting);

    assert.equal(
      JSON.stringify(items),
      before,
      `${setting}: the evaluation was mutated`,
    );
  }

  // And stated field by field, so a future change to the serialisation cannot
  // quietly weaken the assertion above.
  for (const setting of SENSITIVITY_LEVELS) {
    for (const item of items) {
      const score = item.meaningfulScore;
      const level = item.level;
      const confidence = item.confidence;
      const reasons = [...item.reasons];

      displayGroupFor(item, setting);

      assert.equal(item.meaningfulScore, score, `${item.symbol} score under ${setting}`);
      assert.equal(item.level, level, `${item.symbol} level under ${setting}`);
      assert.equal(item.confidence, confidence, `${item.symbol} confidence under ${setting}`);
      assert.deepEqual(item.reasons, reasons, `${item.symbol} reasons under ${setting}`);
      assert.equal(
        item.attentionGroup,
        displayGroupFor(item, DEFAULT_SENSITIVITY),
        `${item.symbol}: the engine's own group is never overwritten`,
      );
    }
  }
});

test('a row with no baseline stays unseen at every setting', () => {
  const unseen = evaluated().find((item) => item.symbol === 'NEW');

  for (const setting of SENSITIVITY_LEVELS) {
    assert.equal(
      displayGroupFor(unseen, setting),
      'unseen',
      `${setting}: no setting may turn an absent comparison into a quiet one`,
    );
  }
});

test('an unknown setting falls back to the default rather than hiding rows', () => {
  const items = evaluated();

  for (const item of items) {
    assert.equal(
      displayGroupFor(item, 'nonsense'),
      displayGroupFor(item, DEFAULT_SENSITIVITY),
      `${item.symbol}: a bad setting must not drop a row out of every group`,
    );
  }

  // Every level names itself, and only medium has nothing to explain.
  assert.deepEqual(Object.keys(SENSITIVITY).sort(), [...SENSITIVITY_LEVELS].sort());
  assert.equal(SENSITIVITY.medium.note, null);
  for (const setting of ['low', 'high']) {
    assert.match(SENSITIVITY[setting].note, /sensitivity/i);
  }
});
