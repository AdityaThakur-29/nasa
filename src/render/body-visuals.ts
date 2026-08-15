/**
 * Body visuals: spheres, sub-pixel markers, and the Sun.
 *
 * WHAT THIS MODULE OWNS. One mesh per body, one marker point cloud per depth slab,
 * and the per-frame decision about which of the two represents each body. It also
 * assigns every object to its slab's render layer.
 *
 * SLAB ASSIGNMENT USES THREE.JS LAYERS rather than three separate scenes or
 * per-pass visibility toggling. A camera with `layers.set(n)` renders only objects
 * on layer n, so switching slabs costs one integer write per object and no
 * scene-graph mutation. Moving meshes between scenes would invalidate three.js's
 * internal render lists every frame; toggling `visible` would work but requires
 * three passes over every object instead of one.
 *
 * GEOMETRY IS SHARED. A single unit sphere is instanced by transform rather than
 * one buffer per body. Ten separate sphere buffers would waste memory for no
 * benefit, and sharing makes the M4 level-of-detail swap a matter of exchanging one
 * geometry rather than ten.
 *
 * OBLATENESS IS APPLIED, because the IAU triaxial radii are already in the data
 * layer and the flattening is visible: 0.098 for Saturn and 0.065 for Jupiter. A
 * non-uniform scale on the shared unit sphere costs one extra line and is more
 * faithful than drawing gas giants as spheres. The scale is normalised by each
 * body's mean radius so its apparent size still matches visualRadius.
 *
 * ILLUMINATION. The Sun's light uses decay 0, meaning no distance falloff from the
 * renderer, and each body's albedo is multiplied by the irradiance computed from its
 * PHYSICAL distance in sim/irradiance.ts. For a Lambertian surface the outgoing
 * radiance is albedo times irradiance times the cosine term, so folding irradiance
 * into the albedo and leaving the cosine to the light is exactly correct, and it
 * stays correct in visualized scale where render distances are compressed. Relying
 * on the renderer's own inverse-square falloff would over-brighten Neptune by a
 * measured factor of 42.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointLight,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { BodySimState, SimulationSnapshot } from '../sim/state';
import type { ScaledBody } from '../sim/scale';
import type { BodyIllumination } from '../sim/irradiance';
import { RENDER_SUN_LIGHT_CALIBRATION } from '../sim/irradiance';
import { getBody } from '../data/bodies';
import { getRotationRecord } from '../data/iau-rotation';
import type { DepthPlan, SlabId } from './depth-slabs';
import { RENDER_ORDER } from './depth-slabs';
import type { RenderOrigin } from './floating-origin';
import { apparentRadiusPixels } from './layered-cameras';
import { SLAB_LAYERS, STARFIELD_LAYER, UNASSIGNED_LAYER } from './layers';

/**
 * Layer constants come from ./layers and are re-exported for existing importers.
 *
 * They live there so that both the objects being drawn and the cameras drawing them can
 * depend on ONE definition. An earlier revision defined them in this module, which meant
 * layered-cameras.ts could not import them without creating a cycle, so the slab cameras
 * were left on the default layer and every planet became invisible. Two independent copies
 * of these numbers could drift apart and resurrect exactly that bug.
 */
export { SLAB_LAYERS, STARFIELD_LAYER, UNASSIGNED_LAYER };

/**
 * Projected DIAMETER below which a body is drawn as a marker instead of geometry.
 *
 * Contract section 8 names 2 pixels. Below that a sphere covers at most a handful of
 * fragments, its shading is meaningless, and it may miss the pixel grid entirely and
 * flicker between frames.
 */
export const MARKER_DIAMETER_THRESHOLD_PX = 2;

/**
 * Marker size in pixels, before any magnitude adjustment.
 *
 * A presentation parameter. Small enough to read as a point rather than a disc, and
 * large enough to survive antialiasing.
 */
export const MARKER_BASE_SIZE_PX = 4;

/**
 * Largest a marker may grow, pixels.
 *
 * Bounded so a bright body cannot be drawn as a disc that might be mistaken for its
 * actual angular size. Contract section 8 requires markers not to be presentable as
 * the physical diameter.
 */
export const MARKER_MAX_SIZE_PX = 7;

/** Smallest a marker may shrink, pixels. Below this it would not reliably render. */
export const MARKER_MIN_SIZE_PX = 1;

/**
 * Reference absolute magnitude for marker scaling.
 *
 * The MIDPOINT of the published planetary V(1,0) range, which runs from -9.40 for
 * Jupiter to -0.60 for Mercury and therefore centres on -5.00. Bodies brighter than
 * this scale up, dimmer ones down.
 *
 * AN EARLIER VALUE OF -1.5 WAS WRONG, and wrong in a way that defeated the feature.
 * -1.5 is roughly Mars, which sits near the DIM end of the range rather than in the
 * middle, so almost every body was brighter than the reference and scaled upward into
 * the MAX_SIZE clamp. Measured, with the old reference and an exponent of 0.25:
 *
 *   jupiter  raw 24.66  ->  7.00  CLAMPED
 *   saturn   raw 21.88  ->  7.00  CLAMPED
 *   uranus   raw 14.83  ->  7.00  CLAMPED
 *   neptune  raw 13.77  ->  7.00  CLAMPED
 *   venus    raw  7.93  ->  7.00  CLAMPED
 *   earth    raw  6.89  ->  6.89
 *   mars     raw  4.02  ->  4.02
 *   mercury  raw  3.25  ->  3.25
 *
 * Five of eight bodies came out at exactly the same size, so the four brightest
 * planets were visually indistinguishable and the magnitude data was doing nothing.
 */
const MARKER_REFERENCE_MAGNITUDE = -5.0;

/**
 * Exponent compressing relative brightness into marker size.
 *
 * The planetary V(1,0) span of 8.8 magnitudes is a factor of about 3400 in brightness,
 * and it has to fit into the range from MARKER_MIN_SIZE_PX to MARKER_MAX_SIZE_PX, a
 * factor of 7. That needs heavy compression: 3400^k = 7 gives k of about 0.24 for the
 * full range, and less once the reference is centred.
 *
 * MEASURED at 0.13, with the reference at -5.0:
 *
 *   jupiter  6.77    venus    3.75
 *   saturn   6.37    earth    3.49
 *   uranus   5.20    mars     2.64
 *   neptune  5.00    mercury  2.36
 *
 * Strictly decreasing with magnitude, and nothing clamped at either end, so every
 * body's marker carries information about its brightness.
 */
const MARKER_BRIGHTNESS_EXPONENT = 0.13;

/**
 * Placeholder albedo colours for the untextured M1 spheres.
 *
 * NOT MEASURED DATA, and deliberately not placed in src/data. These are presentation
 * choices standing in for the real imagery that arrives in M2, and
 * src/data/sources.md records that render parameters carry no provenance because
 * they assert nothing about the physical world. They are loosely informed by each
 * body's published geometric albedo and general appearance, but no claim is made
 * beyond that and the interface must never present them as measured colour.
 */
const PLACEHOLDER_COLOURS: Readonly<Record<string, number>> = {
  sun: 0xfff4ea,
  mercury: 0x8c8680,
  venus: 0xe8d5a8,
  earth: 0x4a7ba7,
  moon: 0x9a9a94,
  mars: 0xa8583a,
  jupiter: 0xc9a87c,
  saturn: 0xd6c295,
  uranus: 0x9fc4c9,
  neptune: 0x5878b4,
};

/** Sphere tessellation for the M1 placeholder geometry. */
const SPHERE_WIDTH_SEGMENTS = 64;
const SPHERE_HEIGHT_SEGMENTS = 32;

/** Everything the body visuals need for one frame. */
export interface BodyFrameInput {
  readonly snapshot: SimulationSnapshot;
  readonly scaled: readonly ScaledBody[];
  readonly illumination: readonly BodyIllumination[];
  readonly plan: DepthPlan;
  readonly origin: RenderOrigin;
  /** Camera position in absolute render space. */
  readonly cameraRenderPosition: Vector3;
  readonly fovDeg: number;
  readonly viewportHeightPx: number;
}

/** Per-body outcome of a frame, for diagnostics and the interface. */
export interface BodyVisualState {
  readonly bodyId: string;
  readonly slab: SlabId;
  /** Apparent radius in pixels. */
  readonly apparentRadiusPx: number;
  /** True when the body was drawn as a marker rather than as geometry. */
  readonly drawnAsMarker: boolean;
  /** Distance from the camera in render units. */
  readonly cameraDistance: number;
}

/**
 * One slab's marker point cloud and its backing buffers.
 *
 * ONE BUFFER PER SLAB, not one shared across slabs. A single Points object cannot be
 * split across layers, so sharing it would mean enabling it on every occupied slab
 * layer and drawing it once per slab pass. With additive blending and depth writing
 * disabled, a marker that survives the depth test in two passes is blended TWICE and
 * comes out at double brightness. The depth clear between slabs guarantees it
 * survives every pass, so that bug would fire on every frame with markers in more
 * than one slab.
 *
 * Per-slab buffers cost at most three draw calls for objects that are a few pixels
 * each, which is negligible, and each marker is then blended exactly once.
 */
interface MarkerBuffer {
  readonly geometry: BufferGeometry;
  readonly points: Points;
  readonly positions: Float32Array;
  readonly sizes: Float32Array;
  readonly colours: Float32Array;
  /** Markers written this frame. Reset at the start of every update. */
  count: number;
}

/**
 * Manages the mesh, marker and light objects for every body.
 *
 * Objects are created once and mutated per frame. Recreating them would discard
 * three.js's geometry and program caches on every update.
 */
export class BodyVisuals {
  private readonly sphereGeometry: SphereGeometry;
  private readonly meshes = new Map<string, Mesh>();

  /**
   * Materials, typed as a union rather than cast.
   *
   * The Sun takes a MeshBasicMaterial because it emits; every other body takes a
   * MeshStandardMaterial because it reflects. An earlier revision stored them all as
   * MeshStandardMaterial via `as unknown as`, which silently claimed the Sun's
   * material had roughness and metalness properties it does not have. The union is
   * honest, and both members share the `color` field applyIllumination touches.
   */
  private readonly materials = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();
  private readonly baseColours = new Map<string, Color>();

  /** One marker cloud per slab. See MarkerBuffer for why they are not shared. */
  private readonly markerBuffers = new Map<SlabId, MarkerBuffer>();

  /**
   * One shader for every marker cloud.
   *
   * Safe to share, unlike the buffers: all per-marker data lives in vertex
   * attributes, so the material carries no per-object state. Sharing also means the
   * shader is compiled once rather than three times.
   */
  private readonly markerMaterial: ShaderMaterial;

  private readonly sunLight: PointLight;
  private lastFrame: BodyVisualState[] = [];

  constructor(
    private readonly scene: Scene,
    bodyIds: readonly string[],
  ) {
    this.sphereGeometry = new SphereGeometry(1, SPHERE_WIDTH_SEGMENTS, SPHERE_HEIGHT_SEGMENTS);

    for (const bodyId of bodyIds) {
      const colour = new Color(PLACEHOLDER_COLOURS[bodyId] ?? 0x888888);
      this.baseColours.set(bodyId, colour.clone());

      // The Sun emits rather than reflects, so it takes an unlit material. A standard
      // material would make it a dark sphere lit by its own light at zero distance.
      const material =
        bodyId === 'sun'
          ? new MeshBasicMaterial({ color: colour })
          : new MeshStandardMaterial({ color: colour, roughness: 0.85, metalness: 0 });

      const mesh = new Mesh(this.sphereGeometry, material);
      // Transforms are written explicitly each frame, so three.js must not also
      // derive them from its own traversal.
      mesh.matrixAutoUpdate = false;
      // Culling is decided by slab classification, which already accounts for the
      // floating origin. three.js's own culling would use stale world matrices.
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.name = `body:${bodyId}`;

      this.meshes.set(bodyId, mesh);
      this.materials.set(bodyId, material);
      scene.add(mesh);
    }

    this.markerMaterial = new ShaderMaterial({
      transparent: true,
      // Depth TEST on, so a marker for a body behind the Sun is correctly hidden.
      depthTest: true,
      // Depth WRITE off, so markers do not occlude each other or nearby geometry.
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: MARKER_VERTEX_SHADER,
      fragmentShader: MARKER_FRAGMENT_SHADER,
    });

    // Capacity is the full body count per slab: in the worst case every body is a
    // marker and every marker lands in the same slab.
    for (const slabId of RENDER_ORDER) {
      this.markerBuffers.set(slabId, this.createMarkerBuffer(slabId, bodyIds.length));
    }

    // Intensity is a documented render calibration, and decay 0 disables the
    // renderer's own falloff because irradiance is supplied per body instead.
    this.sunLight = new PointLight(
      0xfff4ea,
      RENDER_SUN_LIGHT_CALIBRATION.intensity,
      0,
      RENDER_SUN_LIGHT_CALIBRATION.decay,
    );
    this.sunLight.name = 'sun-light';
    // The Sun illuminates bodies in every slab, so the light must be visible to all
    // of them.
    this.sunLight.layers.disableAll();
    for (const slabId of RENDER_ORDER) this.sunLight.layers.enable(SLAB_LAYERS[slabId]);
    scene.add(this.sunLight);
  }

  /** Per-body outcome of the most recent update. */
  get frameState(): readonly BodyVisualState[] {
    return this.lastFrame;
  }

  /** A body's mesh, or undefined if the body is not visualised. */
  meshFor(bodyId: string): Mesh | undefined {
    return this.meshes.get(bodyId);
  }

  /** A slab's marker point cloud, for tests and diagnostics. */
  markersFor(slabId: SlabId): Points {
    const buffer = this.markerBuffers.get(slabId);
    if (buffer === undefined) {
      throw new Error(`BodyVisuals: no marker buffer for slab "${slabId}"`);
    }
    return buffer.points;
  }

  /** The Sun's light, for tests and diagnostics. */
  get light(): PointLight {
    return this.sunLight;
  }

  /**
   * Updates every body for one frame.
   *
   * ORDER MATTERS. Positions are made camera-relative in f64 before anything is
   * written to a three.js object, so no absolute render coordinate ever reaches a
   * float32 buffer.
   */
  update(input: BodyFrameInput): readonly BodyVisualState[] {
    const {
      snapshot,
      scaled,
      illumination,
      plan,
      origin,
      cameraRenderPosition,
      fovDeg,
      viewportHeightPx,
    } = input;

    const physicalById = new Map(snapshot.bodies.map((body) => [body.bodyId, body]));
    const illuminationById = new Map(illumination.map((entry) => [entry.bodyId, entry]));

    for (const buffer of this.markerBuffers.values()) buffer.count = 0;

    const frameState: BodyVisualState[] = [];

    for (const body of scaled) {
      const mesh = this.meshes.get(body.bodyId);
      const physical = physicalById.get(body.bodyId);
      if (mesh === undefined || physical === undefined) continue;

      const slab = plan.assignment.get(body.bodyId);
      if (slab === undefined) {
        // Not classified, so not renderable this frame. Hiding it is correct; a body
        // left on a stale layer would be drawn with the wrong frustum.
        mesh.visible = false;
        continue;
      }

      // Camera-relative, computed in f64 before it reaches any float32 buffer.
      const relativeX = body.renderPosition.x - origin.x;
      const relativeY = body.renderPosition.y - origin.y;
      const relativeZ = body.renderPosition.z - origin.z;

      const cameraDistance = Math.hypot(
        body.renderPosition.x - cameraRenderPosition.x,
        body.renderPosition.y - cameraRenderPosition.y,
        body.renderPosition.z - cameraRenderPosition.z,
      );

      // A camera exactly at a body centre has no meaningful apparent size. Treating
      // it as infinite draws geometry rather than a marker, which is right: the
      // camera is inside the body.
      const apparentRadiusPx =
        cameraDistance > 0
          ? apparentRadiusPixels(body.visualRadius, cameraDistance, fovDeg, viewportHeightPx)
          : Number.POSITIVE_INFINITY;

      const drawnAsMarker = apparentRadiusPx * 2 < MARKER_DIAMETER_THRESHOLD_PX;

      mesh.layers.set(SLAB_LAYERS[slab]);

      if (drawnAsMarker) {
        // Only the marker is drawn. Drawing both would make the sphere and the marker
        // contend for the same few fragments.
        mesh.visible = false;
        this.writeMarker(slab, body.bodyId, relativeX, relativeY, relativeZ);
      } else {
        mesh.visible = true;
        this.applyTransform(mesh, physical, body, relativeX, relativeY, relativeZ);
        this.applyIllumination(body.bodyId, illuminationById.get(body.bodyId));
      }

      frameState.push({
        bodyId: body.bodyId,
        slab,
        apparentRadiusPx,
        drawnAsMarker,
        cameraDistance,
      });
    }

    this.commitMarkers();
    this.positionSunLight(scaled, origin);

    this.lastFrame = frameState;
    return frameState;
  }

  /** Releases every GPU resource this object owns. */
  dispose(): void {
    this.sphereGeometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const mesh of this.meshes.values()) this.scene.remove(mesh);

    for (const buffer of this.markerBuffers.values()) {
      buffer.geometry.dispose();
      this.scene.remove(buffer.points);
    }
    this.markerMaterial.dispose();

    this.scene.remove(this.sunLight);
  }

  /** Creates one slab's marker cloud, permanently bound to that slab's layer. */
  private createMarkerBuffer(slabId: SlabId, capacity: number): MarkerBuffer {
    const positions = new Float32Array(capacity * 3);
    const sizes = new Float32Array(capacity);
    const colours = new Float32Array(capacity * 3);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('markerSize', new BufferAttribute(sizes, 1));
    geometry.setAttribute('markerColour', new BufferAttribute(colours, 3));
    geometry.setDrawRange(0, 0);

    const points = new Points(geometry, this.markerMaterial);
    points.frustumCulled = false;
    points.visible = false;
    points.name = `body-markers:${slabId}`;
    // Set once and never changed, which is what keeps each marker in exactly one
    // slab pass and therefore blended exactly once.
    points.layers.set(SLAB_LAYERS[slabId]);
    this.scene.add(points);

    return { geometry, points, positions, sizes, colours, count: 0 };
  }

  /** Appends one marker to a slab's buffer. */
  private writeMarker(
    slabId: SlabId,
    bodyId: string,
    x: number,
    y: number,
    z: number,
  ): void {
    const buffer = this.markerBuffers.get(slabId);
    if (buffer === undefined) return;

    const index = buffer.count;
    if (index * 3 + 2 >= buffer.positions.length) return;

    buffer.positions[index * 3] = x;
    buffer.positions[index * 3 + 1] = y;
    buffer.positions[index * 3 + 2] = z;

    buffer.sizes[index] = markerSizeFor(bodyId);

    const colour = this.baseColours.get(bodyId);
    buffer.colours[index * 3] = colour?.r ?? 1;
    buffer.colours[index * 3 + 1] = colour?.g ?? 1;
    buffer.colours[index * 3 + 2] = colour?.b ?? 1;

    buffer.count = index + 1;
  }

  /** Uploads whatever each slab's buffer received this frame. */
  private commitMarkers(): void {
    for (const buffer of this.markerBuffers.values()) {
      buffer.geometry.setDrawRange(0, buffer.count);
      buffer.points.visible = buffer.count > 0;
      if (buffer.count === 0) continue;

      for (const name of ['position', 'markerSize', 'markerColour'] as const) {
        const attribute = buffer.geometry.getAttribute(name) as BufferAttribute;
        attribute.needsUpdate = true;
        // Upload only the range actually written, so a single body crossing the
        // threshold does not re-send the whole buffer.
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, buffer.count * attribute.itemSize);
      }
    }
  }

  /**
   * Writes a body's transform, applying orientation and oblateness.
   *
   * The scale is non-uniform, taken from the IAU triaxial radii, and is normalised by
   * the mean radius so the volumetric size still corresponds to visualRadius.
   * Orientation is the body-fixed to ecliptic rotation the simulation already
   * computed, so the flattening lands on the body's own polar axis rather than on
   * world Z.
   */
  private applyTransform(
    mesh: Mesh,
    physical: BodySimState,
    scaledBody: ScaledBody,
    x: number,
    y: number,
    z: number,
  ): void {
    const rotation = getRotationRecord(physical.bodyId);
    const meanKm = getBody(physical.bodyId).meanRadiusKm.value;

    // Ratios of the published semi-axes to the mean radius. Both equal one for a body
    // the IAU models as a sphere, so the scale is uniform in that case.
    const equatorial = scaledBody.visualRadius * (rotation.radii.aKm / meanKm);
    const polar = scaledBody.visualRadius * (rotation.radii.cKm / meanKm);

    mesh.position.set(x, y, z);
    // The simulation supplies a quaternion in the same ecliptic frame the render
    // positions use, so no further frame conversion is needed here.
    mesh.quaternion.set(
      physical.orientationQuaternion.x,
      physical.orientationQuaternion.y,
      physical.orientationQuaternion.z,
      physical.orientationQuaternion.w,
    );
    // A sphere's local Z is its polar axis, matching the IAU convention that the
    // rotation matrix's third column is the north pole.
    mesh.scale.set(equatorial, equatorial, polar);
    mesh.updateMatrix();
  }

  /**
   * Folds computed irradiance into a body's albedo.
   *
   * Correct for a Lambertian surface: outgoing radiance is albedo times irradiance
   * times the cosine of the incidence angle, and the light supplies the cosine. The
   * Sun is skipped because it emits.
   */
  private applyIllumination(bodyId: string, illumination: BodyIllumination | undefined): void {
    if (bodyId === 'sun' || illumination === undefined) return;

    const material = this.materials.get(bodyId);
    const base = this.baseColours.get(bodyId);
    if (material === undefined || base === undefined) return;

    const factor = illumination.brightnessFactor;
    material.color.setRGB(base.r * factor, base.g * factor, base.b * factor);
  }

  /**
   * Places the Sun's light at the Sun's camera-relative position.
   *
   * The light must move with the floating origin like everything else, or its
   * direction would be wrong by the origin offset.
   */
  private positionSunLight(scaled: readonly ScaledBody[], origin: RenderOrigin): void {
    const sun = scaled.find((body) => body.bodyId === 'sun');
    if (sun === undefined) return;

    this.sunLight.position.set(
      sun.renderPosition.x - origin.x,
      sun.renderPosition.y - origin.y,
      sun.renderPosition.z - origin.z,
    );
  }
}

/**
 * Marker size in pixels for a body.
 *
 * Scaled by absolute magnitude where the data layer has one, so the brightness
 * ordering of the markers reflects real apparent brightness. Contract section 8 asks
 * for this "where data is available", and it explicitly is not available for the
 * Moon, so that case falls back to the base size rather than to an invented
 * magnitude.
 *
 * The magnitude scale is logarithmic: five magnitudes is a factor of one hundred in
 * brightness. Marker size therefore varies with the fourth root of relative
 * brightness, which compresses the planetary range of about nine magnitudes into the
 * few pixels the bounds allow.
 */
export function markerSizeFor(bodyId: string): number {
  let magnitude: number | undefined;
  try {
    magnitude = getBody(bodyId).absoluteMagnitudeV10?.value;
  } catch {
    // An unknown body is a caller error elsewhere, not a reason to fail a frame.
    magnitude = undefined;
  }

  if (magnitude === undefined) return MARKER_BASE_SIZE_PX;

  // Brighter is more negative, so a body brighter than the reference gets a positive
  // exponent and therefore a larger marker.
  const relativeBrightness = 10 ** ((MARKER_REFERENCE_MAGNITUDE - magnitude) / 2.5);
  const scaled = MARKER_BASE_SIZE_PX * relativeBrightness ** MARKER_BRIGHTNESS_EXPONENT;

  return Math.min(MARKER_MAX_SIZE_PX, Math.max(MARKER_MIN_SIZE_PX, scaled));
}

/**
 * Marker vertex shader.
 *
 * Size is set in PIXELS directly, with no perspective division, so a marker keeps a
 * constant screen size regardless of distance. That is the point of a marker: it
 * indicates presence, not angular size, and contract section 8 requires it not be
 * presentable as the physical diameter.
 */
const MARKER_VERTEX_SHADER = /* glsl */ `
  attribute float markerSize;
  attribute vec3 markerColour;

  varying vec3 vColour;

  void main() {
    vColour = markerColour;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = markerSize;
  }
`;

/**
 * Marker fragment shader.
 *
 * A radial falloff rather than a filled square, so the marker reads as a soft point.
 * Fragments outside the unit circle are discarded so it does not show as a blended
 * quad against the star field.
 */
const MARKER_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColour;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float radius = length(offset) * 2.0;
    if (radius > 1.0) discard;

    // Smooth edge, with a brighter core so the centre reads as the body position.
    float alpha = pow(1.0 - radius, 1.5);
    gl_FragColor = vec4(vColour, alpha);
  }
`;
