## ADDED Requirements

### Requirement: Optional online entry with local fallback

The browser application SHALL preserve local `Drop in` as the primary immediate action and SHALL expose public quickplay as an optional secondary mode. Missing configuration, service outage, capacity, or protocol incompatibility MUST NOT disable, delay, or change local solo play.

#### Scenario: Application opens without online service

- **WHEN** the static application loads while online authority is unavailable or unconfigured
- **THEN** local `Drop in` remains enabled and online entry reports its unavailable state without blocking solo play

#### Scenario: Player chooses public quickplay

- **WHEN** the player activates the secondary public quickplay action
- **THEN** the application begins anonymous admission without replacing or modifying local solo mode

#### Scenario: Online admission fails

- **WHEN** admission cannot complete
- **THEN** the application presents bounded retry and local solo actions without requiring page reload

### Requirement: Anonymous admission and generated callsigns

The quickplay service SHALL admit players without an account, sign-in, email, custom name, durable identifier, room code, or prematch lobby. It SHALL issue a server-generated neutral callsign and ephemeral credential, and the callsign MUST distinguish current participants in the assigned arena.

#### Scenario: Anonymous player is admitted

- **WHEN** a compatible client requests public quickplay within admission limits
- **THEN** the service returns an ephemeral session, generated callsign, and arena assignment without requesting account or personal information

#### Scenario: Callsign would duplicate a participant

- **WHEN** a generated callsign already belongs to a current participant in the target arena
- **THEN** the service assigns a different callsign before admission

#### Scenario: Client submits display text

- **WHEN** an admission request includes player-provided display text
- **THEN** the service rejects or ignores that text and uses only a curated generated callsign

### Requirement: Immediate public arena assignment

The service SHALL assign an admitted player to a compatible live public arena with capacity or create fresh arena state when process capacity permits. It MUST NOT require an invitation, party, room selection, skill-based matchmaking, ranked queue, or another player before entry.

#### Scenario: Live arena has capacity

- **WHEN** a player is admitted while a compatible live arena has an open slot
- **THEN** the service assigns that arena and lets the player enter its current state

#### Scenario: No live arena has a slot

- **WHEN** no compatible live arena has capacity but process capacity remains
- **THEN** the service creates a fresh arena and assigns the player without waiting for additional players

### Requirement: Strict arena and service capacity

The service SHALL enforce a hard maximum of eight admitted slots per arena, including unexpired reconnect reservations. It MUST enforce configured hard limits for rooms, sessions, pending admissions, connections, entities, and message work and MUST reject excess work instead of overcommitting those limits.

#### Scenario: Ninth arena slot is requested

- **WHEN** an arena already has eight connected or reconnect-held sessions
- **THEN** another player is assigned elsewhere or receives a visible capacity result and is never admitted as a ninth slot

#### Scenario: Process capacity is exhausted

- **WHEN** a valid admission arrives after a configured process limit is reached
- **THEN** the service rejects it with a retryable capacity result and the client offers retry or local solo play

#### Scenario: Capacity is reached during an active arena

- **WHEN** new admission is disabled by capacity while admitted players remain
- **THEN** existing bounded arenas continue and health does not falsely claim process failure solely because they are full

### Requirement: No persistent player identity

The service MUST NOT create durable profiles, career statistics, progression, rankings, leaderboard entries, friends, parties, or reusable credentials. Callsigns, credentials, and session statistics SHALL exist only for the active session and bounded reconnect grace, and process restart SHALL be allowed to end all ephemeral sessions.

#### Scenario: Reconnect grace expires

- **WHEN** a disconnected player's grace expires
- **THEN** the credential becomes invalid and the service releases the callsign, arena slot, kills, and deaths

#### Scenario: Former player returns later

- **WHEN** a player requests quickplay after the former session expired
- **THEN** the service creates a fresh anonymous session with a generated callsign and zero kills and deaths

#### Scenario: Authority restarts

- **WHEN** a process restart discards an ephemeral session
- **THEN** the prior credential is rejected and the client can request fresh quickplay or use local solo play

### Requirement: Bounded reconnect grace

The service SHALL reserve a disconnected player's slot, callsign, life state, kills, and deaths for ten seconds. It MUST resume only when the valid ephemeral credential is presented within that grace, and shared authority MUST continue while the player is disconnected.

#### Scenario: Player reconnects within grace

- **WHEN** a disconnected player presents the valid credential before ten seconds elapse
- **THEN** the service restores the same arena, callsign, life state, kills, and deaths and sends a fresh authoritative snapshot

#### Scenario: Player reconnects after grace

- **WHEN** a client presents a credential after grace expiry
- **THEN** the service rejects it, releases the reserved slot, and requires fresh admission

#### Scenario: Player deliberately leaves

- **WHEN** a connected player explicitly leaves online play
- **THEN** the service ends reconnect eligibility and releases the participant immediately

#### Scenario: Transport disconnects during combat

- **WHEN** a player's transport closes unexpectedly
- **THEN** authority neutralizes held input while the avatar remains present and vulnerable during reconnect grace

### Requirement: Versioned admission and realtime protocol

Admission and realtime communication SHALL carry an explicit protocol version. The service MUST reject an unsupported version before participation or input application, and the client SHALL present incompatibility as a named recoverable state rather than partial gameplay.

#### Scenario: Client and service versions match

- **WHEN** the client requests admission and opens transport with a supported version
- **THEN** the service completes admission and sends the initial session and authoritative arena state

#### Scenario: Client version is unsupported

- **WHEN** admission or transport uses an unsupported version
- **THEN** the service rejects participation before applying input and the client reports that online client and service are incompatible

### Requirement: Strict request, origin, and input validation

The authority MUST validate allowed origin, credential, protocol version, schema, sequence, finite numeric bounds, actions, and payload size before applying input. It SHALL enforce hard admission, connection, and input rates, and invalid or excessive traffic MUST NOT alter authority or consume work beyond configured bounds.

#### Scenario: Client sends invalid input

- **WHEN** a realtime message has an invalid schema, sequence, non-finite value, out-of-range vector, unknown field, or excessive payload
- **THEN** the authority rejects it without applying movement, fire, damage, elimination, or statistics

#### Scenario: Player exceeds input rate

- **WHEN** a session sustains more input traffic than its hard rate
- **THEN** the authority drops or closes the offending session according to policy while continuing bounded service for compliant participants

#### Scenario: Source exceeds admission rate

- **WHEN** admission or connection attempts exceed a configured source limit
- **THEN** the service rejects excess attempts without issuing sessions or consuming player slots

#### Scenario: Browser origin is not allowed

- **WHEN** a browser attempts admission or realtime transport from outside the exact allowlist
- **THEN** the service rejects it before issuing or accepting a gameplay session

### Requirement: Visible transport lifecycle and retry

The online client SHALL time-bound initial connection and reconnection, distinguish connecting, reconnecting, incompatible, capacity-limited, draining, expired, and unavailable states, and MUST NOT remain indefinitely loading. It SHALL offer online retry and local solo whenever online play cannot continue.

#### Scenario: Initial transport fails

- **WHEN** admission succeeds but realtime transport cannot attach within its bound
- **THEN** the client reports online transport unavailable and offers retry or local solo

#### Scenario: Active transport is interrupted

- **WHEN** realtime transport closes unexpectedly during online play
- **THEN** the client clears held controls, exposes reconnecting with remaining grace, and does not claim the arena is paused

#### Scenario: Reconnect succeeds

- **WHEN** transport resumes with a valid credential inside grace
- **THEN** the client replaces stale state with a fresh authoritative snapshot and returns to online presentation

#### Scenario: Player chooses solo during failure

- **WHEN** the player chooses local solo while online connection or reconnection is failing
- **THEN** online retries stop and a fresh local run starts without online authority

### Requirement: Ephemeral empty arena lifecycle

The service SHALL expire an arena after it has no connected players and no unexpired reconnect reservation for a bounded idle period. It MUST NOT preserve empty room state across expiry or process restart.

#### Scenario: Last reservation ends

- **WHEN** the final connected session leaves or its grace expires
- **THEN** the arena stops active stepping and becomes eligible for bounded expiry

#### Scenario: Player arrives after expiry

- **WHEN** quickplay occurs after a former empty arena expired
- **THEN** the service assigns another live arena or creates fresh state rather than restoring the expired world
