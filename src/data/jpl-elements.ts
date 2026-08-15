/**
 * JPL approximate Keplerian elements for the major planets.
 *
 * SOURCE S1: https://ssd.jpl.nasa.gov/planets/approx_pos.html
 * E. M. Standish & J. G. Williams (1992), republished by JPL SSD.
 * See src/data/sources.md for the full provenance record.
 *
 * TRANSCRIPTION POLICY: the numeric rows below are copied verbatim from the
 * published tables, in the published column order, with the published digit
 * count. They are deliberately NOT pre-converted into named fields by hand,
 * because a hand transcription into a different shape cannot be diffed against
 * the source. A reviewer can compare these rows directly with the JPL page line
 * by line. Structuring happens in code, below the data.
 *
 * ACCURACY: this is a best-fit approximation, not an integrated ephemeris and
 * not a measurement. It must never be presented as an exact or observed
 * position. Nominal errors are tabulated in ELEMENT_ACCURACY and reach 600
 * arcseconds in longitude and 1.5 million km in distance for Saturn over the
 * 1800-2050 interval. The elements are invalid outside their stated interval;
 * the source states this explicitly.
 *
 * TIME ARGUMENT: the source's independent variable is T_eph, equated to TDB.
 * This project supplies TT. The difference is periodic and bounded near 1.7 ms,
 * which is five orders of magnitude below the model's own position error. See
 * sources.md S1.
 */

/** Element column order as published. Used only to document the raw rows. */
export const RAW_COLUMN_ORDER = ['a', 'e', 'I', 'L', 'longPeri', 'longNode'] as const;

/**
 * Keplerian elements at the J2000.0 epoch.
 *
 * Units follow the source: a in au, e dimensionless, all angles in degrees.
 *
 * NOTE ON THE SOURCE TABLE HEADER: the published table labels the eccentricity
 * column "rad, rad/Cy". Eccentricity is dimensionless; that label is an
 * artefact of a shared header spanning several columns. Treated as
 * dimensionless here, as the defining formulae require.
 */
export interface KeplerianElements {
  /** Semi-major axis, au. */
  readonly a: number;
  /** Eccentricity, dimensionless. */
  readonly e: number;
  /** Inclination to the J2000 ecliptic, degrees. */
  readonly I: number;
  /** Mean longitude, degrees. */
  readonly L: number;
  /** Longitude of perihelion, varpi, degrees. */
  readonly longPeri: number;
  /** Longitude of the ascending node, Omega, degrees. */
  readonly longNode: number;
}

/** Per-Julian-century rates of change, same units per century. */
export type KeplerianRates = KeplerianElements;

/**
 * Table 2b augmentation terms for the mean anomaly of Jupiter through Neptune.
 *
 * REQUIRED, not optional, whenever the Table 2a element set is used for those
 * four planets. The source states the computation of M "*must* be augmented" by
 * these terms. Omitting them silently degrades the outer planets, which is
 * exactly the kind of quiet inaccuracy this project forbids, so the loader
 * below refuses to construct such a record.
 *
 *   M = L - varpi + b T^2 + c cos(f T) + s sin(f T)
 *
 * b is degrees per century squared; c and s are degrees; f is degrees per
 * century, used as the argument of the trigonometric terms.
 */
export interface AugmentationTerms {
  readonly b: number;
  readonly c: number;
  readonly s: number;
  readonly f: number;
}

/** Validity interval of an element set, as fractional years. */
export interface ValidityInterval {
  readonly startYear: number;
  readonly endYear: number;
  readonly label: string;
}

/** Nominal error figures published alongside an element set. */
export interface NominalAccuracy {
  /** Heliocentric longitude error, arcseconds. */
  readonly longitudeArcsec: number;
  /** Heliocentric latitude error, arcseconds. */
  readonly latitudeArcsec: number;
  /** Radial distance error, thousands of kilometres. */
  readonly distanceThousandKm: number;
}

export interface PlanetElementRecord {
  /** Stable internal identifier. */
  readonly id: string;
  /** Row label exactly as published, so the row can be located in the source. */
  readonly sourceLabel: string;
  readonly elements: KeplerianElements;
  readonly rates: KeplerianRates;
  /** Present only where the source publishes augmentation terms. */
  readonly augmentation?: AugmentationTerms;
}

export interface ElementTable {
  readonly id: 'table1' | 'table2a';
  readonly validity: ValidityInterval;
  readonly bodies: readonly PlanetElementRecord[];
  /** True when this table's outer planets require augmentation terms. */
  readonly requiresAugmentation: boolean;
}

// ---------------------------------------------------------------------------
// RAW PUBLISHED DATA
//
// Column order, both rows:  a  e  I  L  long.peri  long.node
// First row  = element value at J2000.0
// Second row = rate per Julian century
//
// Verbatim from the source tables. Do not reformat the numbers.
// ---------------------------------------------------------------------------

type RawRow = readonly [
  id: string,
  sourceLabel: string,
  values: readonly [number, number, number, number, number, number],
  rates: readonly [number, number, number, number, number, number],
];

/** Table 1: valid 1800 AD - 2050 AD. No augmentation terms published. */
const RAW_TABLE_1: readonly RawRow[] = [
  ['mercury', 'Mercury', [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  ['venus', 'Venus', [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  ['embary', 'EM Bary', [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  ['mars', 'Mars', [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  ['jupiter', 'Jupiter', [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  ['saturn', 'Saturn', [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  ['uranus', 'Uranus', [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  ['neptune', 'Neptune', [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
];

/**
 * Table 2a: valid 3000 BC - 3000 AD.
 *
 * Jupiter through Neptune REQUIRE the Table 2b terms below.
 */
const RAW_TABLE_2A: readonly RawRow[] = [
  ['mercury', 'Mercury', [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819],
    [0.00000000, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182]],
  ['venus', 'Venus', [0.72332102, 0.00676399, 3.39777545, 181.97970850, 131.76755713, 76.67261496],
    [-0.00000026, -0.00005107, 0.00043494, 58517.81560260, 0.05679648, -0.27274174]],
  ['embary', 'EM Bary', [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389],
    [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.31795260, -0.24123856]],
  ['mars', 'Mars', [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984],
    [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431]],
  ['jupiter', 'Jupiter', [5.20248019, 0.04853590, 1.29861416, 34.33479152, 14.27495244, 100.29282654],
    [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619]],
  ['saturn', 'Saturn', [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702],
    [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002]],
  ['uranus', 'Uranus', [19.18797948, 0.04685740, 0.77298127, 314.20276625, 172.43404441, 73.96250215],
    [-0.00020455, -0.00001550, -0.00180155, 428.49512595, 0.09266985, 0.05739699]],
  ['neptune', 'Neptune', [30.06952752, 0.00895439, 1.77005520, 304.22289287, 46.68158724, 131.78635853],
    [0.00006447, 0.00000818, 0.00022400, 218.46515314, 0.01009938, -0.00606302]],
];

/** Table 2b: additional M terms, Jupiter through Neptune, 3000 BC - 3000 AD. */
const RAW_TABLE_2B: Readonly<Record<string, AugmentationTerms>> = {
  jupiter: { b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 },
  saturn: { b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000 },
  uranus: { b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000 },
  neptune: { b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000 },
};

/** Bodies for which the source publishes augmentation terms. */
const AUGMENTED_BODIES: readonly string[] = ['jupiter', 'saturn', 'uranus', 'neptune'];

// ---------------------------------------------------------------------------
// STRUCTURING
// ---------------------------------------------------------------------------

function toElements(values: readonly [number, number, number, number, number, number]): KeplerianElements {
  return {
    a: values[0],
    e: values[1],
    I: values[2],
    L: values[3],
    longPeri: values[4],
    longNode: values[5],
  };
}

function buildTable(
  id: ElementTable['id'],
  validity: ValidityInterval,
  raw: readonly RawRow[],
  augmentation: Readonly<Record<string, AugmentationTerms>> | null,
): ElementTable {
  const bodies = raw.map(([bodyId, sourceLabel, values, rates]): PlanetElementRecord => {
    const terms = augmentation?.[bodyId];

    // Refuse to build a record that silently omits terms the source declares
    // mandatory. A missing augmentation would degrade the outer planets
    // invisibly rather than loudly.
    if (augmentation !== null && AUGMENTED_BODIES.includes(bodyId) && terms === undefined) {
      throw new Error(
        `jpl-elements: ${bodyId} requires Table 2b augmentation terms in table ${id}, none supplied`,
      );
    }

    const base = {
      id: bodyId,
      sourceLabel,
      elements: toElements(values),
      rates: toElements(rates),
    };
    // exactOptionalPropertyTypes is on, so the key is added only when present
    // rather than being set to undefined.
    return terms === undefined ? base : { ...base, augmentation: terms };
  });

  return { id, validity, bodies, requiresAugmentation: augmentation !== null };
}

/**
 * Default element set. Covers 1800-2050 with the tighter published errors.
 *
 * Matches the default simulation clock range, so the clock cannot be scrubbed
 * outside the model's validity without an explicit range change.
 */
export const ELEMENTS_TABLE_1: ElementTable = buildTable(
  'table1',
  { startYear: 1800, endYear: 2050, label: '1800 AD - 2050 AD' },
  RAW_TABLE_1,
  null,
);

/** Wide-interval element set. Outer planets carry the Table 2b terms. */
export const ELEMENTS_TABLE_2A: ElementTable = buildTable(
  'table2a',
  { startYear: -3000, endYear: 3000, label: '3000 BC - 3000 AD' },
  RAW_TABLE_2A,
  RAW_TABLE_2B,
);

/**
 * Nominal accuracy of Table 1 over 1800-2050, as published.
 *
 * Surfaced so the interface can state the uncertainty of a displayed position
 * instead of implying exactness.
 */
export const ELEMENT_ACCURACY: Readonly<Record<string, NominalAccuracy>> = {
  mercury: { longitudeArcsec: 15, latitudeArcsec: 1, distanceThousandKm: 1 },
  venus: { longitudeArcsec: 20, latitudeArcsec: 1, distanceThousandKm: 4 },
  embary: { longitudeArcsec: 20, latitudeArcsec: 8, distanceThousandKm: 6 },
  mars: { longitudeArcsec: 40, latitudeArcsec: 2, distanceThousandKm: 25 },
  jupiter: { longitudeArcsec: 400, latitudeArcsec: 10, distanceThousandKm: 600 },
  saturn: { longitudeArcsec: 600, latitudeArcsec: 25, distanceThousandKm: 1500 },
  uranus: { longitudeArcsec: 50, latitudeArcsec: 2, distanceThousandKm: 1000 },
  neptune: { longitudeArcsec: 10, latitudeArcsec: 1, distanceThousandKm: 200 },
};

/**
 * Obliquity of the ecliptic at J2000, degrees, as used by the S1 formulae for
 * the ecliptic-to-equatorial rotation.
 *
 * The source specifies 23.43928 deg for this transformation, which is 84381.408
 * arcsec. The JPL astrodynamic parameters page lists 84381.412 arcsec
 * (23.4392811 deg) for the same quantity. The source's own value is used here,
 * because mixing a more precise constant into a formula fitted with a less
 * precise one gains nothing and breaks agreement with the published algorithm.
 *
 * The discrepancy is 0.004 arcsec (measured, not estimated). Mercury's nominal
 * longitude error in this same model is 15 arcsec, roughly 3750 times larger, so
 * the choice is immaterial at this model's accuracy.
 */
export const J2000_OBLIQUITY_DEG = 23.43928;

/**
 * Kepler-solver tolerance recommended by the source, in degrees.
 *
 * The project's own solver targets a far tighter residual than this; the value
 * is recorded because the source names it, not because it bounds our solver.
 */
export const SOURCE_KEPLER_TOLERANCE_DEG = 1e-6;

/** Provenance strings, kept beside the data so the interface need not hardcode them. */
export const ELEMENT_SOURCE = {
  id: 'S1',
  model: 'JPL Approximate Positions of the Planets',
  origin: 'E. M. Standish & J. G. Williams (1992), JPL Solar System Dynamics',
  url: 'https://ssd.jpl.nasa.gov/planets/approx_pos.html',
  timeArgument: 'TDB, supplied as TT; see sources.md S1',
  retrieved: '2026-08-15',
} as const;

/**
 * Field-level provenance for every element column, per the §12 requirement that
 * each astronomical field declare value, unit and source.
 *
 * Declared once per field rather than repeated on every value.
 */
export const FIELD_SOURCES: Readonly<
  Record<keyof KeplerianElements, { unit: string; source: string; description: string }>
> = {
  a: { unit: 'au', source: 'S1', description: 'semi-major axis' },
  e: { unit: 'dimensionless', source: 'S1', description: 'eccentricity' },
  I: { unit: 'degrees', source: 'S1', description: 'inclination to J2000 ecliptic' },
  L: { unit: 'degrees', source: 'S1', description: 'mean longitude' },
  longPeri: { unit: 'degrees', source: 'S1', description: 'longitude of perihelion' },
  longNode: { unit: 'degrees', source: 'S1', description: 'longitude of ascending node' },
};

/**
 * IMPORTANT MODELLING NOTE, surfaced deliberately rather than buried.
 *
 * The third row of both tables is the Earth/Moon BARYCENTRE, not Earth. The
 * barycentre sits roughly 4670 km from Earth's centre, which is inside Earth
 * and therefore under one Earth radius, but it is not zero and it is not a
 * fixed offset.
 *
 * In M1 there is no lunar theory, so Earth is drawn at the barycentre and the
 * discrepancy is documented here and in the interface. The Moon's own ephemeris
 * arrives in M4 (ELP2000), at which point Earth and Moon are both offset from
 * this barycentre by their mass ratio instead of Earth being placed on it.
 *
 * Recorded as a known limitation, not silently accepted.
 */
export const EMBARY_LIMITATION = {
  affectedBody: 'embary',
  displayedAs: 'earth',
  maximumOffsetKm: 4670,
  resolution: 'M4 ELP2000 lunar theory',
  note: 'Element set gives the Earth/Moon barycentre; Earth is drawn there until a lunar theory exists.',
} as const;

/** Looks up a body's record in a table, or throws with the available ids. */
export function getElementRecord(table: ElementTable, bodyId: string): PlanetElementRecord {
  const record = table.bodies.find((body) => body.id === bodyId);
  if (record === undefined) {
    throw new Error(
      `jpl-elements: no record for "${bodyId}" in ${table.id}; available: ${table.bodies
        .map((b) => b.id)
        .join(', ')}`,
    );
  }
  return record;
}

/** True when a fractional year falls inside a table's published validity. */
export function isWithinValidity(table: ElementTable, year: number): boolean {
  return year >= table.validity.startYear && year <= table.validity.endYear;
}
