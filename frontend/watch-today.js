/**
 * Frontend controller for "What to Watch Today" right-sidebar card.
 *
 * Renders up to 3 market-wide discovery candidates.
 * Click opens the stock's detail view; "+" adds to watchlist without establishing
 * a viewed baseline.
 */

export function createWatchToday({ api, escapeHtml, onAdd, onOpen }) {
  let cached = null;
  let loading = null;

  function render(bodyEl, subtitleEl, watchedSymbols = new Set()) {
    if (!bodyEl) return;
    const candidates = cached?.candidates ?? [];
    if (subtitleEl && cached?.subtitle) {
      subtitleEl.textContent = cached.subtitle;
    }

    if (candidates.length === 0) {
      bodyEl.innerHTML = `
        <div class="watch-today__empty">
          <p class="watch-today__empty-title">Nothing strong stands out today.</p>
          <p class="watch-today__empty-sub">We'll surface candidates when multiple signals line up.</p>
        </div>`;
      return;
    }

    const itemsHtml = candidates
      .map((item) => {
        const isWatched = watchedSymbols.has(item.symbol);
        const dirSymbol = item.direction === 'up' ? '↗' : item.direction === 'down' ? '↘' : '•';
        const newsPill = item.hasNews
          ? '<span class="watch-today-item__news" title="Verified relevant news context">News</span>'
          : '';

        return `
          <div class="watch-today-item" data-symbol="${escapeHtml(item.symbol)}">
            <div class="watch-today-item__top">
              <button type="button" class="watch-today-item__open" data-open="${escapeHtml(item.symbol)}" title="Open ${escapeHtml(item.name)} detail">
                <span class="watch-today-item__name">${escapeHtml(item.name)}</span>
                <span class="watch-today-item__dir ${item.direction}">${dirSymbol}</span>
              </button>
              <button type="button" class="watch-today-item__add ${isWatched ? 'is-watched' : ''}"
                      data-add="${escapeHtml(item.symbol)}"
                      ${isWatched ? 'disabled' : ''}
                      title="${isWatched ? 'Already on watchlist' : `Add ${escapeHtml(item.symbol)} to watchlist`}"
                      aria-label="Add ${escapeHtml(item.symbol)} to watchlist">
                ${isWatched ? '✓' : '+'}
              </button>
            </div>
            <div class="watch-today-item__desc">
              <span class="watch-today-item__signal">${escapeHtml(item.signal)}</span>
              ${newsPill}
            </div>
          </div>`;
      })
      .join('');

    bodyEl.innerHTML = `
      <div class="watch-today-list">${itemsHtml}</div>
      <a href="#discovery-section" class="watch-today__all" id="watch-today-view-all">View all signals →</a>`;

    // Hook add buttons
    for (const button of bodyEl.querySelectorAll('[data-add]:not([disabled])')) {
      button.addEventListener('click', async (e) => {
        e.stopPropagation();
        const symbol = button.dataset.add;
        button.disabled = true;
        button.textContent = '…';
        try {
          await onAdd(symbol);
          button.textContent = '✓';
          button.classList.add('is-watched');
          watchedSymbols.add(symbol);
        } catch {
          button.disabled = false;
          button.textContent = '+';
        }
      });
    }

    // Hook open buttons
    for (const button of bodyEl.querySelectorAll('[data-open]')) {
      button.addEventListener('click', async () => {
        const symbol = button.dataset.open;
        await onOpen(symbol);
      });
    }

    // Hook view all signals link
    const viewAllLink = bodyEl.querySelector('#watch-today-view-all');
    if (viewAllLink) {
      viewAllLink.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById('discovery-section');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }
  }

  async function load(bodyEl, subtitleEl, watchedSymbols = new Set(), force = false) {
    if (cached && !force) {
      render(bodyEl, subtitleEl, watchedSymbols);
      return;
    }
    if (loading) return loading;

    loading = api('/watch-today')
      .then((data) => {
        cached = data;
        render(bodyEl, subtitleEl, watchedSymbols);
      })
      .catch(() => {
        cached = { candidates: [], subtitle: 'Market signals unavailable' };
        render(bodyEl, subtitleEl, watchedSymbols);
      })
      .finally(() => {
        loading = null;
      });

    return loading;
  }

  return { load, render };
}
