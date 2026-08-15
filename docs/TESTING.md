# Testing Guide

This document describes the testing strategy, how to run tests, and guidelines for writing new tests.

---

## Test Infrastructure

| Suite | Environment | Purpose | Command |
|-------|-------------|---------|---------|
| **Unit** | Node (zero WebGL/DOM) | Numerical correctness, invariants | `npm test` |
| **GL** | Headless Chromium + WebGL | Render pipeline verification | `npm run test:gl` |
| **All** | Both | Full gate | `npm run test:all` |

### Configuration
- [`vitest.config.ts`](../vitest.config.ts) defines two isolated projects (`unit` and `gl`)
- Unit tests must **never** be weakened to accommodate browser/CI limitations
- GL tests use Playwright with ANGLE/SwiftShader software rasterization

---

## Unit Test Files

| File | Module Under Test | Key Assertions |
|------|-------------------|----------------|
| `jd.test.ts` | `core/jd.ts` | Calendar↔JD round-trips, split precision, ΔT polynomials |
| `clock.test.ts` | `core/clock.ts` | Advance, clamping, scrubbing, rate presets, direction |
| `kepler.test.ts` | `ephemeris/kepler.ts` | Kepler equation, orbital mechanics, conservation laws |
| `planets.test.ts` | `ephemeris/planets.ts` | JPL positions vs published accuracy, velocity consistency |
| `orientation.test.ts` | `ephemeris/orientation.ts` | IAU pole/meridian models, frame conversion |
| `data.test.ts` | `data/bodies.ts` | Physical data cross-validation (GM vs mass, periods vs elements) |
| `scale.test.ts` | `sim/scale.ts` | Compression monotonicity, hierarchy, separation, round-trips |
| `irradiance.test.ts` | `sim/irradiance.ts` | Solar constant, inverse-square, perceptual compression |
| `state.test.ts` | `sim/state.ts` | Simulation state, frame conversion, snapshots, distances |
| `depth-slabs.test.ts` | `render/depth-slabs.ts` | Classification, expansion, invariants, z-fighting analysis |
| `floating-origin.test.ts` | `render/floating-origin.ts` | Origin shifts, coordinate precision |
| `layered-cameras.test.ts` | `render/layered-cameras.ts` | Multi-camera compositing, layer isolation |
| `camera-selection.test.ts` | `render/selection.ts` | Screen-space picking, priority |
| `render-objects.test.ts` | `render/body-visuals.ts` + others | Body visuals, orbit paths, starfield |

### GL Test Files

| File | Purpose |
|------|---------|
| `smoke.test.ts` | Basic render: draw calls > 0, non-black output, no crash |
| `depth-stress.test.ts` | Extreme camera positions, depth invariant verification |

---

## Writing New Tests

### General Rules

1. **Tolerance-based assertions** for floating point:
   ```ts
   expect(value).toBeCloseTo(expected, decimalPlaces);
   // or
   expect(Math.abs(value - expected)).toBeLessThan(tolerance);
   ```

2. **Invariant tests over point-value tests:**
   ```ts
   // ✅ Good: tests the property, not a specific number
   expect(compressDistanceKm(d1, config)).toBeLessThan(compressDistanceKm(d2, config));
   
   // ❌ Weak: breaks if the constant changes
   expect(compressDistanceKm(AU_KM, config)).toBeCloseTo(149597870.7, 1);
   ```

3. **No DOM or WebGL in unit tests.** If it imports from Three.js, it's a GL test.

4. **Test the contract, not the implementation:**
   ```ts
   // ✅ Tests that UTC and TT can't be mixed
   expect(() => differenceSeconds(utcDate, ttDate)).toThrow();
   
   // ❌ Tests an internal cache — brittle
   expect(clock['ttCache']).not.toBeNull();
   ```

### Physical Computation Tests

For ephemeris, orientation, and irradiance:

1. **Compare against published values** with stated tolerance:
   ```ts
   // Earth's irradiance at 1 AU should be ~1361 W/m²
   expect(solarIrradianceWm2(AU_KM)).toBeCloseTo(1361.17, 0);
   ```

2. **Test conservation laws** where applicable:
   ```ts
   // Fixed-element Keplerian orbits conserve energy and angular momentum
   expect(specificEnergy(state1)).toBeCloseTo(specificEnergy(state2), 10);
   ```

3. **Test continuity** across boundaries:
   ```ts
   // ΔT should be continuous across the year-1800 polynomial boundary
   const before = deltaT(1799.99);
   const after = deltaT(1800.01);
   expect(Math.abs(after - before)).toBeLessThan(0.5);
   ```

### Render Pipeline Tests

For depth slabs, cameras, selection:

1. **Test structural invariants:**
   ```ts
   // Every candidate must be assigned to exactly one slab
   expect(plan.assignment.size).toBe(candidates.length);
   
   // Verification: complete, disjoint, contained
   const verification = verifyDepthPlan(candidates, plan);
   expect(verification.complete).toBe(true);
   expect(verification.disjoint).toBe(true);
   expect(verification.contained).toBe(true);
   ```

2. **Test boundary behaviour explicitly:**
   ```ts
   // d = 1e4 is in the NEAR/MIDDLE overlap — NEAR wins
   expect(classifyDepthSlab(1e4)).toBe('NEAR');
   ```

3. **Test extreme cases:**
   ```ts
   // Camera 1 km above a surface
   // Camera at Neptune distance
   // Zero-distance (at body centre)
   ```

### Test Helpers

[`test/helpers/seeded.ts`](../test/helpers/seeded.ts) provides deterministic test utilities. Use it for reproducible random positions or dates.

---

## Running Tests

```bash
# Unit tests (fast, Node)
npm test
npm run test:unit

# Watch mode (re-runs on file changes)
npm run test:watch

# GL tests (slower, needs Chromium)
npm run test:gl

# Everything
npm run test:all
```

### CI Requirements
- `npm run typecheck` must pass
- `npm test` must pass
- `npm run test:gl` must pass (requires headless Chromium)
- No test may be skipped or weakened to pass CI
