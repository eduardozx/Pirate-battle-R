# Pirate Battle — Architecture

A 2D top-down naval shooter built with React 18, TypeScript (strict) and PixiJS 8.

This document records the decisions that shaped the codebase and, where relevant,
the alternatives that were rejected and why.

---

## 1. Layering

```
┌──────────────────────────────────────────────────────────────────────┐
│ React UI          menus · options · HUD · panels · dialogs            │
│                   useSyncExternalStore · no per-frame state          │
└───────────────┬──────────────────────────────────────────────────────┘
                │ React → engine: imperative ref · engine → React: store
┌───────────────▼──────────────────────────────────────────────────────┐
│ GameSession        owns ONE match · owns input · owns lifecycle      │
├──────────────────────────────────────────────────────────────────────┤
│ GameWorld          the rule engine · zero PixiJS, zero React, zero DOM│
│                    systems · pooling · collision · match rules        │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │                              │
┌───────────────▼───────────────┐  ┌───────────▼───────────────────────┐
│ PixiJS renderer               │  │ Data layer                        │
│ copies state into display list│  │ Axios · TanStack Query · MSW      │
│ never mutates the simulation  │  │ Outbox with idempotency           │
└───────────────────────────────┘  └───────────────────────────────────┘
```

**The load-bearing invariant:** nothing under `src/game/**` imports `pixi.js` or
`react`, except the isolated view modules in `entities/renderers/` and `render/`.
The rule engine is therefore runnable headless, which is what makes the 112 unit
tests fast and deterministic.

### 1.1 Who owns what

| Concern | Owner | Lifetime | Rationale |
| --- | --- | --- | --- |
| Match state, input, clock | `GameSession` | one per match | A restart builds a new session rather than mutating one, so nothing can survive into the next match |
| WebGL context, display list | `GameRenderer` | one per match | Owned by React via a ref; torn down before the DOM node goes |
| Textures | `TextureRegistry` | one per app | Outlives matches, so a restart reuses warm GPU textures instead of re-uploading the atlas |
| Options, player profile | app singletons | one per app | Local persistence must survive navigation |
| Mock server + queue | app singletons | one per app | The mock database must be shared so the ranking and history panels agree |

---

### 1.2 Camera

The camera **covers** the display rather than containing the arena:

```
scale = max(screenW / arenaW, screenH / arenaH)
```

"Contain" fits the whole arena inside the screen, so any display whose aspect ratio
differs from the arena's gets bars. The arena is 1536×960 (1.6), so a 16:9 display
wasted 10% of its width, an ultrawide 32.5%, and a landscape phone 26%.

Scaling up alone would crop the arena and let the ship sail off-screen, so the
camera **pans to follow the ship**, clamped to the arena:

```
centre = clamp(focus, halfView, arenaSize - halfView)
```

The clamp is sufficient rather than approximate. With a cover scale the visible
rectangle is exactly the arena's size on one axis and no larger than it on the
other — so it is always a window *inside* the arena, and panning can never expose
empty space. The camera centre is part of `Viewport`, which makes the framing
testable as arithmetic in `tests/rules/camera.spec.ts` rather than something only
judgable by eye.

This is presentation only. The simulation is untouched, so determinism and the
headless tests are unaffected. The renderer reads a single read-only
`playerPosition` accessor rather than the mutable `PlayerEntity`, keeping the
simulation → render boundary one-directional.

---

## 2. React ⇄ PixiJS integration

**The Pixi ticker never calls `setState`.** Per frame it does exactly two things:

```ts
session.stepFrame(deltaMs);   // simulate, in fixed substeps
renderer.sync(session.world); // copy state into display objects
```

The HUD is fed by the session **subscribing** to the store, not by polling:

```ts
const unsubscribe = session.subscribeHud((state) => hudStore.publish(state));
```

Two properties follow:

- **No per-frame React renders.** `hudStore.publish` compares before notifying, and
  the session only publishes when a *coarse* value changes — score, whole-second
  timer, health, phase. A 180-second match produces a few dozen renders instead of
  ~10 800.
- **The timer cannot silently freeze.** An earlier version polled behind a
  "did stats change?" flag; that flag fired on damage and score but never on the
  clock, so the HUD froze while the match ran perfectly. Subscribing to the
  session removes the heuristic entirely — the source of truth is the only source
  of truth.

### 2.1 Strict Mode

StrictMode mounts, unmounts and remounts every component in development. Three
defences, each fixing a bug that actually occurred:

1. **Generation token + cancel flag** in `GameCanvas`. An in-flight `initialise`
   that resolves after being superseded destroys itself instead of attaching a
   second canvas.
2. **`Application.init` checks a `destroyed` flag.** Teardown cannot reach a
   half-built application (there is no renderer yet), so the initialiser releases
   the WebGL context itself.
3. **Long-lived singletons.** `useTextureRegistry` and `useOptions` create their
   store once via a ref. An earlier version created and disposed the registry per
   effect, so a StrictMode remount unloaded textures while a renderer still held
   them — producing a `TilingSprite` bound to a destroyed texture.

Ordering matters: the mock API is started **before** the first React render. If
the app renders first, the first ranking query escapes the service worker, reaches
the dev server, and receives the SPA fallback — `index.html` with status **200**.
Since 200 means "success", the query cache stores HTML as if it were data and the
table renders permanently empty with no error anywhere.

---

## 3. The simulation loop

### 3.1 Substepping with a carried remainder

```ts
this.carryMs += min(frameDelta, 100);
while (this.carryMs >= maxSubstepMs) {
  this.carryMs -= maxSubstepMs;
  onSubstep(maxSubstepMs / 1000);
}
```

The carried remainder is the detail that makes the loop genuinely frame-rate
independent. Without it, a 6.9 ms frame integrates as one short step while a
33.3 ms frame integrates as four long ones; the differing partitions make an
exponential term such as acceleration drift apart. With it, **the same seed and
the same input produce a bit-identical match at 30, 60 and 144 fps** — which is
what makes reproducible E2E possible at all.

`maxSubstepsPerFrame` must exceed `maxFrameMs / maxSubstepMs`. At the original 8
it did not, so a 30 fps frame silently discarded a third of its time and the match
clock ran slow on weak hardware.

### 3.2 Match time comes from simulation, never the wall clock

The clock advances only inside a substep. A paused match, a backgrounded tab or a
throttled ticker therefore cannot consume the player's remaining seconds, and
resuming discards the carry so the first frame is small rather than a catch-up
burst.

### 3.3 Pipeline order is load-bearing

```
clock → player → spawner → enemy AI → power-ups → projectiles →
broadphase → narrowphase → damage → effects → match rules
```

- A chaser that spawns this substep already gets its AI tick, so there is no dead
  frame where it sits inert.
- Damage resolves after all movement, so a projectile that kills removes the
  target before it can fire back.
- The phase gate (`if (phase !== 'running') return`) sits at the top of `step`, so
  ending a match structurally stops movement, attacks, damage, spawns and scoring.

---

## 4. Collision

| Pair | Algorithm | Why |
| --- | --- | --- |
| Projectile ↔ Enemy / Player | **Swept** segment vs circle | At 620 u/s a shot moves 62 units in one worst-case frame and would pass straight through a 20-unit hull. Sweeping makes tunnelling impossible regardless of frame pacing. |
| Projectile ↔ Island | Swept segment vs AABB (slab) | Same reason; islands are many small rects, so a cheap island-bounds reject precedes the per-rect test. |
| Ship ↔ Island | Circle vs AABB, push-out, velocity projected onto the normal | Two passes to converge; the projection makes a hull slide along a shore instead of sticking to it. |
| Chaser ↔ Player | Circle overlap starts a fuse | The chaser explodes **on impact**, not on proximity. An earlier version detonated at range, which put explosions in open water 190 units from the ship. |
| Ship ↔ Ship | Soft separation | Not required by the rules, but without it enemies stack into an unreadable blob and the arena stops being legible. The player yields less than enemies do, so contact still reads as the player's responsibility. |

Broadphase is a uniform spatial hash over flat typed arrays — no `Map`/`Set` churn
per frame. With ~15 ships and ~60 projectiles brute force would already suffice,
but the grid keeps cost flat if `maxAlive` or the broadside rate are raised during
balancing.

### 4.1 Enemy turn radius

A pursuer's minimum turning circle is `speed / angularSpeed`. At 165 u/s and
120°/s that circle is ~79 units — **wider than the distance to its target**, so the
chaser orbited forever and never made contact. The fix is a turn rate whose radius
is comfortably below the engagement distance (420°/s → ~22 units). Steering noise
also tapers to zero on approach, because a weaver that keeps oscillating at contact
range never converges either. Both were found by tests, not by inspection.

---

## 5. Asset architecture

Simulation code holds **abstract keys only** — `ASSET.SHIP.PLAYER`. Paths and
frame names exist in exactly one table:

```ts
export const SPRITE_SOURCES: Record<AssetKey, SpriteSource> = {
  'ship.player': { kind: 'atlas', atlas: 'ships', frames: ['ship_6.png'] },
  'tile.water':  { kind: 'image', url: tile(73) },
};
```

Swapping a sprite, a spritesheet or an image format is a one-line edit. A test
asserts that no `.png` or `assets/` string appears anywhere in the gameplay config,
which is what keeps the boundary honest.

Presentation-only concerns live in the manifest too:

```ts
'SPRITE_METADATA': { artAxis: 'up' | 'right', renderScale: number }
```

The ship PNGs are drawn bow-up while the simulation's bow points +X. Encoding that
correction as metadata means a horizontally-authored replacement needs one flag
flip and no code change.

### 5.1 Findings from inspecting the shipped assets

- The Starling atlas ships a genuine 2× UI sheet, but `ships_miscellaneous_sheet_retina.png`
  is **1024×512 — identical to the 1× sheet** (92 of 102 frames have byte-identical
  coordinates). Only the UI has real high-DPI art, so ships render soft on HiDPI
  until a build-time upscale lands.
- The tile set was classified offline by colour clustering: water is `tile_73`,
  with sand/grass/rock/foam groups around it. The classification is frozen as an
  index table, so there is no runtime colour analysis.
- The atlas parser uses a regular expression rather than `DOMParser`. `DOMParser`
  exists only in a browser, which would make the module untestable in Node and
  unusable from a build script; the format is a flat list of self-closing elements
  with numeric attributes, so a strict scan is sufficient and more predictable.

---

## 6. Power-ups: State + Factory + pooling

### 6.1 State Pattern

Each lifecycle phase is an object with its own behaviour
(`drifting → collecting → active → expiring → spent`). Transitions are declared by
the state that owns them, so an illegal transition is impossible to express — a
spent power-up has no way back. Adding a phase means adding one class.

States are **singletons**: they hold no per-instance data, so transitions allocate
nothing.

### 6.2 Factory Pattern

`PowerUpFactory` turns a catalogue key into a live instance, and owns the weighted
spawn table. It draws from the **world's existing seeded PRNG stream**, once.

That placement is deliberate. A random draw consumes a value from the caller's
stream, so a factory with its own RNG would shift every subsequent random decision
in the match and destroy reproducibility. Drawing from the shared stream means
adding a power-up can change *which* power-up appears but never the trajectory of
a ship.

Adding a power-up is one catalogue entry. The factory, the state machine, the
spawner and the renderer all derive from the catalogue, so the core never changes.

### 6.3 Object pooling

The pool is a hard memory ceiling, and `spawn` returns `null` rather than growing
the array. That is the point: a bounded world is what keeps frame time predictable
on low-end mobile, where a GC hitch costs far more than on desktop.

Two allocation disciplines:

- **Stable identities.** Instances are marked inactive, never nulled. A view holding
  a reference to instance #7 keeps pointing at instance #7. Recycling by nulling
  would force every consumer to re-check and re-bind on each spawn.
- **Rotating slot search.** Consecutive spawns land in *different* slots, so a view
  bound to a slot keeps its texture until that slot's kind changes. Always reusing
  slot 0 would rebuild one sprite while the others sat stale.

`forEachActive` passes a callback rather than returning a filtered array, and no
per-frame array, object or closure is created in `update`. A test asserts the
contract directly: 500 spawns produce at most `poolSize` distinct object
identities.

### 6.4 Two bugs this design surfaced

Both were found by tests, and both are the kind that a passing happy path hides.

**Consumables were uncollectable.** `initialStateFor` originally started a
consumable in `spent`, reasoning that it has no active phase. But `spent` is the
terminal state and reports `isCollectable: false` — so a repair kit sank and
vanished without ever being pickable. The fix was not to special-case the state but
to move the distinction where it belongs: the collect **transition** consults
`context.isConsumable`, and every power-up now starts by drifting.

**The crate's lifetime was conflated with the effect's duration.** One timer drove
both, so a crate spawning ~1 100 units away despawned after its 8-second effect
duration — long before a ship covering ~165 units per second could plausibly cross
the arena. The pickup existed only as scenery. They are now separate budgets:
`crateLifetimeMs` (24 s, roughly 15 s of sailing) governs the crate on the water,
and `durationMs` governs the bonus after collection.

A third, non-power-up defect came from the same class of mistake: collecting a
power-up emitted no event the session subscribes to, so the HUD republished from
stale state and the indicator never appeared. The HUD is event-driven precisely to
avoid a 60 Hz poll, which means **any new visible state needs an event** —
`powerup:changed` now exists for that reason.

### 6.5 Verifying reachability

Collection at the *real* pickup radius is asserted in the rule-engine suite, where
the simulation is stepped precisely. End to end, the mechanic cannot be scripted
the same way: a crate lands at a random point at least 260 units away, and holding
a turn key makes the ship orbit a ~50-unit circle rather than cross the arena, so a
blind sweep never arrives. The E2E suite therefore widens the radius and drops the
minimum spawn distance via a dev-only URL seam, which makes the spawn-to-HUD
pipeline deterministic. The seam is compiled out of production builds, and the
production timer confirms it: a build with `?sessionSeconds=6` still plays a
full-length match.

---

## 7. Data layer

### 7.1 The retry rule

`POST /matches` is **never** retried by the transport. A retry is only safe for a
request that cannot have a side effect, and a timeout means "we do not know whether
the server committed". Retrying blindly is precisely how duplicate ranking entries
get created.

Submission retries belong to the outbox, which sends an `Idempotency-Key`. Three
independent layers make duplicates impossible:

1. `enqueue` is keyed by `matchId` — a double click cannot create two items.
2. `flush` processes items serially — no concurrent submission of one match.
3. The server upserts by `matchId` — a resend returns the existing record with
   `status: 'duplicate'`.

The `matchId` is generated **when the match starts**, not at submission time. A
refresh between the end of a match and its submission would otherwise produce a
second id, and therefore a second ranking entry.

### 7.2 The scenario that proves it

`submit-commit-then-hang` writes the record and then never answers. The client sees
a timeout and has no idea the data exists. Only a resend can discover that, and the
upsert is what makes the resend safe. This is the one scenario that distinguishes a
correct queue from a merely present one, and it is verified end to end.

### 7.3 Failure presentation

A background revalidation that fails **while cached rows are on screen does not
blank the table**. The player keeps reading valid data and is told the refresh
failed. Replacing good data with an error panel is a regression disguised as error
handling. Hard errors (no data at all) still get the full panel with Retry.

### 7.4 Response guards

Every response is shape-checked. A request that escapes the mock worker receives
the SPA fallback — `index.html` with status 200 — which the query cache would
otherwise accept as data. A guard turns that silent failure into an explicit,
retryable error at the boundary.

### 7.5 The contracts

Everything below is declared once, in `src/services/api/contracts.ts`, and shared
by three consumers that must never disagree: the Axios client, the TanStack Query
hooks (cache keys and read models) and the MSW handlers. Changing a field breaks
compilation in all three at once — a mismatched mock is a compile error rather
than a silent UI bug.

| Endpoint | Method | Query / body | Response | Who reads it |
| --- | --- | --- | --- | --- |
| `/api/ranking` | `GET` | `configFingerprint` (required), `page`, `pageSize` | `PageResponse<RankingEntryDto>` | Ranking tab, filtered to the configuration the player is currently on |
| `/api/matches` | `GET` | `playerId`, `page`, `pageSize` | `PageResponse<MatchRecordDto>` | Match history tab |
| `/api/matches/:matchId` | `GET` | — | `MatchRecordDto` (404 + `ApiErrorBody` if unknown) | Single-record reads |
| `/api/matches` | `POST` | `SubmitMatchRequest` | `SubmitMatchResponse` | The outbox, once per `matchId` |

Shared shapes:

| Shape | Fields | Why it exists |
| --- | --- | --- |
| `PageResponse<T>` | `data`, `meta { page, pageSize, totalItems, totalPages }`, `revision`, `generatedAtIso` | One envelope for both list endpoints, so pagination and freshness are handled by one code path |
| `revision` | monotonic per resource | Makes a late response *detectable*: a client that already applied revision N discards N−1 instead of replacing fresher data with staler data |
| `SubmitMatchResponse.status` | `created` \| `duplicate` | A resend answering `duplicate` is a **success**, which is what lets the client treat a retry after an unknown timeout as a confirmed write |
| `ApiErrorBody` | `error { code, message, details? }` | A structured failure the UI can render, instead of a bare status code |

`POST` carries an `Idempotency-Key` header equal to the body's `matchId` — the
mock server rejects a request where the two disagree — and the transport still
never retries it (§7.1).

### 7.6 Storage keys

All durable state is `localStorage`, under keys that are **versioned in the name**
so a schema change is a new key instead of a parse crash on an old one:

| Key | Owner | Contents | Cleared by |
| --- | --- | --- | --- |
| `pb.options.v1` | `optionsStore` | Session length and enemy spawn interval, validated against documented limits | The Options screen's reset writes the defaults back |
| `pb.player.v1` | `playerStore` | Anonymous profile: `playerId`, `playerName` | Never (one profile per browser) |
| `pb.outbox.v1` | `outboxStore` | Queued submissions with their backoff, attempt state and last error — plus the 20 most recent confirmed ones, which is where the result screen's *Recorded* comes from | Delivery prunes it; **Reset mock state** empties it |
| `pb.result.v1` | `lastResultStore` | The last completed match, so a refresh mid-result restores the Result screen | Main Menu or Play Again |
| `pb.msw.db.v1` | `mockDb` (MSW) | Every record the mock server has accepted — fixture rows (`fixture-*`) plus real submissions — with their revisions, so both tabs agree after a reload | **Reset mock state** discards everything and re-seeds; switching a scenario replaces only the fixtures and keeps the player's own records |

Every read is wrapped: missing or malformed JSON falls back to the default
instead of taking the app down. What is deliberately *not* persisted — the TanStack
Query cache, the per-resource revision counters and the outbox's in-flight state —
lives in memory, because restoring any of them without their server-side
counterpart would fabricate freshness.

---

## 8. Known limitations

- **No audio.** The brief does not require it and the WAVs are unused.
- **Ships are soft on HiDPI** until the build-time 2× atlas lands (§5.1).
- **Balance is hand-tuned**, not measured against a target difficulty curve.
- **No GPU-side timing.** Frame CPU cost is measured and healthy (worst p99
  3.5 ms, worst single frame 7.6 ms, against a 16.67 ms budget), but PixiJS
  submits rasterisation asynchronously, so draw-call scaling as the arena fills
  is unmeasured. See [PERFORMANCE.md §6](./docs/PERFORMANCE.md).
- **Islands are authored masks**, not procedural. Deterministic arenas are worth
  more than variety at this stage, and they guarantee water lanes on all four sides.

---

## 9. Mobile layout

The `mobile` Playwright project runs the whole suite on a landscape phone
viewport, and it immediately found a defect the desktop project could not:
`align-items: center` on a flex container whose content is taller than the
container overflows in **both** directions, and the part above the scroll origin
can never be reached. On a 390-unit-tall viewport that put the main menu's Play
button at y ≈ −254 — not merely awkward, but unreachable, with no way to scroll to
it. `align-items: safe center` falls back to start alignment exactly when centring
would overflow, so short content stays centred and tall content stays reachable.

The same project surfaced a second issue: `touch-action: none` on `body` — correct
for the canvas, which must not rubber-band during play — also made every menu and
the options form unscrollable by touch. Menus now declare `pan-y` while the canvas
keeps `none`.

---

## 10. Why the E2E suite uses two workers

The simulation advances with the render loop, and the loop deliberately refuses to
catch up in a burst: a starved frame is capped rather than replayed. That is
correct for a game — it prevents a backgrounded tab from fast-forwarding the match
— but it means simulation time runs slower than wall time whenever frames are
starved.

Several E2E specs run **real matches**, and their assertions are about simulation
time. Under four concurrent WebGL contexts, frames were starved badly enough that a
six-second match took the best part of a minute, and assertions failed that passed
every time in isolation. Four consecutive single-spec runs confirmed the tests
themselves were sound.

That failure mode is the dangerous one: a suite that fails only under load teaches
the team to re-run "flaky" tests and to stop believing the results. So `workers` is
pinned to 2. The suite is slower and stops producing ghosts. Fixing the symptom
instead — raising timeouts until the starved runs pass — would have hidden the real
constraint rather than honoured it.

---

## 11. Instrumentation and visual regression

### Frame profiling

`FrameProfiler` wraps the Pixi ticker and times simulation and render separately.
Three choices make its output trustworthy:

- **A fixed ring buffer.** The profiler runs once per frame, so its own cost is
  inside what it measures. Samples land in a preallocated `Float32Array`; nothing
  allocates in the hot path. A profiler that allocated would be measuring its own
  garbage collection.
- **Percentiles, not an average.** A run can average 2 ms while p99 is 40 ms, and
  the player experiences that 40 ms as a stutter. Only the tail is actionable.
- **An injected clock.** Tests drive time deterministically instead of
  monkey-patching a global the frame path also reads — which is how the first
  version of these tests ended up asserting nothing at all.

**Which builds carry it.** Dev builds always; the deployed build never. Both
`import.meta.env.DEV` and `import.meta.env.PROFILE` are replaced by a literal at
build time, so the minifier drops the profiler and its read surface from
`npm run build` — the grep in the README checks `dist/` rather than trusting that.
`npm run build:profile` (`vite build --mode profile`) is the same optimised
bundle with that one flag flipped, which is how [PERFORMANCE.md §2.1](./docs/PERFORMANCE.md)
can quote CPU cost and entity counts measured *on* a production bundle instead of
inferred from the dev one. The test hook, the `?sessionSeconds=` override and the
URL-parameter options stay behind `import.meta.env.DEV` in every mode: profiling
measures the game, it does not play it.

The measured region is JavaScript CPU work. GPU rasterisation is submitted
asynchronously and happens after the callback returns, so it is not captured. That
distinction is stated plainly in PERFORMANCE.md rather than papered over, because
the honest way to present the numbers is the only way they stay useful.

### Visual baselines

Pixel diffs catch what no functional assertion notices: a sprite anchored on the
wrong corner, a panel overlapping another, a colour losing contrast, a layout
collapsing on a narrow viewport.

Three flakes had to be eliminated before the baselines were trustworthy, and each
is a trap worth recording:

- **Live canvas pixels.** A running match redraws every frame, so the arena is
  captured **paused** — freezing the loop is the only stable way to diff gameplay.
  The canvas element is screenshotted rather than the screen, which excludes the
  pause overlay that would otherwise dim the pixels worth checking.
- **Unsettled panels.** The baseline waits for the terminal state, never a
  transition, or it locks in whichever of loading/empty/data happened to be on
  screen.
- **Random per-profile data.** The generated captain name differs on every fresh
  run, so it is masked. Live HUD regions are masked too — and masked *whole*, since
  a field mask whose box resizes with its text leaves an edge diff whenever the
  number changes width.

Baselines target individual elements rather than the viewport, because on the
mobile viewport the ranking table sits below the fold and a viewport shot would
silently protect nothing.

---

## 12. Balance numbers

Every tunable lives in
[`src/game/config/gameConfig.ts`](./src/game/config/gameConfig.ts) as data:
retuning the game is an edit to a literal, and no system, entity or renderer
holds a magic number of its own. The values below are the shipped defaults.

They matter to more than gameplay — the ranking compares only matches whose full
config hashes identically (§7.5), so changing **any** of them starts a new
leaderboard instead of mixing two different games in one table.

### Arena

| | Value |
| --- | --- |
| World | 1536 × 960 units, 64-unit tiles, 3 islands |
| Hull clearance | hulls stay 48 units inside the visible edge |

### Hulls

| Ship | Radius | Health | Speed | Turn rate | Particulars |
| --- | --- | --- | --- | --- | --- |
| Player | 22 | 100 | 210 u/s | 165 °/s | 900 ms of invulnerability after every hit — the fairness setting the whole feel rests on |
| Chaser | 20 | 45 | 165 u/s | 420 °/s | 18 contact damage, detonates 260 ms after impact, ×1.45 rush inside 190 units, 26 °/s steering noise |
| Shooter | 18 | 60 | 145 u/s | 95 °/s | prefers 330 units, fires inside 430, strafes at 0.6 of full turn |

The chaser's turn rate is not cosmetic: minimum turn radius = speed ÷ angular
speed ≈ 22 units, comfortably inside the ~42 units of combined collision radius
(22 + 20), which is why it converges instead of orbiting its target forever.

### Weapons

| Weapon | Cooldown | Damage | Speed | Lifetime | Muzzles |
| --- | --- | --- | --- | --- | --- |
| Bow cannon | 380 ms | 34 | 620 u/s | 1500 ms | 1 |
| Broadside, left or right | 720 ms | 18 | 540 u/s | 1100 ms | 3 in parallel |
| Shooter | 1900 ms | 9 | 400 u/s | 2200 ms | 1 |

All projectiles are 6 units in radius. A press made **inside** a cooldown is
swallowed, never queued — a queued shot would come out alongside the next volley
and quietly double the cannon's rate.

### Spawning

| | Value |
| --- | --- |
| First enemy | 1.2 s after the countdown |
| Interval | 1.6–4.2 s (player-facing option: 0.5–10 s, default 3 s) |
| Mix | 0.65 shooter, 0.35 chaser |
| Concurrency | at most 9 alive |
| Placement | 340-unit band along the edge, ≥ 96 units from land, ≥ 420 units from the player, 24 attempts before giving up |

### Match

| | Value |
| --- | --- |
| Duration | 90 s (player-facing option: 60–180 s) |
| Countdown | 1200 ms |

### Power-ups

First crate at 6 s, then every 9 s. The pool holds 8 and a full pool **skips**
the spawn rather than growing. Crates are collected within 42 units, spawn at
least 80 units from land and 260 from the player, and float for 24 s — longer
than any effect, so a distant crate is always worth crossing for.

| Power-up | Duration | Effect |
| --- | --- | --- |
| Repair Kit | instant | +35 HP |
| Rapid Fire | 9 s | weapon cooldowns halved |
| Timber Shield | 12 s | absorbs 45 damage |
| Double Score | 15 s | ×2 points per kill |
| Overcharge | 8 s | +75 % projectile damage |

### Effects and deterioration

| | Value |
| --- | --- |
| Muzzle flash / explosion / wood impact / splash / hit flash | 160 / 520 / 300 / 420 / 130 ms |
| Burning threshold | a hull at or below **35 %** health burns |

Deterioration is **continuous**, not a set of stages: the fire follows its hull
and is re-lit whenever it expires, so the visual damage tracks remaining health
for as long as the ship lives — and the player's own bar is width-proportional
to the same ratio, which is why the two never disagree.
