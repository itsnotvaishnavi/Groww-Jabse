/**
 * Watchlist UI.
 *
 * Plain ES modules, no framework, no build step. The page is a function of two
 * API responses (/watchlist and /meta), re-rendered on a poll - which at this
 * size is simpler and less bug-prone than incremental DOM updates, and keeps
 * the interesting logic on the server where it can be tested.
 *
 * The design rule throughout: never show a price without also showing how much
 * to trust it. Every number is paired with its age, its source and its
 * freshness state, and any row expands to the raw observations behind it.
 */

import { createChart } from './chart.js';
import { createPanels } from './panels.js';
import { DEFAULT_SENSITIVITY, SENSITIVITY, displayGroupFor } from './sensitivity.js';

const POLL_INTERVAL_MS = 5_000;

const el = {
  sourcePill: document.getElementById('source-pill'),
  ticker: document.getElementById('ticker'),
  form: document.getElementById('add-form'),
  input: document.getElementById('symbol-input'),
  suggestions: document.getElementById('symbol-suggestions'),
  suggestList: document.getElementById('suggest-list'),
  formError: document.getElementById('form-error'),
  chips: document.getElementById('chips'),
  sort: document.getElementById('sort-select'),
  refreshNow: document.getElementById('refresh-now'),
  markAllSeen: document.getElementById('mark-all-seen'),
  sensitivity: document.getElementById('sensitivity-select'),
  historySection: document.getElementById('history-section'),
  historyChips: document.getElementById('history-chips'),
  historyBody: document.getElementById('history-body'),
  tbody: document.getElementById('watchlist'),
  empty: document.getElementById('empty-state'),
  sectionSub: document.getElementById('section-sub'),
  away: document.getElementById('away'),
  awayHeadline: document.getElementById('away-headline'),
  awaySignals: document.getElementById('away-signals'),
  awayScenarios: document.getElementById('away-scenarios'),
  scenarioList: document.getElementById('scenario-list'),
  sourceBody: document.getElementById('source-body'),
  logBody: document.getElementById('log-body'),
  alertFeed: document.getElementById('alert-feed'),
  footer: document.getElementById('footer'),
};

/** Rows the user expanded, kept across re-renders so a poll does not collapse
 *  the audit trail out from under them. */
const expanded = new Set();
let lastPayload = null;
let lastMeta = null;
let filter = 'all';

// ---------------------------------------------------------------- formatting

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact' });

/**
 * Ages are shown in the coarsest unit that is still honest. "3m ago" reads
 * better than "184s ago", but under a minute the seconds matter - that is
 * exactly the range where the user is judging whether the feed is alive.
 */
function ago(ms) {
  if (ms == null) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  return `${Math.floor(h / 24)}d ${h % 24}h ago`;
}

const duration = (ms) => ago(ms).replace(' ago', '');

/**
 * IST, 24-hour, no date. Every timestamp in this app is Indian market time
 * whatever the browser's locale says, because "13:34" meaning two different
 * instants on two machines would make the audit trail unusable.
 *
 * This one had been written out twice - privately in chart.js and inline in
 * observedAt below - so the chart and the row could have disagreed about how
 * to render the same instant.
 */
function clockIst(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * The same clock, to the second. The ingestion heartbeat needs it: the poll
 * runs every 15 seconds, so a minute-precision "last sync" would sit
 * unchanged for four consecutive ticks and prove nothing about liveness.
 */
function clockIstSeconds(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function whenIst(timestamp) {
  return new Date(timestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Seconds included. The audit trail exists to prove where a number came from,
 * and observations are only 15 seconds apart - minute precision makes four
 * distinct observations all read "13:34", which looks like the table is
 * repeating itself and undermines the very thing it is there to demonstrate.
 */
function whenIstPrecise(timestamp) {
  return new Date(timestamp).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const directionClass = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const signed = (n, digits = 2) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/** Symbols are user input and end up in markup, so they are escaped. */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

/** Build a DOM node from an HTML string, used only with escaped values. */
function node(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function stateColor(state) {
  return (
    {
      live: 'var(--live)',
      delayed: 'var(--delayed)',
      market_closed: 'var(--closed)',
      stale: 'var(--stale)',
      no_data: 'var(--nodata)',
    }[state] ?? 'transparent'
  );
}

// ------------------------------------------------------------------ requests

async function api(path, options) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body;
}

// -------------------------------------------------------------- row fragments

/**
 * The freshness pill: state plus the age of the observation. The age shows even
 * in the good cases, because "live" without a number is a claim the user has to
 * take on faith.
 *
 * A frozen scenario is the one exception: its label already names the instant
 * it was frozen at, so appending the age repeats it in different units - and
 * the same age is printed directly above, under the price. Three ways of saying
 * "26m ago" in one cell wrapped the pill onto four lines and read as clutter.
 */
function freshnessPill(freshness) {
  const age =
    freshness.ageMs == null || freshness.frozen ? '' : ` · ${ago(freshness.ageMs)}`;
  return `<span class="pill pill--${freshness.state}" title="${escapeHtml(freshness.label)}">${escapeHtml(
    freshness.label,
  )}${age}</span>`;
}

/**
 * The delta cell - the reason this app exists.
 *
 * With no baseline the cell explains *why* rather than showing a dash:
 * "never viewed" and "we had no data when you looked" are different situations,
 * and the second is the app admitting a gap in its own coverage.
 */
function deltaCell(item) {
  /**
   * One shape, from the engine. `delta` is the retained alias for
   * `changeSinceViewed` - the same object, not a second representation of it -
   * so this reads `available`, `fromPrice` and `toPrice` rather than the older
   * `hasBaseline`/`from.price` form the pre-engine endpoint returned.
   */
  const change = item.changeSinceViewed ?? item.delta;

  if (!change.available) {
    const reasons = {
      never_viewed: 'Not seen yet — mark it seen to start tracking changes',
      no_observation_at_last_view:
        'No observation recorded when you last looked, so there is nothing to diff yet',
      no_current_observation: 'Waiting for the first observation from the feed',
      unusable_baseline_price: 'The recorded baseline price cannot be used',
      /**
       * Deliberately not "0.00 (0.00%)". Diffing the newest observation against
       * itself would claim the price is unchanged, when what actually happened
       * is that nothing new arrived - and those lead a user to opposite
       * conclusions about whether the market is quiet or the feed is down. The
       * last known price and its age are already in the price column.
       */
      no_new_observation_since_view: 'No new observation since you looked',
    };
    return `<span class="chg--none">${escapeHtml(reasons[change.reason] ?? 'No baseline')}</span>`;
  }

  const cls = directionClass(change.absolute);

  return `
    <div class="chg ${cls}">${signed(change.absolute)} (${signed(change.percent)}%)</div>
    <div class="chg__sub">
      ₹${inr.format(change.fromPrice)} → ₹${inr.format(change.toPrice)} ·
      you looked ${ago(Date.now() - change.lastViewedAt)}
    </div>`;
}

function conflictRow(item) {
  const { conflict } = item;
  if (!conflict) return null;

  const detail = conflict.observations
    .map((o) => `${escapeHtml(o.source)} ₹${inr.format(o.price)} (confidence ${o.confidence})`)
    .join(' vs ');
  const preferred = conflict.preferred
    ? ` Showing <strong>${escapeHtml(conflict.preferred)}</strong> as the higher-confidence source.`
    : ' Neither source is more confident, so neither is preferred.';

  return node(`<tr class="wl__audit"><td colspan="5">
    <p class="conflict">
      <strong>Sources disagree by ${conflict.spreadPct}%</strong>
      (tolerance ${conflict.tolerancePct}%): ${detail}.${preferred}
    </p>
  </td></tr>`);
}

/**
 * The chart lives in its own module and receives the formatters rather than
 * importing them, so neither file depends on the other's internals.
 */
const chart = createChart({ api, inr, escapeHtml, directionClass, signed, duration, clockIst });

/** Intraday analysis and alerts, same dependency-injection arrangement. */
const panels = createPanels({
  api,
  inr,
  escapeHtml,
  directionClass,
  signed,
  duration,
  ago,
  whenIstPrecise,
});

async function loadAudit(cell, symbol) {
  try {
    const { snapshots } = await api(`/snapshots/${encodeURIComponent(symbol)}?limit=40`);
    if (snapshots.length === 0) {
      cell.innerHTML = '<p class="empty">No observations recorded for this symbol yet.</p>';
      return;
    }

    const oldest = snapshots.at(-1);
    cell.innerHTML = `
      <div class="audit__head">
        <span>Every observation behind this price — nothing here is computed on the fly.</span>
        <span>${snapshots.length} shown, oldest ${ago(Date.now() - oldest.timestamp)}</span>
      </div>
      <div class="audit__scroll"><table>
        <thead>
          <tr>
            <th>observed for (IST)</th><th>price</th><th>volume</th>
            <th>source</th><th>conf.</th><th>recorded</th>
          </tr>
        </thead>
        <tbody>
          ${snapshots
            .map(
              (s) => `<tr>
                <td>${whenIstPrecise(s.timestamp)}</td>
                <td>₹${inr.format(s.price)}</td>
                <td>${compact.format(s.volume)}</td>
                <td>${escapeHtml(s.source)}</td>
                <td>${s.confidence}</td>
                <td>${ago(Date.now() - s.ingestedAt)}</td>
              </tr>`,
            )
            .join('')}
        </tbody>
      </table></div>`;
  } catch (error) {
    cell.innerHTML = `<p class="empty">Could not load observations: ${escapeHtml(
      error.message,
    )}</p>`;
  }
}

const CROSS = `<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

const CHEVRON = `<svg viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Today's observations show clock time only. The full date is redundant for
 * the overwhelmingly common case and it was long enough to wrap the company
 * cell onto three lines; the complete timestamp is still one hover away, and
 * the audit trail always spells it out in full.
 */
function observedAt(timestamp) {
  const sameIstDay =
    new Date(timestamp).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) ===
    new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

  return sameIstDay ? clockIst(timestamp) : whenIst(timestamp);
}

/** Reason codes that are caveats about our data rather than market findings. */
const CAVEAT_CODES = new Set(['low_confidence', 'insufficient_data']);

/** How many reason lines the main view shows before deferring to the detail. */
const MAX_REASONS_SHOWN = 3;

/**
 * The "why it matters" cell: the level, and the reasons behind it.
 *
 * The level leads because it is the answer to "how important"; the reasons
 * follow because they are the answer to "why". Both come from the backend - the
 * frontend does not decide either, and does not recompute a score.
 *
 * Capped at three lines so the main table stays scannable; the rest are one
 * click away in the detail panel. A row with no reasons at all shows none
 * rather than inventing filler: the engine withheld every claim because
 * nothing crossed its evidence threshold, and that is worth seeing.
 */
function whyCell(item) {
  const badge = `<span class="level level--${escapeHtml(item.level)}"
    title="Meaningful change score ${item.meaningfulScore} · confidence ${item.confidence}">
    ${escapeHtml(item.level)}<span class="level__score">${item.meaningfulScore.toFixed(2)}</span>
  </span>`;

  const reasons = item.reasonText ?? [];
  const codes = item.reasons ?? [];

  if (reasons.length === 0) return badge;

  const shown = reasons.slice(0, MAX_REASONS_SHOWN).map((text, i) => {
    const caveat = CAVEAT_CODES.has(codes[i]) ? ' why--caveat' : '';
    return `<li class="${caveat.trim()}">${escapeHtml(text)}</li>`;
  });

  const remaining = reasons.length - shown.length;
  if (remaining > 0) {
    shown.push(`<li class="why--more">+${remaining} more in detail</li>`);
  }

  return `${badge}<ul class="why">${shown.join('')}</ul>`;
}

function renderRow(item) {
  const { latest, freshness } = item;
  const isOpen = expanded.has(item.symbol);

  const meta = latest
    ? `${escapeHtml(latest.source)} · ${observedAt(latest.timestamp)} IST · vol ${compact.format(
        latest.volume,
      )}`
    : 'no observations recorded yet';

  const row = node(`
    <tr class="wl__row" style="--state-color: ${stateColor(freshness.state)}">
      <td>
        <div class="company">
          <span class="company__logo">${escapeHtml(item.symbol.slice(0, 2))}</span>
          <div class="company__text">
            <div class="company__sym">${escapeHtml(item.symbol)}</div>
            <div class="company__meta" title="${
              latest ? `${escapeHtml(whenIst(latest.timestamp))} IST` : ''
            }">${meta}</div>
          </div>
        </div>
      </td>
      <td class="num">
        <div class="price">${latest ? `₹${inr.format(latest.price)}` : '—'}</div>
        <div class="price__age">${
          freshness.ageMs == null ? 'no data' : ago(freshness.ageMs)
        }</div>
        <div class="price__state">${freshnessPill(freshness)}</div>
      </td>
      <td class="num">${deltaCell(item)}</td>
      <td>${whyCell(item)}</td>
      <td>
        <div class="actions">
          <button type="button" class="btn btn--primary" data-action="viewed">Mark seen</button>
          <button type="button" class="btn btn--icon" data-action="remove"
                  aria-label="Remove ${escapeHtml(item.symbol)}"
                  title="Remove from watchlist">${CROSS}</button>
          <button type="button" class="btn btn--icon ${isOpen ? 'is-open' : ''}"
                  data-action="expand" aria-label="Show the detail behind this score"
                  title="Show the detail behind this score">${CHEVRON}</button>
        </div>
      </td>
    </tr>`);

  row.querySelector('[data-action="viewed"]').addEventListener('click', async () => {
    await api(`/watchlist/${encodeURIComponent(item.symbol)}/viewed`, { method: 'POST' });
    await refresh();
  });

  row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    await api(`/watchlist/${encodeURIComponent(item.symbol)}`, { method: 'DELETE' });
    expanded.delete(item.symbol);
    panelSlots.delete(item.symbol);
    await refresh();
  });

  row.querySelector('[data-action="expand"]').addEventListener('click', () => {
    if (expanded.has(item.symbol)) {
      expanded.delete(item.symbol);
      // Collapsing is the user closing the row, so its panels are discarded
      // rather than held: reopening should be a clean slate, and the map must
      // not accumulate detached nodes for every row ever opened.
      panelSlots.delete(item.symbol);
    } else {
      expanded.add(item.symbol);
    }
    render(lastPayload);
  });

  return row;
}

// ------------------------------------------------------------ detail panel

const kv = (label, value, off = false) =>
  `<div class="detail__row"><span class="detail__k">${escapeHtml(label)}</span>
   <span class="detail__v${off ? ' detail__v--off' : ''}">${escapeHtml(value)}</span></div>`;

const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

/**
 * Everything behind the score, laid out so a sceptical reader can check it.
 *
 * This is the transparency requirement made concrete: the weighted formula with
 * its actual numbers, each feature's raw value, its availability reason when
 * absent, and its own confidence. Nothing here is recomputed in the browser -
 * every figure is a field from the API.
 */
function detailPanel(item) {
  const f = item.features;
  const b = item.scoreBreakdown;

  const signalBlock = (title, key, rows) => {
    const feature = f[key];
    const breakdown = b[key];
    const head = feature.available
      ? kv('contributes', `${breakdown.contribution} × ${breakdown.weight} = ${breakdown.weighted}`)
      : kv('unavailable', feature.reason, true);

    return `<div class="detail__block">
      <div class="detail__title">${escapeHtml(title)}</div>
      ${head}
      ${feature.available ? rows(feature).join('') : ''}
      ${feature.available ? kv('confidence', String(feature.confidence)) : ''}
    </div>`;
  };

  /** Human labels for the signal keys - a camelCase split reads badly. */
  const SIGNAL_LABEL = {
    priceAnomaly: 'price',
    volumeAnomaly: 'volume',
    marketRelative: 'market',
    sectorRelative: 'sector',
  };

  // The formula, with this row's actual numbers substituted in.
  const terms = Object.entries(b)
    .filter(([, entry]) => entry.available)
    .map(([name, entry]) => `${SIGNAL_LABEL[name] ?? name} ${entry.weighted}`);

  const formula = `<div class="detail__formula">
    <strong>score</strong> = ( ${escapeHtml(terms.join(' + ')) || '0'} ) ÷ ${
      item.availableWeight
    } = <strong>${item.meaningfulScore}</strong> → ${escapeHtml(item.level)}
    <br />
    <strong>confidence</strong> = observation ${item.confidenceComponents.observation}
    × freshness ${item.confidenceComponents.freshness}
    × depth ${item.confidenceComponents.depth}
    × coverage ${item.confidenceComponents.coverage}
    = <strong>${item.confidence}</strong>
    ${
      /**
       * Without this line a score of 0.44 showing as LOW looks like a bug. The
       * floor is a deliberate product rule, so it says so, with the two numbers
       * that triggered it.
       */
      item.levelFloor
        ? `<br /><span class="detail__floor">level capped at LOW from ${escapeHtml(
            item.levelFloor.cappedFrom,
          )} — the stock's own move (${item.levelFloor.zMagnitude}σ) and your change
          since last looking (${item.levelFloor.changeMagnitude}%) were both negligible,
          so the relative signals alone do not earn attention</span>`
        : ''
    }
  </div>`;

  const change = f.changeSinceViewed;

  const reasonsList = (item.reasonText && item.reasonText.length > 0)
    ? `<ul class="detail__evidence-list">
        ${item.reasonText.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}
       </ul>`
    : `<p class="detail__evidence-none">No abnormal move detected. All measured signals remained within standard statistical bounds.</p>`;

  const evidenceOverview = `<div class="detail__evidence">
    <div class="detail__evidence-head">
      <span class="detail__evidence-badge level level--${escapeHtml(item.level)}">${escapeHtml(item.level)} ATTENTION</span>
      <span class="detail__evidence-title">Why this stock is surfaced</span>
    </div>
    ${reasonsList}
  </div>`;

  return `<div class="detail">
    ${evidenceOverview}
    ${formula}

    <div class="detail__block">
      <div class="detail__title">Since you last looked</div>
      ${
        change.available
          ? kv('change', `${pct(change.percent)} (₹${change.absolute})`) +
            kv('from → to', `₹${inr.format(change.fromPrice)} → ₹${inr.format(change.toPrice)}`) +
            kv('you looked', whenIstPrecise(change.lastViewedAt) + ' IST') +
            kv('observations span', duration(change.spanMs)) +
            kv('confidence', String(change.confidence))
          : kv('unavailable', change.reason, true)
      }
    </div>

    ${signalBlock('Price anomaly', 'priceAnomaly', (x) => [
      kv('z-score', `${x.z}σ`),
      kv('return over window', pct(x.returnPct)),
      kv('baseline mean', pct(x.baselineMeanPct)),
      kv('baseline std dev', `${x.baselineStdDevPct}%`),
      kv('window', duration(x.horizonMs)),
      kv('samples', String(x.sampleSize)),
      x.flooredStdDev ? kv('std dev floored', 'yes — confidence halved', true) : '',
      x.clamped ? kv('z clamped', 'yes', true) : '',
    ])}

    ${signalBlock('Volume anomaly', 'volumeAnomaly', (x) => [
      kv('ratio', `${x.ratio}×`),
      kv('latest volume', compact.format(x.latestVolume)),
      kv('trailing average', compact.format(x.averageVolume)),
      kv('samples', String(x.sampleSize)),
    ])}

    ${signalBlock('Market-relative', 'marketRelative', (x) => [
      kv('excess', pct(x.excessPct)),
      kv('this symbol', pct(x.symbolReturnPct)),
      kv(`${x.benchmarkSymbol}`, pct(x.benchmarkReturnPct)),
      kv('window', duration(x.horizonMs)),
    ])}

    ${signalBlock('Sector-relative', 'sectorRelative', (x) => [
      kv('sector', x.sector),
      kv('excess', pct(x.excessPct)),
      kv('this symbol', pct(x.symbolReturnPct)),
      kv('peer mean', pct(x.sectorReturnPct)),
      kv('peers used', x.peers.join(', ')),
    ])}

    <div class="detail__block">
      <div class="detail__title">Data &amp; signal state</div>
      ${kv('data quality', item.dataQuality)}
      ${kv('freshness', item.freshness.label)}
      ${
        item.latest
          ? kv('observed for', whenIstPrecise(item.latest.timestamp) + ' IST') +
            kv('recorded', whenIstPrecise(item.latest.ingestedAt) + ' IST') +
            kv('source', item.latest.source) +
            kv('source confidence', String(item.latest.confidence))
          : ''
      }
      ${kv('observations in window', String(item.observationCount))}
      ${kv('already surfaced', item.alreadySurfaced ? 'yes' : 'no')}
    </div>
  </div>`;
}

/**
 * The intraday and alert panels, held across re-renders by symbol.
 *
 * The poll rebuilds every visible row every five seconds, which is right for
 * the numbers - a stale score sitting under a fresh price would be worse - but
 * it was rebuilding these two panels along with them. So a panel opened at
 * t+0 closed itself at t+5, and a threshold half-typed into the alert form was
 * destroyed before it could be submitted: the refresh loop racing the user, and
 * the alert form was effectively unusable in the live app.
 *
 * The panels are the one part of the row that is loaded on demand and never
 * auto-refreshed, so the fix is to move the *same DOM nodes* into each newly
 * rendered row rather than build empty ones. Open state, scroll position and
 * form values all come with them, while the score, the breakdown and the audit
 * table above still refresh on every poll. Same intent as `expanded` above,
 * one level deeper.
 */
const panelSlots = new Map();

function slotsFor(symbol) {
  let slots = panelSlots.get(symbol);
  if (!slots) {
    slots = {
      intraday: node('<div class="intraday-slot" hidden></div>'),
      alert: node('<div class="alert-slot" hidden></div>'),
    };
    panelSlots.set(symbol, slots);
  }
  return slots;
}

function detailRow(item) {
  const row = node(
    `<tr class="wl__audit"><td colspan="5" class="audit">
       <div class="chart-slot"></div>
       <div class="row-actions">
         <button type="button" class="btn" data-action="intraday">Analyze Intraday</button>
         <button type="button" class="btn" data-action="alert">Set Alert</button>
       </div>
       <div class="panel-slots"></div>
       ${detailPanel(item)}
       <div class="audit__observations">Loading observations…</div>
     </td></tr>`,
  );

  const slots = slotsFor(item.symbol);
  row.querySelector('.panel-slots').append(slots.intraday, slots.alert);

  void chart.load(row.querySelector('.chart-slot'), item.symbol);
  void loadAudit(row.querySelector('.audit__observations'), item.symbol);

  /**
   * Both panels are loaded on demand rather than with the row. The intraday
   * analysis is a second batched query and the alert list is a third; paying
   * for them on every expand - and on every five-second poll that re-renders an
   * expanded row - would be waste for a panel most users will not open.
   */
  const intradayButton = row.querySelector('[data-action="intraday"]');
  intradayButton.classList.toggle('is-active', !slots.intraday.hidden);
  intradayButton.addEventListener('click', (event) => {
    const open = slots.intraday.hidden;
    slots.intraday.hidden = !open;
    event.currentTarget.classList.toggle('is-active', open);
    if (open) void panels.loadIntraday(slots.intraday, item.symbol);
  });

  const alertButton = row.querySelector('[data-action="alert"]');
  alertButton.classList.toggle('is-active', !slots.alert.hidden);
  alertButton.addEventListener('click', (event) => {
    const open = slots.alert.hidden;
    slots.alert.hidden = !open;
    event.currentTarget.classList.toggle('is-active', open);
    if (open) {
      void panels.loadAlerts(slots.alert, item.symbol, () =>
        panels.loadAlertFeed(el.alertFeed),
      );
    }
  });

  return row;
}

// -------------------------------------------------------------- filter / sort

/**
 * Filters over what the server already sent. "Changed" is a filter on the raw
 * delta, deliberately not a relevance score - ranking by meaningfulness needs
 * volatility, sector and volume before it deserves to be a default.
 */
const FILTERS = {
  all: () => true,
  changed: (i) => i.changeSinceViewed.available && i.changeSinceViewed.percent !== 0,
  /**
   * "No baseline", read from the engine's group rather than from whether a
   * delta came back.
   *
   * `!changeSinceViewed.available` looked equivalent and is not: a row whose
   * newest observation is the one the user already saw has a perfectly good
   * baseline and simply nothing newer to diff. Against a frozen feed this chip
   * counted the entire watchlist as "not seen yet" moments after the user had
   * explicitly marked all of it seen - while the band below correctly showed
   * those same rows as Stable and Meaningful.
   *
   * The fallback keeps the chip working with the engine disabled, where there
   * are no groups to read.
   */
  unseen: (i) => (i.attentionGroup ? i.attentionGroup === 'unseen' : !i.changeSinceViewed.available),
  /**
   * The engine's own flag, not a second definition. This chip used to count
   * stale-or-conflicting rows while the summary banner counted HIGH and
   * MODERATE, so one screen could read "Needs attention 0" next to "2 deserve
   * your attention". Data health is still visible - through the freshness pill
   * and dataQuality - but it is a different question from meaningfulness.
   */
  attention: (i) => i.needsAttention,
};

function sortItems(items, mode) {
  const copy = [...items];
  if (mode === 'change') {
    const magnitude = (i) =>
      i.changeSinceViewed.available ? Math.abs(i.changeSinceViewed.percent) : -1;
    return copy.sort((a, b) => magnitude(b) - magnitude(a));
  }
  if (mode === 'staleness') {
    const rank = { stale: 0, no_data: 1, market_closed: 2, delayed: 3, live: 4 };
    return copy.sort(
      (a, b) =>
        rank[a.freshness.state] - rank[b.freshness.state] ||
        (b.freshness.ageMs ?? 0) - (a.freshness.ageMs ?? 0),
    );
  }
  return copy; // server order: added_at ascending
}

// -------------------------------------------------------------------- render

function renderTicker(items) {
  if (items.length === 0) {
    el.ticker.innerHTML = '<span class="ticker__empty">No symbols watched yet</span>';
    return;
  }

  el.ticker.innerHTML = items
    .map((item) => {
      const price = item.latest ? `₹${inr.format(item.latest.price)}` : '—';
      const change = item.changeSinceViewed.available
        ? `<span class="ticker__chg ${directionClass(item.changeSinceViewed.absolute)}">${signed(
            item.changeSinceViewed.percent,
          )}%</span>`
        : '<span class="ticker__chg flat">·</span>';
      return `<span class="ticker__item">
        <span class="ticker__sym">${escapeHtml(item.symbol)}</span>
        <span class="ticker__price">${price}</span>
        ${change}
      </span>`;
    })
    .join('');
}

function renderChipCounts(items) {
  for (const chip of el.chips.querySelectorAll('.chip[data-filter]')) {
    const key = chip.dataset.filter;
    const count = items.filter(FILTERS[key]).length;
    chip.classList.toggle('is-active', key === filter);
    chip.innerHTML = `${chip.textContent.replace(/\s*\d+$/, '').trim()} <span class="count">${count}</span>`;
  }
}

/**
 * The benchmark's own value and change.
 *
 * The sidebar used to show "Market: n/a" whenever exchange hours did not apply
 * to the active source - which was every simulator run - while NIFTY was being
 * ingested and used to score the market-relative signal on every row. The panel
 * was hiding its own working. The return is over the same horizon the rows were
 * scored against, so this is the figure their comparison used.
 */
function benchmarkRow(benchmark) {
  if (!benchmark?.latest) {
    return `<div class="kv"><span class="kv__k">Benchmark</span>
      <span class="kv__v detail__v--off">no data yet</span></div>`;
  }

  const change =
    benchmark.returnPct == null
      ? '<span class="flat">—</span>'
      : `<span class="${directionClass(benchmark.returnPct)}">${signed(
          benchmark.returnPct,
        )}%</span>`;

  return `<div class="kv">
    <span class="kv__k">${escapeHtml(benchmark.symbol)}</span>
    <span class="kv__v">${inr.format(benchmark.latest.price)} ${change}</span>
  </div>
  <div class="kv">
    <span class="kv__k">over</span>
    <span class="kv__v">${duration(benchmark.horizonMs)}</span>
  </div>`;
}

function renderStatus(payload) {
  const { source, market } = payload;

  el.sourcePill.className = `pill pill--${source.kind === 'synthetic' ? 'delayed' : 'live'}`;
  el.sourcePill.textContent =
    source.kind === 'synthetic'
      ? 'Simulated data'
      : `${source.name} · delayed ~${Math.round(source.delayMs / 60_000)}m`;
  el.sourcePill.title =
    source.kind === 'synthetic'
      ? `Deterministic synthetic market (seed: ${source.seed})`
      : (source.note ?? 'Live market data feed.');

  const marketLine = !market.appliesToSource
    ? 'Exchange hours not applicable — the simulated market runs continuously so the app is demonstrable while NSE/BSE are closed.'
    : market.open
      ? 'NSE is open.'
      : `NSE is closed. Opens ${whenIst(market.nextOpenAt)} IST; last close ${whenIst(
          market.lastCloseAt,
        )} IST.`;

  el.sourceBody.innerHTML = `
    <div class="kv"><span class="kv__k">Source</span><span class="kv__v">${escapeHtml(
      source.name,
    )}</span></div>
    <div class="kv"><span class="kv__k">Kind</span><span class="kv__v">${escapeHtml(
      source.kind,
    )}</span></div>
    ${
      source.kind === 'synthetic'
        ? `<div class="kv"><span class="kv__k">Seed</span><span class="kv__v">${escapeHtml(
            source.seed,
          )}</span></div>
           <div class="kv"><span class="kv__k">Tick</span><span class="kv__v">${
             source.tickMs / 1000
           }s</span></div>`
        : `<div class="kv"><span class="kv__k">Stated delay</span><span class="kv__v">${Math.round(
            source.delayMs / 60_000,
          )} min</span></div>`
    }
    ${benchmarkRow(payload.benchmark)}
    <p class="card__note">${escapeHtml(marketLine)}</p>`;
}

/**
 * The ingestion heartbeat.
 *
 * Purely presentational, and reads only what the ingestor reports about
 * itself: `lastTickAt` is when a poll actually finished, `nextTickAt` is the
 * scheduler stating when it fires next. Neither is invented here, and there is
 * no timer in this file counting anything down - the line refreshes on the
 * same five-second poll as everything else.
 *
 * Every state it can honestly be in is spelled out, because "the feed is
 * paused" and "the feed is about to tick" must not look alike:
 *   - not running        -> say so, and show no next time, because there isn't one
 *   - running, no tick   -> booting, or backfilling before the loop starts
 *   - running            -> last sync and next update
 */
function heartbeatLine(ingest) {
  if (!ingest) {
    return `<div class="beat beat--off"><span class="beat__dot"></span>
      <span>Ingestion is disabled — prices will not update.</span></div>`;
  }

  if (!ingest.running) {
    return `<div class="beat beat--off"><span class="beat__dot"></span>
      <span>Ingestion paused${
        ingest.lastTickAt ? ` · last sync ${clockIstSeconds(ingest.lastTickAt)}` : ''
      }</span></div>`;
  }

  if (!ingest.lastTickAt) {
    return `<div class="beat"><span class="beat__dot beat__dot--pulse"></span>
      <span>Waiting for the first sync…</span></div>`;
  }

  return `<div class="beat"><span class="beat__dot beat__dot--pulse"></span>
    <span>Last sync ${clockIstSeconds(ingest.lastTickAt)}${
      ingest.nextTickAt ? ` · next ~${clockIstSeconds(ingest.nextTickAt)}` : ''
    }</span></div>`;
}

function renderLogCard(meta) {
  if (!meta) return;
  const { log, ingest, config } = meta;
  const failing = Object.keys(ingest?.failingSymbols ?? {});

  el.logBody.innerHTML = `
    ${heartbeatLine(ingest)}
    <div class="kv"><span class="kv__k">Observations</span><span class="kv__v">${log.snapshots.toLocaleString(
      'en-IN',
    )}</span></div>
    <div class="kv"><span class="kv__k">Oldest data</span><span class="kv__v">${
      log.oldestTimestamp ? ago(Date.now() - log.oldestTimestamp) : '—'
    }</span></div>
    <div class="kv"><span class="kv__k">Update frequency</span><span class="kv__v">every ${
      config.ingestIntervalMs / 1000
    }s</span></div>
    ${(ingest?.failures ?? 0) > 0 ? `<div class="kv"><span class="kv__k">Failures</span><span class="kv__v down">${ingest.failures}</span></div>` : ''}
    <p class="card__note">
      The log is append-only — SQLite triggers reject UPDATE and DELETE, so a price you have
      already seen can never be rewritten.${
        failing.length ? ` Currently failing: ${escapeHtml(failing.join(', '))}.` : ''
      }
    </p>`;
}

/**
 * Attention sensitivity lives in its own module so the test suite can import
 * it without a DOM and assert that it changes no number. See sensitivity.js.
 */
let sensitivity = DEFAULT_SENSITIVITY;

const displayGroupOf = (item) => displayGroupFor(item, sensitivity);

/**
 * The presentation groups, in the order a returning user wants them.
 *
 * `key` matches the engine's own `attentionGroup` field. Nothing here decides
 * which group a row is in - that is computed once by the engine, from the same
 * thresholds the level floor uses. This list only names them and says what
 * each one means.
 */
const GROUPS = [
  {
    key: 'needs_attention',
    label: 'Needs attention',
    note: 'Scored at or above the engine’s attention bar.',
    tone: 'attention',
  },
  {
    key: 'meaningful',
    label: 'Meaningful changes',
    note: 'Something notable happened to this stock, but below the attention bar.',
    tone: 'meaningful',
  },
  {
    key: 'stable',
    label: 'Stable',
    note: 'Measured against your baseline, and nothing notable to report.',
    tone: 'stable',
  },
  {
    key: 'unseen',
    label: 'No baseline yet',
    /**
     * Deliberately not folded into "Stable". Stable is a measurement; this is
     * the absence of one. The wording covers both ways of having no baseline -
     * never marked seen, and nothing new observed since you were.
     */
    note: 'Nothing to compare against yet — mark these seen to start tracking.',
    tone: 'unseen',
  },
];

function groupHeaderRow(group, count) {
  /**
   * The attention band states its own threshold whenever sensitivity has moved
   * it off the engine's bar. Without that line the band's count and the away
   * banner's count could differ with nothing on screen explaining why - the
   * banner reports what the ENGINE found, this reports what you asked to see,
   * and both are true only if each says which it is.
   */
  const sensitivityNote =
    group.key === 'needs_attention' ? SENSITIVITY[sensitivity].note : null;

  return node(
    `<tr class="wl__group wl__group--${group.tone}"><td colspan="5">
       <span class="wl__group-label">${escapeHtml(group.label)}</span>
       <span class="wl__group-count">${count}</span>
       <span class="wl__group-note">${escapeHtml(sensitivityNote ?? group.note)}</span>
     </td></tr>`,
  );
}

function render(payload) {
  if (!payload) return;
  lastPayload = payload;

  renderStatus(payload);
  renderTicker(payload.items);
  renderChipCounts(payload.items);

  const visible = sortItems(payload.items.filter(FILTERS[filter]), el.sort.value);

  const rows = [];
  const rowsFor = (item) => {
    const out = [renderRow(item)];
    const conflict = conflictRow(item);
    if (conflict) out.push(conflict);
    if (expanded.has(item.symbol)) out.push(detailRow(item));
    return out;
  };

  /**
   * Grouping needs the engine's verdict. With the engine disabled the API
   * serves the original ungrouped contract, and there is nothing to group by -
   * so the list renders flat rather than silently dropping every row into a
   * bucket that does not exist.
   */
  if (!visible.some((item) => item.attentionGroup)) {
    for (const item of visible) rows.push(...rowsFor(item));
  } else {
    for (const group of GROUPS) {
      const inGroup = visible.filter((item) => displayGroupOf(item) === group.key);

      /**
       * Empty groups are omitted rather than shown as empty bands. On a quiet
       * watchlist three of the four are empty, and four headings over one row
       * of data is furniture, not information - the counts are already on the
       * chips, and "nothing outstanding" has its own caught-up state.
       */
      if (inGroup.length === 0) continue;

      rows.push(groupHeaderRow(group, inGroup.length));
      for (const item of inGroup) rows.push(...rowsFor(item));
    }
  }
  el.tbody.replaceChildren(...rows);

  el.empty.hidden = visible.length > 0;
  if (visible.length === 0 && payload.items.length > 0) {
    el.empty.textContent = 'No symbols match this filter.';
  } else if (visible.length === 0) {
    el.empty.textContent =
      'Nothing on your watchlist. Search for a symbol above to start tracking it.';
  }

  /**
   * Rows that HAVE a baseline - the same question the "No baseline yet" band
   * answers, so it is answered the same way. Counting rows with a computable
   * delta instead reported "0 of 4 have a baseline" immediately after the user
   * marked all four seen, because a frozen feed leaves the baseline in place
   * and simply provides nothing newer to diff against it.
   */
  const withBaseline = payload.items.filter((i) => !FILTERS.unseen(i)).length;
  el.sectionSub.textContent =
    `Not today's movers — the diff between the price when you last opened each symbol and the newest one now. ` +
    `${withBaseline} of ${payload.items.length} have a baseline to compare against.`;

  el.footer.innerHTML = `
    Prices come from <strong>${escapeHtml(payload.source.name)}</strong>.
    ${
      payload.source.kind === 'synthetic'
        ? 'This is a deterministic simulated market, not real quotes — the same seed replays the same prices exactly.'
        : 'Quotes are typically delayed 15–20 minutes; the timestamp shown is the one the source attributes, never the time it was fetched.'
    }
    Every number above traces to a logged observation — open a row's chevron to see them.`;
}

// -------------------------------------------------------- change history

/**
 * The change-history filter. `null` is "all"; otherwise an engine level.
 * In-session, like sensitivity - and like sensitivity it selects, it does not
 * compute.
 */
let historyLevel = null;

/**
 * HIGH and MODERATE are the only levels that can appear, because they are the
 * only ones ever surfaced. "Meaningful" is the user-facing name for MODERATE,
 * matching the watchlist band.
 */
const HISTORY_LEVEL_LABEL = { HIGH: 'High attention', MODERATE: 'Meaningful' };

async function loadHistory() {
  try {
    const query = historyLevel ? `?level=${encodeURIComponent(historyLevel)}` : '';
    const { events, counts } = await api(`/history${query}`);
    if (el.historySection) {
      el.historySection.hidden = (counts.all === 0);
    }
    if (counts.all === 0) return;

    for (const chip of el.historyChips.querySelectorAll('.chip[data-history]')) {
      const key = chip.dataset.history;
      const count = key === 'all' ? counts.all : (counts[key] ?? 0);
      chip.classList.toggle('is-active', (key === 'all' ? null : key) === historyLevel);
      chip.innerHTML = `${chip.textContent.replace(/\s*\d+$/, '').trim()} <span class="count">${count}</span>`;
    }

    if (events.length === 0) {
      /**
       * Two different empties, because they mean different things: nothing has
       * been surfaced at all, versus nothing at this level. Telling a user with
       * a busy history that they have none would be simply wrong.
       */
      el.historyBody.innerHTML = `<p class="history__empty">${
        counts.all === 0
          ? 'Nothing surfaced yet. When something meaningful changes while you are away, it will be recorded here.'
          : 'No events at this level. Try “All”.'
      }</p>`;
      return;
    }

    el.historyBody.innerHTML = events.map(historyEntry).join('');
  } catch (error) {
    el.historyBody.innerHTML = `<p class="history__empty">Could not load the history: ${escapeHtml(
      error.message,
    )}</p>`;
  }
}

function historyEntry(event) {
  const level = HISTORY_LEVEL_LABEL[event.level] ?? event.level;

  /**
   * The delta is the one recorded at surface time. A row that had no baseline
   * then says so rather than showing a zero, which would be a measurement
   * nobody made.
   */
  const change =
    event.changePct == null
      ? '<span class="chg--none">no baseline at the time</span>'
      : `<span class="${directionClass(event.changePct)}">${signed(
          event.changePct,
        )}% since you last checked</span>`;

  const shownAgain =
    event.surfaceCount > 1
      ? `<span class="hist__again" title="Shown on ${event.surfaceCount} visits">shown ${event.surfaceCount}×</span>`
      : '';

  /**
   * "Since you last checked" leads the engine's reason list, and it is the
   * same fact as the change line above - so the entry was printing it twice,
   * once at 2dp and once at 1dp, which reads like two different numbers.
   *
   * Filtered for display only; the stored line is untouched, and this matches
   * on a deterministic template rather than guessing.
   */
  const why = event.reasons.filter((line) => !line.endsWith('since you last checked'));

  return `
    <article class="hist">
      <div class="hist__when">
        <span class="hist__time">${escapeHtml(clockIst(event.at))}</span>
        <span class="hist__ago">${escapeHtml(ago(Date.now() - event.at))}</span>
      </div>
      <div class="hist__what">
        <div class="hist__head">
          <span class="hist__sym">${escapeHtml(event.symbol)}</span>
          <span class="level level--${escapeHtml(event.level)}">${escapeHtml(level)}</span>
          ${shownAgain}
        </div>
        <p class="hist__chg">${change}</p>
        ${
          why.length > 0
            ? `<p class="hist__why">Why it matters</p>
               <ul class="hist__reasons">${why
                 .map((line) => `<li>${escapeHtml(line)}</li>`)
                 .join('')}</ul>`
            : ''
        }
      </div>
    </article>`;
}

// ----------------------------------------------------- since you were away

/** Dev/demo: simulate a long absence so the aggregated view is showable. */
let simulatedAwayMs = null;

/**
 * Whether this page session has recorded its signals as surfaced yet.
 *
 * The first summary fetch of a session records - that is the moment the user is
 * genuinely shown the signals. Subsequent polls do not, or a 5-second poll would
 * mark everything surfaced within seconds of arriving and the distinction would
 * be worthless. Note this is separate from last_viewed_at, which only "Mark
 * seen" writes.
 */
let awayRecorded = false;

/**
 * The named time-away scenarios, from /api/demo/scenarios.
 *
 * These are an override on the reported absence, so they apply instantly and
 * change nothing about the data - which is why they can be one click. Market
 * conditions need crafted observations in an append-only log, so they are a
 * seeding step and appear in the Scenarios card with their command.
 */
let timeAwayOptions = [];

function renderAwayScenarios() {
  const buttons = [
    ...timeAwayOptions.map((option) => ({ id: option.id, label: option.label, ms: option.ms })),
    { id: 'off', label: 'Real time', ms: null },
  ];

  el.awayScenarios.innerHTML = buttons
    .map(
      (b) =>
        `<button type="button" class="chip chip--ghost ${
          (b.ms ?? null) === simulatedAwayMs ? 'is-active' : ''
        }" data-away="${b.ms ?? ''}">${escapeHtml(b.label)}</button>`,
    )
    .join('');

  for (const button of el.awayScenarios.querySelectorAll('[data-away]')) {
    button.addEventListener('click', async () => {
      const raw = button.dataset.away;
      simulatedAwayMs = raw === '' ? null : Number(raw);
      await refresh();
    });
  }
}

function renderAway(summary) {
  if (!summary) {
    el.away.hidden = true;
    return;
  }

  el.away.hidden = false;
  el.awayHeadline.textContent = summary.headline;
  renderAwayScenarios();

  /**
   * On a long absence the aggregate replaces the enumeration - after two days
   * nobody wants a tick-by-tick account, they want to know which handful of
   * things mattered.
   */
  if (summary.away.long && summary.aggregate) {
    const { byLevel, biggestMove } = summary.aggregate;
    const parts = [
      `<div class="away__signal"><span class="away__sym">Levels</span>
        <span class="away__why">${byLevel.HIGH.count} high · ${byLevel.MODERATE.count} moderate · ${byLevel.LOW.count} low</span></div>`,
    ];
    if (biggestMove) {
      parts.push(`<div class="away__signal">
        <span class="away__sym">Biggest move</span>
        <span class="away__why">${escapeHtml(biggestMove.symbol)}
          <span class="${directionClass(biggestMove.percent)}">${signed(
            biggestMove.percent,
          )}%</span> · ${escapeHtml(biggestMove.level)}</span></div>`);
    }
    el.awaySignals.innerHTML = parts.join('');
    return;
  }

  /**
   * Caught up: every symbol has a baseline, nothing has moved since it, and
   * nothing wants attention. The engine decides this (summary.caughtUp) - the
   * client only renders it, and re-renders it on the next poll, which is why
   * it survives a refresh instead of being a toast that vanishes.
   */
  if (summary.caughtUp) {
    const timeRef = summary.away?.since ? ` since ${clockIst(summary.away.since)} IST` : '';
    const stockCount = summary.counts?.watched ?? (lastPayload?.items?.length ?? 0);
    const countLabel = stockCount > 0 ? `${stockCount} stock${stockCount === 1 ? '' : 's'} checked · ` : '';
    el.awaySignals.innerHTML = `
      <div class="caught-up">
        <svg class="caught-up__tick" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
          <path d="m7.5 12.5 3 3 6-6.5" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div>
          <p class="caught-up__head">You're all caught up.</p>
          <p class="caught-up__sub">${countLabel}No meaningful changes${timeRef}. Jabse will watch what changes next.</p>
        </div>
        <button type="button" class="btn" data-action="to-watchlist">Back to watchlist</button>
      </div>`;

    el.awaySignals
      .querySelector('[data-action="to-watchlist"]')
      .addEventListener('click', () => {
        filter = 'all';
        render(lastPayload); // re-syncs the filter chips, including the active one
        document.querySelector('.section-head')?.scrollIntoView({ behavior: 'smooth' });
      });
    return;
  }

  if (summary.top.length === 0) {
    el.awaySignals.innerHTML =
      '<div class="away__signal"><span class="away__why">Nothing is asking for your attention right now.</span></div>';
    return;
  }

  el.awaySignals.innerHTML = summary.top
    .map(
      (signal) => `<div class="away__signal">
        <span class="away__sym">${escapeHtml(signal.symbol)}</span>
        <span class="level level--${escapeHtml(signal.level)}">${escapeHtml(signal.level)}</span>
        <span class="away__why">${escapeHtml(signal.reasonText[0] ?? '')}</span>
        ${signal.alreadySurfaced ? '<span class="away__seen">seen before</span>' : ''}
      </div>`,
    )
    .join('');
}

// --------------------------------------------------------------------- loops

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const query = new URLSearchParams();
    if (simulatedAwayMs) query.set('awayMs', String(simulatedAwayMs));
    query.set('record', awayRecorded ? 'false' : 'true');

    const [watchlist, meta, summary] = await Promise.all([
      api('/watchlist'),
      api('/meta'),
      api(`/summary?${query}`).catch(() => null),
    ]);
    awayRecorded = true;

    lastMeta = meta;
    render(watchlist);
    renderAway(summary);
    renderLogCard(meta);
    renderSuggestions();
    /**
     * After the summary, deliberately: the summary is what RECORDS a surfaced
     * signal, so loading the history first would show the page as it was one
     * moment before the event it just created.
     */
    void loadHistory();
    void panels.loadAlertFeed(el.alertFeed);
  } catch (error) {
    el.formError.textContent = `Refresh failed: ${error.message}`;
    el.formError.hidden = false;
  } finally {
    refreshing = false;
  }
}

let featured = [];

/** Suggestions double as one-click add buttons; already-watched ones disable. */
function renderSuggestions() {
  const watched = new Set((lastPayload?.items ?? []).map((i) => i.symbol));

  el.suggestList.replaceChildren(
    ...featured.map(({ symbol, name }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'suggest__btn';
      const venue = symbol.endsWith('.BO') ? 'BSE' : 'NSE';
      button.innerHTML = `
        <span class="suggest__sym">${escapeHtml(symbol)}</span>
        <span class="suggest__name">${escapeHtml(name)}</span>
        <span class="suggest__venue">${venue}</span>
      `;
      button.title = `${name} (${venue})`;
      button.disabled = watched.has(symbol);
      button.addEventListener('click', () => addSymbol(symbol));
      return button;
    }),
  );
}

async function loadFeatured() {
  try {
    const { symbols } = await api('/symbols');
    featured = symbols;
    el.suggestions.replaceChildren(
      ...symbols.map((s) => {
        const option = document.createElement('option');
        option.value = s.symbol;
        option.label = s.name;
        return option;
      }),
    );
    renderSuggestions();
  } catch {
    // Suggestions are a convenience; typing a ticker works without them.
  }
}

async function addSymbol(symbol) {
  el.formError.hidden = true;
  try {
    await api('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) });
    el.input.value = '';
    await refresh();
  } catch (error) {
    el.formError.textContent = error.message;
    el.formError.hidden = false;
  }
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const symbol = el.input.value.trim();
  if (symbol) void addSymbol(symbol);
});

el.chips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip[data-filter]');
  if (!chip) return;
  filter = chip.dataset.filter;
  render(lastPayload);
});

el.historyChips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip[data-history]');
  if (!chip) return;
  historyLevel = chip.dataset.history === 'all' ? null : chip.dataset.history;
  void loadHistory();
});

el.sort.addEventListener('change', () => render(lastPayload));

/**
 * Sensitivity is a re-render, not a refetch: every value it selects on is
 * already in the payload the client is holding. Nothing is asked of the server
 * and nothing is recomputed.
 */
el.sensitivity.addEventListener('change', () => {
  sensitivity = el.sensitivity.value;
  render(lastPayload);
});

/**
 * "Mark all as seen" - one explicit user action, one baseline stamp.
 *
 * Disabled while in flight so a double click cannot send two stamps at two
 * instants, and re-enabled in `finally` so a failure does not leave the
 * control dead.
 */
el.markAllSeen.addEventListener('click', async () => {
  el.markAllSeen.disabled = true;
  try {
    await api('/watchlist/viewed-all', { method: 'POST' });
    await refresh();
  } catch (error) {
    el.formError.textContent = `Could not mark all as seen: ${error.message}`;
    el.formError.hidden = false;
  } finally {
    el.markAllSeen.disabled = false;
  }
});

el.refreshNow.addEventListener('click', async () => {
  await api('/ingest/tick', { method: 'POST' }).catch(() => {});
  await refresh();
});

/**
 * Load the scenario catalogue once. The time-away options drive the chips in
 * the absence banner; the market conditions are listed with the command that
 * seeds each, because writing crafted history over a live append-only series
 * would contaminate the statistics and cost them their determinism.
 */
async function loadScenarios() {
  try {
    const catalogue = await api('/demo/scenarios');
    timeAwayOptions = catalogue.timeAway;
    renderAwayScenarios();

    el.scenarioList.innerHTML = `
      <ul class="sc__list">
        ${catalogue.conditions
          .map(
            (c) => `<li>
              <span class="sc__label">${escapeHtml(c.label)}</span>
              <span class="sc__desc">${escapeHtml(c.description)}</span>
              <span class="sc__expect">${escapeHtml(c.expect)}</span>
              <code class="sc__cmd">${escapeHtml(c.command)}</code>
            </li>`,
          )
          .join('')}
      </ul>
      <p class="card__note">${escapeHtml(catalogue.note)}</p>`;
  } catch {
    // The catalogue is a demo aid; a failure here must not break the page.
  }
}

// Ctrl/Cmd+K focuses search, matching the hint rendered in the nav bar.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    el.input.focus();
    el.input.select();
  }
});

await loadFeatured();
await loadScenarios();
await refresh();
setInterval(refresh, POLL_INTERVAL_MS);
