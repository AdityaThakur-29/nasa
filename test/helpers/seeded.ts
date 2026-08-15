/**
 * Deterministic seeded sampler for property-style validation.
 *
 * Replaces a property-testing dependency (fast-check is explicitly rejected).
 * Every failure must be reproducible from the reported seed alone, so the
 * generator is a pure function of its seed with no reliance on Math.random,
 * clock, or iteration order.
 *
 * Algorithm: SplitMix32. Chosen because it is a handful of integer ops, has no
 * dependencies, passes basic distribution smoke checks, and is trivially
 * reimplementable if this file is ever lost. It is NOT cryptographic and must
 * never be used for anything but test sampling.
 */

const UINT32 = 0x1_0000_0000;

export interface Sampler {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Log-uniform in [min, max). Both bounds must be > 0. */
  logRange(min: number, max: number): number;
  /** Random unit-length 3-vector, uniform over the sphere. */
  unitVector(): [number, number, number];
}

export function createSampler(seed: number): Sampler {
  let state = seed >>> 0;

  const nextUint32 = (): number => {
    state = (state + 0x9e37_79b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };

  const next = (): number => nextUint32() / UINT32;

  const range = (min: number, max: number): number => min + next() * (max - min);

  return {
    next,
    range,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('createSampler.pick: empty array');
      // Non-null assertion is safe: index is bounded by the length check above.
      return items[Math.floor(next() * items.length)]!;
    },
    logRange: (min, max) => {
      if (min <= 0 || max <= 0) {
        throw new Error(`createSampler.logRange: bounds must be > 0, got [${min}, ${max}]`);
      }
      return Math.exp(range(Math.log(min), Math.log(max)));
    },
    unitVector: () => {
      // Cosine-free method: sample z uniformly, azimuth uniformly. Uniform on
      // the sphere by Archimedes' theorem.
      const z = range(-1, 1);
      const phi = range(0, 2 * Math.PI);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return [r * Math.cos(phi), r * Math.sin(phi), z];
    },
  };
}

/** Context describing which sample failed, for reproduction. */
export interface SampleContext {
  seed: number;
  sample: number;
  [key: string]: unknown;
}

/**
 * Formats a property failure so the seed and sample index are always visible.
 *
 * Required output shape:
 *
 *   PROPERTY FAILED
 *
 *   seed: 18472931
 *   sample: 417
 *   body: Mars
 *
 *   expected: ...
 *   actual: ...
 */
export function formatPropertyFailure(
  context: SampleContext,
  expected: unknown,
  actual: unknown,
): string {
  const lines = ['PROPERTY FAILED', ''];
  for (const [key, value] of Object.entries(context)) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  lines.push('', `expected: ${formatValue(expected)}`, `actual: ${formatValue(actual)}`);
  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toExponential(17);
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Runs `body` over `count` deterministic samples.
 *
 * `body` receives the sampler and a context pre-populated with seed and sample
 * index; it should attach any extra identifying fields (e.g. body name) to that
 * context before asserting, so failures are self-describing.
 */
export function forEachSample(
  seed: number,
  count: number,
  body: (sampler: Sampler, context: SampleContext) => void,
): void {
  for (let i = 0; i < count; i++) {
    // Re-derive per-sample state from (seed, i) so a single sample can be
    // replayed in isolation without iterating the ones before it.
    const sampler = createSampler((Math.imul(seed, 0x9e37_79b9) + i) >>> 0);
    body(sampler, { seed, sample: i });
  }
}

/** Default seed. Fixed so CI runs are reproducible; override per-test as needed. */
export const DEFAULT_SEED = 0x5eed_1234;
