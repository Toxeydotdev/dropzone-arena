# Dropzone Arena Agent Guide

This file applies to the entire repository. A scoped `AGENTS.md` adds local
rules; follow both, with the nearest file taking precedence.

## Mission

Build a fast, legible browser arena shooter that starts without an account,
download, lobby, or tutorial wall. A run should teach through play, recover
cleanly from interruption, and remain usable on desktop and touch layouts.

## Sources Of Truth

Use repository knowledge in this order:

1. `openspec/specs/` for current required behavior.
2. An active package under `openspec/changes/` for an approved change.
3. `docs/` for current architecture, design, testing, and quality knowledge.
4. The nearest `AGENTS.md` for implementation guidance.
5. Code and tests for details that do not conflict with those sources.

## Required Workflow

1. Read the relevant specs, docs, and scoped guidance before editing.
2. Inspect the Nx project graph and existing patterns rather than inferring boundaries.
3. Create or update an OpenSpec change for material behavior or architecture.
4. Implement the smallest coherent change through engine, runtime, shell, and tests.
5. Test observable behavior at the highest practical real boundary.
6. Review documentation impact and update durable knowledge.
7. Run `npm run check`; required stages may not be skipped.

Do not hand-edit OpenSpec-generated files under `.opencode/`. Regenerate them
with `npm exec openspec update`.

## Architecture Boundaries

- `apps/web` owns the entrypoint and web composition. It imports only the public
  API from `@dropzone-arena/arena-client`.
- `libs/arena-client` owns React composition, input, audio, Three.js rendering,
  and the browser runtime. It imports only `@dropzone-arena/arena-engine`.
- `libs/arena-engine` is a platform-neutral fixed-step simulation. It never
  reads time, randomness, DOM APIs, network, storage, React, or Three.js.
- `apps/web-e2e` exercises the built application through user-visible behavior.

React owns menus and coarse HUD snapshots. Per-frame entity state and rendering
stay in the runtime. Do not drive the simulation through React state.

## Gameplay Integrity

- Feed elapsed time, random seeds, and player input into the engine explicitly.
- Keep simulation steps fixed and cap frame catch-up after throttling or resume.
- Keep collision outcomes deterministic for the same seed and input sequence.
- Pause on hidden or blurred documents; never let a background tab silently end a run.
- Keep hit, damage, score, objective, pause, and game-over state understandable
  without color alone.
- Do not add accounts, telemetry, advertising, purchases, loot boxes, or
  persistent identity without an approved product and privacy change.

## Toolchain

- Use the Node/npm versions declared by `.nvmrc`, `package.json`, and `devEngines`.
- Install with `npm ci`. Add dependencies with `npm install --save-exact`.
- Run project tasks through Nx.
- oxlint and oxfmt are authoritative. Do not add ESLint or Prettier.
- Keep `npm run check` deterministic and independent of network services.

## Frontend And Design

- Preserve the Signal Yard direction in `docs/design-system.md`; do not turn the
  game into a generic dashboard or neon-purple sci-fi template.
- Support keyboard/mouse, touch, narrow mobile, reduced motion, high contrast,
  safe areas, and visible focus.
- Keep touch targets at least 44px and gameplay controls away from browser-safe edges.
- Canvas is enhancement, not semantics. Expose status, controls, errors, and run
  outcomes through accessible HTML.

## Testing

- Unit-test deterministic engine rules with explicit seeds and fixed steps.
- Test React through roles, labels, and visible output rather than internals.
- Use Playwright against a production build for critical start, play, pause,
  restart, responsive, keyboard, touch, reduced-motion, and accessibility paths.
- Use web-first assertions and never arbitrary sleeps.

## Documentation

- Behavioral requirements: `openspec/specs/` through an OpenSpec change.
- Current component and data flow: `docs/architecture.md`.
- Visual and interaction rules: `docs/design-system.md`.
- Deterministic seams and browser coverage: `docs/testing.md`.
- Commands, CI, and caching: `docs/quality.md`.

Do not claim a command passed unless it was run in the current worktree.
