# 🌌 Solar System Visualization

A high-fidelity, interactive Solar System visualization built with **Three.js** and **TypeScript**. Planetary positions are computed from real [JPL approximate Keplerian elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), orientations follow [IAU rotational models](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc), and every physical constant traces to a published citation.

> **Not a toy demo.** This project enforces rigorous data provenance, type-safe time scales, physically-grounded irradiance, and a multi-pass depth-slab pipeline that handles astronomical distance ranges (~10¹⁰) without z-fighting.

![Status: M1 — Core Simulation](https://img.shields.io/badge/Milestone-M1_Core_Simulation-blue)

---

## ✨ Features

- **Real ephemeris** — JPL approximate positions (1800–2050 AD), accurate to published error bounds
- **IAU orientation** — pole and prime-meridian models from `pck00011.tpc`
- **Split Julian Date arithmetic** — sub-microsecond precision preserved over centuries
- **Type-branded time scales** — `JulianDate<'UTC'>` and `JulianDate<'TT'>` prevent mixing at compile time
- **Dual scale modes** — Scientific (true proportions) and Visualized (compressed distances, exaggerated radii)
- **Multi-pass depth slabs** — NEAR / MIDDLE / FAR frustum partitioning with logarithmic depth buffers
- **Floating origin** — camera-relative coordinates eliminate f32 jitter at large distances
- **Physical irradiance** — inverse-square from IAU nominal luminosity, with perceptual compression option
- **Full provenance** — every value cites its source (JPL, IAU, NAIF, Meeus, Espenak & Meeus)
- **Comprehensive tests** — 14 unit test suites + 2 headless WebGL gate tests

---

## 🏗️ Architecture

The project enforces a **strict one-way data pipeline** — no downstream stage writes back upstream:

```
SimulationState (physical km, km/s, f64)
  → scaleSystem (render units, f64, absolute)
  → CameraRig (camera position, derived FROM scaled system)
  → FloatingOrigin (camera-relative, f64)
  → planDepthSlabs (frustum planes per slab)
  → Render objects (f32 uploads, camera-relative only)
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

| Input                    | Action                          |
|--------------------------|---------------------------------|
| **Drag** (left button)   | Orbit camera                    |
| **Scroll / Pinch**       | Zoom (exponential, reversible)  |
| **Middle-drag / 2-finger** | Pan                           |
| **Click**                | Select body                     |
| **Double-click**         | Focus (fly to body)             |
| **Arrow keys**           | Orbit camera                    |
| **`+` / `-`**            | Zoom in / out                   |
| **`Escape`**             | Clear selection                 |
| **`Home`**               | Overview (frame whole system)   |
| **`Space`**              | Pause / resume simulation       |

---

## 📁 Project Structure

```
src/
├── main.ts                 # Entry point: DOM, events, input wiring
├── app.ts                  # Orchestrator: scene, pipeline, frame loop
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
    ├── body-visuals.ts     # Planet spheres, Sun glow, markers
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
npm test              # Run all unit tests
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

**14 unit test files** cover: Julian Date arithmetic, clock, Kepler equation, planet positions, IAU orientation, physical data cross-validation, scale transforms, irradiance, simulation state, depth slabs, floating origin, layered cameras, selection, and render objects.

**2 GL test files** cover: basic render smoke test and extreme-camera depth-stress scenarios.

---

## 🔬 Scale Modes

| Mode | Distances | Radii | Use Case |
|------|-----------|-------|----------|
| **SCIENTIFIC** | True (linear) | True | Physical accuracy |
| **VISUALIZED** | Compressed: `d' = r₀(d/r₀)^0.45` | 8× exaggerated | Legibility |

In Visualized mode, the compression is **monotonic** — orbital ordering is preserved. The interface always discloses active distortions.

---

## 📚 Data Sources

| ID | Source | Used For |
|----|--------|----------|
| S1 | [JPL Approximate Positions](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Keplerian elements |
| S2 | [JPL Physical Parameters](https://ssd.jpl.nasa.gov/planets/phys_par.html) | Radii, masses, periods |
| S3 | [JPL Astrodynamic Parameters](https://ssd.jpl.nasa.gov/astro_par.html) | AU, GM, obliquity |
| S4 | [NAIF pck00011.tpc](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/) | IAU rotation models |
| S5 | IAU 2015 Resolution B3 | Solar luminosity & radius |
| S6 | Espenak & Meeus | ΔT polynomials |
| S7 | Meeus, *Astronomical Algorithms* | Calendar ↔ JD conversion |

Full field-level provenance: [`src/data/sources.md`](src/data/sources.md)

---

## ⚠️ Known Limitations (M1)

| Limitation | Impact | Resolution |
|------------|--------|------------|
| Moon has no position | Appears in "unavailable" list | M4: ELP2000 lunar theory |
| Earth at Earth/Moon barycentre | Offset up to 4670 km | M4: lunar theory separates them |
| No ring geometry | Saturn/Uranus shown without rings | M2: ring shadow geometry |
| No atmospheric effects | No scattering, no glow halos | M2: atmospheric rendering |
| No asteroid belt | Missing between Mars and Jupiter | M4: instanced rendering |
| ΔT prediction divergence | ~6s error at 2026 (75s vs 69s observed) | Non-limiting (model error is 6000 km) |

---

## 🗺️ Roadmap

- **M1** ✅ Core simulation, ephemeris, rendering pipeline
- **M2** 🔲 Ring geometry, atmospheric effects, terminator shading
- **M3** 🔲 Material Design 3 interface, data overlay panels
- **M4** 🔲 ELP2000 lunar theory, asteroid belt, satellite mean elements

---

## 📄 License

Private project.
