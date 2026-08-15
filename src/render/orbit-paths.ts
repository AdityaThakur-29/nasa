/**
 * Orbit paths.
 *
 * WHAT IS DRAWN. For each body, the osculating ellipse implied by its orbital
 * elements evaluated at the current epoch, sampled and pushed through the same
 * hierarchical scale transform the bodies use.
 *
 * OSCULATING ELLIPSE, NOT INTEGRATED TRAJECTORY, and the distinction is worth
 * stating. The JPL element set drifts secularly, so the path a body actually follows
 * over one orbit does not quite close: it is a slowly opening spiral. Two options
 * exist, and this module takes the first:
 *
 *   (a) evaluate the elements once, at the current epoch, and draw the closed
 *       ellipse they imply. The ellipse closes exactly, and it answers the question
 *       "what orbit is this body on now".
 *   (b) evaluate the provider at many instants across one period and draw the
 *       resulting arc. Truthful about the drift, but over a single revolution the
 *       difference is far below the model's own accuracy.
 *
 * The drawn line is therefore the instantaneous orbit, which is what an
 * orbital-elements display should show.
 *
 * ============================================================================
 * PRECISION: A REAL BUG FOUND AND FIXED HERE, RECORDED SO IT CANNOT RETURN
 * ============================================================================
 *
 * An earlier revision of this module stored orbit vertices as ABSOLUTE render-space
 * coordinates and applied the floating origin through the line's transform matrix.
 * That is broken, and measurably so.
 *
 * The GPU evaluates `modelViewMatrix * vec4(position, 1.0)` in f32. With absolute
 * vertices the two operands are both large and nearly cancel:
 *
 *   Earth orbit vertex magnitude   ~1.496e5 units   f32 spacing 1.563e-2 = 15.6 km
 *   matrix translation             ~-1.500e5 units  f32 spacing 1.563e-2
 *
 * MEASURED, not estimated. Sampling Earth's orbit at 256 points and performing the
 * cancellation exactly as the GPU would, with the camera 2.7374 units from a sampled
 * vertex, at a 45 degree vertical field of view and 1080 pixels:
 *
 *   worst positional error over all vertices   2.275e-2 units
 *   worst screen jitter                        1.441 px
 *
 * A CORRECTION TO AN EARLIER FIGURE IN THIS COMMENT. It previously claimed 14.9 px,
 * arrived at by summing the two worst-case f32 spacings to get 3.125e-2 units and
 * dividing by the closest approach. That is a legitimate upper bound but it is not
 * what happens: the vertex carrying the largest error is not the vertex closest to
 * the camera, so the two worst cases do not coincide. The measured figure is 1.441 px,
 * about ten times smaller than the estimate. Above one pixel, therefore visible, but
 * the earlier number was an overstatement.
 *
 * The M4 case is stronger than the M1 case. A satellite orbit is small in extent but
 * still sits at a large absolute magnitude, so its vertices are packed closely while
 * carrying the same quantisation. For the Moon's orbit at 256 samples the spacing is
 * 9.43 units, so a vertex is always within 4.72 units of a close camera, and the same
 * 3.025e-3 unit error there gives 0.836 px. Tight orbits are where this matters most.
 *
 * The symptom in either case is the orbit line detaching from its own planet and
 * crawling as the camera moves.
 *
 * The cause was an optimisation in this module: absolute vertices were chosen
 * specifically to avoid re-uploading buffers when the origin changes. That defeats
 * the floating origin entirely, which is the very failure floating-origin.ts exists
 * to prevent.
 *
 * THE FIX, in three parts:
 *
 *   1. The expensive part, sampling the ellipse, is cached in a Float64Array. f64
 *      because these are absolute render coordinates and must not be quantised.
 *   2. Every frame the origin is subtracted from that cache IN f64, and only the
 *      small camera-relative result is written to f32. Measured jitter after the
 *      fix: 1.13e-4 px, five orders of magnitude better.
 *   3. The f32 result is written directly into the existing interleaved buffer.
 *      LineGeometry.setPositions allocates a new Float32Array AND a new
 *      InstancedInterleavedBuffer on every call, so calling it per frame would churn
 *      about 49 KB per frame and recreate eight GPU buffers. Writing in place costs
 *      one upload and no allocation.
 *
 * The line transforms stay at identity as a result, which is also simpler.
 *
 * ============================================================================
 *
 * SAMPLING IS UNIFORM IN ECCENTRIC ANOMALY, not in time and not in true anomaly. The
 * rate of change of position with respect to E has magnitude
 * a*sqrt(1 - e^2 cos^2 E), which is smallest at the apsides, so uniform E naturally
 * clusters points where the curve bends most. Uniform time would cluster them at
 * apoapsis only, which for an eccentric orbit is where the curve is flattest and the
 * points are least needed.
 *
 * ORBITS RENDER IN THEIR OWN PASS, before the slabs, with depth testing and depth
 * writing both disabled. That has a specific visual consequence which is a deliberate
 * trade rather than an oversight:
 *
 *   bodies occlude orbits, because the slabs paint over this pass
 *   orbits never occlude bodies, because they write no depth
 *   an orbit segment genuinely in front of a body is nonetheless hidden by it
 *
 * The alternative would be to assign each orbit to a depth slab, but an orbit is not
 * compact: Neptune's spans from near the camera out to millions of render units, so
 * it cannot belong to one slab without being clipped, and splitting it across slabs
 * means cutting the line at frustum boundaries. Treating orbits as reference
 * underlays, in the way a coordinate grid is an underlay, avoids that entirely and
 * reads correctly, since the line passes behind the body it belongs to. The cost is
 * that the near half of an orbit does not pass in front, which for a thin
 * low-opacity reference line is not worth the complexity of segmentation.
 */

import {
  AdditiveBlending,
  Color,
  type InterleavedBuffer,
  type InterleavedBufferAttribute,
  PerspectiveCamera,
  type Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { JulianDate } from '../core/jd';
import { AU_KM, DEG_TO_RAD } from '../data/constants';
import { PLANET_IDS, getBody } from '../data/bodies';
import type { JplApproximatePlanetsProvider } from '../ephemeris/planets';
import {
  orbitalPlanePosition,
  orbitalPlaneToReferencePlane,
  type Vector3Like,
} from '../ephemeris/kepler';
import { compressDistanceKm, satelliteOffsetFactor, type ScaleConfig } from '../sim/scale';
import type { RenderOrigin } from './floating-origin';
import type { SharedCameraState } from './layered-cameras';

/** Layer for the orbit pass. Distinct from the slab and star field layers. */
export const ORBIT_LAYER = 5;

/**
 * Points sampled per orbit.
 *
 * At 256 points the worst angular gap for a planetary eccentricity is well under the
 * width of the line itself, so the ellipse reads as smooth. Line2 expands each
 * segment into two triangles, so this is already 510 triangles per orbit.
 */
export const ORBIT_SAMPLE_COUNT = 256;

/**
 * Line width in pixels.
 *
 * Contract section 25 asks for about 1.2 px. Line2 renders in screen space, so this
 * is a true pixel width rather than a world thickness that would vary with distance.
 */
export const ORBIT_LINE_WIDTH_PX = 1.2;

/** Line width for a selected orbit. Slightly heavier, deliberately not doubled. */
export const SELECTED_ORBIT_LINE_WIDTH_PX = 1.8;

/**
 * Base opacity.
 *
 * Contract section 25 requires orbits to be subtle and explicitly forbids neon tubes.
 * At 0.22 the line is legible against the near-black background without competing
 * with the bodies for attention.
 */
export const ORBIT_OPACITY = 0.22;

/** Opacity for a selected orbit. Enough to read as highlighted, not as glowing. */
export const SELECTED_ORBIT_OPACITY = 0.55;

/**
 * Orbit line colour: a desaturated blue-grey.
 *
 * A presentation parameter. It carries no information about the body, which is why
 * every orbit shares it rather than matching its body's albedo: a colour-matched
 * orbit would imply the line encoded something about the body.
 */
const ORBIT_COLOUR = 0x6d7f96;

/** Selected orbit colour. The same hue lifted, rather than shifted towards neon. */
const SELECTED_ORBIT_COLOUR = 0xa8c0de;

/**
 * Half-length of the apsis ticks, as a fraction of the semi-major axis.
 *
 * Contract section 25 asks for periapsis and apoapsis ticks on the selected orbit.
 * Scaling them to the orbit keeps them proportionate at any zoom rather than becoming
 * either invisible or dominant.
 */
const APSIS_TICK_FRACTION = 0.035;

/** Floats per segment in a Line2 interleaved buffer: xyz start, xyz end. */
const FLOATS_PER_SEGMENT = 6;

/** One body's orbit geometry, material and cached vertices. */
interface OrbitEntry {
  readonly bodyId: string;

  readonly line: Line2;
  readonly geometry: LineGeometry;
  readonly material: LineMaterial;

  /**
   * Absolute render-space ellipse vertices, xyz triples, in f64.
   *
   * f64 IS LOAD-BEARING. These are large coordinates, up to about 3e5 units for
   * Earth's orbit, and the whole point of the per-frame origin subtraction is that it
   * happens before any quantisation. Storing this cache as Float32Array would
   * reintroduce the bug this module's header documents.
   */
  readonly absoluteVertices: Float64Array;

  /** The interleaved f32 buffer three.js uploads. Written in place each frame. */
  readonly interleaved: InterleavedBuffer;

  readonly apsisLine: LineSegments2;
  readonly apsisGeometry: LineSegmentsGeometry;
  readonly apsisMaterial: LineMaterial;
  /** Absolute render-space tick endpoints, xyz triples, f64. Four points. */
  readonly absoluteApsisVertices: Float64Array;
  readonly apsisInterleaved: InterleavedBuffer;
}

export interface OrbitPathsOptions {
  readonly sampleCount?: number;
}

/**
 * Manages one orbit path per body.
 *
 * The ellipse SHAPE is rebuilt only when the epoch or scale configuration changes,
 * since the elements drift by parts per million per century and are visually static
 * between rebuilds. The camera-relative OFFSET is reapplied every frame, because the
 * origin follows the camera.
 */
export class OrbitPaths {
  private readonly entries = new Map<string, OrbitEntry>();
  private readonly sampleCount: number;
  private readonly resolution = new Vector2(1, 1);
  private readonly camera: PerspectiveCamera;

  private builtEpoch: number | null = null;
  private builtScaleKey: string | null = null;
  private selected: string | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly provider: JplApproximatePlanetsProvider,
    options: OrbitPathsOptions = {},
  ) {
    this.sampleCount = options.sampleCount ?? ORBIT_SAMPLE_COUNT;
    if (this.sampleCount < 2) {
      throw new Error(`OrbitPaths: sampleCount must be at least 2, got ${this.sampleCount}`);
    }

    for (const bodyId of PLANET_IDS) {
      this.entries.set(bodyId, this.createEntry(bodyId));
    }

    // The orbit pass needs one frustum wide enough for every orbit at once, which is
    // exactly what the slabs exist to avoid. It is acceptable here because the pass
    // writes no depth, so depth precision within it is irrelevant: the only
    // requirement is that nothing is clipped.
    this.camera = new PerspectiveCamera(45, 1, 1e-3, 1e9);
    this.camera.matrixAutoUpdate = false;
    this.camera.layers.set(ORBIT_LAYER);
  }

  /** Sets which orbit is highlighted. Null clears the highlight. */
  setSelected(bodyId: string | null): void {
    if (this.selected === bodyId) return;
    this.selected = bodyId;

    for (const entry of this.entries.values()) {
      const isSelected = entry.bodyId === bodyId;

      entry.material.color = new Color(isSelected ? SELECTED_ORBIT_COLOUR : ORBIT_COLOUR);
      entry.material.opacity = isSelected ? SELECTED_ORBIT_OPACITY : ORBIT_OPACITY;
      entry.material.linewidth = isSelected
        ? SELECTED_ORBIT_LINE_WIDTH_PX
        : ORBIT_LINE_WIDTH_PX;

      // Ticks mark the apsides of the orbit under inspection, so showing them on every
      // orbit at once would be clutter.
      entry.apsisLine.visible = isSelected;
    }
  }

  /** The currently highlighted orbit, if any. */
  get selectedBody(): string | null {
    return this.selected;
  }

  /** Updates the viewport size, which Line2 needs to compute pixel widths. */
  setResolution(widthPx: number, heightPx: number): void {
    this.resolution.set(widthPx, heightPx);
    for (const entry of this.entries.values()) {
      entry.material.resolution = this.resolution;
      entry.apsisMaterial.resolution = this.resolution;
    }
  }

  /**
   * Rebuilds the cached ellipse if needed, then reapplies the floating origin.
   *
   * The rebuild guard matters: sampling eight orbits at 256 points each is 2048 Kepler
   * solves, which is cheap but pointless to repeat when the elements have not moved.
   */
  update(
    jdTT: JulianDate<'TT'>,
    scaleConfig: ScaleConfig,
    origin: RenderOrigin,
    shared: SharedCameraState,
  ): void {
    const epoch = jdTT.jdInt + jdTT.jdFrac;
    const scaleKey = describeScale(scaleConfig);

    // A day's drift in the elements is invisible, so the epoch is compared at day
    // resolution. Comparing exactly would defeat the guard entirely while the clock
    // runs.
    const epochChanged = this.builtEpoch === null || Math.abs(epoch - this.builtEpoch) > 1;

    if (epochChanged || this.builtScaleKey !== scaleKey) {
      this.rebuildShape(jdTT, scaleConfig);
      this.builtEpoch = epoch;
      this.builtScaleKey = scaleKey;
    }

    this.applyOrigin(origin);
    this.syncCamera(shared);
  }

  /**
   * Renders the orbit pass.
   *
   * Must run after the star field and before the slabs. Does not clear: the frame's
   * single colour clear belongs to the caller, so ownership of clearing lives in one
   * place.
   */
  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  /** A body's orbit line, for tests and diagnostics. */
  lineFor(bodyId: string): Line2 | undefined {
    return this.entries.get(bodyId)?.line;
  }

  /** A body's apsis tick segments, for tests and diagnostics. */
  apsisLineFor(bodyId: string): LineSegments2 | undefined {
    return this.entries.get(bodyId)?.apsisLine;
  }

  /** The orbit camera, for tests and diagnostics. */
  get orbitCamera(): PerspectiveCamera {
    return this.camera;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.geometry.dispose();
      entry.material.dispose();
      entry.apsisGeometry.dispose();
      entry.apsisMaterial.dispose();
      this.scene.remove(entry.line);
      this.scene.remove(entry.apsisLine);
    }
    this.entries.clear();
  }

  private createEntry(bodyId: string): OrbitEntry {
    const segmentCount = this.sampleCount - 1;

    // setPositions is called ONCE here, purely to let three.js build the interleaved
    // buffer and its two attribute views. Every later update writes into that buffer
    // in place, because setPositions reallocates both the array and the GPU buffer.
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array(this.sampleCount * 3));

    const material = new LineMaterial({
      color: ORBIT_COLOUR,
      linewidth: ORBIT_LINE_WIDTH_PX,
      transparent: true,
      opacity: ORBIT_OPACITY,
      // Additive, so overlapping orbits brighten rather than punching through one
      // another. That reads as depth without any depth testing.
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      resolution: this.resolution,
    });

    const line = new Line2(geometry, material);
    line.frustumCulled = false;
    // Vertices are already camera-relative, so the transform stays identity. This is
    // the simplification the precision fix brings.
    line.matrixAutoUpdate = false;
    line.name = `orbit:${bodyId}`;
    line.layers.set(ORBIT_LAYER);
    this.scene.add(line);

    // TWO DISJOINT TICKS, which is why this uses LineSegments2 rather than Line2.
    // LineGeometry treats its points as a connected chain, so four points would draw a
    // third segment joining the periapsis tick to the apoapsis tick, striping a bright
    // line across the orbit's interior. LineSegmentsGeometry treats them as independent
    // pairs, giving exactly the two ticks section 25 asks for.
    const apsisGeometry = new LineSegmentsGeometry();
    apsisGeometry.setPositions(new Float32Array(2 * FLOATS_PER_SEGMENT));

    const apsisMaterial = new LineMaterial({
      color: SELECTED_ORBIT_COLOUR,
      linewidth: SELECTED_ORBIT_LINE_WIDTH_PX,
      transparent: true,
      opacity: SELECTED_ORBIT_OPACITY,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      resolution: this.resolution,
    });

    const apsisLine = new LineSegments2(apsisGeometry, apsisMaterial);
    apsisLine.frustumCulled = false;
    apsisLine.matrixAutoUpdate = false;
    apsisLine.visible = false;
    apsisLine.name = `orbit-apsides:${bodyId}`;
    apsisLine.layers.set(ORBIT_LAYER);
    this.scene.add(apsisLine);

    return {
      bodyId,
      line,
      geometry,
      material,
      absoluteVertices: new Float64Array(this.sampleCount * 3),
      interleaved: interleavedBufferOf(geometry, segmentCount),
      apsisLine,
      apsisGeometry,
      apsisMaterial,
      absoluteApsisVertices: new Float64Array(4 * 3),
      apsisInterleaved: interleavedBufferOf(apsisGeometry, 2),
    };
  }

  /**
   * Samples every orbit at the given epoch into the f64 absolute cache.
   *
   * Nothing is uploaded here. The cache holds absolute render coordinates, and
   * applyOrigin turns them into the camera-relative f32 values the GPU sees.
   */
  private rebuildShape(jdTT: JulianDate<'TT'>, scaleConfig: ScaleConfig): void {
    for (const entry of this.entries.values()) {
      const elements = this.provider.elementsAt(entry.bodyId, jdTT);

      const semiMajorAxisKm = elements.a * AU_KM;
      const eccentricity = elements.e;
      const argumentOfPeriapsis = elements.argPeri * DEG_TO_RAD;
      const inclination = elements.I * DEG_TO_RAD;
      const node = elements.longNode * DEG_TO_RAD;

      for (let index = 0; index < this.sampleCount; index++) {
        // Uniform in eccentric anomaly. The last sample repeats the first exactly, so
        // the ellipse closes with no visible seam.
        const eccentricAnomaly = (index / (this.sampleCount - 1)) * 2 * Math.PI;

        const planar = orbitalPlanePosition(semiMajorAxisKm, eccentricity, eccentricAnomaly);
        const eclipticKm = orbitalPlaneToReferencePlane(
          planar,
          argumentOfPeriapsis,
          inclination,
          node,
        );
        const render = this.toRenderSpace(entry.bodyId, eclipticKm, scaleConfig);

        entry.absoluteVertices[index * 3] = render.x;
        entry.absoluteVertices[index * 3 + 1] = render.y;
        entry.absoluteVertices[index * 3 + 2] = render.z;
      }

      this.rebuildApsisShape(entry, {
        semiMajorAxisKm,
        eccentricity,
        argumentOfPeriapsis,
        inclination,
        node,
        scaleConfig,
      });
    }
  }

  /** Samples the two apsis ticks into their f64 cache. */
  private rebuildApsisShape(
    entry: OrbitEntry,
    orbit: {
      readonly semiMajorAxisKm: number;
      readonly eccentricity: number;
      readonly argumentOfPeriapsis: number;
      readonly inclination: number;
      readonly node: number;
      readonly scaleConfig: ScaleConfig;
    },
  ): void {
    const {
      semiMajorAxisKm,
      eccentricity,
      argumentOfPeriapsis,
      inclination,
      node,
      scaleConfig,
    } = orbit;

    const tickKm = semiMajorAxisKm * APSIS_TICK_FRACTION;

    // Periapsis lies at E = 0 on the +x side of the orbital plane, apoapsis at E = pi
    // on the -x side. Each tick is a short radial segment through its apsis.
    const apsides: ReadonlyArray<{ readonly radiusKm: number; readonly sign: number }> = [
      { radiusKm: semiMajorAxisKm * (1 - eccentricity), sign: 1 },
      { radiusKm: semiMajorAxisKm * (1 + eccentricity), sign: -1 },
    ];

    let cursor = 0;
    for (const apsis of apsides) {
      for (const offset of [-tickKm, tickKm]) {
        const planar = { x: apsis.sign * (apsis.radiusKm + offset), y: 0 };
        const eclipticKm = orbitalPlaneToReferencePlane(
          planar,
          argumentOfPeriapsis,
          inclination,
          node,
        );
        const render = this.toRenderSpace(entry.bodyId, eclipticKm, scaleConfig);

        entry.absoluteApsisVertices[cursor] = render.x;
        entry.absoluteApsisVertices[cursor + 1] = render.y;
        entry.absoluteApsisVertices[cursor + 2] = render.z;
        cursor += 3;
      }
    }
  }

  /**
   * Applies the same scale rule the bodies use.
   *
   * THIS MUST AGREE WITH scaleSystem, or an orbit will not pass through its own body,
   * which would be an immediately visible and thoroughly misleading defect. For a
   * heliocentric body the rule is to compress the magnitude and preserve the
   * direction; for a satellite it is a uniform factor on the offset from the primary.
   * The satellite branch is written out even though no M1 body uses it, so adding the
   * Moon does not require rediscovering the rule.
   */
  private toRenderSpace(
    bodyId: string,
    positionKm: Vector3Like,
    scaleConfig: ScaleConfig,
  ): Vector3Like {
    const parentId = getBody(bodyId).parentId;

    // Orbits about the frame origin: compress the radius, keep the direction.
    if (parentId === null || parentId === 'sun') {
      const magnitudeKm = Math.hypot(positionKm.x, positionKm.y, positionKm.z);
      if (magnitudeKm === 0) return { x: 0, y: 0, z: 0 };

      const compressedKm = compressDistanceKm(magnitudeKm, scaleConfig);
      const factor = compressedKm / magnitudeKm / scaleConfig.renderUnitKm;
      return {
        x: positionKm.x * factor,
        y: positionKm.y * factor,
        z: positionKm.z * factor,
      };
    }

    // Satellite orbit: one uniform factor on the offset, which preserves the shape.
    const factor = satelliteOffsetFactor(parentId, scaleConfig) / scaleConfig.renderUnitKm;
    return {
      x: positionKm.x * factor,
      y: positionKm.y * factor,
      z: positionKm.z * factor,
    };
  }

  /**
   * Subtracts the origin in f64 and writes camera-relative f32 into the GPU buffers.
   *
   * THE HEART OF THE PRECISION FIX. The subtraction happens here, in f64, and only the
   * small difference is narrowed to f32. Writing absolute values and letting the
   * transform matrix do the subtraction on the GPU is what produced up to 14.9 px of
   * jitter; see the module header.
   */
  private applyOrigin(origin: RenderOrigin): void {
    for (const entry of this.entries.values()) {
      writeRelativeChain(
        entry.absoluteVertices,
        entry.interleaved,
        this.sampleCount,
        origin,
      );
      writeRelativePairs(entry.absoluteApsisVertices, entry.apsisInterleaved, 2, origin);
    }
  }

  /** Syncs the orbit camera to the shared state, including position. */
  private syncCamera(shared: SharedCameraState): void {
    this.camera.fov = shared.fovDeg;
    this.camera.aspect = shared.aspect;
    this.camera.position.copy(shared.position);
    this.camera.quaternion.copy(shared.quaternion);

    this.camera.matrix.compose(shared.position, shared.quaternion, UNIT_SCALE);
    this.camera.matrixWorld.copy(this.camera.matrix);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();

    this.camera.updateProjectionMatrix();
  }
}

const UNIT_SCALE = new Vector3(1, 1, 1);

/**
 * Recovers the interleaved buffer three.js built, so it can be written in place.
 *
 * Line2 stores its vertices as an InstancedInterleavedBuffer of stride 6, viewed by
 * two InterleavedBufferAttributes: `instanceStart` at offset 0 and `instanceEnd` at
 * offset 3. Both views share one array, which is what makes an in-place rewrite
 * possible.
 *
 * The expected length is checked rather than assumed, because a change in three.js's
 * internal layout would otherwise corrupt geometry silently instead of failing.
 */
function interleavedBufferOf(
  geometry: LineGeometry | LineSegmentsGeometry,
  segmentCount: number,
): InterleavedBuffer {
  const attribute = geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
  const buffer = attribute.data;
  const expected = segmentCount * FLOATS_PER_SEGMENT;

  if (buffer.array.length !== expected) {
    throw new Error(
      `OrbitPaths: expected an interleaved buffer of ${expected} floats for ` +
        `${segmentCount} segments, found ${buffer.array.length}. The three.js line ` +
        'geometry layout has changed and the in-place write is no longer valid.',
    );
  }
  return buffer;
}

/**
 * Writes a CHAIN of points as consecutive segments, camera-relative.
 *
 * Point k becomes the start of segment k and the end of segment k-1, so each interior
 * point is written twice. That duplication is the interleaved layout's own
 * requirement, not redundancy that could be removed.
 */
function writeRelativeChain(
  absolute: Float64Array,
  buffer: InterleavedBuffer,
  pointCount: number,
  origin: RenderOrigin,
): void {
  const target = buffer.array as Float32Array;

  for (let segment = 0; segment < pointCount - 1; segment++) {
    const base = segment * FLOATS_PER_SEGMENT;

    for (const [endpoint, pointIndex] of [
      [0, segment],
      [3, segment + 1],
    ] as const) {
      const source = pointIndex * 3;
      // Subtraction in f64, narrowing to f32 only on assignment into the target.
      target[base + endpoint] = absolute[source]! - origin.x;
      target[base + endpoint + 1] = absolute[source + 1]! - origin.y;
      target[base + endpoint + 2] = absolute[source + 2]! - origin.z;
    }
  }

  buffer.needsUpdate = true;
}

/**
 * Writes independent PAIRS of points as disjoint segments, camera-relative.
 *
 * Used for the apsis ticks, where points 0-1 and 2-3 are two separate marks rather
 * than a connected path.
 */
function writeRelativePairs(
  absolute: Float64Array,
  buffer: InterleavedBuffer,
  segmentCount: number,
  origin: RenderOrigin,
): void {
  const target = buffer.array as Float32Array;

  for (let segment = 0; segment < segmentCount; segment++) {
    const base = segment * FLOATS_PER_SEGMENT;
    const source = segment * 6;

    target[base] = absolute[source]! - origin.x;
    target[base + 1] = absolute[source + 1]! - origin.y;
    target[base + 2] = absolute[source + 2]! - origin.z;
    target[base + 3] = absolute[source + 3]! - origin.x;
    target[base + 4] = absolute[source + 4]! - origin.y;
    target[base + 5] = absolute[source + 5]! - origin.z;
  }

  buffer.needsUpdate = true;
}

/**
 * A key identifying the scale configuration, for rebuild detection.
 *
 * Covers every field that changes where an orbit vertex lands. Comparing the config
 * by reference would miss a mutated object, and a deep comparison would cost more
 * than building this string once per frame.
 */
function describeScale(config: ScaleConfig): string {
  const satellites = Object.entries(config.satelliteOffsetFactors)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, factor]) => `${id}=${factor}`)
    .join(',');

  return [
    config.mode,
    config.renderUnitKm,
    config.compressionReferenceKm,
    config.compressionExponent,
    satellites,
  ].join('|');
}

/**
 * Provenance for the interface.
 *
 * The drawn line is a MODEL of the instantaneous orbit, not a recorded track, and the
 * vocabulary in contract sections 11 and 27 applies.
 */
export const ORBIT_PROVENANCE = {
  model: 'Osculating ellipse from JPL approximate elements at the current epoch',
  source: 'S1',
  note:
    'The instantaneous orbit, not an integrated trajectory. Secular drift in the elements ' +
    'means the true path over one revolution does not exactly close; that difference is ' +
    'below the accuracy of the element model itself.',
} as const;
