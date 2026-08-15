/**
 * Split Julian Date arithmetic and time-scale conversion.
 *
 * WHY SPLIT: a single f64 holding a modern JD (~2.46e6) resolves to about
 * 2.46e6 / 2^53 = 2.7e-10 d = 24 microseconds, and every arithmetic step
 * rounds at that magnitude. Splitting into an integer day plus a fraction in
 * [0,1) keeps the fraction near unit magnitude, where f64 resolves ~1e-16 d
 * = ~10 picoseconds. Long-running simulation time therefore does not degrade.
 *
 * SCALE BRANDING: JulianDate carries its time scale in the type. Ephemeris
 * models that require TT accept only JulianDate<'TT'>, so feeding UTC into
 * them is a compile error rather than a silent multi-second position error.
 *
 * SOURCES
 *   Calendar <-> JD algorithms:
 *     Meeus, J. (1998) Astronomical Algorithms, 2nd ed., chapter 7.
 *   deltaT polynomials:
 *     Espenak, F. & Meeus, J., "Polynomial Expressions for Delta T",
 *     NASA/GSFC Eclipse Web Site (Five Millennium Canon of Solar Eclipses).
 *   J2000.0 epoch:
 *     IAU standard epoch, JD 2451545.0 TT = 2000 Jan 1.5 TT.
 *
 * See data/sources.md for the full field-level provenance table.
 */

/** Seconds in one day. Exact for TT/TAI/TDB. See leap-second caveat on addSeconds. */
export const SECONDS_PER_DAY = 86_400;

/**
 * Microseconds in one day, used as the quantisation grid when converting a day
 * fraction back to a calendar time of day.
 *
 * Fine enough that it never discards meaningful precision for display, and
 * coarse enough to absorb f64 representation noise, so an instant stored as
 * 23:59:59.999999999 reads back as the next midnight rather than as
 * 23:59:59. Internal detail; not part of the public surface.
 */
const MICROSECONDS_PER_DAY = SECONDS_PER_DAY * 1_000_000;

/** IAU standard epoch J2000.0 = JD 2451545.0 TT. */
export const J2000_JD = 2_451_545.0;

/** Days per Julian century. Exact by definition. */
export const DAYS_PER_JULIAN_CENTURY = 36_525;

/** Days per Julian year. Exact by definition. */
export const DAYS_PER_JULIAN_YEAR = 365.25;

/**
 * Time scales represented in this codebase.
 *
 *   UTC - civil time, what the user reads and enters.
 *   TT  - Terrestrial Time, the independent argument of the ephemeris models.
 *   TDB - Barycentric Dynamical Time. Differs from TT by periodic terms below
 *         2 ms; not implemented in M1, listed so the union is stable.
 */
export type TimeScale = 'UTC' | 'TT' | 'TDB';

/**
 * A Julian Date held as an exact integer day plus a fraction.
 *
 * INVARIANT (guaranteed by every constructor and operation in this module):
 *   Number.isInteger(jdInt)  &&  0 <= jdFrac < 1
 *
 * The represented instant is jdInt + jdFrac. Because JD begins at noon, a
 * civil midnight always lands on jdFrac = 0.5.
 */
export interface JulianDate<S extends TimeScale = TimeScale> {
  readonly jdInt: number;
  readonly jdFrac: number;
  readonly scale: S;
}

/** Calendar breakdown. `day` is an integer; time of day is carried separately. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Restores the split invariant, carrying any whole days from frac into int.
 *
 * Uses Math.floor so negative fractions carry correctly: a frac of -0.25
 * becomes int-1 with frac 0.75, which is the same instant.
 */
export function normalizeJD<S extends TimeScale>(jd: JulianDate<S>): JulianDate<S> {
  const carry = Math.floor(jd.jdFrac);
  if (carry === 0 && Number.isInteger(jd.jdInt)) return jd;
  return {
    jdInt: jd.jdInt + carry,
    jdFrac: jd.jdFrac - carry,
    scale: jd.scale,
  };
}

/** Constructs a normalized JulianDate from any int/frac pair. */
export function makeJD<S extends TimeScale>(
  jdInt: number,
  jdFrac: number,
  scale: S,
): JulianDate<S> {
  if (!Number.isFinite(jdInt) || !Number.isFinite(jdFrac)) {
    throw new Error(`makeJD: non-finite input (jdInt=${jdInt}, jdFrac=${jdFrac})`);
  }
  // Fold any fractional part of jdInt into jdFrac before normalizing, so
  // callers may pass e.g. (2451545.0, 0) or (2451544, 1.0) interchangeably.
  const intPart = Math.floor(jdInt);
  return normalizeJD({
    jdInt: intPart,
    jdFrac: jdFrac + (jdInt - intPart),
    scale,
  });
}

/**
 * Collapses to a single f64. LOSSY above microsecond resolution for modern
 * dates. Use only for display, or where the consumer's own precision is
 * coarser than 1e-10 d. Never use for accumulating time.
 */
export function toNumber(jd: JulianDate): number {
  return jd.jdInt + jd.jdFrac;
}

/**
 * Advances by a signed number of seconds, preserving split precision.
 *
 * LEAP SECONDS: on a UTC-scale date this treats every day as exactly 86400 s,
 * so it steps over leap seconds without accounting for them. Introduced error
 * is bounded by the cumulative leap-second count and is irrelevant at the
 * accuracy of the M1 ephemeris models. Time-scale conversion, not this
 * function, is where leap seconds would have to be handled.
 */
export function addSeconds<S extends TimeScale>(
  jd: JulianDate<S>,
  seconds: number,
): JulianDate<S> {
  if (!Number.isFinite(seconds)) {
    throw new Error(`addSeconds: non-finite seconds (${seconds})`);
  }
  const days = seconds / SECONDS_PER_DAY;
  // Split the increment so the whole-day part is added to the exact integer
  // field and never perturbs the high-resolution fraction.
  const wholeDays = Math.trunc(days);
  const fracDays = days - wholeDays;
  return normalizeJD({
    jdInt: jd.jdInt + wholeDays,
    jdFrac: jd.jdFrac + fracDays,
    scale: jd.scale,
  });
}

/** Advances by a signed number of days, preserving split precision. */
export function addDays<S extends TimeScale>(jd: JulianDate<S>, days: number): JulianDate<S> {
  return addSeconds(jd, days * SECONDS_PER_DAY);
}

/**
 * Signed difference a - b in seconds.
 *
 * Differences the integer and fractional fields separately. The integer
 * difference is exact, and the fractional difference is of two values in
 * [0,1), so the result keeps full precision even when both dates are large.
 * Subtracting toNumber() values instead would discard it.
 *
 * Both operands must share a time scale; mixing them is a type error, and a
 * runtime check backs that up for untyped callers.
 */
export function differenceSeconds(a: JulianDate, b: JulianDate): number {
  if (a.scale !== b.scale) {
    throw new Error(`differenceSeconds: scale mismatch (${a.scale} vs ${b.scale})`);
  }
  return ((a.jdInt - b.jdInt) + (a.jdFrac - b.jdFrac)) * SECONDS_PER_DAY;
}

/** Signed difference a - b in days, full precision. */
export function differenceDays(a: JulianDate, b: JulianDate): number {
  if (a.scale !== b.scale) {
    throw new Error(`differenceDays: scale mismatch (${a.scale} vs ${b.scale})`);
  }
  return (a.jdInt - b.jdInt) + (a.jdFrac - b.jdFrac);
}

/** Chronological comparison. Negative if a < b, 0 if equal, positive if a > b. */
export function compareJD(a: JulianDate, b: JulianDate): number {
  if (a.scale !== b.scale) {
    throw new Error(`compareJD: scale mismatch (${a.scale} vs ${b.scale})`);
  }
  if (a.jdInt !== b.jdInt) return a.jdInt - b.jdInt;
  return a.jdFrac - b.jdFrac;
}

/**
 * Julian centuries since J2000.0, the argument of the IAU and JPL polynomial
 * series. Computed via differenceDays to retain split precision.
 */
export function centuriesSinceJ2000(jd: JulianDate<'TT'>): number {
  return differenceDays(jd, { jdInt: J2000_JD, jdFrac: 0, scale: 'TT' }) / DAYS_PER_JULIAN_CENTURY;
}

/** Days since J2000.0, full precision. */
export function daysSinceJ2000(jd: JulianDate<'TT'>): number {
  return differenceDays(jd, { jdInt: J2000_JD, jdFrac: 0, scale: 'TT' });
}

/**
 * True if the date falls in the Gregorian calendar, i.e. on or after
 * 1582 October 15. Dates on or before 1582 October 4 are Julian; the ten
 * intervening days never existed.
 *
 * Meeus, Astronomical Algorithms, 2nd ed., chapter 7.
 */
function isGregorian(year: number, month: number, day: number): boolean {
  if (year > 1582) return true;
  if (year < 1582) return false;
  if (month > 10) return true;
  if (month < 10) return false;
  return day >= 15;
}

/**
 * Calendar date to split Julian Date.
 *
 * Meeus chapter 7, equation 7.1. Selects the Julian or Gregorian branch
 * automatically at the 1582 October reform.
 *
 * The integer day count is computed entirely in integer arithmetic and the
 * time of day is applied to the fraction, so no large-magnitude float ever
 * absorbs a small time offset.
 */
export function calendarToJD<S extends TimeScale>(date: CalendarDate, scale: S): JulianDate<S> {
  const { month, day, hour, minute, second } = date;

  if (!Number.isInteger(date.day)) {
    throw new Error(`calendarToJD: day must be an integer, got ${date.day}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`calendarToJD: month out of range (${month})`);
  }

  // January and February are treated as months 13 and 14 of the prior year,
  // which places the leap day at the end of the year and makes the 365.25
  // term work uniformly.
  let y = date.year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }

  let b = 0;
  if (isGregorian(date.year, month, day)) {
    const a = Math.floor(y / 100);
    b = 2 - a + Math.floor(a / 4);
  }

  // Meeus 7.1. The trailing -1524.5 makes this end in .5, i.e. it lands on the
  // civil midnight that opens the given day.
  const jdMidnight =
    Math.floor(DAYS_PER_JULIAN_YEAR * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5;

  // jdMidnight is always integer + 0.5. Represent that exactly.
  const intPart = Math.floor(jdMidnight);
  const timeOfDayFraction =
    (hour * 3600 + minute * 60 + second) / SECONDS_PER_DAY;

  return normalizeJD({
    jdInt: intPart,
    jdFrac: jdMidnight - intPart + timeOfDayFraction,
    scale,
  });
}

/**
 * Split Julian Date back to a calendar date.
 *
 * Meeus chapter 7, the inverse algorithm. Valid for JD >= 0.
 */
export function jdToCalendar(jd: JulianDate): CalendarDate {
  const norm = normalizeJD(jd);
  if (norm.jdInt < 0) {
    throw new Error(`jdToCalendar: negative Julian Day not supported (${norm.jdInt})`);
  }

  // Shift by half a day so the split falls on civil midnight, then separate
  // the integer day number Z from the day fraction F.
  const shifted = normalizeJD({
    jdInt: norm.jdInt,
    jdFrac: norm.jdFrac + 0.5,
    scale: norm.scale,
  });

  // Round the fraction to microsecond resolution BEFORE splitting off the day
  // number. Rounding afterwards allows a fraction of 1 - 1e-13 to round up to a
  // full 86400 s, producing an invalid hour of 24 that then has to be pushed
  // into the next day by hand. Rounding here lets normalizeJD carry the whole
  // day, so the calendar algorithm below performs the month and year rollover
  // correctly and the time of day is guaranteed to satisfy 0 <= f < 1.
  const roundedFrac =
    Math.round(shifted.jdFrac * MICROSECONDS_PER_DAY) / MICROSECONDS_PER_DAY;
  const settled = normalizeJD({
    jdInt: shifted.jdInt,
    jdFrac: roundedFrac,
    scale: shifted.scale,
  });

  const z = settled.jdInt;
  const f = settled.jdFrac;

  // 2299161 is the JD of 1582 October 15, the first Gregorian day.
  let a = z;
  if (z >= 2_299_161) {
    const alpha = Math.floor((z - 1_867_216.25) / 36_524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }

  const b = a + 1524;
  const c = Math.floor((b - 122.1) / DAYS_PER_JULIAN_YEAR);
  const d = Math.floor(DAYS_PER_JULIAN_YEAR * c);
  const e = Math.floor((b - d) / 30.6001);

  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;

  // Recover the time of day in integer microseconds. `f` was quantised to the
  // microsecond grid above and normalizeJD guarantees 0 <= f < 1, so `micros`
  // is an integer in [0, MICROSECONDS_PER_DAY) and the hour cannot reach 24.
  // Working in integers here removes the need for any carry guards, and with
  // it the risk of a rollover that recurses without advancing.
  const micros = Math.round(f * MICROSECONDS_PER_DAY);

  const MICROS_PER_HOUR = 3_600_000_000;
  const MICROS_PER_MINUTE = 60_000_000;

  const hour = Math.floor(micros / MICROS_PER_HOUR);
  const afterHours = micros - hour * MICROS_PER_HOUR;
  const minute = Math.floor(afterHours / MICROS_PER_MINUTE);
  const secondValue = (afterHours - minute * MICROS_PER_MINUTE) / 1_000_000;

  return { year, month, day, hour, minute, second: secondValue };
}

/**
 * Fractional year used as the argument of the deltaT polynomials.
 *
 * Espenak & Meeus define y = year + (month - 0.5) / 12, which places the
 * argument at the middle of the given month.
 */
export function fractionalYear(date: CalendarDate): number {
  return date.year + (date.month - 0.5) / 12;
}

/**
 * deltaT = TT - UT1, in seconds, from the Espenak & Meeus polynomial set.
 *
 * MODEL: "Polynomial Expressions for Delta T", NASA/GSFC Eclipse Web Site,
 * derived for the Five Millennium Canon of Solar Eclipses. Piecewise fits by
 * calendar epoch.
 *
 * The COMPLETE published segment set is implemented, from the deep-past
 * parabola through year 2150 and beyond. Implementing only the segments needed
 * for the 1800-2050 ephemeris window is a trap: the deep-past parabola is not
 * a valid continuation of the recent segments, so using it as a fallback just
 * below the implemented range produces a step discontinuity (about 17 s at
 * year 1700). Simulation time is scrubbable, so a discontinuity anywhere in the
 * function's domain is reachable. Every seam in the set below is continuous to
 * within about 0.5 s, the widest being at 1600.
 *
 * ACCURACY AND HONESTY: this is a smooth fit to a quantity governed by
 * irregular changes in Earth's rotation. It is not a measurement and it is not
 * a prediction. Beyond the last observed value it diverges from reality; for
 * 2026 the polynomial yields about 75 s while the observed value is nearer
 * 69 s. That 6 s discrepancy moves Earth about 180 km along its orbit, against
 * roughly 7000 km of intrinsic error in the approximate element model itself
 * at 10 arcseconds and 1 AU. The deltaT error is therefore a small fraction of
 * the ephemeris error and is not the limiting term. It is nonetheless reported
 * as APPROXIMATE in the interface rather than presented as exact.
 *
 * @param year fractional year, e.g. from fractionalYear()
 */
export function deltaT(year: number): number {
  if (!Number.isFinite(year)) {
    throw new Error(`deltaT: non-finite year (${year})`);
  }

  if (year >= 2150) {
    const u = (year - 1820) / 100;
    return -20 + 32 * u * u;
  }

  if (year >= 2050) {
    return -20 + 32 * Math.pow((year - 1820) / 100, 2) - 0.5628 * (2150 - year);
  }

  if (year >= 2005) {
    const t = year - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }

  if (year >= 1986) {
    const t = year - 2000;
    return (
      63.86 +
      0.3345 * t -
      0.060374 * t ** 2 +
      0.0017275 * t ** 3 +
      0.000651814 * t ** 4 +
      0.00002373599 * t ** 5
    );
  }

  if (year >= 1961) {
    const t = year - 1975;
    return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718;
  }

  if (year >= 1941) {
    const t = year - 1950;
    return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547;
  }

  if (year >= 1920) {
    const t = year - 1920;
    return 21.20 + 0.84493 * t - 0.076100 * t ** 2 + 0.0020936 * t ** 3;
  }

  if (year >= 1900) {
    const t = year - 1900;
    return (
      -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4
    );
  }

  if (year >= 1860) {
    const t = year - 1860;
    return (
      7.62 +
      0.5737 * t -
      0.251754 * t ** 2 +
      0.01680668 * t ** 3 -
      0.0004473624 * t ** 4 +
      t ** 5 / 233174
    );
  }

  if (year >= 1800) {
    const t = year - 1800;
    return (
      13.72 -
      0.332447 * t +
      0.0068612 * t ** 2 +
      0.0041116 * t ** 3 -
      0.00037436 * t ** 4 +
      0.0000121272 * t ** 5 -
      0.0000001699 * t ** 6 +
      0.000000000875 * t ** 7
    );
  }

  if (year >= 1700) {
    const t = year - 1700;
    return 8.83 + 0.1603 * t - 0.0059285 * t ** 2 + 0.00013336 * t ** 3 - t ** 4 / 1_174_000;
  }

  if (year >= 1600) {
    const t = year - 1600;
    return 120 - 0.9808 * t - 0.01532 * t ** 2 + t ** 3 / 7129;
  }

  if (year >= 500) {
    const u = (year - 1000) / 100;
    return (
      1574.2 -
      556.01 * u +
      71.23472 * u ** 2 +
      0.319781 * u ** 3 -
      0.8503463 * u ** 4 -
      0.005050998 * u ** 5 +
      0.0083572073 * u ** 6
    );
  }

  if (year >= -500) {
    const u = year / 100;
    return (
      10583.6 -
      1014.41 * u +
      33.78311 * u ** 2 -
      5.952053 * u ** 3 -
      0.1798452 * u ** 4 +
      0.022174192 * u ** 5 +
      0.0090316521 * u ** 6
    );
  }

  // Deep past, before the earliest usable eclipse records. The published
  // long-term parabola is the correct expression HERE and only here; it is not
  // a valid continuation of the segments above.
  const u = (year - 1820) / 100;
  return -20 + 32 * u * u;
}

/**
 * Provenance of a deltaT value.
 *
 * All three are approximations in the sense the interface must convey; the
 * distinction records WHY each is approximate, which differs materially.
 *
 *   FITTED       - inside the span of the observational record the polynomials
 *                  were fitted to (roughly -500 to 2005). Best available.
 *   PREDICTED    - 2005 onward. A forward projection past the last observation.
 *                  Earth's rotation is irregular, so this diverges from reality
 *                  and the divergence grows with date. At 2026 the fit yields
 *                  about 75 s against an observed value nearer 69 s.
 *   EXTRAPOLATED - before -500. The long-term parabola, with no eclipse record
 *                  behind it.
 */
export type DeltaTQuality = 'FITTED' | 'PREDICTED' | 'EXTRAPOLATED';

export interface DeltaTResult {
  readonly seconds: number;
  readonly quality: DeltaTQuality;
  readonly model: string;
}

/**
 * Last year covered by the observational record behind the Espenak & Meeus
 * fits. Beyond this the expressions are a forward projection, not a fit.
 */
const DELTA_T_LAST_OBSERVED_YEAR = 2005;

/** Earliest year with usable eclipse records behind the fitted expressions. */
const DELTA_T_FIRST_FITTED_YEAR = -500;

/**
 * deltaT with provenance attached, for display.
 *
 * The interface must not present a forward projection with the same confidence
 * as a value backed by observation, so the three regimes are distinguished
 * rather than collapsed into a single "approximate" label. See DeltaTQuality.
 */
export function deltaTWithProvenance(year: number): DeltaTResult {
  const seconds = deltaT(year);
  const quality: DeltaTQuality =
    year < DELTA_T_FIRST_FITTED_YEAR
      ? 'EXTRAPOLATED'
      : year >= DELTA_T_LAST_OBSERVED_YEAR
        ? 'PREDICTED'
        : 'FITTED';
  return {
    seconds,
    quality,
    model: 'Espenak & Meeus polynomial expressions for Delta T',
  };
}

/**
 * UTC to TT.
 *
 * APPROXIMATION: applies deltaT, which is defined as TT - UT1, to a UTC date.
 * The residual is UT1 - UTC, which leap-second insertion holds below 0.9 s by
 * construction. Rigorous conversion would be TT = UTC + leapSeconds + 32.184 s
 * and require a maintained leap-second table; that is deferred, and this
 * approximation is documented wherever the converted value is displayed.
 */
export function ttFromUtc(jdUtc: JulianDate<'UTC'>): JulianDate<'TT'> {
  const calendar = jdToCalendar(jdUtc);
  const offset = deltaT(fractionalYear(calendar));
  const shifted = addSeconds(jdUtc, offset);
  return { jdInt: shifted.jdInt, jdFrac: shifted.jdFrac, scale: 'TT' };
}

/**
 * TT to UTC.
 *
 * deltaT is a function of the date, so this inverts by one fixed-point
 * iteration: evaluate deltaT at the TT date, step back, re-evaluate at that
 * estimate. deltaT changes by well under a second per year, so a single
 * refinement converges far below the accuracy of the model itself.
 */
export function utcFromTt(jdTt: JulianDate<'TT'>): JulianDate<'UTC'> {
  const firstGuess = addSeconds(jdTt, -deltaT(fractionalYear(jdToCalendar(jdTt))));
  const refinedOffset = deltaT(fractionalYear(jdToCalendar(firstGuess)));
  const shifted = addSeconds(jdTt, -refinedOffset);
  return { jdInt: shifted.jdInt, jdFrac: shifted.jdFrac, scale: 'UTC' };
}

/** Convenience constructor from a UTC calendar date. */
export function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): JulianDate<'UTC'> {
  return calendarToJD({ year, month, day, hour, minute, second }, 'UTC');
}

/**
 * ISO 8601 rendering, always UTC, second resolution.
 *
 * Formats for the interface only. Not a parsing round-trip guarantee.
 */
export function formatJD(jd: JulianDate): string {
  const c = jdToCalendar(jd);
  const pad = (n: number, width = 2): string => String(Math.floor(n)).padStart(width, '0');
  return (
    `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)} ` +
    `${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)} ${jd.scale}`
  );
}
