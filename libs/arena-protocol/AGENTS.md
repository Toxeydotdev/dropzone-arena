# Arena Protocol Agent Guide

This file applies to `libs/arena-protocol`. Follow the root `AGENTS.md` as well.

## Boundary

- Export protocol contracts only through `src/index.ts`.
- Remain platform-neutral and do not import the engine, client, server, DOM, React,
  Three.js, storage, clocks, or environment state.
- Own wire versions, event names, serializable records, strict runtime schemas, and
  payload bounds. Do not own simulation rules or transport lifecycle.

## Validation

- Treat every network value as hostile and validate it with strict Zod schemas.
- Reject unknown fields, non-finite numbers, unsupported versions, and values beyond
  explicit entity, sequence, vector, and payload limits.
- Test successful round trips and every rejection boundary without credentials or
  connection metadata in fixtures.
