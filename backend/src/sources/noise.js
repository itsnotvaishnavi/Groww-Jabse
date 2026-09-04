/**
 * Deterministic, stateless pseudo-randomness.
 *
 * WHY THIS EXISTS, AND WHY IT ISN'T A NORMAL RANDOM WALK
 *
 * The obvious way to synthesise a price series is a seeded PRNG driving a
 * random walk: price[i] = price[i-1] + noise(). It is easy to write and it is
 * genuinely replayable. But it is *sequential* - to learn the price at tick
 * 40,000 you must generate the 39,999 ticks before it. That makes
 * `getSnapshotAt(symbol, someTimestamp)` either slow or a lie (a lie being:
 * "I can only answer for instants I happen to have already walked past").
 *
 * So instead every quantity here is a pure function of (seed, symbol, tick):
 * hash the inputs, interpolate smoothly between hashed lattice points, and sum
 * a few octaves of that. The result is a fractal curve that looks like a price
 * chart, is bit-identical for a given seed, and is O(1) addressable at any
 * point in time - past, present, or future. No state, no warm-up, no replay.
 *
 * Everything below is integer-only 32-bit mixing, so it behaves identically on
 * every platform and never drifts with floating-point accumulation.
 */

/** FNV-1a over a string. Turns a human-readable seed or symbol into a uint32. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Avalanche mix of a hash with an integer (murmur3's finalizer). Adjacent
 * inputs produce completely unrelated outputs, which is what stops the
 * interpolated noise from showing visible periodic structure.
 */
export function mix32(hash, n) {
  let h = (hash ^ (n | 0)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic float in [0, 1) for a given (hash, index) pair. */
export function hashUnit(hash, n) {
  return mix32(hash, n) / 4294967296;
}

/** Derive an independent channel from a base hash, so volume noise and price
 *  noise never correlate by accident. */
export function channel(hash, name) {
  return mix32(hash, fnv1a(name));
}

/**
 * Quintic smoothstep. Cubic would be enough to look continuous, but its second
 * derivative jumps at every lattice point, which shows up on a chart as a
 * faint regular kink. Quintic is C2, so the curve reads as organic.
 */
function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smoothly interpolated value noise in [0, 1). Handles negative x, so
 *  timestamps before the epoch anchor are just as addressable as after it. */
export function valueNoise(hash, x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashUnit(hash, i);
  const b = hashUnit(hash, i + 1);
  return a + (b - a) * smootherstep(f);
}

/**
 * Fractional Brownian motion: octaves of value noise at doubling frequency and
 * halving amplitude. The low octaves give a symbol its multi-day trend, the
 * high octaves give it minute-to-minute chop. Returns roughly [-1, 1].
 */
export function fbm(hash, x, octaves = 5) {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;

  for (let o = 0; o < octaves; o += 1) {
    const octaveHash = mix32(hash, o * 0x9e3779b9);
    sum += amplitude * (valueNoise(octaveHash, x * frequency) * 2 - 1);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return sum / norm;
}

/**
 * Standard normal via Box-Muller, from two independent hash channels. Used for
 * volume, which is log-normally distributed in real markets - a long right
 * tail of heavy days, never negative.
 */
export function gaussian(hash, n) {
  // Guard u1 away from 0: log(0) is -Infinity.
  const u1 = Math.max(hashUnit(hash, n * 2), 1e-9);
  const u2 = hashUnit(hash, n * 2 + 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Deterministic coin flip that is true with the given probability. */
export function bernoulli(hash, n, probability) {
  return hashUnit(hash, n) < probability;
}
