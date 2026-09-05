import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const server = fs.readFileSync(path.join(root, 'backend', 'src', 'server.js'), 'utf8');

test('SPA fallback serves index.html for frontend routes like /history', () => {
  assert.match(server, /express\.static\(path\.join\(REPO_ROOT, 'frontend'\)\)/);
  assert.match(server, /res\.sendFile\(path\.join\(REPO_ROOT, 'frontend', 'index\.html'\)\)/);
});

test('SPA fallback is registered after express.static so static assets win', () => {
  const staticIndex = server.indexOf("express.static(path.join(REPO_ROOT, 'frontend'))");
  const fallbackIndex = server.indexOf("res.sendFile(path.join(REPO_ROOT, 'frontend', 'index.html'))");
  assert.ok(staticIndex !== -1, 'express.static must be present');
  assert.ok(fallbackIndex !== -1, 'SPA fallback must be present');
  assert.ok(
    fallbackIndex > staticIndex,
    'SPA fallback must be registered after express.static',
  );
});

test('SPA fallback excludes /api/* so API requests are not swallowed', () => {
  assert.match(server, /req\.path === '\/api' \|\| req\.path\.startsWith\('\/api\/'\)/);
});

test('SPA fallback only handles GET and HEAD requests', () => {
  assert.match(server, /req\.method !== 'GET' && req\.method !== 'HEAD'/);
});

test('existing API mount is preserved before the static and fallback layers', () => {
  const apiIndex = server.indexOf("app.use(\n  '/api',");
  const staticIndex = server.indexOf("express.static(path.join(REPO_ROOT, 'frontend'))");
  assert.ok(apiIndex !== -1, '/api mount must be present');
  assert.ok(staticIndex !== -1, 'express.static must be present');
  assert.ok(apiIndex < staticIndex, '/api mount must come before static serving');
});