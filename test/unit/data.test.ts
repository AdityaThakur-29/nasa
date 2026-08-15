/**
 * Data-layer validation.
 *
 * PURPOSE: this is the "no fabricated scientific data" gate. It does not check
 * that the code computes correctly; it checks that the transcribed constants are
 * internally consistent with independent physics, and that every value carries
 * provenance.
 *
 * HOW EXPECTED VALUES ARE OBTAINED: each cross-check recomputes a published
 * quantity from OTHER published quantities using a physical law, then compares.
 * Density from mass and radius. Escape velocity from GM and radius. Orbital
 * period from semi-major axis via Kepler III. Rotation period from the IAU
 * prime-meridian rate. No expected value is taken from the module under test,
 * and none was invented.
 *
 * HOW TOLERANCES ARE CHOSEN: every tolerance below is stated with the reason it
 * has the magnitude it does, and is set above a MEASURED residual rather than
 * tightened until the suite passed. Where a physical effect is deliberately
 * excluded from a comparison (centrifugal flattening, satellite mass, planetary
 * perturbations) the tolerance accommodates that effect and says so. A tolerance
 * with no stated justification is a bug in this file.
 */

import { describe, expect, it } from 'vitest';
import {
  BODIES,
  BODY_ORDER,
  ELEMENT_ROW_FOR_BODY,
  PLANET_IDS,
  getBody,
  massFromGm,
  twoBodyPeriodDays,
  yearsToDays,
  type Measured,
} from '@/data/bodies';
import {
  IAU_ROTATION,
  ROTATION_SOURCE,
  flattening,
  getRotationRecord,
  volumetricMeanRadiusKm,
} from '@/data/iau-rotation';
import {
  ELEMENTS_TABLE_1,
  ELEMENTS_TABLE_2A,
  ELEMENT_ACCURACY,
  ELEMENT_SOURCE,
  EMBARY_LIMITATION,
  J2000_OBLIQUITY_DEG as FORMULA_OBLIQUITY_DEG,
  getElementRecord,
  isWithinValidity,
} from '@/data/jpl-elements';
import {
  AU_KM,
  AU_M,
  CONSTANT_SOURCES,
  GM_SUN_KM3_S2,
  GRAVITATIONAL_CONSTANT,
  GRAVITATIONAL_CONSTANT_UNCERTAINTY,
  J2000_OBLIQUITY_ARCSEC,
  J2000_OBLIQUITY_DEG,
  JULIAN_CENTURY_DAYS,
  NOMINAL_SOLAR_LUMINOSITY_W,
} from '@/data/constants';

/**
 * Relative uncertainty of the CODATA gravitational constant.
 *
 * This is the floor on any comparison that converts between GM and mass, since
 * that conversion divides by G. Several tolerances below are derived from it
 * rather than picked.
 */
const G_RELATIVE_UNCERTAINTY = GRAVITATIONAL_CONSTANT_UNCERTAINTY / GRAVITATIONAL_CONSTANT;

/** Source identifiers declared in sources.md. Nothing may cite anything else. */
const KNOWN_SOURCES = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);

/** Collects every Measured field on a body, with a path for error messages. */
function measuredFields(bodyId: string): ReadonlyArray<{ path: string; field: Measured }> {
  const body = getBody(bodyId);
  const out: Array<{ path: string; field: Measured }> = [];
  for (const [key, value] of Object.entries(body)) {
    if (value !== null && typeof value === 'object' && 'value' in value && 'unit' in value) {
      out.push({ path: `${bodyId}.${key}`, field: value as Measured });
    }
  }
  return out;
}

describe('provenance', () => {
  it('gives every measured field a finite value, a unit and a known source', () => {
    for (const id of BODY_ORDER) {
      const fields = measuredFields(id);
      // Guard against a body silently carrying no measurements at all.
      expect(fields.length, `${id} exposes no measured fields`).toBeGreaterThan(0);

      for (const { path, field } of fields) {
        expect(Number.isFinite(field.value), `${path} value is not finite`).toBe(true);
        expect(field.unit.length, `${path} has an empty unit`).toBeGreaterThan(0);
        // Compound sources such as "S3+S3" record a derived value; check each part.
        for (const part of field.source.split('+')) {
          expect(KNOWN_SOURCES.has(part), `${path} cites unknown source "${part}"`).toBe(true);
        }
      }
    }
  });

  it('keeps every published uncertainty positive and smaller than its value', () => {
    for (const id of BODY_ORDER) {
      for (const { path, field } of measuredFields(id)) {
        if (field.uncertainty === undefined) continue;
        expect(field.uncertainty, `${path} uncertainty must be positive`).toBeGreaterThan(0);
        expect(
          field.uncertainty,
          `${path} uncertainty exceeds its own value, which indicates a transcription error`,
        ).toBeLessThan(Math.abs(field.value));
      }
    }
  });

  it('declares provenance for every constant it exposes', () => {
    for (const [name, meta] of Object.entries(CONSTANT_SOURCES)) {
      expect(KNOWN_SOURCES.has(meta.source), `${name} cites unknown source`).toBe(true);
      expect(['DEFINED', 'MEASURED']).toContain(meta.status);
      expect(meta.citation.length, `${name} has an empty citation`).toBeGreaterThan(0);
    }
  });

  it('carries model provenance on the element and rotation tables', () => {
    expect(ELEMENT_SOURCE.url).toMatch(/^https:\/\//);
    expect(ELEMENT_SOURCE.model.length).toBeGreaterThan(0);
    expect(ROTATION_SOURCE.url).toMatch(/^https:\/\//);
    expect(ROTATION_SOURCE.frame).toMatch(/J2000|ICRF/);
  });
});

describe('defined constants', () => {
  it('holds the astronomical unit exactly as defined by IAU 2012 B1', () => {
    // Exact by definition, so an exact assertion is correct here.
    expect(AU_M).toBe(149_597_870_700);
    expect(AU_KM).toBe(149_597_870.7);
    expect(CONSTANT_SOURCES.AU_M.status).toBe('DEFINED');
  });

  it('derives the obliquity in degrees from its arcsecond value', () => {
    expect(J2000_OBLIQUITY_DEG * 3600).toBeCloseTo(J2000_OBLIQUITY_ARCSEC, 9);
  });

  it('separates the S1 formula obliquity from the S3 measured obliquity', () => {
    // Measured discrepancy is 0.004 arcsec. The two must NOT be silently unified:
    // the S1 algorithm was fitted with its own coarser value.
    const differenceArcsec = J2000_OBLIQUITY_ARCSEC - FORMULA_OBLIQUITY_DEG * 3600;
    expect(Math.abs(differenceArcsec)).toBeCloseTo(0.004, 6);
    // And the gap is negligible against Mercury's 15 arcsec nominal longitude error.
    expect(Math.abs(differenceArcsec)).toBeLessThan(ELEMENT_ACCURACY['mercury']!.longitudeArcsec);
  });

  it('converts the heliocentric gravitational constant consistently', () => {
    expect(GM_SUN_KM3_S2 * 1e9).toBeCloseTo(1.327_124_400_412_794_19e20, 6);
  });

  it('implies a solar mass near the accepted value', () => {
    // Independent sanity check on GM_sun and G together. Loose by design: this
    // confirms no exponent slipped, it does not measure the Sun.
    const solarMassKg = (GM_SUN_KM3_S2 * 1e9) / GRAVITATIONAL_CONSTANT;
    expect(solarMassKg).toBeGreaterThan(1.98e30);
    expect(solarMassKg).toBeLessThan(1.99e30);
  });

  it('keeps the nominal solar luminosity as the IAU defined value', () => {
    expect(NOMINAL_SOLAR_LUMINOSITY_W).toBe(3.828e26);
    expect(CONSTANT_SOURCES.NOMINAL_SOLAR_LUMINOSITY_W.status).toBe('DEFINED');
  });
});

describe('bulk density consistency', () => {
  it('reproduces the published density from mass and mean radius', () => {
    // Sphere of the published mean radius holding the published mass. Measured
    // worst case is Uranus at 2.9e-4 relative, which reflects the published
    // density carrying fewer significant figures than mass and radius do.
    const TOLERANCE = 5e-4;

    for (const id of BODY_ORDER) {
      const body = getBody(id);
      if (body.bulkDensityGCm3 === undefined) continue;

      const radiusCm = body.meanRadiusKm.value * 1e5;
      const volumeCm3 = (4 / 3) * Math.PI * radiusCm ** 3;
      const densityGCm3 = (body.massKg.value * 1000) / volumeCm3;

      const relative = Math.abs(densityGCm3 - body.bulkDensityGCm3.value) / body.bulkDensityGCm3.value;
      expect(
        relative,
        `${id}: published ${body.bulkDensityGCm3.value} vs derived ${densityGCm3.toFixed(6)} g/cm^3`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  it('places Saturn below the density of water', () => {
    // A famous property, and a cheap guard against a decimal slip in either
    // Saturn's mass or its radius.
    expect(getBody('saturn').bulkDensityGCm3!.value).toBeLessThan(1.0);
  });
});

describe('escape velocity consistency', () => {
  it('reproduces the published escape velocity from GM and mean radius', () => {
    // v = sqrt(2 GM / R). Measured worst case is Mars at 5.9e-4 relative, driven
    // by the published values being quoted to only three significant figures.
    // Giant-planet GM values are SYSTEM values, which raises v by roughly 1e-4.
    const TOLERANCE = 1e-3;

    for (const id of PLANET_IDS) {
      const body = getBody(id);
      if (body.escapeVelocityKmS === undefined) continue;

      const derived = Math.sqrt((2 * body.gm.value) / body.meanRadiusKm.value);
      const relative = Math.abs(derived - body.escapeVelocityKmS.value) / body.escapeVelocityKmS.value;
      expect(
        relative,
        `${id}: published ${body.escapeVelocityKmS.value} vs derived ${derived.toFixed(6)} km/s`,
      ).toBeLessThan(TOLERANCE);
    }
  });
});

describe('surface gravity consistency', () => {
  it('reproduces the published equatorial gravity from GM and equatorial radius', () => {
    // GM/Re^2 is the Newtonian point-mass value. It deliberately EXCLUDES
    // centrifugal reduction and the J2 oblateness term, both of which are real
    // and are why the published figures differ. Measured worst case is Mars at
    // 8.6e-4 relative; the tolerance leaves room for those excluded effects
    // rather than pretending the comparison is exact.
    const TOLERANCE = 2e-3;

    for (const id of PLANET_IDS) {
      const body = getBody(id);
      if (body.equatorialGravityMS2 === undefined) continue;

      const radiusM = body.equatorialRadiusKm.value * 1000;
      const derived = (body.gm.value * 1e9) / (radiusM * radiusM);
      const relative =
        Math.abs(derived - body.equatorialGravityMS2.value) / body.equatorialGravityMS2.value;
      expect(
        relative,
        `${id}: published ${body.equatorialGravityMS2.value} vs derived ${derived.toFixed(6)} m/s^2`,
      ).toBeLessThan(TOLERANCE);
    }
  });
});

describe('mass and GM consistency', () => {
  it('agrees within the uncertainty of G for planet-scope GM values', () => {
    // Converting GM to mass divides by G, so this comparison cannot beat G's own
    // relative uncertainty of about 2.2e-5. The tolerance is that floor, not a
    // number chosen to pass. Measured worst case is Mercury at 8.9e-6.
    const TOLERANCE = G_RELATIVE_UNCERTAINTY * 1.5;

    for (const id of PLANET_IDS) {
      const body = getBody(id);
      if (body.gm.scope !== 'PLANET') continue;

      const derived = massFromGm(body.gm.value);
      const relative = Math.abs(derived - body.massKg.value) / body.massKg.value;
      expect(
        relative,
        `${id}: S2 mass vs S3 GM/G disagree by ${relative.toExponential(3)}, ` +
          `above the ${TOLERANCE.toExponential(3)} floor set by G`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  it('shows a positive mass excess for system-scope GM values, from satellites', () => {
    // A physical assertion rather than a tolerance check: a SYSTEM GM includes
    // satellite mass, so it must imply MORE mass than the planet alone. The
    // measured excess matches known satellite mass ratios: Jupiter 2.07e-4
    // against a Galilean ratio near 2.1e-4, Saturn 2.48e-4 against Titan near
    // 2.37e-4. If a system GM were mistakenly paired with a planet mass, or the
    // scope tag were wrong, this sign flips.
    const GIANTS = ['jupiter', 'saturn', 'uranus', 'neptune'];

    for (const id of GIANTS) {
      const body = getBody(id);
      expect(body.gm.scope, `${id} GM should be tagged SYSTEM`).toBe('SYSTEM');

      const excess = (massFromGm(body.gm.value) - body.massKg.value) / body.massKg.value;
      expect(excess, `${id} system GM implies less mass than the planet alone`).toBeGreaterThan(0);
      // Satellite systems are a small fraction of a giant planet's mass.
      expect(excess, `${id} satellite mass fraction implausibly large`).toBeLessThan(1e-3);
    }
  });

  it("treats Mars's satellite mass as below the resolution of this comparison", () => {
    // Mars carries a SYSTEM GM, but Phobos and Deimos together are around 1e-8
    // of Mars's mass, far below G's 2.2e-5 uncertainty. The excess is therefore
    // unmeasurable here and must not be asserted as positive.
    const body = getBody('mars');
    expect(body.gm.scope).toBe('SYSTEM');

    const excess = Math.abs(massFromGm(body.gm.value) - body.massKg.value) / body.massKg.value;
    expect(excess).toBeLessThan(G_RELATIVE_UNCERTAINTY);
  });
});

describe('rotation period consistency', () => {
  /**
   * Neptune is excluded and handled separately. S2 and S4 genuinely disagree
   * there, and folding it into a loosened tolerance would hide the conflict.
   */
  const AGREEING_BODIES = BODY_ORDER.filter((id) => id !== 'neptune');

  it('matches the IAU prime-meridian rate for every body except Neptune', () => {
    // period = 360 / Wdot. Measured worst case among these is Jupiter at 4.0e-6
    // relative, which is rounding in the published period.
    const TOLERANCE = 1e-5;

    for (const id of AGREEING_BODIES) {
      const body = BODIES[id];
      const rotation = IAU_ROTATION[id];
      if (body?.siderealRotationPeriodDays === undefined || rotation === undefined) continue;

      const published = body.siderealRotationPeriodDays.value;
      const derived = 360 / rotation.primeMeridian[1];

      // Compare magnitudes: the sign conventions differ between the two sources,
      // and rotation SENSE is asserted separately below.
      const relative = Math.abs(Math.abs(derived) - Math.abs(published)) / Math.abs(published);
      expect(
        relative,
        `${id}: S2 period ${published} d vs S4-derived ${derived.toFixed(6)} d`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  it('documents the measured Neptune conflict instead of hiding it', () => {
    // S2's published period reproduces the kernel's SUPERSEDED rate exactly,
    // which is the evidence that S2 predates the IAU 2015 value.
    const published = getBody('neptune').siderealRotationPeriodDays!.value;
    const SUPERSEDED_RATE = 536.3128492;
    const currentRate = getRotationRecord('neptune').primeMeridian[1];

    expect(360 / SUPERSEDED_RATE).toBeCloseTo(published, 6);

    const currentPeriod = 360 / currentRate;
    const disagreement = Math.abs(currentPeriod - published) / published;
    expect(disagreement).toBeGreaterThan(1e-3);
    expect(disagreement).toBeCloseTo(0.00892, 4);

    // The conflict must be recorded in both files, so it cannot be silently lost.
    expect(getRotationRecord('neptune').note).toMatch(/CONFLICT/i);
    expect(getBody('neptune').note).toMatch(/CONFLICT/i);
  });

  it('uses the current IAU rate rather than the superseded one', () => {
    expect(getRotationRecord('neptune').primeMeridian[1]).toBeCloseTo(541.1397757, 7);
  });
});

describe('retrograde rotation emerges from the data', () => {
  it('encodes retrograde motion as a negative prime-meridian rate', () => {
    // Contract section 15: no body may be special-cased. Venus and Uranus are
    // retrograde purely because their published rate is negative.
    expect(getRotationRecord('venus').primeMeridian[1]).toBeLessThan(0);
    expect(getRotationRecord('uranus').primeMeridian[1]).toBeLessThan(0);

    for (const id of ['mercury', 'earth', 'mars', 'jupiter', 'saturn', 'neptune']) {
      expect(getRotationRecord(id).primeMeridian[1], `${id} should be prograde`).toBeGreaterThan(0);
    }
  });

  it('agrees with the sign convention of the published rotation periods', () => {
    // The two sources encode rotation sense independently: S2 by the sign of the
    // period, S4 by the sign of the rate. They must not contradict each other.
    for (const id of BODY_ORDER) {
      const body = BODIES[id];
      const rotation = IAU_ROTATION[id];
      if (body?.siderealRotationPeriodDays === undefined || rotation === undefined) continue;

      const s2Retrograde = body.siderealRotationPeriodDays.value < 0;
      const s4Retrograde = rotation.primeMeridian[1] < 0;
      expect(s4Retrograde, `${id}: rotation sense disagrees between S2 and S4`).toBe(s2Retrograde);
    }
  });

  it('places the Uranus pole below the ecliptic', () => {
    // The negative declination is what produces the sideways orientation. Stored
    // as data, not as a hardcoded 97.8 degree tilt.
    expect(getRotationRecord('uranus').poleDec[0]).toBeLessThan(0);
  });
});

describe('figure of the planets', () => {
  it('derives the Saturn flattening the M2 ring geometry depends on', () => {
    // (a - c) / a from the published radii. A spherical shadow test is visibly
    // wrong at the ring plane, so this value has a rendering consequence.
    expect(flattening(getRotationRecord('saturn'))).toBeCloseTo(0.098, 3);
  });

  it('orders the gas giants as more oblate than the terrestrial planets', () => {
    const jupiter = flattening(getRotationRecord('jupiter'));
    const earth = flattening(getRotationRecord('earth'));
    expect(jupiter).toBeGreaterThan(earth);
    // Earth's flattening is close to the familiar 1/298.
    expect(1 / earth).toBeCloseTo(298.25, 0);
  });

  it('agrees with the published mean radius to well under a kilometre', () => {
    // The volumetric mean of the IAU triaxial radii is not identical to the
    // published mean radius, which comes from a shape model. Measured worst case
    // is Mercury at 0.37 km. Asserting agreement to 1 km confirms the two
    // describe the same body without pretending they are the same quantity.
    const TOLERANCE_KM = 1.0;

    for (const id of BODY_ORDER) {
      const body = BODIES[id];
      const rotation = IAU_ROTATION[id];
      if (body === undefined || rotation === undefined) continue;

      const difference = Math.abs(volumetricMeanRadiusKm(rotation) - body.meanRadiusKm.value);
      expect(difference, `${id}: volumetric vs published mean radius`).toBeLessThan(TOLERANCE_KM);
    }
  });

  it('never reports an equatorial radius smaller than the mean radius', () => {
    for (const id of BODY_ORDER) {
      const body = getBody(id);
      expect(
        body.equatorialRadiusKm.value,
        `${id}: equatorial radius below mean radius`,
      ).toBeGreaterThanOrEqual(body.meanRadiusKm.value);
    }
  });
});

describe('element table transcription', () => {
  it('recovers the published orbital period from the mean longitude rate', () => {
    // INDEPENDENT CHECK ON THE L COLUMN. The mean longitude rate is degrees per
    // Julian century, so 360 / rate * 36525 is the orbital period in days. This
    // catches a transposed digit in a column that Kepler III cannot check,
    // because Kepler III only involves the semi-major axis.
    //
    // Measured worst case is Neptune at 6.6e-4 relative. The residual is real:
    // the fitted mean-longitude rate absorbs perturbations that the published
    // sidereal period does not.
    const TOLERANCE = 1e-3;

    for (const id of PLANET_IDS) {
      const body = getBody(id);
      if (body.siderealOrbitalPeriodYears === undefined) continue;

      const row = ELEMENT_ROW_FOR_BODY[id]!;
      const rate = getElementRecord(ELEMENTS_TABLE_1, row).rates.L;
      const derivedDays = (360 / rate) * JULIAN_CENTURY_DAYS;
      const publishedDays = yearsToDays(body.siderealOrbitalPeriodYears.value);

      const relative = Math.abs(derivedDays - publishedDays) / publishedDays;
      expect(
        relative,
        `${id}: L-rate implies ${derivedDays.toFixed(3)} d vs published ${publishedDays.toFixed(3)} d`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  it('recovers the published orbital period from the semi-major axis', () => {
    // INDEPENDENT CHECK ON THE a COLUMN, via Kepler III with the heliocentric GM.
    // Measured worst case is Neptune at 6.3e-4. The residual is expected: the
    // two-body law omits planetary perturbations, which matter most for the
    // outer planets.
    const TOLERANCE = 1e-3;

    for (const id of PLANET_IDS) {
      const body = getBody(id);
      if (body.siderealOrbitalPeriodYears === undefined) continue;

      const row = ELEMENT_ROW_FOR_BODY[id]!;
      const a = getElementRecord(ELEMENTS_TABLE_1, row).elements.a;
      const derivedDays = twoBodyPeriodDays(a);
      const publishedDays = yearsToDays(body.siderealOrbitalPeriodYears.value);

      const relative = Math.abs(derivedDays - publishedDays) / publishedDays;
      expect(
        relative,
        `${id}: a=${a} au implies ${derivedDays.toFixed(3)} d vs published ${publishedDays.toFixed(3)} d`,
      ).toBeLessThan(TOLERANCE);
    }
  });

  it('keeps every eccentricity a bound ellipse', () => {
    // Range guard against a misplaced decimal. All planetary eccentricities are
    // well below 0.25; anything at or above 1 would not be an orbit at all.
    for (const table of [ELEMENTS_TABLE_1, ELEMENTS_TABLE_2A]) {
      for (const record of table.bodies) {
        expect(record.elements.e, `${table.id}/${record.id} eccentricity`).toBeGreaterThanOrEqual(0);
        expect(record.elements.e, `${table.id}/${record.id} eccentricity`).toBeLessThan(0.25);
      }
    }
  });

  it('orders the semi-major axes outward from the Sun', () => {
    // Contract section 9 requires relative orbital ordering to be preserved. If
    // two rows were swapped during transcription, this fails.
    for (const table of [ELEMENTS_TABLE_1, ELEMENTS_TABLE_2A]) {
      const axes = table.bodies.map((body) => body.elements.a);
      for (let i = 1; i < axes.length; i++) {
        expect(axes[i]!, `${table.id}: row ${i} is not outside row ${i - 1}`).toBeGreaterThan(
          axes[i - 1]!,
        );
      }
    }
  });

  it('keeps inclinations small and finite for every major planet', () => {
    for (const table of [ELEMENTS_TABLE_1, ELEMENTS_TABLE_2A]) {
      for (const record of table.bodies) {
        expect(Math.abs(record.elements.I), `${table.id}/${record.id} inclination`).toBeLessThan(8);
      }
    }
  });

  it('keeps all element values and rates finite', () => {
    for (const table of [ELEMENTS_TABLE_1, ELEMENTS_TABLE_2A]) {
      for (const record of table.bodies) {
        for (const [key, value] of Object.entries(record.elements)) {
          expect(Number.isFinite(value), `${table.id}/${record.id}.${key}`).toBe(true);
        }
        for (const [key, value] of Object.entries(record.rates)) {
          expect(Number.isFinite(value), `${table.id}/${record.id}.rate.${key}`).toBe(true);
        }
      }
    }
  });

  it('broadly agrees between the two independent element fits', () => {
    // Table 1 and Table 2a are separate fits over different intervals, so they
    // differ. Semi-major axes should nonetheless agree to a small fraction of a
    // percent; a larger gap would indicate a transcription error in one table.
    for (const record of ELEMENTS_TABLE_1.bodies) {
      const wide = getElementRecord(ELEMENTS_TABLE_2A, record.id);
      const relative = Math.abs(wide.elements.a - record.elements.a) / record.elements.a;
      expect(relative, `${record.id}: the two fits disagree on a`).toBeLessThan(1e-3);
    }
  });
});

describe('augmentation terms', () => {
  it('attaches the mandatory Table 2b terms to the outer planets of Table 2a', () => {
    // The source states the mean anomaly "*must* be augmented" for these bodies.
    for (const id of ['jupiter', 'saturn', 'uranus', 'neptune']) {
      const record = getElementRecord(ELEMENTS_TABLE_2A, id);
      expect(record.augmentation, `${id} is missing its Table 2b terms`).toBeDefined();
      expect(Number.isFinite(record.augmentation!.b)).toBe(true);
      expect(record.augmentation!.f).toBeGreaterThan(0);
    }
    expect(ELEMENTS_TABLE_2A.requiresAugmentation).toBe(true);
  });

  it('shares one frequency between Jupiter and Saturn, and another between Uranus and Neptune', () => {
    // The published f values pair up. A mismatched pair would indicate a row
    // misalignment in the Table 2b transcription.
    expect(getElementRecord(ELEMENTS_TABLE_2A, 'jupiter').augmentation!.f).toBeCloseTo(
      getElementRecord(ELEMENTS_TABLE_2A, 'saturn').augmentation!.f,
      8,
    );
    expect(getElementRecord(ELEMENTS_TABLE_2A, 'uranus').augmentation!.f).toBeCloseTo(
      getElementRecord(ELEMENTS_TABLE_2A, 'neptune').augmentation!.f,
      8,
    );
  });

  it('leaves the inner planets of Table 2a unaugmented', () => {
    for (const id of ['mercury', 'venus', 'embary', 'mars']) {
      expect(getElementRecord(ELEMENTS_TABLE_2A, id).augmentation).toBeUndefined();
    }
  });

  it('publishes no augmentation terms for Table 1', () => {
    expect(ELEMENTS_TABLE_1.requiresAugmentation).toBe(false);
    for (const record of ELEMENTS_TABLE_1.bodies) {
      expect(record.augmentation, `${record.id} should have no terms in Table 1`).toBeUndefined();
    }
  });
});

describe('validity intervals', () => {
  it('matches the published interval of each table', () => {
    expect(ELEMENTS_TABLE_1.validity.startYear).toBe(1800);
    expect(ELEMENTS_TABLE_1.validity.endYear).toBe(2050);
    expect(ELEMENTS_TABLE_2A.validity.startYear).toBe(-3000);
    expect(ELEMENTS_TABLE_2A.validity.endYear).toBe(3000);
  });

  it('accepts years inside the interval and rejects years outside it', () => {
    expect(isWithinValidity(ELEMENTS_TABLE_1, 2026)).toBe(true);
    expect(isWithinValidity(ELEMENTS_TABLE_1, 1800)).toBe(true);
    expect(isWithinValidity(ELEMENTS_TABLE_1, 2050)).toBe(true);
    expect(isWithinValidity(ELEMENTS_TABLE_1, 1799)).toBe(false);
    expect(isWithinValidity(ELEMENTS_TABLE_1, 2051)).toBe(false);
    // The wide table covers the year the narrow one rejects.
    expect(isWithinValidity(ELEMENTS_TABLE_2A, 1799)).toBe(true);
  });
});

describe('published accuracy figures', () => {
  it('covers every element row', () => {
    for (const record of ELEMENTS_TABLE_1.bodies) {
      expect(ELEMENT_ACCURACY[record.id], `${record.id} has no accuracy figures`).toBeDefined();
    }
  });

  it('keeps every figure positive', () => {
    for (const [id, accuracy] of Object.entries(ELEMENT_ACCURACY)) {
      expect(accuracy.longitudeArcsec, `${id} longitude`).toBeGreaterThan(0);
      expect(accuracy.latitudeArcsec, `${id} latitude`).toBeGreaterThan(0);
      expect(accuracy.distanceThousandKm, `${id} distance`).toBeGreaterThan(0);
    }
  });

  it('reports a distance error far below the orbital radius it applies to', () => {
    // Sanity: the model is approximate, but not so approximate as to be useless.
    // Saturn's 1.5 million km error against a 9.54 au orbit is about 0.1 percent.
    for (const record of ELEMENTS_TABLE_1.bodies) {
      const errorKm = ELEMENT_ACCURACY[record.id]!.distanceThousandKm * 1000;
      const orbitKm = record.elements.a * AU_KM;
      expect(errorKm / orbitKm, `${record.id} relative distance error`).toBeLessThan(0.01);
    }
  });
});

describe('body registry', () => {
  it('lists every body exactly once in the display order', () => {
    expect(new Set(BODY_ORDER).size).toBe(BODY_ORDER.length);
    expect(new Set(BODY_ORDER)).toEqual(new Set(Object.keys(BODIES)));
  });

  it('treats every planet id as a known body', () => {
    for (const id of PLANET_IDS) {
      expect(BODY_ORDER, `${id} missing from BODY_ORDER`).toContain(id);
      expect(() => getBody(id)).not.toThrow();
    }
  });

  it('maps every planet to an element row that exists', () => {
    for (const id of PLANET_IDS) {
      const row = ELEMENT_ROW_FOR_BODY[id];
      expect(row, `${id} has no element row mapping`).toBeDefined();
      expect(() => getElementRecord(ELEMENTS_TABLE_1, row!)).not.toThrow();
    }
  });

  it('resolves Earth to the Earth/Moon barycentre row and records the limitation', () => {
    // The element set publishes no Earth row, only the barycentre. Drawing Earth
    // there is a documented M1 limitation, not an oversight.
    expect(ELEMENT_ROW_FOR_BODY['earth']).toBe('embary');
    expect(EMBARY_LIMITATION.displayedAs).toBe('earth');
    expect(EMBARY_LIMITATION.maximumOffsetKm).toBeGreaterThan(0);
    // The offset is smaller than Earth's radius, which is why it is tolerable.
    expect(EMBARY_LIMITATION.maximumOffsetKm).toBeLessThan(getBody('earth').meanRadiusKm.value);
    expect(getBody('earth').note).toMatch(/barycentre|barycenter/i);
  });

  it('gives every body a parent except the Sun, forming a tree', () => {
    for (const id of BODY_ORDER) {
      const body = getBody(id);
      if (id === 'sun') {
        expect(body.parentId).toBeNull();
        continue;
      }
      expect(body.parentId, `${id} has no parent`).not.toBeNull();
      expect(BODY_ORDER, `${id} parent "${body.parentId}" is unknown`).toContain(body.parentId!);
    }
  });

  it('roots every parent chain at the Sun without cycles', () => {
    // The hierarchical render transform walks these chains, so a cycle would
    // hang it rather than merely look wrong.
    for (const id of BODY_ORDER) {
      const seen = new Set<string>();
      let current: string | null = id;
      while (current !== null) {
        expect(seen.has(current), `cycle in parent chain at ${current}`).toBe(false);
        seen.add(current);
        current = getBody(current).parentId;
      }
      expect(seen.has('sun'), `${id} chain does not reach the Sun`).toBe(true);
    }
  });

  it('makes the Moon a child of Earth rather than of the Sun', () => {
    // Required by the hierarchical scale transform: a satellite offset must be
    // scaled relative to its primary, not as an absolute heliocentric vector.
    expect(getBody('moon').parentId).toBe('earth');
  });
});

describe('lookup failures', () => {
  it('names the available ids when a body is unknown', () => {
    expect(() => getBody('pluto')).toThrow(/available:/);
    expect(() => getBody('pluto')).toThrow(/mercury/);
  });

  it('names the available ids when a rotation record is unknown', () => {
    expect(() => getRotationRecord('titan')).toThrow(/available:/);
  });

  it('names the table when an element row is unknown', () => {
    expect(() => getElementRecord(ELEMENTS_TABLE_1, 'pluto')).toThrow(/table1/);
    expect(() => getElementRecord(ELEMENTS_TABLE_1, 'pluto')).toThrow(/available:/);
  });
});

describe('no render state in the data layer', () => {
  it('exposes no visual or presentation fields on any body', () => {
    // Contract sections 2 and 39: physical data must not carry visual
    // exaggeration, colour, or texture references. Those belong to sim/scale.ts
    // and the render layer. This guards the boundary against future drift.
    const FORBIDDEN = [
      'visualRadius',
      'visualRadiusMultiplier',
      'color',
      'colour',
      'texture',
      'material',
      'renderScale',
      'exaggeration',
    ];

    for (const id of BODY_ORDER) {
      const keys = Object.keys(getBody(id)).map((key) => key.toLowerCase());
      for (const forbidden of FORBIDDEN) {
        expect(keys, `${id} carries render state "${forbidden}"`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
    }
  });
});
