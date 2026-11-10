"""新しい Flyover の目録（C3MM 第 2 版）の読み取りのテスト（Apple のデータなしで確かめられる部分）。"""
import struct

import pytest

from flyover import c3mm


def _c3mm(parts):
    body = b"".join(struct.pack("<BIBI", kind, 10 + len(raw), 0, len(raw)) + raw for kind, raw in parts)
    return b"C3MM" + struct.pack("<HHI", 2, 3, len(parts)) + body


def _index():
    # ズーム 17 の根 1 つ（x = 3、南から y = 1、高さ区分 0）。子は下半分の 4 つのうち x = 1, y = 0 のものと、
    # 上半分の x = 0, y = 1 のもの（これは端の印つき）。端の印だけの子（データなし）が 1 つ
    roots = struct.pack("<BIIBH", 17, 8, 16, 18, 1) + struct.pack("<I", 1 << 20 | 3 << 8)
    tree = struct.pack("<IHHH", 3, 1 << 2 | 3 << 12 | 2 << 6, 0, 0)
    root_alt = struct.pack("<ffB", 0, 255, 8) + struct.pack("<HH", 10, 55)
    child_alt = bytes([4, 1, 2, 4, 0])
    return _c3mm([(0, roots), (1, tree), (5, root_alt), (6, child_alt)])


def test_index_is_an_octree_with_heights():
    ix = c3mm.Index(_index())
    y = (1 << 17) - 1 - 9                     # y は南が 0 で入っている
    assert ix.heights == {(17, 19, y): [0], (18, 39, 2 * y + 1): [0], (18, 38, 2 * y): [1]}
    assert ix.edge == {(18, 38, 2 * y, 1), (18, 39, 2 * y, 0)}
    assert ix.alt[17, 19, y, 0] == (10, 200)
    # 子は、親の範囲の 16 分の 1 を刻みに、下から a、上から b だけ狭める
    step = 190 / 16
    assert ix.alt[18, 39, 2 * y + 1, 0] == pytest.approx((10 + step, 200 - 2 * step))
    assert ix.alt[18, 38, 2 * y, 1] == pytest.approx((10 + 4 * step, 200))


def test_rejects_other_files():
    with pytest.raises(ValueError):
        c3mm.Index(b"C3MM" + struct.pack("<HHI", 1, 0, 0))
