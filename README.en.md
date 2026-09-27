# flyover-web

[日本語](README.md) | English

View Apple Maps Flyover (3D aerial imagery) in a browser on Windows. It runs on Python alone; no Mac is needed.

## Globe viewer (like Google Earth)

```bash
pip install -r requirements.txt
python scripts/earth.py          # http://localhost:8000/
```

Start from the whole Earth and zoom in: where Flyover exists, the 3D city loads.
Underneath are Apple's satellite imagery and terrain. Tiles for the area in view are fetched from Apple on demand and saved in `cache/`
(a new place finishes loading in about 2–5 seconds; after that it shows up immediately). You can search by place name or by "latitude, longitude".
When you fly to a search result, the destination tiles start loading during the flight.

The controls are the same as Google Earth (press the `?` button at the bottom right or the `?` key for the list):

| Action | Mouse | Keyboard |
|---|---|---|
| Move | Drag | Arrow keys |
| Zoom in / out | Wheel (toward the cursor), right-drag | PageUp / PageDown, + / - |
| Rotate | Shift + drag left/right, middle-button drag | Shift + ← → |
| Tilt | Shift + drag up/down, Shift + wheel | Shift + ↑ ↓ |
| Look around | Ctrl + drag | |
| Zoom toward / away | Double-click / right double-click | |
| Altitude | | Shift + PageUp / PageDown |
| North up / top-down / both | Click the compass | N / U / R |
| 2D / 3D | Button at the bottom right | O |
| Stop / search / help | | Space / `/` / ? |

Hold Alt to move slowly. The view is kept in the URL as `#lat,lon,altitude m,heading h,tilt t`,
so a bookmark opens that same view.

## Export an area

Fetch the tiles around a given point and export them to a three.js viewer or to OBJ.

```bash
python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya   # Higashi Chaya District, Kanazawa
python scripts/serve.py out                                          # http://localhost:8000/higashi-chaya/
```

Main options of `export.py`:

| Option | Default | Meaning |
|---|---|---|
| `--zoom` | 20 | Tile zoom (at 20, one tile is about 30 m square) |
| `--radius` | 4 | How many tiles to go ± from the center tile (4 gives 9×9 tiles, about 280 m square) |
| `--heights` | 4 | Number of height slabs to request (h = 0–3) |
| `--jobs` | 4 | Number of concurrent requests |
| `--obj` | off | Also export OBJ (to open in Blender and similar tools) |

Fetched tiles are saved in `cache/` and reused next time. The 9×9 tiles of Higashi Chaya are 88 tiles and 150,000 triangles, and take about 10 seconds from fetching to export.

## How it works

1. Fetch the **resource manifest** (protobuf) to get the URL of the Flyover tiles (style 15) and the `tokenP2` used for authentication
2. From the **list of height regions** named in the manifest (`altitude-*.xml`), pick the region containing the point
3. Request tiles by `x, y, z, h`. The URL carries `sid` and `accessKey` (built with AES-256-CBC)
4. Read the **C3M** (the 3D model of one tile). The mesh is compressed with Apple's own variant of Edgebreaker (Huffman codes → CLERS string → corner table → parallelogram prediction to restore vertices and UVs). Images are HEIC
5. Convert Earth-centered coordinates (ECEF) to east/north/up (meters) at the center of the area, convert HEIC to JPEG, and export for the browser

In the globe viewer:

- Flyover tiles exist from zoom 13 (about 4 km per tile) to 20 (about 30 m). The viewer (CesiumJS) walks the quadtree down from the zoom 9 regions, picks finer tiles where they look large on screen (over 520 device pixels), and loads the largest-looking ones first. It loads only every other level on the way down (about 40% less to load). It refines quarter by quarter where descendants can fill the quarter; where they can't yet, or where children have no data (water and such), it draws the parent clipped to that quarter. Up to 48 tiles load at once (more doesn't help, because the network link is already full). Tiles visible on screen load first. Off-screen tiles around the camera (2.5× the altitude, 4× that for coarse tiles) are preloaded only after all visible tiles have arrived, so they're ready when you rotate. Until the needed tiles arrive, the gap is filled with finer tiles already at hand (up to 3 levels down) or coarser ones, so the 3D doesn't disappear while you move
- Nothing is drawn while the view is still (Cesium's requestRenderMode). It draws only when the camera moves, or while something is loading or animating
- Where the browser spends its time: while loading, the heavy parts are preparing shaders (translating them for the GPU) and sending images to the GPU. Flyover models are unlit (the photo as is), so Cesium's reflections (the dynamic environment map and IBL) and the preparation for Scene#pick are turned off. Once the reflections became ready, they made Cesium rebuild every shader, which ate the first few seconds of loading (74 shader programs → 53). The cursor elevation and scale in the bottom bar are only rechecked once a second when neither the camera nor the mouse has moved (reading the depth stalls the GPU). The time the globe spends on loading each frame is raised from 5 ms to 20 ms
- The server packs the height slabs of a tile into one glb (vertices in Earth-centered coordinates) and keeps it in `cache/glb3/`. Tiles at the edge of Flyover coverage contain a gray band that joins the flat map (mesh kind 4) and a plane at height 0 (kind 3); on top of the terrain these look like a second layer, so they are left out. Vertex positions are packed as int16 and UVs as uint16 (KHR_mesh_quantization; 8 cm steps even on a 4.9 km tile). Height slabs split heights relative to the tile size. At zoom 16 and below there is only h = 0 (even for Tokyo Skytree or Denver), so zoom 15 and below request only h = 0, and zoom 16 only h = 0–1
- Requests to Apple use HTTP/2 (httpx), with up to 90 concurrent requests on each of 4 connections. Apple takes about 1 second per tile, but the more you run in parallel, the faster it goes (with requests over HTTP/1.1, TLS setup per connection and so on meant waiting about 4 seconds for a response at 32 concurrent requests). If a request hasn't returned after 1.5 seconds, the same request goes out again on another connection and whichever returns first is used (and a third one 3 seconds later if still waiting). Each request gives up after 10 seconds, and a connection that has stalled as a whole (nothing returned for a while) is reopened (before this, some requests waited 60 seconds)
- Terrain and satellite imagery are fetched on a connection separate from the Flyover tiles. While 16 or more Flyover tiles are being fetched, however, they are limited to 4 at a time. The network link (50–65 Mbps here) fills up either way, and much of the ground imagery is hidden under the 3D city, so doing the city first makes the view look good sooner
- If numba is available, the heavy parts of C3M decoding (`flyover/_fast.py`) are compiled for speed (0.3 s → 0.06 s per tile in a dense city; the output is bit-for-bit identical to the pure Python version). Decoding runs in parallel in worker processes started at launch. So as not to compete with the browser for CPU, it uses half the cores (at most 8) at slightly lowered priority
- Satellite imagery is style 7 and terrain is style 17 (zoom 7 and 11 worldwide, 13 for the US and Europe). The versions are in the style settings of the manifest. Terrain is a 16-bit PNG. The 12 bytes appended after the end of the PNG (IEND) hold a float32 base height and scale (0.25): height = base + value × scale. Heights are ellipsoidal, the same as Flyover, and the base differs per tile (miss it and inland terrain ends up hundreds of meters too low). The server converts the terrain into Cesium's geographic tiles. EGM96 geoid heights (2.7 MB fetched from the PROJ data files on first run) are used for sea level where there is no terrain tile, and for the elevation shown on screen
- Place search is relayed to OpenStreetMap's Nominatim

| File | Contents |
|---|---|
| `flyover/client.py` | Manifest, region selection, authentication, tile fetching |
| `flyover/c3m.py` | Reading C3M (header, materials, mesh assembly) |
| `flyover/edgebreaker.py` | Mesh decoding |
| `flyover/huffman.py` | Huffman tables and decoding |
| `flyover/_fast.py` | numba versions of the heavy decoding parts (unused without numba) |
| `flyover/web.py` | Export for the browser and to OBJ, and the viewer |
| `flyover/glb.py` | Tiles to glb (for the globe) |
| `flyover/terrain.py` | Terrain and geoid (for the globe) |
| `flyover/earth.py`, `flyover/earth/` | Globe server and viewer |
| `scripts/earth.py` | Starts the globe viewer |
| `scripts/export.py` | From fetching to export |
| `scripts/serve.py` | A server that only serves local files |
| `scripts/compare_go.py` | Comparison against the Go version (see below) |
| `tools/retroplasma-2026.patch` | Fixes for running the Go version against today's servers (for the comparison) |

## Based on

This is a Python port of the analysis and implementation in [retroplasma/flyover-reverse-engineering](https://github.com/retroplasma/flyover-reverse-engineering) (Go, archived in 2021). C3M decoding copies that project's decompiled logic, down to Go's integer overflow and shift behavior.

On the servers as of 2026, the following had changed since then. This project is adapted to them:

- The manifest's file location (`cache_base_url`) is now empty → use `https://gspe21-ssl.ls.apple.com/`
- The per-region index C3MM version 1 (style 14) now returns 404 (version 2, fetched by tile coordinates as style 52, does respond, but its format is not decoded) → skip the index, request the area's tiles and height slabs directly, and skip empty responses
- The 5th byte of C3M (the version) went from 3 to 7 → it reads fine with the version 3 reader
- Images changed from JPEG to HEIC (image format 13)

Also, the original tool picked the region "whose center is closest", which picks the wrong one where regions overlap, as in Tokyo (Shibuya returned no tiles at all). A region's name `Reg_z9_X_Y` is the zoom 9 tile it covers, so this project picks regions by that.

The authentication steps and `tokenP1` are the same as the Look Around implementation in [sk-zk/streetlevel](https://github.com/sk-zk/streetlevel) (which also comes from retroplasma). retroplasma's setup downloads the Xcode simulator SDK (about 2 GB) to extract `tokenP1`; that isn't needed here.

## Comparison with the Go version

The Python reader has been checked to **match the Go version bit for bit** on real tiles (88 tiles in Kanazawa and 121 in Shibuya, 209 in total). To check again:

```bash
git clone https://github.com/retroplasma/flyover-reverse-engineering
cd flyover-reverse-engineering
git apply ../flyover-web/tools/retroplasma-2026.patch && rm -rf vendor
go build -o dump-json.exe ./cmd/dump-json
cd ../flyover-web
python scripts/compare_go.py ../flyover-reverse-engineering/dump-json.exe cache/c3m/*
```

The patch also makes the Go version itself work against today's servers (`go run ./cmd/export-obj 36.5722 136.6680 20 4 4`).

Tests (the parts that run without Apple's data):

```bash
python -m pytest tests -q
```

## Notes

- Fetched data (`cache/`, `out/`) is Apple's copyrighted material. It is kept out of the repository (listed in `.gitignore`)
- The globe server only listens locally (127.0.0.1–127.0.0.17). To get around the browser's limit on concurrent connections (6 per host), Flyover, satellite and terrain tiles are spread across different loopback addresses
- Extracting Apple Maps data this way may conflict with Apple's terms of service. Use it at your own risk, and do not redistribute the fetched data
- The original, retroplasma/flyover-reverse-engineering, has no license. For that reason, this repository has no license either
