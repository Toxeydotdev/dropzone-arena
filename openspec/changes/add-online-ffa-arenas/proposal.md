## Why

Dropzone Arena currently supports only local solo runs, so players cannot share the arena or build the drop-in competition implied by the product. Add an optional online mode that preserves instant solo play while introducing low-friction, server-authoritative free-for-all arenas for anonymous players.

## What Changes

- Add anonymous public quickplay that assigns a player to an available continuous arena without an account, room code, prematch lobby, or skill-based matchmaking.
- Add server-authoritative free-for-all simulation for up to eight concurrent players per arena, including movement, firing, damage, elimination attribution, safe spawning, three-second automatic respawn, and session kills/deaths.
- Allow players to join and leave a live arena without rounds or global match resets. Empty arenas expire, and process restart may end ephemeral sessions.
- Add a versioned realtime protocol with bounded input rates, authoritative snapshots, client prediction for the local player, interpolation for remote players, reconciliation, reconnect grace, and visible failure/retry behavior.
- Keep the existing 90-second local bot run as the primary immediate action and a usable fallback when online service is unavailable.
- Add a split production topology: immutable static web assets on a CDN and one always-on Railway service for HTTP health, anonymous admission, room assignment, and WebSocket authority.
- Add deterministic engine, protocol, server integration, browser, deployed health, responsive, accessibility, interruption, and reconnect coverage.
- Update architecture, design-system, testing, quality, and deployment documentation for online ownership, privacy, failure, promotion, and rollback boundaries.

Gameplay impact: online play is a separate continuous FFA mode with no teams, rounds, bots, terminal winner, persistent career score, or effect on local solo balance. Players use server-generated neutral callsigns; custom names, chat, accounts, friends, parties, room codes, progression, ranked matchmaking, leaderboards, purchases, telemetry, and durable room state are non-goals.

Ownership remains explicit: `arena-engine` owns pure deterministic local and multiplayer rules; a new server application owns time, admission, room lifecycle, validation, and authoritative stepping; `arena-client` owns transport adaptation, prediction, reconciliation, input, audio, and Three.js presentation; `apps/web` owns only mode entry and public build configuration; unit, integration, and Playwright harnesses own their respective real-boundary evidence.

## Capabilities

### New Capabilities

- `online-ffa-arena`: Continuous eight-player authoritative free-for-all gameplay, join/leave behavior, respawn, scoring, snapshots, prediction, reconciliation, and interruption outcomes.
- `anonymous-quickplay`: Ephemeral no-account admission, public arena assignment, capacity, reconnect grace, input validation, abuse bounds, and privacy behavior.
- `online-service-deployment`: CDN web delivery plus Railway authority, health, configuration, promotion, rollback, and deployed validation requirements.

### Modified Capabilities

None. The required local `arena-run` behavior remains available and does not depend on the online service.

## Impact

- Adds an Nx server application and a platform-neutral protocol boundary while expanding the enforced graph beyond `web -> arena-client -> arena-engine`.
- Extends `arena-engine` with a separate multi-player state and input model without making the pure engine aware of clocks, sockets, storage, environment, or provider APIs.
- Extends `arena-client` and the Signal Yard shell with online connection states, roster/scoreboard, remote-player rendering, respawn feedback, latency/reconnect status, and accessible non-color team-independent identity cues.
- Introduces production HTTP/WebSocket dependencies, public environment configuration, ephemeral credentials, origin validation, rate/capacity limits, and Railway/CDN provider configuration.
- Adds server/protocol tests, production-build end-to-end topology, and deployment smoke checks while keeping `npm run check` deterministic and independent of live services.
- Updates `docs/architecture.md`, `docs/design-system.md`, `docs/testing.md`, and `docs/quality.md`, and adds durable deployment guidance.
