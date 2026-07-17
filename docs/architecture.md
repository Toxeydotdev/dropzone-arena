# Architecture

## Project Graph

```text
web -> arena-client -> arena-engine
                   -> arena-protocol

server -> arena-engine
       -> arena-protocol

web-e2e -> web
        -> server
```

`tools/check-project-boundaries.mjs` is the enforcement point. It permits the
edges above, requires every product project to have a rule, and rejects every
other internal dependency. `arena-engine` and `arena-protocol` are independent
platform-neutral leaves. The `workspace` Nx project owns repository tooling and
has no product dependency edge.

## Ownership

| Project               | Owns                                                                                                                                                     | Must not own                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/web`            | Static entrypoint, React root, metadata, validated public online configuration                                                                           | Game state, rules, transport, or server secrets                       |
| `libs/arena-client`   | React surfaces, input, audio, lazy online loading, Socket.IO adaptation, prediction, interpolation, reconciliation, and Three.js                         | Authoritative hits, damage, spawning, elimination, or score           |
| `libs/arena-engine`   | Pure serializable solo and FFA rules, collision, safe spawn, damage, respawn, and statistics                                                             | Clocks, randomness sources, DOM, network, storage, React, or Three.js |
| `libs/arena-protocol` | Protocol version 1, event names, strict wire schemas, quantization, and payload limits                                                                   | Engine rules, transport lifecycle, or platform APIs                   |
| `apps/server`         | Configuration, monotonic scheduling, HTTP admission, exact origins, sessions, room packing, rate limits, Socket.IO authority, health, logging, and drain | Browser presentation or client authority                              |
| `apps/web-e2e`        | Compiled web-plus-server topology and browser-visible system evidence                                                                                    | Provider-hosted dependencies or reusable running processes            |

React owns menus and bounded semantic HUD snapshots. Imperative runtimes own
animation frames, input state, prediction history, snapshot buffers, Three.js
objects, and per-frame presentation.

## Local Runtime

`apps/web` validates public configuration and mounts `ArenaGame`. The initial
renderer and the primary `Drop in` path do not import the online runtime or make
an authority request.

For a local run, `arena-client` owns one animation loop and passes explicit input
and fixed `1/60` second steps to the solo engine. The engine consumes only its
seeded serializable PRNG state and returns a new state. The runtime caps a frame
at 100 ms and catch-up at five steps, presents the state with Three.js, and emits
React HUD state at no more than 10 Hz plus immediate terminal state.

Blur, a hidden document, `P`, `Escape`, or the visible pause action clears held
input and pauses local simulation. Resume resets the frame clock rather than
replaying hidden time. Context loss suspends the run and exposes a recoverable
renderer failure. Disposal removes listeners and releases renderer resources
exactly once.

## Online Admission And Rooms

Online code is dynamically imported only after `Public quickplay` is activated.
The client constructs presentation before admission so a renderer failure cannot
create a blind session, then performs this flow:

1. `POST /api/quickplay` sends protocol version 1 and the build ID from an exact allowed origin.
2. The authority validates schema, build, origin, process capacity, and coarse per-source limits.
3. It packs the most populated non-full compatible room first, breaking ties by oldest room, or creates a room within the configured cap.
4. A ten-second reservation returns a generated callsign, arena/player IDs, and a random 256-bit opaque token.
5. Socket.IO attaches at `/ws`, atomically redeems the token, and sends a welcome plus a current full snapshot.

The token is kept only in same-tab `sessionStorage` and runtime memory. The
authority indexes an in-memory digest, permits one active socket generation, and
never places the token in a URL, cookie, health response, snapshot, or
application log.

One room holds at most eight connected, reconnect-held, or pending reserved
slots. Initial process bounds are four rooms, 32 sessions, 16 pending
reservations, 48 transport connections, and 96 projectiles per room. Room
selection and every lifecycle command are ordered by the server. An empty room
stops stepping and expires after 30 seconds; reconnect-held rooms remain live.

## Authority And Netcode

| Flow                            | Rate or bound                                                                  | Authority boundary                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Server simulation               | Fixed 60 Hz, at most five catch-up steps per scheduler turn                    | Sole accepted world state                                                   |
| Browser local-motion prediction | Fixed 60 Hz                                                                    | Visual responsiveness only; reconciled on every snapshot                    |
| Client input                    | At most 30 Hz, burst 45, with bounded priority neutral/dash transitions        | Intent only: move, aim, fire, and dash                                      |
| Server snapshots                | 20 Hz, every third authority tick, one serialized volatile full state per room | Positions, projectiles, health, events, kills, deaths, and acknowledgements |
| Remote presentation             | About 100 ms behind authority from at most eight snapshots                     | Interpolation only; at most two missing snapshot intervals are extrapolated |
| React online HUD                | At most 10 Hz                                                                  | Semantic summary, never per-frame world state                               |

The server runs all occupied rooms from one monotonic accumulator. A 500 ms
input deadman and any disconnect replace held input with neutral intent. Repeated
scheduler backlog disables admission and readiness while bounded existing rooms
continue best-effort; elapsed backlog is discarded rather than changing the
fixed engine step.

The client predicts only local kinematics with the engine's shared pure motion
reducer. Each sent input has a monotonic sequence. On a snapshot, the client
resets to accepted local kinematics, removes acknowledged history, and replays
only newer samples. Corrections below two world units may blend for at most
100 ms; larger corrections, reconnects, eliminations, and respawns snap to
authority. Reduced motion also removes correction easing.

Remote players and projectiles come from ordered authoritative snapshots. Stale
snapshots are ignored. When bounded interpolation/extrapolation is exhausted,
presentation holds the last authority and reports `Delayed`. Local muzzle or
audio feedback may be immediate, but clients never predict a hit, health change,
projectile collision, elimination, spawn, kill, or death as fact.

## Online Lifecycle

`P`, `Escape`, and the visible action open the online `Field menu`; they do not
pause authority. Field-menu entry, blur, page hiding, transport interruption, and
renderer failure clear held controls and attempt a priority neutral input. The
browser performs no hidden-time prediction or catch-up and resumes from a fresh
authority snapshot.

An unexpected disconnect leaves the avatar present, neutral, and vulnerable for
ten seconds. A valid same-process reconnect retains the callsign, life, room,
kills, and deaths and receives a fresh full snapshot. Expiry invalidates the
token and removes the player. Explicit leave releases the session immediately.

Online context loss neutralizes input, disconnects transport while retaining
grace, disposes presentation, and names the failure. Retry within grace rebuilds
from current authority. Renderer failure before admission creates no session.
Network, version, capacity, draining, expiry, and renderer failures remain
distinct UI states with local fallback.

`SIGTERM` stops admission, makes health not ready, emits `server:draining`, and
closes transport within the configured bound. No session or room migration is
attempted.

## Production And Privacy

The production contract is split: Netlify serves immutable static assets and one
always-on Railway service owns `/api/health`, `/api/quickplay`, `/ws`, and all
online simulation. CDN availability therefore preserves local play during an
authority outage. See `deployment.md` for promotion and rollback.

The application requests no email, custom text, advertising identifier, durable
identity, or fingerprint. It receives generated callsigns, protocol/build data,
input intent, the ephemeral token, and connection metadata needed to operate the
service. Source addresses are normalized and HMAC-digested with a random
per-process salt for in-memory rate controls; application logs contain only
stable event names and severity. Provider request logging remains a separate
deployment review.

## Known Limits

- Authority is one process in one selected region and one failure domain.
- Restart, deploy, drain, or rollback discards in-memory arenas, tokens, and stats.
- Multiple replicas and cross-replica room or session coordination are unsupported.
- There is no database, volume, persistence, account, chat, custom name, party, or leaderboard.
- Per-source controls are coarse and can group users behind shared network addresses.
- Four rooms and 32 sessions are provisional until the selected Railway service passes the representative deployed load check.
