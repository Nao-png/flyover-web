// 古い Flyover のタイル（C3M）を、ブラウザの中で読み解く作業用のスレッド。サーバー（flyover/earth.py の
// /api/c3m/）は Apple から受け取った C3M をそのまま中継するだけで、メッシュの展開（ハフマン符号と Edgebreaker）と、
// 描くための形への並べ替えはここでする。
//
// flyover/c3m.py・huffman.py・edgebreaker.py（retroplasma/flyover-reverse-engineering の Go 版の移植）を、
// さらに JavaScript に書き写したもの。展開したメッシュはあちらとビット単位で同じ（scripts/check_c3m_js.py で照合）。
// このファイルは MIT ライセンス（LICENSE）の対象外（ライセンスのない移植元のコードを元にしているため。README の「ライセンス」を見よ）。
// あちらの Python 版は、Go の 64 ビットのシフト（逆コンパイルしたまま）でビットを読むが、ここではふつうのビットの
// 読み出し（後ろを 0 で埋める）で同じことをする。Python の負の添字（後ろから数える）にも合わせる（wrap）。
//
// 新しい Flyover（R3D）も、r3d.js を読み込んでここで読み解く。受け取るものと返すものは、このファイルの終わりを見よ。
// 返す glb は flyover/glb.py の tile_glb（hevc=True）と同じ並びで、gpu-render.js がそのまま読む（ファイルにはせず、
// メモリの上で同じ並びにするだけ）

'use strict';

const wrap = (i, n) => (i < 0 ? i + n : i);
const align3 = x => 3 * Math.trunc(x / 3);
const nxt = i => (i >= 0 ? i - i % 3 + [1, 2, 0][i % 3] : align3(i) + i + 1 - align3(i + 1));
const prv = i => (i >= 0 ? i - i % 3 + [2, 0, 1][i % 3] : align3(i) + i + 2 - align3(i + 2));
const i8 = x => (x << 24) >> 24;

// ---------------------------------------------------------------- ビットの読み出し（上位のビットから）
class Bits {
  constructor(bytes, len = bytes.length) {
    const n = (len + 3) >> 2;
    this.w = new Uint32Array(n + 4);
    for (let i = 0; i < len; i++) this.w[i >> 2] |= bytes[i] << (24 - 8 * (i & 3));
    this.pos = 0;
  }
  peek(n) {                       // 1 <= n <= 32
    const k = this.pos >>> 5, o = this.pos & 31;
    const v = o ? ((this.w[k] << o) | (this.w[k + 1] >>> (32 - o))) >>> 0 : this.w[k];
    return n === 32 ? v : v >>> (32 - n);
  }
  read(n) { const v = this.peek(n); this.pos += n; return v; }
}

// ---------------------------------------------------------------- ハフマン符号（huffman.py）
const tables = new Map();
function makeTable(p0, p1, p2, p3) {
  const key = [p0, p1, p2, p3].join(',');
  if (tables.has(key)) return tables.get(key);
  if (p3 === 0) throw new Error('huffman p3 == 0');
  const node = (index, weight) => ({ index, weight, code: 0, c1: null, c2: null, length: 0 });
  const bufs = [];
  let hp1 = p1;
  for (let i = 0; i < p3; i++) { bufs.push(node(i, Math.floor(0xFFFFFFFF / (p2 + hp1 * i)) | 0)); hp1 += p0; }
  for (let n = p3; n > 1; n--) {
    const b1 = bufs[n - 1], b2 = bufs[n - 2];
    const nd = node(-1, (b1.weight + b2.weight) | 0);
    nd.c1 = b1; nd.c2 = b2;
    let k = n;
    for (;;) {
      const b = bufs[k - 2];
      if (nd.weight <= b.weight) { bufs[k - 1] = nd; break; }
      bufs[k - 1] = b;
      k--;
      if (k - 2 === -1) { bufs[0] = nd; break; }
    }
  }
  const leaves = new Array(p3);
  const stack = [bufs[0]];
  while (stack.length) {
    const t = stack[stack.length - 1];
    if (t.index < 0) { stack[stack.length - 1] = t.c1; stack.push(t.c2); }
    else { leaves[t.index] = [t.code, t.length]; stack.pop(); }
    if (t.c1) { t.c1.code = (2 * t.code) | 0; t.c1.length = i8(t.length + 1); }
    if (t.c2) { t.c2.code = (2 * t.code + 1) | 0; t.c2.length = i8(t.length + 1); }
  }
  const buf4 = new Int8Array(0x10001), buf5 = new Int16Array(0x10000);
  let counter = 1;
  for (const [code, length] of leaves) {
    if (length >= 17) {
      const m16 = length - 16, idx5 = code >> m16;
      let idx4 = buf5[idx5];
      if (idx4 === 0) { buf5[idx5] = counter; idx4 = counter; counter++; }
      if (m16 > buf4[idx4]) buf4[idx4] = m16;
    }
  }
  buf4[0] = 16;
  // 表ごとに、項目の値（int32）と長さの 4 バイト（int32）。mark: まだ埋めていない項目
  const pages = [];
  let size = 16;
  for (let j = 0; j < counter; j++) {
    const n = 1 << size;
    pages.push({ val: new Int32Array(n), len: new Int32Array(n), mark: new Uint8Array(n).fill(1) });
    size = buf4[j + 1];
  }
  const put = (pg, i, v, l) => { pg.val[i] = v; pg.len[i] = l; pg.mark[i] = 0; };
  leaves.forEach(([code, length], idx) => {
    if (length > 16) {
      const mod = code >> (length - 16), b5 = buf5[mod];
      put(pages[0], mod, b5, -buf4[b5]);
      const b4 = buf4[b5], m16 = length - 16, lob = 0xFF & code, s = b4 - m16;
      const ptr = s >= 0 ? i8(i8(lob & ((1 << m16) - 1)) << s) : 0;
      if (ptr < 0) throw new Error('negative huffman sub-table index');
      put(pages[b5], ptr, idx, length);
    } else {
      put(pages[0], code << (16 - length), idx, length);
    }
  });
  size = 16;
  for (let j = 0; j < counter; j++) {
    if (size !== 0) {
      const pg = pages[j];
      let cv = pg.mark[0] ? 0xFFFF : pg.val[0], cl = pg.mark[0] ? 0 : pg.len[0];
      for (let c = 1; c < (1 << size); c++) {
        if (pg.mark[c]) { pg.val[c] = cv; pg.len[c] = cl; } else { cv = pg.val[c]; cl = pg.len[c]; }
      }
    }
    size = buf4[j + 1];
  }
  // 値と、長さのバイト（5 バイト目。符号なし）
  const t = { vals: pages.map(p => p.val), lens: pages.map(p => p.len.map(l => l & 0xFF)) };
  t.lens0 = Int8Array.from(t.lens[0], i8);
  tables.set(key, t);
  return t;
}
// data（len2 バイト）を、int16 の並び（len1 バイト + 3）に展開する
function huffDecode(t, data, len1, len2) {
  const out = new Uint8Array(len1 + 3);
  if (len1 < 2) return out;
  const n = len1 >> 1, bits = new Bits(data, len2);
  const fv = t.vals[0], fl = t.lens0, o16 = new Uint16Array(out.buffer, 0, n);
  for (let w = 0; w < n; w++) {
    const neg = bits.read(1);
    const idx = bits.peek(16);
    const fval = fl[idx];
    let val;
    if (fval <= 0) {
      bits.pos += 16;
      const tidx = fv[idx];
      const oidx = -fval ? bits.peek(-fval) : 0;
      bits.pos += t.lens[tidx][oidx] - 16;
      val = t.vals[tidx][oidx];
    } else {
      bits.pos += fval;
      val = fv[idx];
    }
    o16[w] = (neg ? -val : val) & 0xFFFF;
  }
  return out;
}

// ---------------------------------------------------------------- Edgebreaker（edgebreaker.py）
function decompressList(out, length, buf, sh) {
  const bits = new Bits(buf);
  for (let k = 0; k < length; k++) out[k] = bits.read(sh);
}

function readBufs(dv, bytes, off, ta, tb) {
  const bufs = [];
  let pos = 120;
  for (let i = 0; i < 10; i++) {
    const len1 = dv.getUint32(off + 12 * i, true), len2 = dv.getUint32(off + 12 * i + 4, true);
    const kind = bytes[off + 12 * i + 8];
    const raw = bytes.subarray(off + pos, off + pos + len2);
    let b;
    if (kind === 0) { b = new Uint8Array(Math.max(len1 + 3, raw.length)); b.set(raw); }
    else if (kind === 3) b = huffDecode(i === 7 ? tb : ta, raw, len1, len2);
    else throw new Error('mesh buffer type ' + kind);
    bufs.push(b);
    pos += len2;
  }
  return bufs;
}

const C = 67, L = 76, E = 69, R = 82, S = 83, P = 80;
function decodeClers(b2, res9, b5unkn32, opp) {
  const meta = new Int32Array(res9), clers = new Uint8Array(res9 * 3);
  let wbo = 0;
  if (b5unkn32 === 0 && res9 > 0) { wbo = 1; clers[0] = P; }
  if (wbo >= res9) throw new Error('no decoding of data2');
  const bits = new Bits(b2);
  let updown = 0, metaCtr = 0;
  for (;;) {
    let tri = 3 * wbo;
    const wboTmp = wbo;
    let oth = 0, restart = false;
    for (;;) {
      let out = C;
      if (bits.read(1)) {
        const code = bits.read(2);
        if (code === 0) break;
        if (code === 3) {
          wbo += oth + 1;
          clers[wboTmp + oth] = E;
          if (updown > 0) {
            updown--;
            if (wbo < res9) { restart = true; break; }
            return { metaCtr, meta, wbo, clers };
          }
          const bmc = metaCtr + 1;
          if (wbo < res9) {
            if (bmc >= b5unkn32) { clers[wboTmp + 1 + oth] = P; wbo = wboTmp + oth + 2; }
            else meta[metaCtr + 1] = wbo;
          }
          if (wbo >= res9) return { metaCtr: metaCtr + 1, meta, wbo, clers };
          metaCtr = bmc;
          restart = true;
          break;
        }
        out = code === 1 ? R : L;
      }
      clers[wbo + oth] = out;
      oth++;
      tri += 3;
      if (oth + wbo >= res9) return { metaCtr, meta, wbo: wbo + oth, clers };
    }
    if (restart) continue;
    clers[wbo + oth] = S;
    if (opp[wrap(prv(tri), opp.length)] === -1) updown++;
    wbo += oth + 1;
    if (wbo < res9) continue;
    return { metaCtr, meta, wbo, clers };
  }
}

function closeStar(a, b, c, t2) {
  const n = a.length;
  let t1 = align3(c), t2i = prv(c), t3 = t2i, t4 = a[wrap(t2i, n)], t5 = c, t6 = null, i = 0;
  for (; i <= n; i++) {
    t6 = t5 + 1;
    if (t4 < 0) break;
    b[wrap(t1 + t6 - align3(t6), n)] = t2;
    if (t4 === c) { t6 = null; break; }
    t5 = a[wrap(t3, n)];
    t1 = align3(t5);
    t2i = prv(t5);
    t3 = t2i;
    t4 = a[wrap(t2i, n)];
  }
  if (i > n) throw new Error('closeStar が終わらない');
  if (t6 !== null) b[wrap(t1 + t6 - align3(t6), n)] = t2;
  if (t2i >= 0) a[wrap(t3, n)] = c;
  if (c >= 0) a[c] = t2i;
}

function readBoundary(a, b, some, vert) {
  const n = a.length;
  let t1 = nxt(some), result, i = 0;
  for (; i <= n; i++) {
    result = nxt(t1);
    t1 = a[wrap(result, n)];
    if (t1 < 0) break;
  }
  if (i > n) throw new Error('readBoundary が終わらない');
  for (i = 0; i <= n; i++) {
    b[wrap(nxt(result), n)] = vert[0];
    result = prv(result);
    let t4 = a[wrap(result, n)], v = vert[0], k = 0;
    while (t4 >= 0) {
      b[wrap(nxt(t4), n)] = v;
      result = prv(t4);
      t4 = a[wrap(result, n)];
      v = vert[0];
      if (++k > n) throw new Error('readBoundary が終わらない');
    }
    vert[0] = v - 1;
    if (b[wrap(nxt(result), n)] !== -1) break;
  }
  if (i > n) throw new Error('readBoundary が終わらない');
}

function processClers(meta, metaCtr, clers, wbo, b5unkn32, res1, a, b) {
  if (metaCtr <= 0) throw new Error('bufMetaCtr <= 0');
  if (wbo <= 0) throw new Error('writeBufOff <= 0');
  const n = a.length, nm = meta.length, nc = clers.length;
  let stackN = 0;
  const vert = [res1 - 1];
  const tmp = new Int32Array(3 * wbo), nt = tmp.length;
  wbo--;
  for (;;) {
    const keep = b5unkn32;
    metaCtr--;
    let t1 = -1;
    while (b5unkn32 <= metaCtr || (metaCtr >= 0 && wbo >= meta[metaCtr])) {
      const s = clers[wrap(wbo, nc)], w3 = 3 * wbo;
      if (s === C) {
        if (t1 >= 0) a[t1] = w3 + 1;
        if (w3 >= -1) a[w3 + 1] = t1;
        const t2 = vert[0]--;
        closeStar(a, b, w3 + 2, t2);
        b5unkn32 = keep;
      } else if (s === L) {
        if (t1 >= 0) a[t1] = w3 + 1;
        if (w3 >= -1) a[w3 + 1] = t1;
      } else if (s === E) {
        if (t1 > 0) tmp[stackN++] = t1;
      } else if (s === R) {
        const t3 = w3 + 2;
        if (t1 >= 0) a[t1] = t3;
        if (t3 >= 0) a[w3 + 2] = t1;
      } else if (s === S) {
        if (t1 >= 0) a[t1] = w3 + 1;
        if (w3 >= -1) a[w3 + 1] = t1;
        let t4 = w3 + 2;
        const t5 = a[wrap(w3 + 2, n)];
        if (t5 === -1) {
          const t6 = tmp[wrap(stackN - 1, nt)];
          if (t4 >= 0) a[w3 + 2] = t6;
          stackN--;
          if (t6 >= 0) a[t6] = t4;
        } else if (t5 <= -2) {
          const t7 = -t5;
          if (t4 >= 0) a[w3 + 2] = t7;
          a[t7] = t4;
          let t8, i = 0;
          for (; i <= n; i++) {
            t8 = nxt(t4);
            t4 = a[wrap(t8, n)];
            if (!(t4 >= 0)) break;
          }
          if (i > n) throw new Error('S の境界が終わらない');
          readBoundary(a, b, t8, vert);
        }
      } else if (s === P) {
        if (t1 >= 0) a[t1] = w3;
        if (wbo >= 0) a[w3] = t1;
        closeStar(a, b, w3 + 1, vert[0] - 2);
        closeStar(a, b, w3 + 2, vert[0] - 1);
        closeStar(a, b, w3, vert[0]);
        vert[0] -= 3;
        metaCtr--;
        b5unkn32 = keep;
      } else throw new Error('unknown CLERS symbol ' + s);
      t1 = w3;
      wbo--;
    }
    let t9 = 0;
    if (b5unkn32 !== 0) {
      readBoundary(a, b, 3 * meta[wrap(metaCtr, nm)] + 1, vert);
      t9 = b5unkn32 - 1;
    }
    b5unkn32 = t9;
    if (metaCtr <= 0) break;
  }
  if (vert[0] !== -1) throw new Error('res1v_min1ag not -1');
}

// 三角形をたどって頂点と UV を復元する（edgebreaker.py の _traverse）
function traverse(a, res4, res6, d8, d1, vtd, uvd, res1, res9, res3Total) {
  const n4 = res4.length;
  const uv = new Int32Array(res3Total * 2), res5 = new Int32Array(res9 * 3), n5 = res5.length;
  const seen = new Uint8Array(res1), uvof = new Int32Array(res1).fill(-1);
  const done = new Uint8Array(res9), stack = new Int32Array(res9 * 3), later = new Int32Array(res9 * 3);
  const vtx = new Int32Array(res1 * 3), nv = vtx.length, group = new Int32Array(res9);
  const NX = new Int32Array(3 * res9), PV = new Int32Array(3 * res9);
  for (let t = 0; t < 3 * res9; t += 3) { NX[t] = t + 1; NX[t + 1] = t + 2; NX[t + 2] = t; PV[t] = t + 2; PV[t + 1] = t; PV[t + 2] = t + 1; }
  const i16 = x => (((x + 0x8000) & 0xFFFF) - 0x8000);
  let nUv = 0;
  const unpackVtx = av => {
    const idx3 = a[av];
    const h = 3 * res4[wrap(nxt(idx3), n4)], i_ = 3 * res4[wrap(prv(idx3), n4)];
    const j = 3 * res4[wrap(idx3, n4)], k = 3 * res4[av];
    for (let c = 0; c < 3; c++) {
      vtx[wrap(k + c, nv)] = i16(vtx[wrap(h + c, nv)] + vtx[wrap(i_ + c, nv)] - vtx[wrap(j + c, nv)] - vtd[wrap(k + c, nv)]);
    }
    seen[wrap(Math.floor(k / 3), res1)] = 1;
  };
  const unpackUv = c3 => {
    let r = nUv;
    for (const idx of [PV[c3], c3, NX[c3]]) {
      uv[2 * r] = uvd[2 * r]; uv[2 * r + 1] = uvd[2 * r + 1];
      res5[idx] = r;
      uvof[wrap(res4[idx], res1)] = r;
      r++;
    }
    nUv = r;
  };
  let ctrA = 0, ctrC = 0, ctrB = 0, ctrD = 0, ctd = 0, x = 0, v = 0;
  for (;;) {
    while (ctrC < res9 && done[ctrC] !== 0) ctrC++;
    if (ctrC === res9) break;
    const c3 = 3 * ctrC;
    stack[ctrA++] = c3;
    for (const e of [res4[PV[c3]], res4[c3], res4[NX[c3]]]) {
      const ew = wrap(e, res1);
      for (let c = 0; c < 3; c++) vtx[3 * ew + c] = vtd[wrap(3 * e + c, nv)];
      seen[ew] = 1;
    }
    unpackUv(c3);
    done[ctrC] = 1;
    group[ctrC] = res6[ctrB++];
    if ((ctd | ctrA) === 0) continue;
    let nb = ctrB, restart = false;
    for (;;) {
      let nb01;
      if (ctrA !== 0) nb01 = nb;
      else {
        let cnt = ctd - 1;
        for (;;) {
          v = later[cnt];
          x = done[Math.floor(v / 3)];
          ctd--;
          if (ctd === 0) break;
          cnt--;
          if (x === 0) break;
        }
        if (x !== 0) { ctrA = 0; ctrB = nb; restart = true; break; }
        uvof.fill(-1);
        if (seen[wrap(res4[v], res1)] === 0) unpackVtx(v);
        unpackUv(v);
        ctrA = 1;
        done[Math.floor(v / 3)] = 1;
        nb01 = nb + 1;
        group[Math.floor(v / 3)] = res6[nb];
        stack[0] = v;
      }
      nb = nb01;
      let am1 = ctrA - 1;
      const cond = stack[ctrA - 1], g6 = res6[nb01 - 1];
      let ii = cond;
      for (;;) {
        const av = a[ii];
        if (av >= 0 && done[Math.floor(av / 3)] === 0) {
          const i1 = PV[ii], i2 = NX[ii];
          let other = true;
          if (d8[wrap(res4[i1], res1)] !== 0 && d8[wrap(res4[i2], res1)] !== 0) {
            ctrD++;
            if (d1[ctrD - 1] !== 0) { later[ctd++] = av; other = false; }
          }
          if (other) {
            const t = wrap(res4[av], res1);
            if (seen[t] === 0) unpackVtx(av);
            let r = uvof[t];
            if (r === -1) {
              const an = a[av];
              const n1 = res5[wrap(nxt(an), n5)], n2 = res5[wrap(prv(an), n5)], n3 = res5[wrap(an, n5)];
              r = nUv;
              const nu = i16(uv[2 * n1] + uv[2 * n2] - uv[2 * n3]);
              const nvv = i16(uv[2 * n1 + 1] + uv[2 * n2 + 1] - uv[2 * n3 + 1]);
              uv[2 * r] = i16(nu - uvd[2 * r]);
              uv[2 * r + 1] = i16(nvv - uvd[2 * r + 1]);
              nUv = r + 1;
              uvof[t] = r;
            }
            res5[av] = r;
            res5[PV[av]] = res5[i2];
            res5[NX[av]] = res5[i1];
            done[Math.floor(av / 3)] = 1;
            group[Math.floor(av / 3)] = g6;
            stack[am1++] = av;
          }
        }
        ii = NX[ii];
        if (ii === cond) break;
      }
      ctrA = am1;
      if ((ctd | am1) === 0) { ctrB = nb; restart = true; break; }
    }
    if (restart) continue;
  }
  return { vtx, uv, res5, group, nUv };
}

function decompress(bytes, dv, off, ta, tb) {
  const bufs = readBufs(dv, bytes, off, ta, tb);
  const b0 = new DataView(bufs[0].buffer, bufs[0].byteOffset, bufs[0].byteLength);
  const i32_0 = b0.getInt32(0, true);
  const f64 = [b0.getFloat64(4, true), b0.getFloat64(12, true), b0.getFloat64(20, true)];
  const f32 = [b0.getFloat32(28, true), b0.getFloat32(32, true), b0.getFloat32(36, true)];
  const i8_0 = bufs[0][40];
  const res3Total = b0.getInt32(41, true), i32_1 = b0.getInt32(45, true), i32_2 = b0.getInt32(49, true);
  const i8_1 = bufs[0][53], i32_3 = b0.getInt32(54, true), i32_4 = b0.getUint32(58, true);
  if (i32_0 < 0 || i8_0 === 0 || (i32_1 | i32_2) < 0 || i8_1 === 0 || i32_4 & 0x80000000) throw new Error('incorrect values in buf 0');
  const b5 = new DataView(bufs[5].buffer, bufs[5].byteOffset, bufs[5].byteLength);
  const res9 = b5.getInt32(0, true);
  if (res9 < 0) throw new Error('incorrect values in buf 5 #1');
  let fst = i32_0 - 32, snd = 32;
  const a = new Int32Array(res9 * 3).fill(-1), b = new Int32Array(res9 * 3).fill(-1), n = a.length;
  if (fst >= 128) {
    do {
      const va = b5.getInt32(snd >> 3, true), vb = b5.getInt32((snd >> 3) + 4, true);
      if (va >= 0) a[wrap(va, n)] = vb;
      if (vb >= 0) a[wrap(vb, n)] = va;
      fst -= 64; snd += 64;
    } while (fst > 127);
  }
  const res1 = b5.getInt32(snd >> 3, true), b5unkn32 = b5.getInt32((snd >> 3) + 4, true);
  if ((res1 | b5unkn32) < 0) throw new Error('incorrect values in buf 5 #2');

  const cl = decodeClers(bufs[2], res9, b5unkn32, a);
  processClers(cl.meta, cl.metaCtr, cl.clers, cl.wbo, b5unkn32, res1, a, b);
  const res4 = b;

  const res6 = new Int32Array(Math.max(res9, i32_2));
  decompressList(res6, i32_2, bufs[4], i8_1);
  if (i32_2 === 1 && res9 >= 2) res6.fill(res6[0], 1);

  const d9 = new Int32Array(Math.max(res1, i32_3));
  decompressList(d9, i32_3, bufs[9], 1);
  const othB = new Uint8Array(res1), res8 = new Int32Array(res1);
  for (let i = 0; i < 3 * res9; i++) {
    if (a[i] === -1) { othB[wrap(res4[prv(i)], res1)] = 1; othB[wrap(res4[nxt(i)], res1)] = 1; }
  }
  let read = 0;
  for (let i = 0; i < res1; i++) if (othB[i]) res8[i] = d9[read++];

  const d8 = new Uint8Array(res1);
  decompressList(d8, res1, bufs[8], 1);
  const d1 = new Uint8Array(i32_4);
  decompressList(d1, i32_4, bufs[1], 1);
  const i16s = u => new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1)));
  const uvd = i16s(bufs[6]), vtd = i16s(bufs[7]);

  const tr = traverse(a, res4, res6, d8, d1, vtd, uvd, res1, res9, res3Total);
  // あちらと同じく float64 で計算してから float32 に丸める
  const verts = new Float32Array(res1 * 3);
  for (let i = 0; i < res1 * 3; i++) verts[i] = tr.vtx[i] * f64[i % 3] + f32[i % 3];
  const scale = 1 / (2 ** i8_0 - 1);
  const uvs = new Float32Array(tr.nUv * 2);
  for (let i = 0; i < tr.nUv * 2; i++) uvs[i] = tr.uv[i] * scale;
  return { vertices: verts, uv: uvs, uvCount: tr.nUv, faces: res4, res5: tr.res5, groups: tr.group, res8, facesCount: res9 };
}

// ---------------------------------------------------------------- C3M（c3m.py）
// 角ごとの UV 番号で頂点を並べ直す（c3m.py の _assemble）
function assemble(r) {
  const nUv = r.uvCount, nF = r.facesCount;
  const fst = new Int32Array(nUv);
  for (let c = 0; c < 3 * nF; c++) fst[r.res5[c]] = r.faces[c];
  const snd = new Int32Array(nUv);
  let cb = 0, cf = 0;
  for (let i = 0; i < nUv; i++) {
    if (r.res8[wrap(fst[i], r.res8.length)] !== 0) snd[i] = nUv - ++cb;
    else snd[i] = cf++;
  }
  const V = new Float32Array(nUv * 3), UV = new Float32Array(nUv * 2);
  for (let i = 0; i < nUv; i++) {
    const s = snd[i], f = wrap(fst[i], r.vertices.length / 3);
    V[3 * s] = r.vertices[3 * f]; V[3 * s + 1] = r.vertices[3 * f + 1]; V[3 * s + 2] = r.vertices[3 * f + 2];
    UV[2 * s] = r.uv[2 * i]; UV[2 * s + 1] = r.uv[2 * i + 1];
  }
  // 材質ごとの三角形（出てきた順）
  const groups = new Map();
  for (let t = 0; t < nF; t++) {
    const m = r.groups[t];
    if (!groups.has(m)) groups.set(m, []);
    const g = groups.get(m);
    g.push(snd[r.res5[3 * t]], snd[r.res5[3 * t + 1]], snd[r.res5[3 * t + 2]]);
  }
  for (const [m, g] of groups) groups.set(m, Int32Array.from(g));
  return { vertices: V, uv: UV, groups };
}

function quatMatrix(qx, qy, qz, qw) {
  return [
    [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qw * qz, 2 * qx * qz + 2 * qw * qy],
    [2 * qx * qy + 2 * qw * qz, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qw * qx],
    [2 * qx * qz - 2 * qw * qy, 2 * qy * qz + 2 * qw * qx, 1 - 2 * qx * qx - 2 * qy * qy]];
}

const TEXTURE_FORMATS = { 0: 'jpeg', 13: 'heic' };
function parse(buf) {
  const bytes = new Uint8Array(buf), dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 134 || bytes[0] !== 67 || bytes[1] !== 51 || bytes[2] !== 77 || bytes[3] !== 3) throw new Error('C3M 第 3 版ではない');
  if (bytes[4] !== 3 && bytes[4] !== 7) throw new Error('C3M のサブ版 ' + bytes[4]);
  let rot = null, trans = null, materials = [], meshes = [], off = 6;
  for (let k = 0; k < bytes[5]; k++) {
    const kind = bytes[off];
    if (kind === 0) {
      const q = [0, 1, 2, 3].map(i => dv.getFloat64(off + 9 + 8 * i, true));
      rot = quatMatrix(...q);
      trans = [0, 1, 2].map(i => dv.getFloat64(off + 41 + 8 * i, true));
      off += 113;
    } else if (kind === 1) {
      off += 5;
      const n = dv.getInt32(off, true);
      off += 4;
      materials = [];
      for (let i = 0; i < n; i++) {
        const mtype = bytes[off];
        if (mtype > 10) throw new Error('材質の種類 ' + mtype);
        const fmt = bytes[off + 3], toff = dv.getInt32(off + 4, true), tlen2 = dv.getInt32(off + 12, true);
        if (!(fmt in TEXTURE_FORMATS)) throw new Error('画像の形式 ' + fmt);
        materials.push({ image: bytes.subarray(toff, toff + tlen2), format: TEXTURE_FORMATS[fmt] });
        off += 16;
      }
    } else if (kind === 2) {
      off += 5;
      const n = dv.getInt32(off, true);
      off += 4;
      meshes = [];
      for (let i = 0; i < n; i++) {
        const mtype = i8(bytes[off]), size = i8(bytes[off + 1]) + (i8(bytes[off + 2]) << 8);
        if (mtype !== 2) throw new Error('メッシュの種類 ' + mtype);
        const o3 = off + 3, a8 = i8(bytes[o3]);
        const prm = o => [dv.getInt32(o, true), dv.getInt32(o + 4, true), dv.getInt32(o + 8, true), dv.getInt16(o + 12, true)];
        const ta = makeTable(...prm(o3 + 1)), tb = makeTable(...prm(o3 + 15));
        const uvCount = dv.getInt32(o3 + 29, true), facesCount = dv.getInt32(o3 + 33, true);
        const groupCount = dv.getInt32(o3 + 37, true), dataOff = dv.getInt32(o3 + 41, true);
        if (groupCount === 0 && a8 === 6) throw new Error('??? 1');
        if (a8 === 8) throw new Error('??? 2');
        const r = decompress(bytes, dv, dataOff, ta, tb);
        if (r.uvCount !== uvCount || r.facesCount !== facesCount) throw new Error('展開したメッシュの数が先頭の数と合わない');
        const mesh = assemble(r);
        mesh.kind = bytes[o3];
        meshes.push(mesh);
        off += size;
      }
    } else if (kind === 3) break;          // シーングラフかアニメーション。読み飛ばし方が分からない
    else throw new Error('不明な項目 ' + kind);
  }
  return { rotation: rot, translation: trans, materials, meshes };
}

// ---------------------------------------------------------------- 描くための形（glb.py の tile_glb の hevc=True と同じ並び）
function box(b, a, z, name) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (a + 8 <= z) {
    const n = dv.getUint32(a);
    if (n < 8 || a + n > z) return null;
    if (String.fromCharCode(b[a + 4], b[a + 5], b[a + 6], b[a + 7]) === name) return [a + 8, a + n];
    a += n;
  }
  return null;
}
// HEIC が HEVC の 1 コマだけなら { config: hvcC の中身, data: コマ, w, h }（glb.py の heif_hevc）
function heifHevc(heic) {
  try {
    const dv = new DataView(heic.buffer, heic.byteOffset, heic.byteLength);
    const meta = box(heic, 0, heic.length, 'meta');
    const a = meta[0] + 4, z = meta[1];
    const ii = box(heic, a, z, 'iinf');
    if (heic[ii[0]] !== 0 || dv.getUint16(ii[0] + 4) !== 1) return null;
    const infe = box(heic, ii[0] + 6, ii[1], 'infe');
    if (heic[infe[0]] < 2 || String.fromCharCode(...heic.subarray(infe[0] + 8, infe[0] + 12)) !== 'hvc1') return null;
    const ipco = box(heic, ...box(heic, a, z, 'iprp'), 'ipco');
    const hvcc = box(heic, ...ipco, 'hvcC');
    const ispe = box(heic, ...ipco, 'ispe')[0];
    const w = dv.getUint32(ispe + 4), h = dv.getUint32(ispe + 8);
    const loc = box(heic, a, z, 'iloc')[0];
    if (heic[loc] !== 0 || heic[loc + 4] !== 0x44 || heic[loc + 5] !== 0) return null;
    const n = dv.getUint16(loc + 6), ext = dv.getUint16(loc + 12), o = dv.getUint32(loc + 14), len = dv.getUint32(loc + 18);
    if (n !== 1 || ext !== 1 || o + len > heic.length) return null;
    return { config: heic.subarray(hvcc[0], hvcc[1]), data: heic.subarray(o, o + len), w, h };
  } catch (e) {
    return null;
  }
}

const MAIN = 0;   // メッシュの種類のうち本体（範囲の端の、平らな地図につなぐための帯や面は入れない）
// スプラットの縁のぼかし（glb.py の SPLAT_SOFTNESS と _soft_triangle）
const SPLAT_SOFTNESS = 1.5;

// 小さな PNG（RGBA、圧縮しない deflate）を作る
function pngRGBA(w, h, px) {
  const crcT = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; }
  const crc = (b, a, z) => { let c = -1; for (let i = a; i < z; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const raw = new Uint8Array(h * (1 + 4 * w));
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * 4 * w, (y + 1) * 4 * w), y * (1 + 4 * w) + 1);
  const blocks = [];
  for (let o = 0; o < raw.length; o += 65535) {
    const n = Math.min(65535, raw.length - o), last = o + n >= raw.length;
    blocks.push(new Uint8Array([last ? 1 : 0, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255]), raw.subarray(o, o + n));
  }
  let s1 = 1, s2 = 0;
  for (const b of raw) { s1 = (s1 + b) % 65521; s2 = (s2 + s1) % 65521; }
  const z = [new Uint8Array([0x78, 0x01]), ...blocks, new Uint8Array([s2 >> 8, s2 & 255, s1 >> 8, s1 & 255])];
  const cat = xs => { const o = new Uint8Array(xs.reduce((a, x) => a + x.length, 0)); let q = 0; for (const x of xs) { o.set(x, q); q += x.length; } return o; };
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc(c, 4, 8 + data.length));
    return c;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, w); hv.setUint32(4, h); ihdr.set([8, 6, 0, 0, 0], 8);
  return cat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', cat(z)), chunk('IEND', new Uint8Array(0))]);
}
let softTri = null;
function softTriangle(size = 64) {
  if (softTri) return softTri;
  const px = new Uint8Array(size * size * 4).fill(255);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = (i + 0.5) / size, v = (j + 0.5) / size, w = 1 - u - v;
    px[4 * (j * size + i) + 3] = Math.round(Math.min(Math.max(27 * u * v * w, 0), 1) ** SPLAT_SOFTNESS * 255);
  }
  return (softTri = pngRGBA(size, size, px));
}

// 読んだタイル（c3m.js の parse か r3d.js の parse の並び）を、glb.py の tile_glb（hevc=True）と同じ並びの glb にする
// （ファイルにはせず、メモリの上で）。画像は HEVC の 1 コマならそのまま extras.hevc に、JPEG ならそのまま images に。
// R3D の日の当たり方とガラスの地図（白黒の HEVC）は、ブラウザの GPU では展開できない（WebCodecs が 4:0:0 を受け付けない）
// ので入れない。三角形がなければ null
function tileModel(c3ms, warnings = []) {
  const parts = [], splats = [];
  const toEcef = (c, verts) => {
    const n = verts.length / 3, X = new Float64Array(n * 3), R = c.rotation, T = c.translation;
    for (let i = 0; i < n; i++) {
      const x = verts[3 * i], y = verts[3 * i + 1], z = verts[3 * i + 2];
      for (let k = 0; k < 3; k++) X[3 * i + k] = x * R[k][0] + y * R[k][1] + z * R[k][2] + T[k];
    }
    return X;
  };
  c3ms.forEach((c, ci) => {
    for (const m of c.meshes) {
      if (m.kind !== MAIN) continue;
      const X = toEcef(c, m.vertices);
      for (const [mat, F] of m.groups) if (F.length) parts.push({ X, UV: m.uv, F, ci, mat });
    }
    const sp = c.splats;
    if (sp && sp.n) {
      const keep = [];
      for (let k = 0; k < sp.n; k++) if (sp.rgba[4 * k + 3] > 0) keep.push(k);   // 見えないもの（不透明度 0）は入れない
      if (keep.length) {
        const V = new Float32Array(keep.length * 9), rgba = new Uint8Array(keep.length * 4), sun = new Uint8Array(keep.length);
        keep.forEach((k, i) => {
          V.set(sp.vertices.subarray(9 * k, 9 * k + 9), 9 * i);
          rgba.set(sp.rgba.subarray(4 * k, 4 * k + 4), 4 * i);
          sun[i] = Math.min(Math.max(Math.round(sp.params[4 * k + 3] / 0.05), 0), 63);
        });
        splats.push({ X: toEcef(c, V), rgba, sun });
      }
    }
  });
  if (!parts.length && !splats.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const seenX = new Set();
  for (const { X } of [...parts, ...splats]) {
    if (seenX.has(X)) continue;                   // 材質ごとの部分は、同じメッシュの頂点を共有する
    seenX.add(X);
    for (let i = 0; i < X.length; i += 3) {
      const x = X[i], y = X[i + 1], z = X[i + 2];
      if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
      if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
      if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
    }
  }
  const center = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
  const step = Math.max(Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 1e-3) / 32767;

  const chunks = [];
  let binLen = 0;
  const views = [], accessors = [], images = [], materials = [], textures = [], prims = [];
  const view = (u8, extra) => {
    binLen = (binLen + 3) & ~3;
    views.push({ buffer: 0, byteOffset: binLen, byteLength: u8.byteLength, ...extra });
    chunks.push([binLen, u8]);
    binLen += u8.byteLength;
    return views.length - 1;
  };
  const accessor = (arr, ctype, type, count, more) => {
    accessors.push({ bufferView: view(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)), componentType: ctype, count, type, ...more });
    return accessors.length - 1;
  };
  const quantize = (X, idx, n, slab) => {          // int16 x 4（4 つ目は HEVC の材質の番号）
    const P = new Int16Array(n * 4), qlo = [32767, 32767, 32767], qhi = [-32768, -32768, -32768];
    for (let i = 0; i < n; i++) {
      const u = idx ? idx[i] : i;
      for (let k = 0; k < 3; k++) {
        const q = Math.round((X[3 * u + k] - center[k]) / step);
        P[4 * i + k] = q;
        if (q < qlo[k]) qlo[k] = q;
        if (q > qhi[k]) qhi[k] = q;
      }
      P[4 * i + 3] = slab;
    }
    const pos = accessor(P, 5122, 'VEC3', n, { min: qlo, max: qhi });
    views[accessors[pos].bufferView].byteStride = 8;
    return pos;
  };
  const unlit = { metallicFactor: 0, roughnessFactor: 1 };
  const matIndex = new Map();
  let slabs = 0;
  for (const { X, UV, F, ci, mat } of parts) {
    const key = ci + ':' + mat;
    if (!matIndex.has(key)) {
      const m = c3ms[ci].materials[mat];
      const hv = m && m.format === 'heic' ? heifHevc(m.image) : null;
      if (hv) {
        materials.push({ pbrMetallicRoughness: unlit, doubleSided: true,
          extras: { hevc: { config: view(hv.config), data: view(hv.data), width: hv.w, height: hv.h, slab: slabs++ } } });
      } else if (m && m.format === 'jpeg') {
        images.push({ bufferView: view(m.image), mimeType: 'image/jpeg' });
        textures.push({ source: images.length - 1, sampler: m.repeat ? 1 : 0 });
        materials.push({ pbrMetallicRoughness: { ...unlit, baseColorTexture: { index: textures.length - 1 } }, doubleSided: true });
      } else {
        materials.push(null);       // 読めない画像（分割された HEIC など）。描かない
        warnings.push(`区分 ${ci} の材質 ${mat} の画像（${m ? m.format : 'なし'}）を読めないので、その三角形は描かない`);
      }
      matIndex.set(key, materials.length - 1);
    }
    const mi = matIndex.get(key);
    if (!materials[mi]) continue;
    // 使う頂点だけを番号の順に（np.unique と同じ）
    const nX = X.length / 3, remap = new Int32Array(nX).fill(-1);
    for (let i = 0; i < F.length; i++) remap[F[i]] = 0;
    let nu = 0;
    for (let u = 0; u < nX; u++) if (remap[u] === 0) remap[u] = nu++; else remap[u] = -1;
    const used = new Int32Array(nu);
    for (let u = 0; u < nX; u++) if (remap[u] >= 0) used[remap[u]] = u;
    const slab = materials[mi].extras ? materials[mi].extras.hevc.slab : 255;
    let inside = true;
    const uvq = new Float64Array(nu * 2);
    for (let i = 0; i < nu; i++) {
      const u = used[i], a = UV[2 * u], b = 1 - UV[2 * u + 1];      // C3M は v が上向き、glTF は下向き
      uvq[2 * i] = a; uvq[2 * i + 1] = b;
      if (a < 0 || a > 1 || b < 0 || b > 1) inside = false;
    }
    const tex = inside
      ? accessor(Uint16Array.from(uvq, v => Math.round(v * 65535)), 5123, 'VEC2', nu, { normalized: true })
      : accessor(Float32Array.from(uvq), 5126, 'VEC2', nu);
    const pos = quantize(X, used, nu, slab);
    const I = nu < 65536 ? new Uint16Array(F.length) : new Uint32Array(F.length);
    for (let i = 0; i < F.length; i++) I[i] = remap[F[i]];
    const ix = accessor(I, nu < 65536 ? 5123 : 5125, 'SCALAR', F.length);
    prims.push({ attributes: { POSITION: pos, TEXCOORD_0: tex }, indices: ix, material: mi });
  }
  if (splats.length) {
    // 1 つにまとめて、低いものから順に（半透明なので奥から。視点はたいてい上なので、高さの順で代わりになる）
    const N = splats.reduce((a, s) => a + s.sun.length, 0);
    const X = new Float64Array(N * 9), rgba = new Uint8Array(N * 4), sun = new Uint8Array(N);
    let o = 0;
    for (const s of splats) { X.set(s.X, 9 * o); rgba.set(s.rgba, 4 * o); sun.set(s.sun, o); o += s.sun.length; }
    // 高さ = 三角形の中心と上向き（タイルの中心の向き）の内積。numpy と同じ順に計算する（並びが同じになるよう）
    const cl = Math.sqrt(center[0] * center[0] + center[1] * center[1] + center[2] * center[2]), up = center.map(v => v / cl);
    const h = new Float64Array(N);
    for (let k = 0, o = 0; k < N; k++, o += 9) {
      h[k] = (X[o] + X[o + 3] + X[o + 6]) / 3 * up[0] + (X[o + 1] + X[o + 4] + X[o + 7]) / 3 * up[1] + (X[o + 2] + X[o + 5] + X[o + 8]) / 3 * up[2];
    }
    const order = Uint32Array.from({ length: N }, (_, k) => k).sort((a, b) => h[a] - h[b] || a - b);
    const Xo = new Float64Array(N * 9);
    for (let i = 0; i < N; i++) for (let j = 0; j < 9; j++) Xo[9 * i + j] = X[9 * order[i] + j];
    images.push({ bufferView: view(softTriangle()), mimeType: 'image/png' });
    textures.push({ source: images.length - 1, sampler: 0 });
    materials.push({ pbrMetallicRoughness: { ...unlit, baseColorTexture: { index: textures.length - 1 } }, alphaMode: 'BLEND', doubleSided: true });
    const pos = quantize(Xo, null, 3 * N, 255);
    // 色は線形の 16 ビットに（sRGB を戻す）。不透明度の下位 6 ビットに日の当たり方
    const LIN = new Uint16Array(256), A16 = new Uint16Array(256);
    for (let b = 0; b < 256; b++) {
      const x = b / 255;
      LIN[b] = Math.round((x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4) * 65535);
      A16[b] = Math.round(x * 65535) & ~63;
    }
    const C = new Uint16Array(N * 12);
    for (let i = 0; i < N; i++) {
      const k = order[i], r = LIN[rgba[4 * k]], gg = LIN[rgba[4 * k + 1]], bb = LIN[rgba[4 * k + 2]], a = A16[rgba[4 * k + 3]] | sun[k];
      for (let v = 0; v < 3; v++) { const o = 12 * i + 4 * v; C[o] = r; C[o + 1] = gg; C[o + 2] = bb; C[o + 3] = a; }
    }
    const col = accessor(C, 5123, 'VEC4', 3 * N, { normalized: true });
    // 三角形ごとに、画像の (0,0)・(1,0)・(0,1) の角（4 バイトの倍数にそろえて 2 バイト空ける）
    const T = new Uint8Array(N * 12);
    for (let i = 0; i < N; i++) { T[12 * i + 4] = 255; T[12 * i + 9] = 255; }
    const tex = accessor(T, 5121, 'VEC2', 3 * N, { normalized: true });
    views[accessors[tex].bufferView].byteStride = 4;
    prims.push({ attributes: { POSITION: pos, COLOR_0: col, TEXCOORD_0: tex }, material: materials.length - 1 });
  }
  if (!prims.length) return null;
  const bin = new Uint8Array((binLen + 3) & ~3);
  for (const [o, u8] of chunks) bin.set(u8, o);
  const g = {
    asset: { version: '2.0', generator: 'flyover-web c3m.js' },
    extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: center, scale: [step, step, step] }],
    meshes: [{ primitives: prims }],
    materials: materials.map(m => m || {}), accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
  };
  if (images.length) {
    Object.assign(g, { textures, images, samplers: [
      { magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }, { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] });
  }
  const captured = c3ms.map(c => c.captured).filter(Boolean);
  if (captured.length) g.asset.extras = { captured: Math.max(...captured) };
  return glbBytes(g, bin);
}
// glb の JSON と BIN を 1 つのバイト列にする
function glbBytes(g, bin) {
  let js = new TextEncoder().encode(JSON.stringify(g));
  const pad = (4 - js.length % 4) % 4;
  if (pad) { const t = new Uint8Array(js.length + pad).fill(0x20); t.set(js); js = t; }
  const out = new Uint8Array(12 + 8 + js.length + 8 + bin.length), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(js, 20);
  dv.setUint32(20 + js.length, bin.length, true); dv.setUint32(24 + js.length, 0x004E4942, true); out.set(bin, 28 + js.length);
  return out;
}

// /api/c3m/・/api/r3d/ の応答（区分の数、長さの並び、つなげたバイト列）を区分ごとに分ける
function splitRaw(raw) {
  const dv = new DataView(raw), n = dv.getUint32(0, true), out = [];
  let off = 4 + 4 * n;
  for (let i = 0; i < n; i++) {
    const len = dv.getUint32(4 + 4 * i, true);
    out.push(len ? raw.slice(off, off + len) : null);
    off += len;
  }
  return out;
}

// glb（Uint8Array）か、三角形がなければ null。C3M では読めない区分を飛ばして理由を warnings に入れる（flyover/earth.py の
// build_glb と同じ）。R3D（parseFn に r3d.js の parse）では strict: 1 区分でも読めなければ 'fallback'（ビューアが C3M に
// する。区分が欠けて建物の上が消えないよう）
function build(raw, warnings = [], parseFn = parse, strict = false) {
  const tiles = [];
  let failed = false;
  splitRaw(raw).forEach((b, h) => {
    if (!b || failed) return;
    try { tiles.push(parseFn(b)); } catch (e) { warnings.push(`h=${h} を読めない: ${e.message}`); if (strict) failed = true; }
  });
  if (failed) return 'fallback';
  return tiles.length ? tileModel(tiles, warnings) : null;
}

if (typeof module !== 'undefined') {
  module.exports = { parse, build, splitRaw, makeTable, huffDecode, decodeClers, processClers, tileModel, heifHevc, pngRGBA };
} else {
  // 受け取るもの: { id, raw, kind: 'c3m' か 'r3d' }。返すもの: { id, glb, ms } か { id, empty: true } か
  // { id, fallback: true }（R3D を読めない区分があった）か { id, error }。どれにも warnings が付く
  let R3D = null;
  onmessage = ({ data: { id, raw, kind } }) => {
    const t0 = performance.now(), warnings = [];
    try {
      let out;
      if (kind === 'r3d') {
        if (!R3D) { importScripts('r3d.js'); R3D = makeR3D({ decodeClers, processClers }); }
        out = build(raw, warnings, R3D.parse, true);
      } else out = build(raw, warnings);
      if (out === 'fallback') postMessage({ id, fallback: true, warnings });
      else if (!out) postMessage({ id, empty: true, warnings });
      else postMessage({ id, glb: out, ms: performance.now() - t0, warnings }, [out.buffer]);
    } catch (e) {
      postMessage({ id, error: String(e && e.message || e), warnings });
    }
  };
}
