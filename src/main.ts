/**
 * Entry point, UI wiring, and interactive celestial overlay.
 *
 * WHAT THIS LAYER OWNS. The DOM: canvas lookup, resize observation, pointer and keyboard
 * events, reduced motion media queries, interactive planet circles & labels, HUD navigation,
 * playback controls, and the provenance strip. It translates user interactions into app
 * commands and maintains UI state.
 */

import { SolarSystemApp } from './app';

/** Cap on drawing-buffer pixel ratio to protect GPU fillrate. */
const MAX_PIXEL_RATIO = 2;

const MOUSE_DRAG_THRESHOLD_PX = 4;
const TOUCH_DRAG_THRESHOLD_PX = 12;

const AZIMUTH_PER_VIEWPORT = Math.PI;
const ELEVATION_PER_VIEWPORT = Math.PI * 0.75;
const DOLLY_RATE_PER_PIXEL = 0.001;
const WHEEL_LINE_HEIGHT_PX = 16;

const KEYBOARD_ORBIT_STEP = 0.06;
const KEYBOARD_DOLLY_FACTOR = 1.15;

const SPEED_STEPS = [1, 10, 100, 1000, 10000, 50000];

interface PlanetMeta {
  readonly icon: string;
  readonly name: string;
  readonly type: string;
  readonly color: string;
  readonly glow: string;
}

const PLANET_METADATA: Record<string, PlanetMeta> = {
  sun: { icon: '☀️', name: 'Sun', type: 'Yellow Dwarf Star (G2V)', color: '#ffd166', glow: 'rgba(255, 209, 102, 0.7)' },
  mercury: { icon: '☿', name: 'Mercury', type: 'Terrestrial Planet', color: '#adb5bd', glow: 'rgba(173, 181, 189, 0.5)' },
  venus: { icon: '♀', name: 'Venus', type: 'Terrestrial Planet', color: '#f4a261', glow: 'rgba(244, 162, 97, 0.6)' },
  earth: { icon: '⊕', name: 'Earth', type: 'Terrestrial Planet', color: '#4ea8de', glow: 'rgba(78, 168, 222, 0.7)' },
  moon: { icon: '🌙', name: 'Moon', type: 'Natural Satellite (Luna)', color: '#e2eafc', glow: 'rgba(226, 234, 252, 0.5)' },
  mars: { icon: '♂', name: 'Mars', type: 'Terrestrial Planet', color: '#e76f51', glow: 'rgba(231, 111, 81, 0.7)' },
  jupiter: { icon: '♃', name: 'Jupiter', type: 'Gas Giant', color: '#e9c46a', glow: 'rgba(233, 196, 106, 0.7)' },
  saturn: { icon: '♄', name: 'Saturn', type: 'Gas Giant (Ring System)', color: '#f4a261', glow: 'rgba(244, 162, 97, 0.7)' },
  uranus: { icon: '⛢', name: 'Uranus', type: 'Ice Giant', color: '#48cae4', glow: 'rgba(72, 202, 228, 0.7)' },
  neptune: { icon: '♆', name: 'Neptune', type: 'Ice Giant', color: '#0077b6', glow: 'rgba(0, 119, 182, 0.7)' },
  pluto: { icon: '♇', name: 'Pluto', type: 'Dwarf Planet (Kuiper Belt)', color: '#b8bedd', glow: 'rgba(184, 190, 221, 0.5)' },
};

interface PointerRecord {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly startX: number;
  readonly startY: number;
  currentX: number;
  currentY: number;
  travelled: number;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`main: required element "${selector}" is missing from the document`);
  }
  return element;
}

function reportFatal(message: string, detail?: unknown): void {
  const element = document.querySelector<HTMLElement>('#failure');
  const text =
    detail instanceof Error
      ? `${message}\n\n${detail.message}`
      : detail === undefined
        ? message
        : `${message}\n\n${String(detail)}`;

  if (element === null) {
    console.error(text);
    return;
  }
  element.textContent = text;
  element.style.display = 'grid';
}

function main(): void {
  const canvas = requireElement<HTMLCanvasElement>('#viewport');
  const provenance = requireElement<HTMLElement>('#provenance');
  const planetOverlay = requireElement<HTMLElement>('#planet-overlay');
  const topBar = requireElement<HTMLElement>('#top-bar');
  const planetCard = requireElement<HTMLElement>('#planet-card');

  const cardIcon = requireElement<HTMLElement>('#card-icon');
  const cardTitle = requireElement<HTMLElement>('#card-title');
  const cardSubtitle = requireElement<HTMLElement>('#card-subtitle');
  const cardDist = requireElement<HTMLElement>('#card-dist');
  const cardRadius = requireElement<HTMLElement>('#card-radius');
  const cardSpeed = requireElement<HTMLElement>('#card-speed');
  const cardFocusBtn = requireElement<HTMLButtonElement>('#card-focus-btn');
  const closeCardBtn = requireElement<HTMLButtonElement>('#close-card-btn');

  const btnPlayPause = requireElement<HTMLButtonElement>('#btn-play-pause');
  const btnReverse = requireElement<HTMLButtonElement>('#btn-reverse');
  const btnForward = requireElement<HTMLButtonElement>('#btn-forward');
  const rateBadge = requireElement<HTMLElement>('#rate-badge');
  const btnToggleLabels = requireElement<HTMLButtonElement>('#btn-toggle-labels');
  const btnToggleRings = requireElement<HTMLButtonElement>('#btn-toggle-rings');
  const btnScaleMode = requireElement<HTMLButtonElement>('#btn-scale-mode');

  canvas.tabIndex = 0;
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

  motionQuery.addEventListener('change', (event) => {
    app.setReducedMotion(event.matches);
  });

  // UI toggle flags
  let showLabels = true;
  let showRings = true;
  let currentSpeedIndex = 0;
  let isVisualScale = true;

  // ------------------------------------------------------------------- Overlay Targets Map
  const targetElements = new Map<string, { root: HTMLElement; reticle: HTMLElement; label: HTMLElement }>();

  function createOverlayElements(): void {
    planetOverlay.innerHTML = '';
    targetElements.clear();

    for (const [bodyId, meta] of Object.entries(PLANET_METADATA)) {
      const root = document.createElement('div');
      root.className = 'planet-target';
      root.id = `target-${bodyId}`;
      root.style.setProperty('--planet-color', meta.color);
      root.style.setProperty('--planet-glow', meta.glow);

      const reticle = document.createElement('div');
      reticle.className = 'planet-reticle';
      reticle.title = `Click to focus ${meta.name}`;

      const label = document.createElement('div');
      label.className = 'planet-label';
      label.innerHTML = `<span>${meta.icon}</span> <span>${meta.name}</span>`;

      root.appendChild(reticle);
      root.appendChild(label);

      root.addEventListener('click', (e) => {
        e.stopPropagation();
        app.focus(bodyId);
        updateUI();
      });

      planetOverlay.appendChild(root);
      targetElements.set(bodyId, { root, reticle, label });
    }
  }

  createOverlayElements();

  // ------------------------------------------------------------------- Update Overlay
  function updateOverlayPositions(): void {
    const projected = app.getProjectedBodies();
    const selectedId = app.selected;
    const vpWidth = canvas.clientWidth;
    const vpHeight = canvas.clientHeight;

    for (const item of projected) {
      const el = targetElements.get(item.bodyId);
      if (!el) continue;

      // Check if visible and in front of camera
      const isVisible =
        item.inFront &&
        item.screenX >= -50 &&
        item.screenX <= vpWidth + 50 &&
        item.screenY >= -50 &&
        item.screenY <= vpHeight + 50;

      if (!isVisible) {
        el.root.classList.add('hidden');
        continue;
      }

      el.root.classList.remove('hidden');
      el.root.style.left = `${item.screenX}px`;
      el.root.style.top = `${item.screenY}px`;

      // Active selection highlight
      if (item.bodyId === selectedId) {
        el.root.classList.add('selected');
      } else {
        el.root.classList.remove('selected');
      }

      // If user toggles off rings or if apparent size is large (zoomed very close), fade reticle
      if (!showRings || item.apparentRadiusPx > 100) {
        el.reticle.style.display = 'none';
      } else {
        el.reticle.style.display = 'flex';
      }

      // If user toggles off labels, hide label badge
      if (!showLabels) {
        el.label.style.display = 'none';
      } else {
        el.label.style.display = 'flex';
      }
    }
  }

  // ------------------------------------------------------------------- Planet Card & Navigation
  function updatePlanetCard(): void {
    const selectedId = app.selected;
    if (!selectedId) {
      planetCard.style.display = 'none';
      return;
    }

    const meta = PLANET_METADATA[selectedId];
    if (!meta) {
      planetCard.style.display = 'none';
      return;
    }

    const report = app.report;
    const bodyState = report?.snapshot.bodies.find((b) => b.bodyId === selectedId);
    const scaledBody = report?.scaled.find((b) => b.bodyId === selectedId);

    cardIcon.textContent = meta.icon;
    cardTitle.textContent = meta.name;
    cardSubtitle.textContent = meta.type;

    if (bodyState) {
      const distMillion = (bodyState.distanceFromSunKm / 1e6).toFixed(2);
      const distAU = (bodyState.distanceFromSunKm / 149597870.7).toFixed(2);
      cardDist.textContent = selectedId === 'sun' ? '0 km (Center)' : `${distMillion}M km (${distAU} AU)`;

      const radiusKm = (scaledBody?.physicalRadiusKm ?? 0).toLocaleString();
      cardRadius.textContent = `${radiusKm} km`;

      const speedKmS = bodyState.velocityKmS
        ? Math.hypot(
            bodyState.velocityKmS.x,
            bodyState.velocityKmS.y,
            bodyState.velocityKmS.z,
          ).toFixed(2)
        : '0.00';
      cardSpeed.textContent = selectedId === 'sun' ? '0 km/s' : `${speedKmS} km/s`;
    }

    planetCard.style.display = 'flex';
  }

  function updateNavActive(): void {
    const selectedId = app.selected;
    const navButtons = topBar.querySelectorAll<HTMLButtonElement>('.nav-btn');
    navButtons.forEach((btn) => {
      const body = btn.getAttribute('data-body');
      if (body === selectedId || (body === 'overview' && selectedId === null)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function updateUI(): void {
    updateProvenance();
    updatePlanetCard();
    updateNavActive();
  }

  // Top Bar Navigation clicks
  topBar.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.nav-btn');
    if (!target) return;
    const body = target.getAttribute('data-body');
    if (body === 'overview' || !body) {
      app.overview();
    } else {
      app.focus(body);
    }
    updateUI();
  });

  // Card events
  closeCardBtn.addEventListener('click', () => {
    app.select(null);
    updateUI();
  });

  cardFocusBtn.addEventListener('click', () => {
    if (app.selected) {
      app.focus(app.selected);
      updateUI();
    }
  });

  // ------------------------------------------------------------------- Simulation Controls
  btnPlayPause.addEventListener('click', () => {
    app.simulationClock.togglePaused();
    btnPlayPause.textContent = app.simulationClock.paused ? '▶️' : '⏸️';
    btnPlayPause.classList.toggle('active', !app.simulationClock.paused);
    updateProvenance();
  });

  btnReverse.addEventListener('click', () => {
    app.simulationClock.setDirection(-1);
    btnReverse.classList.add('active');
    btnForward.classList.remove('active');
    updateProvenance();
  });

  btnForward.addEventListener('click', () => {
    app.simulationClock.setDirection(1);
    btnForward.classList.add('active');
    btnReverse.classList.remove('active');
    updateProvenance();
  });

  rateBadge.addEventListener('click', () => {
    currentSpeedIndex = (currentSpeedIndex + 1) % SPEED_STEPS.length;
    const rate = SPEED_STEPS[currentSpeedIndex]!;
    app.simulationClock.setRate(rate);
    rateBadge.textContent = `${rate.toLocaleString()}x Speed`;
    updateProvenance();
  });

  btnToggleLabels.addEventListener('click', () => {
    showLabels = !showLabels;
    btnToggleLabels.classList.toggle('active', showLabels);
  });

  btnToggleRings.addEventListener('click', () => {
    showRings = !showRings;
    btnToggleRings.classList.toggle('active', showRings);
  });

  btnScaleMode.addEventListener('click', () => {
    isVisualScale = !isVisualScale;
    app.setScaleMode(isVisualScale ? 'VISUALIZED' : 'SCIENTIFIC');
    btnScaleMode.textContent = isVisualScale ? '🔭 Scale: Visual' : '📐 Scale: Scientific';
    btnScaleMode.classList.toggle('active', !isVisualScale);
    updateProvenance();
  });

  // ------------------------------------------------------------------- sizing
  const applySize = (): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    app.resize(rect.width, rect.height);
    app.glRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  };

  new ResizeObserver(applySize).observe(canvas);
  applySize();

  // ------------------------------------------------------------------ pointer
  const pointers = new Map<number, PointerRecord>();
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

    if (pointers.size >= 2) {
      const distance = pinchDistance();
      if (distance !== null && previousPinchDistance !== null && previousPinchDistance > 0) {
        const ratio = previousPinchDistance / distance;
        if (Number.isFinite(ratio) && ratio > 0) app.cameraRig.dollyBy(ratio);
      }
      previousPinchDistance = distance;
      app.cameraRig.panBy(deltaX / rect.width, -deltaY / rect.height);
      return;
    }

    const middleHeld = (event.buttons & 4) !== 0;
    if (middleHeld) {
      app.cameraRig.panBy(deltaX / rect.width, -deltaY / rect.height);
      return;
    }

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
    if (record.travelled > dragThresholdFor(record.pointerType)) return;

    const rect = canvas.getBoundingClientRect();
    const result = app.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      record.pointerType === 'touch' ? 32 : undefined,
    );

    app.select(result?.bodyId ?? null);
    updateUI();
  };

  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) previousPinchDistance = null;
    if (pointers.size === 0) canvas.classList.remove('dragging');
  });

  canvas.addEventListener('dblclick', (event) => {
    const rect = canvas.getBoundingClientRect();
    const result = app.pick(event.clientX - rect.left, event.clientY - rect.top);
    if (result?.bodyId != null) {
      app.focus(result.bodyId);
      updateUI();
    }
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      let pixels = event.deltaY;
      if (event.deltaMode === 1) pixels *= WHEEL_LINE_HEIGHT_PX;
      else if (event.deltaMode === 2) pixels *= canvas.getBoundingClientRect().height;

      app.cameraRig.dollyBy(Math.exp(pixels * DOLLY_RATE_PER_PIXEL));
    },
    { passive: false },
  );

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
        app.select(null);
        updateUI();
        break;
      case 'Home':
        app.overview();
        updateUI();
        break;
      case ' ':
        app.simulationClock.togglePaused();
        btnPlayPause.textContent = app.simulationClock.paused ? '▶️' : '⏸️';
        btnPlayPause.classList.toggle('active', !app.simulationClock.paused);
        updateUI();
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  // --------------------------------------------------------------- provenance
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

    if (report.snapshot.unavailable.length > 0) {
      const names = report.snapshot.unavailable.map((entry) => entry.bodyId.toUpperCase());
      lines.push(`NO MODEL LOADED  ${names.join(', ')}`);
    }

    provenance.textContent = lines.join('\n');
  }

  // --------------------------------------------------------------------- run
  app.renderFrame(0);
  updateUI();

  // Continual overlay positions synchronization on animation frame
  function overlayLoop(): void {
    updateOverlayPositions();
    requestAnimationFrame(overlayLoop);
  }
  requestAnimationFrame(overlayLoop);

  window.setInterval(updateProvenance, 250);

  // 3D Cube Loading Screen Progress and Dismissal
  const loadingScreen = document.querySelector<HTMLElement>('#loading-screen');
  const loadingStatus = document.querySelector<HTMLElement>('#loading-status');
  const loadingBarInner = document.querySelector<HTMLElement>('.loading-bar-inner');

  app.onModelProgress = (loaded, total, bodyId) => {
    const meta = PLANET_METADATA[bodyId];
    const name = meta?.name.toUpperCase() ?? bodyId.toUpperCase();
    const percent = Math.round((loaded / total) * 100);

    if (loadingStatus) {
      loadingStatus.textContent = `LOADING 3D ASSETS (${loaded}/${total}): ${name}...`;
    }
    if (loadingBarInner) {
      loadingBarInner.style.animation = 'none';
      loadingBarInner.style.left = '0';
      loadingBarInner.style.width = `${percent}%`;
    }
  };

  // Wait until all 3D models are fully loaded before dismissing the loading screen
  app.whenModelsLoaded.then(() => {
    if (loadingStatus) {
      loadingStatus.textContent = 'ALL 3D PLANETS LOADED & READY';
    }
    if (loadingBarInner) {
      loadingBarInner.style.width = '100%';
    }

    if (loadingScreen) {
      window.setTimeout(() => {
        loadingScreen.classList.add('fade-out');
        window.setTimeout(() => {
          loadingScreen.remove();
        }, 850);
      }, 500);
    }
  });

  app.start();

  window.addEventListener('beforeunload', () => {
    app.dispose();
  });
}

try {
  main();
} catch (error) {
  reportFatal('The visualization failed to initialise.', error);
}
