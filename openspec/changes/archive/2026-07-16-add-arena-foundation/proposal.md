## Why

Browser shooters commonly put account, download, lobby, or tutorial friction in
front of the first meaningful action. This repository needs a playable
foundation that opens directly into a short, legible arena run while retaining
the deterministic quality and agent harness proven in Craps Arcade.

## What Changes

- Create a pinned Nx/React/Vite/TypeScript workspace with Oxc quality gates,
  OpenSpec workflows, scoped agent guidance, Vitest, Playwright, and CI.
- Add a pure fixed-step arena engine with seeded bot spawning, movement, aiming,
  projectiles, collisions, dash, pickups, escalating pressure, score, and a
  finite 90-second extraction condition.
- Add an imperative Three.js runtime with keyboard/mouse and touch input,
  bounded frame catch-up, complete resource disposal, pause on interruption,
  reduced effects, and visible WebGL failure recovery.
- Add a responsive Signal Yard React shell with an immediate drop action,
  semantic HUD, pause state, debrief, restart, and accessible controls.
- Verify engine rules, shell states, production build journeys, mobile layout,
  reduced motion, and serious accessibility violations.

Non-goals are multiplayer, accounts, matchmaking, backend authority, persistence,
telemetry, audio, user-generated maps, progression, purchases, rewards, or
production deployment configuration.

## Capabilities

### New Capabilities

- `arena-run`: Start, play, pause, complete, and restart a deterministic local
  arena run through desktop or touch controls with progressive 3D presentation.

### Modified Capabilities

None.

## Impact

- Creates `apps/web`, `apps/web-e2e`, `libs/arena-client`, and
  `libs/arena-engine` with an enforced one-way dependency graph.
- Adds React and Three.js production dependencies plus pinned Nx, Vite, Vitest,
  Playwright, Oxc, and OpenSpec development dependencies.
- Establishes current architecture, design, testing, and quality documentation.
- Produces one static browser artifact under `dist/apps/web` and requires no
  service, account, external asset, or environment secret.
