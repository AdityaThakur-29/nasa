/**
 * Two-body Keplerian mechanics.
 *
 * SCOPE: this module is the FIXED-ELEMENT two-body propagator. Given a set of
 * orbital elements that do not change, it converts between elements and state
 * vectors and solves Kepler's equation. Specific orbital energy and specific
 * angular momentum are invariant here, which is why the conservation tests
 * target this module and not the secular JPL model in planets.ts, where a and e
 * drift by design and those quantities are genuinely not conserved. Asserting
 * conservation against the secular model would fail correctly, and the only way
 * to make it pass would be to loosen the tolerance until the test meant nothing.
 *
 * UNITS: distances in km, velocities in km/s, GM in km^3/s^2, angles in RADIANS.
 * The JPL element tables publish degrees, so conversion happens at the boundary
 * in planets.ts rather than here. Everything internal is radians so no function
 * has to document which convention it expects.
 *
 * ANGLE CONVENTION: the JPL page states Kepler's equation as
 *
 *     M = E - e* sin(E),   where e* = (180/pi) e = 57.29578 e
 *
 * with M and E in degrees. That is the same equation as the radian form
 *
 *     M = E - e sin(E)
 *
 * with the degree-to-radian factor folded into e* so that the sine term is
 * dimensionally consistent with degree-valued M and E. This module implements
 * the radian form, which is equivalent and avoids carrying a magic 57.29578
 * through the numerics.
 *
 * SOURCE for the coordinate construction: S1,
 * https://ssd.jpl.nasa.gov/planets/approx_pos.html (steps 4 through 6).
 * The velocity formulae are NOT on that page and are derived below from the
 * time derivative of Kepler's equation; the derivation is written out so the
 * result is checkable rather than asserted.
 */

/** Result of solving Kepler's equation, with convergence diagnostics. */
export interface KeplerSolution {
  /** Eccentric anomaly, radians. */
  readonly eccentricAnomaly: number;
  /** Iterations consumed. */
  readonly iterations: number;
  /**
   * Residual |M - (E - e sin E)| in radians.
   *
   * Reported rather than discarded so callers and tests can assert the quality
   * of the solution instead of trusting that it converged.
   */
  readonly residual: number;
  /** True when the residual met the requested tolerance. */
  readonly converged: boolean;
  /** Which algorithm produced the answer. */
  readonly method: 'newton' | 'bisection';
}

/** Classical Keplerian elements, angles in radians, length in km. */
export interface OrbitalElements {
  /** Semi-major axis, km. */
  readonly semiMajorAxisKm: number;
  /** Eccentricity, dimensionless. */
  readonly eccentricity: number;
  /** Inclination, radians. */
  readonly inclination: number;
  /** Longitude of the ascending node, radians. */
  readonly longitudeOfAscendingNode: number;
  /** Argument of periapsis, radians. */
  readonly argumentOfPeriapsis: number;
  /** Mean anomaly, radians. */
  readonly meanAnomaly: number;
}

/** A cartesian 3-vector. Plain object so the simulation layer stays render-free. */
export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Position and velocity in a single frame. */
export interface StateVectors {
  /** Position, km. */
  readonly position: Vector3Like;
  /** Velocity, km/s. */
  readonly velocity: Vector3Like;
}

const TWO_PI = 2 * Math.PI;

/**
 * Default tolerance for the Kepler solver, radians.
 *
 * 1e-14 rad is about 2 nanoarcseconds. Chosen to sit just above the f64 noise
 * floor for these expressions, so the residual is limited by arithmetic rather
 * than by an arbitrary early exit. The validation suite asserts a looser 1e-11,
 * which this comfortably clears. The JPL page suggests 1e-6 DEGREES for its own
 * purposes; that is far coarser and is not used here.
 */
export const KEPLER_TOLERANCE = 1e-14;

/** Iteration cap before falling back to bisection. */
const MAX_NEWTON_ITERATIONS = 60;

/** Iteration cap for the bisection fallback. */
const MAX_BISECTION_ITERATIONS = 200;

/**
 * Wraps an angle to the HALF-OPEN interval [-pi, pi).
 *
 * The JPL algorithm requires the mean anomaly reduced to a symmetric interval
 * before solving. Using [-pi, pi) rather than [0, 2pi) keeps the starter
 * estimate close to the root and keeps the |E - M| <= e bracket below valid.
 *
 * HALF-OPEN, NOT CLOSED, and deliberately so. On a closed interval the
 * boundary is ambiguous: +pi and -pi are the same angle modulo 2pi, so an
 * input of 3pi would have two equally valid answers. Excluding the upper end
 * makes the result a unique canonical representative, which means the function
 * is a true function of the angle rather than of how the angle was written.
 * Consequently wrapToPi(3 * PI) is -pi, not +pi.
 *
 * The choice is harmless downstream: both representatives place the body at
 * apoapsis, and the solver returns the same position and velocity for either.
 */
export function wrapToPi(angle: number): number {
  const wrapped = ((angle + Math.PI) % TWO_PI + TWO_PI) % TWO_PI;
  return wrapped - Math.PI;
}

/** Wraps an angle to [0, 2pi). */
export function wrapToTwoPi(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Solves M = E - e sin(E) for the eccentric anomaly E.
 *
 * METHOD: Newton-Raphson from the starter E0 = M + e sin(M), which the JPL page
 * recommends for faster convergence, with two safeguards.
 *
 * SAFEGUARD 1, step clamping. For eccentricities approaching 1 the derivative
 * 1 - e cos(E) becomes small near periapsis (0.05 at e = 0.95, E = 0), so an
 * unclamped Newton step can overshoot far past the root and converge slowly or
 * oscillate. Steps are limited to 1 radian, which cannot skip the root because
 * of the bracket below.
 *
 * SAFEGUARD 2, guaranteed bracket. Since E - M = e sin(E) and |sin| <= 1, the
 * root always satisfies |E - M| <= e. That gives the exact bracket
 * [M - e, M + e] with no estimation involved. If Newton fails to reach the
 * tolerance the solver falls back to bisection on that bracket, which converges
 * unconditionally because f(E) = E - e sin(E) - M is continuous and strictly
 * increasing for e < 1.
 *
 * The function therefore always returns a usable answer, and always reports
 * which method produced it and what residual was achieved.
 *
 * @param meanAnomaly mean anomaly in radians, any range
 * @param eccentricity eccentricity, 0 <= e < 1
 * @param tolerance residual target in radians
 */
export function solveKeplerEquation(
  meanAnomaly: number,
  eccentricity: number,
  tolerance: number = KEPLER_TOLERANCE,
): KeplerSolution {
  if (!Number.isFinite(meanAnomaly)) {
    throw new Error(`solveKeplerEquation: mean anomaly must be finite, got ${meanAnomaly}`);
  }
  if (!Number.isFinite(eccentricity) || eccentricity < 0) {
    throw new Error(`solveKeplerEquation: eccentricity must be finite and >= 0, got ${eccentricity}`);
  }
  if (eccentricity >= 1) {
    // Parabolic and hyperbolic trajectories need Barker's equation or the
    // hyperbolic Kepler equation. Refusing loudly is better than silently
    // returning a meaningless elliptical answer.
    throw new Error(
      `solveKeplerEquation: only elliptical orbits are supported (e < 1), got ${eccentricity}`,
    );
  }

  const m = wrapToPi(meanAnomaly);

  // Circular orbit: E = M exactly, no iteration required.
  if (eccentricity === 0) {
    return {
      eccentricAnomaly: m,
      iterations: 0,
      residual: 0,
      converged: true,
      method: 'newton',
    };
  }

  const residualAt = (e: number): number => e - eccentricity * Math.sin(e) - m;

  let current = m + eccentricity * Math.sin(m);
  let iterations = 0;

  for (let i = 0; i < MAX_NEWTON_ITERATIONS; i++) {
    iterations = i + 1;

    const f = residualAt(current);
    if (Math.abs(f) <= tolerance) {
      return {
        eccentricAnomaly: current,
        iterations,
        residual: Math.abs(f),
        converged: true,
        method: 'newton',
      };
    }

    const derivative = 1 - eccentricity * Math.cos(current);
    // Cannot vanish for e < 1, but guard anyway: a zero here would produce a
    // non-finite step and silently corrupt the result.
    if (derivative === 0) break;

    const step = Math.max(-1, Math.min(1, -f / derivative));
    const next = current + step;
    if (next === current) {
      // Converged to the limit of f64 resolution; no further progress possible.
      return {
        eccentricAnomaly: current,
        iterations,
        residual: Math.abs(f),
        converged: Math.abs(f) <= tolerance,
        method: 'newton',
      };
    }
    current = next;
  }

  // Newton did not reach the tolerance. Bisect the guaranteed bracket.
  let low = m - eccentricity;
  let high = m + eccentricity;
  let fLow = residualAt(low);

  for (let i = 0; i < MAX_BISECTION_ITERATIONS; i++) {
    const mid = 0.5 * (low + high);
    const fMid = residualAt(mid);

    if (Math.abs(fMid) <= tolerance || mid === low || mid === high) {
      return {
        eccentricAnomaly: mid,
        iterations: iterations + i + 1,
        residual: Math.abs(fMid),
        converged: Math.abs(fMid) <= tolerance,
        method: 'bisection',
      };
    }

    if (Math.sign(fMid) === Math.sign(fLow)) {
      low = mid;
      fLow = fMid;
    } else {
      high = mid;
    }
  }

  const finalResidual = Math.abs(residualAt(current));
  return {
    eccentricAnomaly: current,
    iterations: iterations + MAX_BISECTION_ITERATIONS,
    residual: finalResidual,
    converged: false,
    method: 'bisection',
  };
}

/**
 * True anomaly from eccentric anomaly.
 *
 * Uses the atan2 form rather than the arccos form, which loses the quadrant and
 * would fold the second half of the orbit onto the first.
 */
export function trueAnomalyFromEccentric(eccentricAnomaly: number, eccentricity: number): number {
  const sinE = Math.sin(eccentricAnomaly);
  const cosE = Math.cos(eccentricAnomaly);
  return Math.atan2(Math.sqrt(1 - eccentricity * eccentricity) * sinE, cosE - eccentricity);
}

/** Eccentric anomaly from true anomaly. Inverse of the above. */
export function eccentricAnomalyFromTrue(trueAnomaly: number, eccentricity: number): number {
  const sinV = Math.sin(trueAnomaly);
  const cosV = Math.cos(trueAnomaly);
  return Math.atan2(
    Math.sqrt(1 - eccentricity * eccentricity) * sinV,
    cosV + eccentricity,
  );
}

/** Mean anomaly from eccentric anomaly, by direct application of Kepler's equation. */
export function meanAnomalyFromEccentric(eccentricAnomaly: number, eccentricity: number): number {
  return eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
}

/**
 * Mean motion, radians per second.
 *
 * n = sqrt(GM / a^3).
 */
export function meanMotion(semiMajorAxisKm: number, gmKm3S2: number): number {
  if (semiMajorAxisKm <= 0) {
    throw new Error(`meanMotion: semi-major axis must be positive, got ${semiMajorAxisKm}`);
  }
  return Math.sqrt(gmKm3S2 / (semiMajorAxisKm * semiMajorAxisKm * semiMajorAxisKm));
}

/** Orbital period, seconds. */
export function orbitalPeriodSeconds(semiMajorAxisKm: number, gmKm3S2: number): number {
  return TWO_PI / meanMotion(semiMajorAxisKm, gmKm3S2);
}

/**
 * Position in the orbital plane, with the x axis from focus to periapsis.
 *
 * S1 step 4:
 *   x' = a (cos E - e)
 *   y' = a sqrt(1 - e^2) sin E
 *   z' = 0
 */
export function orbitalPlanePosition(
  semiMajorAxisKm: number,
  eccentricity: number,
  eccentricAnomaly: number,
): { readonly x: number; readonly y: number } {
  return {
    x: semiMajorAxisKm * (Math.cos(eccentricAnomaly) - eccentricity),
    y: semiMajorAxisKm * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly),
  };
}

/**
 * Velocity in the orbital plane, km/s.
 *
 * NOT published on the S1 page. Derived here:
 *
 *   Kepler's equation      M = E - e sin E
 *   differentiate in time  dM/dt = n = (dE/dt)(1 - e cos E)
 *   therefore              dE/dt = n / (1 - e cos E)
 *
 *   x' = a (cos E - e)              =>  dx'/dt = -a sin E (dE/dt)
 *   y' = a sqrt(1-e^2) sin E        =>  dy'/dt =  a sqrt(1-e^2) cos E (dE/dt)
 *
 * The factor 1 - e cos E is r/a, so dE/dt = n a / r, which is the familiar
 * statement that angular rate rises as the body approaches periapsis.
 */
export function orbitalPlaneVelocity(
  semiMajorAxisKm: number,
  eccentricity: number,
  eccentricAnomaly: number,
  gmKm3S2: number,
): { readonly x: number; readonly y: number } {
  const n = meanMotion(semiMajorAxisKm, gmKm3S2);
  const eDot = n / (1 - eccentricity * Math.cos(eccentricAnomaly));
  return {
    x: -semiMajorAxisKm * Math.sin(eccentricAnomaly) * eDot,
    y:
      semiMajorAxisKm *
      Math.sqrt(1 - eccentricity * eccentricity) *
      Math.cos(eccentricAnomaly) *
      eDot,
  };
}

/**
 * Rotates orbital-plane coordinates into the reference plane.
 *
 * S1 step 5, the composition Rz(-Omega) Rx(-I) Rz(-omega) written out. The
 * source gives this as an explicit 2-column form because z' is always zero;
 * that form is reproduced here rather than building a full 3x3 matrix, so it
 * can be compared with the page directly.
 *
 * Applies to velocity as well as position: the transformation is a constant
 * rotation for fixed elements, so it commutes with time differentiation.
 */
export function orbitalPlaneToReferencePlane(
  planar: { readonly x: number; readonly y: number },
  argumentOfPeriapsis: number,
  inclination: number,
  longitudeOfAscendingNode: number,
): Vector3Like {
  const cosW = Math.cos(argumentOfPeriapsis);
  const sinW = Math.sin(argumentOfPeriapsis);
  const cosO = Math.cos(longitudeOfAscendingNode);
  const sinO = Math.sin(longitudeOfAscendingNode);
  const cosI = Math.cos(inclination);
  const sinI = Math.sin(inclination);

  return {
    x: (cosW * cosO - sinW * sinO * cosI) * planar.x + (-sinW * cosO - cosW * sinO * cosI) * planar.y,
    y: (cosW * sinO + sinW * cosO * cosI) * planar.x + (-sinW * sinO + cosW * cosO * cosI) * planar.y,
    z: sinW * sinI * planar.x + cosW * sinI * planar.y,
  };
}

/**
 * Rotates an ecliptic vector into the J2000 equatorial (ICRF) frame.
 *
 * S1 step 6. A rotation about the x axis by the obliquity.
 */
export function eclipticToEquatorial(vector: Vector3Like, obliquityRad: number): Vector3Like {
  const cosE = Math.cos(obliquityRad);
  const sinE = Math.sin(obliquityRad);
  return {
    x: vector.x,
    y: cosE * vector.y - sinE * vector.z,
    z: sinE * vector.y + cosE * vector.z,
  };
}

/** Inverse of eclipticToEquatorial. */
export function equatorialToEcliptic(vector: Vector3Like, obliquityRad: number): Vector3Like {
  const cosE = Math.cos(obliquityRad);
  const sinE = Math.sin(obliquityRad);
  return {
    x: vector.x,
    y: cosE * vector.y + sinE * vector.z,
    z: -sinE * vector.y + cosE * vector.z,
  };
}

/**
 * Full elements to state vectors, in the plane the elements are referred to.
 *
 * The returned frame is whatever frame the elements use; for the JPL tables that
 * is the J2000 ecliptic. Converting to equatorial is a separate, explicit step.
 */
export function elementsToStateVectors(
  elements: OrbitalElements,
  gmKm3S2: number,
  tolerance: number = KEPLER_TOLERANCE,
): StateVectors & { readonly solution: KeplerSolution } {
  const solution = solveKeplerEquation(elements.meanAnomaly, elements.eccentricity, tolerance);

  const planarPosition = orbitalPlanePosition(
    elements.semiMajorAxisKm,
    elements.eccentricity,
    solution.eccentricAnomaly,
  );
  const planarVelocity = orbitalPlaneVelocity(
    elements.semiMajorAxisKm,
    elements.eccentricity,
    solution.eccentricAnomaly,
    gmKm3S2,
  );

  return {
    position: orbitalPlaneToReferencePlane(
      planarPosition,
      elements.argumentOfPeriapsis,
      elements.inclination,
      elements.longitudeOfAscendingNode,
    ),
    velocity: orbitalPlaneToReferencePlane(
      planarVelocity,
      elements.argumentOfPeriapsis,
      elements.inclination,
      elements.longitudeOfAscendingNode,
    ),
    solution,
  };
}

// --------------------------------------------------------------------------
// Vector helpers. Local, minimal, and deliberately not from a render library:
// the simulation layer must not depend on the renderer.
// --------------------------------------------------------------------------

export function magnitude(v: Vector3Like): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function dot(a: Vector3Like, b: Vector3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vector3Like, b: Vector3Like): Vector3Like {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function scale(v: Vector3Like, factor: number): Vector3Like {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

export function add(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

// --------------------------------------------------------------------------
// Conserved quantities. These are invariant for FIXED elements only.
// --------------------------------------------------------------------------

/**
 * Specific orbital energy, km^2/s^2.
 *
 *   epsilon = v^2/2 - GM/r
 *
 * Invariant along a fixed-element two-body orbit, and equal to -GM/(2a). Both
 * forms are used in the validation suite: agreement between them is an
 * independent check that position and velocity are mutually consistent.
 */
export function specificOrbitalEnergy(state: StateVectors, gmKm3S2: number): number {
  const r = magnitude(state.position);
  const v = magnitude(state.velocity);
  return (v * v) / 2 - gmKm3S2 / r;
}

/**
 * Specific angular momentum vector, km^2/s.
 *
 *   h = r x v
 *
 * Invariant in both magnitude and direction for a two-body orbit. The direction
 * being invariant is what fixes the orbital plane.
 */
export function specificAngularMomentum(state: StateVectors): Vector3Like {
  return cross(state.position, state.velocity);
}

/**
 * Semi-major axis implied by a state vector, km.
 *
 * Inverted from epsilon = -GM/(2a). An independent route to a, used to check
 * the elements-to-state conversion.
 */
export function semiMajorAxisFromState(state: StateVectors, gmKm3S2: number): number {
  return -gmKm3S2 / (2 * specificOrbitalEnergy(state, gmKm3S2));
}

/**
 * State vectors back to Keplerian elements.
 *
 * Standard formulation. Included so the validation suite can assert an
 * elements -> state -> elements round trip, which catches sign and quadrant
 * errors that a one-way conversion cannot.
 *
 * DEGENERATE CASES, handled explicitly rather than left to produce NaN:
 *
 *   Circular orbit (e ~ 0). The eccentricity vector vanishes, so the argument
 *   of periapsis is undefined. Convention here: omega = 0, and the anomaly is
 *   measured from the ascending node.
 *
 *   Equatorial orbit (i ~ 0 or i ~ pi). The node line vanishes, so the
 *   longitude of the ascending node is undefined. Convention here: Omega = 0,
 *   and the periapsis longitude is measured from the reference x axis.
 *
 * These conventions are choices, not physics. A round trip through a degenerate
 * orbit therefore recovers the same POSITION and VELOCITY but need not recover
 * the same element values, and the validation suite tests the round trip on
 * state vectors for those cases rather than on element equality.
 */
export function stateVectorsToElements(state: StateVectors, gmKm3S2: number): OrbitalElements {
  const { position, velocity } = state;
  const r = magnitude(position);
  const v = magnitude(velocity);

  if (r === 0) {
    throw new Error('stateVectorsToElements: position vector has zero magnitude');
  }

  const h = cross(position, velocity);
  const hMagnitude = magnitude(h);
  if (hMagnitude === 0) {
    // Purely radial motion has no orbital plane and no well-defined elements.
    throw new Error('stateVectorsToElements: degenerate radial trajectory, angular momentum is zero');
  }

  const semiMajorAxisKm = -gmKm3S2 / (2 * ((v * v) / 2 - gmKm3S2 / r));

  // Eccentricity vector, pointing at periapsis.
  const eccentricityVector = scale(
    subtract(scale(position, v * v - gmKm3S2 / r), scale(velocity, dot(position, velocity))),
    1 / gmKm3S2,
  );
  const eccentricity = magnitude(eccentricityVector);

  const inclination = Math.acos(Math.max(-1, Math.min(1, h.z / hMagnitude)));

  // Node vector, zhat x h, which points at the ascending node.
  const nodeVector: Vector3Like = { x: -h.y, y: h.x, z: 0 };
  const nodeMagnitude = magnitude(nodeVector);

  // Thresholds are relative to the vectors they test, so the classification does
  // not depend on the absolute scale of the orbit.
  const equatorial = nodeMagnitude < 1e-12 * hMagnitude;
  const circular = eccentricity < 1e-12;

  let longitudeOfAscendingNode: number;
  let argumentOfPeriapsis: number;
  let trueAnomaly: number;

  if (equatorial && circular) {
    // Neither node nor periapsis defined. Measure position from the x axis.
    longitudeOfAscendingNode = 0;
    argumentOfPeriapsis = 0;
    trueAnomaly = Math.atan2(position.y, position.x);
    if (h.z < 0) trueAnomaly = -trueAnomaly;
  } else if (equatorial) {
    // Periapsis defined, node not. Measure periapsis from the x axis.
    longitudeOfAscendingNode = 0;
    argumentOfPeriapsis = Math.atan2(eccentricityVector.y, eccentricityVector.x);
    if (h.z < 0) argumentOfPeriapsis = -argumentOfPeriapsis;
    trueAnomaly = angleBetween(eccentricityVector, position, h);
  } else if (circular) {
    // Node defined, periapsis not. Measure position from the node.
    longitudeOfAscendingNode = Math.atan2(nodeVector.y, nodeVector.x);
    argumentOfPeriapsis = 0;
    trueAnomaly = angleBetween(nodeVector, position, h);
  } else {
    longitudeOfAscendingNode = Math.atan2(nodeVector.y, nodeVector.x);
    argumentOfPeriapsis = angleBetween(nodeVector, eccentricityVector, h);
    trueAnomaly = angleBetween(eccentricityVector, position, h);
  }

  const eccentricAnomaly = eccentricAnomalyFromTrue(trueAnomaly, eccentricity);

  return {
    semiMajorAxisKm,
    eccentricity,
    inclination,
    longitudeOfAscendingNode: wrapToTwoPi(longitudeOfAscendingNode),
    argumentOfPeriapsis: wrapToTwoPi(argumentOfPeriapsis),
    meanAnomaly: wrapToTwoPi(meanAnomalyFromEccentric(eccentricAnomaly, eccentricity)),
  };
}

/**
 * Signed angle from `from` to `to`, measured about `axis`, in [0, 2pi).
 *
 * Uses atan2 on the components parallel and perpendicular to `from` within the
 * plane normal to `axis`. An arccos of the normalised dot product would lose the
 * sign and collapse angles above pi onto their reflections, which is the classic
 * source of quadrant errors in element extraction.
 */
function angleBetween(from: Vector3Like, to: Vector3Like, axis: Vector3Like): number {
  const axisMagnitude = magnitude(axis);
  const unitAxis = scale(axis, 1 / axisMagnitude);
  const perpendicular = cross(unitAxis, from);
  return wrapToTwoPi(Math.atan2(dot(to, perpendicular), dot(to, from)));
}

/**
 * Propagates fixed elements forward by an interval, seconds.
 *
 * Only the mean anomaly advances: M(t) = M0 + n dt. Every other element is held
 * constant, which is precisely what makes energy and angular momentum invariant
 * under this operation.
 */
export function propagateElements(
  elements: OrbitalElements,
  gmKm3S2: number,
  deltaSeconds: number,
): OrbitalElements {
  const n = meanMotion(elements.semiMajorAxisKm, gmKm3S2);
  return {
    ...elements,
    meanAnomaly: wrapToTwoPi(elements.meanAnomaly + n * deltaSeconds),
  };
}

/** Periapsis distance, km. */
export function periapsisDistanceKm(elements: OrbitalElements): number {
  return elements.semiMajorAxisKm * (1 - elements.eccentricity);
}

/** Apoapsis distance, km. */
export function apoapsisDistanceKm(elements: OrbitalElements): number {
  return elements.semiMajorAxisKm * (1 + elements.eccentricity);
}
