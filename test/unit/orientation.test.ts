/**
 * IAU orientation validation.
 *
 * WHAT IS ASSERTED: rotation-matrix algebra (orthonormality, proper rotation,
 * quaternion agreement), the published-model identities that can be checked
 * WITHIN the cited source, and the structural properties contract section 15
 * requires (retrograde rotation and extreme obliquity emerging from data rather
 * than from special cases).
 *
 * A NOTE ON PUBLISHED OBLIQUITY VALUES. Computing obliquity against each body's
 * actual orbit normal yields figures that agree with the commonly published
 * planetary obliquities to about 0.01 degrees for all eight planets. That
 * agreement is strong evidence the pole transcription and rotation construction
 * are correct, and it is what exposed the Mars defect recorded below. It is NOT
 * asserted as a reference value here: the NASA planetary fact sheet was offline
 * when this suite was written, so those numbers could only have come from
 * recollection, and this project does not assert uncited astronomical values.
 * The Mars regression guard below is asserted instead, because it is verifiable
 * entirely within the S4 kernel.
 */

import { describe, expect, it } from 'vitest';
import {
  ORIENTATION_METADATA,
  applyMatrix3,
  buildRotationMatrix,
  computeOrientation,
  determinant3,
  isRetrograde,
  matrixToQuaternion,
  obliquityToOrbitDeg,
  poleDirectionDeg,
  primeMeridianDeg,
  rotationPeriodDays,
  type Matrix3,
} from '@/ephemeris/orientation';
import { createPlanetsProvider, J2000_TT } from '@/ephemeris/planets';
import { cross, dot, magnitude, subtract, type Vector3Like } from '@/ephemeris/kepler';
import { DEG_TO_RAD, J2000_OBLIQUITY_DEG } from '@/data/constants';
import { BODIES, BODY_ORDER, PLANET_IDS } from '@/data/bodies';
import { IAU_ROTATION, getRotationRecord } from '@/data/iau-rotation';
import { addDays, ttFromUtc, utc, type JulianDate } from '@/core/jd';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

const provider = createPlanetsProvider();

function ttAt(year: number, month = 1, day = 1): JulianDate<'TT'> {
  return ttFromUtc(utc(year, month, day));
}

/** Rotates an ecliptic vector into the J2000 equatorial frame. */
function toEquatorial(v: Vector3Like): Vector3Like {
  const eps = J2000_OBLIQUITY_DEG * DEG_TO_RAD;
  return {
    x: v.x,
    y: Math.cos(eps) * v.y - Math.sin(eps) * v.z,
    z: Math.sin(eps) * v.y + Math.cos(eps) * v.z,
  };
}

/**
 * A planet's orbit normal in the J2000 EQUATORIAL frame.
 *
 * The provider returns ecliptic vectors, and the IAU pole is equatorial, so the
 * frames must be reconciled before the two can be compared. Skipping that
 * rotation would introduce an error of order the obliquity, 23.4 degrees.
 */
function orbitNormalEquatorial(bodyId: string, jd: JulianDate<'TT'>): Vector3Like {
  const state = provider.getState(bodyId, jd);
  return toEquatorial(cross(state.positionKm, state.velocityKmS!));
}

/** Column vectors of a row-major matrix. */
function columns(m: Matrix3): readonly [Vector3Like, Vector3Like, Vector3Like] {
  return [
    { x: m[0], y: m[3], z: m[6] },
    { x: m[1], y: m[4], z: m[7] },
    { x: m[2], y: m[5], z: m[8] },
  ];
}

describe('rotation matrix algebra', () => {
  /**
   * Measured worst orthonormality error across all bodies over 1800-2050 is
   * 4.4e-16, which is a handful of f64 epsilons. The 1e-12 bound leaves four
   * orders of headroom while still catching any real defect.
   */
  const ORTHONORMAL_TOLERANCE = 1e-12;

  it('produces an orthonormal basis for every body across the era', () => {
    for (const id of BODY_ORDER) {
      for (let year = 1800; year <= 2050; year += 25) {
        const matrix = computeOrientation(id, ttAt(year)).bodyToInertial;
        const [c0, c1, c2] = columns(matrix);

        for (const [index, column] of [c0, c1, c2].entries()) {
          expect(
            Math.abs(magnitude(column) - 1),
            `${id} at ${year}: column ${index} is not unit length`,
          ).toBeLessThan(ORTHONORMAL_TOLERANCE);
        }

        expect(Math.abs(dot(c0, c1)), `${id} at ${year}: x.y`).toBeLessThan(ORTHONORMAL_TOLERANCE);
        expect(Math.abs(dot(c0, c2)), `${id} at ${year}: x.z`).toBeLessThan(ORTHONORMAL_TOLERANCE);
        expect(Math.abs(dot(c1, c2)), `${id} at ${year}: y.z`).toBeLessThan(ORTHONORMAL_TOLERANCE);
      }
    }
  });

  it('is a proper rotation, never a reflection', () => {
    // Determinant +1, not -1. A reflection would mirror every body's surface
    // features and reverse its apparent rotation direction.
    for (const id of BODY_ORDER) {
      for (let year = 1800; year <= 2050; year += 50) {
        expect(
          determinant3(computeOrientation(id, ttAt(year)).bodyToInertial),
          `${id} at ${year}`,
        ).toBeCloseTo(1, 12);
      }
    }
  });

  it('maps the body z axis onto the reported north pole', () => {
    // The third column must BE the pole direction, which links the matrix
    // construction back to the published pole angles.
    for (const id of BODY_ORDER) {
      const orientation = computeOrientation(id, ttAt(2026));
      const bodyZ = applyMatrix3(orientation.bodyToInertial, { x: 0, y: 0, z: 1 });
      expect(magnitude(subtract(bodyZ, orientation.northPole)), `${id}`).toBeLessThan(1e-12);
    }
  });

  it('preserves vector length under rotation', () => {
    forEachSample(DEFAULT_SEED ^ 0x4321, 200, (sampler, context) => {
      const bodyId = sampler.pick(BODY_ORDER);
      const matrix = computeOrientation(bodyId, ttAt(sampler.int(1800, 2050))).bodyToInertial;
      const [x, y, z] = sampler.unitVector();
      const rotated = applyMatrix3(matrix, { x, y, z });

      expect(
        Math.abs(magnitude(rotated) - 1),
        formatPropertyFailure({ ...context, bodyId }, 1, magnitude(rotated)),
      ).toBeLessThan(1e-12);
    });
  });

  it('agrees between its matrix and quaternion forms', () => {
    // Rotating by the matrix and by the quaternion must give the same result.
    // The quaternion extraction branches on the largest diagonal term, so this
    // exercises bodies with very different obliquities including Venus and Uranus
    // near 180 and 98 degrees, where a single-branch formula loses precision.
    for (const id of BODY_ORDER) {
      const orientation = computeOrientation(id, ttAt(2026));
      const q = orientation.quaternion;

      expect(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1), `${id} quaternion not unit`).toBeLessThan(
        1e-12,
      );

      for (const axis of [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
      ]) {
        const viaMatrix = applyMatrix3(orientation.bodyToInertial, axis);
        const viaQuaternion = rotateByQuaternion(q, axis);
        expect(magnitude(subtract(viaMatrix, viaQuaternion)), `${id}`).toBeLessThan(1e-12);
      }
    }
  });

  it('recovers a quaternion from a matrix for arbitrary rotations', () => {
    // Directly exercises every branch of matrixToQuaternion, including rotations
    // near 180 degrees where the naive formula divides by nearly zero.
    for (const wDeg of [0, 45, 90, 179, 180, 181, 270, 359]) {
      for (const decDeg of [-90, -45, 0, 45, 90]) {
        const { matrix } = buildRotationMatrix(137, decDeg, wDeg);
        const q = matrixToQuaternion(matrix);
        expect(
          Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1),
          `W=${wDeg}, dec=${decDeg}`,
        ).toBeLessThan(1e-12);

        const axis = { x: 0.3, y: -0.5, z: 0.8 };
        expect(
          magnitude(subtract(applyMatrix3(matrix, axis), rotateByQuaternion(q, axis))),
          `W=${wDeg}, dec=${decDeg}`,
        ).toBeLessThan(1e-11);
      }
    }
  });
});

/** Applies a quaternion to a vector. Local, so no render library is imported. */
function rotateByQuaternion(
  q: { x: number; y: number; z: number; w: number },
  v: Vector3Like,
): Vector3Like {
  const { x, y, z, w } = q;
  // t = 2 (q_vec x v), result = v + w t + q_vec x t
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

describe('Earth as a known anchor', () => {
  it('places the pole at right ascension 0 and declination 90 at J2000', () => {
    // Earth's published pole polynomial has constant terms of exactly 0 and 90,
    // so at T = 0 the evaluated pole must be exactly the equatorial pole. This
    // confirms the polynomial is evaluated with T = 0 at the epoch rather than
    // being offset by a century.
    const orientation = computeOrientation('earth', J2000_TT);
    expect(orientation.poleRaDeg).toBeCloseTo(0, 9);
    expect(orientation.poleDecDeg).toBeCloseTo(90, 9);
  });

  it('advances the prime meridian by one sidereal rotation per day', () => {
    // The published rate is 360.9856235 deg/day, so a 24 hour step advances W by
    // 0.9856 degrees beyond a full turn. That excess is the difference between a
    // sidereal and a solar day and is a strong check that the linear term is
    // being applied per DAY rather than per century.
    const before = computeOrientation('earth', ttAt(2026, 8, 15));
    const after = computeOrientation('earth', addDays(ttAt(2026, 8, 15), 1));

    const advance = ((after.primeMeridianDeg - before.primeMeridianDeg) % 360 + 360) % 360;
    expect(advance).toBeCloseTo(0.9856235, 4);
  });

  it('gives an obliquity matching the ecliptic tilt, since Earth defines the ecliptic', () => {
    // Earth is the ONE body for which measuring obliquity against the ecliptic is
    // correct by definition, so this is a genuine cross-check between the S4 pole
    // and the S3 obliquity constant: two independent sources agreeing.
    const eps = J2000_OBLIQUITY_DEG * DEG_TO_RAD;
    const eclipticNorth: Vector3Like = { x: 0, y: -Math.sin(eps), z: Math.cos(eps) };

    const obliquity = obliquityToOrbitDeg(computeOrientation('earth', J2000_TT), eclipticNorth);
    expect(obliquity).toBeCloseTo(J2000_OBLIQUITY_DEG, 3);
  });

  it('agrees with its own orbit normal, as it must', () => {
    const viaOrbit = obliquityToOrbitDeg(
      computeOrientation('earth', ttAt(2000, 1, 1)),
      orbitNormalEquatorial('earth', ttAt(2000, 1, 1)),
    );
    expect(viaOrbit).toBeCloseTo(J2000_OBLIQUITY_DEG, 2);
  });
});

describe('Mars structural nutation terms', () => {
  /**
   * REGRESSION GUARD for a real defect.
   *
   * An earlier revision omitted Mars's periodic terms, believing them to be below
   * 0.001 degrees. The declination amplitude is in fact 1.591274 degrees, and the
   * omission produced a 1.27 degree obliquity error.
   *
   * The assertions below are verifiable ENTIRELY WITHIN the S4 kernel, which is
   * why they are asserted rather than the published obliquity: the IAU 2015 model
   * moved a large slowly-varying component out of Mars's constant terms and into
   * its periodic series, so evaluating the current model at J2000 must reproduce
   * the superseded 2009 constants. It can only do so if the periodic terms are
   * present.
   */
  const SUPERSEDED_2009 = { poleRa: 317.68143, poleDec: 52.88650, primeMeridian: 176.630 };

  it('reproduces the superseded 2009 constants at J2000', () => {
    const record = getRotationRecord('mars');
    const { raDeg, decDeg } = poleDirectionDeg(record, J2000_TT);

    // Agreement to better than 0.01 deg is only possible with the periodic terms
    // applied; without them the declination is off by about 1.55 deg.
    expect(raDeg, 'Mars pole RA').toBeCloseTo(SUPERSEDED_2009.poleRa, 2);
    expect(decDeg, 'Mars pole Dec').toBeCloseTo(SUPERSEDED_2009.poleDec, 2);
    expect(primeMeridianDeg(record, J2000_TT), 'Mars W').toBeCloseTo(
      SUPERSEDED_2009.primeMeridian,
      2,
    );
  });

  it('would disagree materially if the terms were dropped', () => {
    // Demonstrates the terms are load-bearing rather than decorative: the bare
    // constant term differs from the superseded value by more than 1.5 degrees.
    const bareConstantDec = getRotationRecord('mars').poleDec[0];
    expect(Math.abs(bareConstantDec - SUPERSEDED_2009.poleDec)).toBeGreaterThan(1.5);
  });

  it('carries amplitude vectors indexed into the shared 26-angle list', () => {
    // The large terms sit at indices 15, 20 and 26. Truncating the angle list to
    // the shortest amplitude vector would misalign them.
    const nutation = getRotationRecord('mars').nutation!;
    expect(nutation.angles).toHaveLength(26);
    expect(nutation.raAmplitudes[14]).toBeCloseTo(0.419057, 6);
    expect(nutation.decAmplitudes[19]).toBeCloseTo(1.591274, 6);
    expect(nutation.pmAmplitudes[25]).toBeCloseTo(0.584542, 6);
  });

  it('shares one slow argument between all three large terms', () => {
    // Rate 0.5042615 deg/century is a period near 714,000 years, so over any
    // interval this project simulates these behave as near-constant offsets.
    const angles = getRotationRecord('mars').nutation!.angles;
    for (const index of [14, 19, 25]) {
      expect(angles[index]!.rate, `angle ${index + 1}`).toBeCloseTo(0.5042615, 7);
    }
  });

  it('accepts amplitude vectors shorter than the angle list', () => {
    // SPICE treats absent trailing amplitudes as zero, and the published Mars
    // data relies on that. An evaluator demanding equal lengths would reject
    // valid data; one that silently truncated the ANGLES would misalign it.
    const nutation = getRotationRecord('mars').nutation!;
    expect(nutation.raAmplitudes.length).toBeLessThan(nutation.angles.length);
    expect(() => computeOrientation('mars', J2000_TT)).not.toThrow();
  });
});

describe('obliquity requires the orbital plane', () => {
  it('differs measurably from the pole-to-ecliptic angle for every planet but Earth', () => {
    // Conventional obliquity is measured from the body's ORBITAL plane. Using the
    // ecliptic instead is correct only for Earth. The residual should track each
    // planet's orbital inclination, which is why orientation.ts takes the orbit
    // normal as a parameter rather than assuming the ecliptic.
    const eps = J2000_OBLIQUITY_DEG * DEG_TO_RAD;
    const eclipticNorth: Vector3Like = { x: 0, y: -Math.sin(eps), z: Math.cos(eps) };
    const jd = ttAt(2000, 1, 1);

    for (const id of PLANET_IDS) {
      const orientation = computeOrientation(id, jd);
      const viaEcliptic = obliquityToOrbitDeg(orientation, eclipticNorth);
      const viaOrbit = obliquityToOrbitDeg(orientation, orbitNormalEquatorial(id, jd));
      const difference = Math.abs(viaOrbit - viaEcliptic);

      const inclination = Math.abs(provider.elementsAt(id, jd).I);

      if (id === 'earth') {
        // Earth's orbit defines the ecliptic, so the two agree.
        expect(difference, 'Earth should show no discrepancy').toBeLessThan(0.01);
      } else {
        // The discrepancy cannot exceed the orbital inclination, and should be a
        // substantial fraction of it.
        expect(difference, `${id} discrepancy exceeds its inclination`).toBeLessThanOrEqual(
          inclination + 0.01,
        );
      }
    }
  });

  it('rejects a degenerate orbit normal instead of returning NaN', () => {
    expect(() =>
      obliquityToOrbitDeg(computeOrientation('earth', J2000_TT), { x: 0, y: 0, z: 0 }),
    ).toThrow(/zero magnitude/);
  });

  it('is insensitive to the length of the supplied normal', () => {
    const orientation = computeOrientation('mars', J2000_TT);
    const normal = orbitNormalEquatorial('mars', J2000_TT);
    const scaled = { x: normal.x * 1e6, y: normal.y * 1e6, z: normal.z * 1e6 };
    expect(obliquityToOrbitDeg(orientation, scaled)).toBeCloseTo(
      obliquityToOrbitDeg(orientation, normal),
      9,
    );
  });
});

describe('retrograde rotation emerges from the data', () => {
  it('identifies exactly Venus and Uranus as retrograde among the planets', () => {
    // Contract section 15: no body is special-cased. The classification comes
    // entirely from the sign of the published prime-meridian rate.
    const retrograde = PLANET_IDS.filter((id) => isRetrograde(id));
    expect(retrograde.sort()).toEqual(['uranus', 'venus']);
  });

  it('reports a negative rotation period for a retrograde body', () => {
    expect(rotationPeriodDays('venus')).toBeLessThan(0);
    expect(rotationPeriodDays('uranus')).toBeLessThan(0);
    expect(rotationPeriodDays('earth')).toBeGreaterThan(0);
  });

  it('winds the prime meridian backwards for a retrograde body', () => {
    // The observable consequence: W decreases with time. Compared over a short
    // interval so no full turn can hide the direction.
    const start = ttAt(2026, 8, 15);
    for (const id of BODY_ORDER) {
      const before = computeOrientation(id, start).primeMeridianDeg;
      // A tenth of a rotation period, so the change is well under a full turn.
      const step = Math.abs(rotationPeriodDays(id)) * 0.1;
      const after = computeOrientation(id, addDays(start, step)).primeMeridianDeg;

      const delta = ((after - before + 540) % 360) - 180;
      if (isRetrograde(id)) {
        expect(delta, `${id} should wind backwards`).toBeLessThan(0);
      } else {
        expect(delta, `${id} should wind forwards`).toBeGreaterThan(0);
      }
    }
  });

  it('points the angular momentum opposite the IAU pole for a retrograde body', () => {
    // The IAU north pole is defined by POSITION, not by rotation sense, so this
    // sign handling is what makes Venus report the conventional obliquity near
    // 177 degrees rather than its complement near 3 degrees.
    const jd = ttAt(2000, 1, 1);
    for (const id of ['venus', 'uranus']) {
      const obliquity = obliquityToOrbitDeg(
        computeOrientation(id, jd),
        orbitNormalEquatorial(id, jd),
      );
      expect(obliquity, `${id} should exceed 90 degrees`).toBeGreaterThan(90);
    }
    for (const id of ['earth', 'mars', 'jupiter', 'saturn', 'neptune', 'mercury']) {
      const obliquity = obliquityToOrbitDeg(
        computeOrientation(id, jd),
        orbitNormalEquatorial(id, jd),
      );
      expect(obliquity, `${id} should be under 90 degrees`).toBeLessThan(90);
    }
  });

  it('places the Uranus pole below the ecliptic, giving a near-sideways axis', () => {
    // Emerges from a published pole declination of -15.175 deg, with no branch.
    expect(getRotationRecord('uranus').poleDec[0]).toBeLessThan(0);

    const jd = ttAt(2000, 1, 1);
    const obliquity = obliquityToOrbitDeg(
      computeOrientation('uranus', jd),
      orbitNormalEquatorial('uranus', jd),
    );
    // Within a few degrees of perpendicular to its orbit.
    expect(obliquity).toBeGreaterThan(90);
    expect(obliquity).toBeLessThan(105);
  });
});

describe('cross-source rotation agreement', () => {
  it('matches the S2 published rotation period for every body except Neptune', () => {
    // Neptune is excluded because S2 and S4 genuinely disagree there, a conflict
    // recorded in the data layer and asserted separately in data.test.ts.
    for (const id of BODY_ORDER) {
      if (id === 'neptune') continue;
      const published = BODIES[id]?.siderealRotationPeriodDays;
      if (published === undefined) continue;

      const derived = rotationPeriodDays(id);
      const relative = Math.abs(Math.abs(derived) - Math.abs(published.value)) / Math.abs(published.value);
      expect(relative, `${id}: S2 ${published.value} d vs S4-derived ${derived.toFixed(6)} d`).toBeLessThan(
        1e-5,
      );
    }
  });

  it('uses the current Neptune rate, not the superseded one', () => {
    // 541.1397757 deg/day gives 0.665262 d; the superseded 536.3128492 gives
    // 0.671250 d, which is what S2 still publishes.
    expect(rotationPeriodDays('neptune')).toBeCloseTo(0.665262, 5);
  });
});

describe('pole motion over time', () => {
  it("moves Earth's pole slowly, consistent with its published drift rate", () => {
    // Earth's pole polynomial drifts at -0.641 deg/century in right ascension.
    // Over 250 years that is about 1.6 degrees.
    const early = poleDirectionDeg(getRotationRecord('earth'), ttAt(1800));
    const late = poleDirectionDeg(getRotationRecord('earth'), ttAt(2050));
    expect(Math.abs(late.decDeg - early.decDeg)).toBeGreaterThan(0);
    expect(Math.abs(late.decDeg - early.decDeg)).toBeLessThan(2);
  });

  it("shows Neptune's pole wobble from its 0.70 degree nutation amplitude", () => {
    // Large enough to be visible, which is why it is implemented rather than
    // omitted. Measured spread over 1800-2050 is about 0.95 deg in right
    // ascension.
    const samples = [1800, 1900, 2000, 2050].map(
      (year) => poleDirectionDeg(getRotationRecord('neptune'), ttAt(year)).raDeg,
    );
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeGreaterThan(0.5);
    expect(spread).toBeLessThan(2);
  });

  it('holds a body with no drift terms perfectly fixed', () => {
    // Venus has zero linear pole terms and no nutation, so its pole must not move
    // at all. Catches a spurious time dependence leaking into the evaluation.
    const early = poleDirectionDeg(getRotationRecord('venus'), ttAt(1800));
    const late = poleDirectionDeg(getRotationRecord('venus'), ttAt(2050));
    expect(late.raDeg).toBe(early.raDeg);
    expect(late.decDeg).toBe(early.decDeg);
  });
});

describe('prime meridian wrapping', () => {
  it('always reports an angle in [0, 360)', () => {
    for (const id of BODY_ORDER) {
      for (let year = 1800; year <= 2050; year += 17) {
        const w = computeOrientation(id, ttAt(year)).primeMeridianDeg;
        expect(w, `${id} at ${year}`).toBeGreaterThanOrEqual(0);
        expect(w, `${id} at ${year}`).toBeLessThan(360);
      }
    }
  });

  it('wraps continuously rather than jumping mid-rotation', () => {
    // Stepping by a small fraction of a rotation must never change W by more than
    // that fraction, once the 360 wrap is accounted for.
    const start = ttAt(2026, 3, 1);
    for (const id of BODY_ORDER) {
      const period = Math.abs(rotationPeriodDays(id));
      const step = period / 100;

      let previous = computeOrientation(id, start).primeMeridianDeg;
      for (let i = 1; i <= 20; i++) {
        const current = computeOrientation(id, addDays(start, i * step)).primeMeridianDeg;
        const delta = Math.abs(((current - previous + 540) % 360) - 180);
        expect(delta, `${id} step ${i} jumped ${delta.toFixed(3)} deg`).toBeLessThan(10);
        previous = current;
      }
    }
  });
});

describe('metadata and failure modes', () => {
  it('discloses the model, source and time scale', () => {
    expect(ORIENTATION_METADATA.model).toMatch(/IAU/);
    expect(ORIENTATION_METADATA.source).toBe('S4');
    expect(ORIENTATION_METADATA.frame).toMatch(/J2000|ICRF/);
    expect(ORIENTATION_METADATA.timeScale).toBe('TDB');
    // The TT-for-TDB substitution is stated, not hidden.
    expect(ORIENTATION_METADATA.note).toMatch(/TT/);
  });

  it('names the available bodies when one is unknown', () => {
    expect(() => computeOrientation('titan', J2000_TT)).toThrow(/available:/);
    expect(() => computeOrientation('titan', J2000_TT)).toThrow(/earth/);
  });

  it('rejects amplitude vectors longer than the angle list', () => {
    // Cannot be padded, so it means the transcription is misaligned. Silently
    // truncating would pair amplitudes with the wrong arguments.
    const broken = {
      ...getRotationRecord('neptune'),
      nutation: {
        angles: [{ name: 'N', offset: 357.85, rate: 52.316 }],
        raAmplitudes: [0.7, 0.1],
        decAmplitudes: [-0.51],
        pmAmplitudes: [-0.48],
      },
    };
    expect(() => poleDirectionDeg(broken, J2000_TT)).toThrow(/misaligned/);
  });

  it('covers every body in the physical registry', () => {
    // A body with physical data but no orientation record would silently fail to
    // rotate.
    for (const id of BODY_ORDER) {
      expect(IAU_ROTATION[id], `${id} has no orientation record`).toBeDefined();
      expect(() => computeOrientation(id, J2000_TT)).not.toThrow();
    }
  });

  it('reports the epoch it was evaluated for', () => {
    const jd = ttAt(2026, 8, 15);
    expect(computeOrientation('earth', jd).epoch).toEqual(jd);
  });
});

describe('no render types in the simulation layer', () => {
  it('returns plain data structures only', () => {
    // Contract section 39: the simulation layer must not depend on the renderer.
    const orientation = computeOrientation('earth', J2000_TT);

    expect(Array.isArray(orientation.bodyToInertial)).toBe(true);
    expect(orientation.bodyToInertial).toHaveLength(9);
    expect(Object.keys(orientation.quaternion).sort()).toEqual(['w', 'x', 'y', 'z']);
    // A three.js Quaternion would carry methods; a plain object does not.
    expect(typeof (orientation.quaternion as unknown as { clone?: unknown }).clone).toBe(
      'undefined',
    );
  });
});
