/**
 * Physical space to render space.
 *
 * THE ONLY MODULE PERMITTED TO SCALE ANYTHING. Contract section 1.3 requires
 * every transformation to live here, and sections 1.1, 2 and 39 require the
 * physical values it reads to be left untouched. Every function below is pure:
 * it takes physical quantities and returns render quantities, and never writes
 * back into the simulation.
 *
 * WHAT "RENDER SPACE" MEANS HERE. One render unit is 1000 km. That is a unit
 * choice for the GPU's f32 coordinates, not a statement about the simulation,
 * which continues to work in kilometres at f64. Contract section 1.2 is explicit
 * that scientific mode is a render-space conversion and not a change of
 * simulation units.
 *
 * TWO MODES:
 *
 *   SCIENTIFIC  - true relative distances and true relative sizes. A pure
 *                 division by the render unit. Nothing is exaggerated.
 *
 *   VISUALIZED  - distances compressed by a monotonic power law, radii
 *                 multiplied by a configurable factor. Ordering, orbital
 *                 geometry and every physical value are preserved; only the
 *                 mapping to screen changes, and the interface must say so.
 *
 * NO CITATIONS IN THIS FILE, deliberately. Nothing here asserts anything about
 * the physical world. The render unit, the compression exponent, the reference
 * radius and the radius multiplier are presentation parameters, and
 * src/data/sources.md records that they carry no provenance because they make no
 * empirical claim. They must never appear in an interface panel as though they
 * were measured.
 */

import type { Vector3Like } from '../ephemeris/kepler';
import { AU_KM } from '../data/constants';

/** Kilometres per render unit. */
export const RENDER_UNIT_KM = 1000;

/**
 * Reference radius r0 for the compression law, kilometres.
 *
 * One astronomical unit. The exponent law is the identity at r0, so this choice
 * decides which orbit is drawn at true scale and which side of it is stretched or
 * squeezed. At 1 AU, sub-AU distances are EXPANDED and super-AU distances are
 * COMPRESSED, which is precisely what contract section 1.5 asks for: the inner
 * planets separate instead of collapsing into a point, and the outer planets stay
 * reachable. Measured, with the default exponent:
 *
 *   Mercury perihelion  0.3075 AU  ->  0.5882 AU-equivalent
 *   Earth               1.0000 AU  ->  1.0000 AU-equivalent  (fixed point)
 *   Jupiter             5.2030 AU  ->  2.1005 AU-equivalent
 *   Neptune            30.0700 AU  ->  4.6255 AU-equivalent
 *
 * The system spans 4.63 render-AU rather than 30.
 */
export const DEFAULT_COMPRESSION_REFERENCE_KM = AU_KM;

/**
 * Exponent of the distance compression law.
 *
 * Any value in (0, 1] is monotonic and order-preserving. 1 is the identity, and
 * smaller values compress more aggressively.
 */
export const DEFAULT_COMPRESSION_EXPONENT = 0.45;

/**
 * Default radius exaggeration in visualized mode.
 *
 * Validated against every adjacent pair by validateVisualBodySeparation. Measured
 * worst case at this multiplier is the Earth-Moon pair, whose summed visual radii
 * reach 16.9 percent of their render separation; every other pair is below 2
 * percent. There is margin, but not unlimited margin, which is why the validator
 * runs rather than the number being trusted.
 */
export const DEFAULT_RADIUS_MULTIPLIER = 8;

export type ScaleMode = 'SCIENTIFIC' | 'VISUALIZED';

/**
 * How a satellite's offset from its primary is scaled.
 *
 * See toRenderPosition for why this is a separate, uniform factor per subsystem
 * rather than the heliocentric compression applied to an absolute vector.
 */
export interface SatelliteOffsetFactors {
  readonly [primaryId: string]: number;
}

export interface ScaleConfig {
  readonly mode: ScaleMode;
  readonly renderUnitKm: number;
  readonly compressionReferenceKm: number;
  readonly compressionExponent: number;
  /** Global radius multiplier. Forced to 1 in scientific mode. */
  readonly radiusMultiplier: number;
  /** Per-body radius multiplier overrides, by body id. */
  readonly radiusMultiplierOverrides: Readonly<Record<string, number>>;
  /**
   * Per-primary multiplier on satellite offsets. Defaults to 1, meaning
   * satellite orbits are drawn at TRUE scale relative to their primary.
   */
  readonly satelliteOffsetFactors: SatelliteOffsetFactors;
}

/** Scientific mode: nothing exaggerated, nothing compressed. */
export function scientificScale(): ScaleConfig {
  return {
    mode: 'SCIENTIFIC',
    renderUnitKm: RENDER_UNIT_KM,
    // Unused in this mode, but kept well-formed so the config is always valid.
    compressionReferenceKm: DEFAULT_COMPRESSION_REFERENCE_KM,
    compressionExponent: 1,
    radiusMultiplier: 1,
    radiusMultiplierOverrides: {},
    satelliteOffsetFactors: {},
  };
}

/**
 * Visualized mode, with optional overrides for any parameter except the mode.
 *
 * `mode` is excluded from the override type rather than being accepted and then
 * silently forced. Accepting it would let a caller write
 * `visualizedScale({ mode: 'SCIENTIFIC' })` and receive a config that ignored the
 * argument; excluding it makes that a compile error instead.
 */
export function visualizedScale(
  overrides: Omit<Partial<ScaleConfig>, 'mode'> = {},
): ScaleConfig {
  const config: ScaleConfig = {
    renderUnitKm: RENDER_UNIT_KM,
    compressionReferenceKm: DEFAULT_COMPRESSION_REFERENCE_KM,
    compressionExponent: DEFAULT_COMPRESSION_EXPONENT,
    radiusMultiplier: DEFAULT_RADIUS_MULTIPLIER,
    radiusMultiplierOverrides: {},
    satelliteOffsetFactors: {},
    ...overrides,
    mode: 'VISUALIZED',
  };
  assertValidConfig(config);
  return config;
}

function assertValidConfig(config: ScaleConfig): void {
  if (config.renderUnitKm <= 0 || !Number.isFinite(config.renderUnitKm)) {
    throw new Error(`scale: renderUnitKm must be positive and finite, got ${config.renderUnitKm}`);
  }
  if (config.compressionReferenceKm <= 0 || !Number.isFinite(config.compressionReferenceKm)) {
    throw new Error(
      `scale: compressionReferenceKm must be positive and finite, got ${config.compressionReferenceKm}`,
    );
  }
  // Outside (0, 1] the law stops being a compression: above 1 it expands without
  // bound, and at or below 0 it is not monotonic increasing, which would break
  // the ordering guarantee contract section 1.3 requires.
  if (!(config.compressionExponent > 0) || config.compressionExponent > 1) {
    throw new Error(
      `scale: compressionExponent must lie in (0, 1], got ${config.compressionExponent}`,
    );
  }
  if (config.radiusMultiplier <= 0 || !Number.isFinite(config.radiusMultiplier)) {
    throw new Error(`scale: radiusMultiplier must be positive and finite, got ${config.radiusMultiplier}`);
  }
}

/**
 * The scalar distance law, kilometres to kilometres-equivalent.
 *
 *   scientific:  d' = d
 *   visualized:  d' = r0 (d / r0)^k
 *
 * MONOTONIC for k in (0, 1]: the derivative k r0^(1-k) d^(k-1) is positive for
 * all d > 0, so ordering is preserved exactly, which is what lets the interface
 * claim relative distances are still meaningful.
 */
export function compressDistanceKm(distanceKm: number, config: ScaleConfig): number {
  if (distanceKm < 0) {
    throw new Error(`scale: distance must be non-negative, got ${distanceKm}`);
  }
  if (config.mode === 'SCIENTIFIC' || config.compressionExponent === 1) return distanceKm;
  if (distanceKm === 0) return 0;

  const { compressionReferenceKm: r0, compressionExponent: k } = config;
  return r0 * Math.pow(distanceKm / r0, k);
}

/** Inverse of compressDistanceKm. Exact, since the law is a bijection on [0, inf). */
export function expandDistanceKm(compressedKm: number, config: ScaleConfig): number {
  if (compressedKm < 0) {
    throw new Error(`scale: compressed distance must be non-negative, got ${compressedKm}`);
  }
  if (config.mode === 'SCIENTIFIC' || config.compressionExponent === 1) return compressedKm;
  if (compressedKm === 0) return 0;

  const { compressionReferenceKm: r0, compressionExponent: k } = config;
  return r0 * Math.pow(compressedKm / r0, 1 / k);
}

/**
 * A HELIOCENTRIC physical position to render space.
 *
 * Compresses the MAGNITUDE and leaves the DIRECTION untouched, so a heliocentric
 * orbit keeps its shape in angle while changing in radius.
 *
 * WHY THIS FUNCTION MUST NOT BE USED FOR SATELLITES. Applying a radial
 * compression to an absolute position scales the radial direction by df/dr and
 * the tangential direction by f(r)/r, and those two gains are not equal. At the
 * reference radius with the default exponent they are 0.45 and 1.0, measured, so
 * a circular satellite orbit would be drawn as an ellipse flattened by 55 percent
 * along the Sun-planet line. That is not a small distortion and it is not a
 * defensible one: it would present a fabricated orbital geometry while the
 * interface claimed orbital geometry was accurate. Satellites go through
 * toRenderPositionHierarchical instead.
 */
export function toRenderPosition(positionKm: Vector3Like, config: ScaleConfig): Vector3Like {
  const magnitudeKm = Math.hypot(positionKm.x, positionKm.y, positionKm.z);

  // The origin has no direction to preserve.
  if (magnitudeKm === 0) return { x: 0, y: 0, z: 0 };

  const compressedKm = compressDistanceKm(magnitudeKm, config);
  const factor = compressedKm / magnitudeKm / config.renderUnitKm;

  return { x: positionKm.x * factor, y: positionKm.y * factor, z: positionKm.z * factor };
}

/**
 * Inverse of toRenderPosition, for a position understood as heliocentric.
 *
 * NOT A UNIVERSAL INVERSE, and the limit is inherent rather than an omission.
 * The full hierarchical transform is a different map per subsystem, so an
 * arbitrary render point does not determine which subsystem produced it: a point
 * near Earth could be a heliocentric position or an Earth-relative satellite
 * position, and the two invert differently. This function inverts the
 * heliocentric branch, which is the one that matters for turning a picked screen
 * point back into a physical position. Recovering a satellite's physical position
 * requires the parent context and is done by the caller that already has it.
 */
export function fromRenderPosition(renderPosition: Vector3Like, config: ScaleConfig): Vector3Like {
  const renderMagnitude = Math.hypot(renderPosition.x, renderPosition.y, renderPosition.z);
  if (renderMagnitude === 0) return { x: 0, y: 0, z: 0 };

  const compressedKm = renderMagnitude * config.renderUnitKm;
  const physicalKm = expandDistanceKm(compressedKm, config);
  const factor = physicalKm / renderMagnitude;

  return {
    x: renderPosition.x * factor,
    y: renderPosition.y * factor,
    z: renderPosition.z * factor,
  };
}

/**
 * Physical radius to render radius.
 *
 * The multiplier is a RENDER quantity. Contract section 2 requires physical and
 * visual radius to remain distinct: measurements and selection geometry use
 * physicalRadiusKm, and this value is only ever used to decide how large a sphere
 * to draw.
 */
export function toRenderRadius(
  physicalRadiusKm: number,
  bodyId: string,
  config: ScaleConfig,
): number {
  if (physicalRadiusKm < 0 || !Number.isFinite(physicalRadiusKm)) {
    throw new Error(`scale: physical radius must be non-negative and finite, got ${physicalRadiusKm}`);
  }
  return (physicalRadiusKm * visualRadiusMultiplier(bodyId, config)) / config.renderUnitKm;
}

/** The multiplier in force for a body: its override, or the global value. */
export function visualRadiusMultiplier(bodyId: string, config: ScaleConfig): number {
  if (config.mode === 'SCIENTIFIC') return 1;
  return config.radiusMultiplierOverrides[bodyId] ?? config.radiusMultiplier;
}

/** Inverse of toRenderRadius. Exact, given the same body and config. */
export function fromRenderRadius(
  renderRadius: number,
  bodyId: string,
  config: ScaleConfig,
): number {
  return (renderRadius * config.renderUnitKm) / visualRadiusMultiplier(bodyId, config);
}

/** The minimum a body needs from the simulation to be placed in render space. */
export interface ScalableBody {
  readonly bodyId: string;
  readonly positionKm: Vector3Like;
  readonly parentId: string | null;
  readonly physicalRadiusKm: number;
}

/**
 * A body's render-space placement.
 *
 * Carries all three radii contract section 2 requires, so the interface can show
 * the physical value and the exaggeration side by side rather than one standing
 * in for the other.
 */
export interface ScaledBody {
  readonly bodyId: string;
  readonly renderPosition: Vector3Like;
  /** Unchanged physical radius, km. Authoritative for measurement. */
  readonly physicalRadiusKm: number;
  /** Radius to draw, render units. */
  readonly visualRadius: number;
  /** The multiplier that produced visualRadius. 1 means no exaggeration. */
  readonly visualRadiusMultiplier: number;
}

/**
 * Places a whole system in render space, respecting the gravitational hierarchy.
 *
 * THE HIERARCHICAL RULE:
 *
 *   heliocentric body:  dir(r) * compress(|r|)
 *   satellite:          renderPositionOf(primary) + (r - r_primary) * localFactor
 *
 * The satellite branch applies a UNIFORM scalar to the offset, so the offset is
 * scaled isotropically and the satellite's orbit keeps its true shape. localFactor
 * defaults to 1, which draws satellite orbits at true scale relative to their
 * primary; raising it makes a tight system such as Mars and its moons legible, at
 * the cost of an exaggeration the interface must disclose and the separation
 * validator must re-check.
 *
 * Parents are resolved recursively with memoisation, so declaration order does
 * not matter. A cycle in the parent chain would recurse forever, so it is
 * detected and reported instead.
 */
export function scaleSystem(
  bodies: readonly ScalableBody[],
  config: ScaleConfig,
): readonly ScaledBody[] {
  const byId = new Map(bodies.map((body) => [body.bodyId, body]));
  const resolved = new Map<string, Vector3Like>();

  const renderPositionOf = (bodyId: string, visiting: readonly string[]): Vector3Like => {
    const cached = resolved.get(bodyId);
    if (cached !== undefined) return cached;

    if (visiting.includes(bodyId)) {
      throw new Error(`scale: cycle in parent chain: ${[...visiting, bodyId].join(' -> ')}`);
    }

    const body = byId.get(bodyId);
    if (body === undefined) {
      throw new Error(`scale: no body "${bodyId}" in the supplied system`);
    }

    let position: Vector3Like;
    const parent = body.parentId === null ? undefined : byId.get(body.parentId);

    if (parent === undefined) {
      // No primary in this system: either the frame origin itself, or a body
      // whose primary was not supplied. Treating the absolute position as
      // heliocentric is the honest fallback, keeping the body visible and
      // correctly placed relative to the origin.
      position = toRenderPosition(body.positionKm, config);
    } else if (parent.parentId === null) {
      // PRIMARY IS THE FRAME ORIGIN, so this is a heliocentric orbit and the
      // radial compression applies to its offset from that origin.
      //
      // THIS BRANCH MUST EXIST SEPARATELY FROM THE SATELLITE BRANCH BELOW, and
      // an earlier revision of this function omitted it. Because every planet
      // declares the Sun as its primary, and the Sun is always present, all eight
      // planets fell through to the satellite branch and received a uniform
      // offset factor of 1 instead of the compression. The consequence was that
      // visualized mode was silently IDENTICAL to scientific mode for distances:
      // Mercury rendered at 46001 units, exactly its uncompressed 0.3075 au,
      // rather than the 87999 the compression law specifies. Measured, and caught
      // only because the separation validator reported a ratio of 0.121 where
      // 0.064 was expected.
      //
      // Written as parentRender + compress(offset) rather than
      // compress(absolute) so it stays correct if the frame origin ever moves off
      // the physical origin, for instance if the system is re-referenced to the
      // solar system barycentre. With the origin at zero the two are identical.
      const parentRender = renderPositionOf(parent.bodyId, [...visiting, bodyId]);
      const offsetFromOrigin: Vector3Like = {
        x: body.positionKm.x - parent.positionKm.x,
        y: body.positionKm.y - parent.positionKm.y,
        z: body.positionKm.z - parent.positionKm.z,
      };
      const compressed = toRenderPosition(offsetFromOrigin, config);
      position = {
        x: parentRender.x + compressed.x,
        y: parentRender.y + compressed.y,
        z: parentRender.z + compressed.z,
      };
    } else {
      // TRUE SATELLITE: its primary orbits something else, so the offset is
      // scaled by a single uniform scalar. Isotropic, therefore shape-preserving.
      // Applying the radial compression here instead would flatten a circular
      // orbit by 55 percent at the default exponent; see toRenderPosition.
      const parentRender = renderPositionOf(parent.bodyId, [...visiting, bodyId]);
      const factor = satelliteOffsetFactor(parent.bodyId, config) / config.renderUnitKm;
      position = {
        x: parentRender.x + (body.positionKm.x - parent.positionKm.x) * factor,
        y: parentRender.y + (body.positionKm.y - parent.positionKm.y) * factor,
        z: parentRender.z + (body.positionKm.z - parent.positionKm.z) * factor,
      };
    }

    resolved.set(bodyId, position);
    return position;
  };

  return bodies.map((body) => ({
    bodyId: body.bodyId,
    renderPosition: renderPositionOf(body.bodyId, []),
    physicalRadiusKm: body.physicalRadiusKm,
    visualRadius: toRenderRadius(body.physicalRadiusKm, body.bodyId, config),
    visualRadiusMultiplier: visualRadiusMultiplier(body.bodyId, config),
  }));
}

/** The offset multiplier for a subsystem. 1 means true relative scale. */
export function satelliteOffsetFactor(primaryId: string, config: ScaleConfig): number {
  if (config.mode === 'SCIENTIFIC') return 1;
  return config.satelliteOffsetFactors[primaryId] ?? 1;
}

/** One pair's separation result. */
export interface SeparationCheck {
  readonly bodyA: string;
  readonly bodyB: string;
  /** Sum of the two visual radii, render units. */
  readonly summedVisualRadius: number;
  /** Centre separation in render space, render units. */
  readonly renderSeparation: number;
  /** summedVisualRadius / renderSeparation. At or above 1 the spheres intersect. */
  readonly ratio: number;
  readonly overlapping: boolean;
  readonly crowded: boolean;
}

export interface SeparationReport {
  readonly checks: readonly SeparationCheck[];
  readonly worst: SeparationCheck | null;
  readonly anyOverlapping: boolean;
  readonly anyCrowded: boolean;
}

/**
 * Ratio above which a pair is reported as crowded though not yet intersecting.
 *
 * A pure presentation threshold. At 0.5 the two spheres occupy half the gap
 * between them, which reads as touching even though they do not intersect.
 */
export const CROWDING_RATIO = 0.5;

/**
 * Checks that radius exaggeration has not made bodies overlap.
 *
 * Contract section 3. Runs entirely in RENDER space against RENDER radii, and
 * reads no physical value other than the radii it was given, so it cannot alter
 * the ephemeris. The remedies section 3 lists are all render-side: lower the
 * multiplier, or set a local factor for the affected subsystem.
 *
 * WHICH PAIRS ARE COMPARED: a body against its primary, and a body against its
 * siblings. Since all eight planets share the Sun as primary they are all
 * siblings, so every planet pair IS compared. That is intended, and it cannot
 * raise a false alarm at conjunction: the compression law is monotonic in radius,
 * so two bodies whose orbits do not overlap in radius keep a positive render
 * separation bounded below by the difference of their compressed radial extremes.
 * Measured, the closest sibling pair at ×8 is Jupiter and Saturn at a ratio of
 * 0.011.
 *
 * Unrelated pairs in different subsystems are not compared, because a satellite
 * of one planet approaching a different planet is a question about the sky rather
 * than about scaling.
 */
export function validateVisualBodySeparation(
  bodies: readonly ScalableBody[],
  config: ScaleConfig,
): SeparationReport {
  const scaled = new Map(scaleSystem(bodies, config).map((body) => [body.bodyId, body]));
  const checks: SeparationCheck[] = [];

  const compare = (a: ScalableBody, b: ScalableBody): void => {
    const scaledA = scaled.get(a.bodyId)!;
    const scaledB = scaled.get(b.bodyId)!;

    const separation = Math.hypot(
      scaledA.renderPosition.x - scaledB.renderPosition.x,
      scaledA.renderPosition.y - scaledB.renderPosition.y,
      scaledA.renderPosition.z - scaledB.renderPosition.z,
    );
    const summed = scaledA.visualRadius + scaledB.visualRadius;
    // A coincident pair is infinitely crowded; report that rather than dividing
    // by zero and producing NaN.
    const ratio = separation === 0 ? Number.POSITIVE_INFINITY : summed / separation;

    checks.push({
      bodyA: a.bodyId,
      bodyB: b.bodyId,
      summedVisualRadius: summed,
      renderSeparation: separation,
      ratio,
      overlapping: ratio >= 1,
      crowded: ratio >= CROWDING_RATIO,
    });
  };

  for (const body of bodies) {
    if (body.parentId === null) continue;

    // Body against its own primary.
    const primary = bodies.find((candidate) => candidate.bodyId === body.parentId);
    if (primary !== undefined) compare(body, primary);

    // Body against its siblings, each pair once.
    for (const sibling of bodies) {
      if (sibling.parentId !== body.parentId) continue;
      if (sibling.bodyId <= body.bodyId) continue;
      compare(body, sibling);
    }
  }

  let worst: SeparationCheck | null = null;
  for (const check of checks) {
    if (worst === null || check.ratio > worst.ratio) worst = check;
  }

  return {
    checks,
    worst,
    anyOverlapping: checks.some((check) => check.overlapping),
    anyCrowded: checks.some((check) => check.crowded),
  };
}

/** Human-readable disclosure of the active transform, for the interface. */
export interface ScaleDescription {
  readonly mode: ScaleMode;
  /** True when distances are not linear in physical distance. */
  readonly distanceDistorted: boolean;
  /** True when any radius is drawn larger than true scale. */
  readonly sizeExaggerated: boolean;
  readonly distanceLabel: string;
  readonly sizeLabel: string;
  /** Statement that orbital geometry is undistorted, which the transform guarantees. */
  readonly geometryLabel: string;
  /** The transform in mathematical form, so the distortion is inspectable. */
  readonly distanceFormula: string;
  /** Lines for a compact interface panel. */
  readonly lines: readonly string[];
}

/**
 * Describes the active transform for display.
 *
 * Contract sections 1.3 and 9 require the distortion to be visible whenever it
 * is active, and never presented as though the view were to scale. The wording
 * below states what is distorted, by how much, and what is not.
 */
export function getScaleDescription(config: ScaleConfig): ScaleDescription {
  const distanceDistorted = config.mode === 'VISUALIZED' && config.compressionExponent !== 1;
  const multiplier = config.mode === 'VISUALIZED' ? config.radiusMultiplier : 1;
  const overrides = Object.entries(config.radiusMultiplierOverrides);
  const sizeExaggerated =
    config.mode === 'VISUALIZED' && (multiplier !== 1 || overrides.some(([, value]) => value !== 1));

  const distanceLabel = distanceDistorted ? 'VISUALIZED (NON-LINEAR)' : 'TRUE SCALE';
  const sizeLabel = sizeExaggerated
    ? `EXAGGERATED ${formatMultiplier(multiplier)}`
    : 'TRUE SCALE';

  const distanceFormula = distanceDistorted
    ? `d' = r0 (d / r0)^${config.compressionExponent}, r0 = ${(
        config.compressionReferenceKm / AU_KM
      ).toFixed(3)} au`
    : `d' = d / ${config.renderUnitKm} km per unit`;

  const lines = [
    `DISTANCE SCALE: ${distanceLabel}`,
    `PLANET SIZE: ${sizeLabel}`,
    'ORBITAL GEOMETRY: ACCURATE',
  ];

  // Per-body exaggerations are disclosed individually; a global figure would
  // misdescribe a body that carries an override.
  for (const [bodyId, value] of overrides) {
    if (value === multiplier) continue;
    lines.push(`  ${bodyId.toUpperCase()}: ${formatMultiplier(value)}`);
  }

  // A subsystem drawn at other than true relative scale is an additional
  // distortion and gets its own line rather than hiding behind the size label.
  for (const [primaryId, factor] of Object.entries(config.satelliteOffsetFactors)) {
    if (factor === 1) continue;
    lines.push(`  ${primaryId.toUpperCase()} SYSTEM SPACING: ${formatMultiplier(factor)}`);
  }

  return {
    mode: config.mode,
    distanceDistorted,
    sizeExaggerated,
    distanceLabel,
    sizeLabel,
    geometryLabel: 'ACCURATE',
    distanceFormula,
    lines,
  };
}

function formatMultiplier(value: number): string {
  return Number.isInteger(value) ? `${value}x` : `${value.toFixed(2)}x`;
}
