"""新しい Flyover の目録（C3MM 第 2 版、style 100）を読む。

どのタイルのどの高さ区分にデータがあるかと、その高さの範囲が入っている。ズーム 9 のタイルで要求した
目録にはズーム 13〜16 が、ズーム 13 のタイルで要求した目録にはズーム 17〜20 が載っている（ズーム 9 の
目録のいちばん下の印は、ズーム 17 のタイルがあるかどうかも表す）。

入れ物: "C3MM"、u16 2、u16 3、u32 区画の数。区画は [u8 種類][u32 長さ（この 5 バイトを含む）]
[u8 圧縮したか][u32 元の長さ][中身]。圧縮した中身は LZMA（13 バイトの見出し 5D 00 00 10 00 FF×8 つき）。

- 種類 0（根）: u8 ズーム、u32 y の原点、u32 x の原点、u8 いちばん深いズーム、u16 根の数、根ごとに u32
  （下位 8 ビット = 高さ区分、次の 12 ビット = x、上位 12 ビット = y。原点からの相対で、y は南が 0）
- 種類 1（木）: u32 節の数、節ごとに u16。根ごとに、深さ優先・行きがけ順で並ぶ。u16 は子 8 つ
  （下位バイトが下半分の高さ、上位バイトが上半分の高さ。その中で x、y の順に 2 分割）に 2 ビットずつ。
  下位ビット = その子にデータがある（節が続く）、上位ビット = データのある範囲の端の近く
  （端から 2 タイルほどの帯。データのない外側の 1 タイルにも付く）。
  子の高さ区分は 親の区分 × 2 + （上半分なら 1）。つまり目録は縦・横・高さの 8 分木で、高さ区分が
  0〜3 の上で 8〜15 に飛ぶのはこのため
- 種類 5（根の高さ）: f32 下限、f32 上限 [m、楕円体高]、u8 8、根ごとに u16 が 2 つ（a, b）。
  根の範囲は 下限 + a × 刻み から 上限 − b × 刻み（刻み = (上限 − 下限) / 255）
- 種類 6（子の高さ）: u8 4、根でない節ごとに 2 バイト（a, b）。子の範囲は、親の範囲の 16 分の 1 を
  刻みにして、下から a、上から b だけ狭めたもの（手元の 150 枚のうち 148 枚の実際の高さが 0.5 m 以内で
  収まった。残りも 1.2 m 以内）
- 種類 8: 根ごとに u32 が 2 つ（1 つ目はデータのまとまりの番号。隣り合う根は同じ番号で、1 枚の目録に
  いくつか混ざる。マニフェストの版とは別の数え方。2 つ目は 0）
- 種類 9（ない目録もある）: 根ごとに u32。1 = 古い Flyover を入れ直したデータ（スプラットも、光の当たり方の
  画像もない）、2 = 新しいデータ
- 種類 4（ズーム 9 の目録だけ）: 5 バイト（02 00 10 0D 14）。目録が 2 段で、1 段目がズーム 16 まで、
  2 段目がズーム 13 のタイルごとでズーム 20 まで、と読める（どの目録も同じ値なので確かめられない）
"""
import lzma
import struct

LZMA_HEAD = b"\x5d\x00\x00\x10\x00" + b"\xff" * 8
ROOTS, TREE, ROOT_ALT, CHILD_ALT = 0, 1, 5, 6


def sections(data):
    """区画の種類 -> 中身（圧縮を解いたもの）。"""
    if data[:4] != b"C3MM" or struct.unpack_from("<H", data, 4)[0] != 2:
        raise ValueError("C3MM 第 2 版ではない")
    out, p = {}, 12
    for _ in range(struct.unpack_from("<I", data, 8)[0]):
        kind, size, packed, n = struct.unpack_from("<BIBI", data, p)
        raw = data[p + 10:p + size]
        if packed:
            if raw[:13] != LZMA_HEAD:
                raise ValueError("知らない圧縮")
            lz = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[
                {"id": lzma.FILTER_LZMA1, "lc": 3, "lp": 0, "pb": 2, "dict_size": 1 << 20}])
            raw = lz.decompress(raw[13:], n)
        if len(raw) != n:
            raise ValueError("区画の長さが合わない")
        out[kind] = raw
        p += size
    return out


class Index:
    """目録 1 枚。heights[(z, x, y)] = データのある高さ区分の並び（y は北が 0）。
    alt[(z, x, y, h)] = (いちばん低い所, いちばん高い所) [m、楕円体高]。edge = 範囲の端の近くの (z, x, y, h)。"""

    def __init__(self, data):
        s = sections(data)
        z0, y0, x0, self.max_zoom, n = struct.unpack_from("<BIIBH", s[ROOTS], 0)
        roots = struct.unpack_from(f"<{n}I", s[ROOTS], 12)
        tree = struct.unpack_from(f"<{struct.unpack_from('<I', s[TREE], 0)[0]}H", s[TREE], 4)
        lo, hi = struct.unpack_from("<ff", s[ROOT_ALT], 0)
        root_alt, child_alt = struct.unpack_from(f"<{2 * n}H", s[ROOT_ALT], 9), s[CHILD_ALT]
        self.min_zoom, self.heights, self.alt, self.edge = z0, {}, {}, set()
        pos, k = 0, 1

        def walk(z, x, y, h, a, b):
            nonlocal pos, k
            ty = (1 << z) - 1 - y
            self.heights.setdefault((z, x, ty), []).append(h)
            self.alt[z, x, ty, h] = (a, b)
            mask = tree[pos]
            pos += 1
            for i in range(8):
                code = mask >> (2 * i) & 3
                child = (z + 1, 2 * x + (i & 1), 2 * y + (i >> 1 & 1), 2 * h + (i >> 2))
                if code & 2:
                    self.edge.add((child[0], child[1], (2 << z) - 1 - child[2], child[3]))
                if not code & 1:
                    continue
                if z == self.max_zoom:      # 次の目録の根。あるかどうかだけ分かる
                    self.heights.setdefault((z + 1, child[1], (2 << z) - 1 - child[2]), []).append(child[3])
                    continue
                step = (b - a) / 16
                ca, cb = a + child_alt[k] * step, b - child_alt[k + 1] * step
                k += 2
                walk(*child, ca, cb)

        step = (hi - lo) / 255
        for r, e in enumerate(roots):
            walk(z0, x0 + (e >> 8 & 0xfff), y0 + (e >> 20), e & 0xff,
                 lo + root_alt[2 * r] * step, hi - root_alt[2 * r + 1] * step)
        if pos != len(tree):
            raise ValueError("木の節の数が合わない")
        for hs in self.heights.values():
            hs.sort()
