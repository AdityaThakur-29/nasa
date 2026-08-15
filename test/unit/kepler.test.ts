/**
 * Two-body Keplerian mechanics validation.
 *
 * WHAT IS ASSERTED HERE: mathematical identities and self-consistency. Every
 * expected value is either an exact identity (r = a(1 - e cos E)), an
 * independent physical law (vis-viva, Kepler III), or a round trip. Nothing in
 * this file asserts an astronomical measurement, so nothing here needs a
 * citation beyond the algorithm source already recorded in the module.
 *
 * WHY CONSERVATION IS TESTED HERE AND NOT AGAINST THE JPL MODEL: this module
 * propagates FIXED elements, so specific energy and specific angular momentum
 * are genuinely invariant. The JPL secular model drifts a and e by design, so
 * those quantities are not conserved there and asserting otherwise would fail
 * correctly. See planets.ts for the checks that suit that model.
 */

import { describe, expect, it } from 'vitest';
import {
  KEPLER_TOLERANCE,
  type OrbitalElements,
  type StateVectors,
  type Vector3Like,
  apoapsisDistanceKm,
  cross,
  dot,
  eccentricAnomalyFromTrue,
  eclipticToEquatorial,
  elementsToStateVectors,
  equatorialToEcliptic,
  magnitude,
  meanAnomalyFromEccentric,
  meanMotion,
  orbitalPeriodSeconds,
  orbitalPlanePosition,
  orbitalPlaneToReferencePlane,
  orbitalPlaneVelocity,
  periapsisDistanceKm,
  propagateElements,
  scale,
  semiMajorAxisFromState,
  solveKeplerEquation,
  specificAngularMomentum,
  specificOrbitalEnergy,
  stateVectorsToElements,
  subtract,
  trueAnomalyFromEccentric,
  wrapToPi,
  wrapToTwoPi,
} from '@/ephemeris/kepler';
import { AU_KM, DEG_TO_RAD, GM_SUN_KM3_S2 } from '@/data/constants';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/** Signed angular difference a - b, wrapped to [-pi, pi]. */
function angularDifference(a: number, b: number): number {
  return wrapToPi(a - b);
}

/** Relative difference, falling back to absolute when the reference is ~0. */
function relativeError(actual: number, expected: number): number {
  const scaleOf = Math.abs(expected);
  return scaleOf < 1e-30 ? Math.abs(actual - expected) : Math.abs(actual - expected) / scaleOf;
}

/**
 * A well-conditioned reference orbit. Roughly Mars-like in size, with an
 * eccentricity and inclination large enough that no degenerate branch is
 * exercised.
 */
function referenceOrbit(): OrbitalElements {
  return {
    semiMajorAxisKm: 1.523_71 * AU_KM,
    eccentricity: 0.0934,
    inclination: 1.85 * DEG_TO_RAD,
    longitudeOfAscendingNode: 49.56 * DEG_TO_RAD,
    argumentOfPeriapsis: 286.5 * DEG_TO_RAD,
    meanAnomaly: 19.4 * DEG_TO_RAD,
  };
}

describe('angle wrapping', () => {
  it('maps onto the half-open interval [-pi, pi)', () => {
    expect(wrapToPi(0)).toBeCloseTo(0, 15);
    expect(wrapToPi(Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 12);
    expect(wrapToPi(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
  });

  it('resolves the pi boundary to the single canonical representative', () => {
    // +pi and -pi are the same angle modulo 2pi, so a closed interval would make
    // this ambiguous and the function would depend on how the input was written
    // rather than on the angle it denotes. The half-open interval excludes the
    // upper end, so every input has exactly one answer: -pi.
    expect(wrapToPi(Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapToPi(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapToPi(-Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapToPi(-3 * Math.PI)).toBeCloseTo(-Math.PI, 12);

    // Harmless downstream: both representatives put the body at apoapsis, and
    // the solver returns the same state for either.
    const e = 0.3;
    const atPlusPi = solveKeplerEquation(Math.PI, e);
    const atMinusPi = solveKeplerEquation(-Math.PI, e);
    expect(Math.abs(angularDifference(atPlusPi.eccentricAnomaly, atMinusPi.eccentricAnomaly))).toBeLessThan(
      1e-12,
    );
  });

  it('maps onto [0, 2pi)', () => {
    expect(wrapToTwoPi(0)).toBe(0);
    expect(wrapToTwoPi(-0.5)).toBeCloseTo(2 * Math.PI - 0.5, 12);
    expect(wrapToTwoPi(7 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('preserves the represented angle for arbitrary input', () => {
    forEachSample(DEFAULT_SEED, 400, (sampler, context) => {
      const angle = sampler.range(-200, 200);
      const wrapped = wrapToPi(angle);

      expect(wrapped >= -Math.PI - 1e-12 && wrapped <= Math.PI + 1e-12).toBe(true);
      // Difference must be an exact multiple of 2pi.
      const turns = (angle - wrapped) / (2 * Math.PI);
      expect(
        Math.abs(turns - Math.round(turns)),
        formatPropertyFailure({ ...context, angle }, 'integer number of turns', turns),
      ).toBeLessThan(1e-9);
    });
  });
});

describe("Kepler's equation", () => {
  /**
   * THE PRIMARY M1 NUMERICAL GATE.
   *
   * Contract requirement: |M - (E - e sin E)| < 1e-11 across e in [0, 0.95].
   * Swept deterministically over the full grid the contract names, rather than
   * sampled, so the worst case over that grid is actually found.
   */
  it('holds the residual below 1e-11 across the whole required grid', () => {
    const REQUIRED_TOLERANCE = 1e-11;
    let worstResidual = 0;
    let worstCase = '';

    for (let e = 0; e <= 0.95 + 1e-12; e += 0.01) {
      for (let step = 0; step < 128; step++) {
        const m = -Math.PI + (step * Math.PI) / 64;
        const solution = solveKeplerEquation(m, e);

        // Residual recomputed here from the returned E, independently of what
        // the solver reported, so a solver that lied about its own residual
        // would still be caught.
        const recomputed = Math.abs(
          angularDifference(meanAnomalyFromEccentric(solution.eccentricAnomaly, e), m),
        );

        if (recomputed > worstResidual) {
          worstResidual = recomputed;
          worstCase = `e=${e.toFixed(2)}, M=${m.toFixed(6)}`;
        }

        expect(solution.converged, `did not converge at e=${e.toFixed(2)}, M=${m.toFixed(6)}`).toBe(
          true,
        );
      }
    }

    expect(
      worstResidual,
      `worst residual ${worstResidual.toExponential(3)} at ${worstCase}`,
    ).toBeLessThan(REQUIRED_TOLERANCE);
  });

  it('reaches the tighter default tolerance across the same grid', () => {
    // The module's own default is 1e-14 rad, about 2 nanoarcseconds. Asserted
    // separately so a regression in solver quality is visible even while the
    // contract gate above still passes.
    let worst = 0;
    for (let e = 0; e <= 0.95 + 1e-12; e += 0.05) {
      for (let step = 0; step < 64; step++) {
        const m = -Math.PI + (step * Math.PI) / 32;
        worst = Math.max(worst, solveKeplerEquation(m, e).residual);
      }
    }
    expect(worst, `worst reported residual ${worst.toExponential(3)}`).toBeLessThanOrEqual(
      KEPLER_TOLERANCE,
    );
  });

  it('handles extreme eccentricity near periapsis, where the derivative is smallest', () => {
    // At e = 0.99, M = 0 the derivative 1 - e cos E falls to 0.01, which is the
    // condition that makes an unclamped Newton step overshoot.
    for (const e of [0.95, 0.99, 0.999, 0.9999]) {
      for (const m of [0, 1e-8, 1e-4, 0.01, -0.01]) {
        const solution = solveKeplerEquation(m, e);
        expect(solution.converged, `e=${e}, M=${m} failed to converge`).toBe(true);
        expect(Number.isFinite(solution.eccentricAnomaly)).toBe(true);
        expect(
          Math.abs(angularDifference(meanAnomalyFromEccentric(solution.eccentricAnomaly, e), m)),
          `e=${e}, M=${m}`,
        ).toBeLessThan(1e-11);
      }
    }
  });

  it('solves a circular orbit exactly and without iterating', () => {
    const solution = solveKeplerEquation(1.234, 0);
    expect(solution.eccentricAnomaly).toBeCloseTo(1.234, 15);
    expect(solution.iterations).toBe(0);
    expect(solution.residual).toBe(0);
  });

  it('converges in few iterations for planetary eccentricities', () => {
    // All eight planets sit below e = 0.21. Newton from the recommended starter
    // should need only a handful of steps; a regression to many steps would
    // signal the starter or the clamp had been damaged.
    let worstIterations = 0;
    for (let e = 0; e <= 0.25; e += 0.01) {
      for (let step = 0; step < 32; step++) {
        const m = -Math.PI + (step * Math.PI) / 16;
        const solution = solveKeplerEquation(m, e);
        expect(solution.method).toBe('newton');
        worstIterations = Math.max(worstIterations, solution.iterations);
      }
    }
    expect(worstIterations, `worst iteration count ${worstIterations}`).toBeLessThanOrEqual(6);
  });

  it('is unaffected by how many turns the mean anomaly carries', () => {
    // M and M + 2pi k describe the same point on the orbit.
    const e = 0.3;
    const base = solveKeplerEquation(0.7, e).eccentricAnomaly;
    for (const turns of [1, -1, 5, -5, 100]) {
      const shifted = solveKeplerEquation(0.7 + turns * 2 * Math.PI, e).eccentricAnomaly;
      expect(Math.abs(angularDifference(shifted, base)), `turns=${turns}`).toBeLessThan(1e-12);
    }
  });

  it('inverts meanAnomalyFromEccentric over random inputs', () => {
    forEachSample(DEFAULT_SEED ^ 0x2222, 600, (sampler, context) => {
      const e = sampler.range(0, 0.95);
      const trueE = sampler.range(-Math.PI, Math.PI);
      const m = meanAnomalyFromEccentric(trueE, e);
      const recovered = solveKeplerEquation(m, e).eccentricAnomaly;

      const error = Math.abs(angularDifference(recovered, trueE));
      expect(
        error,
        formatPropertyFailure({ ...context, e, trueE }, trueE, recovered),
      ).toBeLessThan(1e-10);
    });
  });

  it('matches the degree form published by JPL', () => {
    // The source states M = E - e* sin(E) with e* = 57.29578 e and M, E in
    // degrees. This module uses the radian form. The two are algebraically
    // identical, and this test proves that claim rather than leaving it as a
    // comment: multiplying the radian identity by 180/pi yields the degree one.
    const e = 0.2056;
    const eStarDegrees = (180 / Math.PI) * e;

    for (const eDegrees of [0, 30, 90, 137.5, 200, 359]) {
      const eRadians = eDegrees * DEG_TO_RAD;
      const mDegreesViaSource = eDegrees - eStarDegrees * Math.sin(eRadians);
      const mDegreesViaRadianForm = meanAnomalyFromEccentric(eRadians, e) / DEG_TO_RAD;
      expect(mDegreesViaSource, `E=${eDegrees} deg`).toBeCloseTo(mDegreesViaRadianForm, 10);
    }
  });

  it('rejects inputs it cannot solve', () => {
    expect(() => solveKeplerEquation(Number.NaN, 0.1)).toThrow(/finite/);
    expect(() => solveKeplerEquation(0, Number.NaN)).toThrow(/finite/);
    expect(() => solveKeplerEquation(0, -0.1)).toThrow(/>= 0/);
    // Parabolic and hyperbolic need different equations entirely.
    expect(() => solveKeplerEquation(0, 1)).toThrow(/elliptical/);
    expect(() => solveKeplerEquation(0, 1.5)).toThrow(/elliptical/);
  });
});

describe('anomaly conversions', () => {
  it('round-trips true and eccentric anomaly', () => {
    forEachSample(DEFAULT_SEED ^ 0x3333, 600, (sampler, context) => {
      const e = sampler.range(0, 0.95);
      const eccentric = sampler.range(-Math.PI, Math.PI);
      const trueAnomaly = trueAnomalyFromEccentric(eccentric, e);
      const recovered = eccentricAnomalyFromTrue(trueAnomaly, e);

      expect(
        Math.abs(angularDifference(recovered, eccentric)),
        formatPropertyFailure({ ...context, e, eccentric }, eccentric, recovered),
      ).toBeLessThan(1e-11);
    });
  });

  it('makes all three anomalies coincide at periapsis and apoapsis', () => {
    // A geometric fact independent of eccentricity, and a check that no
    // conversion has a spurious offset.
    for (const e of [0, 0.1, 0.5, 0.9]) {
      expect(trueAnomalyFromEccentric(0, e)).toBeCloseTo(0, 12);
      expect(meanAnomalyFromEccentric(0, e)).toBeCloseTo(0, 12);
      expect(Math.abs(trueAnomalyFromEccentric(Math.PI, e))).toBeCloseTo(Math.PI, 12);
      expect(Math.abs(meanAnomalyFromEccentric(Math.PI, e))).toBeCloseTo(Math.PI, 12);
    }
  });

  it('advances the true anomaly ahead of the mean anomaly after periapsis', () => {
    // Kepler's second law: the body moves fastest at periapsis, so for
    // 0 < M < pi the true anomaly leads the mean anomaly.
    const e = 0.4;
    for (const eccentric of [0.3, 1.0, 2.0, 3.0]) {
      const trueAnomaly = trueAnomalyFromEccentric(eccentric, e);
      const mean = meanAnomalyFromEccentric(eccentric, e);
      expect(trueAnomaly, `E=${eccentric}`).toBeGreaterThan(mean);
    }
  });
});

describe('mean motion and period', () => {
  it('reproduces the Earth orbital period from the heliocentric GM', () => {
    // Kepler III with a = 1 au and GM_sun must give a sidereal year. Independent
    // of every other part of this module.
    const periodDays = orbitalPeriodSeconds(AU_KM, GM_SUN_KM3_S2) / 86_400;
    // The sidereal year is 365.256 d; the two-body value at exactly 1 au differs
    // slightly because Earth's semi-major axis is not exactly 1 au and the
    // Earth-Moon system perturbs it.
    expect(periodDays).toBeGreaterThan(365.2);
    expect(periodDays).toBeLessThan(365.3);
  });

  it('satisfies the cube-square law', () => {
    // T^2 proportional to a^3, checked between two arbitrary radii.
    const t1 = orbitalPeriodSeconds(AU_KM, GM_SUN_KM3_S2);
    const t4 = orbitalPeriodSeconds(4 * AU_KM, GM_SUN_KM3_S2);
    // a x 4 implies T x 8.
    expect(t4 / t1).toBeCloseTo(8, 9);
  });

  it('relates mean motion and period exactly', () => {
    const a = 5.2 * AU_KM;
    expect(meanMotion(a, GM_SUN_KM3_S2) * orbitalPeriodSeconds(a, GM_SUN_KM3_S2)).toBeCloseTo(
      2 * Math.PI,
      12,
    );
  });

  it('rejects a non-positive semi-major axis', () => {
    expect(() => meanMotion(0, GM_SUN_KM3_S2)).toThrow(/positive/);
    expect(() => meanMotion(-1, GM_SUN_KM3_S2)).toThrow(/positive/);
  });
});

describe('orbital-plane geometry', () => {
  it('places periapsis and apoapsis on the x axis at the right distances', () => {
    const a = AU_KM;
    const e = 0.2;

    const periapsis = orbitalPlanePosition(a, e, 0);
    expect(periapsis.x).toBeCloseTo(a * (1 - e), 6);
    expect(periapsis.y).toBeCloseTo(0, 6);

    const apoapsis = orbitalPlanePosition(a, e, Math.PI);
    expect(apoapsis.x).toBeCloseTo(-a * (1 + e), 6);
    expect(Math.abs(apoapsis.y)).toBeLessThan(1e-6);
  });

  it('satisfies r = a(1 - e cos E) everywhere', () => {
    // Exact identity, so it holds for every eccentricity and every anomaly.
    forEachSample(DEFAULT_SEED ^ 0x4444, 500, (sampler, context) => {
      const a = sampler.logRange(1e5, 1e10);
      const e = sampler.range(0, 0.95);
      const eccentric = sampler.range(-Math.PI, Math.PI);

      const planar = orbitalPlanePosition(a, e, eccentric);
      const r = Math.hypot(planar.x, planar.y);
      const expected = a * (1 - e * Math.cos(eccentric));

      expect(
        relativeError(r, expected),
        formatPropertyFailure({ ...context, a, e, eccentric }, expected, r),
      ).toBeLessThan(1e-12);
    });
  });

  it('satisfies the vis-viva equation, which links the position and velocity formulae', () => {
    // v^2 = GM (2/r - 1/a). The velocity expressions were derived by hand from
    // the time derivative of Kepler's equation, so this is the check that the
    // derivation is right and not merely plausible.
    forEachSample(DEFAULT_SEED ^ 0x5555, 500, (sampler, context) => {
      const a = sampler.logRange(1e6, 1e10);
      const e = sampler.range(0, 0.9);
      const eccentric = sampler.range(-Math.PI, Math.PI);

      const planar = orbitalPlanePosition(a, e, eccentric);
      const velocity = orbitalPlaneVelocity(a, e, eccentric, GM_SUN_KM3_S2);

      const r = Math.hypot(planar.x, planar.y);
      const vSquared = velocity.x * velocity.x + velocity.y * velocity.y;
      const expected = GM_SUN_KM3_S2 * (2 / r - 1 / a);

      expect(
        relativeError(vSquared, expected),
        formatPropertyFailure({ ...context, a, e, eccentric }, expected, vSquared),
      ).toBeLessThan(1e-10);
    });
  });

  it('makes speed greatest at periapsis and least at apoapsis', () => {
    const a = AU_KM;
    const e = 0.3;
    const atPeriapsis = orbitalPlaneVelocity(a, e, 0, GM_SUN_KM3_S2);
    const atApoapsis = orbitalPlaneVelocity(a, e, Math.PI, GM_SUN_KM3_S2);
    expect(Math.hypot(atPeriapsis.x, atPeriapsis.y)).toBeGreaterThan(
      Math.hypot(atApoapsis.x, atApoapsis.y),
    );
  });

  it('makes velocity perpendicular to position at the apsides', () => {
    // At periapsis and apoapsis the radial velocity component vanishes.
    const a = AU_KM;
    const e = 0.25;
    for (const eccentric of [0, Math.PI]) {
      const p = orbitalPlanePosition(a, e, eccentric);
      const v = orbitalPlaneVelocity(a, e, eccentric, GM_SUN_KM3_S2);
      const cosine = (p.x * v.x + p.y * v.y) / (Math.hypot(p.x, p.y) * Math.hypot(v.x, v.y));
      expect(Math.abs(cosine), `E=${eccentric}`).toBeLessThan(1e-9);
    }
  });
});

describe('frame rotations', () => {
  it('is the identity when all three orientation angles are zero', () => {
    const result = orbitalPlaneToReferencePlane({ x: 3, y: 4 }, 0, 0, 0);
    expect(result.x).toBeCloseTo(3, 12);
    expect(result.y).toBeCloseTo(4, 12);
    expect(result.z).toBeCloseTo(0, 12);
  });

  it('preserves length for every orientation', () => {
    // The composition of three rotations must be orthogonal.
    forEachSample(DEFAULT_SEED ^ 0x6666, 500, (sampler, context) => {
      const planar = { x: sampler.range(-1e8, 1e8), y: sampler.range(-1e8, 1e8) };
      const argument = sampler.range(0, 2 * Math.PI);
      const inclination = sampler.range(0, Math.PI);
      const node = sampler.range(0, 2 * Math.PI);

      const rotated = orbitalPlaneToReferencePlane(planar, argument, inclination, node);
      const before = Math.hypot(planar.x, planar.y);
      const after = magnitude(rotated);

      expect(
        relativeError(after, before),
        formatPropertyFailure({ ...context, argument, inclination, node }, before, after),
      ).toBeLessThan(1e-12);
    });
  });

  it('lifts the orbit fully out of the reference plane at 90 degrees inclination', () => {
    // With i = 90 deg, omega = 90 deg and Omega = 0, the periapsis direction
    // points along +z.
    const result = orbitalPlaneToReferencePlane({ x: 1, y: 0 }, Math.PI / 2, Math.PI / 2, 0);
    expect(result.z).toBeCloseTo(1, 12);
    expect(Math.hypot(result.x, result.y)).toBeLessThan(1e-12);
  });

  it('keeps a zero-inclination orbit in the reference plane', () => {
    forEachSample(DEFAULT_SEED ^ 0x7777, 200, (sampler, context) => {
      const planar = { x: sampler.range(-1e6, 1e6), y: sampler.range(-1e6, 1e6) };
      const rotated = orbitalPlaneToReferencePlane(
        planar,
        sampler.range(0, 2 * Math.PI),
        0,
        sampler.range(0, 2 * Math.PI),
      );
      expect(
        Math.abs(rotated.z),
        formatPropertyFailure(context, 0, rotated.z),
      ).toBeLessThan(1e-9);
    });
  });

  it('round-trips between the ecliptic and equatorial frames', () => {
    const obliquity = 23.43928 * DEG_TO_RAD;
    forEachSample(DEFAULT_SEED ^ 0x8888, 300, (sampler, context) => {
      const [x, y, z] = sampler.unitVector();
      const original: Vector3Like = { x: x * AU_KM, y: y * AU_KM, z: z * AU_KM };
      const recovered = equatorialToEcliptic(eclipticToEquatorial(original, obliquity), obliquity);

      const error = magnitude(subtract(recovered, original)) / AU_KM;
      expect(error, formatPropertyFailure(context, 0, error)).toBeLessThan(1e-12);
    });
  });

  it('leaves the x axis fixed under the obliquity rotation', () => {
    // The rotation is about x, so the vernal equinox direction is invariant.
    const obliquity = 23.43928 * DEG_TO_RAD;
    const result = eclipticToEquatorial({ x: 1, y: 0, z: 0 }, obliquity);
    expect(result.x).toBeCloseTo(1, 15);
    expect(result.y).toBeCloseTo(0, 15);
    expect(result.z).toBeCloseTo(0, 15);
  });

  it('tilts the ecliptic pole by exactly the obliquity', () => {
    const obliquity = 23.43928 * DEG_TO_RAD;
    const result = eclipticToEquatorial({ x: 0, y: 0, z: 1 }, obliquity);
    // Angle from the equatorial pole must equal the obliquity.
    expect(Math.acos(result.z)).toBeCloseTo(obliquity, 12);
  });
});

describe('elements to state vectors', () => {
  it('produces the energy implied by the semi-major axis', () => {
    // epsilon = -GM/(2a) is an identity for a bound orbit. Comparing it with
    // v^2/2 - GM/r checks that position and velocity are mutually consistent.
    forEachSample(DEFAULT_SEED ^ 0x9999, 400, (sampler, context) => {
      const elements: OrbitalElements = {
        semiMajorAxisKm: sampler.logRange(1e7, 1e10),
        eccentricity: sampler.range(0, 0.9),
        inclination: sampler.range(0, Math.PI),
        longitudeOfAscendingNode: sampler.range(0, 2 * Math.PI),
        argumentOfPeriapsis: sampler.range(0, 2 * Math.PI),
        meanAnomaly: sampler.range(0, 2 * Math.PI),
      };

      const state = elementsToStateVectors(elements, GM_SUN_KM3_S2);
      const fromState = specificOrbitalEnergy(state, GM_SUN_KM3_S2);
      const fromElements = -GM_SUN_KM3_S2 / (2 * elements.semiMajorAxisKm);

      expect(
        relativeError(fromState, fromElements),
        formatPropertyFailure({ ...context, ...elements }, fromElements, fromState),
      ).toBeLessThan(1e-10);
    });
  });

  it('produces the angular momentum implied by a and e', () => {
    // |h| = sqrt(GM a (1 - e^2)), independent of the anomaly and orientation.
    forEachSample(DEFAULT_SEED ^ 0xaaaa, 400, (sampler, context) => {
      const a = sampler.logRange(1e7, 1e10);
      const e = sampler.range(0, 0.9);
      const elements: OrbitalElements = {
        semiMajorAxisKm: a,
        eccentricity: e,
        inclination: sampler.range(0, Math.PI),
        longitudeOfAscendingNode: sampler.range(0, 2 * Math.PI),
        argumentOfPeriapsis: sampler.range(0, 2 * Math.PI),
        meanAnomaly: sampler.range(0, 2 * Math.PI),
      };

      const state = elementsToStateVectors(elements, GM_SUN_KM3_S2);
      const actual = magnitude(specificAngularMomentum(state));
      const expected = Math.sqrt(GM_SUN_KM3_S2 * a * (1 - e * e));

      expect(
        relativeError(actual, expected),
        formatPropertyFailure({ ...context, a, e }, expected, actual),
      ).toBeLessThan(1e-10);
    });
  });

  it('recovers the semi-major axis from the state vector', () => {
    const elements = referenceOrbit();
    const state = elementsToStateVectors(elements, GM_SUN_KM3_S2);
    expect(
      relativeError(semiMajorAxisFromState(state, GM_SUN_KM3_S2), elements.semiMajorAxisKm),
    ).toBeLessThan(1e-12);
  });

  it('places the body between periapsis and apoapsis distance', () => {
    forEachSample(DEFAULT_SEED ^ 0xbbbb, 300, (sampler, context) => {
      const elements: OrbitalElements = {
        semiMajorAxisKm: sampler.logRange(1e7, 1e10),
        eccentricity: sampler.range(0, 0.9),
        inclination: sampler.range(0, Math.PI),
        longitudeOfAscendingNode: sampler.range(0, 2 * Math.PI),
        argumentOfPeriapsis: sampler.range(0, 2 * Math.PI),
        meanAnomaly: sampler.range(0, 2 * Math.PI),
      };
      const r = magnitude(elementsToStateVectors(elements, GM_SUN_KM3_S2).position);

      const low = periapsisDistanceKm(elements);
      const high = apoapsisDistanceKm(elements);
      const withinBounds = r >= low * (1 - 1e-12) && r <= high * (1 + 1e-12);

      expect(
        withinBounds,
        formatPropertyFailure({ ...context, ...elements }, `[${low}, ${high}]`, r),
      ).toBe(true);
    });
  });

  it('keeps the orbit normal aligned with the inclination and node', () => {
    // The angular momentum direction encodes i and Omega, so this checks that
    // the rotation composition applies them in the right order.
    const elements = referenceOrbit();
    const h = specificAngularMomentum(elementsToStateVectors(elements, GM_SUN_KM3_S2));
    const unitH = scale(h, 1 / magnitude(h));

    expect(Math.acos(unitH.z)).toBeCloseTo(elements.inclination, 9);

    // Node line is perpendicular to h and lies in the reference plane:
    //   n = zhat x h = (-h_y, h_x, 0)
    // Treating that as a complex number, -h_y + i h_x = i (h_x + i h_y), and
    // multiplying by i adds a quarter turn. Hence
    //   Omega = atan2(n_y, n_x) = atan2(h_y, h_x) + pi/2.
    const nodeDirection = Math.atan2(h.y, h.x) + Math.PI / 2;
    expect(
      Math.abs(angularDifference(nodeDirection, elements.longitudeOfAscendingNode)),
    ).toBeLessThan(1e-9);
  });
});

describe('state vectors to elements', () => {
  it('round-trips well-conditioned orbits', () => {
    // Bounds keep every sample away from the circular and equatorial
    // degeneracies, where element values are conventional rather than physical.
    forEachSample(DEFAULT_SEED ^ 0xcccc, 500, (sampler, context) => {
      const original: OrbitalElements = {
        semiMajorAxisKm: sampler.logRange(1e7, 1e10),
        eccentricity: sampler.range(0.01, 0.9),
        inclination: sampler.range(0.05, Math.PI - 0.05),
        longitudeOfAscendingNode: sampler.range(0, 2 * Math.PI),
        argumentOfPeriapsis: sampler.range(0, 2 * Math.PI),
        meanAnomaly: sampler.range(0, 2 * Math.PI),
      };

      const state = elementsToStateVectors(original, GM_SUN_KM3_S2);
      const recovered = stateVectorsToElements(state, GM_SUN_KM3_S2);

      const describe_ = { ...context, ...original };

      expect(
        relativeError(recovered.semiMajorAxisKm, original.semiMajorAxisKm),
        formatPropertyFailure(describe_, original.semiMajorAxisKm, recovered.semiMajorAxisKm),
      ).toBeLessThan(1e-10);

      expect(
        Math.abs(recovered.eccentricity - original.eccentricity),
        formatPropertyFailure(describe_, original.eccentricity, recovered.eccentricity),
      ).toBeLessThan(1e-10);

      for (const key of [
        'inclination',
        'longitudeOfAscendingNode',
        'argumentOfPeriapsis',
        'meanAnomaly',
      ] as const) {
        expect(
          Math.abs(angularDifference(recovered[key], original[key])),
          formatPropertyFailure({ ...describe_, angle: key }, original[key], recovered[key]),
        ).toBeLessThan(1e-8);
      }
    });
  });

  it('round-trips the STATE of a circular orbit, where periapsis is undefined', () => {
    // For e = 0 the argument of periapsis is a convention, so element equality
    // is not the right assertion. Position and velocity must still be recovered
    // exactly, and that is what the simulation actually consumes.
    const original: OrbitalElements = {
      semiMajorAxisKm: AU_KM,
      eccentricity: 0,
      inclination: 0.4,
      longitudeOfAscendingNode: 1.1,
      argumentOfPeriapsis: 0,
      meanAnomaly: 2.0,
    };

    const state = elementsToStateVectors(original, GM_SUN_KM3_S2);
    const recovered = stateVectorsToElements(state, GM_SUN_KM3_S2);
    const reconstructed = elementsToStateVectors(recovered, GM_SUN_KM3_S2);

    expect(magnitude(subtract(reconstructed.position, state.position)) / AU_KM).toBeLessThan(1e-10);
    expect(
      magnitude(subtract(reconstructed.velocity, state.velocity)) /
        magnitude(state.velocity),
    ).toBeLessThan(1e-10);
  });

  it('round-trips the STATE of an equatorial orbit, where the node is undefined', () => {
    const original: OrbitalElements = {
      semiMajorAxisKm: AU_KM,
      eccentricity: 0.2,
      inclination: 0,
      longitudeOfAscendingNode: 0,
      argumentOfPeriapsis: 1.3,
      meanAnomaly: 0.9,
    };

    const state = elementsToStateVectors(original, GM_SUN_KM3_S2);
    const recovered = stateVectorsToElements(state, GM_SUN_KM3_S2);
    const reconstructed = elementsToStateVectors(recovered, GM_SUN_KM3_S2);

    expect(magnitude(subtract(reconstructed.position, state.position)) / AU_KM).toBeLessThan(1e-10);
    expect(
      magnitude(subtract(reconstructed.velocity, state.velocity)) / magnitude(state.velocity),
    ).toBeLessThan(1e-10);
  });

  it('refuses degenerate trajectories instead of returning NaN', () => {
    // Purely radial motion has no orbital plane, so no elements exist.
    const radial: StateVectors = {
      position: { x: AU_KM, y: 0, z: 0 },
      velocity: { x: 10, y: 0, z: 0 },
    };
    expect(() => stateVectorsToElements(radial, GM_SUN_KM3_S2)).toThrow(/angular momentum/);

    const atOrigin: StateVectors = {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 1, y: 1, z: 0 },
    };
    expect(() => stateVectorsToElements(atOrigin, GM_SUN_KM3_S2)).toThrow(/zero magnitude/);
  });
});

describe('conservation under fixed-element propagation', () => {
  /**
   * CONTRACT REQUIREMENT: for the idealised Kepler model, specific energy and
   * specific angular momentum must remain invariant. Valid here precisely
   * because this propagator holds every element but M constant.
   */
  it('conserves specific energy and angular momentum over a full orbit', () => {
    const elements = referenceOrbit();
    const period = orbitalPeriodSeconds(elements.semiMajorAxisKm, GM_SUN_KM3_S2);
    const STEPS = 720;

    const initial = elementsToStateVectors(elements, GM_SUN_KM3_S2);
    const energy0 = specificOrbitalEnergy(initial, GM_SUN_KM3_S2);
    const momentum0 = specificAngularMomentum(initial);

    let worstEnergyError = 0;
    let worstMomentumError = 0;
    let worstDirectionError = 0;

    for (let i = 1; i <= STEPS; i++) {
      const advanced = propagateElements(elements, GM_SUN_KM3_S2, (i * period) / STEPS);
      const state = elementsToStateVectors(advanced, GM_SUN_KM3_S2);

      worstEnergyError = Math.max(
        worstEnergyError,
        relativeError(specificOrbitalEnergy(state, GM_SUN_KM3_S2), energy0),
      );

      const momentum = specificAngularMomentum(state);
      worstMomentumError = Math.max(
        worstMomentumError,
        relativeError(magnitude(momentum), magnitude(momentum0)),
      );

      // Direction matters as much as magnitude: a drifting h direction would
      // mean the orbital plane was not being held fixed.
      const cosine =
        dot(momentum, momentum0) / (magnitude(momentum) * magnitude(momentum0));
      worstDirectionError = Math.max(worstDirectionError, Math.abs(1 - cosine));
    }

    expect(worstEnergyError, `worst energy drift ${worstEnergyError.toExponential(3)}`).toBeLessThan(
      1e-12,
    );
    expect(
      worstMomentumError,
      `worst |h| drift ${worstMomentumError.toExponential(3)}`,
    ).toBeLessThan(1e-12);
    expect(
      worstDirectionError,
      `worst h direction drift ${worstDirectionError.toExponential(3)}`,
    ).toBeLessThan(1e-12);
  });

  it('conserves both quantities across a wide range of orbits', () => {
    forEachSample(DEFAULT_SEED ^ 0xdddd, 200, (sampler, context) => {
      const elements: OrbitalElements = {
        semiMajorAxisKm: sampler.logRange(1e7, 1e10),
        eccentricity: sampler.range(0, 0.9),
        inclination: sampler.range(0, Math.PI),
        longitudeOfAscendingNode: sampler.range(0, 2 * Math.PI),
        argumentOfPeriapsis: sampler.range(0, 2 * Math.PI),
        meanAnomaly: sampler.range(0, 2 * Math.PI),
      };
      const period = orbitalPeriodSeconds(elements.semiMajorAxisKm, GM_SUN_KM3_S2);

      const first = elementsToStateVectors(elements, GM_SUN_KM3_S2);
      const later = elementsToStateVectors(
        propagateElements(elements, GM_SUN_KM3_S2, period * 0.37),
        GM_SUN_KM3_S2,
      );

      const energyError = relativeError(
        specificOrbitalEnergy(later, GM_SUN_KM3_S2),
        specificOrbitalEnergy(first, GM_SUN_KM3_S2),
      );
      const momentumError = relativeError(
        magnitude(specificAngularMomentum(later)),
        magnitude(specificAngularMomentum(first)),
      );

      expect(
        energyError,
        formatPropertyFailure({ ...context, ...elements }, 0, energyError),
      ).toBeLessThan(1e-11);
      expect(
        momentumError,
        formatPropertyFailure({ ...context, ...elements }, 0, momentumError),
      ).toBeLessThan(1e-11);
    });
  });

  it('returns to the same state after exactly one period', () => {
    const elements = referenceOrbit();
    const period = orbitalPeriodSeconds(elements.semiMajorAxisKm, GM_SUN_KM3_S2);

    const start = elementsToStateVectors(elements, GM_SUN_KM3_S2);
    const afterOnePeriod = elementsToStateVectors(
      propagateElements(elements, GM_SUN_KM3_S2, period),
      GM_SUN_KM3_S2,
    );

    const positionError =
      magnitude(subtract(afterOnePeriod.position, start.position)) / magnitude(start.position);
    const velocityError =
      magnitude(subtract(afterOnePeriod.velocity, start.velocity)) / magnitude(start.velocity);

    expect(positionError).toBeLessThan(1e-10);
    expect(velocityError).toBeLessThan(1e-10);
  });

  it('is reversible: forward then backward returns to the start', () => {
    const elements = referenceOrbit();
    const forward = propagateElements(elements, GM_SUN_KM3_S2, 1e7);
    const back = propagateElements(forward, GM_SUN_KM3_S2, -1e7);
    expect(Math.abs(angularDifference(back.meanAnomaly, elements.meanAnomaly))).toBeLessThan(1e-12);
  });

  it('leaves every element but the mean anomaly untouched', () => {
    const elements = referenceOrbit();
    const advanced = propagateElements(elements, GM_SUN_KM3_S2, 12_345.678);

    expect(advanced.semiMajorAxisKm).toBe(elements.semiMajorAxisKm);
    expect(advanced.eccentricity).toBe(elements.eccentricity);
    expect(advanced.inclination).toBe(elements.inclination);
    expect(advanced.longitudeOfAscendingNode).toBe(elements.longitudeOfAscendingNode);
    expect(advanced.argumentOfPeriapsis).toBe(elements.argumentOfPeriapsis);
    expect(advanced.meanAnomaly).not.toBe(elements.meanAnomaly);
  });
});

describe('vector helpers', () => {
  it('computes magnitude, dot and cross correctly', () => {
    expect(magnitude({ x: 3, y: 4, z: 0 })).toBe(5);
    expect(dot({ x: 1, y: 2, z: 3 }, { x: 4, y: -5, z: 6 })).toBe(12);

    const c = cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    expect([c.x, c.y, c.z]).toEqual([0, 0, 1]);
  });

  it('makes the cross product perpendicular to both operands', () => {
    forEachSample(DEFAULT_SEED ^ 0xeeee, 200, (sampler, context) => {
      const [ax, ay, az] = sampler.unitVector();
      const [bx, by, bz] = sampler.unitVector();
      const a = { x: ax, y: ay, z: az };
      const b = { x: bx, y: by, z: bz };
      const c = cross(a, b);

      expect(Math.abs(dot(c, a)), formatPropertyFailure(context, 0, dot(c, a))).toBeLessThan(1e-12);
      expect(Math.abs(dot(c, b)), formatPropertyFailure(context, 0, dot(c, b))).toBeLessThan(1e-12);
    });
  });
});
