# Artwork Multiplayer Gamification Handoff

This file summarizes the current `fabric-artwork` runtime context and the multiplayer dome-game planning that was persisted in Aimparency (`fabric-artwork/.bowman`).

## Runtime Context In `fabric-artwork`

`./fabric-artwork` is intended to become the authoritative runtime for the planetarium game. The game should stay separate from the normal `net-panel` / `av-controls` path, although a supervisor tool may later run in parallel for curated adjustments after world switches.

The current camera conventions in `fabric-artwork/src/camera.ts` matter for everything:

- local player basis:
  - `right = (1, 0, 0)`
  - `up = (0, 1, 0)`
  - `back = (0, 0, 1)`
- domemaster attention basis:
  - `attentionRight = (1, 0, 0)`
  - `attentionForward = (0, -sin(pi/4), cos(pi/4))`
  - `attentionUp = normalize(cross(attentionForward, attentionRight))`
- practical meaning:
  - current runtime "front" is a 45 degree tilt away from zenith toward negative `y` in domemaster texture space
  - this is the agreed correct convention and should not be flipped casually

The current `Camera` class already has:

- an authoritative camera position in space
- a controller orientation quaternion
- a `playerRotation` matrix
- a `rotation` matrix derived through `domemasterToPlayer`
- existing camera fly controls that are useful as a reference for basis semantics, but not as the final multiplayer transport architecture

For the game, "reach the sphere" means:

- the planetarium camera/origin point for raymarching moves through space
- when that point, optionally with an extra collision/trigger radius, gets close enough to the collectible sphere, the transition effects ramp up
- hit detection and stage switching remain authoritative in `fabric-artwork`

## Agreed Multiplayer Model

### Client Responsibilities

The phone performs calibration locally.

Each client sends:

- `direction`: normalized dome-space direction vector
- current single-button state: `accelerate`

Intent:

- the cursor points to where the phone points on the dome, approximately
- clients do not send velocity or authoritative physics results
- clients do not own hit detection

### Transport

Latest decision:

- use WebRTC for low-latency realtime game input
- orientation vectors go over WebRTC
- buttons should also go over WebRTC for lowest latency

Important note:

- there is an older Aimparency item called `Design dual-transport realtime input protocol` that still mentions WebRTC for orientation and WebSocket for reliable buttons
- that item reflects an earlier state of the discussion and is now stale relative to the later decision to move buttons to WebRTC too

### Game Loop Combination Rule

Inside the authoritative `fabric-artwork` runtime:

- when a client holds `accelerate`, add that client's current `direction` to the collective acceleration sum
- scale the summed direction vector by the acceleration control
- apply that collective acceleration to the shared camera velocity
- integrate velocity into the shared camera position in space

Camera orientation follows the resulting motion:

- compute the desired front from the current camera velocity direction
- blend it slowly: `newFront = normalize(0.9 * oldFront + 0.1 * velocityDirection)`
- derive the new right and top/up vectors by cross product

### Presence, Activity, and Cursors

- all players see all cursors because there is only one dome
- render one cursor per active player
- prune clients that stop heartbeating
- use time since last input change to fade inactive cursors
- suggested behavior: cursor alpha decays with inactivity so stale players are muted rather than immediately disappearing

## Level / World Progression

The collectible / beacon / next-level representation is:

- a sphere
- unioned with the next SDF world / beacon / item

The current preferred transition language:

- keep the existing linear SDF interpolation approach
- as the shared camera approaches the collectible sphere:
  - ramp up satisfying / violent effects
  - blur the containing sphere boundary so the inner SDF leaks into the current world
  - increase a frequency parameter by about `3x` while outside but near the sphere
- on entering / falling into the new world:
  - change `pan`
  - change scale behavior so scaling converges around the current camera position back toward normal scale factor `1`
  - preserve continuity so the transition feels like falling through rather than a hard cut

Level progression should combine:

- randomness
- some curated control

Possible direction:

- random or weighted placement / selection for next worlds
- optional supervisor adjustments after a world switch through a parallel tool path

## Guidance Ideas

Two guidance ideas were explicitly kept:

### Twisted 3D Cross Guide

Add a cheap extra SDF term:

- a 3D cross of lines
- twisted
- radius increasing away from the sphere position

Purpose:

- act as a world-space guidance structure
- help players orient toward the collectible sphere without adding UI clutter

### Spatial Audio

Add a separate aim for spatial audio guidance:

- help orient the crowd toward objectives and transitions
- do this without adding extra visual guidance systems beyond the existing particle language

Extra particle-flow guidance was explicitly rejected because there are already particles in the artwork.

## GPU Sensor Pass Idea

This was refined and persisted in Aimparency as a dedicated terrain-only sensor system.

Desired sensor pass:

- a texture defines sensor sample positions once as camera-relative `xyz` offsets
- camera uniforms transform those offsets into world-space sample positions each frame
- a render pass evaluates only the current terrain SDF
- output per sensor:
  - SDF value
  - normal

Intended uses:

- terrain boundary sensing
- collision avoidance
- if the camera is inside geometry, gently or increasingly push it back out
- object / sphere placement by finding hollow cave-like regions where a collectible sphere can live

## Aimparency State (`fabric-artwork/.bowman`)

Active phase:

- `multiplayer dome game v1`

Data consistency was checked and Aimparency reported no errors.

### Main Aim Tree

- `Define multiplayer dome-game runtime architecture in artwork`
  - `Specify dome-space orientation and calibration pipeline`
    - `Use WebRTC for low-latency player orientation and button input`
      - `Implement player activity tracking and inactive-client pruning`
        - `Render all player cursors on the dome`
      - `Compute collective camera acceleration from player inputs`
        - `Build collectible-driven SDF level progression`
          - `Add twisted 3D cross guide structure around collectible spheres`
          - `Add spatial audio guidance for dome game objectives`
          - `Support curated level adjustments by a supervisor after world switches`
  - `Compute GPU SDF sensors for collision avoidance and object placement`

### Additional Aim Outside The Main Tree

- `Design dual-transport realtime input protocol`

This is the one aim that no longer perfectly matches the latest direction. It should either be:

- updated to reflect WebRTC for both direction and buttons
- or replaced / archived once implementation starts

## Open Questions For The Next Session

These are the main unresolved items worth deciding early:

- exact player packet schema over WebRTC
- whether packets send full current button bitmask every tick, edge events, or both
- exact heartbeat / timeout thresholds
- exact acceleration math and damping / mass / speed caps in the shared camera physics
- exact up-vector derivation and handling of degenerate cases if client vectors drift out of orthogonality
- concrete collectible sphere placement strategy:
  - fully random
  - weighted random
  - supervisor override
  - sensor-constrained hybrid
- how much transition motion remains player-driven once the camera enters a collectible sphere

## Recommended First Implementation Order

1. Freeze the input packet schema and heartbeat rules.
2. Add a minimal player registry in `fabric-artwork` with activity tracking.
3. Render all player cursors from `direction`.
