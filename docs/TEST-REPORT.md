# Test report

The committed, readable half of the delivery's "test reports". The other half is
generated: every `npm run test:e2e` writes a self-contained HTML report to
`playwright-report/` (`npm run test:e2e:report` opens it), and the report of this
delivery's run is committed as
[`docs/reports/playwright-2026-10-04/index.html`](./reports/playwright-2026-10-04/index.html)
— one file, open it straight from the repository.

**Run:** 2026-10-04 · Playwright 1.63.0 / Chromium · Node 26.10 · 4-vCPU container,
no GPU · two workers · both projects.

## Result

| Project | Viewport | Tests | Passed | Skipped | Failed |
| --- | --- | ---: | ---: | ---: | ---: |
| `desktop` | Chromium, 1440×900 | 62 | 58 | 4 | 0 |
| `mobile` | Pixel 5, landscape | 62 | 62 | 0 | 0 |
| **total** | | **124** | **120** | **4** | **0** |

≈ 8 minutes wall time. The four skips are the touch specs on the desktop project —
they assert on a control pad that only exists where `hasTouch` is true, so a
desktop run reports them as skipped instead of passing them vacuously.

Unit tests, run separately: **147 passed / 147** across 8 files (`npx vitest run`),
plus `npx tsc --noEmit` clean and `npm run lint` at 0 errors / 0 warnings.

The suite was run eight times while preparing this delivery — this report is the
last of them, on the final configuration. Exactly one run failed, on
`controls.spec.ts` — "an island stops the hull instead of yielding to it" — and
the cause was the test, not the game: its drive was built from four round trips
to the browser, so a loaded machine added distance the assertion never accounted
for and the hull ended up sailing *round* the island, which is legal navigation.
The drive now runs inside a single `page.evaluate` with the hull sampled every
50 ms; eight consecutive repeats pass, and so does every full run since — this
one included.

## Coverage against the brief's §8 list

| # | Required coverage | Where |
| --- | --- | --- |
| 1 | Options navigation, validation, persistence across refresh | `options.spec.ts` (4 tests, includes `page.reload()`) |
| 2 | Asset loading, failure and retry | `responses.spec.ts` ("an asset failure is reported, and retry recovers it") |
| 3 | Match start, movement, rotation, arena bounds, island collision | `gameplay.spec.ts`, `controls.spec.ts` (3) |
| 4 | Frontal and side shots, damage, cooldown, score without duplication | `combat.spec.ts` (3), `enemies.spec.ts` (self-destruct scores nothing) |
| 5 | Chaser and Shooter behaviour, spawn interval | `enemies.spec.ts` (4) |
| 6 | Ending by time and by death, simulation interruption, clean restart | `match-end.spec.ts` (2), `gameplay.spec.ts` (restart) |
| 7 | Pause, focus loss, resume without clock advance | `gameplay.spec.ts` (2), `keyboard.spec.ts` (2) |
| 8 | Result screen and its persistence across refresh | `visual.spec.ts` (result baseline), `submission.spec.ts` (reload lands on the result screen) |
| 9 | Abandoning, repeated navigation between screens, touch controls | `gameplay.spec.ts` (abandon, 5 enter/exit cycles), `touch.spec.ts` (4, phone project) |
| 10 | Ranking and Match History query and pagination: loading, empty, error | `records.spec.ts` (8) |
| 11 | Recording a match, both tabs updating, pending recovery after refresh | `submission.spec.ts` (7), `responses.spec.ts` (ranking gains exactly one row) |
| 12 | Resend after timeout without duplication; late responses never overwrite | `submission.spec.ts`, `responses.spec.ts` ("a late response never replaces fresher data") |

Chromium is exercised on **both** a desktop and a landscape-phone project, and
visual baselines cover menu, arena (frozen) and result screen — seven screenshots
per project, fourteen in total, versioned in the repository.

## Reproducing

```bash
npm run test:e2e                                  # everything, both projects
npm run test:e2e -- tests/e2e/combat.spec.ts --reporter=line
npm run test:e2e -- tests/e2e/combat.spec.ts -g "cooldown" --project=desktop
npm run test:e2e:ui                                # interactive
npm run test:e2e:report                            # the HTML report
npx playwright show-trace test-results/<file>.zip  # a failed run, step by step
```

Failures keep a screenshot, a video and a trace in `test-results/`
(`trace: 'retain-on-failure'`), so evidence exists for a failure that happens
once, on a machine nobody else can reach.

## Why these tests can be trusted

- **Seeded scenarios.** Network behaviour (timeouts, 5xx, out-of-order replies)
  is driven by a seeded generator, so a failure lands at the same moment on every
  machine.
- **Simulation time, not wall time.** Assertions step the game's own clock
  (`window.__pbTest.advance`), and the input helpers run an entire hold inside one
  `page.evaluate`, so a round trip on a loaded box cannot change what the test
  measured. The island-confinement spec goes further: it samples the hull every
  50 ms *during* the drive, which is why a hull that crossed the land could not
  slip between two samples.
- **Read-only instrumentation.** The hook exposes a snapshot, event counters and
  the clock. It has no spawn, no damage and no teleport: a test that mutates the
  rules can no longer fail for breaking them.
- **Isolation.** Every test starts from a fresh browser context; the mock database
  lives in `localStorage`, which is per context. Two workers are deliberate —
  four starve the WebGL contexts and make simulation time drift from wall time
  (see [ARCHITECTURE.md §10](../ARCHITECTURE.md)).
