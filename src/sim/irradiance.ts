/**
 * Solar irradiance.
 *
 * WHY THIS MODULE EXISTS (contract section 23). The requirement is that solar
 * illumination be calibrated so Earth receives approximately 1361 W/m^2 "in the
 * physical model", and it states explicitly that this is "a validation target,
 * not a value to fake visually". Those are two different jobs, and conflating
 * them is the defect this module prevents:
 *
 *   PHYSICAL   - irradiance in W/m^2 at a given distance. Derived from cited
 *                constants, unit-tested, and reported to the interface as a
 *                computed physical quantity.
 *
 *   RENDER     - how bright to draw a lit surface. A calibration, labelled as
 *                such, carrying no claim about the physical world.
 *
 * NO WATT-TO-CANDELA CONVERSION IS PERFORMED. Converting radiometric watts to
 * the photometric units a renderer's light intensity expects requires a solar
 * luminous efficacy figure, roughly 93 lm/W, and no citation for it was
 * available while writing this. Rather than embed an uncited constant, the
 * render layer receives a dimensionless relative irradiance and applies its own
 * documented exposure. Contract section 12 forbids undocumented magic numbers,
 * and that includes ones that would be buried in a unit conversion.
 *
 * THE SECOND HALF OF THE PROBLEM, measured. A renderer's inverse-square light
 * falloff computes distance in RENDER space. In visualized mode render distances
 * are compressed, so that falloff is wrong, and not slightly:
 *
 *   body      true relative    via compressed distance    error
 *   mercury      6.674e+0            2.349e+0             0.4x
 *   earth        1.000e+0            1.000e+0             1.0x
 *   jupiter      3.694e-2            2.267e-1             6.1x
 *   saturn       1.100e-2            1.314e-1            11.9x
 *   uranus       2.716e-3            7.002e-2            25.8x
 *   neptune      1.106e-3            4.674e-2            42.3x
 *
 * Neptune would be lit 42 times too brightly. The fix is to compute irradiance
 * from PHYSICAL distance here, in the simulation layer, and hand the renderer a
 * per-body factor. Illumination is then correct in both scale modes, which
 * satisfies the original brief's "physically plausible falloff" exactly rather
 * than approximately.
 */

import {
  AU_KM,
  AU_M,
  NOMINAL_SOLAR_LUMINOSITY_W,
  NOMINAL_SOLAR_RADIUS_M,
  RAD_TO_DEG,
} from '../data/constants';

/**
 * Solar irradiance at one astronomical unit, W/m^2.
 *
 *   E = L / (4 pi d^2)
 *
 * DERIVED, NOT ASSERTED. Both inputs are DEFINED constants:
 *
 *   L  = 3.828e26 W          IAU 2015 Resolution B3, nominal solar luminosity
 *   au = 149597870700 m      IAU 2012 Resolution B1, exact
 *
 * so this value is an exact arithmetic consequence of two definitions rather
 * than an independent empirical claim. It evaluates to 1361.1665 W/m^2, which is
 * why contract section 23 names 1361 as the validation target: the nominal
 * luminosity was chosen by the IAU to be consistent with modern total solar
 * irradiance determinations.
 *
 * NOT AN INSTANTANEOUS MEASUREMENT. The real Sun varies by roughly 0.1 percent
 * over the solar cycle, so no value computed here describes the Sun at a
 * particular moment. This is a nominal reporting constant, and the interface must
 * present it as MODEL rather than as measured output.
 */
export const SOLAR_CONSTANT_W_M2 =
  NOMINAL_SOLAR_LUMINOSITY_W / (4 * Math.PI * AU_M * AU_M);

/**
 * Irradiance from the Sun at a distance, W/m^2.
 *
 * Inverse-square law on the PHYSICAL distance. Never pass a render-space
 * distance to this function; that is the error the module header quantifies.
 *
 * @param distanceKm distance from the Sun's centre, kilometres
 */
export function solarIrradianceWm2(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error(
      `solarIrradianceWm2: distance must be positive and finite, got ${distanceKm}`,
    );
  }
  const distanceM = distanceKm * 1000;
  return NOMINAL_SOLAR_LUMINOSITY_W / (4 * Math.PI * distanceM * distanceM);
}

/**
 * Irradiance relative to the value at one astronomical unit, dimensionless.
 *
 * This is the quantity to hand a shader: it is scale-mode independent because it
 * is computed from physical distance, and it needs no unit conversion because it
 * is a ratio. One at Earth's mean distance, 6.67 at Mercury, 0.0011 at Neptune.
 */
export function relativeSolarIrradiance(distanceKm: number): number {
  const ratio = AU_KM / distanceKm;
  if (!Number.isFinite(ratio) || distanceKm <= 0) {
    throw new Error(
      `relativeSolarIrradiance: distance must be positive and finite, got ${distanceKm}`,
    );
  }
  return ratio * ratio;
}

/** Distance at which a given irradiance occurs, km. Inverse of solarIrradianceWm2. */
export function distanceForIrradianceKm(irradianceWm2: number): number {
  if (!Number.isFinite(irradianceWm2) || irradianceWm2 <= 0) {
    throw new Error(
      `distanceForIrradianceKm: irradiance must be positive and finite, got ${irradianceWm2}`,
    );
  }
  const distanceM = Math.sqrt(
    NOMINAL_SOLAR_LUMINOSITY_W / (4 * Math.PI * irradianceWm2),
  );
  return distanceM / 1000;
}

/**
 * Angular diameter of the Sun seen from a distance, degrees.
 *
 * Uses the IAU nominal solar radius, so it is a defined-constant consequence in
 * the same way the solar constant is. Needed in M2 for the softness of the
 * terminator and for penumbra width: the Sun is not a point source, and its
 * apparent size is what sets how gradual the day-night transition looks. About
 * 0.53 degrees from Earth, 1.38 from Mercury, 0.02 from Neptune.
 */
export function solarAngularDiameterDeg(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error(
      `solarAngularDiameterDeg: distance must be positive and finite, got ${distanceKm}`,
    );
  }
  const distanceM = distanceKm * 1000;
  // Half-angle from the radius, doubled. asin rather than a small-angle
  // approximation, so the result stays correct arbitrarily close to the surface.
  const sinHalfAngle = Math.min(1, NOMINAL_SOLAR_RADIUS_M / distanceM);
  return 2 * Math.asin(sinHalfAngle) * RAD_TO_DEG;
}

/**
 * How brightness is mapped for display.
 *
 *   PHYSICAL   - true relative irradiance. Physically faithful, and visually
 *                unusable across the whole system: the range from Mercury to
 *                Neptune is 6034 to 1, measured, so if Mercury is correctly
 *                exposed then Neptune receives about 0.017 percent of that light
 *                and renders as black.
 *
 *   PERCEPTUAL - relative irradiance raised to a power below one, which
 *                compresses that range so the outer planets remain visible.
 *                A DISPLAY CHOICE, disclosed exactly like the distance
 *                compression in sim/scale.ts.
 */
export type BrightnessMode = 'PHYSICAL' | 'PERCEPTUAL';

/**
 * Default perceptual compression exponent.
 *
 * MEASURED EFFECT. The physical Mercury-to-Neptune irradiance range is 6034:1.
 * Raising relative irradiance to this exponent maps that onto 21.0:1, with
 * Neptune's factor landing at 0.092 rather than 0.00017. That keeps the outer
 * planets visible while preserving both the ordering and the qualitative sense
 * that the outer system is dimly lit.
 *
 * Alternatives measured, for context on why this one:
 *
 *   exponent   range      Neptune factor
 *   0.20        5.7:1        0.256          outer system too bright, looks flat
 *   0.25        8.8:1        0.182
 *   0.30       13.6:1        0.130
 *   0.35       21.0:1        0.092          chosen
 *   0.40       32.5:1        0.066
 *   0.50       77.7:1        0.033          Neptune nearly black
 *
 * A presentation parameter with no empirical content, disclosed by
 * getBrightnessDescription whenever it is active.
 */
export const DEFAULT_BRIGHTNESS_EXPONENT = 0.35;

export interface BrightnessConfig {
  readonly mode: BrightnessMode;
  /** Compression exponent, in (0, 1]. Ignored in PHYSICAL mode. */
  readonly exponent: number;
}

/** True relative irradiance, uncompressed. */
export function physicalBrightness(): BrightnessConfig {
  return { mode: 'PHYSICAL', exponent: 1 };
}

/** Compressed for visibility across the whole system. */
export function perceptualBrightness(
  exponent: number = DEFAULT_BRIGHTNESS_EXPONENT,
): BrightnessConfig {
  // Same bound as the distance law: outside (0, 1] this stops being an
  // order-preserving compression, and brightness ordering would no longer track
  // irradiance ordering.
  if (!(exponent > 0) || exponent > 1) {
    throw new Error(`perceptualBrightness: exponent must lie in (0, 1], got ${exponent}`);
  }
  return { mode: 'PERCEPTUAL', exponent };
}

/**
 * The dimensionless factor a shader should multiply its light term by.
 *
 * Monotonic in distance under both modes, so a nearer body is never drawn dimmer
 * than a farther one.
 */
export function brightnessFactor(distanceKm: number, config: BrightnessConfig): number {
  const relative = relativeSolarIrradiance(distanceKm);
  if (config.mode === 'PHYSICAL' || config.exponent === 1) return relative;
  return Math.pow(relative, config.exponent);
}

/** Illumination of one body, physical and render values kept distinct. */
export interface BodyIllumination {
  readonly bodyId: string;
  /** Distance from the Sun used, km. Physical, never render-space. */
  readonly distanceKm: number;
  /** Irradiance, W/m^2. A computed physical quantity, for display. */
  readonly irradianceWm2: number;
  /** True irradiance relative to 1 au, dimensionless. */
  readonly relativeIrradiance: number;
  /** Factor for the renderer, equal to relativeIrradiance in PHYSICAL mode. */
  readonly brightnessFactor: number;
  /** Apparent solar diameter, degrees. Sets terminator and penumbra softness. */
  readonly solarAngularDiameterDeg: number;
}

/** Minimum a body needs to have its illumination computed. */
export interface IlluminableBody {
  readonly bodyId: string;
  readonly distanceFromSunKm: number;
}

/**
 * Computes illumination for a set of bodies.
 *
 * Reads only physical distances, so the result is identical in both scale modes.
 * That invariance is the point, and it is asserted in the test suite.
 *
 * The Sun itself, at distance zero, has no meaningful irradiance and is skipped
 * rather than given a fabricated value: it is a light source, not a lit surface,
 * and its appearance comes from emission.
 */
export function computeIllumination(
  bodies: readonly IlluminableBody[],
  config: BrightnessConfig = physicalBrightness(),
): readonly BodyIllumination[] {
  const result: BodyIllumination[] = [];

  for (const body of bodies) {
    if (body.distanceFromSunKm <= 0) continue;

    result.push({
      bodyId: body.bodyId,
      distanceKm: body.distanceFromSunKm,
      irradianceWm2: solarIrradianceWm2(body.distanceFromSunKm),
      relativeIrradiance: relativeSolarIrradiance(body.distanceFromSunKm),
      brightnessFactor: brightnessFactor(body.distanceFromSunKm, config),
      solarAngularDiameterDeg: solarAngularDiameterDeg(body.distanceFromSunKm),
    });
  }

  return result;
}

/** Disclosure of the brightness mapping, for the interface. */
export interface BrightnessDescription {
  readonly mode: BrightnessMode;
  readonly compressed: boolean;
  readonly label: string;
  readonly formula: string;
  readonly lines: readonly string[];
}

/**
 * Describes the active brightness mapping.
 *
 * A compressed mapping is a distortion of a physical quantity and must be
 * disclosed, on the same principle as the distance and size labels in
 * sim/scale.ts. Contract sections 9 and 27.
 */
export function getBrightnessDescription(config: BrightnessConfig): BrightnessDescription {
  const compressed = config.mode === 'PERCEPTUAL' && config.exponent !== 1;

  const label = compressed ? 'PERCEPTUAL (NON-LINEAR)' : 'PHYSICAL (INVERSE SQUARE)';
  const formula = compressed
    ? `factor = (1 au / d)^(2 x ${config.exponent})`
    : 'factor = (1 au / d)^2';

  const lines = [`ILLUMINATION: ${label}`];
  if (compressed) {
    lines.push('  Relative brightness is compressed for visibility.');
    lines.push('  Irradiance values shown in W/m^2 remain physical.');
  }

  return { mode: config.mode, compressed, label, formula, lines };
}

/**
 * RENDER CALIBRATION, NOT A PHYSICAL QUANTITY.
 *
 * Intensity for the Sun's light in the renderer's own units. It exists to make
 * the scene expose correctly under the chosen tone-mapping operator, and it
 * asserts nothing about the Sun. It is deliberately kept in this module, beside
 * the physical values, so the distinction is visible at the point where the two
 * could be confused.
 *
 * Its value is not derived from SOLAR_CONSTANT_W_M2, and must not be: doing so
 * would require the uncited luminous efficacy figure discussed in the header, and
 * would present a render tuning parameter as though it followed from physics.
 *
 * The renderer should disable its own distance falloff and use brightnessFactor
 * instead, because that factor is computed from physical distance and therefore
 * stays correct when render distances are compressed.
 */
export const RENDER_SUN_LIGHT_CALIBRATION = {
  /** Light intensity in renderer units. Tuned by eye against the tone mapper. */
  intensity: 4,
  /**
   * Falloff exponent for the renderer's own light. Zero means no distance
   * falloff, because falloff is supplied by brightnessFactor from physical
   * distance instead.
   */
  decay: 0,
  status: 'RENDER CALIBRATION' as const,
  note: 'Presentation parameter. Carries no physical claim and no citation. Physical illumination is solarIrradianceWm2.',
} as const;

/** Provenance for the physical quantities in this module. */
export const IRRADIANCE_PROVENANCE = {
  luminosity: {
    value: NOMINAL_SOLAR_LUMINOSITY_W,
    unit: 'W',
    source: 'S5',
    status: 'DEFINED',
    citation: 'IAU 2015 Resolution B3, nominal solar luminosity',
  },
  astronomicalUnit: {
    value: AU_M,
    unit: 'm',
    source: 'S3',
    status: 'DEFINED',
    citation: 'IAU 2012 Resolution B1, exact',
  },
  solarRadius: {
    value: NOMINAL_SOLAR_RADIUS_M,
    unit: 'm',
    source: 'S5',
    status: 'DEFINED',
    citation: 'IAU 2015 Resolution B3, nominal solar radius',
  },
  solarConstant: {
    value: SOLAR_CONSTANT_W_M2,
    unit: 'W/m^2',
    source: 'S5+S3',
    status: 'DERIVED',
    citation: 'L / (4 pi au^2) from the two defined constants above',
  },
} as const;
