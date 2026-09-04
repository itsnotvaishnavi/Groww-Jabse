/**
 * `npm run demo` - build the demo database and print the scenario.
 *
 * This is the demo script: run it, read the output, then `npm start` and the
 * page shows exactly what was printed. It writes to its own database file so it
 * cannot trample a running instance's data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, REPO_ROOT } from '../config.js';
import { createDatabase } from '../db.js';
import { createEngine } from '../engine/index.js';
import { createSurfacedStore } from '../engine/surfaced.js';
import { FrozenSource } from '../freshness.js';
import { createSnapshotLog } from '../snapshot-log.js';
import { createSummaryService } from '../summary.js';
import { createWatchlist } from '../watchlist.js';
import { simulator } from '../sources/simulator.js';
import { applyDemoFixture } from './fixture.js';
import {
  applyScenario,
  findCondition,
  findTimeAway,
  scenarioCatalogue,
} from './scenarios.js';

const dbPath = process.env.DB_PATH ?? path.join(REPO_ROOT, 'data', 'watchlist.sqlite');

// A fixture is a known starting state, so it starts from an empty database.
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

const db = createDatabase(dbPath);
const snapshotLog = createSnapshotLog(db);
const watchlist = createWatchlist(db);
const surfacedStore = createSurfacedStore(db);

const now = Date.now();
const userId = config.devUserId;

/**
 * `npm run demo` keeps its existing behaviour - the full fixture - so anything
 * that relied on it is unchanged. `npm run demo -- <condition> [timeAway]`
 * applies a named scenario instead.
 */
const [conditionArg, timeAwayArg] = process.argv.slice(2);

if (conditionArg && !findCondition(conditionArg)) {
  const catalogue = scenarioCatalogue();
  console.error(`\nUnknown scenario "${conditionArg}".\n`);
  console.error('Market conditions:');
  for (const condition of catalogue.conditions) {
    console.error(`  ${condition.id.padEnd(20)} ${condition.description}`);
  }
  console.error(`\nTime away: ${catalogue.timeAway.map((t) => t.id).join(', ')}\n`);
  process.exit(1);
}

if (timeAwayArg && !findTimeAway(timeAwayArg)) {
  const ids = scenarioCatalogue()
    .timeAway.map((t) => t.id)
    .join(', ');
  console.error(`\nUnknown time-away "${timeAwayArg}". Use one of: ${ids}\n`);
  process.exit(1);
}

const applied = conditionArg
  ? applyScenario({
      snapshotLog,
      watchlist,
      userId,
      condition: conditionArg,
      timeAwayId: timeAwayArg ?? '6h',
      now,
    })
  : applyDemoFixture({ snapshotLog, watchlist, userId, now });

/**
 * The fixture's own source: it never closes and has no delay, so freshness
 * reflects only the age of the observations - which the fixture controls.
 */
const fixtureSource = {
  name: FrozenSource.FIXTURE,
  describe: () => ({
    name: FrozenSource.FIXTURE,
    kind: 'synthetic',
    alwaysOpen: true,
    delayMs: 0,
    seed: applied.seed,
    note: 'Deterministic demo scenario. Prices are synthetic except where marked yahoo-observed.',
  }),
  getSymbols: () => simulator.getSymbols(),
  getLatestSnapshot: async () => null,
  getSnapshotAt: async () => null,
};

const engine = createEngine({
  snapshotLog,
  watchlist,
  surfacedStore,
  source: fixtureSource,
  clock: () => now,
});
const summaryService = createSummaryService({ engine, watchlist, surfacedStore, clock: () => now });

const evaluation = engine.evaluate({ userId, now });
const summary = summaryService.build({ userId, now, record: false });

const pad = (s, n) => String(s).padEnd(n);

console.log(
  applied.condition
    ? `\nJabse scenario "${applied.condition}" — ${applied.conditionLabel}, ` +
        `${applied.timeAwayId} away — seed "${applied.seed}"`
    : `\nJabse demo fixture — seed "${applied.seed}"`,
);
if (applied.condition) {
  console.log(`expect: ${findCondition(applied.condition).expect}`);
}
console.log(`${applied.observations} observations across ${applied.symbols.length} symbols`);
console.log(`database: ${dbPath}\n`);

console.log(`  ${pad('SYMBOL', 13)}${pad('LEVEL', 10)}${pad('SCORE', 8)}${pad('CONF', 7)}${pad('CHANGE', 9)}WHY`);
console.log(`  ${'-'.repeat(96)}`);

for (const item of evaluation.items) {
  const change = item.changeSinceViewed.available
    ? `${item.changeSinceViewed.percent > 0 ? '+' : ''}${item.changeSinceViewed.percent}%`
    : '--';
  const why = item.reasonText[0] ?? '(nothing above the reporting threshold)';
  console.log(
    `  ${pad(item.symbol, 13)}${pad(item.level, 10)}${pad(item.meaningfulScore, 8)}${pad(
      item.confidence,
      7,
    )}${pad(change, 9)}${why}`,
  );
  for (const extra of item.reasonText.slice(1)) {
    console.log(`  ${' '.repeat(47)}${extra}`);
  }
  const unavailable = Object.entries(item.features)
    .filter(([, f]) => !f.available)
    .map(([name, f]) => `${name}=${f.reason}`);
  if (unavailable.length > 0) {
    console.log(`  ${' '.repeat(47)}\x1b[2munavailable: ${unavailable.join(', ')}\x1b[0m`);
  }
  if (item.conflict) {
    console.log(
      `  ${' '.repeat(47)}\x1b[33mCONFLICT ${item.conflict.spreadPct}% between ${item.conflict.observations
        .map((o) => `${o.source} ${o.price}`)
        .join(' and ')}\x1b[0m`,
    );
  }
}

console.log(`\n  Summary: ${summary.headline}`);
console.log(
  `  Levels: ${summary.counts.high} HIGH, ${summary.counts.moderate} MODERATE, ${summary.counts.low} LOW`,
);

// Only the full fixture carries the real captured observation.
if (applied.realObservation) {
  console.log(`\n  The real observation in this fixture:`);
  console.log(
    `    ${applied.realObservation.nse.symbol} ${applied.realObservation.nse.price} (NSE) vs ` +
      `${applied.realObservation.bse.symbol} ${applied.realObservation.bse.price} (BSE)`,
  );
  console.log(`    ${applied.realObservation.note.replace(/\s+/g, ' ')}`);
}

console.log(`\n  Now run:  npm start      then open http://localhost:3000`);
console.log(`  Long absence:  http://localhost:3000/api/summary?awayMs=180000000\n`);

db.close();
