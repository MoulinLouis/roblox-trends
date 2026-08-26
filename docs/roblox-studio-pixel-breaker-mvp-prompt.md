# Roblox Studio AI Agent Prompt — Pixel Breaker Incremental MVP

## Execution context

You are working in the local repository for a newly created Roblox experience. Roblox Studio, Rojo, and the repository have already been set up and connected.

The local Rojo repository is the source of truth.

- Inspect the existing repository, Rojo structure, project configuration, and available development commands before making changes.
- Write all scripts, modules, UI source, and project configuration into the repository. Do not create important unsynchronized Studio-only instances.
- Preserve the existing Rojo setup and modify `default.project.json` only when the implementation requires it.
- Keep filesystem paths and Roblox instance mappings consistent with the existing project rather than replacing the setup with a new structure unnecessarily.
- Use the connected Roblox Studio place for playtests when the available tooling permits it.
- Run the available Rojo build, type, lint, static-analysis, and test commands that are relevant to the repository.
- If the tooling cannot control Roblox Studio, complete every repository-side validation and clearly list the Studio playtests that still require manual verification.
- Do not publish the experience, change ownership or permissions, upload assets, make purchases, or perform other external writes.
- Implement the complete specification below. Do not stop after inspecting the project or producing a plan.

Implement the game, run every available validation and playtest, fix runtime errors, and leave the project in a clean working state. Use English for every source file, identifier, comment, log message, and piece of UI copy.

Working title: `1 Ball vs 1,000,000 Pixels!`

Call every destructible colored square a `Pixel` in player-facing copy. In source code and technical data structures, prefer `Cell` for one grid entry and `Grid` for the complete board. Do not model or present the destructible field as 3D blocks, cubes, voxels, or Roblox Parts.

## Product objective

Create a polished but deliberately small 2D incremental pixel-breaking game inspired by the basic loop of idle brick-breaker games:

1. The player starts with one normal ball ready in a launcher beside an enclosed 2D playfield.
2. The player drags backward from the launcher and releases to launch the ball in the opposite direction.
3. Once launched, the ball moves and bounces automatically.
4. The ball damages pixels when it touches them.
5. Destroyed pixels award coins.
6. The player spends coins on a few permanent upgrades.
7. Clearing the board starts the next level with stronger pixels.

The purpose of this version is to validate the feel of the ball, pixel destruction, progression, upgrades, and UI. Build a clean foundation that can be extended later, but do not implement future features now.

## Strict scope

Implement only:

- One enclosed rectangular 2D playfield.
- One data-driven normal ball type.
- A finite rectangular grid of colored pixels.
- A click-and-drag launcher that controls the initial direction of each newly available ball.
- Automatic ball movement, collision, bouncing, and pixel damage.
- Manual pixel damage by clicking or tapping a pixel.
- Coins earned from destroying pixels.
- Successive levels with increasing pixel health.
- Four upgrades: ball damage, ball speed, maximum active balls, and click damage.
- Persistent player progression.
- A responsive, clean desktop and mobile UI.
- Independent game state for every player.
- Basic sound and visual feedback made from built-in Roblox capabilities only.

Do not implement:

- A beacon, magnet, or any steering or player-directed movement after a ball has been launched.
- Variable launch power, advanced trajectory prediction, trick-shot scoring, or launcher upgrades.
- Procedural generation, chunks, exploration, mining layers, or a large world.
- Golden pixels, a Golden Core, an ending, prestige, or rebirth.
- Special balls, cards, random upgrade choices, rarity, or inventory.
- Offline earnings.
- Pets, NPCs, quests, daily rewards, combat, PvP, trading, or social systems.
- Monetization, game passes, developer products, or premium purchases.
- Multiple maps, decorative 3D environments, or a lobby.
- Marketplace models, external packages, plugins, or copied third-party code.

Do not add a feature merely because it might be useful later. Provide extension points only where they keep the current implementation simpler and clearer.

## Gameplay specification

### Playfield

- Present the game through a full-screen `ScreenGui`.
- Keep the playfield inside a stable aspect-ratio container so collision coordinates do not depend on the physical screen resolution.
- Scale the rendered playfield to fit desktop, tablet, and phone screens without changing the simulation coordinate system.
- Enclose all four sides. There is no paddle and the ball cannot be lost.
- Use a dark, simple background and clearly readable colored pixels and balls.
- Place one clear launcher interaction area next to or immediately below the playfield.
- Give each player a completely independent board and progression state.

### Board and levels

- Start with a small configurable grid, approximately 8 columns by 10 rows.
- Give every pixel on level 1 exactly 1 maximum health.
- When the player clears the board, wait briefly, increment the level, rebuild the grid, and keep already active balls moving from safe positions. Do not force the player to relaunch every owned ball after every level.
- For the initial balance, maximum pixel health should equal the current level: level 1 has 1 HP, level 2 has 2 HP, and so on.
- Keep board generation behind a small, explicit module or interface so a different board generator can replace it later without rewriting progression, upgrades, or rendering.
- Display remaining health clearly. For low health values, a number on each pixel is acceptable. Also change pixel color or brightness as its remaining-health ratio falls.

### Ball simulation

- Begin with one normal ball in the launcher's ready queue and no active ball until the player performs the first launch.
- Distinguish explicit `Ready` and `Active` ball states.
- A ready ball becomes active only after a valid drag-and-release launch.
- Once active, a ball remains active across board clears. Reposition active balls safely during the short level transition while preserving a valid non-axis-aligned direction.
- Newly unlocked balls enter the ready queue and must be launched by the player once.
- When a player rejoins, restore the owned ball capacity but place all owned balls in the ready queue because individual ball positions are not persisted.
- Give each launched ball a non-axis-aligned initial direction so it does not immediately become trapped in a purely horizontal or vertical path.
- Make movement frame-rate independent.
- Resolve wall and pixel-cell collisions consistently.
- Prevent tunneling at higher speeds with substeps, swept collision, or another robust bounded technique.
- Prevent repeated damage from the same unresolved overlap.
- Prevent balls from becoming permanently stuck between pixel cells or moving forever on a near-perfect horizontal or vertical line.
- Keep position, velocity, radius, damage, speed, and ball type as explicit data rather than scattering values through UI code.
- Put all tuning values and safety caps in one configuration module.

### Launcher interaction

- Use a slingshot-style click-and-drag interaction from a clearly visible launcher origin.
- The player presses on the launcher, drags in one direction, and releases. The ball launches in the opposite direction from the drag.
- The drag determines direction only. Launch speed must come from the player's configured ball-speed stat so dragging farther cannot bypass progression or safety caps.
- Require a small configurable minimum drag distance. A drag shorter than that threshold should cancel cleanly without consuming or launching a ball.
- Show a simple arrow or short dotted line while dragging so the launch direction is unambiguous.
- Clamp the preview to a reasonable maximum visual length even though launch power is fixed.
- Support mouse and single-touch input with the same rules.
- Capture the pointer only after the interaction begins on the launcher area. Dragging elsewhere must not create a ball.
- Cancel safely if the pointer is released outside the normal UI bounds, the player opens a menu, or the available ball disappears before release.
- Do not allow launching when the ready queue is empty or when the maximum active-ball capacity has been reached.
- Never create a free ball from repeated input. Every launched ball must correspond to one ball owned through the player's persisted maximum-ball upgrade.
- Send only a normalized requested launch direction to the server. The server must validate the player session, ready-ball count, drag direction, request rate, and active-ball limit before activating the ball at the authoritative configured speed.
- Manual pixel damage remains a separate tap or click directly on a living pixel. Because launching must begin on the dedicated launcher area, the two interactions must not conflict.

### Pixel damage and rewards

- A normal ball deals the player's current ball-damage value on a valid pixel hit.
- Clicking or tapping a living pixel deals the player's current click-damage value.
- The server must validate manual damage requests, the targeted pixel cell, and a reasonable input rate.
- Award coins only once when a pixel transitions from alive to destroyed.
- Start with a simple configurable reward equal to the destroyed pixel's maximum health.
- Use a short scale, flash, particle, or color animation for a hit and a stronger effect for destruction.
- Keep effects lightweight and ensure they cannot intercept input.

### Upgrades

Create exactly four permanent upgrade buttons:

1. `Ball Damage` — increases damage per ball hit.
2. `Ball Speed` — increases movement speed up to a safe configured cap.
3. `Max Balls` — increases owned ball capacity by one. The new ball enters the ready queue and waits for the player to launch it.
4. `Click Damage` — increases damage per manual click or tap.

Requirements:

- Show the current value and next cost on every button.
- Disable or visibly dim a button when the player cannot afford it or has reached its cap.
- Keep base costs, cost growth, stat increments, and caps in the central configuration module.
- Use server-authoritative purchase validation and coin deduction.
- Immediately update active balls after damage or speed upgrades.
- After a successful maximum-ball upgrade, add exactly one ball to the ready queue without launching it automatically.
- Choose starter costs that let a new player buy the first upgrade quickly and add a second ball during a short initial playtest.

Use these values only as an initial tuning baseline and keep them configurable:

| Upgrade | Starting value | First cost | Effect | Cost multiplier | Cap |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ball Damage | 1 | 10 | +1 damage | 1.60 | No practical MVP cap |
| Ball Speed | 220 simulation units/second | 25 | +15 speed | 1.65 | 500 |
| Max Balls | 1 | 100 | +1 owned ball and ready ball | 2.25 | 8 |
| Click Damage | 1 | 10 | +1 damage | 1.60 | No practical MVP cap |

Round displayed costs to integers.

## UI and feedback

Create a coherent interface rather than raw default Roblox buttons.

The UI must include:

- Current coins.
- Current level.
- Remaining pixels.
- Active-ball and ready-ball counts.
- The central playfield.
- The launcher and its direction preview.
- The four upgrade buttons.
- A short level-clear transition.

UI requirements:

- Make the playfield the visual focus.
- Keep upgrades accessible without covering important gameplay on small screens.
- Support mouse and touch without separate game modes.
- Respect safe areas and avoid text clipping at common phone aspect ratios.
- Use consistent spacing, typography, colors, corners, and button states.
- Add concise hover/press feedback where the input device supports it.
- Use number abbreviation only for large values and keep exact small values readable.
- Do not add menus, settings, tutorials, popups, or decorative panels that are not necessary for the core loop.

Use clear English UI labels such as `Level`, `Coins`, `Pixels Left`, `Balls`, `Ready`, `Ball Damage`, `Ball Speed`, `Max Balls`, and `Click Damage`.

## Architecture requirements

Use modular Luau and a clear client/server boundary. Avoid one large script.

The exact hierarchy may adapt to the place, but aim for responsibilities equivalent to:

```text
ReplicatedStorage
  Shared
    GameConfig
    UpgradeDefinitions
    BallDefinitions
    Types
  Remotes

ServerScriptService
  ServerBootstrap
  Services
    PlayerDataService
    GameSessionService
    UpgradeService
  Simulation
    PixelBreakerSimulation
    BoardGenerator

StarterPlayer
  StarterPlayerScripts
    ClientBootstrap
    Controllers
      GameController
      InputController
      RenderController
      UIController

StarterGui
  PixelBreakerGui
```

Architecture rules:

- Keep economy, level progression, upgrades, pixel-cell health, and rewards authoritative on the server.
- Keep the ready-ball queue, active-ball count, launch validation, and final launch velocity authoritative on the server.
- Prefer a small numerical 2D simulation over Roblox physics Parts.
- Send only the state and deltas the client needs to render its own board.
- Rate-limit and validate every client request.
- Never accept a client-provided coin balance, upgrade level, reward amount, or arbitrary damage value.
- Keep the simulation coordinate space independent from physical screen dimensions.
- Keep board generation, simulation, rendering, input, persistence, and UI state separate.
- Represent ball types through a data-driven definition even though the MVP contains only `Normal`.
- Do not overbuild a generic framework. Modules should exist because they have a current, concrete responsibility.
- Use strict Luau typing where practical and name public types explicitly.
- Disconnect events and clean up per-player simulation state when a player leaves.

## Persistence

Persist only:

- Coins.
- Current level.
- Ball-damage upgrade level.
- Ball-speed upgrade level.
- Maximum-ball upgrade level.
- Click-damage upgrade level.
- Data schema version.

Requirements:

- Use `DataStoreService` with `UpdateAsync`, `pcall`, bounded retry behavior, autosave, `PlayerRemoving`, and `BindToClose` handling.
- Use a versioned default profile and sanitize loaded values.
- Never let a failed load overwrite existing saved data with defaults.
- If Studio API access is unavailable, fail gracefully, keep the session playable with in-memory data, and emit one clear warning rather than repeated errors.
- It is acceptable to regenerate the current board when the player rejoins. Do not persist individual pixel cells or ball positions in the MVP.

## Audio and visual polish

- Use only original configuration and built-in Roblox primitives unless suitable audio assets already exist in the place and are clearly safe to use.
- If no safe sound assets are available, leave sound hooks with no asset IDs rather than inventing IDs or importing assets.
- Use restrained hit feedback and a more satisfying destruction effect.
- Pool or reuse frequently created visual effects where useful.
- Keep effects readable when several balls hit pixels at the same time.
- Do not spend time on elaborate art. Clean geometry, good color, timing, and responsive feedback are enough.

## Testing requirements

Test the implementation in Roblox Studio rather than relying only on code inspection.

At minimum, verify:

1. A new player receives a valid default profile with one ready ball and zero active balls.
2. A valid backward drag launches the ready ball in the opposite direction at the authoritative ball-speed value.
3. Short or invalid drags cancel without consuming a ready ball.
4. Repeated input cannot launch more balls than the player owns.
5. The launched ball continues moving and bouncing for several minutes without escaping or becoming permanently stuck.
6. Ball collisions damage pixels exactly once per valid hit.
7. Mouse clicks and touch-style taps damage only living pixels and do not accidentally begin a launch.
8. Clearing level 1 creates level 2 pixels with exactly 2 HP and keeps existing balls active.
9. Each upgrade charges the correct cost and changes only its intended stat.
10. Buying `Max Balls` adds exactly one ready ball and never exceeds the configured cap.
11. Ball speed does not exceed its configured cap or cause obvious tunneling.
12. Mouse and touch launcher input both show a correct direction preview and launch successfully.
13. Two simultaneous test players have independent boards, balls, coins, levels, and upgrades.
14. Leaving and rejoining restores the saved profile and places all owned balls in the ready queue when DataStore access is available.
15. The UI remains usable at desktop and narrow mobile viewport sizes.
16. There are no recurring errors or warnings in the Studio Output window during normal play.

Fix issues found during testing. Do not mark the work complete while a required gameplay path is broken.

## Definition of done

The task is complete only when:

- A player can join, drag from the launcher, and immediately begin breaking pixels without manual setup.
- The full loop `break pixels -> earn coins -> buy upgrades -> clear board -> reach a stronger level` works.
- Progression persists safely.
- Desktop and mobile layouts are usable.
- Multiple players can play independently in the same server.
- The project contains no unexplained runtime errors.
- The implementation stays within the strict MVP scope.

When finished, provide a concise handoff containing:

- What was implemented.
- The final Roblox hierarchy and the responsibility of each important module.
- Which playtests were run and their results.
- Any known limitation that genuinely remains.
- The central configuration values that should be tuned after the first human playtest.

Do not propose or implement expansion features in the handoff. The next product decisions will be made only after the core MVP has been played.
