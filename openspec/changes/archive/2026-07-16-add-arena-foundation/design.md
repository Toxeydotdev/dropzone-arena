## Context

The new repository adapts the engineering harness from Craps Arcade but not its
Discord, server, transport, or dice domain. A shooter needs a persistent game
loop, many short-lived entities, direct input, and a renderer lifecycle. Those
concerns must remain testable without pushing frame state through React or
making WebGL part of game authority.

## Goals / Non-Goals

**Goals:**

- Reach meaningful play in one activation with no identity or network step.
- Keep rules deterministic under explicit input, seed, and fixed elapsed time.
- Support keyboard/mouse and coarse-pointer touch layouts.
- Pause safely on interruption and expose all important state in semantic DOM.
- Bound simulation catch-up, entity pressure, pixel ratio, and renderer cleanup.

**Non-Goals:**

- Multiplayer, backend authority, persistence, accounts, telemetry, progression,
  audio, controller support, or a general-purpose game framework.
- Pixel-identical rendering across GPUs or simulation through React state.

## Decisions

### Use an enforced three-layer graph

`web` imports `arena-client`, and `arena-client` imports `arena-engine`. The
engine imports no browser package. A root graph check rejects undeclared edges.
The web app stays a replaceable entry shell, while client composition owns all
browser behavior behind a runtime driver interface.

### Run a pure fixed-step simulation

The engine returns a new serializable state for each explicit `1/60` second
step. A state-carried integer PRNG supplies spawn variation. The runtime caps
frame delta and catch-up steps after throttling. Movement, weapon cadence,
collision, damage, scoring, pickups, and terminal state therefore depend on
simulation steps rather than display frame rate or wall time.

### Keep Three.js imperative and React coarse-grained

One runtime owns requestAnimationFrame, Three.js resources, entity mesh maps,
camera response, pointer projection, keyboard state, and touch input values.
React receives a bounded HUD snapshot and immediate stage transitions only. It
never renders an entity list or advances the game.

### Treat rendering as progressive presentation

The runtime dynamically imports Three.js implementation after the shell mounts.
Construction failure and context loss produce a named HTML failure state with a
retry action. The canvas has a descriptive accessible label, while health,
time, score, objective, pause, and outcomes remain DOM content. Reduced motion
removes camera shake and particle volume without changing rule timing.

### Pause rather than simulate hidden time

Escape, `P`, blur, and document hiding suspend simulation immediately and clear
held fire. Resume starts from the same engine state and resets the frame clock,
so hidden time cannot damage the player or consume the run timer.

### Use one finite solo mode

Each run lasts at most 90 seconds. Spawn pressure increases across five waves.
The run ends in defeat at zero health or extraction when the clock reaches zero.
The debrief reports score, eliminations, accuracy, and survival outcome and can
start a fresh seeded run without page navigation.

## Risks / Trade-offs

- [Immutable state can create garbage per step] -> Keep the entity cap small,
  use shallow record copies, and profile before adding an ECS or mutation model.
- [WebGL may fail] -> Keep startup and failure in semantic HTML, dispose partial
  resources, and allow an explicit retry without losing application control.
- [Touch controls can obscure play] -> Reserve safe lower corners, keep two
  bounded sticks plus a distinct dash control, and test narrow portrait layout.
- [A local engine cannot prevent cheating] -> Make no competitive or authority
  claim. Any multiplayer work requires a separate server-authority design.

## Migration Plan

This is a new repository with no user data or deployed compatibility surface.
Build the harness, engine, runtime, shell, tests, and docs; run the complete
gate; then archive the foundation change into the current specification.

## Open Questions

No question blocks the local foundation. Audio, controller support, additional
weapons, and multiplayer remain separate product decisions.
