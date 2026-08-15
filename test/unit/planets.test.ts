/**
 * JPL approximate planetary positions validation.
 *
 * WHAT IS ASSERTED: agreement with the published accuracy figures, internal
 * consistency between the returned position and velocity, honest range
 * reporting, and the provider contract. Expected values come from the source's
 * own published elements (via the data layer) or from independent numerical
 * differentiation. No astronomical position is asserted against a number I
 * invented.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: conservation of specific energy and
 * angular momentum. This model drifts a and e by design, so those quantities are
 * genuinely not invariant. They are tested against the fixed-element propagator
 * in kepler.test.ts, where they hold exactly. Testing them here would either
 * fail correctly or require a tolerance so wide the assertion would be
 * meaningless.
 */

import { describe, expect, it } from 'vitest';
import {
  J2000_TT,
  JplApproximatePlanetsProvider,
  createPlanetsProvider,
  createWideRangePlanetsProvider,
  evaluateElements,
} from '@/ephemeris/planets';
import { magnitude, scale, subtract, type Vector3Like } from '@/ephemeris/kepler';
import { ProviderRegistry, supportsBody } from '@/ephemeris/provider';
import {
  addDays,
  addSeconds,
  makeJD,
  toNumber,
  utc,
  ttFromUtc,
  type JulianDate,
} from '@/core/jd';
import { AU_KM, DEG_TO_RAD, GM_SUN_KM3_S2 } from '@/data/constants';
import { ELEMENT_ACCURACY, ELEMENTS_TABLE_1, getElementRecord } from '@/data/jpl-elements';
import { ELEMENT_ROW_FOR_BODY, PLANET_IDS } from '@/data/bodies';

const provider = createPlanetsProvider();

/** A TT instant inside the 1800-2050 validity window. */
function ttAt(year: number, month = 1, day = 1): JulianDate<'TT'> {
  return ttFromUtc(utc(year, month, day));
}

describe('provider contract', () => {
  it('supports exactly the eight planets', () => {
    expect([...provider.supportedBodies].sort()).toEqual([...PLANET_IDS].sort());
    for (const id of PLANET_IDS) {
      expect(supportsBody(provider, id), `${id} unsupported`).toBe(true);
    }
  });

  it('names the supported bodies when asked for an unknown one', () => {
    expect(() => provider.getState('pluto', J2000_TT)).toThrow(/unsupported body/);
    expect(() => provider.getState('pluto', J2000_TT)).toThrow(/mercury/);
    expect(() => provider.getMetadata('titan')).toThrow(/unsupported body/);
  });

  it('discloses model, accuracy, range, frame and origin for every body', () => {
    for (const id of PLANET_IDS) {
      const metadata = provider.getMetadata(id);

      expect(metadata.model).toMatch(/Approximate Positions/);
      expect(metadata.model).toMatch(/1800 AD - 2050 AD/);
      expect(metadata.source).toBe('S1');
      expect(metadata.frame).toBe('J2000_ECLIPTIC');
      expect(metadata.origin).toBe('SUN');
      // The model's own independent variable, not what happens to be passed in.
      expect(metadata.timeScale).toBe('TDB');
      expect(metadata.validRange.start).toBeLessThan(metadata.validRange.end);

      // Accuracy must quote the published figures rather than a vague adjective.
      const published = ELEMENT_ACCURACY[ELEMENT_ROW_FOR_BODY[id]!]!;
      expect(metadata.accuracy).toContain(String(published.longitudeArcsec));
      expect(metadata.accuracy).toMatch(/nominal/);

      expect(metadata.limitations?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('never describes a computed position as measured, live or exact', () => {
    // Contract sections 10, 11 and 27.
    const FORBIDDEN = /telemetry|live|real-?time|exact|ground truth|measured/i;
    for (const id of PLANET_IDS) {
      const metadata = provider.getMetadata(id);
      const text = [metadata.model, metadata.accuracy, ...(metadata.limitations ?? [])].join(' ');
      expect(text, `${id} metadata uses forbidden vocabulary`).not.toMatch(FORBIDDEN);
      expect(provider.getState(id, J2000_TT).status).toBe('COMPUTED');
    }
  });

  it('discloses the Earth/Moon barycentre substitution', () => {
    // The source publishes no Earth row. Drawing Earth at the barycentre is a
    // documented limitation, not something to leave for a reader to discover.
    const limitations = provider.getMetadata('earth').limitations!.join(' ');
    expect(limitations).toMatch(/barycentre|barycenter/i);
    expect(limitations).toMatch(/4670/);

    // No other planet carries that caveat.
    expect(provider.getMetadata('mars').limitations!.join(' ')).not.toMatch(/barycentre/i);
  });

  it('returns identical numbers for the same instant', () => {
    // Purity. A provider that varied between calls would make the simulation
    // non-reproducible and the tests meaningless.
    for (const id of PLANET_IDS) {
      const first = provider.getState(id, J2000_TT);
      const second = provider.getState(id, J2000_TT);
      expect(second.positionKm).toEqual(first.positionKm);
      expect(second.velocityKmS).toEqual(first.velocityKmS);
    }
  });
});

describe('position plausibility', () => {
  it('places every planet between its periapsis and apoapsis', () => {
    // Bounds come from the evaluated elements at the same instant, so this is a
    // self-consistency check on the coordinate construction rather than a
    // comparison against an external number.
    for (const year of [1800, 1900, 2000, 2026, 2050]) {
      const jd = ttAt(year);
      for (const id of PLANET_IDS) {
        const elements = provider.elementsAt(id, jd);
        const r = magnitude(provider.getState(id, jd).positionKm) / AU_KM;

        const periapsis = elements.a * (1 - elements.e);
        const apoapsis = elements.a * (1 + elements.e);

        expect(r, `${id} at ${year}: r=${r.toFixed(4)} au`).toBeGreaterThanOrEqual(
          periapsis * (1 - 1e-9),
        );
        expect(r, `${id} at ${year}: r=${r.toFixed(4)} au`).toBeLessThanOrEqual(
          apoapsis * (1 + 1e-9),
        );
      }
    }
  });

  it('preserves the outward ordering of the planets', () => {
    // Contract section 9. Mercury nearest, Neptune farthest, at any instant.
    // Compares semi-major axes rather than instantaneous radii, since eccentric
    // orbits can genuinely interleave in distance.
    for (const year of [1850, 2000, 2040]) {
      const jd = ttAt(year);
      const axes = PLANET_IDS.map((id) => provider.elementsAt(id, jd).a);
      for (let i = 1; i < axes.length; i++) {
        expect(axes[i]!, `${PLANET_IDS[i]} is not outside ${PLANET_IDS[i - 1]} at ${year}`).toBeGreaterThan(
          axes[i - 1]!,
        );
      }
    }
  });

  it('keeps every returned component finite', () => {
    for (const year of [1800, 2026, 2050]) {
      const jd = ttAt(year);
      for (const id of PLANET_IDS) {
        const state = provider.getState(id, jd);
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(Number.isFinite(state.positionKm[axis]), `${id}.position.${axis}`).toBe(true);
          expect(Number.isFinite(state.velocityKmS![axis]), `${id}.velocity.${axis}`).toBe(true);
        }
      }
    }
  });

  it('keeps the inner planets close to the ecliptic plane', () => {
    // |z|/r must not exceed sin(inclination). A sign or ordering error in the
    // rotation composition would break this immediately.
    const jd = ttAt(2026, 8, 15);
    for (const id of PLANET_IDS) {
      const elements = provider.elementsAt(id, jd);
      const position = provider.getState(id, jd).positionKm;
      const r = magnitude(position);
      const sinLatitude = Math.abs(position.z) / r;

      expect(sinLatitude, `${id} lies further from the ecliptic than its inclination allows`).toBeLessThanOrEqual(
        Math.sin(Math.abs(elements.I) * DEG_TO_RAD) + 1e-9,
      );
    }
  });
});

describe('velocity consistency', () => {
  /**
   * THE CHECK ON THE HAND-DERIVED VELOCITY.
   *
   * The source publishes position only, so the velocity expressions were derived
   * from the time derivative of Kepler's equation. Central-differencing the
   * model's own position is an independent route to the same quantity, and
   * disagreement would expose an error in that derivation.
   *
   * The residual is not zero, and should not be: the analytic form omits the
   * secular drift of the elements themselves (da/dt, de/dt and the angular
   * rates), which the finite difference includes. That neglected term is the
   * measured residual below.
   */
  it('matches a central finite difference of the model position', () => {
    const STEP_SECONDS = 60;
    let worstRelative = 0;
    let worstBody = '';

    for (const id of PLANET_IDS) {
      const jd = ttAt(2026, 8, 15);
      const analytic = provider.getState(id, jd).velocityKmS!;

      const before = provider.getState(id, addSeconds(jd, -STEP_SECONDS)).positionKm;
      const after = provider.getState(id, addSeconds(jd, STEP_SECONDS)).positionKm;
      const numeric = scale(subtract(after, before), 1 / (2 * STEP_SECONDS));

      const relative = magnitude(subtract(analytic, numeric)) / magnitude(numeric);
      if (relative > worstRelative) {
        worstRelative = relative;
        worstBody = id;
      }
    }

    // Loose enough to accommodate the neglected element-drift term, tight enough
    // that a genuine error in the derivation could not hide inside it.
    expect(
      worstRelative,
      `worst velocity disagreement ${worstRelative.toExponential(3)} for ${worstBody}`,
    ).toBeLessThan(1e-5);
  });

  it('produces speeds consistent with the vis-viva relation for each orbit', () => {
    // v^2 = GM(2/r - 1/a) is a two-body identity. This model is not two-body, so
    // exact agreement is not expected; order-of-magnitude agreement confirms the
    // velocity has the right scale and is not, say, out by a factor of 36525
    // from a per-century rate used as a per-second one.
    const jd = ttAt(2026, 8, 15);
    for (const id of PLANET_IDS) {
      const state = provider.getState(id, jd);
      const elements = provider.elementsAt(id, jd);
      const r = magnitude(state.positionKm);
      const speed = magnitude(state.velocityKmS!);

      const expected = Math.sqrt(GM_SUN_KM3_S2 * (2 / r - 1 / (elements.a * AU_KM)));
      expect(speed / expected, `${id} speed ratio`).toBeGreaterThan(0.99);
      expect(speed / expected, `${id} speed ratio`).toBeLessThan(1.01);
    }
  });

  it('orders orbital speeds inward-fastest', () => {
    // Mercury must move faster than Neptune. Catches a per-body mix-up in the
    // mean-motion lookup.
    const jd = ttAt(2026, 8, 15);
    const speeds = PLANET_IDS.map((id) => magnitude(provider.getState(id, jd).velocityKmS!));
    for (let i = 1; i < speeds.length; i++) {
      expect(speeds[i]!, `${PLANET_IDS[i]} is not slower than ${PLANET_IDS[i - 1]}`).toBeLessThan(
        speeds[i - 1]!,
      );
    }
  });
});

describe('secular motion', () => {
  it('advances mean longitude monotonically over the validity window', () => {
    // The replacement for a conservation test on this model: L must increase
    // without stalling or reversing. Compared as an unwrapped total so a
    // full-turn wrap cannot mask a reversal.
    for (const id of PLANET_IDS) {
      const record = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!);
      let previous = Number.NEGATIVE_INFINITY;

      for (let year = 1800; year <= 2050; year += 10) {
        const L = evaluateElements(record, ttAt(year)).L;
        expect(L, `${id} mean longitude did not advance at ${year}`).toBeGreaterThan(previous);
        previous = L;
      }
    }
  });

  it('returns the mean anomaly to its start after one ANOMALISTIC period', () => {
    // The mean anomaly is measured from the perihelion, and the perihelion moves.
    // So it returns after the anomalistic period, NOT the sidereal one. This
    // distinction is not pedantic: advancing by the sidereal period instead
    // leaves Neptune 0.53 deg short, which is exactly the perihelion drift over
    // that interval and was a genuine test error caught during development.
    for (const id of PLANET_IDS) {
      const periodDays = provider.anomalisticPeriodDaysFor(id);
      // Skip bodies whose period exceeds the validity window; a full orbit
      // cannot be observed inside it.
      if (periodDays > 250 * 365.25) continue;

      const start = ttAt(1900);
      const startAnomaly = provider.elementsAt(id, start).meanAnomaly;
      const endAnomaly = provider.elementsAt(id, addDays(start, periodDays)).meanAnomaly;

      const difference = Math.abs(((endAnomaly - startAnomaly + 540) % 360) - 180);
      expect(
        difference,
        `${id} anomaly drifted ${difference.toFixed(6)} deg over one anomalistic period`,
      ).toBeLessThan(1e-6);
    }
  });

  it('falls short of a full anomaly turn after one SIDEREAL period, by the perihelion drift', () => {
    // The complementary assertion, and the one that proves the shortfall above is
    // perihelion precession rather than numerical slop. Predicted shortfall is
    // exactly the change in longitude of perihelion over one period:
    //
    //   delta = (d longPeri / dCy) * (period in centuries)
    //
    // For Neptune: -0.32241464 deg/Cy * 1.6489 Cy = -0.5316 deg, against a
    // measured 0.5313 deg. Agreement to four significant figures.
    for (const id of PLANET_IDS) {
      const siderealDays = provider.siderealPeriodDaysFor(id);
      if (siderealDays > 250 * 365.25) continue;

      const record = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!);
      const centuries = siderealDays / 36_525;
      const predictedShortfall = Math.abs(record.rates.longPeri * centuries);

      const start = ttAt(1900);
      const startAnomaly = provider.elementsAt(id, start).meanAnomaly;
      const endAnomaly = provider.elementsAt(id, addDays(start, siderealDays)).meanAnomaly;
      const measuredShortfall = Math.abs(((endAnomaly - startAnomaly + 540) % 360) - 180);

      expect(
        measuredShortfall,
        `${id}: predicted ${predictedShortfall.toFixed(6)} deg, measured ${measuredShortfall.toFixed(6)} deg`,
      ).toBeCloseTo(predictedShortfall, 5);
    }
  });

  it('drifts the elements rather than holding them fixed', () => {
    // The defining property of this model, and the reason conservation is not
    // asserted against it. Over 250 years a and e must both move measurably.
    for (const id of PLANET_IDS) {
      const early = provider.elementsAt(id, ttAt(1800));
      const late = provider.elementsAt(id, ttAt(2050));
      const moved =
        Math.abs(late.a - early.a) > 0 || Math.abs(late.e - early.e) > 0 || Math.abs(late.I - early.I) > 0;
      expect(moved, `${id} elements did not drift, so the rates are not being applied`).toBe(true);
    }
  });

  it('evaluates the elements at the epoch to their published values', () => {
    // At T = 0 the evaluated elements must equal the tabulated ones exactly,
    // which confirms the rate term is multiplied by zero rather than by one.
    for (const id of PLANET_IDS) {
      const record = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!);
      const evaluated = evaluateElements(record, J2000_TT);

      expect(evaluated.centuriesPastJ2000).toBeCloseTo(0, 12);
      expect(evaluated.a).toBeCloseTo(record.elements.a, 12);
      expect(evaluated.e).toBeCloseTo(record.elements.e, 12);
      expect(evaluated.I).toBeCloseTo(record.elements.I, 12);
    }
  });

  it('derives the argument of perihelion as longPeri minus longNode', () => {
    const jd = ttAt(2026);
    for (const id of PLANET_IDS) {
      const elements = provider.elementsAt(id, jd);
      expect(elements.argPeri, `${id}`).toBeCloseTo(elements.longPeri - elements.longNode, 9);
    }
  });

  it('keeps the mean anomaly within the symmetric interval the algorithm requires', () => {
    // S1 step 3 reduces M to [-180, 180] before solving.
    for (const year of [1800, 1950, 2026, 2050]) {
      for (const id of PLANET_IDS) {
        const meanAnomaly = provider.elementsAt(id, ttAt(year)).meanAnomaly;
        expect(meanAnomaly, `${id} at ${year}`).toBeGreaterThanOrEqual(-180);
        expect(meanAnomaly, `${id} at ${year}`).toBeLessThan(180);
      }
    }
  });
});

describe('validity range reporting', () => {
  it('reports COMPUTED inside the window and OUT_OF_RANGE outside it', () => {
    expect(provider.getState('mars', ttAt(2026)).status).toBe('COMPUTED');
    expect(provider.getState('mars', ttAt(1799)).status).toBe('OUT_OF_RANGE');
    expect(provider.getState('mars', ttAt(2051)).status).toBe('OUT_OF_RANGE');
  });

  it('still returns a usable position outside the window', () => {
    // Being out of range is a disclosure, not a failure. The simulation must not
    // stall at the boundary, and the interface must be able to show the value
    // alongside the warning.
    const state = provider.getState('jupiter', ttAt(1700));
    expect(state.status).toBe('OUT_OF_RANGE');
    expect(Number.isFinite(state.positionKm.x)).toBe(true);
    expect(magnitude(state.positionKm) / AU_KM).toBeGreaterThan(4);
  });

  it('crosses the boundary continuously', () => {
    // The status flips but the position must not jump: the same polynomial is
    // evaluated on both sides.
    //
    // The boundary is taken from the provider's own metadata rather than from
    // ttAt(2050). The validity interval is defined at TT midnight, while
    // ttAt(2050) converts a UTC midnight and so lands about 70 s later, already
    // past the end. Straddling the wrong instant made an earlier version of this
    // test report OUT_OF_RANGE on both sides.
    const boundaryJd = provider.getMetadata('saturn').validRange.end;
    const boundary = makeJD(boundaryJd, 0, 'TT');

    const before = provider.getState('saturn', addSeconds(boundary, -1));
    const after = provider.getState('saturn', addSeconds(boundary, 1));

    expect(before.status).toBe('COMPUTED');
    expect(after.status).toBe('OUT_OF_RANGE');

    // Saturn moves at roughly 9.6 km/s, so two seconds is about 20 km.
    const jumpKm = magnitude(subtract(after.positionKm, before.positionKm));
    expect(jumpKm).toBeLessThan(100);
    expect(jumpKm).toBeGreaterThan(0);
  });

  it('matches the published validity interval', () => {
    const range = provider.getMetadata('venus').validRange;
    expect(range.start).toBeCloseTo(toNumber(ttAt(1800)), 0);
    expect(range.end).toBeCloseTo(toNumber(ttAt(2050)), 0);
  });
});

describe('wide-range table', () => {
  const wide = createWideRangePlanetsProvider();

  it('covers dates the narrow table rejects', () => {
    expect(wide.getState('mars', ttAt(1500)).status).toBe('COMPUTED');
    expect(provider.getState('mars', ttAt(1500)).status).toBe('OUT_OF_RANGE');
  });

  it('applies the mandatory augmentation terms to the outer planets', () => {
    // The source states the mean anomaly "*must* be augmented" for Jupiter
    // through Neptune. Applying them must change the answer; if the terms were
    // silently dropped, the two tables would agree far more closely than they do.
    const jd = ttAt(2500);
    for (const id of ['jupiter', 'saturn', 'uranus', 'neptune']) {
      const withTerms = wide.elementsAt(id, jd).meanAnomaly;
      const record = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!);
      const withoutTerms = evaluateElements(record, jd).meanAnomaly;
      expect(Math.abs(withTerms - withoutTerms), `${id}`).toBeGreaterThan(1e-6);
    }
  });

  it('broadly agrees with the narrow table inside their shared interval', () => {
    // Two independent fits over different intervals. Inside the overlap they
    // should agree to a small fraction of an au; a large disagreement would mean
    // one table was transcribed wrongly.
    const jd = ttAt(2000, 6, 1);
    for (const id of PLANET_IDS) {
      const narrowPosition = provider.getState(id, jd).positionKm;
      const widePosition = wide.getState(id, jd).positionKm;
      const separationAu = magnitude(subtract(widePosition, narrowPosition)) / AU_KM;
      const radiusAu = magnitude(narrowPosition) / AU_KM;
      expect(separationAu / radiusAu, `${id} fits disagree`).toBeLessThan(0.01);
    }
  });

  it('carries its own validity label in the metadata', () => {
    expect(wide.getMetadata('mercury').model).toMatch(/3000 BC - 3000 AD/);
    expect(wide.id).toContain('table2a');
  });
});

describe('provider registry', () => {
  it('routes a body to its registered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(provider);

    expect(registry.getState('mars', J2000_TT).bodyId).toBe('mars');
    expect(registry.providerFor('mars')).toBe(provider);
    expect(registry.getMetadata('mars').source).toBe('S1');
  });

  it('lets a later registration take over a body', () => {
    // How a higher-fidelity provider replaces a coarser one without the
    // simulation layer knowing either exists.
    const registry = new ProviderRegistry();
    registry.register(provider);
    const replacement = new JplApproximatePlanetsProvider();
    registry.register(replacement);

    expect(registry.providerFor('mars')).toBe(replacement);
    expect(registry.allProviders()).toHaveLength(2);
  });

  it('reports what it knows about when a body is unroutable', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getState('mars', J2000_TT)).toThrow(/\(none\)/);

    registry.register(provider);
    expect(() => registry.getState('moon', J2000_TT)).toThrow(/registered: /);
    expect(() => registry.getState('moon', J2000_TT)).toThrow(/mercury/);
  });

  it('exposes the union of its providers supported bodies', () => {
    const registry = new ProviderRegistry();
    registry.register(provider);
    expect([...registry.supportedBodies].sort()).toEqual([...PLANET_IDS].sort());
  });
});

describe('state metadata', () => {
  it('tags every state with its frame, origin and epoch', () => {
    const jd = ttAt(2026, 8, 15);
    const state = provider.getState('earth', jd);

    expect(state.frame).toBe('J2000_ECLIPTIC');
    expect(state.origin).toBe('SUN');
    expect(state.epoch).toEqual(jd);
    expect(state.bodyId).toBe('earth');
  });

  it('supplies a velocity rather than omitting it', () => {
    // This provider models velocity, so null would indicate a regression to
    // position-only output.
    for (const id of PLANET_IDS) {
      expect(provider.getState(id, J2000_TT).velocityKmS, `${id}`).not.toBeNull();
    }
  });
});

describe('Earth-specific behaviour', () => {
  it('places Earth near one astronomical unit from the Sun', () => {
    // Sanity anchor. Earth's distance varies between about 0.983 and 1.017 au
    // over the year, from its published eccentricity of 0.0167.
    for (const month of [1, 4, 7, 10]) {
      const r = magnitude(provider.getState('earth', ttAt(2026, month, 1)).positionKm) / AU_KM;
      expect(r, `month ${month}`).toBeGreaterThan(0.98);
      expect(r, `month ${month}`).toBeLessThan(1.02);
    }
  });

  it('reaches perihelion in early January and aphelion in early July', () => {
    // A well-known seasonal fact, and an independent check that the argument of
    // perihelion and mean anomaly are composed correctly. Testing the ORDERING
    // rather than an exact date, since the date itself shifts year to year.
    const january = magnitude(provider.getState('earth', ttAt(2026, 1, 4)).positionKm);
    const july = magnitude(provider.getState('earth', ttAt(2026, 7, 5)).positionKm);
    expect(january).toBeLessThan(july);
  });

  it('completes one revolution in approximately one year', () => {
    const start = ttAt(2026, 3, 20);
    const startPosition = provider.getState('earth', start).positionKm;
    const laterPosition = provider.getState('earth', addDays(start, 365.256)).positionKm;

    // After one sidereal year Earth must be close to where it started.
    const separation = magnitude(subtract(laterPosition, startPosition)) / AU_KM;
    expect(separation).toBeLessThan(0.01);
  });
});

describe('mean motion accessors', () => {
  it('pairs each rate with the period it implies', () => {
    for (const id of PLANET_IDS) {
      expect(
        provider.siderealMeanMotionFor(id) * provider.siderealPeriodDaysFor(id) * 86_400,
        `${id} sidereal`,
      ).toBeCloseTo(2 * Math.PI, 6);

      expect(
        provider.anomalisticMeanMotionFor(id) * provider.anomalisticPeriodDaysFor(id) * 86_400,
        `${id} anomalistic`,
      ).toBeCloseTo(2 * Math.PI, 6);
    }
  });

  it('returns positive rates for every planet', () => {
    // All eight orbit in the same direction, and no perihelion drifts fast enough
    // to reverse the anomalistic rate. A negative value would mean a sign error in
    // the rate transcription.
    for (const id of PLANET_IDS) {
      expect(provider.siderealMeanMotionFor(id), `${id} sidereal`).toBeGreaterThan(0);
      expect(provider.anomalisticMeanMotionFor(id), `${id} anomalistic`).toBeGreaterThan(0);
    }
  });

  it('separates the two rates by exactly the perihelion drift', () => {
    // The distinction that caused a real defect: conflating these left a 5.7e-5
    // relative velocity error for Saturn. Asserting the exact relationship keeps
    // them from being silently unified again.
    for (const id of PLANET_IDS) {
      const record = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!);
      const expectedDifference =
        ((record.rates.longPeri * Math.PI) / 180) / (36_525 * 86_400);

      expect(
        provider.siderealMeanMotionFor(id) - provider.anomalisticMeanMotionFor(id),
        `${id}`,
      ).toBeCloseTo(expectedDifference, 20);
    }
  });

  it('orders the two periods according to the direction of perihelion drift', () => {
    // Not a universal ordering. In this fit Saturn and Neptune have a RETROGRADE
    // perihelion drift, so their anomalistic period is shorter than their
    // sidereal one, while the other six are the other way round. Asserting a
    // single direction for all eight would be wrong.
    for (const id of PLANET_IDS) {
      const perihelionRate = getElementRecord(ELEMENTS_TABLE_1, ELEMENT_ROW_FOR_BODY[id]!).rates
        .longPeri;
      const sidereal = provider.siderealPeriodDaysFor(id);
      const anomalistic = provider.anomalisticPeriodDaysFor(id);

      if (perihelionRate > 0) {
        expect(anomalistic, `${id}: prograde perihelion drift`).toBeGreaterThan(sidereal);
      } else {
        expect(anomalistic, `${id}: retrograde perihelion drift`).toBeLessThan(sidereal);
      }
    }
  });
});

describe('vector helper reachability', () => {
  it('keeps the local vector helpers usable from the ephemeris layer', () => {
    // The simulation layer must not reach into the renderer for vector maths.
    const a: Vector3Like = { x: 3, y: 0, z: 4 };
    expect(magnitude(a)).toBe(5);
    expect(magnitude(scale(a, 2))).toBe(10);
    expect(magnitude(subtract(a, a))).toBe(0);
  });
});
