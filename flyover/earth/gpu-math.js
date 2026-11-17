// WebGPU 版のビューア（gpu.html）の数学。位置は地球の中心を原点にした座標（ECEF、m）で、倍精度（JavaScript の数）で
// 計算する。GPU にはカメラを原点にした値だけを渡す（遠くでも震えない）
'use strict';
const GM = (() => {
  const A = 6378137, B = 6356752.314245179, E2 = 1 - (B * B) / (A * A);
  const RAD = Math.PI / 180;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => mul(a, 1 / len(a));
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));
  function ecef(lat, lon, h) {        // ラジアン
    const s = Math.sin(lat), c = Math.cos(lat), n = A / Math.sqrt(1 - E2 * s * s);
    return [(n + h) * c * Math.cos(lon), (n + h) * c * Math.sin(lon), (n * (1 - E2) + h) * s];
  }
  function geodetic(p) {               // Bowring の式。[緯度, 経度, 高さ]（ラジアン, m）
    const [x, y, z] = p, r = Math.hypot(x, y), ep2 = (A * A - B * B) / (B * B);
    const th = Math.atan2(z * A, r * B);
    const lat = Math.atan2(z + ep2 * B * Math.sin(th) ** 3, r - E2 * A * Math.cos(th) ** 3);
    const s = Math.sin(lat), n = A / Math.sqrt(1 - E2 * s * s);
    const h = Math.abs(Math.cos(lat)) > 1e-6 ? r / Math.cos(lat) - n : Math.abs(z) - B;
    return [lat, Math.atan2(y, x), h];
  }
  function enu(p) {                    // その地点の東・北・上
    const [lat, lon] = geodetic(p);
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const east = [-Math.sin(lon), Math.cos(lon), 0];
    return { east, north: cross(up, east), up };
  }
  // 軸 k（単位）のまわりに角 a だけ回す（ロドリゲスの式）
  function rot(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
  }
  // 楕円体（高さ h だけふくらませたもの）と光線の交点。なければ null
  function hitEllipsoid(o, d, h = 0) {
    const a = A + h, b = B + h;
    const O = [o[0] / a, o[1] / a, o[2] / b], D = [d[0] / a, d[1] / a, d[2] / b];
    const qa = dot(D, D), qb = 2 * dot(O, D), qc = dot(O, O) - 1, disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;
    const t = (-qb - Math.sqrt(disc)) / (2 * qa);
    return t > 0 ? add(o, mul(d, t)) : null;
  }
  // 列優先の 4 x 4（Float64Array）
  function mat4mul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }
  function mat4inv(a) {
    const o = new Float64Array(16);
    const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
    const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
    const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
    const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
    o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
    o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
    o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
    o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
    o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
    o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
    o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
    return o;
  }
  const mercLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / RAD;   // 度

  // 太陽の方位（北から時計回り）と高さ [°]。NOAA の近似式（0.1° ほどの精度。今のビューアと同じ）
  function sunAt(ts, lat, lon) {
    const rad = RAD, jd = ts / 86400 + 2440587.5, T = (jd - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * rad, e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Cc = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M) * (0.019993 - 0.000101 * T) + Math.sin(3 * M) * 0.000289;
    const om = (125.04 - 1934.136 * T) * rad;
    const lam = (L0 + Cc - 0.00569 - 0.00478 * Math.sin(om)) * rad;
    const eps = (23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(om)) * rad;
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), y = Math.tan(eps / 2) ** 2, l0 = L0 * rad;
    const eqt = 4 / rad * (y * Math.sin(2 * l0) - 2 * e * Math.sin(M) + 4 * e * y * Math.sin(M) * Math.cos(2 * l0)
      - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * M));
    const tst = (((ts % 86400) / 60 + eqt + 4 * lon) % 1440 + 1440) % 1440;
    const ha = (tst / 4 - 180) * rad, la = lat * rad;
    const el = Math.asin(clamp(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha), -1, 1));
    const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) / rad + 180;
    return [(az + 360) % 360, el / rad];
  }
  return { A, B, E2, RAD, add, sub, mul, dot, cross, len, norm, clamp, lerp3, ecef, geodetic, enu, rot, hitEllipsoid,
    mat4mul, mat4inv, mercLat, sunAt };
})();
