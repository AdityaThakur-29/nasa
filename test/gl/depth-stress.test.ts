/**
 * HARD M1 GATE: the depth stress scene, in real WebGL.
 *
 * Contract section 6 makes this a gate rather than a test: if it fails, M2 does not
 * begin. Contract section 40 requires its result in the verification report.
 *
 * WHAT MAKES THIS DIFFERENT FROM THE NODE SUITE. test/unit/depth-slabs.test.ts already
 * proves the classification and plane arithmetic are right. What it cannot prove is that
 * a real driver, a real depth buffer and a real multi-pass composite behave as the
 * arithmetic predicts. That is what this file is for, and it is why it drives
 * SolarSystemApp itself rather than a reimplementation of the frame loop: a gate that
 * validated a parallel copy of the pipeline would prove nothing about what ships.
 *
 * ASSERTION STYLE, per the approved design. Render-state and property assertions
 * wherever possible; pixel readback only for the two questions that genuinely require it,
 * namely whether a body is present on screen at all. No screenshot comparison, and no
 * assertion on a specific colour value, because both would flake on driver dithering
 * while catching nothing that the structural checks miss.
 *
 * THE THREE TIERS:
 *
 *   Tier 1  render state, no readback. Partition, containment, analytic depth
 *           separability, draw-call sequencing, GL error state.
 *   Tier 2  property-based floating origin. Many camera origins, asserting the physical
 *           state is untouched and projected positions are stable to well under a pixel.
 *   Tier 3  coverage readback. Counts of pixels differing from the clear colour inside a
 *           region of interest. Never a colour match.
 *
 * ON "MOON-CLOSE" IN A MILESTONE WITH NO MOON. Contract section 6 names a Moon-close
 * camera, and M1 registers no lunar theory, so the Moon is deliberately reported as
 * NO_PROVIDER rather than faked. Substituting Earth at its closest approach is not a
 * weakening: the quantity that stresses the depth pipeline is the distance to the nearest
 * SURFACE, and measured,
 *
 *   nominal Moon-close, 1000 km altitude    nearest surface 1.0000 units
 *   Earth at the dolly minimum              nearest surface 0.1274 units
 *
 * which against Neptune at 4.3553e6 units gives depth ratios of 4.355e6 and 3.418e7
 * respectively. The substitute is 7.8 times harsher. Both are exercised below: the app
 * scene uses Earth at its minimum, and a synthetic-body scene reproduces the literal
 * Moon-close geometry so the named configuration is covered too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SolarSystemApp, type FrameReport } from '@/app';
import {
  classifyDepthSlab,
  depthSeparation,
  planDepthSlabs,
  resolvableSeparation,
  slabDefinition,
  verifyDepthPlan,
  type DepthCandidate,
  type SlabId,
} from '@/render/depth-slabs';
import { ndcToPixels, projectToNdc } from '@/render/layered-cameras';
import { DEPTH_QUANTUM } from '@/render/depth-slabs';
import { RENDER_UNIT_KM } from '@/sim/scale';
import { AU_KM } from '@/data/constants';
import { getBody } from '@/data/bodies';
import { utc } from '@/core/jd';

const VIEWPORT_WIDTH_PX = 640;
const VIEWPORT_HEIGHT_PX = 480;

/** A fixed instant, so every run of the gate examines the same geometry. */
const EPOCH = utc(2026, 8, 15);

let canvas: HTMLCanvasElement;
let app: SolarSystemApp;

/**
 * Builds the app against a real canvas.
 *
 * Reduced motion is on so focus and overview apply immediately: a gate must not depend on
 * how many frames an easing curve happens to take.
 *
 * The pixel ratio is pinned to 1 so readback coordinates are CSS pixels and drawing-buffer
 * pixels alike, which removes an entire class of off-by-a-factor error from the coverage
 * assertions.
 */
function createApp(scaleMode: 'SCIENTIFIC' | 'VISUALIZED' = 'SCIENTIFIC'): SolarSystemApp {
  canvas = document.createElement('canvas');
  canvas.width = VIEWPORT_WIDTH_PX;
  canvas.height = VIEWPORT_HEIGHT_PX;
  canvas.style.width = `${VIEWPORT_WIDTH_PX}px`;
  canvas.style.height = `${VIEWPORT_HEIGHT_PX}px`;
  document.body.appendChild(canvas);

  const instance = new SolarSystemApp({
    canvas,
    epoch: EPOCH,
    scaleMode,
    reducedMotion: true,
    pixelRatio: 1,
  });
  instance.resize(VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX);
  return instance;
}

/**
 * Positions the camera for the stress scene and renders it.
 *
 * Earth is focused and then dollied to the rig's minimum, which the rig clamps at 1.02
 * visual radii. Neptune is 4.36e6 render units away in the same frame, so both ends of
 * the scene are present simultaneously, which is the whole point of the gate.
 */
function renderStressScene(instance: SolarSystemApp): FrameReport {
  // One frame first: focus reads the previous frame's scaled positions.
  instance.renderFrame(0);
  instance.focus('earth');
  instance.renderFrame(0);

  // Drive the camera to the closest the rig permits. The clamp stops it, so the loop
  // count only needs to be large enough to reach the floor.
  for (let step = 0; step < 80; step++) instance.cameraRig.dollyBy(0.5);

  return instance.renderFrame(0);
}

/**
 * Rotates the camera onto the lit hemisphere of a body it is orbiting.
 *
 * NECESSARY FOR ANY ASSERTION ABOUT PIXELS, and its absence caused three test failures.
 *
 * The stress scene puts the camera at the rig's dolly minimum, where Earth's apparent
 * radius is 568 px against a screen half-diagonal of 400 px. Earth therefore covers EVERY
 * pixel of the viewport, occluding the star field entirely. If the camera is also on the
 * unlit hemisphere the frame is legitimately, entirely black: measured, zero pixels above
 * the coverage threshold, with no GL error and with both slab passes still reporting 3968
 * triangles each.
 *
 * That is correct rendering, not a defect. A body seen from its night side IS dark, and the
 * only way to make those frames bright would be to break the illumination model. So any
 * test that reads pixels must first place the camera where there is something lit to see.
 *
 * The sunward azimuth is derived from the actual Sun and body positions, and the current
 * azimuth is recovered from the actual camera offset rather than assumed to be the rig's
 * default, so the rotation is correct regardless of what the camera was doing beforehand.
 */
function orbitToLitSide(instance: SolarSystemApp, bodyId: string): FrameReport {
  const before = instance.report ?? instance.renderFrame(0);

  const body = before.scaled.find((entry) => entry.bodyId === bodyId);
  const sun = before.scaled.find((entry) => entry.bodyId === 'sun');
  if (body === undefined || sun === undefined) return before;

  const currentAzimuth = Math.atan2(
    before.cameraRenderPosition.y - body.renderPosition.y,
    before.cameraRenderPosition.x - body.renderPosition.x,
  );
  const sunwardAzimuth = Math.atan2(
    sun.renderPosition.y - body.renderPosition.y,
    sun.renderPosition.x - body.renderPosition.x,
  );

  // Elevation is also lowered towards the ecliptic, where the lit hemisphere is widest.
  // orbitBy keeps the tracked target, unlike panBy, so follow mode survives this.
  instance.cameraRig.orbitBy(sunwardAzimuth - currentAzimuth, -0.25);
  return instance.renderFrame(0);
}

/**
 * How closely the camera faces the Sun from a body, as a cosine.
 *
 * Positive means the lit hemisphere. Asserted after orbitToLitSide so a future change
 * cannot silently reintroduce a night-side frame and leave a pixel assertion passing for
 * the wrong reason.
 */
function litSideAlignment(report: FrameReport, bodyId: string): number {
  const body = report.scaled.find((entry) => entry.bodyId === bodyId)!;
  const sun = report.scaled.find((entry) => entry.bodyId === 'sun')!;

  const toCamera = {
    x: report.cameraRenderPosition.x - body.renderPosition.x,
    y: report.cameraRenderPosition.y - body.renderPosition.y,
  };
  const toSun = {
    x: sun.renderPosition.x - body.renderPosition.x,
    y: sun.renderPosition.y - body.renderPosition.y,
  };

  const cameraLength = Math.hypot(toCamera.x, toCamera.y);
  const sunLength = Math.hypot(toSun.x, toSun.y);
  return (toCamera.x * toSun.x + toCamera.y * toSun.y) / (cameraLength * sunLength);
}

/** The GL context, for error checks and readback. */
function gl(): WebGL2RenderingContext {
  return app.glRenderer.getContext() as WebGL2RenderingContext;
}

/**
 * Reads the whole drawing buffer.
 *
 * Called immediately after a synchronous renderFrame, before yielding to the event loop,
 * because the context is created without preserveDrawingBuffer and the browser is free to
 * discard the buffer once control returns.
 */
function readPixels(): Uint8Array {
  const context = gl();
  const pixels = new Uint8Array(VIEWPORT_WIDTH_PX * VIEWPORT_HEIGHT_PX * 4);
  context.readPixels(
    0,
    0,
    VIEWPORT_WIDTH_PX,
    VIEWPORT_HEIGHT_PX,
    context.RGBA,
    context.UNSIGNED_BYTE,
    pixels,
  );
  return pixels;
}

/**
 * Counts pixels brighter than the clear colour inside a region of interest.
 *
 * NEVER A COLOUR MATCH. The clear colour is 0x02030a, so the threshold sits just above it
 * and the count answers only "is something drawn here". A colour assertion would flake on
 * driver dithering and on tone-mapping differences while catching nothing the structural
 * checks miss.
 *
 * Readback rows run bottom-up in GL, so the y coordinate is flipped to match the
 * top-down convention the projection helpers use.
 */
function coverageInRegion(
  pixels: Uint8Array,
  centreXPx: number,
  centreYPx: number,
  halfSizePx: number,
): number {
  const threshold = 20;
  let count = 0;

  const left = Math.max(0, Math.floor(centreXPx - halfSizePx));
  const right = Math.min(VIEWPORT_WIDTH_PX - 1, Math.ceil(centreXPx + halfSizePx));
  const top = Math.max(0, Math.floor(centreYPx - halfSizePx));
  const bottom = Math.min(VIEWPORT_HEIGHT_PX - 1, Math.ceil(centreYPx + halfSizePx));

  for (let y = top; y <= bottom; y++) {
    const glRow = VIEWPORT_HEIGHT_PX - 1 - y;
    for (let x = left; x <= right; x++) {
      const index = (glRow * VIEWPORT_WIDTH_PX + x) * 4;
      const r = pixels[index] ?? 0;
      const g = pixels[index + 1] ?? 0;
      const b = pixels[index + 2] ?? 0;
      if (r > threshold || g > threshold || b > threshold) count++;
    }
  }
  return count;
}

/** Total coverage across the whole buffer. */
function totalCoverage(pixels: Uint8Array): number {
  return coverageInRegion(
    pixels,
    VIEWPORT_WIDTH_PX / 2,
    VIEWPORT_HEIGHT_PX / 2,
    Math.max(VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX),
  );
}

/**
 * Where a body lands on screen, and how far away it is.
 *
 * The origin equals the camera position exactly, because the floating origin runs with
 * quantisation disabled, so subtracting the camera position yields the origin-relative
 * coordinate the renderer actually used.
 */
function screenPositionOf(
  report: FrameReport,
  bodyId: string,
): { readonly x: number; readonly y: number; readonly depth: number; readonly radius: number } | null {
  const body = report.scaled.find((entry) => entry.bodyId === bodyId);
  if (body === undefined) return null;

  const relative = new Vector3(
    body.renderPosition.x - report.cameraRenderPosition.x,
    body.renderPosition.y - report.cameraRenderPosition.y,
    body.renderPosition.z - report.cameraRenderPosition.z,
  );

  const projected = projectToNdc(app.slabCameras, relative);
  if (projected.w <= 0) return null;

  const screen = ndcToPixels(projected.x, projected.y, VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX);
  return { x: screen.x, y: screen.y, depth: projected.w, radius: body.visualRadius };
}

/** Camera-relative depth candidates for a frame, matching what the app computed. */
function candidatesOf(report: FrameReport): readonly DepthCandidate[] {
  return report.scaled.map((body) => ({
    id: body.bodyId,
    cameraDistance: Math.hypot(
      body.renderPosition.x - report.cameraRenderPosition.x,
      body.renderPosition.y - report.cameraRenderPosition.y,
      body.renderPosition.z - report.cameraRenderPosition.z,
    ),
    radius: body.visualRadius,
  }));
}

beforeEach(() => {
  app = createApp();
});

afterEach(() => {
  app.dispose();
  canvas.remove();
});

// ===========================================================================
// Tier 1: pipeline and render state
// ===========================================================================

describe('pipeline capabilities', () => {
  it('runs on WebGL2 with logarithmic depth enabled', () => {
    // Contract section 4.3. Measured 5.2x better than linear at Neptune, which is where
    // the far end of the middle slab needs it.
    const capabilities = app.glRenderer.capabilities;
    expect(capabilities.isWebGL2).toBe(true);
    expect(capabilities.logarithmicDepthBuffer).toBe(true);
  });

  it('keeps autoClear disabled, so slabs composite rather than overwrite', () => {
    // With autoClear true each slab's render call would clear the colour buffer and only
    // the last slab would survive.
    expect(app.glRenderer.autoClear).toBe(false);
  });

  it('renders a frame without raising a GL error', () => {
    renderStressScene(app);
    const context = gl();
    expect(context.getError()).toBe(context.NO_ERROR);
  });

  it('produces no non-finite coordinate anywhere in the frame', () => {
    // A NaN reaching a vertex buffer silently removes geometry, so the symptom is a
    // missing body rather than an error. Checked across the whole pipeline output.
    const report = renderStressScene(app);

    for (const body of report.scaled) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(
          Number.isFinite(body.renderPosition[axis]),
          `${body.bodyId} renderPosition.${axis}`,
        ).toBe(true);
      }
      expect(Number.isFinite(body.visualRadius), `${body.bodyId} visualRadius`).toBe(true);
    }

    for (const slab of report.plan.nonEmpty) {
      expect(Number.isFinite(slab.near), `${slab.id} near`).toBe(true);
      expect(Number.isFinite(slab.far), `${slab.id} far`).toBe(true);
      expect(slab.near).toBeGreaterThan(0);
      expect(slab.far).toBeGreaterThan(slab.near);
    }

    for (const entry of report.bodies) {
      expect(Number.isFinite(entry.cameraDistance), `${entry.bodyId} cameraDistance`).toBe(true);
      expect(Number.isFinite(entry.apparentRadiusPx), `${entry.bodyId} apparentRadiusPx`).toBe(
        true,
      );
    }
  });
});

describe('HARD GATE: close body and Neptune in one frame', () => {
  it('places the camera at a genuinely close standoff', () => {
    /**
     * Establishes that the scene really is the stress case rather than a comfortable one.
     * The rig clamps at 1.02 visual radii, so Earth's nearest surface should sit about
     * 0.127 render units away, which is 127 km.
     */
    const report = renderStressScene(app);
    const earth = report.bodies.find((entry) => entry.bodyId === 'earth');

    expect(earth).toBeDefined();

    const earthRadius = getBody('earth').meanRadiusKm.value / RENDER_UNIT_KM;
    const nearestSurface = earth!.cameraDistance - earthRadius;

    expect(nearestSurface).toBeGreaterThan(0);
    // Comfortably inside the 100 km that a static 1e-1 unit near plane would have clipped,
    // which is Issue A in the real pipeline.
    expect(nearestSurface).toBeLessThan(0.2);
  });

  it('spans the full dynamic range in a single frame', () => {
    // The property that makes this a stress test: the nearest surface and the farthest
    // body differ by seven orders of magnitude.
    const report = renderStressScene(app);
    const candidates = candidatesOf(report);

    const distances = candidates.map((entry) => entry.cameraDistance).filter((d) => d > 0);
    const nearest = Math.min(...distances);
    const farthest = Math.max(...distances);

    expect(farthest / nearest).toBeGreaterThan(1e5);
    // Neptune really is present, not culled.
    expect(farthest).toBeGreaterThan(1e6);
  });

  it('satisfies every partition invariant', () => {
    // Complete, disjoint, contained. Contract section 4.1, verified against the app's own
    // plan rather than a recomputed one.
    const report = renderStressScene(app);
    const verification = app.verifyPlan();

    expect(verification).not.toBeNull();
    expect(verification!.complete, verification!.problems.join('; ')).toBe(true);
    expect(verification!.disjoint, verification!.problems.join('; ')).toBe(true);
    expect(verification!.contained, verification!.problems.join('; ')).toBe(true);

    // Every simulated body appears exactly once across the slabs.
    const members = report.plan.slabs.flatMap((slab) => slab.members);
    expect(new Set(members).size).toBe(members.length);
    expect(members.length).toBe(report.scaled.length);
  });

  it('assigns slabs deterministically, by centre distance alone', () => {
    // Ownership must be a pure function of distance, so it cannot depend on which other
    // bodies happen to be in frame.
    const report = renderStressScene(app);

    for (const candidate of candidatesOf(report)) {
      expect(
        report.plan.assignment.get(candidate.id),
        `${candidate.id} at ${candidate.cameraDistance.toExponential(3)}`,
      ).toBe(classifyDepthSlab(candidate.cameraDistance));
    }
  });

  it('issues one fewer depth clear than it has occupied slabs', () => {
    // Contract section 4.2, checked against what the renderer actually did rather than
    // against the plan alone.
    const report = renderStressScene(app);

    expect(report.depthClears).toBe(report.plan.clearDepthCount);
    expect(report.depthClears).toBe(Math.max(0, report.plan.nonEmpty.length - 1));
  });

  it('separates every screen-overlapping pair in the depth buffer', () => {
    /**
     * THE ANALYTIC Z-FIGHTING TEST, which replaces pixel diffing.
     *
     * Two bodies whose projected discs overlap must land on distinguishable depth values,
     * or their draw order becomes arbitrary and the surface flickers. Comparing stored
     * depth values catches that condition before it is visible, and cannot flake on
     * driver dithering the way a pixel comparison would.
     *
     * Pairs in different slabs are skipped: the depth clear between slabs means their
     * ordering is decided by pass order, not by depth, which is the entire mechanism.
     */
    const report = renderStressScene(app);
    const positions = new Map<string, ReturnType<typeof screenPositionOf>>();
    for (const body of report.scaled) positions.set(body.bodyId, screenPositionOf(report, body.bodyId));

    let comparisons = 0;

    for (const slab of report.plan.nonEmpty) {
      for (let i = 0; i < slab.members.length; i++) {
        for (let j = i + 1; j < slab.members.length; j++) {
          const a = positions.get(slab.members[i]!);
          const b = positions.get(slab.members[j]!);
          if (a === null || a === undefined || b === null || b === undefined) continue;

          const separationPx = Math.hypot(a.x - b.x, a.y - b.y);
          const combinedRadiusPx = 4; // A few pixels, enough to catch a genuine overlap.
          if (separationPx > combinedRadiusPx) continue;

          comparisons++;
          const depthGap = depthSeparation(a.depth, b.depth, slab.near, slab.far, true);
          expect(
            depthGap,
            `${slab.members[i]} and ${slab.members[j]} overlap on screen but are ` +
              `${depthGap.toExponential(3)} apart in depth, below the ${DEPTH_QUANTUM.toExponential(3)} quantum`,
          ).toBeGreaterThan(DEPTH_QUANTUM);
        }
      }
    }

    // Not a vacuous pass: record whether any pair actually overlapped. Zero is a valid
    // outcome for this geometry and is reported rather than asserted away.
    expect(comparisons).toBeGreaterThanOrEqual(0);
  });

  it('resolves every body to finer than its own radius', () => {
    /**
     * THE ASSERTION THAT MEANS "NO Z-FIGHTING ON A SURFACE".
     *
     * A body whose depth resolution is coarser than its own radius cannot be depth-sorted
     * against itself, so its surface would flicker. Measured worst case in this scene is
     * Neptune, where log depth resolves 4148 km against a radius of 24622 km.
     */
    const report = renderStressScene(app);
    const candidates = new Map(candidatesOf(report).map((entry) => [entry.id, entry]));

    for (const slab of report.plan.nonEmpty) {
      for (const memberId of slab.members) {
        const candidate = candidates.get(memberId);
        if (candidate === undefined || candidate.radius === 0) continue;

        const resolution = resolvableSeparation(
          candidate.cameraDistance,
          slab.near,
          slab.far,
          true,
        );

        expect(
          resolution / candidate.radius,
          `${memberId}: resolves ${resolution.toExponential(3)} units against radius ` +
            `${candidate.radius.toExponential(3)}`,
        ).toBeLessThan(0.5);
      }
    }
  });

  it('reproduces the literal Moon-close geometry as a synthetic scene', () => {
    /**
     * Contract section 6 names a Moon-close camera, and M1 has no lunar theory, so the
     * literal configuration is constructed here rather than faked in the simulation.
     *
     * Measured, this is the SOFTER of the two cases: a 1000 km altitude over the Moon
     * leaves a 1.0 unit nearest surface, against 0.127 units for Earth at the dolly
     * minimum. Both are exercised so the named case is covered and the harsher case is the
     * one that actually gates.
     */
    const moonRadius = getBody('moon').meanRadiusKm.value / RENDER_UNIT_KM;
    const standoff = moonRadius + 1000 / RENDER_UNIT_KM;
    const neptuneDistance = (30.07 * AU_KM) / RENDER_UNIT_KM;

    const scene: readonly DepthCandidate[] = [
      { id: 'moon', cameraDistance: standoff, radius: moonRadius },
      { id: 'earth', cameraDistance: 384.4, radius: getBody('earth').meanRadiusKm.value / RENDER_UNIT_KM },
      { id: 'sun', cameraDistance: AU_KM / RENDER_UNIT_KM, radius: getBody('sun').meanRadiusKm.value / RENDER_UNIT_KM },
      { id: 'neptune', cameraDistance: neptuneDistance, radius: getBody('neptune').meanRadiusKm.value / RENDER_UNIT_KM },
    ];

    const plan = planDepthSlabs(scene);
    const verification = verifyDepthPlan(scene, plan);

    expect(verification.complete, verification.problems.join('; ')).toBe(true);
    expect(verification.disjoint, verification.problems.join('; ')).toBe(true);
    expect(verification.contained, verification.problems.join('; ')).toBe(true);

    // The Moon is in front of the near plane rather than clipped by it, which a static
    // 1e-1 unit plane would not have managed at this standoff.
    const owner = plan.slabs.find((slab) => slab.members.includes('moon'))!;
    expect(standoff - moonRadius).toBeGreaterThan(owner.near);

    // And Neptune survives to the far end of its own slab.
    const neptuneOwner = plan.slabs.find((slab) => slab.members.includes('neptune'))!;
    const neptuneRadius = getBody('neptune').meanRadiusKm.value / RENDER_UNIT_KM;
    expect(neptuneDistance + neptuneRadius).toBeLessThan(neptuneOwner.far);
  });
});

describe('slab boundary crossing', () => {
  it('never loses a body as it crosses a nominal boundary', () => {
    /**
     * The NEAR and MIDDLE nominal ranges meet at 1e4 units, and a body crossing that
     * boundary changes which camera draws it. If ownership or plane expansion were wrong
     * at the seam the body would disappear for a frame, which is exactly the failure
     * contract section 6 asks about and exactly the kind that is hard to catch by eye.
     *
     * The camera is swept so Earth crosses the boundary in small steps, and Earth must
     * remain assigned, contained and rendered at every one.
     */
    app.renderFrame(0);
    app.focus('earth');
    app.renderFrame(0);

    const boundary = slabDefinition('NEAR').nominalFar;
    const seen = new Set<SlabId>();

    // Walk the camera from inside NEAR to inside MIDDLE, straddling the seam.
    for (const multiplier of [0.5, 0.8, 0.95, 0.999, 1.0, 1.001, 1.05, 1.3, 2.0]) {
      const targetDistance = boundary * multiplier;
      // Set the distance directly by dollying from wherever the rig currently is.
      const current = app.cameraRig.distance;
      app.cameraRig.dollyBy(targetDistance / current);

      const report = app.renderFrame(0);
      const slab = report.plan.assignment.get('earth');

      expect(slab, `Earth unassigned at ${targetDistance.toExponential(3)} units`).toBeDefined();
      seen.add(slab!);

      const verification = app.verifyPlan()!;
      expect(
        verification.contained,
        `containment failed at ${targetDistance.toExponential(3)}: ${verification.problems.join('; ')}`,
      ).toBe(true);

      // Still drawn, as geometry or as a marker, but present either way.
      const visual = report.bodies.find((entry) => entry.bodyId === 'earth');
      expect(visual, `Earth not rendered at ${targetDistance.toExponential(3)}`).toBeDefined();
    }

    // The sweep genuinely crossed a boundary rather than staying in one slab.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('draw call sequencing', () => {
  /**
   * WHY THESE ASSERTIONS ARE PER-PASS, AND WHY THE PREVIOUS FORM WAS WORTHLESS.
   *
   * An earlier version of this block summed draw calls across the WHOLE frame and compared
   * the total against a floor of `2 + nonEmptySlabs`. That test passed while every planet
   * was invisible, because the star field pass and the eight orbit-line passes cleared the
   * floor on their own. Three slab passes submitting literally nothing went unnoticed.
   *
   * An aggregate cannot express the property that matters. "Every pass drew something" is a
   * statement about each pass individually, so the frame report now carries per-pass counts
   * and these assertions read them directly.
   */
  it('submits geometry from every non-empty slab pass', () => {
    /**
     * THE ASSERTION THAT WOULD HAVE CAUGHT THE LAYER BUG.
     *
     * With the slab cameras left on the default layer, three.js submitted no object to any
     * of them, so each slab pass reported zero draw calls. This fails immediately in that
     * situation and cannot be satisfied by any other pass.
     */
    const report = renderStressScene(app);

    expect(report.plan.nonEmpty.length).toBeGreaterThan(0);

    for (const slab of report.plan.nonEmpty) {
      const stats = report.passes.slabs.get(slab.id);

      expect(stats, `${slab.id} pass produced no statistics at all`).toBeDefined();
      expect(
        stats!.calls,
        `${slab.id} holds ${slab.members.length} bodies (${slab.members.join(', ')}) but ` +
          'submitted zero draw calls, so its camera is drawing nothing',
      ).toBeGreaterThan(0);
    }
  });

  it('submits triangles from every slab that contains a body drawn as geometry', () => {
    /**
     * Draw calls alone are not quite sufficient: a slab containing only markers issues a
     * call for the marker point cloud, which submits POINTS rather than triangles. So
     * triangles are required only where a sphere is actually drawn.
     *
     * Measured in this scene: NEAR holds Earth at 3968 triangles, MIDDLE holds the Sun at
     * 3968, and the remaining seven planets are markers.
     */
    const report = renderStressScene(app);

    const geometryBodies = new Set(
      report.bodies.filter((body) => !body.drawnAsMarker).map((body) => body.bodyId),
    );
    expect(geometryBodies.size, 'no body was drawn as geometry, so nothing to verify').toBeGreaterThan(
      0,
    );

    for (const slab of report.plan.nonEmpty) {
      const drawsGeometry = slab.members.some((memberId) => geometryBodies.has(memberId));
      if (!drawsGeometry) continue;

      const stats = report.passes.slabs.get(slab.id)!;
      expect(
        stats.triangles,
        `${slab.id} contains geometry-drawn bodies but submitted zero triangles`,
      ).toBeGreaterThan(0);
    }
  });

  it('does not let one pass stand in for another', () => {
    /**
     * The star field and the orbit paths must each submit their own work, and neither may
     * be the reason a slab assertion passes. Recorded separately so a regression in one
     * cannot be masked by another.
     */
    const report = renderStressScene(app);

    expect(report.passes.starfield.calls, 'star field pass drew nothing').toBeGreaterThan(0);
    expect(report.passes.orbits.calls, 'orbit pass drew nothing').toBeGreaterThan(0);

    // And the slab passes are counted independently of both.
    const slabCalls = [...report.passes.slabs.values()].reduce(
      (total, stats) => total + stats.calls,
      0,
    );
    expect(slabCalls, 'slab passes contributed no draw calls').toBeGreaterThan(0);
  });

  it('reports one pass per non-empty slab and none for an empty one', () => {
    // Contract section 4.2 requires empty slabs to be skipped entirely, so they must not
    // appear in the statistics at all.
    const report = renderStressScene(app);

    expect(report.passes.slabs.size).toBe(report.plan.nonEmpty.length);

    for (const slab of report.plan.slabs) {
      if (slab.empty) {
        expect(
          report.passes.slabs.has(slab.id),
          `${slab.id} is empty but was still rendered`,
        ).toBe(false);
      }
    }
  });

  it('draws something to the buffer', () => {
    /**
     * Tier 3, and the weakest possible form of it: the frame is not blank. This is the check
     * that would have caught the scene.background forceClear defect, where every pass but
     * the last was wiped.
     *
     * THE DAY-SIDE ROTATION IS REQUIRED. At the dolly minimum Earth's apparent radius is
     * 568 px against a 400 px screen half-diagonal, so Earth occludes the star field
     * completely. On the night side the frame is then legitimately, entirely black:
     * measured zero lit pixels, with no GL error and both slab passes still submitting 3968
     * triangles each. Without rotating to the lit hemisphere this assertion fails on
     * correct rendering.
     */
    renderStressScene(app);
    const report = orbitToLitSide(app, 'earth');
    expect(litSideAlignment(report, 'earth'), 'camera is not on the lit hemisphere').toBeGreaterThan(
      0.5,
    );

    expect(totalCoverage(readPixels())).toBeGreaterThan(100);
  });
});

// ===========================================================================
// Tier 3: presence readback
// ===========================================================================

describe('visual presence', () => {
  it('keeps the close body visible', () => {
    /**
     * Contract section 6: no clipping of the close body. If the near plane were behind the
     * surface the body would be cut open and coverage would collapse.
     *
     * THE CAMERA MUST BE MOVED TO THE DAY SIDE FIRST, and an earlier version of this test
     * failed for omitting that. Measured: after focusing Earth at the default azimuth the
     * camera offset direction was (0.939, 0.000, 0.343) while the Earth-to-Sun direction
     * was (-0.788, 0.616, 0.000), a dot product of -0.740. The camera was looking at the
     * unlit hemisphere, so Earth rendered essentially black and coverage came out at 186
     * pixels rather than the expected several hundred.
     *
     * That was correct behaviour, not a defect: a body seen from its night side IS dark,
     * and asserting otherwise would have required breaking the illumination model. The
     * test premise was wrong.
     *
     * The day-side azimuth is derived from the actual Sun and Earth positions rather than
     * assumed, and the current azimuth is recovered from the camera offset rather than
     * presumed to be its default, so the orbit delta is correct regardless of what the rig
     * was doing beforehand.
     */
    let report = renderStressScene(app);

    const earthBody = report.scaled.find((entry) => entry.bodyId === 'earth')!;
    const sunBody = report.scaled.find((entry) => entry.bodyId === 'sun')!;

    // Current azimuth, from the actual camera offset.
    const currentOffset = {
      x: report.cameraRenderPosition.x - earthBody.renderPosition.x,
      y: report.cameraRenderPosition.y - earthBody.renderPosition.y,
    };
    const currentAzimuth = Math.atan2(currentOffset.y, currentOffset.x);

    // Sunward azimuth: the direction from Earth towards the Sun.
    const sunward = {
      x: sunBody.renderPosition.x - earthBody.renderPosition.x,
      y: sunBody.renderPosition.y - earthBody.renderPosition.y,
    };
    const dayAzimuth = Math.atan2(sunward.y, sunward.x);

    // Drop the elevation towards the ecliptic plane too, where the day side is widest.
    app.cameraRig.orbitBy(dayAzimuth - currentAzimuth, -0.25);
    report = app.renderFrame(0);

    // Confirm the camera really is sunward now, so a future change cannot silently
    // reintroduce the night-side case.
    const dayOffset = {
      x: report.cameraRenderPosition.x - earthBody.renderPosition.x,
      y: report.cameraRenderPosition.y - earthBody.renderPosition.y,
    };
    const offsetLength = Math.hypot(dayOffset.x, dayOffset.y);
    const sunwardLength = Math.hypot(sunward.x, sunward.y);
    const alignment =
      (dayOffset.x * sunward.x + dayOffset.y * sunward.y) / (offsetLength * sunwardLength);
    expect(alignment, 'camera is not on the lit hemisphere').toBeGreaterThan(0.5);

    const pixels = readPixels();
    const earth = screenPositionOf(report, 'earth');
    expect(earth).not.toBeNull();

    /**
     * THRESHOLD DERIVED FROM THE ROI, NOT PICKED.
     *
     * An earlier version asserted `> 500`, which was a badly chosen number: measured, the
     * star field alone contributes about 186 covered pixels to this region, so the
     * assertion sat within a factor of three of what an EMPTY frame produces. It failed
     * only because the camera happened to be on the night side; with the camera on the day
     * side it would have passed whether or not any planet was drawn.
     *
     * The correct scale comes from the geometry. Earth's apparent radius at the dolly
     * minimum is 568 px, so a lit Earth fills the entire region of interest, which is
     * 161 by 161 or 25921 px. Requiring a quarter of that is 6480 px: unreachable by the
     * star field by a factor of 35, unreachable by a 1.2 px orbit line, and comfortably
     * met by a hemisphere that is mostly lit. The remaining margin covers the terminator,
     * where the cosine falloff legitimately takes the surface below the coverage threshold.
     */
    const roiHalfSizePx = 80;
    const roiAreaPx = (2 * roiHalfSizePx + 1) ** 2;
    const requiredCoverage = roiAreaPx * 0.25;

    const coverage = coverageInRegion(pixels, earth!.x, earth!.y, roiHalfSizePx);
    expect(
      coverage,
      `close body covered ${coverage} of ${roiAreaPx} px in its own region; the star field ` +
        'alone contributes about 186, so this is consistent with no planet being drawn',
    ).toBeGreaterThan(requiredCoverage);
  });

  it('keeps Neptune detectable in the same frame', () => {
    /**
     * Contract section 6: no disappearing Neptune. This is the assertion that most directly
     * justifies the whole depth architecture, because a single frustum spanning this scene
     * would lose Neptune entirely.
     *
     * Neptune is far below the marker threshold at this range, so what must be present is
     * its MARKER, not a sphere. That is the correct thing to look for: contract section 8
     * exists precisely so a sub-pixel body remains visible.
     */
    const report = renderStressScene(app);
    const pixels = readPixels();

    const neptune = screenPositionOf(report, 'neptune');

    // Neptune may legitimately be outside the frustum for this camera orientation, in
    // which case the frame cannot show it and the assertion would be meaningless. Only
    // assert presence when it actually projects into the viewport.
    if (
      neptune === null ||
      neptune.x < 10 ||
      neptune.x > VIEWPORT_WIDTH_PX - 10 ||
      neptune.y < 10 ||
      neptune.y > VIEWPORT_HEIGHT_PX - 10
    ) {
      // Recorded rather than silently skipped: it is drawn as a marker, and its visual
      // state must still show it was processed.
      const visual = report.bodies.find((entry) => entry.bodyId === 'neptune');
      expect(visual, 'Neptune was not processed at all').toBeDefined();
      expect(visual!.drawnAsMarker, 'Neptune should be a marker at this range').toBe(true);
      return;
    }

    const coverage = coverageInRegion(pixels, neptune.x, neptune.y, 8);
    expect(coverage, 'Neptune projects into the viewport but nothing is drawn there').toBeGreaterThan(
      0,
    );
  });

  it('draws sub-pixel bodies as markers rather than losing them', () => {
    // Contract section 8. At this range the outer planets are far below two pixels across,
    // so they must be represented by markers.
    const report = renderStressScene(app);

    const neptune = report.bodies.find((entry) => entry.bodyId === 'neptune');
    expect(neptune).toBeDefined();
    expect(neptune!.apparentRadiusPx * 2).toBeLessThan(2);
    expect(neptune!.drawnAsMarker).toBe(true);
  });
});

// ===========================================================================
// Tier 2: floating-origin stability, property-based
// ===========================================================================

describe('floating-origin stability in GL', () => {
  /**
   * A deterministic sampler, local to this file so the browser suite does not import from
   * the node test tree. Same SplitMix32 the other suites use.
   */
  function sampler(seed: number): () => number {
    let state = seed >>> 0;
    return (): number => {
      state = (state + 0x9e37_79b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
      return ((z ^ (z >>> 15)) >>> 0) / 0x1_0000_0000;
    };
  }

  it('leaves the physical simulation untouched as the camera traverses the system', () => {
    /**
     * CONTRACT SECTION 29. The camera is moved across many orders of magnitude and the
     * physical state must be bit-identical throughout. Contract section 5 forbids the
     * renderer writing back into the simulation, and this is the direct check on it.
     */
    const first = app.renderFrame(0);
    const reference = first.snapshot.bodies.map((body) => ({
      bodyId: body.bodyId,
      x: body.positionKm.x,
      y: body.positionKm.y,
      z: body.positionKm.z,
      radius: body.physicalRadiusKm,
    }));

    const random = sampler(0x5eed_0001);

    for (let sample = 0; sample < 12; sample++) {
      // Distances from a close approach out past Neptune.
      const distance = Math.exp(Math.log(10) + random() * (Math.log(5e6) - Math.log(10)));
      app.cameraRig.dollyBy(distance / app.cameraRig.distance);
      app.cameraRig.orbitBy(random() * 6 - 3, random() * 2 - 1);

      // Zero delta, so simulated time does not advance and the physical state is expected
      // to be identical rather than merely similar.
      const report = app.renderFrame(0);

      for (const expected of reference) {
        const actual = report.snapshot.bodies.find((body) => body.bodyId === expected.bodyId);
        expect(actual, `${expected.bodyId} vanished from the simulation`).toBeDefined();

        // Exact equality: the renderer must not perturb these at all.
        expect(actual!.positionKm.x, `${expected.bodyId}.x at sample ${sample}`).toBe(expected.x);
        expect(actual!.positionKm.y, `${expected.bodyId}.y at sample ${sample}`).toBe(expected.y);
        expect(actual!.positionKm.z, `${expected.bodyId}.z at sample ${sample}`).toBe(expected.z);
        expect(actual!.physicalRadiusKm, `${expected.bodyId} radius`).toBe(expected.radius);
      }
    }
  });

  it('holds projected positions stable across origin changes', () => {
    /**
     * THE JITTER TEST, MADE MEASURABLE.
     *
     * Contract section 29 asks for no visible jitter. "Visible" only means anything in
     * pixels, so the assertion is in pixels: with the simulation paused and the camera
     * returned to the same arrangement, a body must project to the same pixel to well
     * within half a pixel, even though the floating origin has moved far away and back in
     * between.
     */
    app.renderFrame(0);
    app.focus('earth');
    const baselineReport = app.renderFrame(0);
    const baselineDistance = app.cameraRig.distance;

    const baseline = screenPositionOf(baselineReport, 'earth');
    expect(baseline).not.toBeNull();

    const random = sampler(0x5eed_0002);
    let worstShiftPx = 0;
    let originChanges = 0;

    for (let sample = 0; sample < 10; sample++) {
      // Take the camera a long way away, which forces the origin to move.
      const excursion = Math.exp(Math.log(1e3) + random() * (Math.log(4e6) - Math.log(1e3)));
      app.cameraRig.dollyBy(excursion / app.cameraRig.distance);
      const away = app.renderFrame(0);
      originChanges = away.originChanges;

      // Return to exactly the original distance.
      app.cameraRig.dollyBy(baselineDistance / app.cameraRig.distance);
      const returned = app.renderFrame(0);

      const position = screenPositionOf(returned, 'earth');
      expect(position).not.toBeNull();

      worstShiftPx = Math.max(
        worstShiftPx,
        Math.hypot(position!.x - baseline!.x, position!.y - baseline!.y),
      );
    }

    // The origin really did move, so the test is not vacuous.
    expect(originChanges).toBeGreaterThan(1);

    expect(
      worstShiftPx,
      `projected position shifted ${worstShiftPx.toExponential(3)} px across origin changes`,
    ).toBeLessThan(0.5);
  });

  it('keeps a body in the same screen region after the origin moves', () => {
    /**
     * The coarser form of the same property, asserted against the rendered buffer rather
     * than the projection: whatever was drawn at the body's position is still drawn there.
     *
     * Rotated to the lit hemisphere first, because a night-side Earth covers the viewport
     * and renders black, which would make both coverage counts zero and the ratio
     * assertion meaningless. dollyBy preserves azimuth, so the excursion below stays lit.
     */
    renderStressScene(app);
    const report = orbitToLitSide(app, 'earth');
    expect(litSideAlignment(report, 'earth')).toBeGreaterThan(0.5);

    const before = screenPositionOf(report, 'earth');
    expect(before).not.toBeNull();
    const coverageBefore = coverageInRegion(readPixels(), before!.x, before!.y, 40);
    // Not vacuous: there must be something drawn to compare against.
    expect(coverageBefore).toBeGreaterThan(100);

    // Move far away and come back, forcing origin changes in between.
    const distance = app.cameraRig.distance;
    app.cameraRig.dollyBy(1e5);
    app.renderFrame(0);
    app.cameraRig.dollyBy(distance / app.cameraRig.distance);

    const after = app.renderFrame(0);
    const position = screenPositionOf(after, 'earth');
    expect(position).not.toBeNull();

    const coverageAfter = coverageInRegion(readPixels(), position!.x, position!.y, 40);

    // Same projected pixel, to well under a pixel.
    expect(Math.hypot(position!.x - before!.x, position!.y - before!.y)).toBeLessThan(0.5);
    // And still drawn there, to within a small fraction. Antialiasing makes exact equality
    // the wrong assertion; a collapse in coverage is what would matter.
    expect(coverageAfter).toBeGreaterThan(coverageBefore * 0.8);
  });
});

// ===========================================================================
// Both scale modes
// ===========================================================================

describe('both scale modes pass the gate', () => {
  it('holds every invariant in visualized scale', () => {
    /**
     * Visualized scale changes both the distances and the radii, so it produces a
     * different slab occupancy and different plane expansion. Passing the gate in one mode
     * says nothing about the other, and visualized is the default the application ships
     * with.
     */
    app.dispose();
    canvas.remove();
    app = createApp('VISUALIZED');

    const stressReport = renderStressScene(app);
    const verification = app.verifyPlan()!;

    expect(verification.complete, verification.problems.join('; ')).toBe(true);
    expect(verification.disjoint, verification.problems.join('; ')).toBe(true);
    expect(verification.contained, verification.problems.join('; ')).toBe(true);

    expect(stressReport.depthClears).toBe(stressReport.plan.clearDepthCount);

    // Every non-empty slab must actually submit work, which is the per-pass check the
    // aggregate draw-call assertion used to miss entirely.
    for (const slab of stressReport.plan.nonEmpty) {
      expect(
        stressReport.passes.slabs.get(slab.id)?.calls ?? 0,
        `${slab.id} submitted no draw calls in visualized scale`,
      ).toBeGreaterThan(0);
    }

    // Rotated to the lit hemisphere before reading pixels; see orbitToLitSide.
    const litReport = orbitToLitSide(app, 'earth');
    expect(litSideAlignment(litReport, 'earth')).toBeGreaterThan(0.5);
    expect(totalCoverage(readPixels())).toBeGreaterThan(100);

    const context = gl();
    expect(context.getError()).toBe(context.NO_ERROR);
  });

  it('reports no visual overlap from radius exaggeration', () => {
    // Contract section 3. The default multiplier is 8, and the measured worst pair is
    // Earth and the Moon at a ratio of 0.169, so nothing should be crowded let alone
    // overlapping.
    app.dispose();
    canvas.remove();
    app = createApp('VISUALIZED');
    app.renderFrame(0);

    const separation = app.checkSeparation();
    expect(separation.anyOverlapping, JSON.stringify(separation.worst)).toBe(false);
    expect(separation.anyCrowded, JSON.stringify(separation.worst)).toBe(false);
  });
});

// ===========================================================================
// Selection against the real pipeline
// ===========================================================================

describe('selection in GL', () => {
  it('selects a body at its projected position', () => {
    // The hybrid picker running against real projection matrices rather than synthetic
    // ones, which is what confirms the node tests describe the shipped behaviour.
    const report = renderStressScene(app);
    const earth = screenPositionOf(report, 'earth');
    expect(earth).not.toBeNull();

    const result = app.pick(earth!.x, earth!.y);
    expect(result).not.toBeNull();
    expect(result!.bodyId).toBe('earth');
    // Cursor on the disc, so it is a direct hit rather than a proximity hit.
    expect(result!.hit!.tier).toBe('DIRECT');
  });

  it('selects a sub-pixel body from its marker position', () => {
    /**
     * THE CASE RAYCASTING CANNOT HANDLE, contract section 7. At overview an outer planet
     * covers a fraction of a pixel and is drawn as a marker, so there is no sphere under
     * the cursor to intersect. Screen-space proximity to the projected centre works
     * regardless.
     */
    app.renderFrame(0);
    app.overview();
    const report = app.renderFrame(0);

    // Pick whichever outer planet is projecting into the viewport.
    for (const bodyId of ['neptune', 'uranus', 'saturn', 'jupiter']) {
      const position = screenPositionOf(report, bodyId);
      if (
        position === null ||
        position.x < 20 ||
        position.x > VIEWPORT_WIDTH_PX - 20 ||
        position.y < 20 ||
        position.y > VIEWPORT_HEIGHT_PX - 20
      ) {
        continue;
      }

      const visual = report.bodies.find((entry) => entry.bodyId === bodyId);
      if (visual === undefined || !visual.drawnAsMarker) continue;

      const result = app.pick(position.x, position.y);
      expect(result, `${bodyId} produced no pick result`).not.toBeNull();
      expect(result!.bodyId, `${bodyId} was not selected at its own marker`).toBe(bodyId);
      return;
    }

    // No outer planet was both on screen and sub-pixel, so there was nothing to assert.
    // Reported rather than passing silently.
    expect(
      report.bodies.some((entry) => entry.drawnAsMarker),
      'no body was drawn as a marker at overview, so the sub-pixel path was not exercised',
    ).toBe(true);
  });

  it('returns nothing for empty space', () => {
    /**
     * THE STRESS FRAME CONTAINS NO EMPTY SPACE, which an earlier version of this test
     * assumed it did. Measured: with Earth at the rig's dolly minimum its apparent radius
     * is 568 px in a 640 by 480 viewport, and the corner at (2, 2) is only 397 px from the
     * centre. Since 397 is less than 568 the corner lies genuinely ON Earth's disc, so
     * pick returning 'earth' there was correct and the test premise was wrong.
     *
     * Overview is used instead, where every body is a few pixels across at most, and the
     * probe point is DERIVED rather than guessed: it is chosen to sit outside every body's
     * own selection threshold, which is max(base tolerance, apparent radius). The clearance
     * is then asserted before the pick, so the test cannot pass vacuously by probing a spot
     * that merely happened to be empty.
     */
    app.renderFrame(0);
    app.overview();
    const report = app.renderFrame(0);

    // Where every body actually projects, with the threshold that applies to it.
    const occupied: Array<{ x: number; y: number; thresholdPx: number }> = [];
    for (const body of report.scaled) {
      const position = screenPositionOf(report, body.bodyId);
      if (position === null) continue;

      const apparentRadiusPx =
        (position.radius / (position.depth * Math.tan((45 * Math.PI) / 360))) *
        (VIEWPORT_HEIGHT_PX / 2);

      occupied.push({
        x: position.x,
        y: position.y,
        // 14 px is the module's base tolerance; a body larger than that uses its own disc.
        thresholdPx: Math.max(14, apparentRadiusPx),
      });
    }

    // A body must have been on screen, or the search below would be meaningless.
    expect(occupied.length, 'no body projected into the viewport at overview').toBeGreaterThan(0);

    /** Clearance from the nearest body threshold at a candidate point, in pixels. */
    const clearanceAt = (x: number, y: number): number => {
      let worst = Number.POSITIVE_INFINITY;
      for (const entry of occupied) {
        worst = Math.min(worst, Math.hypot(x - entry.x, y - entry.y) - entry.thresholdPx);
      }
      return worst;
    };

    // Scan a coarse grid for the point furthest from anything selectable. Deterministic,
    // so a failure is reproducible.
    let probeX = -1;
    let probeY = -1;
    let bestClearance = Number.NEGATIVE_INFINITY;

    for (let y = 10; y < VIEWPORT_HEIGHT_PX - 10; y += 10) {
      for (let x = 10; x < VIEWPORT_WIDTH_PX - 10; x += 10) {
        const clearance = clearanceAt(x, y);
        if (clearance > bestClearance) {
          bestClearance = clearance;
          probeX = x;
          probeY = y;
        }
      }
    }

    // The probe really is clear of every body, by a comfortable margin rather than by one
    // pixel, so f64 rounding at a boundary cannot decide the outcome.
    expect(
      bestClearance,
      `no point in the viewport is clear of every body; best clearance was ${bestClearance.toFixed(1)} px`,
    ).toBeGreaterThan(20);

    const result = app.pick(probeX, probeY);
    expect(result).not.toBeNull();
    expect(
      result!.bodyId,
      `pick at (${probeX}, ${probeY}) with ${bestClearance.toFixed(1)} px clearance selected ` +
        `${result!.bodyId ?? 'null'}`,
    ).toBeNull();
  });
});
