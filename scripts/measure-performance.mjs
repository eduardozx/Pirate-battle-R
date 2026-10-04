import { chromium } from 'playwright';

/**
 * Performance harness.
 *
 * Plays a real match with `?profile` and reads the profiler's summary from the page.
 * The simulation is seeded, so runs are comparable; only the hardware varies.
 *
 * Usage: node scripts/measure-performance.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:5173';

/** Headless Chromium's rAF is not vsync-locked, so FPS here is an upper bound. */
const VIEWPORT = { width: 1440, height: 900 };

const round = (value) => Math.round(value * 100) / 100;

const browser = await chromium.launch({ args: ['--enable-gpu', '--use-gl=swiftshader'] });

const run = async (label, url, seconds, holdKeys = []) => {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !t.includes('GL Driver') && !/status of \d/.test(t)) errors.push(t.slice(0, 120));
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('play-button').click();
  await page.getByTestId('hud').waitFor({ timeout: 40000 });

  // Let the first frames settle: shader compilation and texture upload are
  // one-off costs that would otherwise dominate the window.
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__pbProfile?.reset());

  for (const key of holdKeys) await page.keyboard.down(key);
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    if ((await page.getByTestId('result-screen').count()) === 1) break;
    await page.waitForTimeout(250);
  }
  for (const key of holdKeys) await page.keyboard.up(key);

  const summary = await page.evaluate(() => window.__pbProfile?.summary() ?? null);
  const onResult = (await page.getByTestId('result-screen').count()) === 1;
  const heap = await page.evaluate(() => (performance.memory?.usedJSHeapSize ?? 0) / 1048576);
  const nodes = await page.evaluate(() => document.querySelectorAll('canvas').length);

  await page.close();

  if (summary === null) {
    console.log(`${label.padEnd(26)} PROFILER UNAVAILABLE (is this a dev build?)`);
    return null;
  }

  const row = {
    label,
    fps: round(summary.fps),
    frames: summary.frames,
    dropped: summary.dropped,
    simP50: round(summary.simulation.p50Ms),
    simP95: round(summary.simulation.p95Ms),
    simP99: round(summary.simulation.p99Ms),
    renderP50: round(summary.render.p50Ms),
    renderP95: round(summary.render.p95Ms),
    renderP99: round(summary.render.p99Ms),
    frameP50: round(summary.frame.p50Ms),
    frameP95: round(summary.frame.p95Ms),
    frameP99: round(summary.frame.p99Ms),
    frameMax: round(summary.frame.worstMs),
    entities: summary.entities.current,
    entitiesPeak: summary.entities.peak,
    heapMb: round(heap),
    canvases: nodes,
    ended: onResult,
    errors: errors.length,
  };

  console.log(
    `${row.label.padEnd(26)} fps=${String(row.fps).padStart(6)}` +
    ` dropped=${String(row.dropped).padStart(3)}` +
    ` sim p50/p95/p99=${row.simP50}/${row.simP95}/${row.simP99}` +
    ` render p50/p95/p99=${row.renderP50}/${row.renderP95}/${row.renderP99}` +
    ` frame p99=${row.frameP99} max=${row.frameMax}` +
    ` entities=${row.entities}/${row.entitiesPeak}` +
    ` heap=${row.heapMb}MB canvases=${row.canvases} errors=${row.errors}`,
  );
  return row;
};

console.log(`=== PERFORMANCE @ ${BASE} (headless Chromium / SwiftShader) ===\n`);
console.log('NOTE: frame CPU cost is the number this project controls. Achieved FPS');
console.log('      here is bounded by software rasterisation in a container with no');
console.log('      GPU, and by nothing in the game. Read them separately.\n');

const rows = [];

// Idle: a ship that never moves, so the numbers reflect the world, not combat.
rows.push(await run('idle', `${BASE}/?profile&sessionSeconds=90`, 12));

// Under load: sailing and firing continuously, which is the real gameplay case.
rows.push(await run('sailing + firing', `${BASE}/?profile&sessionSeconds=90`, 20, ['ArrowUp']));

// A full-length match, to confirm the tail does not decay as the world fills up.
rows.push(await run('full match', `${BASE}/?profile&sessionSeconds=60`, 65, ['ArrowUp']));

// Repeated matches: the memory question. Five enter/exit cycles must not grow the
// heap, because the canvas, textures and display list are all released.
const cycles = [];
for (let i = 0; i < 5; i += 1) {
  cycles.push(await run(`cycle ${i + 1}/5`, `${BASE}/?profile&sessionSeconds=60`, 6, ['ArrowUp']));
}

const measured = [...rows, ...cycles].filter(Boolean);
const BUDGET_60 = 1000 / 60;

console.log('\n--- headroom (the metric the game actually controls) ---');
for (const row of measured) {
  const cpuP99 = round(row.simP99 + row.renderP99);
  console.log(
    `${row.label.padEnd(26)} entities peak=${String(row.entitiesPeak).padStart(4)}` +
    `  cpu p99=${String(cpuP99).padStart(5)} ms` +
    `  fits in the 60 fps budget ${round(BUDGET_60 / cpuP99)}x`,
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
const worst = measured.reduce((acc, r) => (r.frameP99 > acc.frameP99 ? r : acc));
console.log(`worst frame p99:   ${worst.frameP99} ms  (${worst.label})`);
console.log(`worst single frame: ${worst.frameMax} ms`);
console.log(`60 fps budget:      ${round(BUDGET_60)} ms`);
console.log(`achieved fps here:  ${worst.fps} (environment-bound, see note above)`);

await browser.close();