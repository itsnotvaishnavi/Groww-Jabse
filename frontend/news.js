export function createNews({ api, escapeHtml, whenIst, ago }) {
  const renderItems = (items) => {
    if (!items.length) return '<p class="news__empty">No major related news found.</p>';

    return `<div class="news-grid">${items
      .map(
        (item) => `<article class="news-card">
          <div class="news-card__meta">
            <span>${escapeHtml(item.source)}</span>
            <time datetime="${new Date(item.publishedAt).toISOString()}" title="${escapeHtml(
                whenIst(item.publishedAt),
              )} IST">${escapeHtml(ago(Date.now() - item.publishedAt))}</time>
          </div>
          <h3 class="news-card__title">${
            item.url
              ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(
                  item.headline,
                )}</a>`
              : escapeHtml(item.headline)
          }</h3>
          ${item.associatedSymbol ? `<span class="news-card__symbol">${escapeHtml(item.associatedSymbol)}</span>` : ''}
        </article>`,
      )
      .join('')}</div>`;
  };

  async function load(container, symbol = null) {
    container.innerHTML = '<p class="news__status">Loading latest news...</p>';
    try {
      const query = symbol ? `?symbol=${encodeURIComponent(symbol)}&limit=6` : '?limit=8';
      const data = await api(`/news${query}`);
      container.innerHTML = renderItems(data.items ?? []);
    } catch (error) {
      container.innerHTML = `<p class="news__error">News is temporarily unavailable. Jabse market data is still running.</p>`;
    }
  }

  return { load };
}
