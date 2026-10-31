"""ある地点のまわりの Flyover を取得して、ブラウザで見る一式を書き出す。

    python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya
    python scripts/export.py --bbox 34.6418 135.3729 34.6601 135.4045 --r3d --quality 100 \\
        --block 15 --out out/yumeshima
    python scripts/serve.py out

ズーム --zoom（既定 20、1 タイル約 30 m 四方）で、中心のタイルから ±--radius タイルの範囲（--bbox
なら南・西・北・東の緯度経度の範囲）を要求する。高さ区分は、ビューアと同じく、最後に要求した区分に
データがあれば上も要求する。データのないタイルは飛ばす。--r3d なら新しい Flyover（R3D）を使い、
R3D がないか読めないタイルだけ C3M にする。--block N なら N x N タイルずつ別のフォルダに書き出し、
その一覧の index.html を --out に置く（広い範囲を 1 枚のページにすると、画像が GPU に載りきらない）。
取得したタイルは --cache に保存し、次からはそれを使う。--obj を付けると OBJ にも書き出す。

取得したデータは Apple の著作物。リポジトリには入れないこと。
"""
import argparse
import html
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flyover  # noqa: E402
from flyover import r3d, web  # noqa: E402
from flyover.earth import fetch_heights, parse_heights  # noqa: E402


def tile_lat_lon(x, y, z):
    """タイルの北西の角の緯度経度。"""
    n = 2 ** z
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))), x / n * 360 - 180


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("lon", type=float, nargs="?")
    ap.add_argument("--bbox", type=float, nargs=4, metavar=("S", "W", "N", "E"),
                    help="中心と --radius の代わりに、緯度経度の範囲で指定する")
    ap.add_argument("--out", required=True, help="書き出すフォルダ")
    ap.add_argument("--zoom", type=int, default=20)
    ap.add_argument("--radius", type=int, default=4, help="中心から何タイルまで（±）")
    ap.add_argument("--r3d", action="store_true", help="新しい Flyover（R3D）を使う")
    ap.add_argument("--block", type=int, help="N x N タイルずつ別のフォルダに書き出す")
    ap.add_argument("--jobs", type=int, default=8, help="同時に取得するタイルの数")
    ap.add_argument("--cache", default="cache", help="マニフェストとタイルの保存先")
    ap.add_argument("--obj", help="OBJ にも書き出す（ファイル名。--block なら各フォルダに置く）")
    ap.add_argument("--quality", type=int, default=90, help="画像の JPEG の画質（95 以上なら色を間引かない）")
    ap.add_argument("--hevc", action="store_true",
                    help="新しい Flyover の画像を JPEG にせず HEVC のまま書く（速いが、HEVC を GPU で展開できるブラウザ専用）")
    a = ap.parse_args()

    z = a.zoom
    if a.bbox:
        s, w, n, e = a.bbox
        x0, y0 = flyover.tile_xy(n, w, z)
        x1, y1 = flyover.tile_xy(s, e, z)
    elif a.lat is not None and a.lon is not None:
        xc, yc = flyover.tile_xy(a.lat, a.lon, z)
        x0, y0, x1, y1 = xc - a.radius, yc - a.radius, xc + a.radius, yc + a.radius
    else:
        ap.error("緯度経度か --bbox が要る")
    client = flyover.Client(cache_dir=a.cache)
    if a.r3d and client.r3d_source() is None:
        sys.exit("iOS 27 のマニフェストに新しい Flyover（style 98）がない")
    print(f"タイル x={x0}〜{x1} y={y0}〜{y1} z={z}（{(x1 - x0 + 1) * (y1 - y0 + 1)} 枚）", flush=True)

    def get(xy):
        """(x, y) -> (形式, [(名前, C3M)]、読めなかった区分の数)。"""
        x, y = xy
        region = client.region_of_tile(x, y, z)
        if region is None:
            return xy, None, [], 0
        if a.r3d:
            raws = fetch_heights(z, lambda hs: [client.r3d_tile_cached(region, x, y, z, h) for h in hs])
            if any(raws):
                tiles, failed = cpu.submit(parse_heights, raws, r3d.parse).result()
                if not failed:
                    return xy, "r3d", [(f"{x}_{y}_{h}", c) for h, c in tiles], 0
                # 1 区分でも読めなければタイルごと C3M にする（ビューアと同じ）
                print(f"  {x} {y}: R3D が読めないので C3M にする（{failed[0][1]}）", flush=True)
        raws = fetch_heights(z, lambda hs: [client.tile_cached(region, x, y, z, h) for h in hs])
        tiles, failed = cpu.submit(parse_heights, raws).result()
        for h, e in failed:
            print(f"  {x} {y} h={h}: {e}", flush=True)
        return xy, "c3m" if tiles else None, [(f"{x}_{y}_{h}", c) for h, c in tiles], len(failed)

    bs = a.block or max(x1 - x0, y1 - y0) + 1
    blocks = [(r, c) for r in range((y1 - y0) // bs + 1) for c in range((x1 - x0) // bs + 1)]
    done, t = {}, time.time()
    # 取得はスレッドで、読むのは別のプロセスで並べる（読む処理の多くは GIL を放さない）
    with ThreadPoolExecutor(a.jobs) as pool, ProcessPoolExecutor(os.cpu_count()) as cpu:
        for r, c in blocks:
            bx0, by0 = x0 + c * bs, y0 + r * bs
            bx1, by1 = min(bx0 + bs - 1, x1), min(by0 + bs - 1, y1)
            xys = [(x, y) for y in range(by0, by1 + 1) for x in range(bx0, bx1 + 1)]
            out = os.path.join(a.out, f"{r}_{c}") if a.block else a.out
            tiles, count, failed = [], {"r3d": 0, "c3m": 0}, 0
            for k, (_, kind, got, f) in enumerate(pool.map(get, xys)):
                if kind:
                    count[kind] += 1
                tiles += got
                failed += f
                if (k + 1) % 100 == 0:
                    print(f"  {k + 1}/{len(xys)}", flush=True)
            name = f"区画 {r}_{c}: " if a.block else ""
            print(f"{name}R3D {count['r3d']} 枚・C3M {count['c3m']} 枚（読めなかった区分 {failed}）、"
                  f"{time.time() - t:.0f} 秒", flush=True)
            if not tiles:
                continue
            # 区画の中心の緯度経度
            (n_, w_), (s_, e_) = tile_lat_lon(bx0, by0, z), tile_lat_lon(bx1 + 1, by1 + 1, z)
            lat, lon = (n_ + s_) / 2, (w_ + e_) / 2
            region = client.region_of_tile((bx0 + bx1) // 2, (by0 + by1) // 2, z)
            try:
                nt, size = web.write(tiles, out, {"lat": lat, "lon": lon,
                                                  "region": region["name"] if region else ""}, a.quality, a.hevc)
            except ValueError as e:   # 範囲の端の帯しかない
                print(f"  書き出さない（{e}）", flush=True)
                continue
            print(f"  {nt} 三角形、{size[0]:.0f} x {size[1]:.0f} x {size[2]:.0f} m -> {out}", flush=True)
            if a.obj:
                path = os.path.join(out, os.path.basename(a.obj)) if a.block else a.obj
                web.write_obj(tiles, path, a.quality)
                print(f"  OBJ -> {path}", flush=True)
            done[r, c] = (lat, lon, nt, count["r3d"] + count["c3m"])
    if not done:
        sys.exit("この範囲に Flyover のデータがない")
    if a.block:
        write_index(a.out, blocks, done)
    print(f"見るには: python scripts/serve.py {os.path.dirname(os.path.abspath(a.out))}")


def write_index(out, blocks, done):
    """区画の一覧（北が上の格子）。"""
    rows, cols = max(r for r, _ in blocks) + 1, max(c for _, c in blocks) + 1
    cells = []
    for r in range(rows):
        for c in range(cols):
            if (r, c) in done:
                lat, lon, nt, n = done[r, c]
                cells.append(f'<a href="{r}_{c}/"><b>{r}_{c}</b><br>{n} タイル<br>{nt / 1e6:.1f} 百万三角形<br>'
                             f'<small>{lat:.4f}, {lon:.4f}</small></a>')
            else:
                cells.append("<span></span>")
    page = f"""<!DOCTYPE html>
<meta charset="utf-8">
<title>Flyover の区画</title>
<style>
  body {{ margin: 16px; background: #0b0d10; color: #cfd6dd; font: 13px/1.5 system-ui, sans-serif; }}
  .grid {{ display: grid; grid-template-columns: repeat({cols}, minmax(0, 120px)); gap: 6px; }}
  .grid a, .grid span {{ display: block; padding: 8px; border-radius: 6px; min-height: 72px; }}
  .grid a {{ background: #1c232b; color: #cfd6dd; text-decoration: none; }}
  .grid a:hover {{ background: #2b3642; }}
  .grid span {{ background: #12161a; }}
</style>
<h3>{html.escape(os.path.basename(os.path.abspath(out)))}（北が上）</h3>
<div class="grid">{"".join(cells)}</div>
"""
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(page)


if __name__ == "__main__":
    main()
