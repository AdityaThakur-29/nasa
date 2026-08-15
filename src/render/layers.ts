/**
 * Render layer assignments.
 *
 * WHY THIS MODULE EXISTS SEPARATELY. Layer numbers are shared between the objects that
 * are drawn and the cameras that draw them, so both sides need them. body-visuals.ts
 * already imports apparentRadiusPixels from layered-cameras.ts, so putting the constants
 * in body-visuals and importing them back into layered-cameras would create an import
 * cycle. This module imports nothing, so it can be depended on from anywhere in the
 * render layer.
 *
 * HOW LAYERS DRIVE THE MULTI-PASS RENDER. three.js renders an object only when the
 * camera's layer mask and the object's layer mask intersect. Each pass therefore has a
 * camera pinned to exactly one layer, and every object is pinned to the layer of the pass
 * that should draw it. One scene serves every pass, which keeps three.js's internal
 * render lists stable; moving objects between scenes would invalidate them every frame.
 *
 * BOTH SIDES MUST BE SET. An object with no layer assignment stays on layer 0 and is
 * drawn by nothing; a CAMERA with no layer assignment also stays on layer 0 and draws
 * nothing. The second case is easy to miss because it produces no error, no warning and
 * no missing-object diagnostic: the pass simply renders an empty scene. That is exactly
 * what happened during development, and the symptom was that the star field and the orbit
 * lines appeared while every planet was invisible, because those two passes assigned
 * their camera layers and the slab passes did not.
 */

import type { SlabId } from './depth-slabs';

/**
 * Layer 0 is deliberately UNUSED.
 *
 * three.js puts every new Object3D and every new Camera on layer 0. Reserving it means an
 * object that was never assigned a layer is drawn by no pass, and a camera that was never
 * assigned a layer draws no object. Both are bugs, and leaving layer 0 empty makes them
 * fail visibly rather than by silently picking up whichever pass happened to include it.
 */
export const UNASSIGNED_LAYER = 0;

/** Layer for each depth slab's geometry and its camera. */
export const SLAB_LAYERS: Readonly<Record<SlabId, number>> = {
  NEAR: 1,
  MIDDLE: 2,
  FAR: 3,
};

/** Layer for the star field pass. */
export const STARFIELD_LAYER = 4;

/** Layer for the orbit path pass. */
export const ORBIT_LAYER = 5;

/**
 * Every layer this application uses, for the isolation check in the test suite.
 *
 * Two passes sharing a layer would draw each other's objects with the wrong frustum and
 * the wrong depth state, so the distinctness of this list is asserted rather than assumed.
 */
export const ALL_RENDER_LAYERS: readonly number[] = [
  SLAB_LAYERS.NEAR,
  SLAB_LAYERS.MIDDLE,
  SLAB_LAYERS.FAR,
  STARFIELD_LAYER,
  ORBIT_LAYER,
];
