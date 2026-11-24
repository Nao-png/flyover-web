// 新しい Flyover のタイル（R3D、iOS 27 の style 98）を、ブラウザの中で読み解く。flyover/r3d.py を JavaScript に
// 書き写したもの（読み方の説明はあちらと docs/how-it-works.md の「新しい Flyover（style 98）」を見よ）。
// 読んだ結果はあちらとビット単位で同じ（scripts/check_c3m_js.py --r3d で照合）。
//
// 三角形を組む所（Edgebreaker の変種）は c3m.js のものを使う。c3m.js の作業用のスレッドが importScripts で読み、
// makeR3D に c3m.js の関数を渡す（Node.js では require('./c3m.js')）。
//
// Python 版との違い: 整数は JavaScript の数（53 ビットまで正確）で扱う。値の範囲を外れる読み違えのデータでは、
// 例外の種類や、候補の選び方が変わることがある（正しいデータでは同じ）。

'use strict';

function makeR3D({ decodeClers, processClers }) {
  const MAGIC = [0x3d, 0x96, 0x59, 0x2e];
  const isByet = (b, i) => b[i] === 0x80 && b[i + 1] === 0x4a && b[i + 2] === 0x00;
  const at = (b, i) => {                       // Python の b[i]（範囲の外は例外）
    if (i < 0 || i >= b.length) throw new RangeError('範囲の外を読んだ');
    return b[i];
  };
  const fail = m => { throw new Error(m); };
  const u32 = (b, i) => {
    if (i + 4 > b.length) throw new RangeError('struct.error');
    return (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  };
  const leNum = (b, i, n) => { let v = 0; for (let k = n - 1; k >= 0; k--) v = v * 256 + (i + k < b.length ? b[i + k] : 0); return v; };
  // 大きな配列を Math.max(...a) に広げると、呼び出しの引数が多すぎて落ちるので、ループで
  const arrMax = a => { let m = -Infinity; for (const x of a) if (x > m) m = x; return m; };
  const arrMin = a => { let m = Infinity; for (const x of a) if (x < m) m = x; return m; };
  const concat = (...xs) => { const out = new Uint8Array(xs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };

  // ---- 数の書き方
  function leb(b, i) {
    let r = 0, s = 1;
    for (;;) {
      const c = at(b, i++);
      r += (c & 0x7F) * s;
      s *= 128;
      if (c < 0x80) return [r, i];
    }
  }
  function v2(b, i) { const [r, j] = leb(b, i + 1); return [(at(b, i) & 0x7F) + r * 128, j]; }
  function v2s(b, i) { return at(b, i) < 0x40 ? [b[i], i + 1] : v2(b, i); }
  function compact(b, i) {
    const c = at(b, i);
    if (c === 0xFF) return [leNum(b, i + 1, 8), i + 9];
    let n = 0;
    while (c >> n & 1) n++;
    return [Math.floor(leNum(b, i, Math.min(n + 1, b.length - i)) / 2 ** (n + 1)), i + n + 1];
  }
  function small(b, i) {
    if (at(b, i) < 0x40) return [b[i], i + 1];
    const v = (b[i] & 0x3F) | (at(b, i + 1) & 0x7F) << 6;
    if (b[i + 1] < 0x80) return [v, i + 2];
    return [v + at(b, i + 2) * 8192, i + 3];
  }
  function tlv(b, a, e) {
    const out = [];
    while (a < e) {
      const [n, j] = leb(b, a + 1);
      out.push([b[a], j, j + n]);
      a = j + n;
    }
    return out;
  }

  // ---- ハフマン符号の封筒
  function words(b) {
    const n = b.length >> 2, by = new Uint8Array(4 * n);
    for (let w = 0; w < n; w++) { by[4 * w] = b[4 * w + 3]; by[4 * w + 1] = b[4 * w + 2]; by[4 * w + 2] = b[4 * w + 1]; by[4 * w + 3] = b[4 * w]; }
    return [by, 32 * n];
  }
  function kRead(by, nbits, p, k) {
    if (p < 0 || p + k > nbits) return [0, -1];
    let v = 0;
    for (let i = p; i < p + k; i++) v = v * 2 + (by[i >> 3] >> (7 - (i & 7)) & 1);
    return [v, p + k];
  }
  // 表。符号が 53 ビットより長ければ -2（Python 版は 62 ビット。どちらにしても本体は読めない）
  function kTable(by, nbits, p, width, empty) {
    let n, w;
    [n, p] = kRead(by, nbits, p, width);
    [w, p] = kRead(by, nbits, p, 3);
    if (p < 0) return { p: -1 };
    n += 1;
    const sym = new Array(n), lns = new Array(n), codes = new Array(n);
    let prev = -1;
    for (let i = 0; i < n; i++) {
      let ln, code, f, s;
      if (n === 1 && empty) { ln = 0; code = 0; }
      else {
        ln = 1;
        if (w) { [ln, p] = kRead(by, nbits, p, w); ln += 1; }
        if (ln > 53) return { p: -2 };
        [code, p] = kRead(by, nbits, p, ln);
      }
      [f, p] = kRead(by, nbits, p, 1);
      if (f === 0) s = prev + 1;
      else {
        [f, p] = kRead(by, nbits, p, 1);
        if (f) [s, p] = kRead(by, nbits, p, width);
        else { [s, p] = kRead(by, nbits, p, width >> 1); s += prev + 1; }
      }
      if (p < 0) return { p: -1 };
      sym[i] = s; lns[i] = ln; codes[i] = code;
      prev = s;
    }
    return { sym, lns, codes, p };
  }
  function kPrefixFree(lns, codes) {
    const n = lns.length;
    if (n === 1) return true;
    const mx = arrMax(lns);
    const lo = lns.map((l, i) => codes[i] * 2 ** (mx - l)), size = lns.map(l => 2 ** (mx - l));
    const o = lo.map((_, i) => i).sort((p, q) => lo[p] - lo[q] || p - q);
    for (let i = 0; i < n - 1; i++) if (lo[o[i]] + size[o[i]] > lo[o[i + 1]]) return false;
    return size.reduce((a, b) => a + b, 0) === 2 ** mx;
  }
  function kBody(by, nbits, p, syms, lns, codes, count, strict) {
    const out = new Float64Array(count);
    if (count === 0) return [out, 0];
    if (lns.length === 1 && lns[0] === 0) { out.fill(syms[0]); return [out, 0]; }
    const mx = arrMax(lns);
    if (mx > 22) return [out, 1];
    const sym = new Float64Array(1 << mx), lens = new Int32Array(1 << mx);
    for (let i = 0; i < syms.length; i++) {
      const lo = codes[i] * 2 ** (mx - lns[i]), hi = lo + 2 ** (mx - lns[i]);
      sym.fill(syms[i], lo, hi); lens.fill(lns[i], lo, hi);
    }
    if (p >= nbits) return [out, 2];
    const nb = by.length, mask = (1 << mx) - 1;
    let q = (p >> 3) + 1, cnt = 8 - (p & 7), buf = by[p >> 3] & ((1 << cnt) - 1);
    for (let i = 0; i < count; i++) {
      if (p >= nbits) return [out, 2];
      while (cnt < mx) { buf = (buf << 8) | (q < nb ? by[q] : 0); cnt += 8; q++; }
      const v = (buf >> (cnt - mx)) & mask, L = lens[v];
      if (L === 0) return [out, 2];
      out[i] = sym[v];
      p += L; cnt -= L; buf &= (1 << cnt) - 1;
    }
    if (strict) {
      if (nbits - p >= 32) return [out, 3];
      for (let i = p; i < nbits; i++) if (by[i >> 3] >> (7 - (i & 7)) & 1) return [out, 3];
    }
    return [out, 0];
  }
  function kStream(by, nbits, width, count, strict) {
    const t = kTable(by, nbits, 0, width, false);
    if (t.p < 0) return [new Float64Array(0), t.p === -1 ? 4 : 1];
    return kBody(by, nbits, Math.ceil(t.p / 32) * 32, t.sym, t.lns, t.codes, count, strict);
  }
  function kSplit(tby, tnbits, tlen, pby, pnbits, empty, count, strict) {
    for (const w of [8, 16]) {
      const t = kTable(tby, tnbits, 0, w, empty);
      if (t.p < 0) continue;
      if (Math.ceil(t.p / 32) * 4 === tlen && kPrefixFree(t.lns, t.codes)) return kBody(pby, pnbits, 0, t.sym, t.lns, t.codes, count, strict);
    }
    return [new Float64Array(0), 5];
  }
  const ERRORS = { 1: '符号が長すぎる', 2: 'ハフマン符号を読めない', 3: '本体の終わりが合わない', 4: 'EOF', 5: '表の幅が決まらない' };
  function envelope(e, count, width = null, strict = true) {
    const h = u32(e, 0);
    if (h === 0xE1000002) {
      const body = e.subarray(4);
      if (body.length === count) return Float64Array.from(body);
      if (body.length === 2 * count) { const o = new Float64Array(count); for (let i = 0; i < count; i++) o[i] = body[2 * i] | body[2 * i + 1] << 8; return o; }
      fail('リテラルの長さが合わない');
    }
    if (h === 0x61000002) {
      const [by, nb] = words(e.subarray(4));
      for (const w of width ? [width] : [8, 16]) {
        const [out, st] = kStream(by, nb, w, count, strict);
        if (st === 0) return out;
        if (width) fail(ERRORS[st]);
      }
      fail('ハフマン符号を読めない');
    }
    if (((h & 0xFFFF00FF) >>> 0) === 0x24000000) {
      const lvl = (h >>> 8) & 0xFF, tl = u32(e, 4), pl = u32(e, 8);
      if (tl === 0) return envelope(e.subarray(16), count, width, strict);
      const T = e.subarray(16, 16 + tl);
      let P = lvl < 2 ? e.subarray(16 + tl, 16 + tl + pl) : e.subarray(16 + tl);
      if (lvl) {
        const hd = 0x24000000 | (lvl - 1) << 8;
        P = Uint8Array.from(envelope(concat(new Uint8Array([hd & 255, hd >>> 8 & 255, hd >>> 16 & 255, hd >>> 24 & 255]), P), pl, 8), v => v & 0xFF);
      }
      const [tby, tnb] = words(T.subarray(4)), [pby, pnb] = words(P);
      const [out, st] = kSplit(tby, tnb, Math.max(T.length - 4, 0), pby, pnb, lvl === 0 && pl === 0, count, strict);
      if (st) fail(ERRORS[st]);
      return out;
    }
    fail('知らない封筒 ' + h.toString(16));
  }

  // ---- BYET ブロック
  const FILL = { 0: 'R', 1: 'H', 2: 'T', 3: 'S', 4: 'H', 5: 'T', 6: 'S' };
  const bitLE = (b, base, end, k) => { const i = base + (k >> 3); return i < end ? (b[i] >> (k & 7)) & 1 : 0; };
  function jdir(J, nlanes) {
    const nb = (nlanes + 7) >> 3;
    const active = [];
    for (let i = 0; i < nlanes; i++) if (bitLE(J, 0, Math.min(nb, J.length), i)) active.push(i);
    const m = active.length;
    const nbB = m ? (2 * m + 6 + 7) >> 3 : 0, bEnd = Math.min(nb + nbB, J.length);
    const toks = active.map((_, t) => bitLE(J, nb, bEnd, 2 * t) | bitLE(J, nb, bEnd, 2 * t + 1) << 1);
    const off = 8 * ((2 * m + 7) >> 3);
    let fill = undefined;
    if (off < 8 * nbB) { let v = 0; for (let k = 0; k < 8; k++) v |= bitLE(J, nb, bEnd, off + k) << k; fill = FILL[v]; }
    let p = nb + nbB, L = 0;
    const lanes = [];
    active.forEach((lane, k) => {
      const t = toks[k];
      if (k === 0 || toks[k - 1] & 2) [L, p] = compact(J, p);
      lanes.push({ lane, t, L, fill });
      if (t & 1 && k !== m - 1) { fill = FILL[at(J, p)]; p++; }
    });
    for (const ln of lanes) { ln.pos = p; p += ln.L; }
    if (p !== J.length) fail('J の長さが合わない');
    return lanes;
  }
  function kFill(bits, vals, n, table) {
    const out = new Float64Array(n), m = vals.length;
    let bad = 0, size = 1;
    for (let k = 0; k < m; k++) size = Math.max(size, vals[k] + 1);
    const tab = new Float64Array(size).fill(-1);
    out[0] = vals[0];
    let j = 1;
    for (let i = 1; i < n; i++) {
      const p = out[i - 1];
      let x;
      if (bits[i - 1]) {
        if (j >= m) return [out, false, bad];
        x = vals[j++];
        const pred = table ? (tab[p] >= 0 ? tab[p] : 0) : p;
        if (x === pred) bad++;
        tab[p] = x;
      } else if (table) x = tab[p] >= 0 ? tab[p] : 0;
      else x = p;
      out[i] = x;
    }
    return [out, true, bad];
  }
  function fillMode(bits, vals, n, mode, withBad = false) {
    if (bits.length < n - 1 || vals.length === 0 || arrMin(vals) < 0) fail('ビットマップかリテラルが足りない');
    const [out, ok, bad] = kFill(bits, vals, n, mode === 'T');
    if (!ok) fail('リテラルが足りない');
    return withBad ? [out, bad] : out;
  }
  const unpackLE = u8 => { const out = new Uint8Array(u8.length * 8); for (let i = 0; i < out.length; i++) out[i] = (u8[i >> 3] >> (i & 7)) & 1; return out; };
  function coded(d, n, fill) {
    let [cnt, i] = compact(d, 0);
    const envs = [];
    while (i < d.length) {
      const [m, j] = compact(d, i);
      envs.push(d.subarray(j, j + m));
      i = j + m;
    }
    if (envs.length !== 2 || i !== d.length) fail('レーンの封筒が 2 つでない');
    const vals = envelope(envs[1], cnt);
    if (n === 1) return new Map([['H', vals.slice(0, 1)]]);
    const bm = envelope(envs[0], (n - 1 + 7) >> 3, 8, false);
    const bits = unpackLE(Uint8Array.from(bm, v => v & 0xFF));
    const modes = new Map();
    if (cnt === n) {
      const S = new Float64Array(n);
      let sign = 0, acc = 0;
      for (let k = 0; k < n; k++) {
        if (k > 0) sign ^= bits[k - 1];
        acc += sign ? -vals[k] : vals[k];
        S[k] = acc;
      }
      modes.set('S', S);
    }
    if (cnt < n && (fill === 'H' || fill === 'T')) modes.set(fill, fillMode(bits, vals, n, fill));
    else if (cnt < n) {
      const [h, bh] = fillMode(bits, vals, n, 'H', true), [tt, bt] = fillMode(bits, vals, n, 'T', true);
      if (bh <= bt) modes.set('H', h);
      if (bt <= bh) modes.set('T', tt);
    }
    return modes;
  }
  function lanesOf(s, st, size, nlanes, n) {
    if (!isByet(s, st)) fail('BYET ブロックではない');
    const J = s.subarray(st + 3, st + size);
    const out = new Map();
    for (const { lane, t, L, pos, fill } of jdir(J, nlanes)) {
      const d = J.subarray(pos, pos + L);
      if (L === 1) {
        const modes = new Map([['C', new Float64Array(n).fill(d[0])]]);
        if (d[0] && n > 1 && fill !== 'H') {
          const T = new Float64Array(n);
          T[0] = d[0];
          modes.set('T', T);
          if (fill === 'T') modes.delete('C');
        }
        out.set(lane, [t, modes]);
        continue;
      }
      if (L !== n) { out.set(lane, [t, coded(d, n, fill)]); continue; }
      if (fill === 'R') { out.set(lane, [t, new Map([['R', Float64Array.from(d)]])]); continue; }
      const modes = fill ? new Map() : new Map([['R', Float64Array.from(d)]]);
      try { for (const [k, v] of coded(d, n, fill)) modes.set(k, v); } catch (e) { /* 詰めたものとしては読めない */ }
      out.set(lane, [t, modes]);
    }
    return out;
  }
  function components(lanes, ncomp, n) {
    const out = [];
    for (let c = 0; c < ncomp; c++) {
      const lo = lanes.get(4 * c), hi = lanes.get(4 * c + 1), opts = new Map();
      if (!lo && !hi) opts.set('--', new Float64Array(n));
      else if (!lo) for (const [m, v] of hi[1]) opts.set('-' + m, v);
      else {
        for (const [ml, vl] of lo[1]) {
          for (const [mh, vh] of hi ? hi[1] : [['-', new Float64Array(n)]]) {
            const v = new Float64Array(n);
            for (let i = 0; i < n; i++) v[i] = vl[i] | (vh[i] << 8);
            opts.set(ml + mh, v);
          }
        }
      }
      out.push(opts);
    }
    return out;
  }
  const unzz = z => { const h = Math.floor(z / 2); return z - 2 * h ? -h - 1 : h; };
  const firstOf = modes => modes.values().next().value;
  const pickMode = (modes, m) => (modes.has(m) ? modes.get(m) : firstOf(modes));

  // ---- メッシュ
  function fields(sec, n) {
    if (sec[0] === 0x0C) {
      const [L, p] = compact(sec, 1);
      sec = concat(new Uint8Array([4]), modeBytes(sec, p, L, 8, L > 64)[0]);
    } else if (sec[0] !== 0x04) fail('欄の区画の形を知らない');
    const nh = (n + 1) >> 1, nib = [];
    for (const x of sec.subarray(1, 1 + nh)) nib.push(x & 15, x >> 4);
    let data = sec.subarray(1 + nh);
    let pop = 0;
    for (const t of nib.slice(0, n)) for (let k = 0; k < 4; k++) pop += t >> k & 1;
    if (pop !== data.length) { const [dl, k] = compact(data, 0); data = data.subarray(k, k + dl); }
    let q = 0, prev = 0, first = true;
    const tab = new Uint8Array(256), out = [];
    for (const t of nib.slice(0, n)) {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        let b;
        if (t >> k & 1) { b = at(data, q++); if (!first) tab[prev] = b; first = false; }
        else b = tab[prev];
        v += b * 2 ** (8 * k);
        prev = b;
      }
      out.push(v >= 2 ** 31 ? v - 2 ** 32 : v);
    }
    return out;
  }
  function head(s) {
    let i, n, L, CL, SL;
    [, i] = v2s(s, 20);
    [, i] = v2s(s, i);
    [n, i] = small(s, i);
    [L, i] = compact(s, i);
    const bits = s.subarray(i, i + L);
    i += L;
    [CL, i] = compact(s, i);
    const cj = i;
    i += CL;
    [SL, i] = compact(s, i);
    return { n, bits, cj, CL, sec: s.subarray(i, i + SL), next: i + SL };
  }
  function clers(s, bits, cj, CL, vals) {
    const F = vals[1], V = vals[vals.length - 2], nb = vals[vals.length - 1], pairs = vals.slice(2, -2);
    if (isByet(bits, 0)) {
      const ls = [...lanesOf(bits, 0, bits.length, 8, (F + 7) >> 3).values()];
      if (ls.length !== 1) fail('C のビットのレーンが 1 本でない');
      const [t, modes] = ls[0];
      bits = Uint8Array.from(pickMode(modes, t === 2 ? 'T' : 'H'), v => v & 0xFF);
    }
    bits = unpackLE(bits);
    let nonc = 0;
    for (let i = 0; i < F; i++) nonc += bits[i] || 0;
    const nby = (nonc + 3) >> 2;
    let cb;
    if (isByet(s, cj)) {
      const ls = [...lanesOf(s, cj, CL, 8, nby).values()];
      if (ls.length !== 1) fail('種類のレーンが 1 本でない');
      const [t, modes] = ls[0];
      cb = Uint8Array.from(pickMode(modes, t === 2 ? 'T' : 'H'), v => v & 0xFF);
    } else cb = s.subarray(cj, cj + CL);
    const codes = new Uint8Array(cb.length * 4);
    cb.forEach((b, i) => { codes[4 * i] = b & 3; codes[4 * i + 1] = b >> 2 & 3; codes[4 * i + 2] = b >> 4 & 3; codes[4 * i + 3] = b >> 6 & 3; });
    if (bits.length < F || codes.length < nonc) fail('C のビットか種類が足りない');
    const total = F + 2 * nonc, nbit = total + ((32 - total % 32) % 32) + 64;
    const b2 = new Uint8Array(nbit >> 3);
    const setBit = k => { b2[k >> 3] |= 0x80 >> (k & 7); };
    let pos = 0, ci = 0;
    for (let f = 0; f < F; f++) {
      if (bits[f]) {
        const c = codes[ci++];
        setBit(pos);
        if (c >> 1) setBit(pos + 1);
        if (c & 1) setBit(pos + 2);
        pos += 3;
      } else pos++;
    }
    const a = new Int32Array(3 * F).fill(-1);
    for (let k = 0; k + 1 < pairs.length; k += 2) {
      const va = pairs[k], vb = pairs[k + 1];
      if (va >= 3 * F || vb >= 3 * F) fail('向かいの角が範囲の外');
      if (va >= 0) a[va] = vb;
      if (vb >= 0) a[vb] = va;
    }
    const cl = decodeClers(b2, F, nb, a);
    const b = new Int32Array(3 * F).fill(-1);
    processClers(cl.meta, cl.metaCtr, cl.clers, cl.wbo, nb, V, a, b);
    return { cor: b, a, V };
  }
  function kReplay(prog, D, n) {
    const out = new Float64Array(n);
    let last = 0;
    for (let i = 0; i < prog.length; i += 5) {
      const k = prog[i], v = prog[i + 1], a = prog[i + 2], b = prog[i + 3], c = prog[i + 4];
      if (k === 0) out[v] = last + D[v];
      else if (k === 1) out[v] = out[a] + D[v];
      else if (k === 2) { const mid = Math.trunc((out[a] + out[b] + 1) / 2); last = mid; out[v] = mid + D[v]; }
      else { last = out[a] + out[b] - out[c]; out[v] = last + D[v]; }
    }
    return out;
  }
  function pick(prog, opts, n) {
    let best = null;
    for (const key of [...opts.keys()].sort()) {
      const raw = opts.get(key);
      if (raw.length !== n) fail('値の数が合わない');
      const o = kReplay(prog, raw.map(unzz), n);
      let lo = Infinity, hi = -Infinity;
      for (const x of o) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const r = n ? hi - lo : 0;
      if (!best || r < best[0]) best = [r, o];
    }
    return best[1];
  }
  function positionProg(cor, a, F, V) {
    const seen = new Uint8Array(V), done = new Uint8Array(F), prog = new Int32Array(V * 5), queue = new Int32Array(F);
    let m = 0;
    const put = (k, v, x = 0, y = 0, z = 0) => { prog.set([k, v, x, y, z], 5 * m); m++; };
    for (let st = 0; st < F; st++) {
      if (done[st]) continue;
      const c3 = 3 * st, s0 = cor[c3], s1 = cor[c3 + 1], s2 = cor[c3 + 2];
      if (!seen[s0]) { put(0, s0); seen[s0] = 1; }
      if (!seen[s1]) { put(1, s1, s0); seen[s1] = 1; }
      if (!seen[s2]) { put(2, s2, s0, s1); seen[s2] = 1; }
      done[st] = 1;
      let hd = 0, tail = 1;
      queue[0] = c3;
      while (hd < tail) {
        const b0 = Math.floor(queue[hd++] / 3) * 3;
        for (let ii = b0; ii < b0 + 3; ii++) {
          const av = a[ii];
          if (av >= 0 && !done[Math.floor(av / 3)]) {
            done[Math.floor(av / 3)] = 1;
            queue[tail++] = av;
            const v = cor[av];
            if (!seen[v]) { seen[v] = 1; put(3, v, cor[b0 + (ii + 1) % 3], cor[b0 + (ii + 2) % 3], cor[ii]); }
          }
        }
      }
    }
    return prog.subarray(0, 5 * m);
  }
  const seam = (a, nib, c) => {
    if ((nib[Math.floor(c / 3)] >> (c % 3)) & 1) return true;
    const o = a[c];
    return o >= 0 && ((nib[Math.floor(o / 3)] >> (o % 3)) & 1) === 1;
  };
  function uvIndices(cor, a, nib, F, V) {
    const done = new Uint8Array(F), triChart = new Int32Array(F), res = new Int32Array(3 * F).fill(-1);
    const uvof = new Int32Array(V), stamp = new Int32Array(V);
    const kidII = new Int32Array(F * 3), kidAV = new Int32Array(F * 3), kidN = new Int32Array(F), kidI = new Int32Array(F);
    let n = 0, chart = 0;
    for (let st = 0; st < F; st++) {
      if (done[st]) continue;
      chart++;
      triChart[st] = chart - 1;
      for (let c = 3 * st; c < 3 * st + 3; c++) { res[c] = n; uvof[cor[c]] = n; stamp[cor[c]] = chart; n++; }
      done[st] = 1;
      let depth = 0, cur = 3 * st;
      while (cur >= 0) {
        const b0 = Math.floor(cur / 3) * 3;
        let k = 0;
        for (let j = 0; j < 3; j++) {
          const ii = b0 + 2 - j, av = a[ii];
          if (av < 0 || done[Math.floor(av / 3)] || seam(a, nib, ii)) continue;
          let bad = false;
          const ab = Math.floor(av / 3) * 3;
          for (const q of [ab + (av + 1) % 3, ab + (av + 2) % 3]) {
            const o = a[q];
            if (o >= 0 && done[Math.floor(o / 3)] && !seam(a, nib, q)) bad = true;
          }
          if (!bad) { kidII[depth * 3 + k] = ii; kidAV[depth * 3 + k] = av; k++; }
        }
        kidN[depth] = k; kidI[depth] = 0;
        depth++;
        cur = -1;
        while (depth > 0 && cur < 0) {
          const d = depth - 1;
          if (kidI[d] === kidN[d]) { depth--; continue; }
          const ii = kidII[d * 3 + kidI[d]], av = kidAV[d * 3 + kidI[d]];
          kidI[d]++;
          if (done[Math.floor(av / 3)]) continue;
          done[Math.floor(av / 3)] = 1;
          triChart[Math.floor(av / 3)] = chart - 1;
          const ab = Math.floor(av / 3) * 3, ib = Math.floor(ii / 3) * 3;
          res[ab + (av + 2) % 3] = res[ib + (ii + 1) % 3];
          res[ab + (av + 1) % 3] = res[ib + (ii + 2) % 3];
          const v = cor[av];
          if (stamp[v] !== chart) { stamp[v] = chart; uvof[v] = n; n++; }
          res[av] = uvof[v];
          cur = av;
        }
      }
    }
    return { res, U: n, triChart };
  }
  function uvProg(res, a, F, U) {
    const known = new Uint8Array(U), done = new Uint8Array(F), prog = new Int32Array((3 * F + U) * 5), queue = new Int32Array(F);
    let m = 0;
    const put = (k, v, x = 0, y = 0, z = 0) => { prog.set([k, v, x, y, z], 5 * m); m++; };
    for (let st = 0; st < F; st++) {
      if (done[st]) continue;
      const c3 = 3 * st, u0 = res[c3], u1 = res[c3 + 1], u2 = res[c3 + 2];
      put(0, u0); put(1, u1, u0); put(2, u2, u0, u1);
      known[u0] = 1; known[u1] = 1; known[u2] = 1;
      done[st] = 1;
      let hd = 0, tail = 1;
      queue[0] = c3;
      while (hd < tail) {
        const b0 = Math.floor(queue[hd++] / 3) * 3;
        for (let ii = b0; ii < b0 + 3; ii++) {
          const av = a[ii];
          if (av < 0 || done[Math.floor(av / 3)]) continue;
          const ab = Math.floor(av / 3) * 3;
          if (res[b0 + (ii + 1) % 3] === res[ab + (av + 2) % 3] && res[b0 + (ii + 2) % 3] === res[ab + (av + 1) % 3]) {
            done[Math.floor(av / 3)] = 1;
            queue[tail++] = av;
            const u = res[av];
            if (!known[u]) { known[u] = 1; put(3, u, res[b0 + (ii + 1) % 3], res[b0 + (ii + 2) % 3], res[ii]); }
          }
        }
      }
    }
    return prog.subarray(0, 5 * m);
  }
  function imageSize(image) {
    if (image[0] === 0xFF && image[1] === 0xD8) {
      let i = 2;
      while (i + 9 < image.length && image[i] === 0xFF) {
        const mk = image[i + 1];
        if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) {
          return [image[i + 7] << 8 | image[i + 8], image[i + 5] << 8 | image[i + 6]];
        }
        i += 2 + (image[i + 2] << 8 | image[i + 3]);
      }
      fail('画像の大きさが分からない');
    }
    const i = find(image, [0x69, 0x73, 0x70, 0x65]);
    if (i < 0) fail('画像の大きさが分からない');
    const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
    return [dv.getUint32(i + 8), dv.getUint32(i + 12)];
  }
  function chartAtlas(s, k, L, charts) {
    if (!charts) return new Int32Array(0);
    if (!isByet(s, k)) {
      if (L !== 4 * charts) fail('チャートごとのテクスチャの番号の長さが合わない');
      const dv = new DataView(s.buffer, s.byteOffset + k, L), o = new Int32Array(charts);
      for (let i = 0; i < charts; i++) o[i] = dv.getInt32(4 * i, true);
      return o;
    }
    const lanes = lanesOf(s, k, L, 4, charts);
    if ([...lanes.keys()].some(x => x !== 0 && x !== 1) || lanes.size > 1) fail('チャートごとのテクスチャの番号のレーンが思っているのと違う');
    if (!lanes.size) return new Int32Array(charts);
    const [t, modes] = firstOf(lanes);
    return Int32Array.from(pickMode(modes, t === 1 ? 'H' : 'T'));
  }
  function decodeMesh(s, sizes) {
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const step = dv.getFloat32(8, true);
    const h = head(s);
    const { cor, a, V } = clers(s, h.bits, h.cj, h.CL, fields(h.sec, h.n));
    let i = h.next;
    const F = cor.length / 3;
    let mn = Infinity, mx = -Infinity, amx = -Infinity;
    for (const c of cor) { if (c < mn) mn = c; if (c > mx) mx = c; }
    for (const x of a) if (x > amx) amx = x;
    if (F === 0 || mn < 0 || mx >= V || amx >= 3 * F) fail('三角形の頂点か向かいの角が範囲の外');
    let n0, k, L;
    [n0, k] = compact(s, i);
    const prog = positionProg(cor, a, F, V);
    const P = components(lanesOf(s, k, n0, 12, V), 3, V).map(o => pick(prog, o, V));
    const pos = new Float32Array(V * 3);
    for (let v = 0; v < V; v++) for (let c = 0; c < 3; c++) pos[3 * v + c] = Math.fround(Math.fround(P[c][v]) * step);
    i = k + n0;
    const nx = at(s, i++);
    if (nx > 4) fail('XYZ の後ろのブロックの数が多すぎる');
    for (let q = 0; q < nx; q++) { [L, k] = compact(s, i); i = k + L; }
    [, i] = v2s(s, i);
    [, i] = v2s(s, i);
    [L, k] = compact(s, i);
    let nib = new Uint8Array(F);
    const spread = nb => { const o = new Uint8Array(nb.length * 2); nb.forEach((x, j) => { o[2 * j] = x & 15; o[2 * j + 1] = x >> 4; }); return o.slice(0, F); };
    if (!isByet(s, k)) nib = spread(s.subarray(k, k + L));
    else {
      for (const [t, modes] of lanesOf(s, k, L, 8, (F + 1) >> 1).values()) {
        nib = spread(Uint8Array.from(pickMode(modes, t === 1 ? 'H' : 'T'), v => v & 0xFF));
      }
    }
    if (nib.length !== F) fail('継ぎ目の印が足りない');
    const { res, U, triChart } = uvIndices(cor, a, nib, F, V);
    let charts;
    [charts, i] = small(s, k + L);
    [L, k] = compact(s, i);
    const atlas = chartAtlas(s, k, L, charts);
    let tcMax = -1, atMax = -Infinity;
    for (const x of triChart) if (x > tcMax) tcMax = x;
    for (const x of atlas) if (x > atMax) atMax = x;
    if (charts !== tcMax + 1 || atMax >= sizes.length) fail('チャートの数かテクスチャの番号が合わない');
    [L, k] = compact(s, k + L);
    const uprog = uvProg(res, a, F, U);
    const iu = components(lanesOf(s, k, L, 8, U), 2, U).map(o => pick(uprog, o, U));
    const triAtlas = Int32Array.from(triChart, c => atlas[c]);
    const uvAtlas = new Int32Array(U);
    for (let c = 0; c < 3 * F; c++) uvAtlas[res[c]] = triAtlas[Math.floor(c / 3)];
    const uv = new Float32Array(U * 2);
    for (let u = 0; u < U; u++) {
      const [W, H] = sizes[uvAtlas[u]];
      uv[2 * u] = Math.fround(Math.fround(iu[0][u]) * Math.fround(1 / Math.fround(4 * W)));
      uv[2 * u + 1] = Math.fround(Math.fround(iu[1][u]) * Math.fround(1 / Math.fround(4 * H)));
    }
    return { pos, cor, uv, res, triAtlas };
  }

  // ---- 三角形のスプラット
  function modeBytes(o, p, n, mode, counted = false) {
    const nb = (n + 7) >> 3, bp = p;
    p += nb;
    if (counted) [, p] = compact(o, p);
    const out = new Uint8Array(n), tab = new Uint8Array(256);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      let b;
      if (at(o, bp + (i >> 3)) >> (i & 7) & 1) { b = at(o, p++); if (i) tab[prev] = b; }
      else b = mode === 8 ? prev : tab[prev];
      out[i] = b;
      prev = b;
    }
    return [out, p];
  }
  const i32s = (b, n) => { if (b.length < 4 * n) throw new RangeError('struct.error'); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return Array.from({ length: n }, (_, i) => dv.getInt32(4 * i, true)); };
  function origin(o, ncomp) {
    if (o.length === 4 * ncomp) return i32s(o, ncomp);
    const mode = at(o, 0);
    if (mode & 0x80) {
      let S;
      if (mode === 0x80) S = o.subarray(1);
      else { const [L, p] = compact(o, 1); [S] = modeBytes(o, p, L, mode & 0x7F); }
      S = concat(new Uint8Array([0x80]), S);
      const lanes = lanesOf(S, 0, S.length, 4, ncomp);
      let v = laneInts(lanes, 0, ncomp, 0);
      const mxl = Math.max(...lanes.keys());
      if (lanes.size && mxl < 3) {
        const bits = 8 * (mxl + 1), M = 2 ** bits, half = 2 ** (bits - 1);
        v = v.map(x => (((x + half) % M) + M) % M - half);
      }
      return Array.from(v);
    }
    const [data] = modeBytes(o, 1, 4 * ncomp, mode);
    return i32s(data, ncomp);
  }
  function laneInts(lanes, c, n, base) {
    const opts = [];
    for (let b = 0; b < 4; b++) {
      const lane = lanes.get(4 * c + b);
      if (!lane) continue;
      const sh = b % 2 && !lanes.has(4 * c + b - 1) ? 8 * (b - 1) : 8 * b, mul = 2 ** sh;
      opts.push([...lane[1].values()].map(v => v.map(x => x * mul)));
    }
    let combos = [[]];
    for (const o of opts) combos = combos.flatMap(cb => o.map(x => [...cb, x]));
    let best = null;
    for (const combo of combos) {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = base; for (const x of combo) s += x[i]; v[i] = s | 0; }
      if (combos.length === 1) return v;
      let lo = Infinity, hi = -Infinity;
      for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
      const r = n ? hi - lo : 0;
      if (!best || r < best[0]) best = [r, v];
    }
    return best[1];
  }
  function soupInts(s, i, ncomp, n) {
    const [L, j] = compact(s, i);
    const blk = s.subarray(j, j + L);
    if (blk[0] !== 0x25 || blk[1] !== 0x00) fail('スプラットの BYET ブロックではない');
    const [ol, k] = compact(blk, 2);
    const org = origin(blk.subarray(k, k + ol), ncomp);
    const lanes = lanesOf(blk, k + ol, blk.length - k - ol, 4 * ncomp, n);
    return [Array.from({ length: ncomp }, (_, c) => laneInts(lanes, c, n, org[c])), j + L];
  }
  function decodeSplats(s) {
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const N = Number(dv.getBigUint64(8, true));
    if (N === 0) return { vertices: new Float32Array(0), rgba: new Uint8Array(0), params: new Float32Array(0), n: 0 };
    const steps = Array.from({ length: 9 }, (_, i) => dv.getFloat32(20 + 4 * i, true));
    const [xyz, i] = soupInts(s, 56, 3, 3 * N);
    const [att] = soupInts(s, i, 8, N);
    const f = (x, st) => Math.fround(Math.fround(x) * st);
    const clip01 = x => Math.min(Math.max(x, 0), 1);
    const rgba = new Uint8Array(N * 4), params = new Float32Array(N * 4), vertices = new Float32Array(N * 9);
    for (let k = 0; k < N; k++) {
      for (let c = 0; c < 3; c++) rgba[4 * k + c] = Math.floor(Math.fround(clip01(f(att[c + 1][k], steps[c + 2])) * 255));
      rgba[4 * k + 3] = Math.floor(Math.fround(clip01(f(att[0][k], steps[1])) * 255));
      for (let c = 0; c < 4; c++) params[4 * k + c] = f(att[c + 4][k], steps[c + 5]);
    }
    for (let v = 0; v < 3 * N; v++) for (let c = 0; c < 3; c++) vertices[3 * v + c] = f(xyz[c][v], steps[0]);
    return { vertices, rgba, params, n: N };
  }

  // ---- ファイルの作り
  const SPLAT_MAGIC = [0xd1, 0x22, 0xc9, 0x07], MESH_MAGIC = [0xe1, 0x21, 0x66, 0x24], FTYP = [0x66, 0x74, 0x79, 0x70];
  function find(b, pat, from = 0, to = b.length) {
    outer: for (let i = Math.max(from, 0); i + pat.length <= to; i++) {
      for (let k = 0; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
      return i;
    }
    return -1;
  }
  const count = (b, pat) => { let n = 0, i = -1; while ((i = find(b, pat, i + 1)) >= 0) n++; return n; };
  function sections(data) {
    if (find(data, MAGIC, 0, 4) !== 0) fail('R3D ではない');
    const ver = u32(data, 4);
    if (ver === 1) return sectionsV1(data);
    if (ver !== 2) fail(`R3D の版 ${ver} は知らない`);
    const out = new Map();
    for (const [tag, s, e] of tlv(data, 11, data.length)) {
      for (const [t, a, z] of tlv(data, s + 4, e)) {
        const key = tag + ',' + t;
        if (key === '2,3') { if (!out.has('atlases')) out.set('atlases', []); out.get('atlases').push([a, z]); }
        if (!out.has(key)) out.set(key, [a, z]);
      }
    }
    return out;
  }
  function sectionsV1(data) {
    const sp = find(data, SPLAT_MAGIC), me = find(data, MESH_MAGIC), f = find(data, FTYP), im = f < 0 ? -5 : f - 4;
    if (count(data, SPLAT_MAGIC) > 1 || count(data, MESH_MAGIC) !== 1 || me < 112 || (sp >= 0 && !(112 <= sp && sp < me)) || (im >= 0 && im < me)) {
      fail('版 1 の並びが思っているのと違う');
    }
    const out = new Map([['2,1', [16, 112]], ['2,2', [me, im >= 0 ? im : data.length]]]);
    if (sp >= 0) out.set('1,3', [sp, me]);
    if (im >= 0) {
      let e = im;
      for (const name of ['ftyp', 'meta', 'mdat']) {
        if (e + 8 > data.length) fail('版 1 の画像の箱が思っているのと違う');
        const n = (data[e] << 24 | data[e + 1] << 16 | data[e + 2] << 8 | data[e + 3]) >>> 0;
        const t = String.fromCharCode(...data.subarray(e + 4, e + 8));
        if (t !== name || n < 8 || e + n > data.length) fail('版 1 の画像の箱が思っているのと違う');
        e += n;
      }
      out.set('2,3', [im, e]);
      out.set('atlases', [[im, e]]);
    }
    return out;
  }
  function imageItems(data, sec, k = 0) {
    const [a, z] = sec.get('atlases')[k];
    if (find(data, FTYP, a + 4, a + 8) === a + 4) return [[1, a, z]];
    return tlv(data, a, z);
  }
  function texture(data, sec, k = 0) {
    const [, s, e] = imageItems(data, sec, k)[0];
    const f = find(data, FTYP, s, e);
    let i = f < 0 ? -5 : f - 4;
    if (i < s) {
      i = find(data, [0xff, 0xd8, 0xff], s, Math.min(e, s + 32));
      if (i < 0) fail('テクスチャがない');
    }
    return data.slice(i, e);
  }
  function shadeImage(data, sec, k, item = 6) {
    for (const [t, s, e] of imageItems(data, sec, k)) {
      if (t === item) {
        const f = find(data, FTYP, s, e);
        if (f >= 0 && f - 4 >= s) return data.slice(f - 4, e);
      }
    }
    return null;
  }
  const EDGE_KINDS = { 1: 4, 2: 3 };
  function edgeKind(data, sec, k) {
    for (const [t, s, e] of imageItems(data, sec, k)) if (t === 13) return EDGE_KINDS[e > s ? data[s] : 0] || 4;
    return 0;
  }
  function capturedTime(data, sec) {
    const [a, z] = sec.get('2,1');
    const t = z - a === 152 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(z - 8, true) : 0;
    return t > 1e9 && t < 4e9 ? t : null;
  }

  // R3D を読んで、c3m.js の parse と同じ形（テクスチャごとの材質と、メッシュ）にする。材質には repeat、shade、gloss、
  // 全体には splats と captured も付く（r3d.py の parse）
  function parse(buf) {
    const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sec = sections(data);
    let [a] = sec.get('2,1');
    const d = Array.from({ length: 12 }, (_, i) => dv.getFloat64(a + 8 * i, true));
    const rotation = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)], translation = d.slice(9, 12);
    const captured = capturedTime(data, sec);
    let splats = null;
    if (sec.has('1,3')) {
      const [sa, sz] = sec.get('1,3');
      try {
        splats = decodeSplats(data.subarray(sa, sz));
        if (splats.n && splats.vertices.some(x => !Number.isFinite(x) || Math.abs(x) > 1e4)) splats = null;
      } catch (e) {
        splats = null;
      }
    }
    if (!sec.has('2,3')) return { rotation, translation, materials: [], meshes: [], splats, captured };
    const nt = sec.get('atlases').length;
    const heics = Array.from({ length: nt }, (_, k) => texture(data, sec, k));
    const [ma, mz] = sec.get('2,2');
    const m = decodeMesh(data.subarray(ma, mz), heics.map(imageSize));
    const repeat = heics.map((_, k) => edgeKind(data, sec, k) !== 0);
    const U = m.uv.length / 2, F = m.cor.length / 3;
    const vert = new Int32Array(U);
    for (let c = 0; c < 3 * F; c++) vert[m.res[c]] = m.cor[c];
    let bad = m.pos.some(x => !Number.isFinite(x) || Math.abs(x) > 1e4) || m.uv.some(x => !Number.isFinite(x));
    for (let c = 0; c < 3 * F && !bad; c++) {
      if (repeat[m.triAtlas[Math.floor(c / 3)]]) continue;
      const u = m.res[c];
      for (const x of [m.uv[2 * u], m.uv[2 * u + 1]]) if (x < -1 || x > 2) bad = true;
    }
    if (bad) fail('頂点か UV がタイルから大きく外れている（読み違え）');
    const kinds = heics.map((_, k) => edgeKind(data, sec, k));
    const V = new Float32Array(U * 3);
    for (let u = 0; u < U; u++) for (let c = 0; c < 3; c++) V[3 * u + c] = m.pos[3 * vert[u] + c];
    const meshes = [];
    for (const kind of [0, ...[...new Set(kinds.filter(x => x))].sort((p, q) => q - p)]) {
      const groups = new Map();
      for (let k = 0; k < nt; k++) {
        if (kinds[k] !== kind) continue;
        const g = [];
        for (let t = 0; t < F; t++) if (m.triAtlas[t] === k) g.push(m.res[3 * t], m.res[3 * t + 1], m.res[3 * t + 2]);
        if (g.length) groups.set(k, Int32Array.from(g));
      }
      if (groups.size || kind === 0) meshes.push({ vertices: V, uv: m.uv, groups, kind });
    }
    const materials = heics.map((h, k) => ({
      image: h, format: h[0] === 0xff && h[1] === 0xd8 ? 'jpeg' : 'heic', repeat: repeat[k],
      shade: shadeImage(data, sec, k), gloss: shadeImage(data, sec, k, 8),
    }));
    return { rotation, translation, materials, meshes, splats, captured };
  }

  return { parse, sections, decodeSplats, envelope };
}

if (typeof module !== 'undefined') module.exports = makeR3D(require('./c3m.js'));
