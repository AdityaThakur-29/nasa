/**
 * IAU body orientation.
 *
 * SOURCE S4: IAU WGCCRE 2015 rotational elements, via NAIF pck00011.tpc.
 * Data lives in src/data/iau-rotation.ts; this module only evaluates it.
 *
 * MODEL:
 *   alpha = a0 + a1 T + a2 T^2 + SUM( amplitude_i * sin(angle_i) )
 *   delta = d0 + d1 T + d2 T^2 + SUM( amplitude_i * cos(angle_i) )
 *   W     = W0 + Wdot d + W2 d^2 + SUM( amplitude_i * sin(angle_i) )
 *
 * T is Julian centuries past J2000, d is days past J2000. Note the asymmetry:
 * alpha and W take sines, delta takes cosines. That is the published convention.
 *
 * WHY THIS REPLACES A CONSTANT TILT (contract section 15): orientation is a
 * time-dependent pole direction plus a rotating prime meridian, not a fixed
 * angle about a fixed axis. Expressing it as published means the awkward bodies
 * need no special handling at all:
 *
 *   Venus  - Wdot is negative, so it rotates retrograde.
 *   Uranus - delta0 is -15.175 deg, so its pole lies below the ecliptic and its
 *            obliquity comes out near 98 deg.
 *
 * Neither body is named anywhere in this module's logic.
 *
 * NO RENDER TYPES. Rotations are returned as plain arrays and plain objects, so
 * the simulation layer never imports from the renderer. Converting to a
 * three.js Quaternion is the render layer's job.
 */

import { centuriesSinceJ2000, daysSinceJ2000, type JulianDate } from '../core/jd';
import { DEG_TO_RAD, RAD_TO_DEG } from '../data/constants';
import {
  type IauRotationRecord,
  type NutationTerms,
  ROTATION_SOURCE,
  getRotationRecord,
} from '../data/iau-rotation';
import { type Vector3Like, cross, dot, magnitude, scale } from './kepler';

/**
 * Row-major 3x3 matrix, as a fixed-length tuple.
 *
 * A tuple rather than number[][] so the compiler knows the length and index
 * access is not possibly-undefined under noUncheckedIndexedAccess.
 */
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

/** Quaternion with a positive-real convention. Plain object, no render types. */
export interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** Evaluated orientation angles, degrees, plus the derived frame. */
export interface Orientation {
  readonly bodyId: string;
  /** Pole right ascension, degrees, in the J2000 equatorial frame. */
  readonly poleRaDeg: number;
  /** Pole declination, degrees. */
  readonly poleDecDeg: number;
  /** Prime meridian angle, degrees, wrapped to [0, 360). */
  readonly primeMeridianDeg: number;
  /** Unit vector along the body's north pole, J2000 equatorial. */
  readonly northPole: Vector3Like;
  /**
   * Body-fixed to J2000-equatorial rotation.
   *
   * Columns are the body's x, y and z axes expressed in the inertial frame, so
   * multiplying a body-fixed vector by this matrix gives the inertial vector.
   */
  readonly bodyToInertial: Matrix3;
  /** Same rotation as a quaternion. */
  readonly quaternion: QuaternionLike;
  /** True when the prime meridian rate is negative. */
  readonly retrograde: boolean;
  /** Instant this orientation was evaluated for. */
  readonly epoch: JulianDate;
}

/** Wraps degrees to [0, 360). */
function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Sums the periodic corrections.
 *
 * Amplitude arrays are index-aligned with the angle list. A length mismatch
 * means the transcription is misaligned, which would silently apply the wrong
 * amplitude to the wrong argument, so it throws rather than proceeding.
 */
function nutationSum(
  terms: NutationTerms,
  centuriesPastJ2000: number,
  amplitudes: readonly number[],
  trigonometric: (radians: number) => number,
  label: string,
): number {
  // A SHORTER amplitude vector is legitimate and common: SPICE treats absent
  // trailing amplitudes as zero, so the published data omits them. Mars is the
  // clear case, with 15 right-ascension amplitudes, 20 for declination and 26
  // for the prime meridian, all sharing one 26-entry angle list.
  //
  // A LONGER amplitude vector than the angle list cannot be padded and means the
  // transcription is misaligned, which would pair amplitudes with the wrong
  // arguments. That is rejected rather than silently truncated.
  if (amplitudes.length > terms.angles.length) {
    throw new Error(
      `orientation: ${label} has ${amplitudes.length} amplitudes for only ` +
        `${terms.angles.length} angles; the transcription is misaligned`,
    );
  }

  let total = 0;
  for (let i = 0; i < amplitudes.length; i++) {
    const amplitude = amplitudes[i]!;
    if (amplitude === 0) continue;

    const angle = terms.angles[i]!;
    // Quadratic term is present on exactly one argument in the whole kernel.
    const quadratic = angle.rateQuadratic ?? 0;
    const argumentDeg =
      angle.offset +
      angle.rate * centuriesPastJ2000 +
      quadratic * centuriesPastJ2000 * centuriesPastJ2000;

    total += amplitude * trigonometric(argumentDeg * DEG_TO_RAD);
  }
  return total;
}

/** Evaluates a quadratic in the supplied variable. */
function polynomial(coefficients: readonly [number, number, number], variable: number): number {
  return coefficients[0] + coefficients[1] * variable + coefficients[2] * variable * variable;
}

/**
 * Pole right ascension and declination, degrees.
 *
 * Both polynomials take T in centuries. Declination takes cosines of the
 * periodic arguments; right ascension takes sines.
 */
export function poleDirectionDeg(
  record: IauRotationRecord,
  jdTT: JulianDate<'TT'>,
): { readonly raDeg: number; readonly decDeg: number } {
  const T = centuriesSinceJ2000(jdTT);

  let raDeg = polynomial(record.poleRa, T);
  let decDeg = polynomial(record.poleDec, T);

  if (record.nutation !== undefined) {
    raDeg += nutationSum(record.nutation, T, record.nutation.raAmplitudes, Math.sin, `${record.id} pole RA`);
    decDeg += nutationSum(
      record.nutation,
      T,
      record.nutation.decAmplitudes,
      Math.cos,
      `${record.id} pole Dec`,
    );
  }

  return { raDeg, decDeg };
}

/**
 * Prime meridian angle, degrees, wrapped to [0, 360).
 *
 * The linear term is degrees per DAY, not per century, so this polynomial takes
 * d rather than T. Mixing the two would scale the rotation rate by 36525.
 */
export function primeMeridianDeg(record: IauRotationRecord, jdTT: JulianDate<'TT'>): number {
  const d = daysSinceJ2000(jdTT);
  let w = polynomial(record.primeMeridian, d);

  if (record.nutation !== undefined) {
    // Periodic arguments are defined in centuries even though W's polynomial is
    // in days, so this term takes T while the polynomial above takes d.
    const T = centuriesSinceJ2000(jdTT);
    w += nutationSum(record.nutation, T, record.nutation.pmAmplitudes, Math.sin, `${record.id} W`);
  }

  return wrapDegrees(w);
}

/** Unit vector for a right ascension and declination, in radians. */
function directionFromRaDec(raRad: number, decRad: number): Vector3Like {
  const cosDec = Math.cos(decRad);
  return {
    x: cosDec * Math.cos(raRad),
    y: cosDec * Math.sin(raRad),
    z: Math.sin(decRad),
  };
}

/**
 * Builds the body-fixed to inertial rotation from the three IAU angles.
 *
 * DERIVED HERE rather than quoted, because the published matrix form is easy to
 * transcribe with the wrong sign or in the wrong composition order. Every step
 * below is checkable:
 *
 * 1. The body's north pole in the inertial frame is the direction (alpha, delta):
 *
 *      zb = (cos d cos a, cos d sin a, sin d)
 *
 * 2. W is measured from the node of the body's equator on the J2000 equator. The
 *    body equator has normal zb and the inertial equator has normal
 *    zi = (0,0,1), so their line of intersection lies along
 *
 *      zi x zb = cos(d) * (-sin a, cos a, 0)
 *
 *    Since cos(d) >= 0 for any declination in [-90, 90], the unit node vector is
 *
 *      Q = (-sin a, cos a, 0)
 *
 *    which is the direction at right ascension alpha + 90 degrees. That is where
 *    the "+90" in the published form comes from.
 *
 * 3. Q is perpendicular to zb, so { Q, zb x Q } is an orthonormal basis of the
 *    body's equatorial plane. Rotating from Q by W about zb, right-handed and so
 *    eastward, gives the prime meridian direction:
 *
 *      xb = cos(W) Q + sin(W) (zb x Q)
 *
 * 4. yb = zb x xb completes a right-handed triad.
 *
 * The columns xb, yb, zb are the body axes in inertial coordinates, so the
 * matrix maps body-fixed vectors to inertial vectors.
 *
 * A retrograde body needs nothing special: its W decreases with time, so xb
 * sweeps the other way around zb on its own.
 */
export function buildRotationMatrix(
  poleRaDeg: number,
  poleDecDeg: number,
  wDeg: number,
): { readonly matrix: Matrix3; readonly northPole: Vector3Like } {
  const raRad = poleRaDeg * DEG_TO_RAD;
  const decRad = poleDecDeg * DEG_TO_RAD;
  const wRad = wDeg * DEG_TO_RAD;

  const zb = directionFromRaDec(raRad, decRad);

  // Node of the body equator on the inertial equator, at RA = alpha + 90 deg.
  const q: Vector3Like = { x: -Math.sin(raRad), y: Math.cos(raRad), z: 0 };

  // Second basis vector of the body's equatorial plane.
  const zbCrossQ = cross(zb, q);

  const cosW = Math.cos(wRad);
  const sinW = Math.sin(wRad);
  const xb: Vector3Like = {
    x: cosW * q.x + sinW * zbCrossQ.x,
    y: cosW * q.y + sinW * zbCrossQ.y,
    z: cosW * q.z + sinW * zbCrossQ.z,
  };

  const yb = cross(zb, xb);

  // Columns are xb, yb, zb; stored row-major.
  return {
    matrix: [
      xb.x, yb.x, zb.x,
      xb.y, yb.y, zb.y,
      xb.z, yb.z, zb.z,
    ],
    northPole: zb,
  };
}

/**
 * Quaternion from a rotation matrix.
 *
 * Uses the branch on the largest diagonal term. The naive single-branch formula
 * divides by sqrt(1 + trace), which approaches zero for rotations near 180
 * degrees and loses precision exactly where large obliquities put Venus and
 * Uranus.
 */
export function matrixToQuaternion(m: Matrix3): QuaternionLike {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return { w: s / 4, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s };
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return { w: (m21 - m12) / s, x: s / 4, y: (m01 + m10) / s, z: (m02 + m20) / s };
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: s / 4, z: (m12 + m21) / s };
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: s / 4 };
}

/** Full orientation of a body at an instant. */
export function computeOrientation(bodyId: string, jdTT: JulianDate<'TT'>): Orientation {
  const record = getRotationRecord(bodyId);
  const { raDeg, decDeg } = poleDirectionDeg(record, jdTT);
  const wDeg = primeMeridianDeg(record, jdTT);
  const { matrix, northPole } = buildRotationMatrix(raDeg, decDeg, wDeg);

  return {
    bodyId,
    poleRaDeg: wrapDegrees(raDeg),
    poleDecDeg: decDeg,
    primeMeridianDeg: wDeg,
    northPole,
    bodyToInertial: matrix,
    quaternion: matrixToQuaternion(matrix),
    retrograde: record.primeMeridian[1] < 0,
    epoch: jdTT,
  };
}

/** Applies a rotation matrix to a vector. */
export function applyMatrix3(m: Matrix3, v: Vector3Like): Vector3Like {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

/** Determinant of a 3x3 matrix. Must be +1 for a proper rotation. */
export function determinant3(m: Matrix3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Sidereal rotation period, days. Negative for a retrograde body. */
export function rotationPeriodDays(bodyId: string): number {
  return 360 / getRotationRecord(bodyId).primeMeridian[1];
}

/** True when the body's prime meridian rate is negative. */
export function isRetrograde(bodyId: string): boolean {
  return getRotationRecord(bodyId).primeMeridian[1] < 0;
}

/**
 * Angle between the body's rotation axis and a supplied orbit normal, degrees.
 *
 * THIS is conventional obliquity. It requires the body's ORBITAL PLANE, which
 * this module deliberately does not know: taking the orbit normal as a parameter
 * keeps orientation independent of the ephemeris, and the caller composes the
 * two. Measuring against the ecliptic instead is only correct for Earth, whose
 * orbit defines the ecliptic; for Venus it is off by 1.4 degrees and for Saturn
 * by 1.3 degrees, both measured.
 *
 * ROTATION SENSE MATTERS. The IAU north pole is defined by position, not by the
 * direction of rotation, so for a retrograde body the angular momentum vector
 * points opposite that pole. Using the pole directly would report Venus at about
 * 2.6 degrees instead of the conventional 177.4. The sign of Wdot resolves this,
 * which is why no body is special-cased.
 */
export function obliquityToOrbitDeg(orientation: Orientation, orbitNormal: Vector3Like): number {
  const normalMagnitude = magnitude(orbitNormal);
  if (normalMagnitude === 0) {
    throw new Error('obliquityToOrbitDeg: orbit normal has zero magnitude');
  }

  const unitNormal = scale(orbitNormal, 1 / normalMagnitude);
  // Angular momentum is along +pole when prograde, -pole when retrograde.
  const spinAxis = orientation.retrograde
    ? scale(orientation.northPole, -1)
    : orientation.northPole;

  return Math.acos(Math.max(-1, Math.min(1, dot(spinAxis, unitNormal)))) * RAD_TO_DEG;
}

/** Provenance for the orientation model, for interface disclosure. */
export const ORIENTATION_METADATA = {
  model: ROTATION_SOURCE.model,
  source: ROTATION_SOURCE.id,
  frame: ROTATION_SOURCE.frame,
  timeScale: 'TDB' as const,
  note: 'Evaluated with TT in place of TDB; the difference is below 1.7 ms.',
} as const;
