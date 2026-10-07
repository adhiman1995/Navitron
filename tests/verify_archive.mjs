// Reads a terrain.pmtiles archive back with the browser pmtiles library (over
// HTTP, through scripts/serve.py, so Range support is exercised too) and
// checks every tile byte-for-byte against the source PNGs on disk.
//
//   node tests/verify_archive.mjs <baseUrl> <archivePathOnServer> <sourceDir>
//   node tests/verify_archive.mjs http://127.0.0.1:8099 terrain-test.pmtiles /tmp/dem

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PMTiles, TileType, Compression, tileIdToZxy } from '../web/vendor/pmtiles.mjs';

const [baseUrl, archivePath, sourceDir] = process.argv.slice(2);
if (!baseUrl || !archivePath || !sourceDir) {
  console.error('usage: node tests/verify_archive.mjs <baseUrl> <archivePath> <sourceDir>');
  process.exit(64);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const url = new URL(archivePath, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').href;
const archive = new PMTiles(url);

const header = await archive.getHeader();
check(header.tileType === TileType.Png, 'tile_type is PNG', `got ${header.tileType}`);
check(header.tileCompression === Compression.None, 'tile_compression is None', `got ${header.tileCompression}`);
check(header.minZoom === 0, 'min_zoom', `${header.minZoom}`);
check(header.maxZoom >= 1, 'max_zoom', `${header.maxZoom}`);
check(
  Number.isFinite(header.centerLon) && Number.isFinite(header.centerLat),
  'header carries a usable centre',
  `${header.centerLon?.toFixed(4)}, ${header.centerLat?.toFixed(4)}`,
);
check(
  header.minLon < header.maxLon && header.minLat < header.maxLat,
  'header bounds are ordered',
  `${header.minLon},${header.minLat},${header.maxLon},${header.maxLat}`,
);

const metadata = await archive.getMetadata();
check(metadata.encoding === 'terrarium', 'metadata.encoding === "terrarium"', String(metadata.encoding));
check(typeof metadata.attribution === 'string' && metadata.attribution.length > 0, 'metadata carries attribution');

// Walk every tile the source directory has and compare it with the archive.
let compared = 0;
let mismatched = 0;
for (let z = header.minZoom; z <= header.maxZoom; z++) {
  const n = 1 << z;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const src = join(sourceDir, String(z), String(x), `${y}.png`);
      if (!existsSync(src)) continue;
      const expected = readFileSync(src);
      const got = await archive.getZxy(z, x, y);
      if (!got || !got.data) {
        console.log(`      missing from archive: ${z}/${x}/${y}`);
        mismatched++;
        continue;
      }
      const actual = Buffer.from(got.data);
      compared++;
      if (sha(actual) !== sha(expected)) {
        console.log(`      byte mismatch at ${z}/${x}/${y} (${actual.length} vs ${expected.length} bytes)`);
        mismatched++;
      }
    }
  }
}
check(compared > 0, 'tiles were found to compare', `${compared} tile(s)`);
check(mismatched === 0, 'every tile matches the source byte-for-byte', `${compared} compared, ${mismatched} bad`);

// A tile that was never written must read back as absent, not as garbage.
const absent = await archive.getZxy(header.maxZoom, 0, 0);
check(absent === undefined || absent === null || !absent.data, 'an unwritten tile reads back as absent');

// tileIdToZxy round-trip, i.e. the ordering the writer relies on.
const rt = tileIdToZxy(0);
check(rt[0] === 0 && rt[1] === 0 && rt[2] === 0, 'tile id 0 maps to 0/0/0');

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
