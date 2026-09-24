"""C3M のメッシュの区画を展開するハフマン符号。

retroplasma/flyover-reverse-engineering の pkg/fly/c3m/internal/huffman.go の移植。
あちらは逆コンパイルした処理をそのまま書き起こしたもので、Go の整数の桁あふれ
（int8・int16・int32 の折り返し、範囲外のシフトは 0）に頼っている。ここでも同じ
結果になるよう、その振る舞いを関数で再現する。
"""
import functools
import struct

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
    """展開表。表ごとに、項目の値（int32）と長さ（バイト）の組を持つ。"""

    def __init__(self, pages):
        self.vals = [list(struct.unpack(f"<{len(p) // 8}q", p)) for p in pages]
        # 8 バイトの項目を (int32 の値, 5 バイト目) に分ける
        self.vals, self.lens = ([[i32(v) for v in page] for page in self.vals],
                                [[(v >> 32) & 0xFF for v in page] for page in self.vals])

    def __len__(self):
        return len(self.vals)

    def decode(self, data, len1, len2):
        """data（len2 バイト）を len1 バイト（int16 の並び）に展開する。"""
        buf = bytes(data[:len2]) + b"\0" * 8
        out = bytearray(len1 + 3)
        if len1 < 2:
            return out
        len2mul8 = 8 * len2
        n = len1 // 2
        fv, fl = self.vals[0], self.lens[0]
        shift1, inp1, roff, woff = 0, 0, 0, 0
        while True:
            if shift1 <= 0:
                inp1 |= shl(be32(buf, roff), 32 - shift1)
                shift1 += 32
                roff += 4
            neg = inp1 >> 63
            shift2 = shift1 - 1
            inp2 = (2 * inp1) & M64
            test = len2mul8 - (8 * roff - (shift1 - 1))
            if test > 15:
                if shift1 <= 16:
                    inp2 |= shl(be32(buf, roff), 33 - shift1)
                    roff += 4
                    shift2 = shift1 + 31
                idx = inp2 >> 48
            else:
                if shift1 <= test:
                    inp2 |= shl(be32(buf, roff), 33 - shift1)
                    roff += 4
                    shift2 = shift1 + 31
                idx = shl(shr(inp2, (64 - (test & 0xFF)) & 0xFF), 16 - test)
            fval = i8(fl[idx])
            if fval <= 0:
                fneg = -fval
                tidx = fv[idx]
                if shift2 <= 15:
                    inp2 |= shl(be32(buf, roff), 32 - shift2)
                    shift2 += 32
                    roff += 4
                shift3 = shift2 - 16
                inp3 = shl(inp2, 16)
                if shift2 - 16 < fneg:
                    inp3 |= shl(be32(buf, roff), 48 - shift2)
                    roff += 4
                    shift3 = shift2 + 16
                oidx = shr(inp3, 64 - fneg)
                ov, ol = self.vals[tidx], self.lens[tidx]
                oneg = ol[oidx] - 16
                if shift3 < oneg:
                    inp3 |= shl(be32(buf, roff), 32 - shift3)
                    shift3 += 32
                    roff += 4
                shift1 = shift3 - oneg
                inp1 = shl(inp3, oneg)
                val = ov[oidx] if neg == 0 else -ov[oidx]
            else:
                if shift2 < fval:
                    inp2 |= shl(be32(buf, roff), 32 - shift2)
                    shift2 += 32
                    roff += 4
                inp1 = shl(inp2, fval)
                val = fv[idx] if neg == 0 else -fv[idx]
                shift1 = shift2 - fval
            struct.pack_into("<H", out, woff, i16(val) & 0xFFFF)
            woff += 2
            n -= 1
            if n == 0:
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
