# Web E2E Agent Guide

This file applies to `apps/web-e2e`. Follow the root `AGENTS.md` as well.

## Boundary

- Exercise the built static artifact through Chromium and user-visible behavior.
- Let the Nx target build `web:build-e2e` and `server:build`; Playwright starts
  their production artifacts directly and must not invoke a nested Nx task.
- Own strict preview port `4301` and authority port `4302`, wait for authority
  health, and never reuse either process.
- Use one worker and keep retries disabled so lifecycle failures remain visible.

## Tests

- Prefer roles, labels, and visible names over structural selectors or test IDs.
- Use web-first assertions and `expect.poll`; never arbitrary sleeps.
- Cover desktop and mobile entry, simulation start, pause/resume, touch control
  visibility, reduced motion, overflow, and serious/critical axe findings.
- Exercise online lifecycle against the owned local authority with separate
  browser contexts and explicit leave cleanup. Tag desktop-only and mobile-only
  journeys so expensive coverage is not duplicated across projects.
- Do not depend on exact bot timing, random scores, screenshots, GPU pixels, or
  a provider-hosted service.
