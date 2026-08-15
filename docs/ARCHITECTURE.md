# Architecture Decision Records

This document records significant architectural decisions, their reasoning, and measured consequences.

---

## ADR-001: Split Julian Date Representation

**Decision:** Store Julian Dates as an integer day + fraction in [0, 1) rather than a single float.

**Context:** A modern Julian Date (~2.46×10⁶) in a single f64 resolves to ~24 microseconds. Every arithmetic step rounds at that magnitude, so long-running simulation time degrades.

**Consequence:** The split representation resolves ~10 picoseconds. Simulation can accumulate time over centuries without precision loss. All JD arithmetic goes through `normalizeJD()` to maintain the invariant.

---

## ADR-002: Type-Branded Time Scales

**Decision:** `JulianDate<'UTC'>` and `JulianDate<'TT'>` are structurally identical but type-branded, preventing accidental mixing.

**Context:** The difference between UTC and TT is ~69 seconds at 2026. Feeding UTC to an ephemeris model that expects TT silently displaces positions by ~2000 km. This happened during early development.

**Consequence:** Passing UTC where TT is expected is a compile error. Conversion goes through `ttFromUtc()` which applies ΔT. The cost is minor API friction when constructing dates for testing.

---

## ADR-003: Velocity by Central Differencing

**Decision:** Compute velocity by central finite differencing of the model's own position, rather than analytically deriving the velocity from the elements.

**Context:** The position depends on time through SIX secular paths (M, ω, Ω, I, a, e). Differentiating only the mean-anomaly path omits five contributions that partially cancel. During development, the analytical approach left a 5.7×10⁻⁵ relative error for Saturn and 1.5×10⁻³ for Neptune.

**Consequence:** Central differencing at h=60s captures all secular paths. Truncation error is ~4×10⁻¹⁰ relative (Mercury) and round-off error is ~7×10⁻¹⁰ (Neptune). Both are four orders below the test tolerance. Cost: two extra element evaluations per body per frame.

---

## ADR-004: Multi-Pass Depth Slabs

**Decision:** Partition the scene into 3 depth slabs (NEAR/MIDDLE/FAR) rendered far-to-near with depth clears between, rather than using a single wide frustum.

**Context:** The scene spans ~10¹⁰ dynamic range (1 km to 4.5×10⁹ km). A single 24-bit depth buffer resolves ~1.2×10¹³ km at Neptune — no discrimination at all.

**Consequence:** Each slab has a bounded near/far ratio. Measured resolution at Neptune improves from useless to 4100 km (log depth) or 22000 km (linear depth). The combination of slabs + log depth is 5.2× better at Neptune than slabs + linear depth.

---

## ADR-005: Logarithmic Depth Buffer (Always On)

**Decision:** Enable `logarithmicDepthBuffer: true` globally, rather than optionally or per-slab.

**Context:** Earlier analysis incorrectly claimed log depth was a net loss in the far slab. That analysis assumed a 4:1 slab ratio, but the actual measured MIDDLE slab ratio is 168:1, where log depth wins decisively (4100 km vs 22000 km at Neptune).

**Consequence:** Resolution is uniformly better at the far end of every slab. The near plane does not appear in log depth's distribution formula, so the dynamic near plane costs nothing.

---

## ADR-006: Floating Origin

**Decision:** Subtract a camera-relative origin in f64 before uploading positions to GPU as f32, rather than uploading absolute positions.

**Context:** Neptune at 4.5×10⁶ render units has f32 resolution of ~0.25 units (250 km). Objects near the camera would jitter visibly.

**Consequence:** All GPU coordinates are small (relative to camera), well within f32 precision. The origin shifts when the camera moves far enough, tracked by an `originChanges` counter.

---

## ADR-007: Scene Background Is Null

**Decision:** Leave `scene.background` null and set the background colour via `renderer.setClearColor()`.

**Context:** Three.js's `WebGLBackground.render()` sets `forceClear = true` when `scene.background` is a Color. This bypasses `autoClear` and clears colour+depth on EVERY `renderer.render()` call. With 5 render passes per frame, only the last pass survives.

**Consequence:** Background colour is applied via `setClearColor()`, which sets the GL clear state without forcing a clear. The single explicit `renderer.clear()` in the frame loop uses it.

---

## ADR-008: Layer 0 Is Unused

**Decision:** Reserve Three.js layer 0 (the default) and never assign anything to it.

**Context:** Three.js puts every new Object3D and Camera on layer 0. If a slab camera stays on layer 0, it draws nothing. If a body stays on layer 0, no pass draws it. Both failures are silent — no error, no warning.

**Consequence:** Forgetting to assign layers fails visibly (invisible objects) rather than silently (objects drawn by the wrong pass). During development, this caught the slab cameras being left on the default layer.

---

## ADR-009: Irradiance from Physical Distance

**Decision:** Compute the renderer's brightness factor from PHYSICAL distance (km), not render-space distance.

**Context:** In visualized mode, render distances are compressed. Neptune's render distance is ~4.4×10⁶ units vs ~4.5×10⁹ km physical. Using render distance for inverse-square falloff would overlight Neptune by a measured factor of 42×.

**Consequence:** Illumination is correct in both scale modes. The renderer receives a pre-computed `brightnessFactor` per body and disables its own distance falloff (decay = 0).

---

## ADR-010: Hierarchical Scaling for Satellites

**Decision:** Scale satellite offsets from their primary ISOTROPICALLY (single scalar), not by applying the heliocentric radial compression to the absolute position.

**Context:** The radial compression scales radially by `df/dr` and tangentially by `f(r)/r`. At the reference radius with exponent 0.45, these are 0.45 and 1.0 — a 55% flattening. A circular satellite orbit would render as an ellipse.

**Consequence:** The satellite branch uses `(position - primary) × uniformFactor`, preserving orbit shape. `satelliteOffsetFactors` in the config allow per-subsystem offset scaling (default 1 = true relative scale).

---

## ADR-011: Provenance on Every Constant

**Decision:** Every astronomical constant carries its source identifier (S1–S7), and presentation parameters carry NO source because they make no empirical claim.

**Context:** Without provenance, a radius multiplier or depth-slab boundary could be mistaken for a physical measurement. Conversely, a physical constant without a source cannot be validated or updated when better values are published.

**Consequence:** `src/data/sources.md` is the single point of truth. The `Measured` interface carries `value`, `uncertainty`, `unit`, and `source` together. The interface labels values as MODEL/COMPUTED, never as measured or exact.
