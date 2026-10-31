"""地球儀のビューア（Google Earth のように、地球全体から寄っていくと Flyover が見える）の
サーバー。ビューアの一式（earth/）と、次の API を配る:

    /api/config                        Flyover のある地域（ズーム 9 のタイル）など
    /api/flyover/<z>/<x>/<y>.glb       Flyover のタイル（高さ区分をまとめた glb）。ないときは 204
    /api/sat/<z>/<x>/<y>.jpg           衛星画像
    /api/terrain/<level>/<x>/<y>.bin   地形（地理座標のタイル、65 x 65 の float32 の楕円体高と、
                                       これより細かいタイルがないとき 1 になる float32 が 1 つ）
    /api/search?q=...                  地名の検索（OpenStreetMap の Nominatim に中継）

取得したものは cache/ に保存し、次からはそれを使う。r3d=True なら、Flyover のタイルに iOS 27 の
新しい Flyover（style 98、flyover/r3d.py）を使い、そのタイルがないか読めないときは C3M にする。
"""
import http.server
import json
import mimetypes
import os
import re
import socketserver
import struct
import sys
import threading
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from urllib.parse import parse_qs, urlparse

import numpy as np

from . import c3m, glb, huffman, r3d
from .client import Client
from .terrain import DROP, Geoid, Terrain

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "earth")
MIN_ZOOM, MAX_ZOOM = 13, 20     # Flyover のタイルのあるズーム
# 新しい Flyover（R3D）を使うズーム。ズームで新旧のデータが切り替わって景色が変わらないよう、全部の
# ズームで使う。z16 以下の R3D は 1 枚 1 MB 前後と大きく、Apple の配信サーバーにまだ溜まっていない
# ことが多いので、初めての場所では遠景の最初の応答に 1〜2 秒かかる
R3D_MIN_ZOOM = MIN_ZOOM
NOMINATIM = "https://nominatim.openstreetmap.org/search"
# 今のサーバーの C3M がどれも使っているハフマン符号の引数（表を作るのに 0.2 秒ほどかかる）
COMMON_HUFFMAN = [(62, 40000, 50000, 1024), (250, 6000, 25000, 1024)]


def first_heights(z):
    """まず要求する高さ区分の数。高さ区分はタイルの大きさに比べた高さの区切りで、ズーム 16 以下
    では東京スカイツリー（634 m）やデンバー（標高 1,600 m）でも h = 0 だけだった。ズーム 17 以上
    は h = 0〜3 を要求し、3 にあればさらに上を見る。"""
    return 1 if z <= 15 else 2 if z == 16 else 4


def fetch_heights(z, get_many):
    """タイルの高さ区分ごとの C3M の並び。get_many(区分の番号の並び) は、それぞれのバイト列か
    None（データなし）の並びを返す。高さ区分は飛び飛びにあることがある（h = 1 がなく 2 がある）
    ので、最後に要求した区分にデータがあれば、次の 4 つも要求する。"""
    raws, h, n = [], 0, first_heights(z)
    while True:
        got = get_many(range(h, h + n))
        raws += got
        h += n
        if n == 1 or not got[-1]:
            return raws
        n = 4


def build_glb(raws, name, parse=c3m.parse, strict=False, hevc=False):
    """高さ区分ごとの C3M（parse が r3d.parse なら R3D）のバイト列から glb を作る（別のプロセスで動かす）。
    読めない区分は飛ばす。strict なら、1 つでも読めなければ None（ほかの形式で作り直せるように）。
    hevc なら、R3D の画像を HEVC のまま入れる（glb.tile_glb を見よ）。"""
    tiles = []
    for k, b in enumerate(raws):
        if b:
            try:
                tiles.append(parse(b))
            except Exception as e:
                print(f"  {name} h={k}: {e}", flush=True)
                if strict:
                    return None
    return glb.tile_glb(tiles, hevc=hevc) if tiles else None


def _warm_worker():
    """作業プロセスの準備（最初のタイルを待たせないよう、起動時に済ませる）。ブラウザと CPU を
    取り合わないよう、優先度を少し下げ、HEIC の復号は 1 本のスレッドでする（既定ではコアの数だけ
    使い、作業プロセスの数とかけ合わさって取り合いになる）。"""
    import pillow_heif
    from pillow_heif import register_heif_opener

    if sys.platform == "win32":
        import ctypes

        k32 = ctypes.windll.kernel32
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x4000)     # BELOW_NORMAL_PRIORITY_CLASS
    else:
        os.nice(5)
    pillow_heif.options.DECODE_THREADS = 1
    register_heif_opener()
    for p in COMMON_HUFFMAN:
        huffman.make_table(*p)
    if huffman._fast is not None:
        huffman._fast.warm()
    r3d.warm()


def _warm_wait():
    time.sleep(0.5)      # 1 つのプロセスに片寄らず、全部のプロセスが立ち上がるように


class Earth:
    def __init__(self, cache_dir="cache", jobs=192, r3d=False):
        self.client = Client(cache_dir=cache_dir)
        self.r3d = r3d and self.client.r3d_source() is not None
        self.cache_dir = cache_dir
        self.pool = ThreadPoolExecutor(jobs)
        # C3M の展開は重い（密な街で 1 枚 0.1 秒ほど、numba がなければ 0.3 秒ほど）ので、プロセスを
        # 分けて並べる。コアを多く使うとブラウザの描画と取り合い、1 つ 140 MB ほどメモリも使うので、
        # 4 分の 1（多くて 4 つ）にする（新しい Flyover を HEVC のまま渡せば、高さ区分 1 つ 50 ms ほど。
        # 待ちのほとんどは Apple からの取得）。全部の立ち上げに数秒かかるので、起動時に裏で立ち上げておく
        n = max(2, min(4, (os.cpu_count() or 4) // 4))
        self.cpu = ProcessPoolExecutor(n, initializer=_warm_worker)
        threading.Thread(target=lambda: [self.cpu.submit(_warm_wait) for _ in range(n)],
                         daemon=True).start()
        self.terrain = Terrain(self.client, Geoid(cache_dir, self.client.http), self.map)
        self._locks, self._locks_lock = {}, threading.Lock()
        self.tile_hosts = []            # タイルを受けるアドレス（serve が足す）

    def map(self, fn, items):
        return list(self.pool.map(fn, items))

    def _lock(self, key):
        """同じものを同時に何度も取りに行かないための鍵。"""
        with self._locks_lock:
            return self._locks.setdefault(key, threading.Lock())

    def config(self):
        # ジオイド高は 2 度ごとに丸めて渡す（ビューアで標高と高度を出す用）
        g = self.terrain.geoid.grid[::8, ::8]
        return {"coverage": self.client.covered(), "minZoom": MIN_ZOOM, "maxZoom": MAX_ZOOM,
                "geoid": {"step": 2, "rows": np.round(g).astype(int).tolist()},
                "terrainDrop": DROP, "tileHosts": self.tile_hosts, "r3d": self.r3d}

    def flyover(self, z, x, y, timing=None, hevc=False):
        """タイルの glb。データがなければ None。timing（dict）があれば、Apple から取るのと
        glb を作るのにかかった時間 [ms] を入れる。hevc なら、新しい Flyover の画像を HEVC のまま
        入れる（ビューアが GPU で展開できるとき）。"""
        timing = {} if timing is None else timing
        if not MIN_ZOOM <= z <= MAX_ZOOM:
            return None
        region = self.client.region_of_tile(x, y, z, strict=True)
        if region is None:
            return None
        hevc = hevc and self.r3d
        kind = ("glb98_13h" if hevc else "glb98_13") if self.r3d else "glb4"    # 作り方を変えたら番号を上げる
        d = os.path.join(self.cache_dir, kind, f"{region['region']}_{region['version']}", str(z))
        path = os.path.join(d, f"{x}_{y}.glb")
        t0 = time.perf_counter()
        with self._lock(("glb", z, x, y, hevc)):
            timing["wait"] = (time.perf_counter() - t0) * 1000
            if os.path.exists(path):
                return open(path, "rb").read() or None
            t0 = time.perf_counter()
            out = None
            if self.r3d and z >= R3D_MIN_ZOOM:
                raws = fetch_heights(z, lambda hs: self.map(
                    lambda k: self.client.r3d_tile_cached(region, x, y, z, k), hs))
                t1 = time.perf_counter()
                # R3D があれば C3M は取らない。R3D の取得が時間切れなら、ここで例外になって
                # 保存せずに 502 を返し、ビューアがあとで取り直す
                if any(raws):
                    # 1 区分でも読めなければ、タイルごと C3M にする（区分が欠けて建物の上が消えないよう）
                    out = self.cpu.submit(build_glb, raws, f"{z}/{x}/{y} r3d", r3d.parse, True, hevc).result()
            if out is None:
                raws = fetch_heights(z, lambda hs: self.map(
                    lambda k: self.client.tile_cached(region, x, y, z, k), hs))
                t1 = time.perf_counter()
                out = self.cpu.submit(build_glb, raws, f"{z}/{x}/{y}").result()
            timing["fetch"], timing["build"] = (t1 - t0) * 1000, (time.perf_counter() - t1) * 1000
            os.makedirs(d, exist_ok=True)
            tmp = f"{path}.{threading.get_ident()}.tmp"
            open(tmp, "wb").write(out or b"")
            os.replace(tmp, path)
            return out

    def satellite(self, z, x, y):
        with self._lock(("sat", z, x, y)):
            return self.client.satellite(x, y, z)

    def search(self, q):
        r = self.client.http.get(NOMINATIM, timeout=20, params={
            "q": q, "format": "jsonv2", "limit": 8, "accept-language": "ja,en"},
            headers={"User-Agent": "flyover-web (personal Flyover viewer)"})
        r.raise_for_status()
        return [{"name": p["display_name"], "lat": float(p["lat"]), "lon": float(p["lon"]),
                 "bbox": [float(v) for v in p.get("boundingbox", [])]} for p in r.json()]


ROUTES = [
    (re.compile(r"/api/flyover/(\d+)/(\d+)/(\d+)\.glb"), "flyover"),
    (re.compile(r"/api/sat/(\d+)/(\d+)/(\d+)\.jpg"), "sat"),
    (re.compile(r"/api/terrain/(\d+)/(\d+)/(\d+)\.bin"), "terrain"),
]


def handler(earth):
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def send(self, code, body=b"", ctype="application/octet-stream", cache=True, timing=None):
            self.send_response(code)
            if timing:
                self.send_header("Server-Timing", ", ".join(f"{k};dur={v:.0f}" for k, v in timing.items()))
                self.send_header("Timing-Allow-Origin", "*")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=86400" if cache else "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Expose-Headers", "Server-Timing")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            u = urlparse(self.path)
            try:
                self.route(u.path, parse_qs(u.query))
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception as e:
                traceback.print_exc()
                try:
                    self.send(502, str(e).encode(), "text/plain; charset=utf-8", cache=False)
                except OSError:
                    pass

        def route(self, path, query):
            if path == "/api/config":
                return self.send(200, json.dumps(earth.config()).encode(), "application/json", cache=False)
            if path == "/api/search":
                res = earth.search(query.get("q", [""])[0])
                return self.send(200, json.dumps(res, ensure_ascii=False).encode(),
                                 "application/json; charset=utf-8")
            for rx, kind in ROUTES:
                m = rx.fullmatch(path)
                if not m:
                    continue
                a, b, c = map(int, m.groups())
                if kind == "flyover":
                    timing = {}
                    out = earth.flyover(a, b, c, timing, query.get("hevc") == ["1"])
                    # ブラウザには覚えさせない（作り方を変えたときに古いものが残らないよう）。cache/ にはある
                    return self.send(200 if out else 204, out or b"", "model/gltf-binary", cache=False, timing=timing)
                if kind == "sat":
                    out = earth.satellite(a, b, c)
                    return self.send(200, out, "image/jpeg") if out else self.send(404)
                h, leaf = earth.terrain.heights(a, b, c)
                return self.send(200, h.tobytes() + struct.pack("<f", leaf))
            # ビューアの一式
            name = "index.html" if path in ("/", "") else path.lstrip("/")
            full = os.path.normpath(os.path.join(STATIC, name))
            if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
                return self.send(404, b"not found", "text/plain", cache=False)
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            return self.send(200, open(full, "rb").read(), ctype, cache=False)

    return Handler


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer は名前を逆引き（socket.getfqdn）して、アドレスごとに数秒待つので飛ばす
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], ConnectionError):   # ブラウザが接続を切っただけなら黙る
            super().handle_error(request, client_address)


# ブラウザは同じホストへの同時接続を 6 本に絞る。ループバックの別のアドレスでも受けて、
# ビューアが Flyover・衛星画像・地形のタイルをそれらに振り分けられるようにする
TILE_HOSTS = [f"127.0.0.{i}" for i in range(2, 18)]


def serve(port=8000, cache_dir="cache", host="127.0.0.1", r3d=False):
    earth = Earth(cache_dir, r3d=r3d)
    make = handler(earth)
    for extra in TILE_HOSTS:
        try:
            s = Server((extra, port), make)
        except OSError:
            continue
        threading.Thread(target=s.serve_forever, daemon=True).start()
        earth.tile_hosts.append(extra)
    server = Server((host, port), make)
    earth.tile_hosts.append(host)
    print(f"http://localhost:{port}/", flush=True)
    server.serve_forever()
