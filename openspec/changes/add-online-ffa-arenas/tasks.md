## 1. Workspace And Boundaries

- [x] 1.1 Add exact Socket.IO, Socket.IO client, and Zod dependencies and create buildable `arena-protocol` and `server` Nx projects with scoped guidance and public APIs.
- [x] 1.2 Update path aliases, production inputs, root scripts, and enforced project boundaries for `web -> arena-client -> arena-engine/arena-protocol`, `server -> arena-engine/arena-protocol`, and `web-e2e -> web/server`; verify the reported Nx graph.

## 2. Deterministic FFA Engine

- [x] 2.1 Add serializable FFA arena, player, projectile, input, event, and statistic records plus deterministic create, join, leave, and safe-spawn operations without changing solo exports or behavior.
- [x] 2.2 Implement shared pure player motion, obstacle/boundary handling, dash, firing cadence, owner-safe projectile collision, and hard player/projectile bounds at fixed `1/60` steps.
- [x] 2.3 Implement authoritative damage, exact elimination attribution, session kills/deaths, non-collidable eliminated state, three-second respawn, and attack-cancelled spawn protection.
- [x] 2.4 Unit-test seeded repeatability, lifecycle ordering, controls, collision, caps, damage, statistics, safe spawn, protection, exact respawn ticks, and continuous non-terminal behavior.

## 3. Versioned Protocol

- [x] 3.1 Define protocol version 1, stable health/admission/error records, handshake auth, client input/leave/ping events, and server welcome/snapshot/error/draining events with strict runtime schemas.
- [x] 3.2 Add engine-to-wire snapshot mapping with finite quantized values, bounded players/projectiles/events, input acknowledgements, and no credential or connection metadata.
- [x] 3.3 Test unknown-field and non-finite rejection, vector and sequence bounds, protocol mismatch, entity limits, round trips, and the maximum encoded snapshot budget.

## 4. Railway Authority

- [x] 4.1 Implement fail-closed server configuration, exact-origin CORS and upgrade checks, redacted logging, body/message limits, and non-sensitive `GET /api/health` readiness.
- [x] 4.2 Implement generated callsigns, opaque token reservations, public quickplay room packing, eight-player room limits, process capacity, per-source admission bounds, and explicit leave.
- [x] 4.3 Implement the injected monotonic 60 Hz scheduler, five-step catch-up cap, room stepping, 500 ms input deadman, 20 Hz once-per-room snapshots, empty-room expiry, and overload admission gating.
- [x] 4.4 Implement Socket.IO token redemption, one active socket generation, strict sequenced input/rate handling, ping, ten-second vulnerable reconnect grace, fresh reconnect snapshots, and stable expiry/incompatibility errors.
- [x] 4.5 Implement bounded `SIGTERM` draining that stops admission, fails readiness, notifies clients, closes transport, and exits without claiming room migration.
- [x] 4.6 Add real in-process HTTP and Socket.IO tests for configuration, origins, health, admission, room packing, capacity, two-client state, malformed/rate-limited input, deadman, reconnect, expiry, leave, and drain.

## 5. Online Browser Runtime

- [x] 5.1 Extract reusable imperative input and Three.js presentation seams so local and online drivers share rendering, resize, DPR, lifecycle cleanup, and control projection without moving per-frame state into React.
- [x] 5.2 Add a lazily loaded online driver that performs bounded quickplay admission, stores only the ephemeral same-tab token, attaches Socket.IO, and exposes explicit connecting, connected, delayed, reconnecting, draining, expired, incompatible, capacity, and unavailable states.
- [x] 5.3 Implement 60 Hz local kinematic prediction, 30 Hz sequenced input, acknowledgement replay, bounded correction, 100 ms remote interpolation, stale snapshot rejection, and delayed-state holding without predicting authoritative outcomes.
- [x] 5.4 Render bounded remote players, authoritative projectiles, callsign and shape markers, elimination/respawn transitions, and local feedback while preserving disposal and reduced-motion performance limits.
- [x] 5.5 Implement online lifecycle handling so field menu, blur, hiding, transport loss, and renderer loss neutralize input without pausing authority or applying hidden-time catch-up.

## 6. React Surface And Accessibility

- [x] 6.1 Preserve local `Drop in` as the primary no-network action and add secondary public quickplay, bounded connection/failure/retry surfaces, fresh quickplay, and local fallback actions.
- [x] 6.2 Add the semantic online HUD and field menu with objective, population, `You` callsign, health, dash, life/respawn state, kills/deaths, roster, coarse connection state, and explicit live-field interruption copy.
- [x] 6.3 Complete keyboard/mouse and touch online controls, 44px targets, safe-area placement, 320px responsive behavior, visible focus, non-color player identity, restrained announcements, and reduced-motion presentation.
- [x] 6.4 Add component and runtime tests for optional entry, unavailable service fallback, online stages, roster/statistics, field menu, interruption, renderer recovery, touch, responsive semantics, and reduced motion.

## 7. Web Composition And Real-Boundary Tests

- [x] 7.1 Add validated public online authority/build configuration and development proxy behavior while proving the local entry path performs no authority request and does not eagerly load networking code.
- [x] 7.2 Update the production-build Playwright topology to own compiled web and authority processes on fixed ports and use separate browser contexts without arbitrary sleeps or live provider dependencies.
- [x] 7.3 Add browser journeys for local-first entry, two anonymous players joining live state, roster visibility, continuous join/leave, field-menu live behavior, reconnect/expiry, service failure fallback, renderer loss, keyboard, touch, narrow layout, reduced motion, and serious/critical accessibility findings.

## 8. Deployment Contracts

- [x] 8.1 Add Netlify configuration for the targeted web build, `dist/apps/web` publish output, immutable hashed assets, revalidated entry/deployment metadata, and no server secrets.
- [x] 8.2 Add Railway configuration for the targeted server build, `node dist/apps/server/main.js`, one non-sleeping replica, `/api/health`, bounded restart policy, and provider `PORT` handling.
- [x] 8.3 Add identifiable build metadata plus separate deployed smoke and bounded load commands that verify HTTPS/CORS, health, admission, realtime snapshots, clean leave, and the initial four-room capacity outside `npm run check`.
- [x] 8.4 Update CI artifact handling without making the deterministic merge gate depend on Netlify, Railway, provider credentials, or external network availability.

## 9. Durable Documentation And Local Verification

- [x] 9.1 Update README and architecture, visual interaction, testing, and quality documentation for FFA ownership, data flow, lifecycle, privacy, limits, provider topology, promotion, rollback, and known single-process limitations.
- [x] 9.2 Run formatting, OpenSpec validation, graph inspection, lint, typecheck, unit/integration tests, and targeted production builds; fix every failure in the current worktree.
- [x] 9.3 Run `npm run check` and record only current-worktree evidence after the complete deterministic gate passes.

## 10. Repository And Production Promotion

- [x] 10.1 Re-authenticate GitHub CLI, inspect the complete initial diff for secrets, create the public `Toxeydotdev/dropzone-arena` repository, commit the passing worktree, and push `main` without bypassing CI.
- [x] 10.2 Create and configure one Railway service with validated production variables, exact Netlify origin, one non-sleeping replica, public TLS domain, and admission initially disabled; deploy and verify readiness.
- [x] 10.3 Create and configure the Netlify site with the Railway public authority URL and exact build identity, enable Railway admission, deploy the compatible pair, and run deployed smoke plus representative load validation.
- [x] 10.4 Record the repository URL, public game URL, Railway service/deployment identity, Netlify deployment identity, source commit, protocol, provider configuration, validation evidence, and first-deploy rollback/containment path without recording credentials.
