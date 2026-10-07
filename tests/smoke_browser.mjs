// Loads the real page in a real browser and checks that the map actually
// renders: no console errors, terrain active, 3D buildings extruded, labels
// placed. Optional -- it needs Playwright, which is not a dependency of this
// project. Install it anywhere and point the script at it:
//
//   npm i -D playwright && npx playwright install chromium
//   node tests/smoke_browser.mjs http://127.0.0.1:8080 [outDir]
//
// Env:
//   PLAYWRIGHT_MODULE  path to the playwright module (default: resolve normally)
//   CHROME_PATH        browser executable to use instead of Playwright's own
//   SMOKE_ZOOM         after load, jump to this zoom (buildings need >= 13)
//   SMOKE_CENTER       "lng,lat" to jump to, for a known-built-up spot

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const baseUrl = process.argv[2] || 'http://127.0.0.1:8080';
const outDir = process.argv[3] || 'tests/screenshots';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('skip: Playwright is not installed. See the header of this file.');
  process.exit(77); // conventional "skipped"
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    // Headless needs a software GL stack for MapLibre's WebGL context.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('requestfailed', (r) => {
  // ERR_ABORTED is the client cancelling, not the resource failing: pmtiles
  // coalesces concurrent range requests and drops the duplicates, and any
  // in-flight fetch aborts when the page closes. Genuine problems still show
  // up as 4xx/5xx in the response handler below, or as other error texts.
  const err = r.failure()?.errorText || '';
  if (err.includes('ABORTED')) return;
  failedRequests.push(`${r.url()} ${err}`);
});
page.on('response', (r) => {
  if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
});

await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

// The page exposes the map as window.__map once app.js has constructed it.
await page.waitForFunction('window.__map !== undefined', null, { timeout: 30000 });
await page.waitForFunction('window.__map.isStyleLoaded()', null, { timeout: 60000 });
await page.waitForFunction('window.__map.areTilesLoaded()', null, { timeout: 60000 }).catch(() => {});
// The initial camera comes from the PMTiles header. For the building check we
// may need to be closer in than that, at a spot that actually has buildings.
if (process.env.SMOKE_ZOOM || process.env.SMOKE_CENTER) {
  const zoom = process.env.SMOKE_ZOOM ? Number(process.env.SMOKE_ZOOM) : null;
  const center = process.env.SMOKE_CENTER ? process.env.SMOKE_CENTER.split(',').map(Number) : null;
  await page.evaluate(
    ({ zoom, center }) => window.__map.jumpTo({ ...(zoom ? { zoom } : {}), ...(center ? { center } : {}) }),
    { zoom, center },
  );
  await page.waitForFunction('window.__map.areTilesLoaded()', null, { timeout: 60000 }).catch(() => {});
}

await page.waitForTimeout(3000); // let labels and extrusions settle

const info = await page.evaluate(() => {
  const m = window.__map;
  const layers = m.getStyle().layers.map((l) => l.id);
  const counted = (ids) =>
    Object.fromEntries(
      ids.map((id) => [id, m.getLayer(id) ? m.queryRenderedFeatures({ layers: [id] }).length : -1]),
    );
  const canvas = m.getCanvas();
  return {
    glContext: !!canvas.getContext('webgl2') || !!canvas.getContext('webgl'),
    layerCount: layers.length,
    hasBuildingLayer: layers.includes('building-3d'),
    buildingMinzoom: m.getLayer('building-3d') ? m.getLayer('building-3d').minzoom : null,
    terrain: m.getTerrain(),
    pitch: m.getPitch(),
    bearing: m.getBearing(),
    zoom: m.getZoom(),
    center: m.getCenter().toArray(),
    fatalVisible: !document.getElementById('fatal').hidden,
    fatalText: document.getElementById('fatal-body').innerText.slice(0, 300),
    status: document.getElementById('status').innerText,
    counts: counted([
      'building-3d', 'road-fill', 'water', 'label-place-town',
      'label-road', 'label-place-other', 'hillshade',
    ]),
    sky: m.getSky ? m.getSky() : null,
  };
});

check(info.glContext, 'the map has a live WebGL context');
check(!info.fatalVisible, 'no missing-data banner', info.fatalVisible ? info.fatalText : '');
check(info.layerCount > 20, 'the style loaded its layers', `${info.layerCount} layers`);
check(info.hasBuildingLayer, 'the building-3d layer exists');
check(info.terrain != null, '3D terrain is active', JSON.stringify(info.terrain));
check(info.pitch > 10, 'the camera is tilted', `${info.pitch.toFixed(1)}°`);
// Buildings only exist above their minzoom, so only assert them when the
// camera is actually close enough — otherwise this reports a styling choice
// as a failure. Use SMOKE_ZOOM to force a closer view.
const buildingMinzoom = info.buildingMinzoom ?? 13;
if (info.zoom >= buildingMinzoom) {
  check(info.counts['building-3d'] > 0, '3D buildings render features', `${info.counts['building-3d']}`);
} else {
  console.log(
    `SKIP  3D buildings render features — camera is at z${info.zoom.toFixed(1)}, ` +
    `below the layer's minzoom ${buildingMinzoom}`,
  );
}
check(info.counts['road-fill'] > 0, 'roads render features', `${info.counts['road-fill']}`);
const labels =
  Math.max(0, info.counts['label-place-town']) +
  Math.max(0, info.counts['label-road']) +
  Math.max(0, info.counts['label-place-other']);
check(labels > 0, 'text labels are placed', `${labels} label features`);

// Glyph PBFs must be served locally and must not 404.
const glyph404 = failedRequests.filter((r) => r.includes('/fonts/'));
check(glyph404.length === 0, 'no glyph request failed', glyph404.slice(0, 3).join(' | '));

check(pageErrors.length === 0, 'no uncaught JavaScript errors', pageErrors.slice(0, 3).join(' | '));
check(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 5).join(' | '));
const otherFailures = failedRequests.filter((r) => !r.includes('/fonts/'));
check(otherFailures.length === 0, 'no failed network requests', otherFailures.slice(0, 5).join(' | '));

// Screenshots: tilted with terrain, and flat from above.
await page.screenshot({ path: `${outDir}/tilted.png` });
await page.evaluate(() => window.__map.easeTo({ pitch: 0, bearing: 0, duration: 0 }));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${outDir}/flat.png` });
await page.evaluate(() => {
  document.getElementById('t-buildings').click();
  document.getElementById('t-terrain').click();
});
await page.waitForTimeout(1500);
const afterToggle = await page.evaluate(() => ({
  terrain: window.__map.getTerrain(),
  buildings: window.__map.getLayoutProperty('building-3d', 'visibility'),
}));
check(afterToggle.terrain === null || afterToggle.terrain === undefined, 'the terrain toggle turns terrain off');
check(afterToggle.buildings === 'none', 'the buildings toggle hides the extrusions');
await page.screenshot({ path: `${outDir}/toggled-off.png` });

console.log(`\nstatus line: ${info.status}`);
console.log(`centre ${info.center.map((v) => v.toFixed(4)).join(', ')} @ z${info.zoom.toFixed(2)}`);
console.log(`screenshots in ${outDir}/`);

await browser.close();
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all browser checks passed'}`);
process.exit(failures ? 1 : 0);
