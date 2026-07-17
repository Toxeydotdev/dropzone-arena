## 1. Repository Harness

- [x] 1.1 Initialize the repository, pinned npm graph, Nx workspace, strict TypeScript, Oxc formatting/linting, OpenSpec/OpenCode workflows, CI, and root commands.
- [x] 1.2 Add root and scoped agent guidance, enforced project boundaries, architecture, Signal Yard design, testing, quality, and setup documentation.

## 2. Deterministic Arena Engine

- [x] 2.1 Implement serializable fixed-step state, seeded spawning, player movement, directional fire, dash, enemies, projectiles, obstacles, pickups, score, combo, and finite run outcomes.
- [x] 2.2 Test repeatability, immutable transitions, movement bounds, weapon cadence, dash behavior, and extraction with explicit seeds and steps.

## 3. Browser Runtime And Surface

- [x] 3.1 Implement the runtime-driver boundary, bounded animation accumulator, keyboard/mouse and touch input, pause lifecycle, HUD snapshots, and complete disposal.
- [x] 3.2 Implement the Three.js Signal Yard arena, entity synchronization, camera response, feedback effects, resize behavior, reduced effects, and context-loss handling.
- [x] 3.3 Implement the responsive React ready, loading, playing, paused, unavailable, and debrief surfaces with semantic HUD and touch controls.

## 4. Verification

- [x] 4.1 Add focused component tests through a fake runtime driver for start, HUD, pause, unavailable, debrief, restart, and reduced motion.
- [x] 4.2 Add production-build Playwright journeys for immediate entry, keyboard play, pause/resume, touch layout, reduced motion, overflow, and accessibility.
- [x] 4.3 Run formatting, boundaries, lint, typecheck, unit tests, strict OpenSpec validation, production build, and browser E2E through `npm run check`.
