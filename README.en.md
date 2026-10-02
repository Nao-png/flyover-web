# flyover-web

[日本語](README.md) | English

A tool for viewing Apple Maps Flyover (3D aerial imagery of cities) in a browser on Windows.
It runs on Python alone; no Mac or Apple apps are needed.

- **Globe viewer** — Zoom in from the whole Earth, like Google Earth, and cities with Flyover appear in 3D. The controls are the same as Google Earth
- **Export** — Save the area around a given point as a set of files you can view in the browser, or as OBJ (a 3D format that Blender and similar tools can open)

> [!WARNING]
> This tool fetches Apple Maps data through interfaces that Apple does not offer to the public. This may violate Apple's terms of service. Use it at your own risk, and do not redistribute the data you fetch. This project is not affiliated with Apple.

## Requirements

- Python 3 (tested with 3.13)
- A browser with WebGL (tested with Chrome and Edge)
- An internet connection (data is fetched from Apple as you view it)

Tested on Windows 11.

## Getting started

```bash
git clone https://github.com/Nao-png/flyover-web
cd flyover-web
pip install -r requirements.txt
python scripts/earth.py
```

Open http://localhost:8000/ in your browser. To use another port, pass it like `python scripts/earth.py 8080`.

## Globe viewer

Zoom in from the whole Earth, and wherever Flyover exists the 3D city loads. Apple's satellite imagery and terrain are used underneath.

- **Search**: Type a place name or "latitude, longitude" in the box at the top left. Places with 3D are marked
- **Loading speed**: The first 3D appears in 2–3 seconds. In a place you haven't visited, it takes about 10–20 seconds until everything is at full detail (depending on your connection). Places you have seen are saved in `cache/`, so the second time takes about 7 seconds
- **Saving a view**: The current view is kept in the URL (`#lat,lon,altitude m,heading h,tilt t`), so a bookmark opens that same view

### Controls

Press the `?` button at the bottom right or the `?` key to see the list at any time.

| Action | Mouse | Keyboard |
|---|---|---|
| Move | Drag | Arrow keys |
| Zoom in / out | Wheel (toward the cursor), right-drag | PageUp / PageDown, + / - |
| Rotate | Shift + drag left/right, middle-button drag | Shift + ← → |
| Tilt | Shift + drag up/down, Shift + wheel | Shift + ↑ ↓ |
| Look around | Ctrl + drag | |
| Zoom toward / away | Double-click / right double-click | |
| Raise / lower altitude | | Shift + PageUp / PageDown |
| North up / top-down / both | Click the compass | N / U / R |
| Switch 2D / 3D | Button at the bottom right | O |
| Stop / search / controls list | | Space / `/` / ? |

Hold Alt while moving to move slowly.

## Export

Fetch the tiles around a given point and save them as a set of files you can view in the browser (three.js).

```bash
python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya   # Higashi Chaya District, Kanazawa
python scripts/serve.py out                                          # http://localhost:8000/higashi-chaya/
```

For the 9×9 tiles around Higashi Chaya (about 280 m square, 88 tiles, 150,000 triangles), fetching and exporting takes about 10 seconds.

| Option | Default | Meaning |
|---|---|---|
| `--out` | (required) | Output folder |
| `--zoom` | 20 | Tile detail (at 20, one tile is about 30 m square) |
| `--radius` | 4 | How many tiles to fetch in each direction from the center tile (4 gives 9×9 tiles) |
| `--heights` | 4 | Number of height slabs to request (taller buildings need more) |
| `--jobs` | 4 | Number of concurrent requests |
| `--obj` | none | Also export OBJ (give a file name, e.g. `--obj out/kanazawa.obj`) |
| `--quality` | 90 | JPEG quality of the images |
| `--cache` | `cache` | Where fetched data is saved |

## How it works

1. Like the Apple Maps app, read the configuration (the resource manifest) to get the tile URLs and the values used for authentication
2. Request tiles by position (`x, y, z`) and height slab (`h`)
3. Decode the 3D model that arrives (C3M format). The shapes are compressed with Apple's own scheme, and the images are HEIC
4. Convert them to formats the browser can handle (glb and JPEG) and display them

For the details, and for what makes loading fast, see [docs/how-it-works.en.md](docs/how-it-works.en.md).

## Files

| File | Contents |
|---|---|
| `scripts/earth.py` | Starts the globe viewer |
| `scripts/export.py` | From fetching to export |
| `scripts/serve.py` | A server that only serves exported files locally |
| `scripts/compare_go.py` | Comparison against the Go version |
| `flyover/client.py` | Requests to Apple (manifest, region selection, authentication, tile fetching) |
| `flyover/c3m.py`, `edgebreaker.py`, `huffman.py`, `_fast.py` | Reading and decoding C3M (`_fast.py` is a faster version using numba) |
| `flyover/glb.py`, `terrain.py`, `earth.py`, `earth/` | Server and page for the globe viewer |
| `flyover/web.py` | Export (for the browser and OBJ) |
| `tools/retroplasma-2026.patch` | Fixes for running the Go version against today's Apple servers (for the comparison) |

## Tests

Tests for the parts that can be checked without Apple's data:

```bash
python -m pytest tests -q
```

C3M reading has been checked to **match the original Go version bit for bit** on 209 real tiles (88 in Kanazawa and 121 in Shibuya). The steps to check again are in [docs/how-it-works.en.md](docs/how-it-works.en.md#comparison-with-the-go-version).

## Credits

- The analysis and implementation of [retroplasma/flyover-reverse-engineering](https://github.com/retroplasma/flyover-reverse-engineering) (Go, archived in 2021) were ported to Python. C3M decoding copies that code down to Go's integer overflow behavior. Apple's servers have changed in places since then (as of 2026), and this project is adapted to those changes
- The authentication steps follow the implementation in [sk-zk/streetlevel](https://github.com/sk-zk/streetlevel) (for Look Around)
- The globe is drawn with [CesiumJS](https://cesium.com/platform/cesiumjs/), and place search uses [OpenStreetMap's Nominatim](https://nominatim.openstreetmap.org/)

## Notes

- Fetched data (`cache/`, `out/`) is Apple's copyrighted material. It is kept out of the repository (`.gitignore`). Do not publish or redistribute it
- Apple's servers can change without notice, which may break this tool
- The server only accepts connections from your own PC (127.0.0.1–127.0.0.17)
- The original, retroplasma/flyover-reverse-engineering, has no license, so this repository has no license either
