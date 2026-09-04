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
  tbody: document.getElementById('watchlist'),
  empty: document.getElementById('empty-state'),
  sectionSub: document.getElementById('section-sub'),
  away: document.getElementById('away'),
  awayHeadline: document.getElementById('away-headline'),
  awaySignals: document.getElementById('away-signals'),
  awaySimulate: document.getElementById('away-simulate'),
  sourceBody: document.getElementById('source-body'),
  logBody: document.getElementById('log-body'),
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
 */
function freshnessPill(freshness) {
  const age = freshness.ageMs == null ? '' : ` · ${ago(freshness.ageMs)}`;
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
const chart = createChart({ api, inr, escapeHtml, directionClass, signed, duration });

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

  return sameIstDay
    ? new Date(timestamp).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : whenIst(timestamp);
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
        ${latest ? `<div class="conf">source confidence ${latest.confidence}</div>` : ''}
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
    await refresh();
  });

  row.querySelector('[data-action="expand"]').addEventListener('click', () => {
    if (expanded.has(item.symbol)) expanded.delete(item.symbol);
    else expanded.add(item.symbol);
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

  return `<div class="detail">
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
      ${kv('signal fingerprint', item.signal.fingerprint)}
    </div>
  </div>`;
}

function detailRow(item) {
  const row = node(
    `<tr class="wl__audit"><td colspan="5" class="audit">
       <div class="chart-slot"></div>
       ${detailPanel(item)}
       <div class="audit__observations">Loading observations…</div>
     </td></tr>`,
  );
  void chart.load(row.querySelector('.chart-slot'), item.symbol);
  void loadAudit(row.querySelector('.audit__observations'), item.symbol);
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
  unseen: (i) => !i.changeSinceViewed.available,
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
      ? `simulated · seed ${source.seed}`
      : `${source.name} · delayed ~${Math.round(source.delayMs / 60_000)}m`;
  el.sourcePill.title =
    source.note ?? 'Deterministic synthetic market: the same seed always replays the same prices.';

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

function renderLogCard(meta) {
  if (!meta) return;
  const { log, ingest, config } = meta;
  const failing = Object.keys(ingest?.failingSymbols ?? {});

  el.logBody.innerHTML = `
    <div class="kv"><span class="kv__k">Observations</span><span class="kv__v">${log.snapshots.toLocaleString(
      'en-IN',
    )}</span></div>
    <div class="kv"><span class="kv__k">Oldest</span><span class="kv__v">${
      log.oldestTimestamp ? ago(Date.now() - log.oldestTimestamp) : '—'
    }</span></div>
    <div class="kv"><span class="kv__k">Poll every</span><span class="kv__v">${
      config.ingestIntervalMs / 1000
    }s</span></div>
    <div class="kv"><span class="kv__k">Written / dupes</span><span class="kv__v">${
      ingest?.written ?? 0
    } / ${ingest?.duplicates ?? 0}</span></div>
    <div class="kv"><span class="kv__k">Absences</span><span class="kv__v">${
      ingest?.absences ?? 0
    }</span></div>
    <div class="kv"><span class="kv__k">Failures</span><span class="kv__v ${
      (ingest?.failures ?? 0) > 0 ? 'down' : ''
    }">${ingest?.failures ?? 0}</span></div>
    <p class="card__note">
      The log is append-only — SQLite triggers reject UPDATE and DELETE, so a price you have
      already seen can never be rewritten.${
        failing.length ? ` Currently failing: ${escapeHtml(failing.join(', '))}.` : ''
      }
    </p>`;
}

function render(payload) {
  if (!payload) return;
  lastPayload = payload;

  renderStatus(payload);
  renderTicker(payload.items);
  renderChipCounts(payload.items);

  const visible = sortItems(payload.items.filter(FILTERS[filter]), el.sort.value);

  const rows = [];
  for (const item of visible) {
    rows.push(renderRow(item));
    const conflict = conflictRow(item);
    if (conflict) rows.push(conflict);
    if (expanded.has(item.symbol)) rows.push(detailRow(item));
  }
  el.tbody.replaceChildren(...rows);

  el.empty.hidden = visible.length > 0;
  if (visible.length === 0 && payload.items.length > 0) {
    el.empty.textContent = 'No symbols match this filter.';
  } else if (visible.length === 0) {
    el.empty.textContent =
      'Nothing on your watchlist. Search for a symbol above to start tracking it.';
  }

  const seen = payload.items.filter((i) => i.changeSinceViewed.available).length;
  el.sectionSub.textContent =
    `Not today's movers — the diff between the price when you last opened each symbol and the newest one now. ` +
    `${seen} of ${payload.items.length} have a baseline to compare against.`;

  el.footer.innerHTML = `
    Prices come from <strong>${escapeHtml(payload.source.name)}</strong>.
    ${
      payload.source.kind === 'synthetic'
        ? 'This is a deterministic simulated market, not real quotes — the same seed replays the same prices exactly.'
        : 'Quotes are typically delayed 15–20 minutes; the timestamp shown is the one the source attributes, never the time it was fetched.'
    }
    Every number above traces to a logged observation — open a row's chevron to see them.`;
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

function renderAway(summary) {
  if (!summary) {
    el.away.hidden = true;
    return;
  }

  el.away.hidden = false;
  el.awayHeadline.textContent = summary.headline;

  el.awaySimulate.textContent = simulatedAwayMs ? 'Back to real time' : 'Simulate 50h away';
  el.awaySimulate.classList.toggle('is-active', Boolean(simulatedAwayMs));

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
      button.textContent = symbol;
      button.title = name;
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

el.sort.addEventListener('change', () => render(lastPayload));

el.refreshNow.addEventListener('click', async () => {
  await api('/ingest/tick', { method: 'POST' }).catch(() => {});
  await refresh();
});

/**
 * The long-absence view cannot otherwise be shown without waiting two days,
 * and a reviewer should not have to take it on trust. It changes only the
 * reported duration and the aggregation threshold - never a score.
 */
el.awaySimulate.addEventListener('click', async () => {
  simulatedAwayMs = simulatedAwayMs ? null : 50 * 3_600_000;
  await refresh();
});

// Ctrl/Cmd+K focuses search, matching the hint rendered in the nav bar.
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    el.input.focus();
    el.input.select();
  }
});

await loadFeatured();
await refresh();
setInterval(refresh, POLL_INTERVAL_MS);
