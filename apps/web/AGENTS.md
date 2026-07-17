# Web Application Agent Guide

This file applies to `apps/web`. Follow the root `AGENTS.md` as well.

## Scope

- Own only the HTML document, React root, Vite configuration, metadata, and thin
  application composition.
- Import only the public API from `@dropzone-arena/arena-client`.
- Keep game state, input, rendering, styles, and rules out of this shell.
- Keep the artifact static and relative-origin. Do not add API, auth, telemetry,
  storage, or environment authority without an approved change.

## Verification

- Keep the development server on strict port `4300`.
- Keep normal production builds independent from the committed `.env.e2e`; use
  `web:build-e2e` only for the fixed local online test artifact.
- Build to `dist/apps/web` and test the production artifact through `web-e2e`.
- Verify the document title, viewport metadata, and shared game composition.
