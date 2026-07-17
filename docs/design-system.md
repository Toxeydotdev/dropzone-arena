# Signal Yard Design System

## Direction

Signal Yard looks like an after-hours municipal test range picked up by a live
field broadcast. It uses painted safety markings, instrument labels, hard
rectangles, and restrained luminous color. It is not a glossy esports lobby,
cyberpunk purple dashboard, military simulator, or cartoon loot interface.

## Palette

- Asphalt: `#080b0b` and `#111716` for the world and shell.
- Chalk: `#e7eadc` for primary readable text.
- Safety lime: `#d7ff3f` for player agency and primary actions.
- Hot coral: `#ff5b45` for hostile pressure and damage.
- Instrument blue: `#77d9ff` for neutral telemetry and focus.
- Concrete: `#8c958c` for secondary labels and inactive structure.

Color always accompanies shape, label, motion, position, or a numeric value.

## Type And Shape

Use system condensed and monospace stacks to avoid font loading. Display text is
uppercase, tightly led, and short. Operational labels use spaced monospace caps.
Panels use clipped or chamfered corners, 1px rules, and low-opacity fills rather
than generic rounded cards. Buttons are physical lane markers with a strong
offset state, not pill controls.

## Motion

Use short recoil, impact, scan, and score responses that explain state. Camera
shake is small and bounded. Under reduced motion, remove shake, large
translations, pulsing, and particle volume while keeping immediate state changes.

## Local And Public Language

The primary ready action remains local `Drop in`; `Public quickplay` is a
secondary anonymous mode. Do not turn online entry into an account flow, lobby,
room browser, ranked queue, or glossy esports presentation.

Local and online interruption use deliberately different language:

| Context    | Action                                              | Required meaning                                                |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Local solo | `Pause`, `Run paused`, `Resume run`                 | Clock and local arena are frozen                                |
| Online FFA | `Field menu`, `Return`, `Leave arena`, `Play local` | Shared authority remains live and the avatar remains vulnerable |

Never label the online field menu as pause or imply that blur, hiding,
reconnecting, or renderer loss stops the shared arena.

## Online HUD And Roster

The semantic online HUD identifies the mode as `Continuous free-for-all` and
states `No rounds / no winner`. It presents population, generated callsign,
numbered marker, an explicit `You` label, health, dash, life/respawn state,
session kills and deaths, and field-link status. It does not reuse solo timer,
wave, combo, extraction, global score, victory, champion, or round-winner
language.

The roster is an HTML table behind an accessible disclosure when space is
tight. Every player has a generated callsign and numbered/patterned shape marker
in addition to color. The local row includes `You`; life is written as `Active`
or `Eliminated`. Kills and deaths are session facts from authority, not career
statistics.

Connection text uses coarse named states such as `Stable`, `Delayed`,
`Reconnecting`, `Draining`, `Expired`, `Incompatible`, `Capacity full`, and
`Unavailable`. Failure panels distinguish transport, version, expiry, capacity,
draining, and renderer failure and keep retry, fresh quickplay, leave, or local
fallback visible as appropriate.

Elimination exposes a numeric respawn countdown, and respawn is named when it
occurs. Polite live regions announce meaningful transitions such as connection
interruption/restoration, elimination, and respawn. They do not announce every
snapshot, roster refresh, or countdown tick.

## Responsive And Accessible Interaction

Keyboard and mouse controls remain listed on the ready screen. Coarse-pointer
layouts expose move and aim/fire sticks, a separate dash action, and a field-menu
action. All essential actions are at least 44 by 44 CSS pixels and remain outside
safe-area insets.

From 320 CSS pixels upward, essential health, respawn state, field menu, and
touch controls remain visible without horizontal document overflow. The full
roster may collapse, but its disclosure remains keyboard reachable and labeled.
HUD placement must not overlap controls or browser-safe edges.

Visible focus uses a high-contrast outline and is never removed without a
replacement. Forced-colors/high-contrast mode preserves panel, marker, meter,
control, and local-identity boundaries. Color always remains supplemental to
text, number, pattern, shape, position, or state.

Reduced motion removes camera shake, pulsing, large transitions, reconciliation
easing, and excess particles. It must not alter authority, controls, simulation
or respawn timing, or the positional information needed to play.

Canvas is presentation, not the only status source. Objective, connection,
identity, health, respawn, roster, errors, menus, and exit actions remain
available through semantic HTML.
