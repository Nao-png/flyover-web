"""地球儀のビューア（earth）の部品のうち、Apple のデータなしで確かめられるもののテスト。"""
import io
import json
import struct

import numpy as np
from PIL import Image

from flyover import client as cl
from flyover import glb, terrain
from flyover.c3m import C3M, Material, Mesh
from test_basic import _offline_client, _pb


def test_manifest_keeps_newest_version_and_ranges():
    # 地形（style 17）は版 0 と 32 の 2 つが載っていて、0 は 410 を返す
    old = _pb(1, b"https://a.invalid/tile") + _pb(3, 17) + _pb(5, _pb(1, 0))
    rng = (_pb(1, 0) + _pb(2, 0) + _pb(3, 127) + _pb(4, 127) + _pb(5, 7) + _pb(6, 7))
    us = (_pb(1, 408) + _pb(2, 2760) + _pb(3, 2583) + _pb(4, 3659) + _pb(5, 13) + _pb(6, 13))
    new = (_pb(1, b"https://b.invalid/tile") + _pb(3, 17)
           + _pb(5, _pb(1, 32) + _pb(2, rng) + _pb(2, us)))
    m = cl.Manifest(_pb(2, old) + _pb(2, new))
    assert m.versions[17] == 32
    assert m.styles[17] == "https://b.invalid/tile"
    assert m.ranges[17] == [(0, 0, 127, 127, 7, 7), (408, 2760, 2583, 3659, 13, 13)]

    c = object.__new__(cl.Client)
    c.manifest = m
    assert c.dtm_zooms() == [7, 13]
    assert c.dtm_available(100, 50, 7)
    assert not c.dtm_available(100, 50, 8)
    assert c.dtm_available(1000, 3000, 13) and not c.dtm_available(3000, 3000, 13)


def test_strict_region_of_tile():
    r = {"name": "Reg_z9_454_201", "region": 2, "version": 1, "lat": 35.9, "lon": 139.4}
    c = _offline_client([r])
    assert c.region_of_tile(454 << 4, 201 << 4, 13, strict=True) is r
    assert c.region_of_tile(0, 0, 13, strict=True) is None
    assert c.region_of_tile(0, 0, 13) is r          # strict でなければいちばん近い地域
    assert c.covered() == [(454, 201)]


def _jpeg():
    out = io.BytesIO()
    Image.new("RGB", (4, 4), (200, 100, 50)).save(out, "JPEG")
    return out.getvalue()


def _read_glb(b):
    magic, version, length = struct.unpack_from("<4sII", b, 0)
    assert (magic, version, length) == (b"glTF", 2, len(b))
    jl, jt = struct.unpack_from("<I4s", b, 12)
    assert jt == b"JSON"
    g = json.loads(b[20:20 + jl])
    bl, bt = struct.unpack_from("<I4s", b, 20 + jl)
    assert bt == b"BIN\0" and len(b) == 28 + jl + bl
    return g, b[28 + jl:]


def _accessor(g, bin_, i, dtype, width):
    a = g["accessors"][i]
    v = g["bufferViews"][a["bufferView"]]
    arr = np.frombuffer(bin_, dtype, a["count"] * width, v["byteOffset"])
    return arr.reshape(-1, width) if width > 1 else arr


def test_tile_glb_layout():
    # 三角形 2 つ（材質 0 と 1 に 1 つずつ）、局所座標を 90 度回して地心座標へ
    V = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 5]], np.float32)
    UV = np.array([[0, 0], [1, 0], [0, 1], [1, 1]], np.float32)
    mesh = Mesh(V, UV, {0: np.array([[0, 1, 2]], np.int32), 1: np.array([[1, 3, 2]], np.int32)})
    rot = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], float)
    trans = np.array([-3730288.4, 3519283.2, 3779547.7])
    c = C3M(rot, trans, [Material(_jpeg(), "jpeg"), Material(_jpeg(), "jpeg")], [mesh])

    g, bin_ = _read_glb(glb.tile_glb([c]))
    assert g["extensionsRequired"] == ["KHR_mesh_quantization"]
    node = g["nodes"][0]
    origin, scale = np.array(node["translation"]), np.array(node["scale"])
    prims = g["meshes"][0]["primitives"]
    assert len(prims) == 2 and len(g["images"]) == 2 and len(g["materials"]) == 2
    for p, F in zip(prims, ([0, 1, 2], [1, 3, 2])):
        a = g["accessors"][p["attributes"]["POSITION"]]
        assert a["componentType"] == glb.INT16 and g["bufferViews"][a["bufferView"]]["byteStride"] == 8
        P = _accessor(g, bin_, p["attributes"]["POSITION"], "<i2", 4)[:, :3]   # 1 頂点 8 バイト
        assert (P.min(0) == a["min"]).all() and (P.max(0) == a["max"]).all()
        uv = _accessor(g, bin_, p["attributes"]["TEXCOORD_0"], "<u2", 2) / 65535
        idx = _accessor(g, bin_, p["indices"], "<u2", 1)
        assert g["accessors"][p["indices"]]["count"] == 3        # 三角形 1 つ = 3 つの番号
        want = c.to_ecef(V[F])
        assert np.allclose(P[idx] * scale + origin, want, atol=scale[0])
        assert np.allclose(uv[idx], np.c_[UV[F][:, 0], 1 - UV[F][:, 1]], atol=1e-4)   # glTF は v が下向き
    assert glb.tile_glb([C3M(rot, trans, [], [])]) is None


def test_mercator_px_and_grid():
    # ズーム 0 の 256 px の中心は (0, 0) 度。画素の中心が整数
    fx, fy = terrain.mercator_px(0.0, 0.0, 0)
    assert np.isclose(fx, 127.5) and np.isclose(fy, 127.5)
    lat, lon = terrain.tile_grid(1, 3, 0)          # 東の端、北半分
    assert lat.shape == (terrain.SIZE, terrain.SIZE)
    assert lat[0, 0] == 90 and lat[-1, 0] == 0
    assert lon[0, 0] == 90 and lon[0, -1] == 180


def _dtm_png(value, base):
    """Apple の地形の PNG と同じ形: 16 bit の値（高さ - 基準）× 4 と、IEND の後ろに基準と倍率。"""
    png = io.BytesIO()
    Image.fromarray(np.full((256, 256), (value - base) * 4, np.uint16)).save(png, "PNG")
    return png.getvalue() + struct.pack("<2f", base, 0.25) + bytes([16, 1, 12, 0])


def test_decode_dtm_uses_base_after_iend():
    assert np.allclose(terrain.decode_dtm(_dtm_png(318.5, 292.15)), 318.5, atol=0.25)   # 0.25 m 刻み
    assert np.allclose(terrain.decode_dtm(_dtm_png(-10, -37.2)), -10, atol=0.25)


class _FakeClient:
    def __init__(self, value):
        self.png, self.calls = _dtm_png(value, 60.0), []

    def dtm_zooms(self):
        return [7, 11]

    def dtm_available(self, x, y, z):
        return z in (7, 11)

    def dtm(self, x, y, z):
        self.calls.append((x, y, z))
        return self.png


def _flat_geoid(h):
    g = object.__new__(terrain.Geoid)
    g.grid = np.full((721, 1441), h, np.float32)
    return g


def test_terrain_heights():
    fake = _FakeClient(100)                  # どこも楕円体高 100 m（地形の高さは楕円体高）
    t = terrain.Terrain(fake, _flat_geoid(30), lambda fn, items: [fn(k) for k in items])
    # 金沢のあたり、レベル 10（ズーム 11 の地形を使う）
    size = 180 / 2 ** 10
    x, y = int((136.67 + 180) / size), int((90 - 36.57) / size)
    h, leaf = t.heights(10, x, y)
    assert h.dtype == np.float32 and h.shape == (65, 65)
    assert np.allclose(h, 100 - terrain.DROP)
    assert not leaf and {z for _, _, z in fake.calls} == {11}
    assert t.heights(12, x * 4, y * 4)[1]    # ズーム 11 より細かい地形はないので、ここで打ち止め
    # 遠いとき（レベル 3）は地形を取らずジオイドだけ
    fake.calls.clear()
    h, leaf = t.heights(3, 14, 3)
    assert np.allclose(h, 30 - terrain.DROP) and not fake.calls and not leaf


def test_fetch_heights_requests_only_needed_slabs():
    from flyover.earth import fetch_heights

    def fake(present):
        asked = []

        def get_many(hs):
            asked.extend(hs)
            return [b"x" if h in present else None for h in hs]
        return asked, get_many

    asked, get = fake({0})
    assert fetch_heights(14, get) == [b"x"] and asked == [0]            # ズーム 15 以下は h = 0 だけ
    asked, get = fake({0})
    assert fetch_heights(16, get) == [b"x", None] and asked == [0, 1]
    asked, get = fake({0, 1, 4})                                        # h = 1 があれば続きも見る
    assert len(fetch_heights(16, get)) == 6 and asked == [0, 1, 2, 3, 4, 5]
    asked, get = fake({0, 2})
    assert fetch_heights(18, get) == [b"x", None, b"x", None] and asked == [0, 1, 2, 3]
    asked, get = fake({0, 3, 5})                                        # 飛び飛びでも拾う
    assert fetch_heights(20, get)[5] == b"x" and asked == list(range(8))


def test_net_sends_a_second_request_when_slow(monkeypatch):
    import asyncio
    import time

    monkeypatch.setattr(cl, "HEDGE", 0.05)
    calls, cancelled = [], []

    class Http:
        async def request(self, method, url):
            calls.append(url)
            if len(calls) == 1:          # 1 本目はなかなか返ってこない
                try:
                    await asyncio.sleep(5)
                except asyncio.CancelledError:
                    cancelled.append(url)
                    raise
                return "slow"
            return "fast"

    net = cl.Net(Http())
    n = iter(range(10))
    t = time.time()
    assert net.get(lambda: f"https://example.invalid/tile?try={next(n)}") == "fast"
    assert calls == ["https://example.invalid/tile?try=0", "https://example.invalid/tile?try=1"]
    assert time.time() - t < 2
    time.sleep(0.1)
    assert cancelled == ["https://example.invalid/tile?try=0"]     # 遅いほうは取りやめる


def test_net_limits_streams_and_retries(monkeypatch):
    import asyncio

    import httpx

    monkeypatch.setattr(cl.Net, "STREAMS", 3)
    state = {"open": 0, "most": 0, "calls": 0}

    class Http:
        async def request(self, method, url):
            state["calls"] += 1
            if url.endswith("flaky") and state["calls"] == 1:
                raise httpx.RemoteProtocolError("connection lost")      # 1 回目だけ失敗
            state["open"] += 1
            state["most"] = max(state["most"], state["open"])
            await asyncio.sleep(0.02)
            state["open"] -= 1
            return url

    net = cl.Net(Http())
    assert net.get(lambda: "https://example.invalid/flaky") == "https://example.invalid/flaky"
    from concurrent.futures import ThreadPoolExecutor
    got = list(ThreadPoolExecutor(10).map(lambda i: net.get(lambda: f"u{i}"), range(10)))
    assert got == [f"u{i}" for i in range(10)] and state["most"] <= 3    # 同時に出すのは STREAMS まで


def test_tile_glb_skips_edge_transition_meshes():
    # Flyover の範囲の端にある、平らな地図につなぐための帯（種類 4）と面（種類 3）は入れない
    V = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0]], np.float32)
    UV = np.array([[0, 0], [1, 0], [0, 1]], np.float32)
    F = {0: np.array([[0, 1, 2]], np.int32)}
    rot, trans = np.eye(3), np.array([-3730288.4, 3519283.2, 3779547.7])
    mats = [Material(_jpeg(), "jpeg")]
    main, band, plane = Mesh(V, UV, F, kind=0), Mesh(V + 5, UV, F, kind=4), Mesh(V - 40, UV, F, kind=3)
    g, _ = _read_glb(glb.tile_glb([C3M(rot, trans, mats, [main, band, plane])]))
    assert len(g["meshes"][0]["primitives"]) == 1
    assert glb.tile_glb([C3M(rot, trans, mats, [band, plane])]) is None     # 帯だけのタイルは空


def test_cover_mask_refines_only_the_edges():
    from flyover.earth import cover_mask

    # 地域 (1, 2) の中で、ズーム 15 で見て左上 20 x 12 の升目にだけ 3D がある
    def inside(z, x, y):
        k = 1 << (15 - z)
        c, r = x * k - 64, y * k - 128          # 地域の左上からの升目（ズーム 15）
        return c < 20 and r < 12 and c + k > 0 and r + k > 0
    asked = []

    def exists(z, x, y):
        asked.append((z, x, y))
        return inside(z, x, y)

    mask = np.unpackbits(np.frombuffer(cover_mask(1, 2, exists), np.uint8)).reshape(64, 64)
    want = np.zeros((64, 64), np.uint8)
    want[:12, :20] = 1
    assert (mask == want).all()
    assert len(asked) < 600              # 4,096 升目を全部は調べない
    assert sum(z == 13 for z, _, _ in asked) == 256


def test_client_tile_exists_uses_head(tmp_path):
    c = _offline_client([])
    c.cache_dir, c.c3m_url = str(tmp_path), "https://example.invalid/tile"
    region = {"region": 5, "version": 7}
    sent = []

    class R:
        def __init__(self, ctype, size):
            self.status_code, self.headers = 200, {"content-type": ctype, "content-length": str(size)}

        def raise_for_status(self):
            pass

    def get(url, method="GET", lane="bulk"):
        sent.append(method)
        return R("application/x-c3m", 120) if "x=1&" in url else R("application/x-c3m", 0)
    c._get = get
    assert c.tile_exists(region, 1, 2, 13) is True
    assert c.tile_exists(region, 3, 2, 13) is False
    assert sent == ["HEAD", "HEAD"]
    d = tmp_path / "c3m" / "5_7"
    d.mkdir(parents=True)
    (d / "13_4_2_0.c3m").write_bytes(b"x")
    assert c.tile_exists(region, 4, 2, 13) is True and len(sent) == 2     # 保存したものがあれば聞かない


def test_net_gives_up_on_stuck_requests_and_reconnects(monkeypatch):
    import asyncio
    import time

    monkeypatch.setattr(cl, "HEDGE", 0.02)
    monkeypatch.setattr(cl.Net, "TIMEOUT", 0.2)
    calls, closed = [], []

    class Stuck:                          # 接続ごと止まっている: 何も返らない
        async def request(self, method, url):
            calls.append(url)
            await asyncio.sleep(30)

        async def aclose(self):
            closed.append(self)

    class Fresh:
        async def request(self, method, url):
            calls.append(url)
            return "ok"

    stuck = Stuck()
    net = cl.Net(stuck)
    net._make = Fresh                    # 張り直すとつながる
    t = time.time()
    assert net.get(lambda: "u") == "ok"
    assert time.time() - t < 2           # 60 秒待たない
    assert closed == [stuck] and isinstance(net.http[0], Fresh)


def test_net_holds_ground_requests_while_many_tiles_load(monkeypatch):
    import asyncio

    monkeypatch.setattr(cl.Net, "BUSY", 2)
    monkeypatch.setattr(cl.Net, "GROUND_BUSY", 1)
    order = []

    class Http:
        async def request(self, method, url):
            await asyncio.sleep(0.2 if url.startswith("tile") else 0.1)
            order.append(url)
            return url

    net = cl.Net(Http())
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(8)
    tiles = [pool.submit(net.get, (lambda i=i: f"tile{i}")) for i in range(3)]
    import time
    time.sleep(0.05)
    ground = [pool.submit(net.get, (lambda i=i: f"sat{i}"), "GET", "ground") for i in range(3)]
    probes = [pool.submit(net.get, (lambda i=i: f"head{i}"), "HEAD", "probe") for i in range(3)]
    for f in tiles + ground + probes:
        f.result()
    # タイルを取っている間、地面の画像は 1 本ずつしか出ない（3 本目が届くのはタイルの後になる
    # こともあるが、3 本とも先に全部届くことはない）。範囲を調べる HEAD は地面を止めない
    first_tile = order.index("tile0")
    assert sum(u.startswith("sat") for u in order[:first_tile]) < 3
    assert all(u in order for u in ["head0", "head1", "head2"])
