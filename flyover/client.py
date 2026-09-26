"""Apple Maps のサーバーから Flyover のタイルを取る。

流れ（retroplasma/flyover-reverse-engineering の pkg/mps、pkg/fly、cmd/export-obj と同じ）:

1. リソースマニフェスト（protobuf）を取り、C3M の URL と認証の tokenP2 を得る
2. そこに書かれた高さ区分の一覧（altitude-*.xml）から、地点を含む地域を選ぶ
3. タイル（style 15）を x, y, z, h で要求する。URL には認証（AES の accessKey）を付ける

2026 年の時点で当時から変わっていたこと:
- マニフェストのファイル置き場（cache_base_url）が空 → gspe21-ssl.ls.apple.com を使う
- 地域ごとの目録 C3MM 第 1 版（style 14）が 404 → 目録を使わず、タイルを直接要求して
  空の応答を飛ばす

地域は、名前 Reg_z9_X_Y が示すズーム 9 のタイルで選ぶ（元のツールは中心がいちばん近い
地域を選んでいて、地域の重なる東京などでは外れる）。
"""
import asyncio
import base64
import hashlib
import math
import os
import random
import re
import string
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse

import requests
import requests.adapters

MANIFEST_URL = ("https://gspe35-ssl.ls.apple.com/geo_manifest/dynamic/config?application=geod"
                "&application_version=1&country_code=US&hardware=MacBookPro11,2&os=osx"
                "&os_build=20B29&os_version=11.0.1")
CACHE_BASE = "https://gspe21-ssl.ls.apple.com/"
TOKEN_P1 = "4cjLaD4jGRwlQ9U"      # GeoServices の GEOURLAuthenticationGenerateURL にある値
STYLE_SATELLITE = 7               # 衛星画像（JPEG、256 px のタイル）
STYLE_C3M = 15
STYLE_DTM = 17                    # 地形（16 bit の PNG、値は海抜 [m] の 4 倍）
HEDGE = 1.5                       # 応答がこれ [秒] より遅ければ、同じ要求をもう 1 本出す


def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def _fields(b):
    """protobuf を (番号, 型, 値) の並びに（スキーマなしで読む）。"""
    i, out = 0, []
    while i < len(b):
        k, i = _varint(b, i)
        f, t = k >> 3, k & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            n, i = _varint(b, i)
            v, i = b[i:i + n], i + n
        elif t == 1:
            v, i = b[i:i + 8], i + 8
        elif t == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError(f"protobuf の型 {t}")
        out.append((f, t, v))
    return out


class Manifest:
    """リソースマニフェストのうち、ここで使う項目だけ。"""

    def __init__(self, raw):
        self.styles, self.versions, self.ranges, self.cache_files = {}, {}, {}, []
        self.token_p2 = self.cache_base = ""
        for f, t, v in _fields(raw):
            if f == 2 and t == 2:                       # style_config
                sub = {sf: sv for sf, st, sv in _fields(v)}
                if 3 not in sub or 1 not in sub:
                    continue
                style, ver, ranges = sub[3], 0, []
                if 5 in sub:                            # 版と、データのある範囲
                    for vf, vt, vv in _fields(sub[5]):
                        if vf == 1:
                            ver = vv
                        elif vf == 2:   # (x の最小, y の最小, x の最大, y の最大, z の最小, z の最大)
                            r = {rf: rv for rf, rt, rv in _fields(vv)}
                            ranges.append(tuple(r.get(k, 0) for k in range(1, 7)))
                # 同じ style が複数あれば版の新しいほう（地形は版 0 と 32 があり、0 は 410 を返す）
                if style not in self.styles or ver > self.versions[style]:
                    self.styles[style] = sub[1].decode()
                    self.versions[style], self.ranges[style] = ver, ranges
            elif f == 30:
                self.token_p2 = v.decode()
            elif f == 31:
                self.cache_base = v.decode()
            elif f == 72:                               # cache_file
                self.cache_files += [sv.decode() for sf, st, sv in _fields(v) if sf == 2]
            elif f == 9:
                self.cache_files.append(v.decode())

    def file(self, prefix):
        for name in self.cache_files:
            if name.startswith(prefix) and name.endswith(".xml"):
                return name
        raise LookupError(f"マニフェストに {prefix}*.xml がない")


class Net:
    """Apple へのタイルの GET を、別のスレッドで動かす asyncio の httpx（HTTP/2）にまとめる。

    requests（HTTP/1.1）は接続ごとに TLS の確立と証明書の読み込みをするので、何十本も並べると
    応答まで数秒待たされる（同時 32 本で中央値 4 秒）。HTTP/2 なら少ない接続の上に多くの要求を
    並べられる（同時 128 本でも 1 秒ほど）。どのスレッドから呼んでもよい。

    Apple の応答はたまに数秒以上かかり、それが読み込みの最後まで残るので、HEDGE 秒たっても
    返らなければ同じ要求を別の接続でもう 1 本出し、先に返ったほうを使う（遅いほうは取りやめる）。
    それでも返らなければ、待つ時間を倍にしながら TRIES 本まで出す。1 本は TIMEOUT 秒であきらめる。
    接続ごと止まることもある（その接続の要求がどれも返らなくなる）ので、しばらく何も返っていない
    接続で時間切れになったら、その接続を捨てて張り直す。

    回線（手元では 50〜65 Mbps）は Flyover のタイルだけで埋まる。地形と衛星画像（lane="ground"）は
    別の接続で取るが、Flyover のタイル（lane="bulk"）を BUSY 本以上取っている間は、同時に GROUND_BUSY
    本までに絞る。地面の画像の多くは 3D の街の下に隠れるので、先に街に回線を回すほうが早くきれいに
    なる（絞らないと、見えている街の読み込みが 3 秒ほど遅れる）。"""

    CONNECTIONS = 4        # HTTP/2 の接続の数
    STREAMS = 90           # 1 本の接続で同時に出す要求の数（Apple の上限は 100 本）
    TIMEOUT = 10.0         # 1 本の要求をあきらめるまで [秒]（ふだんは 3 秒以内に返る）
    TRIES = 3              # 同じ要求を出す本数の上限
    BUSY = 16              # Flyover のタイルをこれ以上取っている間は、
    GROUND_BUSY = 4        # 地形と衛星画像はこれだけしか並べない

    def __init__(self, http=None):
        import httpx

        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="apple-http2", daemon=True).start()
        # httpx は接続の上限に達しても新しい接続を開かずにエラーにするので、接続ごとに
        # AsyncClient を分け、同時に出す数を数えて空いているほうに振り分ける
        self._make = None if http else (
            lambda: httpx.AsyncClient(http2=True, timeout=60, limits=httpx.Limits(max_connections=1)))
        self.http = [http] if http else [self._make() for _ in range(self.CONNECTIONS)]
        self.busy = [0] * len(self.http)
        self.last_ok = [0.0] * len(self.http)      # 最後に応答が返った時刻（loop.time()）
        self.slots = [asyncio.Semaphore(self.STREAMS) for _ in self.http]
        self.errors = (httpx.TransportError,)
        self.active = {"bulk": 0, "ground": 0}     # lane ごとの要求の数（出し直しは数えない）

    def get(self, make_url, method="GET", lane="bulk"):
        """make_url() の URL を GET した応答。URL は要求を出すたびに作る（認証を付け直す）。
        lane は "ground"（最初の接続を使う）か "bulk"（残りの接続を使う）。"""
        return asyncio.run_coroutine_threadsafe(self._get(make_url, method, lane), self.loop).result()

    def _lane(self, lane):
        n = len(self.http)
        return [0] if n == 1 or lane == "ground" else list(range(1, n))

    def _pick(self, lane, avoid=()):
        """その lane でいちばん空いている接続（avoid のものは、ほかになければ使う）。"""
        own = self._lane(lane)
        free = [i for i in own if i not in avoid] or own
        return min(free, key=lambda i: self.busy[i])

    def _reset(self, i, client):
        """止まった接続を捨てて張り直す（その上の要求は失敗し、それぞれやり直す）。"""
        if self._make is None or self.http[i] is not client:
            return
        self.http[i] = self._make()
        self.last_ok[i] = self.loop.time()
        asyncio.ensure_future(client.aclose())

    async def _one(self, make_url, method, lane, i):
        for attempt in range(2):             # 接続が切れたなどの一時的な失敗は 1 回だけやり直す
            client = self.http[i]
            self.busy[i] += 1
            try:
                async with self.slots[i]:
                    r = await asyncio.wait_for(client.request(method, make_url()), self.TIMEOUT)
                self.last_ok[i] = self.loop.time()
                return r
            except asyncio.TimeoutError:
                # しばらく何も返っていない接続なら、接続ごと止まっているので張り直してやり直す
                if attempt or self.loop.time() - self.last_ok[i] <= self.TIMEOUT / 2:
                    raise
                self._reset(i, client)
                continue
            except self.errors:
                if attempt:
                    raise
            finally:
                self.busy[i] -= 1
            i = self._pick(lane, {i})

    async def _get(self, make_url, method, lane):
        if lane == "ground":
            while self.active["bulk"] >= self.BUSY and self.active["ground"] >= self.GROUND_BUSY:
                await asyncio.sleep(0.05)
        self.active[lane] += 1
        try:
            return await self._hedged(make_url, method, lane)
        finally:
            self.active[lane] -= 1

    async def _hedged(self, make_url, method, lane):
        tasks, used = {}, set()

        def launch():
            i = self._pick(lane, used)
            used.add(i)
            tasks[asyncio.ensure_future(self._one(make_url, method, lane, i))] = i

        launch()
        tries, wait, error = 1, HEDGE, None
        while tasks:
            done, _ = await asyncio.wait(tasks, timeout=wait if tries < self.TRIES else None,
                                         return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                del tasks[t]
                if t.exception() is None:
                    for other in tasks:
                        other.cancel()
                    return t.result()
                error = t.exception()
            # 遅いか、出したものが全部失敗したら、もう 1 本
            if tries < self.TRIES and (not done or not tasks):
                launch()
                tries += 1
                wait *= 2
        raise error


class Client:
    def __init__(self, cache_dir="cache", session=None):
        if session is None:
            session = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=128)
            session.mount("https://", adapter)
        self.http = session                     # マニフェストなどの少ない取得用
        self._net = Net()                       # タイルの取得用（HTTP/2）
        self.sid = "".join(random.choices(string.digits, k=40))
        self.cache_dir = cache_dir
        os.makedirs(cache_dir, exist_ok=True)
        self.manifest = Manifest(self._cached("ResourceManifest.pbd", MANIFEST_URL, max_age=3600))
        name = self.manifest.file("altitude")
        base = self.manifest.cache_base or CACHE_BASE
        self.regions = parse_altitude(self._cached(name, base + "xml/" + name))
        self.c3m_url = self.manifest.styles[STYLE_C3M]
        self._by_tile = {}
        for r in self.regions:
            m = re.fullmatch(r"Reg_z9_(\d+)_(\d+)", r["name"] or "")
            if m:
                self._by_tile[(int(m[1]), int(m[2]))] = r

    def _cached(self, name, url, max_age=None):
        path = os.path.join(self.cache_dir, name)
        if os.path.exists(path) and (max_age is None or time.time() - os.path.getmtime(path) < max_age):
            return open(path, "rb").read()
        r = self.http.get(url, timeout=60)
        r.raise_for_status()
        open(path, "wb").write(r.content)
        return r.content

    def _get(self, url, method="GET", lane="bulk"):
        """認証を付けて GET する（Net.get を見よ）。"""
        return self._net.get(lambda: self.auth(url), method, lane)

    def auth(self, url):
        """URL に sid と accessKey を付ける（pkg/mps/auth/auth.go と同じ）。"""
        from Crypto.Cipher import AES

        p3 = "".join(random.choices(string.ascii_letters + string.digits, k=16))
        token = TOKEN_P1 + self.manifest.token_p2 + p3
        ts = int(time.time()) + 4200
        u = urlparse(url)
        path = u.path + ("?" + u.query if u.query else "")
        sep = "&" if "?" in url else "?"
        plain = f"{path}{sep}sid={self.sid}{ts}{p3}".encode()
        pad = 16 - len(plain) % 16
        cipher = AES.new(hashlib.sha256(token.encode()).digest(), AES.MODE_CBC, b"\0" * 16)
        enc = base64.b64encode(cipher.encrypt(plain + bytes([pad]) * pad)).decode()
        return f"{url}{sep}sid={self.sid}&accessKey={quote(f'{ts}_{p3}_{enc}', safe='')}"

    def region(self, lat, lon):
        """地点を含む地域。"""
        return self.region_of_tile(*tile_xy(lat, lon, 9), 9)

    def covered(self):
        """Flyover のある地域の、ズーム 9 のタイル番号 (x, y) の並び。"""
        return sorted(self._by_tile)

    def region_of_tile(self, x, y, z, strict=False):
        """タイルを含む地域。地域の名前 Reg_z9_X_Y は、それが覆うズーム 9 のタイル番号
        （北が 0）。名前で見つからなければ、中心がいちばん近い地域にする（export-obj の
        findPlace と同じ選び方。地域が重なる東京などでは外れる）。strict なら None を返す。"""
        k = (x >> (z - 9), y >> (z - 9)) if z >= 9 else None
        if k in self._by_tile or strict:
            return self._by_tile.get(k)
        n = 1 << z
        lon = (x + 0.5) / n * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
        return min(self.regions, key=lambda r: math.hypot(lat - r["lat"], lon - r["lon"]))

    def tile(self, region, x, y, z, h):
        """C3M のバイト列。データのないタイルは None。y は北が 0 のふつうのタイル番号。"""
        url = (f"{self.c3m_url}?style={STYLE_C3M}&v={region['version']}&region={region['region']}"
               f"&x={x}&y={y}&z={z}&h={h}")
        r = self._get(url)
        if r.status_code == 404 or r.headers.get("content-type") == "image/jpeg":
            return None
        r.raise_for_status()
        return r.content or None

    def tile_cached(self, region, x, y, z, h):
        """tile と同じだが、cache/c3m/<region>_<版>/ に保存し、次からはそれを使う。
        データのないタイルは .empty を置いて覚えておく。"""
        d = os.path.join(self.cache_dir, "c3m", f"{region['region']}_{region['version']}")
        path = os.path.join(d, f"{z}_{x}_{y}_{h}.c3m")
        if os.path.exists(path):
            return open(path, "rb").read()
        if os.path.exists(path + ".empty"):
            return None
        b = self.tile(region, x, y, z, h)
        os.makedirs(d, exist_ok=True)
        _write(path + ".empty" if b is None else path, b or b"")
        return b

    def _style_tile(self, style, x, y, z, ext):
        """衛星画像や地形のタイル（cache/<style>/ に保存する）。データのないものは None。"""
        v = self.manifest.versions.get(style, 0)
        path = os.path.join(self.cache_dir, f"style{style}", str(v), str(z), f"{x}_{y}.{ext}")
        if os.path.exists(path):
            return open(path, "rb").read() or None
        url = f"{self.manifest.styles[style]}?style={style}&z={z}&x={x}&y={y}&v={v}"
        r = self._get(url, lane="ground")
        if r.status_code == 404:
            b = b""
        else:
            r.raise_for_status()
            b = r.content
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _write(path, b)
        return b or None

    def satellite(self, x, y, z):
        """衛星画像のタイル（JPEG）。"""
        return self._style_tile(STYLE_SATELLITE, x, y, z, "jpg")

    def dtm(self, x, y, z):
        """地形のタイル（PNG）。範囲の外やデータのないものは None。"""
        if not self.dtm_available(x, y, z):
            return None
        return self._style_tile(STYLE_DTM, x, y, z, "png")

    def dtm_available(self, x, y, z):
        return any(z0 <= z <= z1 and x0 <= x <= x1 and y0 <= y <= y1
                   for x0, y0, x1, y1, z0, z1 in self.manifest.ranges.get(STYLE_DTM, []))

    def dtm_zooms(self):
        return sorted({r[4] for r in self.manifest.ranges.get(STYLE_DTM, [])})


def _write(path, data):
    """書きかけのファイルを別のスレッドに読ませないよう、別名で書いてから置き換える。"""
    tmp = f"{path}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def parse_altitude(raw):
    out = []
    for t in ET.fromstring(raw).iter("trigger"):
        if t.get("region") is None or t.get("latitude") is None:
            continue
        out.append({"name": t.get("name"), "region": int(t.get("region")),
                    "version": int(t.get("version", 0)), "radius": float(t.get("radius", 0)),
                    "lat": math.degrees(float(t.get("latitude"))),
                    "lon": math.degrees(float(t.get("longitude")))})
    return out


def tile_xy(lat, lon, z):
    """ふつうのタイル番号（北が 0）。"""
    n = 1 << z
    x = int(n * (lon + 180) / 360)
    y = int(n * (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2)
    return x, y
