"""R3D（iOS 27 の新しい Flyover、style 98）を読む。

Apple の説明はなく、データだけから読み方を割り出した（解読の手がかりと検証については
docs/how-it-works.md の「新しい Flyover（style 98）」を見よ）。テクスチャ付きのメッシュ（part 2）と、
木などを表す三角形のスプラット（part 1）を読む。法線は読まない。

ファイルの作り:
    3D 96 59 2E、u32 版（2）、3 バイト、続いて [tag u8][LEB128 長さ][中身] の部分が 3 つ。
    部分は 4 バイトのあと同じ形の項目が並ぶ。part 2 の項目 1 は 3x3 の回転（行優先）と ECEF の
    平行移動の double が 12 個、項目 2 がメッシュ、項目 3 が画像（最初の項目の中の HEIC が
    テクスチャ。項目 13 があるタイルには、海などの塗りつぶし用の画像しか入っていない）。
    版 1（高い区分にまれにある）は部分と項目の枠がなく、16 バイト目から回転と平行移動、続いて
    スプラット（D1 22 C9 07 で始まる）、メッシュ（E1 21 66 24 で始まる）、画像の HEIC が並ぶ。

メッシュは旧 C3M と同じ Edgebreaker の変種を、いくつもの流れに分けて詰めたもの:
    先頭 20 バイト（8 バイト目に位置の刻みの f32）、v1、H2（数。v2 形式）、
    欄の数、三角形ごとの C / C 以外のビット、C 以外の 2 ビットの種類、旧 C3M の buf5 にあたる
    区画（三角形の数・頂点の数など）、位置の BYET ブロック、余分なブロックの数とそのブロック
    （海沿いの低いズームで 1 つ。頂点ごとの 1 ビットの印で、意味は分からない）、数 2 つ、
    UV の継ぎ目のブロック、チャートの数、チャートごとの番号のブロック（ふつうは空。意味は分からない）、
    UV の BYET ブロック、法線（ここでは読まない）。
BYET ブロックは 80 4A 00 のあとに J（使うレーンのビット、レーンごとの 2 ビットの種類、レーンの長さ）と
レーンの中身。レーンの中身は値の数とハフマン符号の封筒 2 つ（ビットマップとリテラル）で、ビットマップの
1 で次のリテラル、0 で「直前の値をくり返す」か「直前の値で表を引く」。どちらかを示す印は見つかって
いないが、予測が当たるところはビット 0 になるので、正しい埋め方ではリテラルが予測と同じになることは
ない。それで選び、決まらなければ値の範囲が一番狭くなるほうにする。
"""
import itertools
import os
import struct
from dataclasses import dataclass

import numpy as np

from . import edgebreaker
from .c3m import C3M, Material, Mesh

try:                     # numba があれば、重いループをそちらで（なくても同じ結果で動く。20 倍ほど遅い）
    if os.environ.get("FLYOVER_NO_NUMBA"):
        raise ImportError
    from numba import njit
    _jit = njit(cache=True)
except ImportError:
    def _jit(f):
        return f

MAGIC = b"\x3d\x96\x59\x2e"
BYET = b"\x80\x4a\x00"


# ---- 数の書き方 ----------------------------------------------------------------

def _leb(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def _v2(b, i):
    """最初のバイトの下位 7 ビットに、続く LEB128 を 128 倍して足す（続きは必ずある）。"""
    r, j = _leb(b, i + 1)
    return (b[i] & 0x7F) | (r << 7), j


def _v2s(b, i):
    """0x40 未満なら 1 バイト、そうでなければ _v2。"""
    return (b[i], i + 1) if b[i] < 0x40 else _v2(b, i)


def _compact(b, i):
    """最初のバイトの下位に並ぶ 1 の数 n で n+1 バイト。LE で読んで n+1 ビット右へ。FF なら続く 8 バイト。"""
    c = b[i]
    if c == 0xFF:
        return int.from_bytes(b[i + 1:i + 9], "little"), i + 9
    n = 0
    while c >> n & 1:
        n += 1
    return int.from_bytes(b[i:i + n + 1], "little") >> (n + 1), i + n + 1


def _small(b, i):
    """0x40 未満なら 1 バイト。そうでなければ下位 6 ビットに、次のバイトの下位 7 ビットの 64 倍を足す。
    次のバイトが 0x80 以上なら、さらに 3 バイト目の 8192 倍を足す。"""
    if b[i] < 0x40:
        return b[i], i + 1
    v = (b[i] & 0x3F) | (b[i + 1] & 0x7F) << 6
    if b[i + 1] < 0x80:
        return v, i + 2
    return v | b[i + 2] << 13, i + 3


def _tlv(b, a, e):
    out = []
    while a < e:
        n, j = _leb(b, a + 1)
        out.append((b[a], j, j + n))
        a = j + n
    return out


# ---- ハフマン符号の封筒 -----------------------------------------------------------

class _Bits:
    """LE の u32 の語を、上のビットから順に読む（bits は 1 ビット 1 バイト、p は次に読む位置）。"""

    def __init__(self, b):
        n = len(b) // 4
        w = np.frombuffer(bytes(b[:4 * n]), "<u4").astype(">u4")
        self.bits = np.unpackbits(w.view(np.uint8))
        self.p = 0


@_jit
def _k_read(bits, p, k):
    """p ビット目から k ビットの数と次の位置。足りなければ位置 -1。"""
    if p < 0 or p + k > bits.shape[0]:
        return 0, -1
    v = 0
    for i in range(k):
        v = (v << 1) | int(bits[p + i])      # uint8 のままだと numba なしで桁あふれ
    return v, p + k


@_jit
def _k_table(bits, p, width, empty):
    """_table の中身。(記号, 符号長, 符号語, 次の位置)。ビットが足りなければ位置 -1、符号が 62 ビット
    より長ければ -2（int64 に入らない。正しい表の符号は 22 ビットまで）。"""
    z = np.zeros(0, np.int64)
    n, p = _k_read(bits, p, width)
    w, p = _k_read(bits, p, 3)
    if p < 0:
        return z, z, z, -1
    n += 1
    sym, lns, codes = np.empty(n, np.int64), np.empty(n, np.int64), np.empty(n, np.int64)
    prev = -1
    for i in range(n):
        if n == 1 and empty:
            ln, code = 0, 0
        else:
            ln = 1
            if w:
                ln, p = _k_read(bits, p, w)
                ln += 1
            if ln > 62:
                return z, z, z, -2
            code, p = _k_read(bits, p, ln)
        f, p = _k_read(bits, p, 1)
        if f == 0:
            s = prev + 1
        else:
            f, p = _k_read(bits, p, 1)
            if f:
                s, p = _k_read(bits, p, width)
            else:
                s, p = _k_read(bits, p, width // 2)
                s += prev + 1
        if p < 0:
            return z, z, z, -1
        sym[i], lns[i], codes[i] = s, ln, code
        prev = s
    return sym, lns, codes, p


def _table(r, width, empty=False):
    """記号の数 - 1、符号長の幅（3 ビット）、記号ごとに（符号長 - 1、符号語、値: 0 = 前 + 1、
    11 = 絶対値、10 = 前 + 増分 + 1）。語の境目にそろえて終わる。本体が空（empty）で記号が 1 つなら、
    符号長と符号語はなく、符号の長さは 0。(記号, 符号長, 符号語) の配列を返す。"""
    sym, ln, code, p = _k_table(r.bits, r.p, width, empty)
    if p == -1:
        raise EOFError
    if p == -2:
        raise ValueError("符号が長すぎる")
    r.p = p + (-p % 32)
    return sym, ln, code


def _prefix_free(tab):
    """どの符号語もほかの符号語の頭になっておらず、符号の長さで隙間なく埋まる（記号が 1 つなら可）。"""
    sym, ln, code = tab
    if len(ln) == 1:
        return True
    mx = int(ln.max())
    lo = code << (mx - ln)               # 符号語を mx ビットに伸ばした区間 [lo, lo + size)
    size = np.int64(1) << (mx - ln)
    o = np.argsort(lo, kind="stable")
    if not (lo[o][:-1] + size[o][:-1] <= lo[o][1:]).all():
        return False
    return int(size.sum()) == 1 << mx      # 区間が重ならないので、和は 2^mx を超えない（桁あふれしない）


@_jit
def _k_huff(bits, p, sym, lens, mx, count):
    """bits の p ビット目から count 個。先の mx ビットで表を引く。(記号, 次の位置)。読めなければ位置 -1。"""
    n = bits.shape[0]
    out = np.empty(count, np.int64)
    for i in range(count):
        if p >= n:
            return out, -1
        w = 0
        for k in range(mx):
            w = (w << 1) | (int(bits[p + k]) if p + k < n else 0)   # uint8 のままだと numba なしで桁あふれ
        if lens[w] == 0:
            return out, -1
        out[i] = sym[w]
        p += lens[w]
    return out, p


@_jit
def _k_lookup(syms, lns, codes, mx):
    """先の mx ビットで引く表 (記号, 符号長)。後の記号が前の記号の区間を上書きする。"""
    sym = np.zeros(1 << mx, np.int64)
    lens = np.zeros(1 << mx, np.int64)
    for i in range(syms.shape[0]):
        lo = codes[i] << (mx - lns[i])
        hi = lo + (1 << (mx - lns[i]))
        sym[lo:hi] = syms[i]
        lens[lo:hi] = lns[i]
    return sym, lens


def _decode(r, tab, count, strict):
    """count 個の記号（int64 の配列）。strict なら、読み終えた後の残りが 0 だけで最後の語の中に収まること。"""
    if count == 0:
        return np.zeros(0, np.int64)
    syms, lns, codes = tab
    if len(lns) == 1 and lns[0] == 0:
        return np.full(count, syms[0], np.int64)
    mx = int(lns.max())
    if mx > 22:
        raise ValueError("符号が長すぎる")
    sym, lens = _k_lookup(syms, lns, codes, mx)
    out, p = _k_huff(r.bits, r.p, sym, lens, mx, count)
    if p < 0:
        raise ValueError("ハフマン符号を読めない")
    r.p = p
    if strict and (len(r.bits) - r.p >= 32 or r.bits[r.p:].any()):
        raise ValueError("本体の終わりが合わない")
    return out


def _envelope(e, count, width=None, strict=True):
    """封筒を展開した記号の並び。width（8 か 16）は分からなければ None。"""
    h = struct.unpack_from("<I", e)[0]
    if h == 0xE1000002:                  # そのままのバイト列
        body = e[4:]
        if len(body) == count:
            return np.frombuffer(body, np.uint8).astype(np.int64)
        if len(body) == 2 * count:
            return np.frombuffer(body, "<u2").astype(np.int64)
        raise ValueError("リテラルの長さが合わない")
    if h == 0x61000002:                  # 表と本体が続けて入った流れ
        for w in ((width,) if width else (8, 16)):
            try:
                r = _Bits(e[4:])
                return _decode(r, _table(r, w), count, strict)
            except (EOFError, ValueError):
                if width:
                    raise
        raise ValueError("ハフマン符号を読めない")
    if h & 0xFFFF00FF == 0x24000000:     # 表と本体を分けたもの。2 バイト目は本体を包む段数
        lvl = (h >> 8) & 0xFF
        tl, pl = struct.unpack_from("<II", e, 4)
        if tl == 0:
            return _envelope(e[16:], count, width, strict)
        T = e[16:16 + tl]
        P = e[16 + tl:16 + tl + pl] if lvl < 2 else e[16 + tl:]
        tab = None
        for w in (8, 16):                # 表の流れをちょうど使い切る幅
            r = _Bits(T[4:])
            try:
                t = _table(r, w, lvl == 0 and pl == 0)
            except (EOFError, ValueError):   # ビットが足りないか、符号が長すぎる（この幅ではない）
                continue
            if r.p // 8 == len(T) - 4 and _prefix_free(t):
                tab = t
                break
        if tab is None:
            raise ValueError("表の幅が決まらない")
        if lvl:
            P = _envelope(struct.pack("<I", 0x24000000 | (lvl - 1) << 8) + P, pl, 8).astype(np.uint8).tobytes()
        return _decode(_Bits(P), tab, count, strict)
    raise ValueError(f"知らない封筒 {h:#x}")


# ---- BYET ブロック --------------------------------------------------------------

FILL = {0: "R", 1: "H", 2: "T", 3: "S", 4: "H", 5: "T", 6: "S"}   # レーンの埋め方の印（4-6 の違いは分からない）


def _jdir(J, nlanes):
    """J のディレクトリ: 使うレーンのビット（nlanes ビット）、レーンごとの 2 ビットの種類（m 本なら
    2m + 6 ビットの欄）、レーンごとの項目。[(レーン, 種類, 長さ, 位置, 埋め方)]。

    種類は「次のレーンで何が変わるか」: 上のビットが 1 なら次のレーンの長さを書き（0 なら同じ長さ）、
    下のビットが 1 なら次のレーンの埋め方の印を 1 バイト書く（0 なら同じ埋め方）。1 本目の長さは必ず
    書き、1 本目の埋め方の印は種類のビットのあとのバイトの区切りから（欄に入らなければ印はない）。
    埋め方は FILL の R（生）、H（くり返し）、T（表引き）、S（符号つき差分）か、分からなければ None。"""
    nb = (nlanes + 7) // 8
    A = int.from_bytes(J[:nb], "little")
    active = [i for i in range(nlanes) if A >> i & 1]
    m = len(active)
    nbB = (2 * m + 6 + 7) // 8 if m else 0   # レーンがなければ（値は全部原点）欄もない
    B = int.from_bytes(J[nb:nb + nbB], "little")
    toks = [B >> (2 * t) & 3 for t in range(m)]
    off = 8 * ((2 * m + 7) // 8)
    fill = FILL.get(B >> off & 0xFF) if off < 8 * nbB else None
    p, lanes = nb + nbB, []
    for k, (lane, t) in enumerate(zip(active, toks)):
        if k == 0 or toks[k - 1] & 2:
            L, p = _compact(J, p)
        lanes.append([lane, t, L, fill])
        if t & 1 and k != m - 1:
            fill = FILL.get(J[p])
            p += 1
    for ln in lanes:
        ln.insert(3, p)
        p += ln[2]
    if p != len(J):
        raise ValueError("J の長さが合わない")
    return [tuple(x) for x in lanes]


@_jit
def _k_fill(bits, vals, n, table):
    """table が偽なら 0 で直前の値をくり返し、真なら直前の値をキーに表を引く（なければ 0。表は
    リテラルを読むたびに、直前の値 -> リテラル を入れる）。リテラルが足りなければ ok が偽。
    bad は、リテラルがその埋め方の予測と同じだった数（正しい埋め方なら 0。予測が当たるところでは
    符号化する側がビット 0 にするので、リテラルは必ず予測と違う）。"""
    out = np.empty(n, np.int64)
    bad = 0
    m = vals.shape[0]
    size = 1
    for k in range(m):
        size = max(size, vals[k] + 1)
    tab = np.full(size, -1, np.int64)
    out[0] = vals[0]
    j = 1
    for i in range(1, n):
        p = out[i - 1]
        if bits[i - 1]:
            if j >= m:
                return out, False, bad
            x = vals[j]
            j += 1
            pred = (tab[p] if tab[p] >= 0 else 0) if table else p
            if x == pred:
                bad += 1
            tab[p] = x
        elif table:
            x = tab[p] if tab[p] >= 0 else 0
        else:
            x = p
        out[i] = x
    return out, True, bad


def _fill(bits, vals, n, mode, with_bad=False):
    if len(bits) < n - 1 or len(vals) == 0 or np.min(vals) < 0:
        raise ValueError("ビットマップかリテラルが足りない")
    out, ok, bad = _k_fill(np.asarray(bits, np.uint8), np.asarray(vals, np.int64), n, mode == "T")
    if not ok:
        raise ValueError("リテラルが足りない")
    return (out, bad) if with_bad else out


def _coded(d, n, fill=None):
    """数とビットマップとリテラルで詰めたレーン d の {埋め方: n 個の値}。fill は J の埋め方の印。"""
    cnt, i = _compact(d, 0)
    envs = []
    while i < len(d):
        m, j = _compact(d, i)
        envs.append(d[j:j + m])
        i = j + m
    if len(envs) != 2 or i != len(d):
        raise ValueError("レーンの封筒が 2 つでない")
    vals = _envelope(envs[1], cnt)
    if n == 1:
        return {"H": vals[:1]}
    bm = _envelope(envs[0], (n - 1 + 7) // 8, 8, strict=False)
    bits = np.unpackbits(bm.astype(np.uint8), bitorder="little")
    modes = {}
    if cnt == n:                         # 符号: ビットの累積の偶奇。値: 符号付きの差分の累積
        sign = np.concatenate([[0], np.cumsum(bits[:n - 1]) & 1])
        modes["S"] = np.cumsum(np.where(sign == 1, -vals, vals))
    if cnt < n and fill in ("H", "T"):
        modes[fill] = _fill(bits, vals, n, fill)
    elif cnt < n:
        # 印がなければ、くり返しか表引きか: リテラルが予測と同じになる（矛盾する）数が少ないほう。
        # 同じなら両方残し、あとで値の範囲で選ぶ
        (h, bh), (tt, bt) = _fill(bits, vals, n, "H", True), _fill(bits, vals, n, "T", True)
        if bh <= bt:
            modes["H"] = h
        if bt <= bh:
            modes["T"] = tt
    return modes


def _lanes(s, st, size, nlanes, n):
    """s[st:st + size] の BYET ブロックの {レーン: (種類, {埋め方: n 個の値})}。埋め方は R（生のバイト列）、C（全部同じ値）、
    S（ビットマップの 1 で符号を反転し、値は大きさの差分）、H、T。"""
    if s[st:st + 3] != BYET:
        raise ValueError("BYET ブロックではない")
    J = s[st + 3:st + size]
    out = {}
    for lane, t, L, pos, fill in _jdir(J, nlanes):
        d = J[pos:pos + L]
        if L == 1:                       # リテラル 1 つでビットマップなし: くり返すか、表引き（あとは 0）か
            modes = {"C": np.full(n, d[0], np.int64)}
            if d[0] and n > 1 and fill != "H":
                modes["T"] = np.zeros(n, np.int64)
                modes["T"][0] = d[0]
                if fill == "T":
                    del modes["C"]
            out[lane] = (t, modes)
            continue
        if L != n:
            out[lane] = (t, _coded(d, n, fill))
            continue
        if fill == "R":
            out[lane] = (t, {"R": np.frombuffer(d, np.uint8).astype(np.int64)})
            continue
        # 長さが値の数と同じなら生のバイト列。ただ、詰めたレーンの長さがたまたま同じこともあるので、
        # 詰めたものとして読めればその候補も残し、あとで値の範囲で選ぶ
        modes = {} if fill else {"R": np.frombuffer(d, np.uint8).astype(np.int64)}
        try:
            modes.update(_coded(d, n, fill))
        except (ValueError, IndexError, struct.error, EOFError):
            pass
        out[lane] = (t, modes)
    return out


def _components(lanes, ncomp, n):
    """成分 c はレーン 4c（下位バイト）と 4c+1（上位バイト。4c がなければ 16 ビットの値そのもの）。
    成分ごとに {埋め方の組: ジグザグの値}。"""
    out = []
    for c in range(ncomp):
        lo, hi = lanes.get(4 * c), lanes.get(4 * c + 1)
        opts = {}
        if lo is None and hi is None:
            opts["--"] = np.zeros(n, np.int64)
        elif lo is None:
            opts.update({"-" + m: v for m, v in hi[1].items()})
        else:
            for ml, vl in lo[1].items():
                for mh, vh in (hi[1].items() if hi else [("-", np.zeros(n, np.int64))]):
                    opts[ml + mh] = vl | (vh << 8)
        out.append(opts)
    return out


def _unzz(z):
    return (z >> 1) ^ -(z & 1)


# ---- メッシュ ------------------------------------------------------------------

def _nx(c):
    return c - c % 3 + (c % 3 + 1) % 3


def _pv(c):
    return c - c % 3 + (c % 3 + 2) % 3


def _fields(sec, n):
    """旧 buf5 にあたる区画。欄は [0x5A4C0000, 三角形の数, (va, vb) の組…, 頂点の数, 部品の数] の int32。
    04、欄ごとのバイトの印（4 ビット、下位から）、（印の合計が本体の長さと合わなければ本体の長さ）、本体。
    欄を 4 バイトずつ並べたバイト列を、印をビットマップとして表引きで詰めたもの（_mode_bytes の mode 4 と
    同じ: 印のないバイトは 表[直前のバイト]、書いたバイトを読むたびに 表[直前] = それ。2 つ目から）。
    先頭が 0C なら、04 のあとをさらにコンパクト長とビットマップ（0 で直前のバイトをくり返す）で詰めてある
    （64 バイトを超えるときは、ビットマップのあとにリテラルの数）。"""
    if sec[0] == 0x0C:
        L, p = _compact(sec, 1)
        sec = b"\x04" + _mode_bytes(sec, p, L, 8, L > 64)[0]
    elif sec[0] != 0x04:
        raise ValueError("欄の区画の形を知らない")
    nib = []
    for x in sec[1:1 + (n + 1) // 2]:
        nib += [x & 15, x >> 4]
    data = sec[1 + (n + 1) // 2:]
    if sum(bin(t).count("1") for t in nib[:n]) != len(data):
        dl, k = _compact(data, 0)
        data = data[k:k + dl]
    q, out = 0, []
    prev, tab, first = 0, [0] * 256, True
    for t in nib[:n]:
        v = 0
        for k in range(4):
            if t >> k & 1:
                b = data[q]
                q += 1
                if not first:
                    tab[prev] = b
                first = False
            else:
                b = tab[prev]
            v |= b << (8 * k)
            prev = b
        out.append(v - (1 << 32) if v >> 31 else v)
    return out


def _head(s):
    """メッシュの区画の見出し: (欄の数, 三角形ごとの C のビットの区画, 種類のブロックの位置と長さ, 欄の区画,
    次の位置)。"""
    v1, i = _v2s(s, 20)
    _, i = _v2s(s, i)                    # 意味は分からない
    n, i = _small(s, i)
    L, i = _compact(s, i)
    bits = s[i:i + L]
    i += L
    CL, i = _compact(s, i)
    cj = i
    i += CL
    SL, i = _compact(s, i)
    return n, bits, cj, CL, s[i:i + SL], i + SL


def _topology(s):
    """(三角形の角ごとの頂点 (F, 3), 向かいの角 (3F,), 頂点の数, 次の位置)。"""
    n, bits, cj, CL, sec, i = _head(s)
    vals = _fields(sec, n)
    return _clers(s, bits, cj, CL, vals) + (i,)


def _clers(s, bits, cj, CL, vals):
    """欄の値から三角形を組む。(三角形の角ごとの頂点 (F, 3), 向かいの角 (3F,), 頂点の数)。"""
    F, V, nb, pairs = vals[1], vals[-2], vals[-1], vals[2:-2]
    if bits[:3] == BYET:                 # C のビットも 1 レーンのブロックに詰めてあることがある
        (t, modes), = _lanes(bits, 0, len(bits), 8, (F + 7) // 8).values()
        m = "T" if t == 2 else "H"
        bits = np.asarray(modes[m] if m in modes else next(iter(modes.values())), np.uint8)
    else:
        bits = np.frombuffer(bits, np.uint8)
    bits = np.unpackbits(bits, bitorder="little")
    nonc = int(bits[:F].sum())
    nby = (nonc + 3) // 4
    if s[cj:cj + 3] == BYET:             # 1 レーンのブロック。J に埋め方の印がないので、種類 1 はくり返し、2 は表引き
        (t, modes), = _lanes(s, cj, CL, 8, nby).values()
        m = "T" if t == 2 else "H"
        cb = modes[m] if m in modes else next(iter(modes.values()))
    else:
        cb = list(s[cj:cj + CL])
    codes = np.unpackbits(np.asarray(cb, np.uint8)[:, None], axis=1)[:, ::-1]   # 2 ビットずつ下から
    codes = (codes[:, 0::2] | (codes[:, 1::2] << 1)).ravel()
    if len(bits) < F or len(codes) < nonc:
        raise ValueError("C のビットか種類が足りない")
    # 旧 C3M の 1 本の CLERS ビット列（C = 0、それ以外は 1 と 2 ビット、上から、be32 の語）にする
    t = bits[:F].astype(np.int64)
    start = np.concatenate([[0], np.cumsum(1 + 2 * t)[:-1]])
    total = int(F + 2 * nonc)
    out = np.zeros(total + (-total % 32) + 64, np.uint8)
    c = codes[:nonc]
    nc = start[t == 1]
    out[nc] = 1
    out[nc + 1] = c >> 1
    out[nc + 2] = c & 1
    b2 = np.packbits(out).tobytes()
    a = [-1] * (3 * F)
    for va, vb in zip(pairs[0::2], pairs[1::2]):
        if va >= 0:
            a[va] = vb
        if vb >= 0:
            a[vb] = va
    meta_ctr, meta, wbo, clers = edgebreaker.decode_clers(b2, F, nb, a)
    if edgebreaker._fast is not None:    # 添字を確かめる numba 版（壊れたデータでも例外で止まる）
        a, b = np.array(a, np.int64), np.full(3 * F, -1, np.int64)
        edgebreaker._fast.process_clers(np.array(meta, np.int64), meta_ctr,
                                        np.frombuffer(bytes(clers), np.uint8), wbo, nb, V, a, b)
    else:
        b = [-1] * (3 * F)
        edgebreaker.process_clers(meta, meta_ctr, clers, wbo, nb, V, a, b)
    return np.asarray(b, np.int64).reshape(-1, 3), np.asarray(a, np.int64), V


@_jit
def _k_replay(prog, D, n):
    """予測の手順 prog（m x 5）を残差 D（ジグザグを戻したもの）で再生する。手順の 0 列目:
    0 = 直前の予測 + D、1 = 元 + D、2 = 中点（C の切り捨て）+ D で中点を直前の予測にする、
    3 = 平行四辺形 a + b - c + D。"""
    out = np.zeros(n, np.int64)
    last = 0
    for i in range(prog.shape[0]):
        k, v, a, b, c = prog[i, 0], prog[i, 1], prog[i, 2], prog[i, 3], prog[i, 4]
        if k == 0:
            out[v] = last + D[v]
        elif k == 1:
            out[v] = out[a] + D[v]
        elif k == 2:
            t = out[a] + out[b] + 1
            mid = t // 2 if t >= 0 else -((-t) // 2)
            last = mid
            out[v] = mid + D[v]
        else:
            last = out[a] + out[b] - out[c]
            out[v] = last + D[v]
    return out


def _pick(prog, opts, n):
    """埋め方ごとに再生し、値の範囲が一番狭いもの。"""
    best = None
    for key in sorted(opts):
        D = _unzz(np.asarray(opts[key], np.int64))
        if len(D) != n:
            raise ValueError("値の数が合わない")
        o = _k_replay(prog, D, n)
        r = int(o.max() - o.min()) if n else 0
        if best is None or r < best[0]:
            best = (r, o)
    return best[1]


@_jit
def _k_position_prog(cor, a, F, V):
    """位置: 三角形の幅優先（未処理で番号の一番小さい三角形から、角は 0,1,2 の順）。
    始めの三角形の頂点は 直前の予測 + D、1 つ目 + D、中点 + D（中点を直前の予測にする。頂点が 3 つだけの
    かたまりの次のかたまりは、その中点から始まる）。
    入った三角形の先の頂点がまだなら平行四辺形 + D。"""
    seen = np.zeros(V, np.uint8)
    done = np.zeros(F, np.uint8)
    prog = np.zeros((V, 5), np.int64)
    queue = np.empty(F, np.int64)
    m = 0
    for st in range(F):
        if done[st]:
            continue
        c3 = 3 * st
        s0, s1, s2 = cor[c3], cor[c3 + 1], cor[c3 + 2]
        if not seen[s0]:
            prog[m, 0], prog[m, 1] = 0, s0
            seen[s0] = 1
            m += 1
        if not seen[s1]:
            prog[m, 0], prog[m, 1], prog[m, 2] = 1, s1, s0
            seen[s1] = 1
            m += 1
        if not seen[s2]:
            prog[m, 0], prog[m, 1], prog[m, 2], prog[m, 3] = 2, s2, s0, s1
            seen[s2] = 1
            m += 1
        done[st] = 1
        head, tail = 0, 1
        queue[0] = c3
        while head < tail:
            b0 = queue[head] // 3 * 3
            head += 1
            for ii in range(b0, b0 + 3):
                av = a[ii]
                if av >= 0 and not done[av // 3]:
                    done[av // 3] = 1
                    queue[tail] = av
                    tail += 1
                    v = cor[av]
                    if not seen[v]:
                        seen[v] = 1
                        prog[m, 0], prog[m, 1] = 3, v
                        prog[m, 2], prog[m, 3], prog[m, 4] = cor[b0 + (ii + 1) % 3], cor[b0 + (ii + 2) % 3], cor[ii]
                        m += 1
    return prog[:m]


@_jit
def _k_seam(a, nib, c):
    """角 c の向かいの辺が UV の継ぎ目か（印はどちらか片側にだけ付く）。"""
    if (nib[c // 3] >> (c % 3)) & 1:
        return True
    o = a[c]
    return o >= 0 and ((nib[o // 3] >> (o % 3)) & 1) == 1


@_jit
def _k_uv_indices(cor, a, nib, F, V):
    """角ごとの UV の番号と UV の数。継ぎ目を境に、未処理で番号の一番小さい三角形からチャートを始め
    （角 0,1,2 に新しい UV）、深さ優先でたどる。三角形に入ったら角 2,1,0 の順に隣を見て、継ぎ目でなく
    未処理で、残りの 2 辺のどちらも（継ぎ目でない辺で）処理済みの三角形に接していないものを控え、控えた
    順にまだ未処理なら入る。入った先の 2 角は辺の UV を写し、先の角はこのチャートでその頂点に UV が
    あればそれ、なければ新しい UV。三角形ごとのチャートの番号（0 から）も返す。"""
    done = np.zeros(F, np.uint8)
    tri_chart = np.zeros(F, np.int64)
    res = np.full(3 * F, -1, np.int64)
    uvof = np.zeros(V, np.int64)
    stamp = np.zeros(V, np.int64)        # その頂点の UV が何番目のチャートのものか
    kid_ii = np.zeros((F, 3), np.int64)  # 深さ優先の段ごとの、控えた隣
    kid_av = np.zeros((F, 3), np.int64)
    kid_n = np.zeros(F, np.int64)
    kid_i = np.zeros(F, np.int64)
    n = 0
    chart = 0
    for st in range(F):
        if done[st]:
            continue
        chart += 1
        tri_chart[st] = chart - 1
        for c in range(3 * st, 3 * st + 3):
            res[c] = n
            uvof[cor[c]] = n
            stamp[cor[c]] = chart
            n += 1
        done[st] = 1
        depth = 0
        cur = 3 * st
        while cur >= 0:
            # cur の三角形の隣を控える
            b0 = cur // 3 * 3
            k = 0
            for j in range(3):
                ii = b0 + 2 - j
                av = a[ii]
                if av < 0 or done[av // 3] or _k_seam(a, nib, ii):
                    continue
                bad = False
                ab = av // 3 * 3
                for q in (ab + (av + 1) % 3, ab + (av + 2) % 3):
                    o = a[q]
                    if o >= 0 and done[o // 3] and not _k_seam(a, nib, q):
                        bad = True
                if not bad:
                    kid_ii[depth, k] = ii
                    kid_av[depth, k] = av
                    k += 1
            kid_n[depth] = k
            kid_i[depth] = 0
            depth += 1
            # 次に入る三角形（控えを使い切った段は戻る）
            cur = -1
            while depth > 0 and cur < 0:
                d = depth - 1
                if kid_i[d] == kid_n[d]:
                    depth -= 1
                    continue
                ii = kid_ii[d, kid_i[d]]
                av = kid_av[d, kid_i[d]]
                kid_i[d] += 1
                if done[av // 3]:
                    continue
                done[av // 3] = 1
                tri_chart[av // 3] = chart - 1
                ab, ib = av // 3 * 3, ii // 3 * 3
                res[ab + (av + 2) % 3] = res[ib + (ii + 1) % 3]
                res[ab + (av + 1) % 3] = res[ib + (ii + 2) % 3]
                v = cor[av]
                if stamp[v] != chart:
                    stamp[v] = chart
                    uvof[v] = n
                    n += 1
                res[av] = uvof[v]
                cur = av
    return res, n, tri_chart


@_jit
def _k_uv_prog(res, a, F, U):
    """UV の値: 幅優先（角は 0,1,2 の順）で、辺の両側の UV の番号が同じなら渡る（継ぎ目の印があっても。
    海沿いのタイルには、印が付いていて両側の UV が同じ辺がある）。始めの三角形は
    直前の予測 + D、1 つ目 + D、中点 + D（中点を直前の予測にする）。値は UV 番号の順に並ぶ。"""
    known = np.zeros(U, np.uint8)
    done = np.zeros(F, np.uint8)
    prog = np.zeros((3 * F + U, 5), np.int64)
    queue = np.empty(F, np.int64)
    m = 0
    for st in range(F):
        if done[st]:
            continue
        c3 = 3 * st
        u0, u1, u2 = res[c3], res[c3 + 1], res[c3 + 2]
        prog[m, 0], prog[m, 1] = 0, u0
        prog[m + 1, 0], prog[m + 1, 1], prog[m + 1, 2] = 1, u1, u0
        prog[m + 2, 0], prog[m + 2, 1], prog[m + 2, 2], prog[m + 2, 3] = 2, u2, u0, u1
        m += 3
        known[u0] = 1
        known[u1] = 1
        known[u2] = 1
        done[st] = 1
        head, tail = 0, 1
        queue[0] = c3
        while head < tail:
            b0 = queue[head] // 3 * 3
            head += 1
            for ii in range(b0, b0 + 3):
                av = a[ii]
                if av < 0 or done[av // 3]:
                    continue
                ab = av // 3 * 3
                if res[b0 + (ii + 1) % 3] == res[ab + (av + 2) % 3] and res[b0 + (ii + 2) % 3] == res[ab + (av + 1) % 3]:
                    done[av // 3] = 1
                    queue[tail] = av
                    tail += 1
                    u = res[av]
                    if not known[u]:
                        known[u] = 1
                        prog[m, 0], prog[m, 1] = 3, u
                        prog[m, 2], prog[m, 3], prog[m, 4] = res[b0 + (ii + 1) % 3], res[b0 + (ii + 2) % 3], res[ii]
                        m += 1
    return prog[:m]


def _image_size(heic):
    i = heic.find(b"ispe")
    if i < 0:
        raise ValueError("画像の大きさが分からない")
    return struct.unpack_from(">II", heic, i + 8)


def decode_mesh(s, sizes):
    """メッシュの区画 s を読む。sizes はテクスチャごとの (幅, 高さ)。(位置 (V, 3) f32, 角ごとの頂点 (F, 3),
    UV (U, 2) f32（v は上向き）, 角ごとの UV の番号 (F, 3), 三角形ごとのテクスチャの番号 (F,))。"""
    step = np.float32(struct.unpack_from("<f", s, 8)[0])
    fc, a, V, i = _topology(s)
    F = len(fc)
    cor = fc.ravel()
    a = np.asarray(a, np.int64)
    # numba の中では添字を確かめないので、壊れたデータはここで止める
    if F == 0 or cor.min() < 0 or cor.max() >= V or a.max() >= 3 * F:
        raise ValueError("三角形の頂点か向かいの角が範囲の外")
    # 位置: 16 ビットの成分が 3 つ（レーン 0-3, 4-7, 8-11）
    n0, k = _compact(s, i)
    prog = _k_position_prog(cor, a, F, V)
    P = np.stack([_pick(prog, o, V) for o in _components(_lanes(s, k, n0, 12, V), 3, V)], 1)
    pos = P.astype(np.float32) * step
    # XYZ の後ろ: 余分なブロックの数とそのブロック（頂点ごとの 1 ビットの印。使わない）、数 2 つ、
    # 継ぎ目のブロック（三角形ごとに 4 ビット）
    i = k + n0
    nx, i = s[i], i + 1
    if nx > 4:
        raise ValueError("XYZ の後ろのブロックの数が多すぎる")
    for _ in range(nx):
        L, k = _compact(s, i)
        i = k + L
    _, i = _v2s(s, i)
    _, i = _v2s(s, i)
    L, k = _compact(s, i)
    nib = np.zeros(F, np.uint8)          # レーンがなければ継ぎ目なし
    if s[k:k + 3] != BYET:               # 小さなタイルでは詰めずにそのまま
        nb = np.frombuffer(s[k:k + L], np.uint8)
        nib = np.stack([nb & 15, nb >> 4], 1).ravel()[:F].copy()
    for t, modes in (_lanes(s, k, L, 8, (F + 1) // 2) if s[k:k + 3] == BYET else {}).values():
        m = "H" if t == 1 else "T"       # 1 レーン。印がないので種類で選ぶ
        nb = np.asarray(modes[m] if m in modes else next(iter(modes.values()))).astype(np.uint8)
        nib = np.stack([nb & 15, nb >> 4], 1).ravel()[:F].copy()
    if len(nib) != F:
        raise ValueError("継ぎ目の印が足りない")
    res, U, tri_chart = _k_uv_indices(cor, a, nib, F, V)
    # チャートの数、チャートごとのテクスチャの番号（テクスチャが 1 枚なら空のブロック）、UV のブロック
    charts, i = _small(s, k + L)
    L, k = _compact(s, i)
    atlas = _chart_atlas(s, k, L, charts)
    if charts != tri_chart.max() + 1 or atlas.max() >= len(sizes):
        raise ValueError("チャートの数かテクスチャの番号が合わない")
    L, k = _compact(s, k + L)
    uprog = _k_uv_prog(res, a, F, U)
    iu = np.stack([_pick(uprog, o, U) for o in _components(_lanes(s, k, L, 8, U), 2, U)], 1)
    # UV の値は、そのチャートのテクスチャの画素の 4 倍の単位（UV の番号はチャートごとに別）
    tri_atlas = atlas[tri_chart]
    uv_atlas = np.zeros(U, np.int64)
    uv_atlas[res] = np.repeat(tri_atlas, 3)
    WH = np.array(sizes, np.float32)[uv_atlas]
    uv = iu.astype(np.float32) * (np.float32(1) / (np.float32(4) * WH))
    return pos, fc, uv, res.reshape(-1, 3), tri_atlas


def _chart_atlas(s, k, L, charts):
    """チャートごとのテクスチャの番号。int32 の並びで、小さければそのまま（LE）、そうでなければ 4 レーンの
    BYET（値はレーン 0 か、レーン 0 がなければレーン 1。どちらもなければ全部 0）。"""
    if not charts:
        return np.zeros(0, np.int64)
    if s[k:k + 3] != BYET:
        if L != 4 * charts:
            raise ValueError("チャートごとのテクスチャの番号の長さが合わない")
        return np.frombuffer(s[k:k + L], "<i4").astype(np.int64)
    lanes = _lanes(s, k, L, 4, charts)
    if set(lanes) - {0, 1} or len(lanes) > 1:
        raise ValueError("チャートごとのテクスチャの番号のレーンが思っているのと違う")
    if not lanes:
        return np.zeros(charts, np.int64)
    t, modes = next(iter(lanes.values()))
    m = "H" if t == 1 else "T"           # 1 レーン。印がないので種類で選ぶ（継ぎ目のブロックと同じ）
    return np.asarray(modes[m] if m in modes else next(iter(modes.values())), np.int64)


# ---- 三角形のスプラット（part 1） --------------------------------------------------

@dataclass
class Splats:
    """柔らかい三角形の並び。Apple は三角形の内側ほど濃く、縁で消えるように描いている。"""
    vertices: np.ndarray     # (N, 3, 3) float32、メッシュと同じ局所座標
    rgba: np.ndarray         # (N, 4) uint8
    # (N, 4) float32。刻みはどれも 0.05。2・3 番目は八面体で詰めた法線（u, v を 2x-1 にして折り返す。三角形の面の
    # 向きとほぼ一致し、空の開けた側を向く）。4 番目（0〜3.15）は上がふさがっているほど小さく、木の内側や下で 0、
    # 外側や上で 3.15 に張り付く（遮蔽か空の見え方。ズームによらない）。1 番目（0.05〜1、0.7 あたりが多く、1 で
    # 張り付く）は形や色とほとんど関係がなく、ズームが低い大きなスプラットほど大きい（意味は不明。縁のぼかしの指数として使うと、
    # Apple の画面との比べで一律の指数より少し遠くなる）
    params: np.ndarray


def _mode_bytes(o, p, n, mode, counted=False):
    """o[p:] のビットマップ（(n+7)//8 バイト）と続くリテラルから n バイト。ビット 1 で次のリテラル、
    0 で直前のバイトをくり返す（mode 8）か、直前のバイトで表を引く（mode 4。表は 2 バイト目からの
    リテラルを読むたびに 直前 -> リテラル を入れ、はじめは全部 0）。"""
    nb = (n + 7) // 8
    bm = o[p:p + nb]
    p += nb
    if counted:                          # リテラルの数（使わない）
        _, p = _compact(o, p)
    out, prev, tab = bytearray(), 0, [0] * 256
    for i in range(n):
        if bm[i >> 3] >> (i & 7) & 1:
            b = o[p]
            p += 1
            if i:
                tab[prev] = b
        else:
            b = prev if mode == 8 else tab[prev]
        out.append(b)
        prev = b
    return bytes(out), p


def _origin(o, ncomp):
    """BYET の原点（成分ごとの int）。4 バイトずつそのまま、モード 08/04 で詰めた 4 バイトずつ、
    または 0x80 + 小さな BYET（4A 00 のあとに J。int のバイト b をレーン b に、成分を値として並べる）/
    0x84 + 長さ + 表引きで詰めたその BYET。小さな BYET では、いちばん上のレーンより上は符号で埋める。"""
    if len(o) == 4 * ncomp:
        return struct.unpack(f"<{ncomp}i", o)
    mode = o[0]
    if mode & 0x80:
        if mode == 0x80:
            S = bytes(o[1:])
        else:
            L, p = _compact(o, 1)
            S, _ = _mode_bytes(o, p, L, mode & 0x7F)
        S = BYET[:1] + S
        lanes = _lanes(S, 0, len(S), 4, ncomp)
        v = _lane_ints(lanes, 0, ncomp, 0)
        if lanes and max(lanes) < 3:
            bits = 8 * (max(lanes) + 1)
            v = (v + (1 << bits - 1)) % (1 << bits) - (1 << bits - 1)
        return tuple(int(x) for x in v)
    data, _ = _mode_bytes(o, 1, 4 * ncomp, mode)
    return struct.unpack(f"<{ncomp}i", data)


def _lane_ints(lanes, c, n, base):
    """成分 c（バイト b はレーン 4c+b。奇数のレーンで 1 つ前のレーンがなければ 2 バイト分の値）の int32 を
    n 個。埋め方の候補が残っていれば、値の範囲がいちばん狭い組み合わせ。"""
    opts = []
    for b in range(4):
        lane = lanes.get(4 * c + b)
        if lane is None:
            continue
        sh = 8 * (b - 1) if b % 2 and (4 * c + b - 1) not in lanes else 8 * b
        opts.append([np.asarray(v, np.int64) << sh for v in lane[1].values()])
    best = None
    for combo in itertools.product(*opts):
        v = sum(combo, np.zeros(n, np.int64)) + base
        v = (v + (1 << 31)) % (1 << 32) - (1 << 31)          # int32 で折り返す
        r = int(v.max() - v.min()) if n else 0
        if best is None or r < best[0]:
            best = (r, v)
    return best[1]


def _soup_ints(s, i, ncomp, n):
    """s[i] からの BYET ブロック（コンパクト長、25 00、原点、80 4A 00 + J）。成分ごとの int（n 個）と次の位置。"""
    L, j = _compact(s, i)
    blk = s[j:j + L]
    if blk[:2] != b"\x25\x00":
        raise ValueError("スプラットの BYET ブロックではない")
    ol, k = _compact(blk, 2)
    org = _origin(blk[k:k + ol], ncomp)
    lanes = _lanes(blk, k + ol, len(blk) - k - ol, 4 * ncomp, n)
    return np.stack([_lane_ints(lanes, c, n, org[c]) for c in range(ncomp)], 1), j + L


def decode_splats(s):
    """スプラットの区画 s（D1 22 C9 07、u32 1、u64 数、u32 8、f32 の刻み 9 つ、XYZ と属性の BYET ブロック）。
    属性: 0 = 不透明度、1-3 = RGB（-1 は 0 にする）、4-7 = params。値 = 整数 × 刻み（float32）。"""
    N = struct.unpack_from("<Q", s, 8)[0]
    if N == 0:                           # 空のときは刻みが途中までしかないことがある
        return Splats(np.zeros((0, 3, 3), np.float32), np.zeros((0, 4), np.uint8), np.zeros((0, 4), np.float32))
    steps = np.array(struct.unpack_from("<9f", s, 20), np.float32)
    xyz, i = _soup_ints(s, 56, 3, 3 * N)
    att, _ = _soup_ints(s, i, 8, N)
    v = att.astype(np.float32) * steps[1:]
    rgba = np.empty((N, 4), np.uint8)
    rgba[:, :3] = np.floor(np.clip(v[:, 1:4], 0, 1) * np.float32(255))
    rgba[:, 3] = np.floor(np.clip(v[:, 0], 0, 1) * np.float32(255))
    pos = (xyz.astype(np.float32) * steps[0]).reshape(N, 3, 3)
    return Splats(pos, rgba, v[:, 4:].copy())



SPLAT_MAGIC = b"\xd1\x22\xc9\x07"
MESH_MAGIC = b"\xe1\x21\x66\x24"


def sections(data):
    """{(部分, 項目): (始め, 終わり)}。版 1 では、項目 (2, 3) は画像の HEIC そのもの。"""
    if data[:4] != MAGIC:
        raise ValueError("R3D ではない")
    ver = struct.unpack_from("<I", data, 4)[0]
    if ver == 1:
        return _sections_v1(data)
    if ver != 2:
        raise ValueError(f"R3D の版 {ver} は知らない")
    out = {}
    for tag, s, e in _tlv(data, 11, len(data)):
        for t, a, z in _tlv(data, s + 4, e):
            if (tag, t) == (2, 3):       # 画像の区画はテクスチャの枚数だけ並ぶ（チャートごとにどれを使うかが決まる）
                out.setdefault("atlases", []).append((a, z))
            out.setdefault((tag, t), (a, z))
    return out


def _sections_v1(data):
    """版 1: 区画を見出しで探す（スプラット、メッシュ、画像の順。画像は最初の HEIC がテクスチャで、
    版 2 と同じく灰色の画像がいくつか続くことがある）。"""
    sp, me, im = data.find(SPLAT_MAGIC), data.find(MESH_MAGIC), data.find(b"ftyp") - 4
    if (data.count(SPLAT_MAGIC) > 1 or data.count(MESH_MAGIC) != 1
            or me < 112 or (sp >= 0 and not 112 <= sp < me) or (im >= 0 and im < me)):
        raise ValueError("版 1 の並びが思っているのと違う")
    out = {(2, 1): (16, 112), (2, 2): (me, im if im >= 0 else len(data))}
    if sp >= 0:
        out[(1, 3)] = (sp, me)
    if im >= 0:
        e = im                           # HEIC の終わり: ftyp、meta、mdat の箱の長さの和
        for name in (b"ftyp", b"meta", b"mdat"):
            n, t = struct.unpack_from(">I4s", data, e)
            if t != name or n < 8 or e + n > len(data):
                raise ValueError("版 1 の画像の箱が思っているのと違う")
            e += n
        out[(2, 3)] = (im, e)
        out["atlases"] = [(im, e)]
    return out


def _image_items(data, sec, k=0):
    """k 枚目のテクスチャの画像の区画の項目 [(番号, 始め, 終わり)]（版 1 では HEIC が 1 つ）。"""
    a, z = sec["atlases"][k]
    if data[a + 4:a + 8] == b"ftyp":
        return [(1, a, z)]
    return _tlv(data, a, z)


def texture(data, sec=None, k=0):
    """k 枚目のテクスチャの HEIC（その画像の区画の項目の最初）。"""
    sec = sec or sections(data)
    t, s, e = _image_items(data, sec, k)[0]
    i = data.find(b"ftyp", s, e) - 4
    if i < s:
        raise ValueError("テクスチャがない")
    return bytes(data[i:e])


def repeat_texture(data, sec, k):
    """k 枚目のテクスチャに画像の項目 13（1 か 2）があるか。あるものは水面などをくり返して貼る小さな画像
    （16 px 角のこともある）で、UV は 0〜1 の外に出る。海沿いのタイルに多い。"""
    return any(t == 13 for t, s, e in _image_items(data, sec, k))


def parse(data):
    """R3D を読んで、c3m.parse と同じ形（テクスチャごとの材質、メッシュ 1 つ）で返す。"""
    sec = sections(data)
    a, _ = sec[(2, 1)]
    d = struct.unpack_from("<12d", data, a)
    rot, trans = np.array(d[:9]).reshape(3, 3), np.array(d[9:12])
    splats = None
    if (1, 3) in sec:
        # スプラットを読み違えたとき（今のところ手元のタイルでは起きない）に備える。
        # 読めなければスプラットだけ省き、メッシュは使う
        a, z = sec[(1, 3)]
        try:
            splats = decode_splats(data[a:z])
            if len(splats.vertices) and (not np.isfinite(splats.vertices).all() or np.abs(splats.vertices).max() > 1e4):
                splats = None            # タイルから大きく外れている（読み違え）
        except (ValueError, IndexError, KeyError, struct.error, EOFError):
            splats = None
    if (2, 3) not in sec:                # 画像がない（高い区分にある、メッシュの空なもの）
        return C3M(rot, trans, [], [], splats)
    heics = [texture(data, sec, k) for k in range(len(sec["atlases"]))]
    a, z = sec[(2, 2)]
    pos, fc, uv, fuv, tri_atlas = decode_mesh(data[a:z], [_image_size(h) for h in heics])
    repeat = [repeat_texture(data, sec, k) for k in range(len(heics))]
    # UV の番号ごとに頂点を分ける（UV の番号は 1 つの頂点にしか付かない）
    vert = np.zeros(len(uv), np.int64)
    vert[fuv.ravel()] = fc.ravel()
    clamp = fuv[~np.array(repeat)[tri_atlas]].ravel()     # くり返さないテクスチャの UV だけ範囲を確かめる
    if (not np.isfinite(pos).all() or np.abs(pos).max() > 1e4 or not np.isfinite(uv).all()
            or len(clamp) and (uv[clamp].min() < -1 or uv[clamp].max() > 2)):
        raise ValueError("頂点か UV がタイルから大きく外れている（読み違え）")
    groups = {k: fuv[tri_atlas == k].astype(np.int32) for k in range(len(heics)) if (tri_atlas == k).any()}
    mesh = Mesh(pos[vert], uv, groups)    # v は c3m.Mesh と同じく上向き
    return C3M(rot, trans, [Material(h, "heic", r) for h, r in zip(heics, repeat)], [mesh], splats)


def warm():
    """numba のコンパイル（か、残してある結果の読み込み）を先に済ませる（作業プロセスの起動時に）。"""
    z, u = np.zeros(0, np.int64), np.zeros(0, np.uint8)
    one = np.zeros(1, np.int64)
    _k_huff(u, 0, one, one, 0, 0)
    _k_table(u, 0, 8, False)
    _k_lookup(one, one, one, 1)
    _k_fill(u, one, 1, True)
    _k_replay(np.zeros((0, 5), np.int64), z, 0)
    _k_position_prog(z, z, 0, 0)
    _k_uv_indices(z, z, u, 0, 0)
    _k_uv_prog(z, z, 0, 0)
