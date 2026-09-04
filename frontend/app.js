/**
 * Watchlist UI.
 *
 * Plain ES modules, no framework, no build step. The whole page is a function
 * of one API response, re-rendered on a poll - which at this size is simpler
 * and less bug-prone than incremental DOM updates, and keeps the interesting
 * logic on the server where it can be tested.
 *
 * The design rule throughout: never show a price without also showing how much
 * to trust it. Every number is paired with its age, its source and its
 * freshness state.
 */

const POLL_INTERVAL_MS = 5_000;

const el = {
  sourcePill: document.getElementById('source-pill'),
  marketPill: document.getElementById('market-pill'),
  refreshNote: document.getElementById('refresh-note'),
  form: document.getElementById('add-form'),
  input: document.getElementById('symbol-input'),
  suggestions: document.getElementById('symbol-suggestions'),
  formError: document.getElementById('form-error'),
  sort: document.getElementById('sort-select'),
  refreshNow: document.getElementById('refresh-now'),
  list: document.getElementById('watchlist'),
  empty: document.getElementById('empty-state'),
  footer: document.getElementById('footer'),
};

/** Rows the user has expanded, kept across re-renders so a poll does not
 *  collapse the audit trail out from under them. */
const expanded = new Set();
let lastPayload = null;

// ---------------------------------------------------------------- formatting

const inr = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat('en-IN', { notation: 'compact' });

/**
 * Ages are shown in the coarsest unit that is still honest. "3m ago" is more
 * readable than "184s ago", but under a minute the seconds matter - that is
 * exactly the range where the user is deciding whether the feed is alive.
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

/** Build a DOM node from an HTML string - used only with values escaped below. */
function html(strings, ...values) {
  const markup = strings.reduce(
    (acc, str, i) => acc + str + (i < values.length ? values[i] : ''),
    '',
  );
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

/** Symbols are user input and end up in markup, so they are escaped. */
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
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

// -------------------------------------------------------------------- render

/**
 * The freshness pill: state, plus the age of the observation. The age is shown
 * even in the good cases, because "live" without a number is a claim the user
 * has to take on faith.
 */
function freshnessPill(freshness) {
  const age = freshness.ageMs == null ? '' : ` · ${ago(freshness.ageMs)}`;
  return `<span class="pill pill--${freshness.state}" title="${escapeHtml(freshness.label)}">
    ${escapeHtml(freshness.label)}${age}
  </span>`;
}

/**
 * The delta block - the reason this app exists.
 *
 * When there is no baseline the row explains *why* rather than showing a dash:
 * "never viewed" and "we had no data when you looked" are different situations
 * and the second one is the app admitting a gap in its own coverage.
 */
function deltaBlock(item) {
  const { delta } = item;

  if (!delta.hasBaseline) {
    const reasons = {
      never_viewed: 'First time seeing this — mark it seen to start tracking changes.',
      no_observation_at_last_view:
        'No observation had been recorded when you last looked, so there is nothing to diff against yet.',
      no_current_observation: 'Waiting for the first observation from the feed.',
    };
    return `<p class="delta delta--none">${escapeHtml(
      reasons[delta.reason] ?? 'No baseline available.',
    )}</p>`;
  }

  const cls = directionClass(delta.absolute);
  const volume =
    delta.volumeRatio == null
      ? ''
      : ` · volume ×${delta.volumeRatio.toFixed(2)}`;

  return `<div class="delta">
    <span class="delta__value ${cls}">
      ${signed(delta.absolute)} (${signed(delta.percent)}%)
    </span>
    <span class="delta__explain">
      since you last looked ${ago(Date.now() - delta.lastViewedAt)} ·
      ₹${inr.format(delta.from.price)} → ₹${inr.format(delta.to.price)} ·
      spans ${ago(delta.spanMs).replace(' ago', '')}${volume}
    </span>
  </div>`;
}

function conflictBlock(conflict) {
  if (!conflict) return '';
  const detail = conflict.observations
    .map((o) => `${escapeHtml(o.source)} ₹${inr.format(o.price)} (confidence ${o.confidence})`)
    .join(' vs ');
  const preferred = conflict.preferred
    ? ` Showing <strong>${escapeHtml(conflict.preferred)}</strong> as the higher-confidence source.`
    : ' Neither source is more confident, so neither is preferred.';

  return `<p class="conflict">
    <strong>Sources disagree by ${conflict.spreadPct}%</strong>
    (tolerance ${conflict.tolerancePct}%): ${detail}.${preferred}
  </p>`;
}

/**
 * The audit trail. The brief calls for change to be explainable and never a
 * black box, so any row can be opened to reveal the actual log rows behind the
 * number - timestamps, source and confidence included.
 */
function auditBlock(symbol) {
  const isOpen = expanded.has(symbol);
  return `<details class="audit" data-symbol="${escapeHtml(symbol)}" ${isOpen ? 'open' : ''}>
    <summary>Show the observations behind this</summary>
    <div class="audit__body">Loading…</div>
  </details>`;
}

function stateColor(state) {
  return {
    live: 'var(--live)',
    delayed: 'var(--delayed)',
    market_closed: 'var(--closed)',
    stale: 'var(--stale)',
    no_data: 'var(--nodata)',
  }[state];
}

function renderRow(item) {
  const { latest, freshness } = item;
  const price = latest ? `₹${inr.format(latest.price)}` : '—';
  const meta = [];

  if (latest) {
    meta.push(`${escapeHtml(latest.source)} · ${whenIst(latest.timestamp)} IST`);
    meta.push(`confidence ${latest.confidence}`);
    meta.push(`vol ${compact.format(latest.volume)}`);
  } else {
    meta.push('no observations recorded yet');
  }

  const row = html`
    <li class="row" style="--state-color: ${stateColor(freshness.state)}">
      <div class="row__main">
        <div class="row__symbol">${escapeHtml(item.symbol)}</div>
        <div class="row__price">${price}</div>
        <div class="row__actions">
          <button type="button" class="ghost" data-action="viewed">Mark seen</button>
          <button type="button" class="ghost" data-action="remove">Remove</button>
        </div>
        <div class="row__meta">
          ${freshnessPill(freshness)}
          <span>${meta.join(' · ')}</span>
        </div>
        ${conflictBlock(item.conflict)}
        ${deltaBlock(item)}
        ${auditBlock(item.symbol)}
      </div>
    </li>
  `;

  row.querySelector('[data-action="viewed"]').addEventListener('click', async () => {
    await api(`/watchlist/${encodeURIComponent(item.symbol)}/viewed`, { method: 'POST' });
    await refresh();
  });

  row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
    await api(`/watchlist/${encodeURIComponent(item.symbol)}`, { method: 'DELETE' });
    expanded.delete(item.symbol);
    await refresh();
  });

  const details = row.querySelector('details');
  details.addEventListener('toggle', () => {
    if (details.open) {
      expanded.add(item.symbol);
      void loadAudit(details, item.symbol);
    } else {
      expanded.delete(item.symbol);
    }
  });
  if (details.open) void loadAudit(details, item.symbol);

  return row;
}

/** A dependency-free sparkline: the log is already an ordered series, so this
 *  is just a polyline over normalised values. */
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
  const color = rising ? 'var(--up)' : 'var(--down)';

  return `<svg class="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none"
               role="img" aria-label="Recent price trend">
    <polyline points="${points}" fill="none" stroke="${color}"
              stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>`;
}

async function loadAudit(details, symbol) {
  const body = details.querySelector('.audit__body');
  try {
    const { snapshots } = await api(`/snapshots/${encodeURIComponent(symbol)}?limit=40`);
    if (snapshots.length === 0) {
      body.textContent = 'No observations recorded for this symbol yet.';
      return;
    }

    body.innerHTML = `
      ${sparkline(snapshots)}
      <div class="audit__scroll"><table>
        <thead>
          <tr><th>observed for (IST)</th><th>price</th><th>volume</th><th>source</th><th>conf.</th><th>recorded</th></tr>
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
    body.textContent = `Could not load observations: ${error.message}`;
  }
}

/**
 * Sorting happens client-side and only over what the server already sent.
 * "Biggest change" is a sort over the raw delta, deliberately not a relevance
 * score - ranking by meaningfulness is the next phase's job and would need to
 * account for volatility, sector and volume before it deserved to be a default.
 */
function sortItems(items, mode) {
  const copy = [...items];
  if (mode === 'change') {
    return copy.sort((a, b) => {
      const magnitude = (item) =>
        item.delta.hasBaseline ? Math.abs(item.delta.percent) : -1;
      return magnitude(b) - magnitude(a);
    });
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

function renderStatus(payload) {
  const { source, market } = payload;

  el.sourcePill.className = `pill pill--${source.kind === 'synthetic' ? 'delayed' : 'live'}`;
  el.sourcePill.textContent =
    source.kind === 'synthetic'
      ? `simulated market · seed ${source.seed}`
      : `${source.name} · delayed ~${Math.round(source.delayMs / 60_000)}m`;
  el.sourcePill.title =
    source.note ?? 'Deterministic synthetic market: the same seed always replays the same prices.';

  if (!market.appliesToSource) {
    el.marketPill.className = 'pill pill--muted';
    el.marketPill.textContent = 'exchange hours not applicable';
    el.marketPill.title =
      'The simulated market runs continuously so the app is demonstrable while NSE/BSE are closed.';
  } else if (market.open) {
    el.marketPill.className = 'pill pill--live';
    el.marketPill.textContent = 'NSE open';
    el.marketPill.title = '';
  } else {
    el.marketPill.className = 'pill pill--market_closed';
    el.marketPill.textContent = `NSE closed · opens ${whenIst(market.nextOpenAt)} IST`;
    el.marketPill.title = `Last close ${whenIst(market.lastCloseAt)} IST`;
  }
}

function render(payload) {
  lastPayload = payload;
  renderStatus(payload);

  const items = sortItems(payload.items, el.sort.value);
  el.list.replaceChildren(...items.map(renderRow));
  el.empty.hidden = items.length > 0;

  el.footer.innerHTML = `
    Prices come from <strong>${escapeHtml(payload.source.name)}</strong>.
    ${
      payload.source.kind === 'synthetic'
        ? 'This is a deterministic simulated market, not real quotes — the same seed replays the same prices exactly.'
        : 'Quotes are typically delayed 15–20 minutes; the app reports the timestamp the source attributes, never the time it was fetched.'
    }
    Every number above can be traced to a logged observation via “show the observations behind this”.`;
}

// --------------------------------------------------------------------- loops

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    render(await api('/watchlist'));
    el.refreshNote.textContent = `updated ${new Date().toLocaleTimeString('en-IN', {
      hour12: false,
    })}`;
  } catch (error) {
    el.refreshNote.textContent = `refresh failed: ${error.message}`;
  } finally {
    refreshing = false;
  }
}

async function loadSuggestions() {
  try {
    const { symbols } = await api('/symbols');
    el.suggestions.replaceChildren(
      ...symbols.map((s) => {
        const option = document.createElement('option');
        option.value = s.symbol;
        option.label = s.name;
        return option;
      }),
    );
  } catch {
    // Suggestions are a convenience; typing a ticker works without them.
  }
}

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const symbol = el.input.value.trim();
  if (!symbol) return;

  el.formError.hidden = true;
  try {
    await api('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) });
    el.input.value = '';
    await refresh();
  } catch (error) {
    el.formError.textContent = error.message;
    el.formError.hidden = false;
  }
});

el.sort.addEventListener('change', () => lastPayload && render(lastPayload));
el.refreshNow.addEventListener('click', async () => {
  await api('/ingest/tick', { method: 'POST' }).catch(() => {});
  await refresh();
});

await loadSuggestions();
await refresh();
setInterval(refresh, POLL_INTERVAL_MS);
