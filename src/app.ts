/**
 * Application orchestration.
 *
 * THE ONE-WAY PIPELINE, in the order contract section 39 requires. Every arrow is a
 * pure read of the stage above it, and no stage writes back:
 *
 *   SimulationState        physical km, km/s, f64
 *     -> scaleSystem       render units, still f64, absolute
 *     -> CameraRig         camera position, derived FROM the scaled system
 *     -> FloatingOrigin    camera-relative, still f64
 *     -> planDepthSlabs    frustum planes per slab
 *     -> render objects    f32 uploads, camera-relative only
 *
 * THE ORDER IS LOAD-BEARING and not merely conventional:
 *
 *   1. The simulation advances first, so every later stage sees one consistent instant.
 *   2. Scaling happens before the camera, because follow mode needs to know where the
 *      tracked body IS in render space this frame.
 *   3. The origin is set from the camera, not the reverse. The camera is the authority
 *      on position; the origin is a derived quantity that exists to keep f32 coordinates
 *      small.
 *   4. Depth classification happens after the camera, because it depends on
 *      camera-relative distance.
 *   5. Uploads happen last, once, from values already made small.
 *
 * WHY THIS IS A CLASS RATHER THAN A SCRIPT. The browser depth-stress test in
 * test/gl must exercise THIS pipeline, not a reimplementation of it. A gate that
 * validated a parallel copy of the frame loop would prove nothing about what ships. So
 * the canvas is injected, and a single frame can be stepped deterministically.
 */

// Color is deliberately NOT imported. The background is set on the renderer via
// setClearColor, which accepts a hex number; constructing a Color for scene.background
// is what triggers the forceClear bug documented on BACKGROUND_COLOUR.
import { Scene, Vector3, WebGLRenderer } from 'three';
import { SimulationClock } from './core/clock';
import { utc, type JulianDate } from './core/jd';
import { BODY_ORDER, PLANET_IDS } from './data/bodies';
import { createPlanetsProvider, type JplApproximatePlanetsProvider } from './ephemeris/planets';
import {
  computeIllumination,
  perceptualBrightness,
  physicalBrightness,
  type BodyIllumination,
  type BrightnessConfig,
} from './sim/irradiance';
import {
  getScaleDescription,
  scaleSystem,
  scientificScale,
  visualizedScale,
  validateVisualBodySeparation,
  type ScaleConfig,
  type ScaledBody,
} from './sim/scale';
import { SimulationState, type SimulationSnapshot } from './sim/state';
import { BodyVisuals, type BodyVisualState } from './render/body-visuals';
import { CameraRig } from './render/camera-rig';
import {
  planDepthSlabs,
  verifyDepthPlan,
  type DepthCandidate,
  type DepthPlan,
  type SlabId,
} from './render/depth-slabs';
import { FloatingOrigin } from './render/floating-origin';
import {
  apparentRadiusPixels,
  LayeredCameras,
  ndcToPixels,
  projectToNdc,
} from './render/layered-cameras';
import { OrbitPaths } from './render/orbit-paths';
import { Starfield } from './render/starfield';
import { buildCandidates, pickBody, type SelectionResult } from './render/selection';

export interface ProjectedBody {
  readonly bodyId: string;
  readonly displayName: string;
  readonly screenX: number;
  readonly screenY: number;
  readonly inFront: boolean;
  readonly apparentRadiusPx: number;
  readonly visualRadius: number;
  readonly cameraDistance: number;
  readonly colorHex: string;
}

/**
 * Background colour.
 *
 * Near-black with a very slight blue-grey lift, as the brief asks. Pure black makes the
 * viewport read as a dead region rather than as space, and hides the star field's
 * faintest members entirely.
 *
 * SET ON THE RENDERER, NEVER ON THE SCENE, and this is not a stylistic preference. It
 * is the difference between a working multi-pass composite and a blank screen.
 *
 * three.js calls WebGLBackground.render(scene) at the start of EVERY renderer.render()
 * call, and that function reads:
 *
 *   } else if ( background && background.isColor ) {
 *     setClear( background, 1 );
 *     forceClear = true;
 *   }
 *   ...
 *   if ( renderer.autoClear || forceClear ) {
 *     renderer.clear( ... );
 *   }
 *
 * So assigning scene.background a Color sets forceClear, and forceClear BYPASSES
 * autoClear. This frame issues five render calls: star field, orbits, and up to three
 * slabs. With a scene background every one of them would clear colour and depth, so only
 * the last slab would survive and the star field, the orbits and the outer planets would
 * all vanish.
 *
 * The LayeredCameras guard on renderer.autoClear would NOT catch this, because
 * forceClear is a separate path that ignores the flag entirely.
 *
 * Leaving scene.background null takes the other branch, which calls
 * setClear(clearColor, clearAlpha) and does not force anything. The colour therefore
 * still reaches the GL clear state, and the single explicit clear in draw() uses it.
 */
const BACKGROUND_COLOUR = 0x02030a;

/**
 * Initial camera distance, render units.
 *
 * Neptune's compressed orbit reaches about 6.9e5 units in visualized scale, so this
 * frames the whole system with margin on first load.
 */
const INITIAL_DISTANCE_UNITS = 1.6e6;

/** Selection priority. Larger bodies win an otherwise exact tie. */
const SELECTION_PRIORITY: Readonly<Record<string, number>> = {
  sun: 10,
  jupiter: 9,
  saturn: 8,
  uranus: 7,
  neptune: 6,
  earth: 5,
  venus: 4,
  mars: 3,
  mercury: 2,
  moon: 1,
};

export interface AppOptions {
  readonly canvas: HTMLCanvasElement;
  /** Starting instant. Defaults to 2026-08-15 UTC. */
  readonly epoch?: JulianDate<'UTC'>;
  readonly scaleMode?: 'SCIENTIFIC' | 'VISUALIZED';
  /** Contract section 28. Injected so the render layer never reads matchMedia itself. */
  readonly reducedMotion?: boolean;
  /**
   * Device pixel ratio for the drawing buffer.
   *
   * Capped by the caller rather than read here, so a 3x display does not silently cost
   * nine times the fragment work.
   */
  readonly pixelRatio?: number;
}

/** Draw calls and triangles a single pass submitted. */
export interface PassStats {
  readonly calls: number;
  readonly triangles: number;
}

/**
 * Per-pass draw statistics for one frame.
 *
 * EXISTS BECAUSE AN AGGREGATE COUNT HID A TOTAL FAILURE. The slab cameras were once left
 * on the default layer, so all three slab passes submitted nothing and every planet was
 * invisible. The browser gate still passed, because its draw-call assertion summed calls
 * across every pass and compared the total against a floor: the star field and the eight
 * orbit lines cleared that floor on their own, so three empty passes went unnoticed.
 *
 * Recording each pass separately makes "this pass drew nothing" directly assertable, which
 * is the only form of the check that could have caught it.
 */
export interface FramePassStats {
  readonly starfield: PassStats;
  readonly orbits: PassStats;
  /** One entry per NON-EMPTY slab, keyed by slab id, in render order. */
  readonly slabs: ReadonlyMap<SlabId, PassStats>;
}

/** Everything one frame produced, for the interface and for tests. */
export interface FrameReport {
  readonly snapshot: SimulationSnapshot;
  readonly scaled: readonly ScaledBody[];
  readonly illumination: readonly BodyIllumination[];
  readonly plan: DepthPlan;
  readonly bodies: readonly BodyVisualState[];
  readonly cameraRenderPosition: Vector3;
  readonly originChanges: number;
  /** Depth clears actually issued. Should equal plan.clearDepthCount. */
  readonly depthClears: number;
  readonly simulatedSecondsApplied: number;
  /** What each pass actually submitted to the GPU. */
  readonly passes: FramePassStats;
}

/**
 * Owns the scene, the pipeline and the frame loop.
 *
 * Construction is side-effect-free apart from allocating GPU resources; nothing renders
 * until renderFrame or start is called.
 */
export class SolarSystemApp {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;

  private readonly state: SimulationState;
  private readonly provider: JplApproximatePlanetsProvider;
  private readonly clock: SimulationClock;

  private readonly rig: CameraRig;
  private readonly cameras: LayeredCameras;
  private readonly origin: FloatingOrigin;

  private readonly starfield: Starfield;
  private readonly orbits: OrbitPaths;
  private readonly visuals: BodyVisuals;

  private scaleConfig: ScaleConfig;
  private brightness: BrightnessConfig;

  private widthPx = 1;
  private heightPx = 1;

  private selectedBodyId: string | null = null;
  private animationHandle: number | null = null;
  private lastFrameMs: number | null = null;
  private lastReport: FrameReport | null = null;

  constructor(options: AppOptions) {
    this.scaleConfig =
      options.scaleMode === 'SCIENTIFIC' ? scientificScale() : visualizedScale();
    // Perceptual by default: the physical Mercury-to-Neptune irradiance range is 6034:1,
    // so a physically exposed outer system renders as black. Disclosed by
    // getBrightnessDescription.
    this.brightness = perceptualBrightness();

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      // Contract section 4.3. Not the primary depth solution, but it protects the far end
      // of each slab; measured 5.2x better than linear at Neptune.
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    // MUST be false. Each slab issues its own render call, and autoClear would wipe the
    // colour buffer before each one, leaving only the last slab visible. LayeredCameras
    // asserts this rather than setting it, so the requirement is visible here.
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(options.pixelRatio ?? 1);

    // On the RENDERER, so the colour reaches the GL clear state without three.js
    // forcing a clear on every render call. See BACKGROUND_COLOUR for the mechanism.
    this.renderer.setClearColor(BACKGROUND_COLOUR, 1);

    this.scene = new Scene();
    // scene.background is deliberately left null. Assigning a Color here would set
    // forceClear inside WebGLBackground and wipe every pass but the last.

    this.clock = new SimulationClock({
      epoch: options.epoch ?? utc(2026, 8, 15),
      paused: true,
    });
    this.state = new SimulationState({ clock: this.clock });
    this.provider = createPlanetsProvider();

    this.rig = new CameraRig({
      distance: INITIAL_DISTANCE_UNITS,
      reducedMotion: options.reducedMotion ?? false,
    });
    this.cameras = new LayeredCameras();
    this.origin = new FloatingOrigin();

    // One scene, three passes. Layer masks isolate them, so no object is drawn by a pass
    // it does not belong to; separate scenes would invalidate three.js's render lists.
    this.starfield = new Starfield(this.scene);
    this.orbits = new OrbitPaths(this.scene, this.provider);
    this.visuals = new BodyVisuals(this.scene, BODY_ORDER);
  }

  // ------------------------------------------------------------------ queries

  get simulationClock(): SimulationClock {
    return this.clock;
  }

  get cameraRig(): CameraRig {
    return this.rig;
  }

  get selected(): string | null {
    return this.selectedBodyId;
  }

  /** The most recent frame's report, or null before the first frame. */
  get report(): FrameReport | null {
    return this.lastReport;
  }

  /** Disclosure text for the active scale transform. Contract sections 1.5 and 9. */
  scaleDisclosure(): readonly string[] {
    return getScaleDescription(this.scaleConfig).lines;
  }

  // ----------------------------------------------------------------- commands

  /** Resizes the drawing buffer and every pass that needs pixel dimensions. */
  resize(widthPx: number, heightPx: number): void {
    if (widthPx <= 0 || heightPx <= 0) return;

    this.widthPx = widthPx;
    this.heightPx = heightPx;

    this.renderer.setSize(widthPx, heightPx, false);
    this.rig.setAspect(widthPx / heightPx);
    // Line2 computes its width in screen space, so it needs the viewport in pixels or
    // the orbit lines are drawn at the wrong thickness.
    this.orbits.setResolution(widthPx, heightPx);
  }

  setScaleMode(mode: 'SCIENTIFIC' | 'VISUALIZED'): void {
    this.scaleConfig = mode === 'SCIENTIFIC' ? scientificScale() : visualizedScale();
  }

  setBrightnessMode(mode: 'PHYSICAL' | 'PERCEPTUAL'): void {
    this.brightness = mode === 'PHYSICAL' ? physicalBrightness() : perceptualBrightness();
  }

  setReducedMotion(reduced: boolean): void {
    this.rig.setReducedMotion(reduced);
  }

  /** Selects a body and highlights its orbit, without moving the camera. */
  select(bodyId: string | null): void {
    this.selectedBodyId = bodyId;
    this.orbits.setSelected(bodyId);
  }

  /** Selects a body and flies to it. Contract section 6: double-click focuses. */
  focus(bodyId: string): void {
    this.select(bodyId);

    const body = this.lastReport?.scaled.find((entry) => entry.bodyId === bodyId);
    if (body === undefined) return;

    this.rig.focusOn(
      bodyId,
      new Vector3(body.renderPosition.x, body.renderPosition.y, body.renderPosition.z),
      body.visualRadius,
    );
  }

  /** Frames the whole system. */
  overview(): void {
    this.select(null);
    this.rig.overview(INITIAL_DISTANCE_UNITS);
  }

  /**
   * Picks the body under a screen position, in CSS pixels.
   *
   * Uses the previous frame's geometry, which is what is actually on screen when the
   * pointer event arrives.
   */
  pick(cursorXPx: number, cursorYPx: number, baseRadiusPx?: number): SelectionResult | null {
    if (this.lastReport === null) return null;

    const candidates = buildCandidates(
      this.lastReport.scaled,
      this.origin.origin,
      (bodyId) => SELECTION_PRIORITY[bodyId] ?? 0,
    );

    return pickBody(this.cameras, candidates, cursorXPx, cursorYPx, {
      widthPx: this.widthPx,
      heightPx: this.heightPx,
      ...(baseRadiusPx === undefined ? {} : { baseRadiusPx }),
    });
  }

  /** Returns projected screen coordinates and visibility for all celestial bodies. */
  getProjectedBodies(): readonly ProjectedBody[] {
    if (this.lastReport === null) return [];
    const candidates = buildCandidates(
      this.lastReport.scaled,
      this.origin.origin,
      (bodyId) => SELECTION_PRIORITY[bodyId] ?? 0,
    );
    const result: ProjectedBody[] = [];
    const colors: Record<string, string> = {
      sun: '#ffd166',
      mercury: '#adb5bd',
      venus: '#f4a261',
      earth: '#4ea8de',
      moon: '#e2eafc',
      mars: '#e76f51',
      jupiter: '#e9c46a',
      saturn: '#f4a261',
      uranus: '#48cae4',
      neptune: '#0077b6',
      pluto: '#b8bedd',
    };

    const fovDeg = this.cameras.sharedState.fovDeg;

    for (const c of candidates) {
      const ndc = projectToNdc(this.cameras, c.relativePosition);
      const px = ndcToPixels(ndc.x, ndc.y, this.widthPx, this.heightPx);
      const body = this.lastReport.snapshot.bodies.find((b) => b.bodyId === c.bodyId);
      const displayName = body?.displayName ?? c.bodyId.toUpperCase();
      const cameraDistance = Math.max(c.relativePosition.length(), 1e-6);
      const apparentRadiusPx = apparentRadiusPixels(
        c.visualRadius,
        cameraDistance,
        fovDeg,
        this.heightPx,
      );

      result.push({
        bodyId: c.bodyId,
        displayName,
        screenX: px.x,
        screenY: px.y,
        inFront: ndc.w > 0,
        apparentRadiusPx,
        visualRadius: c.visualRadius,
        cameraDistance,
        colorHex: colors[c.bodyId] ?? '#ffffff',
      });
    }
    return result;
  }

  /** Promise that resolves when all 3D planetary models are loaded */
  get whenModelsLoaded(): Promise<{ loaded: number; total: number }> {
    return this.visuals.whenLoaded;
  }

  /** Callback fired as each 3D planetary model finishes loading */
  set onModelProgress(cb: ((loaded: number, total: number, bodyId: string) => void) | undefined) {
    this.visuals.onProgress = cb;
  }

  // -------------------------------------------------------------------- frame

  /**
   * Advances and renders one frame.
   *
   * @param realDeltaSeconds wall-clock seconds since the previous frame
   */
  renderFrame(realDeltaSeconds: number): FrameReport {
    // 1. SIMULATION. Advances the clock and recomputes every body in physical units, so
    //    everything downstream sees one consistent instant.
    const simulatedSecondsApplied = this.state.update(realDeltaSeconds);
    const snapshot = this.state.snapshot();

    // 2. SCALE. Physical km to render units, hierarchically so satellite orbits keep
    //    their shape. Still absolute and still f64.
    const scaled = scaleSystem(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        positionKm: body.positionKm,
        parentId: body.parentId,
        physicalRadiusKm: body.physicalRadiusKm,
      })),
      this.scaleConfig,
    );

    // 3. CAMERA. Must come after scaling, because follow mode needs this frame's render
    //    position for the tracked body.
    const positions = new Map(scaled.map((body) => [body.bodyId, body]));
    this.rig.update(realDeltaSeconds, (bodyId) => {
      const body = positions.get(bodyId);
      if (body === undefined) return undefined;
      return {
        position: new Vector3(
          body.renderPosition.x,
          body.renderPosition.y,
          body.renderPosition.z,
        ),
        radius: body.visualRadius,
      };
    });

    // 4. FLOATING ORIGIN, derived from the camera rather than the reverse.
    this.origin.update(this.rig.position);
    const origin = this.origin.origin;

    // 5. DEPTH. Camera-relative distances, so this must follow the camera update.
    const candidates: DepthCandidate[] = scaled.map((body) => ({
      id: body.bodyId,
      cameraDistance: Math.hypot(
        body.renderPosition.x - this.rig.position.x,
        body.renderPosition.y - this.rig.position.y,
        body.renderPosition.z - this.rig.position.z,
      ),
      radius: body.visualRadius,
    }));
    const plan = planDepthSlabs(candidates);

    // 6. ILLUMINATION from PHYSICAL distance, so it is unaffected by scale compression.
    //    Using render distance would over-brighten Neptune by a measured factor of 42.
    const illumination = computeIllumination(
      snapshot.bodies.map((body) => ({
        bodyId: body.bodyId,
        distanceFromSunKm: body.distanceFromSunKm,
      })),
      this.brightness,
    );

    // 7. UPLOADS. Every position handed to a three.js object from here on is
    //    camera-relative, computed by subtracting the origin in f64.
    const shared = this.rig.sharedState();
    this.cameras.setShared(shared);
    this.starfield.update(shared);
    this.orbits.update(this.clock.nowTT(), this.scaleConfig, origin, shared);

    const bodies = this.visuals.update({
      snapshot,
      scaled,
      illumination,
      plan,
      origin,
      cameraRenderPosition: this.rig.position,
      fovDeg: shared.fovDeg,
      viewportHeightPx: this.heightPx,
    });

    const { depthClears, passes } = this.draw(plan);

    this.lastReport = {
      snapshot,
      scaled,
      illumination,
      plan,
      bodies,
      cameraRenderPosition: this.rig.position.clone(),
      originChanges: this.origin.originChanges,
      depthClears,
      simulatedSecondsApplied,
      passes,
    };
    return this.lastReport;
  }

  /** Starts the animation loop. */
  start(): void {
    if (this.animationHandle !== null) return;

    const tick = (nowMs: number): void => {
      const deltaSeconds = this.lastFrameMs === null ? 0 : (nowMs - this.lastFrameMs) / 1000;
      this.lastFrameMs = nowMs;

      this.renderFrame(deltaSeconds);
      this.animationHandle = requestAnimationFrame(tick);
    };

    this.animationHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.animationHandle === null) return;
    cancelAnimationFrame(this.animationHandle);
    this.animationHandle = null;
    this.lastFrameMs = null;
  }

  /**
   * Checks that exaggerated radii have not made bodies overlap. Contract section 3.
   *
   * Render-space only, and reads no physical value beyond the radii supplied.
   */
  checkSeparation(): ReturnType<typeof validateVisualBodySeparation> {
    return validateVisualBodySeparation(
      this.state.snapshot().bodies.map((body) => ({
        bodyId: body.bodyId,
        positionKm: body.positionKm,
        parentId: body.parentId,
        physicalRadiusKm: body.physicalRadiusKm,
      })),
      this.scaleConfig,
    );
  }

  /** Verifies the depth plan's partition invariants. Used by the stress gate. */
  verifyPlan(): ReturnType<typeof verifyDepthPlan> | null {
    if (this.lastReport === null) return null;

    const candidates: DepthCandidate[] = this.lastReport.scaled.map((body) => ({
      id: body.bodyId,
      cameraDistance: Math.hypot(
        body.renderPosition.x - this.lastReport!.cameraRenderPosition.x,
        body.renderPosition.y - this.lastReport!.cameraRenderPosition.y,
        body.renderPosition.z - this.lastReport!.cameraRenderPosition.z,
      ),
      radius: body.visualRadius,
    }));

    return verifyDepthPlan(candidates, this.lastReport.plan);
  }

  /** The renderer, for pixel readback in the browser gate. */
  get glRenderer(): WebGLRenderer {
    return this.renderer;
  }

  /** The slab cameras, for projection in tests. */
  get slabCameras(): LayeredCameras {
    return this.cameras;
  }

  dispose(): void {
    this.stop();
    this.starfield.dispose();
    this.orbits.dispose();
    this.visuals.dispose();
    this.renderer.dispose();
  }

  /**
   * Issues the frame's draw calls in the order contract section 4.2 requires.
   *
   *   clear colour and depth ONCE
   *   star field      no depth interaction, so it can never occlude anything
   *   orbit paths     reference underlay, also no depth interaction
   *   slabs far->near depth cleared between them, colour never cleared again
   *
   * @returns depth clears issued, so a test can compare against plan.clearDepthCount
   */
  private draw(plan: DepthPlan): {
    readonly depthClears: number;
    readonly passes: FramePassStats;
  } {
    const info = this.renderer.info;

    /**
     * Per-pass measurement needs manual control of the counters.
     *
     * With autoReset enabled three.js zeroes info.render at the start of every render
     * call, so reading it after the frame would report only the LAST pass. The previous
     * value is restored afterwards rather than assumed, so this does not quietly change
     * renderer behaviour for anything else.
     */
    const previousAutoReset = info.autoReset;
    info.autoReset = false;

    const measure = (pass: () => void): PassStats => {
      info.reset();
      pass();
      return { calls: info.render.calls, triangles: info.render.triangles };
    };

    this.renderer.clear(true, true, true);

    const starfield = measure(() => this.starfield.render(this.renderer));
    const orbits = measure(() => this.orbits.render(this.renderer));

    const slabs = new Map<SlabId, PassStats>();

    // Ordering and the depth clears stay inside LayeredCameras, which owns the
    // compositing contract and asserts autoClear is disabled. Measuring inside the
    // callback keeps that guard rather than reimplementing the loop here.
    // clearFirst is false because the single clear above already happened; a second full
    // clear would discard the star field and the orbits.
    const depthClears = this.cameras.renderFrame(
      this.renderer,
      plan,
      (slab) => {
        // Each slab camera is pinned to its own layer, so one scene serves every pass.
        slabs.set(
          slab.id,
          measure(() => this.renderer.render(this.scene, slab.camera)),
        );
      },
      { clearFirst: false },
    );

    info.autoReset = previousAutoReset;

    return { depthClears, passes: { starfield, orbits, slabs } };
  }
}

/** Body ids the simulation places, for interface enumeration. */
export const SIMULATED_BODIES: readonly string[] = BODY_ORDER;

/** Planet ids, for a selection list. */
export const SELECTABLE_PLANETS: readonly string[] = PLANET_IDS;
