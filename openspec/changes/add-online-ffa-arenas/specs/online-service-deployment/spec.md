## ADDED Requirements

### Requirement: Split CDN and single-authority production topology

Production SHALL serve the browser application as static assets from a CDN and SHALL run exactly one always-on Railway authority for health, admission, assignment, realtime transport, and authoritative simulation. Authority failure MUST NOT prevent the CDN application from offering local solo play.

#### Scenario: Player loads healthy production

- **WHEN** the production CDN and Railway authority are healthy
- **THEN** the browser loads static assets from the CDN and sends online admission and realtime traffic only to the configured Railway authority

#### Scenario: Railway is unavailable

- **WHEN** the CDN remains available while Railway cannot accept traffic
- **THEN** the application still loads, keeps local `Drop in` usable, and presents online quickplay as unavailable or retryable

#### Scenario: Railway scaling is applied

- **WHEN** the production service applies its runtime scaling configuration
- **THEN** one non-sleeping replica accepts gameplay without independent authorities receiving the same arena's traffic

### Requirement: Secure public routing and origin restriction

Production browser and authority traffic SHALL use HTTPS and WSS. The authority MUST accept browser admission and realtime connections only from exact configured origins, and public client configuration MUST contain only non-secret endpoint, build, and compatibility information.

#### Scenario: Production client connects

- **WHEN** the CDN client starts online admission and transport
- **THEN** it uses the configured secure Railway endpoint without exposing a server secret

#### Scenario: Unapproved website connects

- **WHEN** admission or realtime transport originates from a website outside the allowlist
- **THEN** the authority rejects it before creating or resuming a session

#### Scenario: Public web artifact is inspected

- **WHEN** a user downloads the production assets and public configuration
- **THEN** they contain no server secret, private provider credential, or reusable player credential

### Requirement: Non-sensitive Railway readiness

The Railway authority SHALL expose `GET /api/health` as a stable unauthenticated readiness endpoint. It MUST report success only after required configuration is valid, the scheduler is ready, and the process can evaluate admission and realtime upgrades. Its response MUST NOT expose secrets, credentials, callsigns, addresses, session statistics, or arena state.

#### Scenario: Authority is ready

- **WHEN** the configured process can serve its owned interfaces and is not draining
- **THEN** `/api/health` returns success with non-sensitive service, release, and protocol identity and disables response caching

#### Scenario: Authority is not ready

- **WHEN** startup configuration is invalid, scheduler readiness is lost, or shutdown has begun
- **THEN** `/api/health` does not report ready and Railway does not promote the process as healthy

#### Scenario: Arenas are full

- **WHEN** healthy authority has no admission capacity but continues serving existing bounded arenas
- **THEN** health remains accurate and quickplay returns a separate capacity response

### Requirement: Validated configuration and secret isolation

The authority SHALL validate allowed origins, public release identity, protocol, reconnect grace, room and connection capacity, entity and payload bounds, and rate limits before readiness. It MUST fail closed for missing or invalid required values. Server secrets SHALL remain in Railway-managed configuration and MUST NOT appear in CDN assets, health, logs, or client-visible errors.

#### Scenario: Required configuration is invalid

- **WHEN** Railway starts with a missing or malformed required value
- **THEN** authority refuses readiness and accepts no admission or realtime gameplay

#### Scenario: Deployment bounds change

- **WHEN** an operator deploys valid updated capacity or rate configuration within tested limits
- **THEN** the replacement validates and enforces those hard bounds before reporting ready

#### Scenario: Secret-bearing error occurs

- **WHEN** startup or request handling encounters private configuration
- **THEN** public responses and application logs use stable redacted errors rather than emitting the secret value

### Requirement: Immutable identifiable release artifacts

Each release SHALL produce identifiable immutable web and authority artifacts and SHALL record build identity, protocol compatibility, public origins, and provider configuration. The CDN MUST preserve versioned asset contents, and its production entry MUST select only a completely uploaded release.

#### Scenario: Candidate artifacts are built

- **WHEN** a release candidate is produced
- **THEN** its web artifact, authority artifact, source commit, protocol, and configuration revision can be identified for promotion and rollback

#### Scenario: Versioned asset is cached

- **WHEN** a cache requests a previously published hashed asset
- **THEN** that asset retains its original immutable contents rather than being overwritten by a newer release

#### Scenario: Entry document is updated

- **WHEN** a new compatible web release is promoted
- **THEN** the entry document revalidates to the complete new artifact while hashed assets retain immutable caching

### Requirement: Deterministic live-service-independent merge gate

`npm run check` SHALL remain deterministic and MUST NOT require Netlify, Railway, provider credentials, external network services, or a pre-existing process. Online engine, protocol, service, and browser checks SHALL use explicit seeds, fixed steps, controlled local authority instances, and local production artifacts.

#### Scenario: Merge gate runs offline

- **WHEN** `npm run check` executes in a clean supported environment without provider access
- **THEN** formatting, boundaries, linting, type checking, tests, builds, and browser checks can complete from repository and installed dependency inputs

#### Scenario: Online integration runs locally

- **WHEN** the gate exercises admission, snapshots, reconnect, capacity, or failure
- **THEN** it uses lifecycle-owned local authority and controlled inputs rather than live Railway or arbitrary delays

### Requirement: Separate deployed smoke validation

The release process SHALL provide a separately invoked smoke check against selected Netlify and Railway targets. Before promotion it MUST verify the static application, readiness, exact origin behavior, anonymous admission, realtime connection, increasing authoritative state, and clean session closure, and it MUST remain outside `npm run check`.

#### Scenario: Candidate deployment is healthy

- **WHEN** deployed smoke targets a compatible candidate web and authority pair
- **THEN** it loads the CDN application, observes readiness, admits a session, receives increasing authoritative snapshots, leaves cleanly, and reports success

#### Scenario: Candidate deployment fails

- **WHEN** static load, readiness, origin handling, admission, realtime upgrade, snapshot, or leave validation fails
- **THEN** smoke reports failure and the pair is not described as known-good production

### Requirement: Compatible promotion and controlled drain

The deployment process SHALL promote only a web and authority pair whose protocol versions are compatible and whose required checks passed. Authority replacement MUST stop new admission, expose draining state, and close ephemeral sessions within a bounded window. Local solo MUST remain available throughout promotion.

#### Scenario: Compatible candidate passes

- **WHEN** candidate authority is ready and deployed smoke passes for the identified pair
- **THEN** the pair can be promoted and recorded as current known-good production

#### Scenario: Candidate versions conflict

- **WHEN** the candidate web protocol is unsupported by candidate authority
- **THEN** promotion is blocked before the incompatible pair becomes the production online path

#### Scenario: Authority receives termination

- **WHEN** Railway asks an active authority to terminate
- **THEN** it refuses new admission, reports not ready, notifies connected clients of draining, and closes within the documented bound

### Requirement: Restorable production rollback

The deployment process SHALL retain the previous known-good immutable web artifact, authority artifact, and required configuration and SHALL document repeatable rollback to a compatible pair. Rollback MUST NOT depend on preserving or migrating arenas, credentials, or statistics, and local solo SHALL remain usable while online service is restored.

#### Scenario: New authority fails validation

- **WHEN** a candidate or promoted authority fails required readiness or smoke
- **THEN** rollback restores the previous compatible authority and web configuration when available and reruns validation

#### Scenario: Rollback interrupts sessions

- **WHEN** replacing the single authority terminates active ephemeral sessions
- **THEN** clients receive visible transport failure and can start fresh quickplay or local solo without state migration

#### Scenario: Web release requires rollback

- **WHEN** the CDN release fails validation while authority remains healthy
- **THEN** rollback restores the previous compatible entry and immutable assets
