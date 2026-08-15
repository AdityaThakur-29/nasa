/**
 * Simulation clock. Canonical time is a split Julian Date, independent of
 * wall-clock time.
 *
 * SCALE OWNERSHIP: the clock stores UTC, because that is the scale the user
 * reads, enters and scrubs. Ephemeris models are handed TT via nowTT(), which
 * is type-branded so a UTC value cannot reach a TT-only model by accident.
 * The conversion applies deltaT and is therefore approximate; its provenance
 * travels with the snapshot rather than being hidden.
 *
 * RATE AND DIRECTION are separate: rate is an unsigned magnitude matching the
 * speed presets, direction is +1 or -1. A UI speed selector and a reverse
 * toggle then map one-to-one onto the model instead of having to encode
 * direction in the sign of a magnitude.
 *
 * NO EVENT EMISSION: the clock is polled once per frame by the simulation
 * layer. It never calls into rendering or interface code, so the one-way data
 * flow holds. Interface interaction arrives only through the command methods
 * below.
 */

import {
  SECONDS_PER_DAY,
  type CalendarDate,
  type JulianDate,
  addSeconds,
  calendarToJD,
  compareJD,
  type DeltaTResult,
  deltaTWithProvenance,
  differenceDays,
  differenceSeconds,
  formatJD,
  fractionalYear,
  jdToCalendar,
  ttFromUtc,
  utc,
} from './jd';

/**
 * Speed presets, in simulated seconds per real second.
 *
 * Taken from the required control set. `rate` is not restricted to these
 * values; they exist so the interface can offer fixed steps alongside a custom
 * entry.
 */
export const TIME_RATE_PRESETS = [1, 10, 100, 1_000, 10_000, 100_000] as const;

/** Largest rate the presets expose. Custom rates may exceed it; see setRate. */
export const MAX_PRESET_RATE = 100_000;

/**
 * Hard ceiling on rate magnitude.
 *
 * At 1e9 a 60 Hz frame advances simulated time by about 190 days, which steps
 * clean over an entire Mercury orbit between frames. Motion would still be
 * numerically correct, since positions come from an analytic model rather than
 * integration, but nothing on screen would be interpretable and orbit-trail
 * sampling would alias badly. The limit is a usability bound, not a physical
 * one, and is documented as such.
 */
export const MAX_RATE = 1e9;

/**
 * Longest real-time step honoured in one advance() call, in seconds.
 *
 * A backgrounded tab stalls requestAnimationFrame, so the first frame after
 * refocus can report a delta of many seconds. Multiplied by a high rate that
 * becomes an unintended jump of centuries. Clamping trades exact real-time
 * fidelity during a stall for continuity of simulated time, which is the
 * behaviour a visualisation wants.
 */
export const MAX_REAL_STEP_SECONDS = 0.25;

/** Direction of time flow. */
export type TimeDirection = 1 | -1;

/** Inclusive bounds the clock will not advance or scrub beyond. */
export interface TimeRange {
  readonly start: JulianDate<'UTC'>;
  readonly end: JulianDate<'UTC'>;
}

export interface SimulationClockOptions {
  /**
   * Starting instant.
   *
   * Defaults to 2000-01-01 12:00:00 UTC. That is deliberately NOT called
   * J2000.0: the standard epoch is defined as JD 2451545.0 TT, which falls
   * about 64 s earlier in UTC. The default is a convenient round civil date
   * near the epoch, not the epoch itself.
   */
  readonly epoch?: JulianDate<'UTC'>;
  /**
   * Scrub and advance bounds.
   *
   * Defaults to 1800-01-01 .. 2050-01-01, the validity window of the JPL
   * approximate planetary elements. The clock does not import provider
   * metadata to discover this; the simulation layer is expected to pass the
   * active provider's range so the boundary stays one-way.
   */
  readonly range?: TimeRange;
  /** Initial rate magnitude in simulated seconds per real second. */
  readonly rate?: number;
  /** Initial direction. */
  readonly direction?: TimeDirection;
  /** Whether the clock starts paused. */
  readonly paused?: boolean;
}

/**
 * Readonly view of clock state for the interface layer.
 *
 * Carries formatted strings and provenance so the interface never has to
 * import time-scale machinery or decide how to label an approximation.
 */
export interface ClockSnapshot {
  readonly utc: JulianDate<'UTC'>;
  readonly tt: JulianDate<'TT'>;
  readonly formattedUtc: string;
  readonly rate: number;
  readonly direction: TimeDirection;
  readonly paused: boolean;
  /** True when the clock is sitting on a range bound and cannot advance further. */
  readonly clampedAtBound: boolean;
  /** Position within the scrub range, 0 at start and 1 at end. */
  readonly scrubFraction: number;
  readonly range: TimeRange;
  /** deltaT value and provenance for the current instant. */
  readonly deltaT: DeltaTResult;
  /** Scale the ephemeris is being evaluated in. Constant, present for display. */
  readonly ephemerisTimeScale: 'TT';
}

/** Default range: validity window of the JPL approximate planetary elements. */
function defaultRange(): TimeRange {
  return { start: utc(1800, 1, 1), end: utc(2050, 1, 1) };
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`SimulationClock: ${label} must be finite, got ${value}`);
  }
}

export class SimulationClock {
  private current: JulianDate<'UTC'>;
  private readonly epoch: JulianDate<'UTC'>;
  private range: TimeRange;
  private rateMagnitude: number;
  private flow: TimeDirection;
  private stopped: boolean;
  private clamped = false;

  /**
   * Cached TT conversion. Recomputed only when the UTC instant changes, since
   * the conversion runs jdToCalendar and a polynomial evaluation that would
   * otherwise repeat every frame for an unchanged paused clock.
   */
  private ttCache: {
    keyInt: number;
    keyFrac: number;
    value: JulianDate<'TT'>;
  } | null = null;
  private deltaTCache: { keyInt: number; value: DeltaTResult } | null = null;

  constructor(options: SimulationClockOptions = {}) {
    this.epoch = options.epoch ?? utc(2000, 1, 1, 12, 0, 0);
    this.range = options.range ?? defaultRange();

    if (compareJD(this.range.start, this.range.end) >= 0) {
      throw new Error('SimulationClock: range start must precede range end');
    }

    const requestedRate = options.rate ?? 1;
    assertFinite(requestedRate, 'rate');
    if (requestedRate < 0) {
      throw new Error(
        `SimulationClock: rate must be non-negative; use direction for reverse flow (got ${requestedRate})`,
      );
    }
    // Clamped here as well as in setRate. Applying the ceiling in only one of
    // the two entry points would let a constructor argument bypass a limit that
    // a later setter enforces.
    this.rateMagnitude = Math.min(requestedRate, MAX_RATE);

    this.flow = options.direction ?? 1;
    this.stopped = options.paused ?? true;
    this.current = this.clampToRange(this.epoch);
  }

  // ---------------------------------------------------------------- queries

  /** Current instant in UTC. */
  nowUtc(): JulianDate<'UTC'> {
    return this.current;
  }

  /**
   * Current instant in TT, the scale the ephemeris models require.
   *
   * Approximate: the UTC-to-TT step applies deltaT, which is a fit rather than
   * a measurement. See jd.ts for the error budget.
   */
  nowTT(): JulianDate<'TT'> {
    // The cache key compares BOTH split fields. Summing them into a single
    // number to form the key would discard precision at exactly the magnitude
    // the split representation exists to preserve, so two instants a
    // microsecond apart could collide and return a stale conversion.
    const { jdInt, jdFrac } = this.current;
    if (
      this.ttCache !== null &&
      this.ttCache.keyInt === jdInt &&
      this.ttCache.keyFrac === jdFrac
    ) {
      return this.ttCache.value;
    }
    const value = ttFromUtc(this.current);
    this.ttCache = { keyInt: jdInt, keyFrac: jdFrac, value };
    return value;
  }

  get rate(): number {
    return this.rateMagnitude;
  }

  get direction(): TimeDirection {
    return this.flow;
  }

  get paused(): boolean {
    return this.stopped;
  }

  /** True when advance() is being blocked by a range bound. */
  get atBound(): boolean {
    return this.clamped;
  }

  /**
   * Signed rate in simulated seconds per real second. Zero while paused, so
   * consumers can use this single value instead of branching on paused state.
   */
  get effectiveRate(): number {
    return this.stopped ? 0 : this.rateMagnitude * this.flow;
  }

  getRange(): TimeRange {
    return this.range;
  }

  // --------------------------------------------------------------- commands

  play(): void {
    this.stopped = false;
  }

  pause(): void {
    this.stopped = true;
  }

  /** Flips between playing and paused. */
  togglePaused(): void {
    this.stopped = !this.stopped;
  }

  /**
   * Sets the rate magnitude.
   *
   * Rejects negative values: direction is a separate axis, and accepting a
   * signed rate here would give two competing representations of reverse flow.
   */
  setRate(rate: number): void {
    assertFinite(rate, 'rate');
    if (rate < 0) {
      throw new Error(
        `SimulationClock.setRate: rate must be non-negative; use setDirection(-1) for reverse flow (got ${rate})`,
      );
    }
    this.rateMagnitude = Math.min(rate, MAX_RATE);
  }

  setDirection(direction: TimeDirection): void {
    this.flow = direction;
  }

  /** Reverses the direction of time flow, leaving rate and paused state alone. */
  reverse(): void {
    this.flow = this.flow === 1 ? -1 : 1;
  }

  /** Steps to the next higher preset rate, if one exists. */
  increaseRate(): void {
    const next = TIME_RATE_PRESETS.find((preset) => preset > this.rateMagnitude);
    if (next !== undefined) this.rateMagnitude = next;
  }

  /** Steps to the next lower preset rate, if one exists. */
  decreaseRate(): void {
    const lower = [...TIME_RATE_PRESETS].reverse().find((preset) => preset < this.rateMagnitude);
    if (lower !== undefined) this.rateMagnitude = lower;
  }

  /**
   * Advances simulated time by one real-time step.
   *
   * @param realDeltaSeconds elapsed wall-clock seconds since the previous frame
   * @returns simulated seconds actually applied, after clamping
   */
  advance(realDeltaSeconds: number): number {
    assertFinite(realDeltaSeconds, 'realDeltaSeconds');
    if (this.stopped || this.rateMagnitude === 0) {
      this.clamped = false;
      return 0;
    }

    // Negative real deltas indicate a clock anomaly upstream, not reverse time.
    // Reverse time is expressed by direction, so ignore them rather than
    // silently stepping backwards.
    const realStep = Math.min(Math.max(realDeltaSeconds, 0), MAX_REAL_STEP_SECONDS);
    const requested = realStep * this.rateMagnitude * this.flow;

    const target = addSeconds(this.current, requested);
    const clampedTarget = this.clampToRange(target);
    const applied = differenceSeconds(clampedTarget, this.current);

    // Compared with a relative tolerance rather than exactly. The round trip
    // through addSeconds and differenceSeconds carries floating-point noise, so
    // an exact `applied < requested` test would raise a false clamp signal on a
    // step that was in fact applied in full.
    const shortfall = Math.abs(requested) - Math.abs(applied);
    this.clamped = shortfall > Math.abs(requested) * 1e-6;

    this.current = clampedTarget;
    return applied;
  }

  /** Jumps to an explicit instant, clamped to the range. */
  jumpTo(jd: JulianDate<'UTC'>): void {
    this.current = this.clampToRange(jd);
    this.clamped = false;
  }

  /** Jumps to a calendar date, interpreted as UTC. */
  jumpToCalendar(date: CalendarDate): void {
    this.jumpTo(calendarToJD(date, 'UTC'));
  }

  /** Returns to the configured epoch. Rate, direction and paused state persist. */
  reset(): void {
    this.current = this.clampToRange(this.epoch);
    this.clamped = false;
  }

  /**
   * Replaces the scrub and advance bounds, re-clamping the current instant.
   *
   * Intended for the simulation layer to apply the active ephemeris provider's
   * validity window.
   */
  setRange(range: TimeRange): void {
    if (compareJD(range.start, range.end) >= 0) {
      throw new Error('SimulationClock.setRange: range start must precede range end');
    }
    this.range = range;
    this.current = this.clampToRange(this.current);
  }

  // --------------------------------------------------------------- scrubbing

  /**
   * Position within the range as a fraction, 0 at start and 1 at end.
   *
   * Linear in days, which is what a uniform timeline expects.
   */
  getScrubFraction(): number {
    const span = differenceDays(this.range.end, this.range.start);
    if (span <= 0) return 0;
    const offset = differenceDays(this.current, this.range.start);
    return Math.min(Math.max(offset / span, 0), 1);
  }

  /** Jumps to a fractional position within the range. Input is clamped to [0,1]. */
  scrubToFraction(fraction: number): void {
    assertFinite(fraction, 'fraction');
    const clamped = Math.min(Math.max(fraction, 0), 1);
    const span = differenceDays(this.range.end, this.range.start);
    this.current = this.clampToRange(
      addSeconds(this.range.start, clamped * span * SECONDS_PER_DAY),
    );
    this.clamped = false;
  }

  // --------------------------------------------------------------- snapshot

  /**
   * Immutable view for the interface layer.
   *
   * Allocates a new object per call. Intended to be taken once per frame, not
   * per interface element.
   */
  snapshot(): ClockSnapshot {
    return {
      utc: this.current,
      tt: this.nowTT(),
      formattedUtc: formatJD(this.current),
      rate: this.rateMagnitude,
      direction: this.flow,
      paused: this.stopped,
      clampedAtBound: this.clamped,
      scrubFraction: this.getScrubFraction(),
      range: this.range,
      deltaT: this.currentDeltaT(),
      ephemerisTimeScale: 'TT',
    };
  }

  // ---------------------------------------------------------------- internal

  private currentDeltaT(): DeltaTResult {
    // Keyed on the integer day alone, unlike the TT cache. deltaT is a function
    // of fractional YEAR, so it cannot change measurably within a single day;
    // day resolution is already far finer than the model's own uncertainty.
    const keyInt = this.current.jdInt;
    if (this.deltaTCache !== null && this.deltaTCache.keyInt === keyInt) {
      return this.deltaTCache.value;
    }
    const value = deltaTWithProvenance(fractionalYear(jdToCalendar(this.current)));
    this.deltaTCache = { keyInt, value };
    return value;
  }

  private clampToRange(jd: JulianDate<'UTC'>): JulianDate<'UTC'> {
    if (compareJD(jd, this.range.start) < 0) return this.range.start;
    if (compareJD(jd, this.range.end) > 0) return this.range.end;
    return jd;
  }
}
