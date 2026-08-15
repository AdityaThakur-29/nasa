# Solar System Visualization — Workspace Rules

## Pipeline Direction
- The data pipeline flows: `data/ → ephemeris/ → sim/ → render/`. Never import upstream.
- `main.ts` is the only file touching the DOM or browser APIs.
- The render layer reads simulation snapshots but never writes back.

## Physical Data
- Every astronomical constant must cite one of S1–S7 from `src/data/sources.md`.
- Never invent, estimate, or round a physical value without a published source.
- Carry uncertainty alongside values using the `Measured` interface.
- Presentation parameters (scale exponents, pixel thresholds) carry NO citation.

## Type Safety
- `JulianDate<'UTC'>` and `JulianDate<'TT'>` must not be mixed. Use `ttFromUtc()` / `utcFromTt()`.
- Use strict TypeScript — all checks enabled in `tsconfig.json`.
- Prefer branded types and discriminated unions over raw strings/numbers.

## Vocabulary
- Use: MODEL, COMPUTED, APPROXIMATE, DERIVED, PREDICTED, EXTRAPOLATED
- Never use: measured, live, exact, telemetry, real-time

## Rendering
- `scene.background` must remain `null` — use `renderer.setClearColor()` instead.
- Layer 0 is unused by design. Always assign explicit layers.
- For 3D GLTF models, propagate layer masks recursively to all child meshes.
- Wrap loaded GLTF models in a `Group` container to protect unit-radius centering.
- Register `KHR_materials_pbrSpecularGlossiness` on `GLTFLoader` for embedded textures.
- `renderer.autoClear` must be `false`. Each slab issues its own render call.
- Irradiance uses PHYSICAL distance, never render-space distance.

## Testing
- Unit tests: Node, zero WebGL, zero DOM. Never weaken for CI.
- Physical computations: tolerance-based assertions, prefer invariant tests.
- New functions need tests unless they're thin Three.js wrappers.

## Comments
- Preserve all existing comments and docstrings unrelated to your changes.
- Module headers explain ownership and boundary reasoning — maintain them.
