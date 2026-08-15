/**
 * Render-object validation.
 *
 * WHY THIS RUNS IN NODE. Only WebGLRenderer needs a GL context. Scene, Mesh, Points,
 * BufferGeometry, LineGeometry and the whole of three.js core math are plain
 * JavaScript objects over typed arrays, so the logic that decides WHAT is drawn, WHERE
 * it is written and WHICH buffer receives it is fully testable headlessly. What the
 * browser suite adds is whether the resulting pixels composite correctly.
 *
 * THE PRINCIPAL TARGET IS THE ORBIT PRECISION FIX. An earlier revision of
 * orbit-paths.ts stored absolute render coordinates and let the GPU's f32 model matrix
 * perform the origin subtraction, which produced up to 14.9 pixels of jitter in
 * focus-on-planet view. The fix subtracts in f64 and writes only the small difference.
 * That claim is measured here against the real code path rather than trusted.
 */

import { describe, expect, it } from 'vitest';
import { Quaternion, Scene, Vector3 } from 'three';
import type { InterleavedBufferAttribute } from 'three';
import {
  orbitalPlanePosition,
  orbitalPlaneToReferencePlane,
} from '@/ephemeris/kepler';
import { compressDistanceKm } from '@/sim/scale';
import { DEG_TO_RAD } from '@/data/constants';
import {
  MARKER_BASE_SIZE_PX,
  MARKER_DIAMETER_THRESHOLD_PX,
  MARKER_MAX_SIZE_PX,
  MARKER_MIN_SIZE_PX,
  SLAB_LAYERS,
  STARFIELD_LAYER,
  BodyVisuals,
  markerSizeFor,
} from '@/render/body-visuals';
import {
  DEFAULT_STAR_COUNT,
  STARFIELD_PROVENANCE,
  Starfield,
  generateStars,
} from '@/render/starfield';
import {
  ORBIT_LAYER,
  ORBIT_LINE_WIDTH_PX,
  ORBIT_OPACITY,
  ORBIT_PROVENANCE,
  ORBIT_SAMPLE_COUNT,
  OrbitPaths,
  SELECTED_ORBIT_LINE_WIDTH_PX,
  SELECTED_ORBIT_OPACITY,
} from '@/render/orbit-paths';
import { LayeredCameras, DEFAULT_FOV_DEG } from '@/render/layered-cameras';
import { planDepthSlabs, RENDER_ORDER, type DepthCandidate } from '@/render/depth-slabs';
import { errorToPixels } from '@/render/floating-origin';
import { SimulationState } from '@/sim/state';
import { SimulationClock } from '@/core/clock';
import { ttFromUtc, utc } from '@/core/jd';
import {
  RENDER_UNIT_KM,
  scaleSystem,
  scientificScale,
  visualizedScale,
  type ScaledBody,
} from '@/sim/scale';
import { computeIllumination, physicalBrightness } from '@/sim/irradiance';
import { createPlanetsProvider } from '@/ephemeris/planets';
import { BODY_ORDER, PLANET_IDS, getBody } from '@/data/bodies';
import { AU_KM } from '@/data/constants';
import { DEFAULT_SEED, forEachSample, formatPropertyFailure } from '../helpers/seeded';

const VIEWPORT_WIDTH_PX = 1920;
const VIEWPORT_HEIGHT_PX = 1080;

/** A paused simulation at a fixed instant, so every assertion is reproducible. */
function fixedState(): SimulationState {
  return new SimulationState({
    clock: new SimulationClock({ epoch: utc(2026, 8, 15), paused: true }),
  });
}

/** Scales a snapshot for the render layer. */
function scaleSnapshot(state: SimulationState, config = scientificScale()): readonly ScaledBody[] {
  return scaleSystem(
    state.snapshot().bodies.map((body) => ({
      bodyId: body.bodyId,
      positionKm: body.positionKm,
      parentId: body.parentId,
      physicalRadiusKm: body.physicalRadiusKm,
    })),
    config,
  );
}

describe('marker sizing', () => {
  it('scales with absolute magnitude so brighter bodies read as brighter', () => {
    // Contract section 8 asks for magnitude-based sizing where data is available. The
    // published V(1,0) values run from -9.40 for Jupiter to -0.60 for Mercury, so the
    // ordering of marker sizes must follow that.
    const jupiter = markerSizeFor('jupiter');
    const venus = markerSizeFor('venus');
    const mercury = markerSizeFor('mercury');

    expect(jupiter).toBeGreaterThan(venus);
    expect(venus).toBeGreaterThan(mercury);
  });

  it('keeps every marker inside the documented bounds', () => {
    // Bounded so a bright body cannot be drawn as a disc that might be mistaken for
    // its angular size, which section 8 forbids.
    for (const bodyId of BODY_ORDER) {
      const size = markerSizeFor(bodyId);
      expect(size, `${bodyId}`).toBeGreaterThanOrEqual(MARKER_MIN_SIZE_PX);
      expect(size, `${bodyId}`).toBeLessThanOrEqual(MARKER_MAX_SIZE_PX);
    }
  });

  it('falls back to the base size when no magnitude is published', () => {
    // THE HONEST FALLBACK. The Moon carries no absolute magnitude in the sources
    // consulted, and section 8 says to use magnitude "where data is available". A
    // fabricated magnitude would be worse than a constant size.
    expect(getBody('moon').absoluteMagnitudeV10).toBeUndefined();
    expect(markerSizeFor('moon')).toBe(MARKER_BASE_SIZE_PX);
  });

  it('falls back rather than throwing for an unknown body', () => {
    // A missing body is a caller error elsewhere; it must not abort a frame.
    expect(markerSizeFor('nibiru')).toBe(MARKER_BASE_SIZE_PX);
  });

  it('is deterministic', () => {
    for (const bodyId of PLANET_IDS) {
      expect(markerSizeFor(bodyId)).toBe(markerSizeFor(bodyId));
    }
  });
});

describe('star field generation', () => {
  it('generates the requested count', () => {
    expect(generateStars(500).length).toBe(500);
    expect(generateStars().length).toBe(DEFAULT_STAR_COUNT);
    expect(generateStars(0).length).toBe(0);
  });

  it('is reproducible from its seed', () => {
    // A field that shimmered between runs would be a visible defect, and one that
    // shimmered between frames would be unusable.
    const first = generateStars(200, 12345);
    const second = generateStars(200, 12345);
    expect(second).toEqual(first);

    const different = generateStars(200, 54321);
    expect(different).not.toEqual(first);
  });

  it('places every star on the unit sphere', () => {
    for (const star of generateStars(1000)) {
      const magnitude = Math.hypot(...star.direction);
      expect(magnitude).toBeCloseTo(1, 9);
    }
  });

  it('distributes uniformly over the sphere rather than clustering at the poles', () => {
    /**
     * THE CLASSIC ERROR THIS GUARDS. Sampling both spherical angles uniformly
     * concentrates stars near the poles, which is immediately visible as two bright
     * patches. The correct method samples z uniformly.
     *
     * For a uniform distribution, the fraction of stars in any band of z has to equal
     * that band's fraction of the full [-1, 1] range. Ten equal bands should therefore
     * each hold about a tenth of the stars.
     */
    const stars = generateStars(20_000, 999);
    const bandCount = 10;
    const bands = new Array<number>(bandCount).fill(0);

    for (const star of stars) {
      const z = star.direction[2];
      const index = Math.min(bandCount - 1, Math.floor(((z + 1) / 2) * bandCount));
      bands[index] = (bands[index] ?? 0) + 1;
    }

    const expected = stars.length / bandCount;
    for (const [index, count] of bands.entries()) {
      // Three sigma for a binomial of this size is about 4 percent, so 15 percent is
      // loose enough not to flake and tight enough to catch polar clustering, which
      // would show as a band several times the expected count.
      expect(
        Math.abs(count - expected) / expected,
        `band ${index} holds ${count} stars against an expected ${expected}`,
      ).toBeLessThan(0.15);
    }
  });

  it('produces more faint stars than bright ones', () => {
    // Real star counts rise steeply with magnitude. A uniform draw would give a sky of
    // uniformly bright stars, which reads as artificial.
    const stars = generateStars(5000, 777);
    const faint = stars.filter((star) => star.magnitude > 4).length;
    const bright = stars.filter((star) => star.magnitude < 1).length;

    expect(faint).toBeGreaterThan(bright * 2);
  });

  it('assigns a colour from the temperature sequence to every star', () => {
    for (const star of generateStars(500)) {
      expect(star.colour).toHaveLength(3);
      for (const channel of star.colour) {
        expect(channel).toBeGreaterThan(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects an invalid count', () => {
    expect(() => generateStars(-1)).toThrow(/non-negative/);
    expect(() => generateStars(1.5)).toThrow(/integer/);
  });

  it('declares itself a statistical distribution rather than a catalogue', () => {
    // Contract section 18 requires synthesised objects to be labelled as such. The
    // same rule that applies to the asteroid belt applies to stars, for the same
    // reason: presenting generated objects as observed ones is fabrication.
    expect(STARFIELD_PROVENANCE.status).toBe('STATISTICAL DISTRIBUTION');
    expect(STARFIELD_PROVENANCE.note).toMatch(/not a star catalogue/i);
    expect(STARFIELD_PROVENANCE.note).toMatch(/no star shown corresponds to a real star/i);
  });
});

describe('star field object', () => {
  it('sits on its own layer, isolated from the slabs', () => {
    const scene = new Scene();
    const starfield = new Starfield(scene, { count: 100 });

    expect(starfield.object.layers.isEnabled(STARFIELD_LAYER)).toBe(true);
    for (const slabId of RENDER_ORDER) {
      expect(
        starfield.object.layers.isEnabled(SLAB_LAYERS[slabId]),
        `star field leaked onto the ${slabId} layer`,
      ).toBe(false);
    }

    starfield.dispose();
  });

  it('neither tests nor writes depth', () => {
    // Stars are effectively infinitely distant, so they must never occlude anything.
    // Writing depth would also leave values the first slab's depth clear must remove.
    const scene = new Scene();
    const starfield = new Starfield(scene, { count: 10 });
    const material = starfield.object.material as { depthTest: boolean; depthWrite: boolean };

    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);

    starfield.dispose();
  });

  it('copies camera orientation but never camera position', () => {
    /**
     * THE PROPERTY THAT MAKES STARS BEHAVE AS INFINITELY DISTANT.
     *
     * Turning the camera must sweep the field, so orientation is shared. Translating
     * the camera must not move it at all, so position is not. Locking translation is
     * physically defensible rather than a shortcut: the largest parallax available in
     * this application is about 23 arcseconds across a 30 au baseline, against roughly
     * 150 arcseconds per pixel at this field of view.
     */
    const scene = new Scene();
    const starfield = new Starfield(scene, { count: 10 });
    const cameras = new LayeredCameras();

    cameras.setShared({
      position: new Vector3(1.5e5, -2e5, 3e4),
      aspect: 16 / 9,
      fovDeg: 55,
    });
    starfield.update(cameras.sharedState);

    expect(starfield.starCamera.position.length()).toBe(0);
    expect(starfield.starCamera.fov).toBe(55);
    expect(starfield.starCamera.aspect).toBeCloseTo(16 / 9, 12);

    starfield.dispose();
  });

  it('rotates with the camera but does not translate with it', () => {
    const scene = new Scene();
    const starfield = new Starfield(scene, { count: 10 });
    const cameras = new LayeredCameras();

    // Baseline: identity orientation, camera at the coordinate origin.
    starfield.update(cameras.sharedState);
    const baseline = starfield.starCamera.matrixWorldInverse.clone();

    // TRANSLATION MUST NOT MOVE THE FIELD. Sweeping the camera from Earth out to
    // Neptune is a 30 au baseline, which shifts even the nearest real star by about
    // 23 arcseconds, against roughly 150 arcseconds per pixel at this field of view.
    cameras.setShared({ position: new Vector3(4.5e6, -1e6, 3e5) });
    starfield.update(cameras.sharedState);

    expect(starfield.starCamera.matrixWorldInverse.equals(baseline)).toBe(true);
    expect(starfield.starCamera.position.length()).toBe(0);

    // ROTATION MUST SWEEP IT, since that is how orientation is perceived.
    cameras.setShared({ quaternion: quaternionAboutY(Math.PI / 3) });
    starfield.update(cameras.sharedState);

    expect(starfield.starCamera.matrixWorldInverse.equals(baseline)).toBe(false);

    starfield.dispose();
  });

  it('rejects a negative intensity', () => {
    const scene = new Scene();
    const starfield = new Starfield(scene, { count: 10 });
    expect(() => starfield.setIntensity(-1)).toThrow(/non-negative/);
    starfield.dispose();
  });
});

describe('body visuals', () => {
  it('draws geometry when a body is large enough and a marker when it is not', () => {
    // Contract section 8: below a 2 pixel projected diameter a sphere covers a handful
    // of fragments, its shading is meaningless, and it may miss the pixel grid and
    // flicker between frames.
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    // Camera near Earth, so Earth is large and the outer planets are sub-pixel.
    const earth = scaled.find((body) => body.bodyId === 'earth')!;
    const camera = new Vector3(
      earth.renderPosition.x + earth.visualRadius * 3,
      earth.renderPosition.y,
      earth.renderPosition.z,
    );

    const frame = visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: computeIllumination(
        state.snapshot().bodies.map((body) => ({
          bodyId: body.bodyId,
          distanceFromSunKm: body.distanceFromSunKm,
        })),
        physicalBrightness(),
      ),
      plan: planDepthSlabs(candidatesFor(scaled, camera)),
      origin: { x: camera.x, y: camera.y, z: camera.z },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    const earthState = frame.find((entry) => entry.bodyId === 'earth')!;
    expect(earthState.drawnAsMarker).toBe(false);
    expect(earthState.apparentRadiusPx * 2).toBeGreaterThan(MARKER_DIAMETER_THRESHOLD_PX);

    const neptuneState = frame.find((entry) => entry.bodyId === 'neptune')!;
    expect(neptuneState.drawnAsMarker).toBe(true);
    expect(neptuneState.apparentRadiusPx * 2).toBeLessThan(MARKER_DIAMETER_THRESHOLD_PX);

    // Never both: the sphere and the marker would contend for the same fragments.
    expect(visuals.meshFor('neptune')!.visible).toBe(false);
    expect(visuals.meshFor('earth')!.visible).toBe(true);

    visuals.dispose();
  });

  it('assigns each mesh to exactly its slab layer', () => {
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    const camera = new Vector3(0, 0, 0);
    const plan = planDepthSlabs(candidatesFor(scaled, camera));

    visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: [],
      plan,
      origin: { x: 0, y: 0, z: 0 },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    for (const [bodyId, slabId] of plan.assignment) {
      const mesh = visuals.meshFor(bodyId);
      if (mesh === undefined) continue;

      expect(
        mesh.layers.isEnabled(SLAB_LAYERS[slabId]),
        `${bodyId} is not on its ${slabId} layer`,
      ).toBe(true);

      // Layer 0 is deliberately unused, so an unassigned object cannot appear in a
      // camera that happens to include it.
      expect(mesh.layers.isEnabled(0), `${bodyId} leaked onto layer 0`).toBe(false);
    }

    visuals.dispose();
  });

  it('gives each slab its own marker buffer, so no marker is blended twice', () => {
    /**
     * REGRESSION GUARD FOR A REAL BUG.
     *
     * An earlier revision used ONE Points object for every marker and enabled it on
     * every occupied slab layer, because a Points object cannot be split across
     * layers. With additive blending and depth writing disabled, a marker that
     * survives the depth test in two passes is blended TWICE and comes out at double
     * brightness. The depth clear between slabs guarantees it survives every pass, so
     * the bug fires on any frame with markers in more than one slab.
     *
     * Per-slab buffers mean each marker is written once, into one buffer, drawn in one
     * pass.
     */
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    const camera = new Vector3(0, 0, 0);
    const plan = planDepthSlabs(candidatesFor(scaled, camera));

    const frame = visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: [],
      plan,
      origin: { x: 0, y: 0, z: 0 },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    // Each slab's cloud is pinned to exactly one layer and never re-enabled elsewhere.
    for (const slabId of RENDER_ORDER) {
      const points = visuals.markersFor(slabId);
      expect(points.layers.isEnabled(SLAB_LAYERS[slabId]), `${slabId}`).toBe(true);

      for (const otherId of RENDER_ORDER) {
        if (otherId === slabId) continue;
        expect(
          points.layers.isEnabled(SLAB_LAYERS[otherId]),
          `${slabId} markers also enabled on ${otherId}`,
        ).toBe(false);
      }
    }

    // Every marker appears in exactly one buffer, and the totals agree.
    const markerBodies = frame.filter((entry) => entry.drawnAsMarker);
    const drawn = RENDER_ORDER.reduce(
      (total, slabId) => total + visuals.markersFor(slabId).geometry.drawRange.count,
      0,
    );
    expect(drawn).toBe(markerBodies.length);

    visuals.dispose();
  });

  it('applies oblateness on the body polar axis', () => {
    // The IAU triaxial radii are already in the data layer and the flattening is
    // visible: 0.098 for Saturn. A sphere would be less faithful for one extra line.
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    // Camera close to Saturn so it is drawn as geometry rather than a marker.
    const saturn = scaled.find((body) => body.bodyId === 'saturn')!;
    const camera = new Vector3(
      saturn.renderPosition.x + saturn.visualRadius * 4,
      saturn.renderPosition.y,
      saturn.renderPosition.z,
    );

    visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: [],
      plan: planDepthSlabs(candidatesFor(scaled, camera)),
      origin: { x: camera.x, y: camera.y, z: camera.z },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    const mesh = visuals.meshFor('saturn')!;
    expect(mesh.visible).toBe(true);
    // Local z is the polar axis, so it must be the short one.
    expect(mesh.scale.z).toBeLessThan(mesh.scale.x);
    expect(mesh.scale.x).toBe(mesh.scale.y);
    // Flattening recovered from the applied scale.
    expect(1 - mesh.scale.z / mesh.scale.x).toBeCloseTo(0.098, 2);

    // Venus is modelled as a sphere by the IAU, so its scale must be uniform.
    const venusScale = visuals.meshFor('venus')!.scale;
    expect(venusScale.x).toBe(venusScale.z);

    visuals.dispose();
  });

  it('writes camera-relative positions, never absolute ones', () => {
    // Absolute coordinates at 1.5e5 render units would quantise to 15.6 km in f32.
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    const earth = scaled.find((body) => body.bodyId === 'earth')!;
    const camera = new Vector3(
      earth.renderPosition.x + 10,
      earth.renderPosition.y,
      earth.renderPosition.z,
    );

    visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: [],
      plan: planDepthSlabs(candidatesFor(scaled, camera)),
      origin: { x: camera.x, y: camera.y, z: camera.z },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    // Earth is 10 units from the camera, so its mesh must be near the render origin
    // rather than at 1.5e5.
    const position = visuals.meshFor('earth')!.position;
    expect(position.length()).toBeLessThan(20);
    expect(position.length()).toBeGreaterThan(5);

    visuals.dispose();
  });

  it('folds irradiance into albedo so illumination survives scale compression', () => {
    // Contract section 23 and the measured 42x Neptune error. The renderer's own
    // falloff would use compressed render distances; per-body irradiance uses physical
    // ones.
    const state = fixedState();
    const scaled = scaleSnapshot(state, visualizedScale());
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    const camera = new Vector3(0, 0, 0);
    visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: computeIllumination(
        state.snapshot().bodies.map((body) => ({
          bodyId: body.bodyId,
          distanceFromSunKm: body.distanceFromSunKm,
        })),
        physicalBrightness(),
      ),
      plan: planDepthSlabs(candidatesFor(scaled, camera)),
      origin: { x: 0, y: 0, z: 0 },
      cameraRenderPosition: camera,
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    // The light itself must not apply distance falloff, or the compression would be
    // double-counted.
    expect(visuals.light.decay).toBe(0);
    expect(visuals.light.distance).toBe(0);

    visuals.dispose();
  });

  it('hides a body the depth planner did not classify', () => {
    // An unclassified body left on a stale layer would be drawn with the wrong frustum.
    const state = fixedState();
    const scaled = scaleSnapshot(state);
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

    // A plan containing only Earth, so every other body is unassigned.
    const earth = scaled.find((body) => body.bodyId === 'earth')!;
    const partialPlan = planDepthSlabs([
      { id: 'earth', cameraDistance: 100, radius: earth.visualRadius },
    ]);

    const frame = visuals.update({
      snapshot: state.snapshot(),
      scaled,
      illumination: [],
      plan: partialPlan,
      origin: { x: 0, y: 0, z: 0 },
      cameraRenderPosition: new Vector3(0, 0, 0),
      fovDeg: DEFAULT_FOV_DEG,
      viewportHeightPx: VIEWPORT_HEIGHT_PX,
    });

    expect(frame.map((entry) => entry.bodyId)).toEqual(['earth']);
    expect(visuals.meshFor('jupiter')!.visible).toBe(false);

    visuals.dispose();
  });

  it('names the slab when asked for a marker buffer that does not exist', () => {
    const scene = new Scene();
    const visuals = new BodyVisuals(scene, ['earth']);
    // @ts-expect-error deliberately passing an invalid slab id
    expect(() => visuals.markersFor('OUTER')).toThrow(/no marker buffer/);
    visuals.dispose();
  });
});

describe('ORBIT PRECISION: the f64 origin subtraction', () => {
  /**
   * THE MEASUREMENT THAT VALIDATES THE FIX.
   *
   * Before: vertices held absolute render coordinates and the GPU's f32 model matrix
   * subtracted the origin, so two large nearly-equal values cancelled and up to
   * 3.125e-2 render units of error survived. In focus-on-planet view, where the
   * nearest vertex of a body's own orbit is about 2.74 units away, that is 14.9 pixels.
   *
   * After: the subtraction happens in f64 and only the small difference is narrowed to
   * f32, so the error is bounded by the f32 spacing at the SMALL magnitude.
   *
   * Both figures are computed here from the real buffers rather than asserted.
   */
  function buildOrbits(): { readonly scene: Scene; readonly orbits: OrbitPaths } {
    const scene = new Scene();
    return { scene, orbits: new OrbitPaths(scene, createPlanetsProvider()) };
  }

  /** Reads a segment endpoint out of a Line2 interleaved buffer. */
  function readEndpoint(
    orbits: OrbitPaths,
    bodyId: string,
    segmentIndex: number,
  ): Vector3 {
    const line = orbits.lineFor(bodyId)!;
    const attribute = line.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
    const array = attribute.data.array as Float32Array;
    const base = segmentIndex * 6;
    return new Vector3(array[base]!, array[base + 1]!, array[base + 2]!);
  }

  /**
   * Recomputes one orbit vertex INDEPENDENTLY, in f64, camera-relative.
   *
   * This is what makes the assertion below non-vacuous. Reading the f32 buffer and
   * then rounding it to f32 again would measure nothing, because the value is already
   * f32: the difference would be identically zero and the test would pass however
   * wrong the module was.
   *
   * Comparing against a separately derived f64 value catches the real failure mode. If
   * the module reverted to writing absolute coordinates, the buffer would hold about
   * 1.5e5 units for Earth's orbit while this function returns about 2.7, and the
   * discrepancy would be five orders of magnitude rather than a rounding error.
   *
   * The arithmetic deliberately mirrors OrbitPaths.toRenderSpace operation for
   * operation, so any residual difference is f64 rounding at the 1e-11 level rather
   * than a different formula.
   */
  function expectedRelativeVertex(
    bodyId: string,
    sampleIndex: number,
    jd: ReturnType<typeof ttFromUtc>,
    config: ReturnType<typeof scientificScale>,
    origin: { readonly x: number; readonly y: number; readonly z: number },
  ): Vector3 {
    const elements = createPlanetsProvider().elementsAt(bodyId, jd);

    const eccentricAnomaly = (sampleIndex / (ORBIT_SAMPLE_COUNT - 1)) * 2 * Math.PI;
    const planar = orbitalPlanePosition(elements.a * AU_KM, elements.e, eccentricAnomaly);
    const eclipticKm = orbitalPlaneToReferencePlane(
      planar,
      elements.argPeri * DEG_TO_RAD,
      elements.I * DEG_TO_RAD,
      elements.longNode * DEG_TO_RAD,
    );

    const magnitudeKm = Math.hypot(eclipticKm.x, eclipticKm.y, eclipticKm.z);
    const factor = compressDistanceKm(magnitudeKm, config) / magnitudeKm / config.renderUnitKm;

    // Subtraction in f64, exactly as the module performs it.
    return new Vector3(
      eclipticKm.x * factor - origin.x,
      eclipticKm.y * factor - origin.y,
      eclipticKm.z * factor - origin.z,
    );
  }

  it('keeps the orbit line sub-pixel stable in focus-on-planet view', () => {
    const { scene, orbits } = buildOrbits();
    const jd = ttFromUtc(utc(2026, 8, 15));
    const config = scientificScale();
    const cameras = new LayeredCameras();

    // Camera just outside Earth, which is the case that produced 14.9 px before the fix.
    const state = fixedState();
    const earth = scaleSnapshot(state, config).find((body) => body.bodyId === 'earth')!;
    const standoff = earth.visualRadius + 1000 / RENDER_UNIT_KM;
    const origin = {
      x: earth.renderPosition.x + standoff,
      y: earth.renderPosition.y,
      z: earth.renderPosition.z,
    };

    orbits.update(jd, config, origin, cameras.sharedState);

    let worstErrorUnits = 0;
    let worstSegment = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let worstRelativeError = 0;

    for (let segment = 0; segment < ORBIT_SAMPLE_COUNT - 1; segment++) {
      const uploaded = readEndpoint(orbits, 'earth', segment);
      const expected = expectedRelativeVertex('earth', segment, jd, config, origin);

      const distance = expected.length();
      if (distance === 0) continue;
      nearestDistance = Math.min(nearestDistance, distance);

      const errorUnits = uploaded.distanceTo(expected);
      if (errorUnits > worstErrorUnits) {
        worstErrorUnits = errorUnits;
        worstSegment = segment;
      }

      // Relative to the vertex magnitude, which is the quantity f32 actually bounds.
      worstRelativeError = Math.max(worstRelativeError, errorUnits / Math.max(distance, 1));
    }

    /**
     * SANITY BOUND ON THE FIXTURE, derived rather than guessed.
     *
     * An earlier version of this test asserted a vertex within 50 units of the camera,
     * on the reasoning that Earth sits on its own orbit. That is impossible at this
     * sampling density and the assertion failed at 1558 units. Earth's orbit is about
     * 1.496e5 units in radius, so its circumference is roughly 9.4e5 units and 255
     * segments put the vertices about 3686 units apart. The camera sits near Earth's
     * BODY, and the sampled vertices do not land at Earth's current orbital position,
     * so the nearest is up to half a spacing away.
     *
     * The bound below is therefore computed from the geometry instead of asserted.
     */
    const orbitRadiusUnits = (AU_KM / RENDER_UNIT_KM) * 1.0;
    const vertexSpacingUnits = (2 * Math.PI * orbitRadiusUnits) / (ORBIT_SAMPLE_COUNT - 1);
    expect(nearestDistance).toBeLessThan(vertexSpacingUnits);

    /**
     * THE ASSERTION THAT ACTUALLY VALIDATES THE FIX.
     *
     * The uploaded f32 value must equal the independently recomputed f64
     * camera-relative value to within f32 rounding AT THE SMALL MAGNITUDE. Earth's
     * orbit vertices reach about 3e5 units in extent, and f32 resolves roughly 1.2e-7
     * relative, so 1e-6 relative is a little headroom over that floor.
     *
     * This is the assertion that would fail loudly if the module reverted to writing
     * absolute coordinates: the discrepancy would then be the whole origin offset, about
     * 1.5e5 units, which the next test measures.
     */
    expect(
      worstRelativeError,
      `worst relative vertex error ${worstRelativeError.toExponential(3)} at segment ${worstSegment}, ` +
        `absolute ${worstErrorUnits.toExponential(3)} units`,
    ).toBeLessThan(1e-6);

    orbits.dispose();
    scene.clear();
  });

  it('would fail loudly if the module reverted to absolute vertices', () => {
    // Proves the assertion above has teeth. An absolute vertex differs from the
    // camera-relative one by the whole origin offset, about 1.5e5 render units, so the
    // comparison cannot miss it.
    const jd = ttFromUtc(utc(2026, 8, 15));
    const config = scientificScale();
    const state = fixedState();
    const earth = scaleSnapshot(state, config).find((body) => body.bodyId === 'earth')!;
    const origin = {
      x: earth.renderPosition.x + 2.7374,
      y: earth.renderPosition.y,
      z: earth.renderPosition.z,
    };

    const relative = expectedRelativeVertex('earth', 0, jd, config, origin);
    const absolute = expectedRelativeVertex('earth', 0, jd, config, { x: 0, y: 0, z: 0 });

    expect(absolute.distanceTo(relative)).toBeGreaterThan(1e5);
  });

  it('measures the error the absolute approach would have produced', () => {
    /**
     * The counterfactual, computed rather than described. This is what the rejected
     * design does: hold the vertex absolute, hold the translation absolute, and let
     * f32 arithmetic cancel them.
     */
    const state = fixedState();
    const earth = scaleSnapshot(state).find((body) => body.bodyId === 'earth')!;

    const vertexAbsolute = earth.renderPosition.x;
    const cameraAbsolute = vertexAbsolute + 2.7374;

    // f32 cancellation, exactly as the GPU would perform it.
    const viaAbsolute = Math.fround(Math.fround(vertexAbsolute) - Math.fround(cameraAbsolute));
    const exact = vertexAbsolute - cameraAbsolute;
    const errorUnits = Math.abs(viaAbsolute - exact);

    const pixels = errorToPixels(errorUnits, 2.7374, DEFAULT_FOV_DEG, VIEWPORT_HEIGHT_PX);

    /**
     * MEASURED AT 1.441 px, AND AN EARLIER ASSERTION OF 5 px WAS WRONG.
     *
     * The 5 px threshold came from an estimate of 14.9 px, which was itself computed by
     * summing the two worst-case f32 spacings, 1.563e-2 each, to get 3.125e-2 units and
     * dividing by the closest approach of 2.7374 units. That is a valid upper bound but
     * not the actual behaviour: the vertex carrying the worst quantisation error is not
     * the vertex nearest the camera, so the two worst cases never coincide. Sampling
     * Earth's orbit at 256 points and performing the cancellation exactly as the GPU
     * would gives a worst case of 2.275e-2 units and 1.441 px.
     *
     * The bound below is asserted from the measurement. Above one pixel, so the defect
     * is genuinely visible and worth fixing, and below five, so the earlier claim is not
     * quietly preserved.
     */
    expect(pixels, `absolute-vertex error measured at ${pixels.toFixed(3)} px`).toBeGreaterThan(1);
    expect(pixels).toBeLessThan(5);

    // And the f64 route on the same numbers is five orders of magnitude better.
    const viaRelative = Math.fround(exact);
    const relativePixels = errorToPixels(
      Math.max(Math.abs(viaRelative - exact), Number.MIN_VALUE),
      2.7374,
      DEFAULT_FOV_DEG,
      VIEWPORT_HEIGHT_PX,
    );
    expect(relativePixels).toBeLessThan(0.01);
    expect(pixels / Math.max(relativePixels, 1e-12)).toBeGreaterThan(1e3);
  });

  it('leaves the line transform at identity, since vertices are already relative', () => {
    const { scene, orbits } = buildOrbits();
    orbits.update(
      ttFromUtc(utc(2026, 8, 15)),
      scientificScale(),
      { x: 1e5, y: -2e5, z: 3e4 },
      new LayeredCameras().sharedState,
    );

    const line = orbits.lineFor('earth')!;
    expect(line.position.length()).toBe(0);

    orbits.dispose();
    scene.clear();
  });

  it('shifts every vertex when the origin moves', () => {
    // dispose() already removes every object it added, so the scene handle is not
    // needed here.
    const { orbits } = buildOrbits();
    const jd = ttFromUtc(utc(2026, 8, 15));
    const config = scientificScale();
    const shared = new LayeredCameras().sharedState;

    orbits.update(jd, config, { x: 0, y: 0, z: 0 }, shared);
    const atOrigin = readEndpoint(orbits, 'mars', 10);

    const shift = 1234.5;
    orbits.update(jd, config, { x: shift, y: 0, z: 0 }, shared);
    const shifted = readEndpoint(orbits, 'mars', 10);

    // Mars's orbit is about 2.3e5 units across, so an f32 vertex there resolves to
    // about 0.03 units; the tolerance reflects that rather than being arbitrary.
    expect(atOrigin.x - shifted.x).toBeCloseTo(shift, 0);
    expect(shifted.y).toBeCloseTo(atOrigin.y, 0);
  });
});

describe('orbit geometry', () => {
  it('closes the ellipse exactly', () => {
    // The last sample repeats the first, so there is no seam.
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());
    orbits.update(
      ttFromUtc(utc(2026, 8, 15)),
      scientificScale(),
      { x: 0, y: 0, z: 0 },
      new LayeredCameras().sharedState,
    );

    const line = orbits.lineFor('earth')!;
    const attribute = line.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
    const array = attribute.data.array as Float32Array;

    const first = new Vector3(array[0]!, array[1]!, array[2]!);
    // End of the final segment, which is the closing point.
    const lastBase = (ORBIT_SAMPLE_COUNT - 2) * 6 + 3;
    const last = new Vector3(array[lastBase]!, array[lastBase + 1]!, array[lastBase + 2]!);

    expect(first.distanceTo(last) / Math.max(first.length(), 1)).toBeLessThan(1e-6);

    orbits.dispose();
  });

  it('places every vertex between periapsis and apoapsis', () => {
    const scene = new Scene();
    const provider = createPlanetsProvider();
    const orbits = new OrbitPaths(scene, provider);
    const jd = ttFromUtc(utc(2026, 8, 15));
    const config = scientificScale();

    orbits.update(jd, config, { x: 0, y: 0, z: 0 }, new LayeredCameras().sharedState);

    for (const bodyId of PLANET_IDS) {
      const elements = provider.elementsAt(bodyId, jd);
      const periapsisAu = elements.a * (1 - elements.e);
      const apoapsisAu = elements.a * (1 + elements.e);

      const line = orbits.lineFor(bodyId)!;
      const attribute = line.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
      const array = attribute.data.array as Float32Array;

      for (let segment = 0; segment < ORBIT_SAMPLE_COUNT - 1; segment++) {
        const base = segment * 6;
        const radiusAu =
          (Math.hypot(array[base]!, array[base + 1]!, array[base + 2]!) * RENDER_UNIT_KM) / AU_KM;

        expect(radiusAu, `${bodyId} segment ${segment}`).toBeGreaterThan(periapsisAu * 0.99);
        expect(radiusAu, `${bodyId} segment ${segment}`).toBeLessThan(apoapsisAu * 1.01);
      }
    }

    orbits.dispose();
  });

  it('draws the apsis ticks as two disjoint marks, not a chain', () => {
    /**
     * WHY LineSegments2 RATHER THAN Line2 FOR THE TICKS.
     *
     * LineGeometry treats its points as a connected chain, so four tick endpoints
     * would draw a third segment joining the periapsis tick to the apoapsis tick,
     * striping a bright line across the orbit's interior. LineSegmentsGeometry treats
     * them as independent pairs.
     */
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());
    orbits.update(
      ttFromUtc(utc(2026, 8, 15)),
      scientificScale(),
      { x: 0, y: 0, z: 0 },
      new LayeredCameras().sharedState,
    );

    const apsisLine = orbits.apsisLineFor('mars')!;
    const attribute = apsisLine.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;

    // Exactly two segments: 2 * 6 floats.
    expect(attribute.data.array.length).toBe(12);

    orbits.dispose();
  });

  it('hides the apsis ticks until the orbit is selected', () => {
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());

    expect(orbits.apsisLineFor('mars')!.visible).toBe(false);

    orbits.setSelected('mars');
    expect(orbits.apsisLineFor('mars')!.visible).toBe(true);
    expect(orbits.apsisLineFor('venus')!.visible).toBe(false);

    orbits.setSelected(null);
    expect(orbits.apsisLineFor('mars')!.visible).toBe(false);

    orbits.dispose();
  });

  it('highlights the selected orbit without turning it into a neon tube', () => {
    // Contract section 25 forbids glowing tubes, so the highlight raises opacity and
    // width modestly rather than transforming the line.
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());

    const line = orbits.lineFor('jupiter')!;
    expect(line.material.opacity).toBe(ORBIT_OPACITY);
    expect(line.material.linewidth).toBe(ORBIT_LINE_WIDTH_PX);

    orbits.setSelected('jupiter');
    expect(line.material.opacity).toBe(SELECTED_ORBIT_OPACITY);
    expect(line.material.linewidth).toBe(SELECTED_ORBIT_LINE_WIDTH_PX);

    // Still subtle: nowhere near opaque, and under twice the base width.
    expect(SELECTED_ORBIT_OPACITY).toBeLessThan(0.7);
    expect(SELECTED_ORBIT_LINE_WIDTH_PX / ORBIT_LINE_WIDTH_PX).toBeLessThan(2);

    orbits.dispose();
  });

  it('propagates the viewport size to every line material', () => {
    // Line2 computes its width in screen space, so it needs the viewport size as a
    // uniform. Without this the pixel width in contract section 25 would be wrong, and
    // it would be wrong silently: the lines would still draw, just at the wrong
    // thickness. The apsis material is checked too, because it is a separate material
    // and an easy one to forget.
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());

    orbits.setResolution(VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX);

    const line = orbits.lineFor('earth')!;
    expect(line.material.resolution.x).toBe(VIEWPORT_WIDTH_PX);
    expect(line.material.resolution.y).toBe(VIEWPORT_HEIGHT_PX);

    const apsisLine = orbits.apsisLineFor('earth')!;
    expect(apsisLine.material.resolution.x).toBe(VIEWPORT_WIDTH_PX);
    expect(apsisLine.material.resolution.y).toBe(VIEWPORT_HEIGHT_PX);

    orbits.dispose();
  });

  it('sits on its own layer and writes no depth', () => {
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());
    const line = orbits.lineFor('earth')!;

    expect(line.layers.isEnabled(ORBIT_LAYER)).toBe(true);
    expect(line.material.depthWrite).toBe(false);
    expect(line.material.depthTest).toBe(false);

    for (const slabId of RENDER_ORDER) {
      expect(line.layers.isEnabled(SLAB_LAYERS[slabId]), `${slabId}`).toBe(false);
    }

    orbits.dispose();
  });

  it('rebuilds when the scale mode changes', () => {
    // The compressed and uncompressed ellipses are very different sizes, so a stale
    // cache would leave the orbit detached from its body.
    const scene = new Scene();
    const orbits = new OrbitPaths(scene, createPlanetsProvider());
    const jd = ttFromUtc(utc(2026, 8, 15));
    const shared = new LayeredCameras().sharedState;
    const origin = { x: 0, y: 0, z: 0 };

    orbits.update(jd, scientificScale(), origin, shared);
    const line = orbits.lineFor('neptune')!;
    const attribute = line.geometry.getAttribute('instanceStart') as InterleavedBufferAttribute;
    const scientificRadius = Math.hypot(
      (attribute.data.array as Float32Array)[0]!,
      (attribute.data.array as Float32Array)[1]!,
      (attribute.data.array as Float32Array)[2]!,
    );

    orbits.update(jd, visualizedScale(), origin, shared);
    const visualizedRadius = Math.hypot(
      (attribute.data.array as Float32Array)[0]!,
      (attribute.data.array as Float32Array)[1]!,
      (attribute.data.array as Float32Array)[2]!,
    );

    // Neptune's orbit compresses from about 30 au-equivalent to about 4.6.
    expect(visualizedRadius).toBeLessThan(scientificRadius / 3);

    orbits.dispose();
  });

  it('rejects a sample count too small to form a line', () => {
    const scene = new Scene();
    expect(() => new OrbitPaths(scene, createPlanetsProvider(), { sampleCount: 1 })).toThrow(
      /at least 2/,
    );
  });

  it('describes itself as a model rather than a recorded track', () => {
    expect(ORBIT_PROVENANCE.source).toBe('S1');
    expect(ORBIT_PROVENANCE.model).toMatch(/osculating/i);
    expect(ORBIT_PROVENANCE.note).toMatch(/not an integrated trajectory/i);
  });
});

describe('layer isolation across all passes', () => {
  it('gives every pass a distinct layer', () => {
    // Overlapping layers would draw an object in the wrong pass with the wrong frustum
    // and the wrong depth state.
    const used = [
      SLAB_LAYERS.NEAR,
      SLAB_LAYERS.MIDDLE,
      SLAB_LAYERS.FAR,
      STARFIELD_LAYER,
      ORBIT_LAYER,
    ];
    expect(new Set(used).size).toBe(used.length);
    // Layer 0 is reserved as the unassigned default.
    expect(used).not.toContain(0);
  });
});

describe('randomised threshold behaviour', () => {
  it('always chooses geometry or marker consistently with the pixel threshold', () => {
    forEachSample(DEFAULT_SEED ^ 0x4d4b, 200, (sampler, context) => {
      const state = fixedState();
      const scaled = scaleSnapshot(state, sampler.next() < 0.5 ? scientificScale() : visualizedScale());
      const scene = new Scene();
      const visuals = new BodyVisuals(scene, scaled.map((body) => body.bodyId));

      const target = sampler.pick(scaled);
      const standoff = target.visualRadius * sampler.logRange(1.5, 1e5);
      const camera = new Vector3(
        target.renderPosition.x + standoff,
        target.renderPosition.y,
        target.renderPosition.z,
      );

      const frame = visuals.update({
        snapshot: state.snapshot(),
        scaled,
        illumination: [],
        plan: planDepthSlabs(candidatesFor(scaled, camera)),
        origin: { x: camera.x, y: camera.y, z: camera.z },
        cameraRenderPosition: camera,
        fovDeg: DEFAULT_FOV_DEG,
        viewportHeightPx: VIEWPORT_HEIGHT_PX,
      });

      for (const entry of frame) {
        const expectedMarker = entry.apparentRadiusPx * 2 < MARKER_DIAMETER_THRESHOLD_PX;
        expect(
          entry.drawnAsMarker,
          formatPropertyFailure(
            { ...context, bodyId: entry.bodyId, apparentRadiusPx: entry.apparentRadiusPx },
            expectedMarker,
            entry.drawnAsMarker,
          ),
        ).toBe(expectedMarker);

        const mesh = visuals.meshFor(entry.bodyId)!;
        // Exactly one representation, never both and never neither.
        expect(mesh.visible).toBe(!entry.drawnAsMarker);
      }

      visuals.dispose();
    });
  });
});

/** Depth candidates for a scaled system viewed from a camera position. */
function candidatesFor(
  scaled: readonly ScaledBody[],
  camera: Vector3,
): readonly DepthCandidate[] {
  return scaled.map((body) => ({
    id: body.bodyId,
    cameraDistance: Math.hypot(
      body.renderPosition.x - camera.x,
      body.renderPosition.y - camera.y,
      body.renderPosition.z - camera.z,
    ),
    radius: body.visualRadius,
  }));
}

/**
 * A quaternion rotating about +Y.
 *
 * Constructed from components rather than via setFromAxisAngle so the expected values
 * are visible at a glance: a rotation of theta about a unit axis is
 * (axis * sin(theta/2), cos(theta/2)).
 */
function quaternionAboutY(angle: number): Quaternion {
  const half = angle / 2;
  return new Quaternion(0, Math.sin(half), 0, Math.cos(half));
}
