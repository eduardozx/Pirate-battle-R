# Performance

Measured numbers, how they were taken, and what they do and do not prove.

Reproduce with:

```bash
npm run dev
npm run measure
```

---

## 1. Method

`src/game/core/frameProfiler.ts` wraps the Pixi ticker and times three things
separately: **simulation** (`GameSession.stepFrame`), **render** (copying entity
state into the display list) and the **frame** total. It is enabled in dev builds
by the `?profile` URL parameter, and exposes a read surface the harness polls.

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

### What this measures, precisely

The measured region is **JavaScript CPU work on the main thread**. It does not
include GPU rasterisation, which PixiJS submits asynchronously and the browser
performs after the callback returns. So:

- `sim` and `render` are trustworthy CPU figures.
- `fps` in this environment is **not** a measure of the game. See §4.

---

## 2. Results

Headless Chromium 93, SwiftShader software rasterisation, 1440×900, dev server.

| Scenario | sim p50 | sim p95 | sim p99 | render p50 | render p99 | frame p99 | CPU headroom |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle | 0.5 | 1.1 | 1.9 | 0.1 | 0.3 | 2.1 | **8.8×** |
| sailing + firing | 0.6 | 1.0 | 2.8 | 0.1 | 0.4 | 2.1 | **6.0×** |
| full match (60 s) | 0.5 | 0.9 | 2.1 | 0.1 | 0.4 | 2.2 | **7.6×** |
| worst observed | — | — | — | — | — | **7.3** | **1.9×** |

All figures in milliseconds. *Headroom* is how many times the worst-case CPU cost
fits inside the 16.67 ms budget for 60 fps.

### The headline

**Worst-case CPU cost per frame: 7.3 ms, against a 16.67 ms budget.**

Even the worst scenario leaves roughly 2× headroom, and typical play sits between
6× and 9×. Simulation cost stays flat between the first second of a match and its
last, which is the result that matters most: the cost does not grow as the arena
fills with ships, projectiles and effects.

### Entities: what the timings were measured on

The claim above needs a world size attached to it, so the report now carries one
for every scenario:

| Scenario | entities | peak |
| --- | --- | --- |
| idle | 3 | 5 |
| sailing + firing | 6 | 8 |
| full match (60 s) | 6 | 9 |
| enter/exit cycles (×5) | 3–5 | 5 |

An *entity* is anything the simulation tracks — the player, enemies, projectiles
and effects — counted from the entity store rather than from the display list, so
it is the load the frame actually had to simulate and collide, not what happened
to be on screen.

Two readings:

- **The flat tail is not an artifact of an empty arena.** The full-match row
  peaks at 9 entities — against a design ceiling of the player, at most 9
  enemies alive at once (the spawn cap) and whatever is in flight — and its p99
  sits where the idle row's does. A cost that grew with entity count would show
  up exactly there.
- **The peak is bounded by design, not by luck.** Spawn concurrency is capped and
  projectiles/effects are pooled and lifetime-bound, so `peak` cannot climb over
  a session — which is the same property the memory section measures from the
  other side.

Unlike the timing columns, entity counts are object counts: they do not depend on
the machine at all, only on what the match spawned. The harness does not pin the
match seed, so the exact mix drifts by an entity or two between runs; the peak is
the number that is stable, and it is the one quoted here.

---

## 3. Memory across enter/exit cycles

Five consecutive matches, each fully started and abandoned:

| | Cycle 1 | Cycle 5 | Delta |
| --- | --- | --- | --- |
| JS heap | 19.55 MB | 19.55 MB | **0.00 MB** |
| Canvases left mounted | — | 1 (in-match) | — |
| Page errors | — | — | 0 |

**Zero heap growth across five cycles.** This is the concrete payoff of the
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

## 4. Why achieved FPS is not reported as a result

The harness records ~10.8 fps. That number is **not** about this game.

The container has no GPU, so Chromium rasterises through SwiftShader in software
and `requestAnimationFrame` is offered frames roughly 94 ms apart. The profiler
sees frames that arrive slowly, not frames that take long: the app spends ~2 ms of
each one and then waits ~92 ms for the next.

Two things follow:

1. **The reported CPU cost is the number to trust**, because it is measured inside
   the callback and is unaffected by how often the callback is invoked.
2. **Frame-rate independence was exercised under exactly this handicap.** At
   ~10 fps the substepping loop still produced correct, deterministic matches — the
   whole E2E suite passes in this environment. The 60/144 fps determinism tests
   cover the other end.

Reporting "10.8 fps" as a performance result would be misleading in the same way
reporting a CPU cost measured on a throttled CPU would be.

### Dev builds are a pessimistic upper bound

The profiler is compiled out of production (`import.meta.env.DEV`), so these
figures come from the dev server, which additionally pays for React StrictMode
double-rendering and unminified, un-bundled code. Real production cost is
**lower** than the table above. That was a deliberate trade: a published build
should not expose internals, and a conservative measurement is safer than a
flattering one.

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