/**
 * Astrodynamic constants.
 *
 * SOURCE S3: https://ssd.jpl.nasa.gov/astro_par.html (JPL SSD)
 * SOURCE S5: IAU 2015 Resolution B3 (nominal solar conversion constants)
 * See src/data/sources.md.
 *
 * DEFINED versus MEASURED: some values here are exact by definition and some
 * carry measurement uncertainty. The distinction matters, because a test may
 * assert a defined constant exactly but must allow tolerance on a measured one.
 * Each entry states which it is.
 *
 * SI base units throughout (metres, kilograms, seconds). The simulation layer
 * works in kilometres and km/s, so conversions are explicit at the boundary
 * rather than implied by ambiguous names.
 */

/** Astronomical unit, metres. EXACT by IAU 2012 Resolution B1. */
export const AU_M = 149_597_870_700;

/** Astronomical unit, kilometres. EXACT, derived from AU_M. */
export const AU_KM = AU_M / 1000;

/** Speed of light in vacuum, m/s. EXACT by SI definition. */
export const SPEED_OF_LIGHT_M_S = 299_792_458;

/**
 * Newtonian constant of gravitation, m^3 kg^-1 s^-2.
 * MEASURED. 2018 CODATA recommended value, 6.67430e-11 +/- 0.00015e-11.
 *
 * Relative uncertainty is about 2.2e-5, the largest of any constant here. Any
 * mass derived from a GM via this constant inherits that uncertainty, which is
 * why GM is preferred wherever a computation permits it.
 */
export const GRAVITATIONAL_CONSTANT = 6.674_30e-11;

/** Uncertainty in G, same units. */
export const GRAVITATIONAL_CONSTANT_UNCERTAINTY = 0.000_15e-11;

/**
 * Heliocentric gravitational constant GM_sun, m^3 s^-2.
 * MEASURED. JPL DE440 (Park et al. 2021).
 *
 * Determined far more precisely than either G or the solar mass separately, so
 * orbital dynamics should use this directly rather than G times a mass.
 */
export const GM_SUN_M3_S2 = 1.327_124_400_412_794_19e20;

/** GM_sun in km^3/s^2, the unit the simulation layer uses. */
export const GM_SUN_KM3_S2 = GM_SUN_M3_S2 / 1e9;

/**
 * Obliquity of the ecliptic at J2000, arcseconds.
 * MEASURED, 84381.412 +/- 0.005.
 *
 * NOT the value used by the JPL approximate-position formulae, which specify
 * 23.43928 deg (84381.408 arcsec). See J2000_OBLIQUITY_DEG in jpl-elements.ts
 * for why the source's own coarser value is used inside that algorithm.
 */
export const J2000_OBLIQUITY_ARCSEC = 84_381.412;

/** Obliquity at J2000, degrees. Derived from the arcsecond value. */
export const J2000_OBLIQUITY_DEG = J2000_OBLIQUITY_ARCSEC / 3600;

/** Julian year, days. EXACT by definition. */
export const JULIAN_YEAR_DAYS = 365.25;

/** Julian century, days. EXACT by definition. */
export const JULIAN_CENTURY_DAYS = 36_525;

/** Mean sidereal day, seconds. MEASURED. */
export const MEAN_SIDEREAL_DAY_S = 86_164.090_54;

/** Sidereal year in the quasar reference frame, days. MEASURED. */
export const SIDEREAL_YEAR_DAYS = 365.256_36;

/**
 * Nominal solar luminosity, watts. DEFINED by IAU 2015 Resolution B3.
 *
 * A conversion constant for consistent reporting, not a measurement of a
 * variable star. The Sun's actual output varies by roughly 0.1 percent over the
 * solar cycle. This is the correct value to use for a reproducible irradiance
 * calculation and the wrong one to present as an instantaneous measurement.
 */
export const NOMINAL_SOLAR_LUMINOSITY_W = 3.828e26;

/** Nominal solar radius, metres. DEFINED by IAU 2015 Resolution B3. */
export const NOMINAL_SOLAR_RADIUS_M = 6.957e8;

/** Arcseconds in one degree. */
export const ARCSEC_PER_DEGREE = 3600;

/** Degrees to radians. */
export const DEG_TO_RAD = Math.PI / 180;

/** Radians to degrees. */
export const RAD_TO_DEG = 180 / Math.PI;

/** Provenance for each constant, per the section 12 requirement. */
export const CONSTANT_SOURCES = {
  AU_M: { unit: 'm', source: 'S3', status: 'DEFINED', citation: 'IAU 2012 Resolution B1' },
  SPEED_OF_LIGHT_M_S: { unit: 'm/s', source: 'S3', status: 'DEFINED', citation: 'SI definition' },
  GRAVITATIONAL_CONSTANT: {
    unit: 'm^3 kg^-1 s^-2',
    source: 'S3',
    status: 'MEASURED',
    citation: '2018 CODATA',
  },
  GM_SUN_M3_S2: {
    unit: 'm^3 s^-2',
    source: 'S3',
    status: 'MEASURED',
    citation: 'JPL DE440, Park et al. 2021',
  },
  J2000_OBLIQUITY_ARCSEC: {
    unit: 'arcsec',
    source: 'S3',
    status: 'MEASURED',
    citation: 'Standish 1995, IAU WGAS Numerical Standards',
  },
  NOMINAL_SOLAR_LUMINOSITY_W: {
    unit: 'W',
    source: 'S5',
    status: 'DEFINED',
    citation: 'IAU 2015 Resolution B3',
  },
  NOMINAL_SOLAR_RADIUS_M: {
    unit: 'm',
    source: 'S5',
    status: 'DEFINED',
    citation: 'IAU 2015 Resolution B3',
  },
} as const;
