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
import base64
import hashlib
import math
import os
import random
import re
import string
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse

import requests

MANIFEST_URL = ("https://gspe35-ssl.ls.apple.com/geo_manifest/dynamic/config?application=geod"
                "&application_version=1&country_code=US&hardware=MacBookPro11,2&os=osx"
                "&os_build=20B29&os_version=11.0.1")
CACHE_BASE = "https://gspe21-ssl.ls.apple.com/"
TOKEN_P1 = "4cjLaD4jGRwlQ9U"      # GeoServices の GEOURLAuthenticationGenerateURL にある値
STYLE_C3M = 15


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
        self.styles, self.cache_files = {}, []
        self.token_p2 = self.cache_base = ""
        for f, t, v in _fields(raw):
            if f == 2 and t == 2:                       # style_config
                sub = {sf: sv for sf, st, sv in _fields(v)}
                if 3 in sub and 1 in sub:
                    self.styles.setdefault(sub[3], sub[1].decode())
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


class Client:
    def __init__(self, cache_dir="cache", session=None):
        self.http = session or requests.Session()
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

    def region_of_tile(self, x, y, z):
        """タイルを含む地域。地域の名前 Reg_z9_X_Y は、それが覆うズーム 9 のタイル番号
        （北が 0）。名前で見つからなければ、中心がいちばん近い地域にする（export-obj の
        findPlace と同じ選び方。地域が重なる東京などでは外れる）。"""
        k = (x >> (z - 9), y >> (z - 9)) if z >= 9 else None
        if k in self._by_tile:
            return self._by_tile[k]
        n = 1 << z
        lon = (x + 0.5) / n * 360 - 180
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / n))))
        return min(self.regions, key=lambda r: math.hypot(lat - r["lat"], lon - r["lon"]))

    def tile(self, region, x, y, z, h):
        """C3M のバイト列。データのないタイルは None。y は北が 0 のふつうのタイル番号。"""
        url = (f"{self.c3m_url}?style={STYLE_C3M}&v={region['version']}&region={region['region']}"
               f"&x={x}&y={y}&z={z}&h={h}")
        r = self.http.get(self.auth(url), timeout=60)
        if r.status_code == 404 or r.headers.get("content-type") == "image/jpeg":
            return None
        r.raise_for_status()
        return r.content or None


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
