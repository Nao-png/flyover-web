"""Apple のデータなしで確かめられる部分のテスト。

C3M の展開そのものは、本物のタイルを Go 版と照合して確かめる（scripts/compare_go.py）。
"""
import base64
import hashlib
from urllib.parse import parse_qs, urlparse

import pytest

from flyover import client as cl
from flyover import edgebreaker as eb
from flyover import huffman as hf
from flyover.c3m import parse


def go_align3(x):
    return 3 * int(x / 3)


@pytest.mark.parametrize("i", range(-9, 60))
def test_corner_steps_match_go(i):
    assert eb.nxt(i) == go_align3(i) + i + 1 - go_align3(i + 1)
    assert eb.prv(i) == go_align3(i) + i + 2 - go_align3(i + 2)


def test_go_integer_wraparound():
    assert hf.i16(32767 + 1) == -32768
    assert hf.i16(-32769) == 32767
    assert hf.i32(0xFFFFFFFF) == -1
    assert hf.i8(200) == -56
    assert hf.shl(1, 64) == 0 and hf.shl(1, -1) == 0      # Go では範囲外のシフトは 0
    assert hf.shl(1 << 63, 1) == 0                        # uint64 で桁あふれ


def test_decompress_list_reads_msb_first():
    out = [0] * 8
    eb.decompress_list(out, 8, bytes([0b10110010]), 1)
    assert out == [1, 0, 1, 1, 0, 0, 1, 0]
    out = [0] * 2
    eb.decompress_list(out, 2, bytes([0xAB]), 4)
    assert out == [0xA, 0xB]


def _pb_varint(n):
    b = bytearray()
    while True:
        b.append((n & 0x7F) | (0x80 if n > 0x7F else 0))
        n >>= 7
        if not n:
            return bytes(b)


def _pb(field, value):
    if isinstance(value, int):
        return _pb_varint(field << 3) + _pb_varint(value)
    return _pb_varint(field << 3 | 2) + _pb_varint(len(value)) + value


def test_manifest_fields():
    style = _pb(1, b"https://example.invalid/tile") + _pb(3, 15)
    raw = (_pb(2, style) + _pb(30, b"TOKENP2") + _pb(72, _pb(2, b"altitude-1427.xml"))
           + _pb(9, b"other.xml"))
    m = cl.Manifest(raw)
    assert m.styles[15] == "https://example.invalid/tile"
    assert m.token_p2 == "TOKENP2"
    assert m.file("altitude") == "altitude-1427.xml"


def _offline_client(regions):
    c = object.__new__(cl.Client)
    c.regions, c._by_tile = regions, {}
    for r in regions:
        _, _, x, y = r["name"].split("_")
        c._by_tile[(int(x), int(y))] = r
    return c


def test_region_is_chosen_by_zoom9_tile():
    # 渋谷は z9 の (454, 201)。中心がもっと近い地域があっても、名前のタイルで選ぶ
    near = {"name": "Reg_z9_455_202", "region": 1, "version": 1, "lat": 35.66, "lon": 139.70}
    right = {"name": "Reg_z9_454_201", "region": 2, "version": 1, "lat": 35.9, "lon": 139.4}
    c = _offline_client([near, right])
    assert cl.tile_xy(35.6595, 139.7005, 9) == (454, 201)
    assert c.region(35.6595, 139.7005) is right
    x, y = cl.tile_xy(35.6595, 139.7005, 20)
    assert c.region_of_tile(x, y, 20) is right


def test_auth_url_decrypts_to_path_and_session(monkeypatch):
    from Crypto.Cipher import AES

    c = object.__new__(cl.Client)
    c.sid = "1" * 40
    c.manifest = cl.Manifest(_pb(30, b"P2P2P2P2P2P2P2P"))
    url = "https://gspe11-ssl.ls.apple.com/tile?style=15&x=1&y=2"
    out = c.auth(url)
    q = parse_qs(urlparse(out).query)
    assert q["sid"] == [c.sid]
    ts, p3, enc = q["accessKey"][0].split("_", 2)
    key = hashlib.sha256((cl.TOKEN_P1 + "P2P2P2P2P2P2P2P" + p3).encode()).digest()
    plain = AES.new(key, AES.MODE_CBC, b"\0" * 16).decrypt(base64.b64decode(enc))
    plain = plain[:-plain[-1]]
    assert plain.decode() == f"/tile?style=15&x=1&y=2&sid={c.sid}{ts}{p3}"


def test_parse_rejects_other_data():
    with pytest.raises(ValueError):
        parse(b"not a c3m file" * 20)
