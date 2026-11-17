// WebGPU 版のビューア（gpu.html）の季節の色（?season=）で、スプラットが木の葉かどうかの印を付ける処理。
// 今のビューア（earth.js）のものをそのまま使う（glb のバイト列をその場で書き換える。Cesium は使っていない）
'use strict';
// メッシュの材質の写真の色を見て、(u, v) が葉の緑かを返す関数を作る（写真がなければ null）。水面などの
// くり返して貼る画像は見ない。緑の決め方: 色相 50〜165°（銅ぶきの屋根の青緑は外す）、彩度 0.15 以上、
// 色の差 0.05 以上
function isLeafGreen(r, g, b) {
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 0.05 * 255 || d < 0.15 * mx) return false;
  const h = mx === g ? 60 * ((b - r) / d + 2) : mx === r ? 60 * (((g - b) / d + 6) % 6) : 60 * ((r - g) / d + 4);
  return h >= 50 && h <= 165;
}
async function meshSampler(g, buf, jl, m, planes) {
  const hv = m.extras && m.extras.hevc;
  if (hv) {
    const p = planes && planes[hv.slab];
    if (!p) return null;
    const cw = (p.w + 1) >> 1;
    return (u, v) => {
      const x = Math.min(p.w - 1, Math.max(0, Math.floor(u * p.w))), y = Math.min(p.h - 1, Math.max(0, Math.floor(v * p.h)));
      const Y = p.y[y * p.w + x], o = ((y >> 1) * cw + (x >> 1)) * 2, U = p.uv[o] - 128, V = p.uv[o + 1] - 128;
      return isLeafGreen(Y + 1.402 * V, Y - 0.344136 * U - 0.714136 * V, Y + 1.772 * U);
    };
  }
  const bt = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
  if (!bt || m.alphaMode === 'BLEND') return null;            // スプラットの材質
  const tex = g.textures[bt.index];
  if (tex.sampler === 1) return null;                         // くり返して貼る画像（水面など）
  const im = g.images[tex.source], bv = g.bufferViews[im.bufferView];
  const S = 256, o = 28 + jl + (bv.byteOffset || 0);
  const bmp = await createImageBitmap(new Blob([buf.subarray(o, o + bv.byteLength)], { type: im.mimeType }),
                                      { resizeWidth: S, resizeHeight: S, resizeQuality: 'low' });
  const cv = new OffscreenCanvas(S, S), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = cx.getImageData(0, 0, S, S).data;
  return (u, v) => {
    const i = 4 * (Math.min(S - 1, Math.max(0, Math.floor(v * S))) * S + Math.min(S - 1, Math.max(0, Math.floor(u * S))));
    return isLeafGreen(px[i], px[i + 1], px[i + 2]);
  };
}

// スプラットごとに 3 つの印を、頂点の色の最下位ビットに入れる（色は 65535 分の 1 しか変わらない）。glb を
// Cesium に渡す前に、buf をその場で書き換える
// - 赤: 葉らしい形（詰まった三角形）か。建物の縁や手すりのスプラットは細長い線（いちばん長い辺の 2 乗 ÷ 面積の
//   中央値が宮内庁の屋根の青緑で 92）、葉は詰まった三角形（大手町の街路樹で 4〜5、新宿御苑で 4 前後。
//   正三角形で 2.3）なので、12 で分ける
// - 緑: まわりにスプラットが多い（茂みの中）か。木は数十〜百数十の塊になる。建物の縁は線なので少ない
//   （詰まった形のものでも）
// - 青: 緑のままにするか。木の一部がメッシュ（写真を貼った形）でできている所（大手町の街路樹など）では、
//   メッシュの緑は変えない（木のメッシュの写真まで塗ると、そばのビルの壁まで色が付いた）ので、スプラットも
//   変えずに木ごと緑のままにする。写真が緑で地面より 2.5 m 以上高いメッシュのすぐそばのスプラットと、それを
//   多く（3 割以上）含む葉のスプラットの塊（升目でつながったもの）が対象。写真の色は、HEVC の面（planes）か、
//   glb の中の JPEG を縮めて読む。細かいタイル（fine、ズーム 19 以上）だけで見る。粗いタイルでは森の樹冠も
//   メッシュになっているが、大きなスプラットがそれを覆うので、変えても緑は見えない（緑のままにすると、遠くから
//   見た森がまるごと緑になる）。そのため、メッシュのある木は、近づくと緑に変わる
async function markTreeSplats(buf, planes, fine) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jl = dv.getUint32(12, true);
  const g = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl)));
  const prims = g.meshes[0].primitives;
  const splat = prims.find(p => p.attributes.COLOR_0 !== undefined);
  if (!splat) return;
  const start = i => {
    const a = g.accessors[i];
    return 28 + jl + (g.bufferViews[a.bufferView].byteOffset || 0) + (a.byteOffset || 0);
  };
  const po = start(splat.attributes.POSITION), co = start(splat.attributes.COLOR_0);
  const nv = g.accessors[splat.attributes.POSITION].count, n = Math.floor(nv / 3);
  const X = new Float32Array(3 * nv);                 // 頂点の位置（int16 の刻み）
  for (let j = 0; j < nv; j++) for (let e = 0; e < 3; e++) X[3 * j + e] = dv.getInt16(po + 8 * j + 2 * e, true);
  // 形（いちばん長い辺の 2 乗 ÷ 面積）と中心
  const edge = new Float32Array(n), cx = new Float32Array(3 * n), leafy = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const o = 9 * k;
    const ax = X[o + 3] - X[o], ay = X[o + 4] - X[o + 1], az = X[o + 5] - X[o + 2];
    const bx = X[o + 6] - X[o], by = X[o + 7] - X[o + 1], bz = X[o + 8] - X[o + 2];
    const cxx = bx - ax, cy = by - ay, cz = bz - az;
    const L2 = Math.max(ax * ax + ay * ay + az * az, bx * bx + by * by + bz * bz, cxx * cxx + cy * cy + cz * cz);
    const cr = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);   // 面積の 2 倍
    leafy[k] = cr > 0 && 2 * L2 / cr < 12 ? 1 : 0;
    edge[k] = Math.sqrt(L2);
    for (let e = 0; e < 3; e++) cx[3 * k + e] = (X[o + e] + X[o + 3 + e] + X[o + 6 + e]) / 3;
  }
  // まわりの数: いちばん長い辺の中央値 × 1.5 を升目にして、中心が入る升目を数え、近い角を囲む 2 × 2 × 2 升の
  // 合計を見る
  const cell = 1.5 * (n ? edge.slice().sort()[n >> 1] : 1) || 1;
  const ckey = (x, y, z) => x + 4096 * (y + 4096 * z);
  const floorKey = k => ckey(Math.floor(cx[3 * k] / cell) + 2048, Math.floor(cx[3 * k + 1] / cell) + 2048,
                             Math.floor(cx[3 * k + 2] / cell) + 2048);
  const cellOf = new Int32Array(3 * n);                // 近い角
  const counts = new Map();
  for (let k = 0; k < n; k++) {
    for (let e = 0; e < 3; e++) cellOf[3 * k + e] = Math.round(cx[3 * k + e] / cell) + 2048;
    const kk = floorKey(k);
    counts.set(kk, (counts.get(kk) || 0) + 1);
  }
  const around = (set, k) => {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const kk = ckey(cellOf[3 * k] - 1 + (i & 1), cellOf[3 * k + 1] - 1 + (i >> 1 & 1), cellOf[3 * k + 2] - 1 + (i >> 2));
      sum += set instanceof Set ? (set.has(kk) ? 1 : 0) : set.get(kk) || 0;
    }
    return sum;
  };

  // 写真が緑で、地面より 2.5 m 以上高いメッシュの升目。地面の写真にも上から見た木が写っているので、
  // 高さを見ないと、木の下の地面がどこでも緑になる（新宿御苑がまるごと緑のままになった）。地面の高さは、
  // 上向き（タイルの中心の向き）に測ったメッシュの頂点の高さの、まわり 3 × 3 の柱（1 本 8 m 以上）の最小
  const green = new Set();
  if (fine) {
    const T = g.nodes[0].translation || [0, 0, 1], step = (g.nodes[0].scale || [1])[0];
    const up = T.map(x => x / Math.hypot(...T));
    const ax1 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const ev0 = cross(up, ax1), ev = ev0.map(x => x / Math.hypot(...ev0)), nvv = cross(up, ev);
    const col = Math.max(8 / step, 2 * cell), rise = 2.5 / step;
    const dot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;
    const colKey = (x, y, z) => (Math.floor(dot(ev, x, y, z) / col) + 2048) * 4096 + Math.floor(dot(nvv, x, y, z) / col) + 2048;
    const meshes = prims.filter(p => p !== splat && p.indices !== undefined);
    const ground = new Map();
    for (const p of meshes) {
      const pp = start(p.attributes.POSITION), cnt = g.accessors[p.attributes.POSITION].count;
      for (let j = 0; j < cnt; j++) {
        const x = dv.getInt16(pp + 8 * j, true), y = dv.getInt16(pp + 8 * j + 2, true), z = dv.getInt16(pp + 8 * j + 4, true);
        const k = colKey(x, y, z), h = dot(up, x, y, z);
        if (!(ground.get(k) <= h)) ground.set(k, h);
      }
    }
    const groundAt = (x, y, z) => {
      const k = colKey(x, y, z);
      let lo = Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const h = ground.get(k + a * 4096 + b);
        if (h < lo) lo = h;
      }
      return lo;
    };
    const samplers = await Promise.all(g.materials.map(m => meshSampler(g, buf, jl, m, planes)));
    for (const p of meshes) {
      const sample = samplers[p.material];
      if (!sample) continue;
      const pp = start(p.attributes.POSITION), ip = start(p.indices), uo = start(p.attributes.TEXCOORD_0);
      const ia = g.accessors[p.indices], ua = g.accessors[p.attributes.TEXCOORD_0];
      const big = ia.componentType === 5125, uf = ua.componentType === 5126;
      const pos = (j, e) => dv.getInt16(pp + 8 * j + 2 * e, true);
      const uv = (j, e) => uf ? dv.getFloat32(uo + 8 * j + 4 * e, true) : dv.getUint16(uo + 4 * j + 2 * e, true) / 65535;
      const v = [0, 0, 0];
      for (let q = 0; q + 2 < ia.count; q += 3) {
        for (let m = 0; m < 3; m++) v[m] = big ? dv.getUint32(ip + 4 * (q + m), true) : dv.getUint16(ip + 2 * (q + m), true);
        let L = 0;
        for (let m = 0; m < 3; m++) {
          const a = v[m], b = v[(m + 1) % 3];
          L = Math.max(L, Math.hypot(pos(b, 0) - pos(a, 0), pos(b, 1) - pos(a, 1), pos(b, 2) - pos(a, 2)));
        }
        const ns = Math.min(Math.ceil(L / cell), 24) || 1;
        for (let i = 0; i <= ns; i++) for (let j = 0; j <= ns - i; j++) {
          const w1 = (i + 1 / 3) / (ns + 1), w2 = (j + 1 / 3) / (ns + 1), w0 = 1 - w1 - w2;
          if (!sample(w0 * uv(v[0], 0) + w1 * uv(v[1], 0) + w2 * uv(v[2], 0),
                      w0 * uv(v[0], 1) + w1 * uv(v[1], 1) + w2 * uv(v[2], 1))) continue;
          const P3 = [0, 1, 2].map(e => w0 * pos(v[0], e) + w1 * pos(v[1], e) + w2 * pos(v[2], e));
          if (dot(up, ...P3) - groundAt(...P3) < rise) continue;
          green.add(ckey(...P3.map(x => Math.floor(x / cell) + 2048)));
        }
      }
    }
  }
  // 葉のスプラットの塊（升目が隣り合うものをつなぐ）ごとに、緑のメッシュのそばのものの割合を見る
  const keep = new Uint8Array(n);
  if (green.size) {
    const near = new Uint8Array(n);
    for (let k = 0; k < n; k++) near[k] = around(green, k) > 0 ? 1 : 0;
    const parent = new Map();
    const find = a => {
      while (parent.get(a) !== a) { const b = parent.get(parent.get(a)); parent.set(a, b); a = b; }
      return a;
    };
    for (let k = 0; k < n; k++) if (leafy[k]) parent.set(floorKey(k), floorKey(k));
    for (const a of [...parent.keys()]) {
      const x = a % 4096, y = Math.floor(a / 4096) % 4096, z = Math.floor(a / 4096 / 4096);
      for (let d = 0; d < 27; d++) {
        const b = ckey(x + d % 3 - 1, y + Math.floor(d / 3) % 3 - 1, z + Math.floor(d / 9) - 1);
        if (b > a && parent.has(b)) {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent.set(ra, rb);
        }
      }
    }
    const tot = new Map(), hit = new Map();
    for (let k = 0; k < n; k++) if (leafy[k]) {
      const r = find(floorKey(k));
      tot.set(r, (tot.get(r) || 0) + 1);
      if (near[k]) hit.set(r, (hit.get(r) || 0) + 1);
    }
    for (let k = 0; k < n; k++) {
      if (near[k]) { keep[k] = 1; continue; }
      if (!leafy[k]) continue;
      const r = find(floorKey(k));
      keep[k] = (hit.get(r) || 0) >= 0.3 * tot.get(r) ? 1 : 0;
    }
  }
  for (let k = 0; k < n; k++) {
    const many = around(counts, k) >= 60 ? 1 : 0;
    for (let m = 0; m < 3; m++) {
      const o = co + 8 * (3 * k + m);
      dv.setUint16(o, (dv.getUint16(o, true) & ~1) | leafy[k], true);
      dv.setUint16(o + 2, (dv.getUint16(o + 2, true) & ~1) | many, true);
      dv.setUint16(o + 4, (dv.getUint16(o + 4, true) & ~1) | keep[k], true);
    }
  }
}

