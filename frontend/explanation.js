export function createExplanation({ api, escapeHtml, signed, whenIst, ago }) {
  const dialog = document.getElementById('explanation-dialog');
  const body = document.getElementById('explanation-body');
  const title = document.getElementById('explanation-title');

  function render(data) {
    const { evidence } = data;
    const change = evidence.sinceLastViewedChange;
    const news = evidence.relevantNews ?? [];
    const direction = change.available ? signed(change.percent) : '—';

    title.textContent = `Why did ${evidence.symbol} move?`;
    const context = news.length
      ? `<section class="explain__section">
          <div class="explain__eyebrow">Reported context</div>
          <ul class="explain__news">${news.slice(0, 1).map(newsItem).join('')}</ul>
        </section>`
      : '';

    const summary = data.available
      ? `<section class="explain__section explain__section--ai">
          <div class="explain__eyebrow">Available evidence suggests</div>
          <p class="explain__summary">${escapeHtml(data.summary)}</p>
          <div class="explain__confidence">Confidence: <strong>${escapeHtml(data.confidence)}</strong></div>
        </section>`
      : data.fallbackSummary?.length
        ? `<section class="explain__section explain__section--evidence">
            <div class="explain__eyebrow">Jabse evidence</div>
            <ul class="explain__evidence">${data.fallbackSummary
              .map((line) => `<li>${escapeHtml(line)}</li>`)
              .join('')}</ul>
            <p class="explain__muted">No confirmed catalyst was identified from the available data.</p>
          </section>`
        : `<p class="explain__muted explain__unavailable">AI explanation unavailable. The reported context is shown above.</p>`;

    body.innerHTML = `<section class="explain__section explain__section--what">
      <div class="explain__eyebrow">What happened</div>
      <p class="explain__headline"><strong>${escapeHtml(evidence.company)}</strong> moved ${escapeHtml(
        direction,
      )}% since you last looked.</p>
    </section>${context}${summary}`;
  }

  function newsItem(item) {
    return `<li>
      <div><strong>${escapeHtml(item.source)}</strong> · ${escapeHtml(ago(Date.now() - item.publishedAt))}</div>
      ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.headline)}</a>` : `<span>${escapeHtml(item.headline)}</span>`}
    </li>`;
  }

  async function open(symbol) {
    title.textContent = 'Why did this move?';
    body.innerHTML = '<p class="explain__loading">Reading evidence and relevant context…</p>';
    dialog.showModal();
    try {
      render(await api(`/explanation/${encodeURIComponent(symbol)}`));
    } catch (error) {
      body.innerHTML = `<div class="explain__unavailable"><strong>AI explanation unavailable</strong><p>${escapeHtml(
        error.message,
      )}</p></div>`;
    }
  }

  dialog.querySelector('[data-explanation-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  return { open };
}
