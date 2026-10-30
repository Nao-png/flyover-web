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

- The height slabs of a tile are packed into one glb (vertices in Earth-centered coordinates) and kept in `cache/glb4/`
- Vertex positions are packed as int16 and UVs as uint16 (KHR_mesh_quantization; 8 cm steps even on a 4.9 km tile)
- When the browser can decode HEVC with the GPU's dedicated hardware (WebCodecs; Chrome doesn't decode HEVC in software), images of the new Flyover are passed as HEVC instead of JPEG (`?hevc=1`, `cache/glb98_11h/`). A HEIC holds just one HEVC frame, so its configuration (hvcC) and the frame go into the material's `extras.hevc`. The viewer decodes them in a worker (`earth/hevc.js`), uses the luma (Y) and chroma (UV) planes directly as textures of a Cesium CustomShader, and converts to RGB in the shader. HEIC carries no color description, so it is treated as BT.601 full range as the HEIF rules say (the same as pillow_heif; Chrome otherwise assumes BT.709 limited range)
  - Building a glb on the server drops from about 125 ms to 19 ms per height slab (no HEIC decoding, shrinking or JPEG). Decoding in the browser takes about 10 ms per image
  - Images stay at their original size (in WebGL2, textures made from arrays are not enlarged to powers of two) at 1.5 bytes per pixel. With 208 tiles loaded over Osaka, images take 438 MB of GPU memory (754 MB as power-of-two JPEG, 2,885 MB before shrinking)
  - Which material's image to use is told by the vertex attribute `_SLAB` (the 4th int16 of the position, which used to be padding). If decoding fails, JPEG is used from then on. Add `?hevc=0` to use JPEG only
- Images are shrunk so that width and height are each the next lower power of two. Cesium enlarges images that are not powers of two to the next power of two before building the downscaled levels (mipmaps), so the 1152–1376 px images common in the new Flyover became 2048 px, about 2.5 times the GPU memory (for 314 tiles loaded over Osaka, images are estimated to drop from 3.6 GB to about 1.0 GB)
- Tiles at the edge of Flyover coverage contain a gray band that joins the flat map (mesh kind 4) and a plane at height 0 (kind 3). On top of the terrain these look like a second layer, so they are left out
- Height slabs split heights relative to the tile size. At zoom 16 and below there is only h = 0 (even for Tokyo Skytree or Denver), so zoom 15 and below request only h = 0, and zoom 16 only h = 0–1
- If numba is available, the heavy parts of C3M decoding (`flyover/_fast.py`) are compiled for speed (0.3 s → 0.06 s per tile in a dense city; the output is bit-for-bit identical to the pure Python version). Decoding runs in parallel in worker processes started at launch. So as not to compete with the browser for CPU, it uses a quarter of the cores (at most 4; each takes 140–190 MB of memory) at slightly lowered priority

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

## The new Flyover (style 98)

The manifest requested as iOS 27 lists the new Flyover tiles (style 98). Start with `python scripts/earth.py --r3d` to use them at every zoom; only tiles without the new Flyover or that can't be read are filled in with the old C3M (so the scene doesn't switch between old and new data as you zoom). The reader is `flyover/r3d.py`.

- **Fetching**: Tile numbering and height slabs are the same as C3M. Request `?style=98&v=<style 98 version>&region=<region>&x&y&z&h` (`v` is the style 98 version, not the region's version)
- **File**: A container starting with `3D 96 59 2E` holds triangle splats (part 1) and a textured mesh (part 2). The mesh coordinates become Earth-centered coordinates (ECEF) with the 3×3 rotation and translation in the first entry of part 2. The texture is the first HEIC in the image entry
- **Splats**: Trees and the like are triangle splats, not mesh (a park tile has a small mesh and close to 20,000 splats). Each has 3 vertices, a color and opacity, and 4 more values (octahedral normals and others). Apple draws them denser toward the inside of the triangle, fading out at the edges. In the glb they are semi-transparent triangles with vertex colors (RGBA), with a shared small image that gets more transparent toward the edges, for a similar look (it doesn't match Apple's drawing pixel for pixel)
- **Compression**: The content is the same Edgebreaker variant as C3M, split into streams and packed. Each number sequence is packed per "lane" with a bitmap (1 for the next value, 0 to repeat the previous value or look up a table) and Huffman codes (Apple's own table format)
  - **Shape**: The C / other bit per triangle and the 2-bit kind of the others are rebuilt into the old C3M single bit stream, and `edgebreaker.py` turns it into triangles
  - **Positions**: An integer per vertex × a step. It holds the difference from a parallelogram prediction while walking the triangles breadth first
  - **UV**: 4 bits per triangle mark UV seams. UV numbers are assigned depth first, bounded by seams, and the values are restored with a breadth-first parallelogram prediction bounded by seams. The unit is a quarter texel
  - **Lane directory (J)**: Bits for the lanes in use, a 2-bit kind per lane (a 2m + 6 bit field for m lanes), and a length and fill mark per lane. The kind says what changes for the next lane: if its high bit is 1, the next lane's length is written (otherwise it is the same); if its low bit is 1, 1 byte with the next lane's fill mark is written (otherwise the fill is the same). The first lane's mark sits at the byte boundary after the kind bits (when m leaves a remainder of 1 when divided by 4, it doesn't fit in the field and there is no mark). Marks: 0 = raw bytes, 1 and 4 = repeat, 2 and 5 = table lookup, 3 and 6 = signed differences (the difference between 1–3 and 4–6 is unknown)
  - **Splats**: BYET blocks for the position (XYZ) and 8 attributes. The origin is 4 bytes per component, or a packed form of that. One packed form is itself a small BYET (the bytes of the int as lanes, the components as values)
  - **Normals**: Spherical coordinates in 2° steps (not read now, since the view has no lighting)
- **Speed**:
  - The heavy loops (Huffman codes, lane filling, the 3 walks, prediction replay) run in numba. One tile takes 20–150 ms, 5–13 times faster than plain Python.
  - Reading the Huffman code tables and expanding the triangle connectivity (CLERS) also run in numba. Reading one height slab of the new Flyover went from about 36 ms to 23 ms (on 4,838 local tiles the output is exactly the same as before).
  - So that broken data doesn't crash or hang the process, index ranges are checked before handing data to numba, the corner-table walks run with index checks (`boundscheck`), and loops have an upper limit.
  - In building one tile, decoding the image (HEIC, 100–150 ms) is the heaviest part.
  - The new Flyover is often not yet cached on Apple's delivery servers, so the first fetch of a tile takes 1–2 seconds to respond (tens of ms from the second time; it is also kept locally in `cache/r3d/`).
  - New Flyover tiles at z16 and below are large, around 1 MB each, so in a new place the distant view takes 1–2 seconds to appear. Tiles whose fetch times out are not filled with C3M; the viewer fetches them again later.
- **Checking**: On the 29 Tokyo tiles whose decoding by Apple itself (exported from the iOS 27 simulator) is published, the mesh triangles, positions, UV numbers and UV values, and the splat vertices, colors and attributes all match bit for bit
- **Where the format comes from**: Apple doesn't document it. It was worked out from the data, using the prose of [nmt3325/apple-maps-r3d-research](https://github.com/nmt3325/apple-maps-r3d-research) as clues (its code was not read, since it has no license). The reference data used for checking is from the same repository
- **Lane filling**: Decided by the mark in J (on about 150,000 splat lanes in the local tiles, the mark and the filling worked out from the data agree every time). For lanes without a mark: where the prediction is right the bit is 0, so with the right filling a literal never equals the prediction, and that is how it is chosen
- **Mesh field section**: int32 values for the face count, the corner pairs (va, vb) glued in advance, the vertex count and so on. The fields are laid out as 4 bytes each, and the byte string is packed with a table lookup, using each field's 4-bit mark (which bytes are written) as the bitmap (the same as mode 4 of the origin packing: an unwritten byte is table[previous byte], and each written byte sets table[previous] = it). When the section starts with 0C, that is packed again with a repeat bitmap. Every field in the local tiles reads correctly this way
- **Header numbers and small tiles**: The two numbers in the header (meaning unknown) and the two numbers after XYZ take 1 byte when small. In small tiles the seam block, and in large low-zoom tiles the per-triangle C bits, are stored unpacked or as a 1-lane BYET
- **Version 1 container**: Rare in upper height slabs. It has no part and item framing: from byte 16 come 12 doubles for the rotation and translation, then the splats (starting with `D1 22 C9 07`), the mesh (starting with `E1 21 66 24`) and the image HEIC. The contents have the same form as version 2 and read the same way
- **Coastal low-zoom tiles (z13–14)**: After the XYZ block there is one extra block (a 1-bit mark per vertex; meaning unknown), and the per-chart number block (normally empty) holds values. The image section has item 13, and the image included is only a fill for the sea and the like (sometimes 16 px square); the UVs of land triangles point outside the image. The land photos are not in the tile's other height slabs either. The shapes can be read, but with no photos, tiles that contain land fall back to C3M entirely (sea-only ones are shown from the new Flyover)
- **How much can be read**: Of about 20,000 tiles fetched locally, all splats and meshes can be read except the coastal tiles "without land photos" above (36) and the following 4 (40 of 20,114). The 4 large z13 tiles on the mountain side of Kobe have a height component of the positions that drifts (the shape looks like a tile, but it is shifted by hundreds of meters to kilometers). The cause is unknown, and they fall back to C3M entirely
- **What is unknown**: What the 4 splat values mean for drawing (the view doesn't use them now). The meaning of some numbers between blocks (not used for reading). The meaning of the vertex marks and chart numbers in coastal tiles, and where their land photos are. The shift of the 4 Kobe tiles

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
