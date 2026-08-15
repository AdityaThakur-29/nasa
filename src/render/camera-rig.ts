/**
 * Camera rig.
 *
 * WHAT IT OWNS. The camera's absolute render-space position and orientation, the
 * navigation modes contract section 1.4 requires, and the eased transitions between
 * them. It does not own the three.js cameras: LayeredCameras does, and this rig feeds
 * it a SharedCameraState each frame.
 *
 * Z IS UP. The simulation frame is the J2000 ecliptic with Z toward ecliptic north, so
 * the rig works in that frame throughout and converts to a camera quaternion at the
 * boundary. three.js cameras assume Y-up by default and Object3D.lookAt bakes that in,
 * so the look-at basis is constructed explicitly here rather than delegated. Verified:
 * a camera at (10,0,0) looking at the origin yields a forward vector of exactly
 * (-1,0,0) and an up vector of exactly (0,0,1).
 *
 * POSITION IS ABSOLUTE, IN f64. The rig is the authority on where the camera is, and
 * the floating origin is derived FROM it rather than the other way round. Everything
 * downstream receives camera-relative coordinates; this module is the one place that
 * legitimately holds a large coordinate, and it holds it as a plain number so it stays
 * f64.
 *
 * TWO MODES, NOT FIVE. Contract section 1.4 lists orbit, pan, dolly, focus, follow,
 * free flight, reset and fly-to, but those are not all the same kind of thing:
 *
 *   ORBIT  the camera looks at a target point from a distance, and orbit, pan, dolly,
 *          focus and follow are all operations on that arrangement. Follow is not a
 *          separate mode at all: it is orbit with a target that tracks a moving body.
 *   FREE   the camera has its own position and orientation and moves in its own frame.
 *
 * Fly-to and reset are transitions, not modes. Collapsing them this way means there is
 * one state machine rather than five, and no combination of flags that has no meaning.
 *
 * DISTANCE INTERPOLATES LOGARITHMICALLY, which is the difference between a usable
 * fly-to and an unusable one. A transition from a Neptune overview at 4.4e6 units to an
 * Earth close-up at 3 units, interpolated linearly, is still at 2.2e6 units halfway
 * through: the entire visible motion happens in the last few percent. Interpolated in
 * log space the halfway point is sqrt(4.4e6 * 3), about 3633 units, which is genuinely
 * halfway in perceptual terms.
 */

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SharedCameraState } from './layered-cameras';
import { DEFAULT_FOV_DEG } from './layered-cameras';

/** Navigation mode. */
export type CameraMode = 'ORBIT' | 'FREE';

/** Ecliptic north, the world up vector for this frame. */
const WORLD_UP = new Vector3(0, 0, 1);

/**
 * Elevation limit, radians from the ecliptic plane.
 *
 * Stopping just short of the pole avoids the degenerate case where the view direction
 * is parallel to the world up vector and the look-at basis has no unique solution. The
 * construction below handles that case, but the camera would still gimbal visibly as
 * the azimuth became meaningless, so it is prevented instead.
 */
const MAX_ELEVATION = Math.PI / 2 - 1e-3;

/** Default fly-to duration, seconds. A presentation parameter. */
export const DEFAULT_FLY_DURATION_SECONDS = 1.6;

/**
 * Minimum orbit distance as a multiple of the target's visual radius.
 *
 * 1.02 puts the camera just clear of the surface, which is what makes the close-orbit
 * view of contract section 1.4 reachable. The depth planner's dynamic near plane is
 * what allows it; see the near-plane commentary in depth-slabs.ts.
 */
export const MIN_DISTANCE_RADII = 1.02;

/** Absolute floor on orbit distance, render units, for a target with no radius. */
const MIN_DISTANCE_UNITS = 1e-5;

/** The camera's target: a point, optionally tracking a body. */
export interface OrbitTarget {
  /** Body being tracked, or null for a fixed point in space. */
  readonly bodyId: string | null;
  /** Absolute render-space point the camera looks at. */
  readonly point: Vector3;
  /** Visual radius of the target body, render units. Zero for a fixed point. */
  readonly radius: number;
}

/** Where a tracked body currently is. Supplied by the caller each frame. */
export interface TargetResolver {
  (bodyId: string): { readonly position: Vector3; readonly radius: number } | undefined;
}

/** A complete orbit arrangement, which is what fly-to interpolates between. */
interface OrbitState {
  readonly targetPoint: Vector3;
  readonly targetBodyId: string | null;
  readonly targetRadius: number;
  readonly distance: number;
  readonly azimuth: number;
  readonly elevation: number;
}

/** An in-progress transition. */
interface Transition {
  readonly from: OrbitState;
  readonly to: OrbitState;
  readonly durationSeconds: number;
  elapsedSeconds: number;
}

export interface CameraRigOptions {
  readonly fovDeg?: number;
  /** Initial distance from the initial target, render units. */
  readonly distance?: number;
  /**
   * Whether eased transitions are disabled.
   *
   * Injected rather than read from window.matchMedia inside the class, so the reduced
   * motion path is testable in node and so the render layer does not reach into the
   * DOM. The caller wires the media query. Contract section 28 and M3.
   */
  readonly reducedMotion?: boolean;
  readonly flyDurationSeconds?: number;
}

/**
 * Owns camera position, orientation and navigation.
 *
 * All angles are radians. All distances are render units.
 */
export class CameraRig {
  private mode: CameraMode = 'ORBIT';

  private orbit: OrbitState = {
    targetPoint: new Vector3(0, 0, 0),
    targetBodyId: null,
    targetRadius: 0,
    distance: 1e6,
    azimuth: 0,
    // A slightly elevated default, so the ecliptic plane reads as a plane rather than
    // as a line on first load.
    elevation: 0.35,
  };

  /** Free-flight state. Only meaningful in FREE mode. */
  private freePosition = new Vector3(0, 0, 0);
  private freeQuaternion = new Quaternion();

  private transition: Transition | null = null;

  private fovDeg: number;
  private aspect = 1;
  private reducedMotion: boolean;
  private readonly flyDuration: number;

  /** Reset target, captured at construction. */
  private readonly home: OrbitState;

  private readonly cachedPosition = new Vector3();
  private readonly cachedQuaternion = new Quaternion();

  constructor(options: CameraRigOptions = {}) {
    this.fovDeg = options.fovDeg ?? DEFAULT_FOV_DEG;
    this.reducedMotion = options.reducedMotion ?? false;
    this.flyDuration = options.flyDurationSeconds ?? DEFAULT_FLY_DURATION_SECONDS;

    if (options.distance !== undefined) {
      this.orbit = { ...this.orbit, distance: options.distance };
    }
    this.home = { ...this.orbit, targetPoint: this.orbit.targetPoint.clone() };
    this.recompute();
  }

  // ------------------------------------------------------------------ queries

  get currentMode(): CameraMode {
    return this.mode;
  }

  /** Absolute render-space camera position. The floating origin derives from this. */
  get position(): Vector3 {
    return this.cachedPosition;
  }

  get quaternion(): Quaternion {
    return this.cachedQuaternion;
  }

  /** Distance from the orbit target, render units. Meaningless in FREE mode. */
  get distance(): number {
    return this.orbit.distance;
  }

  /** The body being tracked, or null. */
  get targetBodyId(): string | null {
    return this.orbit.targetBodyId;
  }

  /** True while a fly-to is in progress. */
  get isTransitioning(): boolean {
    return this.transition !== null;
  }

  /** Progress of the current transition in [0, 1], or 1 when idle. */
  get transitionProgress(): number {
    if (this.transition === null) return 1;
    return Math.min(1, this.transition.elapsedSeconds / this.transition.durationSeconds);
  }

  /**
   * State for the slab cameras.
   *
   * POSITION IS ZERO, not the camera's absolute position. The floating origin tracks
   * the camera exactly, so in origin-relative coordinates the camera is at the origin
   * by construction. Passing the absolute position here would apply the offset twice.
   */
  sharedState(): SharedCameraState {
    return {
      fovDeg: this.fovDeg,
      aspect: this.aspect,
      position: new Vector3(0, 0, 0),
      quaternion: this.cachedQuaternion.clone(),
    };
  }

  // ----------------------------------------------------------------- settings

  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) {
      throw new Error(`CameraRig.setAspect: aspect must be positive and finite, got ${aspect}`);
    }
    this.aspect = aspect;
  }

  setFov(fovDeg: number): void {
    if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
      throw new Error(`CameraRig.setFov: fov must lie in (0, 180), got ${fovDeg}`);
    }
    this.fovDeg = fovDeg;
  }

  /** Enables or disables eased transitions. Contract section 28. */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    // An in-flight transition is completed immediately rather than left running, since
    // the user has just asked for no motion.
    if (reduced && this.transition !== null) {
      this.orbit = this.transition.to;
      this.transition = null;
      this.recompute();
    }
  }

  // ------------------------------------------------------------------ gestures

  /**
   * Orbits about the target.
   *
   * Elevation is clamped short of the poles; see MAX_ELEVATION.
   */
  orbitBy(deltaAzimuth: number, deltaElevation: number): void {
    if (this.mode !== 'ORBIT') return;

    this.orbit = {
      ...this.orbit,
      azimuth: this.orbit.azimuth + deltaAzimuth,
      elevation: clamp(this.orbit.elevation + deltaElevation, -MAX_ELEVATION, MAX_ELEVATION),
    };
    this.cancelTransition();
    this.recompute();
  }

  /**
   * Dollies towards or away from the target.
   *
   * MULTIPLICATIVE, not additive. Distances span from a few units at a planet's surface
   * to millions at system overview, so a fixed step is either imperceptible at one end
   * or catastrophic at the other. A scroll notch should move the same PROPORTION of the
   * way in regardless of where the camera is.
   *
   * @param factor multiplier on distance. Below 1 moves closer.
   */
  dollyBy(factor: number): void {
    if (this.mode !== 'ORBIT') return;
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`CameraRig.dollyBy: factor must be positive and finite, got ${factor}`);
    }

    this.orbit = {
      ...this.orbit,
      distance: this.clampDistance(this.orbit.distance * factor, this.orbit.targetRadius),
    };
    this.cancelTransition();
    this.recompute();
  }

  /**
   * Pans the target laterally in the camera's screen plane.
   *
   * Deltas are in units of the visible half-height at the target distance, so a pan of
   * 1 moves the target by half a screen regardless of zoom. That keeps the gesture
   * consistent, which a world-space delta would not.
   *
   * PANNING DETACHES THE CAMERA FROM A TRACKED BODY. If it did not, the pan would be
   * undone on the next frame when the target snapped back to the body's position. So
   * the target becomes a fixed point, and the interface should reflect that follow mode
   * has ended.
   */
  panBy(deltaRight: number, deltaUp: number): void {
    if (this.mode !== 'ORBIT') return;

    const halfHeight = this.orbit.distance * Math.tan((this.fovDeg * Math.PI) / 360);
    const { right, up } = this.basis();

    const moved = this.orbit.targetPoint
      .clone()
      .addScaledVector(right, -deltaRight * halfHeight)
      .addScaledVector(up, -deltaUp * halfHeight);

    this.orbit = {
      ...this.orbit,
      targetPoint: moved,
      targetBodyId: null,
      targetRadius: 0,
    };
    this.cancelTransition();
    this.recompute();
  }

  /**
   * Moves the camera in FREE mode, in its own local frame.
   *
   * @param forward positive moves along the view direction, render units
   * @param right positive moves right, render units
   * @param up positive moves along world up, render units
   */
  flyBy(forward: number, right: number, up: number): void {
    if (this.mode !== 'FREE') return;

    const basis = this.basis();
    this.freePosition
      .addScaledVector(basis.forward, forward)
      .addScaledVector(basis.right, right)
      // World up rather than camera up, so vertical movement stays vertical and does
      // not tilt with the view. That is what makes free flight controllable.
      .addScaledVector(WORLD_UP, up);

    this.recompute();
  }

  /** Rotates the camera in place, in FREE mode. */
  lookBy(deltaYaw: number, deltaPitch: number): void {
    if (this.mode !== 'FREE') return;

    // Yaw about WORLD up rather than camera up, so repeated yaw cannot accumulate roll.
    const yaw = new Quaternion().setFromAxisAngle(WORLD_UP, deltaYaw);
    const pitch = new Quaternion().setFromAxisAngle(this.basis().right, deltaPitch);

    this.freeQuaternion.premultiply(pitch).premultiply(yaw).normalize();
    this.recompute();
  }

  // -------------------------------------------------------------------- modes

  /**
   * Focuses a body, flying to it.
   *
   * @param distance target distance, or undefined for a framing distance derived from
   *   the body's radius
   */
  focusOn(
    bodyId: string,
    position: Vector3,
    radius: number,
    distance?: number,
  ): void {
    // Three radii frames a body with margin: the body then subtends roughly 40 degrees
    // at a 45 degree field of view.
    const requested = distance ?? Math.max(radius * 3, MIN_DISTANCE_UNITS * 10);

    this.beginTransition({
      targetPoint: position.clone(),
      targetBodyId: bodyId,
      targetRadius: radius,
      distance: this.clampDistance(requested, radius),
      azimuth: this.orbit.azimuth,
      elevation: this.orbit.elevation,
    });
  }

  /** Frames the whole system, flying to it. */
  overview(distance: number): void {
    this.beginTransition({
      targetPoint: new Vector3(0, 0, 0),
      targetBodyId: null,
      targetRadius: 0,
      distance: this.clampDistance(distance, 0),
      azimuth: this.orbit.azimuth,
      elevation: this.orbit.elevation,
    });
  }

  /** Returns to the initial arrangement. */
  reset(): void {
    this.mode = 'ORBIT';
    this.beginTransition({ ...this.home, targetPoint: this.home.targetPoint.clone() });
  }

  /**
   * Enters free-flight mode, keeping the current position and orientation.
   *
   * Continuity matters: switching mode must not teleport the camera, or the user loses
   * their place in the scene.
   */
  enterFreeMode(): void {
    if (this.mode === 'FREE') return;

    this.freePosition.copy(this.cachedPosition);
    this.freeQuaternion.copy(this.cachedQuaternion);
    this.mode = 'FREE';
    this.cancelTransition();
    this.recompute();
  }

  /**
   * Returns to orbit mode, orbiting whatever the camera is currently looking at.
   *
   * The target is placed along the view direction at the previous orbit distance, so
   * the arrangement is continuous rather than snapping back to the old target.
   */
  enterOrbitMode(): void {
    if (this.mode === 'ORBIT') return;

    const forward = this.basis().forward;
    const target = this.freePosition.clone().addScaledVector(forward, this.orbit.distance);

    // Recover the spherical angles the new arrangement implies, so the first orbit
    // gesture continues smoothly instead of jumping.
    const offset = this.freePosition.clone().sub(target);
    const distance = Math.max(offset.length(), MIN_DISTANCE_UNITS);

    this.orbit = {
      targetPoint: target,
      targetBodyId: null,
      targetRadius: 0,
      distance,
      azimuth: Math.atan2(offset.y, offset.x),
      elevation: clamp(Math.asin(offset.z / distance), -MAX_ELEVATION, MAX_ELEVATION),
    };

    this.mode = 'ORBIT';
    this.cancelTransition();
    this.recompute();
  }

  // ------------------------------------------------------------------- frame

  /**
   * Advances the rig by one frame.
   *
   * @param deltaSeconds real elapsed time
   * @param resolve supplies the current position of a tracked body, so follow mode
   *   tracks it without this module knowing anything about the simulation
   */
  update(deltaSeconds: number, resolve?: TargetResolver): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new Error(`CameraRig.update: deltaSeconds must be finite and non-negative, got ${deltaSeconds}`);
    }

    this.advanceTransition(deltaSeconds, resolve);

    // FOLLOW MODE. The target point is re-read from the body every frame, so the camera
    // stays with it as it orbits. This is the whole of follow mode: no separate state,
    // no separate branch.
    if (this.mode === 'ORBIT' && this.orbit.targetBodyId !== null && resolve !== undefined) {
      const tracked = resolve(this.orbit.targetBodyId);
      if (tracked !== undefined) {
        this.orbit = {
          ...this.orbit,
          targetPoint: tracked.position.clone(),
          targetRadius: tracked.radius,
          // The body's visual radius changes with the scale mode, so the distance floor
          // is re-applied rather than assumed still valid.
          distance: this.clampDistance(this.orbit.distance, tracked.radius),
        };
      }
    }

    this.recompute();
  }

  // ---------------------------------------------------------------- internals

  /** Starts a transition, or applies the target immediately under reduced motion. */
  private beginTransition(to: OrbitState): void {
    this.mode = 'ORBIT';

    if (this.reducedMotion || this.flyDuration <= 0) {
      this.orbit = to;
      this.transition = null;
      this.recompute();
      return;
    }

    this.transition = {
      from: { ...this.orbit, targetPoint: this.orbit.targetPoint.clone() },
      to,
      durationSeconds: this.flyDuration,
      elapsedSeconds: 0,
    };
  }

  private cancelTransition(): void {
    this.transition = null;
  }

  /**
   * Steps an in-progress transition.
   *
   * Distance interpolates in LOG space; see the module header for why linear is
   * unusable across this range. Angles take the shortest path, so a transition never
   * takes the long way round the sky.
   */
  private advanceTransition(deltaSeconds: number, resolve?: TargetResolver): void {
    const transition = this.transition;
    if (transition === null) return;

    transition.elapsedSeconds += deltaSeconds;
    const linear = Math.min(1, transition.elapsedSeconds / transition.durationSeconds);
    const t = easeInOutCubic(linear);

    // A transition towards a tracked body must aim at where the body IS, not where it
    // was when the transition began, or a long flight would land off target.
    let destination = transition.to;
    if (destination.targetBodyId !== null && resolve !== undefined) {
      const tracked = resolve(destination.targetBodyId);
      if (tracked !== undefined) {
        destination = {
          ...destination,
          targetPoint: tracked.position.clone(),
          targetRadius: tracked.radius,
        };
      }
    }

    this.orbit = {
      targetPoint: transition.from.targetPoint.clone().lerp(destination.targetPoint, t),
      targetBodyId: destination.targetBodyId,
      targetRadius: destination.targetRadius,
      distance: lerpLog(transition.from.distance, destination.distance, t),
      azimuth: lerpAngle(transition.from.azimuth, destination.azimuth, t),
      elevation: lerpAngle(transition.from.elevation, destination.elevation, t),
    };

    if (linear >= 1) {
      this.orbit = destination;
      this.transition = null;
    }
  }

  /** Enforces the distance floor, which keeps the camera outside the target's surface. */
  private clampDistance(distance: number, radius: number): number {
    const floor = Math.max(radius * MIN_DISTANCE_RADII, MIN_DISTANCE_UNITS);
    return Math.max(floor, distance);
  }

  /** Recomputes the cached position and orientation from the active mode. */
  private recompute(): void {
    if (this.mode === 'FREE') {
      this.cachedPosition.copy(this.freePosition);
      this.cachedQuaternion.copy(this.freeQuaternion);
      return;
    }

    const { targetPoint, distance, azimuth, elevation } = this.orbit;

    // Spherical to cartesian in a Z-up frame: elevation is measured from the ecliptic
    // plane rather than from the pole, which is why cos appears on the planar terms.
    const horizontal = Math.cos(elevation) * distance;
    this.cachedPosition.set(
      targetPoint.x + horizontal * Math.cos(azimuth),
      targetPoint.y + horizontal * Math.sin(azimuth),
      targetPoint.z + distance * Math.sin(elevation),
    );

    this.cachedQuaternion.copy(lookAtZUp(this.cachedPosition, targetPoint));
  }

  /** The camera's basis vectors in world space. */
  private basis(): {
    readonly forward: Vector3;
    readonly right: Vector3;
    readonly up: Vector3;
  } {
    const quaternion = this.mode === 'FREE' ? this.freeQuaternion : this.cachedQuaternion;
    return {
      // A camera looks along its own -Z.
      forward: new Vector3(0, 0, -1).applyQuaternion(quaternion),
      right: new Vector3(1, 0, 0).applyQuaternion(quaternion),
      up: new Vector3(0, 1, 0).applyQuaternion(quaternion),
    };
  }
}

/**
 * Builds a look-at quaternion in a Z-up frame.
 *
 * NOT Object3D.lookAt, which assumes Y-up and would roll the camera in this frame.
 * Constructed from the basis directly:
 *
 *   zAxis = -forward          a camera looks along its own -Z
 *   xAxis = worldUp x zAxis   right, perpendicular to both
 *   yAxis = zAxis x xAxis     up, completing a right-handed triad
 *
 * DEGENERATE CASE. Looking straight along the world up axis makes worldUp parallel to
 * zAxis, so their cross product vanishes and the basis is undefined. An arbitrary
 * xAxis is substituted, which is correct in the sense that any choice is equally valid
 * when the azimuth is meaningless. The rig prevents reaching that state via
 * MAX_ELEVATION, but free flight can, so it is handled rather than assumed away.
 */
export function lookAtZUp(from: Vector3, to: Vector3): Quaternion {
  const forward = to.clone().sub(from);
  if (forward.lengthSq() === 0) return new Quaternion();
  forward.normalize();

  const zAxis = forward.clone().negate();
  const xAxis = new Vector3().crossVectors(WORLD_UP, zAxis);

  if (xAxis.lengthSq() < 1e-12) {
    // View direction is parallel to world up; any perpendicular will do.
    xAxis.set(1, 0, 0);
  }
  xAxis.normalize();

  const yAxis = new Vector3().crossVectors(zAxis, xAxis);

  /**
   * NORMALISED DELIBERATELY, and not redundantly.
   *
   * setFromRotationMatrix on an orthonormal basis returns a quaternion whose squared
   * length differs from 1 by about 1e-16, which is unremarkable in itself. What makes it
   * worth correcting is that Quaternion.angleTo computes 2*acos(dot), and acos has
   * infinite derivative at 1, so that 1e-16 deficit is amplified into an apparent
   * rotation of 2.98e-8 radians BETWEEN A QUATERNION AND AN EXACT COPY OF ITSELF.
   *
   * Measured: |q|^2 - 1 = -1.110e-16 gives angleTo(q, q.clone()) = 2.980e-8, and
   * normalising brings it to exactly 0.
   *
   * Left uncorrected this would surface as a spurious orientation delta in any code that
   * compares camera orientations, including change detection that skips work when the
   * camera has not moved: that check would never fire.
   */
  return new Quaternion()
    .setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis))
    .normalize();
}

/**
 * Interpolates in log space, so each step covers a constant RATIO of the remaining
 * distance rather than a constant amount.
 *
 * Falls back to linear when either endpoint is non-positive, since the logarithm is
 * undefined there.
 */
export function lerpLog(from: number, to: number, t: number): number {
  if (from <= 0 || to <= 0) return from + (to - from) * t;
  return Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * t);
}

/** Interpolates an angle along the shortest path. */
export function lerpAngle(from: number, to: number, t: number): number {
  const difference = ((to - from + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return from + difference * t;
}

/**
 * Cubic ease in and out.
 *
 * Zero velocity at both ends, which is what makes a fly-to read as a camera move
 * rather than a cut. Contract section 1.4 asks for smooth interpolation rather than
 * instantaneous jumps.
 */
export function easeInOutCubic(t: number): number {
  const clamped = clamp(t, 0, 1);
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
