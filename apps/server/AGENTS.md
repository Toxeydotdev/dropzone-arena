# Server Application Agent Guide

This file applies to `apps/server`. Follow the root `AGENTS.md` as well.

## Boundary

- Run on Node 24 as ESM and import only public APIs from
  `@dropzone-arena/arena-engine` and `@dropzone-arena/arena-protocol`.
- Own configuration, HTTP and Socket.IO transport, admission, sessions, room
  lifecycle, authoritative scheduling, health, rate limits, logging, and shutdown.
- Do not import browser APIs, React, Three.js, arena-client internals, or private
  files from either shared library.

## Authority

- Supply time, randomness, lifecycle order, and accepted input to the engine
  explicitly. Never move gameplay authority into transport handlers.
- Keep origins, messages, rates, rooms, sessions, catch-up, and shutdown bounded.
- Fail closed on invalid configuration and never log tokens, addresses, secrets, or
  arena state.

## Verification

- Build with Vite to `dist/apps/server/main.js` and keep the artifact executable as
  Node ESM.
- Prefer injected clocks and schedulers for unit tests, plus owned in-process HTTP
  and Socket.IO instances for integration tests.
