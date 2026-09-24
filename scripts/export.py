"""ある地点のまわりの Flyover を取得して、ブラウザで見る一式を書き出す。

    python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya
    python scripts/serve.py out/higashi-chaya

ズーム --zoom（既定 20、1 タイル約 30 m 四方）で、中心のタイルから ±--radius タイルの
範囲を、高さ区分 h = 0〜--heights-1 について要求する。データのないタイルは飛ばす。
取得した C3M は --cache に保存し、次からはそれを使う。--obj を付けると OBJ にも書き出す。

取得したデータは Apple の著作物。リポジトリには入れないこと。
"""
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flyover  # noqa: E402
from flyover import web  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--out", required=True, help="書き出すフォルダ")
    ap.add_argument("--zoom", type=int, default=20)
    ap.add_argument("--radius", type=int, default=4, help="中心から何タイルまで（±）")
    ap.add_argument("--heights", type=int, default=4, help="要求する高さ区分の数")
    ap.add_argument("--jobs", type=int, default=4, help="同時に要求する数")
    ap.add_argument("--cache", default="cache", help="マニフェストとタイルの保存先")
    ap.add_argument("--obj", help="OBJ にも書き出す（ファイル名）")
    ap.add_argument("--quality", type=int, default=90, help="画像の JPEG の画質")
    a = ap.parse_args()

    client = flyover.Client(cache_dir=a.cache)
    region = client.region(a.lat, a.lon)
    x0, y0 = flyover.tile_xy(a.lat, a.lon, a.zoom)
    print(f"地域 {region['name']}（region {region['region']}、版 {region['version']}）、"
          f"タイル x={x0} y={y0} z={a.zoom}", flush=True)
    def tile_dir(x, y):
        r = client.region_of_tile(x, y, a.zoom)
        d = os.path.join(a.cache, "c3m", f"{r['region']}_{r['version']}")
        os.makedirs(d, exist_ok=True)
        return d

    jobs = [(x0 + dx, y0 + dy, h) for dx in range(-a.radius, a.radius + 1)
            for dy in range(-a.radius, a.radius + 1) for h in range(a.heights)]

    def get(job):
        x, y, h = job
        path = os.path.join(tile_dir(x, y), f"{a.zoom}_{x}_{y}_{h}.c3m")
        empty = path + ".empty"
        if os.path.exists(path):
            return job, open(path, "rb").read()
        if os.path.exists(empty):
            return job, None
        b = client.tile(client.region_of_tile(x, y, a.zoom), x, y, a.zoom, h)
        if b is None:
            open(empty, "wb").close()
        else:
            open(path, "wb").write(b)
        return job, b

    t = time.time()
    tiles, failed = [], 0
    with ThreadPoolExecutor(a.jobs) as pool:
        for k, ((x, y, h), b) in enumerate(pool.map(get, jobs)):
            if b:
                try:
                    tiles.append((f"{x}_{y}_{h}", flyover.parse(b)))
                except Exception as e:   # 読めないタイルは飛ばす
                    failed += 1
                    print(f"  {x} {y} h={h}: {e}")
            if (k + 1) % 50 == 0:
                print(f"  {k + 1}/{len(jobs)}  タイル {len(tiles)} 枚", flush=True)
    print(f"{len(jobs)} 回要求してタイル {len(tiles)} 枚（読めなかったもの {failed}）、"
          f"{time.time() - t:.0f} 秒", flush=True)
    if not tiles:
        sys.exit("この範囲に Flyover のデータがない")

    nt, size = web.write(tiles, a.out, {"lat": a.lat, "lon": a.lon, "region": region["name"]},
                         a.quality)
    print(f"{nt} 三角形、{size[0]:.0f} x {size[1]:.0f} x {size[2]:.0f} m -> {a.out}")
    if a.obj:
        web.write_obj(tiles, a.obj, a.quality)
        print(f"OBJ -> {a.obj}")
    print(f"見るには: python scripts/serve.py {a.out}")


if __name__ == "__main__":
    main()
