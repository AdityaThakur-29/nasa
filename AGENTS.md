# Solar System Visualization — Agent Guidelines

This document provides rules and context for AI agents working on this codebase.
Read fully before making any change.

---

## Core Principles (Non-Negotiable)

### 1. One-Way Pipeline
The data pipeline flows **strictly downward**:
```
SimulationState → scaleSystem → CameraRig → FloatingOrigin → planDepthSlabs → GPU
```
- **No stage may write back to a stage above it.**
- The simulation layer never imports from the render layer.
- The render layer reads simulation state but never modifies it.

### 2. Physical Values Are Sacred
- Every value in `src/data/` is sourced and cited. **Never invent, estimate, or modify a physical value without a published citation.**
- Physical units are **km**, **km/s**, **Julian Date**, **f64** throughout the simulation.
- Render units are a separate domain (`1 render unit = 1000 km`). The conversion happens **only** in `src/sim/scale.ts`.

### 3. Provenance Is Mandatory
- Every astronomical constant must trace to one of the sources in `src/data/sources.md` (S1–S7).
- Presentation parameters (scale exponents, depth-slab boundaries, pixel thresholds) carry **no citation** because they make no empirical claim. They must never appear in an interface panel as though they were measured.

### 4. Vocabulary
- Use **MODEL**, **COMPUTED**, **APPROXIMATE** — never "measured", "live", "exact", or "telemetry".
- A value produced by evaluating a model is COMPUTED. A forward projection is PREDICTED. An extrapolation is EXTRAPOLATED.

### 5. Type Safety
- `JulianDate<'UTC'>` and `JulianDate<'TT'>` are **type-branded**. Never cast between them without going through `ttFromUtc()` or `utcFromTt()`.
- `ScaleMode` is `'SCIENTIFIC' | 'VISUALIZED'`. Never add modes without updating disclosure logic.
- `ComputationStatus` is `'COMPUTED' | 'INTERPOLATED' | 'OUT_OF_RANGE'`. Never use `'MEASURED'`.

---

## Architecture Rules

### Simulation Layer (`src/core/`, `src/data/`, `src/ephemeris/`, `src/sim/`)
- Units: **km, km/s, Julian Date, f64**
- Frame: **J2000 ecliptic, Sun-centred, Z = ecliptic north**
- Must not import from `src/render/`
- Must not reference Three.js, DOM, canvas, pixels, or any browser API
- Must not reference `matchMedia`, `devicePixelRatio`, or any CSS value

### Render Layer (`src/render/`)
- Units: **render units (1000 km), f32 on GPU**
- May read simulation state (via `SimulationSnapshot`, `ScaledBody[]`, etc.)
- Must not write back to simulation state
- Must not call `matchMedia` or read browser environment directly — those are injected from `main.ts`

### Entry Point (`src/main.ts`)
- The **only** file permitted to touch the DOM, attach event listeners, read `matchMedia`, or measure elements
- Translates browser events into app commands, nothing else

---

## File-Level Ownership

| File / Directory | Owns | Must Not Touch |
|---|---|---|
| `src/core/jd.ts` | Julian Date arithmetic, time-scale conversion | Anything outside time |
| `src/core/clock.ts` | Simulation clock, rate, scrubbing | Rendering, DOM |
| `src/data/*.ts` | Physical constants and parameters | Render state, visual properties |
| `src/ephemeris/*.ts` | Position and orientation computation | Render layer, Three.js |
| `src/sim/scale.ts` | Physical → render coordinate transforms | GPU uploads, Three.js objects |
| `src/sim/state.ts` | Authoritative physical state | Render state |
| `src/sim/irradiance.ts` | Solar irradiance (physical + brightness factor) | Renderer light objects |
| `src/render/*.ts` | Three.js objects, GPU uploads, draw calls | Simulation state mutation |
| `src/main.ts` | DOM, events, input | Simulation internals |
| `src/app.ts` | Pipeline orchestration, frame loop | DOM (except via injected canvas) |

---

## Testing Contract

### Unit Tests (`test/unit/`)
- Run in **Node** with zero WebGL, zero DOM.
- Must never be weakened to accommodate browser or CI limitations.
- Pure numerical and simulation correctness.

### GL Tests (`test/gl/`)
- Run in **headless Chromium** with real WebGL (ANGLE/SwiftShader).
- Render the actual pipeline and assert render-state properties.
- Infrastructure failures here are reported separately and do not relax unit tests.

### What to Test
- **Every new function** should have a corresponding test unless it's a thin Three.js wrapper.
- **Physical computations** require tolerance-based assertions (never exact equality on floats).
- **Invariants** (monotonicity, ordering, conservation laws) are preferred over point-value checks.

---

## Multi-Pass Rendering Rules

### Depth Slabs
- Three slabs: NEAR (0.1–10⁴), MIDDLE (10³–10⁷), FAR (10⁶–10¹³) render units.
- Classification by **centre distance**, first match wins (NEAR has priority in overlap regions).
- Planes are **expanded per frame** to contain actual members.
- Logarithmic depth buffer is **always on** — it protects the far end of each slab.

### Draw Order
1. `renderer.clear(true, true, true)` — once
2. Star field — no depth interaction
3. Orbit paths — no depth interaction  
4. Slabs far → near — depth cleared between, colour **never** cleared

### Layer Isolation
- Layer 0 is **deliberately unused** (Three.js default). Objects without a layer assignment are drawn by no pass.
- Each pass has a camera pinned to exactly one layer. Both the camera and the objects must have matching layers.
- For hierarchical 3D GLTF models, layer masks must be propagated recursively to all child meshes (`setObjectLayers`), or they will remain on layer 0 and disappear.

### Scene Background
- `scene.background` must be **null**. Setting it to a Color triggers `forceClear` inside Three.js, which would wipe every pass but the last.
- Background colour is set via `renderer.setClearColor()`.

---

## Coding Standards

### Documentation
- Preserve all existing comments and docstrings unrelated to your changes.
- Every module header explains **what it owns** and **why boundaries are where they are**.
- When a threshold or constant has a non-obvious value, document the measurement or derivation.

### Error Handling
- Throw on invalid input (non-finite numbers, out-of-range indices, cycle detection).
- Return structured error information (e.g., `UnavailableBody` with reason and detail) rather than silently omitting.
- Never fabricate data to fill a gap — report the absence.

### Naming
- `*Km` suffix for physical distances in kilometres
- `*Deg` suffix for angles in degrees
- `*Rad` suffix for angles in radians
- `render*` or `visual*` prefix for render-space quantities
- `brightness*` for the renderer-facing factor, `irradiance*` for the physical quantity

### Performance
- Allocation of snapshot objects per frame is acceptable for 10 bodies (immutability is worth more).
- The instanced asteroid belt in M4 will need a different approach — don't prematurely optimise for it now.
- Fragment cost scales with the **square** of pixel ratio — cap at 2.

---

## Common Pitfalls

1. **Using render-space distance for irradiance**: Would over-brighten Neptune by 42×. Use physical distance.
2. **Applying radial compression to satellite positions**: Flattens circular orbits by 55%. Use isotropic offset scaling instead.
3. **Setting `scene.background` to a Color**: Triggers forceClear, wiping every pass but the last.
4. **Mixing UTC and TT**: The type brand exists to prevent this. A 69-second error at 2026.
5. **Using a single wide frustum**: 10¹⁰ dynamic range cannot be resolved. Use the slab system.
6. **Testing conservation laws against secular elements**: They drift by design. Test the fixed-element propagator in `kepler.ts` instead.
7. **Forgetting to set layer masks on both the camera AND the objects**: Results in an invisible pass with no error or warning.
8. **Overwriting 3D model transforms directly without a Group container**: Overwrites internal model normalization and center offsets. Always wrap GLTF models in a `Group` container and apply frame transforms (`applyTransform`) to the container.
9. **Ignoring KHR_materials_pbrSpecularGlossiness in GLTFLoader**: Leaves GLB models without diffuse textures. Register the extension parser on `GLTFLoader`.
