# Arena Client Agent Guide

This file applies to `libs/arena-client`. Follow the root `AGENTS.md` as well.

## Boundaries

- Import only the public API from `@dropzone-arena/arena-engine`.
- Own browser input, React composition, Three.js presentation, responsive HUD,
  reduced effects, and runtime lifecycle.
- Do not put simulation rules, spawn outcomes, damage, score, or collision
  authority in React or renderer code.
- Keep the runtime behind `ArenaRuntimeDriver`; component tests inject a fake.

## Runtime

- One imperative owner controls animation frames, listeners, input state,
  renderer resources, entity meshes, and fixed-step accumulation.
- Cap delta, catch-up steps, device pixel ratio, effects, and entity meshes.
- Pause and clear held input on blur or hidden documents. Reset the frame clock
  on resume.
- Dispose animation frames, observers, listeners, geometry, materials, scene
  objects, and WebGL resources exactly once.

## UI

- Keep health, time, wave, score, combo, dash, pause, errors, and outcomes in DOM.
- Use the Signal Yard visual language from `docs/design-system.md`.
- Preserve visible focus, 44px actions, safe areas, reduced motion, non-color
  status, and no horizontal overflow from 320 CSS pixels upward.
