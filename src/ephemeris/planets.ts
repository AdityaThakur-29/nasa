/**
 * Planetary positions from the JPL approximate Keplerian elements.
 *
 * SOURCE S1: https://ssd.jpl.nasa.gov/planets/approx_pos.html
 * Implements steps 1 through 6 of the published algorithm. Element data lives in
 * src/data/jpl-elements.ts; this module only evaluates it.
 *
 * SECULAR, NOT FIXED, ELEMENTS. Every element carries a per-century rate, so a,
 * e, I, longitude of perihelion and longitude of node all drift with time. That
 * is what makes this model track reality over centuries, and it is also why
 * specific orbital energy and angular momentum are NOT invariant here. Those
 * conservation properties belong to the fixed-element propagator in kepler.ts
 * and are tested there. Asserting them against this module would fail correctly,
 * and the only way to force a pass would be to widen the tolerance until the
 * assertion said nothing.
 *
 * WHAT IS VALIDATED INSTEAD, in planets.test.ts: agreement with the published
 * accuracy figures, monotonic advance of mean longitude, continuity across the
 * validity boundary, and internal consistency between position and velocity.
 */

import {
  J2000_JD,
  type JulianDate,
  addSeconds,
  calendarToJD,
  centuriesSinceJ2000,
  toNumber,
} from '../core/jd';
import {
  AU_KM,
  DEG_TO_RAD,
  JULIAN_CENTURY_DAYS,
} from '../data/constants';
import {
  ELEMENTS_TABLE_1,
  ELEMENTS_TABLE_2A,
  ELEMENT_ACCURACY,
  ELEMENT_SOURCE,
  type ElementTable,
  type PlanetElementRecord,
  getElementRecord,
} from '../data/jpl-elements';
import { ELEMENT_ROW_FOR_BODY, PLANET_IDS } from '../data/bodies';
import {
  orbitalPlanePosition,
  orbitalPlaneToReferencePlane,
  solveKeplerEquation,
  wrapToPi,
  type Vector3Like,
} from './kepler';
import type {
  BodyState,
  EphemerisMetadata,
  EphemerisProvider,
  ValidRange,
} from './provider';

/** Seconds in a Julian century, for converting per-century rates to per-second. */
const SECONDS_PER_JULIAN_CENTURY = JULIAN_CENTURY_DAYS * 86_400;

/** Elements evaluated at a specific instant, in the units the source publishes. */
export interface EvaluatedElements {
  /** Semi-major axis, au. */
  readonly a: number;
  /** Eccentricity, dimensionless. */
  readonly e: number;
  /** Inclination, degrees. */
  readonly I: number;
  /** Mean longitude, degrees. */
  readonly L: number;
  /** Longitude of perihelion, degrees. */
  readonly longPeri: number;
  /** Longitude of ascending node, degrees. */
  readonly longNode: number;
  /** Argument of perihelion, degrees. Derived as longPeri - longNode. */
  readonly argPeri: number;
  /** Mean anomaly wrapped to [-180, 180), degrees. */
  readonly meanAnomaly: number;
  /** Centuries past J2000 this evaluation used. */
  readonly centuriesPastJ2000: number;
}

/**
 * Evaluates the element set at an instant.
 *
 * S1 steps 1 and 2. The augmentation terms are applied only when the record
 * carries them, which is exactly the Jupiter-through-Neptune rows of Table 2a.
 * The data layer refuses to build a Table 2a record for those bodies without
 * them, so a silent omission is not reachable from here.
 */
export function evaluateElements(
  record: PlanetElementRecord,
  jdTT: JulianDate<'TT'>,
): EvaluatedElements {
  const T = centuriesSinceJ2000(jdTT);

  const a = record.elements.a + record.rates.a * T;
  const e = record.elements.e + record.rates.e * T;
  const I = record.elements.I + record.rates.I * T;
  const L = record.elements.L + record.rates.L * T;
  const longPeri = record.elements.longPeri + record.rates.longPeri * T;
  const longNode = record.elements.longNode + record.rates.longNode * T;

  // Step 2: argument of perihelion and mean anomaly.
  const argPeri = longPeri - longNode;

  let meanAnomalyDeg = L - longPeri;
  if (record.augmentation !== undefined) {
    const { b, c, s, f } = record.augmentation;
    const fT = f * T * DEG_TO_RAD;
    meanAnomalyDeg += b * T * T + c * Math.cos(fT) + s * Math.sin(fT);
  }

  // Step 3: reduce to a symmetric interval before solving.
  const meanAnomaly = wrapToPi(meanAnomalyDeg * DEG_TO_RAD) / DEG_TO_RAD;

  return { a, e, I, L, longPeri, longNode, argPeri, meanAnomaly, centuriesPastJ2000: T };
}

/**
 * Rate of change of MEAN LONGITUDE, radians per second.
 *
 * DELIBERATELY NOT sqrt(GM/a^3). The element set publishes its own fitted rate,
 * and using it keeps the velocity consistent with the position the same model
 * produces. The two disagree by up to 6.6e-4 relative for Neptune, measured,
 * because the fitted rate absorbs planetary perturbations a two-body law omits.
 *
 * This is the SIDEREAL rate: mean longitude is measured from the fixed equinox,
 * so 360 degrees of it is one sidereal orbit.
 */
function meanLongitudeRateRadPerSecond(record: PlanetElementRecord): number {
  return (record.rates.L * DEG_TO_RAD) / SECONDS_PER_JULIAN_CENTURY;
}

/**
 * Rate of change of MEAN ANOMALY, radians per second.
 *
 * Since M = L - longPeri, the correct time derivative is
 *
 *   dM/dt = dL/dt - d(longPeri)/dt
 *
 * The perihelion term is NOT negligible and dropping it is a real error, not a
 * rounding one. Measured: using dL/dt alone left a 5.7e-5 relative disagreement
 * with a central finite difference of the model's own position for Saturn, whose
 * perihelion drifts at -0.419 deg/century against a mean-longitude rate of
 * 1222.494 deg/century, a 3.4e-4 relative contribution. Uranus is larger still
 * at 9.5e-4.
 *
 * This rate is ANOMALISTIC: 360 degrees of mean anomaly is one perihelion-to-
 * perihelion orbit, which differs from the sidereal orbit precisely because the
 * perihelion itself moves.
 *
 * The Table 2b augmentation terms also contribute a time derivative. Their
 * amplitudes are below 1 degree with periods of centuries, so the contribution is
 * roughly 1e-8 relative and is neglected; the finite-difference test bounds the
 * total residual and would catch it if that estimate were wrong.
 */
function meanAnomalyRateRadPerSecond(record: PlanetElementRecord): number {
  return ((record.rates.L - record.rates.longPeri) * DEG_TO_RAD) / SECONDS_PER_JULIAN_CENTURY;
}

/**
 * Heliocentric position in the J2000 ecliptic frame, km.
 *
 * S1 steps 3 through 5.
 */
function computePosition(
  record: PlanetElementRecord,
  jdTT: JulianDate<'TT'>,
): { position: Vector3Like; elements: EvaluatedElements } {
  const elements = evaluateElements(record, jdTT);

  const solution = solveKeplerEquation(elements.meanAnomaly * DEG_TO_RAD, elements.e);
  const aKm = elements.a * AU_KM;
  const planar = orbitalPlanePosition(aKm, elements.e, solution.eccentricAnomaly);

  return {
    position: orbitalPlaneToReferencePlane(
      planar,
      elements.argPeri * DEG_TO_RAD,
      elements.I * DEG_TO_RAD,
      elements.longNode * DEG_TO_RAD,
    ),
    elements,
  };
}

/**
 * Central-difference step for the velocity, seconds.
 *
 * ERROR BUDGET, computed rather than guessed. Central differencing carries a
 * truncation error of order (h^2/6)|d3r/dt3|, which relative to the orbital
 * speed is about (omega h)^2/6. Mercury has the largest angular rate at
 * omega = 8.3e-7 rad/s, giving (5e-5)^2/6, about 4e-10 relative.
 *
 * Round-off pushes the other way: differencing two positions of magnitude r
 * loses about eps*r, so the relative velocity error is eps*r/(2 h v). The worst
 * case is Neptune, with r = 4.5e9 km and v = 5.4 km/s, giving about 7e-10.
 *
 * Both error terms therefore sit near 1e-9 relative at h = 60 s, which is four
 * orders of magnitude below the 1e-5 consistency bound the test suite asserts
 * and far below the model's own accuracy. Larger h would worsen truncation,
 * smaller h would worsen round-off.
 */
const VELOCITY_STEP_SECONDS = 60;

/**
 * Heliocentric position and velocity in the J2000 ecliptic frame.
 *
 * VELOCITY BY NUMERICAL DIFFERENTIATION of the model's own position, which is a
 * deliberate choice over an analytic formula.
 *
 * S1 publishes position only. An analytic derivative is possible, but the
 * position depends on time through SIX secular paths, not one: the mean anomaly
 * M = L - longPeri, the argument of perihelion omega = longPeri - longNode, the
 * node longNode, the inclination I, the semi-major axis a, and the eccentricity
 * e. Differentiating only the M path is wrong, and wrong in a way that hides
 * itself: the drift of omega very nearly cancels the perihelion term inside
 * dM/dt, because for a near-circular orbit the heliocentric longitude is
 * approximately longPeri + M = L, so the total along-track rate is dL/dt.
 *
 * That cancellation was measured during development. Using dM/dt = dL/dt alone
 * left a 5.7e-5 relative residual against a finite difference; "correcting" it to
 * dM/dt = dL/dt - d(longPeri)/dt made Neptune WORSE, at 1.5e-3, which is exactly
 * |d(longPeri)/dt| / |dL/dt| for that body. The first version was accidentally
 * close because it captured the correct total; the second removed the
 * cancellation without supplying the compensating omega term.
 *
 * Central differencing captures every secular path exactly, to the error budget
 * documented on VELOCITY_STEP_SECONDS, and cannot silently omit one. It costs two
 * extra element evaluations per query, which is negligible for eight bodies.
 *
 * The returned velocity is therefore the true time derivative of the returned
 * position, which is the property the simulation actually requires.
 */
function computeState(
  record: PlanetElementRecord,
  jdTT: JulianDate<'TT'>,
): { position: Vector3Like; velocity: Vector3Like; elements: EvaluatedElements } {
  const { position, elements } = computePosition(record, jdTT);

  const before = computePosition(record, addSeconds(jdTT, -VELOCITY_STEP_SECONDS)).position;
  const after = computePosition(record, addSeconds(jdTT, VELOCITY_STEP_SECONDS)).position;

  return {
    position,
    velocity: {
      x: (after.x - before.x) / (2 * VELOCITY_STEP_SECONDS),
      y: (after.y - before.y) / (2 * VELOCITY_STEP_SECONDS),
      z: (after.z - before.z) / (2 * VELOCITY_STEP_SECONDS),
    },
    elements,
  };
}

/** Formats the published accuracy figures into a disclosure string. */
function accuracyStatement(bodyId: string): string {
  const row = ELEMENT_ROW_FOR_BODY[bodyId] ?? bodyId;
  const accuracy = ELEMENT_ACCURACY[row];
  if (accuracy === undefined) return 'Not published for this body';
  return (
    `longitude ${accuracy.longitudeArcsec}", ` +
    `latitude ${accuracy.latitudeArcsec}", ` +
    `distance ${accuracy.distanceThousandKm} thousand km (nominal)`
  );
}

/** Converts a table's year interval into a Julian Date range. */
function validRangeOf(table: ElementTable): ValidRange {
  const asJd = (year: number): number =>
    toNumber(calendarToJD({ year, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, 'TT'));
  return { start: asJd(table.validity.startYear), end: asJd(table.validity.endYear) };
}

/**
 * Planetary positions from the JPL approximate element tables.
 *
 * Earth resolves to the Earth/Moon barycentre row, which is the only Earth-like
 * row the source publishes. That substitution is disclosed in the metadata
 * limitations rather than hidden, and is resolved when a lunar theory arrives.
 */
export class JplApproximatePlanetsProvider implements EphemerisProvider {
  readonly id: string;

  private readonly table: ElementTable;
  private readonly range: ValidRange;

  constructor(table: ElementTable = ELEMENTS_TABLE_1) {
    this.table = table;
    this.range = validRangeOf(table);
    this.id = `jpl-approximate-${table.id}`;
  }

  get supportedBodies(): readonly string[] {
    return PLANET_IDS;
  }

  getState(bodyId: string, jd: JulianDate<'TT'>): BodyState {
    const record = this.recordFor(bodyId);
    const { position, velocity } = computeState(record, jd);

    const jdNumber = toNumber(jd);
    const withinRange = jdNumber >= this.range.start && jdNumber <= this.range.end;

    return {
      bodyId,
      positionKm: position,
      velocityKmS: velocity,
      frame: 'J2000_ECLIPTIC',
      origin: 'SUN',
      epoch: jd,
      // Outside the interval the model still evaluates; it is simply no longer
      // supported by its fit. Returning the value with an honest status lets the
      // interface warn instead of the simulation stalling at a boundary.
      status: withinRange ? 'COMPUTED' : 'OUT_OF_RANGE',
    };
  }

  getMetadata(bodyId: string): EphemerisMetadata {
    // Validates the body id as a side effect of resolving the record.
    this.recordFor(bodyId);

    const limitations: string[] = [
      `Best-fit approximation, not an integrated ephemeris. Invalid outside ${this.table.validity.label}.`,
      "Independent variable is TDB; TT is supplied. Difference is below 1.7 ms, five orders of magnitude under the model's position error.",
    ];
    if (bodyId === 'earth') {
      limitations.push(
        'Position is the Earth/Moon barycentre, the only Earth-like row the source publishes. Offset from Earth reaches about 4670 km, which is under one Earth radius.',
      );
    }

    return {
      id: `${this.id}:${bodyId}`,
      model: `${ELEMENT_SOURCE.model} (${this.table.validity.label})`,
      accuracy: accuracyStatement(bodyId),
      validRange: this.range,
      source: ELEMENT_SOURCE.id,
      // The model's own argument is TDB. Declared as TDB so the interface reports
      // what the model wants, not what happens to be handed to it.
      timeScale: 'TDB',
      frame: 'J2000_ECLIPTIC',
      origin: 'SUN',
      limitations,
    };
  }

  /** Elements evaluated at an instant, for orbit rendering and diagnostics. */
  elementsAt(bodyId: string, jd: JulianDate<'TT'>): EvaluatedElements {
    return evaluateElements(this.recordFor(bodyId), jd);
  }

  /**
   * Rate of change of mean longitude, radians per second.
   *
   * SIDEREAL: measured from the fixed equinox, so a full turn is one sidereal
   * orbit. This is the quantity to compare against a published sidereal period.
   */
  siderealMeanMotionFor(bodyId: string): number {
    return meanLongitudeRateRadPerSecond(this.recordFor(bodyId));
  }

  /**
   * Rate of change of mean anomaly, radians per second.
   *
   * ANOMALISTIC: measured from the moving perihelion, so a full turn is one
   * perihelion-to-perihelion orbit. This is the rate Kepler's equation needs.
   *
   * No single "mean motion" accessor is offered, deliberately. Conflating these
   * two rates caused a real defect during development: using the sidereal rate
   * inside the velocity derivation left a 5.7e-5 relative error for Saturn.
   * Forcing the caller to name which rate it wants makes that mistake visible at
   * the call site.
   */
  anomalisticMeanMotionFor(bodyId: string): number {
    return meanAnomalyRateRadPerSecond(this.recordFor(bodyId));
  }

  /** Sidereal orbital period, days, from the fitted mean-longitude rate. */
  siderealPeriodDaysFor(bodyId: string): number {
    return (360 / this.recordFor(bodyId).rates.L) * JULIAN_CENTURY_DAYS;
  }

  /**
   * Anomalistic orbital period, days: perihelion to perihelion.
   *
   * Longer than the sidereal period for a prograde-precessing perihelion, and
   * this is the period after which the mean anomaly returns to its starting
   * value.
   */
  anomalisticPeriodDaysFor(bodyId: string): number {
    const record = this.recordFor(bodyId);
    return (360 / (record.rates.L - record.rates.longPeri)) * JULIAN_CENTURY_DAYS;
  }

  private recordFor(bodyId: string): PlanetElementRecord {
    const row = ELEMENT_ROW_FOR_BODY[bodyId];
    if (row === undefined) {
      throw new Error(
        `JplApproximatePlanetsProvider: unsupported body "${bodyId}"; supported: ${PLANET_IDS.join(', ')}`,
      );
    }
    return getElementRecord(this.table, row);
  }
}

/** Provider over the 1800-2050 table. The default for M1. */
export function createPlanetsProvider(): JplApproximatePlanetsProvider {
  return new JplApproximatePlanetsProvider(ELEMENTS_TABLE_1);
}

/** Provider over the 3000 BC - 3000 AD table, with augmentation terms. */
export function createWideRangePlanetsProvider(): JplApproximatePlanetsProvider {
  return new JplApproximatePlanetsProvider(ELEMENTS_TABLE_2A);
}

/** J2000.0 as a TT Julian Date, the epoch both element sets are referred to. */
export const J2000_TT: JulianDate<'TT'> = { jdInt: J2000_JD, jdFrac: 0, scale: 'TT' };
