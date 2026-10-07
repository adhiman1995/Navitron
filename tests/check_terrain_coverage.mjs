// Verifies that the terrain archive really has tiles at config.terrain.maxzoom
// across the whole of config.terrainBounds.
//
// This exists because of a bug that two other checks missed. MapLibre renders
// the terrain mesh at the source's maxzoom and does NOT substitute a parent
// tile when one is absent -- it renders flat ground. An archive built coarse
// over a country and fine over one city therefore looks correct in that city
// and goes flat everywhere else the moment you zoom in.
//
// queryTerrainElevation() does fall back to the parent, so sampling elevations
// reports perfectly good heights over the flat area. Only tile presence at the
// declared maxzoom tells the truth.
//
//   node tests/check_terrain_coverage.mjs [gridSize]
//
// Env overrides, so the check itself can be tested against a known-holey
// archive: TERRAIN_ARCHIVE, TERRAIN_BOUNDS ("w,s,e,n"), TERRAIN_MAXZOOM.

import { openSync, readSync, closeSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PMTiles } from '../web/vendor/pmtiles.mjs';
import { CONFIG } from '../web/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const grid = Number(process.argv[2] || 6);

const archivePath = process.env.TERRAIN_ARCHIVE
  ? resolve(process.env.TERRAIN_ARCHIVE)
  : resolve(root, 'web', CONFIG.data.terrain);
if (!existsSync(archivePath)) {
  console.log(`SKIP  ${CONFIG.data.terrain} has not been built yet`);
  process.exit(0);
}

// Range-reading Source so we never load a multi-gigabyte archive into memory.
const fd = openSync(archivePath, 'r');
const source = {
  getKey: () => archivePath,
  getBytes: async (offset, length) => {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  },
};

const lonToX = (lon, z) => Math.floor(((lon + 180) / 360) * (1 << z));
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * (1 << z));
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const archive = new PMTiles(source);
const header = await archive.getHeader();
const want = process.env.TERRAIN_MAXZOOM ? Number(process.env.TERRAIN_MAXZOOM) : CONFIG.terrain.maxzoom;
const box = process.env.TERRAIN_BOUNDS
  ? process.env.TERRAIN_BOUNDS.split(',').map(Number)
  : (CONFIG.terrainBounds || CONFIG.bounds);

console.log(`archive ${archivePath.replace(root + '/', '')}  (${(statSync(archivePath).size / 1e6).toFixed(0)} MB)`);
console.log(`header zooms ${header.minZoom}-${header.maxZoom}, config terrain.maxzoom ${want}\n`);

check(want <= header.maxZoom, 'config.terrain.maxzoom is within the archive',
  `config ${want} vs archive ${header.maxZoom}`);

// Sample a grid across the declared terrain area at the declared maxzoom.
const [w, s, e, n] = box;
const missing = [];
let probed = 0;
for (let i = 0; i <= grid; i++) {
  for (let j = 0; j <= grid; j++) {
    const lon = w + ((e - w) * i) / grid;
    const lat = s + ((n - s) * j) / grid;
    const x = lonToX(lon, want);
    const y = latToY(lat, want);
    probed++;
    const t = await archive.getZxy(want, x, y);
    if (!t || !t.data) missing.push(`${want}/${x}/${y} (${lon.toFixed(2)},${lat.toFixed(2)})`);
  }
}
check(missing.length === 0,
  `every sampled point has a z${want} tile`,
  missing.length ? `${missing.length}/${probed} missing, e.g. ${missing.slice(0, 3).join('; ')}` : `${probed} points`);

if (missing.length) {
  console.log('\n  The map will render FLAT terrain at these locations above');
  console.log(`  zoom ${want}. Either rebuild the archive uniformly at z${want},`);
  console.log('  or lower config.terrain.maxzoom to the zoom the archive has everywhere.');
}

closeSync(fd);
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'terrain coverage is uniform'}`);
process.exit(failures ? 1 : 0);
