import test from 'node:test';
import assert from 'node:assert/strict';

const { transformSparkline, renderSparkline } = await import('../../frontend/sparkline.js');

const data = (prices, changePct = null) => ({
  points: prices.map((price, index) => (price == null ? null : { t: index, price })),
  changePct,
});

test('sparkline transforms a rising series into a compact green path', () => {
  const result = transformSparkline(data([100, 101, 103], 3));
  assert.equal(result.tone, 'up');
  assert.match(result.path, /^M/);
  assert.equal(result.width, 132);
  assert.equal(result.height, 36);
});

test('sparkline uses red, neutral, and preserves gaps', () => {
  assert.equal(transformSparkline(data([103, 101, 100], -3)).tone, 'down');
  assert.equal(transformSparkline(data([100, 100.01, 100], 0.01)).tone, 'flat');
  const result = transformSparkline(data([100, 101, null, 102, 103], 3));
  assert.equal((result.path.match(/M/g) ?? []).length, 2);
});

test('sparkline stays quiet for insufficient history', () => {
  assert.equal(transformSparkline({ insufficientPoints: true, points: [] }), null);
  assert.equal(transformSparkline(data([100, 101])), null);
  assert.equal(renderSparkline(data([100, 101])), '');
});
