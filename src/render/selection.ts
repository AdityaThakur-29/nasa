/**
 * Hybrid body selection.
 *
 * WHY NOT RAYCASTING. Contract section 7 is explicit that raycasting is insufficient at
 * astronomical overview scale, and the reason is geometric rather than a matter of
 * tuning. At system overview Mercury's visual radius subtends about 0.1 pixels, so its
 * sphere covers a fraction of one fragment and a ray through the cursor centre misses
 * it almost always. Worse, the body is drawn as a MARKER at that size, so there is no
 * sphere under the cursor to hit at all: raycasting would test geometry that is not
 * what the user can see.
 *
 * THE MECHANISM. Project each body's centre to screen space and compare the cursor's
 * distance to it against a per-body threshold. That works identically for spheres and
 * for markers, because it tests the body's POSITION rather than its geometry, and the
 * position is what both representations indicate.
 *
 * THE THRESHOLD MUST BE PER-BODY, NOT FIXED, and this is the correction that makes the
 * scheme work at both ends. Contract section 7.1 names 14 pixels, which is right for a
 * sub-pixel body but badly wrong for a close one. Measured, for Earth at a visual
 * radius of 6.371 render units, 45 degree vertical field of view, 1080 pixels:
 *
 *   camera distance   apparent radius   cursor on the limb is...
 *   1e5 units          0.1 px           0.1 px from centre
 *   1e3 units          8.3 px           8.3 px from centre
 *   1e2 units         83.1 px           83 px from centre    a 14 px test MISSES
 *   20 units         415.3 px           415 px from centre   a 14 px test MISSES
 *   3.2 units       2595.5 px           2596 px from centre  a 14 px test MISSES
 *
 * So the threshold is max(base, apparentRadius): the base tolerance provides slop for a
 * small target, and the apparent radius makes the whole visible disc selectable.
 *
 * TWO TIERS, WHICH REFINES CONTRACT SECTION 7.1. That section says to take the smallest
 * screen distance, then break ties on depth, then on priority. Applied literally that
 * ordering picks the wrong body in an ordinary case: with the camera near Earth and the
 * Moon visible beyond it, a cursor on Earth's disc is perhaps 400 px from Earth's
 * centre but only 5 px from the Moon's, so the Moon wins on screen distance even though
 * Earth is what the user is pointing at and the Moon is behind it.
 *
 * The fix is to rank by whether the cursor is INSIDE the projected disc:
 *
 *   DIRECT hit      cursor within the body's apparent radius. Ordered by DEPTH, nearest
 *                   first, because the nearest body occludes the others.
 *   PROXIMITY hit   cursor within the base tolerance but outside the disc. Ordered by
 *                   screen distance, then depth, then priority, exactly as section 7.1
 *                   specifies.
 *
 * A direct hit always beats a proximity hit. The section 7.1 ordering is preserved
 * intact for the case it was written for, namely the sub-pixel overview where every
 * candidate is a proximity hit.
 *
 * The direct-hit test is also precisely a ray-sphere intersection, evaluated in screen
 * space: a ray through the cursor meets a sphere exactly when the cursor lies within
 * the projected disc. So the "optional close-range precision mechanism" section 7.1
 * permits is already present, without a scene traversal, and it extends to markers,
 * which a geometric raycast could not.
 *
 * THRESHOLDS ARE IN CSS PIXELS, NOT DEVICE PIXELS. Pointer events report CSS pixels, and
 * a hit tolerance should be a consistent physical size rather than shrinking on a
 * high-density display, so the device pixel ratio deliberately does not enter. An
 * earlier plan for this module scaled the threshold by devicePixelRatio, which would
 * have halved the effective tolerance on a 2x display.
 */

import type { Vector3 } from 'three';
import { Vector3 as ThreeVector3 } from 'three';
import {
  apparentRadiusPixels,
  ndcToPixels,
  projectToNdc,
  type LayeredCameras,
} from './layered-cameras';

/**
 * Base selection tolerance, CSS pixels.
 *
 * Contract section 7.1. Applies to a body smaller than this on screen; larger bodies use
 * their apparent radius instead.
 */
export const DEFAULT_SELECTION_RADIUS_PX = 14;

/**
 * Selection tolerance for touch input, CSS pixels.
 *
 * A fingertip contact patch covers roughly 40 CSS pixels, so the pointing precision
 * available to touch is far coarser than to a mouse. Contract section 6 requires tap to
 * select, and a 14 pixel target would make sub-pixel bodies effectively unselectable by
 * touch.
 */
export const TOUCH_SELECTION_RADIUS_PX = 32;

/**
 * Screen-distance difference below which two proximity candidates count as tied,
 * CSS pixels.
 *
 * Contract section 7.1 asks for a depth tie-break when candidates are "nearly tied" but
 * does not define nearly. Two pixels is about the width of a cursor hotspot, so within
 * that the user cannot have meant one rather than the other and depth is the better
 * discriminator.
 */
export const SELECTION_TIE_PIXELS = 2;

/** How a candidate qualified. */
export type SelectionTier =
  /** Cursor lies within the body's projected disc. */
  | 'DIRECT'
  /** Cursor lies within the base tolerance but outside the disc. */
  | 'PROXIMITY';

/** A body offered for selection. */
export interface SelectionCandidate {
  readonly bodyId: string;
  /**
   * Position in ORIGIN-RELATIVE render space, matching what the renderer draws.
   *
   * Absolute coordinates would be quantised by the projection matrices exactly as they
   * would be for geometry, so picking would disagree with what is on screen by the same
   * error the floating origin exists to remove.
   */
  readonly relativePosition: Vector3;
  /** Visual radius, render units. The drawn size, so picking matches appearance. */
  readonly visualRadius: number;
  /**
   * Tie-break priority. Higher wins.
   *
   * Only consulted when screen distance and depth are both indistinguishable, which in
   * practice means two bodies at the same pixel and the same range.
   */
  readonly priority: number;
}

/** One candidate's evaluation, retained for diagnostics and the interface. */
export interface SelectionHit {
  readonly bodyId: string;
  readonly tier: SelectionTier;
  /** Cursor distance to the projected centre, CSS pixels. */
  readonly screenDistancePx: number;
  /** Apparent radius of the body, CSS pixels. */
  readonly apparentRadiusPx: number;
  /** Threshold actually applied, CSS pixels. */
  readonly thresholdPx: number;
  /** Distance from the camera along the view direction, render units. */
  readonly depth: number;
  /** Projected centre in CSS pixels. */
  readonly screenX: number;
  readonly screenY: number;
}

export interface SelectionResult {
  /** The chosen body, or null when nothing was within threshold. */
  readonly bodyId: string | null;
  /** The winning hit, or null. */
  readonly hit: SelectionHit | null;
  /** Every eligible candidate, best first. Useful for a disambiguation affordance. */
  readonly candidates: readonly SelectionHit[];
}

export interface SelectionOptions {
  /** Base tolerance in CSS pixels. Defaults to DEFAULT_SELECTION_RADIUS_PX. */
  readonly baseRadiusPx?: number;
  /** Viewport width in CSS pixels. */
  readonly widthPx: number;
  /** Viewport height in CSS pixels. */
  readonly heightPx: number;
}

/**
 * Picks the body under a screen position.
 *
 * @param cursorXPx cursor x in CSS pixels, measured from the left of the viewport
 * @param cursorYPx cursor y in CSS pixels, measured from the TOP of the viewport, which
 *   is the convention pointer events use
 */
export function pickBody(
  cameras: LayeredCameras,
  candidates: readonly SelectionCandidate[],
  cursorXPx: number,
  cursorYPx: number,
  options: SelectionOptions,
): SelectionResult {
  const { widthPx, heightPx } = options;
  const baseRadiusPx = options.baseRadiusPx ?? DEFAULT_SELECTION_RADIUS_PX;

  if (!Number.isFinite(widthPx) || widthPx <= 0 || !Number.isFinite(heightPx) || heightPx <= 0) {
    throw new Error(
      `pickBody: viewport must be positive and finite, got ${widthPx} by ${heightPx}`,
    );
  }

  const fovDeg = cameras.sharedState.fovDeg;
  const hits: SelectionHit[] = [];

  for (const candidate of candidates) {
    const projected = projectToNdc(cameras, candidate.relativePosition);

    // BEHIND THE CAMERA. A point behind the camera projects to a plausible looking NDC
    // pair with negative w, so without this test a body behind the viewer would be
    // selectable at a pixel where nothing is drawn. Measured: view position (10, 5, 50)
    // projects to (-0.2716, -0.2414), comfortably inside the viewport, with w = -50.
    if (projected.w <= 0) continue;

    const { x: screenX, y: screenY } = ndcToPixels(projected.x, projected.y, widthPx, heightPx);
    const screenDistancePx = Math.hypot(cursorXPx - screenX, cursorYPx - screenY);

    // w is the view-space distance along the view direction, which is the depth to
    // compare candidates on.
    const depth = projected.w;
    const apparentRadiusPx =
      candidate.visualRadius > 0
        ? apparentRadiusPixels(candidate.visualRadius, depth, fovDeg, heightPx)
        : 0;

    const thresholdPx = Math.max(baseRadiusPx, apparentRadiusPx);
    if (screenDistancePx > thresholdPx) continue;

    hits.push({
      bodyId: candidate.bodyId,
      tier: screenDistancePx <= apparentRadiusPx ? 'DIRECT' : 'PROXIMITY',
      screenDistancePx,
      apparentRadiusPx,
      thresholdPx,
      depth,
      screenX,
      screenY,
    });
  }

  const priorities = new Map(candidates.map((entry) => [entry.bodyId, entry.priority]));
  const ordered = [...hits].sort((a, b) => compareHits(a, b, priorities));

  return {
    bodyId: ordered[0]?.bodyId ?? null,
    hit: ordered[0] ?? null,
    candidates: ordered,
  };
}

/**
 * Orders two eligible hits, best first.
 *
 * A DIRECT hit always precedes a PROXIMITY hit; see the module header for the case that
 * makes this necessary.
 */
function compareHits(
  a: SelectionHit,
  b: SelectionHit,
  priorities: ReadonlyMap<string, number>,
): number {
  // Tier dominates.
  if (a.tier !== b.tier) return a.tier === 'DIRECT' ? -1 : 1;

  if (a.tier === 'DIRECT') {
    // Both under the cursor, so the nearer one is the one actually visible there.
    if (a.depth !== b.depth) return a.depth - b.depth;
    return comparePriority(a, b, priorities);
  }

  // Contract section 7.1 ordering: screen distance, then depth, then priority.
  if (Math.abs(a.screenDistancePx - b.screenDistancePx) > SELECTION_TIE_PIXELS) {
    return a.screenDistancePx - b.screenDistancePx;
  }
  if (a.depth !== b.depth) return a.depth - b.depth;
  return comparePriority(a, b, priorities);
}

function comparePriority(
  a: SelectionHit,
  b: SelectionHit,
  priorities: ReadonlyMap<string, number>,
): number {
  const difference = (priorities.get(b.bodyId) ?? 0) - (priorities.get(a.bodyId) ?? 0);
  // Falling back to the id keeps the ordering total, so a result cannot depend on the
  // order candidates happened to be supplied in.
  return difference !== 0 ? difference : a.bodyId.localeCompare(b.bodyId);
}

/**
 * Builds selection candidates from scaled bodies and the current origin.
 *
 * Convenience for the frame loop, and the place the origin subtraction happens so no
 * caller has to remember it.
 */
export function buildCandidates(
  bodies: readonly {
    readonly bodyId: string;
    readonly renderPosition: { readonly x: number; readonly y: number; readonly z: number };
    readonly visualRadius: number;
  }[],
  origin: { readonly x: number; readonly y: number; readonly z: number },
  priorityOf: (bodyId: string) => number,
): readonly SelectionCandidate[] {
  return bodies.map((body) => ({
    bodyId: body.bodyId,
    // Subtraction in f64, before anything reaches a projection matrix.
    relativePosition: new ThreeVector3(
      body.renderPosition.x - origin.x,
      body.renderPosition.y - origin.y,
      body.renderPosition.z - origin.z,
    ),
    visualRadius: body.visualRadius,
    priority: priorityOf(body.bodyId),
  }));
}
