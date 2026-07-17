# arena-run Specification

## Purpose

Define the immediate, deterministic, responsive, and accessible behavior of a
finite local arena run, including desktop and touch control, safe interruption,
terminal outcomes, and progressive WebGL presentation.

## Requirements

### Requirement: Immediate arena entry

The browser application SHALL expose the arena premise, controls, and one
primary drop action without requiring an account, download, network service,
lobby, persistence consent, or tutorial completion.

#### Scenario: Player opens the application

- **WHEN** the static application loads successfully
- **THEN** a named ready surface explains the 90-second objective and exposes an enabled `Drop in` action in the initial viewport

#### Scenario: Player starts a run

- **WHEN** the player activates `Drop in`
- **THEN** one fresh arena simulation starts, the gameplay HUD becomes visible, and keyboard or touch input can affect the player immediately

### Requirement: Deterministic finite arena simulation

The arena engine SHALL derive movement, spawning, projectiles, collisions,
damage, pickups, scoring, and terminal state only from explicit prior state,
input, seeded random state, and fixed elapsed steps. A run SHALL end in defeat at
zero health or extraction after 90 simulated seconds.

#### Scenario: Inputs and seed are repeated

- **WHEN** two engine runs receive the same initial seed and fixed-step input sequence
- **THEN** they produce equal serializable states, events, score, and outcome

#### Scenario: Display frame stalls

- **WHEN** a browser frame arrives after a long delay
- **THEN** the client caps elapsed catch-up work and does not convert all hidden or stalled wall time into simulation steps

#### Scenario: Player survives the run

- **WHEN** the player retains health through 90 simulated seconds
- **THEN** the run enters extracted state once and the debrief reports the final score and statistics

#### Scenario: Player loses all health

- **WHEN** accepted collision damage reduces health to zero
- **THEN** the run enters defeated state once, stops accepting gameplay advancement, and exposes a restart action

### Requirement: Desktop and touch combat controls

The browser client SHALL support movement, directional fire, dash, and pause on
keyboard/mouse and SHALL expose equivalent movement, directional fire, dash,
and pause controls for coarse pointers.

#### Scenario: Desktop player fights

- **WHEN** a playing desktop user holds movement keys, aims the pointer, holds primary click, and presses Space or Shift
- **THEN** the player moves, fires toward the projected arena aim, and dashes with a visible cooldown

#### Scenario: Touch player fights

- **WHEN** a playing coarse-pointer user manipulates the left and right sticks and activates dash
- **THEN** the player moves, aims and fires, and dashes without document scrolling or controls entering unsafe screen insets

### Requirement: Safe pause and interruption

The application SHALL suspend simulation on explicit pause, window blur, or a
hidden document and SHALL resume from the same arena state without applying the
interrupted wall time.

#### Scenario: Player pauses explicitly

- **WHEN** a playing user presses `P`, Escape, or the visible pause control
- **THEN** simulation and held fire stop, a named paused surface appears, and resume returns to the same run

#### Scenario: Browser loses focus

- **WHEN** the playing document becomes hidden or its window loses focus
- **THEN** the run pauses before more simulation time, damage, or score can accrue

### Requirement: Progressive and accessible presentation

The application SHALL keep objective, health, time, score, wave, status,
controls, errors, and debrief in semantic HTML while using Three.js for visual
arena presentation. It SHALL honor reduced motion and provide a recoverable
renderer failure state.

#### Scenario: Motion reduction is requested

- **WHEN** the user requests reduced motion
- **THEN** camera shake, large transitions, pulsing, and excess particles are removed without changing simulation rules or hiding state

#### Scenario: WebGL construction fails

- **WHEN** the Three.js runtime cannot create or retain a rendering context
- **THEN** partial resources are disposed and a visible named failure surface offers retry without an indefinite loading state

#### Scenario: Arena renders on mobile portrait

- **WHEN** gameplay renders at a supported mobile portrait width
- **THEN** essential HUD and touch controls remain readable and reachable with no horizontal document overflow
