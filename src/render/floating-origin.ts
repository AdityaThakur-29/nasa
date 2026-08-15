/**
 * Floating origin.
 *
 * THE PROBLEM, MEASURED. GPU vertex attributes and matrix uniforms are f32, whose
 * 24-bit significand gives a representable spacing of about v * 2^-23 at
 * magnitude v. In render units of 1000 km:
 *
 *   magnitude (units)        spacing (units)      spacing (physical)
 *   2.7    Moon-close cam     2.384e-7             24 cm
 *   1.5e5  1 au               1.563e-2             15.6 km
 *   4.5e6  Neptune            5.000e-1            500 km
 *
 * So a vertex on the Moon's surface, expressed as an ABSOLUTE render coordinate
 * near 1.5e5 units, can only be positioned to the nearest 15.6 km. As the camera
 * moves, vertices snap between those grid points, which reads as jitter or
 * crawling. Increasing depth precision does not help: this is lateral position
 * error, not depth error.
 *
 * THE FIX. Subtract the camera's render position from every render position in
 * f64, then hand the DIFFERENCE to the GPU. Near the camera the difference is
 * small, and f32 spacing shrinks with magnitude, so precision arrives exactly
 * where it is needed.
 *
 * MEASURED BENEFIT, camera 2.7374 units outside the Moon at 149985.0081 units from
 * the coordinate origin, 45 degree vertical field of view, 1080 pixels tall:
 *
 *   body            distance    absolute err   relative err   factor   screen error
 *   Moon            2.74e+0     1.260e-2       5.492e-8       2.3e5    6.00 px -> 2.6e-5 px
 *   Earth (1 au)    3.87e+2     3.225e-3       9.863e-6       327x
 *   Sun (origin)    1.50e+5     7.525e-3       7.525e-3         1x
 *   Neptune         4.34e+6     1.129e-1       1.129e-1         1x
 *
 * The Moon row is the point: 6 pixels of jitter is plainly visible, and the fix
 * removes it entirely.
 *
 * WHY THE FACTOR IS EXACTLY 1 FOR BOTH THE SUN AND NEPTUNE, for opposite reasons.
 * The two error terms behave as
 *
 *   absolute error ~ max( spacing(|target|), spacing(|origin|) )
 *   relative error ~ spacing(|target - origin|)
 *
 * Neptune is far from the camera, so |target - origin| is itself about 4.34e6 units
 * and the subtraction cannot make the number small. The Sun is at the coordinate
 * origin, where spacing(0) is zero, so the absolute path's error is already just
 * the error in the origin, which the relative path also carries. In neither case is
 * there anything to gain.
 *
 * Neither is a defect. Both errors scale with the distance at which they occur, so
 * 0.1129 units at 4.34e6 units subtends 3.4e-5 pixels. Floating origin buys
 * precision for near geometry and leaves far geometry alone, which is exactly the
 * trade that matters.
 *
 * The honest summary is therefore narrower than "floating origin fixes precision":
 * it fixes precision for objects near the camera, and nothing else needs fixing.
 *
 * WHERE THIS SITS IN THE PIPELINE (contract section 5):
 *
 *   simulation (km, f64)
 *     -> scale transform      (sim/scale.ts, render units, f64)
 *     -> floating origin      (this module, camera-relative, f64)
 *     -> GPU                  (f32)
 *
 * The simulation's coordinates are never overwritten. This module reads render
 * positions and returns new ones; contract section 5 forbids the reverse flow and
 * nothing here writes back.
 */

import type { Vector3Like } from '../ephemeris/kepler';

/**
 * f32 mantissa bits, excluding the implicit leading bit.
 *
 * IEEE-754 binary32 has a 24-bit significand, of which 23 bits are stored.
 */
export const F32_MANTISSA_BITS = 23;

/** Relative spacing of adjacent f32 values, 2^-23. */
export const F32_RELATIVE_EPSILON = 2 ** -F32_MANTISSA_BITS;

/**
 * Rounds a number to the nearest f32, exactly as the GPU would on upload.
 *
 * Used by the validation suite to measure real precision loss rather than
 * estimate it. Math.fround is the standard way to do this and is not an
 * approximation of f32 rounding; it IS f32 rounding.
 */
export function toF32(value: number): number {
  return Math.fround(value);
}

/** Rounds every component of a vector to f32. */
export function vectorToF32(v: Vector3Like): Vector3Like {
  return { x: Math.fround(v.x), y: Math.fround(v.y), z: Math.fround(v.z) };
}

/**
 * Absolute f32 spacing at a given magnitude, in render units.
 *
 * The bound on positional error for a coordinate of this size once it reaches the
 * GPU. Zero at zero, since f32 subnormals reach about 1e-45.
 */
export function f32SpacingAt(magnitude: number): number {
  const absolute = Math.abs(magnitude);
  if (absolute === 0) return 0;
  // 2^floor(log2(v)) is the binade base; spacing within that binade is
  // base * 2^-23.
  return 2 ** Math.floor(Math.log2(absolute)) * F32_RELATIVE_EPSILON;
}

/**
 * The camera-relative origin all render positions are expressed against.
 *
 * Held in f64. Storing this in f32 would defeat the entire mechanism, because the
 * subtraction would then be performed between quantised values.
 */
export interface RenderOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const ZERO_ORIGIN: RenderOrigin = { x: 0, y: 0, z: 0 };

/**
 * Expresses an absolute render position relative to the origin.
 *
 * Performed in f64. The caller is responsible for not rounding the inputs first;
 * doing so would reintroduce the error this function exists to remove.
 */
export function toOriginRelative(absolute: Vector3Like, origin: RenderOrigin): Vector3Like {
  return {
    x: absolute.x - origin.x,
    y: absolute.y - origin.y,
    z: absolute.z - origin.z,
  };
}

/**
 * Recovers an absolute render position from a relative one.
 *
 * Exact in f64, so the transform is a bijection and nothing is lost by working
 * relatively. Needed when a picked screen point has to be turned back into a
 * simulation position.
 */
export function fromOriginRelative(relative: Vector3Like, origin: RenderOrigin): Vector3Like {
  return {
    x: relative.x + origin.x,
    y: relative.y + origin.y,
    z: relative.z + origin.z,
  };
}

/** Euclidean distance from the origin to an absolute render position. */
export function distanceFromOrigin(absolute: Vector3Like, origin: RenderOrigin): number {
  const dx = absolute.x - origin.x;
  const dy = absolute.y - origin.y;
  const dz = absolute.z - origin.z;
  return Math.hypot(dx, dy, dz);
}

/**
 * Default quantisation step for the origin, render units.
 *
 * Zero means the origin tracks the camera exactly.
 *
 * WHY QUANTISATION IS AVAILABLE BUT OFF BY DEFAULT. Snapping the origin to a grid
 * makes it change only when the camera crosses a cell boundary, which lets static
 * geometry keep its relative coordinates across many frames. That matters for
 * large static buffers, which M1 does not have: ten bodies are recomputed every
 * frame regardless, so quantisation would add a discontinuity in exchange for
 * nothing. It is implemented because the instanced asteroid belt in M4 will want
 * it, and because bolting it on later would be a change to a load-bearing
 * transform rather than a parameter.
 *
 * A NON-ZERO STEP COSTS PRECISION. With the origin up to step/2 away from the
 * camera in each axis, positions at the camera are no longer near zero but near
 * step/2, so their f32 spacing rises accordingly. At a step of 1 unit the error
 * at the camera is about 6e-8 units, or 6 cm, which is harmless. At a step of
 * 1e4 units it would be 6e-4 units, or 600 m, which is not.
 */
export const DEFAULT_ORIGIN_QUANTISATION = 0;

export interface FloatingOriginOptions {
  /** Grid step for origin snapping, render units. Zero disables snapping. */
  readonly quantisationStep?: number;
}

/**
 * Tracks the render-space origin and reports when it moves.
 *
 * Stateful only in the sense that it remembers the current origin so callers can
 * detect a change; the transforms themselves are pure.
 */
export class FloatingOrigin {
  private current: RenderOrigin = ZERO_ORIGIN;
  private readonly step: number;
  private changeCount = 0;

  constructor(options: FloatingOriginOptions = {}) {
    this.step = options.quantisationStep ?? DEFAULT_ORIGIN_QUANTISATION;
    if (!Number.isFinite(this.step) || this.step < 0) {
      throw new Error(
        `FloatingOrigin: quantisationStep must be finite and non-negative, got ${this.step}`,
      );
    }
  }

  /** The origin in force. */
  get origin(): RenderOrigin {
    return this.current;
  }

  /** Number of times the origin has actually moved, for diagnostics. */
  get originChanges(): number {
    return this.changeCount;
  }

  /** The active quantisation step. */
  get quantisationStep(): number {
    return this.step;
  }

  /**
   * Updates the origin from the camera's absolute render position.
   *
   * @returns true when the origin moved, so callers can refresh cached geometry
   */
  update(cameraRenderPosition: Vector3Like): boolean {
    const next = this.step === 0 ? snapshot(cameraRenderPosition) : quantise(cameraRenderPosition, this.step);

    if (next.x === this.current.x && next.y === this.current.y && next.z === this.current.z) {
      return false;
    }
    this.current = next;
    this.changeCount += 1;
    return true;
  }

  /** Expresses an absolute render position relative to the current origin. */
  relative(absolute: Vector3Like): Vector3Like {
    return toOriginRelative(absolute, this.current);
  }

  /** Recovers an absolute render position from a relative one. */
  absolute(relative: Vector3Like): Vector3Like {
    return fromOriginRelative(relative, this.current);
  }

  /** Resets to the coordinate origin. Used when re-seeding a scene. */
  reset(): void {
    this.current = ZERO_ORIGIN;
  }
}

function snapshot(v: Vector3Like): RenderOrigin {
  return { x: v.x, y: v.y, z: v.z };
}

/** Snaps a position to a grid. Exported so tests can verify the mapping. */
export function quantise(position: Vector3Like, step: number): RenderOrigin {
  if (step <= 0) return snapshot(position);
  return {
    x: Math.round(position.x / step) * step,
    y: Math.round(position.y / step) * step,
    z: Math.round(position.z / step) * step,
  };
}

/** Precision comparison between absolute and origin-relative treatment. */
export interface PrecisionComparison {
  /** Error in render units if the position is sent to the GPU absolutely. */
  readonly absoluteErrorUnits: number;
  /** Error in render units if the position is sent relative to the origin. */
  readonly relativeErrorUnits: number;
  /** How many times better the relative treatment is. Infinite when exact. */
  readonly improvementFactor: number;
}

/**
 * Measures the precision benefit for one position.
 *
 * Rounds both treatments to f32 and compares against the f64 answer, so the
 * numbers are measured rather than predicted from a formula.
 */
export function comparePrecision(
  absolute: Vector3Like,
  origin: RenderOrigin,
): PrecisionComparison {
  // Absolute treatment: round the position, then subtract in f32.
  const roundedAbsolute = vectorToF32(absolute);
  const roundedOrigin = vectorToF32(origin);
  const viaAbsolute = {
    x: Math.fround(roundedAbsolute.x - roundedOrigin.x),
    y: Math.fround(roundedAbsolute.y - roundedOrigin.y),
    z: Math.fround(roundedAbsolute.z - roundedOrigin.z),
  };

  // Relative treatment: subtract in f64, then round the small difference.
  const exact = toOriginRelative(absolute, origin);
  const viaRelative = vectorToF32(exact);

  const absoluteError = Math.hypot(
    viaAbsolute.x - exact.x,
    viaAbsolute.y - exact.y,
    viaAbsolute.z - exact.z,
  );
  const relativeError = Math.hypot(
    viaRelative.x - exact.x,
    viaRelative.y - exact.y,
    viaRelative.z - exact.z,
  );

  return {
    absoluteErrorUnits: absoluteError,
    relativeErrorUnits: relativeError,
    improvementFactor:
      relativeError === 0 ? Number.POSITIVE_INFINITY : absoluteError / relativeError,
  };
}

/**
 * Screen-space displacement caused by a positional error, in pixels.
 *
 * Converts a world-space error into the quantity that actually matters, namely
 * whether it is visible. A perspective camera of vertical field of view fovDeg
 * rendering to heightPx pixels images a transverse offset e at distance d as
 *
 *   pixels = (e / (d tan(fov/2))) * (heightPx / 2)
 *
 * The floating-origin validation suite uses this to assert sub-pixel stability
 * rather than asserting an arbitrary bound on the world-space error.
 */
export function errorToPixels(
  errorUnits: number,
  distanceUnits: number,
  fovDeg: number,
  heightPx: number,
): number {
  if (distanceUnits <= 0) {
    throw new Error(`errorToPixels: distance must be positive, got ${distanceUnits}`);
  }
  const halfHeightAtDistance = distanceUnits * Math.tan((fovDeg * Math.PI) / 360);
  return (errorUnits / halfHeightAtDistance) * (heightPx / 2);
}
