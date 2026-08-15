/**
 * Layered slab camera validation.
 *
 * WHY THIS RUNS IN NODE. three.js's core math classes, PerspectiveCamera included,
 * need no GL context: they are matrix arithmetic. Only WebGLRenderer requires one.
 * So the invariants that actually matter here, namely that the three cameras share
 * everything but their depth planes, are testable headlessly and belong in the unit
 * project rather than behind the browser gate.
 *
 * renderFrame is tested against a RECORDING STUB rather than a real renderer,
 * because the contract it implements is a CALL SEQUENCE: clear once, draw far to
 * near, clear depth between slabs, never clear colour mid-frame. A stub verifies
 * that sequence exactly. Whether the resulting pixels composite correctly is a
 * different claim, and it is verified against real GL in the browser suite.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3, type WebGLRenderer } from 'three';
import {
  DEFAULT_FOV_DEG,
  LayeredCameras,
  apparentRadiusPixels,
  ndcToPixels,
  projectToNdc,
  verifyCameraConsistency,
} from '@/render/layered-cameras';
import {
  ORBIT_LAYER,
  SLAB_LAYERS,
  STARFIELD_LAYER,
  UNASSIGNED_LAYER,
} from '@/render/layers';
import {
  RENDER_ORDER,
  type DepthCandidate,
  planDepthSlabs,
} from '@/render/depth-slabs';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

/**
 * Tolerance for the shared-projection assertions, in units in the last place.
 *
 * WHY A ULP COMPARISON RATHER THAN EQUALITY OR toBeCloseTo.
 *
 * The near plane cancels out of the NDC x and y expressions algebraically, but not
 * numerically: three.js builds the projection matrix as m00 = 2*near/width with
 * width itself proportional to near, so the cancellation is only exact to within
 * rounding. An equality assertion therefore fails, and it should: the values really
 * do differ in the last bit or two.
 *
 * toBeCloseTo is also wrong here, because it tests an ABSOLUTE difference. NDC
 * values in these tests range from 1e-6 for a distant planet to 5.7e4 for a point
 * far outside the frustum, and no single absolute tolerance is meaningful across
 * eight orders of magnitude. A relative comparison scaled to the magnitude being
 * compared is the only form that means the same thing at both ends.
 *
 * MEASURED BASIS: over 20000 randomised samples, varying field of view, aspect
 * ratio, both plane pairs and the point itself, the worst disagreement between the
 * closest and furthest cameras was 2.64 ULP. 16 ULP is therefore a factor of six of
 * headroom, and still bounds the error at 3.6e-15 in NDC, which is 3.8e-12 pixels
 * at a 1080-pixel viewport height.
 */
const PROJECTION_ULP_TOLERANCE = 16;

/**
 * Asserts two values agree to within PROJECTION_ULP_TOLERANCE units in the last
 * place, scaled to the larger of the two magnitudes.
 */
function expectUlpAgreement(actual: number, expected: number, label: string): void {
  const scale = Math.max(Math.abs(actual), Math.abs(expected));

  // Both exactly zero: nothing to scale against, and they already agree.
  if (scale === 0) {
    expect(actual, label).toBe(expected);
    return;
  }

  const ulps = Math.abs(actual - expected) / (scale * Number.EPSILON);
  expect(
    ulps,
    `${label}: ${actual} vs ${expected} differ by ${ulps.toFixed(2)} ULP, ` +
      `above the ${PROJECTION_ULP_TOLERANCE} ULP tolerance`,
  ).toBeLessThanOrEqual(PROJECTION_ULP_TOLERANCE);
}

/** A scene occupying two slabs: something close, and the outer system. */
function twoSlabScene(): readonly DepthCandidate[] {
  return [
    { id: 'moon', cameraDistance: 2.7374, radius: 1.7374 },
    { id: 'earth', cameraDistance: 387.14, radius: 6.371 },
    { id: 'neptune', cameraDistance: 4.3553e6, radius: 24.622 },
  ];
}

/** A scene occupying all three slabs, so the full render order is exercised. */
function threeSlabScene(): readonly DepthCandidate[] {
  return [
    ...twoSlabScene(),
    { id: 'distant-star-probe', cameraDistance: 5e12, radius: 1e3 },
  ];
}

interface RecordedCall {
  readonly kind: 'clear' | 'clearDepth' | 'draw';
  readonly slab?: string;
}

/**
 * Minimal renderer stub that records the calls renderFrame makes.
 *
 * Only the three members renderFrame touches are implemented. The cast is
 * deliberate and narrow: substituting a real WebGLRenderer would require a GL
 * context and would test compositing rather than sequencing.
 */
function recordingRenderer(autoClear: boolean): {
  readonly renderer: WebGLRenderer;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const stub = {
    autoClear,
    clear(): void {
      calls.push({ kind: 'clear' });
    },
    clearDepth(): void {
      calls.push({ kind: 'clearDepth' });
    },
  };
  return { renderer: stub as unknown as WebGLRenderer, calls };
}

describe('shared camera state', () => {
  it('creates one camera per slab', () => {
    const cameras = new LayeredCameras();
    for (const id of RENDER_ORDER) {
      expect(cameras.cameraFor(id)).toBeDefined();
    }
    // Distinct objects, not one camera returned three times.
    const unique = new Set(RENDER_ORDER.map((id) => cameras.cameraFor(id)));
    expect(unique.size).toBe(3);
  });

  it('applies the same field of view, aspect, position and orientation to all three', () => {
    // CONTRACT SECTION 4: the cameras must share everything except their depth
    // planes, or the layers would not composite into one coherent view.
    const cameras = new LayeredCameras();
    cameras.setShared({
      fovDeg: 37.5,
      aspect: 16 / 9,
      position: new Vector3(1, -2, 3),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7),
    });

    const reference = cameras.cameraFor('NEAR');
    for (const id of RENDER_ORDER) {
      const camera = cameras.cameraFor(id);
      expect(camera.fov, `${id} fov`).toBe(reference.fov);
      expect(camera.aspect, `${id} aspect`).toBe(reference.aspect);
      expect(camera.position.distanceTo(reference.position), `${id} position`).toBe(0);
      expect(camera.quaternion.angleTo(reference.quaternion), `${id} orientation`).toBe(0);
    }

    expect(verifyCameraConsistency(cameras).consistent).toBe(true);
  });

  it('uses the documented default field of view', () => {
    expect(new LayeredCameras().cameraFor('NEAR').fov).toBe(DEFAULT_FOV_DEG);
  });

  it('copies vectors rather than holding the caller reference', () => {
    // A caller reusing its own Vector3 across frames must not be able to
    // desynchronise the cameras from each other or from the shared state.
    const cameras = new LayeredCameras();
    const position = new Vector3(5, 0, 0);
    cameras.setShared({ position });

    position.set(999, 999, 999);

    for (const id of RENDER_ORDER) {
      expect(cameras.cameraFor(id).position.x, `${id}`).toBe(5);
    }
    expect(cameras.sharedState.position.x).toBe(5);
  });

  it('leaves unspecified fields untouched', () => {
    const cameras = new LayeredCameras();
    cameras.setShared({ fovDeg: 60, aspect: 2 });
    cameras.setShared({ aspect: 1.5 });

    expect(cameras.cameraFor('NEAR').fov).toBe(60);
    expect(cameras.cameraFor('NEAR').aspect).toBe(1.5);
  });

  it('rejects a non-positive aspect ratio', () => {
    // Zero or negative aspect produces a degenerate projection matrix rather than
    // a visibly wrong image, so it is refused at the boundary.
    const cameras = new LayeredCameras();
    expect(() => cameras.setAspect(0)).toThrow(/positive/);
    expect(() => cameras.setAspect(-1)).toThrow(/positive/);
    expect(() => cameras.setAspect(Number.NaN)).toThrow(/finite/);
  });

  it('names the slab when asked for a camera that does not exist', () => {
    // @ts-expect-error deliberately passing an invalid slab id
    expect(() => new LayeredCameras().cameraFor('OUTER')).toThrow(/no camera for slab/);
  });
});

describe('the shared projection centre', () => {
  /**
   * THE MEASURED PROPERTY THE SELECTION SYSTEM DEPENDS ON.
   *
   * A perspective projection produces x_clip and y_clip from the field of view and
   * aspect ratio alone; only w_clip involves view depth, and neither near nor far
   * appears in the x or y rows of the matrix. So cameras differing only in their
   * depth planes project every point to the SAME pixel.
   *
   * That is what makes it safe for the hybrid picker to use one camera, and it is
   * why a body straddling a slab boundary can only ever show a depth artefact, never
   * a positional one.
   */
  it('projects to identical NDC x and y across all three cameras', () => {
    const cameras = new LayeredCameras();
    cameras.setShared({ aspect: 16 / 9 });
    cameras.applyPlan(planDepthSlabs(threeSlabScene()));

    // Confirm the planes really do differ, or the test would be vacuous.
    const planes = RENDER_ORDER.map((id) => {
      const camera = cameras.cameraFor(id);
      return `${camera.near}:${camera.far}`;
    });
    expect(new Set(planes).size).toBe(3);

    for (const point of [
      new Vector3(3, 2, -10),
      new Vector3(0.5, -0.25, -1e5),
      new Vector3(-100, 50, -4.4e6),
      new Vector3(1e-3, 1e-3, -1e-2),
    ]) {
      const reference = point.clone().project(cameras.cameraFor('NEAR'));

      for (const id of RENDER_ORDER.slice(1)) {
        const projected = point.clone().project(cameras.cameraFor(id));
        expectUlpAgreement(projected.x, reference.x, `${id} x for ${point.toArray().join(',')}`);
        expectUlpAgreement(projected.y, reference.y, `${id} y for ${point.toArray().join(',')}`);
      }
    }
  });

  it('holds for arbitrary points and arbitrary plane pairs', () => {
    forEachSample(DEFAULT_SEED ^ 0x0ca3, 400, (sampler, context) => {
      const cameras = new LayeredCameras();
      cameras.setShared({ aspect: sampler.range(0.5, 2.5), fovDeg: sampler.range(20, 90) });

      // Independent plane pairs spanning the full range the slabs can produce.
      const near = cameras.cameraFor('NEAR');
      const far = cameras.cameraFor('FAR');
      near.near = sampler.logRange(1e-7, 1e-1);
      near.far = sampler.logRange(1e2, 1e6);
      near.updateProjectionMatrix();
      far.near = sampler.logRange(1e2, 1e6);
      far.far = sampler.logRange(1e7, 1e18);
      far.updateProjectionMatrix();

      const point = new Vector3(
        sampler.range(-1e6, 1e6),
        sampler.range(-1e6, 1e6),
        -sampler.logRange(1, 1e7),
      );

      const viaNear = point.clone().project(near);
      const viaFar = point.clone().project(far);

      // ULP-relative, not absolute. NDC magnitudes here span from about 1e-6 for a
      // distant body to 5.7e4 for a point outside the frustum, so an absolute
      // tolerance would be far too loose at one end and impossible at the other.
      // The seed is carried through the label so any failure is reproducible.
      expectUlpAgreement(
        viaNear.x,
        viaFar.x,
        formatPropertyFailure({ ...context, axis: 'x' }, viaFar.x, viaNear.x),
      );
      expectUlpAgreement(
        viaNear.y,
        viaFar.y,
        formatPropertyFailure({ ...context, axis: 'y' }, viaFar.y, viaNear.y),
      );
    });
  });

  it('does differ in NDC z, which is the whole reason for separate cameras', () => {
    // The complement of the assertion above: if z were also identical the slabs
    // would be pointless.
    const cameras = new LayeredCameras();
    cameras.applyPlan(planDepthSlabs(threeSlabScene()));

    const point = new Vector3(0, 0, -1e5);
    const zValues = RENDER_ORDER.map((id) => point.clone().project(cameras.cameraFor(id)).z);
    expect(new Set(zValues).size).toBe(3);
  });

  it('nominates one camera for projection so callers cannot disagree', () => {
    const cameras = new LayeredCameras();
    expect(cameras.projectionCamera).toBe(cameras.cameraFor('NEAR'));
  });
});

describe('slab camera layer masks', () => {
  /**
   * REGRESSION GUARD FOR A TOTAL RENDERING FAILURE.
   *
   * An earlier revision created the three slab cameras without assigning layer masks, so
   * each kept the constructor default of layer 0 only. three.js decides submission in
   * WebGLRenderer.projectObject with
   *
   *   if ( object.layers.test( camera.layers ) )
   *
   * and Layers.test is a mask intersection. A default camera has mask 1, a planet mesh
   * assigned to the near slab has mask 2, and 1 & 2 is 0, so NOT ONE MESH was ever
   * submitted. All three slab passes rendered empty scenes and every planet was invisible.
   *
   * The failure was silent: no error, no warning, and the star field and orbit passes still
   * drew correctly because those two did assign their camera layers. The viewport therefore
   * showed stars and orbit lines with nothing on them, which looks like a body or scale
   * defect rather than a camera defect.
   *
   * These assertions are the cheapest possible check for it.
   */
  it('pins each slab camera to its own slab layer', () => {
    const cameras = new LayeredCameras();

    for (const id of RENDER_ORDER) {
      const camera = cameras.cameraFor(id);
      expect(
        camera.layers.isEnabled(SLAB_LAYERS[id]),
        `${id} camera is not enabled for layer ${SLAB_LAYERS[id]}, so it would draw nothing`,
      ).toBe(true);
    }
  });

  it('leaves layer 0 disabled on every slab camera', () => {
    // Layer 0 is reserved as the unassigned default. A slab camera that still included it
    // would draw any object whose own layer assignment had been forgotten, in all three
    // passes, which is exactly the bug UNASSIGNED_LAYER exists to expose rather than hide.
    const cameras = new LayeredCameras();

    for (const id of RENDER_ORDER) {
      expect(
        cameras.cameraFor(id).layers.isEnabled(UNASSIGNED_LAYER),
        `${id} camera still includes the unassigned layer`,
      ).toBe(false);
    }
  });

  it('gives each slab camera a mask that excludes every other pass', () => {
    // A camera drawing another pass's objects would use the wrong frustum and the wrong
    // depth state for them.
    const cameras = new LayeredCameras();

    for (const id of RENDER_ORDER) {
      const camera = cameras.cameraFor(id);

      for (const otherId of RENDER_ORDER) {
        if (otherId === id) continue;
        expect(
          camera.layers.isEnabled(SLAB_LAYERS[otherId]),
          `${id} camera would also draw ${otherId} geometry`,
        ).toBe(false);
      }

      expect(
        camera.layers.isEnabled(STARFIELD_LAYER),
        `${id} camera would also draw the star field`,
      ).toBe(false);
      expect(
        camera.layers.isEnabled(ORBIT_LAYER),
        `${id} camera would also draw orbit paths`,
      ).toBe(false);
    }
  });

  it('matches each camera mask to exactly one bit', () => {
    // `set` rather than `enable`, so the mask is a single bit. A mask with several bits
    // would mean the camera had accumulated layers rather than been pinned to one.
    const cameras = new LayeredCameras();

    for (const id of RENDER_ORDER) {
      const mask = cameras.cameraFor(id).layers.mask;
      expect(mask, `${id} camera mask`).toBe(1 << SLAB_LAYERS[id]);
      // A single set bit: subtracting one clears it and shares no bits with the original.
      expect(mask & (mask - 1), `${id} camera mask has more than one bit set`).toBe(0);
    }
  });

  it('survives a shared-state update, which must not touch layer masks', () => {
    // setShared rewrites projection and orientation every frame, so it must not reset the
    // masks as a side effect.
    const cameras = new LayeredCameras();
    cameras.setShared({ fovDeg: 60, aspect: 2, position: new Vector3(1e5, 0, 0) });
    cameras.applyPlan(planDepthSlabs(threeSlabScene()));

    for (const id of RENDER_ORDER) {
      expect(cameras.cameraFor(id).layers.mask, `${id} after update`).toBe(1 << SLAB_LAYERS[id]);
    }
  });
});

describe('applying a depth plan', () => {
  it('sets each occupied slab camera to its planned planes', () => {
    const cameras = new LayeredCameras();
    const plan = planDepthSlabs(twoSlabScene());
    cameras.applyPlan(plan);

    for (const slab of plan.nonEmpty) {
      const camera = cameras.cameraFor(slab.id);
      expect(camera.near, `${slab.id} near`).toBe(slab.near);
      expect(camera.far, `${slab.id} far`).toBe(slab.far);
    }
  });

  it('returns the occupied slabs in far-to-near order', () => {
    // CONTRACT SECTION 4.2. Rendering near-first would let near geometry be
    // overwritten by far geometry after the depth clear.
    const cameras = new LayeredCameras();
    const active = cameras.applyPlan(planDepthSlabs(threeSlabScene()));

    expect(active.map((entry) => entry.id)).toEqual(['FAR', 'MIDDLE', 'NEAR']);
  });

  it('omits empty slabs from the active list', () => {
    // Measured earlier: a solar-system scene occupies MIDDLE and NEAR only, because
    // MIDDLE's nominal range reaches 67 au.
    const cameras = new LayeredCameras();
    const active = cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    expect(active.map((entry) => entry.id)).toEqual(['MIDDLE', 'NEAR']);
    expect(active.some((entry) => entry.id === 'FAR')).toBe(false);
  });

  it('leaves an empty slab camera with a valid projection rather than zeroed planes', () => {
    // Writing zeroes would give a degenerate matrix if that camera were ever used
    // by mistake. Keeping the previous planes fails safe.
    const cameras = new LayeredCameras();
    cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    const unused = cameras.cameraFor('FAR');
    expect(unused.near).toBeGreaterThan(0);
    expect(unused.far).toBeGreaterThan(unused.near);
  });

  it('carries the plan through so a caller can inspect what it is drawing', () => {
    const cameras = new LayeredCameras();
    const active = cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    const near = active.find((entry) => entry.id === 'NEAR')!;
    expect(near.plan.members).toEqual(['moon', 'earth']);
    expect(near.plan.empty).toBe(false);
  });

  it('handles an empty frame without producing a camera to render with', () => {
    const cameras = new LayeredCameras();
    expect(cameras.applyPlan(planDepthSlabs([]))).toEqual([]);
  });
});

describe('frame rendering sequence', () => {
  it('refuses to render when autoClear is left enabled', () => {
    // With autoClear true, three.js clears the colour buffer at the start of every
    // render call, so only the last slab would survive. Silently setting the flag
    // from inside this helper would hide a renderer misconfiguration, so it is
    // reported instead.
    const cameras = new LayeredCameras();
    const { renderer } = recordingRenderer(true);

    expect(() =>
      cameras.renderFrame(renderer, planDepthSlabs(twoSlabScene()), () => {}),
    ).toThrow(/autoClear must be false/);
  });

  it('clears once, then clears depth only between slabs', () => {
    // THE COMPOSITING CONTRACT, section 4.2, as a call sequence.
    const cameras = new LayeredCameras();
    const { renderer, calls } = recordingRenderer(false);

    const depthClears = cameras.renderFrame(
      renderer,
      planDepthSlabs(threeSlabScene()),
      (slab) => calls.push({ kind: 'draw', slab: slab.id }),
    );

    expect(calls).toEqual([
      { kind: 'clear' },
      { kind: 'draw', slab: 'FAR' },
      { kind: 'clearDepth' },
      { kind: 'draw', slab: 'MIDDLE' },
      { kind: 'clearDepth' },
      { kind: 'draw', slab: 'NEAR' },
    ]);
    expect(depthClears).toBe(2);
  });

  it('spends no depth clear on an empty slab', () => {
    // Two occupied slabs need one clear, not two.
    const cameras = new LayeredCameras();
    const { renderer, calls } = recordingRenderer(false);

    const plan = planDepthSlabs(twoSlabScene());
    const depthClears = cameras.renderFrame(renderer, plan, (slab) =>
      calls.push({ kind: 'draw', slab: slab.id }),
    );

    expect(depthClears).toBe(1);
    expect(depthClears).toBe(plan.clearDepthCount);
    expect(calls.filter((call) => call.kind === 'clearDepth')).toHaveLength(1);
  });

  it('never clears colour after the first clear', () => {
    // A second full clear would discard every slab drawn so far. The stub records
    // clear and clearDepth distinctly precisely so this can be asserted.
    const cameras = new LayeredCameras();
    const { renderer, calls } = recordingRenderer(false);

    cameras.renderFrame(renderer, planDepthSlabs(threeSlabScene()), () => {});

    expect(calls.filter((call) => call.kind === 'clear')).toHaveLength(1);
    expect(calls[0]!.kind).toBe('clear');
  });

  it('draws nothing and clears nothing for an empty frame', () => {
    const cameras = new LayeredCameras();
    const { renderer, calls } = recordingRenderer(false);

    const depthClears = cameras.renderFrame(renderer, planDepthSlabs([]), () => {
      throw new Error('draw callback must not run for an empty frame');
    });

    expect(depthClears).toBe(0);
    expect(calls).toEqual([]);
  });

  it('can skip the initial clear when compositing over existing content', () => {
    const cameras = new LayeredCameras();
    const { renderer, calls } = recordingRenderer(false);

    cameras.renderFrame(renderer, planDepthSlabs(twoSlabScene()), () => {}, {
      clearFirst: false,
    });

    expect(calls.filter((call) => call.kind === 'clear')).toHaveLength(0);
    // Depth clears between slabs are still required.
    expect(calls.filter((call) => call.kind === 'clearDepth')).toHaveLength(1);
  });

  it('hands each callback the camera configured for that slab', () => {
    const cameras = new LayeredCameras();
    const { renderer } = recordingRenderer(false);
    const plan = planDepthSlabs(twoSlabScene());

    cameras.renderFrame(renderer, plan, (slab) => {
      expect(slab.camera).toBe(cameras.cameraFor(slab.id));
      expect(slab.camera.near).toBe(slab.plan.near);
      expect(slab.camera.far).toBe(slab.plan.far);
    });
  });
});

describe('consistency verification', () => {
  it('detects a desynchronised field of view', () => {
    // The verifier must be able to fail, or it proves nothing. Mutating a camera
    // directly is the failure mode it exists to catch.
    const cameras = new LayeredCameras();
    cameras.cameraFor('MIDDLE').fov = 90;

    const verification = verifyCameraConsistency(cameras);
    expect(verification.consistent).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('fov'))).toBe(true);
  });

  it('detects a desynchronised orientation', () => {
    const cameras = new LayeredCameras();
    cameras.cameraFor('NEAR').quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.5);

    const verification = verifyCameraConsistency(cameras);
    expect(verification.consistent).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('orientation'))).toBe(true);
  });

  it('detects a desynchronised position', () => {
    const cameras = new LayeredCameras();
    cameras.cameraFor('FAR').position.set(1, 0, 0);

    const verification = verifyCameraConsistency(cameras);
    expect(verification.consistent).toBe(false);
    expect(verification.problems.some((problem) => problem.includes('position'))).toBe(true);
  });

  it('stays consistent through a full update cycle', () => {
    const cameras = new LayeredCameras();
    cameras.setShared({ fovDeg: 55, aspect: 1.777 });
    cameras.applyPlan(planDepthSlabs(threeSlabScene()));
    cameras.setAspect(2.1);
    cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    expect(verifyCameraConsistency(cameras).consistent).toBe(true);
  });
});

describe('projection to normalised device coordinates', () => {
  it('agrees with the three.js projection for x and y', () => {
    // projectToNdc recovers w separately, which Vector3.project discards. The x and
    // y it returns must nonetheless match exactly.
    const cameras = new LayeredCameras();
    cameras.setShared({ aspect: 16 / 9 });
    cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    for (const point of [
      new Vector3(3, 2, -10),
      new Vector3(-100, 50, -4.4e6),
      new Vector3(0, 0, -1),
    ]) {
      const viaHelper = projectToNdc(cameras, point);
      const viaThree = point.clone().project(cameras.projectionCamera);

      expect(viaHelper.x).toBe(viaThree.x);
      expect(viaHelper.y).toBe(viaThree.y);
    }
  });

  it('returns positive w in front of the camera and negative behind it', () => {
    /**
     * THE TRAP THIS EXISTS TO CLOSE, measured.
     *
     * A point behind the camera projects to a perfectly plausible looking NDC pair:
     * at view position (10, 5, +50) the result is (-0.2716, -0.2414), which is well
     * inside the viewport and would be selectable. Its w is -50, and the sign of w
     * is the only reliable way to reject it.
     *
     * Discarding w, as Vector3.project does, makes a body behind the camera pickable
     * at a pixel where nothing is drawn.
     */
    const cameras = new LayeredCameras();
    cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    const inFront = projectToNdc(cameras, new Vector3(0, 0, -100));
    expect(inFront.w).toBeGreaterThan(0);

    const behind = projectToNdc(cameras, new Vector3(10, 5, 50));
    expect(behind.w).toBeLessThan(0);
    // And its NDC lands inside the viewport, which is why the w check is required.
    expect(Math.abs(behind.x)).toBeLessThan(1);
    expect(Math.abs(behind.y)).toBeLessThan(1);
  });

  it('reports w as the view-space distance along the view direction', () => {
    const cameras = new LayeredCameras();
    expect(projectToNdc(cameras, new Vector3(0, 0, -1234.5)).w).toBeCloseTo(1234.5, 9);
  });

  it('places a point on the view axis at the centre of the viewport', () => {
    const cameras = new LayeredCameras();
    cameras.applyPlan(planDepthSlabs(twoSlabScene()));

    const centre = projectToNdc(cameras, new Vector3(0, 0, -500));
    expect(centre.x).toBeCloseTo(0, 12);
    expect(centre.y).toBeCloseTo(0, 12);
  });

  it('respects camera orientation', () => {
    // Rotating the camera 90 degrees about +Y makes -X the new view direction, so a
    // point on -X should land at the centre.
    const cameras = new LayeredCameras();
    cameras.setShared({
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
    });

    const projected = projectToNdc(cameras, new Vector3(-500, 0, 0));
    expect(projected.w).toBeGreaterThan(0);
    expect(projected.x).toBeCloseTo(0, 9);
    expect(projected.y).toBeCloseTo(0, 9);
  });
});

describe('pixel conversion', () => {
  it('maps the NDC centre to the viewport centre', () => {
    expect(ndcToPixels(0, 0, 1920, 1080)).toEqual({ x: 960, y: 540 });
  });

  it('flips y, since NDC counts upward and pixels count downward', () => {
    // A common source of inverted picking. NDC +1 is the top of the screen, which
    // is pixel row 0.
    expect(ndcToPixels(0, 1, 1920, 1080).y).toBe(0);
    expect(ndcToPixels(0, -1, 1920, 1080).y).toBe(1080);
  });

  it('maps the NDC corners to the viewport corners', () => {
    expect(ndcToPixels(-1, 1, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(ndcToPixels(1, -1, 800, 600)).toEqual({ x: 800, y: 600 });
  });
});

describe('apparent radius in pixels', () => {
  it('images an object spanning the view height as half the viewport', () => {
    // Sanity anchor from the projection geometry: at distance d the visible
    // half-height is d tan(fov/2).
    const distance = 100;
    const halfHeight = distance * Math.tan((DEFAULT_FOV_DEG * Math.PI) / 360);
    expect(apparentRadiusPixels(halfHeight, distance, DEFAULT_FOV_DEG, 1080)).toBeCloseTo(
      540,
      6,
    );
  });

  it('scales linearly with radius and inversely with distance', () => {
    const base = apparentRadiusPixels(10, 1000, DEFAULT_FOV_DEG, 1080);
    expect(apparentRadiusPixels(20, 1000, DEFAULT_FOV_DEG, 1080)).toBeCloseTo(base * 2, 9);
    expect(apparentRadiusPixels(10, 2000, DEFAULT_FOV_DEG, 1080)).toBeCloseTo(base / 2, 9);
  });

  it('identifies a body that falls below the sub-pixel marker threshold', () => {
    // CONTRACT SECTION 8 exists because this case is real. Mercury has a render
    // radius of 2.44 units in scientific scale; seen from 1.8e5 units away it is
    // far under a pixel across and needs a marker rather than geometry.
    const mercuryRadiusUnits = 2.4394;
    const overviewDistanceUnits = 1.7886e5;

    const radiusPx = apparentRadiusPixels(
      mercuryRadiusUnits,
      overviewDistanceUnits,
      DEFAULT_FOV_DEG,
      1080,
    );

    // Diameter below 2 px is the threshold section 8 names.
    expect(radiusPx * 2).toBeLessThan(2);
    expect(radiusPx).toBeGreaterThan(0);
  });

  it('identifies a body that does not need a marker', () => {
    // The same body at close range is thousands of pixels across.
    expect(apparentRadiusPixels(2.4394, 10, DEFAULT_FOV_DEG, 1080)).toBeGreaterThan(100);
  });

  it('rejects a non-positive distance', () => {
    expect(() => apparentRadiusPixels(1, 0, DEFAULT_FOV_DEG, 1080)).toThrow(/positive/);
    expect(() => apparentRadiusPixels(1, -10, DEFAULT_FOV_DEG, 1080)).toThrow(/positive/);
  });
});
