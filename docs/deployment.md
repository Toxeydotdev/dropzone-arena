# Deployment

## Scope

Production is a split compatible pair:

| Surface   | Provider contract             | Responsibility                                                           |
| --------- | ----------------------------- | ------------------------------------------------------------------------ |
| Web       | Netlify static CDN            | Local-first browser artifact and optional public authority configuration |
| Authority | One always-on Railway service | Health, admission, room assignment, Socket.IO, and 60 Hz FFA authority   |

The Netlify origin, Railway public domain, Railway region, and service class are
deployment-time values that are not yet encoded in this repository. Resolve and
record them from provider state; do not infer or document invented values.

Use HTTPS for web and authority origins and WSS for realtime traffic. The web
artifact contains no secret. Railway hosts exactly one replica in one selected
region, with sleeping disabled and no volume, database, Redis, or shared Socket.IO
adapter. Do not increase replicas: independent processes cannot share rooms,
tokens, or sessions.

## Source And Provider Configuration

Both providers build the same immutable source revision from the repository
root and locked dependencies.

| Provider | Repository configuration     | Build and output                                                                                                         |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Netlify  | `netlify.toml`               | `npm ci && npm exec -- nx run web:build --configuration=production --outputStyle=static`; publish `dist/apps/web`        |
| Railway  | `railway.json` with Railpack | `npm exec -- nx run server:build --configuration=production --outputStyle=static`; start `node dist/apps/server/main.js` |

Netlify caches `/assets/*` as immutable for one year. `/`, `/index.html`, and
`/deployment.json` must revalidate. Railway binds `0.0.0.0:$PORT`, checks
`/api/health`, runs one replica without sleep, and uses the bounded on-failure
restart policy from `railway.json`. Railway watch paths cover authority-affecting
root, server, engine, protocol, and deployment-tool sources so browser-only,
end-to-end-test, and documentation commits do not replace the running authority.

Provider UI settings must agree with committed configuration. Record any setting
the provider applies outside these files, including source repository, branch or
revision, root, region, service class, domain, replica count, sleep policy,
volume state, build command, start command, and health path.

## Release Identity

Set these values on both builds before producing a candidate:

- `DEPLOYMENT_RELEASE=true` exactly.
- `DEPLOYMENT_SOURCE_REVISION` to the same full lowercase 40- or 64-character source revision.
- `DEPLOYMENT_CONFIGURATION_ID` to the same non-`local` revision identifying the compatible pair configuration.
- `VITE_BUILD_ID` on Netlify and `BUILD_ID` on Railway to the same immutable build ID.

Build and configuration IDs are 1-64 ASCII letters, numbers, dots, underscores,
or hyphens, must start alphanumeric, and must not be `local`. The source revision
uses its separate full-revision format. The authority embeds `BUILD_ID` at build
time and refuses startup if the runtime `BUILD_ID` differs. Never reuse an ID for
changed artifact contents or configuration.

The exact compatible pair is therefore:

```text
web.VITE_BUILD_ID == authority.BUILD_ID
web.DEPLOYMENT_SOURCE_REVISION == authority.DEPLOYMENT_SOURCE_REVISION
web.DEPLOYMENT_CONFIGURATION_ID == authority.DEPLOYMENT_CONFIGURATION_ID
web.VITE_ONLINE_AUTHORITY_URL == selected Railway HTTPS origin
authority.ALLOWED_WEB_ORIGINS contains every selected Netlify origin exactly
protocolVersion == 1
```

Changing an origin or another pair-defining value requires a new configuration
ID and rebuilt metadata. Inspect both `deployment.json` files before promotion.
The web record must name `dropzone-arena-web`, `release: true`, online enablement,
and the exact authority origin. The authority record must name
`dropzone-arena-authority`, `release: true`, and the exact allowed web origins.

Normal local builds intentionally emit non-release metadata with `local` source
and configuration identity. They are not promotable even if they run correctly.

## Web Variables

All web variables and emitted deployment metadata are public.

| Variable                      | Release requirement                  | Safe use                                                                                           |
| ----------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_RELEASE`          | Required, exactly `true`             | Fail the build rather than falling back for a release                                              |
| `DEPLOYMENT_SOURCE_REVISION`  | Required full source revision        | Same value as authority                                                                            |
| `DEPLOYMENT_CONFIGURATION_ID` | Required pair configuration revision | Change when public pair configuration changes                                                      |
| `VITE_BUILD_ID`               | Required immutable build ID          | Exactly equal to Railway `BUILD_ID`                                                                |
| `VITE_ONLINE_ENABLED`         | Required exact `true` or `false`     | Use `false` for a local-only candidate; smoke requires an unpromoted candidate rebuilt with `true` |
| `VITE_ONLINE_AUTHORITY_URL`   | Required when enabled                | Exact Railway HTTPS origin, with no path, query, hash, or credentials                              |

Do not place a provider token, API key, private hostname, session token, shared
secret, or server-only setting in a `VITE_*` value, static asset, or Netlify
snippet. Public online entry uses exact origins and ephemeral session tokens, not
a secret embedded in JavaScript.

## Authority Variables

These runtime values have no fallback and must be present:

| Variable              | Requirement                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | Provider-injected integer `1-65535`; do not hardcode or expose a second listener                                                        |
| `BUILD_ID`            | Exact 1-64 character ID embedded in the authority release artifact                                                                      |
| `ALLOWED_WEB_ORIGINS` | One to 16 unique comma-separated exact HTTP(S) origins; production entries use HTTPS, no wildcard, path, query, hash, or trailing slash |

The authority release build also requires `DEPLOYMENT_RELEASE=true`,
`DEPLOYMENT_SOURCE_REVISION`, and `DEPLOYMENT_CONFIGURATION_ID`. Set
`ALLOWED_WEB_ORIGINS` consistently at build and runtime so emitted authority
metadata matches live CORS and WebSocket enforcement.

Bounded optional settings and code defaults are:

| Variable                         | Default | Valid deployment bound or note                                         |
| -------------------------------- | ------: | ---------------------------------------------------------------------- |
| `ADMISSION_ENABLED`              |  `true` | Exact boolean; explicitly set `false` for the initial candidate        |
| `CONNECTION_ATTEMPTS_PER_MINUTE` |    `60` | `1-120` per source                                                     |
| `DRAIN_TIMEOUT_MS`               |  `2000` | `100-10000`                                                            |
| `MAX_CONNECTIONS`                |    `48` | `1-64`, and not below `MAX_SESSIONS`                                   |
| `MAX_PLAYERS_PER_ROOM`           |     `8` | `1-8`                                                                  |
| `MAX_RESERVATIONS`               |    `16` | `1-16`, and not above `MAX_SESSIONS`                                   |
| `MAX_ROOMS`                      |     `4` | `1-4`                                                                  |
| `MAX_SESSIONS`                   |    `32` | `1-32`, and not above rooms times players                              |
| `MAX_SESSIONS_PER_SOURCE`        |     `4` | `1-32`, not above `MAX_SESSIONS`; public value must be restored to `4` |
| `QUICKPLAY_REQUESTS_PER_MINUTE`  |    `12` | `1-60` per source; public value must be restored to `12`               |
| `ROOM_IDLE_TTL_MS`               | `30000` | `1000-300000`                                                          |
| `TRUSTED_PROXY_HOPS`             |     `0` | `0-2`; trust only a verified proxy chain                               |

Protocol-owned bounds are not deployment overrides: ten-second admission and
reconnect windows, 1 KiB quickplay body, 8 KiB inbound messages, eight players,
96 projectiles, and 12 KiB snapshots.

### Trusted Proxy Boundary

Per-source controls select an address from the normalized forwarding chain, then
HMAC it with a random per-process salt. `TRUSTED_PROXY_HOPS=0` ignores forwarded
address headers and is the safe anti-spoofing default, but a proxy may then make
many players appear as one source. For one explicitly trusted hop, the authority
prefers Railway's documented `X-Real-IP` header and otherwise evaluates
`X-Forwarded-For`; deeper chains use `X-Forwarded-For`. A value of `1` or `2` is
safe only after the actual Railway edge chain and header replacement behavior are
verified. Record that evidence before changing the value; never guess a hop count
or trust a client-appended address.

These controls are coarse abuse bounds, not identity or bans. Shared households,
schools, workplaces, carriers, and VPN exits can share a source and receive a
rate or session limit together.

## Candidate And Promotion

Use this order for the first release and any incompatible pair replacement:

1. Record the source revision, pair build ID, configuration ID, intended exact web origins, authority origin, region, service class, and prior rollback pair.
2. Create or update one Railway service from `railway.json`. Confirm one replica, one region, no sleep, no volumes, the committed build/start/health configuration, and `ADMISSION_ENABLED=false`.
3. Build and deploy the authority release with exact origins and identity. Do not expose public quickplay yet.
4. Build an unpromoted Netlify candidate from the same source and identity. For end-to-end candidate validation it must use `VITE_ONLINE_ENABLED=true` and the exact candidate authority origin; keep `Drop in` primary.
5. Inspect both deployment metadata records. Query `/api/health` and require HTTP 200, `Cache-Control: no-store`, service `dropzone-arena-authority`, protocol 1, `status: ready`, and the expected build ID. Admission being disabled does not make health unhealthy.
6. Isolate the candidate from public play, enable admission only for validation, and run deployed smoke against the exact candidate pair.
7. For representative load only, temporarily set `MAX_SESSIONS_PER_SOURCE=32` and `QUICKPLAY_REQUESTS_PER_MINUTE=60` while retaining `MAX_SESSIONS=32`, `MAX_ROOMS=4`, and `MAX_PLAYERS_PER_ROOM=8`. Run the 32-client load check.
8. Mandatory: restore `MAX_SESSIONS_PER_SOURCE=4` and `QUICKPLAY_REQUESTS_PER_MINUTE=12`, verify the provider configuration record, and redeploy if needed. Disable admission again until the public switch. Do not promote while either temporary value remains.
9. Before public enablement, confirm exact production origins, one replica, no sleep, no volume, restored `4`/`12` controls, provider log/privacy settings, and a known rollback pair. Any pair identity change requires rebuilt metadata and repeated validation.
10. Enable authority admission and promote the complete compatible Netlify artifact. Run smoke again against the public web origin and record the result. Local play remains available throughout.

Health proves process, configuration, scheduler, and drain readiness. Full room
capacity is an admission `503` and does not make a healthy process unhealthy.
Health does not prove admission, CORS, realtime snapshots, cleanup, or capacity;
smoke and load provide those separate boundaries.

## Deployed Smoke

Set the shell variables to the selected public values, then run:

```sh
npm run deploy:smoke -- \
  --web-url "$WEB_ORIGIN" \
  --authority-url "$AUTHORITY_ORIGIN" \
  --build-id "$BUILD_ID" \
  --source-revision "$SOURCE_REVISION" \
  --configuration-id "$CONFIGURATION_ID"
```

The command requires HTTPS/WSS and release metadata. It checks revalidated HTML
and `deployment.json`, exact web release identity and authority origin, no-store
health, exact allowlisted CORS, rejection of an unlisted origin, admission,
WebSocket welcome, two strictly increasing snapshots containing the session,
acknowledged leave, cleanup, and health after leave. The optional
`--unlisted-origin` must be a known-unlisted HTTPS origin. The insecure loopback
flag is test-only and must never justify an HTTP deployment.

## Isolated Load Evidence

After applying only the temporary overrides in the promotion sequence, run:

```sh
npm run deploy:load -- \
  --authority-url "$AUTHORITY_ORIGIN" \
  --web-origin "$WEB_ORIGIN" \
  --build-id "$BUILD_ID" \
  --confirm-isolated-pre-enable-candidate
```

The default and representative run is 32 clients. It requires four packed rooms
of eight, two increasing snapshots per client with exact rosters, ready health
before and during load, acknowledged leave, and cleanup. It sends no bypass
header and must not target public play.

Immediately after any load attempt, successful or failed, restore
`MAX_SESSIONS_PER_SOURCE=4` and `QUICKPLAY_REQUESTS_PER_MINUTE=12`. Record both
the temporary configuration and proof of restoration. Four-room capacity remains
provisional until this check passes on the selected Railway service class; lower
configured capacity if timing, memory, snapshot, or egress evidence fails.

## Evidence Record

The initial production record is
[`production-evidence-2026-07-17.md`](./production-evidence-2026-07-17.md).

For every promoted pair, retain public, non-secret evidence for:

- repository and full source revision;
- web and authority build ID, protocol, metadata schema, and configuration ID;
- Netlify site/deploy identity and exact web origin;
- Railway service/deployment identity, exact authority origin, region, service class, and one-replica/no-sleep/no-volume settings;
- exact allowed origins and trusted-proxy decision;
- build, start, publish, and health configuration identity;
- health, deployed smoke, accessibility, and representative load outcomes with timestamps and command output;
- proof that temporary load overrides were restored to `4` and `12`;
- current and previous compatible rollback targets.

Do not record provider credentials, session tokens, raw source addresses, request
bodies, arena state, or private account data in this evidence.

## Provider Logs And Privacy

Application logs contain only stable events and severity. The process keeps raw
session credentials out of logs, stores only credential digests and salted
source digests in memory, and discards arenas, callsigns, credentials, and stats
on restart. The browser keeps its opaque token in same-tab `sessionStorage`.

Netlify and Railway can still observe connection metadata through provider edge,
request, build, and deployment logs. Before public enablement, review actual
retention, access, redaction, request-body/header capture, WebSocket logging, and
deletion controls. Confirm tokens and addresses are not copied into application
or long-lived provider logs beyond unavoidable transport operation. Record the
review outcome without recording sensitive samples.

## Drain And Rollback

Rollback restores compatibility, not live sessions:

1. Set `ADMISSION_ENABLED=false` so no new session enters the affected authority.
2. Restore the previous known-good compatible Netlify artifact, or a local-only artifact with online disabled.
3. Terminate or replace the authority through normal Railway lifecycle. `SIGTERM` makes health not ready, sends `server:draining`, and closes sockets within the bounded drain window.
4. Restore the previous immutable authority artifact and exact configuration when one exists, still with one replica and no sleep.
5. Verify health, enable admission only for the compatible pair, rerun deployed smoke, and record the restored targets.

If no compatible authority is available, leave online entry disabled and keep
local `Drop in` available. Never claim room, token, callsign, kill/death, or
session migration across a deploy, restart, rollback, region change, or process.

## Known Limitations

- One process and one region form one authority and one failure domain.
- Restart, deploy, drain, or rollback loses all ephemeral arenas, tokens, and session statistics.
- Cross-replica scaling, shared room ownership, and seamless session migration do not exist.
- There is no persistence, database, account, custom name, chat, party, progression, or leaderboard.
- Per-source controls are coarse and can affect multiple players behind one address.
- The initial four-room/32-session target is provisional until representative Railway load evidence passes.
