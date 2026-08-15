/**
 * Simulation state validation.
 *
 * THE CENTRAL RISK THIS FILE ADDRESSES: state.ts reconciles two frames. Positions
 * arrive from the JPL fit in the J2000 ECLIPTIC frame; orientations arrive from
 * the IAU model in the J2000 EQUATORIAL frame. Getting that conversion wrong
 * would tilt every rotation axis by the obliquity, about 23.4 degrees, and the
 * result would STILL be orthonormal with determinant +1. So a matrix-algebra
 * check cannot detect it. The conversion is therefore verified against an
 * independently composed rotation, and against Earth's obliquity, which is known
 * exactly in the ecliptic frame by definition.
 */

import { describe, expect, it } from 'vitest';
import {
  SIMULATION_FRAME,
  SIMULATION_ORIGIN,
  SimulationState,
  composePosition,
  snapshotJdNumber,
  type BodySimState,
} from '@/sim/state';
import { SimulationClock } from '@/core/clock';
import { ttFromUtc, utc, toNumber, SECONDS_PER_DAY } from '@/core/jd';
import { BODY_ORDER, PLANET_IDS, getBody } from '@/data/bodies';
import { AU_KM, DEG_TO_RAD, J2000_OBLIQUITY_DEG } from '@/data/constants';
import { createPlanetsProvider } from '@/ephemeris/planets';
import { computeOrientation } from '@/ephemeris/orientation';
import {
  cross,
  dot,
  equatorialToEcliptic,
  magnitude,
  scale,
  subtract,
  type Vector3Like,
} from '@/ephemeris/kepler';
import type { EphemerisProvider, BodyState, EphemerisMetadata } from '@/ephemeris/provider';

const OBLIQUITY_RAD = J2000_OBLIQUITY_DEG * DEG_TO_RAD;

/** A state fixed at a known instant, so assertions are reproducible. */
function stateAt(year: number, month = 1, day = 1): SimulationState {
  return new SimulationState({
    clock: new SimulationClock({ epoch: utc(year, month, day), paused: true }),
  });
}

/** Ecliptic north, which in the ecliptic frame is simply +Z. */
const ECLIPTIC_NORTH: Vector3Like = { x: 0, y: 0, z: 1 };

/** Angle between two vectors, degrees. */
function angleBetweenDeg(a: Vector3Like, b: Vector3Like): number {
  const cosine = dot(a, b) / (magnitude(a) * magnitude(b));
  return Math.acos(Math.max(-1, Math.min(1, cosine))) / DEG_TO_RAD;
}

/** Columns of a row-major 3x3 as vectors. */
function columns(m: readonly number[]): readonly [Vector3Like, Vector3Like, Vector3Like] {
  return [
    { x: m[0]!, y: m[3]!, z: m[6]! },
    { x: m[1]!, y: m[4]!, z: m[7]! },
    { x: m[2]!, y: m[5]!, z: m[8]! },
  ];
}

describe('frame and origin declaration', () => {
  it('declares one canonical frame and origin on every snapshot', () => {
    const snapshot = stateAt(2026, 8, 15).snapshot();
    expect(snapshot.frame).toBe('J2000_ECLIPTIC');
    expect(snapshot.origin).toBe('SUN');
    expect(SIMULATION_FRAME).toBe('J2000_ECLIPTIC');
    expect(SIMULATION_ORIGIN).toBe('SUN');
  });

  it('places the frame origin at exactly zero', () => {
    // In a heliocentric frame the Sun is at the origin BY DEFINITION, so it needs
    // no ephemeris and must not acquire a position from one.
    const sun = stateAt(2026).getBody('sun')!;
    expect(sun.positionKm).toEqual({ x: 0, y: 0, z: 0 });
    expect(sun.distanceFromSunKm).toBe(0);
    expect(sun.parentId).toBeNull();
    expect(sun.providerId).toBe('frame-origin');
  });
});

describe('orientation frame conversion', () => {
  /**
   * THE ASSERTION THAT ACTUALLY VALIDATES THE CONVERSION.
   *
   * The frame change is a rotation R applied on the LEFT: M_ecliptic = R M_equatorial.
   * state.ts implements that by rotating each column of M individually, which is
   * algebraically the same thing. Composing R M independently here and comparing
   * catches a wrong-side application, a transposed R, or a sign error in the
   * obliquity, none of which a determinant or orthonormality check could see.
   */
  it('equals the independently composed rotation R times M', () => {
    const jd = ttFromUtc(utc(2026, 8, 15));
    const state = stateAt(2026, 8, 15);

    for (const bodyId of BODY_ORDER) {
      const body = state.getBody(bodyId);
      if (body === undefined) continue;

      const equatorial = computeOrientation(bodyId, jd).bodyToInertial;

      // Independent composition: rotate each equatorial column into the ecliptic
      // frame using the primitive from the ephemeris layer.
      const [eqX, eqY, eqZ] = columns(equatorial);
      const expected = [
        equatorialToEcliptic(eqX, OBLIQUITY_RAD),
        equatorialToEcliptic(eqY, OBLIQUITY_RAD),
        equatorialToEcliptic(eqZ, OBLIQUITY_RAD),
      ];

      const [actualX, actualY, actualZ] = columns(body.orientation);
      const actual = [actualX, actualY, actualZ];

      for (let i = 0; i < 3; i++) {
        expect(
          magnitude(subtract(actual[i]!, expected[i]!)),
          `${bodyId}: converted column ${i} disagrees with R M`,
        ).toBeLessThan(1e-12);
      }
    }
  });

  it('keeps the converted matrix orthonormal with determinant +1', () => {
    // Necessary but NOT sufficient, which is why the assertion above exists. A
    // wrongly applied rotation would pass this.
    for (const bodyId of BODY_ORDER) {
      const body = stateAt(2026).getBody(bodyId);
      if (body === undefined) continue;

      const [c0, c1, c2] = columns(body.orientation);
      for (const [index, column] of [c0, c1, c2].entries()) {
        expect(Math.abs(magnitude(column) - 1), `${bodyId} column ${index}`).toBeLessThan(1e-12);
      }
      expect(Math.abs(dot(c0, c1)), `${bodyId} x.y`).toBeLessThan(1e-12);
      expect(Math.abs(dot(c0, c2)), `${bodyId} x.z`).toBeLessThan(1e-12);
      expect(Math.abs(dot(c1, c2)), `${bodyId} y.z`).toBeLessThan(1e-12);

      // Right-handed: x cross y must be z, not -z.
      expect(magnitude(subtract(cross(c0, c1), c2)), `${bodyId} is left-handed`).toBeLessThan(1e-12);
    }
  });

  it('tilts Earth by exactly the obliquity in the ecliptic frame', () => {
    // THE PHYSICAL CHECK. Earth's IAU pole is at declination 90 in the equatorial
    // frame, so after conversion its angle from ecliptic north must equal the
    // obliquity. Any error in the conversion changes this number directly, and it
    // is verifiable from the S3 constant rather than from recollection.
    const earth = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2000, 1, 1, 12), paused: true }),
    }).getBody('earth')!;

    expect(angleBetweenDeg(earth.northPole, ECLIPTIC_NORTH)).toBeCloseTo(J2000_OBLIQUITY_DEG, 3);
  });

  it('keeps the north pole equal to the third column of the orientation', () => {
    // Both are converted independently in state.ts, so agreement confirms neither
    // was converted with a different rotation.
    for (const bodyId of BODY_ORDER) {
      const body = stateAt(2026).getBody(bodyId);
      if (body === undefined) continue;
      const [, , columnZ] = columns(body.orientation);
      expect(magnitude(subtract(columnZ, body.northPole)), `${bodyId}`).toBeLessThan(1e-12);
    }
  });

  it('reproduces the expected obliquity ordering across the planets', () => {
    // Measured against each planet's own orbit normal, which in this frame comes
    // straight from r x v with no further rotation. Uranus must be near
    // perpendicular and Venus near inverted; both emerge from the data.
    const state = stateAt(2000, 1, 1);

    const obliquityOf = (bodyId: string): number => {
      const body = state.getBody(bodyId)!;
      const orbitNormal = cross(body.positionKm, body.velocityKmS!);
      // The spin axis opposes the IAU pole for a retrograde rotator.
      const spinAxis = body.retrograde ? scale(body.northPole, -1) : body.northPole;
      return angleBetweenDeg(spinAxis, orbitNormal);
    };

    expect(obliquityOf('uranus')).toBeGreaterThan(90);
    expect(obliquityOf('venus')).toBeGreaterThan(150);
    expect(obliquityOf('earth')).toBeGreaterThan(20);
    expect(obliquityOf('earth')).toBeLessThan(27);
    expect(obliquityOf('mercury')).toBeLessThan(5);
  });

  it('flags exactly the retrograde rotators', () => {
    const state = stateAt(2026);
    const retrograde = PLANET_IDS.filter((id) => state.getBody(id)?.retrograde === true);
    expect(retrograde.sort()).toEqual(['uranus', 'venus']);
  });
});

describe('missing models are disclosed, never silently dropped', () => {
  it('lists the Moon as unavailable with a reason during M1', () => {
    // REGRESSION GUARD. An earlier revision filtered unsupported bodies out of the
    // simulated set entirely, so the Moon vanished from the snapshot with nothing
    // to indicate a tenth body was expected. Including it and reporting the reason
    // is what lets the interface say no lunar theory is loaded yet.
    const snapshot = stateAt(2026).snapshot();

    expect(snapshot.bodies.some((body) => body.bodyId === 'moon')).toBe(false);

    const moon = snapshot.unavailable.find((entry) => entry.bodyId === 'moon');
    expect(moon, 'the Moon must be reported as unavailable, not omitted').toBeDefined();
    expect(moon!.reason).toBe('NO_PROVIDER');
    expect(moon!.detail).toMatch(/moon/i);
  });

  it('places every other body in the registry', () => {
    const snapshot = stateAt(2026).snapshot();
    const placed = snapshot.bodies.map((body) => body.bodyId);
    const expected = BODY_ORDER.filter((id) => id !== 'moon');
    expect(placed).toEqual(expected);
  });

  it('reports a provider failure distinctly from a missing provider', () => {
    // The distinction matters: a missing model is a known gap, a throwing provider
    // is a defect. Collapsing them would hide the second.
    const brokenProvider: EphemerisProvider = {
      id: 'broken',
      supportedBodies: PLANET_IDS,
      getState(): BodyState {
        throw new Error('synthetic provider failure');
      },
      getMetadata(): EphemerisMetadata {
        throw new Error('synthetic provider failure');
      },
    };

    const snapshot = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), paused: true }),
      provider: brokenProvider,
    }).snapshot();

    const mars = snapshot.unavailable.find((entry) => entry.bodyId === 'mars');
    expect(mars).toBeDefined();
    expect(mars!.reason).toBe('PROVIDER_ERROR');
    expect(mars!.detail).toMatch(/synthetic provider failure/);

    // The frame origin needs no provider, so it survives a total provider failure.
    expect(snapshot.bodies.map((body) => body.bodyId)).toEqual(['sun']);
  });

  it('explains why a known body is unplaced, quoting the provider reason', () => {
    // The Moon has a physical record but no lunar theory in M1, so the error must
    // carry the specific reason rather than a generic absence.
    const state = stateAt(2026);
    expect(() => state.centreDistanceKm('earth', 'moon')).toThrow(/NO_PROVIDER/);
    expect(() => state.centreDistanceKm('earth', 'moon')).toThrow(/no ephemeris provider/);
  });

  it('lists the placed bodies when an entirely unknown id is requested', () => {
    // No reason entry exists for a body that was never in the simulated set, so
    // the message enumerates what IS placed. That is what makes a typo diagnosable.
    const state = stateAt(2026);
    expect(() => state.centreDistanceKm('earth', 'pluto')).toThrow(/"pluto" is not placed/);
    expect(() => state.centreDistanceKm('earth', 'pluto')).toThrow(/simulated bodies are/);
    expect(() => state.centreDistanceKm('earth', 'pluto')).toThrow(/neptune/);
  });
});

describe('hierarchical position', () => {
  it('makes the relative position identical to the absolute one for heliocentric bodies', () => {
    // Every M1 body orbits the Sun directly, so the two must coincide exactly.
    // Not approximately: the same vector should be used.
    for (const body of stateAt(2026).snapshot().bodies) {
      expect(body.positionRelativeToPrimaryKm, `${body.bodyId}`).toEqual(body.positionKm);
    }
  });

  it('recomposes an absolute position from a primary and an offset', () => {
    const state = stateAt(2026);
    const earth = state.getBody('earth')!;
    const recomposed = composePosition({ x: 0, y: 0, z: 0 }, earth.positionRelativeToPrimaryKm);
    expect(magnitude(subtract(recomposed, earth.positionKm))).toBe(0);
  });

  it('records the gravitational parent from the data layer', () => {
    const state = stateAt(2026);
    for (const body of state.snapshot().bodies) {
      expect(body.parentId, `${body.bodyId}`).toBe(getBody(body.bodyId).parentId);
    }
  });
});

describe('physical values are never scaled', () => {
  it('carries the published mean radius unchanged', () => {
    // Contract section 2: measurements use the physical radius. A visual
    // multiplier must never reach this field.
    for (const body of stateAt(2026).snapshot().bodies) {
      expect(body.physicalRadiusKm, `${body.bodyId}`).toBe(
        getBody(body.bodyId).meanRadiusKm.value,
      );
    }
  });

  it('exposes no render-space fields', () => {
    // Contract sections 2 and 39. The state layer must not carry visual radius,
    // colour, or any presentation property.
    const FORBIDDEN = [
      'visualradius',
      'visualradiusmultiplier',
      'renderposition',
      'scaledposition',
      'color',
      'colour',
      'texture',
      'material',
      'exaggeration',
    ];

    const body = stateAt(2026).snapshot().bodies[0]!;
    const keys = Object.keys(body).map((key) => key.toLowerCase());
    for (const forbidden of FORBIDDEN) {
      expect(keys, `state leaks render field "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('places the planets at plausible heliocentric distances', () => {
    // Sanity anchor on the whole pipeline, in astronomical units.
    const state = stateAt(2026, 8, 15);
    const distanceAu = (id: string): number => state.getBody(id)!.distanceFromSunKm / AU_KM;

    expect(distanceAu('mercury')).toBeGreaterThan(0.3);
    expect(distanceAu('mercury')).toBeLessThan(0.47);
    expect(distanceAu('earth')).toBeGreaterThan(0.98);
    expect(distanceAu('earth')).toBeLessThan(1.02);
    expect(distanceAu('neptune')).toBeGreaterThan(29);
    expect(distanceAu('neptune')).toBeLessThan(31);
  });

  it('agrees between the distance field and the position magnitude', () => {
    for (const body of stateAt(2026).snapshot().bodies) {
      expect(body.distanceFromSunKm, `${body.bodyId}`).toBeCloseTo(magnitude(body.positionKm), 6);
    }
  });
});

describe('distance measurement', () => {
  it('measures centre separation from physical positions', () => {
    const state = stateAt(2026, 8, 15);
    const earth = state.getBody('earth')!;
    const mars = state.getBody('mars')!;

    const expected = magnitude(subtract(mars.positionKm, earth.positionKm));
    expect(state.centreDistanceKm('earth', 'mars')).toBeCloseTo(expected, 6);
  });

  it('is symmetric', () => {
    const state = stateAt(2026);
    expect(state.centreDistanceKm('earth', 'jupiter')).toBeCloseTo(
      state.centreDistanceKm('jupiter', 'earth'),
      6,
    );
  });

  it('subtracts both physical radii for a surface measurement', () => {
    const state = stateAt(2026, 8, 15);
    const centre = state.centreDistanceKm('earth', 'mars');
    const surface = state.surfaceDistanceKm('earth', 'mars');

    expect(centre - surface).toBeCloseTo(
      getBody('earth').meanRadiusKm.value + getBody('mars').meanRadiusKm.value,
      6,
    );
  });

  it('reports zero centre distance from a body to itself', () => {
    expect(stateAt(2026).centreDistanceKm('mars', 'mars')).toBe(0);
  });

  it('measures the Sun to Earth distance as roughly one astronomical unit', () => {
    // Independent check that the origin really is the Sun.
    const state = stateAt(2026, 8, 15);
    const au = state.centreDistanceKm('sun', 'earth') / AU_KM;
    expect(au).toBeGreaterThan(0.98);
    expect(au).toBeLessThan(1.02);
  });
});

describe('time advance', () => {
  it('moves the bodies when time advances', () => {
    const state = new SimulationState({
      clock: new SimulationClock({
        epoch: utc(2026, 1, 1),
        rate: SECONDS_PER_DAY / 0.25,
        paused: false,
      }),
    });

    const before = state.getBody('earth')!.positionKm;
    state.update(0.25);
    const after = state.getBody('earth')!.positionKm;

    // Earth covers roughly 2.6 million km in a day.
    const movedKm = magnitude(subtract(after, before));
    expect(movedKm).toBeGreaterThan(2e6);
    expect(movedKm).toBeLessThan(3e6);
  });

  it('rotates the bodies as time advances', () => {
    const state = new SimulationState({
      clock: new SimulationClock({
        epoch: utc(2026, 1, 1),
        rate: SECONDS_PER_DAY / 0.25,
        paused: false,
      }),
    });

    const before = state.getBody('earth')!.primeMeridianDeg;
    state.update(0.25);
    const after = state.getBody('earth')!.primeMeridianDeg;

    // One day advances Earth's prime meridian by 360.9856 degrees, so the wrapped
    // change is about 0.986. This is the check that rotation and orbit are
    // independent motions.
    const advance = ((after - before) % 360 + 360) % 360;
    expect(advance).toBeCloseTo(0.9856, 2);
  });

  it('does not move anything while paused', () => {
    const state = stateAt(2026, 8, 15);
    const before = state.getBody('mars')!.positionKm;
    expect(state.update(1)).toBe(0);
    expect(state.getBody('mars')!.positionKm).toEqual(before);
  });

  it('increments the revision on every recomputation', () => {
    const state = stateAt(2026);
    const first = state.snapshot().revision;
    state.refresh();
    expect(state.snapshot().revision).toBe(first + 1);
    state.update(0);
    expect(state.snapshot().revision).toBe(first + 2);
  });

  it('leaves an existing snapshot unchanged when the state advances', () => {
    // Snapshots must be stable: an interface holding one for a frame must not see
    // it mutate underneath. recompute replaces the array rather than editing it.
    const state = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), rate: 1e6, paused: false }),
    });

    const held = state.snapshot();
    const heldEarthPosition = held.bodies.find((body) => body.bodyId === 'earth')!.positionKm;
    const capturedX = heldEarthPosition.x;

    state.update(0.25);

    expect(held.bodies.find((body) => body.bodyId === 'earth')!.positionKm.x).toBe(capturedX);
    expect(state.snapshot().bodies.find((body) => body.bodyId === 'earth')!.positionKm.x).not.toBe(
      capturedX,
    );
  });
});

describe('clock integration', () => {
  it('carries the clock snapshot without exposing the clock itself', () => {
    // Contract section 39: the interface receives a readonly derived snapshot and
    // has no route back into the simulation.
    const snapshot = stateAt(2026, 8, 15).snapshot();

    expect(snapshot.clock.formattedUtc).toBe('2026-08-15 00:00:00 UTC');
    expect(snapshot.clock.ephemerisTimeScale).toBe('TT');
    expect((snapshot as unknown as { getClock?: unknown }).getClock).toBeUndefined();
    expect((snapshot as unknown as { update?: unknown }).update).toBeUndefined();
  });

  it('exposes the clock to the owner for command wiring', () => {
    const clock = new SimulationClock({ epoch: utc(2026, 1, 1), paused: true });
    expect(new SimulationState({ clock }).getClock()).toBe(clock);
  });

  it('reports the snapshot Julian Date', () => {
    const state = stateAt(2026, 8, 15);
    expect(snapshotJdNumber(state.snapshot())).toBeCloseTo(toNumber(utc(2026, 8, 15)), 9);
  });
});

describe('status propagation', () => {
  it('marks bodies COMPUTED inside the model validity interval', () => {
    for (const body of stateAt(2026).snapshot().bodies) {
      expect(body.status, `${body.bodyId}`).toBe('COMPUTED');
    }
  });

  it('propagates OUT_OF_RANGE rather than hiding it', () => {
    // The clock's default range matches the element set's validity, so reaching an
    // out-of-range date requires widening the range deliberately. The status must
    // then reach the snapshot so the interface can warn.
    const state = new SimulationState({
      clock: new SimulationClock({
        epoch: utc(1700, 1, 1),
        range: { start: utc(1600, 1, 1), end: utc(2100, 1, 1) },
        paused: true,
      }),
    });

    const mars = state.getBody('mars')!;
    expect(mars.status).toBe('OUT_OF_RANGE');
    // Still placed, so the simulation does not stall at the boundary.
    expect(Number.isFinite(mars.positionKm.x)).toBe(true);
  });

  it('names the provider behind each body', () => {
    for (const body of stateAt(2026).snapshot().bodies) {
      if (body.bodyId === 'sun') continue;
      expect(body.providerId, `${body.bodyId}`).toContain('jpl-approximate');
    }
  });
});

describe('frame mismatch handling', () => {
  it('rotates a provider that returns equatorial vectors into the canonical frame', () => {
    // A provider declaring a different frame must be converted, not trusted. This
    // synthetic provider returns a known equatorial vector so the rotation can be
    // checked exactly.
    const equatorialPosition: Vector3Like = { x: 0, y: 0, z: AU_KM };

    const equatorialProvider: EphemerisProvider = {
      id: 'synthetic-equatorial',
      supportedBodies: ['earth'],
      getState(bodyId, jd): BodyState {
        return {
          bodyId,
          positionKm: equatorialPosition,
          velocityKmS: null,
          frame: 'J2000_EQUATORIAL',
          origin: 'SUN',
          epoch: jd,
          status: 'COMPUTED',
        };
      },
      getMetadata(bodyId): EphemerisMetadata {
        return {
          id: bodyId,
          model: 'synthetic',
          accuracy: 'n/a',
          validRange: { start: 0, end: 1e9 },
          source: 'S1',
          timeScale: 'TT',
          frame: 'J2000_EQUATORIAL',
          origin: 'SUN',
        };
      },
    };

    const earth = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), paused: true }),
      provider: equatorialProvider,
      bodyIds: ['sun', 'earth'],
    }).getBody('earth')!;

    const expected = equatorialToEcliptic(equatorialPosition, OBLIQUITY_RAD);
    expect(magnitude(subtract(earth.positionKm, expected))).toBeLessThan(1e-6);

    // An equatorial +Z vector must NOT remain on the ecliptic +Z axis.
    expect(Math.abs(earth.positionKm.y)).toBeGreaterThan(1e6);
    // The rotation preserves length.
    expect(earth.distanceFromSunKm).toBeCloseTo(AU_KM, 6);
  });

  it('leaves a provider already in the canonical frame untouched', () => {
    const jd = ttFromUtc(utc(2026, 8, 15));
    const direct = createPlanetsProvider().getState('mars', jd);
    const viaState = stateAt(2026, 8, 15).getBody('mars')!;
    expect(viaState.positionKm).toEqual(direct.positionKm);
  });

  it('handles a provider that supplies no velocity', () => {
    // Must surface as null rather than a fabricated zero, which would read as a
    // stationary body.
    const positionOnlyProvider: EphemerisProvider = {
      id: 'position-only',
      supportedBodies: ['earth'],
      getState(bodyId, jd): BodyState {
        return {
          bodyId,
          positionKm: { x: AU_KM, y: 0, z: 0 },
          velocityKmS: null,
          frame: 'J2000_ECLIPTIC',
          origin: 'SUN',
          epoch: jd,
          status: 'COMPUTED',
        };
      },
      getMetadata(bodyId): EphemerisMetadata {
        return {
          id: bodyId,
          model: 'position only',
          accuracy: 'n/a',
          validRange: { start: 0, end: 1e9 },
          source: 'S1',
          timeScale: 'TT',
          frame: 'J2000_ECLIPTIC',
          origin: 'SUN',
        };
      },
    };

    const earth = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), paused: true }),
      provider: positionOnlyProvider,
      bodyIds: ['sun', 'earth'],
    }).getBody('earth')!;

    expect(earth.velocityKmS).toBeNull();
  });
});

describe('body selection', () => {
  it('simulates only the requested bodies when a list is supplied', () => {
    const state = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), paused: true }),
      bodyIds: ['sun', 'earth', 'mars'],
    });
    expect(state.snapshot().bodies.map((body) => body.bodyId)).toEqual(['sun', 'earth', 'mars']);
    expect(state.getBody('jupiter')).toBeUndefined();
  });

  it('preserves the requested order', () => {
    const state = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 1, 1), paused: true }),
      bodyIds: ['sun', 'neptune', 'mercury'],
    });
    expect(state.snapshot().bodies.map((body) => body.bodyId)).toEqual([
      'sun',
      'neptune',
      'mercury',
    ]);
  });
});

describe('numerical integrity', () => {
  it('produces finite values for every field across the validity window', () => {
    // A NaN reaching the render layer would silently remove geometry, so it is
    // caught here rather than diagnosed on screen.
    for (const year of [1800, 1900, 2000, 2026, 2049]) {
      const snapshot = stateAt(year, 6, 15).snapshot();

      for (const body of snapshot.bodies) {
        const scalars: Array<[string, number]> = [
          ['distanceFromSunKm', body.distanceFromSunKm],
          ['physicalRadiusKm', body.physicalRadiusKm],
          ['primeMeridianDeg', body.primeMeridianDeg],
        ];
        for (const [name, value] of scalars) {
          expect(Number.isFinite(value), `${year} ${body.bodyId}.${name}`).toBe(true);
        }

        for (const axis of ['x', 'y', 'z'] as const) {
          expect(Number.isFinite(body.positionKm[axis]), `${year} ${body.bodyId}.pos.${axis}`).toBe(
            true,
          );
          expect(
            Number.isFinite(body.velocityKmS![axis]),
            `${year} ${body.bodyId}.vel.${axis}`,
          ).toBe(true);
          expect(Number.isFinite(body.northPole[axis]), `${year} ${body.bodyId}.pole.${axis}`).toBe(
            true,
          );
        }

        for (const [index, element] of body.orientation.entries()) {
          expect(Number.isFinite(element), `${year} ${body.bodyId}.orientation[${index}]`).toBe(
            true,
          );
        }

        const q = body.orientationQuaternion;
        expect(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1), `${year} ${body.bodyId} quat`).toBeLessThan(
          1e-12,
        );
      }
    }
  });

  it('keeps the planets near the ecliptic plane, as the frame choice implies', () => {
    // The motivation for choosing the ecliptic frame: |z| stays small relative to
    // r, which is what makes the overview camera and reference grid natural.
    const state = stateAt(2026, 8, 15);
    for (const id of PLANET_IDS) {
      const body = state.getBody(id)!;
      const ratio = Math.abs(body.positionKm.z) / body.distanceFromSunKm;
      // The largest planetary inclination is Mercury's 7 degrees, sin 7 = 0.122.
      expect(ratio, `${id} sits far from the ecliptic plane`).toBeLessThan(0.13);
    }
  });

  it('never returns the same object for two different bodies', () => {
    // Guards against a shared mutable vector being handed out repeatedly, which
    // would make one body's position track another's.
    const bodies = stateAt(2026).snapshot().bodies;
    const seen = new Set<unknown>();
    for (const body of bodies) {
      expect(seen.has(body.positionKm), `${body.bodyId} shares a position object`).toBe(false);
      seen.add(body.positionKm);
    }
  });
});

describe('snapshot shape', () => {
  it('exposes exactly the documented body fields', () => {
    // Pins the interface contract, so a field cannot be added without a
    // deliberate decision about whether the interface should see it.
    const expected: ReadonlyArray<keyof BodySimState> = [
      'bodyId',
      'displayName',
      'positionKm',
      'velocityKmS',
      'positionRelativeToPrimaryKm',
      'parentId',
      'distanceFromSunKm',
      'physicalRadiusKm',
      'orientation',
      'orientationQuaternion',
      'northPole',
      'primeMeridianDeg',
      'retrograde',
      'status',
      'providerId',
    ];
    const actual = Object.keys(stateAt(2026).snapshot().bodies[0]!).sort();
    expect(actual).toEqual([...expected].sort());
  });

  it('carries a display name from the data layer', () => {
    const state = stateAt(2026);
    expect(state.getBody('earth')!.displayName).toBe('Earth');
    expect(state.getBody('sun')!.displayName).toBe('Sun');
  });
});
