export function createSearch({ api, input, results, escapeHtml, onSelect }) {
  let timer = null;
  let requestId = 0;

  function close() {
    results.hidden = true;
    results.replaceChildren();
  }

  function render(items) {
    if (items.length === 0) {
      results.innerHTML = '<p class="search-results__empty">No supported securities found.</p>';
      results.hidden = false;
      return;
    }

    results.innerHTML = items
      .map(
        (item) => `<button type="button" class="search-result" data-symbol="${escapeHtml(item.symbol)}">
          <span class="search-result__ticker">${escapeHtml(item.symbol)}</span>
          <span class="search-result__name">${escapeHtml(item.name ?? item.symbol)}</span>
          <span class="search-result__exchange">${escapeHtml(item.exchange ?? 'Market unavailable')}</span>
        </button>`,
      )
      .join('');
    results.hidden = false;

    for (const button of results.querySelectorAll('[data-symbol]')) {
      button.addEventListener('click', () => {
        input.value = '';
        close();
        onSelect(button.dataset.symbol);
      });
    }
  }

  async function search(query) {
    const current = ++requestId;
    if (!query) {
      close();
      return;
    }

    results.innerHTML = '<p class="search-results__status">Searching supported markets...</p>';
    results.hidden = false;

    try {
      const response = await api(`/symbols/search?q=${encodeURIComponent(query)}`);
      if (current === requestId) render(response.results ?? []);
    } catch (error) {
      if (current !== requestId) return;
      results.innerHTML = `<p class="search-results__error">${escapeHtml(
        error.message || 'Search is temporarily unavailable.',
      )}</p>`;
      results.hidden = false;
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(input.value.trim()), 240);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.nav__search')) close();
  });

  return { close };
}
