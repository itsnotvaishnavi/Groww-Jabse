/**
 * Alerts: the crossing state machine, the data-quality gates, and persistence.
 *
 * The centrepiece is the exact sequence from the brief - 1348, 1350, 1351,
 * 1352, 1348, 1352 against a ₹1350 threshold - because that sequence is the
 * whole difference between an alert that answers an edge and one that shouts on
 * every poll.
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
const { createAlertStore, AlertType, validateDefinition } = await import('../src/alerts.js');
const { ValidationError } = await import('../src/symbols.js');

const USER = 'test-user';
const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);

/** The production bands, so these tests exercise the shipped behaviour. */
const PARAMS = {
  hysteresisPricePct: 0.001,
  hysteresisChangePct: 0.25,
  hysteresisVolumeRatio: 0.2,
  feedLimit: 20,
};

function fresh(params = PARAMS) {
  const db = createDatabase(':memory:');
  return { db, store: createAlertStore(db, params) };
}

/**
 * A minimal engine evaluation - the shape alerts read. Built by hand rather
 * than by running the engine, so each test controls exactly one variable.
 */
function evaluation(items) {
  return {
    items: items.map((item) => ({
      symbol: item.symbol ?? 'RELIANCE',
      latest: item.price == null ? null : { price: item.price },
      freshness: { state: item.state ?? 'live' },
      dataQuality: (item.state ?? 'live').toUpperCase(),
      level: item.level ?? 'LOW',
      meaningfulScore: item.score ?? 0.1,
      confidence: item.confidence ?? 0.9,
      changeSinceViewed:
        item.changePct == null
          ? { available: false, reason: 'never_viewed' }
          : { available: true, percent: item.changePct },
      features: {
        volumeAnomaly:
          item.volumeRatio == null
            ? { available: false, reason: 'insufficient_history' }
            : { available: true, ratio: item.volumeRatio },
      },
    })),
  };
}

/** Feed a sequence of prices through one alert, returning fires per step. */
function feed(store, prices, { symbol = 'RELIANCE', state = 'live' } = {}) {
  return prices.map((price, i) => {
    const result = store.evaluate({
      userId: USER,
      evaluation: evaluation([{ symbol, price, state }]),
      now: T0 + i * 15_000,
    });
    return result.fired.length;
  });
}

// ===================================================== definition validation

test('definitions are validated, and the benchmark rule still applies', () => {
  assert.deepEqual(
    validateDefinition({ symbol: 'reliance', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 }),
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
  );

  // Canonicalisation applies here too: one instrument, one alert.
  assert.equal(
    validateDefinition({ symbol: 'RELIANCE.NS', type: AlertType.PRICE_FALLS_BELOW, threshold: 1 })
      .symbol,
    'RELIANCE',
  );

  assert.throws(
    () => validateDefinition({ symbol: 'RELIANCE', type: 'nonsense', threshold: 1 }),
    ValidationError,
  );
  assert.throws(
    () => validateDefinition({ symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE }),
    ValidationError,
    'a price alert needs a price',
  );
  assert.throws(
    () =>
      validateDefinition({ symbol: 'RELIANCE', type: AlertType.UNUSUAL_VOLUME, threshold: 0.5 }),
    ValidationError,
    'a volume multiple below 1 is not unusual',
  );

  // A level alert takes no threshold, and quietly accepting one would imply it
  // did something.
  assert.equal(
    validateDefinition({ symbol: 'RELIANCE', type: AlertType.ATTENTION_HIGH }).threshold,
    null,
  );
  assert.throws(
    () =>
      validateDefinition({ symbol: 'RELIANCE', type: AlertType.ATTENTION_HIGH, threshold: 5 }),
    ValidationError,
  );
});

test('creating the same alert twice returns the first rather than stacking', () => {
  const { store } = fresh();
  const definition = { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 };

  const first = store.create(USER, definition, T0);
  const second = store.create(USER, definition, T0);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.alert.id, first.alert.id);
  /**
   * Duplicates would all fire at once on the same crossing, so the user would
   * get three notifications for one event.
   */
  assert.equal(store.count(USER), 1);
});

// ========================================== the crossing sequence from the brief

test('the ₹1350 sequence behaves exactly as specified', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const fires = feed(store, [1348, 1350, 1351, 1352, 1348, 1352]);

  assert.deepEqual(
    fires,
    [0, 1, 0, 0, 0, 1],
    '1348 nothing · 1350 fires · 1351 and 1352 do not refire · 1348 resets · 1352 fires again',
  );

  const events = store.events(USER, 10);
  assert.equal(events.length, 2, 'two events for two genuine crossings');
  assert.equal(events[0].observed, 1352, 'newest first');
  assert.equal(events[1].observed, 1350);
  assert.equal(store.list(USER)[0].fireCount, 2);
});

test('a price that never reaches the threshold never fires', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const fires = feed(store, [1340, 1345, 1349, 1349.9, 1348]);

  assert.deepEqual(fires, [0, 0, 0, 0, 0]);
  assert.equal(store.events(USER, 10).length, 0);
  assert.equal(store.list(USER)[0].armed, true, 'and it stays armed, ready');
});

test('hysteresis suppresses chatter around the threshold', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  /**
   * The band is 0.1% of 1350, so re-arming needs a price below 1348.65. A
   * price oscillating either side of the line satisfies "crossed" repeatedly,
   * and without the band would fire on every wobble.
   */
  const fires = feed(store, [1350, 1349.8, 1350.2, 1349.5, 1351, 1348.0, 1350.5]);

  assert.deepEqual(
    fires,
    [1, 0, 0, 0, 0, 0, 1],
    'one fire for the first crossing, nothing for the wobble, one for the real round trip',
  );
});

test('falls-below is the mirror image, including its reset direction', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_FALLS_BELOW, threshold: 1300 },
    T0,
  );

  const fires = feed(store, [1310, 1300, 1295, 1290, 1315, 1290]);

  assert.deepEqual(
    fires,
    [0, 1, 0, 0, 0, 1],
    'fires at the threshold, stays quiet below it, re-arms above it',
  );

  const event = store.events(USER, 1)[0];
  assert.match(event.reason, /fell below/);
  assert.match(event.reason, /1300/);
});

// ============================================================= other types

test('an attention-level alert fires on entering HIGH, not while it stays there', () => {
  const { store } = fresh();
  store.create(USER, { symbol: 'RELIANCE', type: AlertType.ATTENTION_HIGH }, T0);

  const levels = ['LOW', 'MODERATE', 'HIGH', 'HIGH', 'MODERATE', 'HIGH'];
  const fires = levels.map((level, i) => {
    const result = store.evaluate({
      userId: USER,
      evaluation: evaluation([{ price: 1000, level, score: 0.8, confidence: 0.9 }]),
      now: T0 + i * 15_000,
    });
    return result.fired.length;
  });

  assert.deepEqual(
    fires,
    [0, 0, 1, 0, 0, 1],
    'fires on entry to HIGH, silent while it remains, fires again after leaving and returning',
  );

  const event = store.events(USER, 1)[0];
  assert.match(event.reason, /attention level became HIGH/);
  assert.match(event.reason, /confidence/, 'and says how much to believe it');
});

test('a volume alert fires on the spike and re-arms once it subsides', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.UNUSUAL_VOLUME, threshold: 3 },
    T0,
  );

  const ratios = [1.2, 2.9, 3.1, 4.5, 2.5, 3.4];
  const fires = ratios.map((volumeRatio, i) => {
    const result = store.evaluate({
      userId: USER,
      evaluation: evaluation([{ price: 1000, volumeRatio }]),
      now: T0 + i * 15_000,
    });
    return result.fired.length;
  });

  assert.deepEqual(fires, [0, 0, 1, 0, 0, 1]);
  assert.match(store.events(USER, 1)[0].reason, /normal volume/);
});

test('a change-since-viewed alert measures magnitude, either direction', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.CHANGE_SINCE_VIEWED_EXCEEDS, threshold: 2 },
    T0,
  );

  const changes = [0.5, -2.4, -2.8, 0.1, 3.1];
  const fires = changes.map((changePct, i) => {
    const result = store.evaluate({
      userId: USER,
      evaluation: evaluation([{ price: 1000, changePct }]),
      now: T0 + i * 15_000,
    });
    return result.fired.length;
  });

  assert.deepEqual(fires, [0, 1, 0, 0, 1], 'a 2.4% FALL satisfies "changes by more than 2%"');
});

test('an unavailable value is skipped, not treated as zero', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.CHANGE_SINCE_VIEWED_EXCEEDS, threshold: 2 },
    T0,
  );

  // Never viewed, so there is no change to compare.
  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1000, changePct: null }]),
    now: T0,
  });

  assert.equal(result.fired.length, 0);
  assert.equal(result.skipped[0].reason, 'value_unavailable');
  assert.equal(store.list(USER)[0].lastSkippedReason, 'value_unavailable');
});

// ======================================================== data quality gates

test('a stale observation cannot fire a price alert', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1400, state: 'stale' }]),
    now: T0,
  });

  assert.equal(result.fired.length, 0, 'well past the threshold, but not on a stale price');
  assert.equal(result.skipped[0].reason, 'data_quality:stale');

  /**
   * And crucially the crossing state is untouched. Disarming on data we have
   * just declared untrustworthy would let a stale reading suppress the real
   * crossing that follows.
   */
  assert.equal(store.list(USER)[0].armed, true);

  // A live observation at the same price then fires normally.
  const live = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1400, state: 'live' }]),
    now: T0 + 15_000,
  });
  assert.equal(live.fired.length, 1);
});

test('a closed market is not movement', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1400, state: 'market_closed' }]),
    now: T0,
  });

  /**
   * The last traded price sitting above a threshold is not a crossing - nothing
   * is happening while the exchange is shut, so nothing should fire.
   */
  assert.equal(result.fired.length, 0);
  assert.equal(result.skipped[0].reason, 'data_quality:market_closed');
  assert.equal(store.list(USER)[0].armed, true);
});

test('absent data is skipped rather than read as a price of zero', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_FALLS_BELOW, threshold: 1300 },
    T0,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: null, state: 'no_data' }]),
    now: T0,
  });

  assert.equal(result.fired.length, 0, 'a missing price must not read as below the threshold');
  assert.equal(result.skipped[0].reason, 'data_quality:no_data');
});

test('a delayed observation is trusted, because delay is not staleness', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1355, state: 'delayed' }]),
    now: T0,
  });

  /**
   * Yahoo's quotes are always delayed; refusing to fire on them would make
   * alerts useless against the real feed. Delayed data is late, not wrong -
   * which is exactly the distinction the freshness layer exists to draw.
   */
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].dataQuality, 'DELAYED');
});

test('an alert on an unwatched symbol is skipped and says so', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'ZOMATO', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 300 },
    T0,
  );

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ symbol: 'RELIANCE', price: 1400 }]),
    now: T0,
  });

  assert.equal(result.fired.length, 0);
  assert.equal(result.skipped[0].reason, 'symbol_not_watched');
});

// ============================================================= persistence

test('crossing state survives a restart', () => {
  const { db, store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  assert.deepEqual(feed(store, [1348, 1352]), [0, 1], 'fires once');
  assert.equal(store.list(USER)[0].armed, false, 'and is now disarmed');

  /**
   * Rebuild the store over the SAME database - which is what a process restart
   * is. If `armed` lived in memory, the price still sitting at 1352 would fire
   * again the moment the server came up, turning a move the user has already
   * been told about back into news.
   */
  const reopened = createAlertStore(db, PARAMS);

  assert.equal(reopened.list(USER)[0].armed, false, 'still disarmed after restart');
  assert.deepEqual(feed(reopened, [1353, 1355]), [0, 0], 'and it does not refire');

  // The round trip still re-arms it across the restart boundary.
  assert.deepEqual(feed(reopened, [1348, 1352]), [0, 1]);
  assert.equal(reopened.list(USER)[0].fireCount, 2);
});

test('fired events persist with what triggered them and why', () => {
  const { db, store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );
  feed(store, [1348, 1351]);

  const reopened = createAlertStore(db, PARAMS);
  const events = reopened.events(USER, 10);

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.symbol, 'RELIANCE');
  assert.equal(event.type, AlertType.PRICE_CROSSES_ABOVE);
  assert.equal(event.threshold, 1350);
  assert.equal(event.observed, 1351);
  assert.equal(event.dataQuality, 'LIVE');
  assert.match(event.reason, /RELIANCE crossed above ₹1350/);
  assert.match(event.reason, /observed ₹1351/, 'the observation, not just the rule');
});

test('the notification list tracks what has not been seen', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );
  feed(store, [1348, 1351, 1348, 1352]);

  assert.equal(store.unacknowledgedCount(USER), 2);
  assert.equal(store.acknowledgeAll(USER), 2);
  assert.equal(store.unacknowledgedCount(USER), 0);
  assert.equal(store.events(USER, 10).length, 2, 'acknowledging does not delete the history');
});

test('alerts are scoped to a user, and removable', () => {
  const { store } = fresh();
  const mine = store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );
  store.create(
    'someone-else',
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );

  assert.equal(store.list(USER).length, 1);
  assert.equal(store.list('someone-else').length, 1);

  assert.equal(store.remove('someone-else', mine.alert.id), false, 'not theirs to remove');
  assert.equal(store.remove(USER, mine.alert.id), true);
  assert.equal(store.list(USER).length, 0);
  assert.equal(store.list('someone-else').length, 1, 'and theirs is untouched');
});

test('evaluation is deterministic and reports what it did', () => {
  const { store } = fresh();
  store.create(
    USER,
    { symbol: 'RELIANCE', type: AlertType.PRICE_CROSSES_ABOVE, threshold: 1350 },
    T0,
  );
  store.create(USER, { symbol: 'RELIANCE', type: AlertType.ATTENTION_HIGH }, T0);

  const result = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1355, level: 'HIGH' }]),
    now: T0,
  });

  assert.equal(result.evaluated, 2);
  assert.equal(result.fired.length, 2, 'both conditions held');
  assert.equal(result.skipped.length, 0);
  for (const alert of result.fired) {
    assert.ok(Number.isFinite(alert.observed));
    assert.ok(alert.reason.length > 0);
    assert.equal(alert.firedAt, T0);
  }

  // Re-running against identical input changes nothing further.
  const again = store.evaluate({
    userId: USER,
    evaluation: evaluation([{ price: 1355, level: 'HIGH' }]),
    now: T0 + 15_000,
  });
  assert.equal(again.fired.length, 0);
});
