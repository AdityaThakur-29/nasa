# 🌌 Solar System Visualization

A high-fidelity, interactive Solar System visualization built with **Three.js** and **TypeScript**. Planetary positions are computed from real [JPL approximate Keplerian elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), orientations follow [IAU rotational models](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc), visual geometry utilizes realistic **3D GLTF/GLB models with embedded PBR textures and rings**, and every physical constant traces to a published citation.

> **Not a toy demo.** This project enforces rigorous data provenance, type-safe time scales, physically-grounded irradiance, and a multi-pass depth-slab pipeline that handles astronomical distance ranges (~10¹⁰) without z-fighting.

![Status: M3 — Interactive HUD & Visual Fidelity Complete](https://img.shields.io/badge/Milestone-M1_%2B_M2_%2B_M3_Complete-emerald)

---

## ✨ Features

- **Realistic 3D Planetary Models & PBR Textures** — GLTF/GLB assets with embedded high-resolution surface textures for the Sun, all 8 planets, Moon, and Pluto
- **PBR Specular-Glossiness Extension Parser** — Custom `GLTFLoader` plugin mapping embedded diffuse textures to Three.js `MeshStandardMaterial`
- **Ring Systems** — Double-sided transparent 3D annular ring geometry for Saturn and Uranus
- **Emissive Stellar Rendering & Unit Normalization** — Glowing Sun geometry with unit sphere normalization, centered pivot, and unlit `MeshBasicMaterial`
- **Interactive 3D Planet Target Reticles** — Screen-projected glowing circles with animated pulses for instant planet discovery from far away
- **Floating Planet Name Badges** — Glassmorphic labels with planetary symbols and names positioned dynamically over every celestial body
- **Top Quick-Selector HUD** — Glassmorphic toolbar with instant click-to-focus navigation for the Sun, planets, Moon, Pluto, and system overview
- **Planet Inspector Data Card** — Floating inspector showing real-time solar distance (km & AU), equatorial radius, and orbital speed
- **Real-Time Simulation Controls** — Play/pause, reverse/forward direction, and 1× to 50000× speed multipliers
- **Scale Mode & Visibility Toggles** — Live switching between Visualized and Scientific scale, plus instant Label and Ring visibility toggles
- **Real Ephemeris** — JPL approximate positions (1800–2050 AD), accurate to published error bounds
- **IAU Orientation** — Pole and prime-meridian models from `pck00011.tpc`
- **Split Julian Date Arithmetic** — Sub-microsecond precision preserved over centuries
- **Type-Branded Time Scales** — `JulianDate<'UTC'>` and `JulianDate<'TT'>` prevent mixing at compile time
- **Multi-Pass Depth Slabs** — NEAR / MIDDLE / FAR frustum partitioning with logarithmic depth buffers
- **Floating Origin** — Camera-relative coordinates eliminate f32 jitter at astronomical distances
- **Multi-Pass Space Lighting** — Directional solar light + balanced ambient illumination across all depth slabs
- **Full Provenance** — Every value cites its source (JPL, IAU, NAIF, Meeus, Espenak & Meeus)
- **Comprehensive Tests** — 14 unit test suites (675 tests) + 2 headless WebGL gate tests

---

## 🏗️ Architecture

The project enforces a **strict one-way data pipeline** — no downstream stage writes back upstream:

```
SimulationState (physical km, km/s, f64)
  → scaleSystem (render units, f64, absolute)
  → CameraRig (camera position, derived FROM scaled system)
  → FloatingOrigin (camera-relative, f64)
  → planDepthSlabs (frustum planes per slab)
  → Render objects / 3D GLB Models (f32 uploads, camera-relative only)
```

### Draw Order (per frame)
1. Clear colour + depth (once)
2. Star field (no depth interaction)
3. Orbit paths (no depth interaction)
4. Depth slabs far → near (depth cleared between, colour preserved)

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** ≥ 22.12.0
- **npm** (comes with Node)

### Installation

```bash
# Clone the repository
git clone https://github.com/AdityaThakur-29/nasa.git
cd nasa

# Install dependencies
npm install
```

### Development

```bash
# Start dev server (http://localhost:5173)
npm run dev
```

### Build

```bash
# Production build
npm run build

# Preview production build
npm run preview
```

### Type Check

```bash
npm run typecheck
```

---

## 🎮 Controls

| Input | Action |
|---|---|
| **Drag** (left button) | Orbit camera around target |
| **Scroll / Pinch** | Zoom (exponential, reversible) |
| **Middle-drag / 2-finger** | Pan camera |
| **Click on Planet / Reticle / Name** | Focus and fly camera directly to body |
| **Double-click** | Focus and track celestial body |
| **Top Navigation Bar** | Instant teleport/fly to any planet or Overview |
| **Bottom Controls Bar** | Play/Pause, speed adjustment (1x–50000x), scale toggle, labels/rings toggle |
| **Arrow keys** | Orbit camera |
| **`+` / `-`** | Zoom in / out |
| **`Escape`** | Clear selection / close info card |
| **`Home`** | Overview (frame whole system) |
| **`Space`** | Pause / resume simulation |

---

## 📁 Project Structure

```
public/
└── models/                 # Realistic 3D GLTF/GLB models & textures
    ├── the_star_sun.glb    # Sun 3D asset (emissive LOD0)
    ├── mercury.glb         # Mercury 3D asset (PBR texture)
    ├── venus.glb           # Venus 3D asset (PBR texture)
    ├── earth.glb           # Earth 3D asset (PBR texture)
    ├── moon.glb            # Moon 3D asset (PBR texture)
    ├── mars.glb            # Mars 3D asset (PBR texture)
    ├── jupiter.glb         # Jupiter 3D asset (PBR texture)
    ├── saturn.glb          # Saturn 3D asset (with rings)
    ├── uranus.glb          # Uranus 3D asset (with rings)
    ├── neptune.glb         # Neptune 3D asset (PBR texture)
    └── pluto.glb           # Pluto 3D asset (PBR texture)

src/
├── main.ts                 # Entry point: DOM, events, interactive HUD & overlay
├── app.ts                  # Orchestrator: scene, pipeline, frame loop, screen projection
│
├── core/                   # Time infrastructure
│   ├── clock.ts            # Simulation clock (rate, direction, scrubbing)
│   └── jd.ts               # Split Julian Date, UTC↔TT conversion, ΔT
│
├── data/                   # Astronomical data (cited, immutable)
│   ├── bodies.ts           # Physical parameters (radii, masses, GM)
│   ├── constants.ts        # Astrodynamic constants (AU, G, L☉, etc.)
│   ├── iau-rotation.ts     # IAU pole/meridian polynomial coefficients
│   ├── jpl-elements.ts     # JPL Keplerian element tables
│   └── sources.md          # Field-level provenance for every value
│
├── ephemeris/              # Position & orientation computation
│   ├── kepler.ts           # Kepler equation solver, orbital mechanics
│   ├── orientation.ts      # Body orientation from IAU models
│   ├── planets.ts          # JPL approximate planet positions
│   └── provider.ts         # Ephemeris provider interface & registry
│
├── sim/                    # Simulation layer (physical → render)
│   ├── irradiance.ts       # Solar irradiance & brightness models
│   ├── scale.ts            # Distance compression & radius exaggeration
│   └── state.ts            # Authoritative physical state of the system
│
└── render/                 # Three.js rendering
    ├── body-visuals.ts     # GLTF model loading, PBR plugin, fallback spheres, lighting
    ├── camera-rig.ts       # Orbit camera with follow/focus modes
    ├── depth-slabs.ts      # 3-slab depth partitioning
    ├── floating-origin.ts  # Camera-relative origin shift
    ├── layered-cameras.ts  # Per-slab PerspectiveCameras + compositing
    ├── layers.ts           # Three.js render layer assignments
    ├── orbit-paths.ts      # Orbit trail rendering (Line2)
    ├── selection.ts        # Screen-space body picking
    └── starfield.ts        # Background star field
```

---

## 🧪 Testing

### Unit Tests (Node, zero WebGL/DOM)
```bash
npm test              # Run all unit tests (675 passed)
npm run test:unit     # Same as above
npm run test:watch    # Watch mode
```

### GL Tests (headless Chromium + WebGL via Playwright)
```bash
npm run test:gl       # Smoke + depth-stress tests
```

### All Tests
```bash
npm run test:all      # Unit + GL
```

---

## 🔬 Scale Modes

| Mode | Distances | Radii | Use Case |
|---|---|---|---|
| **SCIENTIFIC** | True (linear) | True | Physical accuracy |
| **VISUALIZED** | Compressed: `d' = r₀(d/r₀)^0.45` | 8× exaggerated | Legibility & screen presentation |

In Visualized mode, the compression is **monotonic** — orbital ordering is strictly preserved. The interface always discloses active distortions.

---

## 📚 Data Sources

| ID | Source | Used For |
|---|---|---|
| S1 | [JPL Approximate Positions](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Keplerian elements |
| S2 | [JPL Physical Parameters](https://ssd.jpl.nasa.gov/planets/phys_par.html) | Radii, masses, periods |
| S3 | [JPL Astrodynamic Parameters](https://ssd.jpl.nasa.gov/astro_par.html) | AU, GM, obliquity |
| S4 | [NAIF pck00011.tpc](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/) | IAU rotation models |
| S5 | IAU 2015 Resolution B3 | Solar luminosity & radius |
| S6 | Espenak & Meeus | ΔT polynomials |
| S7 | Meeus, *Astronomical Algorithms* | Calendar ↔ JD conversion |

Full field-level provenance: [`src/data/sources.md`](src/data/sources.md)

---

## 🗺️ Roadmap Progress

- **M1** ✅ Core simulation, ephemeris, rendering pipeline
- **M2** ✅ Visual Fidelity (3D GLTF models, PBR textures, Saturn/Uranus rings, emissive Sun)
- **M3** ✅ Glassmorphic HUD, interactive planet reticles, name badges, time controls, inspector card
- **M4** 🔲 ELP2000 lunar theory, asteroid belt, satellite mean elements
- **M5** 🔲 WebGPU renderer, performance optimization & LOD

---

## 📄 License

Private project.
