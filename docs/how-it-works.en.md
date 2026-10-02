# How it works

[日本語](how-it-works.md) | English

This page covers what doesn't fit in the [README](../README.en.md): how the data is fetched and how the globe viewer is built.

## Fetching the data

1. Fetch the **resource manifest** (protobuf) to get the URL of the Flyover tiles (style 15) and the `tokenP2` used for authentication
2. From the **list of height regions** named in the manifest (`altitude-*.xml`), pick the region containing the point. A region's name `Reg_z9_X_Y` is the zoom 9 tile it covers
3. Request tiles by `x, y, z, h`. The URL carries `sid` and `accessKey` (built with AES-256-CBC)
4. Read the **C3M** (the 3D model of one tile). The mesh is compressed with Apple's own variant of Edgebreaker (Huffman codes → CLERS string → corner table → parallelogram prediction to restore vertices and UVs). Images are HEIC
5. Convert Earth-centered coordinates (ECEF) to east/north/up in meters, convert HEIC to JPEG, and export for the browser

Satellite imagery is style 7, and terrain is style 17 (zoom 7 and 11 worldwide, 13 for the US and Europe). The versions are in the style settings of the manifest.

## Globe viewer

### Choosing tiles

- Flyover tiles exist from zoom 13 (about 4 km per tile) to 20 (about 30 m). The viewer (CesiumJS) walks the quadtree down from the zoom 9 regions and picks finer tiles where they look large on screen (over 520 device pixels)
- It loads only every other level on the way down (about 40% less to load)
- It refines quarter by quarter where descendants can fill the quarter. Where they can't yet, or where children have no data (water and such), it draws the parent clipped to that quarter
- Until the needed tiles arrive, the gap is filled with finer tiles already at hand (up to 3 levels down) or coarser ones, so the 3D doesn't disappear while you move

### Loading order

- Up to 48 tiles load at once. More doesn't help, because the network link is already full (on a 50–65 Mbps line, 48 requests reached the limit; 96 only made each tile wait longer)
- Tiles visible on screen load first, the ones that look largest first. Off-screen tiles around the camera (2.5× the altitude, 4× that for coarse tiles) are preloaded only after all visible tiles have arrived, so they're ready when you rotate

### Lightening the browser's load

- Nothing is drawn while the view is still (Cesium's requestRenderMode). It draws only when the camera moves, or while something is loading or animating
- While loading, the heavy parts are preparing shaders (translating them for the GPU) and sending images to the GPU. Flyover models are unlit (the photo as is), so Cesium's reflections (the dynamic environment map and IBL) and the preparation for `Scene#pick` are turned off. Once the reflections became ready, they made Cesium rebuild every shader, which ate the first few seconds of loading (74 shader programs → 53)
- The cursor elevation and scale in the bottom bar are only rechecked once a second when neither the camera nor the mouse has moved (reading the depth stalls the GPU)
- The time the globe spends on loading each frame is raised from 5 ms to 20 ms

### Conversion on the server

- The height slabs of a tile are packed into one glb (vertices in Earth-centered coordinates) and kept in `cache/glb3/`
- Vertex positions are packed as int16 and UVs as uint16 (KHR_mesh_quantization; 8 cm steps even on a 4.9 km tile)
- Tiles at the edge of Flyover coverage contain a gray band that joins the flat map (mesh kind 4) and a plane at height 0 (kind 3). On top of the terrain these look like a second layer, so they are left out
- Height slabs split heights relative to the tile size. At zoom 16 and below there is only h = 0 (even for Tokyo Skytree or Denver), so zoom 15 and below request only h = 0, and zoom 16 only h = 0–1
- If numba is available, the heavy parts of C3M decoding (`flyover/_fast.py`) are compiled for speed (0.3 s → 0.06 s per tile in a dense city; the output is bit-for-bit identical to the pure Python version). Decoding runs in parallel in worker processes started at launch. So as not to compete with the browser for CPU, it uses half the cores (at most 8) at slightly lowered priority

### Requests to Apple

- They use HTTP/2 (httpx), with up to 90 concurrent requests on each of 4 connections. Apple takes about 1 second per tile, but the more you run in parallel, the faster it goes (with requests over HTTP/1.1, TLS setup per connection and so on meant waiting about 4 seconds for a response at 32 concurrent requests)
- If a request hasn't returned after 1.5 seconds, the same request goes out again on another connection and whichever returns first is used (and a third one 3 seconds later if still waiting)
- Each request gives up after 10 seconds. A connection that has stalled as a whole (nothing returned for a while) is reopened (before this, some requests waited 60 seconds)
- Terrain and satellite imagery are fetched on a connection separate from the Flyover tiles. While 16 or more Flyover tiles are being fetched, however, they are limited to 4 at a time. The link fills up either way, and much of the ground imagery is hidden under the 3D city, so doing the city first makes the view look good sooner

### Terrain

- Terrain is a 16-bit PNG. The 12 bytes appended after the end of the PNG (IEND) hold a float32 base height and scale (0.25): height = base + value × scale
- Heights are ellipsoidal, the same as Flyover, and the base differs per tile (miss it and inland terrain ends up hundreds of meters too low)
- The server converts the terrain into Cesium's geographic tiles
- EGM96 geoid heights (2.7 MB fetched from the PROJ data files on first run) are used for sea level where there is no terrain tile, and for the elevation shown on screen

### Other

- To get around the browser's limit on concurrent connections (6 per host), Flyover, satellite and terrain tiles are spread across different loopback addresses (127.0.0.2–127.0.0.17)
- Place search is relayed to OpenStreetMap's Nominatim

## What had changed on the servers by 2026

Since the original, retroplasma/flyover-reverse-engineering (archived in 2021), the following had changed. This project is adapted to them.

- The manifest's file location (`cache_base_url`) is now empty → use `https://gspe21-ssl.ls.apple.com/`
- The per-region index C3MM version 1 (style 14) now returns 404 (version 2, fetched by tile coordinates as style 52, does respond, but its format is not decoded) → skip the index, request the area's tiles and height slabs directly, and skip empty responses
- The 5th byte of C3M (the version) went from 3 to 7 → it reads fine with the version 3 reader
- Images changed from JPEG to HEIC (image format 13)

Also, the original tool picked the region "whose center is closest", which picks the wrong one where regions overlap, as in Tokyo (Shibuya returned no tiles at all). This project picks regions by the tile number in the region name `Reg_z9_X_Y`.

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
