/**
 * The price chart.
 *
 * Hand-rolled inline SVG, consistent with the project's no-framework,
 * no-dependency stance - a price line with two markers does not need a
 * charting library.
 *
 * Two ranges only: "Since I checked" and 1D. The row of 1D/1W/1M/1Y buttons
 * every other price chart carries would dilute the single comparison this
 * product is making, which is against the user's own last visit.
 *
 * Everything drawn here is a field from /api/chart. This module scales and
 * positions; it does not decide what the period high is, where the marker
 * goes, or which window is in view. Formatting helpers arrive as `deps` rather
 * than being imported, to keep this module free of a cycle with app.js.
 */

const CHART = {
  width: 800,
  height: 224,
  padTop: 26,
  padRight: 78,
  padBottom: 26,
  padLeft: 10,
};

const PLOT_W = CHART.width - CHART.padLeft - CHART.padRight;
const PLOT_H = CHART.height - CHART.padTop - CHART.padBottom;

const RANGES = [
  { key: 'since_viewed', label: 'Since I checked' },
  { key: '1d', label: '1D' },
];

export function createChart(deps) {
  // clockIst comes from app.js like every other formatter this module uses -
  // it had been a private second copy of the identical function.
  const { api, inr, escapeHtml, directionClass, signed, duration, clockIst } = deps;

  /** Which range each symbol is showing, so two open rows do not fight. */
  const selected = new Map();

  function svgFor(data) {
    const { range, points, high, low, first, last, lastViewed } = data;

    const from = range.drawnFrom;
    const to = range.to;
    const spanMs = Math.max(1, to - from);

    /**
     * Headroom above and below, so the period high and low sit inside the plot
     * rather than exactly on its edges where their markers would clip.
     */
    const priceSpan = high.price - low.price;
    const pad = priceSpan > 0 ? priceSpan * 0.12 : Math.max(high.price * 0.001, 0.01);
    const yMin = low.price - pad;
    const yMax = high.price + pad;

    const x = (t) => CHART.padLeft + ((t - from) / spanMs) * PLOT_W;
    const y = (price) => CHART.padTop + (1 - (price - yMin) / (yMax - yMin || 1)) * PLOT_H;

    /**
     * The line breaks at gaps rather than joining across them. Bridging a
     * ten-minute outage would draw a confident straight move that never
     * happened.
     */
    const segments = [];
    let run = [];
    for (const point of points) {
      if (point === null) {
        if (run.length > 0) segments.push(run);
        run = [];
        continue;
      }
      run.push(point);
    }
    if (run.length > 0) segments.push(run);

    const rising = last.price >= first.price;
    const stroke = rising ? 'var(--green)' : 'var(--red)';
    const fillId = `cf-${data.symbol.replace(/[^A-Za-z0-9]/g, '')}-${range.key}`;

    const pathOf = (seg) =>
      seg
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.price).toFixed(1)}`)
        .join(' ');

    const lines = segments
      .map(
        (seg) =>
          `<path d="${pathOf(seg)}" fill="none" stroke="${stroke}" stroke-width="2"
             stroke-linejoin="round" stroke-linecap="round" />`,
      )
      .join('');

    /**
     * Every segment gets its own fill, closed to the baseline.
     *
     * Filling only the longest run left one half of the chart shaded and the
     * other bare, which reads as a rendering fault rather than as a deliberate
     * gap. Per-segment fills leave the hole genuinely empty - which is the
     * honest depiction - while the rest of the line still sits on a body of
     * colour.
     */
    const baseline = (CHART.padTop + PLOT_H).toFixed(1);
    const area = segments
      .filter((seg) => seg.length > 1)
      .map(
        (seg) =>
          `<path d="${pathOf(seg)} L${x(seg.at(-1).t).toFixed(1)} ${baseline}
             L${x(seg[0].t).toFixed(1)} ${baseline} Z" fill="url(#${fillId})" />`,
      )
      .join('');

    /**
     * THE LAST-VIEWED MARKER, and the shaded region after it.
     *
     * This is the chart's whole argument: the line is when you last looked, and
     * everything shaded to its right happened while you were away. Without it
     * this is just another price chart.
     */
    /**
     * MARKER PLACEMENT.
     *
     * In "since you checked" the visit IS the left boundary of the range, so an
     * overlaid line there marks the edge of the chart and the shaded "while you
     * were away" region covers the entire plot - conveying nothing while washing
     * the colour out. Worse, its label landed on top of the change badge.
     *
     * So when the marker is the boundary, it is folded into the axis label
     * instead ("16:47 · you looked"): the same fact, stated where there is room
     * for it. The full apparatus - line, shading, dot - appears when the visit
     * falls INSIDE the window, which is when its position carries information.
     */
    const markerX = lastViewed.available && lastViewed.inRange ? x(lastViewed.timestamp) : null;
    const markerIsBoundary = markerX !== null && markerX <= CHART.padLeft + 3;

    let marker = '';
    if (markerX !== null && !markerIsBoundary) {
      const mx = markerX;
      const awayW = Math.max(0, CHART.padLeft + PLOT_W - mx);

      /**
       * The label flips to the left of the marker once the marker is past
       * two-thirds of the width. Anchored right of it, a late visit - which is
       * the common case, since people return more often than not - ran its
       * label off the edge and into the price gutter.
       */
      const flip = mx > CHART.padLeft + PLOT_W * 0.62;

      marker = `
        <rect class="chart__away" x="${mx.toFixed(1)}" y="${CHART.padTop}"
          width="${awayW.toFixed(1)}" height="${PLOT_H}" />
        <line class="chart__marker" x1="${mx.toFixed(1)}" y1="${CHART.padTop - 7}"
          x2="${mx.toFixed(1)}" y2="${CHART.padTop + PLOT_H}" />
        <text class="chart__marker-label" x="${(flip ? mx - 5 : mx + 5).toFixed(1)}"
          y="${CHART.padTop - 11}" text-anchor="${flip ? 'end' : 'start'}">
          you looked · ${clockIst(lastViewed.timestamp)}
        </text>
        ${
          lastViewed.price == null
            ? ''
            : `<circle class="chart__marker-dot" cx="${mx.toFixed(1)}"
                 cy="${y(lastViewed.price).toFixed(1)}" r="3.5" />`
        }`;
    }

    /** Period high and low: a dot, a leader line, and the price in the gutter. */
    const extreme = (point, label, cls) => {
      const px = x(point.timestamp);
      const py = y(point.price);
      const gutter = (CHART.padLeft + PLOT_W + 11).toFixed(1);

      return `
        <line class="chart__leader" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}"
          x2="${(CHART.padLeft + PLOT_W + 6).toFixed(1)}" y2="${py.toFixed(1)}" />
        <circle class="chart__extreme ${cls}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" />
        <text class="chart__price ${cls}" x="${gutter}" y="${(py + 3.5).toFixed(1)}">
          ₹${inr.format(point.price)}
        </text>
        <text class="chart__extreme-label" x="${gutter}" y="${(py + 14).toFixed(1)}">
          ${label} ${clockIst(point.timestamp)}
        </text>`;
    };

    return `
      <svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" role="img"
           aria-label="${escapeHtml(data.symbol)} price, ${escapeHtml(range.label)}">
        <defs>
          <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${stroke}" stop-opacity="0.18" />
            <stop offset="100%" stop-color="${stroke}" stop-opacity="0" />
          </linearGradient>
        </defs>

        ${marker}
        ${area}
        ${lines}
        ${extreme(high, 'high', 'up')}
        ${extreme(low, 'low', 'down')}

        <text class="chart__axis" x="${CHART.padLeft}" y="${CHART.height - 8}">
          ${clockIst(from)}${
            markerIsBoundary
              ? ' · you looked'
              : range.truncated
                ? ' · earliest held'
                : ''
          }
        </text>
        <text class="chart__axis" text-anchor="end"
          x="${(CHART.padLeft + PLOT_W).toFixed(1)}" y="${CHART.height - 8}">
          now · ${clockIst(to)}
        </text>
        <text class="chart__change ${directionClass(data.changePct ?? 0)}"
          x="${CHART.padLeft}" y="${CHART.padTop - 11}">
          ${data.changePct == null ? '' : `${signed(data.changePct)}%`}
        </text>
      </svg>`;
  }

  /** The honest small print: resolution, gaps, and any window truncation. */
  function metaFor(data) {
    if (data.insufficientPoints) return '';

    const parts = [
      `${data.pointCount} points at ${duration(data.range.barMs)} resolution`,
      data.gaps > 0 ? `${data.gaps} gap${data.gaps === 1 ? '' : 's'} in the feed` : null,
      data.range.truncated
        ? `showing ${duration(data.range.drawnSpanMs)} — all we have observed`
        : null,
      data.range.fellBackTo ? 'never viewed, so showing the last 24 hours' : null,
    ].filter(Boolean);

    return `<p class="chart__meta">${escapeHtml(parts.join(' · '))}</p>`;
  }

  function headFor(symbol, title) {
    const active = selected.get(symbol) ?? 'since_viewed';
    const buttons = RANGES.map(
      (option) =>
        `<button type="button" class="chart__range ${
          option.key === active ? 'is-active' : ''
        }" data-range="${option.key}">${option.label}</button>`,
    ).join('');

    return `<div class="chart__head">
      <span class="chart__title">${escapeHtml(title)}</span>
      <div class="chart__ranges">${buttons}</div>
    </div>`;
  }

  function bindRanges(container, symbol) {
    for (const button of container.querySelectorAll('.chart__range')) {
      button.addEventListener('click', () => {
        selected.set(symbol, button.dataset.range);
        void load(container, symbol);
      });
    }
  }

  async function load(container, symbol) {
    const active = selected.get(symbol) ?? 'since_viewed';
    container.innerHTML = `${headFor(symbol, 'Price')}<p class="chart__meta">Loading…</p>`;
    bindRanges(container, symbol);

    try {
      const data = await api(
        `/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(active)}`,
      );

      const body = data.insufficientPoints
        ? `<p class="chart__empty">
             Only ${data.observed} observation${data.observed === 1 ? '' : 's'} in this
             window — at least ${data.minPoints} are needed before a line means anything.
           </p>`
        : svgFor(data);

      container.innerHTML = `${headFor(symbol, data.range.label)}${body}${metaFor(data)}`;
    } catch (error) {
      container.innerHTML = `${headFor(symbol, 'Price')}
        <p class="chart__empty">Could not load the chart: ${escapeHtml(error.message)}</p>`;
    }

    bindRanges(container, symbol);
  }

  return { load };
}
