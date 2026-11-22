// 空の雲（WebGPU 版のビューア）。takram の three-geospatial（@takram/three-clouds。three.js の後処理）の雲のシェーダーを
// WGSL に移したもの。https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds
// - 天気のテクスチャー（4 チャンネル = 4 つの雲の層。3 つを使う）を、地球を立方体に見立てた座標で貼る（1 面に 100 回）
// - 雲の形は、形のノイズ（128^3）と細部のノイズ（32^3）で、天気の濃さを削って作る。渦のノイズ（128^2）で少しゆがめる
// - 光は、太陽の方へ 2 歩だけ進んで数えた光の弱まりと、その先を影の地図（BSM: Beer Shadow Map。太陽から見た雲の
//   はじまりの距離、平均の濃さ、いちばん奥までの光の弱まり）から求めた弱まりを足し、何度も散らばる光を 8 段の近似で
//   （Oz の近似）。空の光と地面の照り返しも少し
// - ノイズのテクスチャーは起動時に計算シェーダーで作る（takram の手順と同じ。画像は読み込まない）
// 単位は km（takram は m）。大気（空の光、かすみ）はこのビューアの gpu-atmo.js の関数を使う。
// 描く仕組み（縦横 1/3 の画像に描き、カメラが止まっている間はコマを重ね、動いている間は前のコマをずらして混ぜ、空や
// 地面の手前に重ねる）は、このビューアのもの。takram と違う所:
// - 立方体の座標は、日本（北緯 36 度、東経 138 度）が面の真ん中に来るように回す（そのままだと立方体の角が日本の上に
//   あり、面の継ぎ目で雲の模様がずれる）
// - 影の地図は 1 枚（カメラのまわり 100 km 四方。takram は視野に合わせた 3 枚）
// - 霧と光芒は、空の分は雲の画像のパスで（空に重ねるときの隠れる割合に、光芒で減る空の光の割合を入れる）、地面や
//   建物の分はかすみの表で（cloudAerial）
//
// ---------------------------------------------------------------------------------------------------------------------
// The MIT License (MIT)
// Copyright (c) 2024 Shota Matsuda
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// ---------------------------------------------------------------------------------------------------------------------
// ノイズの一部（GPU_CLOUD_NOISE_WGSL）は、takram が元にした次のものを含む:
// - TileableVolumeNoise（https://github.com/sebh/TileableVolumeNoise）
//   The MIT License (MIT) Copyright (c) 2017 Sébastien Hillaire（条件は上と同じ）
// - GLM の周期つき Perlin ノイズ（https://github.com/g-truc/glm/blob/master/glm/gtc/noise.inl）
//   The MIT License Copyright (c) 2005 - G-Truc Creation（条件は上と同じ）
// ---------------------------------------------------------------------------------------------------------------------
'use strict';

// 日本が立方体の面の真ん中に来るように回す軸（東・北・上。地球の座標）
const CLOUD_FRAME = (() => {
  const la = 36 * Math.PI / 180, lo = 138 * Math.PI / 180;
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const e = [-Math.sin(lo), Math.cos(lo), 0];
  const n = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
  return { e, n, u };
})();

// coverage: 雲の量（takram の coverage。0〜1、既定 0.3）。返すのは WGSL: fns（関数と、雲の画像のバインディング。
// どのモジュールにも入れる）、sky（fsSky の中で、L に太陽まで足したあとに入れる文）、shadowCS（影の地図を作る
// 計算シェーダー）、genCS（ノイズを作る計算シェーダー）
function gpuCloudWGSL(coverage) {
  const v3 = a => `vec3f(${a.map(x => x.toFixed(6)).join(', ')})`;
  const fns = /* wgsl */`
// ---------------------------------------------------------------- 決まった値（takram の既定。長さは km）
const CL_COVERAGE = ${coverage.toFixed(4)};
// 雲の層: 0 低い雲（0.75〜1.4 km）、1 低い〜中くらいの雲（1.0〜2.2 km）、2 巻雲（7.5〜8.0 km）、3 なし
const CL_MIN_LAYER = vec4f(0.75, 1.0, 7.5, 0.0);
const CL_LAYER_H = vec4f(0.65, 1.2, 0.5, 1.0);
const CL_MASK = vec4f(1.0, 1.0, 1.0, 0.0);
const CL_SHADOW_MASK = vec4f(1.0, 1.0, 0.0, 0.0);   // 影の地図に入れる層
const CL_DENSITY_SCALE = vec4f(0.2, 0.2, 0.003, 0.0);
const CL_SHAPE_AMOUNT = vec4f(1.0, 1.0, 0.4, 0.0);
const CL_DETAIL_AMOUNT = vec4f(1.0, 1.0, 0.0, 0.0);
const CL_SHAPE_BIAS = vec4f(0.35);
const CL_FILTER_W = vec4f(0.6, 0.6, 0.5, 0.6);
const CL_MIN_H = 0.75;
const CL_MAX_H = 8.0;
const CL_SHADOW_TOP = 2.2;
const CL_SHADOW_BOTTOM = 0.75;
// 雲のない高さの帯（層と層の間）
const CL_GAP_MIN = vec2f(0.0, 2.2);
const CL_GAP_MAX = vec2f(0.75, 7.5);
const CL_SCATTER = 1000.0;           // 濃さ 1 のときの散らばり [1/km]（takram は 1/m）
const CL_WEATHER_REPEAT = 100.0;     // 天気のテクスチャーを、立方体の 1 面に何回
const CL_SHAPE_REPEAT = 0.3;         // [1/km]
const CL_DETAIL_REPEAT = 6.0;
const CL_TURB_REPEAT = 20.0;
const CL_TURB_DISP = 0.35;           // 渦でゆがめる量 [km]
const CL_MIN_DENSITY = 1e-4;
const CL_MIN_EXT = 0.1;              // [1/km]
const CL_MIN_T = 1e-2;
const CL_MAX_ITER = 200;
const CL_MIN_STEP = 0.1;             // [km]
const CL_MAX_STEP = 1.0;
const CL_MAX_RAY = 100.0;
const CL_STEP_SCALE = 1.01;
const CL_SUN_ITER = 2;
const CL_GROUND_ITER = 1;
const CL_SEC_STEP = 0.1;
const CL_SEC_SCALE = 2.0;
const CL_OCTAVES = 8;
const CL_SL_MAX = 100.0;          // 光芒を調べる距離の上限 [km]
// 影の地図（Beer Shadow Map）: 影の地図の真ん中（カメラの位置を 1 km ごとに丸めた点）のまわり、太陽に垂直な面の
// 2 x CL_BSM_R 四方
const CL_BSM_R = 50.0;
const CL_BSM_N = 512u;
const CL_E = ${v3(CLOUD_FRAME.e)};
const CL_N = ${v3(CLOUD_FRAME.n)};
const CL_U = ${v3(CLOUD_FRAME.u)};

@group(0) @binding(12) var clShape: texture_3d<f32>;
@group(0) @binding(13) var clDetail: texture_3d<f32>;
@group(0) @binding(14) var clSamp: sampler;
@group(0) @binding(15) var clTurb: texture_2d<f32>;
@group(0) @binding(21) var clWeather: texture_2d<f32>;
@group(1) @binding(6) var cloudShadowTex: texture_2d<f32>;

// x から a〜b を 0〜1 に（範囲の外は 0 か 1。a > b でもよい）
fn remapC(x: f32, a: f32, b: f32) -> f32 { return clamp((x - a) / (b - a), 0.0, 1.0); }
fn remapC4(x: vec4f, a: vec4f, b: vec4f) -> vec4f { return clamp((x - a) / (b - a), vec4f(0.0), vec4f(1.0)); }
fn raySphere2(o: vec3f, d: vec3f, r: f32) -> f32 {
  let b = dot(d, o);
  let disc = b * b - dot(o, o) + r * r;
  return select(-1.0, -b + sqrt(max(disc, 0.0)), disc >= 0.0);
}
fn raySphere1(o: vec3f, d: vec3f, r: f32) -> f32 {
  let b = dot(d, o);
  let disc = b * b - dot(o, o) + r * r;
  return select(-1.0, -b - sqrt(max(disc, 0.0)), disc >= 0.0);
}

// 立方体の座標（takram の getCubeSphereUv。日本が面の真ん中に来るように回してから）
fn clGlobeUv(p: vec3f) -> vec2f {
  let n0 = normalize(p);
  let n = vec3f(dot(n0, CL_E), dot(n0, CL_N), dot(n0, CL_U));
  let f = abs(n);
  let c = n / max(f.x, max(f.y, f.z));
  var m: vec2f;
  if (f.y > f.x && f.y > f.z) {
    m = select(n.xz, vec2f(-n.x, n.z), c.y > 0.0);
  } else if (f.x > f.y && f.x > f.z) {
    m = select(vec2f(-n.y, n.z), n.yz, c.x > 0.0);
  } else {
    m = select(vec2f(n.x, -n.y), n.xy, c.z > 0.0);
  }
  let m2 = m * m;
  let q = dot(m2, vec2f(-2.0, 2.0)) - 3.0;
  let q2 = q * q;
  let ux = sqrt(max(1.5 + m2.x - m2.y - 0.5 * sqrt(max(-24.0 * m2.x + q2, 0.0)), 0.0)) * select(-1.0, 1.0, m.x > 0.0);
  let uy = sqrt(6.0 / (3.0 - ux * ux)) * m.y;
  return vec2f(ux, uy) * 0.5 + 0.5;
}
fn clInGap(h: f32) -> bool {
  return (h > CL_GAP_MIN.x && h < CL_GAP_MAX.x) || (h > CL_GAP_MIN.y && h < CL_GAP_MAX.y);
}

// ---------------------------------------------------------------- 天気と雲の濃さ（takram の clouds.glsl）
struct ClWeather { hf: vec4f, density: vec4f };
fn clShapeAlter(hf: vec4f, bias: vec4f) -> vec4f {
  let x = clamp(pow(hf, bias) * 2.0 - 1.0, vec4f(-1.0), vec4f(1.0));
  return 1.0 - x * x;
}
fn clSampleWeather(uv: vec2f, h: f32, mip: f32, mask: vec4f) -> ClWeather {
  var w: ClWeather;
  w.hf = clamp((vec4f(h) - CL_MIN_LAYER) / CL_LAYER_H, vec4f(0.0), vec4f(1.0));
  let lw = textureSampleLevel(clWeather, clSamp, uv * CL_WEATHER_REPEAT, mip) * mask;
  let factor = 1.0 - CL_COVERAGE * clShapeAlter(w.hf, CL_SHAPE_BIAS);
  w.density = remapC4(mix(lw, vec4f(1.0), CL_FILTER_W), factor, factor + CL_FILTER_W) * mask;
  return w;
}
struct ClMedia { weight: vec4f, scattering: f32, extinction: f32 };
fn clSampleMedia(w: ClWeather, p: vec3f, uv: vec2f, mip: f32, jitter: f32) -> ClMedia {
  var density = w.density;
  let tuv = fract(uv * CL_WEATHER_REPEAT * CL_TURB_REPEAT);
  let turb = CL_TURB_DISP * (textureSampleLevel(clTurb, clSamp, tuv, 0.0).rgb * 2.0 - 1.0)
           * dot(density, remapC4(w.hf, vec4f(0.3), vec4f(0.0)));
  let shape = textureSampleLevel(clShape, clSamp, fract((p + turb) * CL_SHAPE_REPEAT), 0.0).r;
  density = remapC4(density, vec4f(1.0 - shape) * CL_SHAPE_AMOUNT, vec4f(1.0));
  if (mip * 0.5 + (jitter - 0.5) * 0.5 < 0.5) {
    let detail = textureSampleLevel(clDetail, clSamp, fract((p + turb) * CL_DETAIL_REPEAT), 0.0).r;
    // 上はもこもこ、下はすじ状
    var md = mix(vec4f(pow(detail, 6.0)), vec4f(1.0 - detail), remapC4(w.hf, vec4f(0.2), vec4f(0.4)));
    md = mix(vec4f(0.0), md, CL_DETAIL_AMOUNT);
    density = remapC4(density * 2.0, md * 0.5, vec4f(1.0));
  }
  // 濃さの高さの変わり方（takram の既定: 0.75 x 層の中の高さ + 0.25）
  density = clamp(density * CL_DENSITY_SCALE * (0.75 * w.hf + 0.25), vec4f(0.0), vec4f(1.0));
  let sum = density.x + density.y + density.z + density.w;
  var m: ClMedia;
  m.weight = density / max(sum, 1e-7);
  m.scattering = sum * CL_SCATTER;
  m.extinction = m.scattering;
  return m;
}

// ---------------------------------------------------------------- 影の地図
// 影の地図の真ん中（大気の座標）。カメラの位置を 1 km ごとに丸めた点（fr.shadowC はカメラからその点まで [m] の逆向き）
fn shadowCenter() -> vec3f { return fr.cam0.xyz - fr.shadowC.xyz / 1000.0; }
// 影の地図の 2 つの軸（太陽に垂直）
fn clBsmAxes() -> mat2x3f {
  let sun = fr.sun.xyz;
  var e1 = cross(normalize(shadowCenter()), sun);
  if (length(e1) < 1e-3) { e1 = cross(vec3f(1.0, 0.0, 0.0), sun); }
  e1 = normalize(e1);
  return mat2x3f(e1, cross(sun, e1));
}
// 点 p から太陽までの、影の地図からの光の弱まり。offset: そこまでは数えない距離（太陽の方へ進んで数えた分）[km]
fn clShadowOD(p: vec3f, offset: f32) -> f32 {
  let sun = fr.sun.xyz;
  let dt = raySphere2(p, sun, BOTTOM + CL_SHADOW_TOP);
  if (dt <= 0.0) { return 0.0; }
  let ax = clBsmAxes();
  let d = p - shadowCenter();
  let xy = vec2f(dot(d, ax[0]), dot(d, ax[1])) / CL_BSM_R;
  let e = max(abs(xy.x), abs(xy.y));
  if (e >= 1.0) { return 0.0; }
  // r: 雲のはじまりの距離、g: 平均の濃さ、b: いちばん奥までの光の弱まり、a: その残りの見積もり
  let s = textureSampleLevel(cloudShadowTex, atmoSamp, xy * 0.5 + 0.5, 0.0);
  let front = max(0.0, dt - offset - s.r);
  return min(s.b + s.a, s.g * front) * (1.0 - smoothstep(0.85, 1.0, e));
}
// 地面の点（カメラからの位置 rel [m]）に落ちる雲の影（1 が日なた）
fn cloudShadow(rel: vec3f) -> f32 {
  if (fr.nup.w < 0.5) { return 1.0; }
  let hc = length(fr.cam0.xyz) - BOTTOM;
  if (hc > 40.0) { return 1.0; }
  let od = clShadowOD(fr.cam0.xyz + rel / 1000.0, 0.0);
  return mix(exp(-od), 1.0, smoothstep(15.0, 40.0, hc));
}

// ---------------------------------------------------------------- 光（takram の clouds.frag）
fn clHG(g: vec2f, c: f32) -> vec2f {
  let g2 = g * g;
  return (1.0 / (4.0 * PI)) * (1.0 - g2) / max(vec2f(1e-7), pow(1.0 + g2 - 2.0 * g * c, vec2f(1.5)));
}
fn clPhase(c: f32, att: f32) -> f32 { return dot(clHG(vec2f(0.7, -0.2) * att, c), vec2f(0.5)); }
// 方向 d へ数歩進んだ所までの光の弱まり。rd: 最後に見た点までの距離 [km]
fn clMarchOD(o: vec3f, d: vec3f, maxIter: i32, mip: f32, jitter: f32, rd: ptr<function, f32>) -> f32 {
  let n = i32(max(0.0, f32(maxIter + 1) - mip * f32(maxIter) - jitter));
  if (n == 0) { return 0.5; }
  var step = CL_SEC_STEP / f32(n);
  var next = step * jitter;
  var od = 0.0;
  for (var i = 0; i < n; i++) {
    *rd = next;
    let p = next * d + o;
    let uv = clGlobeUv(p);
    let w = clSampleWeather(uv, length(p) - BOTTOM, mip, CL_MASK);
    od += clSampleMedia(w, p, uv, mip, jitter).extinction * step;
    next += step;
    step *= CL_SEC_SCALE;
  }
  return od;
}
// 何度も散らばる光の近似（Oz。段ごとに弱まり・量・散らばる向きの偏りを半分に）
fn clMultiScatter(od: f32, c: f32) -> f32 {
  var k = vec3f(1.0);
  var s = 0.0;
  for (var i = 0; i < CL_OCTAVES; i++) {
    s += k.x * exp(-od * k.y) * clPhase(c, k.z);
    k *= 0.5;
  }
  return s;
}
struct ClLight { sunMin: vec3f, sunMax: vec3f, skyMin: vec3f, skyMax: vec3f, sunG: vec3f, skyG: vec3f };
fn clLightAt(p: vec3f) -> ClLight {
  let sun = fr.sun.xyz;
  let up = normalize(p);
  let mus = dot(up, sun);
  let lit = smoothstep(-0.02, 0.05, mus);
  var l: ClLight;
  l.sunMin = SOLAR * transToTop(BOTTOM + CL_MIN_H, mus) * lit;
  l.sunMax = SOLAR * transToTop(BOTTOM + CL_MAX_H, mus) * lit;
  l.skyMin = skyRadiance(up * (BOTTOM + CL_MIN_H), up, sun).l * PI;
  l.skyMax = skyRadiance(up * (BOTTOM + CL_MAX_H), up, sun).l * PI;
  l.sunG = SOLAR * transToTop(BOTTOM, mus) * max(mus, 0.0) * lit;
  l.skyG = skyRadiance(up * (BOTTOM + 0.01), up, sun).l * PI;
  return l;
}
fn clMarch(o: vec3f, v: vec3f, nf: vec2f, cosT: f32, jitter: f32, startTexels: f32, lt: ClLight,
           front: ptr<function, f32>) -> vec4f {
  let sun = fr.sun.xyz;
  var rad = vec3f(0.0);
  var T = 1.0;
  var wds = 0.0;
  var ts = 0.0;
  let maxD = nf.y - nf.x;
  // 刻みは光線のはじまりまでの距離の 1 %（takram）。ただし 1 km まで（宇宙から見ると 5 km を超え、雲の層を飛び越した）
  var step = min(CL_MIN_STEP + (CL_STEP_SCALE - 1.0) * nf.x, CL_MAX_STEP);
  var rd = step * jitter * 2.0;
  for (var i = 0; i < CL_MAX_ITER; i++) {
    if (rd > maxD) { break; }
    let p = rd * v + o;
    let h = length(p) - BOTTOM;
    let mip = log2(max(1.0, startTexels + rd * 0.01));
    if (clInGap(h)) {
      step *= CL_STEP_SCALE;
      rd += mix(step, CL_MAX_STEP, min(1.0, mip));
      continue;
    }
    let uv = clGlobeUv(p);
    let w = clSampleWeather(uv, h, mip, CL_MASK);
    if (!any(w.density > vec4f(CL_MIN_DENSITY))) {
      step *= CL_STEP_SCALE;
      rd += mix(step, CL_MAX_STEP, min(1.0, mip));
      continue;
    }
    let m = clSampleMedia(w, p, uv, mip, jitter);
    if (m.extinction > CL_MIN_EXT) {
      let a = remapC(h, CL_MIN_H, CL_MAX_H);
      let sunI = mix(lt.sunMin, lt.sunMax, a);
      let skyI = mix(lt.skyMin, lt.skyMax, a);
      let nrm = normalize(p);
      // 太陽の方へ数歩（影の地図にない細かい所）。その先は影の地図から
      var srd = 0.0;
      var od = clMarchOD(p, sun, CL_SUN_ITER, mip, jitter, &srd);
      if (h < CL_SHADOW_TOP) { od += clShadowOD(p, srd); }
      var radiance = sunI * clMultiScatter(od, cosT);
      // 地面の照り返し（低い所の近くの雲だけ）
      if (h < CL_SHADOW_TOP && mip < 0.5) {
        var gd = 0.0;
        let odG = clMarchOD(p, -nrm, CL_GROUND_ITER, mip, jitter, &gd);
        let gi = lt.skyG + (1.0 - CL_COVERAGE) * lt.sunG;
        radiance += 0.3 / PI * gi * exp(-odG) / (4.0 * PI);
      }
      // 空の光（上ほど多い、大まかな近似）
      radiance += skyI / (4.0 * PI) * dot(w.hf * 0.5 + 0.5, m.weight);
      radiance *= m.scattering;
      // powder（雲の縁が少し暗くなる）
      radiance *= 1.0 - 0.8 * exp(-m.extinction * 0.15);
      // 1 刻みの中の散らばった光を、弱まりを考えて積む（Frostbite 2016 の 5.6.3）
      let tr = exp(-m.extinction * step);
      rad += T * (radiance - radiance * tr) / max(m.extinction, 1e-7);
      T *= tr;
      wds += rd * T;
      ts += T;
    }
    if (T <= CL_MIN_T) { break; }
    step *= CL_STEP_SCALE;
    rd += step;
  }
  *front = select(-1.0, wds / ts, ts > 0.0);
  return vec4f(rad, remapC(T, 1.0, CL_MIN_T));
}
// 雲までの距離 [km]（時間方向の再投影に使う。雲がなければ遠く）
var<private> gCloudD: f32 = 1e4;
// 視線 v（大気の座標の単位ベクトル）の雲（足す光（かすみをかけたもの）、隠れる割合）。tMax: 地面や建物までの距離 [km]。
// pix: 画素の位置、dimInv: 雲の画像の 1 画素の大きさ（画面の座標で）
fn cloudMarch(v: vec3f, ndc: vec2f, pix: vec2f, tMax: f32, frame: f32, sky: bool) -> vec4f {
  gCloudD = 1e4;
  let cam = fr.cam0.xyz;
  let rc = length(cam);
  let camH = rc - BOTTOM;
  let sun = fr.sun.xyz;
  let cosT = dot(sun, v);
  let b = dot(cam, v);
  let ground = b < 0.0 && b * b - rc * rc + BOTTOM * BOTTOM >= 0.0;
  // 空の分で、地面（海の高さの球）に当たる向きは描かない（地面のほうは、かすみの表で霧と光芒をかける）
  if (sky && ground) { return vec4f(0.0); }
  let tg = select(1e9, -b - sqrt(max(b * b - rc * rc + BOTTOM * BOTTOM, 0.0)), ground);
  let rMin = BOTTOM + CL_MIN_H;
  let rMax = BOTTOM + CL_MAX_H;
  let dMin = b * b - rc * rc + rMin * rMin;
  let dMax = b * b - rc * rc + rMax * rMax;
  let min1 = select(-1.0, -b - sqrt(max(dMin, 0.0)), dMin >= 0.0);
  let min2 = select(-1.0, -b + sqrt(max(dMin, 0.0)), dMin >= 0.0);
  let max1 = select(-1.0, -b - sqrt(max(dMax, 0.0)), dMax >= 0.0);
  let max2 = select(-1.0, -b + sqrt(max(dMax, 0.0)), dMax >= 0.0);
  var nf = vec2f(-1.0);
  if (camH < CL_MIN_H) {
    if (!ground) { nf = vec2f(min2, min(max2, CL_MAX_RAY)); }
  } else if (camH < CL_MAX_H) {
    nf = select(vec2f(0.0, max2), vec2f(0.0, min1), ground);
  } else {
    nf = vec2f(max1, max2);
    if (ground) { nf.y = min1; }
  }
  nf.y = min(nf.y, tMax);
  // 区切りのずらし（画素ごとの乱数。コマごとに黄金比ずつ変える）
  let jitter = fract(fract(52.9829189 * fract(dot(pix, vec2f(0.06711056, 0.00583715)))) + frame * 0.618034);
  var c = vec4f(0.0);
  var fd = -1.0;
  if (nf.x >= 0.0 && nf.y > nf.x) {
    let o = nf.x * v + cam;
    // 天気のテクスチャーの、光線のはじまりでの 1 画素あたりのテクセル数（takram は画面の微分から求める）。雲の画像の
    // 1 画素の角度 x 距離 / テクセルの大きさ（立方体の 1 面 1 万 km を 100 x 512 に分けた 0.2 km）
    let dim = vec2f(textureDimensions(cloudHist));
    let pixAng = length(cloudDir(ndc + vec2f(2.0 / dim.x, 0.0)) - v);
    let tpp = nf.x * pixAng / 0.195;
    var mip0 = max(0.0, log2(max(1.0, tpp * 0.316)));
    mip0 = mip0 * 0.33 * min(1.0, 0.2 * camH / CL_MAX_H);
    var front = 0.0;
    c = clMarch(o, v, nf, cosT, jitter, exp2(mip0), clLightAt(o), &front);
    if (front >= 0.0) {
      fd = max(nf.x + front, 0.01);
      gCloudD = fd;
    }
  }
  if (!sky) {
    // 地面や建物の手前の雲（霧と光芒は、地面のほうでかすみの表にかけてある）
    if (fd < 0.0) { return vec4f(0.0); }
    let air = skyToPoint(cam, cam + v * fd, sun);
    return vec4f(c.rgb * air.t + air.l * c.a, c.a);
  }
  // 光芒: 視線の上の、雲の影に入った長さ（影の層の上の球まで。雲に当たったら、隠れる割合に応じてそこまで）
  var sr = clShadowRay(cam, v, tg);
  var hz = select(max2, min(max2, tg), camH < CL_MAX_H);
  if (fd >= 0.0) {
    sr.y = mix(sr.y, min(fd, sr.y), c.a);
    hz = mix(hz, min(fd, hz), c.a);
  }
  var sl = 0.0;
  if (sr.x >= 0.0 && sr.y > sr.x) { sl = clShadowLength(cam + v * sr.x, v, sr.y - sr.x, jitter); }
  if (fd >= 0.0) {
    let air = skyToPointSL(cam, cam + v * fd, sun, sl);
    c = vec4f(c.rgb * air.t + air.l * c.a, c.a);
  }
  // 霧
  let hzc = clHaze(cam, v, hz, cosT, sl);
  c = vec4f(mix(c.rgb, hzc.rgb, hzc.a), c.a * (1.0 - hzc.a) + hzc.a);
  // 雲の向こうの空にも光芒（空の光を、影に入った分だけ減らす。空に重ねるときの隠れる割合に入れる）
  if (sl > 0.0) {
    let lum = vec3f(0.2126, 0.7152, 0.0722);
    let full = dot(skyRadiance(cam, v, sun).l, lum);
    let k = clamp(dot(skyRadianceSL(cam, v, sun, sl).l, lum) / max(full, 1e-6), 0.0, 1.0);
    c.a = 1.0 - (1.0 - c.a) * k;
  }
  return c;
}
// 光芒を調べる区間（カメラから、影の層の上の球まで。地面に当たれば tg まで。多くて CL_SL_MAX）
fn clShadowRay(cam: vec3f, v: vec3f, tg: f32) -> vec2f {
  let rc = length(cam);
  let b = dot(cam, v);
  let rT = BOTTOM + CL_SHADOW_TOP;
  let dT = b * b - rc * rc + rT * rT;
  if (dT < 0.0) { return vec2f(-1.0); }
  let t1 = -b - sqrt(dT);
  let t2 = -b + sqrt(dT);
  var sr = select(vec2f(t1, min(t2, tg)), vec2f(0.0, min(t2, tg)), rc - BOTTOM < CL_SHADOW_TOP);
  sr.y = min(sr.y, CL_SL_MAX);
  return sr;
}
// 光芒（takram の marchShadowLength）: 視線の上で、影の地図から求めた雲の影の濃さ（1 - 透けぐあい）を足す [km]。
// 刻みは 50 m から 1.08 倍ずつ（64 歩で 85 km ほど）
fn clShadowLength(o: vec3f, v: vec3f, maxD: f32, jitter: f32) -> f32 {
  var step = 0.05;
  var rd = step * jitter;
  var sl = 0.0;
  for (var i = 0; i < 64; i++) {
    if (rd > maxD) { break; }
    let od = clShadowOD(o + v * rd, 0.0);
    sl += (1.0 - exp(-od)) * step;
    step *= 1.08;
    rd += step;
  }
  return sl;
}
// 地面での太陽の光と空の光（水平な面。霧に使う）
fn clGroundLight(p: vec3f) -> mat2x3f {
  let sun = fr.sun.xyz;
  let up = normalize(p);
  let mus = dot(up, sun);
  return mat2x3f(SOLAR * transToTop(BOTTOM, mus) * max(mus, 0.0) * smoothstep(-0.02, 0.05, mus),
                 skyRadiance(up * (BOTTOM + 0.01), up, sun).l * PI);
}
// 霧（takram の approximateHaze）: 高さとともに指数で薄くなる霧を、視線に沿って式で積む。雲の量が 0.2〜0.4 で濃くなる。
// rgb: 霧の光、a: 霧で隠れる割合。影に入った長さ sl の分は、太陽の光を散らさない
const CL_HAZE_DENSITY = 0.03;   // [1/km]（takram は 3e-5 /m）
const CL_HAZE_EXP = 1.0;        // [1/km]
fn clHaze(cam: vec3f, v: vec3f, maxD: f32, cosT: f32, sl: f32) -> vec4f {
  let modulation = remapC(CL_COVERAGE, 0.2, 0.4);
  let camH = length(cam) - BOTTOM;
  if (camH * modulation < 0.0 || maxD <= 0.0) { return vec4f(0.0); }
  let density = modulation * CL_HAZE_DENSITY * exp(-camH * CL_HAZE_EXP);
  if (density < 1e-4) { return vec4f(0.0); }
  // カメラの真上の向きと、地平線での向きを、視線の向きで混ぜる（地面の近くはカメラの、空は地平線の）
  let nO = normalize(cam);
  let nH = (cam - dot(cam, v) * v) / BOTTOM;
  let n = mix(nO, nH, remapC(dot(nO, nH), 0.9, 1.0));
  let angle = max(dot(n, v), 1e-5);
  let ex = angle * CL_HAZE_EXP;
  let lin = density / CL_HAZE_EXP / angle;
  let et = 1.0 - exp(-maxD * ex);
  let sEt = 1.0 - exp(-min(maxD, sl) * ex);
  let tr = clamp(1.0 - exp(-et * lin), 0.0, 1.0);
  let str = clamp(1.0 - exp(-max((et - sEt) * lin, 0.0)), 0.0, 1.0);
  let gl = clGroundLight(cam);
  let ins = (gl[0] * clPhase(cosT, 1.0) * str + gl[1] / (4.0 * PI) * tr) * (0.9 / 1.4);
  return vec4f(ins, tr);
}
// 地面や建物のかすみ（gpu-render.js の AERIAL_CS で表にする）に、光芒と霧をかける。rel: カメラからの位置 [m]
fn cloudAerial(rel: vec3f) -> Aer {
  if (fr.nup.w < 0.5 || fr.cam0.w < 1.5) { return aerialAt(rel); }
  let cam = fr.cam0.xyz;
  let dist = max(length(rel) / 1000.0, 1e-3);
  let v = rel / 1000.0 / dist;
  let sr = clShadowRay(cam, v, dist);
  var sl = 0.0;
  if (sr.x >= 0.0 && sr.y > sr.x) { sl = clShadowLength(cam + v * sr.x, v, sr.y - sr.x, 0.5); }
  let a = aerialAtSL(rel, sl);
  let hzc = clHaze(cam, v, dist, dot(fr.sun.xyz, v), sl);
  let hs = hzc.rgb * fr.balance.rgb * fr.balance.w;
  return Aer(a.t * (1.0 - hzc.a), a.s * (1.0 - hzc.a) + hs * hzc.a);
}

// ---------------------------------------------------------------- 描く仕組み（このビューアのもの）
// 雲の画像 tex を画面の位置 cuv で引く。まわりより明るく飛び出した画素は、まわりの画素のいちばん明るい値に抑え
// （白い粒が散らばって見えないよう）、そのあと、まわりの 4 点との平均で少しならす
fn cloudBil(q: ptr<function, array<vec4f, 16>>, x: f32, y: f32) -> vec4f {
  let ix = clamp(i32(floor(x)), 0, 2);
  let iy = clamp(i32(floor(y)), 0, 2);
  let fx = clamp(x - f32(ix), 0.0, 1.0);
  let fy = clamp(y - f32(iy), 0.0, 1.0);
  let k = iy * 4 + ix;
  return mix(mix((*q)[k], (*q)[k + 1], fx), mix((*q)[k + 4], (*q)[k + 5], fx), fy);
}
fn cloudClean(tex: texture_2d<f32>, cuv: vec2f) -> vec4f {
  let dim = vec2i(textureDimensions(tex));
  let pf = cuv * vec2f(dim) - 0.5;
  let i0 = vec2i(floor(pf));
  let f = pf - floor(pf);
  var c: array<vec4f, 16>;
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) { c[y * 4 + x] = textureLoad(tex, clamp(i0 + vec2i(x - 1, y - 1), vec2i(0), dim - 1), 0); }
  }
  var q: array<vec4f, 16>;
  for (var k = 0; k < 16; k++) {
    let cx = k & 3;
    let cy = k >> 2u;
    var mx = vec4f(0.0);
    for (var y = max(cy - 1, 0); y <= min(cy + 1, 3); y++) {
      for (var x = max(cx - 1, 0); x <= min(cx + 1, 3); x++) {
        if (x != cx || y != cy) { mx = max(mx, c[y * 4 + x]); }
      }
    }
    q[k] = min(c[k], mx);
  }
  let x = 1.0 + f.x;
  let y = 1.0 + f.y;
  return (cloudBil(&q, x, y) * 4.0 + cloudBil(&q, x + 0.5, y + 0.5) + cloudBil(&q, x - 0.5, y + 0.5)
        + cloudBil(&q, x + 0.5, y - 0.5) + cloudBil(&q, x - 0.5, y - 0.5)) / 8.0;
}
// 縦横 1/3 の大きさで描いておいた雲（rgb: 足す光、a: 雲で隠れる割合）。空を描くときだけ使う
@group(0) @binding(10) var cloudTex: texture_2d<f32>;
@group(0) @binding(11) var cloudSamp: sampler;
// 雲の画像を描く（縦横 1/3 の大きさ。vsSky の 3 角形を使う）。カメラが止まっている間は、区切りのずらし方を変えた
// コマを前のコマの画像と平均していく。動いている間は、前のコマの画像を、今の画素の雲までの距離から求めた前のコマ
// での位置で引いて混ぜる（時間方向の再投影）
// info: x 平均したコマの数、y 前のコマの画像と平均するか、z ずらし方の番号、w 再投影するか。prevVP: 前のコマの
// カメラの向きと投影（カメラが原点、m）、dcam: 前のコマからカメラが動いた量 [m]
struct CloudU { info: vec4f, prevVP: mat4x4f, dcam: vec4f };
@group(0) @binding(16) var cloudHist: texture_2d<f32>;
@group(0) @binding(17) var<uniform> cu: CloudU;
fn cloudHistAt(px: vec2f) -> vec4f {
  let dim = vec2i(textureDimensions(cloudHist));
  let q = px - 0.5;
  let i0 = vec2i(floor(q));
  let f = q - floor(q);
  let a = textureLoad(cloudHist, clamp(i0, vec2i(0), dim - 1), 0);
  let b = textureLoad(cloudHist, clamp(i0 + vec2i(1, 0), vec2i(0), dim - 1), 0);
  let c = textureLoad(cloudHist, clamp(i0 + vec2i(0, 1), vec2i(0), dim - 1), 0);
  let d = textureLoad(cloudHist, clamp(i0 + vec2i(1, 1), vec2i(0), dim - 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn cloudReproj(c: vec4f, v: vec3f) -> vec4f {
  let D = select(1e4, gCloudD, c.a > 0.01) * 1000.0;
  let cl = cu.prevVP * vec4f(v * D + cu.dcam.xyz, 1.0);
  if (cl.w <= 0.0) { return c; }
  let ndc = cl.xy / cl.w;
  if (any(abs(ndc) > vec2f(1.0))) { return c; }
  let dim = vec2f(textureDimensions(cloudHist));
  let h = cloudHistAt(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * dim);
  if (!all(abs(h) < vec4f(1e6))) { return c; }
  // 前のコマとの差が大きい所は、前のコマをあまり使わない（雲の残像が残る）
  let w = 0.75 * (1.0 - smoothstep(0.15, 0.5, abs(h.a - c.a)));
  return mix(c, h, w);
}
fn cloudAccum(c0: vec4f, pix: vec2f, v: vec3f) -> vec4f {
  let c = select(vec4f(0.0), c0, all(abs(c0) < vec4f(1e6)));
  if (cu.info.w > 0.5) { return cloudReproj(c, v); }
  if (cu.info.y < 0.5) { return c; }
  let h = textureLoad(cloudHist, vec2i(pix), 0);
  return mix(select(c, h, all(abs(h) < vec4f(1e6))), c, 1.0 / (cu.info.x + 1.0));
}
fn cloudDir(ndc: vec2f) -> vec3f {
  let q = fr.invVP * vec4f(ndc, 1.0, 1.0);
  return normalize(q.xyz / q.w);
}
// 空の分（地面や建物のない所）
@fragment fn fsCloud(i: SkyV) -> @location(0) vec4f {
  if (fr.cam0.w < 0.5) { return vec4f(0.0); }
  let v = cloudDir(i.ndc);
  return cloudAccum(cloudMarch(v, i.ndc, i.pos.xy, 1e9, cu.info.z, true), i.pos.xy, v);
}
// 地面や建物の手前の雲（カメラが雲の層の近くより高いとき）。奥行き d の所まで見る。空の所（奥行き 0）は 0
@group(0) @binding(18) var depthMS: texture_depth_multisampled_2d;
@group(0) @binding(19) var depth1: texture_depth_2d;
fn cloudOver(i: SkyV, d: f32) -> vec4f {
  if (fr.cam0.w < 0.5 || d <= 0.0) { return vec4f(0.0); }
  let q = fr.invVP * vec4f(i.ndc, d, 1.0);
  let v = cloudDir(i.ndc);
  return cloudAccum(cloudMarch(v, i.ndc, i.pos.xy, length(q.xyz / q.w) / 1000.0, cu.info.z, false), i.pos.xy, v);
}
// 雲の画像の 1 画素にあたる画面の画素（3 x 3 ほど）のうち、いちばん手前の奥行きを使う
fn overPix(i: SkyV, dim: vec2i) -> vec2i {
  return vec2i(i.pos.xy * vec2f(dim) / vec2f(textureDimensions(cloudHist)));
}
@fragment fn fsCloudOverMS(i: SkyV) -> @location(0) vec4f {
  let dim = vec2i(textureDimensions(depthMS));
  let c = overPix(i, dim);
  var d = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) { d = max(d, textureLoad(depthMS, clamp(c + vec2i(x, y), vec2i(0), dim - 1), 0)); }
  }
  return cloudOver(i, d);
}
@fragment fn fsCloudOver1(i: SkyV) -> @location(0) vec4f {
  let dim = vec2i(textureDimensions(depth1));
  let c = overPix(i, dim);
  var d = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) { d = max(d, textureLoad(depth1, clamp(c + vec2i(x, y), vec2i(0), dim - 1), 0)); }
  }
  return cloudOver(i, d);
}
// 地面や建物の手前の雲を、できあがった画面に重ねる（画面の色は明るさの曲線をかけたあとなので、雲だけを曲線にかけて
// 隠れる割合で重ねる近い式）
@group(0) @binding(20) var overTex: texture_2d<f32>;
@fragment fn fsCloudComp(i: SkyV) -> @location(0) vec4f {
  let cuv = vec2f(i.ndc.x * 0.5 + 0.5, 0.5 - i.ndc.y * 0.5);
  let cl = cloudClean(overTex, cuv);
  if (cl.a < 0.003) { discard; }
  let bal = select(vec3f(1.0), fr.balance.rgb, fr.cam0.w > 1.5);
  let col = pow(tone(cl.rgb / cl.a * bal * fr.balance.w), vec3f(1.0 / 2.2));
  return vec4f(col * cl.a, cl.a);
}
`;
  const sky = /* wgsl */`
  {
    let cuv = vec2f(i.ndc.x * 0.5 + 0.5, 0.5 - i.ndc.y * 0.5);
    let cl = cloudClean(cloudTex, cuv);
    L = L * (1.0 - cl.a) + cl.rgb;
  }`;
  // 影の地図を作る計算シェーダー（takram の shadow.frag。fns の後ろにつなげて、別のモジュールにする）
  const shadowCS = /* wgsl */`
@group(0) @binding(0) var bsmOut: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8) fn cloudShadowMain(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= CL_BSM_N || id.y >= CL_BSM_N) { return; }
  let xy = (vec2f(id.xy) + 0.5) / f32(CL_BSM_N) * 2.0 - 1.0;
  let ax = clBsmAxes();
  let sun = fr.sun.xyz;
  let q = shadowCenter() + (ax[0] * xy.x + ax[1] * xy.y) * CL_BSM_R;
  // 太陽の側の遠くから、太陽と逆向きに、影の層の上の球に入った所から下の球まで
  let sp = q + sun * 500.0;
  let dir = -sun;
  let near0 = raySphere1(sp, dir, BOTTOM + CL_SHADOW_TOP);
  if (near0 < 0.0) { textureStore(bsmOut, id.xy, vec4f(1e3, 0.0, 0.0, 0.0)); return; }
  var far = raySphere1(sp, dir, BOTTOM + CL_SHADOW_BOTTOM);
  if (far < 0.0) { far = raySphere2(sp, dir, BOTTOM + CL_SHADOW_TOP); }
  let near = max(0.0, near0);
  let o = sp + dir * near;
  let maxD = far - near;
  let step = clamp(maxD / 50.0, CL_MIN_STEP, CL_MAX_STEP);
  var rd = step * 0.5;
  var extSum = 0.0;
  var maxOD = 0.0;
  var tail = 0.0;
  var T = 1.0;
  var wds = 0.0;
  var ts = 0.0;
  var n = 0;
  for (var i = 0; i < 50; i++) {
    if (rd > maxD) { break; }
    let p = rd * dir + o;
    let h = length(p) - BOTTOM;
    if (clInGap(h)) { rd += step; continue; }
    let uv = clGlobeUv(p);
    let w = clSampleWeather(uv, h, 0.0, CL_SHADOW_MASK);
    if (any(w.density > vec4f(CL_MIN_DENSITY))) {
      let m = clSampleMedia(w, p, uv, 0.0, 0.5);
      if (m.extinction > CL_MIN_EXT) {
        extSum += m.extinction;
        maxOD += m.extinction * step;
        T *= exp(-m.extinction * step);
        wds += rd * T;
        ts += T;
        n++;
      }
    }
    if (T <= 1e-4) {
      tail = min(2.0 * step * exp(f32(1 - n)), step * 0.5);
      break;
    }
    rd += step;
  }
  if (n == 0) { textureStore(bsmOut, id.xy, vec4f(maxD, 0.0, 0.0, 0.0)); return; }
  textureStore(bsmOut, id.xy, vec4f(min(wds / ts, maxD), extSum / f32(n), maxOD, tail));
}
`;
  return { fns, sky, shadowCS, genCS: GPU_CLOUD_NOISE_WGSL };
}
// 雲なし（?clouds=0）のとき
const GPU_NO_CLOUD_WGSL = 'fn cloudShadow(rel: vec3f) -> f32 { return 1.0; }\nfn cloudAerial(rel: vec3f) -> Aer { return aerialAt(rel); }\n';

// ノイズのテクスチャーを作る計算シェーダー（takram の cloudShape.frag、cloudShapeDetail.frag、localWeather.frag、
// turbulence.frag と、その元の TileableVolumeNoise と GLM の Perlin ノイズ）。形のノイズは重いので、z を何回かに
// 分けて作る（genShape の p.z が、はじめの z）
const GPU_CLOUD_NOISE_WGSL = /* wgsl */`
@group(0) @binding(0) var outShape: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var outDetail: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(2) var outWeather: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var outTurb: texture_storage_2d<rgba8unorm, write>;
struct GenP { z0: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(4) var<uniform> gp: GenP;
fn gmod4(x: vec4f, y: vec4f) -> vec4f { return x - y * floor(x / y); }
fn gmod3(x: vec3f, y: f32) -> vec3f { return x - y * floor(x / y); }
fn mod289(x: vec4f) -> vec4f { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute(v: vec4f) -> vec4f { return mod289((v * 34.0 + 1.0) * v); }
fn taylorInvSqrt(r: vec4f) -> vec4f { return 1.79284291400159 - 0.85373472095314 * r; }
fn fade4(v: vec4f) -> vec4f { return v * v * v * (v * (v * 6.0 - 15.0) + 10.0); }
// 周期つきの Perlin ノイズ（4 次元）
fn gradSet(ixy: vec4f) -> array<vec4f, 4> {
  var gx = ixy / 7.0;
  var gy = floor(gx) / 7.0;
  var gz = floor(gy) / 6.0;
  gx = fract(gx) - 0.5;
  gy = fract(gy) - 0.5;
  gz = fract(gz) - 0.5;
  let gw = vec4f(0.75) - abs(gx) - abs(gy) - abs(gz);
  let sw = step(gw, vec4f(0.0));
  gx -= sw * (step(vec4f(0.0), gx) - 0.5);
  gy -= sw * (step(vec4f(0.0), gy) - 0.5);
  return array<vec4f, 4>(gx, gy, gz, gw);
}
fn perlin4(pos: vec4f, rep: vec4f) -> f32 {
  let Pi0 = gmod4(floor(pos), rep);
  let Pi1 = gmod4(Pi0 + 1.0, rep);
  let Pf0 = fract(pos);
  let Pf1 = Pf0 - 1.0;
  let ix = vec4f(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  let iy = vec4f(Pi0.y, Pi0.y, Pi1.y, Pi1.y);
  let ixy = permute(permute(ix) + iy);
  let ixy0 = permute(ixy + vec4f(Pi0.z));
  let ixy1 = permute(ixy + vec4f(Pi1.z));
  let g00 = gradSet(permute(ixy0 + vec4f(Pi0.w)));
  let g01 = gradSet(permute(ixy0 + vec4f(Pi1.w)));
  let g10 = gradSet(permute(ixy1 + vec4f(Pi0.w)));
  let g11 = gradSet(permute(ixy1 + vec4f(Pi1.w)));
  var g0000 = vec4f(g00[0].x, g00[1].x, g00[2].x, g00[3].x);
  var g1000 = vec4f(g00[0].y, g00[1].y, g00[2].y, g00[3].y);
  var g0100 = vec4f(g00[0].z, g00[1].z, g00[2].z, g00[3].z);
  var g1100 = vec4f(g00[0].w, g00[1].w, g00[2].w, g00[3].w);
  var g0010 = vec4f(g10[0].x, g10[1].x, g10[2].x, g10[3].x);
  var g1010 = vec4f(g10[0].y, g10[1].y, g10[2].y, g10[3].y);
  var g0110 = vec4f(g10[0].z, g10[1].z, g10[2].z, g10[3].z);
  var g1110 = vec4f(g10[0].w, g10[1].w, g10[2].w, g10[3].w);
  var g0001 = vec4f(g01[0].x, g01[1].x, g01[2].x, g01[3].x);
  var g1001 = vec4f(g01[0].y, g01[1].y, g01[2].y, g01[3].y);
  var g0101 = vec4f(g01[0].z, g01[1].z, g01[2].z, g01[3].z);
  var g1101 = vec4f(g01[0].w, g01[1].w, g01[2].w, g01[3].w);
  var g0011 = vec4f(g11[0].x, g11[1].x, g11[2].x, g11[3].x);
  var g1011 = vec4f(g11[0].y, g11[1].y, g11[2].y, g11[3].y);
  var g0111 = vec4f(g11[0].z, g11[1].z, g11[2].z, g11[3].z);
  var g1111 = vec4f(g11[0].w, g11[1].w, g11[2].w, g11[3].w);
  let n00 = taylorInvSqrt(vec4f(dot(g0000, g0000), dot(g0100, g0100), dot(g1000, g1000), dot(g1100, g1100)));
  g0000 *= n00.x; g0100 *= n00.y; g1000 *= n00.z; g1100 *= n00.w;
  let n01 = taylorInvSqrt(vec4f(dot(g0001, g0001), dot(g0101, g0101), dot(g1001, g1001), dot(g1101, g1101)));
  g0001 *= n01.x; g0101 *= n01.y; g1001 *= n01.z; g1101 *= n01.w;
  let n10 = taylorInvSqrt(vec4f(dot(g0010, g0010), dot(g0110, g0110), dot(g1010, g1010), dot(g1110, g1110)));
  g0010 *= n10.x; g0110 *= n10.y; g1010 *= n10.z; g1110 *= n10.w;
  let n11 = taylorInvSqrt(vec4f(dot(g0011, g0011), dot(g0111, g0111), dot(g1011, g1011), dot(g1111, g1111)));
  g0011 *= n11.x; g0111 *= n11.y; g1011 *= n11.z; g1111 *= n11.w;
  let a0000 = dot(g0000, Pf0);
  let a1000 = dot(g1000, vec4f(Pf1.x, Pf0.y, Pf0.z, Pf0.w));
  let a0100 = dot(g0100, vec4f(Pf0.x, Pf1.y, Pf0.z, Pf0.w));
  let a1100 = dot(g1100, vec4f(Pf1.x, Pf1.y, Pf0.z, Pf0.w));
  let a0010 = dot(g0010, vec4f(Pf0.x, Pf0.y, Pf1.z, Pf0.w));
  let a1010 = dot(g1010, vec4f(Pf1.x, Pf0.y, Pf1.z, Pf0.w));
  let a0110 = dot(g0110, vec4f(Pf0.x, Pf1.y, Pf1.z, Pf0.w));
  let a1110 = dot(g1110, vec4f(Pf1.x, Pf1.y, Pf1.z, Pf0.w));
  let a0001 = dot(g0001, vec4f(Pf0.x, Pf0.y, Pf0.z, Pf1.w));
  let a1001 = dot(g1001, vec4f(Pf1.x, Pf0.y, Pf0.z, Pf1.w));
  let a0101 = dot(g0101, vec4f(Pf0.x, Pf1.y, Pf0.z, Pf1.w));
  let a1101 = dot(g1101, vec4f(Pf1.x, Pf1.y, Pf0.z, Pf1.w));
  let a0011 = dot(g0011, vec4f(Pf0.x, Pf0.y, Pf1.z, Pf1.w));
  let a1011 = dot(g1011, vec4f(Pf1.x, Pf0.y, Pf1.z, Pf1.w));
  let a0111 = dot(g0111, vec4f(Pf0.x, Pf1.y, Pf1.z, Pf1.w));
  let a1111 = dot(g1111, Pf1);
  let fw = fade4(Pf0);
  let n0w = mix(vec4f(a0000, a1000, a0100, a1100), vec4f(a0001, a1001, a0101, a1101), fw.w);
  let n1w = mix(vec4f(a0010, a1010, a0110, a1110), vec4f(a0011, a1011, a0111, a1111), fw.w);
  let nzw = mix(n0w, n1w, fw.z);
  let nyzw = mix(nzw.xy, nzw.zw, fw.y);
  return 2.2 * mix(nyzw.x, nyzw.y, fw.x);
}
fn perlinFbm(point: vec3f, freq: vec3f, octaves: i32) -> f32 {
  var sum = 0.0;
  var ws = 0.0;
  var w = 1.0;
  var f = freq;
  for (var i = 0; i < octaves; i++) {
    sum += perlin4(vec4f(point * f, 0.0), vec4f(f, 1.0)) * w;
    ws += w;
    w *= 0.5;
    f *= 2.0;
  }
  return sum / ws;
}
fn tnHash(n: f32) -> f32 { return fract(sin(n + 1.951) * 43758.5453); }
fn tnNoise(x: vec3f) -> f32 {
  let p = floor(x);
  var f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  let n = p.x + p.y * 57.0 + 113.0 * p.z;
  return mix(mix(mix(tnHash(n), tnHash(n + 1.0), f.x), mix(tnHash(n + 57.0), tnHash(n + 58.0), f.x), f.y),
             mix(mix(tnHash(n + 113.0), tnHash(n + 114.0), f.x), mix(tnHash(n + 170.0), tnHash(n + 171.0), f.x), f.y), f.z);
}
fn worley(p: vec3f, cells: f32) -> f32 {
  let cell = p * cells;
  var d = 1.0e10;
  for (var x = -1; x <= 1; x++) {
    for (var y = -1; y <= 1; y++) {
      for (var z = -1; z <= 1; z++) {
        var tp = floor(cell) + vec3f(f32(x), f32(y), f32(z));
        tp = cell - tp - tnNoise(gmod3(tp, cells));
        d = min(d, dot(tp, tp));
      }
    }
  }
  return clamp(d, 0.0, 1.0);
}
fn worleyFbm3(point: vec3f, base: f32) -> f32 {
  let n = vec4f(1.0 - worley(point, base), 1.0 - worley(point, base * 2.0), 1.0 - worley(point, base * 4.0),
                1.0 - worley(point, base * 8.0));
  let fbm = vec3f(dot(n.xyz, vec3f(0.625, 0.25, 0.125)), dot(n.yzw, vec3f(0.625, 0.25, 0.125)), dot(n.zw, vec2f(0.75, 0.25)));
  return dot(fbm, vec3f(0.625, 0.25, 0.125));
}
// 形のノイズ（128^3）: Perlin-Worley を Worley の fBm で削ったもの
@compute @workgroup_size(4, 4, 4) fn genShape(@builtin(global_invocation_id) id0: vec3u) {
  let id = vec3u(id0.xy, id0.z + gp.z0);
  if (any(id >= vec3u(128u))) { return; }
  let point = vec3f((f32(id.x) + 0.5) / 128.0, (f32(id.y) + 0.5) / 128.0, f32(id.z) / 128.0);
  let perlin = clamp(perlinFbm(point, vec3f(8.0), 3), 0.0, 1.0);
  let wn = vec3f(1.0 - worley(point, 8.0), 1.0 - worley(point, 32.0), 1.0 - worley(point, 56.0));
  let fbm = dot(wn, vec3f(0.625, 0.25, 0.125));
  let pw = fbm + perlin * (1.0 - fbm);
  let wf = worleyFbm3(point, 8.0);
  let v = (pw - (wf - 1.0)) / (1.0 - (wf - 1.0));
  textureStore(outShape, id, vec4f(v, 0.0, 0.0, 1.0));
}
// 細部のノイズ（32^3）: Worley の fBm
@compute @workgroup_size(4, 4, 4) fn genDetail(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= vec3u(32u))) { return; }
  let point = vec3f((f32(id.x) + 0.5) / 32.0, (f32(id.y) + 0.5) / 32.0, f32(id.z) / 32.0);
  textureStore(outDetail, id, vec4f(worleyFbm3(point, 2.0), 0.0, 0.0, 1.0));
}
fn worleyOct(point: vec3f, freq0: f32, amp0: f32) -> f32 {
  var f = freq0;
  var a = amp0;
  var n = 0.0;
  for (var i = 0; i < 4; i++) {
    n += a * (1.0 - worley(point, f));
    f *= 2.0;
    a *= 0.95;
  }
  return n;
}
// 天気（512^2）: r 低い雲、g 中くらいの雲（takram の層 1）、b 高い雲、a なし
@compute @workgroup_size(8, 8) fn genWeather(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(512u))) { return; }
  let point = vec3f((f32(id.x) + 0.5) / 512.0, (f32(id.y) + 0.5) / 512.0, 0.0);
  let g = smoothstep(1.0, 1.4, worleyOct(point + vec3f(0.5), 8.0, 0.4));
  let r = clamp(smoothstep(0.8, 1.4, worleyOct(point, 16.0, 0.4)) - g, 0.0, 1.0);
  let b = smoothstep(-0.5, 0.5, perlinFbm(point, vec3f(6.0, 12.0, 1.0), 8));
  textureStore(outWeather, id.xy, vec4f(r, g, b, 1.0));
}
fn perlin3d(p: vec3f) -> vec3f {
  return vec3f(perlinFbm(p, vec3f(12.0), 3), perlinFbm(p.yzx + vec3f(-19.1, 33.4, 47.2), vec3f(12.0), 3),
               perlinFbm(p.zxy + vec3f(74.2, -124.5, 99.4), vec3f(12.0), 3));
}
// 渦（128^2）: Perlin ノイズのカール
@compute @workgroup_size(8, 8) fn genTurb(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(128u))) { return; }
  let p = vec3f((f32(id.x) + 0.5) / 128.0, (f32(id.y) + 0.5) / 128.0, 0.0);
  let dl = 0.1;
  let px0 = perlin3d(p - vec3f(dl, 0.0, 0.0));
  let px1 = perlin3d(p + vec3f(dl, 0.0, 0.0));
  let py0 = perlin3d(p - vec3f(0.0, dl, 0.0));
  let py1 = perlin3d(p + vec3f(0.0, dl, 0.0));
  let pz0 = perlin3d(p - vec3f(0.0, 0.0, dl));
  let pz1 = perlin3d(p + vec3f(0.0, 0.0, dl));
  let c = vec3f(py1.z - py0.z - pz1.y + pz0.y, pz1.x - pz0.x - px1.z + px0.z, px1.y - px0.y - py1.x + py0.x) / (2.0 * dl);
  textureStore(outTurb, id.xy, vec4f(0.5 * normalize(c) + 0.5, 1.0));
}
`;
