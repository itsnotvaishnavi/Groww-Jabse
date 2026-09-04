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
  const { delta } = item;

  if (!delta.hasBaseline) {
    const reasons = {
      never_viewed: 'Not seen yet — mark it seen to start tracking changes',
      no_observation_at_last_view:
        'No observation recorded when you last looked, so there is nothing to diff yet',
      no_current_observation: 'Waiting for the first observation from the feed',
    };
    return `<span class="chg--none">${escapeHtml(reasons[delta.reason] ?? 'No baseline')}</span>`;
  }

  const cls = directionClass(delta.absolute);
  const volume = delta.volumeRatio == null ? '' : ` · vol ×${delta.volumeRatio.toFixed(2)}`;

  return `
    <div class="chg ${cls}">${signed(delta.absolute)} (${signed(delta.percent)}%)</div>
    <div class="chg__sub">
      ₹${inr.format(delta.from.price)} → ₹${inr.format(delta.to.price)} ·
      you looked ${ago(Date.now() - delta.lastViewedAt)}${volume}
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

/** A dependency-free sparkline: the log is already an ordered series, so this
 *  is a polyline over normalised values. */
function sparkline(snapshots) {
  if (snapshots.length < 2) return '';

  const series = [...snapshots].reverse(); // oldest first
  const prices = series.map((s) => s.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;

  const points = series
    .map((s, i) => {
      const x = (i / (series.length - 1)) * 100;
      const y = 100 - ((s.price - min) / span) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const rising = prices.at(-1) >= prices[0];
  const color = rising ? 'var(--green)' : 'var(--red)';

  return `<svg class="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none"
               role="img" aria-label="Recent price trend">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"
              stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  </svg>`;
}

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
      ${sparkline(snapshots)}
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
      </td>
      <td class="num">${deltaCell(item)}</td>
      <td>
        ${freshnessPill(freshness)}
        ${latest ? `<div class="conf">confidence ${latest.confidence}</div>` : ''}
      </td>
      <td>
        <div class="actions">
          <button type="button" class="btn btn--primary" data-action="viewed">Mark seen</button>
          <button type="button" class="btn" data-action="remove">Remove</button>
          <button type="button" class="btn btn--icon ${isOpen ? 'is-open' : ''}"
                  data-action="expand" aria-label="Show the observations behind this"
                  title="Show the observations behind this">${CHEVRON}</button>
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

function auditRow(item) {
  const row = node(`<tr class="wl__audit"><td colspan="5" class="audit">Loading…</td></tr>`);
  void loadAudit(row.querySelector('td'), item.symbol);
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
  changed: (i) => i.delta.hasBaseline && i.delta.percent !== 0,
  unseen: (i) => !i.delta.hasBaseline,
  attention: (i) => i.freshness.isStale || Boolean(i.conflict),
};

function sortItems(items, mode) {
  const copy = [...items];
  if (mode === 'change') {
    const magnitude = (i) => (i.delta.hasBaseline ? Math.abs(i.delta.percent) : -1);
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
      const change = item.delta.hasBaseline
        ? `<span class="ticker__chg ${directionClass(item.delta.absolute)}">${signed(
            item.delta.percent,
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
    <div class="kv"><span class="kv__k">Market</span><span class="kv__v">${
      market.appliesToSource ? (market.open ? 'open' : 'closed') : 'n/a'
    }</span></div>
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
    if (expanded.has(item.symbol)) rows.push(auditRow(item));
  }
  el.tbody.replaceChildren(...rows);

  el.empty.hidden = visible.length > 0;
  if (visible.length === 0 && payload.items.length > 0) {
    el.empty.textContent = 'No symbols match this filter.';
  } else if (visible.length === 0) {
    el.empty.textContent =
      'Nothing on your watchlist. Search for a symbol above to start tracking it.';
  }

  const seen = payload.items.filter((i) => i.delta.hasBaseline).length;
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

// --------------------------------------------------------------------- loops

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [watchlist, meta] = await Promise.all([api('/watchlist'), api('/meta')]);
    lastMeta = meta;
    render(watchlist);
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
