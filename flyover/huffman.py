"""C3M のメッシュの区画を展開するハフマン符号。

retroplasma/flyover-reverse-engineering の pkg/fly/c3m/internal/huffman.go の移植。
あちらは逆コンパイルした処理をそのまま書き起こしたもので、Go の整数の桁あふれ
（int8・int16・int32 の折り返し、範囲外のシフトは 0）に頼っている。ここでも同じ
結果になるよう、その振る舞いを関数で再現する。
"""
import functools
import os
import struct

import numpy as np

try:                     # numba があれば、復号をそちらで（なくても同じ結果で動く）
    from . import _fast
except ImportError:
    _fast = None
if os.environ.get("FLYOVER_NO_NUMBA"):
    _fast = None

M64 = (1 << 64) - 1


def shl(x, n):
    """Go の uint64 << uint(n)。n が負（uint にすると巨大）か 64 以上なら 0。"""
    return (x << n) & M64 if 0 <= n < 64 else 0


def shr(x, n):
    return x >> n if 0 <= n < 64 else 0


def i8(x):
    x &= 0xFF
    return x - 0x100 if x & 0x80 else x


def i16(x):
    x &= 0xFFFF
    return x - 0x10000 if x & 0x8000 else x


def i32(x):
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x & 0x80000000 else x


def be32(b, off):
    return struct.unpack_from(">I", b, off)[0]


class Table:
    """展開表。表ごとに、項目の値（int32）と長さ（int8）の組を持つ。"""

    def __init__(self, pages):
        raw = [list(struct.unpack(f"<{len(p) // 8}q", p)) for p in pages]
        # 8 バイトの項目を (int32 の値, 5 バイト目) に分ける
        self.vals = [[i32(v) for v in page] for page in raw]
        self.lens = [[(v >> 32) & 0xFF for v in page] for page in raw]
        self.lens0_i8 = [i8(v) for v in self.lens[0]]
        # numba 版（_fast.huffman_decode）用に、全部の表を 1 列に並べたもの
        self.flat_vals = np.array([v for page in self.vals for v in page], np.int64)
        self.flat_lens = np.array([v for page in self.lens for v in page], np.int64)
        self.offs = np.cumsum([0] + [len(page) for page in self.vals[:-1]]).astype(np.int64)

    def __len__(self):
        return len(self.vals)

    def decode(self, data, len1, len2):
        """data（len2 バイト）を len1 バイト（int16 の並び）に展開する。

        huffman.go の処理そのままだが、速さのために shl・shr・i8・i16 を書き下し、4 バイトの
        読み出しを先に済ませてある（読む位置はいつも 4 の倍数）。"""
        out = bytearray(len1 + 3)
        if len1 < 2:
            return out
        buf = bytes(data[:len2]) + b"\0" * 16
        if _fast is not None:
            words = np.frombuffer(buf[:len(buf) // 4 * 4], ">u4").astype(np.uint32)
            res = _fast.huffman_decode(words, len2, len1 // 2, self.flat_vals, self.flat_lens, self.offs)
            out[:len1 // 2 * 2] = res.astype("<u2").tobytes()
            return out
        words = struct.unpack(f">{len(buf) // 4}I", buf[:len(buf) // 4 * 4])
        len2mul8 = 8 * len2
        n = len1 // 2
        fv, fl = self.vals[0], self.lens0_i8
        vals, lens = self.vals, self.lens
        res = [0] * n
        shift1 = inp1 = ri = 0          # ri: 次に読む 4 バイトの番号（roff = 4 * ri）
        for w in range(n):
            if shift1 <= 0:
                k = 32 - shift1
                if k < 64:
                    inp1 = (inp1 | (words[ri] << k)) & M64
                ri += 1
                shift1 += 32
            neg = inp1 >> 63
            shift2 = shift1 - 1
            inp2 = (inp1 << 1) & M64
            test = len2mul8 - (32 * ri - (shift1 - 1))
            if test > 15:
                if shift1 <= 16:
                    k = 33 - shift1
                    if k < 64:
                        inp2 = (inp2 | (words[ri] << k)) & M64
                    ri += 1
                    shift2 = shift1 + 31
                idx = inp2 >> 48
            else:
                if shift1 <= test:
                    k = 33 - shift1
                    if 0 <= k < 64:
                        inp2 = (inp2 | (words[ri] << k)) & M64
                    ri += 1
                    shift2 = shift1 + 31
                k = (64 - (test & 0xFF)) & 0xFF
                idx = inp2 >> k if k < 64 else 0
                k = 16 - test
                idx = (idx << k) & M64 if 0 <= k < 64 else 0
            fval = fl[idx]
            if fval <= 0:
                fneg = -fval
                tidx = fv[idx]
                if shift2 <= 15:
                    k = 32 - shift2
                    if k < 64:
                        inp2 = (inp2 | (words[ri] << k)) & M64
                    shift2 += 32
                    ri += 1
                shift3 = shift2 - 16
                inp3 = (inp2 << 16) & M64
                if shift2 - 16 < fneg:
                    k = 48 - shift2
                    if 0 <= k < 64:
                        inp3 = (inp3 | (words[ri] << k)) & M64
                    ri += 1
                    shift3 = shift2 + 16
                k = 64 - fneg
                oidx = inp3 >> k if 0 <= k < 64 else 0
                ov = vals[tidx]
                oneg = lens[tidx][oidx] - 16
                if shift3 < oneg:
                    k = 32 - shift3
                    if 0 <= k < 64:
                        inp3 = (inp3 | (words[ri] << k)) & M64
                    shift3 += 32
                    ri += 1
                shift1 = shift3 - oneg
                inp1 = (inp3 << oneg) & M64 if 0 <= oneg < 64 else 0
                val = ov[oidx] if neg == 0 else -ov[oidx]
            else:
                if shift2 < fval:
                    k = 32 - shift2
                    if 0 <= k < 64:
                        inp2 = (inp2 | (words[ri] << k)) & M64
                    shift2 += 32
                    ri += 1
                inp1 = (inp2 << fval) & M64 if fval < 64 else 0
                val = fv[idx] if neg == 0 else -fv[idx]
                shift1 = shift2 - fval
            res[w] = val & 0xFFFF
        struct.pack_into(f"<{n}H", out, 0, *res)
        return out


def read_params(data, off):
    return struct.unpack_from("<iiih", data, off)


@functools.lru_cache(maxsize=16)
def make_table(p0, p1, p2, p3):
    """符号の長さを決めて展開表を作る（同じ引数の表は使い回す）。"""
    if p3 == 0:
        raise NotImplementedError("huffman p3 == 0")

    class Node:
        __slots__ = ("index", "weight", "code", "child1", "child2", "length")

        def __init__(self, index, weight):
            self.index, self.weight = index, weight
            self.code, self.child1, self.child2, self.length = 0, None, None, 0

    bufs = []
    hp1 = p1
    for i in range(p3):
        bufs.append(Node(i, i32(0xFFFFFFFF // (p2 + hp1 * i))))
        hp1 += p0

    for n in range(p3, 1, -1):
        b1, b2 = bufs[n - 1], bufs[n - 2]
        node = Node(-1, i32(b1.weight + b2.weight))
        node.child1, node.child2 = b1, b2
        k = n
        while True:
            b = bufs[k - 2]
            if node.weight <= b.weight:
                bufs[k - 1] = node
                break
            bufs[k - 1] = b
            k -= 1
            if k - 2 == -1:
                bufs[0] = node
                break

    leaves = [None] * p3
    stack = [bufs[0]]
    while stack:
        t = stack[-1]
        if t.index < 0:
            stack[-1] = t.child1
            stack.append(t.child2)
        else:
            leaves[t.index] = (t.code, t.length)
            stack.pop()
        if t.child1 is not None:
            t.child1.code, t.child1.length = i32(2 * t.code), i8(t.length + 1)
        if t.child2 is not None:
            t.child2.code, t.child2.length = i32(2 * t.code + 1), i8(t.length + 1)

    buf4 = [0] * 0x10001        # int8
    buf5 = [0] * 0x10000        # int16
    counter = 1
    for code, length in leaves:
        if length >= 17:
            m16 = length - 16
            idx5 = code >> m16
            idx4 = buf5[idx5]
            if idx4 == 0:
                buf5[idx5] = counter
                idx4 = counter
                counter += 1
            if m16 > buf4[idx4]:
                buf4[idx4] = m16

    buf4[0] = 16
    pages = []
    size = 16
    for j in range(counter):
        page = bytearray(8 * (1 << size))
        for c in range(1 << size):
            page[8 * c:8 * c + 2] = b"\xff\xff"
        pages.append(page)
        size = buf4[j + 1]

    for idx, (code, length) in enumerate(leaves):
        if length > 16:
            mod = code >> (length - 16)
            b5 = buf5[mod]
            struct.pack_into("<ii", pages[0], 8 * mod, b5, -buf4[b5])
            b4 = buf4[b5]
            m16 = length - 16
            lob = 0xFF & code
            s = b4 - m16
            ptr = i8(i8(lob & ((1 << m16) - 1)) << s) if s >= 0 else 0
            if ptr < 0:
                raise ValueError("negative huffman sub-table index")
            struct.pack_into("<ii", pages[b5], 8 * ptr, idx, length)
        else:
            ptr = code << (16 - length)
            struct.pack_into("<ii", pages[0], 8 * ptr, idx, length)

    size = 16
    for j in range(counter):
        if size != 0:
            page = pages[j]
            cur = page[0:8]
            for c in range(1, 1 << size):
                if page[8 * c:8 * c + 2] == b"\xff\xff":
                    page[8 * c:8 * c + 8] = cur
                else:
                    cur = page[8 * c:8 * c + 8]
        size = buf4[j + 1]
    return Table([bytes(p) for p in pages])
