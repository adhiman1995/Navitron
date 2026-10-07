# Navitron

A self-hosted 3D map in the browser: OpenStreetMap vector tiles with
fill-extrusion buildings, Terrarium elevation tiles for 3D terrain and
hillshade, self-hosted fonts, and nothing else. **At runtime the page talks to
exactly one origin — yours.** No Google, Esri, Mapbox, MapTiler or CDN, no API
keys, no tile quota.

Everything the browser loads is a file in `web/`:

```
web/
  index.html            the page (UI, panel, styling)
  app.js                map wiring: PMTiles protocol, controls, toggles
  style.js              the MapLibre style for the OpenMapTiles schema (no DOM)
  config.js             area, bounds, data paths, camera, attribution
  vendor/               maplibre-gl.mjs + worker, pmtiles.mjs, maplibre-gl.css
  fonts/                glyph PBFs (Noto Sans Regular / Bold / Italic)
  data/map.pmtiles      vector tiles      (generated, not committed)
  data/terrain.pmtiles  elevation tiles   (generated, not committed)
```

Default area: **all of India** — bbox `68.0,6.0,97.5,37.5`, vector tiles to
z14 (3D buildings included), **2.0 GB, about 5 minutes to build** on a 10-core
laptop from the 1.6 GB Geofabrik extract. Terrain is built for a smaller box around Pune;
see [Terrain coverage](#terrain-coverage-is-separate-from-vector-coverage).
See [Changing the area](#changing-the-area).

---

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 18+ | installing MapLibre/pmtiles and vendoring them into `web/vendor/` |
| Python | 3.9+ | the terrain build, the font fetch, the local server |
| Java (JDK) | **21 or newer** | Planetiler |
| Disk | ~3 GB | Planetiler's shared sources (~1.5 GB), plus your tiles |
| RAM | 4 GB+ free | Planetiler heap for a city-sized extract |

Java 17 is **not** enough — Planetiler requires 21. `scripts/build-map.sh`
checks the version and tells you how to fix it.

```sh
# macOS
brew install openjdk@21
export JAVA="$(brew --prefix openjdk@21)/bin/java"

# Debian / Ubuntu
sudo apt install openjdk-21-jdk
```

## Setup

```sh
cd Navitron
npm install                        # also vendors maplibre + pmtiles into web/vendor/
python3 -m pip install -r requirements.txt
python3 scripts/fetch_fonts.py     # ~62 MB download -> ~2.4 MB of glyphs
```

`npm install` runs `scripts/sync-vendor.sh`, which copies the browser builds out
of `node_modules` into `web/vendor/`. Re-run `npm run vendor` after upgrading
either library.

> MapLibre GL JS 5+ ships **ES modules only** — there is no UMD bundle. The page
> therefore uses `<script type="module">`, and `maplibre-gl.mjs` must sit next to
> `maplibre-gl-worker.mjs`, which it resolves through its own `import.meta.url`.
> The vendor script keeps those together; don't split them.

## Build the data

### 1. Vector tiles (Planetiler + OpenMapTiles profile)

```sh
# all of India, full detail
AREA=india BOUNDS="68.0,6.0,97.5,37.5" HEAP=8g MAXZOOM=14 \
  NODEMAP=sortedtable COMPRESS_TEMP=true ./scripts/build-map.sh

# or just one city, out of the same extract
AREA=india BOUNDS="73.70,18.40,74.00,18.65" HEAP=6g MAXZOOM=14 ./scripts/build-map.sh
```

Measured on this stack:

| Area | maxzoom | output | build time |
|---|---|---|---|
| Monaco | 14 | 444 KB | 20 s |
| Pune city bbox | 14 | 9.2 MB | ~5 min |
| **All India** | **14** | **2.0 GB** | **~5 min** |

The script refuses to start if the disk looks too small, estimating scratch
space from the **input** size (every node is read before `--bounds` is applied,
so a city clip still pays for it) and output from the **area and maxzoom**:

```
Disk:    21 GB free, ~13 GB estimated for this build
```

That estimate is deliberately pessimistic — all-India came in at 2.0 GB against
a ~13 GB guess. It is a guard against filling the disk, not a forecast.

Override with `MIN_FREE_GB=0`, or lower the peak with `COMPRESS_TEMP=true` and
`EXTRA_ARGS='--free-osm-after-read'`.

On the first run this downloads `planetiler.jar` from its GitHub releases page
into `vendor-jars/`, plus the shared sources Planetiler needs (OSM extract,
water polygons, Natural Earth, lake centerlines, ~1.5 GB) into `.planetiler/`.
Those are cached, so later builds only re-read them.

`AREA` is the **Geofabrik extract to download** (`india`, `monaco`,
`europe/monaco`, …) and `BOUNDS` clips the output to your city. Downloading
`india` is ~1.3 GB; to avoid that, point the build at an extract you already
have:

```sh
OSM_PATH=~/osm/western-zone-latest.osm.pbf BOUNDS="73.70,18.40,74.00,18.65" ./scripts/build-map.sh
```

| Variable | Default | Meaning |
|---|---|---|
| `AREA` | `india` | Geofabrik extract name (ignored when `OSM_PATH` is set) |
| `BOUNDS` | `73.70,18.40,74.00,18.65` | `west,south,east,north`, clips the output |
| `OSM_PATH` | — | use this local `.osm.pbf` instead of downloading |
| `HEAP` | `6g` | JVM max heap |
| `NODEMAP` | `sortedtable` | node location map. `sortedtable` suits country extracts, `sparsearray` the planet |
| `COMPRESS_TEMP` | `false` | trade CPU for much less scratch disk |
| `MIN_FREE_GB` | estimated | abort below this much free disk; `0` disables |
| `MAXZOOM` / `MINZOOM` | `14` / `0` | vector zoom range |
| `OUTPUT` | `web/data/map.pmtiles` | output archive |
| `PLANETILER_VERSION` | `latest` | release tag to fetch |
| `JAVA` | `java` | explicit JDK 21 binary |
| `EXTRA_ARGS` | — | appended verbatim to the Planetiler command |

Buildings need `maxzoom` ≥ 14 to carry `render_height`; 14 is the OpenMapTiles
default and what the style expects. The schema only emits the `building` layer
from z13, and this style ramps extrusion height in between z13 and z13.5, so
buildings fade in as you cross z13.

The build runs in a staging directory under `WORK_DIR` and the finished archive
is moved into place only on success. An interrupted or failed build therefore
leaves your existing `map.pmtiles` intact, and Planetiler never runs inside
`web/data`.

> Planetiler parses `--output` as a URI, so a space anywhere in the path makes
> it fail with *Illegal character in path*. The script runs Planetiler from the
> output directory and passes a bare filename, so a project living under
> `~/My Projects/…` works — but keep the **filename** itself free of spaces.

### Storage, and how to shrink it

What this deployment actually costs on disk:

| File | Size | Shrink it by |
|---|---|---|
| `web/data/map.pmtiles` | 2.0 GB | `MAXZOOM=13` roughly halves it, but loses most 3D buildings; a state-sized `BOUNDS` cuts it far more |
| `web/data/terrain.pmtiles` | 776 MB | lower `--maxzoom`: z13 ≈ 27 MB, z12 ≈ 2 MB |
| `web/data/world.pmtiles` | 21 MB | drop it, and the globe becomes a blank sphere |
| `web/data/world-labels.geojson` | 213 KB | lower `--max-city-rank` |
| `web/fonts/` | 2.8 MB | drop unused Unicode ranges in `scripts/fetch_fonts.py` — but keep **7680-7935**, which holds the ṭ/ḍ/ṇ/ś/ṣ used to romanise Indian names; without it `name:latin` labels 404 |
| `web/vendor/` | 1.7 MB | — |
| `.terrain-cache/` | 109 MB | safe to delete; only needed to rebuild terrain without re-downloading |
| `vendor-jars/planetiler.jar` | 89 MB | safe to delete; re-downloaded on the next build |
| `.planetiler/sources/` | ~3 GB | safe to delete between builds; it caches the OSM extract, water polygons and Natural Earth, so deleting means re-downloading them |

Only `web/` needs to be deployed. Everything else is build-time scratch.

This deployment is **India only**: `data.world` is `null`, so the map is empty
outside `bounds`. Turning on the global low-zoom context costs 21 MB — see the
comment in `config.js`.

### Terrain coverage is separate from vector coverage

Vector tiles for a whole country are a few gigabytes. Terrain for the same area
is not: India at z14 would be about **1.9 million tiles / 140 GB**, because DEM
tiles are lossless PNGs that do not thin out over empty land.

So the two are decoupled. `bounds` in `config.js` describes the vector tiles;
`terrainBounds` describes the elevation archive. Outside `terrainBounds` the map
works normally and simply renders flat when tilted — the status line says
`no terrain here` so it does not read as a bug.

**The terrain archive must cover its whole area at one uniform maxzoom.**
MapLibre renders the terrain mesh at the source's `maxzoom` and does *not*
fall back to a parent tile where one is missing — it renders **flat**. So an
archive that is z10 nationwide plus z14 over one city produces a map that goes
flat the moment you zoom past 10 anywhere else.

That failure is invisible to elevation checks: `queryTerrainElevation()` *does*
fall back to the parent and returns correct heights over the flat area. It has
to be looked at. `scripts/build_terrain.py --region` can still build mixed
archives — useful if you serve several styles — but `terrain.maxzoom` in
`config.js` must then be set to the zoom the archive actually has everywhere.

A smoother DEM also costs less road wobble: roads are draped on the terrain and
MapLibre has no way to pin a line to a fixed elevation, so DEM noise shows up as
rippling roads on flat ground.

Pick a scale that fits:

| Terrain area | maxzoom | tiles | size | time @12 jobs |
|---|---|---|---|---|
| Pune + surroundings | 14 | 1,424 | 106 MB | 2 min |
| All India | 9 | 2,907 | ~220 MB | ~5 min |
| **All India (current)** | **10** | **11,322** | **776 MB** | **~12 min** |
| All India | 11 | 44,615 | ~3.3 GB | ~45 min |
| All India | 12 | 177,056 | ~13 GB | ~3 h |

z12 is about the limit worth building: Terrarium is derived from ~30 m SRTM,
which z12 already resolves. Above that you are interpolating.

A reasonable country-wide compromise is z9–10 for the whole of India plus a
z14 archive for the city you actually work in — but MapLibre takes one DEM
source per style, so that means swapping `data.terrain` rather than merging.

### 2. Terrain tiles (Terrarium → PMTiles)

```sh
python3 scripts/build_terrain.py --bounds "73.50,18.20,74.20,18.85" --maxzoom 14 --jobs 12 --max-tiles 3000
```

Two things worth copying from that command:

- **Pad the bounds beyond the vector area.** When the camera is tilted you see
  past the edge of the city, and un-covered DEM renders flat. ~0.2° of padding
  on each side covers the horizon.
- **`--maxzoom` is what makes relief legible.** At z12 a city reads as a flat
  plate; z14 resolves individual ridges. It costs size: the Pune archive above
  is **1,424 tiles / 106 MB** at z14, against ~27 MB at z13 and 2 MB at z12.
  Pick per deployment, and set `terrain.maxzoom` in `config.js` to match —
  never above what you built.

`--jobs` controls parallel connections (default 8). The Pune build above took
**2m13s** at 12 jobs, against roughly 25 minutes serially.

Tiles come from the **Tilezen Joerd** elevation dataset on AWS Open Data —
openly licensed, not a commercial service. They are cached in `.terrain-cache/`,
so an interrupted run resumes instead of starting over, and failures are retried
with backoff. The archive is written to a temp file and renamed only on success:
a failed run never leaves a half-built `terrain.pmtiles`.

| Option | Default | Meaning |
|---|---|---|
| `--bounds` | `73.70,18.40,74.00,18.65` | `west,south,east,north` |
| `--minzoom` / `--maxzoom` | `0` / `12` | zoom range (each extra zoom is ~4× the tiles) |
| `--source` | Tilezen on AWS Open Data | URL template with `{z}/{x}/{y}`, or `file://DIR` |
| `--output` | `web/data/terrain.pmtiles` | output archive |
| `--cache-dir` | `.terrain-cache` | on-disk cache, reused to resume |
| `--max-tiles` | `60000` | refuses larger builds; the error prints the exact override |
| `--jobs` | `8` | parallel connections (a `file://` source stays serial) |
| `--retries` / `--timeout` / `--pause` | `4` / `30` / `0` | HTTP behaviour |

Fully offline, from a directory of tiles you already have:

```sh
python3 scripts/build_terrain.py --source file:///data/terrarium --bounds "73.70,18.40,74.00,18.65"
```

### 3. Serve it

```sh
python3 scripts/serve.py          # http://127.0.0.1:8080
```

**PMTiles needs HTTP Range requests.** Python's stock
`python3 -m http.server` does not implement them, and the map will not load
behind it. `scripts/serve.py` adds single, open-ended and suffix ranges, a
correct `416`, and the MIME types this stack needs (`.mjs`, `.pmtiles`, `.pbf`).

## Using the map

- Drag to pan, scroll to zoom, right-drag or two-finger drag to rotate and tilt
  (or ctrl-drag). The navigation control's compass visualises pitch.
- The panel toggles **3D terrain**, **3D buildings** and **hillshade**, and has
  an exaggeration slider (0–4×).
- Camera buttons: tilt/flat, face north, rotate 90°, reset view.
- The view is written to the URL hash, so a link restores the camera.
- Buildings are extruded from `render_height` / `render_min_height` and appear
  from zoom 13. They take their colour from the OSM `colour` tag where one
  exists (rare in India — about 7% of buildings in central Mumbai) and
  otherwise from a height ramp of warm greys.
- **Sun** sliders set the light direction and height. One sun drives both the
  building shading and the hillshade, anchored to the map so they stay
  consistent as you rotate. The directional term eases off as the sun drops,
  because at full strength a low sun turns every away-facing wall to mud.
- Building parts tagged `hide_3d` are filtered out; rendering them causes
  z-fighting against the parent building.
- **Globe**: the map is a globe below z5 and Mercator above z7, interpolated in
  between (`projection` in `config.js`; `globe: false` disables it, and the
  globe button in the corner always works). Mercator is right for a city —
  curvature fights the 3D terrain and buildings up close.
- The globe needs `data/world.pmtiles` (21 MB) or it is a blank sphere, and
  `data/world-labels.geojson` (213 KB, Natural Earth) for country and city
  names. The world archive's own `place` layer is useless: OpenMapTiles fills
  it from OSM, so a stub-extract build contains exactly one country.
- The sky and atmospheric fog come from the style's root `sky` property.
  MapLibre dropped `"type": "sky"` *layers* in v4; a style that still uses one
  will not validate.
- There is no sprite in this stack, so the map is **text labels only** — no
  icons. Labels cover places, roads, water, and peaks (with elevation).
- If a data file is missing, the page says so and prints the exact command to
  build it. A missing `terrain.pmtiles` is non-fatal: the map loads flat with
  terrain and hillshade disabled.

## Changing the area

Three places, which must agree:

1. **`web/config.js`** — `area` (the label) and `bounds`.
2. **The vector build** — `AREA` (Geofabrik extract, or `OSM_PATH`) and `BOUNDS`.
3. **The terrain build** — `--bounds`.

```sh
# e.g. switch to Bengaluru
sed -i '' "s/area: 'Pune, India'/area: 'Bengaluru, India'/" web/config.js
sed -i '' 's/bounds: \[73.70, 18.40, 74.00, 18.65\]/bounds: [77.45, 12.82, 77.78, 13.10]/' web/config.js

AREA=india BOUNDS="77.45,12.82,77.78,13.10" ./scripts/build-map.sh
python3 scripts/build_terrain.py --bounds "77.45,12.82,77.78,13.10"
```

The initial camera comes from the PMTiles header, so it follows the new area on
its own. `camera.center` / `camera.zoom` in `config.js` override it if you want
a specific opening shot; `pitch` and `bearing` always come from the config.

Nothing outside `config.js` hardcodes a location, and `style.js` never touches
the DOM — so you can swap either file independently.

## Deploying to static hosting

The whole app is static files plus two archives. Any host that supports **HTTP
Range requests** works — S3, Cloudflare R2, GitHub Pages, Netlify, nginx, Caddy.

```sh
npm install && npm run vendor
python3 scripts/fetch_fonts.py
AREA=india BOUNDS="73.70,18.40,74.00,18.65" ./scripts/build-map.sh
python3 scripts/build_terrain.py --bounds "73.50,18.20,74.20,18.85" --maxzoom 14 --max-tiles 3000

# then upload the whole web/ tree, including web/data/*.pmtiles
rsync -av --delete web/ user@host:/var/www/navitron/
```

Checklist for the host:

- **Range requests must work.** Verify after deploying:
  ```sh
  curl -sI -H 'Range: bytes=-127' https://example.com/data/map.pmtiles | head -3
  # expect: HTTP/1.1 206 Partial Content  +  Content-Range: bytes .../...
  ```
  A `200` here means the host ignores ranges, and PMTiles will fetch whole
  archives (or fail). On nginx this works out of the box; don't put a
  transforming proxy or `gzip` in front of `.pmtiles`.
- Serve `.pmtiles` as `application/vnd.pmtiles`, `.mjs` as `text/javascript`,
  `.pbf` as `application/x-protobuf`.
- Do **not** gzip `.pmtiles` — the tiles inside are already compressed, and
  transport compression breaks byte-range addressing.
- Cache `vendor/`, `fonts/` and the archives aggressively; the page itself
  briefly. Re-uploading an archive to the same name needs a cache purge.
- `web/vendor/` and `web/fonts/` are `.gitignore`d because they are reproducible
  (`npm run vendor`, `python3 scripts/fetch_fonts.py`). If your deploy pipeline
  builds from a clean checkout, run both before uploading.

S3/R2 example:

```sh
aws s3 sync web/ s3://my-bucket/ --delete \
  --exclude '*.pmtiles' --exclude '*.pbf'
aws s3 cp web/data/map.pmtiles     s3://my-bucket/data/ --content-type application/vnd.pmtiles
aws s3 cp web/data/terrain.pmtiles s3://my-bucket/data/ --content-type application/vnd.pmtiles
aws s3 sync web/fonts/ s3://my-bucket/fonts/ --content-type application/x-protobuf
```

## Tests

```sh
npm test            # or: bash tests/run_all.sh
```

Runs, with no network and no browser:

| Suite | What it checks |
|---|---|
| syntax | `node --check`, `py_compile`, `bash -n` across every script |
| `validate-style` | the generated style against `@maplibre/maplibre-gl-style-spec`, with and without terrain |
| `test_no_third_party.sh` | nothing in `web/` references a commercial service or CDN, and all three attributions are present |
| `test_terrain.sh` | offline `file://` build, resume-from-cache, reproducible output, absent tiles, the tile limit, bad bounds, non-PNG data, and that no partial archive is ever written |
| `test_range.sh` | the server: `200`, `206` closed/open-ended/suffix ranges, `416` with `Content-Range: bytes */size`, MIME types |
| `test_roundtrip.sh` | packs synthetic DEM tiles, serves them, reads the archive back with the **browser** pmtiles library and compares every tile byte-for-byte |
| `smoke_browser.mjs` | **optional**: loads the page in headless Chromium and asserts a live WebGL context, terrain active, extruded buildings, placed labels, working toggles and a clean console. Skipped unless Playwright is installed and `web/data/map.pmtiles` exists. |

```sh
npm i -D playwright && npx playwright install chromium
npm test            # the browser step now runs too, screenshots in tests/screenshots/
```

`tests/make_test_dem.py` generates valid Terrarium PNGs with a tiny built-in PNG
encoder, so the terrain path is testable with no elevation service at all.

## Licences and attribution

The code in this repository is MIT. The data and libraries are not — **you must
keep these credits visible**, which `web/config.js` does by default:

| Component | Licence | Required credit |
|---|---|---|
| OpenStreetMap data | [ODbL 1.0](https://www.openstreetmap.org/copyright) | **© OpenStreetMap contributors** |
| OpenMapTiles schema | [BSD-3-Clause (code), CC-BY 4.0 (schema)](https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md) | **OpenMapTiles** |
| Tilezen Joerd elevation | public domain / attribution per source ([details](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)) | **SRTM / ETOPO1 / NED a.o.** as listed there |
| Natural Earth | public domain | — (credit appreciated) |
| OSM water polygons | ODbL | covered by the OSM credit |
| MapLibre GL JS | BSD-3-Clause | notice in `web/vendor/VERSIONS.txt` |
| pmtiles | BSD-3-Clause | notice in `web/vendor/VERSIONS.txt` |
| Planetiler | Apache-2.0 | build-time only |
| Noto Sans | [SIL OFL 1.1](https://openfontlicense.org/) | keep the licence notice when redistributing the glyphs |

ODbL is a **share-alike** licence: if you publish a derived database, you have to
publish it under ODbL too. Rendered map images are a "produced work" and only
need the attribution above.

Do not repoint `--source` or the style at Google, Esri, Mapbox or any other
commercial tile service. Beyond breaking the point of this project, caching or
redistributing their tiles violates their terms.

## Not committed

`.gitignore` excludes the generated and downloaded artefacts: `web/data/*.pmtiles`,
`web/fonts/`, `web/vendor/`, `vendor-jars/` (the Planetiler jar), `.planetiler/`,
`.terrain-cache/`, `.font-cache/`, `node_modules/`. Everything there is
reproducible from the scripts.
