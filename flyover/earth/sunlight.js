// Copyright (c) 2017 Eric Bruneton. All rights reserved.
// 表の引き方は Bruneton の precomputed_atmospheric_scattering（atmosphere/functions.glsl）と同じなので、そのライセンス
// （BSD 3-Clause。全文は atmosphere/LICENSE）に従う。
//
// ?light= の光を、大気の表から求める（両方のビューアで使う）。atmosphere.js のワーカーが計算した、太陽から
// 地面までの透けぐあいの表と、空から地面に届く光の表を CPU で引き、太陽の高さに応じた直射光と空の光を出す。
// 表のない間（計算中、?atmo=0、計算できないとき）は、ビューアの手で決めた値を使う
'use strict';
const SUNLIGHT = (() => {
  const BOTTOM = 6360, TOP = 6420, SUN_R = 0.00935 / 2;        // atmosphere.js と同じ（km）
  const SOLAR = [1.474, 1.8504, 1.91198];                     // 大気の上での太陽の光（680・550・440 nm）
  const RAD = Math.PI / 180;
  // 撮った写真の日かげは、日なたの R 0.10・G 0.15・B 0.17 倍ほど（線形の値）。ビューアのシェーダーと同じ値
  const SHADE = [0.10, 0.15, 0.17];
  const REF_EL = 45;          // 写真を撮ったときの太陽の高さとみなす値 [°]
  const ADAPT = 0.7;          // 明るさの変化をどれだけ打ち消すか（1 でカメラの自動露出のように全部、0 でそのまま）
  const MAX_GAIN = 4;

  // 表の一番下の行（地面の高さ）を、x（0〜1）で線形に引く
  const row0 = (a, w, x) => {
    const p = Math.min(Math.max(x, 0), 1) * (w - 1), i = Math.min(Math.floor(p), w - 2), f = p - i;
    return [0, 1, 2].map(c => a[i * 4 + c] * (1 - f) + a[(i + 1) * 4 + c] * f);
  };
  const smoothstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

  // 地面での、太陽の向きの光（光に垂直な面に当たる量）と、空の光（水平な面に当たる量）。el は太陽の高さ [°]
  function ground(data, el) {
    const mu = Math.sin(el * RAD);
    const H = Math.sqrt(TOP * TOP - BOTTOM * BOTTOM);
    const d = Math.max(-BOTTOM * mu + Math.sqrt(Math.max(BOTTOM * BOTTOM * (mu * mu - 1) + TOP * TOP, 0)), 0);
    const T = row0(data.transmittance, 256, (d - (TOP - BOTTOM)) / (H - (TOP - BOTTOM)));
    const seen = smoothstep(-SUN_R, SUN_R, mu);               // 地平線にかかった太陽の見えている割合
    return { sun: SOLAR.map((s, c) => s * T[c] * seen), sky: row0(data.irradiance, 64, mu * 0.5 + 0.5) };
  }

  // シェーダーの L = sky × 空の向き + sunColor × cos に入れる値。太陽が REF_EL のとき、水平な面の日なたが 1、
  // 日かげが SHADE になる（写真のまま）ようにそろえ、そこからの色と明るさの変化を大気から求める。
  // 夜（太陽が沈んでいる）は大気の光がほぼ 0 なので、ビューアは手で決めた値を使う
  function light(data, el) {
    const r = ground(data, REF_EL), x = ground(data, el);
    const sunColor = [0, 1, 2].map(c => (1 - SHADE[c]) * x.sun[c] / (r.sun[c] * Math.sin(REF_EL * RAD)));
    const sky = [0, 1, 2].map(c => SHADE[c] * x.sky[c] / r.sky[c]);
    // 明るさ（緑）の目安は、水平な面と太陽に向いた壁の平均（街では壁も多い。水平な面だけで合わせると、
    // 太陽が低いときに壁が明るくなりすぎる）
    const e = Math.max(el, 0) * RAD;
    const total = sunColor[1] * (Math.sin(e) + Math.cos(e)) / 2 + sky[1];
    const gain = Math.min(Math.pow(Math.max(total, 1e-6), -ADAPT), MAX_GAIN);
    return { sunColor: sunColor.map(v => v * gain), sky: sky.map(v => v * gain) };
  }
  return { ground, light };
})();
