// Validates the generated style against the MapLibre style specification.
// Run: node scripts/validate-style.mjs
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { CONFIG } from '../web/config.js';
import { buildStyle } from '../web/style.js';

let failed = false;

for (const withTerrain of [true, false]) {
  const style = buildStyle(CONFIG, 'http://localhost:8080/fonts/{fontstack}/{range}.pbf', { withTerrain });
  const errors = validateStyleMin(style);
  const label = withTerrain ? 'with terrain' : 'without terrain (fallback)';
  if (errors.length) {
    failed = true;
    console.error(`FAIL  ${label}: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  ${e.message}`);
  } else {
    console.log(`PASS  ${label}: ${style.layers.length} layers, ${Object.keys(style.sources).length} source(s)`);
  }
}

process.exit(failed ? 1 : 0);
