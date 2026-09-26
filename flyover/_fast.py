"""C3M の展開のうち重い部分の numba 版（numba がなければ import に失敗し、純 Python 版を使う）。

edgebreaker.py の _traverse・process_clers と huffman.py の Table.decode を、そのまま書き写した
もの。結果は純 Python 版とビット単位で同じ（Go 版と照合済みの版と、実データ 190 枚で比べてある）。
展開は純 Python の 5 倍ほど速い。コンパイルした結果は __pycache__ に残るので、2 回目からは速く始まる。
int16 の折り返しは ((x + 0x8000) & 0xFFFF) - 0x8000、Go の uint64 のシフトは範囲外なら 0。
"""
import numpy as np
from numba import njit

U64 = np.uint64


@njit(cache=True)
def _go_step(i, k):
    """負の角の番号の次・前（Go の align3(i) + i + k - align3(i + k)、0 に向かって切り捨て）。"""
    a = 3 * int(i / 3)
    b = 3 * int((i + k) / 3)
    return a + i + k - b


@njit(cache=True)
def _nx(i):
    return i - i % 3 + (1, 2, 0)[i % 3] if i >= 0 else _go_step(i, 1)


@njit(cache=True)
def _pv(i):
    return i - i % 3 + (2, 0, 1)[i % 3] if i >= 0 else _go_step(i, 2)


@njit(cache=True)
def _i16(x):
    return ((x + 0x8000) & 0xFFFF) - 0x8000


@njit(cache=True)
def _unpack_vtx(av, a, res4, vtx, vtd, seen):
    idx3 = a[av]
    h = 3 * res4[_nx(idx3)]
    i_ = 3 * res4[_pv(idx3)]
    j = 3 * res4[idx3]
    k = 3 * res4[av]
    for c in range(3):
        vtx[k + c] = _i16(vtx[h + c] + vtx[i_ + c] - vtx[j + c] - vtd[k + c])
    seen[k // 3] = 1


@njit(cache=True)
def _unpack_uv(c3, n_uv, res4, uv, uvd, res5, uvof):
    r = n_uv
    for idx in (_pv(c3), c3, _nx(c3)):
        uv[2 * r] = uvd[2 * r]
        uv[2 * r + 1] = uvd[2 * r + 1]
        res5[idx] = r
        uvof[res4[idx]] = r
        r += 1
    return r


@njit(cache=True)
def traverse(a, res4, res6, d8, d1, vtd, uvd, res1, res9, res3_total):
    """edgebreaker._traverse と同じ。配列はどれも int64。(vtx, uv, res5, group, res3)。"""
    uv = np.zeros(res3_total * 2, np.int64)
    res5 = np.zeros(res9 * 3, np.int64)
    seen = np.zeros(res1, np.int64)
    uvof = np.full(res1, -1, np.int64)
    done = np.zeros(res9, np.int64)
    stack = np.zeros(res9 * 3, np.int64)
    later = np.zeros(res9 * 3, np.int64)
    vtx = np.zeros(res1 * 3, np.int64)
    group = np.zeros(res9, np.int64)
    n_uv = 0
    ctrA = ctrC = ctrB = ctrD = ctd = 0
    x = 0
    v = 0
    while True:                                    # BIG_LOOP
        while ctrC < res9 and done[ctrC] != 0:
            ctrC += 1
        if ctrC == res9:
            break
        c3 = 3 * ctrC
        stack[ctrA] = c3
        ctrA += 1
        for e in (res4[_pv(c3)], res4[c3], res4[_nx(c3)]):
            for c in range(3):
                vtx[3 * e + c] = vtd[3 * e + c]
            seen[e] = 1
        n_uv = _unpack_uv(c3, n_uv, res4, uv, uvd, res5, uvof)
        done[ctrC] = 1
        group[ctrC] = res6[ctrB]
        ctrB += 1
        if (ctd | ctrA) == 0:
            continue
        nb = ctrB
        restart = False
        while True:
            if ctrA != 0:
                nb01 = nb
            else:
                cnt = ctd - 1
                while True:
                    v = later[cnt]
                    x = done[v // 3]
                    ctd -= 1
                    if ctd == 0:
                        break
                    cnt -= 1
                    if x == 0:
                        break
                if x != 0:
                    ctrA = 0
                    ctrB = nb
                    restart = True
                    break
                uvof[:] = -1
                if seen[res4[v]] == 0:
                    _unpack_vtx(v, a, res4, vtx, vtd, seen)
                n_uv = _unpack_uv(v, n_uv, res4, uv, uvd, res5, uvof)
                ctrA = 1
                done[v // 3] = 1
                nb01 = nb + 1
                group[v // 3] = res6[nb]
                stack[0] = v
            nb = nb01
            am1 = ctrA - 1
            cond = stack[ctrA - 1]
            g6 = res6[nb01 - 1]
            ii = cond
            while True:
                av = a[ii]
                if av >= 0 and done[av // 3] == 0:
                    i1 = _pv(ii)
                    i2 = _nx(ii)
                    other = True
                    if d8[res4[i1]] != 0 and d8[res4[i2]] != 0:
                        ctrD += 1
                        if d1[ctrD - 1] != 0:
                            later[ctd] = av
                            ctd += 1
                            other = False
                    if other:
                        t = res4[av]
                        if seen[t] == 0:
                            _unpack_vtx(av, a, res4, vtx, vtd, seen)
                        r = uvof[t]
                        if r == -1:
                            an = a[av]
                            n1 = res5[_nx(an)]
                            n2 = res5[_pv(an)]
                            n3 = res5[an]
                            r = n_uv
                            nu = _i16(uv[2 * n1] + uv[2 * n2] - uv[2 * n3])
                            nv = _i16(uv[2 * n1 + 1] + uv[2 * n2 + 1] - uv[2 * n3 + 1])
                            uv[2 * r] = _i16(nu - uvd[2 * r])
                            uv[2 * r + 1] = _i16(nv - uvd[2 * r + 1])
                            n_uv = r + 1
                            uvof[t] = r
                        res5[av] = r
                        res5[_pv(av)] = res5[i2]
                        res5[_nx(av)] = res5[i1]
                        done[av // 3] = 1
                        group[av // 3] = g6
                        stack[am1] = av
                        am1 += 1
                ii = _nx(ii)
                if ii == cond:
                    break
            ctrA = am1
            if (ctd | am1) == 0:
                ctrB = nb
                restart = True
                break
        if restart:
            continue
    return vtx, uv, res5, group, n_uv


@njit(cache=True)
def _shl(x, n):
    """Go の uint64 << uint(n)（n が負か 64 以上なら 0）。"""
    return x << U64(n) if 0 <= n < 64 else U64(0)


@njit(cache=True)
def _shr(x, n):
    return x >> U64(n) if 0 <= n < 64 else U64(0)


@njit(cache=True)
def huffman_decode(words, len2, n, vals, lens, offs):
    """huffman.Table.decode と同じ。words: 4 バイトごとの big endian の値、vals・lens・offs: 表の
    項目の値と長さ（生のバイト）を全部の表で並べたものと、各表の始まり。int16 の値（uint16）の並び。"""
    res = np.zeros(n, np.uint16)
    len2mul8 = 8 * len2
    shift1 = 0
    inp1 = U64(0)
    ri = 0
    for w in range(n):
        if shift1 <= 0:
            inp1 = inp1 | _shl(U64(words[ri]), 32 - shift1)
            ri += 1
            shift1 += 32
        neg = inp1 >> U64(63)
        shift2 = shift1 - 1
        inp2 = inp1 << U64(1)
        test = len2mul8 - (32 * ri - (shift1 - 1))
        if test > 15:
            if shift1 <= 16:
                inp2 = inp2 | _shl(U64(words[ri]), 33 - shift1)
                ri += 1
                shift2 = shift1 + 31
            idx = np.int64(inp2 >> U64(48))
        else:
            if shift1 <= test:
                inp2 = inp2 | _shl(U64(words[ri]), 33 - shift1)
                ri += 1
                shift2 = shift1 + 31
            idx = np.int64(_shl(_shr(inp2, (64 - (test & 0xFF)) & 0xFF), 16 - test))
        fval = lens[idx]
        if fval >= 128:
            fval -= 256                               # int8
        if fval <= 0:
            fneg = -fval
            tidx = vals[idx]
            if shift2 <= 15:
                inp2 = inp2 | _shl(U64(words[ri]), 32 - shift2)
                shift2 += 32
                ri += 1
            shift3 = shift2 - 16
            inp3 = inp2 << U64(16)
            if shift2 - 16 < fneg:
                inp3 = inp3 | _shl(U64(words[ri]), 48 - shift2)
                ri += 1
                shift3 = shift2 + 16
            oidx = np.int64(_shr(inp3, 64 - fneg))
            base = offs[tidx]
            oneg = lens[base + oidx] - 16
            if shift3 < oneg:
                inp3 = inp3 | _shl(U64(words[ri]), 32 - shift3)
                shift3 += 32
                ri += 1
            shift1 = shift3 - oneg
            inp1 = _shl(inp3, oneg)
            val = vals[base + oidx]
        else:
            if shift2 < fval:
                inp2 = inp2 | _shl(U64(words[ri]), 32 - shift2)
                shift2 += 32
                ri += 1
            inp1 = _shl(inp2, fval)
            val = vals[idx]
            shift1 = shift2 - fval
        if neg != 0:
            val = -val
        res[w] = val & 0xFFFF
    return res


@njit(cache=True)
def _align3(x):
    return 3 * int(x / 3)


@njit(cache=True)
def _close_star(a, b, c, t2):
    t1 = _align3(c)
    t2i = _pv(c)
    t3 = t2i
    t4 = a[t2i]
    t5 = c
    t6 = 0
    closed = False
    while True:
        t6 = t5 + 1
        if t4 < 0:
            break
        b[t1 + t6 - _align3(t6)] = t2
        if t4 == c:
            closed = True
            break
        t5 = a[t3]
        t1 = _align3(t5)
        t2i = _pv(t5)
        t3 = t2i
        t4 = a[t2i]
    if not closed:
        b[t1 + t6 - _align3(t6)] = t2
    if t2i >= 0:
        a[t3] = c
    if c >= 0:
        a[c] = t2i


@njit(cache=True)
def _read_boundary(a, b, some, vert):
    t1 = _nx(some)
    result = 0
    while True:
        result = _nx(t1)
        t1 = a[result]
        if t1 < 0:
            break
    while True:
        b[_nx(result)] = vert
        result = _pv(result)
        t4 = a[result]
        i = vert
        while t4 >= 0:
            b[_nx(t4)] = i
            result = _pv(t4)
            t4 = a[result]
            i = vert
        vert = i - 1
        if b[_nx(result)] != -1:
            break
    return vert


@njit(cache=True)
def process_clers(meta, meta_ctr, clers, wbo, b5unkn32, res1, a, b):
    """edgebreaker.process_clers と同じ（a と b を書き換える）。"""
    if meta_ctr <= 0:
        raise NotImplementedError("bufMetaCtr <= 0")
    if wbo <= 0:
        raise NotImplementedError("writeBufOff <= 0")
    C, L, E, R, S, P = 67, 76, 69, 82, 83, 80
    stack_n = 0
    vert = res1 - 1
    tmp = np.zeros(3 * wbo, np.int64)
    wbo -= 1
    while True:
        keep = b5unkn32
        meta_ctr -= 1
        t1 = -1
        while b5unkn32 <= meta_ctr or (meta_ctr >= 0 and wbo >= meta[meta_ctr]):
            s = clers[wbo]
            w3 = 3 * wbo
            if s == C:
                if t1 >= 0:
                    a[t1] = w3 + 1
                if w3 >= -1:
                    a[w3 + 1] = t1
                t2 = vert
                vert -= 1
                _close_star(a, b, w3 + 2, t2)
                b5unkn32 = keep
            elif s == L:
                if t1 >= 0:
                    a[t1] = w3 + 1
                if w3 >= -1:
                    a[w3 + 1] = t1
            elif s == E:
                if t1 > 0:
                    tmp[stack_n] = t1
                    stack_n += 1
            elif s == R:
                t3 = w3 + 2
                if t1 >= 0:
                    a[t1] = t3
                if t3 >= 0:
                    a[w3 + 2] = t1
            elif s == S:
                if t1 >= 0:
                    a[t1] = w3 + 1
                if w3 >= -1:
                    a[w3 + 1] = t1
                t4 = w3 + 2
                t5 = a[w3 + 2]
                if t5 == -1:
                    t6 = tmp[stack_n - 1]
                    if t4 >= 0:
                        a[w3 + 2] = t6
                    stack_n -= 1
                    if t6 >= 0:
                        a[t6] = t4
                elif t5 <= -2:
                    t7 = -t5
                    if t4 >= 0:
                        a[w3 + 2] = t7
                    a[t7] = t4
                    t8 = 0
                    while True:
                        t8 = _nx(t4)
                        t4 = a[t8]
                        if not t4 >= 0:
                            break
                    vert = _read_boundary(a, b, t8, vert)
            elif s == P:
                if t1 >= 0:
                    a[t1] = w3
                if wbo >= 0:
                    a[w3] = t1
                _close_star(a, b, w3 + 1, vert - 2)
                _close_star(a, b, w3 + 2, vert - 1)
                _close_star(a, b, w3, vert)
                vert -= 3
                meta_ctr -= 1
                b5unkn32 = keep
            else:
                raise ValueError("unknown CLERS symbol")
            t1 = w3
            wbo -= 1
        t9 = 0
        if b5unkn32 != 0:
            vert = _read_boundary(a, b, 3 * meta[meta_ctr] + 1, vert)
            t9 = b5unkn32 - 1
        b5unkn32 = t9
        if meta_ctr <= 0:
            break
    if vert != -1:
        raise ValueError("res1v_min1ag not -1")


def warm():
    """コンパイル（か、残してある結果の読み込み）を先に済ませる。"""
    z = np.zeros(0, np.int64)
    traverse(z, z, z, z, z, z, z, 0, 0, 0)
    huffman_decode(np.zeros(4, np.uint32), 0, 0, z, z, z)
    try:
        process_clers(z, 0, np.zeros(0, np.uint8), 0, 0, 0, z, z)
    except NotImplementedError:
        pass
