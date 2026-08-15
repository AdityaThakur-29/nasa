/**
 * Physical parameters of the Sun, Moon and eight planets.
 *
 * SOURCE S2: https://ssd.jpl.nasa.gov/planets/phys_par.html
 * SOURCE S3: https://ssd.jpl.nasa.gov/astro_par.html (GM values, DE440)
 * SOURCE S4: NAIF pck00011.tpc (radii for bodies absent from S2)
 * SOURCE S5: IAU 2015 Resolution B3 (nominal solar radius)
 * See src/data/sources.md.
 *
 * WHAT THIS FILE DOES NOT CONTAIN: no visual radius, no exaggeration multiplier,
 * no colour, no texture path, no render hint of any kind. Contract section 2
 * requires every body to carry physicalRadiusKm, visualRadius and
 * visualRadiusMultiplier, but only the first of those is an astronomical
 * measurement. The other two are render-space quantities and are attached by
 * sim/scale.ts, so that section 39's one-way flow is not violated by the data
 * layer holding presentation state. Physical values here are authoritative and
 * are never scaled for visual purposes.
 *
 * UNCERTAINTY IS CARRIED, not discarded. A value quoted as 24764 +/- 15 km is
 * not the same claim as 24764 km, and the interface must be able to tell the
 * difference. Fields with a published uncertainty store it alongside the value.
 */

import {
  AU_KM,
  GM_SUN_KM3_S2,
  GRAVITATIONAL_CONSTANT,
  JULIAN_YEAR_DAYS,
  NOMINAL_SOLAR_RADIUS_M,
} from './constants';

/** A measured quantity with its published uncertainty, where one exists. */
export interface Measured {
  readonly value: number;
  /** Published uncertainty, same unit. Absent when the source quotes none. */
  readonly uncertainty?: number;
  readonly unit: string;
  /** Source identifier from sources.md. */
  readonly source: string;
}

/**
 * Whether a GM value describes the planet alone or the planet plus its
 * satellites.
 *
 * This distinction is a genuine trap. The JPL astrodynamic parameters page
 * publishes SYSTEM values from Mars outward, which include satellite mass. A
 * system GM is the correct choice for propagating the planet's heliocentric
 * orbit and the WRONG choice for propagating a satellite about that planet.
 * Jupiter's system GM exceeds the planet's own by roughly 0.03 percent, which is
 * small but not negligible for close satellites.
 */
export type GmScope = 'PLANET' | 'SYSTEM';

export interface BodyPhysical {
  readonly id: string;
  readonly displayName: string;

  /**
   * Parent in the gravitational hierarchy, or null for the Sun.
   *
   * Consumed by the hierarchical render-space transform, which must scale a
   * satellite's offset from its primary rather than its absolute heliocentric
   * vector; scaling the absolute vector compresses radially only and would
   * render a circular satellite orbit as an ellipse.
   */
  readonly parentId: string | null;

  /**
   * Volumetric mean radius, km. The value to use for display and for any
   * distance measurement involving a surface.
   *
   * From S2 where published. For the Sun and Moon, from S5 and S4 respectively.
   */
  readonly meanRadiusKm: Measured;

  /** Equatorial radius, km. Differs from mean radius for flattened bodies. */
  readonly equatorialRadiusKm: Measured;

  /** Mass, kilograms. */
  readonly massKg: Measured;

  /** Gravitational parameter, km^3/s^2, with its scope. */
  readonly gm: Measured & { readonly scope: GmScope };

  /** Bulk density, g/cm^3. */
  readonly bulkDensityGCm3?: Measured;

  /**
   * Sidereal rotation period, days.
   *
   * NEGATIVE denotes retrograde rotation, as published. Nothing in this project
   * branches on that sign; orientation comes from the IAU model in
   * iau-rotation.ts, where retrograde motion is simply a negative rate. This
   * field is for display and cross-validation against that model.
   */
  readonly siderealRotationPeriodDays?: Measured;

  /** Sidereal orbital period, Julian years. Absent for the Sun. */
  readonly siderealOrbitalPeriodYears?: Measured;

  /**
   * Absolute magnitude V(1,0), the visual magnitude at 1 au from both Sun and
   * observer at zero phase angle.
   *
   * Used to size the sub-pixel visibility markers so their brightness ordering
   * reflects real apparent brightness. Absent where no source value is
   * available, in which case the marker must fall back to a constant size
   * rather than a fabricated magnitude.
   */
  readonly absoluteMagnitudeV10?: Measured;

  /** Geometric albedo, dimensionless. */
  readonly geometricAlbedo?: Measured;

  /** Equatorial surface gravity, m/s^2. */
  readonly equatorialGravityMS2?: Measured;

  /** Escape velocity, km/s. */
  readonly escapeVelocityKmS?: Measured;

  /** Anything about this record a reader needs to know. */
  readonly note?: string;
}

/** Shorthand for an S2 measurement with uncertainty. */
function s2(value: number, unit: string, uncertainty?: number): Measured {
  return uncertainty === undefined
    ? { value, unit, source: 'S2' }
    : { value, uncertainty, unit, source: 'S2' };
}

/** Shorthand for a measurement from another source. */
function from(source: string, value: number, unit: string, uncertainty?: number): Measured {
  return uncertainty === undefined
    ? { value, unit, source }
    : { value, uncertainty, unit, source };
}

/**
 * Mass in kg from the S2 table, which publishes 10^24 kg for planets.
 * Kept as an explicit conversion so the exponent is visible at the call site.
 */
function massFrom1e24(value: number, uncertainty: number): Measured {
  return { value: value * 1e24, uncertainty: uncertainty * 1e24, unit: 'kg', source: 'S2' };
}

export const BODIES: Readonly<Record<string, BodyPhysical>> = {
  sun: {
    id: 'sun',
    displayName: 'Sun',
    parentId: null,
    // IAU nominal solar radius. A defined conversion constant, not a
    // measurement of a body whose limb is not a solid surface.
    meanRadiusKm: from('S5', NOMINAL_SOLAR_RADIUS_M / 1000, 'km'),
    equatorialRadiusKm: from('S5', NOMINAL_SOLAR_RADIUS_M / 1000, 'km'),
    // Derived from the DE440 GM and CODATA G. Inherits G's 2.2e-5 relative
    // uncertainty, which is why dynamics uses GM directly instead.
    massKg: from('S3+S3', (GM_SUN_KM3_S2 * 1e9) / GRAVITATIONAL_CONSTANT, 'kg'),
    gm: { ...from('S3', GM_SUN_KM3_S2, 'km^3/s^2'), scope: 'PLANET' },
    // Carrington sidereal rotation, from the IAU prime-meridian rate:
    // 360 / 14.18440 deg/day.
    siderealRotationPeriodDays: from('S4', 360 / 14.18440, 'd'),
    note: 'Radius and luminosity are IAU nominal DEFINED constants. Rotation is the Carrington convention; the Sun rotates differentially and has no solid surface.',
  },

  mercury: {
    id: 'mercury',
    displayName: 'Mercury',
    parentId: 'sun',
    meanRadiusKm: s2(2439.4, 'km', 0.1),
    equatorialRadiusKm: s2(2440.53, 'km', 0.04),
    massKg: massFrom1e24(0.330103, 0.000021),
    gm: { ...from('S3', 22_031.868551, 'km^3/s^2'), scope: 'PLANET' },
    bulkDensityGCm3: s2(5.4289, 'g/cm^3', 0.0007),
    siderealRotationPeriodDays: s2(58.6462, 'd'),
    siderealOrbitalPeriodYears: s2(0.2408467, 'y'),
    absoluteMagnitudeV10: s2(-0.60, 'mag', 0.10),
    geometricAlbedo: s2(0.106, 'dimensionless'),
    equatorialGravityMS2: s2(3.70, 'm/s^2'),
    escapeVelocityKmS: s2(4.25, 'km/s'),
  },

  venus: {
    id: 'venus',
    displayName: 'Venus',
    parentId: 'sun',
    meanRadiusKm: s2(6051.8, 'km', 1.0),
    equatorialRadiusKm: s2(6051.8, 'km', 1.0),
    massKg: massFrom1e24(4.86731, 0.00023),
    gm: { ...from('S3', 324_858.592, 'km^3/s^2'), scope: 'PLANET' },
    bulkDensityGCm3: s2(5.243, 'g/cm^3', 0.003),
    // Negative: retrograde, as published.
    siderealRotationPeriodDays: s2(-243.018, 'd'),
    siderealOrbitalPeriodYears: s2(0.61519726, 'y'),
    absoluteMagnitudeV10: s2(-4.47, 'mag', 0.07),
    geometricAlbedo: s2(0.65, 'dimensionless'),
    equatorialGravityMS2: s2(8.87, 'm/s^2'),
    escapeVelocityKmS: s2(10.36, 'km/s'),
    note: 'Retrograde rotation. Published radii are identical for all axes; Venus is very nearly spherical.',
  },

  earth: {
    id: 'earth',
    displayName: 'Earth',
    parentId: 'sun',
    meanRadiusKm: s2(6371.0084, 'km', 0.0001),
    equatorialRadiusKm: s2(6378.1366, 'km', 0.0001),
    massKg: massFrom1e24(5.97217, 0.00028),
    gm: { ...from('S3', 398_600.435507, 'km^3/s^2'), scope: 'PLANET' },
    bulkDensityGCm3: s2(5.5134, 'g/cm^3', 0.0003),
    siderealRotationPeriodDays: s2(0.99726968, 'd'),
    siderealOrbitalPeriodYears: s2(1.0000174, 'y'),
    absoluteMagnitudeV10: s2(-3.86, 'mag'),
    geometricAlbedo: s2(0.367, 'dimensionless'),
    equatorialGravityMS2: s2(9.80, 'm/s^2'),
    escapeVelocityKmS: s2(11.19, 'km/s'),
    note: 'In M1 Earth is drawn at the Earth/Moon barycentre, since the element set gives that point and no lunar theory exists yet. Offset reaches about 4670 km. Resolved in M4.',
  },

  moon: {
    id: 'moon',
    displayName: 'Moon',
    parentId: 'earth',
    meanRadiusKm: from('S4', 1737.4, 'km'),
    equatorialRadiusKm: from('S4', 1737.4, 'km'),
    massKg: from('S3+S3', (4902.800118 * 1e9) / GRAVITATIONAL_CONSTANT, 'kg'),
    gm: { ...from('S3', 4902.800118, 'km^3/s^2'), scope: 'PLANET' },
    // Derived from the IAU prime-meridian rate, 360 / 13.17635815 deg/day.
    // The Moon's rotation is synchronous with its orbit, so this also
    // approximates its sidereal orbital period.
    siderealRotationPeriodDays: from('S4', 360 / 13.17635815, 'd'),
    note: 'Absolute magnitude and geometric albedo are not carried: no value for them appears in the sources consulted, and markers must fall back to a constant size rather than use a fabricated magnitude. Position awaits the M4 ELP2000 provider.',
  },

  mars: {
    id: 'mars',
    displayName: 'Mars',
    parentId: 'sun',
    meanRadiusKm: s2(3389.50, 'km', 0.2),
    equatorialRadiusKm: s2(3396.19, 'km', 0.1),
    massKg: massFrom1e24(0.641691, 0.000030),
    // SYSTEM value: includes Phobos and Deimos.
    gm: { ...from('S3', 42_828.375816, 'km^3/s^2'), scope: 'SYSTEM' },
    bulkDensityGCm3: s2(3.9340, 'g/cm^3', 0.0007),
    siderealRotationPeriodDays: s2(1.02595676, 'd'),
    siderealOrbitalPeriodYears: s2(1.8808476, 'y'),
    absoluteMagnitudeV10: s2(-1.52, 'mag'),
    geometricAlbedo: s2(0.150, 'dimensionless'),
    equatorialGravityMS2: s2(3.71, 'm/s^2'),
    escapeVelocityKmS: s2(5.03, 'km/s'),
    note: 'GM is a SYSTEM value including Phobos and Deimos. Not valid for propagating those satellites.',
  },

  jupiter: {
    id: 'jupiter',
    displayName: 'Jupiter',
    parentId: 'sun',
    meanRadiusKm: s2(69911, 'km', 6),
    equatorialRadiusKm: s2(71492, 'km', 4),
    massKg: massFrom1e24(1898.125, 0.088),
    gm: { ...from('S3', 126_712_764.1, 'km^3/s^2'), scope: 'SYSTEM' },
    bulkDensityGCm3: s2(1.3262, 'g/cm^3', 0.0003),
    siderealRotationPeriodDays: s2(0.41354, 'd'),
    siderealOrbitalPeriodYears: s2(11.862615, 'y'),
    absoluteMagnitudeV10: s2(-9.40, 'mag'),
    geometricAlbedo: s2(0.52, 'dimensionless'),
    equatorialGravityMS2: s2(24.79, 'm/s^2'),
    escapeVelocityKmS: s2(60.20, 'km/s'),
    note: 'GM is a SYSTEM value. Rotation period is System III (magnetic field), the convention for a body with no solid surface.',
  },

  saturn: {
    id: 'saturn',
    displayName: 'Saturn',
    parentId: 'sun',
    meanRadiusKm: s2(58232, 'km', 6),
    equatorialRadiusKm: s2(60268, 'km', 4),
    massKg: massFrom1e24(568.317, 0.026),
    gm: { ...from('S3', 37_940_584.8418, 'km^3/s^2'), scope: 'SYSTEM' },
    bulkDensityGCm3: s2(0.6871, 'g/cm^3', 0.0002),
    siderealRotationPeriodDays: s2(0.44401, 'd'),
    siderealOrbitalPeriodYears: s2(29.447498, 'y'),
    absoluteMagnitudeV10: s2(-8.88, 'mag'),
    geometricAlbedo: s2(0.47, 'dimensionless'),
    equatorialGravityMS2: s2(10.44, 'm/s^2'),
    escapeVelocityKmS: s2(36.09, 'km/s'),
    note: 'GM is a SYSTEM value. Bulk density is below that of water. Flattening 0.098 from the IAU radii; the ring shadow geometry in M2 requires an oblate intersection test.',
  },

  uranus: {
    id: 'uranus',
    displayName: 'Uranus',
    parentId: 'sun',
    meanRadiusKm: s2(25362, 'km', 7),
    equatorialRadiusKm: s2(25559, 'km', 4),
    massKg: massFrom1e24(86.8099, 0.0040),
    gm: { ...from('S3', 5_794_556.4, 'km^3/s^2'), scope: 'SYSTEM' },
    bulkDensityGCm3: s2(1.270, 'g/cm^3', 0.001),
    siderealRotationPeriodDays: s2(-0.71833, 'd'),
    siderealOrbitalPeriodYears: s2(84.016846, 'y'),
    absoluteMagnitudeV10: s2(-7.19, 'mag'),
    geometricAlbedo: s2(0.51, 'dimensionless'),
    equatorialGravityMS2: s2(8.87, 'm/s^2'),
    escapeVelocityKmS: s2(21.38, 'km/s'),
    note: 'GM is a SYSTEM value. Retrograde rotation. Obliquity near 97.8 deg emerges from the IAU pole declination of -15.175 deg, not from any special case.',
  },

  neptune: {
    id: 'neptune',
    displayName: 'Neptune',
    parentId: 'sun',
    meanRadiusKm: s2(24622, 'km', 19),
    equatorialRadiusKm: s2(24764, 'km', 15),
    massKg: massFrom1e24(102.4092, 0.0048),
    gm: { ...from('S3', 6_836_527.10058, 'km^3/s^2'), scope: 'SYSTEM' },
    bulkDensityGCm3: s2(1.638, 'g/cm^3', 0.004),
    siderealRotationPeriodDays: s2(0.67125, 'd'),
    siderealOrbitalPeriodYears: s2(164.79132, 'y'),
    absoluteMagnitudeV10: s2(-6.87, 'mag'),
    geometricAlbedo: s2(0.41, 'dimensionless'),
    equatorialGravityMS2: s2(11.15, 'm/s^2'),
    escapeVelocityKmS: s2(23.56, 'km/s'),
    note:
      'GM is a SYSTEM value. ROTATION PERIOD CONFLICTS WITH S4, measured: this published ' +
      '0.671250 d corresponds to the superseded IAU rate of 536.3128492 deg/day, not the ' +
      'current 541.1397757 deg/day, which gives 0.665262 d. A 0.89 percent disagreement. ' +
      'Orientation is driven by the current S4 rate; this value is display-only. Neptune is ' +
      'the only body where the two sources disagree beyond rounding.',
  },
};

/** Ordered outward from the Sun. Used for deterministic iteration and display. */
export const BODY_ORDER: readonly string[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];

/** Bodies whose heliocentric position comes from the JPL element tables. */
export const PLANET_IDS: readonly string[] = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];

/**
 * Maps a body id to the element-table row that supplies its position.
 *
 * Earth maps to the Earth/Moon barycentre row, which is the only Earth-like row
 * the source publishes. See EMBARY_LIMITATION in jpl-elements.ts.
 */
export const ELEMENT_ROW_FOR_BODY: Readonly<Record<string, string>> = {
  mercury: 'mercury',
  venus: 'venus',
  earth: 'embary',
  mars: 'mars',
  jupiter: 'jupiter',
  saturn: 'saturn',
  uranus: 'uranus',
  neptune: 'neptune',
};

/** Looks up a physical record, or throws listing the available ids. */
export function getBody(bodyId: string): BodyPhysical {
  const record = BODIES[bodyId];
  if (record === undefined) {
    throw new Error(`bodies: no record for "${bodyId}"; available: ${Object.keys(BODIES).join(', ')}`);
  }
  return record;
}

/**
 * Mass implied by a GM value and the CODATA G, kilograms.
 *
 * Provided for cross-checking the S2 masses against the S3 GM values. Agreement
 * is limited by G's 2.2e-5 relative uncertainty, so a check must allow at least
 * that much slack. Dynamics should use GM directly and never route through this.
 */
export function massFromGm(gmKm3S2: number): number {
  return (gmKm3S2 * 1e9) / GRAVITATIONAL_CONSTANT;
}

/**
 * Orbital period implied by a semi-major axis under the two-body approximation,
 * in days. Kepler's third law with the heliocentric GM.
 *
 * For cross-checking the published periods against the element semi-major axes.
 * The residual is not zero, because the published periods come from full
 * ephemerides that include planetary perturbations.
 */
export function twoBodyPeriodDays(semiMajorAxisAu: number): number {
  const aKm = semiMajorAxisAu * AU_KM;
  const seconds = 2 * Math.PI * Math.sqrt((aKm * aKm * aKm) / GM_SUN_KM3_S2);
  return seconds / 86_400;
}

/** Converts a period in Julian years to days. */
export function yearsToDays(years: number): number {
  return years * JULIAN_YEAR_DAYS;
}
