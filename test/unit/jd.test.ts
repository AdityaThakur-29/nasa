/**
 * Split Julian Date validation.
 *
 * REFERENCE VALUES: every absolute JD asserted here is taken from the worked
 * examples and the calendar table in Meeus, J. (1998) Astronomical Algorithms,
 * 2nd ed., chapter 7 ("Julian Day"). No expected astronomical value in this
 * file was computed by the implementation under test, and none was invented.
 *
 * Relative assertions (day counts between adjacent dates, round trips,
 * monotonicity, precision retention) are self-consistent properties and are
 * labelled as such.
 */

import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_JULIAN_CENTURY,
  J2000_JD,
  SECONDS_PER_DAY,
  addDays,
  addSeconds,
  calendarToJD,
  centuriesSinceJ2000,
  compareJD,
  daysSinceJ2000,
  deltaT,
  deltaTWithProvenance,
  differenceDays,
  differenceSeconds,
  fractionalYear,
  formatJD,
  jdToCalendar,
  makeJD,
  normalizeJD,
  toNumber,
  ttFromUtc,
  utc,
  utcFromTt,
  type CalendarDate,
} from '@/core/jd';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/** Meeus, Astronomical Algorithms, 2nd ed., ch. 7, table 7.A and examples 7.a/7.b. */
const MEEUS_TABLE: ReadonlyArray<{
  readonly label: string;
  readonly date: CalendarDate;
  readonly jd: number;
}> = [
  // Example 7.a
  { label: '1957 Oct 4.81 (Sputnik 1)', date: cal(1957, 10, 4, 19, 26, 24), jd: 2_436_116.31 },
  // Table 7.A, Gregorian calendar entries
  { label: '2000 Jan 1.5', date: cal(2000, 1, 1, 12, 0, 0), jd: 2_451_545.0 },
  { label: '1999 Jan 1.0', date: cal(1999, 1, 1), jd: 2_451_179.5 },
  { label: '1987 Jan 27.0', date: cal(1987, 1, 27), jd: 2_446_822.5 },
  { label: '1987 Jun 19.5', date: cal(1987, 6, 19, 12, 0, 0), jd: 2_446_966.0 },
  { label: '1988 Jan 27.0', date: cal(1988, 1, 27), jd: 2_447_187.5 },
  { label: '1988 Jun 19.5', date: cal(1988, 6, 19, 12, 0, 0), jd: 2_447_332.0 },
  { label: '1900 Jan 1.0', date: cal(1900, 1, 1), jd: 2_415_020.5 },
  { label: '1600 Jan 1.0', date: cal(1600, 1, 1), jd: 2_305_447.5 },
  { label: '1600 Dec 31.0', date: cal(1600, 12, 31), jd: 2_305_812.5 },
  // Table 7.A, Julian calendar entries (before the 1582 October reform)
  { label: '837 Apr 10.3 (Julian)', date: cal(837, 4, 10, 7, 12, 0), jd: 2_026_871.8 },
  { label: '333 Jan 27.5 (Julian)', date: cal(333, 1, 27, 12, 0, 0), jd: 1_842_713.0 },
];

function cal(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): CalendarDate {
  return { year, month, day, hour, minute, second };
}

describe('normalizeJD', () => {
  it('establishes the split invariant for positive fractions', () => {
    const result = normalizeJD({ jdInt: 2_451_545, jdFrac: 2.75, scale: 'TT' });
    expect(result.jdInt).toBe(2_451_547);
    expect(result.jdFrac).toBeCloseTo(0.75, 15);
  });

  it('carries negative fractions downward rather than leaving them negative', () => {
    const result = normalizeJD({ jdInt: 2_451_545, jdFrac: -0.25, scale: 'TT' });
    expect(result.jdInt).toBe(2_451_544);
    expect(result.jdFrac).toBeCloseTo(0.75, 15);
    // The instant is unchanged by normalisation.
    expect(toNumber(result)).toBeCloseTo(2_451_544.75, 9);
  });

  it('is idempotent', () => {
    const once = normalizeJD({ jdInt: 100, jdFrac: 5.5, scale: 'UTC' });
    const twice = normalizeJD(once);
    expect(twice).toEqual(once);
  });

  it('holds the invariant across randomised inputs', () => {
    forEachSample(DEFAULT_SEED, 500, (sampler, context) => {
      const jdInt = sampler.int(0, 3_000_000);
      const jdFrac = sampler.range(-50, 50);
      const result = normalizeJD({ jdInt, jdFrac, scale: 'TT' });

      const holds =
        Number.isInteger(result.jdInt) && result.jdFrac >= 0 && result.jdFrac < 1;
      expect(
        holds,
        formatPropertyFailure(
          { ...context, jdInt, jdFrac },
          'integer jdInt and 0 <= jdFrac < 1',
          `jdInt=${result.jdInt}, jdFrac=${result.jdFrac}`,
        ),
      ).toBe(true);
    });
  });
});

describe('makeJD', () => {
  it('folds a fractional jdInt into the fraction field', () => {
    const a = makeJD(2_451_545.0, 0, 'TT');
    const b = makeJD(2_451_544, 1.0, 'TT');
    expect(compareJD(a, b)).toBe(0);
    expect(a.jdInt).toBe(2_451_545);
    expect(a.jdFrac).toBe(0);
  });

  it('rejects non-finite input rather than producing a corrupt date', () => {
    expect(() => makeJD(Number.NaN, 0, 'TT')).toThrow(/non-finite/);
    expect(() => makeJD(0, Number.POSITIVE_INFINITY, 'TT')).toThrow(/non-finite/);
  });
});

describe('calendarToJD', () => {
  it.each(MEEUS_TABLE)('matches Meeus reference: $label', ({ date, jd }) => {
    const result = calendarToJD(date, 'TT');
    // Meeus tabulates to 0.01 d; assert to half of that last place.
    expect(toNumber(result)).toBeCloseTo(jd, 2);
  });

  it('places civil midnight on a half-day fraction', () => {
    // JD begins at noon, so 00:00 civil time is always JD x.5.
    const midnight = calendarToJD(cal(2026, 8, 15), 'UTC');
    expect(midnight.jdFrac).toBeCloseTo(0.5, 12);
  });

  it('spans the 1582 Gregorian reform without a gap in the day count', () => {
    // 1582 Oct 4 (Julian) is immediately followed by 1582 Oct 15 (Gregorian).
    // The ten skipped calendar days did not exist, so the JDs are consecutive.
    const lastJulian = calendarToJD(cal(1582, 10, 4), 'TT');
    const firstGregorian = calendarToJD(cal(1582, 10, 15), 'TT');
    expect(differenceDays(firstGregorian, lastJulian)).toBeCloseTo(1, 9);
  });

  it('rejects a non-integer day', () => {
    expect(() => calendarToJD(cal(2000, 1, 1.5), 'TT')).toThrow(/integer/);
  });

  it('rejects an out-of-range month', () => {
    expect(() => calendarToJD(cal(2000, 13, 1), 'TT')).toThrow(/month/);
    expect(() => calendarToJD(cal(2000, 0, 1), 'TT')).toThrow(/month/);
  });
});

describe('leap year handling', () => {
  it('treats 1900 as a common year (Gregorian century rule)', () => {
    const feb28 = calendarToJD(cal(1900, 2, 28), 'TT');
    const mar1 = calendarToJD(cal(1900, 3, 1), 'TT');
    expect(differenceDays(mar1, feb28)).toBeCloseTo(1, 9);
  });

  it('treats 2000 as a leap year (divisible by 400)', () => {
    const feb28 = calendarToJD(cal(2000, 2, 28), 'TT');
    const mar1 = calendarToJD(cal(2000, 3, 1), 'TT');
    expect(differenceDays(mar1, feb28)).toBeCloseTo(2, 9);
  });

  it('treats 2024 as a leap year and round-trips 29 February', () => {
    const feb29 = calendarToJD(cal(2024, 2, 29, 6, 30, 0), 'TT');
    const back = jdToCalendar(feb29);
    expect(back.year).toBe(2024);
    expect(back.month).toBe(2);
    expect(back.day).toBe(29);
    expect(back.hour).toBe(6);
    expect(back.minute).toBe(30);
  });

  it('counts 366 days across a leap year and 365 across a common year', () => {
    const leapStart = calendarToJD(cal(2024, 1, 1), 'TT');
    const leapEnd = calendarToJD(cal(2025, 1, 1), 'TT');
    expect(differenceDays(leapEnd, leapStart)).toBeCloseTo(366, 9);

    const commonStart = calendarToJD(cal(2023, 1, 1), 'TT');
    const commonEnd = calendarToJD(cal(2024, 1, 1), 'TT');
    expect(differenceDays(commonEnd, commonStart)).toBeCloseTo(365, 9);
  });
});

describe('month boundaries', () => {
  const MONTH_LENGTHS_2023 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  it('produces the correct length for every month of a common year', () => {
    for (let month = 1; month <= 12; month++) {
      const start = calendarToJD(cal(2023, month, 1), 'TT');
      const next =
        month === 12 ? calendarToJD(cal(2024, 1, 1), 'TT') : calendarToJD(cal(2023, month + 1, 1), 'TT');
      expect(
        differenceDays(next, start),
        `month ${month} length`,
      ).toBeCloseTo(MONTH_LENGTHS_2023[month - 1] ?? 0, 9);
    }
  });

  it('round-trips the last instant before each month rollover', () => {
    for (let month = 1; month <= 12; month++) {
      const lastDay = differenceDays(
        month === 12 ? calendarToJD(cal(2023, 12, 31), 'TT') : calendarToJD(cal(2023, month + 1, 1), 'TT'),
        calendarToJD(cal(2023, month, 1), 'TT'),
      );
      const day = month === 12 ? 31 : lastDay;
      const jd = calendarToJD(cal(2023, month, day, 23, 59, 59), 'TT');
      const back = jdToCalendar(jd);
      expect(back.month, `month ${month} did not roll over correctly`).toBe(month);
      expect(back.hour).toBe(23);
      expect(back.minute).toBe(59);
      expect(back.second).toBeCloseTo(59, 6);
    }
  });

  it('does not emit an hour of 24 at the top of a day', () => {
    // A fraction epsilon below midnight must read as the next day at 00:00,
    // never as hour 24 of the previous day.
    const justBeforeMidnight = makeJD(2_451_545, 0.5 - 1e-13, 'UTC');
    const back = jdToCalendar(justBeforeMidnight);
    expect(back.hour).toBeLessThan(24);
    expect(back.hour).toBe(0);
    expect(back.day).toBe(2);
  });
});

describe('calendar round trip', () => {
  it('recovers randomised dates to microsecond resolution', () => {
    forEachSample(DEFAULT_SEED ^ 0x1111, 800, (sampler, context) => {
      const year = sampler.int(1600, 2400);
      const month = sampler.int(1, 12);
      const day = sampler.int(1, 28);
      const hour = sampler.int(0, 23);
      const minute = sampler.int(0, 59);
      const second = sampler.int(0, 59);

      const source = cal(year, month, day, hour, minute, second);
      const jd = calendarToJD(source, 'TT');
      const back = jdToCalendar(jd);

      const matches =
        back.year === year &&
        back.month === month &&
        back.day === day &&
        back.hour === hour &&
        back.minute === minute &&
        Math.abs(back.second - second) < 1e-6;

      expect(
        matches,
        formatPropertyFailure(
          { ...context, date: `${year}-${month}-${day} ${hour}:${minute}:${second}` },
          `${year}-${month}-${day} ${hour}:${minute}:${second}`,
          `${back.year}-${back.month}-${back.day} ${back.hour}:${back.minute}:${back.second}`,
        ),
      ).toBe(true);
    });
  });
});

describe('addSeconds and differenceSeconds', () => {
  it('are exact inverses for a range of offsets', () => {
    const base = utc(2026, 8, 15, 8, 8, 0);
    for (const seconds of [0, 1, -1, 60, -3600, 86_400, -86_400, 1e6, -1e6, 1e9]) {
      const moved = addSeconds(base, seconds);
      expect(differenceSeconds(moved, base), `offset ${seconds}`).toBeCloseTo(seconds, 6);
    }
  });

  it('handles positive and negative offsets across a day boundary symmetrically', () => {
    const midnight = utc(2026, 8, 15, 0, 0, 0);
    const before = addSeconds(midnight, -1);
    const after = addSeconds(midnight, 1);

    const beforeCal = jdToCalendar(before);
    expect(beforeCal.day).toBe(14);
    expect(beforeCal.hour).toBe(23);
    expect(beforeCal.minute).toBe(59);
    expect(beforeCal.second).toBeCloseTo(59, 6);

    const afterCal = jdToCalendar(after);
    expect(afterCal.day).toBe(15);
    expect(afterCal.hour).toBe(0);
    expect(afterCal.second).toBeCloseTo(1, 6);
  });

  it('retains microsecond precision under repeated accumulation', () => {
    // THE REASON THE SPLIT REPRESENTATION EXISTS. A single f64 holding a modern
    // JD near 2.45e6 has a spacing of about 2.7e-10 d, roughly 24 us, so
    // accumulating 1 us steps into one float loses most of the increments.
    const STEPS = 10_000;
    const MICROSECOND = 1e-6;

    let split = utc(2026, 8, 15, 0, 0, 0);
    for (let i = 0; i < STEPS; i++) {
      split = addSeconds(split, MICROSECOND);
    }
    const splitTotal = differenceSeconds(split, utc(2026, 8, 15, 0, 0, 0));

    // Naive single-float accumulation, for contrast.
    let naive = toNumber(utc(2026, 8, 15, 0, 0, 0));
    for (let i = 0; i < STEPS; i++) {
      naive += MICROSECOND / SECONDS_PER_DAY;
    }
    const naiveTotal = (naive - toNumber(utc(2026, 8, 15, 0, 0, 0))) * SECONDS_PER_DAY;

    const expected = STEPS * MICROSECOND;
    const splitError = Math.abs(splitTotal - expected);
    const naiveError = Math.abs(naiveTotal - expected);

    // Split form stays well inside a nanosecond over 10^4 steps.
    expect(splitError).toBeLessThan(1e-9);
    // And is at least an order of magnitude better than the naive form.
    expect(splitError).toBeLessThan(naiveError * 0.1);
  });

  it('preserves precision in differences between distant dates', () => {
    // Two instants one millisecond apart, three centuries from the epoch.
    const a = utc(2300, 6, 15, 12, 0, 0);
    const b = addSeconds(a, 1e-3);
    expect(differenceSeconds(b, a)).toBeCloseTo(1e-3, 12);
  });

  it('rejects non-finite offsets', () => {
    expect(() => addSeconds(utc(2000, 1, 1), Number.NaN)).toThrow(/non-finite/);
  });

  it('addDays agrees with addSeconds', () => {
    const base = utc(2026, 1, 1);
    expect(differenceSeconds(addDays(base, 2.5), addSeconds(base, 2.5 * SECONDS_PER_DAY))).toBeCloseTo(
      0,
      9,
    );
  });
});

describe('time scale safety', () => {
  it('refuses to difference dates on different scales', () => {
    const utcDate = utc(2026, 1, 1);
    const ttDate = ttFromUtc(utcDate);
    expect(() => differenceSeconds(ttDate, utcDate as never)).toThrow(/scale mismatch/);
    expect(() => compareJD(ttDate, utcDate as never)).toThrow(/scale mismatch/);
    expect(() => differenceDays(ttDate, utcDate as never)).toThrow(/scale mismatch/);
  });

  it('tags converted dates with the target scale', () => {
    const tt = ttFromUtc(utc(2026, 8, 15));
    expect(tt.scale).toBe('TT');
    expect(utcFromTt(tt).scale).toBe('UTC');
  });
});

describe('compareJD', () => {
  it('orders by instant, not by field', () => {
    const early = makeJD(2_451_545, 0.25, 'TT');
    const late = makeJD(2_451_545, 0.75, 'TT');
    const nextDay = makeJD(2_451_546, 0.1, 'TT');

    expect(compareJD(early, late)).toBeLessThan(0);
    expect(compareJD(late, early)).toBeGreaterThan(0);
    expect(compareJD(early, early)).toBe(0);
    expect(compareJD(late, nextDay)).toBeLessThan(0);
  });
});

describe('epoch helpers', () => {
  it('places J2000.0 at zero centuries and zero days', () => {
    const j2000 = makeJD(J2000_JD, 0, 'TT');
    expect(centuriesSinceJ2000(j2000)).toBe(0);
    expect(daysSinceJ2000(j2000)).toBe(0);
  });

  it('counts one Julian century as exactly 36525 days', () => {
    const j2000 = makeJD(J2000_JD, 0, 'TT');
    const later = addDays(j2000, DAYS_PER_JULIAN_CENTURY);
    expect(centuriesSinceJ2000(later)).toBeCloseTo(1, 12);
    expect(daysSinceJ2000(later)).toBeCloseTo(DAYS_PER_JULIAN_CENTURY, 9);
  });

  it('returns negative centuries before the epoch', () => {
    const earlier = addDays(makeJD(J2000_JD, 0, 'TT'), -DAYS_PER_JULIAN_CENTURY);
    expect(centuriesSinceJ2000(earlier)).toBeCloseTo(-1, 12);
  });
});

describe('deltaT', () => {
  it('is continuous across every polynomial segment boundary', () => {
    // The Espenak & Meeus expressions are a piecewise fit. A discontinuity at a
    // join would make simulation time jump, so the seam must be smooth to well
    // below the model's own uncertainty.
    // Every seam in the published set, including the deep-past joins. The 1700
    // seam is the one that caught a real defect: falling back to the long-term
    // parabola below 1700 produced a 17 s step.
    const boundaries = [
      -500, 500, 1600, 1700, 1800, 1860, 1900, 1920, 1941, 1961, 1986, 2005, 2050, 2150,
    ];
    for (const boundary of boundaries) {
      const below = deltaT(boundary - 1e-6);
      const above = deltaT(boundary + 1e-6);
      expect(
        Math.abs(above - below),
        `discontinuity at year ${boundary}: ${below} -> ${above}`,
      ).toBeLessThan(0.5);
    }
  });

  it('reproduces the published value at the 2000 reference year', () => {
    // Espenak & Meeus 1986-2005 segment evaluates to 63.86 s at t = 0, matching
    // the observed value of about 63.83 s for 2000.0.
    expect(deltaT(2000)).toBeCloseTo(63.86, 2);
  });

  it('returns a plausible positive offset across the ephemeris validity window', () => {
    // Bounds are sanity limits on the fit, not measurements.
    for (let year = 1800; year <= 2050; year += 10) {
      const value = deltaT(year);
      expect(Number.isFinite(value), `year ${year}`).toBe(true);
      expect(Math.abs(value), `year ${year}`).toBeLessThan(200);
    }
  });

  it('distinguishes fitted, predicted and extrapolated regimes', () => {
    // Backed by the observational record the polynomials were fitted to.
    expect(deltaTWithProvenance(1900).quality).toBe('FITTED');
    expect(deltaTWithProvenance(1500).quality).toBe('FITTED');
    expect(deltaTWithProvenance(0).quality).toBe('FITTED');

    // Past the last observation: a forward projection of an irregular quantity.
    // The interface must not imply this carries observational confidence.
    expect(deltaTWithProvenance(2026).quality).toBe('PREDICTED');
    expect(deltaTWithProvenance(2200).quality).toBe('PREDICTED');

    // Before the earliest usable eclipse records.
    expect(deltaTWithProvenance(-1000).quality).toBe('EXTRAPOLATED');

    expect(deltaTWithProvenance(2026).model).toMatch(/Espenak/);
  });

  it('rejects non-finite years', () => {
    expect(() => deltaT(Number.NaN)).toThrow(/non-finite/);
  });

  it('does not hardcode a universal constant offset', () => {
    // Guards against regressing to a fixed 69 s. The model must vary with date.
    expect(deltaT(1900)).not.toBeCloseTo(deltaT(2026), 1);
    expect(deltaT(2026)).not.toBeCloseTo(deltaT(2040), 2);
  });
});

describe('fractionalYear', () => {
  it('places the argument at the middle of the month', () => {
    // Espenak & Meeus define y = year + (month - 0.5) / 12.
    expect(fractionalYear(cal(2026, 1, 1))).toBeCloseTo(2026 + 0.5 / 12, 12);
    expect(fractionalYear(cal(2026, 12, 31))).toBeCloseTo(2026 + 11.5 / 12, 12);
  });
});

describe('UTC and TT conversion', () => {
  it('round-trips to well below the model uncertainty', () => {
    for (const year of [1800, 1900, 1950, 2000, 2026, 2049]) {
      const original = utc(year, 6, 15, 12, 0, 0);
      const recovered = utcFromTt(ttFromUtc(original));
      // The fixed-point inversion converges to microseconds, far inside the
      // several-second uncertainty of deltaT itself.
      expect(Math.abs(differenceSeconds(recovered, original)), `year ${year}`).toBeLessThan(1e-3);
    }
  });

  it('advances TT ahead of UTC in the modern era', () => {
    const utcDate = utc(2026, 8, 15, 8, 8, 0);
    const ttDate = ttFromUtc(utcDate);
    // Same underlying instant count, so compare the raw numeric offset.
    const offsetSeconds = (toNumber(ttDate) - toNumber(utcDate)) * SECONDS_PER_DAY;
    expect(offsetSeconds).toBeGreaterThan(60);
    expect(offsetSeconds).toBeLessThan(90);
  });
});

describe('formatJD', () => {
  it('renders a padded timestamp carrying the time scale', () => {
    expect(formatJD(utc(2026, 8, 15, 8, 8, 0))).toBe('2026-08-15 08:08:00 UTC');
    expect(formatJD(makeJD(J2000_JD, 0, 'TT'))).toBe('2000-01-01 12:00:00 TT');
  });
});
