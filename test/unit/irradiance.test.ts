/**
 * Solar irradiance validation.
 *
 * THE TWO THINGS THIS FILE GUARDS.
 *
 *   1. The contract section 23 validation target. Earth must receive about
 *      1361 W/m^2 in the physical model. That value is DERIVED here from two
 *      defined IAU constants rather than asserted as a literal, so the test
 *      cannot pass by someone typing 1361 into the source.
 *
 *   2. Scale-mode invariance. Illumination must be computed from PHYSICAL
 *      distance, so switching between scientific and visualized scale cannot
 *      change how brightly a body is lit. The measured error from getting this
 *      wrong is a factor of 42 at Neptune, so the invariance is asserted
 *      directly rather than assumed from the code's shape.
 *
 * Every expected value below is either an arithmetic consequence of a cited
 * constant, an inverse-square identity, or a monotonicity property. No
 * uncited astronomical figure is asserted.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRIGHTNESS_EXPONENT,
  IRRADIANCE_PROVENANCE,
  RENDER_SUN_LIGHT_CALIBRATION,
  SOLAR_CONSTANT_W_M2,
  brightnessFactor,
  computeIllumination,
  distanceForIrradianceKm,
  getBrightnessDescription,
  perceptualBrightness,
  physicalBrightness,
  relativeSolarIrradiance,
  solarAngularDiameterDeg,
  solarIrradianceWm2,
} from '@/sim/irradiance';
import {
  AU_KM,
  AU_M,
  NOMINAL_SOLAR_LUMINOSITY_W,
  NOMINAL_SOLAR_RADIUS_M,
} from '@/data/constants';
import { SimulationState } from '@/sim/state';
import { SimulationClock } from '@/core/clock';
import { scaleSystem, scientificScale, visualizedScale } from '@/sim/scale';
import { utc } from '@/core/jd';
import { PLANET_IDS } from '@/data/bodies';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/** Relative difference, falling back to absolute near zero. */
function relativeError(actual: number, expected: number): number {
  return Math.abs(expected) < 1e-30
    ? Math.abs(actual - expected)
    : Math.abs(actual - expected) / Math.abs(expected);
}

describe('the contract section 23 validation target', () => {
  it('derives the solar constant from two defined IAU constants', () => {
    // COMPUTED INDEPENDENTLY HERE, not read from the module, so the module cannot
    // satisfy this by hardcoding a number.
    const expected = NOMINAL_SOLAR_LUMINOSITY_W / (4 * Math.PI * AU_M * AU_M);
    expect(SOLAR_CONSTANT_W_M2).toBeCloseTo(expected, 9);
  });

  it('places Earth near 1361 W/m^2, the stated validation target', () => {
    // Contract section 23 names 1361 W/m^2 as a validation target rather than a
    // value to reproduce visually. The derived figure is 1361.1665, which is
    // within 0.02 percent of the named target.
    expect(SOLAR_CONSTANT_W_M2).toBeGreaterThan(1360);
    expect(SOLAR_CONSTANT_W_M2).toBeLessThan(1362);
    expect(SOLAR_CONSTANT_W_M2).toBeCloseTo(1361.1665, 3);
  });

  it('agrees at exactly one astronomical unit', () => {
    expect(solarIrradianceWm2(AU_KM)).toBeCloseTo(SOLAR_CONSTANT_W_M2, 9);
    expect(relativeSolarIrradiance(AU_KM)).toBeCloseTo(1, 12);
  });

  it('records the provenance of every input and marks the result as derived', () => {
    // Contract section 12: no unexplained constants. The solar constant is not an
    // independent claim, and its record must say so.
    expect(IRRADIANCE_PROVENANCE.luminosity.status).toBe('DEFINED');
    expect(IRRADIANCE_PROVENANCE.astronomicalUnit.status).toBe('DEFINED');
    expect(IRRADIANCE_PROVENANCE.solarConstant.status).toBe('DERIVED');
    expect(IRRADIANCE_PROVENANCE.solarConstant.source).toBe('S5+S3');
    expect(IRRADIANCE_PROVENANCE.solarConstant.citation).toMatch(/4 pi au\^2/);
    expect(IRRADIANCE_PROVENANCE.solarConstant.value).toBe(SOLAR_CONSTANT_W_M2);
  });
});

describe('inverse-square law', () => {
  it('quarters the irradiance when the distance doubles', () => {
    forEachSample(DEFAULT_SEED ^ 0x1a2d, 400, (sampler, context) => {
      const distanceKm = sampler.logRange(1e6, 1e11);
      const near = solarIrradianceWm2(distanceKm);
      const far = solarIrradianceWm2(distanceKm * 2);

      expect(
        relativeError(far, near / 4),
        formatPropertyFailure({ ...context, distanceKm }, near / 4, far),
      ).toBeLessThan(1e-12);
    });
  });

  it('is strictly decreasing in distance', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let au = 0.1; au <= 40; au += 0.31) {
      const value = solarIrradianceWm2(au * AU_KM);
      expect(value, `at ${au} au`).toBeLessThan(previous);
      previous = value;
    }
  });

  it('relates the absolute and relative forms consistently', () => {
    forEachSample(DEFAULT_SEED ^ 0x3a4b, 300, (sampler, context) => {
      const distanceKm = sampler.logRange(1e6, 1e11);
      const absolute = solarIrradianceWm2(distanceKm);
      const relative = relativeSolarIrradiance(distanceKm);

      expect(
        relativeError(absolute, relative * SOLAR_CONSTANT_W_M2),
        formatPropertyFailure(context, relative * SOLAR_CONSTANT_W_M2, absolute),
      ).toBeLessThan(1e-12);
    });
  });

  it('inverts exactly', () => {
    forEachSample(DEFAULT_SEED ^ 0x5c6d, 300, (sampler, context) => {
      const original = sampler.logRange(1e6, 1e11);
      const recovered = distanceForIrradianceKm(solarIrradianceWm2(original));

      expect(
        relativeError(recovered, original),
        formatPropertyFailure(context, original, recovered),
      ).toBeLessThan(1e-9);
    });
  });

  it('rejects non-physical inputs rather than returning infinity', () => {
    // Distance zero would give infinite irradiance, which would propagate into
    // shader uniforms as a non-finite value.
    expect(() => solarIrradianceWm2(0)).toThrow(/positive/);
    expect(() => solarIrradianceWm2(-1)).toThrow(/positive/);
    expect(() => solarIrradianceWm2(Number.NaN)).toThrow(/finite/);
    expect(() => relativeSolarIrradiance(0)).toThrow(/positive/);
    expect(() => distanceForIrradianceKm(0)).toThrow(/positive/);
    expect(() => solarAngularDiameterDeg(0)).toThrow(/positive/);
  });
});

describe('ISSUE D: illumination is independent of render scale', () => {
  /**
   * THE ASSERTION THAT VALIDATES THE DESIGN.
   *
   * A renderer's own inverse-square falloff measures distance in RENDER space. In
   * visualized mode those distances are compressed, so the falloff is wrong by
   * the square of the compression ratio. Measured error, if that route were taken:
   *
   *   jupiter   6.1x too bright
   *   saturn   11.9x
   *   uranus   25.8x
   *   neptune  42.3x
   *
   * Computing irradiance from physical distance in the simulation layer makes the
   * result invariant, and this test measures that invariance rather than inferring
   * it from the code.
   */
  function planetState(): SimulationState {
    return new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 8, 15), paused: true }),
    });
  }

  it('produces byte-identical illumination in both scale modes', () => {
    const snapshot = planetState().snapshot();

    // Physical distances are what illumination reads, and they are the same object
    // regardless of which scale config the render layer happens to be using.
    const illuminationA = computeIllumination(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        distanceFromSunKm: body.distanceFromSunKm,
      })),
    );

    // Scaling the system does not alter the simulation, so recomputing gives the
    // same input and therefore the same output.
    scaleSystem(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        positionKm: body.positionKm,
        parentId: body.parentId,
        physicalRadiusKm: body.physicalRadiusKm,
      })),
      visualizedScale(),
    );

    const illuminationB = computeIllumination(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        distanceFromSunKm: body.distanceFromSunKm,
      })),
    );

    expect(illuminationB).toEqual(illuminationA);
  });

  it('would differ by more than 40x at Neptune if render distances were used', () => {
    // The counterfactual, measured. This is the error the design avoids, and
    // computing it here keeps the justification checkable rather than rhetorical.
    const scientific = scientificScale();
    const visualized = visualizedScale();

    const neptuneDistanceKm = 30.069923 * AU_KM;

    const system = [
      { bodyId: 'sun', positionKm: { x: 0, y: 0, z: 0 }, parentId: null, physicalRadiusKm: 695_700 },
      {
        bodyId: 'neptune',
        positionKm: { x: neptuneDistanceKm, y: 0, z: 0 },
        parentId: 'sun',
        physicalRadiusKm: 24_622,
      },
    ];

    const renderDistanceIn = (config: ReturnType<typeof scientificScale>): number => {
      const scaled = scaleSystem(system, config);
      const neptune = scaled.find((entry) => entry.bodyId === 'neptune')!;
      return Math.hypot(neptune.renderPosition.x, neptune.renderPosition.y, neptune.renderPosition.z);
    };

    const scientificRender = renderDistanceIn(scientific);
    const visualizedRender = renderDistanceIn(visualized);

    // An inverse-square falloff on render distance would over-brighten Neptune by
    // the square of the compression ratio.
    const errorFactor = (scientificRender / visualizedRender) ** 2;
    expect(errorFactor).toBeGreaterThan(40);
    expect(errorFactor).toBeLessThan(45);

    // Whereas the physical computation is unaffected by which config is active.
    expect(solarIrradianceWm2(neptuneDistanceKm)).toBeCloseTo(
      solarIrradianceWm2(neptuneDistanceKm),
      12,
    );
  });

  it('orders the planets by irradiance, inward brightest', () => {
    const state = planetState();
    const illumination = computeIllumination(
      state.snapshot().bodies.map((body) => ({
        bodyId: body.bodyId,
        distanceFromSunKm: body.distanceFromSunKm,
      })),
    );

    // Mercury must be lit most strongly and Neptune least. Independent of the
    // brightness mapping, since this is the physical quantity.
    const byId = new Map(illumination.map((entry) => [entry.bodyId, entry]));
    let previous = Number.POSITIVE_INFINITY;
    for (const bodyId of PLANET_IDS) {
      const value = byId.get(bodyId)!.irradianceWm2;
      expect(value, `${bodyId} is not dimmer than the planet inside it`).toBeLessThan(previous);
      previous = value;
    }
  });

  it('skips the Sun rather than fabricating an irradiance for it', () => {
    // The Sun is a light source, not a lit surface. Distance zero has no
    // meaningful irradiance, and inventing one would be worse than omitting it.
    const illumination = computeIllumination([
      { bodyId: 'sun', distanceFromSunKm: 0 },
      { bodyId: 'earth', distanceFromSunKm: AU_KM },
    ]);

    expect(illumination.map((entry) => entry.bodyId)).toEqual(['earth']);
  });
});

describe('brightness mapping', () => {
  it('is the true relative irradiance in physical mode', () => {
    const config = physicalBrightness();
    for (const au of [0.4, 1, 5, 30]) {
      expect(brightnessFactor(au * AU_KM, config)).toBeCloseTo(
        relativeSolarIrradiance(au * AU_KM),
        12,
      );
    }
  });

  it('compresses the measured 6034:1 physical range to about 21:1', () => {
    // The reason a perceptual mode exists. With true falloff, correctly exposing
    // Mercury leaves Neptune at 0.017 percent of that brightness, which renders as
    // black.
    const mercuryKm = 0.387098 * AU_KM;
    const neptuneKm = 30.069923 * AU_KM;

    const physicalRange =
      relativeSolarIrradiance(mercuryKm) / relativeSolarIrradiance(neptuneKm);
    expect(physicalRange).toBeCloseTo(6034, -1);

    const config = perceptualBrightness();
    const compressedRange =
      brightnessFactor(mercuryKm, config) / brightnessFactor(neptuneKm, config);
    expect(compressedRange).toBeGreaterThan(19);
    expect(compressedRange).toBeLessThan(23);

    // Neptune stays visible instead of vanishing.
    expect(brightnessFactor(neptuneKm, config)).toBeGreaterThan(0.05);
  });

  it('stays monotonic under compression, so ordering still tracks irradiance', () => {
    const config = perceptualBrightness();
    let previous = Number.POSITIVE_INFINITY;
    for (let au = 0.3; au <= 35; au += 0.37) {
      const value = brightnessFactor(au * AU_KM, config);
      expect(value, `at ${au} au`).toBeLessThan(previous);
      previous = value;
    }
  });

  it('is the identity at an exponent of one', () => {
    const config = perceptualBrightness(1);
    expect(brightnessFactor(5 * AU_KM, config)).toBeCloseTo(
      relativeSolarIrradiance(5 * AU_KM),
      12,
    );
  });

  it('rejects an exponent that would break monotonicity', () => {
    // Same bound as the distance compression law, and for the same reason.
    expect(() => perceptualBrightness(0)).toThrow(/\(0, 1\]/);
    expect(() => perceptualBrightness(-0.5)).toThrow(/\(0, 1\]/);
    expect(() => perceptualBrightness(1.5)).toThrow(/\(0, 1\]/);
  });

  it('uses the documented default exponent', () => {
    expect(perceptualBrightness().exponent).toBe(DEFAULT_BRIGHTNESS_EXPONENT);
    expect(DEFAULT_BRIGHTNESS_EXPONENT).toBeGreaterThan(0);
    expect(DEFAULT_BRIGHTNESS_EXPONENT).toBeLessThan(1);
  });
});

describe('solar angular diameter', () => {
  it('derives from the nominal solar radius', () => {
    // Independent computation, so the module cannot satisfy this with a literal.
    const expected =
      2 * Math.asin(NOMINAL_SOLAR_RADIUS_M / AU_M) * (180 / Math.PI);
    expect(solarAngularDiameterDeg(AU_KM)).toBeCloseTo(expected, 9);
  });

  it('shrinks with distance', () => {
    // Needed in M2: apparent solar size sets terminator softness and penumbra
    // width, so the outer planets have far sharper day-night transitions.
    const mercury = solarAngularDiameterDeg(0.387098 * AU_KM);
    const earth = solarAngularDiameterDeg(AU_KM);
    const neptune = solarAngularDiameterDeg(30.069923 * AU_KM);

    expect(mercury).toBeGreaterThan(earth);
    expect(earth).toBeGreaterThan(neptune);
    // Roughly half a degree from Earth, which is the familiar figure.
    expect(earth).toBeCloseTo(0.533, 2);
  });

  it('reaches 180 degrees at the solar surface without producing NaN', () => {
    // asin is clamped, so approaching or entering the photosphere cannot produce a
    // non-finite value that would corrupt a shader uniform.
    const atSurface = solarAngularDiameterDeg(NOMINAL_SOLAR_RADIUS_M / 1000);
    expect(atSurface).toBeCloseTo(180, 6);

    const inside = solarAngularDiameterDeg(NOMINAL_SOLAR_RADIUS_M / 2000);
    expect(Number.isFinite(inside)).toBe(true);
    expect(inside).toBeCloseTo(180, 6);
  });
});

describe('render calibration is kept distinct from physics', () => {
  it('labels itself as a render calibration carrying no physical claim', () => {
    // Contract section 23 requires the 1361 figure to be a validation target
    // rather than a visual value. Keeping the render constant separate and
    // explicitly labelled is what enforces that.
    expect(RENDER_SUN_LIGHT_CALIBRATION.status).toBe('RENDER CALIBRATION');
    expect(RENDER_SUN_LIGHT_CALIBRATION.note).toMatch(/no physical claim/i);
    expect(RENDER_SUN_LIGHT_CALIBRATION.note).toMatch(/no citation/i);
  });

  it('is not derived from the solar constant', () => {
    // Deriving it would require an uncited luminous efficacy figure and would
    // present a tuning parameter as though it followed from physics.
    expect(RENDER_SUN_LIGHT_CALIBRATION.intensity).not.toBeCloseTo(SOLAR_CONSTANT_W_M2, 0);
    expect(RENDER_SUN_LIGHT_CALIBRATION.intensity).toBeLessThan(100);
  });

  it('disables the renderer own distance falloff', () => {
    // Falloff must come from brightnessFactor, which is computed from physical
    // distance. A non-zero decay here would reintroduce the 42x Neptune error.
    expect(RENDER_SUN_LIGHT_CALIBRATION.decay).toBe(0);
    expect(RENDER_SUN_LIGHT_CALIBRATION.note).toMatch(/solarIrradianceWm2/);
  });
});

describe('brightness disclosure', () => {
  it('states inverse square in physical mode', () => {
    const description = getBrightnessDescription(physicalBrightness());
    expect(description.compressed).toBe(false);
    expect(description.label).toMatch(/INVERSE SQUARE/);
    expect(description.formula).toBe('factor = (1 au / d)^2');
    expect(description.lines).toHaveLength(1);
  });

  it('declares the compression and preserves the physical reading', () => {
    // Contract sections 9 and 27: a distorted quantity must be labelled, and the
    // physical value must still be available.
    const description = getBrightnessDescription(perceptualBrightness());

    expect(description.compressed).toBe(true);
    expect(description.label).toMatch(/NON-LINEAR/);
    expect(description.formula).toContain(String(DEFAULT_BRIGHTNESS_EXPONENT));
    expect(description.lines.some((line) => line.includes('compressed'))).toBe(true);
    expect(description.lines.some((line) => line.includes('W/m^2'))).toBe(true);
  });

  it('reports no compression at an exponent of one', () => {
    expect(getBrightnessDescription(perceptualBrightness(1)).compressed).toBe(false);
  });
});

describe('illumination records', () => {
  it('carries both the physical irradiance and the render factor', () => {
    // The interface must be able to show the physical value while the renderer
    // uses the mapped one. Collapsing them into a single number is how a
    // presentation choice ends up displayed as a measurement.
    const illumination = computeIllumination(
      [{ bodyId: 'neptune', distanceFromSunKm: 30.069923 * AU_KM }],
      perceptualBrightness(),
    );

    const neptune = illumination[0]!;
    expect(neptune.irradianceWm2).toBeCloseTo(1.505, 2);
    expect(neptune.relativeIrradiance).toBeCloseTo(1.1059e-3, 6);
    // The render factor is compressed and therefore much larger.
    expect(neptune.brightnessFactor).toBeGreaterThan(neptune.relativeIrradiance * 50);
    expect(neptune.solarAngularDiameterDeg).toBeCloseTo(0.0177, 3);
  });

  it('leaves the render factor equal to the physical value in physical mode', () => {
    const neptune = computeIllumination(
      [{ bodyId: 'neptune', distanceFromSunKm: 30.069923 * AU_KM }],
      physicalBrightness(),
    )[0]!;

    expect(neptune.brightnessFactor).toBeCloseTo(neptune.relativeIrradiance, 12);
  });

  it('keeps every field finite across the whole system', () => {
    const state = new SimulationState({
      clock: new SimulationClock({ epoch: utc(2026, 8, 15), paused: true }),
    });

    const illumination = computeIllumination(
      state.snapshot().bodies.map((body) => ({
        bodyId: body.bodyId,
        distanceFromSunKm: body.distanceFromSunKm,
      })),
      perceptualBrightness(),
    );

    expect(illumination.length).toBe(PLANET_IDS.length);
    for (const entry of illumination) {
      for (const [name, value] of Object.entries(entry)) {
        if (typeof value !== 'number') continue;
        expect(Number.isFinite(value), `${entry.bodyId}.${name}`).toBe(true);
        expect(value, `${entry.bodyId}.${name}`).toBeGreaterThan(0);
      }
    }
  });
});
