# Dropzone Arena

Dropzone Arena is a local-first browser arena shooter. The primary `Drop in`
action starts a 90-second solo run against bots without an account, download,
lobby, or network service. A separately configured `Public quickplay` action can
join up to eight anonymous players to a continuous server-authoritative
free-for-all. Online failure never removes local play.

There are no purchases, advertising, player telemetry, custom names, or
persistent profiles. Online callsigns, arenas, credentials, kills, and deaths are
ephemeral.

## Controls

| Action                     | Desktop                        | Touch             |
| -------------------------- | ------------------------------ | ----------------- |
| Move                       | `WASD` or arrow keys           | Left stick        |
| Aim and fire               | Pointer and hold primary click | Right stick       |
| Dash                       | `Space` or `Shift`             | Dash button       |
| Pause a local run          | `P`, `Escape`, or `Pause`      | Pause button      |
| Open the online field menu | `P`, `Escape`, or `Field menu` | Field menu button |

Local pause freezes the solo clock and simulation. The online field menu does
not pause shared authority: controls are cleared, but the arena remains live and
the avatar remains vulnerable until the player returns or leaves.

## Prerequisites

- Node `24.14.0`
- npm `11.9.0`

Use the exact versions declared by `.nvmrc`, `package.json`, and `devEngines`.

## Setup

```sh
npm ci
npm run dev
```

The development client opens at `http://localhost:4300`. This setup is
local-first and does not start or require the authority. Public quickplay is
enabled only by validated public build configuration; see
[`docs/deployment.md`](docs/deployment.md).

## Commands

| Command                | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `npm run dev`          | Start the web Vite development server on port `4300`                    |
| `npm run build`        | Run every build target except `workspace` and `web-e2e`                 |
| `npm run typecheck`    | Typecheck every non-workspace project                                   |
| `npm run test`         | Run unit and integration suites, excluding Playwright                   |
| `npm run e2e`          | Run the owned production-build web and authority topology               |
| `npm run lint`         | Verify project boundaries, then run oxlint                              |
| `npm run lint:fix`     | Apply safe oxlint fixes and deny remaining warnings                     |
| `npm run format`       | Format supported repository files with oxfmt                            |
| `npm run format:check` | Check repository formatting through Nx                                  |
| `npm run spec:check`   | Strictly validate every OpenSpec package                                |
| `npm run check:quick`  | Run formatting, lint, types, tests, and specs                           |
| `npm run check`        | Add production builds and Playwright to the quick gate                  |
| `npm run deploy:smoke` | Validate an identified deployed compatible pair with required arguments |
| `npm run deploy:load`  | Validate an isolated pre-enable candidate with required arguments       |
| `npm run graph`        | Open the Nx project graph                                               |

The deployed smoke and load commands are release evidence, not merge-gate
stages. They intentionally remain outside `npm run check`; append `-- --help`
to either command for its exact arguments.

## Repository Map

| Path                  | Ownership                                                           |
| --------------------- | ------------------------------------------------------------------- |
| `apps/web`            | Static Vite/React entrypoint and public build configuration         |
| `apps/server`         | HTTP admission, Socket.IO transport, rooms, authority, and shutdown |
| `apps/web-e2e`        | Built web-plus-server Playwright topology                           |
| `libs/arena-client`   | React, input, audio, netcode, Three.js, and browser lifecycle       |
| `libs/arena-engine`   | Pure deterministic solo and FFA simulation                          |
| `libs/arena-protocol` | Versioned wire records, schemas, events, and payload bounds         |
| `tools/deployment`    | Release metadata plus deployed smoke and load checks                |
| `openspec`            | Current required behavior and approved changes                      |
| `docs`                | Architecture, design, testing, quality, and deployment knowledge    |

The enforced internal graph is:

```text
web -> arena-client -> arena-engine
                   -> arena-protocol

server -> arena-engine
       -> arena-protocol

web-e2e -> web
        -> server
```

`tools/check-project-boundaries.mjs` rejects undeclared projects and all other
internal edges. Read `AGENTS.md` and the nearest scoped guide before changing a
project.

## Known Limitations

- Online authority is one process in one region and one failure domain.
- A restart or deploy loses every ephemeral arena, credential, and session stat.
- Cross-replica room or session scaling and migration are not implemented.
- There is no persistence, account, custom name, chat, party, or leaderboard.
- Per-source admission controls are coarse and can group players on shared networks.
- Four-room, 32-session capacity is provisional until representative Railway load evidence passes.
