/**
 * The simulator's guarantees, tested as guarantees rather than as behaviour.
 *
 * "Replayable" and "randomly addressable" are load-bearing claims - the demo
 * depends on them and so does every historical delta - so they get golden
 * tests rather than smoke tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Pin the seed before the config module is evaluated, so this file's
// expectations cannot be changed by an env var in someone's shell.
process.env.SIM_SEED = 'groww-code-2026';
process.env.SIM_GAP_PROBABILITY = '0.03';
process.env.SIM_OUTAGE_PROBABILITY = '0.02';

const { simulator, TICK_MS, __testing } = await import('../src/sources/simulator.js');
const { snapshotForTick } = __testing;

/** A fixed instant, so nothing here depends on when the test runs. */
const ANCHOR = Date.UTC(2026, 8, 4, 5, 0, 0); // Fri 2026-09-04 10:30 IST
const ANCHOR_TICK = Math.floor(ANCHOR / TICK_MS);

test('the same seed replays the same sequence, byte for byte', () => {
  const fingerprint = (count) => {
    const hash = createHash('sha256');
    for (let i = 0; i < count; i += 1) {
      const snapshot = snapshotForTick('RELIANCE', ANCHOR_TICK + i);
      hash.update(snapshot ? `${snapshot.timestamp}:${snapshot.price}:${snapshot.volume}` : 'GAP');
      hash.update('|');
    }
    return hash.digest('hex').slice(0, 16);
  };

  // Recomputed within this process...
  assert.equal(fingerprint(500), fingerprint(500));

  /**
   * ...and locked to a literal, which is the part that actually matters. This
   * catches the failure that a self-comparison cannot: a refactor of the noise
   * functions that is still internally consistent but silently produces a
   * different market than the one demoed. If this assertion fails, the
   * simulated history changed - which is either a bug or a deliberate change
   * that needs this constant updated on purpose.
   *
   * UPDATED DELIBERATELY when the market factor landed: symbol returns now
   * decompose into beta * market + idiosyncratic, so every price in the
   * simulated history legitimately changed. The previous value was
   * e85f744cf29c017c.
   */
  assert.equal(fingerprint(500), '123a42e61c8f5f8b');
});

test('getSnapshotAt is stable and quantised to the tick grid', async () => {
  const first = await simulator.getSnapshotAt('TCS', ANCHOR);
  const again = await simulator.getSnapshotAt('TCS', ANCHOR);
  assert.deepEqual(first, again);

  // Any instant inside a tick resolves to that tick's single observation, so
  // two nearby queries cannot produce two contradictory prices.
  const midTick = await simulator.getSnapshotAt('TCS', ANCHOR + TICK_MS - 1);
  assert.deepEqual(midTick, first);

  if (first) assert.equal(first.timestamp % TICK_MS, 0);
});

test('history is addressable without replaying it', async () => {
  // Ten years back is ~21 million ticks. A sequential random walk would have
  // to generate all of them; this must return immediately.
  const longAgo = ANCHOR - 10 * 365 * 24 * 60 * 60 * 1000;
  const startedAt = process.hrtime.bigint();
  const snapshot = await simulator.getSnapshotAt('INFY', longAgo);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.ok(elapsedMs < 50, `expected O(1) access, took ${elapsedMs.toFixed(2)}ms`);
  if (snapshot) assert.ok(snapshot.price > 0);
});

test('symbols are independent of one another', () => {
  const a = snapshotForTick('RELIANCE', ANCHOR_TICK);
  const b = snapshotForTick('TCS', ANCHOR_TICK);
  assert.ok(a && b);
  assert.notEqual(a.price, b.price);

  // An unlisted ticker still gets a stable, plausible identity of its own.
  const custom = snapshotForTick('WIPRO', ANCHOR_TICK);
  assert.deepEqual(custom, snapshotForTick('WIPRO', ANCHOR_TICK));
});

test('prices stay in a believable band and volumes are whole positive numbers', () => {
  let checked = 0;

  for (let i = 0; i < 2000; i += 1) {
    const snapshot = snapshotForTick('RELIANCE', ANCHOR_TICK + i * 40);
    if (!snapshot) continue;
    checked += 1;

    // Base price 1420, swing 0.09 on the trend plus a quarter of that on the
    // chop: the envelope is about +/-11%. A price outside 40% of base would
    // mean the model had come unstuck.
    assert.ok(
      snapshot.price > 1420 * 0.6 && snapshot.price < 1420 * 1.4,
      `implausible price ${snapshot.price}`,
    );
    // Quoted in paise: two decimals, never a float artefact.
    assert.equal(snapshot.price, Math.round(snapshot.price * 100) / 100);
    assert.ok(Number.isInteger(snapshot.volume) && snapshot.volume > 0);
    assert.equal(snapshot.confidence, 1);
    assert.equal(snapshot.source, 'simulator');
  }

  assert.ok(checked > 1500, `too many gaps: only ${checked}/2000 ticks present`);
});

test('the feed has gaps, because a source that never fails proves nothing', () => {
  let gaps = 0;
  for (let i = 0; i < 3000; i += 1) {
    if (!snapshotForTick('SBIN', ANCHOR_TICK + i)) gaps += 1;
  }

  // Roughly 3% dropped ticks plus occasional multi-minute outages. The bounds
  // are loose on purpose - this asserts that failure is exercised at all, not
  // that the rate is exactly some number.
  assert.ok(gaps > 20, `expected the simulator to drop ticks, saw ${gaps}`);
  assert.ok(gaps < 900, `expected mostly-available data, saw ${gaps} gaps`);
});

test('intraday volume follows the real session shape', () => {
  const { intradayVolumeFactor } = __testing;
  const ist = (hour, minute) => Date.UTC(2026, 8, 4, hour - 5, minute - 30);

  const open = intradayVolumeFactor(ist(9, 20));
  const midday = intradayVolumeFactor(ist(12, 30));
  const close = intradayVolumeFactor(ist(15, 25));
  const overnight = intradayVolumeFactor(ist(3, 0));

  assert.ok(open > midday, 'the open should be busier than midday');
  assert.ok(close > midday, 'the close should be busier than midday');
  assert.ok(overnight < midday, 'outside the session should be quietest');
});
