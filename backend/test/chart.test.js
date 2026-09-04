/**
 * The chart series.
 *
 * The interesting assertions are the honest ones: that a gap stays a gap, that
 * the marker price is one the user could actually have seen, and that a window
 * we cannot fill says so rather than implying data it does not have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEV_USER_ID = 'test-user';
process.env.INGEST_ENABLED = 'false';

const { createDatabase } = await import('../src/db.js');
const { createSnapshotLog } = await import('../src/snapshot-log.js');
const { createWatchlist } = await import('../src/watchlist.js');
const { buildChart, ChartRange } = await import('../src/chart.js');

const T0 = Date.UTC(2026, 8, 4, 5, 0, 0);
const MIN = 60_000;
const USER = 'test-user';

function fresh() {
  const db = createDatabase(':memory:');
  return { db, log: createSnapshotLog(db), watchlist: createWatchlist(db) };
}

/** Write one observation per minute, ending at `endAt`. */
function seed(log, symbol, { minutes = 120, price, endAt = T0, skip = () => false }) {
  const rows = [];
  for (let i = minutes; i >= 0; i -= 1) {
    const step = minutes - i;
    if (skip(step)) continue;
    const t = endAt - i * MIN;
    rows.push({
      symbol,
      timestamp: t,
      price: price(step),
      volume: 1000,
      source: 'test',
      confidence: 1,
      ingestedAt: t,
    });
  }
  log.appendMany(rows);
}

/** A gentle ramp with a distinct peak and trough at known offsets. */
const shaped = (base) => (i) => {
  if (i === 30) return base * 1.05; // the high, 90 minutes before the end
  if (i === 80) return base * 0.94; // the low, 40 minutes before the end
  return Math.round(base * (1 + 0.0005 * Math.sin(i / 3)) * 100) / 100;
};

const chartFor = ({ log, watchlist }, symbol, rangeKey, now = T0) =>
  buildChart({
    snapshotLog: log,
    symbol,
    entry: watchlist.get(USER, symbol),
    rangeKey,
    now,
  });

test('"since I checked" spans exactly the user\'s absence', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });
  h.watchlist.markViewed(USER, 'STOCK', T0 - 45 * MIN);

  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);

  assert.equal(chart.range.key, ChartRange.SINCE_VIEWED);
  assert.equal(chart.range.label, 'Since you checked');
  assert.equal(chart.range.from, T0 - 45 * MIN, 'starts at the moment they looked');
  assert.equal(chart.range.to, T0, 'and runs to now');
  assert.ok(chart.pointCount > 30, `got ${chart.pointCount} points`);
});

test('1D is a fixed 24-hour window, not the absence', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });
  h.watchlist.markViewed(USER, 'STOCK', T0 - 5 * MIN);

  const chart = chartFor(h, 'STOCK', ChartRange.ONE_DAY);

  assert.equal(chart.range.key, ChartRange.ONE_DAY);
  assert.equal(chart.range.spanMs, 24 * 60 * MIN);
  // Only two hours are held, so the window is truncated and says so.
  assert.equal(chart.range.truncated, true);
  assert.ok(chart.range.drawnSpanMs < 3 * 60 * MIN);
});

test('the period high and low are the range\'s own, with their timestamps', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });
  h.watchlist.markViewed(USER, 'STOCK', T0 - 120 * MIN);

  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);

  assert.equal(chart.high.price, 105, 'the seeded peak');
  assert.equal(chart.low.price, 94, 'the seeded trough');
  assert.equal(chart.high.timestamp, T0 - 90 * MIN);
  assert.equal(chart.low.timestamp, T0 - 40 * MIN);
  assert.ok(chart.high.price > chart.low.price);
});

test('a narrower range reports a narrower high and low', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });

  // Looked after the peak but before the trough: the peak is out of range.
  h.watchlist.markViewed(USER, 'STOCK', T0 - 60 * MIN);
  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);

  assert.ok(chart.high.price < 105, 'the earlier peak is outside this window');
  assert.equal(chart.low.price, 94, 'the trough is inside it');
  assert.ok(chart.high.timestamp >= T0 - 60 * MIN, 'and both sit inside the range');
  assert.ok(chart.low.timestamp >= T0 - 60 * MIN);
});

test('the last-viewed marker carries a price the user could have seen', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });

  const viewedAt = T0 - 45 * MIN + 20_000; // 20s after an observation landed
  h.watchlist.markViewed(USER, 'STOCK', viewedAt);

  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);
  const marker = chart.lastViewed;

  assert.equal(marker.available, true);
  assert.equal(marker.timestamp, viewedAt);
  assert.equal(marker.inRange, true);
  assert.equal(marker.hasBaseline, true);

  /**
   * The marker price is the as-of price - the newest observation at or BEFORE
   * the visit. Taking the nearest observation instead could pick one that
   * arrived after they left, showing them a price they could not have seen.
   */
  assert.ok(marker.priceObservedAt <= viewedAt);
  assert.equal(marker.priceObservedAt, T0 - 45 * MIN);
});

test('a never-viewed symbol falls back to 1D and admits it', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  seed(h.log, 'STOCK', { price: shaped(100) });

  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);

  assert.equal(chart.range.requestedKey, ChartRange.SINCE_VIEWED);
  assert.equal(chart.range.key, ChartRange.ONE_DAY, 'served a different range');
  assert.equal(chart.range.fellBackTo, ChartRange.ONE_DAY);
  assert.equal(chart.range.reason, 'never_viewed');
  assert.equal(chart.lastViewed.available, false, 'and there is no marker to draw');
  assert.equal(chart.lastViewed.reason, 'never_viewed');
});

test('a gap in the feed stays a gap', () => {
  const h = fresh();
  h.watchlist.add(USER, 'GAPPY');

  // A twenty-minute hole in the middle of the series.
  seed(h.log, 'GAPPY', {
    price: shaped(100),
    skip: (step) => step >= 50 && step < 70,
  });
  h.watchlist.markViewed(USER, 'GAPPY', T0 - 120 * MIN);

  const chart = chartFor(h, 'GAPPY', ChartRange.SINCE_VIEWED);

  assert.ok(chart.gaps > 10, `the hole survives as nulls, got ${chart.gaps}`);
  assert.ok(
    chart.points.some((p) => p === null),
    'nulls are preserved rather than dropped',
  );
  /**
   * Why this matters: if the nulls were filtered out, the frontend would join
   * across the hole and draw a confident straight move that never happened.
   */
  const nullIndex = chart.points.findIndex((p) => p === null);
  assert.ok(nullIndex > 0 && nullIndex < chart.points.length - 1, 'the gap is interior');
});

test('bar size respects the feed cadence, not just the span', () => {
  const h = fresh();
  h.watchlist.add(USER, 'STOCK');
  // One observation a minute.
  seed(h.log, 'STOCK', { price: shaped(100) });
  h.watchlist.markViewed(USER, 'STOCK', T0 - 45 * MIN);

  const chart = chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);

  /**
   * Sizing on span alone put 15-second bars against 60-second observations, so
   * three bars in four were empty and the line drew as dashes. The bar can
   * never be finer than the interval the data arrives on.
   */
  assert.ok(chart.range.barMs >= MIN, `bar must be >= the cadence, got ${chart.range.barMs}`);
  assert.ok(chart.gaps <= 2, `so the line is continuous, got ${chart.gaps} gaps`);
});

test('too few observations refuses to draw a line', () => {
  const h = fresh();
  h.watchlist.add(USER, 'THIN');
  seed(h.log, 'THIN', { minutes: 1, price: () => 100 });
  h.watchlist.markViewed(USER, 'THIN', T0 - 30 * MIN);

  const chart = chartFor(h, 'THIN', ChartRange.SINCE_VIEWED);

  // Two points make a straight line that tells the user nothing true.
  assert.equal(chart.insufficientPoints, true);
  assert.equal(chart.pointCount, 0);
  assert.ok(chart.observed < chart.minPoints);
  assert.equal(chart.high, undefined, 'and no high is invented from two points');
});

test('the chart is deterministic for a fixed clock', () => {
  const build = () => {
    const h = fresh();
    h.watchlist.add(USER, 'STOCK', T0 - 200 * MIN);
    seed(h.log, 'STOCK', { price: shaped(100) });
    h.watchlist.markViewed(USER, 'STOCK', T0 - 45 * MIN);
    return chartFor(h, 'STOCK', ChartRange.SINCE_VIEWED);
  };

  assert.equal(JSON.stringify(build()), JSON.stringify(build()));
});

test('every number the chart emits is finite', () => {
  const h = fresh();
  h.watchlist.add(USER, 'ODD');
  // Constant price: zero range, which is where a naive y-scale divides by zero.
  seed(h.log, 'ODD', { price: () => 100 });
  h.watchlist.markViewed(USER, 'ODD', T0 - 60 * MIN);

  const chart = chartFor(h, 'ODD', ChartRange.SINCE_VIEWED);

  assert.equal(chart.high.price, chart.low.price, 'a flat series has no range');
  assert.equal(chart.changePct, 0);
  for (const value of [chart.high.price, chart.low.price, chart.changePct, chart.range.barMs]) {
    assert.ok(Number.isFinite(value));
  }
  for (const point of chart.points.filter(Boolean)) {
    assert.ok(Number.isFinite(point.price) && Number.isFinite(point.t));
  }
});
