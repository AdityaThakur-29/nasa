/**
 * Entry point and input wiring.
 *
 * WHAT THIS LAYER OWNS. The DOM: canvas lookup, resize observation, pointer and keyboard
 * events, the media query for reduced motion, and the provenance strip. It translates
 * browser events into app commands and nothing else.
 *
 * WHY THE DOM LIVES ONLY HERE. The render layer must not read matchMedia, measure
 * elements, or attach listeners, because none of that is testable in node and all of it
 * would make the render modules depend on a browser. CameraRig takes `reducedMotion` as a
 * constructor option for exactly this reason: the query is evaluated here and injected.
 *
 * EVERY THRESHOLD IN THIS FILE IS IN CSS PIXELS. Pointer events report CSS pixels, and a
 * gesture threshold should be a consistent physical size rather than shrinking on a
 * high-density display. The device pixel ratio appears in precisely one place, sizing the
 * drawing buffer, and nowhere else.
 */

import { SolarSystemApp } from './app';

/**
 * Cap on the drawing-buffer pixel ratio.
 *
 * Fragment cost scales with the SQUARE of this, so an uncapped 3x display costs nine
 * times the shading of a 1x one. Two is the point of diminishing returns for a scene
 * whose finest detail is a 1.2 pixel orbit line.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * Movement beyond which a pointer interaction is a drag rather than a click, CSS pixels.
 *
 * Without a threshold every drag would end in a selection, because a drag is a pointerdown
 * followed by a pointerup. Touch needs a larger value than mouse: a fingertip rolls by
 * several pixels during what the user intends as a stationary tap.
 */
const MOUSE_DRAG_THRESHOLD_PX = 4;
const TOUCH_DRAG_THRESHOLD_PX = 12;

/**
 * Orbit sensitivity: radians of azimuth per viewport width dragged.
 *
 * Expressed per VIEWPORT rather than per pixel so the gesture feels identical in a small
 * window and a large one. Half a turn across the full width is controllable; a full turn
 * is too fast to aim.
 */
const AZIMUTH_PER_VIEWPORT = Math.PI;

/** Radians of elevation per viewport height dragged. */
const ELEVATION_PER_VIEWPORT = Math.PI * 0.75;

/**
 * Dolly rate, in inverse CSS pixels of wheel travel.
 *
 * Applied as exp(pixels * rate), which makes zoom MULTIPLICATIVE and exactly reversible:
 * scrolling down by n pixels and back up by n returns to the starting distance, because
 * exp(nk) * exp(-nk) is 1. A linear mapping would neither be reversible nor usable across
 * the seven orders of magnitude the camera spans.
 *
 * One Chrome wheel notch reports about 100 pixels, so this gives roughly 1.105x per notch.
 */
const DOLLY_RATE_PER_PIXEL = 0.001;

/**
 * Approximate line height for wheel events reported in lines, CSS pixels.
 *
 * NECESSARY FOR CROSS-BROWSER PARITY. WheelEvent.deltaMode is 0 for pixels, 1 for lines
 * and 2 for pages. Chrome reports pixels with deltaY near 100 per notch; Firefox has
 * historically reported LINES with deltaY near 3. Using deltaY unnormalised makes zoom
 * about thirty times slower in Firefox, which reads as the feature being broken rather
 * than as a sensitivity difference.
 */
const WHEEL_LINE_HEIGHT_PX = 16;

/** Keyboard step sizes. Deliberately coarse enough to be usable without a pointer. */
const KEYBOARD_ORBIT_STEP = 0.06;
const KEYBOARD_DOLLY_FACTOR = 1.15;

interface PointerRecord {
  readonly pointerId: number;
  readonly pointerType: string;
  /** Position at pointerdown, for the click-versus-drag test. */
  readonly startX: number;
  readonly startY: number;
  currentX: number;
  currentY: number;
  /** Total distance travelled, so a drag that returns to its origin still counts. */
  travelled: number;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`main: required element "${selector}" is missing from the document`);
  }
  return element;
}

/**
 * Reports a fatal failure to the user rather than leaving a black canvas.
 *
 * WebGL context creation genuinely fails on some machines: no GPU, a blocklisted driver,
 * or a browser with hardware acceleration disabled. A blank viewport gives the user
 * nothing to act on.
 */
function reportFatal(message: string, detail?: unknown): void {
  const element = document.querySelector<HTMLElement>('#failure');
  const text =
    detail instanceof Error
      ? `${message}\n\n${detail.message}`
      : detail === undefined
        ? message
        : `${message}\n\n${String(detail)}`;

  if (element === null) {
    // Nothing to render into, so the console is the only channel left.
    console.error(text);
    return;
  }

  element.textContent = text;
  element.style.display = 'grid';
}

function main(): void {
  const canvas = requireElement<HTMLCanvasElement>('#viewport');
  const provenance = requireElement<HTMLElement>('#provenance');

  /**
   * The canvas must be focusable to receive keyboard events.
   *
   * Set here rather than in the markup so the reason sits beside the keyboard handler.
   * Without a tabindex the canvas is not in the tab order and every keyboard control
   * below would be unreachable, which contract section 28 does not allow.
   */
  canvas.tabIndex = 0;

  /**
   * Reduced motion, read ONCE here and injected.
   *
   * Contract section 28. The render layer never touches matchMedia, so the eased-transition
   * path stays testable in node.
   */
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  let app: SolarSystemApp;
  try {
    app = new SolarSystemApp({
      canvas,
      reducedMotion: motionQuery.matches,
      pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    });
  } catch (error) {
    reportFatal(
      'Unable to start the visualization.\n\n' +
        'This view requires WebGL2. It may be disabled in your browser settings, or ' +
        'unavailable on this hardware.',
      error,
    );
    return;
  }

  // The query can change while the page is open, for instance if the user alters an
  // operating-system setting, so the response is live rather than read only at startup.
  motionQuery.addEventListener('change', (event) => {
    app.setReducedMotion(event.matches);
  });

  // ------------------------------------------------------------------- sizing

  const applySize = (): void => {
    const rect = canvas.getBoundingClientRect();
    // A zero-sized rect occurs before layout settles; sizing to it would produce a
    // degenerate aspect ratio.
    if (rect.width <= 0 || rect.height <= 0) return;

    app.resize(rect.width, rect.height);
    // Re-read the ratio each time: dragging a window between displays changes it.
    app.glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  };

  // ResizeObserver rather than the window resize event, because the canvas can change
  // size without the window doing so, and it fires once after layout rather than
  // repeatedly during it.
  new ResizeObserver(applySize).observe(canvas);
  applySize();

  // ------------------------------------------------------------------ pointer

  const pointers = new Map<number, PointerRecord>();
  /** Separation between two pointers on the previous move, for pinch. */
  let previousPinchDistance: number | null = null;

  const dragThresholdFor = (pointerType: string): number =>
    pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD_PX : MOUSE_DRAG_THRESHOLD_PX;

  const pinchDistance = (): number | null => {
    const active = [...pointers.values()];
    if (active.length < 2) return null;
    const [first, second] = active as [PointerRecord, PointerRecord];
    return Math.hypot(first.currentX - second.currentX, first.currentY - second.currentY);
  };

  canvas.addEventListener('pointerdown', (event) => {
    // Capture so a drag that leaves the canvas keeps delivering events; without this the
    // camera stops mid-gesture when the pointer crosses the edge.
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();

    pointers.set(event.pointerId, {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      travelled: 0,
    });

    if (pointers.size === 2) previousPinchDistance = pinchDistance();
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    const record = pointers.get(event.pointerId);
    if (record === undefined) return;

    const deltaX = event.clientX - record.currentX;
    const deltaY = event.clientY - record.currentY;

    record.currentX = event.clientX;
    record.currentY = event.clientY;
    record.travelled += Math.hypot(deltaX, deltaY);

    const rect = canvas.getBoundingClientRect();

    // TWO POINTERS: pinch to zoom and two-finger drag to pan. Contract section 6.
    if (pointers.size >= 2) {
      const distance = pinchDistance();
      if (distance !== null && previousPinchDistance !== null && previousPinchDistance > 0) {
        // The ratio of separations is directly the dolly factor, which keeps the gesture
        // multiplicative without any tuning constant.
        const ratio = previousPinchDistance / distance;
        if (Number.isFinite(ratio) && ratio > 0) app.cameraRig.dollyBy(ratio);
      }
      previousPinchDistance = distance;

      // Two-finger drag pans, using this pointer's own motion so the pan tracks the hand
      // rather than the midpoint, which jumps when a finger lifts.
      app.cameraRig.panBy(deltaX / rect.width, -deltaY / rect.height);
      return;
    }

    // MIDDLE BUTTON pans, matching the convention contract section 6 specifies for mouse
    // input. event.buttons is a bitmask; bit 2 is the middle button.
    const middleHeld = (event.buttons & 4) !== 0;
    if (middleHeld) {
      app.cameraRig.panBy(deltaX / rect.width, -deltaY / rect.height);
      return;
    }

    /**
     * SINGLE POINTER DRAGS THE CAMERA.
     *
     * Dragging right rotates the camera anticlockwise about the target, so the scene
     * appears to follow the hand. Dragging up raises the camera above the ecliptic. Both
     * are conventions rather than derivations, and inverting either would be a defensible
     * preference.
     */
    app.cameraRig.orbitBy(
      (-deltaX / rect.width) * AZIMUTH_PER_VIEWPORT,
      (-deltaY / rect.height) * ELEVATION_PER_VIEWPORT,
    );
  });

  const finishPointer = (event: PointerEvent): void => {
    const record = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);

    if (pointers.size < 2) previousPinchDistance = null;
    if (pointers.size === 0) canvas.classList.remove('dragging');

    if (record === undefined) return;

    // A gesture that moved beyond the threshold was a drag, so it must not also select.
    if (record.travelled > dragThresholdFor(record.pointerType)) return;

    const rect = canvas.getBoundingClientRect();
    const result = app.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      // Touch pointing is far coarser than mouse pointing, so it gets the larger
      // tolerance. Passing undefined lets the selection module apply its own default.
      record.pointerType === 'touch' ? 32 : undefined,
    );

    // A tap on empty space clears the selection, which is the same effect as Escape.
    app.select(result?.bodyId ?? null);
    updateProvenance();
  };

  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', (event) => {
    // Cancelled, so no selection: the interaction did not complete.
    pointers.delete(event.pointerId);
    if (pointers.size < 2) previousPinchDistance = null;
    if (pointers.size === 0) canvas.classList.remove('dragging');
  });

  canvas.addEventListener('dblclick', (event) => {
    // Contract section 6: double-click focuses, which selects and flies to the body.
    const rect = canvas.getBoundingClientRect();
    const result = app.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (result?.bodyId != null) {
      app.focus(result.bodyId);
      updateProvenance();
    }
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      // Without preventDefault the browser zooms the page instead, and the camera receives
      // nothing. Requires passive: false, which is why it is set explicitly below.
      event.preventDefault();

      // Normalised to CSS pixels; see WHEEL_LINE_HEIGHT_PX for why this is not optional.
      let pixels = event.deltaY;
      if (event.deltaMode === 1) pixels *= WHEEL_LINE_HEIGHT_PX;
      else if (event.deltaMode === 2) pixels *= canvas.getBoundingClientRect().height;

      // Exponential, so the gesture is multiplicative and exactly reversible.
      app.cameraRig.dollyBy(Math.exp(pixels * DOLLY_RATE_PER_PIXEL));
    },
    // Chrome treats wheel listeners as passive by default in some contexts, and a passive
    // listener cannot call preventDefault.
    { passive: false },
  );

  // Middle-click autoscroll would otherwise hijack the pan gesture.
  canvas.addEventListener('auxclick', (event) => {
    if (event.button === 1) event.preventDefault();
  });

  // ----------------------------------------------------------------- keyboard

  canvas.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowLeft':
        app.cameraRig.orbitBy(KEYBOARD_ORBIT_STEP, 0);
        break;
      case 'ArrowRight':
        app.cameraRig.orbitBy(-KEYBOARD_ORBIT_STEP, 0);
        break;
      case 'ArrowUp':
        app.cameraRig.orbitBy(0, KEYBOARD_ORBIT_STEP);
        break;
      case 'ArrowDown':
        app.cameraRig.orbitBy(0, -KEYBOARD_ORBIT_STEP);
        break;
      case '+':
      case '=':
        app.cameraRig.dollyBy(1 / KEYBOARD_DOLLY_FACTOR);
        break;
      case '-':
      case '_':
        app.cameraRig.dollyBy(KEYBOARD_DOLLY_FACTOR);
        break;
      case 'Escape':
        // Contract section 6: Escape clears the selection.
        app.select(null);
        updateProvenance();
        break;
      case 'Home':
        app.overview();
        updateProvenance();
        break;
      case ' ':
        app.simulationClock.togglePaused();
        updateProvenance();
        break;
      default:
        // Not a control this view handles, so the browser keeps it.
        return;
    }
    // Consumed, so arrow keys do not also scroll the page.
    event.preventDefault();
  });

  // --------------------------------------------------------------- provenance

  /**
   * Updates the always-visible statement of what the view is showing.
   *
   * NOT the M3 interface. This exists so the scale distortion and the model behind the
   * positions are never implicit, which contract sections 1.5, 9 and 11 require whenever
   * non-linear scaling is active. The vocabulary follows section 27: MODEL and COMPUTED,
   * never telemetry or live.
   */
  function updateProvenance(): void {
    const report = app.report;
    if (report === null) return;

    const clock = report.snapshot.clock;
    const lines: string[] = [
      `SIMULATION DATE  ${clock.formattedUtc}`,
      `TIME             ${clock.paused ? 'PAUSED' : `${clock.rate}x ${clock.direction < 0 ? 'REVERSE' : 'FORWARD'}`}`,
      ...app.scaleDisclosure(),
      'MODEL            JPL Approximate Positions of the Planets',
      'STATUS           COMPUTED',
    ];

    if (app.selected !== null) {
      const body = report.snapshot.bodies.find((entry) => entry.bodyId === app.selected);
      if (body !== undefined) {
        lines.push(
          `SELECTED         ${body.displayName.toUpperCase()}`,
          `DISTANCE (SUN)   ${(body.distanceFromSunKm / 1e6).toFixed(3)} million km`,
        );
      }
    }

    // Bodies with no model are disclosed rather than silently absent; in M1 that is the
    // Moon, which awaits its lunar theory.
    if (report.snapshot.unavailable.length > 0) {
      const names = report.snapshot.unavailable.map((entry) => entry.bodyId.toUpperCase());
      lines.push(`NO MODEL LOADED  ${names.join(', ')}`);
    }

    provenance.textContent = lines.join('\n');
  }

  // --------------------------------------------------------------------- run

  // One frame before starting the loop, so the provenance strip and the pick buffer are
  // populated rather than empty until the first animation callback.
  app.renderFrame(0);
  updateProvenance();

  // Refresh the strip about four times a second rather than every frame: it is text, and
  // rewriting it at 60 Hz would cost layout for no visible benefit.
  window.setInterval(updateProvenance, 250);

  app.start();

  // Released so a hot reload or a navigation does not leak GPU resources.
  window.addEventListener('beforeunload', () => {
    app.dispose();
  });
}

try {
  main();
} catch (error) {
  reportFatal('The visualization failed to initialise.', error);
}
