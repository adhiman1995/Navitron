// Builds the MapLibre style object for the OpenMapTiles schema.
// Pure data: this module must never touch the DOM or the map instance.
// There is no sprite in this stack, so every label layer is text-only.

const VECTOR_SOURCE = 'openmaptiles';
const WORLD_SOURCE = 'world';
const WORLD_LABEL_SOURCE = 'world-labels';
const TERRAIN_SOURCE = 'terrain-dem';
// MapLibre warns when one raster-dem source feeds both 3D terrain and a
// hillshade layer, because the two want different overzoom behaviour. Declaring
// a second source over the same archive costs nothing extra to build or deploy.
const HILLSHADE_SOURCE = 'hillshade-dem';

const REGULAR = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];
const ITALIC = ['Noto Sans Italic'];

// Prefer the localised name, fall back to the generic one.
const NAME_FIELD = ['coalesce', ['get', 'name:latin'], ['get', 'name'], ''];

const C = {
  background: '#eceae3',
  water: '#a5c9e2',
  waterDeep: '#8fb8d6',
  grass: '#d6e3c4',
  wood: '#c6d9b3',
  scrub: '#dbe3c8',
  sand: '#eee3c6',
  ice: '#f4f8fb',
  residential: '#e6e2d8',
  industrial: '#e3ded4',
  hospital: '#f0e0e0',
  school: '#ece4d4',
  park: '#cfe3bd',
  cemetery: '#d4ddc4',
  roadFill: '#ffffff',
  roadCasing: '#ccc6b8',
  motorway: '#f6c98b',
  motorwayCasing: '#d8a257',
  trunk: '#f8dba6',
  primary: '#fbe9bf',
  rail: '#b8b2a6',
  apron: '#e4e0d7',
  taxiway: '#d9d5cb',
  runway: '#c3bdb1',
  runwayLine: '#f4f1ea',
  boundary: '#9b94a8',
  text: '#3b3a36',
  textHalo: '#ffffff',
  waterText: '#386a8c',
  peakText: '#6b5a3e',
};

// Sunlight warms as it drops towards the horizon.
function sunColour(altitude) {
  const t = Math.max(0, Math.min(1, altitude / 45));
  const mix = (low, high) => Math.round(low + (high - low) * t);
  return `rgb(${mix(255, 255)}, ${mix(201, 246)}, ${mix(150, 238)})`;
}

/**
 * The style's root `light`, derived from a sun position.
 * MapLibre takes [radial, azimuthal, polar]; polar is measured from straight
 * up, so a sun 45 deg above the horizon is a polar angle of 45.
 */
export function sunLight(lighting = {}) {
  const { azimuth = 135, altitude = 45, intensity = 0.45 } = lighting;
  // A low sun leaves most faces pointing away from it, and at full intensity
  // the whole city goes muddy. Ease the directional term off as the sun drops,
  // the way ambient skylight fills shadows in the real world.
  const fill = 0.45 + 0.55 * Math.min(1, Math.max(0, altitude / 45));
  return {
    anchor: 'map',
    position: [1.3, azimuth, Math.max(0, Math.min(90, 90 - altitude))],
    color: sunColour(altitude),
    intensity: Number((intensity * fill).toFixed(3)),
  };
}

// height (m) -> colour, as a MapLibre interpolate expression
function heightRamp(ramp) {
  const stops = [];
  for (const [h, colour] of ramp) stops.push(h, colour);
  return [
    'interpolate',
    ['linear'],
    ['coalesce', ['get', 'render_height'], ['get', 'height'], 0],
    ...stops,
  ];
}

/**
 * Global context drawn beneath the detailed layers: coastlines, boundaries,
 * landcover and place labels for the whole planet, from a small Natural Earth
 * + water-polygon archive. Without it the map is blank outside `cfg.bounds`.
 *
 * The fills stop where the detail archive starts, and the labels stop two
 * zooms earlier so they do not compete with the detailed place labels.
 */
function worldLayers(maxzoom) {
  return [
    {
      id: 'world-landcover',
      type: 'fill',
      source: WORLD_SOURCE,
      'source-layer': 'landcover',
      maxzoom,
      filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest', 'grass', 'farmland']]],
      paint: { 'fill-color': C.wood, 'fill-opacity': 0.45 },
    },
    {
      id: 'world-water',
      type: 'fill',
      source: WORLD_SOURCE,
      'source-layer': 'water',
      maxzoom,
      paint: {
        'fill-color': ['match', ['get', 'class'], 'ocean', C.waterDeep, C.water],
      },
    },
    {
      id: 'world-waterway',
      type: 'line',
      source: WORLD_SOURCE,
      'source-layer': 'waterway',
      minzoom: 4,
      maxzoom,
      paint: {
        'line-color': C.water,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 8, 1.4],
      },
    },
    {
      id: 'world-boundary-country',
      type: 'line',
      source: WORLD_SOURCE,
      'source-layer': 'boundary',
      maxzoom,
      filter: ['<=', ['get', 'admin_level'], 2],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.6],
        'line-dasharray': [4, 1.5],
      },
    },
    {
      id: 'world-boundary-state',
      type: 'line',
      source: WORLD_SOURCE,
      'source-layer': 'boundary',
      minzoom: 3,
      maxzoom,
      filter: ['all', ['>', ['get', 'admin_level'], 2], ['<=', ['get', 'admin_level'], 4]],
      paint: { 'line-color': C.boundary, 'line-width': 0.6, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] },
    },
  ];
}

/**
 * @param {object} cfg          the CONFIG object from config.js
 * @param {string} glyphsUrl    ABSOLUTE url template for the glyph PBFs
 * @param {object} [opts]
 * @param {boolean} [opts.withTerrain]  include the raster-dem source + hillshade
 * @param {boolean} [opts.withWorld]    include the global context archive
 * @returns {object} a MapLibre GL style specification
 */
export function buildStyle(cfg, glyphsUrl, opts = {}) {
  const withTerrain = opts.withTerrain !== false;
  const withWorld = opts.withWorld !== false && !!cfg.data.world;

  const sources = {
    [VECTOR_SOURCE]: {
      type: 'vector',
      url: `pmtiles://${cfg.data.vector}`,
      attribution: cfg.attribution,
    },
  };

  if (withTerrain) {
    const dem = {
      type: 'raster-dem',
      url: `pmtiles://${cfg.data.terrain}`,
      encoding: cfg.terrain.encoding,
      tileSize: cfg.terrain.tileSize,
      maxzoom: cfg.terrain.maxzoom,
      // The archive carries its own attribution string in its metadata; the
      // terrain credit is already in cfg.attribution, so suppress the
      // duplicate rather than printing it twice in the attribution bar.
      attribution: '',
    };
    sources[TERRAIN_SOURCE] = dem;
    sources[HILLSHADE_SOURCE] = { ...dem };
  }

  if (withWorld) {
    sources[WORLD_SOURCE] = {
      type: 'vector',
      url: `pmtiles://${cfg.data.world}`,
      attribution: cfg.attribution,
    };
  }

  const labelMax = Math.max(1, (cfg.worldMaxzoom ?? 8) - 2);
  const withWorldLabels = withWorld && !!cfg.data.worldLabels;
  if (withWorldLabels) {
    sources[WORLD_LABEL_SOURCE] = {
      type: 'geojson',
      data: cfg.data.worldLabels,
      attribution: 'Natural Earth',
    };
  }

  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': C.background } },
    ...(withWorld ? worldLayers(cfg.worldMaxzoom ?? 8) : []),
    ...(withWorldLabels
      ? [
          {
            id: 'ne-label-city',
            type: 'symbol',
            source: WORLD_LABEL_SOURCE,
            minzoom: 3,
            maxzoom: labelMax,
            filter: ['==', ['get', 'kind'], 'city'],
            layout: {
              'text-field': ['get', 'name'],
              'text-font': REGULAR,
              'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 6, 13],
              'text-max-width': 8,
              // Natural Earth's scalerank: 0 is a world city. Lower sorts
              // first, so collision keeps the important ones and drops the
              // rest instead of us filtering by zoom.
              'symbol-sort-key': ['get', 'rank'],
              'text-padding': 4,
            },
            paint: { 'text-color': C.text, 'text-halo-color': C.textHalo, 'text-halo-width': 1.6 },
          },
          {
            id: 'ne-label-country',
            type: 'symbol',
            source: WORLD_LABEL_SOURCE,
            maxzoom: labelMax,
            filter: ['==', ['get', 'kind'], 'country'],
            layout: {
              'text-field': ['get', 'name'],
              'text-font': BOLD,
              'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 18],
              'text-transform': 'uppercase',
              'text-letter-spacing': 0.1,
              'text-max-width': 7,
              // Big countries first; the globe limb is crowded, so let
              // collision thin the rest out by importance.
              'symbol-sort-key': ['get', 'rank'],
              'text-padding': 6,
            },
            paint: { 'text-color': '#4a4842', 'text-halo-color': C.textHalo, 'text-halo-width': 2 },
          },
        ]
      : []),

    // ---------------------------------------------------------------- landcover
    {
      id: 'landcover-wood',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
      paint: { 'fill-color': C.wood, 'fill-opacity': 0.7 },
    },
    {
      id: 'landcover-grass',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'wetland']]],
      paint: { 'fill-color': C.grass, 'fill-opacity': 0.6 },
    },
    {
      id: 'landcover-scrub',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['scrub', 'heath']]],
      paint: { 'fill-color': C.scrub, 'fill-opacity': 0.6 },
    },
    {
      id: 'landcover-sand',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landcover',
      filter: ['==', ['get', 'class'], 'sand'],
      paint: { 'fill-color': C.sand },
    },
    {
      id: 'landcover-ice',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', ['ice', 'glacier']]],
      paint: { 'fill-color': C.ice },
    },

    // ------------------------------------------------------------------ landuse
    {
      id: 'landuse-residential',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'quarter', 'neighbourhood']]],
      paint: { 'fill-color': C.residential, 'fill-opacity': 0.6 },
    },
    {
      id: 'landuse-industrial',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['industrial', 'commercial', 'retail', 'railway']]],
      paint: { 'fill-color': C.industrial, 'fill-opacity': 0.6 },
    },
    {
      id: 'landuse-institution',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['hospital', 'school', 'university', 'college', 'kindergarten']]],
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'hospital', C.hospital,
          C.school,
        ],
        'fill-opacity': 0.6,
      },
    },

    // -------------------------------------------------------------------- parks
    {
      id: 'park-fill',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'park',
      paint: { 'fill-color': C.park, 'fill-opacity': 0.55 },
    },
    {
      id: 'park-outline',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'park',
      minzoom: 11,
      paint: { 'line-color': '#9dbd85', 'line-width': 0.8, 'line-opacity': 0.7 },
    },
    {
      id: 'landuse-cemetery',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'landuse',
      filter: ['==', ['get', 'class'], 'cemetery'],
      paint: { 'fill-color': C.cemetery },
    },

    // -------------------------------------------------------------------- water
    {
      id: 'water',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'water',
      filter: ['!=', ['get', 'intermittent'], 1],
      paint: {
        'fill-color': ['match', ['get', 'class'], 'ocean', C.waterDeep, C.water],
      },
    },
    {
      id: 'water-intermittent',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'water',
      filter: ['==', ['get', 'intermittent'], 1],
      paint: { 'fill-color': C.water, 'fill-opacity': 0.5 },
    },
    {
      id: 'waterway',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'waterway',
      minzoom: 8,
      paint: {
        'line-color': C.water,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2.4, 17, 5],
      },
    },
  ];

  // ---------------------------------------------------------------- hillshade
  if (withTerrain) {
    layers.push({
      id: 'hillshade',
      type: 'hillshade',
      source: HILLSHADE_SOURCE,
      paint: {
        'hillshade-exaggeration': 0.45,
        'hillshade-shadow-color': '#4a4335',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#6b6354',
        // Lit from the same sun as the buildings, in world space so the two
        // stay consistent as the map rotates.
        'hillshade-illumination-anchor': 'map',
        'hillshade-illumination-direction': Math.round(cfg.lighting?.azimuth ?? 135),
        'hillshade-illumination-altitude': Math.round(cfg.lighting?.altitude ?? 45),
      },
    });
  }

  // ------------------------------------------------------------------- aeroway
  // Airports: aprons and runway/taxiway areas as fill, the runway and taxiway
  // centrelines as lines. Drawn above landcover but below the road network.
  layers.push(
    {
      id: 'aeroway-area',
      type: 'fill',
      source: VECTOR_SOURCE,
      'source-layer': 'aeroway',
      filter: ['==', ['geometry-type'], 'Polygon'],
      minzoom: 10,
      paint: {
        'fill-color': [
          'match', ['get', 'class'],
          'apron', C.apron,
          'runway', C.runway,
          'helipad', C.runway,
          C.taxiway,
        ],
      },
    },
    {
      id: 'aeroway-taxiway',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'aeroway',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'taxiway']],
      minzoom: 11,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C.taxiway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 14, 3.5, 18, 12],
      },
    },
    {
      id: 'aeroway-runway',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'aeroway',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'runway']],
      minzoom: 10,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': C.runway,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 11, 18, 40],
      },
    },
    {
      id: 'aeroway-runway-centreline',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'aeroway',
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'runway']],
      minzoom: 13,
      paint: {
        'line-color': C.runwayLine,
        'line-dasharray': [3, 3],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 18, 2.4],
      },
    },
  );

  // ------------------------------------------------------------------- tunnels
  layers.push(
    {
      id: 'tunnel-casing',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'tunnel'], ['!=', ['get', 'class'], 'ferry']],
      minzoom: 11,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': C.roadCasing,
        'line-dasharray': [0.5, 0.25],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 12, 20, 32],
      },
    },
    {
      id: 'tunnel-fill',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'tunnel'], ['!=', ['get', 'class'], 'ferry']],
      minzoom: 11,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#f2efe6',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 9, 20, 26],
      },
    },

    // ------------------------------------------------------------------- roads
    {
      id: 'road-casing',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: [
        'all',
        ['!', ['in', ['get', 'brunnel'], ['literal', ['tunnel', 'bridge']]]],
        ['!', ['in', ['get', 'class'], ['literal', ['ferry', 'rail', 'transit', 'aerialway']]]],
      ],
      minzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'match', ['get', 'class'],
          'motorway', C.motorwayCasing,
          C.roadCasing,
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          6, ['match', ['get', 'class'], 'motorway', 1.6, 'trunk', 1.2, 0.4],
          12, ['match', ['get', 'class'], 'motorway', 6, 'trunk', 5, 'primary', 4.5, 'secondary', 3.5, 2],
          16, ['match', ['get', 'class'], 'motorway', 20, 'trunk', 17, 'primary', 15, 'secondary', 12, 8],
          20, ['match', ['get', 'class'], 'motorway', 52, 'trunk', 46, 'primary', 40, 'secondary', 32, 22],
        ],
      },
    },
    {
      id: 'road-fill',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: [
        'all',
        ['!', ['in', ['get', 'brunnel'], ['literal', ['tunnel', 'bridge']]]],
        ['!', ['in', ['get', 'class'], ['literal', ['ferry', 'rail', 'transit', 'aerialway']]]],
      ],
      minzoom: 6,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': [
          'match', ['get', 'class'],
          'motorway', C.motorway,
          'trunk', C.trunk,
          ['primary', 'secondary'], C.primary,
          C.roadFill,
        ],
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          6, ['match', ['get', 'class'], 'motorway', 0.8, 'trunk', 0.6, 0.2],
          12, ['match', ['get', 'class'], 'motorway', 4, 'trunk', 3.4, 'primary', 3, 'secondary', 2.4, 1.2],
          16, ['match', ['get', 'class'], 'motorway', 15, 'trunk', 13, 'primary', 11, 'secondary', 9, 5.5],
          20, ['match', ['get', 'class'], 'motorway', 44, 'trunk', 38, 'primary', 33, 'secondary', 26, 17],
        ],
      },
    },
    {
      id: 'road-path',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['path', 'track', 'footway', 'pedestrian', 'steps']]],
      minzoom: 14,
      paint: {
        'line-color': '#b9a98c',
        'line-dasharray': [1.4, 0.8],
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.8, 20, 4],
      },
    },

    // ------------------------------------------------------------------ bridges
    {
      id: 'bridge-casing',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'bridge'], ['!=', ['get', 'class'], 'ferry']],
      minzoom: 11,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#9e9684',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 22, 20, 56],
      },
    },
    {
      id: 'bridge-fill',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['all', ['==', ['get', 'brunnel'], 'bridge'], ['!=', ['get', 'class'], 'ferry']],
      minzoom: 11,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': [
          'match', ['get', 'class'],
          'motorway', C.motorway,
          'trunk', C.trunk,
          ['primary', 'secondary'], C.primary,
          C.roadFill,
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 16, 20, 46],
      },
    },

    // --------------------------------------------------------------------- rail
    {
      id: 'rail',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
      minzoom: 9,
      paint: {
        'line-color': C.rail,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 16, 2.4, 20, 5],
      },
    },
    {
      id: 'rail-hatch',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation',
      filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
      minzoom: 13,
      paint: {
        'line-color': '#f2efe6',
        'line-dasharray': [0.2, 2.2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.4, 20, 4],
      },
    },

    // ---------------------------------------------------------------- buildings
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: VECTOR_SOURCE,
      'source-layer': 'building',
      minzoom: cfg.buildings.minzoom,
      // OpenMapTiles sets hide_3d on building parts that would double-extrude
      // on top of their parent. Rendering them produces z-fighting walls.
      filter: ['!=', ['coalesce', ['get', 'hide_3d'], false], true],
      paint: {
        // Use the mapped colour where OSM has one, otherwise fall back to the
        // height ramp. In Indian cities only a few percent of buildings are
        // tagged, so the ramp still does most of the work.
        'fill-extrusion-color': [
          'case',
          ['has', 'colour'], ['to-color', ['get', 'colour'], '#c9c2b4'],
          heightRamp(cfg.buildings.ramp),
        ],
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          cfg.buildings.minzoom, 0,
          cfg.buildings.minzoom + 0.5, ['coalesce', ['get', 'render_height'], ['get', 'height'], 3],
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          cfg.buildings.minzoom, 0,
          cfg.buildings.minzoom + 0.5, ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        ],
        'fill-extrusion-opacity': 0.94,
        // Darkens wall bases, which reads as contact shadow. MapLibre has no
        // real ambient occlusion for extrusions.
        'fill-extrusion-vertical-gradient': true,
      },
    },

    // --------------------------------------------------------------- boundaries
    {
      id: 'boundary-country',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'boundary',
      filter: ['<=', ['get', 'admin_level'], 2],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 10, 2.4],
        'line-dasharray': [4, 1.5],
      },
    },
    {
      id: 'boundary-state',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'boundary',
      filter: ['all', ['>', ['get', 'admin_level'], 2], ['<=', ['get', 'admin_level'], 4]],
      minzoom: 4,
      paint: {
        'line-color': C.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 12, 1.6],
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.8,
      },
    },
    {
      id: 'boundary-local',
      type: 'line',
      source: VECTOR_SOURCE,
      'source-layer': 'boundary',
      filter: ['>', ['get', 'admin_level'], 4],
      minzoom: 9,
      paint: { 'line-color': C.boundary, 'line-width': 0.7, 'line-opacity': 0.5, 'line-dasharray': [2, 2] },
    },

    // ------------------------------------------------------------------- labels
    {
      id: 'label-water',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'water_name',
      minzoom: 9,
      layout: {
        'text-field': NAME_FIELD,
        'text-font': ITALIC,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 16, 15],
        'symbol-placement': 'line',
        'text-letter-spacing': 0.1,
        'text-max-width': 6,
      },
      paint: { 'text-color': C.waterText, 'text-halo-color': C.textHalo, 'text-halo-width': 1.2 },
    },
    {
      id: 'label-road',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'transportation_name',
      minzoom: 13,
      layout: {
        'text-field': NAME_FIELD,
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13, 9, 18, 13],
        'symbol-placement': 'line',
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'text-padding': 2,
      },
      paint: { 'text-color': C.text, 'text-halo-color': C.textHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-aerodrome',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'aerodrome_label',
      minzoom: 10,
      layout: {
        // No sprite in this stack, so no aeroplane icon: show the IATA code
        // alongside the name instead, which is what the code is for.
        'text-field': [
          'case',
          ['has', 'iata'],
          ['concat', NAME_FIELD, ' (', ['get', 'iata'], ')'],
          NAME_FIELD,
        ],
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 15, 14],
        'text-max-width': 9,
        'text-anchor': 'top',
        'text-offset': [0, 0.4],
      },
      paint: { 'text-color': '#4a5a6b', 'text-halo-color': C.textHalo, 'text-halo-width': 1.6 },
    },
    {
      id: 'label-peak',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'mountain_peak',
      minzoom: 11,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': [
          'case',
          ['has', 'ele'],
          ['concat', NAME_FIELD, '\n', ['to-string', ['get', 'ele']], ' m'],
          NAME_FIELD,
        ],
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
        'text-anchor': 'bottom',
        'text-offset': [0, -0.2],
      },
      paint: { 'text-color': C.peakText, 'text-halo-color': C.textHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-place-other',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood', 'hamlet', 'village', 'island']]],
      minzoom: 11,
      layout: {
        'text-field': NAME_FIELD,
        'text-font': REGULAR,
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 15],
        'text-max-width': 8,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
      },
      paint: { 'text-color': '#5c5a53', 'text-halo-color': C.textHalo, 'text-halo-width': 1.4 },
    },
    {
      id: 'label-place-town',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['town', 'city']]],
      minzoom: 5,
      layout: {
        'text-field': NAME_FIELD,
        'text-font': BOLD,
        'text-size': [
          'interpolate', ['linear'], ['zoom'],
          5, ['match', ['get', 'class'], 'city', 12, 10],
          14, ['match', ['get', 'class'], 'city', 24, 17],
        ],
        'text-max-width': 8,
      },
      paint: { 'text-color': C.text, 'text-halo-color': C.textHalo, 'text-halo-width': 1.8 },
    },
    {
      id: 'label-place-country',
      type: 'symbol',
      source: VECTOR_SOURCE,
      'source-layer': 'place',
      filter: ['in', ['get', 'class'], ['literal', ['country', 'state']]],
      maxzoom: 9,
      layout: {
        'text-field': NAME_FIELD,
        'text-font': BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 11, 8, 20],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
        'text-max-width': 8,
      },
      paint: { 'text-color': '#4a4842', 'text-halo-color': C.textHalo, 'text-halo-width': 1.8 },
    },
  );

  const proj = cfg.projection || {};
  const projection = proj.globe === false
    ? undefined
    : {
        // A projectionDefinition may be a zoom expression, so the map can be a
        // globe when zoomed out and Mercator when zoomed in.
        type: [
          'interpolate', ['linear'], ['zoom'],
          proj.globeMaxzoom ?? 5, 'globe',
          proj.mercatorMinzoom ?? 7, 'mercator',
        ],
      };

  return {
    version: 8,
    name: `Navitron — ${cfg.area}`,
    glyphs: glyphsUrl,
    ...(projection ? { projection } : {}),
    // Root-level sky + atmospheric fog; "sky" stopped being a layer type in
    // MapLibre GL JS 4 and is a style property now.
    sky: {
      'sky-color': '#8fc1e3',
      'sky-horizon-blend': 0.6,
      'horizon-color': '#dfeaf2',
      'horizon-fog-blend': 0.6,
      'fog-color': '#e8eef2',
      'fog-ground-blend': 0.2,
      // Heavy atmosphere washes the globe out to near-white; keep it subtle.
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.35, 6, 0.2, 12, 0.1],
    },
    light: sunLight(cfg.lighting),
    sources,
    layers,
    ...(withTerrain
      ? { terrain: { source: TERRAIN_SOURCE, exaggeration: cfg.terrain.exaggeration } }
      : {}),
  };
}

export const SOURCE_IDS = { vector: VECTOR_SOURCE, world: WORLD_SOURCE, terrain: TERRAIN_SOURCE, hillshade: HILLSHADE_SOURCE };
export default buildStyle;
