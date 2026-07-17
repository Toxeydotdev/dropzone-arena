# Production Evidence: 2026-07-17

This record was finalized at `2026-07-17T07:58:56.679Z`. It contains public,
non-secret release evidence only.

## Release Identity

| Field             | Value                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Repository        | `https://github.com/Toxeydotdev/dropzone-arena`                                      |
| Production source | `8240b13bee9be6020e928157222db04b6cebf6e0`                                           |
| Build ID          | `8240b13bee9be6020e928157222db04b6cebf6e0`                                           |
| Configuration ID  | `production-20260717-v1`                                                             |
| Protocol          | `1`                                                                                  |
| Metadata schema   | `1`                                                                                  |
| Final source CI   | `https://github.com/Toxeydotdev/dropzone-arena/actions/runs/29563916174` (`success`) |

The web and authority metadata both identify the source and build above, use
configuration `production-20260717-v1`, and report `release: true`.

## Netlify

| Field                | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Site ID              | `dff85128-71cf-4569-be9b-26d878497e7e`                         |
| Production deploy ID | `6a59df295a27be3236c04fde`                                     |
| Production URL       | `https://dropzone-arena.netlify.app`                           |
| Immutable deploy URL | `https://6a59df295a27be3236c04fde--dropzone-arena.netlify.app` |
| Published            | `2026-07-17T07:52:11.390Z`                                     |
| State/context        | `ready` / `production`                                         |

The CLI production upload was built from the clean production source with
`netlify build --context production`; CLI uploads do not populate Netlify's
`commit_ref`, so the deployed `deployment.json` is the immutable source record.
`netlify.toml` selected the locked targeted web build and `dist/apps/web` publish
directory. `/`, `/index.html`, and `/deployment.json` returned
`public,max-age=0,must-revalidate`; hashed assets returned
`public,max-age=31536000,immutable`. The release metadata names the exact Railway
origin and has online play enabled.

## Railway

| Field                | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| Project ID           | `0a8bbc3f-0c9d-4227-aa0e-847ee3f1789c`                                    |
| Environment ID       | `f0cfc706-e3bc-4736-b8c9-0ae5f74e9bc0`                                    |
| Service ID           | `b26b7351-b44e-412c-bb26-a92e72238812`                                    |
| Service instance ID  | `f1a7ed79-4326-4e40-aa50-702f00e8475a`                                    |
| Final deployment ID  | `760db1f6-4e30-46d9-9f78-c89e531d423d`                                    |
| Public origin        | `https://authority-production-bc7a.up.railway.app`                        |
| Domain ID            | `fe2f26b8-769b-4332-b8fc-d4aa0bce592c`                                    |
| Image digest         | `sha256:9c7eb688f0e144a33ce9e6b52b77af7cd80983f1896bdaf29acb3bfbe12d0449` |
| Region/service class | `sfo` / Railway trial                                                     |

The final deployment reports `SUCCESS` with one running replica, sleeping
disabled, and no volume. It used Railpack with the committed targeted build,
`node dist/apps/server/main.js`, `/api/health`, a 300-second health timeout, and
the on-failure policy with five retries. Committed authority watch paths prevent
browser-only, end-to-end-test, and documentation changes from replacing the
running process.

Final public configuration is:

| Setting                          |                                Value |
| -------------------------------- | -----------------------------------: |
| `ADMISSION_ENABLED`              |                               `true` |
| `ALLOWED_WEB_ORIGINS`            | `https://dropzone-arena.netlify.app` |
| `CONNECTION_ATTEMPTS_PER_MINUTE` |                                 `60` |
| `DRAIN_TIMEOUT_MS`               |                               `2000` |
| `MAX_CONNECTIONS`                |                                 `48` |
| `MAX_PLAYERS_PER_ROOM`           |                                  `8` |
| `MAX_RESERVATIONS`               |                                 `16` |
| `MAX_ROOMS`                      |                                  `4` |
| `MAX_SESSIONS`                   |                                 `32` |
| `MAX_SESSIONS_PER_SOURCE`        |                                  `4` |
| `QUICKPLAY_REQUESTS_PER_MINUTE`  |                                 `12` |
| `ROOM_IDLE_TTL_MS`               |                              `30000` |
| `TRUSTED_PROXY_HOPS`             |                                  `1` |

The trusted-hop decision uses Railway's documented edge-replaced `X-Real-IP`
boundary. The authority prefers that header for one trusted hop, hashes the
normalized address with a per-process salt, and ignores client-appended values
outside the configured boundary.

## Validation

| Stage               | Result                                                                                                                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local gate          | `npm run check` passed after the final source changes: formatting, boundaries, lint, typechecks, strict OpenSpec validation, production builds, 218 unit/integration tests, and 18 Playwright journeys.                                                                                  |
| Final source CI     | Run `29563916174` passed for source `8240b13...` from `2026-07-17T07:42:07Z` through `2026-07-17T07:50:02Z`.                                                                                                                                                                             |
| Closed candidate    | Deployment `a33ec1c0-c6a3-4f55-932e-810402bb0555` returned ready health with `Cache-Control: no-store`; valid quickplay returned `503 SERVICE_UNAVAILABLE` while admission was disabled.                                                                                                 |
| Candidate smoke     | Deployed HTTPS/WSS smoke passed in `1249 ms` with exact metadata/CORS, rejected unlisted origin, admission, two increasing snapshots, acknowledged leave, cleanup, and post-leave health.                                                                                                |
| Representative load | Deployment `f207cf59-e938-4852-9e0b-4f49d71b1d98` passed in `6010 ms`: 32 clients, four arenas, `[8,8,8,8]` players, two snapshots per client, ready health, and clean leave.                                                                                                            |
| Limit restoration   | Deployment `912dee4a-685c-45e5-a49a-ceea1f74ebc3` restored `MAX_SESSIONS_PER_SOURCE=4`, `QUICKPLAY_REQUESTS_PER_MINUTE=12`, and disabled admission. Ready health plus a valid `503 SERVICE_UNAVAILABLE` admission response verified the closed restored state at `2026-07-17T07:56:45Z`. |
| Public promotion    | Final deployment `760db1f6-4e30-46d9-9f78-c89e531d423d` enabled admission with the restored public limits. Post-promotion smoke passed in `850 ms` over WSS with two increasing snapshots and clean leave.                                                                               |

The representative load used only the documented temporary values
`MAX_SESSIONS_PER_SOURCE=32` and `QUICKPLAY_REQUESTS_PER_MINUTE=60`; all room,
player, and process caps remained unchanged. Railway application-log queries
reported no errors during the load or final smoke.

## Privacy Review

- Netlify contains public web configuration only; no provider token, session token, or server-only value is in the static artifact.
- Railway application logs exposed only stable lifecycle events such as `authority-listening`; they contained no token, source address, callsign, statistics, request body, or arena state.
- Railway HTTP logs were not exported because provider edge records can include source addresses and request metadata.
- Netlify Starter and Railway trial still process build and transport metadata under their provider controls. No raw provider-log sample was copied into this repository.

## Rollback And Containment

This is the first production pair, so there is no earlier independent compatible
web and authority release. The verified containment target is Netlify deploy
`6a59df295a27be3236c04fde` with Railway admission disabled and the restored
`4`/`12` controls, as proven by closed deployment
`912dee4a-685c-45e5-a49a-ceea1f74ebc3`.

1. Set `ADMISSION_ENABLED=false` and verify ready health plus rejected valid admission.
2. Keep the current Netlify artifact available so primary local `Drop in` remains usable while online entry reports unavailable.
3. Drain or replace Railway through its normal lifecycle; every active arena, token, callsign, and session statistic is intentionally lost.
4. If the web artifact itself is affected, publish a newly identified local-only artifact with online disabled rather than pairing it with an incompatible authority.
5. Re-enable admission only after a compatible pair passes deployed smoke again.
