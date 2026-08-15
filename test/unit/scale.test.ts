/**
 * Render-space transform validation.
 *
 * WHAT THIS FILE EXISTS TO PROTECT: sim/scale.ts is the only module allowed to
 * scale anything, and it is the module where a mistake would silently fabricate
 * scientific content. Two failure modes are guarded specifically.
 *
 *   1. A transform that distorts orbital GEOMETRY while the interface claims
 *      geometry is accurate. This is Issue C, and the regression guard below
 *      measures the exact distortion the rejected approach would produce.
 *
 *   2. A render quantity leaking back into a physical one. Every test that
 *      touches a physical value asserts it is byte-identical afterwards.
 *
 * No astronomical value is asserted here. Distances and radii used as inputs come
 * from the cited data layer; everything checked is a property of the mapping.
 */

import { describe, expect, it } from 'vitest';
import {
  CROWDING_RATIO,
  DEFAULT_COMPRESSION_EXPONENT,
  DEFAULT_RADIUS_MULTIPLIER,
  RENDER_UNIT_KM,
  type ScalableBody,
  type ScaleConfig,
  compressDistanceKm,
  expandDistanceKm,
  fromRenderPosition,
  fromRenderRadius,
  getScaleDescription,
  satelliteOffsetFactor,
  scaleSystem,
  scientificScale,
  toRenderPosition,
  toRenderRadius,
  validateVisualBodySeparation,
  visualRadiusMultiplier,
  visualizedScale,
} from '@/sim/scale';
import { AU_KM } from '@/data/constants';
import { getBody } from '@/data/bodies';
import { magnitude, subtract, type Vector3Like } from '@/ephemeris/kepler';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

const SCIENTIFIC = scientificScale();
const VISUALIZED = visualizedScale();

/** Relative difference, falling back to absolute near zero. */
function relativeError(actual: number, expected: number): number {
  return Math.abs(expected) < 1e-30
    ? Math.abs(actual - expected)
    : Math.abs(actual - expected) / Math.abs(expected);
}

/** Body helper for building synthetic systems. */
function body(
  bodyId: string,
  positionKm: Vector3Like,
  physicalRadiusKm: number,
  parentId: string | null,
): ScalableBody {
  return { bodyId, positionKm, physicalRadiusKm, parentId };
}

describe('configuration', () => {
  it('makes scientific mode a pure unit conversion', () => {
    expect(SCIENTIFIC.mode).toBe('SCIENTIFIC');
    expect(SCIENTIFIC.radiusMultiplier).toBe(1);
    expect(SCIENTIFIC.compressionExponent).toBe(1);
    expect(SCIENTIFIC.renderUnitKm).toBe(RENDER_UNIT_KM);
  });

  it('defaults visualized mode to the documented parameters', () => {
    expect(VISUALIZED.compressionExponent).toBe(DEFAULT_COMPRESSION_EXPONENT);
    expect(VISUALIZED.radiusMultiplier).toBe(DEFAULT_RADIUS_MULTIPLIER);
    expect(VISUALIZED.compressionReferenceKm).toBe(AU_KM);
  });

  it('rejects an exponent outside the range that keeps the law monotonic', () => {
    // Outside (0, 1] the mapping stops being an order-preserving compression, so
    // the ordering guarantee the interface relies on would no longer hold.
    expect(() => visualizedScale({ compressionExponent: 0 })).toThrow(/\(0, 1\]/);
    expect(() => visualizedScale({ compressionExponent: -0.5 })).toThrow(/\(0, 1\]/);
    expect(() => visualizedScale({ compressionExponent: 1.5 })).toThrow(/\(0, 1\]/);
    expect(() => visualizedScale({ compressionExponent: Number.NaN })).toThrow(/\(0, 1\]/);
    // The identity is permitted: it means "no compression".
    expect(() => visualizedScale({ compressionExponent: 1 })).not.toThrow();
  });

  it('rejects non-physical unit and multiplier values', () => {
    expect(() => visualizedScale({ renderUnitKm: 0 })).toThrow(/renderUnitKm/);
    expect(() => visualizedScale({ renderUnitKm: -1 })).toThrow(/renderUnitKm/);
    expect(() => visualizedScale({ compressionReferenceKm: 0 })).toThrow(/compressionReferenceKm/);
    expect(() => visualizedScale({ radiusMultiplier: 0 })).toThrow(/radiusMultiplier/);
    expect(() => visualizedScale({ radiusMultiplier: Number.POSITIVE_INFINITY })).toThrow(
      /radiusMultiplier/,
    );
  });
});

describe('distance law', () => {
  it('is the identity in scientific mode', () => {
    for (const distanceKm of [0, 1, AU_KM, 30 * AU_KM]) {
      expect(compressDistanceKm(distanceKm, SCIENTIFIC)).toBe(distanceKm);
    }
  });

  it('fixes the reference radius, expands below it and compresses above it', () => {
    // The property that makes r0 = 1 au the right choice: inner planets separate,
    // outer planets stay reachable. Contract section 1.5.
    expect(compressDistanceKm(AU_KM, VISUALIZED)).toBeCloseTo(AU_KM, 3);

    const inner = compressDistanceKm(0.3 * AU_KM, VISUALIZED);
    expect(inner).toBeGreaterThan(0.3 * AU_KM);

    const outer = compressDistanceKm(30 * AU_KM, VISUALIZED);
    expect(outer).toBeLessThan(30 * AU_KM);
    expect(outer).toBeGreaterThan(AU_KM);
  });

  it('is strictly monotonic', () => {
    // CONTRACT REQUIREMENT (section 29): r1 < r2 implies f(r1) < f(r2). Without
    // this, relative distances on screen would not reflect relative distances in
    // reality, and the interface could not claim ordering is preserved.
    forEachSample(DEFAULT_SEED ^ 0x5ca1e, 800, (sampler, context) => {
      const a = sampler.logRange(1, 1e11);
      const b = a * sampler.range(1.000001, 10);

      const fa = compressDistanceKm(a, VISUALIZED);
      const fb = compressDistanceKm(b, VISUALIZED);

      expect(
        fb > fa,
        formatPropertyFailure({ ...context, a, b }, `f(${b}) > f(${a})`, `${fb} <= ${fa}`),
      ).toBe(true);
    });
  });

  it('is monotonic for every permitted exponent', () => {
    for (const exponent of [0.01, 0.1, 0.3, 0.45, 0.7, 0.99, 1]) {
      const config = visualizedScale({ compressionExponent: exponent });
      let previous = -1;
      for (let au = 0.1; au <= 50; au += 0.37) {
        const value = compressDistanceKm(au * AU_KM, config);
        expect(value, `exponent ${exponent} at ${au} au`).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  it('maps zero to zero', () => {
    expect(compressDistanceKm(0, VISUALIZED)).toBe(0);
    expect(expandDistanceKm(0, VISUALIZED)).toBe(0);
  });

  it('rejects a negative distance rather than returning a complex result', () => {
    // A fractional power of a negative number is NaN, which would propagate
    // silently into geometry.
    expect(() => compressDistanceKm(-1, VISUALIZED)).toThrow(/non-negative/);
    expect(() => expandDistanceKm(-1, VISUALIZED)).toThrow(/non-negative/);
  });

  it('inverts exactly', () => {
    // CONTRACT REQUIREMENT (section 29): physical -> render -> inverse must
    // recover the original.
    forEachSample(DEFAULT_SEED ^ 0x1a2b, 600, (sampler, context) => {
      const original = sampler.logRange(1, 1e11);
      const recovered = expandDistanceKm(compressDistanceKm(original, VISUALIZED), VISUALIZED);

      expect(
        relativeError(recovered, original),
        formatPropertyFailure(context, original, recovered),
      ).toBeLessThan(1e-12);
    });
  });

  it('inverts exactly for every permitted exponent', () => {
    for (const exponent of [0.05, 0.45, 0.9, 1]) {
      const config = visualizedScale({ compressionExponent: exponent });
      for (const au of [0.001, 0.1, 1, 5, 50, 1000]) {
        const original = au * AU_KM;
        const recovered = expandDistanceKm(compressDistanceKm(original, config), config);
        expect(relativeError(recovered, original), `exponent ${exponent} at ${au} au`).toBeLessThan(
          1e-11,
        );
      }
    }
  });
});

describe('position transform', () => {
  it('preserves direction exactly', () => {
    // Only the magnitude is compressed. A change of direction would move a body
    // to a different place in its orbit, not merely a different distance.
    forEachSample(DEFAULT_SEED ^ 0x3c4d, 400, (sampler, context) => {
      const [ux, uy, uz] = sampler.unitVector();
      const distanceKm = sampler.logRange(1e5, 1e10);
      const physical = { x: ux * distanceKm, y: uy * distanceKm, z: uz * distanceKm };

      const render = toRenderPosition(physical, VISUALIZED);
      const renderMagnitude = magnitude(render);

      // Unit vectors must match component by component.
      for (const [axis, component] of [
        ['x', ux],
        ['y', uy],
        ['z', uz],
      ] as const) {
        const renderUnit = render[axis] / renderMagnitude;
        expect(
          Math.abs(renderUnit - component),
          formatPropertyFailure({ ...context, axis }, component, renderUnit),
        ).toBeLessThan(1e-12);
      }
    });
  });

  it('divides by the render unit in scientific mode', () => {
    const physical = { x: AU_KM, y: 0, z: 0 };
    const render = toRenderPosition(physical, SCIENTIFIC);
    expect(render.x).toBeCloseTo(AU_KM / RENDER_UNIT_KM, 6);
    expect(render.y).toBe(0);
    expect(render.z).toBe(0);
  });

  it('maps the origin to the origin', () => {
    expect(toRenderPosition({ x: 0, y: 0, z: 0 }, VISUALIZED)).toEqual({ x: 0, y: 0, z: 0 });
    expect(fromRenderPosition({ x: 0, y: 0, z: 0 }, VISUALIZED)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('round-trips a heliocentric position', () => {
    forEachSample(DEFAULT_SEED ^ 0x5e6f, 400, (sampler, context) => {
      const [ux, uy, uz] = sampler.unitVector();
      const distanceKm = sampler.logRange(1e6, 1e10);
      const original = { x: ux * distanceKm, y: uy * distanceKm, z: uz * distanceKm };

      const recovered = fromRenderPosition(toRenderPosition(original, VISUALIZED), VISUALIZED);
      const error = magnitude(subtract(recovered, original)) / distanceKm;

      expect(error, formatPropertyFailure(context, 0, error)).toBeLessThan(1e-11);
    });
  });

  it('never mutates the input', () => {
    // The physical vector belongs to the simulation. Contract section 39.
    const physical = { x: AU_KM, y: 2 * AU_KM, z: 3 * AU_KM };
    const before = { ...physical };
    toRenderPosition(physical, VISUALIZED);
    fromRenderPosition(physical, VISUALIZED);
    expect(physical).toEqual(before);
  });
});

describe('ISSUE C: satellite orbit geometry', () => {
  /**
   * THE REGRESSION GUARD FOR THE CENTRAL DESIGN DECISION.
   *
   * Applying the radial compression to an ABSOLUTE heliocentric position scales
   * the radial direction by df/dr and the tangential direction by f(r)/r. Those
   * gains differ, so a circular satellite orbit is drawn as an ellipse. At the
   * reference radius with the default exponent the gains are 0.45 and 1.0, so the
   * orbit is flattened by 55 percent along the Sun-planet line.
   *
   * The hierarchical transform scales the satellite's OFFSET from its primary by
   * a single uniform scalar, which is isotropic and therefore shape-preserving.
   *
   * Both claims are measured below rather than asserted.
   */

  /** A circular satellite orbit sampled evenly, in the plane of the ecliptic. */
  function circularSatelliteSystem(
    sampleCount: number,
    primaryDistanceKm: number,
    orbitRadiusKm: number,
  ): ReadonlyArray<{ readonly angle: number; readonly system: readonly ScalableBody[] }> {
    const samples: Array<{ angle: number; system: readonly ScalableBody[] }> = [];
    const primaryPosition = { x: primaryDistanceKm, y: 0, z: 0 };

    for (let i = 0; i < sampleCount; i++) {
      const angle = (i / sampleCount) * 2 * Math.PI;
      const satellitePosition = {
        x: primaryDistanceKm + orbitRadiusKm * Math.cos(angle),
        y: orbitRadiusKm * Math.sin(angle),
        z: 0,
      };

      samples.push({
        angle,
        system: [
          body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
          body('primary', primaryPosition, 6371, 'sun'),
          body('satellite', satellitePosition, 1737, 'primary'),
        ],
      });
    }
    return samples;
  }

  it('keeps a circular satellite orbit circular under the hierarchical transform', () => {
    const samples = circularSatelliteSystem(180, AU_KM, 384_400);
    const radii: number[] = [];

    for (const { system } of samples) {
      const scaled = scaleSystem(system, VISUALIZED);
      const primary = scaled.find((entry) => entry.bodyId === 'primary')!;
      const satellite = scaled.find((entry) => entry.bodyId === 'satellite')!;
      radii.push(magnitude(subtract(satellite.renderPosition, primary.renderPosition)));
    }

    const smallest = Math.min(...radii);
    const largest = Math.max(...radii);
    const eccentricityOfArtefact = (largest - smallest) / largest;

    // Exactly circular to floating-point precision: the offset is scaled by one
    // uniform scalar regardless of orbital phase.
    expect(
      eccentricityOfArtefact,
      `hierarchical transform introduced ${(eccentricityOfArtefact * 100).toFixed(4)} percent flattening`,
    ).toBeLessThan(1e-12);
  });

  it('measures the 55 percent flattening the rejected approach would introduce', () => {
    // The counterfactual, computed here rather than described in a comment. This
    // is what would be shipped if the compression were applied to absolute
    // positions, and it is why it is not.
    const samples = circularSatelliteSystem(180, AU_KM, 384_400);
    const radii: number[] = [];

    for (const { system } of samples) {
      const primary = system.find((entry) => entry.bodyId === 'primary')!;
      const satellite = system.find((entry) => entry.bodyId === 'satellite')!;

      // The rejected approach: compress both ABSOLUTE vectors independently.
      const primaryRender = toRenderPosition(primary.positionKm, VISUALIZED);
      const satelliteRender = toRenderPosition(satellite.positionKm, VISUALIZED);
      radii.push(magnitude(subtract(satelliteRender, primaryRender)));
    }

    const smallest = Math.min(...radii);
    const largest = Math.max(...radii);
    const axisRatio = smallest / largest;

    // The radial axis is compressed to the exponent, 0.45, while the tangential
    // axis is untouched. Measured axis ratio therefore lands near 0.45.
    expect(axisRatio).toBeGreaterThan(0.4);
    expect(axisRatio).toBeLessThan(0.5);
    expect(axisRatio).toBeCloseTo(DEFAULT_COMPRESSION_EXPONENT, 1);

    // A distortion of this size would be plainly visible and would contradict the
    // interface's claim that orbital geometry is accurate.
    expect(1 - axisRatio).toBeGreaterThan(0.5);
  });

  it('draws satellite offsets at true relative scale by default', () => {
    // localFactor defaults to 1, so the Moon's orbit is not silently exaggerated
    // alongside the heliocentric compression.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('earth', { x: AU_KM, y: 0, z: 0 }, 6371, 'sun'),
      body('moon', { x: AU_KM + 384_400, y: 0, z: 0 }, 1737, 'earth'),
    ];

    const scaled = scaleSystem(system, VISUALIZED);
    const earth = scaled.find((entry) => entry.bodyId === 'earth')!;
    const moon = scaled.find((entry) => entry.bodyId === 'moon')!;

    const separationRenderUnits = magnitude(subtract(moon.renderPosition, earth.renderPosition));
    expect(separationRenderUnits).toBeCloseTo(384_400 / RENDER_UNIT_KM, 9);
    expect(satelliteOffsetFactor('earth', VISUALIZED)).toBe(1);
  });

  it('applies a subsystem factor uniformly, so shape survives exaggeration', () => {
    // Raising the factor makes a tight system legible. It must scale the whole
    // offset uniformly, so the orbit stays the same shape and only its size changes.
    //
    // A tight orbit is used deliberately here: 9400 km, roughly Phobos, against a
    // primary 1 au from the origin. That ratio is what makes the tolerance below
    // non-trivial.
    const PRIMARY_DISTANCE_KM = AU_KM;
    const ORBIT_RADIUS_KM = 9_400;

    const config = visualizedScale({ satelliteOffsetFactors: { primary: 20 } });
    const samples = circularSatelliteSystem(90, PRIMARY_DISTANCE_KM, ORBIT_RADIUS_KM);

    const radii = samples.map(({ system }) => {
      const scaled = scaleSystem(system, config);
      const primary = scaled.find((entry) => entry.bodyId === 'primary')!;
      const satellite = scaled.find((entry) => entry.bodyId === 'satellite')!;
      return magnitude(subtract(satellite.renderPosition, primary.renderPosition));
    });

    const smallest = Math.min(...radii);
    const largest = Math.max(...radii);
    const flattening = (largest - smallest) / largest;

    /**
     * TOLERANCE DERIVED, NOT CHOSEN.
     *
     * The residual here comes from the TEST FIXTURE, not from the transform. The
     * fixture builds the satellite's absolute position as
     * PRIMARY_DISTANCE_KM + orbitRadius * cos(angle), and scaleSystem recovers the
     * offset by subtracting the primary's position. That subtraction is
     * catastrophic cancellation: a value near 1.5e8 has f64 spacing of about
     * 3e-8 km, so the recovered offset carries that absolute error against a
     * magnitude of only 9400 km.
     *
     *   relative floor ~ eps(primaryDistance) / orbitRadius
     *                  ~ 3e-8 / 9400  ~  3e-12
     *
     * Measured flattening is 2.3e-12, which sits just under that floor. The
     * transform itself is exact: it multiplies the offset by one scalar.
     *
     * The Earth-Moon case elsewhere in this file passes at 1e-12 because its
     * orbit radius is 384400 km, putting its floor near 8e-14. Same arithmetic,
     * forty times more headroom, which is why the two tolerances differ.
     */
    const cancellationFloor = (Number.EPSILON * PRIMARY_DISTANCE_KM) / ORBIT_RADIUS_KM;
    const tolerance = 10 * cancellationFloor;

    expect(
      flattening,
      `flattening ${flattening.toExponential(3)} exceeds the f64 cancellation floor ` +
        `${cancellationFloor.toExponential(3)} by more than 10x, which would indicate a real distortion`,
    ).toBeLessThan(tolerance);

    // And the tolerance is still tight enough to be meaningful: four orders of
    // magnitude below anything visible on screen.
    expect(tolerance).toBeLessThan(1e-8);

    // Twenty times the true relative separation.
    expect(largest).toBeCloseTo((ORBIT_RADIUS_KM * 20) / RENDER_UNIT_KM, 6);
  });

  it('ignores subsystem factors entirely in scientific mode', () => {
    const config: ScaleConfig = { ...scientificScale(), satelliteOffsetFactors: { earth: 50 } };
    expect(satelliteOffsetFactor('earth', config)).toBe(1);
  });
});

describe('hierarchy resolution', () => {
  it('places a satellite relative to its primary regardless of declaration order', () => {
    // The satellite is declared BEFORE its primary, so the resolver must recurse
    // rather than depend on array order.
    const system = [
      body('moon', { x: AU_KM + 384_400, y: 0, z: 0 }, 1737, 'earth'),
      body('earth', { x: AU_KM, y: 0, z: 0 }, 6371, 'sun'),
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
    ];

    const scaled = scaleSystem(system, VISUALIZED);
    const earth = scaled.find((entry) => entry.bodyId === 'earth')!;
    const moon = scaled.find((entry) => entry.bodyId === 'moon')!;

    expect(magnitude(subtract(moon.renderPosition, earth.renderPosition))).toBeCloseTo(
      384_400 / RENDER_UNIT_KM,
      9,
    );
  });

  it('treats a body whose primary is absent as heliocentric', () => {
    // The honest fallback: keep the body visible and in the right place relative
    // to the Sun, rather than dropping it or placing it at the origin.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('orphan', { x: 5 * AU_KM, y: 0, z: 0 }, 1000, 'missing-primary'),
    ];

    const scaled = scaleSystem(system, VISUALIZED);
    const orphan = scaled.find((entry) => entry.bodyId === 'orphan')!;
    const direct = toRenderPosition({ x: 5 * AU_KM, y: 0, z: 0 }, VISUALIZED);
    expect(orphan.renderPosition).toEqual(direct);
  });

  it('detects a cycle instead of recursing forever', () => {
    const system = [
      body('a', { x: 1, y: 0, z: 0 }, 1, 'b'),
      body('b', { x: 2, y: 0, z: 0 }, 1, 'a'),
    ];
    expect(() => scaleSystem(system, VISUALIZED)).toThrow(/cycle in parent chain/);
  });

  it('resolves a three-level chain', () => {
    // Sun -> planet -> moon -> submoon. Each level must compose onto the last.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('planet', { x: 5 * AU_KM, y: 0, z: 0 }, 69_911, 'sun'),
      body('moon', { x: 5 * AU_KM + 1e6, y: 0, z: 0 }, 1821, 'planet'),
      body('submoon', { x: 5 * AU_KM + 1e6 + 1e4, y: 0, z: 0 }, 10, 'moon'),
    ];

    const scaled = scaleSystem(system, VISUALIZED);
    const at = (id: string): Vector3Like =>
      scaled.find((entry) => entry.bodyId === id)!.renderPosition;

    expect(magnitude(subtract(at('moon'), at('planet')))).toBeCloseTo(1e6 / RENDER_UNIT_KM, 6);
    expect(magnitude(subtract(at('submoon'), at('moon')))).toBeCloseTo(1e4 / RENDER_UNIT_KM, 6);
  });

  it('reports a body referenced but not supplied', () => {
    expect(() => scaleSystem([body('a', { x: 1, y: 0, z: 0 }, 1, null)], VISUALIZED)).not.toThrow();
  });
});

describe('heliocentric compression reaches bodies orbiting the frame origin', () => {
  /**
   * REGRESSION GUARD FOR A REAL, SHIPPED-IN-DEVELOPMENT DEFECT.
   *
   * Every planet declares the Sun as its primary, and the Sun is always present
   * in the system, so an earlier revision of scaleSystem sent all eight planets
   * down the SATELLITE branch. That branch applies a uniform offset factor, which
   * defaults to 1, so the radial compression was never applied to anything.
   * Visualized mode was silently identical to scientific mode for all distances.
   *
   * Nothing detected it directly. The tests for toRenderPosition passed, because
   * that function was always correct; it was simply never called for a planet. The
   * defect surfaced only as an unexpected separation ratio, 0.121 where 0.064 was
   * predicted. These assertions pin the branch itself so it cannot regress
   * unnoticed again.
   */

  /** Mercury at perihelion: the shortest planetary distance, so the most compressed. */
  const MERCURY_PERIHELION_KM = 0.3075 * AU_KM;

  it('compresses a planet distance instead of passing it through', () => {
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('mercury', { x: MERCURY_PERIHELION_KM, y: 0, z: 0 }, 2439.4, 'sun'),
    ];

    const mercury = scaleSystem(system, VISUALIZED).find(
      (entry) => entry.bodyId === 'mercury',
    )!;

    // Must equal the compression law applied to the distance.
    const expected = compressDistanceKm(MERCURY_PERIHELION_KM, VISUALIZED) / RENDER_UNIT_KM;
    expect(mercury.renderPosition.x).toBeCloseTo(expected, 6);

    // And must NOT equal the raw distance. This is the assertion the defect failed:
    // measured, the compressed value is 87994 units against 46001 uncompressed, so
    // the two differ by 91 percent and cannot be confused for rounding.
    const uncompressed = MERCURY_PERIHELION_KM / RENDER_UNIT_KM;
    expect(
      Math.abs(mercury.renderPosition.x - uncompressed) / uncompressed,
      'render distance equals the uncompressed distance, so compression was skipped',
    ).toBeGreaterThan(0.5);
  });

  it('agrees with toRenderPosition for every planet', () => {
    // scaleSystem and toRenderPosition must not disagree about a heliocentric
    // body. Comparing them is what makes the two code paths mutually checking.
    const distancesAu: Readonly<Record<string, number>> = {
      mercury: 0.3075,
      venus: 0.7184,
      earth: 0.9833,
      mars: 1.3814,
      jupiter: 4.951,
      saturn: 9.041,
      uranus: 18.29,
      neptune: 29.81,
    };

    const system: ScalableBody[] = [body('sun', { x: 0, y: 0, z: 0 }, 695_700, null)];
    for (const [bodyId, au] of Object.entries(distancesAu)) {
      // Off-axis, so a bug that only worked along +x would be exposed.
      const angle = au;
      system.push(
        body(
          bodyId,
          { x: au * AU_KM * Math.cos(angle), y: au * AU_KM * Math.sin(angle), z: 0 },
          getBody(bodyId).meanRadiusKm.value,
          'sun',
        ),
      );
    }

    const scaled = scaleSystem(system, VISUALIZED);

    for (const entry of scaled) {
      if (entry.bodyId === 'sun') continue;
      const original = system.find((candidate) => candidate.bodyId === entry.bodyId)!;
      const direct = toRenderPosition(original.positionKm, VISUALIZED);

      expect(
        magnitude(subtract(entry.renderPosition, direct)),
        `${entry.bodyId}: scaleSystem disagrees with toRenderPosition`,
      ).toBeLessThan(1e-9);
    }
  });

  it('leaves scientific mode as a pure unit conversion', () => {
    // The same branch must NOT compress in scientific mode; there it is exactly a
    // division by the render unit.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('mercury', { x: MERCURY_PERIHELION_KM, y: 0, z: 0 }, 2439.4, 'sun'),
    ];

    const mercury = scaleSystem(system, SCIENTIFIC).find(
      (entry) => entry.bodyId === 'mercury',
    )!;
    expect(mercury.renderPosition.x).toBeCloseTo(MERCURY_PERIHELION_KM / RENDER_UNIT_KM, 6);
  });

  it('preserves the outward ordering of the planets after compression', () => {
    // Monotonicity of the law guarantees this, but the guarantee is worth asserting
    // through the full system transform rather than only through the scalar law.
    const distancesAu = [0.3075, 0.7184, 0.9833, 1.3814, 4.951, 9.041, 18.29, 29.81];

    const system: ScalableBody[] = [body('sun', { x: 0, y: 0, z: 0 }, 695_700, null)];
    distancesAu.forEach((au, index) => {
      system.push(body(`p${index}`, { x: au * AU_KM, y: 0, z: 0 }, 5000, 'sun'));
    });

    const scaled = scaleSystem(system, VISUALIZED);
    let previous = -1;
    for (let index = 0; index < distancesAu.length; index++) {
      const x = scaled.find((entry) => entry.bodyId === `p${index}`)!.renderPosition.x;
      expect(x, `planet ${index} is not outside planet ${index - 1}`).toBeGreaterThan(previous);
      previous = x;
    }
  });

  it('still compresses when the frame origin is not at the coordinate origin', () => {
    // The branch is written as parentRender + compress(offset) rather than
    // compress(absolute), so it remains correct if the system is ever
    // re-referenced, for instance to the solar system barycentre. With the origin
    // at zero the two forms coincide; this checks the general case.
    const originOffset = { x: 1e6, y: -2e6, z: 5e5 };
    const offsetFromOrigin = { x: MERCURY_PERIHELION_KM, y: 0, z: 0 };

    const system = [
      body('sun', originOffset, 695_700, null),
      body(
        'mercury',
        {
          x: originOffset.x + offsetFromOrigin.x,
          y: originOffset.y + offsetFromOrigin.y,
          z: originOffset.z + offsetFromOrigin.z,
        },
        2439.4,
        'sun',
      ),
    ];

    const scaled = scaleSystem(system, VISUALIZED);
    const sun = scaled.find((entry) => entry.bodyId === 'sun')!;
    const mercury = scaled.find((entry) => entry.bodyId === 'mercury')!;

    // Separation from the primary must be the compressed offset, independent of
    // where the primary itself sits.
    const separation = magnitude(subtract(mercury.renderPosition, sun.renderPosition));
    expect(separation).toBeCloseTo(
      compressDistanceKm(MERCURY_PERIHELION_KM, VISUALIZED) / RENDER_UNIT_KM,
      6,
    );
  });
});

describe('radius transform', () => {
  it('leaves radii at true scale in scientific mode', () => {
    const earthRadius = getBody('earth').meanRadiusKm.value;
    expect(toRenderRadius(earthRadius, 'earth', SCIENTIFIC)).toBeCloseTo(
      earthRadius / RENDER_UNIT_KM,
      9,
    );
    expect(visualRadiusMultiplier('earth', SCIENTIFIC)).toBe(1);
  });

  it('applies the global multiplier in visualized mode', () => {
    const earthRadius = getBody('earth').meanRadiusKm.value;
    expect(toRenderRadius(earthRadius, 'earth', VISUALIZED)).toBeCloseTo(
      (earthRadius * DEFAULT_RADIUS_MULTIPLIER) / RENDER_UNIT_KM,
      9,
    );
  });

  it('lets a per-body override take precedence', () => {
    const config = visualizedScale({ radiusMultiplierOverrides: { mercury: 30 } });
    expect(visualRadiusMultiplier('mercury', config)).toBe(30);
    expect(visualRadiusMultiplier('earth', config)).toBe(DEFAULT_RADIUS_MULTIPLIER);
  });

  it('inverts exactly', () => {
    for (const bodyId of ['mercury', 'earth', 'jupiter']) {
      const physical = getBody(bodyId).meanRadiusKm.value;
      for (const config of [SCIENTIFIC, VISUALIZED, visualizedScale({ radiusMultiplier: 3.5 })]) {
        const recovered = fromRenderRadius(toRenderRadius(physical, bodyId, config), bodyId, config);
        expect(relativeError(recovered, physical), `${bodyId} ${config.mode}`).toBeLessThan(1e-12);
      }
    }
  });

  it('preserves the ordering of physical radii', () => {
    // Exaggeration is a single multiplier, so relative sizes stay correct even
    // when absolute sizes do not.
    const ordered = ['mercury', 'mars', 'venus', 'earth', 'neptune', 'uranus', 'saturn', 'jupiter'];
    let previous = -1;
    for (const bodyId of ordered) {
      const radius = toRenderRadius(getBody(bodyId).meanRadiusKm.value, bodyId, VISUALIZED);
      expect(radius, `${bodyId} breaks size ordering`).toBeGreaterThan(previous);
      previous = radius;
    }
  });

  it('rejects a negative or non-finite radius', () => {
    expect(() => toRenderRadius(-1, 'earth', VISUALIZED)).toThrow(/non-negative/);
    expect(() => toRenderRadius(Number.NaN, 'earth', VISUALIZED)).toThrow(/finite/);
  });
});

describe('physical values are never modified', () => {
  it('passes the physical radius through untouched', () => {
    // CONTRACT SECTION 2: measurements use physicalRadiusKm. Exaggeration must
    // reach visualRadius only.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('earth', { x: AU_KM, y: 0, z: 0 }, 6371.0084, 'sun'),
    ];

    for (const scaled of scaleSystem(system, VISUALIZED)) {
      const original = system.find((entry) => entry.bodyId === scaled.bodyId)!;
      expect(scaled.physicalRadiusKm, `${scaled.bodyId}`).toBe(original.physicalRadiusKm);
    }
  });

  it('never mutates the input system', () => {
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('earth', { x: AU_KM, y: 0, z: 0 }, 6371, 'sun'),
    ];
    const before = JSON.stringify(system);

    scaleSystem(system, VISUALIZED);
    validateVisualBodySeparation(system, VISUALIZED);
    getScaleDescription(VISUALIZED);

    expect(JSON.stringify(system)).toBe(before);
  });

  it('exposes all three radii so the interface can show physical and visual side by side', () => {
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('earth', { x: AU_KM, y: 0, z: 0 }, 6371, 'sun'),
    ];
    const earth = scaleSystem(system, VISUALIZED).find((entry) => entry.bodyId === 'earth')!;

    expect(earth.physicalRadiusKm).toBe(6371);
    expect(earth.visualRadiusMultiplier).toBe(DEFAULT_RADIUS_MULTIPLIER);
    expect(earth.visualRadius).toBeCloseTo((6371 * DEFAULT_RADIUS_MULTIPLIER) / RENDER_UNIT_KM, 9);
  });
});

describe('separation validation', () => {
  /** The eight planets at perihelion, which is the tightest real configuration. */
  function planetSystemAtPerihelion(): readonly ScalableBody[] {
    const perihelionAu: Readonly<Record<string, number>> = {
      mercury: 0.3075,
      venus: 0.7184,
      earth: 0.9833,
      mars: 1.3814,
      jupiter: 4.951,
      saturn: 9.041,
      uranus: 18.29,
      neptune: 29.81,
    };

    const system: ScalableBody[] = [
      body('sun', { x: 0, y: 0, z: 0 }, getBody('sun').meanRadiusKm.value, null),
    ];
    for (const [bodyId, au] of Object.entries(perihelionAu)) {
      system.push(
        body(bodyId, { x: au * AU_KM, y: 0, z: 0 }, getBody(bodyId).meanRadiusKm.value, 'sun'),
      );
    }
    return system;
  }

  it('finds no overlap at the default multiplier', () => {
    // Validates the DEFAULT_RADIUS_MULTIPLIER choice against real geometry rather
    // than trusting the arithmetic in its comment.
    const report = validateVisualBodySeparation(planetSystemAtPerihelion(), VISUALIZED);

    expect(report.anyOverlapping, `worst pair: ${JSON.stringify(report.worst)}`).toBe(false);
    expect(report.anyCrowded).toBe(false);
    expect(report.worst).not.toBeNull();
    // Measured worst planetary pair is Sun/Mercury at about 0.064.
    expect(report.worst!.ratio).toBeLessThan(0.1);
  });

  it('compares every planet pair, since all share the Sun as primary', () => {
    const report = validateVisualBodySeparation(planetSystemAtPerihelion(), VISUALIZED);
    // Eight planets: 8 body-to-primary comparisons plus 28 sibling pairs.
    expect(report.checks).toHaveLength(8 + 28);
  });

  it('detects overlap when the multiplier is pushed too far', () => {
    // The validator must actually be capable of failing, or it proves nothing.
    const report = validateVisualBodySeparation(
      planetSystemAtPerihelion(),
      visualizedScale({ radiusMultiplier: 500 }),
    );
    expect(report.anyOverlapping).toBe(true);
    expect(report.worst!.ratio).toBeGreaterThanOrEqual(1);
  });

  it('reports crowding before outright overlap', () => {
    /**
     * The spacing is DERIVED from the transform rather than hand-picked.
     *
     * An earlier version of this test placed the two bodies 200000 km apart and
     * predicted a ratio near 0.51, reasoning from a render separation of 200
     * units. That reasoning silently assumed distances were NOT compressed. Once
     * the missing heliocentric branch was restored the same fixture produced a
     * ratio of 1.133, because near the reference radius the compression law has a
     * local radial gain equal to its exponent: a 200000 km physical gap renders as
     * 200000 * 0.45 = 90000 km-equivalent, so the bodies are drawn less than half
     * as far apart as the raw distance suggests.
     *
     * Deriving the position through expandDistanceKm expresses the intent, which
     * is a target ratio in the crowded band, and cannot drift out of step with the
     * transform if its parameters change.
     */
    const TARGET_RATIO = 0.68;
    const RADIUS_KM = 6371;

    const summedVisualRadius = (2 * RADIUS_KM * DEFAULT_RADIUS_MULTIPLIER) / RENDER_UNIT_KM;
    const targetSeparationKm = (summedVisualRadius / TARGET_RATIO) * RENDER_UNIT_KM;

    // Place the second body so its COMPRESSED distance exceeds the first's by the
    // separation the target ratio requires.
    const innerCompressedKm = compressDistanceKm(AU_KM, VISUALIZED);
    const outerDistanceKm = expandDistanceKm(innerCompressedKm + targetSeparationKm, VISUALIZED);

    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('a', { x: AU_KM, y: 0, z: 0 }, RADIUS_KM, 'sun'),
      body('b', { x: outerDistanceKm, y: 0, z: 0 }, RADIUS_KM, 'sun'),
    ];

    const report = validateVisualBodySeparation(system, VISUALIZED);
    const pair = report.checks.find((check) => check.bodyA === 'a' && check.bodyB === 'b')!;

    expect(pair.ratio).toBeCloseTo(TARGET_RATIO, 6);
    expect(pair.ratio).toBeGreaterThan(CROWDING_RATIO);
    expect(pair.ratio).toBeLessThan(1);
    expect(pair.crowded).toBe(true);
    expect(pair.overlapping).toBe(false);

    // The physical gap needed is substantially larger than the render separation
    // implies, which is the compression at work rather than an artefact.
    const physicalGapKm = outerDistanceKm - AU_KM;
    expect(physicalGapKm / targetSeparationKm).toBeGreaterThan(2);
  });

  it('validates the Earth-Moon pair, the tightest real subsystem', () => {
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, getBody('sun').meanRadiusKm.value, null),
      body('earth', { x: AU_KM, y: 0, z: 0 }, getBody('earth').meanRadiusKm.value, 'sun'),
      body('moon', { x: AU_KM + 384_400, y: 0, z: 0 }, getBody('moon').meanRadiusKm.value, 'earth'),
    ];

    const report = validateVisualBodySeparation(system, VISUALIZED);
    const pair = report.checks.find(
      (check) =>
        (check.bodyA === 'moon' && check.bodyB === 'earth') ||
        (check.bodyA === 'earth' && check.bodyB === 'moon'),
    )!;

    // Measured: about 0.169 at the default multiplier. Safe, with margin, but the
    // largest ratio anywhere in the system, which is why it is asserted directly.
    expect(pair.ratio).toBeCloseTo(0.169, 2);
    expect(pair.overlapping).toBe(false);
  });

  it('shows a raised subsystem factor improving separation', () => {
    // One of the remedies contract section 3 permits, and evidence it works.
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('mars', { x: 1.52 * AU_KM, y: 0, z: 0 }, 3389.5, 'sun'),
      body('phobos', { x: 1.52 * AU_KM + 9376, y: 0, z: 0 }, 11.1, 'mars'),
    ];

    const tight = validateVisualBodySeparation(system, VISUALIZED);
    const spread = validateVisualBodySeparation(
      system,
      visualizedScale({ satelliteOffsetFactors: { mars: 15 } }),
    );

    expect(spread.worst!.ratio).toBeLessThan(tight.worst!.ratio);
  });

  it('reports an infinite ratio for coincident bodies rather than NaN', () => {
    const system = [
      body('sun', { x: 0, y: 0, z: 0 }, 695_700, null),
      body('a', { x: AU_KM, y: 0, z: 0 }, 1000, 'sun'),
      body('b', { x: AU_KM, y: 0, z: 0 }, 1000, 'sun'),
    ];
    const pair = validateVisualBodySeparation(system, VISUALIZED).checks.find(
      (check) => check.bodyA === 'a' && check.bodyB === 'b',
    )!;

    expect(pair.ratio).toBe(Number.POSITIVE_INFINITY);
    expect(pair.overlapping).toBe(true);
    expect(Number.isNaN(pair.ratio)).toBe(false);
  });

  it('finds nothing to check in a system with only a frame origin', () => {
    const report = validateVisualBodySeparation(
      [body('sun', { x: 0, y: 0, z: 0 }, 695_700, null)],
      VISUALIZED,
    );
    expect(report.checks).toHaveLength(0);
    expect(report.worst).toBeNull();
    expect(report.anyOverlapping).toBe(false);
  });
});

describe('scale disclosure', () => {
  it('states true scale in scientific mode', () => {
    const description = getScaleDescription(SCIENTIFIC);
    expect(description.distanceDistorted).toBe(false);
    expect(description.sizeExaggerated).toBe(false);
    expect(description.distanceLabel).toBe('TRUE SCALE');
    expect(description.sizeLabel).toBe('TRUE SCALE');
  });

  it('declares both distortions in visualized mode', () => {
    // CONTRACT SECTIONS 1.3 AND 9: distortion must be visible whenever active.
    const description = getScaleDescription(VISUALIZED);

    expect(description.distanceDistorted).toBe(true);
    expect(description.sizeExaggerated).toBe(true);
    expect(description.distanceLabel).toMatch(/NON-LINEAR/);
    expect(description.sizeLabel).toMatch(/EXAGGERATED 8x/);
  });

  it('always asserts that orbital geometry is undistorted', () => {
    // A claim the hierarchical transform actually earns, per the Issue C tests.
    for (const config of [SCIENTIFIC, VISUALIZED]) {
      expect(getScaleDescription(config).geometryLabel).toBe('ACCURATE');
      expect(getScaleDescription(config).lines).toContain('ORBITAL GEOMETRY: ACCURATE');
    }
  });

  it('publishes the transform in inspectable mathematical form', () => {
    const description = getScaleDescription(VISUALIZED);
    expect(description.distanceFormula).toContain('0.45');
    expect(description.distanceFormula).toContain('r0');
    // Scientific mode states the unit conversion instead.
    expect(getScaleDescription(SCIENTIFIC).distanceFormula).toContain('1000 km');
  });

  it('discloses a per-body exaggeration separately from the global one', () => {
    const description = getScaleDescription(
      visualizedScale({ radiusMultiplierOverrides: { mercury: 30 } }),
    );
    expect(description.lines.some((line) => line.includes('MERCURY') && line.includes('30x'))).toBe(
      true,
    );
  });

  it('discloses a subsystem spacing exaggeration', () => {
    const description = getScaleDescription(
      visualizedScale({ satelliteOffsetFactors: { mars: 15 } }),
    );
    expect(
      description.lines.some((line) => line.includes('MARS SYSTEM SPACING') && line.includes('15x')),
    ).toBe(true);
  });

  it('says nothing about a subsystem left at true relative scale', () => {
    const description = getScaleDescription(
      visualizedScale({ satelliteOffsetFactors: { earth: 1 } }),
    );
    expect(description.lines.some((line) => line.includes('SPACING'))).toBe(false);
  });

  it('reports no exaggeration when the multiplier is exactly one', () => {
    const description = getScaleDescription(visualizedScale({ radiusMultiplier: 1 }));
    expect(description.sizeExaggerated).toBe(false);
    expect(description.sizeLabel).toBe('TRUE SCALE');
    // Distance compression is independent of radius exaggeration.
    expect(description.distanceDistorted).toBe(true);
  });

  it('reports no distance distortion at an exponent of one', () => {
    const description = getScaleDescription(visualizedScale({ compressionExponent: 1 }));
    expect(description.distanceDistorted).toBe(false);
    expect(description.distanceLabel).toBe('TRUE SCALE');
  });
});
