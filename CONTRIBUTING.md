# Contributing to Solar System Visualization

Thank you for considering contributing. This project has strict requirements around data integrity, architecture, and testing. Please read this fully before opening a PR.

---

## Before You Start

1. **Read [`AGENTS.md`](AGENTS.md)** — architecture rules, layer boundaries, and common pitfalls
2. **Read [`src/data/sources.md`](src/data/sources.md)** — provenance requirements for every data value
3. **Read [`ROADMAP.md`](ROADMAP.md)** — check which milestone your feature belongs to
4. **Run the full test suite** before and after your changes

---

## Development Setup

```bash
# Prerequisites: Node.js >= 22.12.0
npm install
npm run dev          # Dev server on http://localhost:5173
npm run typecheck    # TypeScript strict-mode check
npm test             # Unit tests (Node)
npm run test:gl      # GL tests (headless Chromium)
npm run test:all     # Everything
```

---

## Rules

### 1. Never Modify Physical Data Without a Citation
Every value in `src/data/` traces to a published source (S1–S7). If you need to change or add a physical constant:
- Find the published value and its citation
- Add the source to `src/data/sources.md` if it's new
- Use the `Measured` interface to carry uncertainty alongside the value

### 2. Respect the One-Way Pipeline
```
src/data/ → src/ephemeris/ → src/sim/ → src/render/
```
- **Never import from a downstream layer.** `src/sim/` must not import from `src/render/`. `src/data/` must not import from anywhere except other data files.
- The render layer reads simulation output via snapshots. It never writes back.

### 3. Write Tests First
- Every physical computation needs a test with tolerance-based assertions
- Prefer invariant tests (monotonicity, conservation, ordering) over point-value checks
- Unit tests must run in Node with zero WebGL and zero DOM
- GL tests are for render-state verification only, never for numerical correctness

### 4. Document Non-Obvious Choices
- Module headers explain **what the module owns** and **why its boundaries are where they are**
- When a constant has a non-obvious value, document the measurement or derivation
- Preserve all existing comments unrelated to your change

### 5. Use Correct Vocabulary
- ✅ MODEL, COMPUTED, APPROXIMATE, DERIVED
- ❌ measured, live, exact, telemetry, real-time

### 6. TypeScript Strict Mode
The project uses every available strict check:
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- `verbatimModuleSyntax`, `isolatedModules`

Your code must pass `npm run typecheck` without errors.

---

## Commit Messages

Use conventional format:
```
feat(ephemeris): add ELP2000 lunar theory provider
fix(render): correct slab layer assignment for FAR pass
test(scale): add monotonicity check for compression law
docs(sources): add S8 citation for lunar elements
refactor(clock): extract rate clamping into helper
```

---

## Pull Request Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all unit tests)
- [ ] `npm run test:gl` passes (if render changes)
- [ ] New code has tests
- [ ] No physical data added without a citation
- [ ] No downstream imports from upstream layers
- [ ] Existing comments and docstrings preserved
- [ ] ROADMAP.md updated if a feature is completed
