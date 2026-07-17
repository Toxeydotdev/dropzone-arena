# Testing

## Suites And Boundaries

| Layer                  | Exact suites                                                                                                                                                                                                                       | Real boundary exercised                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Solo and FFA engine    | `libs/arena-engine/src/lib/arena.spec.ts`, `ffa-arena.spec.ts`                                                                                                                                                                     | Pure serializable reducers with explicit seeds, input, lifecycle order, and `1/60` steps                                    |
| Protocol               | `libs/arena-protocol/src/lib/protocol.spec.ts`, `snapshot-mapper.spec.ts`                                                                                                                                                          | Strict platform-neutral schemas, engine-to-wire mapping, entity limits, and encoded byte budgets                            |
| Authority              | `apps/server/src/config.spec.ts`, `authority.spec.ts`                                                                                                                                                                              | Fail-closed config plus an owned in-process Node HTTP/Socket.IO server with real clients                                    |
| Deployment helpers     | `tools/deployment/deployment.spec.mjs`                                                                                                                                                                                             | Release metadata, command parsing, identity matching, deadlines, and cleanup; included by `server:test`                     |
| Browser runtime and UI | `arena-input-controller.spec.ts`, `three-arena-presentation.spec.ts`, `online-netcode.spec.ts`, `online-arena-runtime.spec.ts`, `online-arena-runtime-driver.spec.ts`, and `arena-game.spec.tsx` under `libs/arena-client/src/lib` | Injected clocks, sockets, storage, animation frames, runtime drivers, and renderer adapters; semantic React output in jsdom |
| Web composition        | `apps/web/src/app.spec.tsx`, `local-entry.spec.tsx`, `online-config.spec.ts`, `vite-config.spec.ts`                                                                                                                                | Thin composition, public config validation, proxy validation, and local-path network/lazy-load isolation                    |
| Built browser system   | `apps/web-e2e/src/web.local.spec.ts`, `web.online.spec.ts`                                                                                                                                                                         | Compiled authority and static web artifacts in Chromium through visible behavior                                            |

## Deterministic Seams

Engine suites provide every seed, command ordering, input record, and fixed
step. They cover solo terminal outcomes and continuous FFA join/leave order,
movement, fire cadence, collision, projectile caps, lethal attribution,
kills/deaths, safe spawn, one-second protection, and exact 180-tick respawn.

Protocol suites reject unknown fields, non-finite values, unsupported versions,
invalid sequence advances, outcome declarations, duplicate IDs, excess entities,
and values beyond the 1 KiB admission, 8 KiB inbound, and 12 KiB snapshot
budgets. Snapshot fixtures contain no credentials or connection metadata.

Authority tests inject monotonic clock, scheduler, and random adapters while
using a real ephemeral HTTP and Socket.IO boundary. They cover exact origins,
health, room packing, process/source capacity, reservation redemption, two-client
state, 30 Hz input rate with burst 45, the 500 ms deadman, five-step catch-up,
overload gating, reconnect and generation replacement, grace expiry, empty-room
expiry, explicit leave, and bounded drain.

Client netcode replays controlled input and snapshot streams through latency,
jitter, loss, stale packets, correction, elimination, respawn, hiding, and
reconnect. Component tests inject `ArenaRuntimeDriver` and the online driver,
then assert roles, labels, live-region transitions, field-menu semantics, touch
reset, renderer recovery, 320px semantics, and reduced-motion propagation rather
than implementation state.

## Production-Build Topology

`npm run e2e` first builds `web:build-e2e` and `server:build`. Playwright then
starts `node dist/apps/server/main.js` on strict port `4302` and Vite preview of
`dist/apps/web` on strict port `4301`. It waits on `/api/health`, never reuses an
existing process, runs one worker with zero retries, and owns shutdown. Desktop
Chromium uses 1280 by 720; the mobile project uses the Pixel 7 profile.

Multiplayer journeys create separate browser contexts so two anonymous players
have independent same-tab storage and transport. They verify shared live state,
unique callsigns/markers, roster join and leave, continuous no-winner language,
and field-menu authority while another participant observes the arena.

The initial and local paths are monitored for both authority requests and the
lazy `online-arena-runtime` chunk. Neither may load before quickplay activation.
The web unit suite provides the same isolation check without a browser network.

Browser interruption coverage includes transport loss and reconnect inside grace,
reload-based identity expiry followed by fresh quickplay, aborted authority traffic followed
by a local run with no further retries, local and online WebGL context loss, and
current-authority renderer recovery. Runtime suites cover blur, document hiding,
field-menu neutralization, disconnected-input suppression, and no hidden-time
catch-up.

Mobile coverage sets an exact 320 by 640 viewport, exercises touch move, aim,
dash, field menu, and roster disclosure, verifies 44px action bounds, and checks
for horizontal overflow. Reduced-motion coverage runs on ready, connected, and
field-menu states. Axe checks WCAG 2 A/AA rules and fail on serious or critical
findings; they do not claim that lesser findings are absent.

Locators prefer roles, labels, and visible text. Timing assertions use web-first
expectations or `expect.poll`, never arbitrary sleeps.

## Deployed Evidence

`npm run deploy:smoke` targets one identified Netlify/Railway pair. It validates
HTTPS/WSS, revalidated entry and metadata, exact web release identity and
authority build identity, no-store health, allowlisted and rejected CORS,
anonymous admission, WebSocket welcome, strictly increasing snapshots,
acknowledged leave, and health after cleanup.

`npm run deploy:load` targets only an isolated pre-enable authority. Its
representative 32 clients must pack into four rooms of eight, receive increasing
snapshots, remain healthy, and leave cleanly. The temporary per-source overrides
and mandatory restoration are documented in `deployment.md`.

These checks remain outside `npm run check` because they require selected live
targets and evidence from provider routing, TLS, process class, timing, memory,
and egress conditions. Making them a merge gate would couple every change to
external network availability and nondeterministic provider release state.
