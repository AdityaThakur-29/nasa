/**
 * STEP 0 GL INFRASTRUCTURE SMOKE TEST.
 *
 * Verifies the browser project can obtain a real WebGL2 context with the exact
 * capabilities the M1 depth-slab gate depends on:
 *
 *   - WebGL2 context creation under headless Chromium (ANGLE/SwiftShader)
 *   - logarithmicDepthBuffer support
 *   - manual clear control (autoClear=false + clearDepth between slabs)
 *   - render-target readback (coverage counting for the stress gate)
 *   - finite projection at extreme near/far ratios
 *
 * Expected pixel counts are derived analytically from projection geometry
 * rather than hardcoded, and compared within a tolerance band. No screenshot
 * comparison and no exact colour matching.
 *
 * This asserts *infrastructure capability only*. It contains no astronomical
 * data. Numerical correctness belongs to the `unit` project and must never be
 * weakened to accommodate anything observed here.
 */

import { describe, expect, it } from 'vitest';
import {
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

const SIZE = 256;
const FOV_DEG = 45;
const WIDTH_SEGMENTS = 32;

/**
 * Rasteriser tolerance band. Accounts for polygonal sphere tessellation,
 * disabled antialiasing, the coverage luminance threshold, and mild
 * off-axis silhouette distortion.
 */
const TOLERANCE_LOW = 0.82;
const TOLERANCE_HIGH = 1.18;

/** Silhouette radius in pixels of a sphere of radius r at camera distance d. */
function projectedRadiusPx(r: number, d: number, heightPx: number): number {
  const halfFov = (FOV_DEG * Math.PI) / 360;
  const halfHeightAtD = d * Math.tan(halfFov);
  return (r / halfHeightAtD) * (heightPx / 2);
}

/**
 * Area of a regular n-gon inscribed in a circle of radius rPx. A tessellated
 * sphere silhouette is an inscribed polygon, so this is a closer prediction of
 * rasterised coverage than pi*r^2.
 */
function tessellatedDiscArea(rPx: number, segments: number): number {
  return 0.5 * segments * rPx * rPx * Math.sin((2 * Math.PI) / segments);
}

function makeRenderer(): WebGLRenderer {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.appendChild(canvas);

  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    logarithmicDepthBuffer: true,
    powerPreference: 'default',
  });
  renderer.setSize(SIZE, SIZE, false);
  renderer.autoClear = false;
  return renderer;
}

/** Counts pixels differing from the cleared background. Never matches colour. */
function coverage(pixels: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    if (r > 8 || g > 8 || b > 8) n++;
  }
  return n;
}

function readback(renderer: WebGLRenderer, target: WebGLRenderTarget): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, pixels);
  return pixels;
}

function expectWithinBand(actual: number, expected: number, label: string): void {
  const low = expected * TOLERANCE_LOW;
  const high = expected * TOLERANCE_HIGH;
  expect(
    actual >= low && actual <= high,
    `${label}: coverage ${actual} px outside analytic band [${low.toFixed(0)}, ${high.toFixed(0)}] ` +
      `(predicted ${expected.toFixed(0)} px)`,
  ).toBe(true);
}

describe('GL infrastructure', () => {
  it('creates a WebGL2 context', () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    expect(gl).not.toBeNull();
  });

  it('reports renderer capabilities required by the depth-slab pipeline', () => {
    const renderer = makeRenderer();
    const caps = renderer.capabilities;

    expect(caps.isWebGL2).toBe(true);
    expect(caps.logarithmicDepthBuffer).toBe(true);
    expect(caps.maxTextures).toBeGreaterThanOrEqual(8);

    renderer.dispose();
  });

  it('renders geometry and reads back coverage matching projection geometry', () => {
    const renderer = makeRenderer();
    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    scene.add(
      new Mesh(
        new SphereGeometry(1, WIDTH_SEGMENTS, WIDTH_SEGMENTS / 2),
        new MeshBasicMaterial({ color: 0xffffff }),
      ),
    );

    const target = new WebGLRenderTarget(SIZE, SIZE);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    const actual = coverage(readback(renderer, target));
    renderer.setRenderTarget(null);

    const rPx = projectedRadiusPx(1, 5, SIZE);
    expectWithinBand(actual, tessellatedDiscArea(rPx, WIDTH_SEGMENTS), 'unit sphere at d=5');

    const gl = renderer.getContext();
    expect(gl.getError()).toBe(gl.NO_ERROR);

    target.dispose();
    renderer.dispose();
  });

  it('preserves the colour buffer across an explicit depth clear between slabs', () => {
    const renderer = makeRenderer();

    // Far slab: large distant sphere, screen-centred.
    const farRadius = 40;
    const farDistance = 1000;
    const farScene = new Scene();
    farScene.add(
      new Mesh(
        new SphereGeometry(farRadius, WIDTH_SEGMENTS, WIDTH_SEGMENTS / 2),
        new MeshBasicMaterial({ color: 0x808080 }),
      ),
    );
    const farCam = new PerspectiveCamera(FOV_DEG, 1, 100, 5000);
    farCam.position.set(0, 0, farDistance);
    farCam.updateMatrixWorld(true);

    // Near slab: small close sphere, deliberately offset so it does NOT overlap
    // the far body on screen. Without this separation the test cannot tell
    // "far slab survived" from "far slab was overwritten".
    const nearRadius = 0.3;
    const nearDistance = 3;
    const nearScene = new Scene();
    const nearMesh = new Mesh(
      new SphereGeometry(nearRadius, WIDTH_SEGMENTS, WIDTH_SEGMENTS / 2),
      new MeshBasicMaterial({ color: 0xffffff }),
    );
    nearMesh.position.set(0.6, 0, 0);
    nearScene.add(nearMesh);
    const nearCam = new PerspectiveCamera(FOV_DEG, 1, 0.01, 50);
    nearCam.position.set(0, 0, nearDistance);
    nearCam.updateMatrixWorld(true);

    const farPredicted = tessellatedDiscArea(
      projectedRadiusPx(farRadius, farDistance, SIZE),
      WIDTH_SEGMENTS,
    );
    const nearPredicted = tessellatedDiscArea(
      projectedRadiusPx(nearRadius, nearDistance, SIZE),
      WIDTH_SEGMENTS,
    );

    const target = new WebGLRenderTarget(SIZE, SIZE);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);

    renderer.render(farScene, farCam);
    const farOnly = coverage(readback(renderer, target));
    expectWithinBand(farOnly, farPredicted, 'far slab alone');

    // Depth cleared, colour retained. This is the slab-compositing contract.
    renderer.clearDepth();
    renderer.render(nearScene, nearCam);
    const both = coverage(readback(renderer, target));
    renderer.setRenderTarget(null);

    // Both contributions must coexist in one colour buffer.
    expectWithinBand(both, farPredicted + nearPredicted, 'far + near slabs composited');
    expect(
      both,
      'near-slab render must add coverage, not replace the far slab',
    ).toBeGreaterThan(farOnly);

    const gl = renderer.getContext();
    expect(gl.getError()).toBe(gl.NO_ERROR);

    target.dispose();
    renderer.dispose();
  });

  it('produces finite projected coordinates at extreme depth ratios', () => {
    // near=1e-4, far=1e7 is the worst-case ratio the near slab must tolerate.
    const camera = new PerspectiveCamera(FOV_DEG, 16 / 9, 1e-4, 1e7);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    for (const el of camera.projectionMatrix.elements) {
      expect(Number.isFinite(el)).toBe(true);
    }
  });
});
