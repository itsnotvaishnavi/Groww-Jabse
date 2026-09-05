/**
 * HTTP entrypoint.
 *
 * Deliberately thin: it wires modules together, serves the static frontend,
 * and owns process lifecycle. All real logic lives in modules so it can be
 * tested (and reasoned about) without standing up a server.
 */
import path from 'node:path';
import express from 'express';
import { REPO_ROOT, config } from './config.js';
import { createApi } from './api.js';
import { closeDb, getDb } from './db.js';
import { createAlertStore } from './alerts.js';
import { createEngine } from './engine/index.js';
import { createSurfacedStore } from './engine/surfaced.js';
import { assessFreshness } from './freshness.js';
import { createIngestor } from './ingest.js';
import { createSnapshotLog } from './snapshot-log.js';
import { createSummaryService } from './summary.js';
import { createWatchlist } from './watchlist.js';
import { createNewsService } from './news.js';
import { createExplanationService, createOpenAiCompatibleProvider } from './explanation.js';
import { createDiscoveryService } from './discovery.js';
import { createInstrumentCatalogue } from './catalogue.js';
import { getSource } from './sources/index.js';

const STARTED_AT = Date.now();

const db = getDb();
const snapshotLog = createSnapshotLog(db);
const watchlist = createWatchlist(db);
const source = getSource();
const sourceInfo = source.describe();
const instrumentCatalogue = createInstrumentCatalogue({
  source,
  cachePath: path.join(REPO_ROOT, 'data', 'instrument-catalogue.json'),
});
await instrumentCatalogue.loadCache();

// A first-run watchlist, so the page has something on it before the user has
// typed anything. Existing watchlists are left alone.
const seeded = watchlist.ensureDefaults(config.devUserId, config.defaultSymbols);
if (seeded.length > 0) {
  console.log(`[boot] seeded watchlist with ${seeded.join(', ')}`);
}

const surfacedStore = createSurfacedStore(db);
const alertStore = createAlertStore(db, config.alerts);
const newsService = createNewsService({ source });

/**
 * Alerts are evaluated on every ingestion tick, because that is the moment a
 * threshold crossing can have happened - so an alert fires whether or not
 * anyone has the page open. The engine is built below; the hook reads it
 * lazily through the closure so the wiring order stays readable.
 */
const ingestor = config.ingestEnabled
  ? createIngestor({
      source,
      snapshotLog,
      watchlist,
      intervalMs: config.ingestIntervalMs,
      afterTick: () => {
        const now = Date.now();
        const result = alertStore.evaluate({
          userId: config.devUserId,
          evaluation: engine.evaluate({ userId: config.devUserId, now }),
          now,
          // So the firing explanation is recorded with the event.
          engineParams: engine.params(),
        });
        for (const alert of result.fired) {
          console.log(`[alert] ${alert.reason}`);
        }
      },
    })
  : null;

/**
 * The Meaningful Change Engine and its dependencies.
 *
 * The clock is injected even here, where it is just Date.now - so that the one
 * and only way anything in the engine learns the time is through a seam a test
 * can hold still. A default parameter buried three modules down would make the
 * determinism guarantee unverifiable.
 */
const engine = createEngine({
  snapshotLog,
  watchlist,
  surfacedStore,
  source,
  clock: () => Date.now(),
});
const summaryService = createSummaryService({
  engine,
  watchlist,
  surfacedStore,
  clock: () => Date.now(),
});
const explanationService = createExplanationService({
  engine,
  source,
  newsService,
  provider: createOpenAiCompatibleProvider({
    apiKey: config.ai.apiKey,
    endpoint: config.ai.endpoint,
    model: config.ai.model,
  }),
});
const discoveryService = createDiscoveryService({
  engine,
  snapshotLog,
  watchlist,
  source,
});

const app = express();
app.use(express.json());

/**
 * Liveness probe. Intentionally does NOT touch the database or any upstream
 * data source - it answers "is this process up?", nothing more.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    serverTime: new Date().toISOString(),
  });
});

/**
 * Readiness, which is a different question from liveness: the process can be
 * perfectly healthy while the data behind it is hours old. This reports the
 * freshness of every watched symbol and answers 503 when nothing is fresh, so
 * "the server is up" can never be mistaken for "the data is good".
 */
app.get('/ready', (_req, res) => {
  const now = Date.now();
  const symbols = watchlist.symbolsInUse();
  const latest = snapshotLog.latestForSymbols(symbols);

  const byState = {};
  for (const symbol of symbols) {
    const { state } = assessFreshness(latest.get(symbol) ?? null, sourceInfo, now);
    byState[state] = (byState[state] ?? 0) + 1;
  }

  const fresh = symbols.length - (byState.stale ?? 0) - (byState.no_data ?? 0);
  const ready = symbols.length === 0 || fresh > 0;

  res.status(ready ? 200 : 503).json({
    ready,
    source: source.name,
    symbols: symbols.length,
    fresh,
    byState,
  });
});

app.use(
  '/api',
  createApi({
    snapshotLog,
    watchlist,
    source,
    ingestor,
    engine,
    summaryService,
    surfacedStore,
    alertStore,
    newsService,
    explanationService,
    discoveryService,
    instrumentCatalogue,
  }),
);

// The frontend is plain HTML/JS with no build step, so Express serves it
// directly. One process, one origin, no CORS to reason about.
app.use(express.static(path.join(REPO_ROOT, 'frontend')));

if (source.name === 'yahoo') {
  void instrumentCatalogue.refresh().catch((error) =>
    console.error('[catalogue] refresh failed:', error.message),
  );
}

const server = app.listen(config.port, async () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  console.log(
    `[server] source=${source.name} interval=${config.ingestIntervalMs}ms` +
      (source.name === 'simulator' ? ` seed=${config.simSeed}` : ''),
  );

  if (!ingestor) {
    console.log('[boot] ingestion disabled (INGEST_ENABLED=false)');
    return;
  }

  /**
   * Backfill before starting the loop, and after listen() rather than before:
   * the page should be reachable while history is being reconstructed, and a
   * failing upstream should delay data, never the server itself.
   */
  try {
    const result = await ingestor.backfill();
    console.log(
      `[boot] backfilled ${result.written} snapshots from ${result.points} probes ` +
        `over ${config.backfillHours}h`,
    );
  } catch (error) {
    console.error('[boot] backfill failed, continuing with live ingestion only:', error.message);
  }

  ingestor.start();
});

/**
 * Shut down in dependency order - stop producing writes, stop accepting
 * requests, then close the database - so nothing is mid-transaction when the
 * file handle goes away.
 */
let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  ingestor?.stop();
  server.close(() => {
    closeDb();
    process.exit(code);
  });

  // Do not hang forever on a lingering keep-alive connection.
  setTimeout(() => process.exit(code), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * A crash still gets an ordered shutdown.
 *
 * Node's default for either of these is to print the error and exit, which is
 * the right instinct - a process whose invariants have just been violated
 * should not keep serving. What it skips is closing the database, so the poll
 * timer and the WAL handle are left to the OS to reap.
 *
 * So these handlers do not rescue anything: they log the fault, run the same
 * dependency-ordered shutdown as a signal, and exit non-zero. Swallowing the
 * error and continuing would be strictly worse than crashing, because every
 * number this app reports would then come from a process known to be in an
 * undefined state.
 */
process.on('uncaughtException', (error) => {
  console.error('[server] uncaught exception:', error);
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
  shutdown('unhandledRejection', 1);
});
