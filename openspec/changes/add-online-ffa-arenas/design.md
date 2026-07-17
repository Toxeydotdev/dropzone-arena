## Context

Dropzone Arena currently ships one static browser application with this enforced graph:

```text
web -> arena-client -> arena-engine
web-e2e -> web
```

`arena-engine` is a deterministic, serializable 90-second solo simulation. `arena-client` owns browser input, a capped fixed-step loop, Three.js presentation, and bounded React HUD snapshots. Blur, document hiding, explicit pause, and renderer loss can suspend a local run because no other participant shares that state.

Online FFA introduces a different lifecycle. Up to eight human players can enter and leave one continuous world, the world cannot pause for one browser, and one service must own movement, fire, damage, eliminations, spawning, respawn, and session statistics. The static browser build and realtime service will also have different production origins. Anonymous sessions, arenas, and scores remain ephemeral; the current local run remains the primary service-independent action.

## Goals / Non-Goals

**Goals:**

- Add no-account public quickplay into continuous server-authoritative FFA arenas with at most eight players.
- Join players to a live world without a round, countdown, global reset, or terminal winner.
- Respawn eliminated connected players after three authoritative seconds and retain kills/deaths for the anonymous session.
- Keep multiplayer rules deterministic over explicit state, ordered commands, seeded randomness, player input, and fixed steps.
- Make local movement responsive through prediction while interpolating remote authority and reconciling all clients to server snapshots.
- Bound simulation work, input and snapshot traffic, entity counts, room count, payload size, catch-up, and reconnect retention.
- Preserve keyboard/mouse, touch, narrow layouts, safe areas, semantic status, reduced motion, visible focus, and recoverable renderer failure.
- Deploy static assets through Netlify's CDN and one always-on Railway authority with explicit health, promotion, smoke, and rollback behavior.
- Keep `npm run check` deterministic and independent of either live provider.

**Non-Goals:**

- Teams, rounds, a match clock, a winner, bots, pickups, skill-based matchmaking, private rooms, room codes, spectators, or replays.
- Accounts, custom names, chat, parties, friends, progression, ranked play, durable leaderboards, or persistent statistics.
- Client-authoritative movement, damage, hits, spawning, eliminations, or score.
- Server rewind, client-reported hits, or cross-region lag compensation in the first release.
- Durable rooms, a database, Redis, horizontal authority replicas, seamless migration across deploys, or recovery after a process restart.
- Replacing or rebalancing the required 90-second local solo run.
- Player-level telemetry, advertising, purchases, voice, user-generated content, or device fingerprinting.

## Decisions

### Add protocol and server projects with narrow ownership

The enforced project graph becomes:

```text
web -> arena-client -> arena-engine
                   -> arena-protocol

server -> arena-engine
       -> arena-protocol

web-e2e -> web
        -> server
```

- `arena-engine` owns pure solo and FFA rules, serializable state, deterministic spawn selection, collision, damage, elimination, respawn, and statistics.
- `arena-protocol` owns the protocol version, event names, wire records, strict runtime schemas, and payload bounds. It does not import the engine.
- `apps/server` owns Node configuration, monotonic scheduling, HTTP admission, origin checks, anonymous sessions, room assignment, rate limits, authoritative stepping, snapshots, health, and shutdown.
- `arena-client` owns transport adaptation, input sampling, prediction, interpolation, reconciliation, browser lifecycle, audio, and Three.js presentation.
- `apps/web` remains a thin composition layer. It validates public build configuration and imports only the `arena-client` public API.
- `web-e2e` owns the built web-plus-server test topology.

The service uses Node's HTTP server with Socket.IO attached at `/ws`; it does not add Nest or Express. Socket.IO supplies ordered framing, heartbeat, reconnect transport, and polling fallback. Zod supplies shared runtime validation because TypeScript types cannot validate hostile wire input. The online client and protocol implementation are loaded only after `Public quickplay` is activated, so the local entry path does not pay the networking bundle cost.

Nest was rejected because the service has a small route/event surface and does not need modules, decorators, or dependency injection. Raw WebSocket was rejected because it would require custom framing, heartbeat, reconnection, and upgrade lifecycle code. Keeping wire types in only one adapter was rejected because client and service validation could drift.

### Keep FFA separate from the solo state model

The solo `ArenaState`, `createArenaState`, and `stepArena` contract remain unchanged. A separate FFA engine module exposes pure operations equivalent to:

```text
createFfaArenaState(seed)
joinFfaPlayer(state, playerId, callsign)
leaveFfaPlayer(state, playerId)
stepFfaArena(state, inputsByPlayer, 1 / 60)
stepFfaPlayerMotion(player, input, collisionWorld, 1 / 60)
```

The server supplies stable player IDs, callsigns, room seeds, lifecycle command order, and input order. The engine never reads time, randomness, environment, network, storage, or provider state.

FFA rules are deliberately small:

- One arena contains zero to eight players and no bots.
- There is no terminal status, run timer, wave, extraction, combo, or global score.
- Players collide with arena bounds and static obstacles but not with one another. Avoiding body collision keeps movement prediction independent of remote timing.
- Projectiles cannot damage their owner. A lethal authoritative projectile awards exactly one kill and one death; there are no assists.
- Eliminated players are non-collidable and cannot act for exactly 180 ticks, then respawn automatically at full health.
- Spawn selection evaluates a fixed deterministic candidate set, rejects blocked positions, and maximizes distance from living players and active projectile paths.
- New and respawned players receive one second of protection, canceled by firing or dashing.
- Per-player firing cadence and a 96-projectile room cap bound entity growth.
- State, events, tick, random state, player statistics, and IDs remain serializable and repeatable.

Generalizing the solo model was rejected because its bots, pickups, waves, timer, and terminal outcomes would force mode branches through every rule. Predicting the full world was rejected because clients do not possess remote inputs or authority. Player body collision and unrestricted random spawn are deferred because both create avoidable prediction and live-entry failures.

### Run all rooms from one bounded fixed-step authority

The service owns one monotonic scheduler and accumulator for all active rooms. It calls the engine only with `1 / 60` second and performs at most five catch-up steps per scheduler turn. Excess wall-time backlog is discarded instead of becoming a large simulation delta. Repeated scheduler delay disables new admission while existing rooms continue best-effort; it never changes engine step size.

The latest accepted input state is applied each tick. Dash is a one-shot edge. If no valid input arrives for 500 ms, held movement, firing, and dash become neutral so a suspended client cannot fire indefinitely.

Quickplay fills the most populated non-full arena first, using oldest arena as a stable tie-breaker. It creates a room only when every compatible room is full. Reconnect-held players count against the eight-player cap. An arena with no connected or reconnect-held sessions stops stepping and expires after 30 seconds. Restart discards every arena, session, and statistic.

Initial production bounds are four arenas, 32 active or reconnect-held sessions, and 16 ten-second admission reservations. The room cap cannot be configured above eight. Capacity can be lowered after load evidence without changing protocol behavior.

One timer per room was rejected because drift and overload become harder to bound. Worker threads are deferred until profiling proves one bounded loop insufficient. Shared persistence and multiple replicas are excluded because the first release intentionally has ephemeral in-process authority.

### Use explicit anonymous admission and a short reconnect grace

Online entry begins only after a user activates quickplay:

1. The client sends `POST /api/quickplay` with protocol and build versions.
2. The service validates origin, request schema, capacity, and per-source limits.
3. It reserves a room slot for ten seconds and returns a cryptographically random 256-bit opaque token.
4. The client opens Socket.IO at `/ws` with the version and token in handshake auth.
5. The service atomically redeems the reservation and sends a reliable welcome containing player ID, generated neutral callsign, arena ID, rates, reconnect grace, and a full current snapshot.

The token is stored only in same-tab `sessionStorage`, never in a URL, cookie, DOM attribute, health response, analytics event, or log. It contains no encoded claims, and the service indexes an in-memory digest. A token controls one input-producing socket generation; a successful newer attachment replaces an older one.

On an unexpected disconnect, the service immediately neutralizes input but leaves the avatar vulnerable for a ten-second reconnect grace. The room slot, life, callsign, kills, and deaths remain attached. A valid reconnect to the same process receives a fresh full snapshot. Grace expiry removes the participant and invalidates the token. Explicit leave removes the participant immediately. Restart or expiry returns a stable `SESSION_EXPIRED` result rather than silently creating a new identity.

Cross-origin cookies were rejected because the CDN and authority are intentionally separate. Durable storage was rejected because it creates a longer-lived pseudonymous identity. Immediate despawn was rejected because disconnecting would become a combat escape. Socket.IO packet recovery was rejected because missed snapshots should be replaced by one current snapshot, not replayed.

### Version and validate a compact state-stream protocol

`arena-protocol` defines protocol version `1`. Version 1 accepts only version 1; incompatible HTTP admission returns `426`, and incompatible socket attachment returns a stable `PROTOCOL_MISMATCH` error with reload guidance.

The wire surface is:

| Direction        | Message               | Purpose                                     |
| ---------------- | --------------------- | ------------------------------------------- |
| HTTP             | `GET /api/health`     | Process/config/scheduler readiness          |
| HTTP             | `POST /api/quickplay` | Anonymous token and slot reservation        |
| Client to server | handshake auth        | Protocol version and token                  |
| Client to server | `client:input`        | Sequenced bounded control state             |
| Client to server | `client:leave`        | Explicit release with acknowledgement       |
| Client to server | `client:ping`         | Low-rate latency sample                     |
| Server to client | `server:welcome`      | Reliable identity, settings, and full state |
| Server to client | `server:snapshot`     | Volatile full authoritative room state      |
| Server to client | `server:error`        | Stable visible failure code                 |
| Server to client | `server:draining`     | Planned shutdown notice                     |

Input can contain only a monotonic sequence, finite movement and aim vectors, firing state, and dash edge. It cannot name a position, health, target, projectile, damage, elimination, or score. Strict schemas reject unknown fields, non-finite values, invalid vector bounds, stale or impossible sequence jumps, and oversized values before engine input is changed.

Snapshots carry protocol version, arena ID, authoritative tick, bounded players, bounded projectiles, presentation events, and the local player's last processed input sequence. They never contain tokens, addresses, client clocks, or server internals. Full snapshots are preferred to deltas because the capped world is small and one missed volatile packet self-recovers.

The client sends at most 30 input states per second, with immediate neutral and dash transitions within a server token bucket of 30/s and burst 45. The server emits a snapshot every third simulation tick, or 20/s, serializes it once per room, and broadcasts it as volatile. Hard bounds are 8 KiB inbound Engine.IO messages, 12 KiB encoded snapshots, 96 projectiles, eight buffered client snapshots, and at most 10 Hz React HUD updates. Gameplay input is never buffered while disconnected.

Delta snapshots, binary encoding, and WebSocket compression are deferred until measured JSON size, CPU, or egress exceeds these explicit budgets. A 60 Hz snapshot stream was rejected because rendering can interpolate lower-rate authority.

### Predict local motion and reconcile to authority

The online runtime remains imperative; React never stores players, projectiles, input history, or snapshot buffers.

At fixed 60 Hz, the client predicts only local kinematics through the same pure `stepFfaPlayerMotion` function used by authority. Each sent input receives a monotonic sequence and bounded history. A server snapshot acknowledges the latest processed sequence. The client resets to authoritative kinematics, removes acknowledged history, and replays newer samples. Health, projectile collision, damage, eliminations, spawns, kills, and deaths are never predicted as facts.

Small position corrections blend visually for at most 100 ms. Errors over two world units, reconnects, eliminations, and respawns snap immediately. Remote players and projectiles render approximately 100 ms behind the newest server tick from an eight-snapshot buffer. The runtime interpolates ordered states, ignores stale snapshots, and extrapolates no more than two missing snapshots before holding authority and reporting a delayed connection.

Local firing may provide immediate muzzle/audio feedback, but only authoritative projectiles and events can show hits or score. Server rewind is excluded, so high-latency players may be disadvantaged; the HUD exposes coarse `Stable`, `Delayed`, or `Reconnecting` status instead of pretending latency is absent.

No prediction was rejected because movement would feel one full round trip late. Predicting damage was rejected because it creates false outcomes. Unlimited extrapolation was rejected because it fabricates positions and increases correction severity.

### Treat browser interruption as a live-field condition

Solo pause behavior remains unchanged. In online mode, Escape, `P`, and the visible action open a `Field menu`, not a paused state. The menu explicitly says the shared arena remains live and exposes `Return`, `Leave arena`, and local fallback.

Blur, hidden document, field-menu entry, renderer failure, and transport interruption clear held keyboard, pointer, and touch state and attempt one priority neutral input. Authority continues and the avatar remains vulnerable. The browser performs no hidden-time prediction or catch-up. On return it discards stale prediction/interpolation buffers, waits for a fresh snapshot, resets its frame clock, and resumes from authority.

Renderer construction failure before admission creates no session. Context loss during online play neutralizes input, disconnects transport while retaining reconnect eligibility, disposes resources once, and shows a named failure explaining that the arena could not pause. Retry inside grace reconnects and rebuilds from a current snapshot; expiry offers fresh quickplay and local play. Network, protocol, and renderer failures remain distinct surfaces.

Pausing shared authority was rejected because one player cannot stop other participants. Keeping a blind session connected after renderer loss was rejected because the player cannot understand or control the world.

### Extend Signal Yard without making canvas the status source

The ready surface retains local `Drop in` as the primary action. `Public quickplay` is secondary and does not contact Railway until activated. Missing or invalid public configuration disables only online entry with an explanation.

The online HUD replaces solo timer, wave, combo, and extraction language with population, generated callsign and explicit `You` marker, health, dash, life/respawn state, kills, deaths, compact roster, and coarse connection quality. It never implies a round winner. Roster and status are semantic HTML; only meaningful connection, elimination, and respawn transitions enter restrained live regions.

Remote identity uses callsign labels and numbered or patterned ground markers in addition to color. Touch retains two sticks, dash, and a minimum 44px field-menu action outside safe insets. From 320 CSS pixels upward, essential health, respawn, menu, and controls remain visible; the full roster may collapse behind an accessible disclosure. Reduced motion removes shake, pulses, excess particles, and reconciliation easing without changing authority, input, timing, or necessary positional interpolation.

### Minimize anonymous data and bound public abuse

The service receives only the ephemeral token, generated callsign, protocol/build version, input intent, and connection metadata inherently available to Railway. It requests no email, custom text, advertising identifier, fingerprint, or durable history.

Per-source admission and connection limits use the explicitly configured Railway proxy boundary. With one trusted Railway edge hop, the service consumes Railway's documented `X-Real-IP` address; otherwise it ignores untrusted forwarding headers or evaluates the configured `X-Forwarded-For` chain. An address is normalized, hashed with a random per-process salt, held only in memory, and never written to application logs. Initial bounds are four simultaneous sessions and twelve quickplay requests per minute per address. These are coarse abuse limits, not identity or bans.

Additional controls are one active socket generation per token, strict schemas, 1 KiB quickplay bodies, 8 KiB realtime messages, a 500 ms input deadman, hard process/room/entity limits, stable non-reflective error codes, and no chat, uploads, custom names, or public room identifiers.

`ALLOWED_WEB_ORIGINS` is an exact list. HTTP admission emits CORS only for an exact match and allows no credentials. Socket.IO uses the same list for polling plus `allowRequest` for WebSocket upgrades. Production rejects missing or unlisted browser origins for admission and transport; `/api/health` remains available to Railway. Origin checks are not authentication, so opaque tokens and all authority validation remain mandatory.

Wildcard CORS, durable bans, fingerprints, and custom names were rejected because they either weaken the boundary or create privacy and moderation obligations outside this scope.

### Deploy immutable web assets and one Railway authority

Netlify runs the targeted Nx web build and publishes `dist/apps/web`. Hashed assets receive immutable caching; HTML and deployment metadata revalidate so a protocol or authority change is not trapped behind a long cache. `VITE_ONLINE_AUTHORITY_URL`, online enablement, and build ID are public build-time values, not secrets.

Railway uses the pinned Node/npm versions and lockfile, builds only the server target, and starts `node dist/apps/server/main.js`. It listens on `0.0.0.0:$PORT`, uses one replica in one region, disables sleeping, exposes a Railway TLS domain, and has no volume, database, or shared adapter. `/api/health` is the deployment healthcheck and returns success only after configuration and scheduler readiness; it returns `Cache-Control: no-store`, protocol/build identity, and no player or room data. Full capacity is a quickplay `503`, not an unhealthy process.

On `SIGTERM`, the service disables admission, fails readiness, emits `server:draining`, allows a short bounded disconnect window, closes sockets, and exits. Increasing replicas is unsupported until shared room/session coordination is designed.

The static and server artifacts carry the exact Git commit/build ID. Provider promotion records the compatible web deploy, Railway deploy, public origins, protocol, and rollback targets. A deployed smoke verifies CDN load, exact health and CORS, admission, Socket.IO connection, increasing authoritative snapshots, and clean leave. It remains separate from the merge gate.

Netlify Functions were rejected because the authority requires a continuously active fixed-step process. Railway sleeping was rejected because cold-start failure conflicts with quickplay. Serving static assets from the Node process was rejected because the selected split keeps local fallback independent from authority availability.

### Verify deterministic rules and real boundaries

- Engine tests cover join/leave order, movement, fire cadence, projectile caps, collision, lethal attribution, kills/deaths, deterministic safe spawn, protection, exact 180-tick respawn, continuous state, and seeded repeatability.
- Protocol tests cover strict parsing, finite bounds, unknown fields, sequences, versions, callsigns, array/entity limits, encoded snapshot size, and round trips.
- Server tests inject monotonic clock and scheduling adapters. Real in-process HTTP/Socket.IO integration covers origins, admission, room fill, capacity, input limits, deadman, two-client combat, leave, reconnect, expiry, health, and shutdown.
- Client netcode tests replay input/snapshot streams with latency, jitter, missed volatile packets, large correction, respawn, hiding, and reconnect. React tests use injected runtime/transport drivers and visible roles/labels.
- Production-build Playwright starts owned web and server processes on fixed ports and uses separate browser contexts for joining live state, roster presence, interruption, reconnect, unavailable fallback, renderer failure, keyboard, touch, narrow layout, reduced motion, and accessibility.
- `npm run check` never calls Netlify or Railway. A separate deployed smoke and bounded 32-client load smoke provide environmental evidence before first enablement or capacity increases.

## Risks / Trade-offs

- [One Railway process is a single failure domain] -> Preserve independent solo play, use explicit failure/retry, health-check one immutable artifact, and accept that restart ends ephemeral sessions.
- [Deploys interrupt live arenas] -> Disable admission, emit draining state, keep rollout windows short, and make no continuity claim.
- [No server rewind disadvantages high-latency fire] -> Expose connection quality, choose one suitable region, and defer rewind until measured need justifies fairness complexity.
- [Pure immutable stepping can allocate heavily at 60 Hz] -> Enforce hard entity/room caps, profile the 32-player target, and optimize data structures before adding workers or an ECS.
- [JSON snapshots consume CPU and egress] -> Quantize only wire values, serialize once per room, use volatile 20 Hz full snapshots, enforce 12 KiB, and lower room capacity before changing format.
- [Prediction diverges] -> Share one pure motion reducer, acknowledge sequences, retain bounded history, reconcile every snapshot, and snap discontinuities.
- [Disconnect grace leaves an avatar vulnerable] -> Neutralize immediately, explain live behavior, bound grace to ten seconds, and prevent disconnect from becoming an escape.
- [Mobile suspension can delay the neutral event] -> Send neutral on lifecycle signals and enforce the 500 ms server deadman.
- [Public anonymous play has limited moderation] -> Exclude custom text and communication, use curated callsigns, and retain strict rate/capacity bounds.
- [Per-address limits can affect shared networks] -> Keep household-sized allowances, return retry guidance, and treat limits as only one coarse defense.
- [Static and authority versions can diverge] -> Require exact protocol versions and build identity, promote authority before a breaking client, and keep solo functional on mismatch.
- [The selected Railway plan may miss timing budgets] -> Gate enablement on representative load evidence and lower configured arenas rather than weakening simulation bounds.

## Migration Plan

1. Add `arena-protocol` and `server`, update graph enforcement, and keep online entry disabled.
2. Add the separate deterministic FFA engine and tests without changing solo behavior.
3. Add protocol schemas, server scheduler, admission, rooms, reconnect, health, and real transport integration tests.
4. Extract reusable renderer/input presentation seams and add online transport, prediction, interpolation, reconciliation, and semantic UI.
5. Add the built two-process Playwright topology, deployment configuration, documentation, and complete local quality gate.
6. Load-test the intended Railway class at four rooms and 32 clients; lower configured capacity if timing, memory, snapshot, or egress budgets fail.
7. Deploy one Railway replica with admission disabled, exact production origin configuration, and health/smoke validation.
8. Enable admission, deploy the Netlify artifact with the public authority URL, rerun smoke and accessibility checks, then record the compatible deploy pair.

There is no persisted data migration. Rollback first disables new admission, restores the prior local-only or compatible Netlify artifact, drains or terminates ephemeral sessions, restores the prior compatible Railway artifact when one exists, and reruns health and deployed smoke. No room or score migration is attempted.

## Open Questions

- The exact Netlify origin, Railway domain, region, and service class are provider values resolved during deployment.
- The initial four-room capacity remains provisional until the selected Railway service passes the representative load smoke.
- Provider request-log retention and redaction settings must be reviewed before public enablement.
- The curated neutral callsign vocabulary needs final product review, but it does not block local implementation.
