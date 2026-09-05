/**
 * The DataSource interface, and the one-line switch between implementations.
 *
 * THE INTERFACE
 *   describe()                        -> static facts about the source
 *   getSymbols()                      -> [{ symbol, name }] for UI suggestions
 *   searchSymbols(query)              -> [{ symbol, name, exchange }] discovery
 *   getLatestSnapshot(symbol)         -> Snapshot | null
 *   getSnapshotAt(symbol, timestamp)  -> Snapshot | null
 *
 *   Snapshot = { symbol, timestamp, price, volume, source, confidence }
 *
 * WHY getSnapshotAt LIVES HERE
 * It would have been defensible to keep only getLatestSnapshot on the source
 * and answer every historical question from the snapshot log, on the grounds
 * that a log can only know what it observed. The interface carries both
 * because both sources can genuinely answer "what was the price at time T":
 * the simulator evaluates its noise field at T in O(1), and Yahoo serves
 * historical candles. Refusing to ask would mean a fresh clone has no past to
 * diff against, which is precisely the product's core feature.
 *
 * The two are not redundant, and the distinction matters:
 *   - source.getSnapshotAt(T) is what the market *was*, reconstructed on demand.
 *   - log.snapshotAsOf(T)     is what this app *observed*, and is what user
 *                             baselines are computed from - because the user's
 *                             "since I last looked" must diff against what
 *                             they could actually have seen.
 *
 * A source method that cannot answer returns null (a real absence, e.g. a
 * dropped tick) or throws (a real failure, e.g. the network). Callers must
 * treat those differently, and ../ingest.js does.
 */
import { config } from '../config.js';
import { simulator } from './simulator.js';
import { yahoo } from './yahoo.js';

const SOURCES = {
  simulator,
  yahoo,
};

export function getSource(name = config.dataSource) {
  const source = SOURCES[name];
  if (!source) {
    throw new Error(
      `Unknown DATA_SOURCE "${name}". Available: ${Object.keys(SOURCES).join(', ')}`,
    );
  }
  return source;
}

export { simulator, yahoo };
