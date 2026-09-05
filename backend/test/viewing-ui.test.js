import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'frontend', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

test('primary UI has no manual seen controls', () => {
  assert.doesNotMatch(app, /markAllSeen|data-action=["']viewed["']/);
  assert.doesNotMatch(html, /Mark all as seen|Mark seen/);
});

test('opening a stock uses the existing viewed API', () => {
  assert.match(app, /\/watchlist\/\$\{encodeURIComponent\(item\.symbol\)\}\/viewed/);
  assert.match(app, /expanded\.add\(item\.symbol\)/);
});

test('the not-seen filter is not exposed as a primary control', () => {
  assert.doesNotMatch(html, /data-filter=["']unseen["']/);
});

test('expanded detail and sparklines are cached across unchanged polls', () => {
  assert.match(app, /const detailRows = new Map\(\)/);
  assert.match(app, /if \(cached\) \{[\s\S]*?return cached\.row;/);
  assert.match(app, /cached\.latestTimestamp !== item\.latest\?\.timestamp/);
  assert.match(app, /sparkline\.load\(row\.querySelector\('\.trend-slot'\), item\.symbol, latest\?\.timestamp\)/);
});

test('raw observation audit is behind analysis disclosure', () => {
  const detail = app.slice(app.indexOf('function detailPanel'), app.indexOf('// -------------------------------------------------------------- filter'));
  assert.match(detail, /<details class="analysis-details">/);
  assert.match(detail, /<div class="audit__observations"><\/div>/);
  assert.doesNotMatch(detail, /Every observation behind this price/);
});

test('alert diagnostics are behind a collapsed disclosure', () => {
  const panels = fs.readFileSync(path.join(root, 'frontend', 'panels.js'), 'utf8');
  assert.match(panels, /<details class="alert-diagnostics">/);
  assert.match(panels, /Why wasn't I alerted\?/);
  assert.match(panels, /diagnosisMarkup/);
});
