# Quality

## Commands

| Command                | Exact scope                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run dev`          | Run `web:serve` on strict `http://localhost:4300`; no authority is started                             |
| `npm run build`        | Run all available build targets except `workspace` and `web-e2e`                                       |
| `npm run typecheck`    | Run every project typecheck target except `workspace`                                                  |
| `npm run test`         | Run every unit/integration test target except `workspace` and `web-e2e`                                |
| `npm run e2e`          | Run uncached `web-e2e:e2e` against owned compiled processes                                            |
| `npm run lint`         | Run cached boundary enforcement, then cached repository oxlint with warnings denied                    |
| `npm run lint:fix`     | Apply oxlint fixes across the repository and deny remaining warnings                                   |
| `npm run format`       | Format supported repository files with oxfmt                                                           |
| `npm run format:check` | Run the cached workspace oxfmt check                                                                   |
| `npm run spec:check`   | Run cached `openspec validate --all --strict`                                                          |
| `npm run check:quick`  | Run format check, lint/boundaries, typecheck, unit/integration tests, and OpenSpec validation in order |
| `npm run check`        | Run `check:quick`, build, then Playwright in order                                                     |
| `npm run deploy:smoke` | Run separately invoked deployed pair validation with required arguments                                |
| `npm run deploy:load`  | Run separately invoked isolated 1-32 client load validation with required arguments                    |
| `npm run graph`        | Open the Nx project graph                                                                              |

`dist/apps/web` is the static artifact. `dist/apps/server/main.js` is the Node
authority entry, and `dist/apps/server/deployment.json` records its artifact
metadata. Build and test target details remain in each `project.json`.

## Nx And Cache Behavior

Nx caches build, typecheck, and unit/integration test targets using project
inputs and production dependency inputs. Production inputs exclude test files
and test configuration. Workspace format check, boundaries, lint, and OpenSpec
validation are also explicitly cacheable.

Web and server build cache keys include deployment metadata source plus every
release environment value that changes the artifact. Server tests include
`tools/deployment/**/*` as an input and execute the deployment helper suite.
Build targets depend on buildable upstream projects.

Playwright is deliberately uncached, non-parallel, one-worker, and zero-retry
because it owns Chromium and fixed ports `4301` and `4302`. It starts compiled
processes itself and refuses to reuse anything already listening. Deployed smoke
and load commands are direct release tools, not cached merge-gate stages.

## Deterministic Merge Gate

`npm run check` owns its seeds, clocks, local authority, production artifacts,
ports, and browser contexts. It never calls Netlify or Railway and requires no
provider credential, live deployment, account, external API, or pre-existing
process. Online integration uses in-process or compiled local authority
instances.

CI installs the lockfile with `npm ci`, installs Chromium, and runs
`npm run check`. On failure it uploads Playwright report and test-output
diagnostics when present. Those diagnostics are retained for seven days and can
contain screenshots or traces, so treat access to them as build-system access.
The upload reads `dist/.playwright/apps/web-e2e/test-output` and
`dist/.playwright/apps/web-e2e/playwright-report` and ignores absent files.

Only after the deterministic check succeeds, CI performs an uncached web/server
build with release-shaped metadata. It uses intentionally unresolved `.invalid`
web and authority origins, requires all four expected artifact files, and
uploads a seven-day `ci-only-non-promotable-pair` artifact. That pair demonstrates
release build wiring only. It contains `dist/apps/web` and `dist/apps/server`,
and missing files fail this artifact stage. It is not a live smoke result, a
provider candidate, or a promotable release.

## Release Metadata Contract

Both release artifacts use metadata schema 1 and gameplay protocol 1. A
compatible pair uses the same immutable build ID, source revision, and pair
configuration revision.

| Environment value             | Contract                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_RELEASE`          | Exactly `true` for a release artifact; absent or `false` creates non-release metadata                         |
| `DEPLOYMENT_SOURCE_REVISION`  | Exact lowercase 40- or 64-character source revision for both artifacts                                        |
| `DEPLOYMENT_CONFIGURATION_ID` | Non-`local` public configuration revision for both artifacts                                                  |
| `VITE_BUILD_ID`               | Public web build ID; must exactly equal authority `BUILD_ID`                                                  |
| `BUILD_ID`                    | Authority build/runtime ID; a release process refuses a runtime value different from its embedded artifact ID |
| `VITE_ONLINE_ENABLED`         | Public exact `true`/`false` web setting; required for release builds                                          |
| `VITE_ONLINE_AUTHORITY_URL`   | Public exact authority origin, required only when online is enabled                                           |
| `ALLOWED_WEB_ORIGINS`         | Exact comma-separated web origins embedded in authority release metadata and enforced at runtime              |

`VITE_*`, build identity, source revision, configuration identity, protocol, and
allowed origins are public metadata, not secrets. No credential belongs in the
web environment or artifact.

Ordinary local builds emit `release: false` with `local` source and configuration
identity and no production origin claim. They are deterministic local artifacts,
not promotion candidates. Release creation, evidence, and rollback are detailed
in `deployment.md`.

A command result is evidence only for the exact worktree, environment, and
provider target where it ran.
