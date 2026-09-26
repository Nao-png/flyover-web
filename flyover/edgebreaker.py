"""C3M のメッシュの展開（Apple 独自の Edgebreaker の変種）。

retroplasma/flyover-reverse-engineering の pkg/fly/c3m/internal/edgebreaker.go の移植。
変数名はあちらに合わせてある（逆コンパイル由来で意味の分からない名前が多い）。
頂点と UV は int16 の差分で詰められていて、予測との和は int16 で折り返す。
"""
import os
import struct

import numpy as np

from .huffman import be32, i16

try:                     # numba があれば、重い部分をそちらで（なくても同じ結果で動く）
    from . import _fast
except ImportError:
    _fast = None
if os.environ.get("FLYOVER_NO_NUMBA"):
    _fast = None

NEXT = (1, 2, 0)   # 三角形の中で次の角
PREV = (2, 0, 1)


def nxt(i):
    """同じ三角形の次の角（Go の align3(i) + i + 1 - align3(i + 1)）。"""
    return i - i % 3 + NEXT[i % 3] if i >= 0 else _go_step(i, 1)


def prv(i):
    """同じ三角形の前の角（align3(i) + i + 2 - align3(i + 2)）。"""
    return i - i % 3 + PREV[i % 3] if i >= 0 else _go_step(i, 2)


def _align3(x):
    """Go の 3 * (x / 3)（0 に向かって切り捨て）。"""
    return 3 * int(x / 3)


def _go_step(i, k):
    return _align3(i) + i + k - _align3(i + k)


def i32le(b, off):
    return struct.unpack_from("<i", b, off)[0]


def u32le(b, off):
    return struct.unpack_from("<I", b, off)[0]


def decompress_list(out, length, buf, sh):
    """sh ビットずつの符号なし整数を length 個読む。"""
    buf = bytes(buf) + b"\0" * 8
    shift, off, inp = 0, 0, 0
    mask = (1 << 64) - 1
    for k in range(length):
        if shift < sh:
            inp |= (be32(buf, off) << (32 - shift)) & mask
            shift += 32
            off += 4
        out[k] = inp >> (64 - sh)
        shift -= sh
        inp = (inp << sh) & mask


def read_bufs(data, off, table_a, table_b):
    """区画 10 個（種類 0 はそのまま、3 はハフマン符号）。"""
    bufs, pos = [], 120
    for i in range(10):
        len1 = u32le(data, off + 12 * i)
        len2 = u32le(data, off + 12 * i + 4)
        kind = data[off + 12 * i + 8]
        raw = data[off + pos:off + pos + len2]
        if kind == 0:
            b = bytearray(len1 + 3)
            b[:len(raw)] = raw
        elif kind == 3:
            b = (table_b if i == 7 else table_a).decode(raw, len1, len2)
        else:
            raise NotImplementedError(f"mesh buffer type {kind}")
        bufs.append(bytes(b))
        pos += len2
    return bufs


def decode_clers(b2, res9, b5unkn32, opp):
    meta = [0] * res9
    clers = bytearray(res9 * 3)
    wbo = 0
    if b5unkn32 == 0 and res9 > 0:
        wbo = 1
        clers[0] = ord("P")
    if wbo >= res9:
        raise NotImplementedError("no decoding of data2")
    b2 = bytes(b2) + b"\0" * 8
    mask = (1 << 64) - 1
    inp, rs, bmc_tmp, updown, roff, meta_ctr = 0, 0, 0, 0, 0, 0
    while True:                                   # BIG_LOOP
        tri = 3 * wbo
        wbo_tmp = wbo
        oth = 0
        shift = rs
        restart = False
        while True:
            if shift <= 0:
                inp |= (be32(b2, roff) << (32 - shift)) & mask
                shift += 32
                roff += 4
            rs = shift - 1
            out = ord("C")
            flag = inp >> 63
            inp = (inp * 2) & mask
            if flag:
                if shift <= 2:
                    inp |= (be32(b2, roff) << (33 - shift)) & mask
                    roff += 4
                    rs = shift + 31
                code = inp >> 62
                rs -= 2
                inp = (inp * 4) & mask
                if code == 0:
                    break
                if code == 3:
                    wbo += oth + 1
                    clers[wbo_tmp + oth] = ord("E")
                    if updown > 0:
                        updown -= 1
                        if wbo < res9:
                            restart = True
                            break
                        return meta_ctr, meta, wbo, clers
                    bmc_tmp = meta_ctr + 1
                    if wbo < res9:
                        if bmc_tmp >= b5unkn32:
                            clers[wbo_tmp + 1 + oth] = ord("P")
                            wbo = wbo_tmp + oth + 2
                        else:
                            meta[meta_ctr + 1] = wbo
                    if wbo >= res9:
                        meta_ctr += 1
                        return meta_ctr, meta, wbo, clers
                    meta_ctr = bmc_tmp
                    restart = True
                    break
                out = ord("R") if code == 1 else ord("L")
            clers[wbo + oth] = out
            oth += 1
            tri += 3
            shift = rs
            if oth + wbo >= res9:
                wbo += oth
                return meta_ctr, meta, wbo, clers
        if restart:
            continue
        clers[wbo + oth] = ord("S")
        if opp[prv(tri)] == -1:
            updown += 1
        wbo += oth + 1
        if wbo < res9:
            continue
        return meta_ctr, meta, wbo, clers


def close_star(a, b, c, t2):
    """closeStar"""
    t1 = _align3(c)
    t2i = prv(c)
    t3 = t2i
    t4 = a[t2i]
    t5 = c
    while True:
        t6 = t5 + 1
        if t4 < 0:
            break
        b[t1 + t6 - _align3(t6)] = t2
        if t4 == c:
            t6 = None
            break
        t5 = a[t3]
        t1 = _align3(t5)
        t2i = prv(t5)
        t3 = t2i
        t4 = a[t2i]
    if t6 is not None:
        b[t1 + t6 - _align3(t6)] = t2
    if t2i >= 0:
        a[t3] = c
    if c >= 0:
        a[c] = t2i


def read_boundary(a, b, some, out):
    """readBoundary。out は [残りの頂点番号] の 1 要素リスト。"""
    t1 = nxt(some)
    while True:
        result = nxt(t1)
        t1 = a[result]
        if t1 < 0:
            break
    while True:
        b[nxt(result)] = out[0]
        result = prv(result)
        t4 = a[result]
        i = out[0]
        while t4 >= 0:
            b[nxt(t4)] = i
            result = prv(t4)
            t4 = a[result]
            i = out[0]
        out[0] = i - 1
        if b[nxt(result)] != -1:
            break


def process_clers(meta, meta_ctr, clers, wbo, b5unkn32, res1, a, b):
    if meta_ctr <= 0:
        raise NotImplementedError("bufMetaCtr <= 0")
    if wbo <= 0:
        raise NotImplementedError("writeBufOff <= 0")
    stack_n = 0
    vert = [res1 - 1]                 # res1v_min1ag
    tmp = [0] * (3 * wbo)
    wbo -= 1
    while True:
        keep = b5unkn32
        meta_ctr -= 1
        t1 = -1
        while b5unkn32 <= meta_ctr or (meta_ctr >= 0 and wbo >= meta[meta_ctr]):
            s = chr(clers[wbo])
            w3 = 3 * wbo
            if s == "C":
                if t1 >= 0:
                    a[t1] = w3 + 1
                if w3 >= -1:
                    a[w3 + 1] = t1
                t2 = vert[0]
                vert[0] -= 1
                close_star(a, b, w3 + 2, t2)
                b5unkn32 = keep
            elif s == "L":
                if t1 >= 0:
                    a[t1] = w3 + 1
                if w3 >= -1:
                    a[w3 + 1] = t1
            elif s == "E":
                if t1 > 0:
                    tmp[stack_n] = t1
                    stack_n += 1
            elif s == "R":
                t3 = w3 + 2
                if t1 >= 0:
                    a[t1] = t3
                if t3 >= 0:
                    a[w3 + 2] = t1
            elif s == "S":
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
                    while True:
                        t8 = nxt(t4)
                        t4 = a[t8]
                        if not t4 >= 0:
                            break
                    read_boundary(a, b, t8, vert)
            elif s == "P":
                if t1 >= 0:
                    a[t1] = w3
                if wbo >= 0:
                    a[w3] = t1
                close_star(a, b, w3 + 1, vert[0] - 2)
                close_star(a, b, w3 + 2, vert[0] - 1)
                close_star(a, b, w3, vert[0])
                vert[0] -= 3
                meta_ctr -= 1
                b5unkn32 = keep
            else:
                raise ValueError(f"unknown CLERS symbol {s!r}")
            t1 = w3
            wbo -= 1
        t9 = 0
        if b5unkn32 != 0:
            read_boundary(a, b, 3 * meta[meta_ctr] + 1, vert)
            t9 = b5unkn32 - 1
        b5unkn32 = t9
        if meta_ctr <= 0:
            break
    if vert[0] != -1:
        raise ValueError("res1v_min1ag not -1")


def make_res7(res9, buf3, i32_1, a):
    res7 = [0] * res9
    decompress_list(res7, i32_1, buf3, 1)
    if res9 <= 0:
        raise NotImplementedError("res9 <= 0")
    out = [0] * res9
    ptr, left, tmpval, tri, ctr, ctr2, res = 1, res9 - 1, 0, 2, 0, 0, 0
    while True:
        if tmpval == 0:
            ctr3 = 3 * ctr
            other = False
            if a[tri - 2] == -1:
                other = True
            elif a[tri - 1] == -1:
                ctr3 += 1
                other = True
            else:
                res = 0
                ctr3 = tri
                if a[tri] == -1:
                    other = True
            if other:
                res = res7[ctr2]
                ctr2 += 1
                if res != 0:
                    out[int(a[prv(ctr3)] / 3)] = res
                else:
                    res = 0
            out[ptr - 1] = res
        if left == 0:
            return out
        ctr += 1
        tmpval = out[ptr]
        ptr += 1
        left -= 1
        tri += 3


def _traverse(a, res4, res6, d8, d1, vtd, uvd, res1, res9, res3_total):
    """三角形をたどって頂点と UV を復元する（展開の処理のほとんどを占める）。numba があれば
    _fast.traverse（同じ処理）を使う。(vtx, uv, res5, group, UV の数)。"""
    uv = [0] * (res3_total * 2)
    res5 = [0] * (res9 * 3)            # 角ごとの UV 番号
    seen = [0] * res1                  # bf_res1mul4_a（頂点が復元済みか）
    uvof = [-1] * res1                 # bf_res1mul4_b（頂点の UV 番号）
    unset = [-1] * res1
    done = [0] * res9                  # bf_res9mul4_a（三角形を訪れたか）
    stack = [0] * (res9 * 3)           # bf_res9mul12_b
    later = [0] * (res9 * 3)           # bf_res9mul12_c
    vtx = [0] * (res1 * 3)
    group = [0] * res9                 # bf_res9mul4_b_res6t
    n_uv = [0]

    # ここから先は処理のほとんどを占めるので、速さのために書き下してある:
    # 0 以上の角の番号の次・前は表 NX・PV で引き（負の番号は Go の振る舞いに合わせて nxt・prv）、
    # int16 の折り返し i16(x) は ((x + 0x8000) & 0xFFFF) - 0x8000、int(v / 3) は v // 3（v >= 0）
    NX = [c for t in range(0, 3 * res9, 3) for c in (t + 1, t + 2, t)]
    PV = [c for t in range(0, 3 * res9, 3) for c in (t + 2, t, t + 1)]

    def unpack_vtx(av):
        idx3 = a[av]
        if idx3 >= 0:
            h, i_ = 3 * res4[NX[idx3]], 3 * res4[PV[idx3]]
        else:
            h, i_ = 3 * res4[nxt(idx3)], 3 * res4[prv(idx3)]
        j = 3 * res4[idx3]
        k = 3 * res4[av]
        vtx[k] = ((vtx[h] + vtx[i_] - vtx[j] - vtd[k] + 0x8000) & 0xFFFF) - 0x8000
        vtx[k + 1] = ((vtx[h + 1] + vtx[i_ + 1] - vtx[j + 1] - vtd[k + 1] + 0x8000) & 0xFFFF) - 0x8000
        vtx[k + 2] = ((vtx[h + 2] + vtx[i_ + 2] - vtx[j + 2] - vtd[k + 2] + 0x8000) & 0xFFFF) - 0x8000
        seen[k // 3] = 1

    def unpack_uv(c3):
        r = n_uv[0]
        for idx in (PV[c3], c3, NX[c3]):
            uv[2 * r], uv[2 * r + 1] = uvd[2 * r], uvd[2 * r + 1]
            res5[idx] = r
            uvof[res4[idx]] = r
            r += 1
        n_uv[0] = r

    ctrA = ctrC = ctrB = ctrD = ctd = 0
    while True:                                    # BIG_LOOP
        while ctrC < res9 and done[ctrC] != 0:
            ctrC += 1
        if ctrC == res9:
            break
        c3 = 3 * ctrC
        stack[ctrA] = c3
        ctrA += 1
        for e in (res4[PV[c3]], res4[c3], res4[NX[c3]]):
            vtx[3 * e:3 * e + 3] = vtd[3 * e:3 * e + 3]
            seen[e] = 1
        unpack_uv(c3)
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
                uvof[:] = unset                    # 全部 -1 に戻す
                if seen[res4[v]] == 0:
                    unpack_vtx(v)
                unpack_uv(v)
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
                    i1, i2 = PV[ii], NX[ii]
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
                            unpack_vtx(av)
                        r = uvof[t]
                        if r == -1:
                            an = a[av]
                            if an >= 0:
                                n1, n2 = res5[NX[an]], res5[PV[an]]
                            else:
                                n1, n2 = res5[nxt(an)], res5[prv(an)]
                            n3 = res5[an]
                            r = n_uv[0]
                            nu = ((uv[2 * n1] + uv[2 * n2] - uv[2 * n3] + 0x8000) & 0xFFFF) - 0x8000
                            nv = ((uv[2 * n1 + 1] + uv[2 * n2 + 1] - uv[2 * n3 + 1] + 0x8000) & 0xFFFF) - 0x8000
                            uv[2 * r] = ((nu - uvd[2 * r] + 0x8000) & 0xFFFF) - 0x8000
                            uv[2 * r + 1] = ((nv - uvd[2 * r + 1] + 0x8000) & 0xFFFF) - 0x8000
                            n_uv[0] = r + 1
                            uvof[t] = r
                        res5[av] = r
                        res5[PV[av]] = res5[i2]
                        res5[NX[av]] = res5[i1]
                        done[av // 3] = 1
                        group[av // 3] = g6
                        stack[am1] = av
                        am1 += 1
                ii = NX[ii]
                if ii == cond:
                    break
            ctrA = am1
            if (ctd | am1) == 0:
                ctrB = nb
                restart = True
                break
        if restart:
            continue

    return vtx, uv, res5, group, n_uv[0]


def decompress(data, off, table_a, table_b):
    """展開したメッシュ。vertices (res1, 3) float32、uv (res3, 2) float32、faces（角ごとの頂点
    番号 res4）、res5（角ごとの UV 番号）、groups（三角形ごとの材質 res6）、res8、faces_count。"""
    bufs = read_bufs(data, off, table_a, table_b)
    b0 = bufs[0]
    i32_0 = i32le(b0, 0)
    f64 = struct.unpack_from("<3d", b0, 4)
    f32 = struct.unpack_from("<3f", b0, 28)
    i8_0 = b0[40]
    i32_1, i32_2 = i32le(b0, 45), i32le(b0, 49)
    i8_1 = b0[53]
    i32_3 = i32le(b0, 54)
    i32_4 = u32le(b0, 58)
    if i32_0 < 0 or i8_0 == 0 or (i32_1 | i32_2) < 0 or i8_1 == 0 or i32_4 & 0x80000000:
        raise ValueError("incorrect values in buf 0")

    b5 = bufs[5]
    res9 = i32le(b5, 0)
    if res9 < 0:
        raise ValueError("incorrect values in buf 5 #1")
    fst, snd = i32_0 - 32, 32
    a = [-1] * (res9 * 3)             # 角ごとの向かいの角（opposite）
    b = [-1] * (res9 * 3)             # 角ごとの頂点番号（res4）
    if fst >= 128:
        while True:
            va, vb = i32le(b5, snd // 8), i32le(b5, snd // 8 + 4)
            if va >= 0:
                a[va] = vb
            if vb >= 0:
                a[vb] = va
            fst -= 64
            snd += 64
            if not fst > 127:
                break
    res1 = i32le(b5, snd // 8)
    b5unkn32 = i32le(b5, snd // 8 + 4)
    if (res1 | b5unkn32) < 0:
        raise ValueError("incorrect values in buf 5 #2")

    meta_ctr, meta, wbo, clers = decode_clers(bufs[2], res9, b5unkn32, a)
    if _fast is not None:
        an, bn = np.array(a, np.int64), np.array(b, np.int64)
        _fast.process_clers(np.array(meta, np.int64), meta_ctr, np.frombuffer(bytes(clers), np.uint8),
                            wbo, b5unkn32, res1, an, bn)
        a, b = an.tolist(), bn.tolist()
    else:
        process_clers(meta, meta_ctr, clers, wbo, b5unkn32, res1, a, b)
    res4 = b

    make_res7(res9, bufs[3], i32_1, a)   # 使わないが、あちらと同じく読んでおく

    res6 = [0] * res9
    decompress_list(res6, i32_2, bufs[4], i8_1)
    if i32_2 == 1 and res9 >= 2:
        for i in range(1, res9):
            res6[i] = res6[0]

    d9 = [0] * res1
    decompress_list(d9, i32_3, bufs[9], 1)
    oth_a, oth_b = [0] * res1, [0] * res1
    for i in range(3 * res9):
        if a[i] == -1:
            oth_b[res4[prv(i)]] = 1
            oth_b[res4[nxt(i)]] = 1
    read = 0
    for i in range(res1):
        if oth_b[i]:
            oth_a[i] = d9[read]
            read += 1
    res8 = oth_a

    d8 = [0] * res1
    decompress_list(d8, res1, bufs[8], 1)
    d1 = [0] * i32_4
    decompress_list(d1, i32_4, bufs[1], 1)

    uvd = struct.unpack(f"<{len(bufs[6]) // 2}h", bufs[6][:len(bufs[6]) // 2 * 2])
    vtd = struct.unpack(f"<{len(bufs[7]) // 2}h", bufs[7][:len(bufs[7]) // 2 * 2])

    res3_total = i32le(b0, 41)
    args = (a, res4, res6, d8, d1, vtd, uvd, res1, res9, res3_total)
    if _fast is not None:
        vtx, uv, res5, group, res3 = _fast.traverse(*[np.asarray(x, np.int64) if isinstance(x, (list, tuple)) else x
                                                      for x in args])
    else:
        vtx, uv, res5, group, res3 = _traverse(*args)
    # あちらと同じく float64 で計算してから float32 に丸める
    verts = (np.array(vtx, np.float64).reshape(-1, 3) * f64 + np.array(f32, np.float64)).astype(np.float32)
    scale = 1.0 / ((1 << i8_0) - 1)
    uvs = (np.array(uv[:res3 * 2], np.float64) * scale).astype(np.float32).reshape(-1, 2)
    return {"vertices": verts, "vertices_count": res1, "uv": uvs, "uv_count": res3,
            "faces": res4, "res5": res5, "groups": group, "res8": res8, "faces_count": res9}
