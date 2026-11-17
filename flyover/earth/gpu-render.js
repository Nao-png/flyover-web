// WebGPU 版のビューア（gpu.html）の描画。Cesium を使わずに、Apple の衛星画像を貼った地球儀の地面、新しい Flyover の
// 3D の建物とスプラット、空と大気を描く。操作と画面の部品は gpu-ui.js（ここが用意する GE を使う）。
// - 地面は Web メルカトルの四分木（衛星画像のタイルと 1 対 1）。高さはサーバーの地形のタイル（地理座標、65 x 65）から読む。
//   目的の細かさのタイルを直接読み、届くまでは手元の親か子で埋める（親はステンシルで、届いたタイルの描いていない画素だけ）
// - Flyover のタイルの選び方は今のビューア（earth.js の updateFlyover）と同じ。親の 4 分の 1 の切り出しはシェーダーで捨てる
// - 写真は明るさ（Y）と縦横半分の色（UV）の 2 枚で持つ（RGBA の 4 割ほど）
// - 深度は reversed-Z（奥ほど 0）で、遠くまで 1 回で描く。位置は CPU で倍精度で計算し、GPU にはカメラを原点にした値を渡す
// - カーソルの下の点: 地形だけなら CPU で（地形の高さで光線を楕円体に当てる）。建物も含めるときは、その 1 画素だけを
//   描き直して深度を読む（GPU を待たずに、届いたら使う）
'use strict';
const GE = {};
GE.ready = (async function () {
const { A, RAD, add, sub, mul, dot, cross, len, norm, clamp, ecef, geodetic, enu, hitEllipsoid, mat4mul, mat4inv, mercLat, sunAt } = GM;
const params = new URLSearchParams(location.search);
const fail = msg => { const e = document.getElementById('gpu-error'); if (e) { e.textContent = msg; e.hidden = false; } };
if (!navigator.gpu) { fail('このブラウザーでは WebGPU が使えません（Chrome か Edge で開いてください）'); return; }
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) { fail('WebGPU の GPU が見つかりません'); return; }
const timing = adapter.features.has('timestamp-query');
const floatFilter = adapter.features.has('float32-filterable');     // 大気の表（float32）を補間して読む
const stencil32 = adapter.features.has('depth32float-stencil8');
// 写真を GPU 用の圧縮形式（BC4 と BC5）にする（?bc=0 でしない）
const BC = adapter.features.has('texture-compression-bc') && params.get('bc') !== '0';
const device = await adapter.requestDevice({ requiredFeatures: [...(timing ? ['timestamp-query'] : []),
  ...(floatFilter ? ['float32-filterable'] : []), ...(stencil32 ? ['depth32float-stencil8'] : []),
  ...(BC ? ['texture-compression-bc'] : [])] });
// 深度はステンシル付き（地面の代わりの親を、届いたタイルの描いていない画素にだけ描く）。depth32float-stencil8 なら
// 深度をバッファに写せる（カーソルの下の建物を探すのに使う）
const DEPTH = stencil32 ? 'depth32float-stencil8' : 'depth24plus-stencil8';
// GPU との接続が切れたら（GPU のリセットなど）、1 回だけ読み直す（続けて切れるなら読み直さない）
device.lost.then(e => {
  if (e.reason === 'destroyed') return;
  let last = 0;
  try { last = Number(sessionStorage.getItem('gpu-lost')) || 0; sessionStorage.setItem('gpu-lost', String(Date.now())); } catch (err) { /* */ }
  if (Date.now() - last > 60000) { fail('GPU との接続が切れたので、読み直します'); setTimeout(() => location.reload(), 1500); }
  else fail('GPU との接続が切れました（' + (e.message || e.reason) + '）。PC を再起動すると直ることがあります');
});

const cfg = await (await fetch('/api/config')).json();
const hosts = (cfg.tileHosts || []).filter(h => h !== location.hostname);
const hostBase = k => hosts.length ? `${location.protocol}//${hosts[k % hosts.length]}:${location.port}` : '';

// ジオイド高（海抜にするため。サーバーが 2 度ごとに丸めて渡す）
function geoid(latDeg, lonDeg) {
  const g = cfg.geoid, rows = g.rows;
  const fy = clamp((90 - latDeg) / g.step, 0, rows.length - 1.001);
  const lo = ((lonDeg + 180) % 360 + 360) % 360;
  const fx = clamp(lo / g.step, 0, rows[0].length - 1.001);
  const y0 = Math.floor(fy), x0 = Math.floor(fx), ty = fy - y0, tx = fx - x0;
  const r0 = rows[y0], r1 = rows[y0 + 1];
  return (r0[x0] * (1 - tx) + r0[x0 + 1] * tx) * (1 - ty) + (r1[x0] * (1 - tx) + r1[x0 + 1] * tx) * ty;
}

// ---------------------------------------------------------------- カメラ

// 画角は Cesium と同じく、縦横の長いほうが 60°
const fovy = aspect => aspect > 1 ? 2 * Math.atan(Math.tan(30 * RAD) / aspect) : 60 * RAD;
const cam = { pos: ecef(30 * RAD, 138 * RAD, 14e6), dir: [0, 0, -1], up: [0, 1, 0] };
function setView(lat, lon, h, heading, tilt) {
  cam.pos = ecef(lat * RAD, lon * RAD, h);
  const { east, north, up } = enu(cam.pos), hd = heading * RAD, pitch = (tilt - 90) * RAD;
  const fwd = add(mul(east, Math.sin(hd)), mul(north, Math.cos(hd)));
  cam.dir = norm(add(mul(fwd, Math.cos(pitch)), mul(up, Math.sin(pitch))));
  const right = add(mul(east, Math.cos(hd)), mul(north, -Math.sin(hd)));
  cam.up = norm(cross(right, cam.dir));
  dirty = true;
}
let dirty = true;
let selStale = true;     // 選んだあとにタイルが届いた（選び直すと描けるものが増える）

// ---------------------------------------------------------------- 見た目の設定

// 色合い: apple（初めて開いたとき）は空だけで写真にかすみをかけない、google は空とかすみ（今のビューアと同じ値）。
// 選んだものは今のビューアと同じくこのブラウザーに覚える（localStorage の look）。?look= でも選べる。?atmo=0 で大気を使わない
const ATMOSPHERE = params.get('atmo') !== '0';
let look = (() => {
  let saved = null;
  try { saved = localStorage.getItem('look'); } catch (e) { /* */ }
  const name = params.get('look') || saved;
  return name === 'google' ? 'google' : 'apple';
})();
const num = (name, d) => (v => Number.isFinite(v) ? v : d)(Number(params.get(name) ?? NaN));
const bal = (params.get('balance') || '').split(',').map(Number);
const ATMO = {
  exposure: Number(params.get('exposure')) || 6, haze: Number(params.get('haze')) || 0.5,
  aces: params.get('tone') !== 'exp',
  balance: bal.length === 3 && bal.every(Number.isFinite) ? bal : [0.95, 0.97, 1.3],
  aerial: num('aerial', 0.4), aerialNear: num('aerialNear', 3), aerialKm: Math.max(num('aerialKm', 2), 0.01), grey: num('grey', 0),
};
// ?light=: 撮ったときの日なたと日かげを取り除いて、別の光で描き直す（今のビューアと同じ値と式）
const LIGHTS = {
  morning: { sun: [100, 18], sunColor: [1.25, 1.05, 0.8], sky: [0.42, 0.5, 0.66] },
  evening: { sun: [255, 9], sunColor: [1.5, 0.78, 0.4], sky: [0.34, 0.3, 0.45] },
  cloudy: { sun: null, sky: [0.92, 0.95, 1.0] },
  night: { sun: null, sky: [0.07, 0.09, 0.17] },
  check: { check: true, sun: null, sky: [1, 1, 1] },
};
const light = cfg.r3d ? LIGHTS[params.get('light')] : undefined;
// 空の太陽: ?light= に太陽があればそれ、夜は沈んだ太陽、ほかは昼の太陽（方位と高さ [°]）
const atmoSun = light && light.sun ? light.sun : params.get('light') === 'night' ? [0, -20] : [150, 45];
const SEASONS = { sakura: 0, momiji: 1, check: 2 };
const season = cfg.r3d ? SEASONS[params.get('season')] : undefined;
const SAMPLES = Number(params.get('msaa')) === 1 ? 1 : 4;

// ---------------------------------------------------------------- シェーダー

const f4 = x => x.toFixed(5);
const v3w = a => `vec3f(${a.map(f4).join(', ')})`;
const ATMO_WGSL = gpuAtmoWGSL(ATMO.haze) + gpuLookWGSL(ATMO.aces);
const GLOBE_WGSL = /* wgsl */`${ATMO_WGSL}
struct U { mvp: mat4x4f, rc: vec4f, rect: vec4f };   // rc: タイルの中心（カメラを原点に）、rect: 描く範囲（写真の座標）
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;      // 明るさ（Y）
@group(0) @binding(3) var uvTex: texture_2d<f32>;    // 縦横半分の色（r が Cb、g が Cr）
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) at: vec3f, @location(2) as_: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) uv: vec2f) -> V {
  var o: V;
  o.pos = fr.pickM * (u.mvp * vec4f(p, 1.0));
  o.uv = uv;
  let a = aerialAt(u.rc.xyz + p);
  o.at = a.t; o.as_ = a.s;
  return o;
}
fn yuv(y: f32, c0: vec2f) -> vec3f {
  let c = c0 - 128.0 / 255.0;      // BT.601 のフルレンジ: 色の真ん中は 128
  return clamp(vec3f(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x), vec3f(0.0), vec3f(1.0));
}
@fragment fn fs(i: V) -> @location(0) vec4f {
  let y = textureSample(tex, samp, i.uv).r;
  let c = textureSample(uvTex, samp, i.uv).rg;
  if (any(i.uv < u.rect.xy) || any(i.uv > u.rect.zw)) { discard; }
  return vec4f(atmoApply(yuv(y, c), i.at, i.as_), 1.0);
}`;
// 光の描き直し（今のビューアの lightApply を WGSL に）。c は sRGB、lit は撮ったときの日なた（1）・日かげ（0）、
// n は面の向き（地球の座標の軸。画面上の位置の変化から求める）
const LIGHT_WGSL = !light ? 'fn lightRgb(c: vec3f, lit: f32, n: vec3f) -> vec3f { return c; }' : (() => {
  const s = light.sun && light.sun.map(d => d * RAD);
  const sunENU = s ? [Math.sin(s[0]) * Math.cos(s[1]), Math.cos(s[0]) * Math.cos(s[1]), Math.sin(s[1])] : [0, 0, 1];
  return /* wgsl */`
fn lightRgb(c: vec3f, lit0: f32, n: vec3f) -> vec3f {
  let lit = clamp(lit0, 0.0, 1.0);
  ${light.check ? 'return linearToSrgb(vec3f(lit));' : ''}
  let east = u.east.xyz;
  let north = u.north.xyz;
  let up = cross(east, north);
  // 撮ったときの太陽（u.sun0。東・北・上の向き。w が 0 なら分からない）に対する面の向き。0.25〜2 倍に抑える
  var k = 1.0;
  if (u.sun0.w > 0.5) {
    let s0 = normalize(east * u.sun0.x + north * u.sun0.y + up * u.sun0.z);
    k = clamp(dot(n, s0) / u.sun0.z, 0.25, 2.0);
  }
  // 影を取り除いた色。日かげは日なたの R 0.10・G 0.15・B 0.17 倍ほどに写っている
  let albedo = srgbToLinear(c) / mix(vec3f(0.10, 0.15, 0.17), vec3f(1.0), lit * k);
  let sunE = normalize(east * ${f4(sunENU[0])} + north * ${f4(sunENU[1])} + up * ${f4(sunENU[2])});
  let sky = 0.65 + 0.35 * dot(n, up);
  let L = ${v3w(light.sky)} * sky${light.sun ? ` + ${v3w(light.sunColor)} * max(dot(n, sunE), 0.0)` : ''};
  return linearToSrgb(albedo * L);
}`;
})();
// 季節の色（今のビューアの seasonTint を WGSL に）。色は線形の値で受け取って返す。pw は地球の座標での位置
const SEASON_WGSL = season === undefined ? 'fn seasonLin(lin: vec3f, color: vec4f, pw: vec3f) -> vec3f { return lin; }' : /* wgsl */`
fn fmodf(x: vec3f, y: f32) -> vec3f { return x - y * floor(x / y); }
fn seasonHash(p0: vec3f) -> f32 {
  let p = fmodf(p0, 1024.0);
  return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
}
fn seasonNoise(p: vec3f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(seasonHash(i), seasonHash(i + vec3f(1.0, 0.0, 0.0)), f.x),
                 mix(seasonHash(i + vec3f(0.0, 1.0, 0.0)), seasonHash(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(seasonHash(i + vec3f(0.0, 0.0, 1.0)), seasonHash(i + vec3f(1.0, 0.0, 1.0)), f.x),
                 mix(seasonHash(i + vec3f(0.0, 1.0, 1.0)), seasonHash(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
fn seasonBit(v: f32) -> bool { return (u32(floor(v * 65535.0 + 0.5)) & 1u) == 1u; }
fn seasonLin(lin: vec3f, color: vec4f, pw: vec3f) -> vec3f {
  let c = linearToSrgb(color.rgb);
  let leafy = seasonBit(color.r);
  let many = seasonBit(color.g);
  let keep = seasonBit(color.b);
  ${season === 2 ? 'if (keep) { return vec3f(0.0, 1.0, 0.2); } if (!leafy) { return vec3f(0.0, 0.8, 1.0); } if (many) { return vec3f(1.0, 0.0, 1.0); } return vec3f(1.0, 0.9, 0.0);' : ''}
  if (keep || !leafy) { return lin; }
  let mx = max(c.r, max(c.g, c.b));
  let d = mx - min(c.r, min(c.g, c.b));
  if (d < 0.012) { return lin; }
  var h: f32;
  if (mx == c.g) { h = 60.0 * ((c.b - c.r) / d + 2.0); }
  else if (mx == c.r) { let q = (c.g - c.b) / d; h = 60.0 * (q - 6.0 * floor(q / 6.0)); }
  else { h = 60.0 * ((c.r - c.g) / d + 4.0); }
  var w: f32;
  if (many) { w = smoothstep(38.0, 50.0, h) * (1.0 - smoothstep(190.0, 205.0, h)) * smoothstep(0.03, 0.08, d / mx); }
  else { w = smoothstep(48.0, 62.0, h) * (1.0 - smoothstep(145.0, 160.0, h)) * smoothstep(0.10, 0.18, d / mx); }
  w *= smoothstep(0.012, 0.025, d);
  if (w <= 0.0) { return lin; }
  let L = dot(c, vec3f(0.299, 0.587, 0.114));
  let t = clamp((0.7 * seasonNoise(pw / 14.0) + 0.3 * seasonNoise(pw / 5.0) - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  let f = clamp((seasonNoise(pw / 2.5) - 0.5) * 2.0 + 0.5, 0.0, 1.0);
  var col: vec3f;
  ${season === 0 ? `let pink = mix(vec3f(0.96, 0.66, 0.76), vec3f(1.0, 0.90, 0.93), clamp(0.6 * t + 0.4 * f, 0.0, 1.0));
  col = pink * clamp(L * 2.8, 0.0, 1.15);` : `let red = vec3f(0.78, 0.13, 0.07);
  let orange = vec3f(0.92, 0.42, 0.08);
  let yellow = vec3f(0.93, 0.74, 0.16);
  let k = clamp(t + 0.25 * (f - 0.5), 0.0, 1.0);
  if (k < 0.5) { col = mix(red, orange, k * 2.0); } else { col = mix(orange, yellow, k * 2.0 - 1.0); }
  col *= mix(1.05, 1.7, k) * L / dot(col, vec3f(0.299, 0.587, 0.114));`}
  return srgbToLinear(mix(c, clamp(col, vec3f(0.0), vec3f(1.0)), w));
}`;
const FLY_WGSL = /* wgsl */`${ATMO_WGSL}
// p: (1 刻みの長さ, 4 分の 1 の切り出し, 0, 0)。east, north: タイルの中心の東と北。off: 中心から見たタイルの地面の
// 中心（切り出し用）。rc: 中心（カメラを原点に）。sun0: 撮ったときの太陽（東・北・上、w が 1 なら分かっている）
struct U { mvp: mat4x4f, p: vec4f, east: vec4f, north: vec4f, off: vec4f, rc: vec4f, sun0: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;      // RGBA の写真か、HEVC の写真の明るさ（Y）
@group(0) @binding(3) var uvTex: texture_2d<f32>;    // HEVC の写真の縦横半分の色（r が Cb、g が Cr）
@group(0) @binding(4) var shadeTex: texture_2d<f32>; // 撮ったときの日の当たり方（?light= のときだけ。ほかは白）
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) local: vec3f, @location(2) color: vec4f,
           @location(3) at: vec3f, @location(4) as_: vec3f, @location(5) rel: vec3f, @location(6) world: vec3f };
fn srgbToLinear(c: vec3f) -> vec3f { return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045)); }
fn linearToSrgb(c: vec3f) -> vec3f { return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308)); }
${LIGHT_WGSL}
${SEASON_WGSL}
// 4 分の 1 の切り出し（mask のビット 0〜3 = 北西・北東・南西・南東。0 は全部を出す）
fn clipped(local: vec3f) -> bool {
  let m = u32(u.p.y);
  if (m == 0u) { return false; }
  let d = local - u.off.xyz;
  let q = select(0u, 1u, dot(d, u.east.xyz) >= 0.0) + select(0u, 2u, dot(d, u.north.xyz) < 0.0);
  return ((m >> q) & 1u) == 0u;
}
fn vsCommon(q: vec4i, uv: vec2f, color: vec4f) -> V {
  var o: V;
  let l = vec3f(q.xyz) * u.p.x;
  o.pos = fr.pickM * (u.mvp * vec4f(l, 1.0));
  o.uv = uv; o.local = l; o.color = color;
  o.rel = u.rc.xyz + l;
  o.world = o.rel + fr.camPos.xyz;
  let a = aerialAt(o.rel);
  o.at = a.t; o.as_ = a.s;
  return o;
}
@vertex fn vsMesh(@location(0) q: vec4i, @location(1) uv: vec2f) -> V { return vsCommon(q, uv, vec4f(1.0)); }
@vertex fn vsSplat(@location(0) q: vec4i, @location(1) color: vec4f, @location(2) uv: vec2f) -> V { return vsCommon(q, uv, color); }
// 見ている側を向いた面の向き（カメラが原点）
fn normalOf(rel: vec3f) -> vec3f {
  var n = normalize(cross(dpdx(rel), dpdy(rel)));
  if (dot(n, rel) > 0.0) { n = -n; }
  return n;
}
@fragment fn fsMesh(i: V) -> @location(0) vec4f {
  let n = normalOf(i.rel);
  let base = textureSample(tex, samp, i.uv).rgb;
  let lit = textureSample(shadeTex, samp, i.uv).r;
  if (clipped(i.local)) { discard; }
  return vec4f(atmoApply(lightRgb(base, lit, n), i.at, i.as_), 1.0);
}
// HEVC の写真。BT.601 のフルレンジ（hevc.js を見よ）
@fragment fn fsMeshYuv(i: V) -> @location(0) vec4f {
  let n = normalOf(i.rel);
  let y = textureSample(tex, samp, i.uv).r;
  let c = textureSample(uvTex, samp, i.uv).rg - 128.0 / 255.0;
  let lit = textureSample(shadeTex, samp, i.uv).r;
  if (clipped(i.local)) { discard; }
  let rgb = clamp(vec3f(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x), vec3f(0.0), vec3f(1.0));
  return vec4f(atmoApply(lightRgb(rgb, lit, n), i.at, i.as_), 1.0);
}
// スプラット: 頂点の色は線形の値。不透明度の下位 6 ビットが撮ったときの日の当たり方。
// 今のビューア（Cesium）と同じ重ね方（Weighted Blended OIT。McGuire と Bavoil 2013）: 色 x 不透明度 x 重みの合計と
// 透ける割合（1 - 不透明度 の積）を 0 番に、不透明度 x 重みの合計を 1 番にためて、最後に平均の色を重ねる。
// 重みは Cesium（Apache-2.0）の czm_alphaWeight と同じ式。z は -1〜1 なので深さの項はほぼ 300 で、
// ほぼ不透明度で重みをつけた平均になる。半精度でためるので 300 で割っておく（比なので結果は同じ）
struct OitOut { @location(0) accum: vec4f, @location(1) reveal: f32 };
fn oitWeight(a: f32, fz: f32) -> f32 {
  let z = fz * 2.0 - 1.0;
  return (pow(a + 0.01, 4.0) + max(1e-2, min(3.0 * 1e3, 0.003 / (1e-5 + pow(abs(z) / 200.0, 4.0))))) / 300.0;
}
@fragment fn fsSplat(i: V) -> OitOut {
  let n = normalOf(i.rel);
  let t = textureSample(tex, samp, i.uv);
  if (clipped(i.local)) { discard; }
  let lin = seasonLin(i.color.rgb, i.color, i.world);
  let lit = f32(u32(i.color.a * 65535.0 + 0.5) % 64u) / 63.0;
  let rgb = atmoApply(lightRgb(linearToSrgb(lin), lit, n), i.at, i.as_);
  let a = i.color.a * t.a;
  let w = oitWeight(a, i.pos.z);
  var o: OitOut;
  o.accum = vec4f(rgb * a * w, a);
  o.reveal = a * w;
  return o;
}`;
// 木（スプラット）をためたものを、不透明な絵の上に重ねる（Cesium の CompositeOITFS と同じ計算）
const OIT_WGSL = /* wgsl */`
@group(0) @binding(0) var accumT: texture_2d<f32>;
@group(0) @binding(1) var revealT: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let c = vec2i(p.xy);
  let acc = textureLoad(accumT, c, 0);
  if (acc.a >= 1.0) { discard; }           // 木がない
  let r = textureLoad(revealT, c, 0).r;
  return vec4f(acc.rgb / clamp(r, 1e-4 / 300.0, 5e4 / 300.0), 1.0 - acc.a);
}`;
const MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(i: V) -> @location(0) vec4f { return textureSample(tex, samp, i.uv); }
@fragment fn fsY(i: V) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv).rgb;
  return vec4f(dot(c, vec3f(0.299, 0.587, 0.114)), 0.0, 0.0, 1.0);
}
@fragment fn fsUV(i: V) -> @location(0) vec4f {
  let c = textureSample(tex, samp, i.uv).rgb;
  let y = dot(c, vec3f(0.299, 0.587, 0.114));
  return vec4f((c.b - y) / 1.772 + 128.0 / 255.0, (c.r - y) / 1.402 + 128.0 / 255.0, 0.0, 1.0);
}`;
// 展開したコマ（VideoFrame）を直接読む版。RGB はブラウザがコマの色の決め方（hevc.js の COLOR）で変換したもの
const EXT_WGSL = MIP_WGSL.replace('var tex: texture_2d<f32>', 'var tex: texture_external')
  .replace(/textureSample\(tex, samp, i\.uv\)/g, 'textureSampleBaseClampToEdge(tex, samp, i.uv)')
  .replace(/@fragment fn fs\(i: V\)[^\n]*\n/, '');

// ---------------------------------------------------------------- パイプライン

const canvas = document.createElement('canvas');
canvas.id = 'gpu-canvas';
document.getElementById('globe').append(canvas);
const ctx = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: 'opaque' });

const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, FR = GPUShaderStage.FRAGMENT;
const uniformEntry = { binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true } };
const groundLayout = device.createBindGroupLayout({ entries: [uniformEntry,
  { binding: 1, visibility: FR, sampler: {} }, { binding: 2, visibility: FR, texture: {} }, { binding: 3, visibility: FR, texture: {} }] });
const flyLayout = device.createBindGroupLayout({ entries: [uniformEntry,
  { binding: 1, visibility: FR, sampler: {} }, { binding: 2, visibility: FR, texture: {} }, { binding: 3, visibility: FR, texture: {} },
  { binding: 4, visibility: FR, texture: {} }] });
const frameLayout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
  { binding: 1, visibility: VF, sampler: {} },
  { binding: 2, visibility: VF, texture: {} },
  { binding: 3, visibility: VF, texture: { viewDimension: '3d' } }] });
const emptyLayout = device.createBindGroupLayout({ entries: [] });
const emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] });
const globeModule = device.createShaderModule({ code: GLOBE_WGSL });
const flyModule = device.createShaderModule({ code: FLY_WGSL });
const mipModule = device.createShaderModule({ code: MIP_WGSL });
const extModule = device.createShaderModule({ code: EXT_WGSL });

// 描くもののパイプラインの組。アンチエイリアスの倍率ごとに作る（画面は SAMPLES、カーソルの下の点とスクリーンショットは 1）
const stencilOn = fb => fb ? { compare: 'not-equal' } : { compare: 'always', passOp: 'replace' };
async function makePipes(samples) {
  const ms = { count: samples };
  const depth = (write, compare, st) => ({ format: DEPTH, depthWriteEnabled: write, depthCompare: compare,
    ...(st ? { stencilFront: st, stencilBack: st } : {}) });
  const globe = fb => device.createRenderPipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: [groundLayout, frameLayout] }),
    vertex: { module: globeModule, entryPoint: 'vs', buffers: [{ arrayStride: 20, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }] }] },
    fragment: { module: globeModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth(true, 'greater', stencilOn(fb)), multisample: ms });
  const flyPL = device.createPipelineLayout({ bindGroupLayouts: [flyLayout, frameLayout] });
  const mesh = (uvFormat, entry) => device.createRenderPipelineAsync({
    layout: flyPL,
    vertex: { module: flyModule, entryPoint: 'vsMesh', buffers: [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'sint16x4' }] },
      { arrayStride: uvFormat === 'float32x2' ? 8 : 4, attributes: [{ shaderLocation: 1, offset: 0, format: uvFormat }] }] },
    fragment: { module: flyModule, entryPoint: entry, targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth(true, 'greater'), multisample: ms });
  const [sky, ground, groundFb, meshU16, meshF32, yuvU16, yuvF32, splat] = await Promise.all([
    device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, frameLayout] }),
      vertex: { module: globeModule, entryPoint: 'vsSky' }, fragment: { module: globeModule, entryPoint: 'fsSky', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }, depthStencil: depth(false, 'always'), multisample: ms }),
    globe(false), globe(true),
    mesh('unorm16x2', 'fsMesh'), mesh('float32x2', 'fsMesh'), mesh('unorm16x2', 'fsMeshYuv'), mesh('float32x2', 'fsMeshYuv'),
    device.createRenderPipelineAsync({
      layout: flyPL,
      vertex: { module: flyModule, entryPoint: 'vsSplat', buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'sint16x4' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'unorm16x4' }] },
        { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x2' }] }] },
      fragment: { module: flyModule, entryPoint: 'fsSplat', targets: [
        { format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' } } },
        { format: 'r16float', blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: depth(false, 'greater'), multisample: ms }),
  ]);
  return { sky, ground, groundFb, meshU16, meshF32, yuvU16, yuvF32, splat };
}
const oitModule = device.createShaderModule({ code: OIT_WGSL });
const [pipesMain, pipes1, oitPipe] = await Promise.all([makePipes(SAMPLES), SAMPLES === 1 ? null : makePipes(1),
  device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: oitModule, entryPoint: 'vs' },
    fragment: { module: oitModule, entryPoint: 'fs', targets: [{ format, blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
    primitive: { topology: 'triangle-list' } })]);
const pipesOne = pipes1 || pipesMain;

const linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
  addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 8 });
const repeat = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
  addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
const mipSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

// ---------------------------------------------------------------- テクスチャ

// 写真のテクスチャの GPU のメモリ（ミップマップの 3 分の 1 を含む。調べる用）
const mem = { fly: 0, ground: 0 };
const BYTES = { rgba8unorm: 4, r8unorm: 1, rg8unorm: 2, 'bc4-r-unorm': 0.5, 'bc5-rg-unorm': 1 };
function photoTexture(w, h, fmt, acc) {
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  const tex = device.createTexture({ size: [w, h], format: fmt, mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  tex.bytes = Math.round(w * h * BYTES[fmt] * 4 / 3); tex.acc = acc;
  mem[acc] += tex.bytes;
  return { tex, levels };
}
// 写真を GPU に載せる命令（ミップマップ、Y・UV への変換、BC 圧縮）は 1 つにまとめて、コマの終わり（コマの外で
// 作ったときは今の仕事の終わり）に 1 回で送る。送る前に捨てられないもの（作業用のテクスチャやバッファ、HEVC の
// コマ）は送ったあとで捨てる。?batch=0 で 1 枚ずつ送る
const BATCH = params.get('batch') !== '0';
let upEnc = null, upAfter = [], upSubmits = 0;
function upEncoder() {
  if (!upEnc) { upEnc = device.createCommandEncoder(); setTimeout(flushUploads, 0); }
  return upEnc;
}
function upDone() { if (!BATCH) flushUploads(); }
function afterUpload(fn) { if (upEnc) upAfter.push(fn); else fn(); }
function flushUploads() {
  if (!upEnc) return;
  device.queue.submit([upEnc.finish()]);
  upEnc = null; upSubmits++;
  const after = upAfter;
  upAfter = [];
  after.forEach(f => f());
}
function dropTexture(tex) { if (tex.acc) mem[tex.acc] -= tex.bytes; afterUpload(() => tex.destroy()); }
// JPEG・PNG は ImageDecoder で開いて CPU に出し（JPEG は Y・U・V のまま、ほかは RGBA）、GPU には putPixels で
// 送る。ImageBitmap を copyExternalImageToTexture で写すと、描いている最中は 1 枚で数十 ms 止まることがある。yuv が true なら、I420 のときは { w, h, y, uv }（UV は U と V を交互に並べたもの）。開けなければ ImageBitmap。
// ?imgdec=0 で今までどおり ImageBitmap
const IMGDEC = typeof ImageDecoder !== 'undefined' && params.get('imgdec') !== '0';
async function decodeImage(data, type, yuv) {
  if (!IMGDEC) return createImageBitmap(new Blob([data], { type }));
  let dec = null, f = null;
  try {
    dec = new ImageDecoder({ data, type });
    f = (await dec.decode()).image;
    const w = f.visibleRect.width, h = f.visibleRect.height;
    if (yuv && f.format === 'I420') {
      const buf = new Uint8Array(f.allocationSize());
      const [py, pu, pv] = await f.copyTo(buf);
      let y = buf.subarray(py.offset, py.offset + w * h);
      if (py.stride !== w) {
        y = new Uint8Array(w * h);
        for (let j = 0; j < h; j++) y.set(buf.subarray(py.offset + j * py.stride, py.offset + j * py.stride + w), j * w);
      }
      const cw = (w + 1) >> 1, ch = (h + 1) >> 1, uv = new Uint8Array(cw * ch * 2);
      for (let j = 0; j < ch; j++) {
        const ou = pu.offset + j * pu.stride, ov = pv.offset + j * pv.stride, o = j * cw * 2;
        for (let i = 0; i < cw; i++) { uv[o + 2 * i] = buf[ou + i]; uv[o + 2 * i + 1] = buf[ov + i]; }
      }
      return { w, h, y, uv };
    }
    const rgba = new Uint8Array(w * h * 4);
    await f.copyTo(rgba, { format: 'RGBA' });
    return { w, h, rgba };
  } catch (e) {
    return createImageBitmap(new Blob([data], { type }));
  } finally {
    if (f) f.close();
    if (dec) dec.close();
  }
}
// CPU の画素（items: { tex, data, w, h, bpp }）をテクスチャの一番上の段に送る。書き込める状態で作ったバッファに 1 行
// 256 バイトにそろえて詰め、テクスチャへの写しはまとめた命令の中で（queue.writeTexture は、描いている最中だと 1 回で
// 100 ms を超えて待たされることがある）
function putPixels(items) {
  let size = 0;
  const lay = items.map(it => { const row = Math.ceil(it.w * it.bpp / 256) * 256, o = size; size += row * it.h; return { row, o }; });
  const buf = device.createBuffer({ size, usage: GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
  const dst = new Uint8Array(buf.getMappedRange());
  items.forEach((it, k) => {
    const { row, o } = lay[k], w = it.w * it.bpp;
    if (row === w) dst.set(it.data.subarray(0, w * it.h), o);
    else for (let j = 0; j < it.h; j++) dst.set(it.data.subarray(j * w, j * w + w), o + j * row);
  });
  buf.unmap();
  const enc = upEncoder();
  items.forEach((it, k) => enc.copyBufferToTexture({ buffer: buf, offset: lay[k].o, bytesPerRow: lay[k].row, rowsPerImage: it.h },
    { texture: it.tex }, [it.w, it.h]));
  afterUpload(() => buf.destroy());
}
// 画像（ImageBitmap か decodeImage の RGBA）をテクスチャの一番上の段に写す。r8unorm なら赤だけ
function putImage(src, tex) {
  if (!src.rgba) {
    device.queue.copyExternalImageToTexture({ source: src }, { texture: tex }, [src.width, src.height]);
    src.close();
    return;
  }
  let data = src.rgba, bpp = 4;
  if (tex.format === 'r8unorm') {
    data = new Uint8Array(src.w * src.h);
    for (let i = 0; i < data.length; i++) data[i] = src.rgba[i * 4];
    bpp = 1;
  }
  putPixels([{ tex, data, w: src.w, h: src.h, bpp }]);
}
const imageSize = src => src.rgba || src.y ? [src.w, src.h] : [src.width, src.height];
const mipPipes = new Map();
const pipeFor = (fmt, entry) => {
  const k = fmt + entry;
  if (!mipPipes.has(k)) mipPipes.set(k, device.createRenderPipeline({ layout: 'auto', vertex: { module: mipModule, entryPoint: 'vs' },
    fragment: { module: mipModule, entryPoint: entry, targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } }));
  return mipPipes.get(k);
};
// 写真を GPU に載せるときに使うパイプラインは、起動のときに先に作っておく（使うときに作ると、そのコマが重くなる）
const extPipes = new Map();
await Promise.all([
  ...[['rgba8unorm', 'fs'], ['r8unorm', 'fs'], ['rg8unorm', 'fs'], ['r8unorm', 'fsY'], ['rg8unorm', 'fsUV']].map(([fmt, entry]) =>
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mipModule, entryPoint: 'vs' },
      fragment: { module: mipModule, entryPoint: entry, targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } })
      .then(p => mipPipes.set(fmt + entry, p))),
  ...[['r8unorm', 'fsY'], ['rg8unorm', 'fsUV']].map(([fmt, entry]) =>
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: extModule, entryPoint: 'vs' },
      fragment: { module: extModule, entryPoint: entry, targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } })
      .then(p => extPipes.set(entry, p))),
]);
function blit(enc, pipe, src, dst) {
  const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: mipSampler }, { binding: 1, resource: src }] });
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
}
function makeMips(enc, tex, levels) {
  const pipe = pipeFor(tex.format, 'fs');
  for (let l = 1; l < levels; l++) {
    blit(enc, pipe, tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 }), tex.createView({ baseMipLevel: l, mipLevelCount: 1 }));
  }
}
// 画像（ImageBitmap）をミップマップ付きのテクスチャに（fmt が r8unorm なら赤だけ。日の当たり方の画像）
function bitmapTexture(src, acc, fmt = 'rgba8unorm') {
  const [w, h] = imageSize(src);
  const { tex, levels } = photoTexture(w, h, fmt, acc);
  putImage(src, tex);
  makeMips(upEncoder(), tex, levels);
  upDone();
  return tex;
}
// 写真の圧縮: 明るさ（r8）を BC4、色（rg8）を BC5 にする。4 x 4 画素ごとに、いちばん明るい値と暗い値と、その間の
// 8 段階のどれかで表す（1 画素 4 ビット。メモリと GPU が読む量が半分になる）。ミップマップを作ったあとの各段を、
// GPU の計算シェーダーで 1 ブロックずつ詰めてバッファに書き、テクスチャに写す。大きさが 4 の倍数でなければしない
const BC_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
struct P { blocksX: u32, blocksY: u32, rowWords: u32, chans: u32 };
@group(0) @binding(2) var<uniform> p: P;
// 16 画素（0〜255）を BC4 の 1 ブロック（8 バイト）に。1 バイト目が明るいほう、2 バイト目が暗いほう（明るいほうが
// 大きいと 8 段階）、続いて画素ごとに 3 ビットの番号（0: 明るいほう、1: 暗いほう、2〜7: 明るいほうから順に間の 6 段）
fn bc4(v: ptr<function, array<u32, 16>>) -> vec2u {
  var hi = 0u;
  var lo = 255u;
  for (var i = 0u; i < 16u; i++) { hi = max(hi, (*v)[i]); lo = min(lo, (*v)[i]); }
  var a = hi | (lo << 8u);
  var b = 0u;
  if (hi > lo) {
    let d = f32(hi - lo);
    for (var i = 0u; i < 16u; i++) {
      let t = u32(round(f32(hi - (*v)[i]) * 7.0 / d));
      let idx = select(select(t + 1u, 1u, t == 7u), 0u, t == 0u);
      let bit = 16u + 3u * i;
      if (bit < 32u) {
        a |= idx << bit;
        if (bit > 29u) { b |= idx >> (32u - bit); }
      } else { b |= idx << (bit - 32u); }
    }
  }
  return vec2u(a, b);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= p.blocksX || g.y >= p.blocksY) { return; }
  let size = vec2i(textureDimensions(src));
  var r: array<u32, 16>;
  var c: array<u32, 16>;
  for (var i = 0u; i < 16u; i++) {
    let at = min(vec2i(i32(g.x * 4u + (i & 3u)), i32(g.y * 4u + (i >> 2u))), size - 1);
    let s = textureLoad(src, at, 0);
    r[i] = u32(round(s.r * 255.0));
    c[i] = u32(round(s.g * 255.0));
  }
  let o = g.y * p.rowWords + g.x * 2u * p.chans;
  let x = bc4(&r);
  out[o] = x.x; out[o + 1u] = x.y;
  if (p.chans == 2u) { let y = bc4(&c); out[o + 2u] = y.x; out[o + 3u] = y.y; }
}`;
const bcPipe = BC ? await device.createComputePipelineAsync({ layout: 'auto',
  compute: { module: device.createShaderModule({ code: BC_WGSL }), entryPoint: 'main' } }) : null;
const align = (n, a) => Math.ceil(n / a) * a;
function bcTexture(src, chans) {
  const w = src.width, h = src.height, levels = src.mipLevelCount, fmt = chans === 1 ? 'bc4-r-unorm' : 'bc5-rg-unorm';
  const blockBytes = 8 * chans;
  const lv = [];
  let size = 0;
  for (let l = 0; l < levels; l++) {
    const bx = Math.ceil(Math.max(1, w >> l) / 4), by = Math.ceil(Math.max(1, h >> l) / 4), row = align(bx * blockBytes, 256);
    lv.push({ bx, by, row, offset: size });
    size += align(row * by, 256);
  }
  const buf = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const ubuf = device.createBuffer({ size: 256 * levels, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const u = new Uint32Array(64 * levels);
  lv.forEach((v, l) => u.set([v.bx, v.by, v.row / 4, chans], l * 64));
  device.queue.writeBuffer(ubuf, 0, u);
  const tex = device.createTexture({ size: [w, h], format: fmt, mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  tex.bytes = Math.round(w * h * BYTES[fmt] * 4 / 3); tex.acc = src.acc;
  if (tex.acc) mem[tex.acc] += tex.bytes;
  const enc = upEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(bcPipe);
  lv.forEach((v, l) => {
    pass.setBindGroup(0, device.createBindGroup({ layout: bcPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: src.createView({ baseMipLevel: l, mipLevelCount: 1 }) },
      { binding: 1, resource: { buffer: buf, offset: v.offset, size: v.row * v.by } },
      { binding: 2, resource: { buffer: ubuf, offset: l * 256, size: 16 } }] }));
    pass.dispatchWorkgroups(Math.ceil(v.bx / 8), Math.ceil(v.by / 8));
  });
  pass.end();
  lv.forEach((v, l) => enc.copyBufferToTexture({ buffer: buf, offset: v.offset, bytesPerRow: v.row, rowsPerImage: v.by },
    { texture: tex, mipLevel: l }, [v.bx * 4, v.by * 4]));
  afterUpload(() => { buf.destroy(); ubuf.destroy(); });
  dropTexture(src);
  upDone();
  return tex;
}
// Y と UV を圧縮したものに取りかえる（できないときはそのまま）
function bcYuv(t) {
  if (!BC || t.y.width % 4 || t.y.height % 4 || t.uv.width % 4 || t.uv.height % 4) return t;
  return { y: bcTexture(t.y, 1), uv: bcTexture(t.uv, 2) };
}
// 写真（ImageBitmap か decodeImage の RGBA）を GPU の中で明るさ（Y、r8）と縦横半分の色（UV、rg8）のテクスチャに（今の
// ビューアの gpuPlanes と同じ。UV は RGB の 2 x 2 画素の真ん中を線形補間で引いて平均する）。decodeImage が Y と UV で
// 出したものは planeTextures へ
function yuvTextures(src, acc) {
  if (src.y) return planeTextures(src, acc);
  const [w, h] = imageSize(src);
  const rgb = device.createTexture({ size: [w, h], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  putImage(src, rgb);
  const y = photoTexture(w, h, 'r8unorm', acc), uv = photoTexture((w + 1) >> 1, (h + 1) >> 1, 'rg8unorm', acc);
  const enc = upEncoder();
  blit(enc, pipeFor('r8unorm', 'fsY'), rgb.createView(), y.tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }));
  blit(enc, pipeFor('rg8unorm', 'fsUV'), rgb.createView(), uv.tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }));
  makeMips(enc, y.tex, y.levels);
  makeMips(enc, uv.tex, uv.levels);
  afterUpload(() => rgb.destroy());
  upDone();
  return bcYuv({ y: y.tex, uv: uv.tex });
}
// 展開したコマ（VideoFrame）から、RGB の画像を作らずに直接 Y と UV のテクスチャに。コマは命令を送ったらすぐ閉じる
// （専用回路のコマを抱えていると、次の展開が詰まる）
function frameTextures(frame, acc) {
  try {
    const w = frame.visibleRect.width, h = frame.visibleRect.height;
    const ext = device.importExternalTexture({ source: frame });
    const y = photoTexture(w, h, 'r8unorm', acc), uv = photoTexture((w + 1) >> 1, (h + 1) >> 1, 'rg8unorm', acc);
    const enc = upEncoder();
    for (const [t, entry] of [[y, 'fsY'], [uv, 'fsUV']]) blit(enc, extPipes.get(entry), ext, t.tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }));
    makeMips(enc, y.tex, y.levels);
    makeMips(enc, uv.tex, uv.levels);
    const out = { ...bcYuv({ y: y.tex, uv: uv.tex }), ready: true };
    upDone();
    return out;
  } finally { afterUpload(() => frame.close()); }
}
// 展開したもの（frameTextures の結果、ImageBitmap、CPU の Y と UV）を手放す
function dropFrames(frames) {
  for (const f of frames || []) {
    if (!f) continue;
    if (f.ready) { dropTexture(f.y); dropTexture(f.uv); }
    else if (f.bitmap) f.bitmap.close();
  }
}
// CPU にある Y と UV（hevc.js が読み戻したもの（季節の色のとき）と、decodeImage が開いた JPEG）から
function planeTextures(p, acc) {
  const cw = (p.w + 1) >> 1, ch = (p.h + 1) >> 1;
  const y = photoTexture(p.w, p.h, 'r8unorm', acc), uv = photoTexture(cw, ch, 'rg8unorm', acc);
  putPixels([{ tex: y.tex, data: p.y, w: p.w, h: p.h, bpp: 1 }, { tex: uv.tex, data: p.uv, w: cw, h: ch, bpp: 2 }]);
  const enc = upEncoder();
  makeMips(enc, y.tex, y.levels);
  makeMips(enc, uv.tex, uv.levels);
  upDone();
  return bcYuv({ y: y.tex, uv: uv.tex });
}
const tex1 = (fmt, data) => {
  const t = device.createTexture({ size: [1, 1], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: t }, new Uint8Array(data), { bytesPerRow: 4 }, [1, 1]);
  return t;
};
const white = tex1('rgba8unorm', [255, 255, 255, 255]), whiteR = tex1('r8unorm', [255, 0, 0, 0]);

// ---------------------------------------------------------------- 大気の表と画面ごとの値

const frameMain = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const framePick = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const atmoSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const atmoFormat = floatFilter ? 'rgba32float' : 'rgba16float';
let atmoT2 = device.createTexture({ size: [1, 1], format: atmoFormat, usage: GPUTextureUsage.TEXTURE_BINDING });
let atmoT3 = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: atmoFormat, usage: GPUTextureUsage.TEXTURE_BINDING });
const frameBind = buf => device.createBindGroup({ layout: frameLayout, entries: [
  { binding: 0, resource: { buffer: buf } }, { binding: 1, resource: atmoSampler },
  { binding: 2, resource: atmoT2.createView() }, { binding: 3, resource: atmoT3.createView({ dimension: '3d' }) }] });
let groupMain = frameBind(frameMain), groupPick = frameBind(framePick), atmoReady = false;
// 前もって計算する表は、今のビューアのワーカーで（WebGL2 で数秒）。float32 の補間ができないときは使わない
if (ATMOSPHERE && floatFilter) {
  const worker = new Worker('atmosphere.js');
  worker.onmessage = ({ data }) => {
    worker.terminate();
    if (!data.ok) { console.warn('大気を計算できない:', data.error); return; }
    const tex = (w, h, d, pixels) => {
      const t = device.createTexture({ size: [w, h, d], dimension: d > 1 ? '3d' : '2d', format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, pixels, { bytesPerRow: w * 16, rowsPerImage: h }, [w, h, d]);
      return t;
    };
    atmoT2 = tex(256, 64, 1, data.transmittance); atmoT3 = tex(256, 128, 32, data.scattering);
    groupMain = frameBind(frameMain); groupPick = frameBind(framePick);
    atmoReady = true; dirty = true;
  };
  worker.postMessage({ haze: ATMO.haze });
}
const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// 画面ごとの値: カメラは真下の楕円体からの高さで大気の球（半径 6360 km）の上に置く（今のビューアと同じ）
function frameData(vp, pickM) {
  const { east, north, up } = enu(cam.pos), h = Math.max(geodetic(cam.pos)[2], 1) / 1000;
  const [az, el] = atmoSun.map(d => d * RAD);
  const sun = norm(add(add(mul(east, Math.sin(az) * Math.cos(el)), mul(north, Math.cos(az) * Math.cos(el))), mul(up, Math.sin(el))));
  const mode = !atmoReady ? 0 : look === 'apple' ? 1 : 2;
  const f = new Float32Array(52);
  f.set([...mul(up, 6360 + h), mode, ...sun, 0, ...ATMO.balance, ATMO.exposure, ATMO.aerial, ATMO.aerialNear, ATMO.aerialKm, ATMO.grey]);
  f.set(mat4inv(vp), 16);
  f.set(pickM || IDENTITY, 32);
  f.set([...cam.pos, 0], 48);
  return f;
}

// ---------------------------------------------------------------- 地形

// 地理座標のタイル（レベル L は東西 2^(L+1)、南北 2^L 枚）。65 x 65 の楕円体高で、北西の角から行ごとに東へ
const TERRAIN_MAX = 13;
const geoTiles = new Map(), geoData = new Map();
function geoTile(L, x, y) {
  const k = L + '/' + x + '/' + y;
  if (!geoTiles.has(k)) {
    geoTiles.set(k, fetch(`${hostBase(x + y + L)}/api/terrain/${L}/${x}/${y}.bin?v=2`)
      .then(r => r.ok ? r.arrayBuffer() : null).then(b => b && new Float32Array(b)).catch(() => null)
      .then(a => { if (a) geoData.set(k, a); return a; }));
  }
  return geoTiles.get(k);
}
function sampleHeight(a, L, x, y, lat, lon) {      // 度
  const size = 180 / (1 << L);
  const fx = clamp(((lon + 180) / size - x) * 64, 0, 64), fy = clamp(((90 - lat) / size - y) * 64, 0, 64);
  const x0 = Math.min(Math.floor(fx), 63), y0 = Math.min(Math.floor(fy), 63), tx = fx - x0, ty = fy - y0;
  const h = (i, j) => a[j * 65 + i];
  return (h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx) * (1 - ty) + (h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx) * ty;
}
// 手元にあるいちばん細かい地形の、その地点の楕円体高（度で）。なければ undefined
function heightAt(lat, lon) {
  for (let L = TERRAIN_MAX; L >= 0; L--) {
    const size = 180 / (1 << L), x = Math.floor((lon + 180) / size), y = Math.floor((90 - lat) / size);
    const a = geoData.get(L + '/' + x + '/' + y);
    if (a) return sampleHeight(a, L, x, y, lat, lon);
  }
  return undefined;
}

// ---------------------------------------------------------------- 地面のタイル

const MAX_Z = 20, N = 33;
const indices = (() => {
  const out = [];
  const g = (i, j) => j * N + i;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) out.push(g(i, j), g(i + 1, j), g(i, j + 1), g(i + 1, j), g(i + 1, j + 1), g(i, j + 1));
  // 継ぎ目の隙間を隠す縁: 北・南・西・東の辺の順に、格子の頂点 N 個と、その真下に垂らした頂点 N 個
  const edges = [i => g(i, 0), i => g(i, N - 1), j => g(0, j), j => g(N - 1, j)];
  edges.forEach((e, k) => {
    const base = N * N + k * N;
    for (let i = 0; i < N - 1; i++) out.push(e(i), e(i + 1), base + i, e(i + 1), base + i + 1, base + i);
  });
  return new Uint16Array(out);
})();
const indexBuffer = device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(indexBuffer, 0, indices);
const MAX_DRAW = 4096, U_STRIDE = 256;
const uniformBuffer = device.createBuffer({ size: MAX_DRAW * U_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const uniformData = new Float32Array(MAX_DRAW * U_STRIDE / 4);

const heightRange = new Map();          // タイル -> 読んだときの楕円体高の範囲（捨てても覚えておく）
let rangeGen = 0;                         // heightRange が増えるたびに 1 増やす（増えていなければ bounds() は探し直さない）
const UNKNOWN_RANGE = [-100, 9000];
class Tile {
  constructor(z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent; this.key = z + '/' + x + '/' + y;
    this.state = 'none'; this.kids = null; this.used = 0; this.wantedAt = 0; this.abort = null;
    const n = 2 ** z;
    this.lonW = x / n * 360 - 180; this.lonE = (x + 1) / n * 360 - 180;
    this.latN = mercLat(y, n); this.latS = mercLat(y + 1, n);
    const pts = [];
    for (const la of [this.latN, (this.latN + this.latS) / 2, this.latS])
      for (const lo of [this.lonW, (this.lonW + this.lonE) / 2, this.lonE]) pts.push(ecef(la * RAD, lo * RAD, 0));
    this.corners = pts;
    this.width = len(sub(pts[3], pts[5]));
    this._range = null;
    this.bounds();
  }
  // 見えるかどうかと細かくするかどうかに使う球。高さの範囲は、このタイルか、いちばん近い親の読んだときの範囲。
  // 覚えた範囲は捨てても戻らないので、読んだ・捨てたで判断が行ったり来たりしない
  bounds() {
    if (this._gen === rangeGen) return;
    this._gen = rangeGen;
    let t = this, r;
    while (t && !(r = heightRange.get(t.key))) t = t.parent;
    r = r || UNKNOWN_RANGE;
    if (r === this._range) return;
    this._range = r;
    const pts = [];
    for (const la of [this.latN, (this.latN + this.latS) / 2, this.latS])
      for (const lo of [this.lonW, (this.lonW + this.lonE) / 2, this.lonE])
        for (const h of r) pts.push(ecef(la * RAD, lo * RAD, h));
    this.center = mul(pts.reduce(add), 1 / pts.length);
    this.radius = Math.max(...pts.map(p => len(sub(p, this.center))));
  }
  children() {
    if (!this.kids) {
      this.kids = [];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.kids.push(new Tile(this.z + 1, this.x * 2 + i, this.y * 2 + j, this));
    }
    return this.kids;
  }
}
const roots = [];
for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) roots.push(new Tile(1, x, y, null));
// 読み込んだ地面のタイルは groundUploads に並べ、1 コマに GROUND_UPLOADS_PER_FRAME 枚まで GPU に載せる（一度に
// たくさん届いても、1 コマが重くならないように）
const MAX_ACTIVE = 32, GROUND_UPLOADS_PER_FRAME = 8;
let active = 0, loadedCount = 0;
const groundUploads = [];
async function load(t) {
  t.state = 'loading'; active++;
  const ac = t.abort = new AbortController();
  try {
    const n = 2 ** t.z;
    const img = fetch(`${hostBase(t.x + t.y + t.z)}/api/sat/${t.z}/${t.x}/${t.y}.jpg`, { signal: ac.signal })
      .then(async r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return decodeImage(await r.arrayBuffer(), (r.headers.get('content-type') || 'image/jpeg').split(';')[0], true);
      });
    // 地形: 東西の幅が同じ地理座標のタイル（ズーム z ならレベル z - 1）。南北は 1〜2 枚にかかる。ズーム 5 以下は
    // サーバーが地形を入れない（ジオイドだけ）ので、楕円体のまま
    const L = Math.min(t.z - 1, TERRAIN_MAX);
    const size = 180 / (1 << L), gx = Math.floor((t.lonW + 180) / size + 1e-9);
    const gy0 = Math.max(0, Math.floor((90 - t.latN) / size)), gy1 = Math.min((1 << L) - 1, Math.floor((90 - t.latS) / size - 1e-9));
    const useTerrain = t.z >= 6;
    const geo = useTerrain ? await Promise.all(Array.from({ length: gy1 - gy0 + 1 }, (_, k) => geoTile(L, gx, gy0 + k))) : [];
    const verts = new Float32Array((N * N + 4 * N) * 5);
    const P = [], UV = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = i / (N - 1), v = j / (N - 1);
      const lon = t.lonW + (t.lonE - t.lonW) * u, lat = mercLat(t.y + v, n);
      let h = 0;
      if (useTerrain) {
        const gy = Math.min(Math.max(Math.floor((90 - lat) / size), gy0), gy1);
        const a = geo[gy - gy0];
        if (a) h = sampleHeight(a, L, gx, gy, lat, lon);
      }
      P.push(ecef(lat * RAD, lon * RAD, h)); UV.push([u, v]);
    }
    const center = mul(P.reduce(add), 1 / P.length);
    if (useTerrain) {
      const hs = P.map(p => geodetic(p)[2]);
      heightRange.set(t.key, [Math.min(...hs) - 50, Math.max(...hs) + 50]);
    } else heightRange.set(t.key, UNKNOWN_RANGE);
    rangeGen++;
    const skirt = t.width * 0.02 + 30;
    const put = (k, p, uv) => { const d = sub(p, center); verts.set([d[0], d[1], d[2], uv[0], uv[1]], k * 5); };
    P.forEach((p, k) => put(k, p, UV[k]));
    const edges = [i => i, i => (N - 1) * N + i, j => j * N, j => j * N + N - 1];
    edges.forEach((e, k) => { for (let i = 0; i < N; i++) { const p = P[e(i)]; put(N * N + k * N + i, sub(p, mul(norm(p), skirt)), UV[e(i)]); } });
    groundUploads.push({ t, verts, center, image: await img });
  } catch (e) {
    t.state = e.name === 'AbortError' ? 'none' : 'failed';
  } finally {
    active--; t.abort = null; dirty = true; selStale = true;
  }
}
function groundUpload({ t, verts, center, image }) {
  // 書き込める状態で作って詰める（queue.writeBuffer は、描いている最中だと長く待たされることがある）
  const vbuf = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
  new Float32Array(vbuf.getMappedRange()).set(verts);
  vbuf.unmap();
  const tex = yuvTextures(image, 'ground');
  t.vbuf = vbuf; t.tex = tex; t.meshCenter = center;
  t.bind = device.createBindGroup({ layout: groundLayout, entries: [
    { binding: 0, resource: { buffer: uniformBuffer, size: 96 } },
    { binding: 1, resource: linear }, { binding: 2, resource: tex.y.createView() }, { binding: 3, resource: tex.uv.createView() }] });
  t.state = 'ready'; loadedCount++;
}
function unload(t) {
  t.vbuf.destroy(); dropTexture(t.tex.y); dropTexture(t.tex.uv);
  t.vbuf = t.tex = t.bind = null; t.state = 'none'; loadedCount--;
}
// 北極と南極のふた（Web メルカトルの範囲の外。今のビューアと同じく、地球儀の下地の色）
const caps = [1, -1].map(sgn => {
  const SEG = 64, RINGS = 4, edge = mercLat(0, 1);   // 85.05°
  const pole = ecef(sgn * 90 * RAD, 0, 0), P = [pole];
  for (let r = 1; r <= RINGS; r++) {
    const lat = sgn * (90 - (90 - edge) * r / RINGS);
    for (let s = 0; s <= SEG; s++) P.push(ecef(lat * RAD, (s / SEG * 360 - 180) * RAD, 0));
  }
  const verts = new Float32Array(P.length * 5);
  P.forEach((p, k) => { const d = sub(p, pole); verts.set([d[0], d[1], d[2], 0.5, 0.5], k * 5); });
  const idx = [];
  for (let s = 0; s < SEG; s++) idx.push(0, 1 + s, 2 + s);
  for (let r = 1; r < RINGS; r++) {
    const a = 1 + (r - 1) * (SEG + 1), b = 1 + r * (SEG + 1);
    for (let s = 0; s < SEG; s++) idx.push(a + s, b + s, a + s + 1, a + s + 1, b + s, b + s + 1);
  }
  const vbuf = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vbuf, 0, verts);
  const ia = new Uint16Array(idx.length + (idx.length & 1));      // 書き込む長さを 4 バイトの倍数に
  ia.set(idx);
  const ibuf = device.createBuffer({ size: ia.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ibuf, 0, ia);
  const c = [0x0b, 0x1a, 0x2e].map(v => v / 255), Y = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  const yT = tex1('r8unorm', [Math.round(Y * 255), 0, 0, 0]);
  const uvT = tex1('rg8unorm', [Math.round((c[2] - Y) / 1.772 * 255 + 128), Math.round((c[0] - Y) / 1.402 * 255 + 128), 0, 0]);
  const bind = device.createBindGroup({ layout: groundLayout, entries: [
    { binding: 0, resource: { buffer: uniformBuffer, size: 96 } },
    { binding: 1, resource: linear }, { binding: 2, resource: yT.createView() }, { binding: 3, resource: uvT.createView() }] });
  return { cap: true, meshCenter: pole, vbuf, ibuf, count: idx.length, bind };
});

function frustumPlanes(vp) {
  const row = r => [vp[r], vp[4 + r], vp[8 + r], vp[12 + r]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  return [r3.map((v, i) => v + r0[i]), r3.map((v, i) => v - r0[i]), r3.map((v, i) => v + r1[i]),
    r3.map((v, i) => v - r1[i]), r3.map((v, i) => v - r2[i])].map(p => { const l = Math.hypot(p[0], p[1], p[2]); return p.map(v => v / l); });
}
const sphereOut = (planes, c, r) => planes.some(p => p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r);

// 地面のタイルの選び方: 画面で REFINE_PX より大きく見えるものは子に分け、目的の細かさのタイルを直接読む。届くまでは
// 手元の細かいタイル（2 段下まで）か、手元のいちばん近い親で埋める（親はステンシルで、届いたタイルの描いていない画素
// だけ）。代わりの親が 4 段以上粗ければ、3 段上の親も読む。そのコマで使わなかったタイルはすぐに捨てる
const REFINE_PX = 256;
let frame = 0;
function selectGround(vp, H, aspect) {
  frame++;
  const draw = [], wantLoad = [], parents = new Set(), now = performance.now();
  const camPos = cam.pos, k = H / (2 * Math.tan(fovy(aspect) / 2));
  const planes = frustumPlanes(vp), camR = len(camPos);
  const hz = Math.sqrt(Math.max(camR * camR - A * A, 0));
  const isVisible = t => {
    t.bounds();
    if (sphereOut(planes, sub(t.center, camPos), t.radius)) return false;
    if (t.z >= 4) {         // 地平線の向こう
      if (!t.corners.some(p => len(sub(p, camPos)) < hz + t.radius * 0.5 + 2000 || dot(norm(p), sub(camPos, p)) > 0)) return false;
    }
    return true;
  };
  const visible = t => {    // 1 回の選び方で同じタイルを何度も聞くので、覚えておく
    if (t.visFrame !== frame) { t.visFrame = frame; t.gvis = isVisible(t); }
    return t.gvis;
  };
  const px = t => t.width * k / Math.max(1, len(sub(t.center, camPos)) - t.width * 0.71);
  const FULL = [0, 0, 1, 1];
  const covered = (t, d) => t.state === 'ready' || (d > 0 && !!t.kids && t.kids.every(c => !visible(c) || covered(c, d - 1)));
  const drawCovered = (t, d) => {
    if (t.state === 'ready') { t.used = frame; draw.push({ t, rect: FULL, fallback: false }); return; }
    for (const c of t.kids) if (visible(c)) drawCovered(c, d - 1);
  };
  const want = t => { t.used = frame; t.wantedAt = now; if (t.state === 'none') wantLoad.push(t); };
  const visit = t => {
    t.seen = frame;
    if (!visible(t)) return;
    if (t.z < MAX_Z && px(t) > REFINE_PX) { for (const c of t.children()) visit(c); return; }
    want(t);
    if (t.state === 'ready') { draw.push({ t, rect: FULL, fallback: false }); return; }
    if (covered(t, 2)) { drawCovered(t, 2); return; }
    let a = t.parent;
    while (a && a.state !== 'ready') a = a.parent;
    if (a) { a.used = frame; parents.add(a); }
    if (!a || t.z - a.z > 3) {
      let m = t;
      for (let i = 0; i < 3 && m.parent; i++) m = m.parent;
      want(m);
    }
  };
  for (const r of roots) want(r);
  for (const r of roots) visit(r);
  const dirC = cam.dir;
  wantLoad.sort((a, b) => {
    if ((a.z === 1) !== (b.z === 1)) return a.z === 1 ? -1 : 1;
    return dot(norm(sub(b.center, camPos)), dirC) - dot(norm(sub(a.center, camPos)), dirC);
  });
  for (const t of wantLoad) { if (active >= MAX_ACTIVE) break; if (t.state === 'none') load(t); }
  for (const t of parents) draw.push({ t, rect: FULL, fallback: true });
  for (const c of caps) draw.push({ t: c, rect: FULL, fallback: false });
  // 捨てる: そのコマで使わなかったもの（ズーム 1 の 4 枚は残す）。読みかけは 4 秒要らなければ取りやめる
  const prune = t => {
    if (!t.kids) return;
    for (const c of t.kids) {
      prune(c);
      if (c.state === 'ready' && c.used !== frame) unload(c);
      else if (c.state === 'loading' && c.abort && now - c.wantedAt > 4000) c.abort.abort();
    }
    // 子がどれも空なら子を消す。ただしこのコマで見たタイルの子は残す（次のコマですぐ作り直すことになる）
    if (t.seen !== frame && t.kids.every(c => c.state === 'none' && !c.kids)) t.kids = null;
  };
  for (const r of roots) prune(r);
  return draw;
}

// ---------------------------------------------------------------- Flyover の 3D の建物

const FLY = { min: cfg.minZoom, max: cfg.maxZoom };
const SHOW_PX = 175 / devicePixelRatio;
const FLY_REFINE_PX = (Number(params.get('lodpx')) || 520) / devicePixelRatio;   // CSS px（?lodpx= で変えられる）
const FLY_ACTIVE = 48, KEEP_MS = 5000, MAX_MODELS = 150, UPLOADS_PER_FRAME = 4;
// HEVC のまま受け取って GPU の専用回路で展開する（できないときと ?hevc=0 のときは JPEG）
let hevc = cfg.r3d && typeof VideoDecoder !== 'undefined' && params.get('hevc') !== '0'
  && (await VideoDecoder.isConfigSupported({ codec: 'hvc1.3.E.L120.B0', hardwareAcceleration: 'prefer-hardware' })
    .catch(() => ({}))).supported === true;
// 展開は 1 つずつ（同時にいくつも展開すると GPU の側が詰まり、画面が 100 ms 単位で止まる。読み込みも遅くなる）。
// ?hevcw= で数を変えられる
const HEVC_WORKERS = Number(params.get('hevcw')) || 1;
const hevcWorkers = hevc ? Array.from({ length: HEVC_WORKERS }, () => ({ worker: new Worker('hevc.js'), job: null })) : [];
const hevcPending = [];
// コマをそのまま受け取るか（?hevcframe=0 で前と同じく RGB の画像で受け取る）
const HEVC_FRAME = params.get('hevcframe') !== '0';
for (const w of hevcWorkers) w.worker.onmessage = ({ data }) => {
  const job = w.job;
  if (data.frame) {             // 1 枚ずつ届くコマは、すぐ GPU で Y と UV にする
    try { job.parts[data.part] = frameTextures(data.frame, 'fly'); } catch (e) { job.partError = e; }
    return;
  }
  w.job = null;
  const err = data.error ? new Error(data.error) : job.partError;
  if (err) { dropFrames(job.parts); job.reject(err); }
  else job.resolve(data.out.map(o => o.part !== undefined ? job.parts[o.part] : o));
  hevcNext();
};
function hevcNext() {
  const now = performance.now();
  for (let i = hevcPending.length - 1; i >= 0; i--) {     // しばらく（4 秒）要らなかったものは展開しない
    if (now - hevcPending[i].t.wantedAt > 4000) hevcPending.splice(i, 1)[0].reject(new DOMException('要らなくなった', 'AbortError'));
  }
  const rank = ({ t }) => (t.vis && t.wanted === fframe ? 0 : 1e9) + t.pri;
  for (const w of hevcWorkers) {
    if (w.job || !hevcPending.length) continue;
    let best = 0;
    for (let i = 1; i < hevcPending.length; i++) if (rank(hevcPending[i]) < rank(hevcPending[best])) best = i;
    w.job = hevcPending.splice(best, 1)[0];
    w.job.parts = [];
    // 季節の色では、写真の色を CPU で見る（gpu-season.js）ので、Y と UV を読み戻す
    w.worker.postMessage({ id: 0, images: w.job.images, gpu: season !== undefined ? false : HEVC_FRAME ? 'frame' : true });
  }
}
const hevcDecode = (t, images) => new Promise((resolve, reject) => { hevcPending.push({ t, images, resolve, reject }); hevcNext(); });

const flySphere = new Map();      // タイル -> 読んだときの建物の範囲の球（捨てても覚えておく）
class FTile {
  constructor(z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent; this.key = z + '/' + x + '/' + y;
    const n = 2 ** z;
    this.lonW = x / n * 360 - 180; this.lonE = (x + 1) / n * 360 - 180;
    this.latN = mercLat(y, n); this.latS = mercLat(y + 1, n);
    const latC = mercLat(y + 0.5, n), lonC = (this.lonW + this.lonE) / 2;
    this.width = (this.lonE - this.lonW) * RAD * A * Math.cos(latC * RAD);
    this.ground = ecef(latC * RAD, lonC * RAD, 0);
    const { east, north, up } = enu(this.ground);
    this.east = east; this.north = north; this.up = up;
    this.half = Math.hypot(this.width, (this.latN - this.latS) * RAD * A) / 2;
    this._range = null; this._sphere = null;
    this.state = 'none'; this.model = null; this.kids = null; this.abort = null;
    this.used = 0; this.usedAt = 0; this.wanted = 0; this.wantedAt = 0; this.pri = Infinity; this.failedAt = 0;
    this.sun0 = [0, 0, 0, 0];
  }
  // 見えるかどうかを調べる球。読んだことがあればそのときの建物の範囲、なければ同じ位置の地面のタイルで覚えた高さの
  // 範囲に建物の高さ（600 m）を足したもの。捨てても戻らないので、判断が行ったり来たりしない
  sphere() {
    const known = flySphere.get(this.key);
    if (known) return known;
    let z = this.z, x = this.x, y = this.y, r;
    while (z >= 1 && !(r = heightRange.get(z + '/' + x + '/' + y))) { z--; x >>= 1; y >>= 1; }
    r = r || UNKNOWN_RANGE;
    if (r !== this._range) {
      this._range = r;
      const lo = r[0], hi = r[1] + 600;
      this._sphere = { c: add(this.ground, mul(this.up, (lo + hi) / 2)), r: Math.hypot(this.half, (hi - lo) / 2) };
    }
    return this._sphere;
  }
  children() {
    if (!this.kids) {
      this.kids = [];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.kids.push(new FTile(this.z + 1, this.x * 2 + i, this.y * 2 + j, this));
    }
    return this.kids;
  }
}
const flyRoots = (cfg.coverage || []).map(([x, y]) => new FTile(9, x, y, null));
let fframe = 0, flyActive = 0, flyModels = 0, evictTimer = 0;
const uploads = [];
const flyLoading = new Set();

// 写真を撮った時刻（Unix 時刻）。ズーム 20 のタイルにしか入っていないので、ほかの所はその地点のズーム 20 のタイルの
// 時刻（読み込んであればそれ、なければサーバーに聞く /api/captured。結果は覚えておく）
const capturedKnown = new Map(), capturedWait = new Map();
function z20Key(latDeg, lonDeg) {
  const n = 2 ** FLY.max;
  return Math.floor((lonDeg + 180) / 360 * n) + '/' + Math.floor((1 - Math.asinh(Math.tan(latDeg * RAD)) / Math.PI) / 2 * n);
}
function capturedOf(key) {
  if (capturedKnown.has(key)) return Promise.resolve(capturedKnown.get(key));
  if (!capturedWait.has(key)) capturedWait.set(key, fetch(`/api/captured/${FLY.max}/${key}`)
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(v => { capturedKnown.set(key, v); capturedWait.delete(key); return v; }));
  return capturedWait.get(key);
}
// ?light= で、タイルの写真を撮ったときの太陽（タイルの中心の時刻から）
function setSun0(t) {
  const latC = mercLat(t.y + 0.5, 2 ** t.z), lonC = (t.lonW + t.lonE) / 2;
  const use = ts => {
    if (!ts) return;
    const [az, el] = sunAt(ts, latC, lonC).map(d => d * RAD);
    if (el <= 0.05) return;
    t.sun0 = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el), 1];
    dirty = true;
  };
  if (t.captured) use(t.captured); else capturedOf(z20Key(latC, lonC)).then(use);
}

function glbParts(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl)));
  const bin = buf.subarray(28 + jl, 28 + jl + dv.getUint32(20 + jl, true));
  return { json, bin };
}
async function flyLoad(t) {
  t.state = 'loading'; flyActive++; flyLoading.add(t);
  const ac = t.abort = new AbortController();
  const useHevc = hevc;
  let frames = [], queued = false;
  try {
    const r = await fetch(`${hostBase(t.x + t.y + 1)}/api/flyover/${t.z}/${t.x}/${t.y}.glb${useHevc ? '?hevc=1' : ''}`, { signal: ac.signal });
    if (r.status === 204) { t.state = 'empty'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    let { json: g, bin } = glbParts(buf);
    const view = i => { const v = g.bufferViews[i]; return bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength); };
    t.captured = g.asset.extras && g.asset.extras.captured;
    if (t.z === FLY.max && t.captured !== undefined) capturedKnown.set(t.x + '/' + t.y, t.captured || null);
    // 画像: HEVC は展開する（展開できなければ、以後は JPEG で受け取る）。ほかは JPEG・PNG のまま
    const hv = g.materials.map(m => m.extras && m.extras.hevc).filter(Boolean).sort((a, b) => a.slab - b.slab);
    if (hv.length) {
      try {
        frames = await hevcDecode(t, hv.map(h => ({ config: view(h.config).slice(), data: view(h.data).slice() })));
      } catch (e) {
        if (e.name !== 'AbortError') { hevc = false; console.warn('HEVC を展開できないので、JPEG にする', e); }
        t.state = 'none';
        return;
      }
    }
    if (season !== undefined) {            // 季節の色: スプラットに木の葉かどうかの印を付ける（buf を書き換える）
      try { await markTreeSplats(buf, frames, t.z >= 19); } catch (e) { console.warn('季節の色の印', t.key, e); }
      ({ json: g, bin } = glbParts(buf));
    }
    // 使う画像だけを読む: HEVC でない材質の写真と、?light= のときは日の当たり方の画像
    const need = new Set();
    for (const m of g.materials) {
      const bt = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
      if (bt && !(m.extras && m.extras.hevc)) need.add(g.textures[bt.index].source);
      if (light && m.occlusionTexture) need.add(g.textures[m.occlusionTexture.index].source);
    }
    const images = await Promise.all((g.images || []).map((im, i) => need.has(i)
      ? decodeImage(view(im.bufferView), im.mimeType, false) : null));
    uploads.push({ t, g, bin, frames, images });
    queued = true;
    if (light) setSun0(t);
  } catch (e) {
    if (e.name === 'AbortError') t.state = 'none';
    else { t.state = 'failed'; t.failedAt = performance.now(); console.warn('Flyover', t.key, e); }
  } finally {
    if (!queued) dropFrames(frames);
    flyActive--; flyLoading.delete(t); t.abort = null; dirty = true;
  }
}
// glb の形（flyover/glb.py の tile_glb）: 位置は int16 x 4（4 つ目は HEVC の材質の番号）で、ノードの translation（中心）と
// scale（1 刻みの長さ）で戻す
function upload({ t, g, bin, frames, images }) {
  const node = g.nodes[0], center = node.translation, step = node.scale[0];
  const used = new Set();
  for (const p of g.meshes[0].primitives) {
    for (const a of Object.values(p.attributes)) used.add(g.accessors[a].bufferView);
    if (p.indices !== undefined) used.add(g.accessors[p.indices].bufferView);
  }
  const offs = new Map();
  let size = 0;
  for (const v of used) { offs.set(v, size); size += (g.bufferViews[v].byteLength + 3) & ~3; }
  const gbuf = device.createBuffer({ size: Math.max(size, 4), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX, mappedAtCreation: true });
  const dst = new Uint8Array(gbuf.getMappedRange());
  for (const v of used) { const bv = g.bufferViews[v]; dst.set(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength), offs.get(v)); }
  gbuf.unmap();
  const at = a => { const ac = g.accessors[a]; return { offset: offs.get(ac.bufferView) + (ac.byteOffset || 0), count: ac.count, ac }; };
  const texs = [];
  const hevcTex = frames.map(f => {
    const tx = f.ready ? f : f.bitmap ? yuvTextures(f.bitmap, 'fly') : planeTextures(f, 'fly');
    texs.push(tx.y, tx.uv);
    return tx;
  });
  const imgTex = images.map((b, i) => {
    if (!b) return null;
    const shadeOnly = g.materials.every(m => !(m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture
      && g.textures[m.pbrMetallicRoughness.baseColorTexture.index].source === i));
    const tx = bitmapTexture(b, 'fly', shadeOnly ? 'r8unorm' : 'rgba8unorm');
    texs.push(tx);
    return tx;
  });
  const prims = [];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of g.meshes[0].primitives) {
    const m = g.materials[p.material], pos = at(p.attributes.POSITION), uv = at(p.attributes.TEXCOORD_0);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], pos.ac.min[i]); hi[i] = Math.max(hi[i], pos.ac.max[i]); }
    let tex, samp = linear, yuv = null;
    if (m.extras && m.extras.hevc) { yuv = hevcTex[m.extras.hevc.slab]; tex = yuv && yuv.y; }
    else {
      const ti = g.textures[m.pbrMetallicRoughness.baseColorTexture.index];
      tex = imgTex[ti.source];
      if (ti.sampler === 1) samp = repeat;
    }
    if (!tex) continue;
    const shade = light && m.occlusionTexture ? imgTex[g.textures[m.occlusionTexture.index].source] : null;
    const bind = device.createBindGroup({ layout: flyLayout, entries: [
      { binding: 0, resource: { buffer: uniformBuffer, size: 160 } }, { binding: 1, resource: samp },
      { binding: 2, resource: tex.createView() }, { binding: 3, resource: (yuv ? yuv.uv : white).createView() },
      { binding: 4, resource: (shade || whiteR).createView() }] });
    if (m.alphaMode === 'BLEND') prims.push({ splat: true, pos, uv, col: at(p.attributes.COLOR_0), count: pos.count, bind });
    else {
      const ix = at(p.indices);
      prims.push({ splat: false, yuv: !!yuv, pos, uv, uvFloat: uv.ac.componentType === 5126, ix, ix32: ix.ac.componentType === 5125, bind });
    }
  }
  const mid = add(center, mul([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], step));
  flySphere.set(t.key, { c: mid, r: len(sub(hi, lo)) * step / 2 });
  t.model = { buf: gbuf, texs, prims, center, step, off: sub(t.ground, center) };
  t.state = 'ready'; flyModels++;
  t.usedAt = performance.now();     // 載せたばかりのものを、まだ描いていないからと同じコマで捨てない
}
function flyUnload(t) {
  t.model.buf.destroy(); t.model.texs.forEach(dropTexture);
  t.model = null; t.state = 'none'; flyModels--;
}
// 今のビューアの updateFlyover と同じ選び方。描くもの [{t, mask}] を返す
function selectFlyover(planes, cssH, aspect) {
  fframe++;
  const out = [], queue = [], now = performance.now();
  const [camLat, camLon, camH] = geodetic(cam.pos);
  if (!GE.mode2D && camH < 400e3 && flyRoots.length) {
    const k = cssH / (2 * Math.tan(fovy(aspect) / 2));
    const visible = t => { const s = t.sphere(); return !sphereOut(planes, sub(s.c, cam.pos), s.r); };
    const dist = t => {
      const la = clamp(camLat / RAD, t.latS, t.latN), lo = clamp(camLon / RAD, t.lonW, t.lonE);
      return Math.max(1, len(sub(cam.pos, ecef(la * RAD, lo * RAD, 0))));
    };
    const fromCenter = (t, d) => Math.max(0, Math.acos(clamp(dot(norm(sub(t.ground, cam.pos)), cam.dir), -1, 1)) - Math.atan(t.width * 0.71 / d));
    const want = (t, d) => {
      t.wanted = fframe; t.wantedAt = now; t.pri = fromCenter(t, d);
      if (t.state === 'failed' && now - t.failedAt > 15000) t.state = 'none';
      if (t.state === 'none') queue.push(t);
    };
    const loadedCover = (t, depth) => {
      if (t.state === 'ready') return true;
      if (!depth || !t.kids) return false;
      return t.kids.every(c => !visible(c) || loadedCover(c, depth - 1));
    };
    const visit = t => {
      t.vis = visible(t); t.refine = false;
      if (!t.vis) return true;
      const d = dist(t);
      if (t.z < FLY.min) {
        t.refine = t.width / 2 ** (FLY.min - t.z) * k / d >= SHOW_PX;
        if (t.refine) for (const c of t.children()) visit(c);
        return true;
      }
      const px = t.width * k / d;
      if (t.z === FLY.min && px < SHOW_PX) { t.vis = false; return true; }
      const settledEmpty = t.state === 'empty' || t.state === 'failed';
      t.refine = t.z < FLY.max && px > FLY_REFINE_PX && !settledEmpty;
      if (!t.refine) want(t, d);
      let kidsCov = true;
      if (t.refine) for (const c of t.children()) kidsCov = visit(c) && kidsCov;
      t.kidsCov = kidsCov;
      t.descCov = !t.refine && t.state !== 'ready' && loadedCover(t, 3);
      t.cov = (t.refine && kidsCov) || t.state === 'ready' || t.descCov;
      return t.cov;
    };
    const show = (t, mask) => { t.used = fframe; t.usedAt = now; out.push({ t, mask }); };
    const drawLoaded = (t, depth = 3) => {
      if (t.state === 'ready') show(t, 0);
      else if (depth > 0 && t.kids) t.kids.forEach(c => { if (visible(c)) drawLoaded(c, depth - 1); });
    };
    const draw = t => {
      if (!t.vis) return;
      const kids = t.refine ? t.children() : [];
      if (t.z < FLY.min || t.refine && t.kidsCov) { kids.forEach(draw); return; }
      if (!t.refine && t.state !== 'ready') { drawLoaded(t); return; }
      if (t.refine && t.state === 'ready') {
        let mask = 0;
        kids.forEach((c, i) => { if (c.vis && !c.cov) mask |= 1 << i; });
        if (mask === 15 || mask === 6 || mask === 9) { show(t, 0); return; }
        show(t, mask);
      } else if (t.state === 'ready') { show(t, 0); return; }
      kids.forEach(c => { if (c.vis && (c.cov || t.state !== 'ready')) draw(c); });
    };
    const far = Math.max(80000, 6000 * k / SHOW_PX * 4);
    for (const r of flyRoots) {
      if (len(sub(r.ground, cam.pos)) - r.width > far) { r.vis = false; continue; }
      visit(r); draw(r);
    }
  }
  queue.sort((a, b) => a.pri - b.pri);
  for (const t of queue) { if (flyActive >= FLY_ACTIVE) break; flyLoad(t); }
  // 読みかけは、しばらく（4 秒）要らなかったら取りやめる（回している間に取りやめると、戻ったときに初めからになる）
  for (const t of flyLoading) if (now - t.wantedAt > 4000 && t.abort) t.abort.abort();
  // 捨てる: 描かなくなって KEEP_MS たったものと、MAX_MODELS を超えた分。止まっていると描かないので、残したものは
  // KEEP_MS たったら選び直して捨てる
  const idle = [];
  const walk = t => { if (t.model && t.used !== fframe) idle.push(t); if (t.kids) t.kids.forEach(walk); };
  flyRoots.forEach(walk);
  idle.sort((a, b) => a.usedAt - b.usedAt);
  idle.forEach((t, i) => { if (now - t.usedAt >= KEEP_MS || flyModels - i > MAX_MODELS) flyUnload(t); });
  if (flyModels > out.length && !evictTimer) evictTimer = setTimeout(() => { evictTimer = 0; selStale = dirty = true; }, KEEP_MS + 50);
  return out;
}
// GPU に載せる（1 コマに UPLOADS_PER_FRAME まで。見えているもの・中央に近いものから）。しばらく要らなかったものは捨てる。
// 選び直さないコマでも、描くたびに進める
function flyUploads() {
  const now = performance.now();
  for (let i = uploads.length - 1; i >= 0; i--) {
    const u = uploads[i];
    if (now - u.t.wantedAt > 4000) {
      uploads.splice(i, 1);
      dropFrames(u.frames); u.images.forEach(b => b && b.close && b.close());
      u.t.state = 'none';
    }
  }
  if (!uploads.length) return;
  uploads.sort((a, b) => ((a.t.wanted === fframe ? 0 : 1e9) + a.t.pri) - ((b.t.wanted === fframe ? 0 : 1e9) + b.t.pri));
  for (const u of uploads.splice(0, UPLOADS_PER_FRAME)) upload(u);
  selStale = true;
  if (uploads.length) dirty = true;
}

// ---------------------------------------------------------------- 描く

// 目に見える範囲。W, H は描く画素、cssH は CSS の高さ（Flyover の細かさは CSS px で決める）
function viewProj(W, H, wide = 1) {
  const aspect = W / H, f = 1 / Math.tan(fovy(aspect) / 2) / wide;
  const near = clamp(geodetic(cam.pos)[2] * 0.001, 0.5, 1000);
  // reversed-Z の無限遠の透視投影（深度は手前 1、無限遠 0）
  const P = new Float64Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, 0, -1, 0, 0, near, 0]);
  const r = norm(cross(cam.dir, cam.up)), u = cam.up, d = cam.dir;
  const V = new Float64Array([r[0], u[0], -d[0], 0, r[1], u[1], -d[1], 0, r[2], u[2], -d[2], 0, 0, 0, 0, 1]);
  return { vp: mat4mul(P, V), near };
}
// 選んで、1 回分の描く中身（uniform を書き、描く関数を返す）
// タイル選びは毎コマやらない。視野を SEL_WIDE 倍に広げて選んでおき、カメラがその余白の中で動いている間は前の結果を
// 使う。選び直すのは、余白を出たとき、地面までの距離が SEL_DIST より変わったとき（細かさが変わる）、画面の大きさや
// 2D/3D が変わったとき、タイルが届いて SEL_SOFT_MS たったとき、前に選んでから SEL_MAX_MS たったとき（読みかけの
// 取りやめと、使わなくなったものを捨てるのを進める）。?reuse=0 で毎コマ選ぶ
const SEL_WIDE = 1.2, SEL_DIST = 0.05, SEL_SOFT_MS = 100, SEL_MAX_MS = 500, REUSE = params.get('reuse') !== '0';
let sel = null, selCount = 0, selMs = 0, selSplit = [0, 0], upMs = 0;
const angle = (a, b) => Math.acos(clamp(dot(a, b), -1, 1));
function groundDist() {
  const [lat, lon, h] = geodetic(cam.pos), g = heightAt(lat / RAD, lon / RAD);
  return Math.max(10, h - (g === undefined ? 0 : g));
}
function mustSelect(W, H, cssH, now) {
  if (!REUSE || !sel || sel.W !== W || sel.H !== H || sel.cssH !== cssH || sel.mode2D !== GE.mode2D) return true;
  const age = now - sel.at;
  if (age >= SEL_MAX_MS || (selStale && age >= SEL_SOFT_MS)) return true;
  const d = groundDist();
  if (Math.abs(d / sel.dist - 1) > SEL_DIST) return true;
  // 向きの変わり（見る向き + 傾き）と、動いた距離を地面までの距離で割ったもの（近くのものが見える向きの変わり）
  return angle(sel.dir, cam.dir) + angle(sel.up, cam.up) + len(sub(cam.pos, sel.pos)) / Math.min(d, sel.dist) > sel.margin;
}
function prepare(W, H, cssH, force = false) {
  const { vp, near } = viewProj(W, H);
  const t0 = performance.now();
  if (force || mustSelect(W, H, cssH, t0)) {
    const aspect = W / H, h = Math.tan(fovy(aspect) / 2);
    const wvp = viewProj(W, H, SEL_WIDE).vp;
    const list = selectGround(wvp, H, aspect);
    const t1 = performance.now();
    const fly = selectFlyover(frustumPlanes(wvp), cssH, aspect);
    selSplit = [t1 - t0, performance.now() - t1];
    // 余白の角度（縦と横の狭いほう）
    const margin = Math.min(Math.atan(h * SEL_WIDE) - Math.atan(h), Math.atan(h * aspect * SEL_WIDE) - Math.atan(h * aspect));
    sel = { list, fly, W, H, cssH, mode2D: GE.mode2D, at: t0, pos: cam.pos.slice(), dir: cam.dir.slice(), up: cam.up.slice(),
      dist: groundDist(), margin };
    selStale = false; selCount++;
    selMs = performance.now() - t0;
  }
  const t2 = performance.now();
  flyUploads();
  if (groundUploads.length) {
    for (const u of groundUploads.splice(0, GROUND_UPLOADS_PER_FRAME)) groundUpload(u);
    selStale = true; dirty = true;
  }
  flushUploads();
  upMs = performance.now() - t2;
  const { list, fly } = sel;
  const n = Math.min(list.length, MAX_DRAW), nf = Math.min(fly.length, MAX_DRAW - n);
  const putMvp = (i, o) => {
    const b = i * U_STRIDE / 4, m = uniformData.subarray(b, b + 16);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) m[c * 4 + r] = vp[c * 4 + r];
    for (let r = 0; r < 4; r++) m[12 + r] = vp[r] * o[0] + vp[4 + r] * o[1] + vp[8 + r] * o[2] + vp[12 + r];
    return b;
  };
  for (let i = 0; i < n; i++) { const o = sub(list[i].t.meshCenter, cam.pos), b = putMvp(i, o); uniformData.set(o, b + 16); uniformData.set(list[i].rect, b + 20); }
  for (let j = 0; j < nf; j++) {
    const { t, mask } = fly[j], md = t.model, o = sub(md.center, cam.pos), b = putMvp(n + j, o);
    uniformData.set([md.step, mask, 0, 0, ...t.east, 0, ...t.north, 0, ...md.off, 0, ...o, 0, ...t.sun0], b + 16);
  }
  if (n + nf) device.queue.writeBuffer(uniformBuffer, 0, uniformData, 0, (n + nf) * U_STRIDE / 4);
  // pass に描く。pipes: パイプラインの組、group: 画面ごとの値、sky: 空、opaque: 地面と建物、splats: 木（重みつきでためる）
  const encode = (pass, pipes, group, { sky = true, opaque = true, splats = false } = {}) => {
    pass.setBindGroup(0, emptyGroup);
    pass.setBindGroup(1, group);
    if (sky) { pass.setPipeline(pipes.sky); pass.draw(3); }
    pass.setStencilReference(1);
    for (const fb of opaque ? [false, true] : []) {
      pass.setPipeline(fb ? pipes.groundFb : pipes.ground);
      for (let i = 0; i < n; i++) {
        const e = list[i];
        if (e.fallback !== fb) continue;
        pass.setBindGroup(0, e.t.bind, [i * U_STRIDE]);
        pass.setVertexBuffer(0, e.t.vbuf);
        if (e.t.cap) { pass.setIndexBuffer(e.t.ibuf, 'uint16'); pass.drawIndexed(e.t.count); }
        else { pass.setIndexBuffer(indexBuffer, 'uint16'); pass.drawIndexed(indices.length); }
      }
    }
    for (const splat of [...(opaque ? [false] : []), ...(splats ? [true] : [])]) {
      for (let j = 0; j < nf; j++) {
        const md = fly[j].t.model;
        for (const p of md.prims) {
          if (p.splat !== splat) continue;
          pass.setPipeline(splat ? pipes.splat : p.yuv ? (p.uvFloat ? pipes.yuvF32 : pipes.yuvU16) : p.uvFloat ? pipes.meshF32 : pipes.meshU16);
          pass.setBindGroup(0, p.bind, [(n + j) * U_STRIDE]);
          pass.setVertexBuffer(0, md.buf, p.pos.offset);
          if (splat) {
            pass.setVertexBuffer(1, md.buf, p.col.offset);
            pass.setVertexBuffer(2, md.buf, p.uv.offset);
            pass.draw(p.count);
          } else {
            pass.setVertexBuffer(1, md.buf, p.uv.offset);
            pass.setIndexBuffer(md.buf, p.ix32 ? 'uint32' : 'uint16', p.ix.offset);
            pass.drawIndexed(p.ix.count);
          }
        }
      }
    }
  };
  return { vp, near, n, nf, encode };
}

// 画面の描画用のテクスチャ
// 動かしている間は MSAA を使わず 1 倍で描く（GPU の時間が 2〜4 ms 減る）。カメラが止まって STILL_MS たったら、
// 4 倍で描き直す（止まった画面は今までどおり）
const STILL_MS = 150;
let msaaTex = null, depthTex = null, depth1Tex = null, W = 0, H = 0;
let oitMain = null;        // 木をためるテクスチャ（resize で作る）
let lastCam = '', movedAt = -Infinity, stillTimer = 0;
function resize() {
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (w === W && h === H) return;
  W = canvas.width = w; H = canvas.height = h;
  if (msaaTex) msaaTex.destroy();
  if (depthTex) depthTex.destroy();
  if (depth1Tex) depth1Tex.destroy();
  depth1Tex = SAMPLES > 1 ? device.createTexture({ size: [W, H], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
  msaaTex = SAMPLES > 1 ? device.createTexture({ size: [W, H], format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
  depthTex = device.createTexture({ size: [W, H], format: DEPTH, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  if (oitMain) oitMain.destroy();
  oitMain = oitTextures(W, H, SAMPLES);
  dirty = true;
}
// 木をためるテクスチャ: 1 倍のもの（重ねるときに読む）と、MSAA のもの（samples > 1 のとき。1 倍に解決する）
function oitTextures(w, h, samples) {
  const mk = (fmt, n) => device.createTexture({ size: [w, h], format: fmt, sampleCount: n,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | (n === 1 ? GPUTextureUsage.TEXTURE_BINDING : 0) });
  const o = { accum: mk('rgba16float', 1), reveal: mk('r16float', 1) };
  if (samples > 1) { o.accumMS = mk('rgba16float', samples); o.revealMS = mk('r16float', samples); }
  o.bind = device.createBindGroup({ layout: oitPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: o.accum.createView() }, { binding: 1, resource: o.reveal.createView() }] });
  o.destroy = () => [o.accum, o.reveal, o.accumMS, o.revealMS].forEach(t => t && t.destroy());
  return o;
}
// 1 回分を描く: 空・地面・建物 → 木を重みつきでためる → 木を重ねる。
// t: { pipes, color, resolve（MSAA のとき画面）, depth, oit, ms（MSAA で描くか）, out（できあがりを書く所） }
function drawScene(enc, frame, t, timestamps) {
  const p1 = enc.beginRenderPass({
    colorAttachments: [{ view: t.color, resolveTarget: t.resolve, loadOp: 'clear', storeOp: t.resolve ? 'discard' : 'store',
      clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: t.depth, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0,
      stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 },
    timestampWrites: timestamps ? { querySet: timestamps, beginningOfPassWriteIndex: 0 } : undefined,
  });
  frame.encode(p1, t.pipes, groupMain);
  p1.end();
  const o = t.oit, ms = t.ms;
  const p2 = enc.beginRenderPass({
    colorAttachments: [
      { view: (ms ? o.accumMS : o.accum).createView(), resolveTarget: ms ? o.accum.createView() : undefined,
        loadOp: 'clear', storeOp: ms ? 'discard' : 'store', clearValue: [0, 0, 0, 1] },
      { view: (ms ? o.revealMS : o.reveal).createView(), resolveTarget: ms ? o.reveal.createView() : undefined,
        loadOp: 'clear', storeOp: ms ? 'discard' : 'store', clearValue: [0, 0, 0, 0] }],
    depthStencilAttachment: { view: t.depth, depthReadOnly: true, stencilReadOnly: true },
  });
  frame.encode(p2, t.pipes, groupMain, { sky: false, opaque: false, splats: true });
  p2.end();
  const p3 = enc.beginRenderPass({ colorAttachments: [{ view: t.out, loadOp: 'load', storeOp: 'store' }],
    timestampWrites: timestamps ? { querySet: timestamps, endOfPassWriteIndex: 1 } : undefined });
  p3.setPipeline(oitPipe); p3.setBindGroup(0, o.bind); p3.draw(3);
  p3.end();
}

// GPU の描画時間（timestamp-query）
let gpuMs = NaN;
const query = timing && {
  set: device.createQuerySet({ type: 'timestamp', count: 2 }),
  resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
  read: [0, 1, 2].map(() => ({ buf: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false })),
};

// カーソルの下の点（建物も含める）: その 1 画素だけを 1 x 1 の的に描き直し（pickM で画面全体に広げる）、深度をバッファに
// 写して、GPU を待たずに届いたら使う。depth32float-stencil8 でないと深度を写せないので、そのときは地形だけ
const canPick = stencil32;
const pickColor = device.createTexture({ size: [1, 1], format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
const pickDepth = device.createTexture({ size: [1, 1], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT | (canPick ? GPUTextureUsage.COPY_SRC : 0) });
const pickBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
let pickReq = null, pickBusy = false;
function rayAt(x, y, Wc, Hc) {         // CSS px
  const aspect = Wc / Hc, t = Math.tan(fovy(aspect) / 2);
  const nx = x / Wc * 2 - 1, ny = 1 - y / Hc * 2;
  const r = norm(cross(cam.dir, cam.up));
  return norm(add(add(cam.dir, mul(r, nx * t * aspect)), mul(cam.up, ny * t)));
}
// 地形だけの点（CPU で。地形の高さで、楕円体をふくらませて当て直す）
function pickTerrain(x, y) {
  const o = cam.pos, d = rayAt(x, y, canvas.clientWidth, canvas.clientHeight);
  let p = hitEllipsoid(o, d, 0);
  if (!p) return null;
  for (let i = 0; i < 4; i++) {
    const [lat, lon] = geodetic(p);
    const h = heightAt(lat / RAD, lon / RAD);
    if (h === undefined) break;
    const q = hitEllipsoid(o, d, h);
    if (!q) break;
    p = q;
  }
  return p;
}
function encodePick(enc, frame) {
  const { x, y } = pickReq.req, dpr = devicePixelRatio || 1;
  const nx = (2 * (x * dpr + 0.5)) / W - 1, ny = 1 - (2 * (y * dpr + 0.5)) / H;
  const PM = new Float64Array([W, 0, 0, 0, 0, H, 0, 0, 0, 0, 1, 0, -nx * W, -ny * H, 0, 1]);
  device.queue.writeBuffer(framePick, 0, frameData(frame.vp, PM));
  const pass = enc.beginRenderPass({
    colorAttachments: [{ view: pickColor.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] }],
    depthStencilAttachment: { view: pickDepth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0,
      stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0 },
  });
  frame.encode(pass, pipesOne, groupPick, { sky: false });
  pass.end();
  enc.copyTextureToBuffer({ texture: pickDepth, aspect: 'depth-only' }, { buffer: pickBuf, bytesPerRow: 256 }, [1, 1]);
}
function finishPick(frame) {
  const r = pickReq; pickReq = null; pickBusy = true;
  const { x, y } = r.req, d = rayAt(x, y, canvas.clientWidth, canvas.clientHeight), pos = cam.pos.slice(), fwd = cam.dir.slice();
  pickBuf.mapAsync(GPUMapMode.READ).then(() => {
    const z = new Float32Array(pickBuf.getMappedRange(0, 4))[0];
    pickBuf.unmap(); pickBusy = false;
    let out = null;
    if (z > 0) {
      const dist = frame.near / z / dot(d, fwd);
      out = { p: add(pos, mul(d, dist)), onGlobe: false };
      const tp = pickTerrain(x, y);
      if (tp && len(sub(tp, pos)) <= dist + 0.5) out = { p: tp, onGlobe: true };
    } else {
      const tp = pickTerrain(x, y);
      out = tp ? { p: tp, onGlobe: true } : null;
    }
    lastPick = { x, y, at: performance.now(), r: out };
    r.resolve(out);
    if (pickReq) dirty = true;
  }, () => { pickBusy = false; r.resolve(null); });
}
let lastPick = null;
// 建物も含めたカーソルの下の点を、次に描くときに探す（Promise）
function pickAsync(x, y) {
  if (!canPick) { const p = pickTerrain(x, y); return Promise.resolve(p ? { p, onGlobe: true } : null); }
  return new Promise(resolve => {
    if (pickReq) pickReq.resolve(null);
    pickReq = { req: { x, y }, resolve };
    dirty = true;
  });
}

// 画面に描く
let stats = { draw: 0, fly: 0 }, cpuMs = 0;
function render() {
  const t0 = performance.now();
  resize();
  const frame = prepare(W, H, canvas.clientHeight);
  device.queue.writeBuffer(frameMain, 0, frameData(frame.vp));
  const now = performance.now(), key = cam.pos.join() + cam.dir.join() + cam.up.join();
  if (key !== lastCam) { lastCam = key; movedAt = now; }
  const fast = SAMPLES > 1 && now - movedAt < STILL_MS;
  if (fast) { clearTimeout(stillTimer); stillTimer = setTimeout(() => { dirty = true; }, STILL_MS + 10); }
  const ms = fast ? null : msaaTex;
  const enc = device.createCommandEncoder();
  const target = ctx.getCurrentTexture().createView();
  drawScene(enc, frame, { pipes: fast ? pipesOne : pipesMain, color: ms ? ms.createView() : target, resolve: ms ? target : undefined,
    depth: (fast ? depth1Tex : depthTex).createView(), oit: oitMain, ms: !!ms, out: target }, query && query.set);
  const picking = pickReq && !pickBusy && canPick;
  if (picking) encodePick(enc, frame);
  let rb = null;
  if (query) {
    enc.resolveQuerySet(query.set, 0, 2, query.resolve, 0);
    rb = query.read.find(r => !r.busy);
    if (rb) enc.copyBufferToBuffer(query.resolve, 0, rb.buf, 0, 16);
  }
  device.queue.submit([enc.finish()]);
  if (picking) finishPick(frame);
  if (rb) {
    rb.busy = true;
    rb.buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigUint64Array(rb.buf.getMappedRange());
      gpuMs = Number(t[1] - t[0]) / 1e6;
      rb.buf.unmap(); rb.busy = false;
    }, () => { rb.busy = false; });
  }
  stats = { msaa: fast ? 1 : SAMPLES, draw: frame.n, fly: frame.nf, selMs, selCount, selGround: selSplit[0], selFly: selSplit[1], upMs };
  cpuMs = performance.now() - t0;
  rendered++;
}

// スクリーンショット: 画面とは別に、W x H（アンチエイリアスなし。4K を 4 倍で描くと GPU のメモリが足りなくなる）に描いて
// 読み戻す。タイルの細かさは写す大きさに合わせ、読み終えて落ち着くまで待つ（最大 90 秒）
let shooting = null;
async function shot(SW, SH) {
  const lim = device.limits.maxTextureDimension2D, f = Math.min(1, lim / Math.max(SW, SH));
  SW = Math.round(SW * f); SH = Math.round(SH * f);
  const color = device.createTexture({ size: [SW, SH], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [SW, SH], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const dpr = devicePixelRatio || 1;
  let oit = null;
  shooting = { SW, SH, cssH: SH / dpr };
  try {
    const t0 = performance.now();
    let calm = 0;
    while (performance.now() - t0 < 90000) {
      prepare(SW, SH, SH / dpr, true);       // 選んで読む（描かない）
      calm = active === 0 && flyActive === 0 && uploads.length === 0 ? calm + 1 : 0;
      if (calm >= 10 && performance.now() - t0 > 500) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const frame = prepare(SW, SH, SH / dpr, true);
    device.queue.writeBuffer(frameMain, 0, frameData(frame.vp));
    const enc = device.createCommandEncoder();
    oit = oitTextures(SW, SH, 1);
    const view = color.createView();
    drawScene(enc, frame, { pipes: pipesOne, color: view, depth: depth.createView(), oit, ms: false, out: view });
    const bpr = Math.ceil(SW * 4 / 256) * 256;
    const buf = device.createBuffer({ size: bpr * SH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: color }, { buffer: buf, bytesPerRow: bpr }, [SW, SH]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), img = new ImageData(SW, SH), bgra = format === 'bgra8unorm';
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const s = y * bpr + x * 4, d = (y * SW + x) * 4;
        img.data[d] = src[s + (bgra ? 2 : 0)]; img.data[d + 1] = src[s + 1]; img.data[d + 2] = src[s + (bgra ? 0 : 2)]; img.data[d + 3] = 255;
      }
    }
    buf.unmap(); buf.destroy();
    const c = document.createElement('canvas');
    c.width = SW; c.height = SH;
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  } finally {
    color.destroy(); depth.destroy(); if (oit) oit.destroy();
    shooting = null; sel = null; dirty = true;
  }
}

// ---------------------------------------------------------------- 毎コマ

// 動き（操作や読み込み）があるときだけ描く。読み込みだけが進んでいるときは 100 ms ごとに間引く（毎コマ描くと GPU が
// 埋まり、HEVC の展開が進まない）
let last = performance.now(), lastLoadFrame = 0, rendered = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const busy = GE.beforeFrame ? GE.beforeFrame(dt) : false;
  const loading = active > 0 || flyActive > 0 || uploads.length > 0;
  if (!shooting && (dirty || busy || (loading && now - lastLoadFrame > 100))) {
    dirty = false;
    if (loading) lastLoadFrame = now;
    try { render(); } catch (e) { console.error(e); }
  }
  requestAnimationFrame(tick);
}

Object.assign(GE, {
  cfg, cam, setView, fovy, geoid, heightAt, pickTerrain, pickAsync, canvas, rayAt,
  lastPick: () => lastPick, capturedOf, capturedKnown, z20Key, shot,
  redraw: () => { dirty = true; }, rendered: () => rendered,
  look: () => look, setLook: name => { look = name; try { localStorage.setItem('look', name); } catch (e) { /* */ } dirty = true; },
  atmosphere: ATMOSPHERE, mode2D: false,
  pending: () => active + flyActive + uploads.length + groundUploads.length, shooting: () => !!shooting,
  stats: () => ({ gpuMs, cpuMs, ...stats, groundTiles: loadedCount, flyModels, flyActive, uploads: uploads.length, groundUploads: groundUploads.length, upSubmits, active,
    memMB: { ground: mem.ground / 1048576, fly: mem.fly / 1048576 }, hevc, bc: BC }),
});
requestAnimationFrame(tick);
return GE;
})();
