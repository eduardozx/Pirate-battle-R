# Progress

Last updated: after the ESLint gate, the new end-to-end specs and the final
documentation pass.

## Status

| Block | State | Evidence |
| --- | --- | --- |
| A — Gameplay core | Complete | 147 headless rule tests; frame-rate independence verified at 30/60/144 fps; the profiler now reports how many entities each frame carried |
| B — Architecture | Complete | Engine is PixiJS-free and React-free; React never re-renders per frame |
| C — Data layer | Complete | 124 Playwright tests across 13 specs: all four remote states, every failure scenario, and exactly one record per match |
| D — Tests & docs | Complete | 147 unit + 124 E2E (14 of them visual baselines), ESLint reporting 0 errors / 0 warnings, and `README.md`, `ARCHITECTURE.md`, `docs/PERFORMANCE.md`, this file |

## Verification gates

All six pass:

```
tsc --noEmit            clean under strict + noUncheckedIndexedAccess
vitest run              147 passed
eslint .                0 errors, 0 warnings
vite build              succeeds (and carries no test seam — see README, "The test seam")
playwright test         124 tests: 120 passed + 4 skipped (touch, desktop project), twice in a row
npm run measure         worst frame p99 7.3 ms; heap delta 0.00 MB over 5 cycles
```

The Playwright suite, including the visual baselines, was run twice consecutively
with no failures. `workers` is pinned to 2 on purpose: the simulation is
frame-paced rather than wall-clock paced, so parallel WebGL contexts starve frames
and make time-based assertions fail sporadically. See
[ARCHITECTURE.md §10](../ARCHITECTURE.md).

The production build was also exercised through `vite preview`: MSW registers, the
ranking and history panels load, a match plays, and teardown leaves no canvas
behind. Opening that build with `?sessionSeconds=6` still plays a full-length match,
which confirms the test seam is genuinely stripped from production.

## Measured performance

| | Result |
| --- | --- |
| Worst frame cost, p99 | 7.3 ms (budget 16.67 ms) |
| Typical play | 6–9× headroom |
| Entities carried per frame (peak) | 9 — against a design ceiling of the player, 9 enemies at once and what is in flight |
| Heap growth, 5 enter/exit cycles | 0.00 MB |
| Simulation cost, first second vs last | flat |

The harness reports ~10.8 fps, which is **not** a result: the container has no GPU,
so Chromium rasterises in software and offers frames ~94 ms apart. The app spends
~2 ms of each frame and waits for the next. Method and caveats:
[PERFORMANCE.md](./PERFORMANCE.md).

## Defects found and fixed

Every one of these was found by a test or a browser check, not by reading the code.

### Data layer

- **The first query escaped the mock service worker.** The app rendered before the
  worker took control, so the first ranking request received the SPA fallback —
  `index.html` with status **200**. Because 200 means "success", the query cache
  stored the HTML as if it were data and the table rendered permanently empty with
  no error anywhere. Fixed by awaiting the worker before the first render, plus
  response shape guards so a wrong payload can never masquerade as an empty
  result.
- **`placeholderData: (previous) => previous` silently produced `undefined` data**
  on a *succeeded* query in TanStack Query v5.104. Replaced with the supported
  `keepPreviousData`.
- **`/api/api/ranking`** — endpoint paths repeated the prefix axios already
  prepends via `baseURL`.
- **Fixtures were seeded under a synthetic fingerprint** that never matched the
  client's, so the ranking was permanently empty. Both now derive it from one
  shared function.
- **Stale persisted mock data** could override fresh seeding, so the ranking looked
  broken after a balance change. Added a seed tag that discards generated rows and
  keeps real submissions.

### Presentation

- **Black bars on every screen whose aspect ratio differed from the arena.** The
  viewport used "contain", which fits the whole arena inside the screen — so a 16:9
  display wasted 10% of its width on empty space, an ultrawide 32.5% and a
  landscape phone 26%. The camera now uses "cover" and follows the ship, so the
  arena always fills the display. Simply scaling up would have cropped the edges
  and let the ship sail off-screen; panning is clamped to the arena, which is safe
  because a cover-scaled view is always a window INSIDE the arena. A test suite
  sweeps six screen shapes and asserts the visible rectangle never escapes the
  water.

### Gameplay

- **Enemies could sail out of the arena while the player could not.** The rule had
  two implementations that disagreed, and the enemy's only ran on the island
  collision path — which returns early when no island was touched. So an enemy
  crossing open border water was never clamped at all. Two things followed: both
  implementations now call one shared pure `clampInsideArena`, and confinement runs
  once per step after every displacement source rather than at each call site.
  Hull-versus-hull separation was a third displacement path that also pushed
  hulls out, including the player's — a second escape found only after the first
  fix was in. The choke point makes the guarantee structural rather than something
  each site must remember.
- **Broadside shots left the bow when the ship pointed vertically.** The firing
  angle used a fixed WORLD constant (±90° from world +X) instead of an offset from
  the bow, so it looked correct only while the ship sailed along +X — the exact
  orientation a test would try first. The shots now fire at
  `player.angle ± 90°`, which keeps them perpendicular to the bow at any heading.
  A regression suite sweeps all 36 headings and asserts the forward cannon still
  fires exactly along the bow.
- **Chasers orbited forever.** At 120°/s the minimum turning circle (~85 units)
  exceeded the engagement range, so a chaser never made contact and never
  detonated. Raised to 420°/s.
- **Missing feedback:** no muzzle flash for the player or enemies, a wood-impact
  sprite used for water splashes, and no hull deterioration.

### Power-ups

- **Consumables were uncollectable.** `initialStateFor` started a repair kit in
  `spent`, which reports `isCollectable: false`, so it sank without ever being
  pickable. The distinction now lives on the collect transition.
- **Crates were unreachable.** Crate lifetime and effect duration shared one timer,
  so a crate 1 100 units away despawned after 8 seconds — before a ship could cross
  the arena. They are now separate budgets (24 s vs the effect duration).
- **The HUD never showed a bonus.** Collecting emitted no event the session
  subscribes to, and the HUD republishes from events rather than polling. Added
  `powerup:changed`.

### Mobile layout

- **The Play button was unreachable on a landscape phone.** Flex centring overflows
  in both directions, and content above the scroll origin can never be scrolled to;
  the button sat at y ≈ −254. Fixed with `align-items: safe center`.
- **Menus could not be scrolled by touch.** `touch-action: none` on `body` is right
  for the canvas but wrong for every menu; menus now use `pan-y`.

### Test infrastructure

- **Vitest was loading the Playwright specs** into a node environment, because both
  runners glob `*.spec.ts`. Excluded `tests/e2e/**`.
- **Test files were not type-checked at all.** `tsconfig.json` included only `src`,
  so a wrong signature in a test was invisible until the test failed for an
  unrelated reason. Tests are now part of the program; doing so immediately exposed
  16 real type errors in existing specs, including a state-machine API whose
  singletons were exported with the concrete class type instead of the interface.
- **A blur event dispatched once was silently dropped** when React had not yet
  attached its listener, so the auto-pause spec failed for a reason unrelated to
  auto-pause. The event is now dispatched in a poll.
- **The pause click was lost under load.** The in-match HUD republishes on every
  clock tick and point of damage, so a single click could be dispatched against a
  node React was about to replace — the handler then ran on a detached node and the
  overlay never appeared, with no error anywhere. Clicks on live HUD controls now go
  through a retrying `clickUntil` helper.
- **Three visual baselines were flaky** for reasons that had nothing to do with the
  UI: live canvas pixels, unsettled panels, and the randomly generated captain
  name. All three are documented in
  [ARCHITECTURE.md §11](../ARCHITECTURE.md) because each is a trap, not a typo.

### Time and coordinates in the end-to-end suite

- **A heading assertion was defeated by the ±π seam.** The pad test held "turn
  left" for 400 ms of simulation spread over three Playwright round trips. Each
  round trip costs ~100 ms of wall time, the simulation clock follows wall time,
  and the button stays pressed for every millisecond of it — so the hull turned
  96° instead of 66°, crossed −π, and the heading it reported jumped from −3.25
  to +3.03. The game had done exactly what the test asked; the raw comparison
  called it a RIGHT turn. Two fixes: the hold now runs inside a single evaluate
  (exact simulation time, the same reasoning as `scriptInputs`), and heading
  comparisons subtract through `headingDelta`, which folds the difference into
  (−π, π]. A coordinate seam can no longer read as a direction.

### Code quality

- **A ref was read during render.** `MatchScreen` initialised its match id, seed
  and HUD store from a ref during render, so a StrictMode double render could
  build two sessions. Replaced with lazy `useState` initialisers — the documented
  shape for exactly this — and the recreate effect now depends on the values it
  actually uses.
- **Submission status copied state it did not own.** `useSubmissionStatus`
  mirrored the queue's `lastError` into local state and resynchronised it from an
  effect: state that could disagree with its source, and a `set-state-in-effect`
  on every change. The message is now derived from the queue, and the hook lost
  twenty lines with it.
- **The two remaining `set-state-in-effect` warnings are deliberate**, each
  carrying an inline disable with a reason: the engine created in
  `MatchScreen`'s effect and the texture registry catching up after a render are
  external systems React is mirroring, which is what an effect is for. The
  configuration file records why the React Compiler rules are warnings rather
  than errors today, so promoting them later is a decision rather than an
  archaeology exercise.

## Known limitations

Carried forward from [ARCHITECTURE.md §8](../ARCHITECTURE.md#8-known-limitations)
and [PERFORMANCE.md §6](./PERFORMANCE.md): no audio, ships render soft on HiDPI
until a 2× atlas is generated, balance is hand-tuned rather than measured, no
GPU-side timing is captured, and there is no long-session memory soak.