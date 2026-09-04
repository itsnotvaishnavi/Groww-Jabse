/**
 * HTTP entrypoint.
 *
 * Deliberately thin: it wires routes and serves the static frontend. All real
 * logic lives in modules so it can be tested (and reasoned about) without
 * standing up a server.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const PORT = Number(process.env.PORT ?? 3000);
const STARTED_AT = Date.now();

const app = express();
app.use(express.json());

/**
 * Liveness probe. Intentionally does NOT touch the database or any upstream
 * data source - it answers "is this process up?", nothing more. A readiness
 * check that reports data freshness is a separate concern and will get its
 * own endpoint once the snapshot log exists.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    serverTime: new Date().toISOString(),
  });
});

// The frontend is plain HTML/JS with no build step, so Express serves it
// directly. One process, one origin, no CORS to reason about.
app.use(express.static(path.join(REPO_ROOT, 'frontend')));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
