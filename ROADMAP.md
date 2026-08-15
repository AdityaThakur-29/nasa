# 🗺️ Solar System Visualization — Roadmap

This document tracks the project's milestones, planned features, and technical debt.

---

## Milestones

### ✅ M1 — Core Simulation (Current)

> Foundational pipeline: ephemeris, simulation, rendering, testing.

| Feature | Status | Notes |
|---------|--------|-------|
| JPL approximate planet positions (1800–2050) | ✅ Done | Table 1 elements, accuracy validated |
| JPL wide-range positions (3000 BC – 3000 AD) | ✅ Done | Table 2a with augmentation terms |
| IAU rotational models (pole + meridian) | ✅ Done | pck00011.tpc, all planets + Sun |
| Split Julian Date arithmetic | ✅ Done | Sub-microsecond precision over centuries |
| UTC ↔ TT conversion (ΔT polynomials) | ✅ Done | Full Espenak & Meeus set |
| Simulation clock (rate, direction, scrub) | ✅ Done | 1× to 10⁹×, range-clamped |
| Physical data with full provenance | ✅ Done | S1–S7 citations, uncertainty carried |
| Dual scale modes (Scientific + Visualized) | ✅ Done | Monotonic compression, disclosure |
| Solar irradiance model | ✅ Done | Physical + perceptual brightness |
| Multi-pass depth-slab rendering | ✅ Done | NEAR / MIDDLE / FAR, log depth |
| Floating origin | ✅ Done | Eliminates f32 jitter |
| Orbit path rendering (Line2) | ✅ Done | Sampled from the element model |
| Star field background | ✅ Done | Depth-independent pass |
| Camera rig (orbit, dolly, pan, focus) | ✅ Done | Eased transitions, follow mode |
| Screen-space body selection | ✅ Done | Click + double-click focus |
| Keyboard controls | ✅ Done | Arrows, +/-, Escape, Home, Space |
| Touch support (pinch, pan, tap) | ✅ Done | Threshold-based drag vs. tap |
| Provenance strip (always visible) | ✅ Done | Scale, model, status disclosure |
| Unit test suite (14 files) | ✅ Done | Node, zero WebGL |
| GL gate tests (2 files) | ✅ Done | Headless Chromium, depth stress |

---

### 🔲 M2 — Visual Fidelity

> Realistic appearance: surface shading, rings, atmosphere.

| Feature | Status | Description |
|---------|--------|-------------|
| Planetary textures | 🔲 Planned | NASA/USGS texture maps for each body |
| Saturn ring geometry | 🔲 Planned | Annular ring mesh with shadow casting |
| Uranus ring geometry | 🔲 Planned | Narrow ring system |
| Day/night terminator | 🔲 Planned | Sun angular diameter sets softness |
| Atmospheric scattering | 🔲 Planned | Thin-shell approximation for Earth, gas giants |
| Sun glow / corona | 🔲 Planned | Bloom post-processing or billboard |
| Shadow mapping (eclipses) | 🔲 Planned | Earth shadow on Moon, planet shadows on rings |
| Oblate spheroids | 🔲 Planned | Jupiter and Saturn flattening from IAU radii |
| Axial tilt visualization | 🔲 Planned | Pole indicator lines |

**Technical notes:**
- Terminator softness derived from `solarAngularDiameterDeg()` (already computed in M1)
- Ring shadow requires an oblate intersection test (Saturn flattening 0.098)
- Textures must not be added as uncited assets — source and license must be documented

---

### 🔲 M3 — User Interface

> Material Design 3 interface, data panels, time controls.

| Feature | Status | Description |
|---------|--------|-------------|
| M3 design system | 🔲 Planned | Tokens, typography, colour scheme |
| Body info panel | 🔲 Planned | Physical data, provenance, distance, irradiance |
| Time control bar | 🔲 Planned | Play/pause, rate presets, scrub slider, date input |
| Scale mode toggle | 🔲 Planned | Scientific / Visualized with disclosure |
| Brightness mode toggle | 🔲 Planned | Physical / Perceptual with disclosure |
| Body list / selector | 🔲 Planned | Click-to-focus for all planets |
| Settings panel | 🔲 Planned | Pixel ratio, orbit visibility, grid |
| Distance measurement tool | 🔲 Planned | Centre-to-centre, surface-to-surface (physical km) |
| Keyboard shortcut overlay | 🔲 Planned | Discoverable controls |
| Responsive layout | 🔲 Planned | Mobile-first, panel collapse |

**Technical notes:**
- `FrameReport` and `SimulationSnapshot` already carry all data the panels need
- `ClockSnapshot` has `formattedUtc`, `scrubFraction`, `rate`, `deltaT` for time controls
- `ScaleDescription` and `BrightnessDescription` provide disclosure text
- Interface must never call `matchMedia` — values are injected from `main.ts`

---

### 🔲 M4 — Extended Solar System

> Lunar theory, satellites, asteroids, comets.

| Feature | Status | Description |
|---------|--------|-------------|
| ELP2000 lunar theory | 🔲 Planned | Moon position from a proper lunar theory |
| Earth/Moon separation | 🔲 Planned | Requires lunar theory to resolve barycentre |
| Major moons (Galilean, Titan, etc.) | 🔲 Planned | Satellite mean elements or DE440 interpolation |
| Asteroid belt | 🔲 Planned | Instanced rendering (~10k objects) |
| Named asteroids (Ceres, Vesta, etc.) | 🔲 Planned | Individual orbital elements |
| Comets (Halley, etc.) | 🔲 Planned | Hyperbolic/parabolic orbit support |
| Dwarf planets (Pluto, Eris) | 🔲 Planned | Extended element tables |
| Lagrange points | 🔲 Planned | Computed from two-body GM values |
| Spacecraft trajectories | 🔲 Planned | SPICE kernel reader or tabulated data |

**Technical notes:**
- `ProviderRegistry` already supports multiple providers — register `ELP2000Provider` alongside `JplApproximatePlanetsProvider`
- Moon position moves it from `unavailable` to `bodies` with no pipeline change
- Asteroid belt needs instanced rendering — `BodyVisuals` pattern won't scale to 10k objects
- `satelliteOffsetFactors` in `ScaleConfig` allow per-subsystem offset scaling for tight satellite systems

---

### 🔲 M5 — Performance & Polish

> Optimisation, accessibility, deployment.

| Feature | Status | Description |
|---------|--------|-------------|
| WebGPU renderer option | 🔲 Planned | Three.js WebGPURenderer for capable browsers |
| LOD system | 🔲 Planned | Reduce geometry for distant bodies |
| Texture streaming | 🔲 Planned | Progressive loading of high-res textures |
| Service worker caching | 🔲 Planned | Offline support |
| ARIA accessibility | 🔲 Planned | Screen reader support for data panels |
| Reduced motion support | 🔲 Partial | `prefers-reduced-motion` already read, needs wider application |
| PWA manifest | 🔲 Planned | Installable app |
| SEO & Open Graph | 🔲 Planned | Meta tags, social preview |
| CI/CD pipeline | 🔲 Planned | Automated test + deploy on push |
| Performance monitoring | 🔲 Planned | Frame budget tracking, GPU memory |

---

## Technical Debt

| Item | Priority | Description |
|------|----------|-------------|
| Velocity via central differencing | Low | Works well and tested; analytic derivative would be complex but slightly faster |
| ΔT prediction error (6s at 2026) | Low | Not the limiting term; model error is 6000 km |
| Neptune rotation period conflict (S2 vs S4) | Low | Documented, S4 rate used for orientation |
| `scripts/` directory empty | Low | Add build/deployment scripts as needed |
| No CI configuration | Medium | Add GitHub Actions for typecheck + test on push |
| No `.env` / config file | Low | Hardcoded epoch and scale defaults are fine for now |

---

## Contributing

Before implementing a feature:
1. Read [`AGENTS.md`](AGENTS.md) for architecture rules
2. Read [`src/data/sources.md`](src/data/sources.md) for provenance requirements
3. Check this roadmap for the planned milestone
4. Write tests first — especially for any physical computation
5. Never modify physical data without a published citation
