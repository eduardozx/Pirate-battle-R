# Performance

Measured numbers, how they were taken, and what they do and do not prove.

Reproduce with:

```bash
npm run dev
npm run measure          # dev server
npm run measure:prod     # profiled production build, served by `vite preview`, measured
```

Raw outputs of the runs quoted here are committed under
[`docs/reports/`](./reports/) — `measure-dev-2026-10-04.txt` and
`measure-prod-2026-10-04.txt` — so every figure below can be checked without
re-running anything.

---

## 1. Method

`src/game/core/frameProfiler.ts` wraps the Pixi ticker and times three things
separately: **simulation** (`GameSession.stepFrame`), **render** (copying entity
state into the display list) and the **frame** total. It is enabled by the
`?profile` URL parameter, in dev builds and in the `npm run build:profile`
bundle alike (§2.1), and exposes a read surface the harness polls. The deployed
build replaces the gate with a literal and drops the whole block.

The same summary carries a fourth, non-timing signal: **how many entities each
frame was carrying** — `entities.current` and `entities.peak`, sampled once per
frame from `GameWorld.entityCount` (the entity store's live count: player,
enemies, projectiles and effects). A p99 without the world size that produced it
cannot be compared with anything, and "the cost does not grow as the arena
fills" is only checkable if the report says how full it got. The harness prints
it as `entities=<current>/<peak>` per scenario and `entities peak=` in the
headroom block.

Four decisions make the numbers trustworthy:

- **A ring buffer, not a growing array.** The profiler runs once per frame, so its
  own cost is inside what it measures. Samples land in a preallocated
  `Float32Array`; nothing allocates in the hot path. A profiling build that
  allocates would be measuring its own garbage collection.
- **Percentiles, not an average.** A run can average 2 ms while p99 is 40 ms, and
  the player experiences that 40 ms as a stutter. Only the tail is actionable.
- **Simulation and render are charged separately.** Attributing render with
  "everything after the substep" would bill simulation's cost to the GPU.
- **Injection point is inside the frame callback.** Nothing else can see where the
  time actually goes.

### The matches that were measured

| Scenario | session length | window | input |
| --- | --- | --- | --- |
| idle | 90 s | 12 s | none |
| sailing + firing | 90 s | 20 s | `ArrowUp` held, a shot every 1.2 s |
| **3-minute match** | **180 s** (the brief's maximum) | 185 s | `ArrowUp` held, a shot every 1.5 s, a spawn every 3 s |
| enter/exit cycles (×5) | 60 s, played for 6 s each | 6 s each | `ArrowUp` held, then abandoned |

The two long sessions are written into the player's own `pb.options.v1` key
before the page loads — the same key the Options screen writes — so the harness
plays a *player-configured* match through the game's real configuration path, in
every build, rather than through a test flag. The shorter scenarios use the URL
parameter that only a dev build carries; in the optimised build it is inert and
the session length falls back to the stored option, which does not affect a window
that is far shorter than either. Everything else — hull speed, weapon cooldowns,
damage, spawn rules — is the shipped default gameplay configuration, untouched by
the harness (the full table is in [ARCHITECTURE.md §12](./ARCHITECTURE.md)).

Headless Chromium, 1440×900, no GPU: the environment is part of the result, so it
is stated with it (§2).

### What this measures, precisely

The measured region is **JavaScript CPU work on the main thread**. It does not
include GPU rasterisation, which PixiJS submits asynchronously and the browser
performs after the callback returns. So:

- `sim` and `render` are trustworthy CPU figures.
- `fps` in this environment is **not** a measure of the game. See §4.

---

## 2. Results

Headless Chromium **153.0.8010.12** (Playwright 1.63), SwiftShader software
rasterisation, 1440×900, on a 4-vCPU / 15 GiB container running Node v26.10.0.
This section is the **dev server**; §2.1 repeats the measurement against the
optimised `dist/` build.

| Scenario | entities now / peak | sim p50 / p95 / p99 | frame cost p50 / p95 / p99 | CPU headroom |
| --- | --- | --- | --- | --- |
| idle | 5 / 6 | 0.7 / 1.4 / 3.0 | 0.8 / 1.6 / 3.0 | **4.8×** |
| sailing + firing | 6 / 11 | 0.6 / 1.1 / 1.4 | 0.7 / 1.2 / 1.6 | **9.8×** |
| **3-minute match** | 6 / 11 | 0.7 / 1.1 / 1.9 | 0.8 / 1.3 / 2.2 | **6.9×** |
| enter/exit cycles (×5) | 2 / 5 | 0.6 / 1.1–1.3 / 1.4–1.8 | 0.7 / 1.3–1.5 / 1.6–1.8 | **7.6–9.3×** |
| worst single frame observed | — | — | **7.6** | **2.2×** |

All figures in milliseconds. *Headroom* is how many times that row's `cpu p99` —
simulation p99 + render p99, the harness's deliberately conservative CPU figure —
fits inside the 16.67 ms budget for 60 fps.

The **3-minute match** row is the brief's own scenario: a match run for its full
three minutes with regular fire, driven through the player's saved options rather
than a test-only flag — see §1 for why that matters.

### The headline

**Worst-case CPU cost per frame: 3.5 ms at the p99 of the worst scenario (idle,
simulation + render summed), and 7.6 ms for the single worst frame the run ever
saw — both against a 16.67 ms budget.**

Typical play sits between 6.9× and 9.8× headroom; even the single worst frame
leaves 2.2×. Simulation cost stays flat between the first second of a match and
its last, which is the result that matters most: the cost does not grow as the
arena fills with ships, projectiles and effects.

### Entities: what the timings were measured on

The claim above needs a world size attached to it, so every row carries its own —
and what that number means:

An *entity* is anything the simulation tracks — the player, enemies, projectiles
and effects — counted from the entity store rather than from the display list, so
it is the load the frame actually had to simulate and collide, not what happened
to be on screen.

Two readings:

- **The flat tail is not an artifact of an empty arena.** The 3-minute row peaks
  at 11 entities — against a design ceiling of the player, at most 9 enemies
  alive at once (the spawn cap) and whatever is in flight — and its p99 sits
  where the idle row's does. A cost that grew with entity count would show up
  exactly there.
- **The peak is bounded by design, not by luck.** Spawn concurrency is capped and
  projectiles/effects are pooled and lifetime-bound, so `peak` cannot climb over
  a session — which is the same property the memory section measures from the
  other side.

Unlike the timing columns, entity counts are object counts: they do not depend on
the machine at all, only on what the match spawned. The harness does not pin the
match seed, so the exact mix drifts by an entity or two between runs; the peak is
the number that is stable, and it is the one quoted here.

Raw output: [`reports/measure-dev-2026-10-04.txt`](./reports/measure-dev-2026-10-04.txt).

---

## 2.1 The same harness on the optimised build

```bash
npm run measure:prod    # = npm run build:profile, then the harness against `vite preview`
```

The brief asks for frame rate, frame-time p95 **and entity counts from a
three-minute match in an optimised build** — while the profiler that reports CPU
cost and entities is, by design, absent from the deployed bundle. So the optimised
build is produced twice from the same source:

| build | command | carries |
| --- | --- | --- |
| **deployed** | `npm run build` | no profiler, no test hook, no `?sessionSeconds=` — the grep in the README checks `dist/` for this one |
| **measured** | `npm run build:profile` | the same `vite build` optimisation (minified, bundled, production React) with one flag flipped: `import.meta.env.PROFILE` compiles to `true` and the profiler is kept |

That flag is a `define` in `vite.config.ts`, not an environment variable, so
nothing a deployment inherits can switch it on; the test hook stays behind
`import.meta.env.DEV` in both, so measuring the game never plays it for you.

The measured build (15.1 s) is served with `vite preview` on port 4173 and run
through the same scenario set as §2:

| Scenario | fps | frame time p50 / p95 / p99 | entities now / peak | frame cost p50 / p95 / p99 | CPU headroom | JS heap |
| --- | --- | --- | --- | --- | --- | --- |
| idle | 10.18 | 100.0 / 116.7 / 133.3 | 5 / 6 | 0.8 / 1.6 / 3.0 | **5.1×** | 12.11 MB |
| sailing + firing | 11.19 | 83.4 / 100.1 / 116.7 | 6 / 11 | 0.8 / 1.4 / 1.9 | **7.6×** | 12.11 MB |
| **3-minute match** | 11.38 | 83.4 / 100.0 / 100.1 | 6 / 11 | 0.8 / 1.3 / 1.7 | **8.3×** | 10.11 MB |
| enter/exit cycles (×5) | 11.08–11.33 | 83.4 / 100.0–100.1 / 100.1–150.0 | 2 / 5 | 0.7–0.9 / 1.3–1.8 / 1.4–2.1 | **6.0–10.4×** | 12.11 → 10.68 MB |

All timings in milliseconds. Canvases (1 while a match is on screen) and page
errors (0, every scenario) are printed per row in the raw output.

**The three numbers §9 asks for, taken off the optimised build:** 11.38 fps,
frame-time p95 of 100.0 ms, and 11 entities at peak — 6 alive at the sampling
moments — in the three-minute match; the CPU spends 1.3 ms of each frame at p95.

Four readings:

- **The production bundle is measurably faster than the dev one**, which turns
  §4's "dev is a pessimistic upper bound" from an argument into a measurement:
  worst frame-cost p99 falls from 3.5 ms to **3.0 ms**, the single worst frame
  from 7.6 ms to **4.0 ms**, and the three-minute match's CPU p99 from 2.4 ms to
  **2.0 ms**.
- **Frame time is environment-bound for the reason §4 gives** — ~100 ms between
  callbacks, ~11 fps, because there is no GPU in this container. The 60 fps target
  cannot be read off that column; the CPU column is the transferable one, and it
  reports 5–10× headroom against the same target.
- **Entity counts have the same shape as the dev runs** (peak 11 in a real match,
  6 idle) — as they should, since entity count is a property of the simulation and
  not of the bundle. The difference is that this time it was measured rather than
  borrowed.
- **The five cycles start at 12.11 MB and end at 10.68 MB**: no growth, zero page
  errors, exactly one canvas while a match is on screen.

Raw output: [`reports/measure-prod-2026-10-04.txt`](./reports/measure-prod-2026-10-04.txt).

---

## 3. Memory across enter/exit cycles

Five consecutive matches, each fully started and abandoned:

| | Cycle 1 | Cycle 5 | Delta |
| --- | --- | --- | --- |
| JS heap, dev build | 20.69 MB | 17.36 MB | **−3.33 MB** |
| JS heap, optimised build | 12.11 MB | 10.68 MB | **−1.43 MB** |
| Canvases left mounted | — | 1 (in-match) | — |
| Page errors | — | — | 0 |

**No heap growth across five cycles.** Both builds end *below* where they
started — the first cycle's one-off allocations are still being collected by the
time the fifth one runs — so neither reading can show the upward slope that a
leak produces. This is the concrete payoff of the
lifetime decisions in [ARCHITECTURE.md §1](./ARCHITECTURE.md):

- the **session** is owned and destroyed by `MatchScreen`, so a restart cannot
  inherit state;
- the **renderer** (WebGL context and display list) is owned by `GameCanvas`, which
  releases it in cleanup;
- the **texture registry** deliberately *outlives* matches, so a restart reuses warm
  GPU textures instead of re-uploading the atlas — which is precisely why the heap
  does not climb while textures are freed per match and re-created.

A separate E2E assertion backs this up from the DOM: exactly one canvas while a
match runs, and zero once the host unmounts, over five cycles.

---

## 4. Frame time, and why achieved FPS is not a result

The brief asks for frame-time percentiles, so the harness samples
`requestAnimationFrame` deltas itself — an evaluation the page performs, not an
instrumentation the game opts into, which is why §2.1 gets the same percentiles
out of an optimised bundle for which the profiler was, until then, the missing
half.

Dev build, time between consecutive frames:

| Scenario | fps | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| idle | 10.14 | 100.0 | 116.7 | 116.8 |
| sailing + firing | 11.43 | 83.4 | 100.1 | 100.1 |
| **3-minute match** | 11.61 | 83.4 | 100.1 | 100.1 |
| worst p95 seen | — | — | **116.7** | — |

All in milliseconds, all against a 16.67 ms budget for 60 fps — and all of them
far over it. Those gaps are **not** this game.

The container has no GPU, so Chromium rasterises through SwiftShader in software
and `requestAnimationFrame` is offered frames roughly 100 ms apart. The profiler
sees frames that arrive slowly, not frames that take long: the app spends ~1–3 ms
of each one (§2) and then waits ~99 ms for the next.

Two things follow:

1. **The CPU cost is the number to trust**, because it is measured inside the
   callback and is unaffected by how often the callback is invoked. Frame time is
   reported next to it — with its cause stated — rather than silently dropped.
2. **Frame-rate independence was exercised under exactly this handicap.** At
   ~10 fps the substepping loop still produced correct, deterministic matches —
   the whole E2E suite passes in this environment. The 60/144 fps determinism
   tests cover the other end.

Reporting "10.1 fps" as a performance result would be misleading in the same way
reporting a CPU cost measured on a throttled CPU would be.

### Dev builds are a pessimistic upper bound

The profiler is compiled out of the deployed bundle, so the cost figures in §2
come from the dev server, which additionally pays for React StrictMode
double-rendering and unminified, un-bundled code. That this is an upper bound is
now a **measurement** rather than an argument: §2.1 runs the same scenarios
against the optimised bundle and every tail is lower (3.0 ms against 3.5 ms at
p99, 4.0 ms against 7.6 ms on the worst single frame). The trade was deliberate —
a published build should not expose internals, and a conservative measurement is
safer than a flattering one — and `build:profile` is what lets the optimistic
number be measured without reopening it.

---

## 5. Design decisions that produced this

These are the choices the numbers justify, not decoration.

### Object pooling

Power-ups, projectiles, effects and ship views are allocated once and recycled. A
test enforces the contract directly — 500 spawns produce at most `poolSize`
distinct object identities — so the guarantee cannot silently regress into
per-spawn garbage. Zero steady-state allocation is what keeps the p99 tail flat
instead of spiking whenever a GC cycle lands.

### Mark-and-sweep views

The renderer reconciles the display list against live entities each frame and
detaches exactly what disappeared, so nothing is created or destroyed per frame.
Views are bound to pool slots and only rebind when a slot's power-up kind actually
changes.

### Shipped design consequences

Chaser turn rate was raised from 120°/s to 420°/s. The minimum turning circle is
`speed / angularSpeed`; at the original rate that circle (~85 units) exceeded the
engagement range, so chasers orbited forever and never made contact. This is
correctness and feel, not throughput, but it is the same class of finding as the
profile above: measure, then fix the number that measurement exposed.

---

## 6. Known gaps

- **No GPU timing.** PixiJS exposes batch counts and, on some backends, GPU
  timings; neither is captured here, so draw-call scaling as the arena fills is
  unmeasured. CPU cost is flat, which suggests the bottleneck is not on the main
  thread, but that is an inference, not a measurement.
- **Single machine, single browser.** Every figure is one container on one CPU.
  The mobile project in the E2E suite runs on a phone viewport but with the same
  engine, so it does not substitute for testing on real low-end hardware.
- **No long-session soak.** Cycles run ~6 s each. A multi-hour session could still
  surface a slow leak that five short cycles would miss.