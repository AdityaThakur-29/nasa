/**
 * Layered slab cameras.
 *
 * Owns three PerspectiveCameras that share FOV, aspect ratio, orientation and
 * projection centre, and differ ONLY in their near and far planes. Contract
 * section 4 requires exactly that, and it is what makes the layers composite into
 * one coherent image rather than three unrelated views.
 *
 * THE PROPERTY THAT MAKES THIS WORK, verified numerically rather than assumed.
 * A standard perspective projection produces
 *
 *   x_clip = (cot(fov/2) / aspect) * x_view
 *   y_clip = cot(fov/2) * y_view
 *   w_clip = -z_view
 *
 * so NDC x and y are x_clip/w_clip and y_clip/w_clip, and NEITHER involves the
 * near or far plane. Only NDC z does. Measured across three cameras with planes
 * spanning 1e-7 to 1e18:
 *
 *   view point            NDC x, y (all three cameras)   NDC z
 *   (3, 2, -10)           0.407398539, 0.482842712       1.0000 / -199.0 / -199999.0
 *   (0.5, -0.25, -1e5)    0.000006790, -0.000006036      1.0000 / 0.9800 / -19.0
 *   (-100, 50, -4.4e6)   -0.000030864, 0.000027434       1.0000 / 0.9995 / 0.5455
 *
 * NOT BIT-IDENTICAL, AND WHY. The cancellation of the near plane is exact in
 * algebra but not in floating point. three.js builds the matrix as
 *
 *   top    = near * tan(fov/2)
 *   height = 2 * top
 *   width  = aspect * height
 *   m00    = 2 * near / width
 *
 * so `near` appears in both the numerator and the denominator and cancels only to
 * within rounding. Measured m00 at aspect 16/9, fov 45:
 *
 *   near = 1e-7   1.3579951288348659499
 *   near = 1e3    1.3579951288348661720   <- equals the analytic value
 *   near = 1e6    1.3579951288348661720
 *
 * Over 2000 randomised points the worst relative disagreement in NDC x or y
 * between the 1e-7 and 1e6 cameras was 4.346e-16, which is 2.0 units in the last
 * place. At a 1080-pixel viewport height that is 4.7e-13 pixels.
 *
 * The two consequences below therefore hold to twelve orders of magnitude beyond
 * anything observable, but the accurate statement is "the same pixel to within
 * 2 ULP", not "the same value".
 *
 *   1. Screen-space selection can use ANY of the three cameras, because they all
 *      project to the same pixel. The hybrid picker therefore needs one matrix,
 *      not three, and cannot disagree with itself across a slab boundary.
 *   2. A body straddling two slabs would land at the same pixel in both, so the
 *      only artefact of a bad split would be depth, not position. That is why
 *      contract section 4.1's one-object-one-slab rule is about depth
 *      correctness rather than geometric correctness.
 *
 * THIS MODULE MAY IMPORT THREE.JS. It is the render layer. The simulation layer
 * must not, and does not: everything under src/sim and src/ephemeris is free of
 * render types, which contract section 39 requires and the test suite asserts.
 */

import { PerspectiveCamera, Quaternion, Vector3, type WebGLRenderer } from 'three';
import {
  RENDER_ORDER,
  type DepthPlan,
  type SlabId,
  type SlabPlan,
} from './depth-slabs';

/** Camera state shared by all three slabs. */
export interface SharedCameraState {
  /** Vertical field of view, degrees. */
  readonly fovDeg: number;
  /** Viewport aspect ratio, width over height. */
  readonly aspect: number;
  /**
   * Camera position in ORIGIN-RELATIVE render space.
   *
   * Almost always the zero vector, because the floating origin tracks the camera.
   * Kept explicit rather than assumed: quantised origin tracking leaves the camera
   * up to half a grid cell from the origin, and a future two-camera stereo mode
   * would need a genuine offset.
   */
  readonly position: Vector3;
  /** Camera orientation. */
  readonly quaternion: Quaternion;
}

/** One slab's camera together with the plan that configured it. */
export interface SlabCamera {
  readonly id: SlabId;
  readonly camera: PerspectiveCamera;
  readonly plan: SlabPlan;
}

/**
 * Default vertical field of view, degrees.
 *
 * A presentation parameter, not a physical one. 45 degrees is a conventional
 * choice for a scientific visualisation: wide enough to establish context, narrow
 * enough to avoid the perspective distortion that makes a wide-angle view of
 * spheres look artificial.
 */
export const DEFAULT_FOV_DEG = 45;

/**
 * Manages the three slab cameras and the multi-pass render.
 *
 * The cameras are created once and mutated per frame. Recreating them would
 * discard three.js's internal matrix caches every frame for no benefit.
 */
export class LayeredCameras {
  private readonly cameras: Map<SlabId, PerspectiveCamera>;

  /**
   * The camera used for screen-space projection.
   *
   * Any of the three would give identical NDC x and y, as measured above. One is
   * nominated so callers cannot accidentally introduce an inconsistency by picking
   * a different camera on different frames.
   */
  private readonly projectionReference: PerspectiveCamera;

  private shared: SharedCameraState;

  constructor(initial?: Partial<SharedCameraState>) {
    this.shared = {
      fovDeg: initial?.fovDeg ?? DEFAULT_FOV_DEG,
      aspect: initial?.aspect ?? 1,
      position: initial?.position?.clone() ?? new Vector3(0, 0, 0),
      quaternion: initial?.quaternion?.clone() ?? new Quaternion(),
    };

    this.cameras = new Map();
    for (const id of RENDER_ORDER) {
      const camera = new PerspectiveCamera(this.shared.fovDeg, this.shared.aspect, 1, 1000);
      // Matrices are driven explicitly from the shared state each frame, so
      // three.js must not also update them from its own scene-graph traversal.
      camera.matrixAutoUpdate = false;
      this.cameras.set(id, camera);
    }

    // The near slab is nominated because it is the one guaranteed to exist in any
    // scene containing something close to the camera, and because its planes are
    // the tightest, which keeps its NDC z meaningful for the rare caller that
    // wants depth as well as position.
    this.projectionReference = this.cameras.get('NEAR')!;
    this.applyShared();
  }

  /** The camera for a slab. */
  cameraFor(slabId: SlabId): PerspectiveCamera {
    const camera = this.cameras.get(slabId);
    if (camera === undefined) {
      throw new Error(`LayeredCameras: no camera for slab "${slabId}"`);
    }
    return camera;
  }

  /**
   * The camera to use for screen-space projection.
   *
   * Safe for selection because NDC x and y do not depend on the near or far plane.
   * See the module header for the measurements.
   */
  get projectionCamera(): PerspectiveCamera {
    return this.projectionReference;
  }

  /** The shared state currently applied. */
  get sharedState(): SharedCameraState {
    return this.shared;
  }

  /**
   * Updates the properties every camera shares.
   *
   * Position and quaternion are COPIED rather than referenced, so a caller mutating
   * its own vector after the call cannot desynchronise the cameras from each other.
   */
  setShared(next: Partial<SharedCameraState>): void {
    this.shared = {
      fovDeg: next.fovDeg ?? this.shared.fovDeg,
      aspect: next.aspect ?? this.shared.aspect,
      position: next.position?.clone() ?? this.shared.position,
      quaternion: next.quaternion?.clone() ?? this.shared.quaternion,
    };
    this.applyShared();
  }

  /** Convenience for a resize. */
  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) {
      throw new Error(`LayeredCameras: aspect must be positive and finite, got ${aspect}`);
    }
    this.setShared({ aspect });
  }

  /**
   * Applies a frame's depth plan to the cameras.
   *
   * Only non-empty slabs are configured. An empty slab's camera keeps its previous
   * planes, which is harmless because nothing is rendered with it, and is preferable
   * to writing zeroes that would produce a degenerate projection if it were used by
   * mistake.
   *
   * @returns the slab cameras to render, already in far-to-near order
   */
  applyPlan(plan: DepthPlan): readonly SlabCamera[] {
    const active: SlabCamera[] = [];

    for (const slab of plan.nonEmpty) {
      const camera = this.cameraFor(slab.id);

      if (camera.near !== slab.near || camera.far !== slab.far) {
        camera.near = slab.near;
        camera.far = slab.far;
        camera.updateProjectionMatrix();
      }

      active.push({ id: slab.id, camera, plan: slab });
    }

    return active;
  }

  /**
   * Renders one frame across the slabs.
   *
   * THE COMPOSITING CONTRACT, from section 4.2:
   *
   *   - colour and depth are cleared ONCE, before the first slab
   *   - slabs render far to near
   *   - depth is cleared between slabs, colour is NOT
   *   - empty slabs are skipped entirely, so they cost no clear
   *
   * The caller supplies the per-slab draw callback, so this module stays unaware of
   * what a scene contains. It owns the ordering and the clears, nothing else.
   *
   * `renderer.autoClear` must already be false; that is asserted rather than set,
   * because silently changing a renderer flag from inside a helper is the kind of
   * action that makes a rendering bug hard to locate.
   */
  renderFrame(
    renderer: WebGLRenderer,
    plan: DepthPlan,
    drawSlab: (slab: SlabCamera) => void,
    options: { readonly clearFirst?: boolean } = {},
  ): number {
    if (renderer.autoClear) {
      throw new Error(
        'LayeredCameras.renderFrame: renderer.autoClear must be false, or each slab would ' +
          'clear the colour buffer and only the last would remain visible',
      );
    }

    const active = this.applyPlan(plan);
    if (active.length === 0) return 0;

    if (options.clearFirst !== false) {
      // Colour, depth and stencil, once for the whole frame.
      renderer.clear(true, true, true);
    }

    let depthClears = 0;
    for (const [index, slab] of active.entries()) {
      if (index > 0) {
        // Depth only. Clearing colour here would discard every slab drawn so far.
        renderer.clearDepth();
        depthClears += 1;
      }
      drawSlab(slab);
    }

    return depthClears;
  }

  /**
   * Pushes the shared state onto all three cameras.
   *
   * Matrices are composed by hand rather than left to three.js, because
   * matrixAutoUpdate is off. Doing it here guarantees the three cameras are
   * byte-identical in everything but their projection.
   */
  private applyShared(): void {
    const { fovDeg, aspect, position, quaternion } = this.shared;
    const unitScale = new Vector3(1, 1, 1);

    for (const camera of this.cameras.values()) {
      camera.fov = fovDeg;
      camera.aspect = aspect;
      camera.position.copy(position);
      camera.quaternion.copy(quaternion);

      camera.matrix.compose(position, quaternion, unitScale);
      camera.matrixWorld.copy(camera.matrix);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

      camera.updateProjectionMatrix();
    }
  }
}

/** Result of checking that the cameras really do share what they must. */
export interface CameraConsistency {
  readonly consistent: boolean;
  readonly problems: readonly string[];
}

/**
 * Verifies the invariant contract section 4 states: all cameras share FOV, aspect,
 * orientation and projection centre, and differ only in near and far.
 *
 * Returns a report rather than throwing, so it can be asserted in tests and logged
 * in development without becoming a runtime failure mode.
 */
export function verifyCameraConsistency(cameras: LayeredCameras): CameraConsistency {
  const problems: string[] = [];
  const reference = cameras.cameraFor(RENDER_ORDER[0]!);

  for (const id of RENDER_ORDER.slice(1)) {
    const camera = cameras.cameraFor(id);

    if (camera.fov !== reference.fov) {
      problems.push(`${id} fov ${camera.fov} differs from ${reference.fov}`);
    }
    if (camera.aspect !== reference.aspect) {
      problems.push(`${id} aspect ${camera.aspect} differs from ${reference.aspect}`);
    }
    if (camera.position.distanceTo(reference.position) !== 0) {
      problems.push(`${id} position differs from the reference camera`);
    }
    if (camera.quaternion.angleTo(reference.quaternion) !== 0) {
      problems.push(`${id} orientation differs from the reference camera`);
    }
  }

  return { consistent: problems.length === 0, problems };
}

/**
 * Projects an origin-relative render position to normalised device coordinates.
 *
 * Uses the nominated projection camera. Returns NDC in [-1, 1] for points inside
 * the frustum, and the w component so callers can reject points behind the camera.
 *
 * BEHIND-CAMERA POINTS. A point with negative view-space depth projects to a valid
 * looking NDC pair with negative w, which is how a body behind the camera can
 * appear to be selectable at a plausible pixel. The w component is therefore
 * returned rather than discarded, and the picker rejects on its sign.
 */
export function projectToNdc(
  cameras: LayeredCameras,
  originRelativePosition: Vector3,
): { readonly x: number; readonly y: number; readonly z: number; readonly w: number } {
  const camera = cameras.projectionCamera;

  // View space, then clip space, done explicitly so w survives. Vector3.project
  // divides by w internally and discards it.
  const view = originRelativePosition.clone().applyMatrix4(camera.matrixWorldInverse);
  const w = -view.z;

  const clip = view.clone().applyMatrix4(camera.projectionMatrix);
  // applyMatrix4 on a Vector3 already performs the perspective divide, so clip is
  // NDC. Recovering w separately from view space is what the line above is for.
  return { x: clip.x, y: clip.y, z: clip.z, w };
}

/** Converts NDC to pixel coordinates, with y measured downward from the top. */
export function ndcToPixels(
  ndcX: number,
  ndcY: number,
  widthPx: number,
  heightPx: number,
): { readonly x: number; readonly y: number } {
  return {
    x: (ndcX * 0.5 + 0.5) * widthPx,
    y: (1 - (ndcY * 0.5 + 0.5)) * heightPx,
  };
}

/**
 * Apparent radius of a sphere in pixels.
 *
 * Used to decide when a body falls below the sub-pixel threshold and needs a
 * marker instead of geometry. Contract section 8.
 *
 * The exact projected silhouette of a sphere is an ellipse whose semi-minor axis
 * is r*d/sqrt(d^2-r^2) rather than r, but that correction only matters when the
 * camera is close enough for the sphere to fill much of the view, and in that
 * regime the body is thousands of pixels across and the threshold is irrelevant.
 * The simple form is used, and the approximation is stated rather than hidden.
 */
export function apparentRadiusPixels(
  radiusUnits: number,
  distanceUnits: number,
  fovDeg: number,
  heightPx: number,
): number {
  if (distanceUnits <= 0) {
    throw new Error(`apparentRadiusPixels: distance must be positive, got ${distanceUnits}`);
  }
  const halfHeightAtDistance = distanceUnits * Math.tan((fovDeg * Math.PI) / 360);
  return (radiusUnits / halfHeightAtDistance) * (heightPx / 2);
}
