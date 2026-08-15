/**
 * IAU rotational elements and triaxial radii.
 *
 * SOURCE S4: NAIF generic PCK pck00011.tpc, which encodes Archinal, B. A. et
 * al., "Report of the IAU Working Group on Cartographic Coordinates and
 * Rotational Elements: 2015", Celestial Mechanics and Dynamical Astronomy.
 * Retrieved 2026-08-15. See src/data/sources.md.
 *
 * ONLY the kernel's CURRENT (uppercase) assignments are used. The kernel also
 * retains superseded lowercase assignments for historical reference; mixing the
 * two would silently pair a modern pole with an obsolete rotation rate. Where
 * the two differ materially the discrepancy is recorded in the record below.
 *
 * WHY THIS REPLACES A CONSTANT AXIAL TILT (contract section 15): orientation is
 * a polynomial in time about a pole specified in equatorial coordinates, not a
 * fixed angle about a fixed axis. Expressing it this way makes the awkward
 * bodies fall out of the data rather than out of special-case code:
 *
 *   - Venus rotates retrograde. Its prime-meridian rate is simply negative
 *     (-1.4813688 deg/day). No branch tests for it.
 *   - Uranus has a pole declination of -15.175 deg, which yields an obliquity
 *     near 97.8 deg and the familiar sideways orientation. No branch.
 *   - Earth's pole itself drifts, at -0.641 and -0.557 deg/century.
 *
 * MODEL, per the source:
 *
 *   alpha = a0 + a1 T + a2 T^2 + SUM( amplitude * sin(angle) )
 *   delta = d0 + d1 T + d2 T^2 + SUM( amplitude * cos(angle) )
 *   W     = W0 + Wdot d + W2 d^2 + SUM( amplitude * sin(angle) )
 *
 * where T is Julian centuries past J2000 TDB and d is days past J2000 TDB.
 * Note the asymmetry: alpha and W take sines, delta takes cosines. This is the
 * published convention, not a transcription slip.
 *
 * This module holds DATA ONLY. The evaluation of these polynomials lives in the
 * ephemeris layer, so the data layer stays free of behaviour.
 */

/** Polynomial coefficients: constant, linear, quadratic. */
export type PolynomialTriple = readonly [number, number, number];

/**
 * A periodic argument, in the form  angle = offset + rate * T,  with T in
 * Julian centuries past J2000. Amplitudes below reference these by index.
 */
export interface NutationAngle {
  /** Human-readable name from the IAU report, e.g. "N" for Neptune. */
  readonly name: string;
  /** Constant term, degrees. */
  readonly offset: number;
  /** Rate, degrees per Julian century. */
  readonly rate: number;
  /**
   * Quadratic term, degrees per Julian century squared. Absent means zero.
   *
   * Only one angle in the whole kernel uses this (Mars angle 5, which serves
   * Phobos and Deimos rather than Mars itself). Transcribed for fidelity so the
   * data matches the source even where this project does not consume it.
   */
  readonly rateQuadratic?: number;
}

/**
 * Periodic corrections to pole and prime meridian.
 *
 * Arrays are index-aligned with `angles`. A zero amplitude means that angle
 * contributes nothing to that quantity, which is common; the source publishes
 * long zero-padded vectors and the padding is preserved so indices line up.
 */
export interface NutationTerms {
  readonly angles: readonly NutationAngle[];
  /** Amplitudes applied as sin(angle) to right ascension, degrees. */
  readonly raAmplitudes: readonly number[];
  /** Amplitudes applied as cos(angle) to declination, degrees. */
  readonly decAmplitudes: readonly number[];
  /** Amplitudes applied as sin(angle) to the prime meridian, degrees. */
  readonly pmAmplitudes: readonly number[];
}

/**
 * Triaxial radii as published. Equal values indicate a body modelled as a
 * sphere by the IAU, not a body known to be perfectly spherical.
 */
export interface TriaxialRadii {
  /** Semi-axis toward the prime meridian, km. */
  readonly aKm: number;
  /** Semi-axis perpendicular to that, in the equatorial plane, km. */
  readonly bKm: number;
  /** Polar semi-axis, km. */
  readonly cKm: number;
}

export interface IauRotationRecord {
  readonly id: string;
  /** NAIF integer body code, for cross-referencing the kernel. */
  readonly naifId: number;
  /** Pole right ascension polynomial in T, degrees. */
  readonly poleRa: PolynomialTriple;
  /** Pole declination polynomial in T, degrees. */
  readonly poleDec: PolynomialTriple;
  /**
   * Prime meridian polynomial. Constant term is degrees; linear term is
   * degrees per DAY, not per century; quadratic is degrees per day squared.
   * A negative linear term denotes retrograde rotation.
   */
  readonly primeMeridian: PolynomialTriple;
  readonly radii: TriaxialRadii;
  /** Present only where periodic terms are implemented for this body. */
  readonly nutation?: NutationTerms;
  /** Any material discrepancy or omission worth surfacing. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Periodic argument definitions
// ---------------------------------------------------------------------------

/**
 * Neptune's single precession angle N, from BODY8_NUT_PREC_ANGLES.
 *
 * Amplitudes reach 0.70 deg in right ascension, which is large enough to be
 * visible as a pole wobble, so this one is implemented rather than omitted.
 */
const NEPTUNE_ANGLES: readonly NutationAngle[] = [
  { name: 'N', offset: 357.85, rate: 52.316 },
];

/**
 * Mercury's libration arguments M1..M5, from BODY1_NUT_PREC_ANGLES.
 *
 * Rates are published in the kernel in exponential form; transcribed here as
 * plain decimals with the same value.
 */
const MERCURY_ANGLES: readonly NutationAngle[] = [
  { name: 'M1', offset: 174.7910857, rate: 149472.53587500003 },
  { name: 'M2', offset: 349.5821714, rate: 298945.07175000006 },
  { name: 'M3', offset: 164.3732571, rate: 448417.60762500006 },
  { name: 'M4', offset: 339.1643429, rate: 597890.1435000001 },
  { name: 'M5', offset: 153.9554286, rate: 747362.6793749999 },
];

/**
 * The Mars system's 26 precession angles, from BODY4_NUT_PREC_ANGLES.
 *
 * WHY ALL 26 ARE PRESENT even though Mars itself uses only a few: the amplitude
 * vectors are INDEX-ALIGNED with this list. Mars's declination amplitudes place
 * their largest term at index 20 and its prime-meridian amplitudes at index 26,
 * so dropping the intervening angles would silently pair large amplitudes with
 * the wrong arguments. Most amplitudes are zero; the indices are not optional.
 *
 * Angle 5 carries the only quadratic rate in the kernel. It serves Phobos and
 * Deimos rather than Mars, and is transcribed for fidelity.
 *
 * Angles 15, 20 and 26 share a rate of 0.5042615 deg/century, a period near
 * 714,000 years. Those three carry the structural terms discussed on the Mars
 * record below.
 */
const MARS_SYSTEM_ANGLES: readonly NutationAngle[] = [
  { name: 'M1', offset: 190.72646643, rate: 15917.10818695 },
  { name: 'M2', offset: 21.46892470, rate: 31834.27934054 },
  { name: 'M3', offset: 332.86082793, rate: 19139.89694742 },
  { name: 'M4', offset: 394.93256437, rate: 38280.79631835 },
  { name: 'M5', offset: 189.63271560, rate: 41215158.18420050, rateQuadratic: 12.711923222 },
  { name: 'M6', offset: 121.46893664, rate: 660.22803474 },
  { name: 'M7', offset: 231.05028581, rate: 660.99123540 },
  { name: 'M8', offset: 251.37314025, rate: 1320.50145245 },
  { name: 'M9', offset: 217.98635955, rate: 38279.96125550 },
  { name: 'M10', offset: 196.19729402, rate: 19139.83628608 },
  { name: 'M11', offset: 198.991226, rate: 19139.4819985 },
  { name: 'M12', offset: 226.292679, rate: 38280.8511281 },
  { name: 'M13', offset: 249.663391, rate: 57420.7251593 },
  { name: 'M14', offset: 266.183510, rate: 76560.6367950 },
  { name: 'M15', offset: 79.398797, rate: 0.5042615 },
  { name: 'M16', offset: 122.433576, rate: 19139.9407476 },
  { name: 'M17', offset: 43.058401, rate: 38280.8753272 },
  { name: 'M18', offset: 57.663379, rate: 57420.7517205 },
  { name: 'M19', offset: 79.476401, rate: 76560.6495004 },
  { name: 'M20', offset: 166.325722, rate: 0.5042615 },
  { name: 'M21', offset: 129.071773, rate: 19140.0328244 },
  { name: 'M22', offset: 36.352167, rate: 38281.0473591 },
  { name: 'M23', offset: 56.668646, rate: 57420.9295360 },
  { name: 'M24', offset: 67.364003, rate: 76560.2552215 },
  { name: 'M25', offset: 104.792680, rate: 95700.4387578 },
  { name: 'M26', offset: 95.391654, rate: 0.5042615 },
];

// ---------------------------------------------------------------------------
// Records, verbatim from the kernel's current assignments
// ---------------------------------------------------------------------------

export const IAU_ROTATION: Readonly<Record<string, IauRotationRecord>> = {
  /**
   * Sun. The prime-meridian rate is the Carrington sidereal rotation, a
   * convention for tracking solar features rather than the rotation of a solid
   * surface; the Sun rotates differentially and has no such surface.
   */
  sun: {
    id: 'sun',
    naifId: 10,
    poleRa: [286.13, 0, 0],
    poleDec: [63.87, 0, 0],
    primeMeridian: [84.176, 14.18440, 0],
    radii: { aKm: 695700, bKm: 695700, cKm: 695700 },
    note: 'Prime-meridian rate is the Carrington convention; the Sun rotates differentially.',
  },

  mercury: {
    id: 'mercury',
    naifId: 199,
    poleRa: [281.0103, -0.0328, 0],
    poleDec: [61.4155, -0.0049, 0],
    primeMeridian: [329.5988, 6.1385108, 0],
    radii: { aKm: 2440.53, bKm: 2440.53, cKm: 2438.26 },
    nutation: {
      angles: MERCURY_ANGLES,
      raAmplitudes: [0, 0, 0, 0, 0],
      decAmplitudes: [0, 0, 0, 0, 0],
      // Libration in longitude, peak amplitude about 0.011 deg.
      pmAmplitudes: [0.01067257, -0.00112309, -0.00011040, -0.00002539, -0.00000571],
    },
  },

  /**
   * Venus. Retrograde rotation appears purely as a negative prime-meridian
   * rate. Nothing in this project tests for retrograde motion.
   */
  venus: {
    id: 'venus',
    naifId: 299,
    poleRa: [272.76, 0, 0],
    poleDec: [67.16, 0, 0],
    primeMeridian: [160.20, -1.4813688, 0],
    radii: { aKm: 6051.8, bKm: 6051.8, cKm: 6051.8 },
    note: 'Retrograde rotation, expressed as a negative prime-meridian rate.',
  },

  /**
   * Earth. Radii are the IAU/WGS-style reference ellipsoid; flattening works
   * out near 1/298.25.
   *
   * The kernel's linear pole terms describe the drift of the pole in the
   * inertial frame. This is a low-order model and is not a substitute for a
   * full precession-nutation theory, which M1 does not require.
   */
  earth: {
    id: 'earth',
    naifId: 399,
    poleRa: [0.0, -0.641, 0],
    poleDec: [90.0, -0.557, 0],
    primeMeridian: [190.147, 360.9856235, 0],
    radii: { aKm: 6378.1366, bKm: 6378.1366, cKm: 6356.7519 },
    note: 'Low-order pole drift only; not a full precession-nutation theory.',
  },

  /**
   * Moon. The prime-meridian quadratic term is genuinely -1.4e-12, not a typo.
   *
   * The kernel publishes a 13-term libration series with amplitudes up to about
   * 3.9 deg, which is far too large to discard. It is deliberately NOT
   * transcribed here: the Moon receives a dedicated ELP2000 provider in M4, and
   * a partial libration model in the interim would be an undocumented
   * half-measure. Recorded in sources.md as a deliberate omission.
   */
  moon: {
    id: 'moon',
    naifId: 301,
    poleRa: [269.9949, 0.0031, 0],
    poleDec: [66.5392, 0.0130, 0],
    primeMeridian: [38.3213, 13.17635815, -1.4e-12],
    radii: { aKm: 1737.4, bKm: 1737.4, cKm: 1737.4 },
    note: 'IAU libration series (13 terms, up to 3.9 deg) omitted pending the M4 ELP2000 provider.',
  },

  /**
   * Mars. Its periodic terms are STRUCTURAL, not refinements, and omitting them
   * is not an approximation but a wrong model.
   *
   * MEASURED EVIDENCE. The IAU 2015 report moved a large slowly-varying
   * component out of Mars's constant terms and into the periodic series.
   * Evaluating the current model at J2000 reproduces the superseded 2009
   * constants almost exactly, which is only possible because those periodic
   * terms are carrying the difference:
   *
   *   RA:  317.269202 + 0.419057 sin(79.398797 deg)  = 317.68121
   *        superseded constant                        = 317.68143   (0.0002 deg)
   *   Dec:  54.432516 + 1.591274 cos(166.325722 deg) =  52.88615
   *        superseded constant                        =  52.88650   (0.0004 deg)
   *   W:   176.049863 + 0.584542 sin(95.391654 deg)  = 176.63180
   *        superseded constant                        = 176.630     (0.0018 deg)
   *
   * The three arguments share a rate of 0.5042615 deg/century, a period near
   * 714,000 years, so over any interval this project simulates they behave as
   * near-constant offsets rather than as visible oscillations.
   *
   * An earlier revision of this file omitted these terms and claimed in a comment
   * that Mars's omitted terms were "below 0.001 deg". That was wrong by three
   * orders of magnitude: the declination amplitude is 1.591274 deg. The error
   * surfaced as a 1.27 deg discrepancy between the computed obliquity and the
   * published 25.19 deg, which is recorded here so the omission cannot recur.
   */
  mars: {
    id: 'mars',
    naifId: 499,
    poleRa: [317.269202, -0.10927547, 0],
    poleDec: [54.432516, -0.05827105, 0],
    primeMeridian: [176.049863, 350.891982443297, 0],
    radii: { aKm: 3396.19, bKm: 3396.19, cKm: 3376.20 },
    nutation: {
      angles: MARS_SYSTEM_ANGLES,
      // Index-aligned with MARS_SYSTEM_ANGLES. Trailing zeros are omitted, as
      // SPICE permits; the evaluator pads them.
      raAmplitudes: [
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0.000068, 0.000238, 0.000052, 0.000009, 0.419057,
      ],
      decAmplitudes: [
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0.000051, 0.000141, 0.000031, 0.000005, 1.591274,
      ],
      pmAmplitudes: [
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0, 0, 0, 0, 0,
        0.000145, 0.000157, 0.000040, 0.000001, 0.000001, 0.584542,
      ],
    },
  },

  /**
   * Jupiter. The kernel's periodic amplitudes peak near 0.0014 deg, which is
   * far below the angular resolution of any view in this project, so they are
   * omitted. The omission is recorded rather than silent.
   */
  jupiter: {
    id: 'jupiter',
    naifId: 599,
    poleRa: [268.056595, -0.006499, 0],
    poleDec: [64.495303, 0.002413, 0],
    primeMeridian: [284.95, 870.5360000, 0],
    radii: { aKm: 71492, bKm: 71492, cKm: 66854 },
    note:
      'Periodic terms omitted; largest published amplitude is 0.00215 deg in right ascension ' +
      '(kernel angles JA-JE), which is below the angular resolution of any view in this project. ' +
      'Unlike Mars, these are genuine refinements rather than structural terms: the 2015 report ' +
      "leaves Jupiter's constant terms unchanged from 2009. Rotation rate is System III (magnetic field).",
  },

  /**
   * Saturn. Flattening from these radii is (60268 - 54364) / 60268 = 0.0980,
   * the value the ring shadow geometry in M2 depends on. An oblate intersection
   * test is required there; a spherical one is visibly wrong at the ring plane.
   */
  saturn: {
    id: 'saturn',
    naifId: 699,
    poleRa: [40.589, -0.036, 0],
    poleDec: [83.537, -0.004, 0],
    primeMeridian: [38.90, 810.7939024, 0],
    radii: { aKm: 60268, bKm: 60268, cKm: 54364 },
    note: 'Flattening 0.0980. Rotation rate is System III.',
  },

  /**
   * Uranus. The negative pole declination is what produces the roughly 97.8 deg
   * obliquity and the accompanying retrograde prime-meridian rate. Both come
   * straight from the data.
   */
  uranus: {
    id: 'uranus',
    naifId: 799,
    poleRa: [257.311, 0, 0],
    poleDec: [-15.175, 0, 0],
    primeMeridian: [203.81, -501.1600928, 0],
    radii: { aKm: 25559, bKm: 25559, cKm: 24973 },
    note: 'Pole below the ecliptic; obliquity near 97.8 deg emerges from the pole, not a special case.',
  },

  /**
   * Neptune. Uses the CURRENT prime-meridian rate of 541.1397757 deg/day. The
   * kernel also retains a superseded value of 536.3128492 deg/day; the two
   * differ by roughly 4.83 deg/day, which would accumulate to a completely
   * wrong rotation phase within days. Only the current value is used.
   */
  neptune: {
    id: 'neptune',
    naifId: 899,
    poleRa: [299.36, 0, 0],
    poleDec: [43.46, 0, 0],
    primeMeridian: [249.978, 541.1397757, 0],
    radii: { aKm: 24764, bKm: 24764, cKm: 24341 },
    nutation: {
      angles: NEPTUNE_ANGLES,
      raAmplitudes: [0.70],
      decAmplitudes: [-0.51],
      pmAmplitudes: [-0.48],
    },
    note:
      'CROSS-SOURCE CONFLICT, measured. The S2 physical-parameters page publishes a ' +
      'sidereal rotation period of 0.671250 d, which corresponds exactly to the ' +
      "kernel's SUPERSEDED rate of 536.3128492 deg/day (360/536.3128492 = 0.671250). " +
      'The current rate of 541.1397757 deg/day gives 0.665262 d instead, a 0.89 percent ' +
      'difference. S2 has not been updated to the 2015 IAU value. This module uses the ' +
      'current S4 rate because orientation is its responsibility; the S2 period is ' +
      'retained in bodies.ts for display and is flagged there. Do not "fix" the ' +
      'disagreement by reverting to the superseded rate.',
  },
};

/** Provenance, kept beside the data so no interface code hardcodes it. */
export const ROTATION_SOURCE = {
  id: 'S4',
  model: 'IAU WGCCRE 2015 rotational elements',
  origin: 'Archinal et al., IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015',
  encoding: 'NAIF generic PCK pck00011.tpc',
  url: 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc',
  frame: 'ICRF / J2000 equatorial',
  timeArgument: 'TDB, supplied as TT; see sources.md S1',
  retrieved: '2026-08-15',
} as const;

/** Field-level provenance, per the section 12 requirement. */
export const FIELD_SOURCES = {
  poleRa: { unit: 'degrees, degrees/century', source: 'S4', description: 'pole right ascension' },
  poleDec: { unit: 'degrees, degrees/century', source: 'S4', description: 'pole declination' },
  primeMeridian: { unit: 'degrees, degrees/day', source: 'S4', description: 'prime meridian angle' },
  radii: { unit: 'km', source: 'S4', description: 'triaxial semi-axes' },
} as const;

/** Looks up a rotation record, or throws listing the available ids. */
export function getRotationRecord(bodyId: string): IauRotationRecord {
  const record = IAU_ROTATION[bodyId];
  if (record === undefined) {
    throw new Error(
      `iau-rotation: no record for "${bodyId}"; available: ${Object.keys(IAU_ROTATION).join(', ')}`,
    );
  }
  return record;
}

/**
 * Geometric flattening, (a - c) / a, derived from the published radii.
 *
 * Derived rather than quoted, so it cannot drift out of step with the radii it
 * comes from.
 */
export function flattening(record: IauRotationRecord): number {
  return (record.radii.aKm - record.radii.cKm) / record.radii.aKm;
}

/**
 * Mean radius, the cube root of the product of the three semi-axes.
 *
 * This is the volumetric mean and is NOT identical to the mean radius published
 * on the JPL physical-parameters page, which is derived from a shape model. For
 * Earth this yields 6371.0008 km against the published 6371.0084 km, a
 * difference of about 8 m. Use the published value for display; this helper
 * exists for geometry that needs a radius consistent with the ellipsoid above.
 */
export function volumetricMeanRadiusKm(record: IauRotationRecord): number {
  const { aKm, bKm, cKm } = record.radii;
  return Math.cbrt(aKm * bKm * cKm);
}
