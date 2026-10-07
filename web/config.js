// Single place for everything deployment-specific.
// Changing the mapped area means editing AREA/BOUNDS here and re-running the
// two build scripts (see README). Nothing else in web/ hardcodes a location.

export const CONFIG = {
  // Human-readable name of the mapped area, shown in the UI.
  area: 'India',

  // west, south, east, north — must match what the build scripts were run with.
  bounds: [68.0, 6.0, 97.5, 37.5],

  // Terrain covers a smaller area than the vector tiles (see README): building
  // India-wide elevation at this detail would run to tens of gigabytes. Outside
  // this box the map still works, it just renders flat when tilted.
  terrainBounds: [68.0, 6.0, 97.5, 37.5],

  // The Geofabrik extract the vector build downloads (NOT the display name
  // above): 'india', 'monaco', 'europe/monaco', … Used only to print a
  // correct, copy-pasteable command when a data file is missing.
  osmArea: 'india',

  // Local data files. Relative to web/, served by scripts/serve.py.
  data: {
    vector: 'data/map.pmtiles',
    terrain: 'data/terrain.pmtiles',
    // Optional global context for low zooms: coastlines, boundaries, water
    // and landcover for the whole planet, from Natural Earth plus the global
    // OSM water polygons. 21 MB, because it needs almost no OSM data.
    // Required by the globe: without it the sphere is blank except for
    // India. Rebuild with:
    //
    //   AREA=monaco BOUNDS="-180,-85,180,85" MAXZOOM=8 \
    //     OUTPUT=web/data/world.pmtiles ./scripts/build-map.sh
    //
    // Set to null to drop it (and the globe becomes an empty ball).
    //
    // Note it carries no place names: the OpenMapTiles `place` layer comes
    // from OSM, so global labels need the 95 GB planet extract. Generate them
    // from Natural Earth instead with scripts/make_world_labels.py.
    world: 'data/world.pmtiles',
    // Country and major-city labels for the globe, from Natural Earth
    // (public domain). The world archive's own `place` layer is unusable:
    // OpenMapTiles fills it from OSM, and the world archive is built from a
    // stub extract, so it contains exactly one country — Monaco.
    // Regenerate with: python3 scripts/make_world_labels.py
    worldLabels: 'data/world-labels.geojson',
  },

  // Zoom at which the detailed archive takes over from the world context.
  // The world archive is built to z8; detail layers are drawn on top of it.
  worldMaxzoom: 8,

  // Glyph PBFs are self-hosted. MapLibre requires an absolute URL here, so it
  // is resolved against the page origin at load time (see style.js).
  glyphsPath: 'fonts/{fontstack}/{range}.pbf',

  // Initial camera. center/zoom are overridden by the PMTiles header when the
  // archive carries a usable center; pitch/bearing always come from here.
  // Globe below this zoom, Mercator above it, interpolated in between.
  // Mercator is what you want for a city: the globe's curvature fights the
  // 3D terrain and buildings once you are close in. Set `globe: false` to
  // stay on Mercator always; the globe button in the corner still works.
  projection: {
    globe: true,
    globeMaxzoom: 5,
    mercatorMinzoom: 7,
  },

  camera: {
    // The archive now covers all of India, so the header's centre is somewhere
    // in the middle of the country at a zoom with no buildings and no terrain
    // coverage. Open on Pune instead, where both are at their best; set to
    // null to go back to the header, or to [78.9, 22.5] with zoom 4 to open on
    // the whole country.
    center: [73.8567, 18.5204],
    // null => derive from the PMTiles header. The header's centre zoom for a
    // city extract is typically ~11, which is below buildings.minzoom, so the
    // map would open with no 3D buildings in view. 13 is the first zoom that
    // shows the extrusions while still framing the hills on the horizon when
    // tilted; set to null to go back to whatever the archive says.
    zoom: 13,
    pitch: 60,
    bearing: -17.6,
    maxPitch: 85,
  },

  terrain: {
    exaggeration: 1.5,
    exaggerationMax: 4,
    encoding: 'terrarium',
    tileSize: 256,
    // MUST equal the archive's real maxzoom, and the archive must cover the
    // whole area uniformly at it. MapLibre renders the terrain mesh at this
    // zoom and does NOT fall back to a parent tile when one is missing: it
    // renders flat instead. (queryTerrainElevation does fall back, which makes
    // the bug invisible to elevation checks — it has to be seen.)
    // So a mixed-zoom archive leaves holes. 11 is what India has everywhere.
    maxzoom: 11,
    enabledOnLoad: true,
  },

  buildings: {
    enabledOnLoad: true,
    minzoom: 13,
    // height (m) -> colour ramp, interpolated.
    // Warm greys rather than browns: Indian cities are mostly concrete and
    // whitewash, and a saturated ramp turns to mud under low, warm sunlight.
    ramp: [
      [0, '#e6e2da'],
      [10, '#dad5cb'],
      [25, '#cac4b8'],
      [50, '#b8b1a3'],
      [100, '#a79e8e'],
      [200, '#94897a'],
    ],
  },

  hillshade: {
    enabledOnLoad: true,
  },

  // One sun drives building shading AND the hillshade, so the two agree.
  // azimuth:  compass degrees the light comes FROM (0 = north, 90 = east)
  // altitude: degrees above the horizon (低 = long shadows, warm light)
  lighting: {
    azimuth: 135,
    altitude: 45,
    intensity: 0.45,
  },

  attribution: [
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    '<a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>',
    'Terrain: <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">Tilezen Joerd</a> (SRTM / ETOPO1 / NED a.o.)',
  ].join(' | '),
};

export default CONFIG;
