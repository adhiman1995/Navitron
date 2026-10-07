// Wires the style module to the map, the PMTiles protocol and the UI controls.
// All DOM work lives here; style.js and config.js stay presentation-only data.

// MapLibre GL JS 6's ESM bundle has named exports only — there is no default.
import * as maplibregl from './vendor/maplibre-gl.mjs';
import { Protocol, PMTiles } from './vendor/pmtiles.mjs';
import { CONFIG } from './config.js';
import { buildStyle, sunLight, SOURCE_IDS } from './style.js';

const $ = (id) => document.getElementById(id);
const abs = (path) => new URL(path, window.location.href).href;

// MapLibre needs an ABSOLUTE glyphs url, but it also needs the literal
// {fontstack} and {range} tokens — and new URL() percent-encodes the braces.
// So resolve only the directory part and append the template untouched.
function absTemplate(path) {
  const i = path.indexOf('{');
  if (i < 0) return abs(path);
  return abs(path.slice(0, i)) + path.slice(i);
}

// Commands quoted verbatim in the "missing data" banner.
const BUILD_COMMANDS = {
  [CONFIG.data.vector]: './scripts/build-map.sh',
  [CONFIG.data.terrain]: 'python3 scripts/build_terrain.py',
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Writes into #fatal-body so the dismiss button survives.
function fatal(title, lines) {
  $('fatal-body').innerHTML =
    `<h2>${esc(title)}</h2>` +
    lines.map((l) => (l.cmd ? `<pre>${esc(l.cmd)}</pre>` : `<p>${esc(l.text)}</p>`)).join('');
  $('fatal').hidden = false;
}

/** HEAD each data file; returns the paths that are missing or unreadable. */
async function findMissing(paths) {
  const missing = [];
  await Promise.all(
    paths.map(async (p) => {
      try {
        const r = await fetch(abs(p), { method: 'HEAD', cache: 'no-store' });
        if (!r.ok) missing.push(p);
      } catch {
        missing.push(p);
      }
    }),
  );
  return missing;
}

async function main() {
  const status = $('status');
  status.textContent = 'Checking local data…';

  const required = [CONFIG.data.vector];
  const optional = [CONFIG.data.terrain, CONFIG.data.world, CONFIG.data.worldLabels].filter(Boolean);
  const missing = await findMissing([...required, ...optional]);

  if (missing.includes(CONFIG.data.vector)) {
    fatal('Vector tiles are missing', [
      { text: `web/${CONFIG.data.vector} was not found. Build it with:` },
      { cmd: `AREA="${CONFIG.osmArea}" BOUNDS="${CONFIG.bounds.join(',')}" ${BUILD_COMMANDS[CONFIG.data.vector]}` },
      { text: 'Then reload this page.' },
    ]);
    status.textContent = 'No map data.';
    return;
  }

  const haveTerrain = !missing.includes(CONFIG.data.terrain);
  // The world context is optional: without it the map is blank outside
  // CONFIG.bounds, which is a degradation, not a failure.
  const haveWorld = !!CONFIG.data.world && !missing.includes(CONFIG.data.world);
  if (CONFIG.data.worldLabels && missing.includes(CONFIG.data.worldLabels)) {
    CONFIG.data.worldLabels = null; // globe keeps working, just unlabelled
  }
  if (!haveTerrain) {
    fatal('Terrain is missing — showing a flat map', [
      { text: `web/${CONFIG.data.terrain} was not found. 3D terrain and hillshade are disabled. Build it with:` },
      { cmd: `${BUILD_COMMANDS[CONFIG.data.terrain]} --bounds "${(CONFIG.terrainBounds || CONFIG.bounds).join(',')}"` },
    ]);
  }

  // One PMTiles instance per archive, shared with the protocol handler so the
  // header read below does not cost an extra range request.
  const protocol = new Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const vector = new PMTiles(abs(CONFIG.data.vector));
  protocol.add(vector);
  if (haveWorld) protocol.add(new PMTiles(abs(CONFIG.data.world)));
  let terrainArchive = null;
  if (haveTerrain) {
    terrainArchive = new PMTiles(abs(CONFIG.data.terrain));
    protocol.add(terrainArchive);
  }

  // Initial camera from the archive header, unless config pins it.
  let header;
  try {
    header = await vector.getHeader();
  } catch (err) {
    fatal('Could not read the PMTiles header', [
      { text: `${CONFIG.data.vector} is not a readable PMTiles archive (${err.message}).` },
      { text: 'The server must support HTTP Range requests — use scripts/serve.py, not a plain static server.' },
    ]);
    status.textContent = 'Unreadable archive.';
    return;
  }

  const center = CONFIG.camera.center ?? [header.centerLon, header.centerLat];
  const zoom = CONFIG.camera.zoom ?? Math.max(header.centerZoom || 0, header.minZoom || 0);

  if (haveTerrain) {
    try {
      // Never ask the DEM source for zooms the archive does not contain.
      const th = await terrainArchive.getHeader();
      CONFIG.terrain.maxzoom = Math.min(CONFIG.terrain.maxzoom, th.maxZoom);
    } catch {
      /* fall back to the configured maxzoom */
    }
  }

  const style = buildStyle(CONFIG, absTemplate(CONFIG.glyphsPath), {
    withTerrain: haveTerrain,
    withWorld: haveWorld,
  });

  const map = new maplibregl.Map({
    container: 'map',
    style,
    center,
    zoom,
    pitch: CONFIG.camera.pitch,
    bearing: CONFIG.camera.bearing,
    maxPitch: CONFIG.camera.maxPitch,
    attributionControl: false,
    hash: true,
  });
  window.__map = map; // handy from the console

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: CONFIG.attribution }), 'bottom-right');
  map.addControl(new maplibregl.GlobeControl(), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');

  map.on('error', (e) => {
    // Tile 404s inside the archive bounds are normal; log the rest.
    if (e && e.error) console.warn('[map]', e.error.message || e.error);
  });

  const setTerrain = (on) => {
    if (!haveTerrain) return;
    map.setTerrain(on ? { source: SOURCE_IDS.terrain, exaggeration: Number($('exag').value) } : null);
  };

  map.on('load', () => {
    status.textContent = `${CONFIG.area} · z${map.getZoom().toFixed(1)}`;

    // --- toggles -----------------------------------------------------------
    const terrainBox = $('t-terrain');
    const buildingsBox = $('t-buildings');
    const hillshadeBox = $('t-hillshade');
    const exag = $('exag');
    const exagOut = $('exag-val');

    terrainBox.disabled = !haveTerrain;
    hillshadeBox.disabled = !haveTerrain;
    exag.disabled = !haveTerrain;
    exag.max = String(CONFIG.terrain.exaggerationMax);
    exag.value = String(CONFIG.terrain.exaggeration);
    exagOut.textContent = `${Number(exag.value).toFixed(1)}×`;

    terrainBox.checked = haveTerrain && CONFIG.terrain.enabledOnLoad;
    buildingsBox.checked = CONFIG.buildings.enabledOnLoad;
    hillshadeBox.checked = haveTerrain && CONFIG.hillshade.enabledOnLoad;

    setTerrain(terrainBox.checked);
    map.setLayoutProperty('building-3d', 'visibility', buildingsBox.checked ? 'visible' : 'none');
    if (haveTerrain) {
      map.setLayoutProperty('hillshade', 'visibility', hillshadeBox.checked ? 'visible' : 'none');
    }

    terrainBox.addEventListener('change', () => setTerrain(terrainBox.checked));
    buildingsBox.addEventListener('change', () =>
      map.setLayoutProperty('building-3d', 'visibility', buildingsBox.checked ? 'visible' : 'none'),
    );
    hillshadeBox.addEventListener('change', () =>
      map.setLayoutProperty('hillshade', 'visibility', hillshadeBox.checked ? 'visible' : 'none'),
    );
    exag.addEventListener('input', () => {
      exagOut.textContent = `${Number(exag.value).toFixed(1)}×`;
      if (terrainBox.checked) setTerrain(true);
    });

    // --- sun ---------------------------------------------------------------
    const sunAz = $('sun-az');
    const sunAlt = $('sun-alt');
    const sunAzOut = $('sun-az-val');
    const sunAltOut = $('sun-alt-val');
    sunAz.value = String(CONFIG.lighting.azimuth);
    sunAlt.value = String(CONFIG.lighting.altitude);

    const applySun = () => {
      const azimuth = Number(sunAz.value);
      const altitude = Number(sunAlt.value);
      sunAzOut.textContent = `${azimuth}°`;
      sunAltOut.textContent = `${altitude}°`;
      map.setLight(sunLight({ ...CONFIG.lighting, azimuth, altitude }));
      if (haveTerrain && map.getLayer('hillshade')) {
        map.setPaintProperty('hillshade', 'hillshade-illumination-direction', azimuth);
        map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', altitude);
      }
    };
    applySun();
    sunAz.addEventListener('input', applySun);
    sunAlt.addEventListener('input', applySun);

    // --- camera buttons ----------------------------------------------------
    $('c-pitch').addEventListener('click', () =>
      map.easeTo({ pitch: map.getPitch() > 10 ? 0 : CONFIG.camera.pitch, duration: 600 }),
    );
    $('c-north').addEventListener('click', () => map.easeTo({ bearing: 0, duration: 600 }));
    $('c-spin').addEventListener('click', () => map.easeTo({ bearing: map.getBearing() + 90, duration: 900 }));
    $('c-home').addEventListener('click', () =>
      map.easeTo({ center, zoom, pitch: CONFIG.camera.pitch, bearing: CONFIG.camera.bearing, duration: 900 }),
    );
  });

  // Terrain may cover less ground than the vector tiles. Say so rather than
  // letting a flat tilted view look like a bug.
  const inTerrain = (lngLat) => {
    const b = CONFIG.terrainBounds;
    if (!b) return true;
    return lngLat.lng >= b[0] && lngLat.lng <= b[2] && lngLat.lat >= b[1] && lngLat.lat <= b[3];
  };

  map.on('moveend', () => {
    const outside = haveTerrain && !inTerrain(map.getCenter());
    status.textContent =
      `${CONFIG.area} · z${map.getZoom().toFixed(1)} · ` +
      `pitch ${map.getPitch().toFixed(0)}° · bearing ${map.getBearing().toFixed(0)}°` +
      (outside ? ' · no terrain here' : '');
  });

  $('fatal-close')?.addEventListener('click', () => { $('fatal').hidden = true; });
}

main().catch((err) => {
  console.error(err);
  fatal('Startup failed', [{ text: String(err && err.message ? err.message : err) }]);
});
