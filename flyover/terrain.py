"""地球儀の地形。Apple の地形タイル（style 17）を、Cesium の地理座標のタイル
（GeographicTilingScheme、ズーム 0 で東西 2 枚）の高さの格子に直す。

Apple の地形は Web メルカトルの 256 px の PNG（16 bit）。PNG の終わり（IEND）の後ろに 12 バイト
付いていて、float32 の基準の高さと倍率（0.25）が入っている: 高さ = 基準 + 値 × 倍率。高さは
Flyover の頂点と同じ楕円体高（海面はジオイド高になる）。基準はタイルごとに違う（タイルの中で
いちばん低い所）ので、読み落とすと内陸では何百 m も低くなる。ズーム 7 と 11 は全世界、13 は
米国と欧州だけにある。地形のタイルがない所は、海面（EGM96 のジオイド高）にする。
"""
import io
import math
import os
import struct
import threading
from collections import OrderedDict

import numpy as np

SIZE = 65                     # 1 タイルの格子の点の数（一辺）
GEOID_URL = "https://cdn.proj.org/us_nga_egm96_15.tif"   # EGM96、15 分ごと（PROJ の配布物）
# Flyover の地面より地形がわずかに高いと、建物の足もとに地形の面が突き出る（地形は 1 画素が
# 数十 m で、谷が埋まる）。地形を少し下げてそれを隠す。
DROP = 8.0


def decode_dtm(b):
    """Apple の地形の PNG を、楕円体高 [m] の 256 x 256 の float32 に。"""
    from PIL import Image

    a = np.asarray(Image.open(io.BytesIO(b)), np.float32)
    base, scale = 0.0, 0.25
    i = b.rfind(b"IEND")
    if i >= 0 and len(b) >= i + 16:          # IEND の種類 4 バイトと CRC 4 バイトの後ろ
        base, scale = struct.unpack_from("<2f", b, i + 8)
    return base + a * scale


class Geoid:
    """EGM96 のジオイド高 [m]。初めて使うときに cache に落とす（2.7 MB）。"""

    def __init__(self, cache_dir, http):
        path = os.path.join(cache_dir, "egm96_15.tif")
        if not os.path.exists(path):
            r = http.get(GEOID_URL, timeout=120)
            r.raise_for_status()
            open(path + ".tmp", "wb").write(r.content)
            os.replace(path + ".tmp", path)
        from PIL import Image

        g = np.asarray(Image.open(path), np.float32)          # 721 x 1440、点は (90 - j/4, -180 + i/4)
        self.grid = np.concatenate([g, g[:, :1]], axis=1)     # 経度 180 度を 1 列足して折り返しを省く

    def height(self, lat, lon):
        fy = (90 - np.asarray(lat, np.float64)) * 4
        fx = (np.asarray(lon, np.float64) + 180) % 360 * 4
        return _bilinear(self.grid, fy, fx)


def _bilinear(a, fy, fx):
    fy = np.clip(fy, 0, a.shape[0] - 1)
    fx = np.clip(fx, 0, a.shape[1] - 1)
    y0 = np.minimum(fy.astype(int), a.shape[0] - 2)
    x0 = np.minimum(fx.astype(int), a.shape[1] - 2)
    ty, tx = fy - y0, fx - x0
    return ((a[y0, x0] * (1 - tx) + a[y0, x0 + 1] * tx) * (1 - ty)
            + (a[y0 + 1, x0] * (1 - tx) + a[y0 + 1, x0 + 1] * tx) * ty)


def tile_grid(level, x, y):
    """地理座標のタイルの格子点の (緯度, 経度)（度）。北西の角から、行ごとに東へ。"""
    size = 180 / (1 << level)
    t = np.arange(SIZE) / (SIZE - 1)
    lon = -180 + (x + t) * size
    lat = 90 - (y + t) * size
    return np.meshgrid(lat, lon, indexing="ij")


def mercator_px(lat, lon, z):
    """ズーム z の Web メルカトルの画素の座標（全体で通し、画素の中心が整数）。"""
    lat = np.clip(lat, -85.0511, 85.0511)
    n = 256 << z
    fx = (np.asarray(lon) + 180) / 360 * n - 0.5
    fy = (1 - np.arcsinh(np.tan(np.radians(lat))) / math.pi) / 2 * n - 0.5
    return fx, fy


class Terrain:
    def __init__(self, client, geoid, fetch_many):
        """fetch_many(関数, 引数の並び): 並行して呼んで結果を並びで返す。"""
        self.client, self.geoid, self.fetch_many = client, geoid, fetch_many
        self.zooms = client.dtm_zooms() or [7, 11]
        self._tiles, self._lock = OrderedDict(), threading.Lock()

    def _available(self, level, x, y):
        """このタイルの中心で地形のあるズーム（小さい順）。"""
        lat, lon = tile_grid(level, x, y)
        lat, lon = lat[SIZE // 2, SIZE // 2], lon[SIZE // 2, SIZE // 2]
        out = []
        for z in self.zooms:
            fx, fy = mercator_px(lat, lon, z)
            if self.client.dtm_available(int(fx + 0.5) // 256, int(fy + 0.5) // 256, z):
                out.append(z)
        return out

    def source_zoom(self, level, x, y):
        """(このタイルに使う地形のズーム（なければ None、ジオイドだけにする）, これより細かい
        タイルを作っても地形が細かくならないか)。"""
        want = level - 1                 # 65 点の格子の間隔と、256 px の画素の大きさがほぼそろう
        zs = self._available(level, x, y)
        if not zs:
            return None, level >= 6
        leaf = level >= zs[-1] + 1
        if want < 5:                     # 遠すぎて地形が見えない。取るタイルも多すぎる
            return None, leaf
        return next((z for z in zs if z >= want), zs[-1]), leaf

    def _dtm(self, x, y, z):
        key = (x, y, z)
        with self._lock:
            if key in self._tiles:
                self._tiles.move_to_end(key)
                return self._tiles[key]
        b = self.client.dtm(x, y, z)
        a = decode_dtm(b) if b else None
        with self._lock:
            self._tiles[key] = a
            while len(self._tiles) > 400:
                self._tiles.popitem(last=False)
        return a

    def heights(self, level, x, y):
        """(楕円体高 [m] の SIZE x SIZE の float32, これより細かいものがないか)。"""
        lat, lon = tile_grid(level, x, y)
        h = self.geoid.height(lat, lon)          # 地形のタイルがない所は海面
        z, leaf = self.source_zoom(level, x, y)
        if z is not None:
            fx, fy = mercator_px(lat, lon, z)
            n = 1 << z
            x0, x1 = int(np.floor(fx.min())) // 256, int(np.floor(fx.max()) + 1) // 256
            y0, y1 = max(0, int(np.floor(fy.min())) // 256), min(n - 1, (int(np.floor(fy.max())) + 1) // 256)
            keys = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
            tiles = self.fetch_many(lambda k: self._dtm(k[0] % n, k[1], z), keys)
            mosaic = np.full(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.nan, np.float32)
            for (tx, ty), a in zip(keys, tiles):
                if a is not None:
                    mosaic[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = a
            d = _bilinear(mosaic, fy - y0 * 256, fx - x0 * 256)
            h = np.where(np.isnan(d), h, d)
        return (h - DROP).astype("<f4"), leaf
