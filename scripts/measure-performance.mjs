import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

/**
 * Performance harness.
 *
 * Plays real matches and reports two different things, because they answer two
 * different questions:
 *
 *   - the PROFILER (`?profile`, dev builds only) times what the CPU spent inside
 *     the frame callback: simulation, render, frame cost, live entity count.
 *   - a page-side rAF SAMPLER times how far apart frames arrived. It needs no
 *     instrumentation at all, which is what makes it usable against a production
 *     build — where the profiler is deliberately compiled out.
 *
 * Usage:
 *   node scripts/measure-performance.mjs [baseUrl]        # dev server
 *   node scripts/measure-performance.mjs --prod           # builds nothing: runs `vite preview`
 *
 * The simulation is seeded, so runs are comparable; only the hardware varies.
 */

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const PORT = 4173;
const BASE = args.find((value) => !value.startsWith('--')) ?? (prod ? `http://localhost:${PORT}` : 'http://localhost:5173');

/** Headless Chromium's rAF is not vsync-locked, so FPS here is an upper bound. */
const VIEWPORT = { width: 1440, height: 900 };

const round = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
const fmt = (value) => (typeof value === 'number' ? round(value) : 'n/a');

/* -------------------------------------------------------------------------- */
/* Production preview (only with --prod)                                       */
/* -------------------------------------------------------------------------- */

const waitForServer = async (url, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up — run \`npm run build\` first`);
};

let preview = null;
if (prod) {
  preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  await waitForServer(BASE, 60_000);
}

const shutdown = () => {
  if (preview !== null && !preview.killed) preview.kill('SIGTERM');
  preview = null;
};
process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});

/* -------------------------------------------------------------------------- */
/* One measured run                                                            */
/* -------------------------------------------------------------------------- */

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-gl=swiftshader'] });

const run = async (label, url, seconds, holdKeys = [], options = {}) => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('GL Driver') && !/status of \d/.test(t)) errors.push(t.slice(0, 120));
  });

  /* A three-minute match is a PLAYER configuration, not a test seam: the harness
     writes the same localStorage key the Options screen writes, which works in
     every build — including the production one, where `?sessionSeconds=` no
     longer exists. */
  if (options.playerOptions !== undefined) {
    await page.addInitScript((stored) => {
      try {
        localStorage.setItem('pb.options.v1', JSON.stringify(stored));
      } catch {
        /* private mode: the default configuration is used instead */
      }
    }, options.playerOptions);
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('play-button').click();
  await page.getByTestId('hud').waitFor({ timeout: 40000 });

  // Let the first frames settle: shader compilation and texture upload are
  // one-off costs that would otherwise dominate the window.
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__pbProfile?.reset());

  /* rAF deltas: frame-to-frame wall time, collected by the page itself so it
     works with or without the profiler. The first few are dropped as warm-up. */
  await page.evaluate(() => {
    const state = { deltas: [], last: performance.now(), handle: 0 };
    const tick = (now) => {
      state.deltas.push(now - state.last);
      state.last = now;
      state.handle = requestAnimationFrame(tick);
    };
    state.handle = requestAnimationFrame(tick);
    window.__pbRaf = state;
  });

  for (const key of holdKeys) await page.keyboard.down(key);
  const deadline = Date.now() + seconds * 1000;
  let nextFire = Date.now() + (options.fireEveryMs ?? Number.POSITIVE_INFINITY);

  while (Date.now() < deadline) {
    if ((await page.getByTestId('result-screen').count()) === 1) break;
    await page.waitForTimeout(250);
    if (Date.now() >= nextFire) {
      await page.keyboard.press('Space');
      nextFire = Date.now() + options.fireEveryMs;
    }
  }
  for (const key of holdKeys) await page.keyboard.up(key);

  const summary = await page.evaluate(() => window.__pbProfile?.summary() ?? null);
  const raf = await page.evaluate(() => {
    const state = window.__pbRaf;
    cancelAnimationFrame(state.handle);
    const deltas = state.deltas.slice(5).sort((a, b) => a - b);
    const total = deltas.reduce((sum, value) => sum + value, 0);
    const at = (p) =>
      deltas.length === 0
        ? Number.NaN
        : deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))];
    return {
      frames: deltas.length,
      seconds: total / 1000,
      fps: total === 0 ? 0 : deltas.length / (total / 1000),
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  });

  const onResult = (await page.getByTestId('result-screen').count()) === 1;
  const heap = await page.evaluate(() => (performance.memory?.usedJSHeapSize ?? 0) / 1048576);
  const nodes = await page.evaluate(() => document.querySelectorAll('canvas').length);

  await page.close();

  const row = {
    label,
    frames: raf.frames,
    rafFps: round(raf.fps),
    rafP50: round(raf.p50),
    rafP95: round(raf.p95),
    rafP99: round(raf.p99),
    dropped: summary?.dropped ?? null,
    simP50: summary ? round(summary.simulation.p50Ms) : null,
    simP95: summary ? round(summary.simulation.p95Ms) : null,
    simP99: summary ? round(summary.simulation.p99Ms) : null,
    renderP50: summary ? round(summary.render.p50Ms) : null,
    renderP95: summary ? round(summary.render.p95Ms) : null,
    renderP99: summary ? round(summary.render.p99Ms) : null,
    frameP50: summary ? round(summary.frame.p50Ms) : null,
    frameP95: summary ? round(summary.frame.p95Ms) : null,
    frameP99: summary ? round(summary.frame.p99Ms) : null,
    frameMax: summary ? round(summary.frame.worstMs) : null,
    entities: summary?.entities.current ?? null,
    entitiesPeak: summary?.entities.peak ?? null,
    heapMb: round(heap),
    canvases: nodes,
    ended: onResult,
    errors: errors.length,
  };

  console.log(
    `${row.label.padEnd(26)} raf fps=${String(row.rafFps).padStart(6)}` +
      ` p50/p95/p99=${row.rafP50}/${row.rafP95}/${row.rafP99}` +
      ` | frame cost p50/p95/p99=${fmt(row.frameP50)}/${fmt(row.frameP95)}/${fmt(row.frameP99)}` +
      ` max=${fmt(row.frameMax)}` +
      ` | sim p50/p95/p99=${fmt(row.simP50)}/${fmt(row.simP95)}/${fmt(row.simP99)}` +
      ` | entities=${fmt(row.entities)}/${fmt(row.entitiesPeak)}` +
      ` | heap=${row.heapMb}MB canvases=${row.canvases} errors=${row.errors}`,
  );
  return row;
};

console.log(`=== PERFORMANCE @ ${BASE}${prod ? ' (PRODUCTION build via vite preview)' : ''} ===\n`);
console.log('NOTE: frame CPU cost is the number this project controls. Achieved FPS');
console.log('      here is bounded by software rasterisation in a container with no');
console.log('      GPU, and by nothing in the game. Read them separately.\n');

const rows = [];

// Idle: a ship that never moves, so the numbers reflect the world, not combat.
rows.push(await run('idle', `${BASE}/?profile&sessionSeconds=90`, 12));

// Under load: sailing and firing continuously, which is the real gameplay case.
rows.push(await run('sailing + firing', `${BASE}/?profile&sessionSeconds=90`, 20, ['ArrowUp'], { fireEveryMs: 1200 }));

// The brief's reference scenario: a THREE-MINUTE match, fought.
rows.push(
  await run('3-minute match', `${BASE}/?profile`, 185, ['ArrowUp'], {
    playerOptions: { sessionSeconds: 180, spawnIntervalSeconds: 3 },
    fireEveryMs: 1500,
  }),
);

// Repeated matches: the memory question. Five enter/exit cycles must not grow the
// heap, because the canvas, textures and display list are all released.
const cycles = [];
for (let i = 0; i < 5; i += 1) {
  cycles.push(await run(`cycle ${i + 1}/5`, `${BASE}/?profile&sessionSeconds=60`, 6, ['ArrowUp']));
}

const measured = [...rows, ...cycles].filter(Boolean);
const profiled = measured.filter((row) => row.frameP99 !== null);
const BUDGET_60 = 1000 / 60;

console.log('\n--- headroom (the metric the game actually controls) ---');
for (const row of profiled) {
  const cpuP99 = round(row.simP99 + row.renderP99);
  console.log(
    `${row.label.padEnd(26)} entities peak=${String(row.entitiesPeak).padStart(4)}` +
      `  frame p95=${String(row.frameP95).padStart(5)} ms` +
      `  cpu p99=${String(cpuP99).padStart(5)} ms` +
      `  fits in the 60 fps budget ${round(BUDGET_60 / cpuP99)}x`,
  );
}
if (profiled.length !== measured.length) {
  console.log(
    '(production build: the profiler is compiled out, so CPU cost and entity counts' +
      ' are reported only for the instrumented dev runs — see docs/PERFORMANCE.md §4.)',
  );
}

console.log('\n--- memory across enter/exit cycles ---');
if (cycles.every(Boolean)) {
  const first = cycles[0];
  const last = cycles[cycles.length - 1];
  console.log(`heap after cycle 1: ${first.heapMb} MB   after cycle 5: ${last.heapMb} MB   delta: ${round(last.heapMb - first.heapMb)} MB`);
  console.log(`canvases left mounted: ${last.canvases} (must be 1 in-match)`);
  console.log(`page errors: ${measured.reduce((sum, r) => sum + r.errors, 0)}`);
}

console.log('\n--- worst observed ---');
const worstRaf = measured.reduce((acc, r) => (r.rafP95 > acc.rafP95 ? r : acc), measured[0]);
if (profiled.length > 0) {
  const worst = profiled.reduce((acc, r) => (r.frameP99 > acc.frameP99 ? r : acc), profiled[0]);
  console.log(`worst frame-cost p99: ${worst.frameP99} ms  (${worst.label})`);
  console.log(`worst single frame:   ${worst.frameMax} ms`);
}
console.log(`worst frame-time p95: ${worstRaf.rafP95} ms between frames  (${worstRaf.label})`);
console.log(`60 fps budget:        ${round(BUDGET_60)} ms`);
console.log(`achieved fps here:    ${worstRaf.rafFps} (environment-bound, see note above)`);

await browser.close();
shutdown();
