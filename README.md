# Pirate Battle

A 2D top-down naval shooter. Sail between islands, sink enemy ships and hold the
line until the clock runs out.

React 18 · TypeScript (strict) · PixiJS 8 · TanStack Query 5 · Axios · MSW 2 · Vitest · Playwright

Design decisions and the reasoning behind them are in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Requirements

Node **20 or 22**. If Node is missing:

```bash
curl -fsSLO https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz
mkdir -p ~/.local/opt && tar -xf node-v22.14.0-linux-x64.tar.xz -C ~/.local/opt
export PATH="$HOME/.local/opt/node-v22.14.0-linux-x64/bin:$PATH"
```

## Setup

```bash
npm install
npm run dev          # http://localhost:5173
```

The game runs entirely in the browser. There is no backend: the ranking and match
history APIs are mocked in the browser with MSW, including in the production build.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with HMR and React StrictMode |
| `npm run build` | Typecheck (`tsc -b`) then production bundle |
| `npm run build:profile` | The same production bundle with the profiler compiled in (what `measure:prod` measures) |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | Types only, no emit |
| `npm run lint` | ESLint over `src`, `tests`, `scripts` and the config files |
| `npm run test` | Rule-engine unit tests (headless, no DOM) |
| `npm run test:e2e` | Playwright end-to-end suite (starts the dev server itself) |
| `npm run test:e2e:ui` | Playwright interactive mode |
| `npm run test:e2e:report` | Open the last HTML Playwright report |
| `npm run test:visual` | Visual baselines only (menu, arena, result — both viewports) |
| `npm run measure` | Performance harness against the dev server |
| `npm run measure:prod` | `build:profile`, serve `dist/` with `vite preview`, measure **that** |

## Controls

| Input | Action |
| --- | --- |
| `W` / `↑` | Sail forward |
| `A` `D` / `←` `→` | Turn |
| `Space` | Fire forward cannon (1 shot) |
| `Q` | Fire left broadside (3 parallel shots) |
| `E` | Fire right broadside (3 parallel shots) |
| `P` / `Esc` | Pause |

Movement and firing are independent — you can sail, turn and shoot at once. On
touch devices an on-screen control set appears automatically; the arena is
landscape-only and prompts for rotation in portrait.

### Touch controls

The keyboard table above is replaced, on a touch device, by the pad the player
actually has — and the same list is printed in the main menu, because an
undocumented control pad is an unusable one:

| Pad | Action |
| --- | --- |
| `▲` | Hold to sail forward |
| `⟲` `⟳` | Hold to turn |
| `✦` | Fire forward cannon (1 shot) |
| `◀` `▶` | Fire left / right broadside (3 shots) |
| `❚❚` | Pause |

Every button carries an accessible name (`aria-label`), so a screen reader gets
the same table, and the pad only appears when the device reports touch support —
a desktop browser never shows it.

## Options

Two settings are exposed, both validated against documented limits and persisted to
`localStorage`:

| Option | Range | Default |
| --- | --- | --- |
| Game session time | 60–180 s | 90 s |
| Enemy spawn time | 0.5–10 s | 3 s |

A match **snapshots** the configuration when it starts, so changing an option
mid-match cannot affect the match in progress or the record it produces.

## Records: ranking and match history

Both tabs are real — they query the mocked API through Axios and TanStack Query and
render all four states (loading, empty, error, data) plus pagination.

- The ranking compares **only matches played with the same configuration**. The
  active filter is shown above the table so the rule is visible rather than implied.
- Ordering is deterministic: score descending, then duration ascending, then
  finish time, then `matchId`. The final clause makes it a total order, so two
  players with identical numbers never swap places between requests.
- An **abandoned** match is never recorded.

### Submission, retries and duplicates

Finishing a match never waits for the network. The result is queued to
`localStorage` and delivered in the background, so **Play Again is always
available**, online or not.

A completed match produces exactly one history record and one ranking entry, even
across retries, double clicks, timeouts and refreshes:

1. `matchId` is generated when the match **starts**, so it survives a refresh.
2. Queuing is keyed by `matchId`, so a double click cannot enqueue twice.
3. Deliveries are serialised.
4. The server upserts by `matchId` and answers a repeat with `duplicate`.

The result screen shows live status: *Recorded*, *Pending*, *Retrying*, or *Failed*,
with a manual retry button. A queued record survives a refresh and is delivered as
soon as the API is reachable.

## Network scenarios

The scenario panel at the bottom of the main menu selects reproducible network
conditions and includes a **Reset mock state** button.

| Scenario | What it exercises |
| --- | --- |
| Success | Healthy API, populated leaderboard |
| Empty lists | Empty state |
| Multiple pages | Pagination and page jumps |
| Slow responses | Loading states |
| Variable latency | Missing loading states |
| Out-of-order responses | Page 1 arriving after page 2 |
| HTTP 500 (ranking) | Per-endpoint failure with data already cached |
| HTTP 400 (history) | Structured client errors |
| Service unavailable (history) | Retryable outages |
| Connection failure | Offline handling |
| Timeout | Client-side timeouts |
| **Submit commits, then times out** | Recovery via idempotent retry — the record exists but the client never learns that |
| **Unavailable at match end** | Finishing a match into a dead endpoint |
| Flaky chaos | Mixed seeded latency and failures |

Every scenario is seeded: the same scenario fails the same way on every run and on
every machine.

## Gameplay rules

- **Scoring:** one point per enemy destroyed by the player's guns. A chaser that
  self-destructs on the player scores nothing.
- **Chaser** pursues the player and explodes on impact, dealing contact damage.
- **Shooter** holds a stand-off distance and fires when in range.
- **Spawning** never places an enemy on land or close enough to the player to cause
  unavoidable damage.
- **Pause** (manual, or automatic on losing focus or hiding the tab) freezes the
  clock, cooldowns and simulation. Resuming requires a deliberate action and
  nothing accumulates while paused.

### Power-ups

Collect by sailing over them.

| Power-up | Type | Effect |
| --- | --- | --- |
| Repair Kit | Instant | Heals 35 HP |
| Rapid Fire | 9 s | Halves weapon cooldowns |
| Timber Shield | 12 s | Absorbs 45 points of damage |
| Double Score | 15 s | Doubles points from kills |
| Overcharge | 8 s | +75% projectile damage |

A crate stays on the water for up to 24 seconds regardless of its effect, so a
distant one is always worth sailing to. Active bonuses and remaining shield are
shown in the HUD while they run.

Adding one is a single entry in `src/game/powerups/powerUpCatalog.ts`. The
catalogue drives the factory (weighted spawn), the state machine (lifecycle) and
the renderer, so the game core never changes when content grows.

## Testing

```bash
npm run test         # 147 rule-engine tests, headless
npm run test:e2e     # 124 Playwright tests, desktop + landscape phone
npm run test:visual  # 14 visual baselines only (7 screenshots × 2 projects)
npm run lint         # ESLint — 0 errors, 0 warnings
npm run measure      # performance harness against the dev server (must be running)
npm run measure:prod # builds, serves dist/ with `vite preview`, and measures that
```

Unit tests cover the rule engine with no DOM and no renderer: frame-rate
independence, collision geometry, arena confinement, spawn guarantees, scoring,
match lifecycle, the submission outbox, power-up pooling, broadside geometry, the
camera framing and the frame profiler's statistics. Tests are type-checked
alongside `src`.

Because the simulation has no rendering dependency, the same seed and input produce
a **bit-identical** match at 30, 60 and 144 fps — the property that makes
reproducible end-to-end tests possible.

The end-to-end suite covers what unit tests cannot reach:

| Spec | What it proves |
| --- | --- |
| `records.spec.ts` | Ranking and history render all four remote states, paginate deterministically, and keep valid rows visible when a background refresh fails |
| `submission.spec.ts` | Exactly one record per match across timeouts, double submission, retries and refreshes — including the commit-then-hang case |
| `gameplay.spec.ts` | Canvas lifecycle, HUD, pause and auto-pause, restart, abandon, and leak-free teardown over five enter/exit cycles |
| `options.spec.ts` | Validation, persistence across refresh, and reset |
| `powerups.spec.ts` | Spawn → collect → effect → HUD → expiry, end to end |
| `controls.spec.ts` | The hull answers the helm, the arena edge holds it, and an island stops it instead of yielding to it |
| `combat.spec.ts` | One volley per press, a press inside the 380 ms cooldown is swallowed rather than queued, a broadside throws three guns, and a hit costs health |
| `enemies.spec.ts` | The spawn schedule, a chaser closing the distance, a shooter holding its stand-off, and a self-destructing chaser scoring nothing |
| `match-end.spec.ts` | Running out of time and losing the hull each end the match, with the right reason on the result screen |
| `keyboard.spec.ts` | The menu is operable from the keyboard alone; `P`/`Esc` pause and resume, and both dialogs are modal with focus where it belongs |
| `touch.spec.ts` | The on-screen pad steers, fires and reports what is held — and the menu documents the pad (runs on the phone project) |
| `responses.spec.ts` | A slow endpoint shows a loading state, a late response never replaces fresher data, the ranking gains exactly one row per match, and a failed asset reports itself and recovers on retry |
| `visual.spec.ts` | Pixel baselines for the menu, ranking, history, options, arena, pause overlay and result screen |

It all runs twice: once on a desktop viewport and once on a landscape phone.

### Reproducing a failure

```bash
# one spec, with a plain linear log
npm run test:e2e -- tests/e2e/combat.spec.ts --reporter=line

# one test, on one project
npm run test:e2e -- tests/e2e/combat.spec.ts -g "cooldown" --project=desktop

# follow it on screen, or drive it interactively
npm run test:e2e -- tests/e2e/controls.spec.ts --headed
npm run test:e2e:ui
```

A failure keeps its evidence in `test-results/`: a screenshot, a video and a
trace of the run itself — kept for the failed test, not only for a retry,
because a failure on a local machine is exactly the one nobody can reproduce for
you. Open it with `npx playwright show-trace <file>.zip`: every action, the
console and the network, in order.

Every run also writes a self-contained HTML report to `playwright-report/`
(`npm run test:e2e:report` opens the last one), and
[`docs/TEST-REPORT.md`](./docs/TEST-REPORT.md) is the committed summary of the
last full run — the human-readable half of the delivery's "test reports". The
other half is committed as artifacts: the report of the last full run is snapshotted
under [`docs/reports/`](./docs/reports/), beside the raw performance output
(`measure-dev-*`, `measure-prod-*`) recorded the same day.

The suite is built to fail the same way twice:

- **Network scenarios are seeded**, so a timeout, a 500 or an out-of-order
  response happens at the same moment on every machine.
- **The simulation is seed- and frame-rate-independent**: the same seed and input
  produce a bit-identical match, which is why specs assert on *simulation* time
  instead of wall-clock time.
- **The test seam is read-mostly.** Specs reach into the running game through
  `window.__pbTest` (present in dev builds only): a snapshot of the world, event
  counters, and `advance(ms)` to move simulated time. It can observe and it can
  step the clock — it cannot spawn, damage or teleport anything, because a test
  that mutates the rules can no longer fail for breaking them.
- URL parameters shorten what would otherwise be minutes (`?sessionSeconds=6`)
  without editing the game.

If a test passes alone but fails in the suite, look at the worker count first.
The config runs two workers on purpose: four starve the WebGL contexts, and
simulation time runs slower than wall time precisely when frames are starved.

### Performance

`npm run measure` plays real matches and reports frame-cost percentiles, split
into simulation and render — plus how many entities each frame was carrying,
because a percentile without the world size that produced it is not comparable.
`npm run measure:prod` rebuilds `dist/` with the profiler compiled in
(`build:profile`) and runs the same scenarios against that **optimised bundle**,
so fps, frame-time p95, CPU cost and entity counts all come off a production build:

| | dev build | optimised build |
| --- | --- | --- |
| Worst CPU cost per frame, p99 | 3.5 ms | **3.0 ms** (budget 16.67 ms) |
| Worst single frame observed | 7.6 ms | **4.0 ms** → 4.2× headroom |
| Typical play | 6.9–9.8× headroom | 5.0–10.4× headroom |
| 3-minute match (the brief's scenario) | entities 6/11, frame cost p95 1.3 ms | entities **6/11**, fps **11.4**, frame time p95 **100 ms**, frame cost p95 **1.3 ms** |
| Entities per frame (peak) | **11**, against a design ceiling of the player, at most 9 enemies at once, and what is in flight | **11** |
| Heap over 5 enter/exit cycles | −3.33 MB | **−1.43 MB** |
| Page errors | 0 | 0 |

Full method, caveats and known gaps in [docs/PERFORMANCE.md](./docs/PERFORMANCE.md);
raw outputs of both runs in [docs/reports/](./docs/reports/). The achieved-FPS
column is deliberately *not* a result — §4 of that document explains why: the
container has no GPU, so frames arrive ~100 ms apart whatever the game does. The
CPU column is the one that transfers, and it reports 5–10× headroom against the
60 fps target.

### The test seam

The shortest session a player may choose is 60 seconds, and reaching a drifting
pickup at the real radius cannot be scripted in real time. Specs that need a
finished match therefore pass parameters in the URL — `?sessionSeconds=6`,
`?powerUpPickupRadius=5000`, `?powerUpMinDistance=0`.

The override lives behind `import.meta.env.DEV`, so it is dead code in a
production build: a build opened with `?sessionSeconds=6` still plays a full-length
match. Verified rather than assumed — the seams are **absent from the bundle**,
not merely switched off:

```bash
npm run build
grep -o '__pbTest\|__pbProfile\|get("sessionSeconds")' dist/assets/*.js
# prints nothing: Vite replaced the flag at build time and the minifier dropped
# every branch behind it (the word "sessionSeconds" survives only as the name of
# the player-facing option it configures)
```

`npm run build:profile` is the deliberate exception: it flips a second define so
the **profiler** survives into an otherwise normal optimised bundle — that is how
[performance](#performance) measures CPU cost and entity counts off a production
build. Run the same grep against it and only `__pbProfile` matches; `__pbTest` and
the URL overrides are still gone, because the test hook never leaves a dev build.

## Lint

```bash
npm run lint        # eslint .
```

[`eslint.config.js`](./eslint.config.js) is a flat config covering `src`, `tests`,
`scripts` and the config files themselves: `@eslint/js` and `typescript-eslint`
recommended, plus `eslint-plugin-react-hooks`.

Severity is a decision, not a default, and the config explains each one:

| Severity | What goes there | Why |
| --- | --- | --- |
| **error** | Unused variables, the core rules of hooks, rules TypeScript already covers better than ESLint | Breaking these changes behaviour, and nothing else will tell you |
| **warning** | React Compiler diagnostics (`purity`, `refs`, `set-state-in-effect`, …), `no-explicit-any` | They describe a direction for the code. Promoting them today would mean rewriting working screens to satisfy a linter while feature work waits |
| inline disable | Two places, each with its reason attached | The engine created in `MatchScreen`'s effect and the texture registry catching up after a render are *external systems React is mirroring* — which is exactly what an effect is for |

The rules that were worth fixing were fixed rather than silenced: the report is
currently **0 errors and 0 warnings**, and `npm run lint` exits non-zero on any
error, so it can gate a commit as it stands.

## Environment variables

There are no secrets and no backend to point at: every API call is answered in
the browser by MSW, in development and in the production build alike.

| Variable | Read by | Meaning |
| --- | --- | --- |
| `CI` | `playwright.config.ts` | Selects the CI profile — one retry, `test.only` forbidden, the HTML reporter enabled, and a dev server started by Playwright instead of reusing the one already running |
| `NODE_ENV` | Vite, React, tooling | `production` for `npm run build`. Nothing in this repo branches on it directly |
| *(not an env var)* `BASE_URL` | Vite → `import.meta.env.BASE_URL` | The base path the app is served from, set by `base` in `vite.config.ts` or `vite --base=`. It prefixes the art, the mocked API and the MSW worker, so deploying under a sub-path keeps every URL correct |
| *(not an env var)* `DEV` | Vite → `import.meta.env.DEV` | Gates every test seam: the `?sessionSeconds=` override, `window.__pbTest` and, in development, `window.__pbProfile`. Vite replaces the flag at build time, so a production bundle contains none of them — the grep in **The test seam** above checks `dist/` instead of taking that on faith |
| *(not an env var)* `PROFILE` | `vite.config.ts` → `import.meta.env.PROFILE` | `true` only for `vite build --mode profile`. It compiles the **profiler** — never the test hook — into an otherwise normal optimised bundle, so CPU cost and entity counts can be read off a production build (§9 of the brief) instead of inferred from the dev one. The deployed bundle replaces it with `false` and the minifier drops the whole block |

`npm run measure [baseUrl]` takes the dev server's URL as an argument rather than
an environment variable.

## Deployment

The output of `npm run build` is a static bundle in `dist/`: there is no backend
to deploy, because MSW answers `/api/*` from inside the browser (its service
worker ships in `public/`). Any static host works.

This repository is already linked to the Vercel project `pirate-battle`
(`.vercel/project.json`), so a production deploy is one command:

```bash
npx vercel --prod
```

Vercel's default build command (`vite build`, output `dist/`) is what
[`vite.config.ts`](./vite.config.ts) produces; nothing needs configuring. The one
thing a non-root deploy would need is the base path — see `BASE_URL` above.

## Project layout

```
src/
├─ components/     React UI: canvas bridge, HUD, panels, screens
├─ game/           Engine
│  ├─ assets/      Asset manifest + texture registry + atlas parser
│  ├─ config/      Gameplay balance + arena layout
│  ├─ core/        World, session, loop, clock, RNG, math, events
│  ├─ entities/    Entity models, pool, and the PixiJS views
│  ├─ input/       Input intents
│  ├─ physics/     Collision geometry + spatial hash
│  ├─ powerups/    Catalogue, states, factory, pooled system
│  ├─ render/      PixiJS application and per-frame sync
│  └─ systems/     Player, enemies, spawner, projectiles, effects
├─ services/       Axios, TanStack Query, MSW, submission outbox
├─ store/          HUD store, options store, player profile
└─ styles/

tests/
├─ rules/          Headless rule-engine tests (Vitest)
└─ e2e/            Browser tests + visual baselines (Playwright)

scripts/
└─ measure-performance.mjs   Performance harness
```

## Known limitations

Listed with reasons in [ARCHITECTURE.md §8](./ARCHITECTURE.md#8-known-limitations)
and measured gaps in [docs/PERFORMANCE.md §6](./docs/PERFORMANCE.md): no audio, soft
ship rendering on HiDPI, hand-tuned balance, and no GPU-side timing.
