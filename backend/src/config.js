/**
 * All runtime configuration in one place.
 *
 * Every value is env-overridable with a sensible default, so `npm start` works
 * on a clean checkout with no setup. Nothing else in the codebase reads
 * process.env - if you want to know what this app can be tuned with, this file
 * is the complete answer.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Which data source feeds the ingestion loop: 'simulator' | 'yahoo'. */
export const DATA_SOURCE = process.env.DATA_SOURCE ?? 'simulator';

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * The simulator polls far more often than the real source. That asymmetry is
 * deliberate rather than cosmetic: synthetic ticks are free, whereas Yahoo is
 * an unofficial endpoint publishing data that is already 15-20 minutes
 * delayed, so polling it faster than once a minute would add load without
 * adding a single new fact.
 */
const DEFAULT_INTERVAL_MS = DATA_SOURCE === 'simulator' ? 15_000 : 60_000;

export const config = {
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH ?? path.join(REPO_ROOT, 'data', 'watchlist.sqlite'),

  dataSource: DATA_SOURCE,

  /**
   * Same seed, same market. Change this to get a different but equally
   * reproducible synthetic history - useful for demoing a second scenario
   * without touching a line of code.
   */
  simSeed: process.env.SIM_SEED ?? 'groww-code-2026',

  ingestIntervalMs: num(process.env.INGEST_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  ingestEnabled: process.env.INGEST_ENABLED !== 'false',

  /**
   * How much history to reconstruct into the log on boot. The whole point of a
   * "what changed since you last looked" product is having a past to diff
   * against, and on a fresh clone there isn't one - so we ask the source to
   * describe the recent past and record it.
   */
  backfillHours: num(process.env.BACKFILL_HOURS, 6),
  /** Safety cap so a large backfillHours can't stall boot or bloat the log. */
  backfillMaxPoints: num(process.env.BACKFILL_MAX_POINTS, 400),

  /**
   * A snapshot is considered stale once it is older than
   * ingestIntervalMs * this, and the market it belongs to is open. Three
   * intervals tolerates one missed poll plus jitter before crying wolf.
   */
  stalenessIntervals: num(process.env.STALENESS_INTERVALS, 3),

  /**
   * Two sources describing the same instant will never agree to the paisa.
   * Disagreement beyond this percentage is treated as a genuine conflict worth
   * showing the user rather than rounding error worth hiding.
   */
  conflictTolerancePct: num(process.env.CONFLICT_TOLERANCE_PCT, 0.5),
  /** How far apart two observations can be and still describe "the same instant". */
  conflictWindowMs: num(process.env.CONFLICT_WINDOW_MS, 5 * 60_000),

  /**
   * Auth is explicitly out of scope for this phase, so there is exactly one
   * user. Every query is still scoped by user_id, so adding real auth later
   * means populating this from a session instead of a constant - not
   * reshaping the schema.
   */
  devUserId: process.env.DEV_USER_ID ?? 'dev-user',

  /** Seeded into an empty watchlist on first boot so the demo isn't blank. */
  defaultSymbols: (process.env.DEFAULT_SYMBOLS ?? 'RELIANCE,TCS,HDFCBANK,INFY')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
};
