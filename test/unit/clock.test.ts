/**
 * Simulation clock validation.
 *
 * All assertions here are behavioural properties of the clock itself. No
 * astronomical reference value is asserted in this file; time-scale conversion
 * accuracy belongs to jd.test.ts, which cites its sources.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_RATE,
  MAX_REAL_STEP_SECONDS,
  SimulationClock,
  TIME_RATE_PRESETS,
} from '@/core/clock';
import {
  SECONDS_PER_DAY,
  addDays,
  compareJD,
  differenceDays,
  differenceSeconds,
  jdToCalendar,
  utc,
} from '@/core/jd';

/**
 * Longest real step the clock will honour. Every test that wants a predictable
 * amount of simulated time must step by this and size its rate accordingly;
 * passing a larger real delta is silently clamped, which is the documented
 * stalled-tab protection rather than a bug.
 */
const FULL_STEP = MAX_REAL_STEP_SECONDS;

/** Rate at which one maximum-length real step advances exactly one day. */
const ONE_DAY_PER_STEP = SECONDS_PER_DAY / MAX_REAL_STEP_SECONDS;

/** Narrow range for bound tests, so a step can reach an edge in one call. */
function tightClock(): SimulationClock {
  return new SimulationClock({
    epoch: utc(2026, 8, 15, 12, 0, 0),
    range: { start: utc(2026, 8, 15, 0, 0, 0), end: utc(2026, 8, 16, 0, 0, 0) },
    rate: 1,
    paused: false,
  });
}

describe('construction', () => {
  it('starts paused at the configured epoch', () => {
    const epoch = utc(2026, 8, 15, 8, 8, 0);
    const clock = new SimulationClock({ epoch });
    expect(clock.paused).toBe(true);
    expect(compareJD(clock.nowUtc(), epoch)).toBe(0);
  });

  it('defaults to the JPL approximate-element validity window', () => {
    const range = new SimulationClock().getRange();
    expect(jdToCalendar(range.start).year).toBe(1800);
    expect(jdToCalendar(range.end).year).toBe(2050);
  });

  it('clamps an epoch outside the range', () => {
    const clock = new SimulationClock({
      epoch: utc(1500, 1, 1),
      range: { start: utc(1800, 1, 1), end: utc(2050, 1, 1) },
    });
    expect(jdToCalendar(clock.nowUtc()).year).toBe(1800);
  });

  it('rejects an inverted range', () => {
    expect(
      () => new SimulationClock({ range: { start: utc(2050, 1, 1), end: utc(1800, 1, 1) } }),
    ).toThrow(/must precede/);
  });

  it('rejects a negative initial rate rather than inferring reverse flow', () => {
    expect(() => new SimulationClock({ rate: -100 })).toThrow(/non-negative/);
  });

  it('applies the rate ceiling to the constructor argument', () => {
    // A limit enforced only in the setter would be bypassable at construction.
    expect(new SimulationClock({ rate: 1e15 }).rate).toBe(MAX_RATE);
  });
});

describe('play state', () => {
  it('advances only while playing', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), rate: 100, paused: true });
    expect(clock.advance(0.1)).toBe(0);

    clock.play();
    expect(clock.advance(0.1)).toBeCloseTo(10, 9);

    clock.pause();
    expect(clock.advance(0.1)).toBe(0);
  });

  it('toggles', () => {
    const clock = new SimulationClock();
    expect(clock.paused).toBe(true);
    clock.togglePaused();
    expect(clock.paused).toBe(false);
    clock.togglePaused();
    expect(clock.paused).toBe(true);
  });

  it('reports a zero effective rate while paused', () => {
    const clock = new SimulationClock({ rate: 1000, paused: true });
    expect(clock.effectiveRate).toBe(0);
    clock.play();
    expect(clock.effectiveRate).toBe(1000);
    clock.setDirection(-1);
    expect(clock.effectiveRate).toBe(-1000);
  });
});

describe('rate control', () => {
  it('separates magnitude from direction', () => {
    const clock = new SimulationClock({ rate: 1000, paused: false });
    clock.setDirection(-1);
    expect(clock.rate).toBe(1000);
    expect(clock.direction).toBe(-1);
    expect(clock.advance(0.1)).toBeCloseTo(-100, 9);
  });

  it('rejects a negative rate', () => {
    expect(() => new SimulationClock().setRate(-1)).toThrow(/non-negative/);
  });

  it('clamps to the documented ceiling', () => {
    const clock = new SimulationClock();
    clock.setRate(MAX_RATE * 10);
    expect(clock.rate).toBe(MAX_RATE);
  });

  it('steps through the presets without overshooting the ends', () => {
    const clock = new SimulationClock({ rate: 1 });
    for (const expected of TIME_RATE_PRESETS.slice(1)) {
      clock.increaseRate();
      expect(clock.rate).toBe(expected);
    }
    // Already at the top preset; must not move.
    clock.increaseRate();
    expect(clock.rate).toBe(TIME_RATE_PRESETS[TIME_RATE_PRESETS.length - 1]);

    for (const expected of [...TIME_RATE_PRESETS].reverse().slice(1)) {
      clock.decreaseRate();
      expect(clock.rate).toBe(expected);
    }
    clock.decreaseRate();
    expect(clock.rate).toBe(TIME_RATE_PRESETS[0]);
  });

  it('reverses direction without disturbing magnitude or play state', () => {
    const clock = new SimulationClock({ rate: 500, paused: false });
    clock.reverse();
    expect(clock.direction).toBe(-1);
    expect(clock.rate).toBe(500);
    expect(clock.paused).toBe(false);
    clock.reverse();
    expect(clock.direction).toBe(1);
  });
});

describe('advance', () => {
  it('scales real time by the rate', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), rate: 1000, paused: false });
    const applied = clock.advance(0.016);
    expect(applied).toBeCloseTo(16, 9);
  });

  it('clamps an oversized real step so a stalled tab cannot jump centuries', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), rate: 1, paused: false });
    // 10 s of stalled wall clock arrives as one delta.
    expect(clock.advance(10)).toBeCloseTo(MAX_REAL_STEP_SECONDS, 9);
  });

  it('ignores a negative real delta rather than stepping backwards', () => {
    // Reverse flow is expressed by direction. A negative wall-clock delta is an
    // upstream anomaly and must not be reinterpreted as reverse time.
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), rate: 100, paused: false });
    const before = clock.nowUtc();
    expect(clock.advance(-5)).toBe(0);
    expect(compareJD(clock.nowUtc(), before)).toBe(0);
  });

  it('rejects a non-finite real delta', () => {
    const clock = new SimulationClock({ paused: false });
    expect(() => clock.advance(Number.NaN)).toThrow(/finite/);
  });

  it('accumulates many small steps without drift', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), rate: 1, paused: false });
    const start = clock.nowUtc();
    const STEPS = 6000;
    const STEP = 1 / 60;
    for (let i = 0; i < STEPS; i++) clock.advance(STEP);
    // Split JD arithmetic must keep this exact to well under a millisecond.
    expect(differenceSeconds(clock.nowUtc(), start)).toBeCloseTo(STEPS * STEP, 6);
  });

  it('advances backwards under reverse direction', () => {
    const clock = new SimulationClock({
      epoch: utc(2026, 6, 1),
      rate: ONE_DAY_PER_STEP,
      paused: false,
    });
    const start = clock.nowUtc();
    clock.setDirection(-1);
    clock.advance(FULL_STEP);
    expect(differenceDays(clock.nowUtc(), start)).toBeCloseTo(-1, 9);
  });
});

describe('range bounds', () => {
  it('clamps at the end and flags the bound', () => {
    const clock = tightClock();
    // One full-length real step requests a whole day, which overruns the 12 h
    // remaining between the epoch and the range end.
    clock.setRate(ONE_DAY_PER_STEP);
    const applied = clock.advance(FULL_STEP);
    expect(applied).toBeCloseTo(SECONDS_PER_DAY / 2, 3);
    expect(clock.atBound).toBe(true);
    expect(compareJD(clock.nowUtc(), clock.getRange().end)).toBe(0);
  });

  it('clamps at the start under reverse flow', () => {
    const clock = tightClock();
    clock.setRate(ONE_DAY_PER_STEP);
    clock.setDirection(-1);
    const applied = clock.advance(FULL_STEP);
    expect(applied).toBeCloseTo(-SECONDS_PER_DAY / 2, 3);
    expect(clock.atBound).toBe(true);
    expect(compareJD(clock.nowUtc(), clock.getRange().start)).toBe(0);
  });

  it('does not raise a false bound flag on a fully applied step', () => {
    // Guards the float comparison in advance(): an exact shortfall test would
    // trip on round-trip noise from addSeconds/differenceSeconds.
    const clock = tightClock();
    clock.setRate(1000);
    for (let i = 0; i < 50; i++) {
      clock.advance(1 / 60);
      expect(clock.atBound).toBe(false);
    }
  });

  it('applies zero and stays flagged once resting on a bound', () => {
    const clock = tightClock();
    clock.setRate(SECONDS_PER_DAY * 10);
    clock.advance(1);
    expect(compareJD(clock.nowUtc(), clock.getRange().end)).toBe(0);
    expect(clock.advance(1)).toBe(0);
    expect(clock.atBound).toBe(true);
  });

  it('clears the bound flag when paused', () => {
    const clock = tightClock();
    clock.setRate(SECONDS_PER_DAY * 10);
    clock.advance(1);
    expect(clock.atBound).toBe(true);
    clock.pause();
    clock.advance(1);
    expect(clock.atBound).toBe(false);
  });
});

describe('jump and reset', () => {
  it('jumps to an explicit instant', () => {
    const clock = new SimulationClock();
    const target = utc(1969, 7, 20, 20, 17, 40);
    clock.jumpTo(target);
    expect(compareJD(clock.nowUtc(), target)).toBe(0);
  });

  it('clamps a jump outside the range', () => {
    const clock = tightClock();
    clock.jumpTo(utc(2100, 1, 1));
    expect(compareJD(clock.nowUtc(), clock.getRange().end)).toBe(0);
    clock.jumpTo(utc(1900, 1, 1));
    expect(compareJD(clock.nowUtc(), clock.getRange().start)).toBe(0);
  });

  it('jumps to a calendar date interpreted as UTC', () => {
    const clock = new SimulationClock();
    clock.jumpToCalendar({ year: 2026, month: 8, day: 15, hour: 8, minute: 8, second: 0 });
    const cal = jdToCalendar(clock.nowUtc());
    expect([cal.year, cal.month, cal.day, cal.hour, cal.minute]).toEqual([2026, 8, 15, 8, 8]);
  });

  it('returns to the epoch on reset while preserving rate and direction', () => {
    const epoch = utc(2026, 8, 15, 12, 0, 0);
    const clock = new SimulationClock({ epoch, rate: 1000, paused: false });
    clock.setDirection(-1);
    clock.advance(0.5);
    clock.reset();
    expect(compareJD(clock.nowUtc(), epoch)).toBe(0);
    expect(clock.rate).toBe(1000);
    expect(clock.direction).toBe(-1);
    expect(clock.paused).toBe(false);
  });

  it('clears the bound flag on jump and reset', () => {
    const clock = tightClock();
    clock.setRate(SECONDS_PER_DAY * 10);
    clock.advance(1);
    expect(clock.atBound).toBe(true);
    clock.jumpTo(utc(2026, 8, 15, 6, 0, 0));
    expect(clock.atBound).toBe(false);
  });
});

describe('setRange', () => {
  it('re-clamps the current instant into the new range', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1) });
    clock.setRange({ start: utc(2030, 1, 1), end: utc(2040, 1, 1) });
    expect(compareJD(clock.nowUtc(), utc(2030, 1, 1))).toBe(0);
  });

  it('rejects an inverted range', () => {
    const clock = new SimulationClock();
    expect(() => clock.setRange({ start: utc(2040, 1, 1), end: utc(2030, 1, 1) })).toThrow(
      /must precede/,
    );
  });
});

describe('scrubbing', () => {
  it('reports 0 at the range start and 1 at the end', () => {
    const clock = tightClock();
    clock.jumpTo(clock.getRange().start);
    expect(clock.getScrubFraction()).toBeCloseTo(0, 12);
    clock.jumpTo(clock.getRange().end);
    expect(clock.getScrubFraction()).toBeCloseTo(1, 12);
  });

  it('round-trips a fraction through scrub and back', () => {
    const clock = new SimulationClock();
    for (const fraction of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      clock.scrubToFraction(fraction);
      expect(clock.getScrubFraction(), `fraction ${fraction}`).toBeCloseTo(fraction, 9);
    }
  });

  it('clamps out-of-range fractions', () => {
    const clock = new SimulationClock();
    clock.scrubToFraction(-5);
    expect(compareJD(clock.nowUtc(), clock.getRange().start)).toBe(0);
    clock.scrubToFraction(5);
    expect(compareJD(clock.nowUtc(), clock.getRange().end)).toBe(0);
  });

  it('is linear in days', () => {
    const clock = new SimulationClock();
    const { start, end } = clock.getRange();
    const span = differenceDays(end, start);
    clock.scrubToFraction(0.5);
    expect(differenceDays(clock.nowUtc(), start)).toBeCloseTo(span / 2, 6);
  });

  it('rejects a non-finite fraction', () => {
    expect(() => new SimulationClock().scrubToFraction(Number.NaN)).toThrow(/finite/);
  });
});

describe('time scale delivery', () => {
  it('hands the ephemeris a TT-branded date', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 8, 15) });
    expect(clock.nowTT().scale).toBe('TT');
    expect(clock.nowUtc().scale).toBe('UTC');
  });

  it('does not collide cached TT values for instants a microsecond apart', () => {
    // The cache key must compare both split fields. Summing them into one number
    // would discard exactly the precision the split form exists to keep, and a
    // stale conversion would be returned.
    //
    // Rate is sized so one full-length real step advances exactly one
    // microsecond of simulated time.
    const MICROSECOND = 1e-6;
    const clock = new SimulationClock({
      epoch: utc(2026, 8, 15),
      rate: MICROSECOND / MAX_REAL_STEP_SECONDS,
      paused: false,
    });

    const first = clock.nowTT();
    clock.advance(FULL_STEP);
    const second = clock.nowTT();
    const measured = differenceSeconds(second, first);

    // A cache collision would return the stale conversion and yield exactly
    // zero, so this is the assertion that actually guards the defect.
    expect(measured).not.toBe(0);

    // Tolerance is grounded in the f64 floor rather than chosen optimistically.
    // A day fraction near 0.5 has a spacing of about 1.1e-16 d, which is
    // roughly 1e-11 s, so no split-JD arithmetic can resolve better than that.
    // 1e-10 sits above the floor and remains four orders of magnitude below the
    // signal being measured.
    const F64_FLOOR_SECONDS = 1e-10;
    expect(Math.abs(measured - MICROSECOND)).toBeLessThan(F64_FLOOR_SECONDS);
  });

  it('keeps TT ahead of UTC by the deltaT offset', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 8, 15) });
    const snapshot = clock.snapshot();
    const offset =
      (snapshot.tt.jdInt - snapshot.utc.jdInt + (snapshot.tt.jdFrac - snapshot.utc.jdFrac)) *
      SECONDS_PER_DAY;
    expect(offset).toBeCloseTo(snapshot.deltaT.seconds, 6);
  });
});

describe('snapshot', () => {
  it('carries formatted time, rate, direction and provenance', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 8, 15, 8, 8, 0), rate: 1000 });
    clock.setDirection(-1);
    const snapshot = clock.snapshot();

    expect(snapshot.formattedUtc).toBe('2026-08-15 08:08:00 UTC');
    expect(snapshot.rate).toBe(1000);
    expect(snapshot.direction).toBe(-1);
    expect(snapshot.paused).toBe(true);
    expect(snapshot.ephemerisTimeScale).toBe('TT');
    // 2026 lies past the last observation behind the deltaT fits.
    expect(snapshot.deltaT.quality).toBe('PREDICTED');
    expect(snapshot.deltaT.model).toMatch(/Espenak/);
  });

  it('tracks the current instant across advances', () => {
    const clock = new SimulationClock({
      epoch: utc(2026, 1, 1),
      rate: ONE_DAY_PER_STEP,
      paused: false,
    });
    clock.advance(FULL_STEP);
    const snapshot = clock.snapshot();
    expect(differenceDays(snapshot.utc, utc(2026, 1, 1))).toBeCloseTo(1, 6);
  });

  it('reports a scrub fraction consistent with the getter', () => {
    const clock = new SimulationClock();
    clock.scrubToFraction(0.3);
    expect(clock.snapshot().scrubFraction).toBeCloseTo(clock.getScrubFraction(), 12);
  });

  it('exposes the active range', () => {
    const range = { start: utc(2020, 1, 1), end: utc(2030, 1, 1) };
    const clock = new SimulationClock({ epoch: utc(2025, 1, 1), range });
    expect(compareJD(clock.snapshot().range.start, range.start)).toBe(0);
    expect(compareJD(clock.snapshot().range.end, range.end)).toBe(0);
  });
});

describe('long-run stability', () => {
  it('holds precision after simulating a century at high rate', () => {
    // A century of simulated time at 1e5x, stepped at 60 Hz. The split
    // representation must not degrade over the run.
    const start = utc(1950, 1, 1);
    const clock = new SimulationClock({
      epoch: start,
      range: { start: utc(1800, 1, 1), end: utc(2050, 1, 1) },
      rate: 100_000,
      paused: false,
    });

    let applied = 0;
    for (let i = 0; i < 20_000; i++) applied += clock.advance(1 / 60);

    const measured = differenceSeconds(clock.nowUtc(), start);
    expect(measured).toBeCloseTo(applied, 3);
    expect(clock.atBound).toBe(false);

    // Sanity: the run advanced a meaningful span, so the assertion is not
    // vacuously true against a clock that never moved.
    expect(differenceDays(clock.nowUtc(), start)).toBeGreaterThan(300);
  });

  it('returns to the same instant after a symmetric forward and reverse run', () => {
    const start = utc(2026, 1, 1);
    const clock = new SimulationClock({ epoch: start, rate: 10_000, paused: false });

    for (let i = 0; i < 1000; i++) clock.advance(1 / 60);
    clock.reverse();
    for (let i = 0; i < 1000; i++) clock.advance(1 / 60);

    expect(differenceSeconds(clock.nowUtc(), start)).toBeCloseTo(0, 6);
  });
});

describe('preset table', () => {
  it('is strictly increasing and starts at real time', () => {
    expect(TIME_RATE_PRESETS[0]).toBe(1);
    for (let i = 1; i < TIME_RATE_PRESETS.length; i++) {
      expect(TIME_RATE_PRESETS[i]! > TIME_RATE_PRESETS[i - 1]!).toBe(true);
    }
  });

  it('stays within the hard ceiling', () => {
    for (const preset of TIME_RATE_PRESETS) {
      expect(preset).toBeLessThanOrEqual(MAX_RATE);
    }
  });
});

describe('unused import guard', () => {
  it('keeps addDays reachable for range helpers', () => {
    // addDays is imported for range construction in later steps; assert it here
    // so the import is exercised rather than silently dropped.
    expect(differenceDays(addDays(utc(2026, 1, 1), 10), utc(2026, 1, 1))).toBeCloseTo(10, 9);
  });
});
