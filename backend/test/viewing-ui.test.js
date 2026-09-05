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
