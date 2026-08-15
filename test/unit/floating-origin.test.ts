/**
 * Floating-origin validation.
 *
 * CONTRACT SECTION 29 REQUIREMENT: move the camera across large distances and
 * verify the physical state is unchanged, render coordinates stay numerically
 * stable, and there is no visible jitter.
 *
 * "No visible jitter" is made measurable rather than left as a judgement. Every
 * stability assertion below converts a world-space error into SCREEN PIXELS and
 * asserts a sub-pixel bound, because pixels are the only units in which
 * "visible" means anything.
 *
 * All expected values are either exact IEEE-754 properties, exact f64 identities,
 * or measured quantities recomputed inside the test. Nothing astronomical is
 * asserted here.
 */

import { describe, expect, it } from 'vitest';
import {
  F32_RELATIVE_EPSILON,
  FloatingOrigin,
  ZERO_ORIGIN,
  comparePrecision,
  distanceFromOrigin,
  errorToPixels,
  f32SpacingAt,
  fromOriginRelative,
  quantise,
  toF32,
  toOriginRelative,
  vectorToF32,
} from '@/render/floating-origin';
import { magnitude, subtract, type Vector3Like } from '@/ephemeris/kepler';
import { AU_KM } from '@/data/constants';
import { RENDER_UNIT_KM } from '@/sim/scale';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/** A representative viewport for the pixel assertions. */
const FOV_DEG = 45;
const VIEWPORT_HEIGHT_PX = 1080;

/** Render-unit positions of the fixture used for the measured comparisons. */
const ONE_AU_UNITS = AU_KM / RENDER_UNIT_KM;
const MOON_ORBIT_UNITS = 384_400 / RENDER_UNIT_KM;
const MOON_ABSOLUTE_UNITS = ONE_AU_UNITS + MOON_ORBIT_UNITS;
const NEPTUNE_ABSOLUTE_UNITS = (30.0 * AU_KM) / RENDER_UNIT_KM;

/** Camera just outside the Moon: its radius of 1737.4 km plus a little. */
const MOON_CLOSE_STANDOFF_UNITS = 2.7374;

describe('f32 behaviour', () => {
  it('rounds exactly as the GPU would on upload', () => {
    // Math.fround IS f32 rounding, not an approximation of it. 0.1 is the classic
    // demonstration: it is not representable in either binary format, and the f32
    // result differs from the f64 one in the eighth significant digit.
    expect(toF32(0.1)).not.toBe(0.1);
    expect(toF32(0.1)).toBeCloseTo(0.1, 7);
    // Powers of two are exact in both formats.
    expect(toF32(0.5)).toBe(0.5);
    expect(toF32(2 ** 20)).toBe(2 ** 20);
  });

  it('rounds every component of a vector', () => {
    const rounded = vectorToF32({ x: 0.1, y: 0.2, z: 0.3 });
    expect(rounded.x).toBe(Math.fround(0.1));
    expect(rounded.y).toBe(Math.fround(0.2));
    expect(rounded.z).toBe(Math.fround(0.3));
  });

  it('reports the spacing that actually separates adjacent f32 values', () => {
    // MEASURED AGAINST THE FORMAT, not against a formula. Stepping by the reported
    // spacing must land on a different f32; stepping by half of it must not.
    for (const magnitude of [1, 2.7374, 1000, ONE_AU_UNITS, NEPTUNE_ABSOLUTE_UNITS]) {
      const spacing = f32SpacingAt(magnitude);
      const base = Math.fround(magnitude);

      expect(
        Math.fround(base + spacing),
        `spacing ${spacing} at ${magnitude} did not reach the next f32`,
      ).not.toBe(base);
      expect(
        Math.fround(base + spacing / 4),
        `a quarter of the spacing at ${magnitude} should round back`,
      ).toBe(base);
    }
  });

  it('matches the measured spacings that motivate this module', () => {
    // These three figures are the argument for floating origin, so they are pinned.
    expect(f32SpacingAt(MOON_CLOSE_STANDOFF_UNITS)).toBeCloseTo(2.384e-7, 10);
    expect(f32SpacingAt(ONE_AU_UNITS)).toBeCloseTo(1.5625e-2, 6);
    expect(f32SpacingAt(NEPTUNE_ABSOLUTE_UNITS)).toBeCloseTo(0.5, 6);

    // In physical terms: 24 cm near the Moon, 15.6 km at 1 au, 500 km at Neptune.
    expect(f32SpacingAt(ONE_AU_UNITS) * RENDER_UNIT_KM).toBeCloseTo(15.625, 3);
  });

  it('returns zero spacing at zero, where subnormals make precision effectively unlimited', () => {
    expect(f32SpacingAt(0)).toBe(0);
  });

  it('is symmetric in sign', () => {
    expect(f32SpacingAt(-ONE_AU_UNITS)).toBe(f32SpacingAt(ONE_AU_UNITS));
  });

  it('uses the documented relative epsilon', () => {
    expect(F32_RELATIVE_EPSILON).toBe(2 ** -23);
    // Within a binade the spacing is the binade base times the relative epsilon.
    expect(f32SpacingAt(1.5)).toBe(1 * F32_RELATIVE_EPSILON);
    expect(f32SpacingAt(3.0)).toBe(2 * F32_RELATIVE_EPSILON);
  });
});

describe('origin transform', () => {
  it('is an exact inverse pair in f64', () => {
    forEachSample(DEFAULT_SEED ^ 0x0f01, 500, (sampler, context) => {
      const absolute: Vector3Like = {
        x: sampler.range(-1e7, 1e7),
        y: sampler.range(-1e7, 1e7),
        z: sampler.range(-1e7, 1e7),
      };
      const origin = { x: sampler.range(-1e7, 1e7), y: sampler.range(-1e7, 1e7), z: sampler.range(-1e7, 1e7) };

      const recovered = fromOriginRelative(toOriginRelative(absolute, origin), origin);

      // Exact, not approximate: subtracting then adding the same f64 is lossless
      // for values in this range.
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(
          recovered[axis],
          formatPropertyFailure({ ...context, axis }, absolute[axis], recovered[axis]),
        ).toBeCloseTo(absolute[axis], 9);
      }
    });
  });

  it('is the identity at the zero origin', () => {
    const position = { x: 1, y: 2, z: 3 };
    expect(toOriginRelative(position, ZERO_ORIGIN)).toEqual(position);
    expect(fromOriginRelative(position, ZERO_ORIGIN)).toEqual(position);
  });

  it('measures distance consistently with the relative vector', () => {
    forEachSample(DEFAULT_SEED ^ 0x0f02, 200, (sampler, context) => {
      const absolute = { x: sampler.range(-1e6, 1e6), y: sampler.range(-1e6, 1e6), z: sampler.range(-1e6, 1e6) };
      const origin = { x: sampler.range(-1e6, 1e6), y: sampler.range(-1e6, 1e6), z: sampler.range(-1e6, 1e6) };

      const viaHelper = distanceFromOrigin(absolute, origin);
      const viaVector = magnitude(toOriginRelative(absolute, origin));

      expect(viaHelper, formatPropertyFailure(context, viaVector, viaHelper)).toBeCloseTo(viaVector, 9);
    });
  });

  it('never mutates its inputs', () => {
    const absolute = { x: 1, y: 2, z: 3 };
    const origin = { x: 4, y: 5, z: 6 };
    const absoluteBefore = { ...absolute };
    const originBefore = { ...origin };

    toOriginRelative(absolute, origin);
    fromOriginRelative(absolute, origin);

    expect(absolute).toEqual(absoluteBefore);
    expect(origin).toEqual(originBefore);
  });
});

describe('measured precision benefit', () => {
  /**
   * The fixture from the module header: camera 2.7374 units outside the Moon,
   * which is itself 1 au plus a lunar orbit radius from the coordinate origin.
   */
  const cameraOrigin = { x: MOON_ABSOLUTE_UNITS + MOON_CLOSE_STANDOFF_UNITS, y: 0, z: 0 };

  it('improves near-camera precision by four orders of magnitude', () => {
    const moon = { x: MOON_ABSOLUTE_UNITS, y: 0, z: 0 };
    const comparison = comparePrecision(moon, cameraOrigin);

    // Absolute treatment loses about 3.0e-3 units, which is 3 metres.
    expect(comparison.absoluteErrorUnits).toBeGreaterThan(1e-3);
    // Relative treatment loses about 5.5e-8 units, which is 5.5 centimetres.
    expect(comparison.relativeErrorUnits).toBeLessThan(1e-6);
    expect(comparison.improvementFactor).toBeGreaterThan(1e4);
  });

  it('removes visible jitter from a Moon-close camera', () => {
    // THE ASSERTION THAT MAKES "NO VISIBLE JITTER" MEANINGFUL.
    const moon = { x: MOON_ABSOLUTE_UNITS, y: 0, z: 0 };
    const comparison = comparePrecision(moon, cameraOrigin);

    const absolutePixels = errorToPixels(
      comparison.absoluteErrorUnits,
      MOON_CLOSE_STANDOFF_UNITS,
      FOV_DEG,
      VIEWPORT_HEIGHT_PX,
    );
    const relativePixels = errorToPixels(
      comparison.relativeErrorUnits,
      MOON_CLOSE_STANDOFF_UNITS,
      FOV_DEG,
      VIEWPORT_HEIGHT_PX,
    );

    // Measured: about 1.44 pixels absolute, which is plainly visible.
    expect(absolutePixels).toBeGreaterThan(1);
    // Measured: about 2.6e-5 pixels relative, four orders below one pixel.
    expect(relativePixels).toBeLessThan(0.01);
  });

  it('gives Neptune no benefit, which is correct rather than a defect', () => {
    // Neptune's camera-relative difference is itself about 4.3e6 units, so the
    // subtraction cannot make it small and f32 spacing there stays at 0.5 units.
    const neptune = { x: NEPTUNE_ABSOLUTE_UNITS, y: 0, z: 0 };
    const comparison = comparePrecision(neptune, cameraOrigin);

    expect(comparison.improvementFactor).toBeCloseTo(1, 1);

    // And it does not matter: the error subtends far less than a pixel because it
    // scales with the distance it occurs at.
    const distance = Math.abs(NEPTUNE_ABSOLUTE_UNITS - cameraOrigin.x);
    const pixels = errorToPixels(
      comparison.relativeErrorUnits,
      distance,
      FOV_DEG,
      VIEWPORT_HEIGHT_PX,
    );
    expect(pixels).toBeLessThan(1e-3);
  });

  it('helps intermediate distances proportionally', () => {
    // Earth sits 387 units from this camera, between the Moon at 2.7 units and
    // Neptune at 4.3e6, and gains about 327x. The benefit falls off smoothly with
    // distance rather than switching on and off.
    const earth = { x: ONE_AU_UNITS, y: 0, z: 0 };
    const comparison = comparePrecision(earth, cameraOrigin);

    expect(comparison.improvementFactor).toBeGreaterThan(100);
    expect(comparison.improvementFactor).toBeLessThan(1e4);
  });

  it('gains nothing for a target at the coordinate origin, for a different reason', () => {
    /**
     * The Sun sits at the coordinate origin in heliocentric render space, and its
     * improvement factor is exactly 1 rather than the several hundred that its
     * distance from the camera might suggest.
     *
     * The two error terms behave as
     *
     *   absolute error ~ max( spacing(|target|), spacing(|origin|) )
     *   relative error ~ spacing(|target - origin|)
     *
     * and spacing(0) is zero, so for a target at the origin the absolute path's
     * error is already just the error in the camera origin, which the relative path
     * carries too. There is nothing to remove.
     *
     * This is the opposite situation to Neptune, which also scores 1 but because
     * its camera-relative difference is itself enormous. Both are asserted so the
     * distinction is recorded rather than rediscovered.
     */
    const sunAtOrigin = { x: 0, y: 0, z: 0 };
    const comparison = comparePrecision(sunAtOrigin, cameraOrigin);

    expect(comparison.improvementFactor).toBeCloseTo(1, 6);
    expect(comparison.absoluteErrorUnits).toBeCloseTo(comparison.relativeErrorUnits, 12);

    // And it does not matter: at 1.5e5 units the error subtends far under a pixel.
    const pixels = errorToPixels(
      comparison.relativeErrorUnits,
      cameraOrigin.x,
      FOV_DEG,
      VIEWPORT_HEIGHT_PX,
    );
    expect(pixels).toBeLessThan(1e-3);
  });

  it('reports an infinite factor when the relative form is exact', () => {
    // A position that lands on an f32 grid point loses nothing, so the ratio is
    // infinite rather than NaN.
    const origin = { x: 1024, y: 0, z: 0 };
    const absolute = { x: 1024.5, y: 0, z: 0 };
    expect(comparePrecision(absolute, origin).improvementFactor).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('camera traversal stability', () => {
  /**
   * CONTRACT SECTION 29: move the camera across large distances and verify the
   * physical state is unchanged and render coordinates stay stable.
   */
  it('leaves the input positions bit-identical after a full traversal', () => {
    // The simulation's coordinates must survive untouched. Contract section 5
    // forbids the reverse flow, and this is the direct check on it.
    const bodies: Vector3Like[] = [
      { x: 0, y: 0, z: 0 },
      { x: ONE_AU_UNITS, y: 0, z: 0 },
      { x: MOON_ABSOLUTE_UNITS, y: 0, z: 0 },
      { x: NEPTUNE_ABSOLUTE_UNITS, y: 0, z: 0 },
    ];
    const before = bodies.map((body) => ({ ...body }));

    const floatingOrigin = new FloatingOrigin();
    for (let step = 0; step <= 60; step++) {
      const t = step / 60;
      // Sweep the camera from the Moon out to Neptune.
      const cameraX = MOON_ABSOLUTE_UNITS + t * (NEPTUNE_ABSOLUTE_UNITS - MOON_ABSOLUTE_UNITS);
      floatingOrigin.update({ x: cameraX, y: 0, z: 0 });
      for (const body of bodies) floatingOrigin.relative(body);
    }

    expect(bodies).toEqual(before);
  });

  it('keeps a tracked body sub-pixel stable across many origin changes', () => {
    // The camera holds a fixed standoff from the Moon while sweeping in a circle
    // around it. The Moon's projected position must not wander.
    const floatingOrigin = new FloatingOrigin();
    const moon = { x: MOON_ABSOLUTE_UNITS, y: 0, z: 0 };

    let worstPixels = 0;
    for (let step = 0; step < 120; step++) {
      const angle = (step / 120) * 2 * Math.PI;
      const camera = {
        x: moon.x + MOON_CLOSE_STANDOFF_UNITS * Math.cos(angle),
        y: moon.y + MOON_CLOSE_STANDOFF_UNITS * Math.sin(angle),
        z: 0,
      };
      floatingOrigin.update(camera);

      // What the GPU receives, and what it should have received.
      const exact = floatingOrigin.relative(moon);
      const uploaded = vectorToF32(exact);
      const error = magnitude(subtract(uploaded, exact));

      worstPixels = Math.max(
        worstPixels,
        errorToPixels(error, MOON_CLOSE_STANDOFF_UNITS, FOV_DEG, VIEWPORT_HEIGHT_PX),
      );
    }

    expect(worstPixels, `worst projected wander ${worstPixels.toExponential(3)} px`).toBeLessThan(
      0.01,
    );
  });

  it('holds relative geometry invariant under an arbitrary origin', () => {
    // The separation between two bodies must not depend on where the camera is.
    // If it did, the scene would deform as the camera moved.
    forEachSample(DEFAULT_SEED ^ 0x0f03, 300, (sampler, context) => {
      const a: Vector3Like = { x: sampler.range(-1e6, 1e6), y: sampler.range(-1e6, 1e6), z: 0 };
      const b: Vector3Like = { x: sampler.range(-1e6, 1e6), y: sampler.range(-1e6, 1e6), z: 0 };

      const trueSeparation = magnitude(subtract(b, a));

      const origin = {
        x: sampler.range(-NEPTUNE_ABSOLUTE_UNITS, NEPTUNE_ABSOLUTE_UNITS),
        y: sampler.range(-1e6, 1e6),
        z: sampler.range(-1e6, 1e6),
      };
      const relativeSeparation = magnitude(
        subtract(toOriginRelative(b, origin), toOriginRelative(a, origin)),
      );

      const error =
        trueSeparation === 0 ? 0 : Math.abs(relativeSeparation - trueSeparation) / trueSeparation;
      expect(error, formatPropertyFailure(context, trueSeparation, relativeSeparation)).toBeLessThan(
        1e-9,
      );
    });
  });

  it('sweeps from Moon-close to Neptune-distant without a precision cliff', () => {
    // Property test across the full range the application supports. At every
    // camera position the nearest body must stay sub-pixel stable.
    forEachSample(DEFAULT_SEED ^ 0x0f04, 200, (sampler, context) => {
      const floatingOrigin = new FloatingOrigin();

      const cameraDistanceFromSun = sampler.logRange(ONE_AU_UNITS * 0.5, NEPTUNE_ABSOLUTE_UNITS);
      const standoff = sampler.logRange(1e-3, 1e3);

      const target = { x: cameraDistanceFromSun, y: 0, z: 0 };
      const camera = { x: cameraDistanceFromSun + standoff, y: 0, z: 0 };

      floatingOrigin.update(camera);
      const exact = floatingOrigin.relative(target);
      const uploaded = vectorToF32(exact);
      const errorUnits = magnitude(subtract(uploaded, exact));
      const pixels = errorToPixels(errorUnits, standoff, FOV_DEG, VIEWPORT_HEIGHT_PX);

      expect(
        pixels,
        formatPropertyFailure(
          { ...context, cameraDistanceFromSun, standoff },
          'under 0.5 px',
          `${pixels.toExponential(3)} px`,
        ),
      ).toBeLessThan(0.5);
    });
  });
});

describe('origin tracking', () => {
  it('starts at the coordinate origin', () => {
    expect(new FloatingOrigin().origin).toEqual(ZERO_ORIGIN);
    expect(new FloatingOrigin().originChanges).toBe(0);
  });

  it('reports a change only when the origin actually moves', () => {
    // Callers refresh cached geometry on a change, so a spurious true would cost
    // work every frame and a missed true would leave stale coordinates.
    const floatingOrigin = new FloatingOrigin();

    expect(floatingOrigin.update({ x: 100, y: 0, z: 0 })).toBe(true);
    expect(floatingOrigin.originChanges).toBe(1);

    expect(floatingOrigin.update({ x: 100, y: 0, z: 0 })).toBe(false);
    expect(floatingOrigin.originChanges).toBe(1);

    expect(floatingOrigin.update({ x: 100, y: 1e-12, z: 0 })).toBe(true);
    expect(floatingOrigin.originChanges).toBe(2);
  });

  it('tracks the camera exactly when quantisation is disabled', () => {
    const floatingOrigin = new FloatingOrigin();
    const camera = { x: 1234.5678, y: -91.2, z: 0.5 };
    floatingOrigin.update(camera);

    expect(floatingOrigin.origin).toEqual(camera);
    // A body at the camera therefore lands exactly at the relative origin.
    expect(floatingOrigin.relative(camera)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('round-trips through relative and absolute', () => {
    const floatingOrigin = new FloatingOrigin();
    floatingOrigin.update({ x: ONE_AU_UNITS, y: 0, z: 0 });

    const body = { x: MOON_ABSOLUTE_UNITS, y: 12.5, z: -3.25 };
    const recovered = floatingOrigin.absolute(floatingOrigin.relative(body));

    expect(recovered.x).toBeCloseTo(body.x, 9);
    expect(recovered.y).toBeCloseTo(body.y, 9);
    expect(recovered.z).toBeCloseTo(body.z, 9);
  });

  it('resets to the coordinate origin', () => {
    const floatingOrigin = new FloatingOrigin();
    floatingOrigin.update({ x: 500, y: 500, z: 500 });
    floatingOrigin.reset();
    expect(floatingOrigin.origin).toEqual(ZERO_ORIGIN);
  });

  it('rejects an invalid quantisation step', () => {
    expect(() => new FloatingOrigin({ quantisationStep: -1 })).toThrow(/non-negative/);
    expect(() => new FloatingOrigin({ quantisationStep: Number.NaN })).toThrow(/finite/);
  });
});

describe('origin quantisation', () => {
  it('snaps to the nearest grid point', () => {
    expect(quantise({ x: 12.4, y: -7.6, z: 0.5 }, 5)).toEqual({ x: 10, y: -10, z: 0 });
    expect(quantise({ x: 13, y: 0, z: 0 }, 5)).toEqual({ x: 15, y: 0, z: 0 });
  });

  it('is the identity at a step of zero', () => {
    const position = { x: 1.5, y: 2.5, z: 3.5 };
    expect(quantise(position, 0)).toEqual(position);
  });

  it('holds the origin still until the camera crosses a cell boundary', () => {
    // The reason quantisation exists: static geometry keeps its relative
    // coordinates across many frames, which M4's instanced buffers will want.
    const floatingOrigin = new FloatingOrigin({ quantisationStep: 100 });

    expect(floatingOrigin.update({ x: 10, y: 0, z: 0 })).toBe(false);
    expect(floatingOrigin.origin).toEqual(ZERO_ORIGIN);

    expect(floatingOrigin.update({ x: 40, y: 0, z: 0 })).toBe(false);
    expect(floatingOrigin.update({ x: 60, y: 0, z: 0 })).toBe(true);
    expect(floatingOrigin.origin.x).toBe(100);
    expect(floatingOrigin.originChanges).toBe(1);
  });

  it('costs precision in proportion to the step size', () => {
    // MEASURED TRADE-OFF, so the cost of enabling this later is known rather than
    // discovered. With the origin up to step/2 from the camera, positions at the
    // camera are no longer near zero.
    const target = { x: MOON_ABSOLUTE_UNITS, y: 0, z: 0 };

    const measureWorstPixels = (step: number): number => {
      const floatingOrigin = new FloatingOrigin({ quantisationStep: step });
      let worst = 0;

      for (let i = 0; i < 50; i++) {
        const standoff = MOON_CLOSE_STANDOFF_UNITS;
        const camera = { x: target.x + standoff + (i / 50) * Math.max(step, 1e-6), y: 0, z: 0 };
        floatingOrigin.update(camera);

        const exact = floatingOrigin.relative(target);
        const error = magnitude(subtract(vectorToF32(exact), exact));
        worst = Math.max(worst, errorToPixels(error, standoff, FOV_DEG, VIEWPORT_HEIGHT_PX));
      }
      return worst;
    };

    const exactTracking = measureWorstPixels(0);
    const coarseGrid = measureWorstPixels(1e4);

    // Exact tracking stays far below a pixel.
    expect(exactTracking).toBeLessThan(0.01);
    // A coarse grid is measurably worse, which is why the default is zero.
    expect(coarseGrid).toBeGreaterThan(exactTracking * 10);
  });
});

describe('pixel conversion', () => {
  it('scales linearly with the error and inversely with distance', () => {
    const base = errorToPixels(1, 100, FOV_DEG, VIEWPORT_HEIGHT_PX);
    expect(errorToPixels(2, 100, FOV_DEG, VIEWPORT_HEIGHT_PX)).toBeCloseTo(base * 2, 9);
    expect(errorToPixels(1, 200, FOV_DEG, VIEWPORT_HEIGHT_PX)).toBeCloseTo(base / 2, 9);
  });

  it('images an object spanning the viewport height as that many pixels', () => {
    // Sanity anchor. At distance d the visible half-height is d tan(fov/2), so an
    // error of exactly that size must map to half the viewport.
    const distance = 10;
    const halfHeight = distance * Math.tan((FOV_DEG * Math.PI) / 360);
    expect(errorToPixels(halfHeight, distance, FOV_DEG, VIEWPORT_HEIGHT_PX)).toBeCloseTo(
      VIEWPORT_HEIGHT_PX / 2,
      6,
    );
  });

  it('rejects a non-positive distance', () => {
    expect(() => errorToPixels(1, 0, FOV_DEG, VIEWPORT_HEIGHT_PX)).toThrow(/positive/);
    expect(() => errorToPixels(1, -5, FOV_DEG, VIEWPORT_HEIGHT_PX)).toThrow(/positive/);
  });
});
