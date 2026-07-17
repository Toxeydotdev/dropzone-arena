## ADDED Requirements

### Requirement: Continuous human free-for-all arena

Each online arena SHALL host no more than eight admitted human players in a continuous free-for-all world. It SHALL have no teams, bots, rounds, prematch countdown, global match reset, terminal winner, or effect on local solo rules.

#### Scenario: Player joins an active arena

- **WHEN** an admitted player connects to an arena already in progress
- **THEN** the player receives the current authoritative world and roster, enters without a round countdown, and does not reset the arena or existing session statistics

#### Scenario: Player leaves an active arena

- **WHEN** a player leaves while other players remain
- **THEN** the shared arena continues without ending a round, declaring a winner, or resetting world state

#### Scenario: One player remains

- **WHEN** only one connected player remains in an online arena
- **THEN** the arena remains playable without adding bots or declaring that player the winner

### Requirement: Deterministic server authority

The online authority SHALL be the sole source of accepted positions, movement, dashes, projectiles, damage, eliminations, spawn outcomes, and session statistics. It MUST advance deterministic multiplayer rules from explicit prior state, seeded random state, ordered lifecycle changes, accepted inputs, and fixed elapsed steps. Clients MUST submit input intent rather than gameplay outcomes.

#### Scenario: Authoritative simulation is repeated

- **WHEN** two authority runs receive the same initial state, seed, fixed-step sequence, lifecycle changes, and accepted player inputs
- **THEN** they produce equal serializable world states, events, eliminations, and session statistics

#### Scenario: Client declares a gameplay outcome

- **WHEN** a client attempts to declare its position, health, damage, elimination, spawn, projectile, or statistics
- **THEN** the authority rejects or ignores that declaration and continues from accepted input intent only

#### Scenario: Authority publishes live state

- **WHEN** the authority advances an occupied arena
- **THEN** admitted clients receive ordered authoritative snapshots sufficient to present the current world and reconcile predictions

### Requirement: Safe live entry and automatic respawn

The authority SHALL place newly admitted and respawning players at deterministic valid positions inside the playable arena. A selected position MUST avoid blocked geometry, living players, and active damaging paths. An eliminated connected player SHALL return automatically after exactly three authoritative seconds without resetting the arena or requiring activation.

#### Scenario: Player first enters the world

- **WHEN** an admitted player is ready to enter a live arena
- **THEN** the authority places the player at a valid protected spawn and includes that player in subsequent snapshots

#### Scenario: Player is eliminated

- **WHEN** accepted authoritative damage reduces a player's health to zero
- **THEN** the player becomes non-collidable and unable to act, and the client exposes a visible three-second respawn countdown

#### Scenario: Respawn delay elapses

- **WHEN** three authoritative seconds have elapsed since elimination
- **THEN** the player returns automatically at full health at a valid protected spawn while the arena and session statistics continue

#### Scenario: Protected player attacks

- **WHEN** a newly spawned player fires or dashes during spawn protection
- **THEN** protection ends before that action can combine offense with continued protection

### Requirement: Authoritative session kills and deaths

The authority SHALL record one death for each eliminated player and one kill for the player whose accepted damage caused that elimination. The client SHALL expose each rostered player's generated callsign and session kills and deaths. Statistics MUST survive respawns and successful reconnects within grace, MUST reset for a new session, and MUST NOT become local-run or persistent career statistics.

#### Scenario: One player eliminates another

- **WHEN** one player's accepted damage causes another player's elimination
- **THEN** the authority increments the attacker's kills and the victim's deaths exactly once

#### Scenario: Eliminated player respawns

- **WHEN** a player with recorded kills or deaths respawns
- **THEN** the existing session statistics remain visible and continue accumulating

#### Scenario: Player joins live state

- **WHEN** a player receives the first snapshot for an active arena
- **THEN** the player can identify the current roster and each participant's current session kills and deaths

### Requirement: Desktop and touch online combat controls

The online client SHALL support movement, directional aim and fire, dash, and a field menu through keyboard and mouse. It SHALL provide equivalent controls for coarse pointers, and every gameplay control MUST submit bounded input intent rather than directly changing authoritative state.

#### Scenario: Desktop player fights online

- **WHEN** a connected desktop player uses movement keys, pointer aim, primary fire, and dash
- **THEN** the client provides immediate control feedback, submits corresponding intent, and presents the resulting authoritative state

#### Scenario: Touch player fights online

- **WHEN** a connected coarse-pointer player operates movement, aim-and-fire, dash, and field-menu controls
- **THEN** the client submits equivalent intent without document scrolling and keeps actions reachable outside browser safe-area insets

### Requirement: Prediction, interpolation, and reconciliation

The online client SHALL predict immediate local-player movement, interpolate remote players between ordered authoritative snapshots, and reconcile predicted state to newer authority. Prediction and interpolation MUST NOT commit health, damage, projectile collision, elimination, spawn, kill, or death outcomes.

#### Scenario: Local input precedes the next snapshot

- **WHEN** a connected player supplies valid movement input before the next authoritative snapshot
- **THEN** the local player receives immediate predicted movement feedback while final position remains subject to reconciliation

#### Scenario: Remote snapshots arrive normally

- **WHEN** ordered snapshots contain successive states for a remote player
- **THEN** the client presents that player between authoritative states rather than treating local simulation as remote authority

#### Scenario: Prediction disagrees with authority

- **WHEN** a newer authoritative snapshot differs from local prediction
- **THEN** the client converges to authority without fabricating confirmed damage, elimination, or statistics

#### Scenario: Stale snapshot arrives

- **WHEN** a snapshot is older than the newest applied authoritative state
- **THEN** the client does not replace newer world state or replay already reconciled events

#### Scenario: Snapshot delivery stalls

- **WHEN** the client cannot interpolate from fresh authoritative snapshots within the bounded tolerance
- **THEN** it holds the last bounded presentation, reports delayed service, and does not extrapolate indefinitely

### Requirement: Online interruption does not pause shared authority

The online authority MUST continue advancing an occupied arena when one client opens its field menu, loses window focus, hides its document, loses transport, or suspends rendering. The client SHALL clear held controls on interruption and SHALL restore current authoritative state on return without replaying hidden wall time or representing the shared arena as paused.

#### Scenario: Player opens the field menu

- **WHEN** an online player presses `P`, Escape, or the visible menu action
- **THEN** held controls clear, the menu states that the field remains live, and the authority continues advancing the player and arena

#### Scenario: Online document becomes hidden

- **WHEN** a connected player's document becomes hidden or its window loses focus
- **THEN** held controls are released while authoritative movement, damage, elimination, respawn, and statistics continue

#### Scenario: Player returns after interruption

- **WHEN** an interrupted document becomes active again
- **THEN** the client presents a fresh authoritative world instead of resuming stale state or applying hidden-time catch-up

### Requirement: Accessible responsive online presentation

The online client SHALL expose the free-for-all objective, health, connection state, respawn countdown, generated callsign, roster, and session kills and deaths through semantic HTML. It MUST identify the local and remote players through labels or shapes in addition to color, remain usable on supported mobile portrait layouts, and honor reduced motion without changing authoritative rules.

#### Scenario: Online status is read without canvas interpretation

- **WHEN** assistive technology examines an active online session
- **THEN** local status, connection, respawn, roster callsigns, kills, and deaths are available without interpreting rendered pixels

#### Scenario: Reduced motion is requested

- **WHEN** an online player requests reduced motion
- **THEN** shake, large transitions, pulses, correction easing, and excess particles are removed while controls, authority, timing, and necessary positional presentation remain understandable

#### Scenario: Online arena renders on mobile portrait

- **WHEN** online play renders at a supported mobile portrait width
- **THEN** essential status and touch actions remain readable, at least 44 CSS pixels where actionable, outside unsafe insets, and free from horizontal document overflow

### Requirement: Recoverable online renderer failure

The online client SHALL provide a named recoverable failure state when the renderer cannot be created or its context is lost. It MUST dispose partial resources, clear held controls, explain that the shared arena cannot pause, and offer renderer retry and session-exit actions without remaining in indefinite loading.

#### Scenario: Renderer fails before admission

- **WHEN** the renderer cannot be created before an online session is admitted
- **THEN** no online session is created and the player receives retry and local-play actions

#### Scenario: Renderer fails during online play

- **WHEN** the rendering context is lost during an online session
- **THEN** held input is neutralized, transport enters bounded recovery, resources are disposed, and a visible surface explains that the arena remains live

#### Scenario: Renderer retry succeeds

- **WHEN** renderer retry succeeds while the session can still reconnect
- **THEN** presentation rebuilds from a fresh authoritative snapshot rather than stale prediction
