# Arena Engine Agent Guide

This file applies to `libs/arena-engine`. Follow the root `AGENTS.md` as well.

## Purity Boundary

- Accept all input, elapsed time, and random seed state explicitly.
- Never read browser APIs, wall time, `Math.random`, environment, network,
  storage, React, Three.js, or mutable application singletons.
- Return a new state and do not mutate the caller's state or input.
- Keep world coordinates and collision rules independent of presentation.

## Simulation

- The runtime supplies fixed `1/60` second steps. Keep behavior deterministic
  for the same initial state and input sequence.
- Use stable IDs and serializable records for players, enemies, projectiles,
  pickups, events, and statistics.
- Keep spawn pressure and terminal conditions bounded. A long frame must not
  become an implicit difficulty or weapon-cadence change.
- Test movement, collision, weapon cadence, damage, dash immunity, scoring,
  spawning, pickups, completion, and seeded repeatability.
