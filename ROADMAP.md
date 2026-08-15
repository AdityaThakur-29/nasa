# 🗺️ Solar System Visualization — Roadmap

This document tracks the project's milestones, planned features, and technical debt.

---

## Milestones

### ✅ M1 — Core Simulation

> Foundational pipeline: ephemeris, simulation, rendering, testing.

| Feature | Status | Notes |
|---------|--------|-------|
| JPL approximate planet positions (1800–2050) | ✅ Done | Table 1 elements, accuracy validated |
| JPL wide-range positions (3000 BC – 3000 AD) | ✅ Done | Table 2a with augmentation terms |
| IAU rotational models (pole + meridian) | ✅ Done | pck00011.tpc, all planets + Sun |
| Split Julian Date arithmetic | ✅ Done | Sub-microsecond precision over centuries |
| UTC ↔ TT conversion (ΔT polynomials) | ✅ Done | Full Espenak & Meeus set |
| Simulation clock (rate, direction, scrub) | ✅ Done | 1× to 50000×, range-clamped |
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

### ✅ M2 — Visual Fidelity & 3D Assets

> Realistic appearance: 3D models, PBR textures, rings, atmosphere.

| Feature | Status | Description |
|---------|--------|-------------|
| 3D planetary models & textures | ✅ Done | Realistic GLTF/GLB models with embedded high-res PBR maps for Sun, 8 planets, Moon, Pluto |
| PBR Specular-Glossiness parsing | ✅ Done | Custom `GLTFLoader` extension plugin maps embedded diffuse textures to `MeshStandardMaterial` |
| Saturn ring geometry | ✅ Done | Integrated 3D annular ring mesh with double-sided transparency in `saturn.glb` |
| Uranus ring geometry | ✅ Done | Integrated 3D ring system with double-sided rendering in `uranus.glb` |
| Emissive Sun rendering & normalization | ✅ Done | Unit radius normalization, LOD0 extraction, emissive star glow without dark artifacts |
| Dynamic Lambertian irradiance | ✅ Done | Automatic traversal and base color scaling for GLTF materials |
| Multi-pass ambient space lighting | ✅ Done | Layered `AmbientLight` enabled across all depth-slab passes (1, 2, 3) for realistic dark-side visibility |
| Oblate spheroids | ✅ Done | Jupiter and Saturn flattening applied via IAU radii |
| Day/night terminator | 🔲 Planned | Sun angular diameter sets softness |
| Atmospheric scattering | 🔲 Planned | Thin-shell Rayleigh scattering shader for Earth & gas giants |
| Shadow mapping (eclipses) | 🔲 Planned | Earth shadow on Moon, planet shadows on rings |
| Axial tilt visualization | 🔲 Planned | Pole indicator lines |

**Technical notes:**
- Models placed in `public/models/` and loaded asynchronously via `GLTFLoader`
- `Group` container encapsulation ensures scale/position matrices do not overwrite internal model centering
- Depth-slab layer masks are recursively applied to all child meshes for artifact-free multi-pass rendering
- Graceful fallback to analytical unit sphere meshes when models are loading or unavailable

---

### ✅ M3 — User Interface & Navigation

> Glassmorphic HUD, interactive celestial overlay, data panels, time controls.

| Feature | Status | Description |
|---------|--------|-------------|
| Interactive planet target reticles | ✅ Done | Projected screen-space glowing rings with animated pulses for instant discovery from far away |
| Dynamic planet name badges | ✅ Done | Floating glassmorphic badges with planet symbols and names above each celestial body |
| Top quick-selector HUD | ✅ Done | Click-to-focus navigation bar for Sun, all 8 planets, Moon, Pluto, and full system overview |
| Planet inspector data card | ✅ Done | Real-time distance (million km & AU), equatorial radius, orbital velocity, and fly button |
| Simulation time toolbar | ✅ Done | Play/pause toggle, reverse/forward direction, and 1x to 50000x rate presets |
| Scale mode toggle | ✅ Done | Live switching between Visualized and Scientific scale with disclosure |
| Visibility controls | ✅ Done | Instant toggles for Labels (on/off) and Reticles/Rings (on/off) |
| Distance measurement tool | 🔲 Planned | Centre-to-centre, surface-to-surface (physical km) |
| Keyboard shortcut overlay | 🔲 Planned | Discoverable controls modal |
| Responsive mobile layout | ✅ Done | Touch-friendly HUD with horizontal scroll and tap-to-focus |

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
| Dwarf planets (Pluto, Eris) | 🔲 Planned | Extended element tables (Pluto 3D model ready) |
| Lagrange points | 🔲 Planned | Computed from two-body GM values |
| Spacecraft trajectories | 🔲 Planned | SPICE kernel reader or tabulated data |

---

### 🔲 M5 — Performance & Polish

> Optimisation, accessibility, deployment.

| Feature | Status | Description |
|---------|--------|-------------|
| WebGPU renderer option | 🔲 Planned | Three.js WebGPURenderer for capable browsers |
| LOD system | 🔲 Planned | Progressive switching of mesh LODs based on apparent pixels |
| Texture streaming & KTX2 | 🔲 Planned | Compressed GPU textures |
| Service worker caching | 🔲 Planned | Offline model caching |
| ARIA accessibility | 🔲 Partial | Screen reader support for live provenance & alerts |
| Reduced motion support | ✅ Done | `prefers-reduced-motion` integration |
| PWA manifest | 🔲 Planned | Installable app |
| SEO & Open Graph | 🔲 Planned | Meta tags, social preview |
| CI/CD pipeline | 🔲 Planned | Automated test + deploy on push |

---

## Technical Debt

| Item | Priority | Description |
|------|----------|-------------|
| Velocity via central differencing | Low | Works well and tested; analytic derivative would be complex |
| ΔT prediction error (6s at 2026) | Low | Not the limiting term; model error is 6000 km |
| Neptune rotation period conflict (S2 vs S4) | Low | Documented, S4 rate used for orientation |
| No CI configuration | Medium | Add GitHub Actions for typecheck + test on push |

---

## Contributing

Before implementing a feature:
1. Read [`AGENTS.md`](AGENTS.md) for architecture rules
2. Read [`src/data/sources.md`](src/data/sources.md) for provenance requirements
3. Check this roadmap for the planned milestone
4. Write tests first — especially for any physical computation
5. Never modify physical data without a published citation
