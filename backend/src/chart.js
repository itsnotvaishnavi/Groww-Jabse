/**
 * The chart series.
 *
 * This is the visual that carries the product's whole argument, so its default
 * range is "since you checked" rather than a calendar period: the point is not
 * what the stock did today, it is what it did while you were not looking. The
 * last-viewed marker is the line that makes that legible - everything to its
 * right happened in your absence.
 *
 * Only two ranges exist, deliberately. A row of 1D / 1W / 1M / 1Y buttons is
 * the furniture of every other price chart and it dilutes the one comparison
 * this product is making.
 *
 * All the arithmetic is here rather than in the browser: the frontend receives
 * points, a high, a low and a marker, and draws them.
 */
import { toBars } from './engine/returns.js';

/** Roughly how many points a chart needs to look continuous at ~600px wide. */
const TARGET_POINTS = 240;

/**
 * Bar sizes the grid is allowed to use.
 *
 * Snapping to a fixed ladder rather than computing span/240 exactly means the
 * bar boundaries are stable between polls - the same instants bucket the same
 * way five seconds later, so the line does not shimmer as the window slides.
 */
const BAR_LADDER = [
  15_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000,
  30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000,
];

/** A chart of two points is a straight line, which tells the user nothing. */
const MIN_POINTS = 3;

export const ChartRange = {
  SINCE_VIEWED: 'since_viewed',
  ONE_DAY: '1d',
};

const ONE_DAY_MS = 24 * 60 * 60_000;

function barSizeFor(spanMs) {
  const ideal = Math.ceil(spanMs / TARGET_POINTS);
  return BAR_LADDER.find((step) => step >= ideal) ?? BAR_LADDER[BAR_LADDER.length - 1];
}

/**
 * The typical gap between consecutive observations.
 *
 * Median rather than mean, because a single ten-minute blackout would drag a
 * mean far above the cadence the feed actually runs at and coarsen the whole
 * chart on the strength of one outage.
 */
function medianIntervalOf(ascending) {
  if (ascending.length < 2) return 0;

  const gaps = [];
  for (let i = 1; i < ascending.length; i += 1) {
    const gap = ascending[i].timestamp - ascending[i - 1].timestamp;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;

  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Bar size that satisfies both the span and the feed's own cadence. */
function barSizeFor2(spanMs, medianIntervalMs) {
  const bySpan = barSizeFor(spanMs);
  if (medianIntervalMs <= bySpan) return bySpan;
  return (
    BAR_LADDER.find((step) => step >= medianIntervalMs) ?? BAR_LADDER[BAR_LADDER.length - 1]
  );
}

/**
 * Resolve a range key into an actual window.
 *
 * "Since you checked" needs a last-viewed timestamp, so on a symbol the user
 * has never opened it falls back to 1D and says so - `fellBackTo` - rather than
 * silently showing a different period than the one the button claimed.
 */
function resolveRange(key, { lastViewedAt, now }) {
  if (key === ChartRange.SINCE_VIEWED) {
    if (lastViewedAt == null) {
      return {
        key: ChartRange.ONE_DAY,
        requestedKey: ChartRange.SINCE_VIEWED,
        fellBackTo: ChartRange.ONE_DAY,
        reason: 'never_viewed',
        label: 'Last 24 hours',
        from: now - ONE_DAY_MS,
        to: now,
      };
    }

    return {
      key: ChartRange.SINCE_VIEWED,
      requestedKey: ChartRange.SINCE_VIEWED,
      label: 'Since you checked',
      from: lastViewedAt,
      to: now,
    };
  }

  return {
    key: ChartRange.ONE_DAY,
    requestedKey: ChartRange.ONE_DAY,
    label: 'Last 24 hours',
    from: now - ONE_DAY_MS,
    to: now,
  };
}

/**
 * Build the chart payload for one symbol.
 *
 * @param entry the watchlist entry, for its lastViewedAt
 * @param now   injected, like everywhere else in this codebase, so the output
 *              is reproducible and the tests can hold the clock still
 */
export function buildChart({ snapshotLog, symbol, entry, rangeKey, now, engine }) {
  const range = resolveRange(rangeKey, { lastViewedAt: entry?.lastViewedAt ?? null, now });

  const requestedSpanMs = Math.max(1, range.to - range.from);

  const snapshots = snapshotLog.history(symbol, {
    // Padded generously so the left edge has something to carry forward from,
    // without needing the bar size decided first.
    from: range.from - 60 * 60_000,
    to: range.to,
    limit: 5000,
  });

  // history() returns newest-first; the resampler needs oldest-first.
  const ascending = [...snapshots].reverse();
  const inWindow = ascending.filter((s) => s.timestamp >= range.from);

  /**
   * Draw the window we actually hold, not the one the button names.
   *
   * A 1D button against a six-hour log was sizing its bars for 24 hours and
   * then drawing 19 points in the right-hand eighth of the axis. Clamping the
   * drawn window to the earliest observation gives the data the whole width at
   * a resolution that suits it - and `truncated` plus `observedFrom` keep it
   * honest about the difference.
   */
  const earliest = inWindow[0] ?? ascending[ascending.length - 1] ?? null;
  const effectiveFrom = earliest ? Math.max(range.from, earliest.timestamp) : range.from;
  const effectiveSpanMs = Math.max(1, range.to - effectiveFrom);

  /**
   * Bar size respects the source's own cadence as well as the span.
   *
   * Sizing on span alone produced a grid finer than the feed - 15-second bars
   * against 60-second observations - so three bars in four were empty and the
   * chart drew as dashes. A bar cannot be more informative than the interval
   * the data arrives on.
   */
  const barMs = barSizeFor2(effectiveSpanMs, medianIntervalOf(ascending));

  const bars = toBars(ascending, {
    from: effectiveFrom,
    to: range.to,
    barMs,
    /**
     * One bar, not the engine's two. On a chart a carried-forward price draws a
     * flat segment that looks like the market stood still, so the tolerance for
     * inventing one is lower here than it is for a statistic.
     */
    carryForwardBars: 1,
  });

  /**
   * Nulls are preserved rather than dropped. A gap in the feed must draw as a
   * break in the line - joining across it would render a ten-minute outage as a
   * confident straight move that never happened.
   */
  const points = bars.map((bar) =>
    bar === null ? null : { t: bar.t, price: bar.price, stale: bar.stale },
  );

  const present = points.filter(Boolean);

  if (present.length < MIN_POINTS) {
    return {
      symbol,
      range: { ...range, spanMs: requestedSpanMs, barMs, drawnFrom: effectiveFrom },
      points: [],
      pointCount: 0,
      insufficientPoints: true,
      observed: present.length,
      minPoints: MIN_POINTS,
      lastViewed: markerFor({ snapshotLog, symbol, entry, range }),
    };
  }

  /**
   * PERIOD HIGH AND LOW over the selected range - not all-time, and not the
   * y-axis bounds of whatever happened to be plotted. First occurrence wins on
   * a tie, so the marker sits at the moment the level was first reached.
   */
  let high = present[0];
  let low = present[0];
  for (const point of present) {
    if (point.price > high.price) high = point;
    if (point.price < low.price) low = point;
  }

  const first = present[0];
  const last = present[present.length - 1];
  const changePct = first.price > 0 ? ((last.price - first.price) / first.price) * 100 : null;

  return {
    symbol,
    range: {
      ...range,
      spanMs: requestedSpanMs,
      barMs,
      /**
       * What we actually hold, which is often less than what was asked for -
       * a 24-hour button on a six-hour log. Reported so the UI can label the
       * real span instead of implying a day of data it does not have.
       */
      observedFrom: first.t,
      observedTo: last.t,
      /** The window actually drawn, which is what the axis spans. */
      drawnFrom: effectiveFrom,
      drawnSpanMs: effectiveSpanMs,
      truncated: effectiveFrom > range.from + barMs,
    },

    points,
    pointCount: present.length,
    gaps: points.length - present.length,

    high: { price: high.price, timestamp: high.t },
    low: { price: low.price, timestamp: low.t },
    first: { price: first.price, timestamp: first.t },
    last: { price: last.price, timestamp: last.t },
    changePct: changePct === null ? null : Math.round(changePct * 100) / 100,

    lastViewed: markerFor({ snapshotLog, symbol, entry, range }),
  };
}

/**
 * The last-viewed marker: the whole reason this chart exists.
 *
 * The price at the marker is read with the log's as-of rule, so it is the value
 * the user could actually have seen - never one reconstructed from data that
 * arrived after they left.
 */
function markerFor({ snapshotLog, symbol, entry, range }) {
  const lastViewedAt = entry?.lastViewedAt ?? null;
  if (lastViewedAt == null) return { available: false, reason: 'never_viewed' };

  const baseline = snapshotLog.asOf(symbol, lastViewedAt);

  return {
    available: true,
    timestamp: lastViewedAt,
    /** False when the visit predates the window, so the line is off-chart. */
    inRange: lastViewedAt >= range.from && lastViewedAt <= range.to,
    price: baseline?.price ?? null,
    priceObservedAt: baseline?.timestamp ?? null,
    hasBaseline: Boolean(baseline),
  };
}
