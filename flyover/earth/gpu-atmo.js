// Copyright (c) 2017 Eric Bruneton. All rights reserved.
// このファイルは Bruneton の precomputed_atmospheric_scattering を元にしているので、そのライセンス
// （BSD 3-Clause。全文は atmosphere/LICENSE）に従う。
//
// WebGPU 版のビューア（gpu.html）の空と大気。atmosphere/functions.glsl の、画面で使う関数（GetSkyRadiance・
// GetSkyRadianceToPoint とその下の関数）を WGSL に書き直したもの。前もって計算する表（透けぐあいと散乱のテクスチャ）は
// 今のビューアと同じワーカー（atmosphere.js。WebGL2 で計算する）のものを使う。大気の値は atmosphere.js の header と同じ
// （長さは km、3 波長 680・550・440 nm、散乱のテクスチャはミー散乱を 1 つにまとめた形）
'use strict';
// haze: 空気中のちり（ミー散乱）の量の倍率。返すのは WGSL（画面の値 fr と、atmoApply などの関数）
function gpuAtmoWGSL(haze) {
  const um = [0.68, 0.55, 0.44];
  const rayleigh = um.map(l => 1.24062e-6 * Math.pow(l, -4) * 1000);
  const mie = 5.328e-3 / 1200 * 1000 * haze;
  const v = a => `vec3f(${a.map(x => x.toExponential(8)).join(', ')})`;
  return /* wgsl */`
const PI = 3.14159265358979;
const BOTTOM = 6360.0;
const TOP = 6420.0;
const SUN_R = ${(0.00935 / 2).toExponential(8)};
const MU_S_MIN = ${Math.cos(102 / 180 * Math.PI).toExponential(8)};
const MIE_G = 0.8;
const RAY = ${v(rayleigh)};
const MIE = ${v(rayleigh.map(() => mie * 0.9))};
const SOLAR = ${v([1.474, 1.8504, 1.91198])};
// 画面ごとの値。cam0: 大気の座標（km）でのカメラと、w に大気の使い方（0 なし、1 空だけ、2 空とかすみ）。
// sun: 太陽の向き（地球の座標の軸）。balance: 空とかすみに掛ける色と、w に明るさ。aerial: かすみの倍率（遠く、近く、
// 目安の距離 km）と、w に灰色に寄せる割合。invVP: 画面からカメラを原点にした向きへ。pickM: カーソルの下の点を
// 探すときに 1 画素を画面全体に広げる行列（ふだんは単位行列）。camPos: カメラの位置（季節の色の模様用）。
// lsun・lsky: ?light= の太陽の光と空の光（gpu-render.js の lightNow）
struct Frame { cam0: vec4f, sun: vec4f, balance: vec4f, aerial: vec4f, invVP: mat4x4f, pickM: mat4x4f, camPos: vec4f,
  lsun: vec4f, lsky: vec4f };
@group(1) @binding(0) var<uniform> fr: Frame;
@group(1) @binding(1) var atmoSamp: sampler;
@group(1) @binding(2) var transTex: texture_2d<f32>;
@group(1) @binding(3) var scatTex: texture_3d<f32>;
fn safeSqrt(a: f32) -> f32 { return sqrt(max(a, 0.0)); }
fn distToTop(r: f32, mu: f32) -> f32 { return max(-r * mu + safeSqrt(r * r * (mu * mu - 1.0) + TOP * TOP), 0.0); }
fn hitsGround(r: f32, mu: f32) -> bool { return mu < 0.0 && r * r * (mu * mu - 1.0) + BOTTOM * BOTTOM >= 0.0; }
fn texCoord(x: f32, n: f32) -> f32 { return 0.5 / n + x * (1.0 - 1.0 / n); }
fn transToTop(r: f32, mu: f32) -> vec3f {
  let H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  let rho = safeSqrt(r * r - BOTTOM * BOTTOM);
  let d = distToTop(r, mu);
  let dmin = TOP - r;
  let dmax = rho + H;
  let uv = vec2f(texCoord((d - dmin) / (dmax - dmin), 256.0), texCoord(rho / H, 64.0));
  return textureSampleLevel(transTex, atmoSamp, uv, 0.0).rgb;
}
fn transmittance(r: f32, mu: f32, d: f32, ground: bool) -> vec3f {
  let rd = clamp(sqrt(d * d + 2.0 * r * mu * d + r * r), BOTTOM, TOP);
  let mud = clamp((r * mu + d) / rd, -1.0, 1.0);
  if (ground) { return min(transToTop(rd, -mud) / transToTop(r, -mu), vec3f(1.0)); }
  return min(transToTop(r, mu) / transToTop(rd, mud), vec3f(1.0));
}
fn scatUvwz(r: f32, mu: f32, mus: f32, nu: f32, ground: bool) -> vec4f {
  let H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  let rho = safeSqrt(r * r - BOTTOM * BOTTOM);
  let ur = texCoord(rho / H, 32.0);
  let rmu = r * mu;
  let disc = rmu * rmu - r * r + BOTTOM * BOTTOM;
  var umu: f32;
  if (ground) {
    let d = -rmu - safeSqrt(disc);
    let dmin = r - BOTTOM;
    let dmax = rho;
    var x = 0.0;
    if (dmax != dmin) { x = (d - dmin) / (dmax - dmin); }
    umu = 0.5 - 0.5 * texCoord(x, 64.0);
  } else {
    let d = -rmu + safeSqrt(disc + H * H);
    let dmin = TOP - r;
    let dmax = rho + H;
    umu = 0.5 + 0.5 * texCoord((d - dmin) / (dmax - dmin), 64.0);
  }
  let ds = distToTop(BOTTOM, mus);
  let smin = TOP - BOTTOM;
  let a = (ds - smin) / (H - smin);
  let A = (distToTop(BOTTOM, MU_S_MIN) - smin) / (H - smin);
  let umus = texCoord(max(1.0 - a / A, 0.0) / (1.0 + a), 32.0);
  return vec4f((nu + 1.0) / 2.0, umus, umu, ur);
}
fn combined(r: f32, mu: f32, mus: f32, nu: f32, ground: bool) -> vec4f {
  let u = scatUvwz(r, mu, mus, nu, ground);
  let tx = u.x * 7.0;
  let x0 = floor(tx);
  let l = tx - x0;
  let a = textureSampleLevel(scatTex, atmoSamp, vec3f((x0 + u.y) / 8.0, u.z, u.w), 0.0);
  let b = textureSampleLevel(scatTex, atmoSamp, vec3f((x0 + 1.0 + u.y) / 8.0, u.z, u.w), 0.0);
  return a * (1.0 - l) + b * l;
}
fn extrapolatedMie(c: vec4f) -> vec3f {
  if (c.r <= 0.0) { return vec3f(0.0); }
  return c.rgb * c.a / c.r * (RAY.r / MIE.r) * (MIE / RAY);
}
fn rayleighPhase(nu: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + nu * nu); }
fn miePhase(g: f32, nu: f32) -> f32 {
  let k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + nu * nu) / pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}
struct Rad { l: vec3f, t: vec3f };
fn skyRadiance(cam: vec3f, v: vec3f, sun: vec3f) -> Rad {
  var c = cam;
  var r = length(c);
  var rmu = dot(c, v);
  let dtop = -rmu - sqrt(rmu * rmu - r * r + TOP * TOP);
  if (dtop > 0.0) { c = c + v * dtop; r = TOP; rmu = rmu + dtop; }
  else if (r > TOP) { return Rad(vec3f(0.0), vec3f(1.0)); }
  let mu = rmu / r;
  let mus = dot(c, sun) / r;
  let nu = dot(v, sun);
  let g = hitsGround(r, mu);
  var t = vec3f(0.0);
  if (!g) { t = transToTop(r, mu); }
  let cs = combined(r, mu, mus, nu, g);
  return Rad(cs.rgb * rayleighPhase(nu) + extrapolatedMie(cs) * miePhase(MIE_G, nu), t);
}
fn skyToPoint(cam: vec3f, point: vec3f, sun: vec3f) -> Rad {
  let v = normalize(point - cam);
  var c = cam;
  var r = length(c);
  var rmu = dot(c, v);
  let dtop = -rmu - sqrt(rmu * rmu - r * r + TOP * TOP);
  if (dtop > 0.0) { c = c + v * dtop; r = TOP; rmu = rmu + dtop; }
  let mu = rmu / r;
  let mus = dot(c, sun) / r;
  let nu = dot(v, sun);
  let d = length(point - c);
  let g = hitsGround(r, mu);
  let t = transmittance(r, mu, d, g);
  let cs = combined(r, mu, mus, nu, g);
  let rp = clamp(sqrt(d * d + 2.0 * r * mu * d + r * r), BOTTOM, TOP);
  let csp = combined(rp, (r * mu + d) / rp, (r * mus + d * nu) / rp, nu, g);
  let s = cs.rgb - t * csp.rgb;
  let m = extrapolatedMie(cs) - t * extrapolatedMie(csp);
  let mie = extrapolatedMie(vec4f(s, m.r)) * smoothstep(0.0, 0.01, mus);
  return Rad(s * rayleighPhase(nu) + mie * miePhase(MIE_G, nu), t);
}
`;
}

// 大気の表を使う、このビューアの見た目の部分（明るさの曲線、かすみのかけ方、空）。Bruneton のコードではない
function gpuLookWGSL(aces) {
  return /* wgsl */`
// 明るさの曲線（光の量 → 画面の線形の値）と、その逆。aces は ACES の近似（Narkowicz）、ほかは 1 - exp(-x)
fn tone(x: vec3f) -> vec3f {
  ${aces ? 'return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));'
         : 'return 1.0 - exp(-x);'}
}
fn untone(y0: vec3f) -> vec3f {
  ${aces ? `let y = min(y0, vec3f(0.999));
  let a = y * 2.43 - 2.51;
  let b = y * 0.59 - 0.03;
  let c = y * 0.14;
  return (-b - sqrt(max(b * b - 4.0 * a * c, vec3f(0.0)))) / (2.0 * a);`
         : 'return -log(max(1.0 - y0, vec3f(1e-4)));'}
}
// カメラから rel [m] の所までのかすみ（透けぐあい t と、足す空気の光 s）。頂点で計算して、画素の間は補間する
// （かすみは距離でなめらかに変わる。画素ごとに計算すると、重なったスプラットの分まで計算して重い）
struct Aer { t: vec3f, s: vec3f };
fn aerialAt(rel: vec3f) -> Aer {
  if (fr.cam0.w < 1.5) { return Aer(vec3f(1.0), vec3f(0.0)); }
  let dist = max(length(rel), 0.01);
  let rr = skyToPoint(fr.cam0.xyz, fr.cam0.xyz + rel / 1000.0, fr.sun.xyz);
  let a = fr.aerial.x * (1.0 + (fr.aerial.y - 1.0) * exp(-dist / 1000.0 / fr.aerial.z));
  // 空気の量を a 倍にしたときの透けぐあいと空気の光（光の足し方と色の薄れ方を同じ割合で変える。空気の光だけを
  // 減らすと、遠くが明るいかすみに溶けずに暗く沈む）
  let t = pow(rr.t, vec3f(a));
  let k = select(vec3f(a), (1.0 - t) / max(1.0 - rr.t, vec3f(1e-6)), rr.t < vec3f(0.9999));
  var S = rr.l * k * fr.balance.rgb;
  S = mix(S, vec3f(dot(S, vec3f(0.2126, 0.7152, 0.0722))), fr.aerial.w);
  return Aer(t, S * fr.balance.w);
}
// 写真の色 c（sRGB）にかすみをかける（今のビューアの後処理と同じ式）
fn atmoApply(c: vec3f, t: vec3f, s: vec3f) -> vec3f {
  if (fr.cam0.w < 1.5) { return c; }
  return pow(tone(untone(pow(c, vec3f(2.2))) * t + s), vec3f(1.0 / 2.2));
}
// 空。画面全体に最初に描く（奥行きは書かない）
struct SkyV { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsSky(@builtin(vertex_index) i: u32) -> SkyV {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: SkyV;
  o.pos = vec4f(p, 0.0, 1.0); o.ndc = p;
  return o;
}
@fragment fn fsSky(i: SkyV) -> @location(0) vec4f {
  if (fr.cam0.w < 0.5) { return vec4f(0.043, 0.102, 0.18, 1.0); }
  let q = fr.invVP * vec4f(i.ndc, 1.0, 1.0);
  let v = normalize(q.xyz / q.w);
  let rr = skyRadiance(fr.cam0.xyz, v, fr.sun.xyz);
  var L = rr.l;
  if (dot(v, fr.sun.xyz) > cos(SUN_R)) { L += rr.t * SOLAR / (PI * SUN_R * SUN_R); }
  let bal = select(vec3f(1.0), fr.balance.rgb, fr.cam0.w > 1.5);
  return vec4f(pow(tone(L * bal * fr.balance.w), vec3f(1.0 / 2.2)), 1.0);
}
`;
}
