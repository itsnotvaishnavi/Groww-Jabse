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
import { BENCHMARK_SYMBOL } from './symbols.js';

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

  /**
   * The market benchmark, ingested for everyone and excluded from watchlists.
   * One internal key; each source maps it to its own wire symbol (`^NSEI` on
   * Yahoo, the shared market series in the simulator).
   */
  benchmarkSymbol: BENCHMARK_SYMBOL,

  /**
   * Sector membership for the demo universe.
   *
   * Static and deliberately small. A real product would take this from an
   * exchange classification feed; inventing a fuller mapping here would be
   * fabricating data, so a symbol absent from this map simply HAS no sector
   * and its sector-relative signal reports unavailable rather than guessing.
   */
  sectorMap: {
    TCS: 'IT',
    INFY: 'IT',
    WIPRO: 'IT',
    HCLTECH: 'IT',
    HDFCBANK: 'BANKING',
    ICICIBANK: 'BANKING',
    SBIN: 'BANKING',
    KOTAKBANK: 'BANKING',
    RELIANCE: 'ENERGY',
    ONGC: 'ENERGY',
    TATAMOTORS: 'AUTO',
    MARUTI: 'AUTO',
    ITC: 'FMCG',
    HINDUNILVR: 'FMCG',
    SUNPHARMA: 'PHARMA',
    CIPLA: 'PHARMA',
  },

  /**
   * A sector return is the mean of its watched peers. One peer is not a
   * sector - it is that stock compared with itself - so two is the floor.
   */
  sectorMinPeers: num(process.env.SECTOR_MIN_PEERS, 2),

  /**
   * THE MEANINGFUL CHANGE ENGINE
   *
   * Every number the score depends on lives here, because "we tuned it until
   * the demo looked good" is not a defensible answer and a hardcoded constant
   * cannot be argued with. Each one is a product decision with a stated
   * reason.
   */
  engine: {
    /**
     * Returns are measured on a fixed bar grid rather than between consecutive
     * raw observations. Raw spacing mixes 15s live ticks, ~54s backfill points
     * and 10-minute blackout gaps into a single standard deviation, which
     * inflates it and thereby suppresses exactly the anomalies we are looking
     * for. One bar length means every return covers the same elapsed time.
     */
    barMs: num(process.env.ENGINE_BAR_MS, 60_000),

    /**
     * How many bars an observation may be carried forward before its bar is
     * treated as missing. Without a cap, a ten-minute outage would produce ten
     * identical bars - a run of fake zero returns that deflates volatility and
     * makes everything afterwards look anomalous.
     */
    carryForwardBars: num(process.env.ENGINE_CARRY_FORWARD_BARS, 2),

    /**
     * The anomaly horizon: the return being judged covers this much time.
     *
     * Deliberately NOT the user's absence window. "Change since you last
     * looked" is already its own feature; the anomaly asks whether the recent
     * move is unusual *for this stock*, which must be a property of the stock
     * rather than of when the user happened to log in - otherwise two users
     * see different z-scores for the same instrument at the same instant, and
     * the surfaced-signal fingerprint stops being comparable.
     */
    anomalyHorizonMs: num(process.env.ENGINE_ANOMALY_HORIZON_MS, 15 * 60_000),

    /** How much history the rolling mean and standard deviation see. */
    statsWindowMs: num(process.env.ENGINE_STATS_WINDOW_MS, 6 * 60 * 60_000),

    /**
     * Below this many usable returns an anomaly feature is unavailable. A
     * z-score from three data points is not a signal, it is a coincidence
     * wearing a decimal point.
     */
    minReturns: num(process.env.ENGINE_MIN_RETURNS, 20),
    /** Full confidence in the statistics is only reached at this many. */
    fullConfidenceReturns: num(process.env.ENGINE_FULL_CONFIDENCE_RETURNS, 60),

    /**
     * Standard-deviation floor, as a fraction. A stock that has not moved all
     * session has a near-zero sd, and dividing by it would turn a one-paisa
     * tick into an infinite z-score. The floor is applied and confidence is
     * reduced, rather than emitting a number nobody should believe.
     */
    minStdDev: Number(process.env.ENGINE_MIN_STDDEV ?? 0.0004),

    /** Z-scores are clamped here so a single bad tick cannot dominate. */
    zClamp: num(process.env.ENGINE_Z_CLAMP, 6),

    /**
     * Reference points at which a signal contributes its full weight. These
     * are the "how unusual is unusual" product decisions.
     */
    zFullContribution: num(process.env.ENGINE_Z_FULL, 3),
    volumeRatioFullContribution: num(process.env.ENGINE_VOLUME_FULL, 3),
    relativeMoveFullContributionPct: Number(process.env.ENGINE_RELATIVE_FULL_PCT ?? 1.5),

    /**
     * Signal weights. They sum to 1.0 over all four signals, and the score is
     * renormalised over whichever are actually available - a missing signal
     * must never be silently scored as a zero contribution, because "we could
     * not tell" and "there was nothing there" are different facts.
     */
    weights: {
      priceAnomaly: Number(process.env.ENGINE_W_PRICE ?? 0.35),
      volumeAnomaly: Number(process.env.ENGINE_W_VOLUME ?? 0.25),
      marketRelative: Number(process.env.ENGINE_W_MARKET ?? 0.2),
      sectorRelative: Number(process.env.ENGINE_W_SECTOR ?? 0.2),
    },

    /**
     * Level thresholds, absolute rather than percentile-ranked within the
     * watchlist. Percentile ranking would mean a stock's level changes because
     * the user added an unrelated stock, which makes the label meaningless and
     * the surfaced-state fingerprint unstable.
     */
    levels: {
      moderate: Number(process.env.ENGINE_LEVEL_MODERATE ?? 0.4),
      high: Number(process.env.ENGINE_LEVEL_HIGH ?? 0.7),
    },

    /**
     * Beyond this much time away, the summary aggregates rather than
     * enumerating: after two days nobody wants a list of every tick.
     */
    longAbsenceMs: num(process.env.ENGINE_LONG_ABSENCE_MS, 24 * 60 * 60_000),

    /** How many signals the "since you were away" summary presents at once. */
    summaryTopN: num(process.env.ENGINE_SUMMARY_TOP_N, 5),

    /**
     * Floors below which a signal contributes to the score but earns NO
     * written reason.
     *
     * This is the evidence rule made numeric. A 0.1-sigma move is not
     * "unusually large for this stock", and a ratio of 1.02 is not "high
     * volume" - stating either would be the system overselling what it
     * measured, which is the fastest way to lose a user's trust in every other
     * line it prints. The contribution is still counted; only the claim is
     * withheld.
     */
    reasonMinZ: Number(process.env.ENGINE_REASON_MIN_Z ?? 1),
    reasonMinVolumeRatio: Number(process.env.ENGINE_REASON_MIN_VOLUME ?? 1.5),
    reasonMinRelativePct: Number(process.env.ENGINE_REASON_MIN_RELATIVE_PCT ?? 0.4),
    /** Below this, "moved in line with the market" is the honest description. */
    reasonInlineWithMarketPct: Number(process.env.ENGINE_REASON_INLINE_PCT ?? 0.4),
  },
};
