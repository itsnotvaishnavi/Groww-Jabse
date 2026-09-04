/**
 * The intraday panel and the alert form.
 *
 * Both are deliberately small. The intraday panel renders what
 * /api/intraday returns and nothing more - it does no arithmetic, which is why
 * a session number here can never disagree with a session number there. The
 * alert form is a type, a value and a button; the brief asked for no wizard and
 * there is none.
 *
 * Formatters arrive as `deps` rather than being imported, the same arrangement
 * chart.js uses, so no two frontend modules depend on each other's internals.
 */

const ALERT_TYPES = [
  { key: 'price_crosses_above', label: 'Price crosses above', unit: '₹', needsValue: true },
  { key: 'price_falls_below', label: 'Price falls below', unit: '₹', needsValue: true },
  { key: 'change_since_viewed_exceeds', label: 'Change since I looked exceeds', unit: '%', needsValue: true },
  { key: 'attention_high', label: 'Attention becomes HIGH', unit: '', needsValue: false },
  { key: 'unusual_volume', label: 'Unusual volume above', unit: '×', needsValue: true },
];

export function createPanels(deps) {
  const { api, inr, escapeHtml, directionClass, signed, duration, ago, whenIstPrecise } = deps;

  const pct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

  /**
   * One metric row. An unavailable metric prints its reason and NOT a number -
   * substituting a figure from another window is the single thing this panel
   * must never do.
   */
  const row = (label, metric, render) => {
    if (!metric?.available) {
      return `<div class="ip__row">
        <span class="ip__k">${escapeHtml(label)}</span>
        <span class="ip__v ip__v--off">unavailable — ${escapeHtml(
          metric?.reason ?? 'unknown',
        )}</span>
      </div>`;
    }
    return `<div class="ip__row">
      <span class="ip__k">${escapeHtml(label)}</span>
      <span class="ip__v">${render(metric)}</span>
    </div>`;
  };

  function renderIntraday(data) {
    const m = data.metrics;
    const w = data.window;

    /**
     * The window is named before any number is shown. Every figure below is
     * scoped to it, and the engine's own values are kept in their own block
     * lower down precisely so the two cannot be read as one set.
     */
    const header = `<div class="ip__window">
      <span class="ip__window-label">${escapeHtml(w.label)}</span>
      <span class="ip__window-span">
        ${whenIstPrecise(w.from)} → ${whenIstPrecise(w.to)} IST · ${duration(w.lengthMs)}
      </span>
      <span class="ip__window-note">${escapeHtml(w.note ?? '')}</span>
    </div>`;

    const session = `<div class="ip__block">
      <div class="ip__title">${w.isSession ? 'Session' : 'Recent window'}</div>
      ${row('Current price', m.currentPrice, (x) =>
        `₹${inr.format(x.price)}${
          x.inWindow ? '' : ' <em class="ip__flag">outside this window</em>'
        }`,
      )}
      ${row(w.isSession ? 'Session high' : 'Window high', m.high, (x) =>
        `₹${inr.format(x.price)} <em>${whenIstPrecise(x.timestamp)}</em>`,
      )}
      ${row(w.isSession ? 'Session low' : 'Window low', m.low, (x) =>
        `₹${inr.format(x.price)} <em>${whenIstPrecise(x.timestamp)}</em>`,
      )}
      ${row(w.isSession ? 'Session return' : 'Window return', m.return, (x) =>
        `<span class="${directionClass(x.percent)}">${signed(x.percent)}%</span>
         <em>₹${inr.format(x.fromPrice)} → ₹${inr.format(x.toPrice)}</em>`,
      )}
      ${row('Volatility', m.volatility, (x) =>
        `${x.perBarPct}% per ${duration(x.barMs)} <em>${x.samples} intervals</em>`,
      )}
      ${row('Volume vs normal', m.volume, (x) =>
        `${x.ratio}× <em>${x.windowAvgPerBar} vs ${x.baselineAvgPerBar} per bar, baseline ${duration(
          x.baselineTo - x.baselineFrom,
        )} before</em>`,
      )}
      ${row('vs market', m.vsMarket, (x) =>
        `<span class="${directionClass(x.excessPct)}">${signed(x.excessPct)}%</span>
         <em>${pct(x.symbolReturnPct)} vs ${escapeHtml(x.benchmarkSymbol)} ${pct(
           x.benchmarkReturnPct,
         )}</em>`,
      )}
      ${row('vs sector', m.vsSector, (x) =>
        `<span class="${directionClass(x.excessPct)}">${signed(x.excessPct)}%</span>
         <em>${escapeHtml(x.sector)} peers ${pct(x.sectorReturnPct)} · ${escapeHtml(
           x.peers.join(', '),
         )}</em>`,
      )}
    </div>`;

    const engine = data.engine
      ? `<div class="ip__block">
          <div class="ip__title">Engine <em>not session-scoped</em></div>
          <div class="ip__row"><span class="ip__k">Attention level</span>
            <span class="ip__v"><span class="level level--${escapeHtml(
              data.engine.attentionLevel,
            )}">${escapeHtml(data.engine.attentionLevel)}</span></span></div>
          <div class="ip__row"><span class="ip__k">Confidence</span>
            <span class="ip__v">${data.engine.confidence}</span></div>
          <div class="ip__row"><span class="ip__k">Freshness</span>
            <span class="ip__v">${escapeHtml(data.engine.freshness.label)} · ${ago(
              data.engine.freshness.ageMs,
            )}</span></div>
          <p class="ip__note">${escapeHtml(data.engine.note)} Horizon ${duration(
            data.engine.anomalyHorizonMs ?? 0,
          )}.</p>
        </div>`
      : '';

    /**
     * Observations, in the past tense, each with the evidence that produced it.
     * Nothing here is a forecast or an instruction - see backend/src/intraday.js.
     */
    const patterns = data.patterns.length
      ? `<div class="ip__block ip__block--wide">
          <div class="ip__title">Observed in this window</div>
          <ul class="ip__patterns">
            ${data.patterns
              .map(
                (p) =>
                  `<li><span class="ip__pattern-code">${escapeHtml(
                    p.code.replace(/_/g, ' '),
                  )}</span> ${escapeHtml(p.text)}</li>`,
              )
              .join('')}
          </ul>
          <p class="ip__note">
            Observations about what has already happened, not forecasts. This panel
            never says buy, sell or hold.
          </p>
        </div>`
      : `<div class="ip__block ip__block--wide">
          <div class="ip__title">Observed in this window</div>
          <p class="ip__note">Nothing in this window crossed a reporting threshold.</p>
        </div>`;

    return `${header}<div class="ip__grid">${session}${engine}${patterns}</div>
      <p class="ip__meta">
        ${data.barsObserved} of ${Math.round(w.lengthMs / data.barMs)} bars observed at
        ${duration(data.barMs)} resolution${data.gaps ? ` · ${data.gaps} gaps` : ''}
      </p>`;
  }

  async function loadIntraday(container, symbol) {
    container.innerHTML = '<p class="ip__note">Analysing…</p>';
    try {
      const data = await api(`/intraday/${encodeURIComponent(symbol)}`);
      container.innerHTML = renderIntraday(data);
    } catch (error) {
      container.innerHTML = `<p class="ip__note">Could not analyse: ${escapeHtml(
        error.message,
      )}</p>`;
    }
  }

  // ------------------------------------------------------------------ alerts

  function alertFormMarkup(symbol, alerts) {
    const options = ALERT_TYPES.map(
      (t) => `<option value="${t.key}">${escapeHtml(t.label)}</option>`,
    ).join('');

    const existing = alerts.length
      ? `<ul class="al__list">
          ${alerts
            .map(
              (a) => `<li>
                <span class="al__desc">${escapeHtml(describeAlert(a))}</span>
                <span class="al__state ${a.armed ? '' : 'al__state--fired'}">${
                  a.armed ? 'armed' : `fired ${a.fireCount}×`
                }</span>
                <button type="button" class="btn btn--icon" data-remove-alert="${a.id}"
                        title="Remove this alert" aria-label="Remove alert">×</button>
              </li>`,
            )
            .join('')}
        </ul>`
      : '<p class="ip__note">No alerts on this symbol yet.</p>';

    return `<div class="al">
      <div class="ip__title">Alerts</div>
      ${existing}
      <form class="al__form" data-symbol="${escapeHtml(symbol)}">
        <select name="type" aria-label="Alert type">${options}</select>
        <input name="threshold" type="number" step="any" placeholder="value"
               aria-label="Threshold" />
        <button type="submit" class="btn btn--primary">Set alert</button>
      </form>
      <p class="al__error" hidden></p>
      <p class="ip__note">
        Alerts fire on the crossing, not while the condition holds, and never from
        a stale price or a closed market.
      </p>
    </div>`;
  }

  function describeAlert(alert) {
    const type = ALERT_TYPES.find((t) => t.key === alert.type);
    const label = type?.label ?? alert.type;
    return alert.threshold == null
      ? label
      : `${label} ${type?.unit === '₹' ? '₹' : ''}${alert.threshold}${
          type?.unit && type.unit !== '₹' ? type.unit : ''
        }`;
  }

  const STATUS_LABEL = {
    would_fire: 'would fire now',
    not_met: 'not met yet',
    awaiting_reset: 'waiting to reset',
    blocked: 'not evaluated',
  };

  /**
   * "Why wasn't I alerted?"
   *
   * Rendered straight from /api/alerts/diagnostics - the rule, the current
   * value, the specific blockers and the feature facts behind them. Nothing is
   * composed here: a generic sentence assembled in the browser would be exactly
   * the thing this feature exists to replace.
   */
  function diagnosisMarkup(diagnosis) {
    if (!diagnosis) return '';

    const blockers = diagnosis.blockers.length
      ? `<ul class="dg__blockers">${diagnosis.blockers
          .map((b) => `<li><span class="dg__code">${escapeHtml(b.code)}</span> ${escapeHtml(b.text)}</li>`)
          .join('')}</ul>`
      : '<p class="dg__ok">Every condition is satisfied — the next evaluation fires it.</p>';

    const facts = diagnosis.signals.length
      ? `<ul class="dg__facts">${diagnosis.signals
          .map(
            (f) =>
              `<li class="${f.available === false ? 'dg__fact--off' : ''}">${escapeHtml(f.text)}</li>`,
          )
          .join('')}</ul>`
      : '';

    return `<div class="dg dg--${escapeHtml(diagnosis.status)}">
      <div class="dg__head">
        <span class="dg__rule">${escapeHtml(diagnosis.rule.text)}</span>
        <span class="dg__status">${escapeHtml(STATUS_LABEL[diagnosis.status] ?? diagnosis.status)}</span>
      </div>
      <div class="dg__now">now: <strong>${escapeHtml(diagnosis.current.text)}</strong>${
        diagnosis.current.dataQuality
          ? ` <em>${escapeHtml(diagnosis.current.dataQuality)}</em>`
          : ''
      }</div>
      ${blockers}
      ${facts}
    </div>`;
  }

  async function loadAlerts(container, symbol, onChange) {
    try {
      const [{ alerts }, diagnostics] = await Promise.all([
        api('/alerts'),
        api('/alerts/diagnostics').catch(() => ({ diagnostics: [] })),
      ]);
      const mine = alerts.filter((a) => a.symbol === symbol);
      const byId = new Map((diagnostics.diagnostics ?? []).map((d) => [d.alertId, d]));

      container.innerHTML =
        alertFormMarkup(symbol, mine) +
        (mine.length
          ? `<div class="dg__list">${mine
              .map((a) => diagnosisMarkup(byId.get(a.id)))
              .join('')}</div>`
          : '');
    } catch (error) {
      container.innerHTML = `<p class="ip__note">Could not load alerts: ${escapeHtml(
        error.message,
      )}</p>`;
      return;
    }

    const form = container.querySelector('.al__form');
    const error = container.querySelector('.al__error');

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;

      const type = form.type.value;
      const spec = ALERT_TYPES.find((t) => t.key === type);
      const raw = form.threshold.value.trim();

      try {
        await api('/alerts', {
          method: 'POST',
          body: JSON.stringify({
            symbol,
            type,
            threshold: spec?.needsValue ? Number(raw) : null,
          }),
        });
        await loadAlerts(container, symbol, onChange);
        onChange?.();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.hidden = false;
      }
    });

    for (const button of container.querySelectorAll('[data-remove-alert]')) {
      button.addEventListener('click', async () => {
        await api(`/alerts/${button.dataset.removeAlert}`, { method: 'DELETE' }).catch(() => {});
        await loadAlerts(container, symbol, onChange);
        onChange?.();
      });
    }
  }

  /** The notification list: what fired, and why. */
  function renderAlertFeed(container, { events, unacknowledged }) {
    if (events.length === 0) {
      container.innerHTML = '<p class="card__note">Nothing has fired yet.</p>';
      return;
    }

    container.innerHTML = `
      ${
        unacknowledged > 0
          ? `<button type="button" class="chip chip--ghost al__ack">Mark ${unacknowledged} as seen</button>`
          : ''
      }
      <ul class="al__feed">
        ${events
          .map(
            (e) => `<li class="${e.acknowledged ? '' : 'is-new'}">
              <span class="al__feed-reason">${escapeHtml(e.reason)}</span>
              <span class="al__feed-meta">${ago(Date.now() - e.firedAt)} · ${escapeHtml(
                e.dataQuality ?? '',
              )}</span>
              ${
                /**
                 * Which signals contributed, as recorded AT fire time. The
                 * market has moved since; recomputing this now would describe a
                 * different moment than the one that triggered.
                 */
                e.diagnosis?.contributing?.length
                  ? `<span class="al__feed-why">via ${e.diagnosis.contributing
                      .map((c) => escapeHtml(c.signal.replace(/([A-Z])/g, ' $1').toLowerCase().trim()))
                      .join(', ')}</span>`
                  : ''
              }
            </li>`,
          )
          .join('')}
      </ul>`;

    container.querySelector('.al__ack')?.addEventListener('click', async () => {
      await api('/alerts/events/acknowledge', { method: 'POST' }).catch(() => {});
      await loadAlertFeed(container);
    });
  }

  async function loadAlertFeed(container) {
    try {
      renderAlertFeed(container, await api('/alerts/events'));
    } catch {
      // The feed is informational; a failure here must not break the page.
    }
  }

  return { loadIntraday, loadAlerts, loadAlertFeed };
}
