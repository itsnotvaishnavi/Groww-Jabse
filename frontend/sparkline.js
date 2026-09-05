const WIDTH = 132;
const HEIGHT = 36;
const PAD = 2;
const FLAT_THRESHOLD_PCT = 0.05;

export function transformSparkline(data) {
  if (!data || data.insufficientPoints || !Array.isArray(data.points)) return null;

  const points = data.points;
  const present = points.filter(Boolean);
  if (present.length < 3) return null;

  const prices = present.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || Math.max(Math.abs(max) * 0.001, 0.01);
  const plotWidth = WIDTH - PAD * 2;
  const plotHeight = HEIGHT - PAD * 2;
  const x = (index) => PAD + (index / Math.max(1, points.length - 1)) * plotWidth;
  const y = (price) => PAD + (1 - (price - min) / span) * plotHeight;

  const segments = [];
  let segment = [];
  points.forEach((point, index) => {
    if (!point) {
      if (segment.length > 1) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ x: x(index), y: y(point.price) });
  });
  if (segment.length > 1) segments.push(segment);
  if (segments.length === 0) return null;

  const changePct = Number.isFinite(data.changePct)
    ? data.changePct
    : ((present.at(-1).price - present[0].price) / present[0].price) * 100;
  const tone =
    Math.abs(changePct) < FLAT_THRESHOLD_PCT ? 'flat' : changePct > 0 ? 'up' : 'down';
  const path = segments
    .map((run) =>
      run.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
    )
    .join(' ');

  return { path, tone, width: WIDTH, height: HEIGHT };
}

export function renderSparkline(data, symbol = 'stock') {
  const transformed = transformSparkline(data);
  if (!transformed) return '';

  return `<svg class="sparkline" viewBox="0 0 ${transformed.width} ${transformed.height}"
      role="img" aria-label="${symbol} intraday trend">
    <path class="sparkline__line sparkline__line--${transformed.tone}"
      d="${transformed.path}" fill="none" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

export function createSparkline({ api }) {
  async function load(container, symbol) {
    container.replaceChildren();
    try {
      const data = await api(`/chart/${encodeURIComponent(symbol)}?range=1d`);
      const markup = renderSparkline(data, symbol);
      if (markup) container.innerHTML = markup;
    } catch {
      // A sparkline is optional context; leave the cell quiet when unavailable.
    }
  }

  return { load };
}
