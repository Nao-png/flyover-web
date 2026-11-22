"""夜景の街灯用の道路データ（OpenStreetMap）。

OpenFreeMap（https://openfreemap.org）の無料のベクタータイル（OpenMapTiles の形、ズーム 14 まで）から、
transportation 層の道路と、landuse・aeroway 層の投光器で照らされる範囲（水面・商業地・線路・競技場は areas）を読み、Flyover のタイルの範囲を上から見た道路の画像（256 px 四方）にする。
データは © OpenStreetMap contributors（ODbL）、タイルは OpenMapTiles。取ったタイルは cache/osm/ に置く。

ベクタータイル（Mapbox Vector Tile）は protobuf で、ここでは必要な所だけを読む:
  Tile { 3: Layer }、Layer { 1: name, 2: Feature, 3: keys, 4: values, 5: extent }、
  Feature { 2: tags（キーと値の番号の組）, 3: type（2 が線）, 4: geometry }、Value { 1: string, 4: int, 5: uint, 6: sint, 7: bool }。
geometry は (命令 | 回数 << 3) と、ジグザグにした座標の差の並び（1 MoveTo、2 LineTo、7 ClosePath）。
"""
import io
import math
import os
import threading
import time

import httpx

TILEJSON = "https://tiles.openfreemap.org/planet"
# 夜の明るさ: NASA の Black Marble（2016 年、衛星 Suomi NPP の VIIRS。GIBS の地図タイル、ズーム 8 まで。登録は要らない）
BLACK_MARBLE = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/"
                "GoogleMapsCompatible_Level8/{z}/{y}/{x}.png")
BM_ZOOM = 8
ZOOM = 14                     # ベクタータイルの一番細かいズーム
SIZE = 256                    # 道路の画像の大きさ [px]（夜景で建物のタイルごとに GPU に載せるので小さめ）
CIRC = 40075016.686           # 赤道の長さ [m]

# 道路の種類 -> (幅 [m], 明るさ 0〜255)。歩道・線路・航路などは入れない
ROADS = {
    "motorway": (22, 255), "trunk": (20, 255), "primary": (16, 240), "secondary": (12, 215),
    "tertiary": (9, 190), "minor": (6, 160), "service": (4, 100), "raceway": (8, 120),
    "busway": (6, 160), "bus_guideway": (6, 160),
}
# 夜に投光器で照らされる範囲（層, 種類） -> 明るさ 0〜255。港の埠頭や工場の構内（landuse の industrial）と、空港の
# エプロン（aeroway の apron）。上空から見た夜景では、橙の塊に見える
AREAS = {("landuse", "industrial"): 160, ("aeroway", "apron"): 255}


def _varint(b, i):
    v = s = 0
    while True:
        c = b[i]
        i += 1
        v |= (c & 0x7F) << s
        if c < 0x80:
            return v, i
        s += 7


def _fields(b, start=0, end=None):
    """protobuf の (番号, 形, 値) を順に。形 2（長さ付き）の値は (始め, 終わり)。"""
    i, end = start, len(b) if end is None else end
    while i < end:
        key, i = _varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            n, i = _varint(b, i)
            v, i = (i, i + n), i + n
        elif t == 1:
            v, i = b[i:i + 8], i + 8
        elif t == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError(f"protobuf の形 {t} は読めない")
        yield f, t, v


def _packed(b, se):
    out, i = [], se[0]
    while i < se[1]:
        v, i = _varint(b, i)
        out.append(v)
    return out


def _value(b, se):
    for f, t, v in _fields(b, *se):
        if f == 1:
            return bytes(b[v[0]:v[1]]).decode("utf-8", "replace")
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
    return None


def _lines(geom):
    """線の geometry -> 線の並び（点はタイルの中の整数の座標）。"""
    lines, cur, x, y, i = [], None, 0, 0, 0
    while i < len(geom):
        cmd, n = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd in (1, 2):
            for _ in range(n):
                dx, dy = geom[i], geom[i + 1]
                i += 2
                x += (dx >> 1) ^ -(dx & 1)
                y += (dy >> 1) ^ -(dy & 1)
                if cmd == 1:
                    cur = [(x, y)]
                    lines.append(cur)
                else:
                    cur.append((x, y))
        elif cmd == 7 and cur:
            cur.append(cur[0])
    return lines


def _signed_area(ring):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:]))


def features(data, layers):
    """ベクタータイルのバイト列 -> (extent, [(層, タグ, 形, 線の並び), ...])。layers の層だけ。形は 1 点、2 線、3 面。"""
    out, extent = [], 4096
    for f, t, se in _fields(data):
        if f != 3:
            continue
        name, feats, keys, vals = None, [], [], []
        for lf, lt, lv in _fields(data, *se):
            if lf == 1:
                name = bytes(data[lv[0]:lv[1]]).decode()
            elif lf == 2:
                feats.append(lv)
            elif lf == 3:
                keys.append(bytes(data[lv[0]:lv[1]]).decode())
            elif lf == 4:
                vals.append(lv)
            elif lf == 5:
                extent = lv
        if name not in layers:
            continue
        for fs in feats:
            tags, typ, geom = {}, 0, []
            for ff, ft, fv in _fields(data, *fs):
                if ff == 2:
                    p = _packed(data, fv)
                    for k in range(0, len(p) - 1, 2):
                        tags[keys[p[k]]] = _value(data, vals[p[k + 1]])
                elif ff == 3:
                    typ = fv
                elif ff == 4:
                    geom = _packed(data, fv)
            out.append((name, tags, typ, _lines(geom)))
    return extent, out


def _rings(lines):
    """面の輪 -> [(外側か, 輪), ...]（外側は画面の座標で時計回り、面積が正）"""
    return [(_signed_area(r) > 0, r) for r in lines if len(r) >= 4]


def roads(data):
    """ベクタータイルのバイト列 -> (extent, [(種類, 橋か, 線), ...], [(明るさ, [(外側か, 輪), ...]), ...])。
    道路にトンネルは入れない。範囲は AREAS のもの"""
    extent, fs = features(data, ("transportation", "landuse", "aeroway"))
    out, areas = [], []
    for name, tags, typ, lines in fs:
        cls = tags.get("class")
        if name != "transportation":
            v = AREAS.get((name, cls))
            if typ == 3 and v:
                areas.append((v, _rings(lines)))
        elif typ == 2 and cls in ROADS and tags.get("brunnel") != "tunnel":
            out.append((cls, tags.get("brunnel") == "bridge", lines))
    return extent, out, areas


class OSM:
    """OpenFreeMap のタイルを取って cache/osm/ に置き、Flyover のタイルの道路の画像を作る。"""

    def __init__(self, cache_dir):
        self.dir = os.path.join(cache_dir, "osm")
        self.http = httpx.Client(timeout=30, headers={"User-Agent": "flyover-web"}, follow_redirects=True)
        self._url = None
        self._url_at = 0
        self._locks = {}
        self._lock = threading.Lock()

    def _template(self):
        # タイルの URL には版（日付）が入るので、TileJSON から 1 日ごとに取り直す
        if self._url is None or time.time() - self._url_at > 86400:
            j = self.http.get(TILEJSON).json()
            self._url, self._url_at = j["tiles"][0], time.time()
        return self._url

    def tile(self, x, y):
        """ズーム 14 のタイルのバイト列（cache/osm/14/x_y.pbf）。"""
        path = os.path.join(self.dir, str(ZOOM), f"{x}_{y}.pbf")
        return self._fetch(path, self._template().format(z=ZOOM, x=x, y=y))

    def _fetch(self, path, url):
        with self._lock:
            lock = self._locks.setdefault(path, threading.Lock())
        with lock:
            if not os.path.exists(path):
                r = self.http.get(url)
                r.raise_for_status()
                os.makedirs(os.path.dirname(path), exist_ok=True)
                tmp = f"{path}.{threading.get_ident()}.tmp"
                open(tmp, "wb").write(r.content)
                os.replace(tmp, path)
            return open(path, "rb").read()

    def night_light(self, z, x, y):
        """Flyover のタイル（z/x/y）の範囲の夜の明るさ（Black Marble）を SIZE px 四方の白黒の画像（0〜255）にする。
        Black Marble のタイル（ズーム 8、1 画素 約 500 m）は cache/blackmarble/8/x_y.png に置き、なめらかに引き伸ばす。"""
        from PIL import Image

        k = 1 << (z - BM_ZOOM)
        bx, by = x // k, y // k
        path = os.path.join(os.path.dirname(self.dir), "blackmarble", str(BM_ZOOM), f"{bx}_{by}.png")
        im = Image.open(io.BytesIO(self._fetch(path, BLACK_MARBLE.format(z=BM_ZOOM, x=bx, y=by)))).convert("L")
        n = im.width / k                                  # Flyover のタイル 1 枚が Black Marble の何画素か
        x0, y0 = (x % k) * n, (y % k) * n
        # 1 画素ぶん広く切り出して引き伸ばし、真ん中を使う（タイルの縁でつながるよう、画素の中心で合わせる）
        return im.transform((SIZE, SIZE), Image.Transform.EXTENT, (x0, y0, x0 + n, y0 + n), Image.Resampling.BILINEAR)

    def _cover(self, z, x, y):
        """Flyover のタイル（z/x/y）にかかるズーム 14 のタイルと、1 px が何 m か"""
        if z >= ZOOM:
            k = 1 << (z - ZOOM)
            cover = [(x // k, y // k)]
        else:
            k = 1 << (ZOOM - z)
            cover = [(x * k + i, y * k + j) for i in range(k) for j in range(k)]
        n = 1 << z
        lat = math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n)))
        return cover, CIRC * math.cos(lat) / n / SIZE

    def _to_px(self, z, x, y, tx, ty, extent):
        n = 1 << z
        s = SIZE * n / (1 << ZOOM)                         # ベクタータイル 1 枚が何 px か
        ox, oy = (tx * n / (1 << ZOOM) - x) * SIZE, (ty * n / (1 << ZOOM) - y) * SIZE
        return lambda ln: [(ox + px / extent * s, oy + py / extent * s) for px, py in ln]

    def areas(self, z, x, y):
        """夜景の範囲の PNG（SIZE px 四方、北が上）。赤: 水面（water 層の面と、waterway 層の川・運河）、
        緑: 商業地（landuse の commercial・retail。店先とネオン）、青: 線路（線 90、操車場など 140、駅のまわり 255）、
        アルファ: 255 から競技場（stadium 255、運動場 pitch 170。夜間照明）を引いたもの（アルファが 0 の画素は、ブラウザーが
        画像を開くときに色を消すことがあるので、ふだんは 255 にしておく）。トンネルは入れない。ズーム 13〜20。"""
        from PIL import Image, ImageDraw

        cover, mpp = self._cover(z, x, y)
        bands = [Image.new("L", (SIZE, SIZE), 0) for _ in range(4)]
        dw, dc, dr, ds = (ImageDraw.Draw(b) for b in bands)

        def width(m):
            return max(1, round(m / mpp))

        def disc(d, pt, m, v):
            r = m / mpp
            d.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=v)

        kinds = {"commercial": (dc, 200), "retail": (dc, 255), "railway": (dr, 140), "stadium": (ds, 255), "pitch": (ds, 170)}
        for tx, ty in cover:
            extent, fs = features(self.tile(tx, ty), ("water", "waterway", "landuse", "transportation", "poi"))
            px = self._to_px(z, x, y, tx, ty, extent)
            for name, tags, typ, lines in fs:
                cls, tunnel = tags.get("class"), tags.get("brunnel") == "tunnel"
                if name == "water" and typ == 3 and cls != "swimming_pool":
                    for outer, r in _rings(lines):
                        dw.polygon(px(r), fill=255 if outer else 0)
                elif name == "waterway" and typ == 2 and cls in ("river", "canal") and not tunnel:
                    for ln in lines:
                        if len(ln) >= 2:
                            dw.line(px(ln), fill=255, width=width(25 if cls == "river" else 12))
                elif name == "landuse" and typ == 3 and cls in kinds:
                    d, v = kinds[cls]
                    for outer, r in _rings(lines):
                        d.polygon(px(r), fill=v if outer else 0)
                elif name == "transportation" and typ == 2 and cls in ("rail", "transit") and not tunnel:
                    for ln in lines:
                        if len(ln) >= 2:
                            dr.line(px(ln), fill=90, width=width(8))
                elif name == "poi" and typ == 1:
                    sub = tags.get("subclass")
                    for ln in lines:
                        if cls == "railway" and sub in ("station", "halt"):
                            disc(dr, px(ln)[0], 70, 255)
                        elif cls == "stadium":
                            disc(ds, px(ln)[0], 80, 255)
        bands[3] = bands[3].point(lambda v: 255 - v)
        img = Image.merge("RGBA", bands)
        out = io.BytesIO()
        img.save(out, "PNG", optimize=False, compress_level=1)
        return out.getvalue()

    def night_tile(self, z, x, y):
        """遠くの地面（Flyover のない所）用の夜の明るさの PNG（白黒、256 px 四方）。ズーム 8 までは Black Marble の
        タイルそのもの、9 より細かいときはズーム 8 のタイルから切り出して引き伸ばす。"""
        from PIL import Image

        if z <= BM_ZOOM:
            path = os.path.join(os.path.dirname(self.dir), "blackmarble", str(z), f"{x}_{y}.png")
            im = Image.open(io.BytesIO(self._fetch(path, BLACK_MARBLE.format(z=z, x=x, y=y)))).convert("L")
        else:
            im = self.night_light(z, x, y)
        out = io.BytesIO()
        im.save(out, "PNG", optimize=False, compress_level=1)
        return out.getvalue()

    def image(self, z, x, y):
        """Flyover のタイル（z/x/y）の範囲を上から見た道路の PNG（SIZE px 四方、北が上）。赤: 道路（種類で明るさ）、
        緑: 高架（橋）、青: 投光器で照らされる範囲（AREAS）、アルファ: 夜の明るさ（Black Marble。取れなければ 160）。
        ズーム 13〜20。"""
        from PIL import Image, ImageDraw

        cover, mpp = self._cover(z, x, y)
        road = Image.new("L", (SIZE, SIZE), 0)
        bridge = Image.new("L", (SIZE, SIZE), 0)
        flood = Image.new("L", (SIZE, SIZE), 0)
        dr, db, df = ImageDraw.Draw(road), ImageDraw.Draw(bridge), ImageDraw.Draw(flood)
        items = []
        for tx, ty in cover:
            extent, rs, areas = roads(self.tile(tx, ty))
            px = self._to_px(z, x, y, tx, ty, extent)
            for v, rings in areas:
                for outer, ring in rings:
                    df.polygon(px(ring), fill=v if outer else 0)
            for cls, br, lines in rs:
                for ln in lines:
                    items.append((ROADS[cls][1], cls, br, px(ln)))
        items.sort(key=lambda it: it[0])                   # 細い道から描いて、太い道で上書きする
        for v, cls, br, pts in items:
            w = max(1, round(ROADS[cls][0] / mpp))
            if len(pts) >= 2:
                dr.line(pts, fill=v, width=w, joint="curve")
                if br:
                    db.line(pts, fill=255, width=w, joint="curve")
        try:
            light = self.night_light(z, x, y)
        except (httpx.HTTPError, OSError):
            light = Image.new("L", (SIZE, SIZE), 160)
        # アルファが 0 の画素は、ブラウザーが画像を開くときに色を消すことがあるので 1 以上にする
        img = Image.merge("RGBA", (road, bridge, flood, light.point(lambda v: max(v, 1))))
        out = io.BytesIO()
        img.save(out, "PNG", optimize=False, compress_level=1)
        return out.getvalue()
