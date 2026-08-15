/**
 * Camera rig and hybrid selection validation.
 *
 * BOTH MODULES ARE PURE GEOMETRY, so they belong in the node project. The rig computes
 * a position and a quaternion; selection projects points and compares pixel distances.
 * Neither needs a GL context, and both encode decisions that would be expensive to
 * discover visually.
 *
 * THE TWO DESIGN CORRECTIONS UNDER TEST, each measured rather than argued:
 *
 *   1. Fly-to distance must interpolate LOGARITHMICALLY. Linear interpolation from a
 *      4.4e6 unit overview to a 3 unit close-up is still 2.2e6 units out at the halfway
 *      point, so the entire visible approach happens in the last fraction of a percent.
 *   2. Selection needs a PER-BODY threshold and a two-tier ordering. A fixed 14 pixel
 *      test misses a body whose disc is 1038 pixels across, and the literal contract
 *      section 7.1 ordering picks a body 384 units behind the one under the cursor.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import {
  CameraRig,
  DEFAULT_FLY_DURATION_SECONDS,
  MIN_DISTANCE_RADII,
  easeInOutCubic,
  lerpAngle,
  lerpLog,
  lookAtZUp,
} from '@/render/camera-rig';
import {
  DEFAULT_SELECTION_RADIUS_PX,
  SELECTION_TIE_PIXELS,
  TOUCH_SELECTION_RADIUS_PX,
  buildCandidates,
  pickBody,
  type SelectionCandidate,
} from '@/render/selection';
import { DEFAULT_FOV_DEG, LayeredCameras, apparentRadiusPixels } from '@/render/layered-cameras';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

const VIEWPORT_WIDTH_PX = 1920;
const VIEWPORT_HEIGHT_PX = 1080;
const ASPECT = VIEWPORT_WIDTH_PX / VIEWPORT_HEIGHT_PX;

/** Ecliptic north, the world up vector for the simulation frame. */
const ECLIPTIC_NORTH = new Vector3(0, 0, 1);

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

describe('logarithmic distance interpolation', () => {
  /**
   * THE MEASUREMENT THAT JUSTIFIES LOG SPACE.
   *
   * Flying from a Neptune overview to an Earth close-up spans six orders of magnitude.
   * Measured, for 4.4e6 down to 3 render units:
   *
   *   t      linear      log
   *   0.25   3.300e+6    1.264e+5
   *   0.50   2.200e+6    3.633e+3
   *   0.75   1.100e+6    1.044e+2
   *   0.99   4.400e+4    -
   *
   * Under linear interpolation the camera is still 44000 units out at 99 percent of the
   * way through, so the approach is invisible until it is abrupt.
   */
  const OVERVIEW = 4.4e6;
  const CLOSE_UP = 3;

  it('places the halfway point at the geometric mean', () => {
    // Which is the definition of halfway when the perceptually relevant quantity is the
    // ratio rather than the difference.
    expect(lerpLog(OVERVIEW, CLOSE_UP, 0.5)).toBeCloseTo(Math.sqrt(OVERVIEW * CLOSE_UP), 6);
    expect(lerpLog(OVERVIEW, CLOSE_UP, 0.5)).toBeCloseTo(3633.2, 1);
  });

  it('leaves linear interpolation nowhere near halfway', () => {
    // The counterfactual, so the justification stays checkable.
    const linearHalfway = OVERVIEW + (CLOSE_UP - OVERVIEW) * 0.5;
    expect(linearHalfway).toBeGreaterThan(2e6);
    // Three orders of magnitude worse than the log result at the same t.
    expect(linearHalfway / lerpLog(OVERVIEW, CLOSE_UP, 0.5)).toBeGreaterThan(500);
  });

  it('hits both endpoints exactly', () => {
    expect(lerpLog(OVERVIEW, CLOSE_UP, 0)).toBeCloseTo(OVERVIEW, 6);
    expect(lerpLog(OVERVIEW, CLOSE_UP, 1)).toBeCloseTo(CLOSE_UP, 6);
  });

  it('covers a constant ratio per unit of t', () => {
    // The defining property: equal steps in t multiply the distance by equal factors.
    const quarter = lerpLog(OVERVIEW, CLOSE_UP, 0.25);
    const half = lerpLog(OVERVIEW, CLOSE_UP, 0.5);
    const threeQuarters = lerpLog(OVERVIEW, CLOSE_UP, 0.75);

    expect(OVERVIEW / quarter).toBeCloseTo(quarter / half, 3);
    expect(quarter / half).toBeCloseTo(half / threeQuarters, 3);
  });

  it('is monotonic in both directions', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = lerpLog(OVERVIEW, CLOSE_UP, t);
      expect(value).toBeLessThan(previous);
      previous = value;
    }

    previous = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = lerpLog(CLOSE_UP, OVERVIEW, t);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('falls back to linear where the logarithm is undefined', () => {
    // Zero and negative distances have no logarithm. Falling back keeps the function
    // total rather than producing NaN that would propagate into a camera position.
    expect(lerpLog(0, 10, 0.5)).toBeCloseTo(5, 9);
    expect(lerpLog(10, 0, 0.5)).toBeCloseTo(5, 9);
    expect(Number.isFinite(lerpLog(-5, 5, 0.5))).toBe(true);
  });
});

describe('shortest-path angle interpolation', () => {
  it('crosses the wrap boundary rather than going the long way round', () => {
    // From just above zero to just below a full turn is a short step backwards, not a
    // near-complete revolution forwards. Without this a fly-to could spin the camera
    // most of the way round the sky.
    const from = 0.1;
    const to = 2 * Math.PI - 0.1;

    const midpoint = lerpAngle(from, to, 0.5);
    // The true midpoint is at zero, or equivalently a full turn.
    expect(Math.abs(Math.atan2(Math.sin(midpoint), Math.cos(midpoint)))).toBeLessThan(1e-9);
  });

  it('reaches the destination modulo a full turn', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a09, 300, (sampler, context) => {
      const from = sampler.range(-10, 10);
      const to = sampler.range(-10, 10);
      const arrived = lerpAngle(from, to, 1);

      const difference = Math.abs(
        Math.atan2(Math.sin(arrived - to), Math.cos(arrived - to)),
      );
      expect(difference, formatPropertyFailure({ ...context, from, to }, 0, difference)).toBeLessThan(
        1e-9,
      );
    });
  });

  it('never travels more than half a turn', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a0a, 300, (sampler, context) => {
      const from = sampler.range(-Math.PI, Math.PI);
      const to = sampler.range(-Math.PI, Math.PI);
      const travelled = Math.abs(lerpAngle(from, to, 1) - from);

      expect(
        travelled,
        formatPropertyFailure({ ...context, from, to }, 'at most pi', travelled),
      ).toBeLessThanOrEqual(Math.PI + 1e-9);
    });
  });
});

describe('easing', () => {
  it('starts at zero, ends at one, and passes through the midpoint', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
  });

  it('has zero velocity at both ends, which is what makes a fly-to read as a move', () => {
    // A curve with non-zero end velocity produces a visible jerk when the transition
    // starts and stops. Contract section 1.4 asks for smooth interpolation.
    const epsilon = 1e-4;
    const startVelocity = (easeInOutCubic(epsilon) - easeInOutCubic(0)) / epsilon;
    const endVelocity = (easeInOutCubic(1) - easeInOutCubic(1 - epsilon)) / epsilon;

    expect(startVelocity).toBeLessThan(0.01);
    expect(endVelocity).toBeLessThan(0.01);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const value = easeInOutCubic(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('clamps out-of-range input', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Z-up look-at
// ---------------------------------------------------------------------------

describe('Z-up look-at construction', () => {
  /**
   * WHY NOT Object3D.lookAt. It assumes Y-up, and the simulation frame is the J2000
   * ecliptic with Z toward ecliptic north. Using the three.js helper would roll the
   * camera so that the ecliptic plane appeared tilted.
   */
  it('points the camera at the target', () => {
    const from = new Vector3(10, 0, 0);
    const quaternion = lookAtZUp(from, new Vector3(0, 0, 0));

    // A camera looks along its own -Z.
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);
    expect(forward.x).toBeCloseTo(-1, 9);
    expect(forward.y).toBeCloseTo(0, 9);
    expect(forward.z).toBeCloseTo(0, 9);
  });

  it('keeps the camera up vector aligned with ecliptic north', () => {
    // The property that makes the ecliptic read as a plane. With a Y-up look-at this
    // would come out along world +Y instead.
    const quaternion = lookAtZUp(new Vector3(10, 0, 0), new Vector3(0, 0, 0));
    const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);

    expect(up.angleTo(ECLIPTIC_NORTH)).toBeCloseTo(0, 9);
  });

  it('produces an orthonormal right-handed basis for arbitrary directions', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a0b, 400, (sampler, context) => {
      const [x, y, z] = sampler.unitVector();
      const from = new Vector3(x, y, z).multiplyScalar(sampler.logRange(1, 1e6));
      const quaternion = lookAtZUp(from, new Vector3(0, 0, 0));

      const right = new Vector3(1, 0, 0).applyQuaternion(quaternion);
      const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
      const back = new Vector3(0, 0, 1).applyQuaternion(quaternion);

      for (const [name, vector] of [
        ['right', right],
        ['up', up],
        ['back', back],
      ] as const) {
        expect(
          Math.abs(vector.length() - 1),
          formatPropertyFailure({ ...context, axis: name }, 1, vector.length()),
        ).toBeLessThan(1e-9);
      }

      expect(Math.abs(right.dot(up))).toBeLessThan(1e-9);
      expect(Math.abs(right.dot(back))).toBeLessThan(1e-9);

      // Right-handed: right cross up must be back, not its negation.
      const cross = new Vector3().crossVectors(right, up);
      expect(cross.distanceTo(back)).toBeLessThan(1e-9);
    });
  });

  it('stays finite looking straight along the pole, where the basis is degenerate', () => {
    // World up is parallel to the view direction, so their cross product vanishes and no
    // unique basis exists. The rig prevents reaching this in orbit mode via the
    // elevation clamp, but free flight can, so it must not produce NaN.
    const quaternion = lookAtZUp(new Vector3(0, 0, 10), new Vector3(0, 0, 0));
    const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion);

    expect(Number.isFinite(forward.x)).toBe(true);
    expect(Number.isFinite(forward.y)).toBe(true);
    expect(Number.isFinite(forward.z)).toBe(true);
    expect(forward.z).toBeCloseTo(-1, 9);
  });

  it('returns identity for a zero-length view direction', () => {
    const quaternion = lookAtZUp(new Vector3(5, 5, 5), new Vector3(5, 5, 5));
    expect(quaternion.angleTo(new Quaternion())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Camera rig
// ---------------------------------------------------------------------------

describe('orbit arrangement', () => {
  it('places the camera at the requested distance from the target', () => {
    const rig = new CameraRig({ distance: 500 });
    rig.update(0);

    expect(rig.position.length()).toBeCloseTo(500, 6);
    expect(rig.distance).toBeCloseTo(500, 6);
  });

  it('measures elevation from the ecliptic plane, not from the pole', () => {
    // A Z-up spherical convention. At zero elevation the camera sits IN the plane, and
    // the sign convention must put positive elevation above it.
    const rig = new CameraRig({ distance: 100 });
    rig.orbitBy(0, -0.35);
    rig.update(0);
    expect(rig.position.z).toBeCloseTo(0, 6);

    rig.orbitBy(0, 0.5);
    rig.update(0);
    expect(rig.position.z).toBeGreaterThan(0);
    expect(rig.position.z).toBeCloseTo(100 * Math.sin(0.5), 6);
  });

  it('clamps elevation short of the pole', () => {
    // Prevents the degenerate look-at basis, and prevents the visible gimbal that would
    // occur as azimuth became meaningless.
    const rig = new CameraRig({ distance: 100 });
    rig.orbitBy(0, 100);
    rig.update(0);

    // Just short of straight down the axis, so a horizontal component survives.
    expect(Math.hypot(rig.position.x, rig.position.y)).toBeGreaterThan(0);
    expect(rig.position.z).toBeLessThan(100);

    rig.orbitBy(0, -200);
    rig.update(0);
    expect(Math.hypot(rig.position.x, rig.position.y)).toBeGreaterThan(0);
  });

  it('always looks at the target', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a0c, 200, (sampler, context) => {
      const rig = new CameraRig({ distance: sampler.logRange(1e-3, 1e7) });
      rig.orbitBy(sampler.range(-10, 10), sampler.range(-2, 2));
      rig.update(0);

      const forward = new Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
      const toTarget = rig.position.clone().negate().normalize();

      const angle = forward.angleTo(toTarget);
      expect(angle, formatPropertyFailure(context, 0, angle)).toBeLessThan(1e-6);
    });
  });
});

describe('dolly', () => {
  it('is multiplicative, so a notch covers the same proportion at any scale', () => {
    // An additive step is either imperceptible at overview or catastrophic at a surface,
    // because the usable range spans seven orders of magnitude.
    const rig = new CameraRig({ distance: 1e6 });
    rig.dollyBy(0.5);
    expect(rig.distance).toBeCloseTo(5e5, 3);

    const close = new CameraRig({ distance: 10 });
    close.dollyBy(0.5);
    expect(close.distance).toBeCloseTo(5, 6);

    // The same factor produced the same ratio at both ends.
    expect(1e6 / rig.distance).toBeCloseTo(10 / close.distance, 6);
  });

  it('refuses a factor that would invert or collapse the distance', () => {
    const rig = new CameraRig();
    expect(() => rig.dollyBy(0)).toThrow(/positive/);
    expect(() => rig.dollyBy(-1)).toThrow(/positive/);
    expect(() => rig.dollyBy(Number.NaN)).toThrow(/finite/);
  });

  it('stops just clear of the target surface', () => {
    // Contract section 1.4 requires a close-orbit view, and it is reachable precisely
    // because the depth planner uses a dynamic near plane. Stopping at 1.02 radii puts
    // the camera outside the surface without a wide standoff.
    const rig = new CameraRig({ distance: 1000 });
    const radius = 6.371;
    rig.focusOn('earth', new Vector3(0, 0, 0), radius, 1000);
    rig.setReducedMotion(true);

    for (let step = 0; step < 200; step++) rig.dollyBy(0.5);
    rig.update(0);

    expect(rig.distance).toBeCloseTo(radius * MIN_DISTANCE_RADII, 6);
    // Outside the surface, which is what keeps the body visible rather than inverted.
    expect(rig.distance).toBeGreaterThan(radius);
  });
});

describe('pan', () => {
  it('moves the target by a screen-proportional amount', () => {
    // Deltas are in units of the visible half-height, so a pan of 1 moves the target by
    // half a screen at any zoom. A world-space delta would be unusable across the range.
    const rig = new CameraRig({ distance: 1000 });
    rig.update(0);
    const before = rig.position.clone();

    rig.panBy(1, 0);
    rig.update(0);

    const halfHeight = 1000 * Math.tan((DEFAULT_FOV_DEG * Math.PI) / 360);
    expect(rig.position.distanceTo(before)).toBeCloseTo(halfHeight, 3);
  });

  it('detaches from a tracked body, since otherwise the pan would be undone', () => {
    // Follow mode re-reads the target from the body every frame, so a pan that left the
    // tracking in place would snap back on the next update and the gesture would appear
    // not to work.
    const rig = new CameraRig({ distance: 100 });
    rig.focusOn('earth', new Vector3(1000, 0, 0), 6.371, 100);
    rig.setReducedMotion(true);
    rig.update(0);

    expect(rig.targetBodyId).toBe('earth');

    rig.panBy(0.5, 0);
    expect(rig.targetBodyId).toBeNull();

    // And the pan survives a subsequent update rather than being reverted.
    const afterPan = rig.position.clone();
    rig.update(0.016, () => ({ position: new Vector3(1000, 0, 0), radius: 6.371 }));
    expect(rig.position.distanceTo(afterPan)).toBeLessThan(1e-6);
  });
});

describe('follow mode', () => {
  it('tracks a moving body without a separate mode', () => {
    // Follow is orbit with a target that is re-read each frame. Collapsing it this way
    // means there is one state machine rather than two that must be kept consistent.
    const rig = new CameraRig({ distance: 50 });
    rig.setReducedMotion(true);
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 50);

    let bodyPosition = new Vector3(0, 0, 0);
    const resolve = (): { position: Vector3; radius: number } => ({
      position: bodyPosition,
      radius: 6.371,
    });

    rig.update(0, resolve);
    const initialOffset = rig.position.clone();

    // The body moves a long way, as Earth does over a few simulated days.
    bodyPosition = new Vector3(2.6e6, 1e5, 0);
    rig.update(0.016, resolve);

    // The camera followed, keeping the same relative arrangement.
    const newOffset = rig.position.clone().sub(bodyPosition);
    expect(newOffset.distanceTo(initialOffset)).toBeLessThan(1e-6);
    expect(rig.distance).toBeCloseTo(50, 6);
  });

  it('re-applies the distance floor when the visual radius changes', () => {
    // Switching from scientific to visualized scale multiplies visual radii by eight, so
    // a distance that was outside the surface can end up inside it.
    const rig = new CameraRig({ distance: 10 });
    rig.setReducedMotion(true);
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 10);
    rig.update(0, () => ({ position: new Vector3(0, 0, 0), radius: 6.371 }));
    expect(rig.distance).toBeCloseTo(10, 6);

    // Radius grows past the current distance.
    rig.update(0.016, () => ({ position: new Vector3(0, 0, 0), radius: 50.968 }));
    expect(rig.distance).toBeCloseTo(50.968 * MIN_DISTANCE_RADII, 6);
  });

  it('keeps a fixed target when no body is tracked', () => {
    const rig = new CameraRig({ distance: 100 });
    rig.update(0);
    const before = rig.position.clone();

    rig.update(0.016, () => ({ position: new Vector3(9999, 9999, 9999), radius: 1 }));
    expect(rig.position.distanceTo(before)).toBeLessThan(1e-9);
  });
});

describe('transitions', () => {
  it('eases over the configured duration', () => {
    const rig = new CameraRig({ distance: 1e6, flyDurationSeconds: 1 });
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 20);

    expect(rig.isTransitioning).toBe(true);
    expect(rig.transitionProgress).toBe(0);

    rig.update(0.5);
    expect(rig.transitionProgress).toBeCloseTo(0.5, 6);
    expect(rig.isTransitioning).toBe(true);
    // Log interpolation, so halfway is near the geometric mean rather than the midpoint.
    expect(rig.distance).toBeLessThan(1e5);

    rig.update(0.5);
    expect(rig.isTransitioning).toBe(false);
    expect(rig.distance).toBeCloseTo(20, 6);
  });

  it('uses the documented default duration', () => {
    const rig = new CameraRig({ distance: 1e3 });
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 20);

    rig.update(DEFAULT_FLY_DURATION_SECONDS - 0.01);
    expect(rig.isTransitioning).toBe(true);
    rig.update(0.02);
    expect(rig.isTransitioning).toBe(false);
  });

  it('aims at where a tracked body is on arrival, not where it was on departure', () => {
    // Over a long flight at a high time rate the target moves substantially. Aiming at
    // the departure position would land the camera short.
    const rig = new CameraRig({ distance: 1e6, flyDurationSeconds: 1 });

    let bodyPosition = new Vector3(0, 0, 0);
    const resolve = (): { position: Vector3; radius: number } => ({
      position: bodyPosition,
      radius: 6.371,
    });

    rig.focusOn('earth', bodyPosition.clone(), 6.371, 20);
    rig.update(0.5, resolve);

    bodyPosition = new Vector3(1e6, 0, 0);
    rig.update(0.5, resolve);

    // Arrived at the body's CURRENT position.
    expect(rig.position.distanceTo(bodyPosition)).toBeCloseTo(20, 3);
  });

  it('applies immediately under reduced motion', () => {
    // Contract section 28. Injected rather than read from matchMedia inside the class, so
    // the path is testable and the render layer does not reach into the DOM.
    const rig = new CameraRig({ distance: 1e6, reducedMotion: true });
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 20);

    expect(rig.isTransitioning).toBe(false);
    expect(rig.distance).toBeCloseTo(20, 6);
  });

  it('completes an in-flight transition when reduced motion is switched on', () => {
    // The user has just asked for no motion, so leaving an animation running would be
    // the wrong response.
    const rig = new CameraRig({ distance: 1e6, flyDurationSeconds: 2 });
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 20);
    rig.update(0.1);
    expect(rig.isTransitioning).toBe(true);

    rig.setReducedMotion(true);
    expect(rig.isTransitioning).toBe(false);
    expect(rig.distance).toBeCloseTo(20, 6);
  });

  it('is cancelled by a direct gesture', () => {
    // A user grabbing the camera mid-flight expects to take control, not to fight the
    // animation.
    const rig = new CameraRig({ distance: 1e6, flyDurationSeconds: 2 });
    rig.focusOn('earth', new Vector3(0, 0, 0), 6.371, 20);
    rig.update(0.1);
    expect(rig.isTransitioning).toBe(true);

    rig.orbitBy(0.1, 0);
    expect(rig.isTransitioning).toBe(false);
  });

  it('returns to the initial arrangement on reset', () => {
    const rig = new CameraRig({ distance: 1234, reducedMotion: true });
    rig.focusOn('earth', new Vector3(5e5, 0, 0), 6.371, 20);
    rig.update(0);

    rig.reset();
    rig.update(0);

    expect(rig.distance).toBeCloseTo(1234, 6);
    expect(rig.targetBodyId).toBeNull();
    expect(rig.position.length()).toBeCloseTo(1234, 6);
  });

  it('reports idle progress as complete', () => {
    expect(new CameraRig().transitionProgress).toBe(1);
  });
});

describe('free flight', () => {
  it('preserves position and orientation when entering, so the view does not jump', () => {
    // Continuity across a mode switch. Without it the user loses their place in the
    // scene, which at astronomical scale means losing it entirely.
    const rig = new CameraRig({ distance: 500 });
    rig.orbitBy(0.7, 0.3);
    rig.update(0);

    const position = rig.position.clone();
    const quaternion = rig.quaternion.clone();

    rig.enterFreeMode();
    rig.update(0);

    expect(rig.currentMode).toBe('FREE');
    expect(rig.position.distanceTo(position)).toBeLessThan(1e-9);
    expect(rig.quaternion.angleTo(quaternion)).toBeLessThan(1e-9);
  });

  it('moves along its own axes', () => {
    const rig = new CameraRig({ distance: 100 });
    rig.enterFreeMode();
    rig.update(0);

    const forward = new Vector3(0, 0, -1).applyQuaternion(rig.quaternion);
    const before = rig.position.clone();

    rig.flyBy(10, 0, 0);
    rig.update(0);

    const moved = rig.position.clone().sub(before);
    expect(moved.length()).toBeCloseTo(10, 6);
    expect(moved.normalize().angleTo(forward)).toBeLessThan(1e-6);
  });

  it('keeps vertical movement vertical rather than tilting with the view', () => {
    // Using world up rather than camera up is what makes free flight controllable: a
    // pitched camera would otherwise drift sideways when the user asked to rise.
    const rig = new CameraRig({ distance: 100 });
    rig.enterFreeMode();
    rig.lookBy(0, 0.6);
    rig.update(0);

    const before = rig.position.clone();
    rig.flyBy(0, 0, 10);
    rig.update(0);

    const moved = rig.position.clone().sub(before);
    expect(moved.x).toBeCloseTo(0, 6);
    expect(moved.y).toBeCloseTo(0, 6);
    expect(moved.z).toBeCloseTo(10, 6);
  });

  it('does not accumulate roll under repeated yaw', () => {
    // Yaw about world up rather than camera up. Yawing about the camera's own up vector
    // introduces roll that compounds, and the horizon slowly tilts.
    const rig = new CameraRig({ distance: 100 });
    rig.enterFreeMode();
    rig.lookBy(0, 0.4);

    for (let step = 0; step < 40; step++) rig.lookBy(0.15, 0);
    rig.update(0);

    // The camera's right vector must stay in the ecliptic plane if no roll accumulated.
    const right = new Vector3(1, 0, 0).applyQuaternion(rig.quaternion);
    expect(Math.abs(right.dot(ECLIPTIC_NORTH))).toBeLessThan(1e-6);
  });

  it('resumes orbiting whatever it is looking at', () => {
    // Returning to orbit mode must not snap back to the previous target, which could be
    // millions of units away.
    const rig = new CameraRig({ distance: 100 });
    rig.enterFreeMode();
    rig.flyBy(0, 0, 0);
    rig.lookBy(0.5, 0.2);
    rig.update(0);

    const position = rig.position.clone();
    const quaternion = rig.quaternion.clone();

    rig.enterOrbitMode();
    rig.update(0);

    expect(rig.currentMode).toBe('ORBIT');
    // Continuous: the camera has not moved and is still looking the same way.
    expect(rig.position.distanceTo(position)).toBeLessThan(1e-6);
    expect(rig.quaternion.angleTo(quaternion)).toBeLessThan(1e-6);
  });

  it('ignores orbit gestures in free mode and flight gestures in orbit mode', () => {
    const rig = new CameraRig({ distance: 100 });
    rig.enterFreeMode();
    rig.update(0);
    const freePosition = rig.position.clone();

    rig.orbitBy(1, 1);
    rig.dollyBy(0.5);
    rig.panBy(1, 1);
    rig.update(0);
    expect(rig.position.distanceTo(freePosition)).toBeLessThan(1e-9);

    rig.enterOrbitMode();
    rig.update(0);
    const orbitPosition = rig.position.clone();

    rig.flyBy(100, 100, 100);
    rig.lookBy(1, 1);
    rig.update(0);
    expect(rig.position.distanceTo(orbitPosition)).toBeLessThan(1e-9);
  });
});

describe('shared camera state', () => {
  it('reports the camera at the render origin, not at its absolute position', () => {
    /**
     * THE CRITICAL DETAIL. The floating origin tracks the camera exactly, so in
     * origin-relative coordinates the camera is at the origin by construction. Returning
     * the absolute position here would apply the offset twice and place every body at
     * double its true distance.
     */
    const rig = new CameraRig({ distance: 1.5e5 });
    rig.update(0);

    expect(rig.position.length()).toBeCloseTo(1.5e5, 3);
    expect(rig.sharedState().position.length()).toBe(0);
  });

  it('carries the orientation, field of view and aspect ratio', () => {
    const rig = new CameraRig({ distance: 100, fovDeg: 55 });
    rig.setAspect(ASPECT);
    rig.orbitBy(0.4, 0.2);
    rig.update(0);

    const shared = rig.sharedState();
    expect(shared.fovDeg).toBe(55);
    expect(shared.aspect).toBeCloseTo(ASPECT, 12);
    expect(shared.quaternion.angleTo(rig.quaternion)).toBeLessThan(1e-12);
  });

  it('hands out a copy, so a caller cannot mutate rig state', () => {
    const rig = new CameraRig({ distance: 100 });
    rig.update(0);

    const shared = rig.sharedState();
    shared.quaternion.set(1, 0, 0, 0);

    expect(rig.quaternion.angleTo(shared.quaternion)).toBeGreaterThan(0);
  });

  it('rejects an invalid aspect ratio or field of view', () => {
    const rig = new CameraRig();
    expect(() => rig.setAspect(0)).toThrow(/positive/);
    expect(() => rig.setAspect(-1)).toThrow(/positive/);
    expect(() => rig.setFov(0)).toThrow(/\(0, 180\)/);
    expect(() => rig.setFov(180)).toThrow(/\(0, 180\)/);
  });

  it('rejects a negative frame delta', () => {
    // Time never runs backwards between frames; a negative delta indicates an upstream
    // clock anomaly.
    expect(() => new CameraRig().update(-1)).toThrow(/non-negative/);
    expect(() => new CameraRig().update(Number.NaN)).toThrow(/finite/);
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * A view-space position that projects to a given screen pixel at a given depth.
 *
 * Inverts the perspective projection, so a test can place a body exactly where it needs
 * it on screen rather than solving for coordinates by hand. Derived from
 *
 *   ndcX = x_view * (cot(fov/2) / aspect) / depth
 *   ndcY = y_view * cot(fov/2) / depth
 *
 * with the screen-to-NDC mapping inverted, remembering that screen y runs downward.
 */
function positionForScreen(
  screenXPx: number,
  screenYPx: number,
  depth: number,
): Vector3 {
  const cot = 1 / Math.tan((DEFAULT_FOV_DEG * Math.PI) / 360);
  const ndcX = (screenXPx / VIEWPORT_WIDTH_PX) * 2 - 1;
  const ndcY = 1 - (screenYPx / VIEWPORT_HEIGHT_PX) * 2;

  return new Vector3((ndcX * depth * ASPECT) / cot, (ndcY * depth) / cot, -depth);
}

/** A camera set for the standard test viewport, at the origin looking along -Z. */
function testCameras(): LayeredCameras {
  const cameras = new LayeredCameras();
  cameras.setShared({ aspect: ASPECT, fovDeg: DEFAULT_FOV_DEG });
  return cameras;
}

function candidate(
  bodyId: string,
  position: Vector3,
  visualRadius: number,
  priority = 0,
): SelectionCandidate {
  return { bodyId, relativePosition: position, visualRadius, priority };
}

const SELECTION_OPTIONS = {
  widthPx: VIEWPORT_WIDTH_PX,
  heightPx: VIEWPORT_HEIGHT_PX,
} as const;

describe('per-body selection threshold', () => {
  /**
   * THE CORRECTION TO A FIXED 14 PIXEL TEST.
   *
   * Contract section 7.1 names 14 pixels, which suits a sub-pixel body and fails badly
   * for a close one. Measured for Earth, visual radius 6.371 render units, at this field
   * of view and viewport:
   *
   *   camera distance   apparent radius
   *   1e5 units          0.1 px
   *   1e3 units          8.3 px
   *   1e2 units         83.1 px
   *   20 units         415.3 px
   *   3.2 units       2595.5 px
   *
   * A cursor anywhere on the visible disc must select the body, so the threshold has to
   * be max(base, apparentRadius).
   */
  it('selects a sub-pixel body within the base tolerance', () => {
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    // Mercury at overview: apparent radius measured at 0.018 px, so effectively a point.
    const mercury = candidate('mercury', positionForScreen(centre.x, centre.y, 1.79e5), 2.4394);

    const inside = pickBody(cameras, [mercury], centre.x + 10, centre.y, SELECTION_OPTIONS);
    expect(inside.bodyId).toBe('mercury');
    expect(inside.hit!.tier).toBe('PROXIMITY');
    expect(inside.hit!.apparentRadiusPx).toBeLessThan(1);

    const outside = pickBody(cameras, [mercury], centre.x + 20, centre.y, SELECTION_OPTIONS);
    expect(outside.bodyId).toBeNull();
  });

  it('selects anywhere on a large body disc, far beyond the base tolerance', () => {
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    // Earth at 20 units: apparent radius measured at 415.3 px.
    const earth = candidate('earth', positionForScreen(centre.x, centre.y, 20), 6.371);
    const expectedRadiusPx = apparentRadiusPixels(6.371, 20, DEFAULT_FOV_DEG, VIEWPORT_HEIGHT_PX);
    expect(expectedRadiusPx).toBeCloseTo(415.3, 0);

    // 300 px off centre is far outside the 14 px base tolerance but well inside the disc.
    const onDisc = pickBody(cameras, [earth], centre.x + 300, centre.y, SELECTION_OPTIONS);
    expect(onDisc.bodyId).toBe('earth');
    expect(onDisc.hit!.tier).toBe('DIRECT');
    expect(onDisc.hit!.thresholdPx).toBeCloseTo(expectedRadiusPx, 0);

    // Just beyond the limb, nothing is selected.
    const offDisc = pickBody(
      cameras,
      [earth],
      centre.x + expectedRadiusPx + 5,
      centre.y,
      SELECTION_OPTIONS,
    );
    expect(offDisc.bodyId).toBeNull();
  });

  it('never falls below the base tolerance', () => {
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };
    const tiny = candidate('tiny', positionForScreen(centre.x, centre.y, 1e6), 0);

    const result = pickBody(cameras, [tiny], centre.x + 13, centre.y, SELECTION_OPTIONS);
    expect(result.bodyId).toBe('tiny');
    expect(result.hit!.thresholdPx).toBe(DEFAULT_SELECTION_RADIUS_PX);
  });

  it('offers a larger tolerance for touch input', () => {
    // A fingertip contact patch spans roughly 40 CSS pixels, so touch pointing is far
    // coarser than mouse pointing. Contract section 6 requires tap to select.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };
    const body = candidate('mercury', positionForScreen(centre.x, centre.y, 1.79e5), 2.4394);

    const mouse = pickBody(cameras, [body], centre.x + 25, centre.y, SELECTION_OPTIONS);
    expect(mouse.bodyId).toBeNull();

    const touch = pickBody(cameras, [body], centre.x + 25, centre.y, {
      ...SELECTION_OPTIONS,
      baseRadiusPx: TOUCH_SELECTION_RADIUS_PX,
    });
    expect(touch.bodyId).toBe('mercury');
  });

  it('uses CSS pixels rather than device pixels', () => {
    // Pointer events report CSS pixels, and a hit tolerance should be a consistent
    // physical size rather than shrinking on a high-density display. An earlier plan
    // scaled the threshold by devicePixelRatio, which would have halved the effective
    // tolerance at 2x.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };
    const body = candidate('mercury', positionForScreen(centre.x, centre.y, 1.79e5), 2.4394);

    const result = pickBody(cameras, [body], centre.x + 13, centre.y, SELECTION_OPTIONS);
    expect(result.hit!.thresholdPx).toBe(DEFAULT_SELECTION_RADIUS_PX);
  });
});

describe('two-tier ordering', () => {
  /**
   * THE CASE WHERE LITERAL SECTION 7.1 ORDERING PICKS THE WRONG BODY.
   *
   * Camera 8 units from Earth's centre, with the Moon visible beyond it. Measured
   * apparent radii: Earth 1038.2 px, Moon 5.77 px. A cursor 300 px from Earth's centre
   * is well inside Earth's disc, but if the Moon happens to project within a few pixels
   * of that cursor then "smallest screen distance wins" selects the Moon, which is 384
   * render units BEHIND the body the user is pointing at.
   */
  /**
   * The shared arrangement for both orderings below: camera 8 units from Earth's centre,
   * Moon a lunar orbit beyond it. Measured apparent radii are Earth 1038.2 px and
   * Moon 5.77 px, so Earth's disc covers most of the viewport while the Moon is a few
   * pixels across.
   */
  const EARTH_DEPTH = 8;
  const EARTH_RADIUS = 6.371;
  const MOON_DEPTH = 8 + 384.4;
  const MOON_RADIUS = 1.7374;

  /** Cursor well inside Earth's disc but far outside the base tolerance. */
  const CURSOR_X = VIEWPORT_WIDTH_PX / 2 + 300;
  const CURSOR_Y = VIEWPORT_HEIGHT_PX / 2;

  function earthCandidate(): SelectionCandidate {
    return candidate(
      'earth',
      positionForScreen(VIEWPORT_WIDTH_PX / 2, VIEWPORT_HEIGHT_PX / 2, EARTH_DEPTH),
      EARTH_RADIUS,
    );
  }

  it('prefers the nearer body when both are under the cursor', () => {
    /**
     * BOTH HITS ARE DIRECT HERE, which an earlier version of this test got wrong.
     *
     * Placing the Moon exactly at the cursor gives it a screen distance of zero, and zero
     * is inside its own 5.77 px disc, so it qualifies as DIRECT rather than PROXIMITY.
     * The tier does not separate them; depth does.
     *
     * The case still demonstrates why literal contract section 7.1 ordering is wrong.
     * Under "smallest screen distance wins" the Moon takes it at 0 px against Earth's
     * 300 px, despite sitting 384 render units behind the body the cursor is on.
     */
    const cameras = testCameras();
    const moon = candidate('moon', positionForScreen(CURSOR_X, CURSOR_Y, MOON_DEPTH), MOON_RADIUS);

    const result = pickBody(cameras, [earthCandidate(), moon], CURSOR_X, CURSOR_Y, SELECTION_OPTIONS);

    expect(result.bodyId).toBe('earth');

    const earthHit = result.candidates.find((hit) => hit.bodyId === 'earth')!;
    const moonHit = result.candidates.find((hit) => hit.bodyId === 'moon')!;

    // Both inside their own discs.
    expect(earthHit.tier).toBe('DIRECT');
    expect(moonHit.tier).toBe('DIRECT');

    // And the Moon really is much closer in screen space, so the depth ordering is doing
    // the work rather than the screen-distance ordering happening to agree.
    expect(moonHit.screenDistancePx).toBeCloseTo(0, 3);
    expect(earthHit.screenDistancePx).toBeCloseTo(300, 3);
    expect(earthHit.depth).toBeLessThan(moonHit.depth);

    expect(earthHit.apparentRadiusPx).toBeCloseTo(1038.2, 0);
    expect(moonHit.apparentRadiusPx).toBeCloseTo(5.77, 1);
  });

  it('prefers a direct hit over a proximity hit that is nearer in pixels', () => {
    /**
     * THE TIER PRECEDENCE ITSELF, which needs the Moon OUTSIDE its own disc but still
     * inside the base tolerance. Its apparent radius is 5.77 px and the base tolerance is
     * 14 px, so a cursor 10 px away satisfies both: outside the disc, therefore PROXIMITY,
     * and within threshold, therefore eligible.
     *
     * Earth wins on tier alone, with a screen distance thirty times larger.
     */
    const cameras = testCameras();
    const moon = candidate(
      'moon',
      positionForScreen(CURSOR_X + 10, CURSOR_Y, MOON_DEPTH),
      MOON_RADIUS,
    );

    const result = pickBody(cameras, [earthCandidate(), moon], CURSOR_X, CURSOR_Y, SELECTION_OPTIONS);

    expect(result.bodyId).toBe('earth');

    const earthHit = result.candidates.find((hit) => hit.bodyId === 'earth')!;
    const moonHit = result.candidates.find((hit) => hit.bodyId === 'moon')!;

    expect(earthHit.tier).toBe('DIRECT');
    expect(moonHit.tier).toBe('PROXIMITY');

    // Outside its own disc, inside the base tolerance.
    expect(moonHit.screenDistancePx).toBeGreaterThan(moonHit.apparentRadiusPx);
    expect(moonHit.screenDistancePx).toBeLessThanOrEqual(DEFAULT_SELECTION_RADIUS_PX);

    // Won on tier despite being far closer in pixels.
    expect(earthHit.screenDistancePx).toBeGreaterThan(moonHit.screenDistancePx * 20);
  });

  it('orders two direct hits by depth, nearest first', () => {
    // Both under the cursor, so the nearer one is the one actually visible there.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    const near = candidate('near', positionForScreen(centre.x, centre.y, 20), 6.371);
    const far = candidate('far', positionForScreen(centre.x, centre.y, 2000), 637.1);

    const result = pickBody(cameras, [far, near], centre.x, centre.y, SELECTION_OPTIONS);
    expect(result.bodyId).toBe('near');
    expect(result.candidates.map((hit) => hit.bodyId)).toEqual(['near', 'far']);
  });

  it('preserves the section 7.1 ordering among proximity hits', () => {
    // At overview every candidate is sub-pixel, so every hit is a proximity hit and the
    // published ordering applies unchanged: screen distance, then depth, then priority.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    const closest = candidate('closest', positionForScreen(centre.x + 2, centre.y, 1e5), 2);
    const middle = candidate('middle', positionForScreen(centre.x + 7, centre.y, 1e5), 2);
    const furthest = candidate('furthest', positionForScreen(centre.x + 12, centre.y, 1e5), 2);

    const result = pickBody(
      cameras,
      [furthest, closest, middle],
      centre.x,
      centre.y,
      SELECTION_OPTIONS,
    );

    expect(result.candidates.every((hit) => hit.tier === 'PROXIMITY')).toBe(true);
    expect(result.candidates.map((hit) => hit.bodyId)).toEqual([
      'closest',
      'middle',
      'furthest',
    ]);
  });

  it('breaks a near tie in screen distance on depth', () => {
    // Contract section 7.1 asks for a depth tie-break when candidates are nearly tied.
    // Two pixels is about a cursor hotspot, so within that the user cannot have meant
    // one rather than the other.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    const nearer = candidate('nearer', positionForScreen(centre.x + 11, centre.y, 5e4), 2);
    const further = candidate('further', positionForScreen(centre.x + 10, centre.y, 5e5), 2);

    // The further body is marginally closer in pixels, inside the tie window.
    const result = pickBody(cameras, [further, nearer], centre.x, centre.y, SELECTION_OPTIONS);

    const gap = Math.abs(
      result.candidates[0]!.screenDistancePx - result.candidates[1]!.screenDistancePx,
    );
    expect(gap).toBeLessThanOrEqual(SELECTION_TIE_PIXELS);
    expect(result.bodyId).toBe('nearer');
  });

  it('breaks a full tie on priority', () => {
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    const low = candidate('low', positionForScreen(centre.x + 5, centre.y, 1e5), 2, 1);
    const high = candidate('high', positionForScreen(centre.x + 5, centre.y, 1e5), 2, 10);

    const result = pickBody(cameras, [low, high], centre.x, centre.y, SELECTION_OPTIONS);
    expect(result.bodyId).toBe('high');
  });

  it('is deterministic regardless of the order candidates were supplied', () => {
    // The ordering must be total, or a result could depend on iteration order and the
    // same click would select different bodies on different frames.
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };

    const a = candidate('alpha', positionForScreen(centre.x + 5, centre.y, 1e5), 2, 0);
    const b = candidate('beta', positionForScreen(centre.x + 5, centre.y, 1e5), 2, 0);

    const forward = pickBody(cameras, [a, b], centre.x, centre.y, SELECTION_OPTIONS);
    const reversed = pickBody(cameras, [b, a], centre.x, centre.y, SELECTION_OPTIONS);

    expect(reversed.bodyId).toBe(forward.bodyId);
    expect(reversed.candidates.map((hit) => hit.bodyId)).toEqual(
      forward.candidates.map((hit) => hit.bodyId),
    );
  });
});

describe('selection edge cases', () => {
  it('rejects a body behind the camera', () => {
    /**
     * THE TRAP THE w COMPONENT CLOSES. A point behind the camera projects to a plausible
     * NDC pair: view position (10, 5, 50) yields (-0.2716, -0.2414), comfortably inside
     * the viewport. Without a sign test on w it would be selectable at a pixel where
     * nothing is drawn.
     */
    const cameras = testCameras();
    const behind = candidate('behind', new Vector3(10, 5, 50), 100);

    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };
    for (const offset of [0, 100, 400]) {
      const result = pickBody(cameras, [behind], centre.x + offset, centre.y, SELECTION_OPTIONS);
      expect(result.bodyId, `offset ${offset}`).toBeNull();
    }
  });

  it('returns null when nothing is within threshold', () => {
    const cameras = testCameras();
    const body = candidate('earth', positionForScreen(100, 100, 1e4), 6.371);

    const result = pickBody(cameras, [body], 1800, 1000, SELECTION_OPTIONS);
    expect(result.bodyId).toBeNull();
    expect(result.hit).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('handles an empty candidate list', () => {
    const result = pickBody(testCameras(), [], 100, 100, SELECTION_OPTIONS);
    expect(result.bodyId).toBeNull();
  });

  it('rejects an invalid viewport', () => {
    const cameras = testCameras();
    expect(() => pickBody(cameras, [], 0, 0, { widthPx: 0, heightPx: 1080 })).toThrow(/positive/);
    expect(() => pickBody(cameras, [], 0, 0, { widthPx: 1920, heightPx: -1 })).toThrow(/positive/);
  });

  it('reports the projected centre, so the interface can place a label', () => {
    const cameras = testCameras();
    const target = { x: 1200, y: 400 };
    const body = candidate('earth', positionForScreen(target.x, target.y, 5e3), 6.371);

    const result = pickBody(cameras, [body], target.x, target.y, SELECTION_OPTIONS);
    expect(result.hit!.screenX).toBeCloseTo(target.x, 3);
    expect(result.hit!.screenY).toBeCloseTo(target.y, 3);
  });

  it('reports depth as the view-space distance', () => {
    const cameras = testCameras();
    const centre = { x: VIEWPORT_WIDTH_PX / 2, y: VIEWPORT_HEIGHT_PX / 2 };
    const body = candidate('earth', positionForScreen(centre.x, centre.y, 1234.5), 6.371);

    const result = pickBody(cameras, [body], centre.x, centre.y, SELECTION_OPTIONS);
    expect(result.hit!.depth).toBeCloseTo(1234.5, 6);
  });
});

describe('candidate construction', () => {
  it('subtracts the origin in f64, before anything reaches a projection matrix', () => {
    // Absolute coordinates would be quantised by the projection exactly as geometry
    // would be, so picking would disagree with what is on screen by the same error the
    // floating origin exists to remove.
    const origin = { x: 1.5e5, y: -2e5, z: 3e4 };
    const bodies = [
      {
        bodyId: 'earth',
        renderPosition: { x: 1.5e5 + 10, y: -2e5, z: 3e4 },
        visualRadius: 6.371,
      },
    ];

    const candidates = buildCandidates(bodies, origin, () => 0);
    expect(candidates).toHaveLength(1);

    const relative = candidates[0]!.relativePosition;
    expect(relative.x).toBeCloseTo(10, 9);
    expect(relative.y).toBeCloseTo(0, 9);
    expect(relative.z).toBeCloseTo(0, 9);
    // Small, so f32 resolves it finely: the whole point of the subtraction.
    expect(relative.length()).toBeLessThan(100);
  });

  it('carries the visual radius and the supplied priority', () => {
    const candidates = buildCandidates(
      [{ bodyId: 'sun', renderPosition: { x: 0, y: 0, z: 0 }, visualRadius: 695.7 }],
      { x: 0, y: 0, z: 0 },
      (bodyId) => (bodyId === 'sun' ? 5 : 0),
    );

    expect(candidates[0]!.visualRadius).toBeCloseTo(695.7, 6);
    expect(candidates[0]!.priority).toBe(5);
  });
});

describe('selection under randomised viewing conditions', () => {
  it('always selects a body when the cursor is on its disc and nothing occludes it', () => {
    // The invariant that matters for usability: pointing at a visible body selects it,
    // at any distance and any zoom.
    forEachSample(DEFAULT_SEED ^ 0x0a0d, 300, (sampler, context) => {
      const cameras = testCameras();
      const depth = sampler.logRange(5, 1e6);
      const radius = sampler.logRange(1, 700);

      const screenX = sampler.range(200, VIEWPORT_WIDTH_PX - 200);
      const screenY = sampler.range(200, VIEWPORT_HEIGHT_PX - 200);
      const body = candidate('target', positionForScreen(screenX, screenY, depth), radius);

      const apparent = apparentRadiusPixels(radius, depth, DEFAULT_FOV_DEG, VIEWPORT_HEIGHT_PX);
      // Somewhere inside the disc, or inside the base tolerance for a tiny body.
      const reach = Math.max(apparent, DEFAULT_SELECTION_RADIUS_PX) * 0.7;
      const cursorX = screenX + reach * Math.cos(sampler.range(0, 2 * Math.PI));
      const cursorY = screenY + reach * Math.sin(sampler.range(0, 2 * Math.PI));

      const result = pickBody(cameras, [body], cursorX, cursorY, SELECTION_OPTIONS);

      expect(
        result.bodyId,
        formatPropertyFailure(
          { ...context, depth, radius, apparent, reach },
          'target',
          result.bodyId,
        ),
      ).toBe('target');
    });
  });

  it('never selects anything beyond the applicable threshold', () => {
    forEachSample(DEFAULT_SEED ^ 0x0a0e, 300, (sampler, context) => {
      const cameras = testCameras();
      const depth = sampler.logRange(5, 1e6);
      const radius = sampler.logRange(1, 700);

      const screenX = VIEWPORT_WIDTH_PX / 2;
      const screenY = VIEWPORT_HEIGHT_PX / 2;
      const body = candidate('target', positionForScreen(screenX, screenY, depth), radius);

      const apparent = apparentRadiusPixels(radius, depth, DEFAULT_FOV_DEG, VIEWPORT_HEIGHT_PX);
      const threshold = Math.max(apparent, DEFAULT_SELECTION_RADIUS_PX);
      // Comfortably outside, so f64 rounding at the boundary cannot decide the outcome.
      const cursorX = screenX + threshold * 1.5 + 5;

      const result = pickBody(cameras, [body], cursorX, screenY, SELECTION_OPTIONS);
      expect(
        result.bodyId,
        formatPropertyFailure({ ...context, depth, radius, threshold }, null, result.bodyId),
      ).toBeNull();
    });
  });
});
