export function createDiscovery({ api, escapeHtml, signed, onAdd, onOpen }) {
  let cached = null;
  let loading = null;

  function render(container) {
    const suggestions = cached?.suggestions ?? [];
    if (suggestions.length === 0) {
      container.innerHTML = '<p class="discovery__empty">Nothing new stands out right now.</p>';
      return;
    }

    container.innerHTML = suggestions
      .map(
        (item) => `<article class="discovery-item">
          <button type="button" class="discovery-item__main" data-open="${escapeHtml(item.symbol)}">
            <span class="discovery-item__identity">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.symbol)} · ${escapeHtml(item.exchange)}</span>
            </span>
            <span class="discovery-item__move ${item.currentMove == null ? 'flat' : item.currentMove >= 0 ? 'up' : 'down'}">
              ${item.currentMove == null ? 'Active' : `${signed(item.currentMove)}%`}
            </span>
          </button>
          <p class="discovery-item__why"><span>Why you're seeing this</span>${escapeHtml(item.why)}</p>
          <button type="button" class="btn btn--primary discovery-item__add" data-add="${escapeHtml(item.symbol)}">+ Add to watchlist</button>
        </article>`,
      )
      .join('');

    for (const button of container.querySelectorAll('[data-add]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await onAdd(button.dataset.add);
          cached.suggestions = cached.suggestions.filter((item) => item.symbol !== button.dataset.add);
          render(container);
        } finally {
          button.disabled = false;
        }
      });
    }

    for (const button of container.querySelectorAll('[data-open]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        await onOpen(button.dataset.open);
        cached.suggestions = cached.suggestions.filter((item) => item.symbol !== button.dataset.open);
        render(container);
      });
    }
  }

  async function load(container, force = false) {
    if (cached && !force) {
      render(container);
      return;
    }
    if (loading) return loading;

    container.innerHTML = '<p class="discovery__status">Looking for something worth a look...</p>';
    loading = api('/discovery')
      .then((data) => {
        cached = data;
        render(container);
      })
      .catch(() => {
        cached = { suggestions: [] };
        container.innerHTML = '<p class="discovery__empty">Nothing new stands out right now.</p>';
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  return { load };
}
