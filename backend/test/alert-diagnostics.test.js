/**
 * "Why wasn't I alerted?" and "why was I?"
 *
 * The point of these tests is that the answer is never generic. Each one
 * asserts a specific, checkable statement built from a real feature value -
 * because "conditions not met" would pass a looser test while teaching the user
 * nothing and hiding a permanently stale feed behind what looks like a quiet
 * market.
 *
 * No clock, no network, no database beyond an in-memory one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';

const { createDatabase } = await import('../src/db.js');
const { createAlertStore, AlertType } = await import('../src/alerts.js');
const {
  diagnoseAlert,
  explainSignals,
  explainFiring,
  contributingSignals,
  BlockerCode,
  DiagnosisStatus,
  describeRule,
} = await import('../src/alert-diagnostics.js');

const USER = 'test-user';
const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);

const ALERT_PARAMS = {
  hysteresisPricePct: 0.001,
  hysteresisChangePct: 0.25,
  hysteresisVolumeRatio: 0.2,
  feedLimit: 20,
};

const ENGINE_PARAMS = {
  levels: { moderate: 0.4, high: 0.7 },
  reasonMinZ: 1,
  reasonMinVolumeRatio: 1.5,
  reasonMinRelativePct: 0.4,
};

/**
 * An engine item, built by hand so each test controls exactly one variable.
 * The shape mirrors what the engine actually returns.
 */
function item(over = {}) {
  const {
    price = 1400,
    state = 'live',
    level = 'LOW',
    score = 0.2,
    confidence = 0.9,
    changePct = 0.1,
    z = 0.4,
    volumeRatio = 1.0,
    marketExcess = 0.1,
    sectorExcess = null,
    sectorReason = 'insufficient_peers',
    levelFloor = null,
  } = over;

  const weighted = (contribution, weight) => ({
    available: true,
    weight,
    contribution,
    weighted: Math.round(contribution * weight * 1e6) / 1e6,
  });

  return {
    symbol: 'RELIANCE',
    latest: price == null ? null : { price, timestamp: T0 },
    freshness: { state, label: state, ageMs: 3000, isStale: state === 'stale' },
    dataQuality: state.toUpperCase(),
    level,
    meaningfulScore: score,
    confidence,
    levelFloor,
    changeSinceViewed:
      changePct == null
        ? { available: false, reason: 'never_viewed' }
        : { available: true, percent: changePct },
    features: {
      priceAnomaly:
        z == null
          ? { available: false, reason: 'insufficient_history' }
          : { available: true, z, horizonMs: 900_000 },
      volumeAnomaly:
        volumeRatio == null
          ? { available: false, reason: 'volume_not_reported' }
          : { available: true, ratio: volumeRatio },
      marketRelative:
        marketExcess == null
          ? { available: false, reason: 'benchmark_unavailable' }
          : {
              available: true,
              excessPct: marketExcess,
              symbolReturnPct: 0.2,
              benchmarkReturnPct: 0.1,
            },
      sectorRelative:
        sectorExcess == null
          ? { available: false, reason: sectorReason }
          : { available: true, excessPct: sectorExcess, sector: 'ENERGY' },
    },
    scoreBreakdown: {
      priceAnomaly: z == null ? { available: false } : weighted(Math.min(Math.abs(z) / 3, 1), 0.35),
      volumeAnomaly:
        volumeRatio == null
          ? { available: false }
          : weighted(Math.max(0, volumeRatio - 1) / 2, 0.25),
      marketRelative:
        marketExcess == null
          ? { available: false }
          : weighted(Math.abs(marketExcess) / (Math.abs(marketExcess) + 1.5), 0.2),
      sectorRelative:
        sectorExcess == null
          ? { available: false, reason: sectorReason }
          : weighted(Math.abs(sectorExcess) / (Math.abs(sectorExcess) + 1.5), 0.2),
    },
  };
}

const alert = (over = {}) => ({
  id: 1,
  symbol: 'RELIANCE',
  type: AlertType.PRICE_CROSSES_ABOVE,
  threshold: 1450,
  armed: true,
  lastObserved: null,
  fireCount: 0,
  ...over,
});

const diagnose = (a, i) =>
  diagnoseAlert({
    alert: a,
    item: i,
    alertParams: ALERT_PARAMS,
    engineParams: ENGINE_PARAMS,
  });

const codes = (d) => d.blockers.map((b) => b.code);
const signalCodes = (d) => d.signals.map((s) => s.code);

// ======================================================== below threshold

test('below a price threshold, the answer is the distance, not a verdict', () => {
  const d = diagnose(alert({ threshold: 1450 }), item({ price: 1412.3 }));

  assert.equal(d.status, DiagnosisStatus.NOT_MET);
  assert.deepEqual(codes(d), [BlockerCode.CONDITION_NOT_MET]);

  assert.equal(d.rule.text, 'Price crosses above ₹1450');
  assert.equal(d.current.text, '₹1412.3');

  /**
   * "₹37.70 below your ₹1450 threshold" is checkable by the user against the
   * price on their screen. "Conditions not met" is not.
   */
  assert.match(d.blockers[0].text, /₹37\.7 below your ₹1450 threshold/);
  assert.equal(d.blockers[0].gap.distance, 37.7);
});

test('an attention-HIGH rule reports the score, the target, and the facts behind it', () => {
  /**
   * The example from the brief: score 0.43, and the contributing facts - price
   * movement not unusual, volume normal, market moved similarly.
   */
  const d = diagnose(
    alert({ type: AlertType.ATTENTION_HIGH, threshold: null }),
    item({ level: 'MODERATE', score: 0.43, z: 0.4, volumeRatio: 1.0, marketExcess: 0.1 }),
  );

  assert.equal(d.status, DiagnosisStatus.NOT_MET);
  assert.equal(d.rule.text, 'Attention level becomes HIGH');
  assert.equal(d.current.text, 'not HIGH');

  // The score and the target it fell short of, both stated.
  assert.match(d.blockers[0].text, /Attention is MODERATE, not HIGH/);
  assert.match(d.blockers[0].text, /score is 0\.43/);
  assert.match(d.blockers[0].text, /HIGH needs 0\.7/);

  // And the facts, each carrying the number that produced it.
  assert.ok(signalCodes(d).includes('price_movement_not_unusual'));
  assert.ok(signalCodes(d).includes('volume_normal'));
  assert.ok(signalCodes(d).includes('moved_with_market'));
  assert.ok(signalCodes(d).includes('sector_unavailable'));

  const price = d.signals.find((s) => s.code === 'price_movement_not_unusual');
  assert.match(price.text, /not unusual for this stock \(0\.4σ\)/);
  assert.equal(price.z, 0.4, 'the raw value travels with the sentence');

  const volume = d.signals.find((s) => s.code === 'volume_normal');
  assert.match(volume.text, /Volume is normal \(1\.0×\)/);

  const market = d.signals.find((s) => s.code === 'moved_with_market');
  assert.match(market.text, /market moved similarly/);

  const sector = d.signals.find((s) => s.code === 'sector_unavailable');
  assert.match(sector.text, /insufficient_peers/, 'an unmeasurable signal says why');
});

test('ordinary market movement is described as ordinary, with its numbers', () => {
  /**
   * The case that most needs explaining: the stock DID move, so the user
   * expects an alert, but it moved with everything else and unremarkably for
   * itself. Every clause here is a measurement.
   */
  const d = diagnose(
    alert({ type: AlertType.ATTENTION_HIGH, threshold: null }),
    item({
      level: 'LOW',
      score: 0.19,
      z: 0.3,
      volumeRatio: 1.05,
      marketExcess: 0.05,
      sectorExcess: 0.1,
    }),
  );

  assert.equal(d.status, DiagnosisStatus.NOT_MET);
  assert.ok(signalCodes(d).includes('price_movement_not_unusual'));
  assert.ok(signalCodes(d).includes('volume_normal'));
  assert.ok(signalCodes(d).includes('moved_with_market'));
  assert.ok(signalCodes(d).includes('moved_with_sector'));

  /**
   * Nothing claims the stock was unusual in any respect. Matched on exact
   * codes, not a substring - `price_movement_not_unusual` contains the word
   * "unusual" and a looser check passes while asserting the opposite.
   */
  for (const claim of [
    'price_movement_unusual',
    'volume_elevated',
    'diverged_from_market',
    'diverged_from_sector',
  ]) {
    assert.ok(!signalCodes(d).includes(claim), `must not claim ${claim}`);
  }
});

test('a level capped by the floor is explained, not left contradictory', () => {
  const d = diagnose(
    alert({ type: AlertType.ATTENTION_HIGH, threshold: null }),
    item({
      level: 'LOW',
      score: 0.44,
      levelFloor: {
        capped: true,
        cappedFrom: 'MODERATE',
        zMagnitude: 0.2,
        changeMagnitude: 0.05,
        volumeRatio: 1.01,
      },
    }),
  );

  const floor = d.signals.find((s) => s.code === 'level_capped_by_floor');
  assert.ok(floor, 'a score of 0.44 showing as LOW must be explained');
  assert.match(floor.text, /capped at LOW/);
  assert.match(floor.text, /0\.2σ/);
  assert.match(floor.text, /1\.01×/);
});

// ==================================================== insufficient confidence

test('an unmeasurable value is reported as unmeasurable, with the reason', () => {
  // A change-since-viewed rule on a symbol the user has never opened.
  const d = diagnose(
    alert({ type: AlertType.CHANGE_SINCE_VIEWED_EXCEEDS, threshold: 2 }),
    item({ changePct: null }),
  );

  assert.equal(d.status, DiagnosisStatus.BLOCKED);
  assert.deepEqual(codes(d), [BlockerCode.VALUE_UNAVAILABLE]);
  assert.match(d.blockers[0].text, /you have not opened this symbol/);
  assert.match(d.blockers[0].text, /no baseline/);
  assert.equal(d.current.available, false);
});

test('a volume rule with no volume says so rather than reading it as zero', () => {
  const d = diagnose(
    alert({ type: AlertType.UNUSUAL_VOLUME, threshold: 3 }),
    item({ volumeRatio: null }),
  );

  assert.deepEqual(codes(d), [BlockerCode.VALUE_UNAVAILABLE]);
  assert.match(d.blockers[0].text, /volume_not_reported/);
  assert.match(d.blockers[0].text, /multiple of normal cannot be formed/);
});

test('thin history behind a signal is surfaced as unavailable, not as calm', () => {
  const d = diagnose(
    alert({ type: AlertType.ATTENTION_HIGH, threshold: null }),
    item({ z: null, volumeRatio: null, marketExcess: null }),
  );

  /**
   * The distinction that matters: "we measured and it was ordinary" and "we
   * could not measure" both produce a low score, and only one of them means
   * the market was quiet.
   */
  assert.ok(signalCodes(d).includes('price_anomaly_unavailable'));
  assert.ok(signalCodes(d).includes('volume_unavailable'));
  assert.ok(signalCodes(d).includes('market_unavailable'));
  for (const signal of d.signals.filter((s) => s.code.endsWith('_unavailable'))) {
    assert.equal(signal.available, false);
    assert.ok(signal.reason, 'each carries the engine reason code');
  }
});

// ============================================================== stale data

test('stale data is reported as "not evaluated", not as a condition not met', () => {
  // The price is well past the threshold, but the observation is stale.
  const d = diagnose(alert({ threshold: 1350 }), item({ price: 1500, state: 'stale' }));

  assert.equal(d.status, DiagnosisStatus.BLOCKED);
  assert.deepEqual(
    codes(d),
    [BlockerCode.DATA_QUALITY],
    'and it is the ONLY blocker listed',
  );
  assert.match(d.blockers[0].text, /Not evaluated/);
  assert.match(d.blockers[0].text, /stale/);
  assert.match(d.blockers[0].text, /only run against live or delayed data/);
  assert.equal(d.met, null, 'the condition was never tested, so it has no verdict');

  /**
   * Listing "condition not met" here would be a lie: the rule was not checked
   * and found wanting, it was not checked at all. A permanently stale feed must
   * not be able to hide behind language that suggests a quiet market.
   */
  assert.ok(!codes(d).includes(BlockerCode.CONDITION_NOT_MET));
});

test('a closed market is reported as not evaluated too', () => {
  const d = diagnose(alert({ threshold: 1350 }), item({ price: 1500, state: 'market_closed' }));

  assert.equal(d.status, DiagnosisStatus.BLOCKED);
  assert.equal(d.blockers[0].code, BlockerCode.DATA_QUALITY);
  assert.match(d.blockers[0].text, /market closed/);
});

test('delayed data is evaluated, because delay is not staleness', () => {
  const d = diagnose(alert({ threshold: 1350 }), item({ price: 1400, state: 'delayed' }));

  assert.equal(d.status, DiagnosisStatus.WOULD_FIRE);
  assert.deepEqual(codes(d), []);
  assert.equal(d.met, true);
});

// ======================================================= condition not crossed

test('an already-fired alert explains that it is waiting to reset', () => {
  /**
   * The case users most often mistake for a bug: the condition IS true, and
   * still nothing fires, because this crossing has already been reported.
   */
  const d = diagnose(
    alert({ threshold: 1350, armed: false, lastObserved: 1352, fireCount: 1 }),
    item({ price: 1360 }),
  );

  assert.equal(d.status, DiagnosisStatus.AWAITING_RESET);
  assert.deepEqual(codes(d), [BlockerCode.AWAITING_RESET]);
  assert.equal(d.met, true, 'the condition is satisfied...');
  assert.equal(d.armed, false, '...but the alert is disarmed');

  assert.match(d.blockers[0].text, /Already fired at ₹1352/);
  assert.match(d.blockers[0].text, /one crossing is reported once/);
  // The reset boundary is the threshold less the hysteresis band.
  assert.equal(d.blockers[0].resetsAt, 1348.65);
  assert.match(d.blockers[0].text, /₹1348\.65/);
});

test('a disarmed alert whose value has come back is simply not met', () => {
  const d = diagnose(
    alert({ threshold: 1350, armed: false, lastObserved: 1352 }),
    item({ price: 1300 }),
  );

  // Back below the line: the next evaluation will re-arm it, and the honest
  // description now is the distance, not the latch.
  assert.equal(d.status, DiagnosisStatus.NOT_MET);
  assert.deepEqual(codes(d), [BlockerCode.CONDITION_NOT_MET]);
});

test('a falls-below rule reports the distance in its own direction', () => {
  const d = diagnose(
    alert({ type: AlertType.PRICE_FALLS_BELOW, threshold: 1300 }),
    item({ price: 1345.5 }),
  );

  assert.match(d.blockers[0].text, /₹45\.5 above your ₹1300 threshold/);
});

test('a change rule reports the shortfall in percentage points', () => {
  const d = diagnose(
    alert({ type: AlertType.CHANGE_SINCE_VIEWED_EXCEEDS, threshold: 2 }),
    item({ changePct: -0.8 }),
  );

  assert.equal(d.current.text, '-0.8%');
  assert.match(d.blockers[0].text, /1\.2 percentage points short of the 2% you set/);
});

test('an alert on an unwatched symbol says exactly that', () => {
  const d = diagnose(alert(), null);

  assert.equal(d.status, DiagnosisStatus.BLOCKED);
  assert.deepEqual(codes(d), [BlockerCode.SYMBOL_NOT_WATCHED]);
  assert.match(d.blockers[0].text, /not on your watchlist/);
  assert.deepEqual(d.signals, [], 'and there are no facts to report');
});

test('a would-fire alert has no blockers at all', () => {
  const d = diagnose(alert({ threshold: 1350 }), item({ price: 1400 }));

  assert.equal(d.status, DiagnosisStatus.WOULD_FIRE);
  assert.deepEqual(codes(d), []);
  assert.equal(d.met, true);
});

// ============================================================== why fired

test('a fired alert reports the rule, the crossing value, and the signals', () => {
  const fired = explainFiring({
    alert: alert({ threshold: 1350 }),
    item: item({ price: 1361.4, level: 'HIGH', score: 0.81, z: 3.2, volumeRatio: 2.8 }),
    value: 1361.4,
    engineParams: ENGINE_PARAMS,
  });

  assert.equal(fired.rule, 'Price crosses above ₹1350');
  assert.equal(fired.threshold, 1350);
  assert.equal(fired.crossedWith.value, 1361.4);
  assert.equal(fired.crossedWith.text, '₹1361.4');
  assert.equal(fired.crossedWith.dataQuality, 'LIVE');
  assert.equal(fired.level, 'HIGH');
  assert.equal(fired.score, 0.81);

  // Which signals contributed, largest first.
  assert.ok(fired.contributing.length > 0);
  const sorted = [...fired.contributing].sort((a, b) => b.contribution - a.contribution);
  assert.deepEqual(fired.contributing, sorted, 'ordered by contribution');

  // And the same factual sentences, now describing an unusual stock.
  assert.ok(fired.signals.some((s) => s.code === 'price_movement_unusual'));
  assert.ok(fired.signals.some((s) => s.code === 'volume_elevated'));
});

test('contributing signals exclude the unavailable and the zero', () => {
  const contributions = contributingSignals(
    item({ z: 3, volumeRatio: 1, marketExcess: 1.5, sectorExcess: null }),
  );

  const names = contributions.map((c) => c.signal);
  assert.ok(names.includes('priceAnomaly'), 'it contributed');
  assert.ok(names.includes('marketRelative'), 'so did this');
  assert.ok(!names.includes('volumeAnomaly'), 'a ratio of 1 contributes nothing');
  assert.ok(!names.includes('sectorRelative'), 'and an unavailable signal contributes nothing');
});

test('every rule type has a human description', () => {
  for (const type of Object.values(AlertType)) {
    const text = describeRule({ type, threshold: type === 'attention_high' ? null : 10 });
    assert.ok(text.length > 0);
    assert.notEqual(text, type, `${type} needs prose, not its own code`);
  }
});

// ============================================================ determinism

test('a diagnosis is deterministic for the same inputs', () => {
  const a = alert({ type: AlertType.ATTENTION_HIGH, threshold: null });
  const i = item({ level: 'MODERATE', score: 0.43 });

  assert.equal(JSON.stringify(diagnose(a, i)), JSON.stringify(diagnose(a, i)));
});

test('the diagnosis reads the same rules the evaluator fires from', () => {
  /**
   * The guarantee that makes the audit trustworthy: a diagnosis saying
   * "would_fire" and an evaluation that actually fires must agree, because both
   * read the conditions from alert-rules.js. If they ever diverged, the
   * explanation would be describing a rule the system does not use.
   */
  const db = createDatabase(':memory:');
  const store = createAlertStore(db, ALERT_PARAMS);
  const created = store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const below = item({ price: 1340 });
  const above = item({ price: 1360 });

  assert.equal(diagnose(created.alert, below).status, DiagnosisStatus.NOT_MET);
  assert.equal(
    store.evaluate({ userId: USER, evaluation: { items: [below] }, now: T0 }).fired.length,
    0,
    'diagnosis says not met; evaluation fires nothing',
  );

  assert.equal(diagnose(created.alert, above).status, DiagnosisStatus.WOULD_FIRE);
  assert.equal(
    store.evaluate({ userId: USER, evaluation: { items: [above] }, now: T0 + 1000 }).fired.length,
    1,
    'diagnosis says would fire; evaluation fires',
  );

  // And once fired, the diagnosis switches to the latch explanation.
  const afterFiring = store.list(USER)[0];
  assert.equal(diagnose(afterFiring, above).status, DiagnosisStatus.AWAITING_RESET);
  assert.equal(
    store.evaluate({ userId: USER, evaluation: { items: [above] }, now: T0 + 2000 }).fired.length,
    0,
    'and evaluation agrees by not refiring',
  );

  db.close();
});

test('the firing explanation is stored with the event, not recomputed later', () => {
  const db = createDatabase(':memory:');
  const store = createAlertStore(db, ALERT_PARAMS);
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  store.evaluate({
    userId: USER,
    evaluation: { items: [item({ price: 1355, z: 2.5, volumeRatio: 2.2, level: 'MODERATE' })] },
    now: T0,
    engineParams: ENGINE_PARAMS,
  });

  /**
   * Read back through a fresh store, as the notification list does. The
   * explanation describes the moment that fired - which is why it is persisted
   * rather than recalculated from whatever the market is doing when someone
   * finally reads the notification.
   */
  const reopened = createAlertStore(db, ALERT_PARAMS);
  const event = reopened.events(USER, 1)[0];

  assert.ok(event.diagnosis, 'the event carries its own explanation');
  assert.equal(event.diagnosis.rule, 'Price crosses above ₹1350');
  assert.equal(event.diagnosis.crossedWith.value, 1355);
  assert.ok(event.diagnosis.signals.some((s) => s.code === 'price_movement_unusual'));
  assert.ok(event.diagnosis.contributing.length > 0);

  db.close();
});
