"""R3D（style 98）の読み取りのうち、Apple のデータなしで確かめられる部分のテスト。"""
import struct

import numpy as np
import pytest

from flyover import r3d


def test_compact_lengths():
    assert r3d._compact(bytes([0x36]), 0) == (27, 1)              # 下位ビットが 0 なら 1 バイト
    assert r3d._compact(bytes([0x71, 0x6A]), 0) == (6812, 2)      # 1 つ 1 なら 2 バイト
    assert r3d._compact(b"\xff" + (5).to_bytes(8, "little"), 0) == (5, 9)


def test_v2_and_small_numbers():
    assert r3d._v2(bytes([0x4A, 0x07]), 0) == (970, 2)
    assert r3d._v2(bytes([0x5F, 0x88, 0x01]), 0) == (95 + (8 << 7) + (1 << 14), 3)
    assert r3d._small(bytes([0x08]), 0) == (8, 1)
    assert r3d._small(bytes([0x55, 0x02]), 0) == (149, 2)
    # 2 バイト目が 0x80 以上なら 3 バイト（8,192 以上）
    assert r3d._small(bytes([0x72, 0x8F, 0x01, 0xAD]), 0) == (9202, 3)
    assert r3d._small(bytes([0x63, 0x80, 0x01]), 0) == (8227, 3)


def test_jdir_reads_lengths_and_kind_bytes():
    # レーン 1, 5, 9（12 レーン）、種類 2, 3, 0。種類の欄は 2×3 + 6 ビットで 2 バイト。種類 3 は長さの
    # あとに 1 バイト（最後のレーンには付かない）
    J = bytes([0x22, 0x02, 0b00_11_10, 0x04, 3 << 1, 2 << 1, 0x05, 1 << 1]) + bytes(3 + 2 + 1)
    lanes = r3d._jdir(J, 12)
    assert [(ln[0], ln[1], ln[2]) for ln in lanes] == [(1, 2, 3), (5, 3, 2), (9, 0, 1)]
    assert lanes[0][3] == 8 and lanes[1][3] == 11 and lanes[2][3] == 13
    with pytest.raises(ValueError):
        r3d._jdir(J + b"\0", 12)


def test_jdir_omits_length_after_kinds_0_and_1():
    # 種類 0 の次のレーンは長さを書かず、同じ長さ。種類 2 の次は書く
    J = bytes([0x22, 0x02, 0b00_10_00, 0x00, 4 << 1, 2 << 1]) + bytes(4 + 4 + 2)
    assert [ln[2] for ln in r3d._jdir(J, 12)] == [4, 4, 2]
    # 種類 1 は、長さを省くうえに、あとに 1 バイト
    J = bytes([0x22, 0x02, 0b00_10_01, 0x00, 4 << 1, 0x07, 2 << 1]) + bytes(4 + 4 + 2)
    assert [ln[2] for ln in r3d._jdir(J, 12)] == [4, 4, 2]


def test_jdir_fill_marks():
    # 種類 3, 1, 0。1 本目の埋め方の印は種類のビットのあとのバイト（2 = 表引き）、下のビットが 1 の
    # レーンのあとの 1 バイトが次のレーンの印（1 = くり返し、3 = 符号つき差分）。種類 1 の次は長さを省く
    J = bytes([0x22, 0x02, 0b00_01_11, 0x02, 3 << 1, 0x01, 2 << 1, 0x03]) + bytes(3 + 2 + 2)
    lanes = r3d._jdir(J, 12)
    assert [(ln[2], ln[4]) for ln in lanes] == [(3, "T"), (2, "H"), (2, "S")]
    # 5 本なら欄に 1 本目の印は入らない
    J = bytes([0x33, 0x01, 0b10_10_10_10, 0b10, 1 << 1, 1 << 1, 1 << 1, 1 << 1, 1 << 1]) + bytes(5)
    assert [ln[4] for ln in r3d._jdir(J, 12)] == [None] * 5


def test_jdir_kind_field_size():
    # 5 本なら種類の欄は 2×5 + 6 = 16 ビットで 2 バイト（余りのバイトはない）
    J = bytes([0x33, 0x01, 0b10_10_10_10, 0b10, 1 << 1, 1 << 1, 1 << 1, 1 << 1, 1 << 1]) + bytes(5)
    assert [ln[3] for ln in r3d._jdir(J, 12)] == [9, 10, 11, 12, 13]
    # レーンがなければ欄もない
    assert r3d._jdir(bytes(4), 32) == []


def test_mesh_fields():
    # 04、欄の印（4 ビット、下から）、本体。欄は [マジック, 三角形の数, 頂点の数, 部品の数]
    body = bytes([0xBC, 0x5B]) + bytes.fromhex("4c5a" "1f6e00" "d40400" "0100")
    assert r3d._fields(b"\x04" + body, 4)[1:] == [0x6E1F, 0x4D4, 1]
    # 0C: 04 のあとを、長さとビットマップ（0 で直前のバイトをくり返す）で詰めたもの
    assert r3d._fields(bytes([0x0C, len(body) << 1, 0xFF, 0x0F]) + body, 4)[1:] == [0x6E1F, 0x4D4, 1]
    # 書かないバイトは表引き: 欄を 4 バイトずつ並べ、表[直前のバイト]（書いたバイトで 表[直前] = それ）。
    # 1 バイトも書かない欄は、表がまだ空なら 0
    assert r3d._fields(bytes([0x04, 0xBC, 0x0B]) + bytes.fromhex("4c5a" "460300" "a50100"), 4)[1:] == [838, 421, 0]
    # ff の次は ff（d5 f3 ff ff で覚える）なので、a（バイト 1, 3）の欄のバイト 0 は FF
    sec = bytes([0x04, 0xBC, 0xFB, 0x5A]) + bytes.fromhex("4c5a" "d30600" "1a0c00" "d5f3ffff" "0300" "0100")
    assert r3d._fields(sec, 6)[1:] == [0x6D3, 0xC1A, -0xC2B, 0x3FF, 1]
    # 2 バイトだけの欄の上のバイトも表引き: b7 の次は fe、fe の次は ff
    sec = bytes([0x04, 0xBC, 0xFB, 0x3B, 0x5B]) + bytes.fromhex(
        "4c5a" "1f6e00" "2f3000" "22b7feff" "353000" "10b7" "7d3a00" "0100")
    assert r3d._fields(sec, 8)[2:6] == [0x302F, -84190, 0x3035, -84208]
    # 実際のタイルから: 4c 5a（マジック）と 1c 5a 00 で、4c の次は 5a、5a の次は 00 と覚えるので、
    # 9（バイト 0, 3）の欄 4c .. .. 00 は 0x5A4C
    sec = bytes.fromhex("04bcfb9b5b4c5acb3600d055001c5a00005d29004c00c21d000100")
    assert r3d._fields(sec, 8)[1:] == [0x36CB, 0x55D0, 0x5A1C, 0x295D, 0x5A4C, 0x1DC2, 1]


def test_fill_modes():
    bits = [1, 0, 1, 0, 0]
    vals = [5, 7, 9]
    assert r3d._fill(bits, vals, 6, "H").tolist() == [5, 7, 7, 9, 9, 9]
    # 表: リテラルを読むたびに 直前の値 -> リテラル を覚え、0 では直前の値で引く（なければ 0）
    assert r3d._fill(bits, vals, 6, "T").tolist() == [5, 7, 0, 9, 0, 9]
    with pytest.raises(ValueError):          # ビットマップの 1 にリテラルが足りない
        r3d._fill([1, 1, 1, 1, 1], vals, 6, "H")


def test_single_symbol_table_with_empty_body():
    # 表と本体を分けた封筒で、本体が空。表は記号 1 つ（0x55）で、符号語を持たない
    T = struct.pack("<I", 0x61000002) + bytes.fromhex("00a81a00")
    e = struct.pack("<IIII", 0x24000000, len(T), 0, 0) + T
    assert r3d._envelope(e, 5).tolist() == [0x55] * 5


def test_literal_envelope_and_zigzag():
    e = struct.pack("<I", 0xE1000002) + bytes([1, 2, 3])
    assert r3d._envelope(e, 3).tolist() == [1, 2, 3]
    assert r3d._envelope(struct.pack("<I", 0xE1000002) + struct.pack("<2H", 300, 7), 2).tolist() == [300, 7]
    assert r3d._unzz(np.array([0, 1, 2, 3, 4])).tolist() == [0, -1, 1, -2, 2]


def _prog(*ops):
    return np.array([list(op) + [0] * (5 - len(op)) for op in ops], np.int64)


def test_replay_predictions():
    # 1 つ目 = 直前の予測（はじめ 0）+ D、2 つ目 = 1 つ目 + D、3 つ目 = 中点（0 に向けて切り捨て）+ D、
    # 平行四辺形 = a + b - c + D。中点も「直前の予測」になる
    D = np.array([10, 4, -3, 1, 2], np.int64)
    out = r3d._k_replay(_prog((0, 0), (1, 1, 0), (2, 2, 0, 1), (3, 3, 0, 1, 2), (0, 4)), D, 5).tolist()
    mid = (10 + 14 + 1) // 2
    assert out[:3] == [10, 14, mid - 3]
    assert out[3] == 10 + 14 - (mid - 3) + 1
    assert out[4] == (10 + 14 - (mid - 3)) + 2
    out = r3d._k_replay(_prog((0, 0), (1, 1, 0), (2, 2, 0, 1), (0, 3)), np.array([10, 4, 0, 5]), 4).tolist()
    assert out[3] == (10 + 14 + 1) // 2 + 5  # 頂点が 3 つのかたまりの次は、その中点から
    neg = r3d._k_replay(_prog((0, 0), (1, 1, 0), (2, 2, 0, 1)), np.array([-10, -5, 0]), 3).tolist()
    assert neg[2] == -12                    # (-10 + -15 + 1) / 2 = -12（-12.0 の切り捨て）


def test_uv_indices_on_two_triangles():
    # 四角形を 2 つの三角形に分けたもの。辺 (1, 2) を共有し、継ぎ目がなければ UV は 4 つ、あれば 6 つ
    cor = np.array([0, 1, 2, 3, 2, 1], np.int64)
    a = np.array([3, -1, -1, 0, -1, -1], np.int64)
    res, n, chart = r3d._k_uv_indices(cor, a, np.zeros(2, np.uint8), 2, 4)
    assert n == 4 and res.tolist() == [0, 1, 2, 3, 2, 1] and chart.tolist() == [0, 0]
    res, n, chart = r3d._k_uv_indices(cor, a, np.array([1, 0], np.uint8), 2, 4)   # 三角形 0 の角 0 の向かいが継ぎ目
    assert n == 6 and res.tolist() == [0, 1, 2, 3, 4, 5] and chart.tolist() == [0, 1]


def test_uv_prog_crosses_edges_with_the_same_uvs():
    # 上と同じ 2 つの三角形。辺の両側の UV の番号が同じなら（継ぎ目の印があっても）渡って平行四辺形で予測し、
    # 違えば渡らずに新しい三角形から始める
    a = np.array([3, -1, -1, 0, -1, -1], np.int64)
    prog = r3d._k_uv_prog(np.array([0, 1, 2, 3, 2, 1], np.int64), a, 2, 4)
    assert prog.tolist()[3:] == [[3, 3, 1, 2, 0]]
    prog = r3d._k_uv_prog(np.array([0, 1, 2, 3, 4, 5], np.int64), a, 2, 6)
    assert [k for k, *_ in prog.tolist()] == [0, 1, 2, 0, 1, 2]


def test_parse_rejects_other_data():
    with pytest.raises(ValueError):
        r3d.parse(b"C3M\x03\x07" + bytes(200))
    with pytest.raises(ValueError):
        r3d.sections(r3d.MAGIC + struct.pack("<I", 3) + bytes(200))


def test_version1_container_sections():
    # 版 1: 枠がなく、16 バイト目から回転と平行移動、スプラット、メッシュ、画像の HEIC の順
    head = r3d.MAGIC + struct.pack("<IfI", 1, 0.0016, 2) + struct.pack("<12d", *range(12))
    splat = r3d.SPLAT_MAGIC + bytes(20)
    mesh = r3d.MESH_MAGIC + bytes(30)
    heic = (struct.pack(">I4s", 24, b"ftyp") + bytes(16) + struct.pack(">I4s", 12, b"meta") + bytes(4)
            + struct.pack(">I4s", 10, b"mdat") + bytes(2))
    data = head + b"pbr" + bytes(29) + splat + mesh + heic + heic   # 2 つ目は灰色の画像など
    sec = r3d.sections(data)
    a = len(head) + 32
    assert sec[(2, 1)] == (16, 112)
    assert sec[(1, 3)] == (a, a + len(splat))
    assert sec[(2, 2)] == (a + len(splat), a + len(splat) + len(mesh))
    assert r3d.texture(data, sec) == heic
    assert not r3d.repeat_texture(data, sec, 0)
    # 画像のないもの（メッシュが空で、スプラットだけ）
    sec = r3d.sections(head + bytes(32) + splat + mesh)
    assert (2, 3) not in sec and sec[(2, 2)][1] == len(head) + 32 + len(splat) + len(mesh)
    with pytest.raises(ValueError):                    # メッシュがスプラットより前
        r3d.sections(head + bytes(32) + mesh + splat)


def test_attribute_origin_forms():
    # 0x84: 長さ 13（コンパクト）、ビットマップ 2 バイト、リテラル（表引きで 13 バイトに）。
    # 13 バイトは小さな BYET（4A 00、レーン 0 だけ、長さ 8 の生のレーン）
    assert r3d._origin(bytes.fromhex("841ab50a4a011001000100"), 8) == (1, 0, 0, 0, 1, 0, 0, 0)
    assert r3d._origin(bytes.fromhex("841a550a4a0110000100"), 8) == (0, 0, 0, 0, 1, 0, 0, 0)
    # 0x80: 小さな BYET がそのまま。いちばん上のレーンより上は符号で埋める
    assert r3d._origin(bytes.fromhex("804a00010010010104080700" "0101"), 8) == (1, 1, 4, 8, 7, 0, 1, 1)
    assert r3d._origin(bytes.fromhex("804a000100" "06" "ff0200"), 3) == (-1, 2, 0)
    # 4 レーンとも長さ 1（定数）: 3 成分とも FFFFFE68
    assert r3d._origin(bytes.fromhex("804a000f000102" "68feffff"), 3) == (-408, -408, -408)
    # 表引きの最初のリテラルは表に入れない（5D 00 00 00 になる）
    assert r3d._origin(bytes.fromhex("04710f5d2dffff79f9ffff"), 3) == (93, -211, -1671)
    # 成分ごとに 4 バイトがそのまま（XYZ）
    assert r3d._origin(struct.pack("<3i", -404, -421, -641), 3) == (-404, -421, -641)


def test_splat_texture_is_soft_triangle():
    from io import BytesIO
    from PIL import Image
    from flyover import glb
    a = np.asarray(Image.open(BytesIO(glb._soft_triangle(32))))[..., 3]
    assert a[10, 10] > 200                  # 重心の近くは濃い
    assert a[0, 0] < 60 and a[31, 31] == 0  # 角と三角形の外は透明
