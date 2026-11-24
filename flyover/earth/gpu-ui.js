// WebGPU 版のビューア（gpu.html）の操作と画面の部品。今のビューア（earth.js）の操作（Google Earth に合わせたもの）、
// ボタン、下の帯、URL、検索、スクリーンショットを、gpu-render.js のカメラ（GE.cam）で動くように移したもの。
// Cesium に任せていた操作（左ドラッグで動かす、Ctrl + ドラッグで見回す、右ドラッグとホイールで寄る、慣性）も自前で行う
'use strict';
GE.ready.then(GE => {
if (!GE) return;
const { RAD, add, sub, mul, dot, cross, len, norm, clamp, lerp3, ecef, geodetic, enu, rot, hitEllipsoid } = GM;
const { cam, cfg, canvas } = GE;
const $ = id => document.getElementById(id);
// 下の帯とスクリーンショットの出典。夜景では道路の街灯に OpenStreetMap のデータを使う（ODbL。表記が要る）
const CREDITS = '画像・3D © Apple' + (cfg.r3d && new URLSearchParams(location.search).get('light') === 'night'
  ? '、道路 © OpenStreetMap contributors、夜の明るさ NASA Black Marble' : '');

// ---------------------------------------------------------------- 視点の計算

let camVersion = 0;               // カメラを動かすたびに増やす（カーソルの下の点を使い回してよいかに使う）
function changed() { camVersion++; GE.redraw(); scheduleHash(); }
const saveCamera = () => ({ pos: cam.pos.slice(), dir: cam.dir.slice(), up: cam.up.slice() });
function restoreCamera(s) { cam.pos = s.pos; cam.dir = s.dir; cam.up = s.up; changed(); }
// 地面（地形）の楕円体高。分からなければ undefined
function groundAt(p) {
  const [lat, lon] = geodetic(p);
  return GE.heightAt(lat / RAD, lon / RAD);
}
function underground() {
  const h = groundAt(cam.pos);
  return h !== undefined && geodetic(cam.pos)[2] < h + 1;
}
function altitude() {
  const h = groundAt(cam.pos);
  return Math.max(1, geodetic(cam.pos)[2] - (h === undefined ? 0 : h));
}
// 点 at から見たカメラの向き（東・北・上で）と距離
function orbitState(at) {
  const { east, north, up } = enu(at);
  const pitch = Math.asin(clamp(dot(cam.dir, up), -1, 1));
  const h = Math.hypot(dot(cam.dir, east), dot(cam.dir, north)) > 1e-3
    ? Math.atan2(dot(cam.dir, east), dot(cam.dir, north)) : Math.atan2(dot(cam.up, east), dot(cam.up, north));
  return { heading: h, pitch, range: len(sub(at, cam.pos)) };
}
// at を見る向き（heading, pitch）で、距離 range の所にカメラを置く（Cesium の lookAt と同じ）
function lookAt(at, heading, pitch, range) {
  const { east, north, up } = enu(at);
  const fwd = add(mul(east, Math.sin(heading)), mul(north, Math.cos(heading)));
  const dir = norm(add(mul(fwd, Math.cos(pitch)), mul(up, Math.sin(pitch))));
  const right = add(mul(east, Math.cos(heading)), mul(north, -Math.sin(heading)));
  cam.dir = dir; cam.up = norm(cross(right, dir)); cam.pos = sub(at, mul(dir, range));
  changed();
}
// カメラの位置で、向きを heading, pitch に
function setOrientation(heading, pitch) {
  const { east, north, up } = enu(cam.pos);
  const fwd = add(mul(east, Math.sin(heading)), mul(north, Math.cos(heading)));
  cam.dir = norm(add(mul(fwd, Math.cos(pitch)), mul(up, Math.sin(pitch))));
  cam.up = norm(cross(add(mul(east, Math.cos(heading)), mul(north, -Math.sin(heading))), cam.dir));
  changed();
}
function headingPitch() {
  const { east, north, up } = enu(cam.pos);
  const pitch = Math.asin(clamp(dot(cam.dir, up), -1, 1));
  const heading = Math.hypot(dot(cam.dir, east), dot(cam.dir, north)) > 1e-3
    ? Math.atan2(dot(cam.dir, east), dot(cam.dir, north)) : Math.atan2(dot(cam.up, east), dot(cam.up, north));
  return { heading, pitch };
}
const MAX_PITCH = -0.02;     // 傾けても地平線より上は見上げない
function orbitTo(at, heading, pitch, range) {
  const before = saveCamera();
  lookAt(at, heading, pitch, range);
  if (underground()) restoreCamera(before);
}
function orbitBy(at, dHeading, dPitch) {
  if (!at) {           // 空を見ている: その場で向きを変える
    const s = headingPitch();
    setOrientation(s.heading + dHeading, clamp(s.pitch + dPitch, -Math.PI / 2, 0.3));
    return;
  }
  const s = orbitState(at);
  const lo = Math.min(-Math.PI / 2, s.pitch), hi = Math.max(MAX_PITCH, s.pitch);
  orbitTo(at, s.heading + dHeading, clamp(s.pitch + dPitch, lo, hi), s.range);
}
// 地球の中心のまわりにカメラを回す
function rotateCamera(k, a) {
  cam.pos = rot(cam.pos, k, a); cam.dir = norm(rot(cam.dir, k, a)); cam.up = norm(rot(cam.up, k, a));
  changed();
}
// 画面の向きに沿って地面の上を動かす
function panBy(forward, right) {
  const up = enu(cam.pos).up;
  let f = sub(cam.dir, mul(up, dot(cam.dir, up)));
  if (len(f) < 0.2) f = sub(cam.up, mul(up, dot(cam.up, up)));    // 真下を見ている: 画面の上方向を前に
  f = norm(f);
  const r = cross(f, up), move = add(mul(f, forward), mul(r, right)), dist = len(move);
  if (dist === 0) return;
  rotateCamera(norm(cross(up, move)), dist / len(cam.pos));
}
// カメラから at までの距離を factor 倍に（向きは保つ）
function zoomAround(at, factor) {
  const before = saveCamera();
  const pos = add(at, mul(sub(cam.pos, at), factor));
  if (len(sub(pos, at)) < 1 && factor < 1) return;
  cam.pos = pos; changed();
  if (underground()) restoreCamera(before);
}

// ---------------------------------------------------------------- カーソルの下の点

// 建物も含めた点は、カーソルを動かすと少しあとに届く（GE.pickAsync）。届いた点は、カメラを動かすまで使い回す。
// すぐに要るとき（ドラッグを始めたとき）は、それがカーソルの近くにあれば使い、なければ地形だけで探す
let hover = null;          // { x, y, ver, r }
function pickNow(x, y) {
  if (hover && hover.ver === camVersion && Math.hypot(hover.x - x, hover.y - y) < 8 && hover.r) return hover.r;
  const p = GE.pickTerrain(x, y);
  return p ? { p, onGlobe: true } : null;
}
function center() { return [canvas.clientWidth / 2, canvas.clientHeight / 2]; }
function pivot() { const r = pickNow(...center()); return r && r.p; }
let hoverAt = 0, hoverWait = false;
function requestHover(x, y) {
  if (hoverWait) return;
  hoverWait = true;
  const ver = camVersion;
  GE.pickAsync(x, y).then(r => { hoverWait = false; hover = { x, y, ver, r }; });
}

// ---------------------------------------------------------------- 動き（アニメーション・慣性）

let anim = null;      // { update(t), start, duration }
const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
function animate(duration, update) { anim = { start: performance.now(), duration, update }; }
let spin = null;      // 動かしたあとの慣性 { axis, w（rad/s） }
let zoomSpin = null;  // ホイールの慣性 { at, v（1 秒あたりの log 倍率） }
function stopAll() { anim = null; spin = null; zoomSpin = null; }
function resetView({ north = false, top = false, duration = 0.9 } = {}) {
  stopAll();
  const at = pivot();
  if (!at) {
    const s = headingPitch(), h0 = s.heading, p0 = s.pitch;
    const h1 = north ? 0 : h0, p1 = top ? -Math.PI / 2 : p0, dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
    animate(duration, t => { const k = ease(t); setOrientation(h0 + dh * k, p0 + (p1 - p0) * k); });
    return;
  }
  const s = orbitState(at);
  const h0 = s.heading, p0 = s.pitch, h1 = north ? 0 : h0, p1 = top ? -Math.PI / 2 : p0;
  const dh = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
  animate(duration, t => { const k = ease(t); lookAt(at, h0 + dh * k, p0 + (p1 - p0) * k, s.range); });
}
// カーソルの方へ寄る（factor < 1）・離れる（factor > 1）
function zoomTo(x, y, factor, duration = 0.5) {
  stopAll();
  const r = pickNow(x, y);
  if (!r) return;
  const at = r.p, from = cam.pos.slice(), dir = norm(sub(at, from)), dist = len(sub(at, from));
  const target = Math.max(dist * factor, 2);
  animate(duration, t => {
    const k = 1 - Math.pow(1 - t, 3);
    cam.pos = sub(at, mul(dir, dist - (dist - target) * k)); changed();
  });
}
// 場所へ飛ぶ（検索）。緯度・経度・高さを、途中で高く上がりながら動かす
function flyTo(lat, lon, h, heading, pitch, duration = 3) {
  stopAll();
  const [la0, lo0, h0] = geodetic(cam.pos), s = headingPitch();
  const la1 = lat * RAD, lo1 = lon * RAD;
  const dlo = Math.atan2(Math.sin(lo1 - lo0), Math.cos(lo1 - lo0));
  const dist = len(sub(ecef(la1, lo1, 0), ecef(la0, lo0, 0)));
  const peak = Math.max(0, Math.min(dist * 0.4, 8e6) - Math.max(h0, h) * 0.5);
  const dh = Math.atan2(Math.sin(heading - s.heading), Math.cos(heading - s.heading));
  animate(duration, t => {
    const k = ease(t);
    cam.pos = ecef(la0 + (la1 - la0) * k, lo0 + dlo * k, h0 + (h - h0) * k + peak * Math.sin(Math.PI * k));
    setOrientation(s.heading + dh * k, s.pitch + (pitch - s.pitch) * k);
  });
}

// ---------------------------------------------------------------- マウス

const sel = e => [e.offsetX, e.offsetY];
let drag = null;
canvas.addEventListener('pointerdown', e => {
  stopAll();
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = sel(e);
  if (e.button === 2) {                 // 右ドラッグ = 寄る・離れる（右ダブルクリック = 離れる）
    const now = performance.now();
    if (lastRight && now - lastRight.t < 350 && Math.hypot(x - lastRight.x, y - lastRight.y) < 6) { zoomTo(x, y, 2); lastRight = null; return; }
    lastRight = { t: now, x, y };
    const r = pickNow(x, y);
    drag = { kind: 'zoom', x, y, at: r && r.p };
  } else if ((e.button === 0 && e.shiftKey) || e.button === 1) {   // Shift + ドラッグ・中ボタン = 回転と傾き
    if (GE.mode2D) return;
    drag = { kind: 'orbit', x, y, at: pivot() };
    e.preventDefault();
  } else if (e.button === 0 && e.ctrlKey) {                         // Ctrl + ドラッグ = 見回す
    if (GE.mode2D) return;
    drag = { kind: 'look', x, y };
  } else if (e.button === 0) {                                      // ドラッグ = 移動（つかんだ点がカーソルについてくる）
    const r = pickNow(x, y);
    drag = { kind: 'pan', x, y, grab: r && r.p, h: r ? geodetic(r.p)[2] : 0, moves: [] };
  }
});
canvas.addEventListener('pointermove', e => {
  const [x, y] = sel(e);
  mouse = [x, y]; mouseMoved = true;
  if (!drag) return;
  const dx = x - drag.x, dy = y - drag.y;
  drag.x = x; drag.y = y;
  if (drag.kind === 'orbit') orbitBy(drag.at, dx * 0.006, -dy * 0.005);
  else if (drag.kind === 'look') {
    const s = headingPitch();
    setOrientation(s.heading - dx * 0.003, clamp(s.pitch + dy * 0.003, -Math.PI / 2, Math.PI / 2 - 0.01));
  } else if (drag.kind === 'zoom') {
    if (drag.at) zoomAround(drag.at, Math.exp(dy * 0.006));
  } else if (drag.kind === 'pan' && drag.grab) {
    const now = hitEllipsoid(cam.pos, GE.rayAt(x, y, canvas.clientWidth, canvas.clientHeight), drag.h);
    if (!now) return;
    const a = norm(now), b = norm(drag.grab), axis = cross(a, b), s = len(axis);
    if (s < 1e-12) return;
    const ang = Math.atan2(s, dot(a, b)), k = mul(axis, 1 / s);
    rotateCamera(k, ang);
    drag.moves.push({ t: performance.now(), k, ang });
    if (drag.moves.length > 6) drag.moves.shift();
  }
});
canvas.addEventListener('pointerup', () => {
  // 動かしていた向きに少し動き続ける（直近 80 ms の動きの速さ）
  if (drag && drag.kind === 'pan' && drag.moves.length) {
    const now = performance.now(), recent = drag.moves.filter(m => now - m.t < 80);
    if (recent.length >= 2) {
      const span = (recent[recent.length - 1].t - recent[0].t) / 1000 || 0.016;
      let sum = [0, 0, 0];
      for (const m of recent) sum = add(sum, mul(m.k, m.ang));
      const w = len(sum) / span;
      if (w > 1e-7) spin = { axis: norm(sum), w };
    }
  }
  drag = null;
});
canvas.addEventListener('pointerleave', () => { mouse = null; $('cursor').textContent = ''; });
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
let lastRight = null;
canvas.addEventListener('dblclick', e => zoomTo(...sel(e), 0.5));
// ホイール = カーソルの方へ寄る・離れる（少しなめらかに）。Shift + ホイール = 傾き
let wheelPivot = null;
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  anim = null; spin = null;
  const [x, y] = sel(e), now = performance.now();
  if (e.shiftKey) {
    if (GE.mode2D) return;
    const d = e.deltaY || e.deltaX;
    if (!wheelPivot || now - wheelPivot.at > 400) wheelPivot = { p: pivot() };
    wheelPivot.at = now;
    orbitBy(wheelPivot.p, 0, -Math.sign(d) * 0.06);
    return;
  }
  const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  const r = pickNow(x, y);
  if (!r) { cam.pos = add(cam.pos, mul(cam.dir, -d * altitude() * 0.002)); changed(); return; }
  if (!zoomSpin || len(sub(zoomSpin.at, r.p)) > 1) zoomSpin = { at: r.p, v: 0 };
  zoomSpin.v += d * 0.002;             // 1 目盛り（100）で 2 割ほど。0.125 秒ほどかけて寄る
}, { passive: false });

// ---------------------------------------------------------------- キーボード

const held = new Map();
let alt = false, keyPivot;
function keyAction(e) {
  const s = e.shiftKey;
  switch (e.key) {
    case 'ArrowUp': return s ? 'tiltUp' : 'panUp';
    case 'ArrowDown': return s ? 'tiltDown' : 'panDown';
    case 'ArrowLeft': return s ? 'rotLeft' : 'panLeft';
    case 'ArrowRight': return s ? 'rotRight' : 'panRight';
    case 'PageUp': return s ? 'altUp' : 'zoomIn';
    case 'PageDown': return s ? 'altDown' : 'zoomOut';
    case '+': case '=': case ';': return 'zoomIn';
    case '-': case '_': return 'zoomOut';
  }
  return null;
}
addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, textarea')) {
    if (e.key === 'Escape') { e.target.blur(); hideResults(); }
    return;
  }
  if (e.ctrlKey || e.metaKey) return;
  alt = e.altKey;
  if (e.key === '/') { e.preventDefault(); searchInput.focus(); searchInput.select(); return; }
  if (e.key === '?') { toggleHelp(); return; }
  if (e.key === 'Escape') { toggleHelp(false); return; }
  const act = keyAction(e);
  if (act) {
    if (GE.mode2D && /^(tilt|rot)/.test(act)) return;
    e.preventDefault();
    if (!held.size) stopAll();
    held.set(e.code, act);
    return;
  }
  if (e.repeat) return;
  switch (e.key.toLowerCase()) {
    case 'n': resetView({ north: true }); break;
    case 'u': resetView({ top: true }); break;
    case 'r': resetView({ north: true, top: true }); break;
    case 'o': set2D(!GE.mode2D); break;
    case 'g': if (GE.atmosphere) setLook(GE.look() === 'apple' ? 'google' : 'apple'); break;
    case 'c': if (GE.cloudsAvailable) setClouds(!GE.clouds()); break;
    case 'p': screenshot(e.shiftKey ? '4k' : 'screen'); break;
    case ' ': e.preventDefault(); stopAll(); held.clear(); break;
  }
});
addEventListener('keyup', e => { alt = e.altKey; held.delete(e.code); });
addEventListener('blur', () => held.clear());
function keyTick(dt) {
  if (!held.size) { keyPivot = undefined; return; }
  const slow = alt ? 0.25 : 1, h = altitude();
  const need = () => keyPivot === undefined ? (keyPivot = pivot() || null) : keyPivot;
  for (const act of new Set(held.values())) {
    const pan = Math.max(h, 30) * 0.9 * dt * slow;
    switch (act) {
      case 'panUp': panBy(pan, 0); keyPivot = undefined; break;
      case 'panDown': panBy(-pan, 0); keyPivot = undefined; break;
      case 'panLeft': panBy(0, -pan); keyPivot = undefined; break;
      case 'panRight': panBy(0, pan); keyPivot = undefined; break;
      case 'rotLeft': orbitBy(need(), 1.0 * dt * slow, 0); break;
      case 'rotRight': orbitBy(need(), -1.0 * dt * slow, 0); break;
      case 'tiltUp': orbitBy(need(), 0, 0.7 * dt * slow); break;
      case 'tiltDown': orbitBy(need(), 0, -0.7 * dt * slow); break;
      case 'zoomIn': case 'zoomOut': {
        const k = Math.exp((act === 'zoomIn' ? -1.8 : 1.8) * dt * slow);
        if (need()) zoomAround(keyPivot, k);
        else { cam.pos = add(cam.pos, mul(cam.dir, (act === 'zoomIn' ? 1 : -1) * h * 1.5 * dt * slow)); changed(); }
        break;
      }
      case 'altUp': case 'altDown': {
        const before = saveCamera(), up = enu(cam.pos).up;
        cam.pos = add(cam.pos, mul(up, (act === 'altUp' ? 1 : -1) * Math.max(h, 20) * 1.2 * dt * slow)); changed();
        if (underground()) restoreCamera(before);
        keyPivot = undefined;
        break;
      }
    }
  }
}

// 毎コマ（描く前に GE が呼ぶ）。動きがあれば true（次のコマも描く）
GE.beforeFrame = dt => {
  if (anim) {
    const t = Math.min(1, (performance.now() - anim.start) / (anim.duration * 1000));
    const a = anim;
    a.update(t);
    if (t >= 1 && anim === a) anim = null;
  }
  keyTick(dt);
  if (spin) {
    rotateCamera(spin.axis, spin.w * dt);
    spin.w *= Math.pow(0.9, dt * 60 / 4);        // Cesium の inertiaTranslate 0.9 くらい
    if (spin.w * len(cam.pos) < 1 || spin.w < 1e-9) spin = null;
  }
  if (zoomSpin) {
    const step = zoomSpin.v * Math.min(1, dt * 8);
    zoomSpin.v -= step;
    zoomAround(zoomSpin.at, Math.exp(step));
    if (Math.abs(zoomSpin.v) < 1e-3) zoomSpin = null;
  }
  return !!(anim || held.size || spin || zoomSpin || drag);
};

// ---------------------------------------------------------------- ボタン

$('compass').onclick = () => resetView({ north: true });
$('zoom-in').onclick = () => zoomTo(...center(), 0.5, 0.4);
$('zoom-out').onclick = () => zoomTo(...center(), 2, 0.4);
$('help-btn').onclick = () => toggleHelp();
const helpEl = $('help');
function toggleHelp(show = helpEl.hidden) { helpEl.hidden = !show; }
helpEl.addEventListener('click', e => { if (e.target === helpEl || e.target.closest('.close')) toggleHelp(false); });
// 2D: 真上から見て、Flyover を隠し、傾けられないようにする
const dimBtn = $('dim-btn');
function set2D(on) {
  GE.mode2D = on;
  dimBtn.textContent = on ? '2D' : '3D';
  GE.redraw();
  if (on) resetView({ top: true });
}
dimBtn.onclick = () => set2D(!GE.mode2D);
// 色合い（A: Apple マップ、G: 大気あり）
const lookBtn = $('look-btn');
function setLook(name) {
  GE.setLook(name);
  lookBtn.textContent = name === 'apple' ? 'A' : 'G';
  lookBtn.title = `色合い: ${name === 'apple' ? 'Apple マップ（大気なし）' : '大気あり'}（G で切り替え）`;
}
lookBtn.onclick = () => setLook(GE.look() === 'apple' ? 'google' : 'apple');
lookBtn.hidden = !GE.atmosphere;
setLook(GE.look());
// 雲（出す・消す）。?clouds=0 では雲の仕組みがないので、ボタンも出さない。始めはボタンの見た目だけ合わせる
// （ブラウザーに書き込まない）
const cloudBtn = $('cloud-btn');
function showClouds(on) {
  cloudBtn.style.opacity = on ? '1' : '0.45';
  cloudBtn.title = `雲: ${on ? '出す' : '消す'}（C で切り替え）`;
}
function setClouds(on) { GE.setClouds(on); showClouds(on); }
cloudBtn.onclick = () => setClouds(!GE.clouds());
cloudBtn.hidden = !GE.cloudsAvailable;
if (GE.cloudsAvailable) showClouds(GE.clouds());

// スクリーンショット: 地球儀と 3D だけを PNG で保存する。大きさは今の画面か、HD・2K・4K。右下に出典を入れる
const SHOT_SIZES = { screen: null, hd: [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160] };
async function screenshot(key = 'screen') {
  if (GE.shooting()) return;
  const dpr = devicePixelRatio || 1;
  const size = SHOT_SIZES[key] || [Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr)];
  const c = await GE.shot(size[0], size[1]);
  const g = c.getContext('2d');
  const s = Math.max(1, c.height / 900), text = CREDITS;
  g.font = `${Math.round(12 * s)}px system-ui, sans-serif`;
  const w = g.measureText(text).width, pad = 6 * s;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(c.width - w - 3 * pad, c.height - 26 * s, w + 2 * pad, 20 * s);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, c.width - w - 2 * pad, c.height - 16 * s);
  const m = location.hash.slice(1).split(',');
  const t = new Date(), p = n => String(n).padStart(2, '0');
  const name = `flyover_${m.length >= 2 ? m[0] + '_' + m[1] + '_' : ''}${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}.png`;
  c.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}
const shotMenu = $('shot-menu');
$('shot-btn').onclick = () => { shotMenu.hidden = !shotMenu.hidden; };
shotMenu.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  shotMenu.hidden = true;
  screenshot(b.dataset.size);
});

// ---------------------------------------------------------------- 下の帯

const fmt = (v, d = 0) => v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtDist = m => m >= 1000 ? fmt(m / 1000, m >= 10000 ? 0 : 1) + ' km' : fmt(m) + ' m';
const fmtLatLon = (la, lo) => `${fmt(Math.abs(la), 5)}°${la >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lo), 5)}°${lo >= 0 ? 'E' : 'W'}`;
function elevation(p, onGlobe) {
  const [la, lo, h] = geodetic(p);
  return h - GE.geoid(la / RAD, lo / RAD) + (onGlobe ? cfg.terrainDrop : 0);
}
$('credits').textContent = CREDITS;
let mouse = null, mouseMoved = false, shownRender = -1, shownVer = -1, cursorAt = 0, movedAt = 0, cursorRough = false;
const STILL_MS = 300;
function capturedAtCenter() {
  if (!cfg.r3d || GE.mode2D || GE.rawMode === 'c3m') return '';     // 時刻は新しい Flyover のもの（?c3m=1 の古い Flyover には出さない）
  const p = GE.pickTerrain(...center());
  if (!p) return '';
  const [la, lo] = geodetic(p).map(v => v / RAD);
  const key = GE.z20Key(la, lo);
  if (!GE.capturedKnown.has(key)) GE.capturedOf(key).then(() => { mouseMoved = true; });
  const ts = GE.capturedKnown.get(key);
  if (!ts) return '';
  const d = new Date((ts + lo / 15 * 3600) * 1000);
  return `撮影 ${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
setInterval(() => {
  $('loading').hidden = !(GE.pending() > 0 || GE.shooting());
  const rendered = GE.rendered();
  if (rendered === shownRender && !mouseMoved && !cursorRough) return;
  shownRender = rendered;
  const now = performance.now();
  const camMoved = camVersion !== shownVer;
  const moved = mouseMoved || camMoved;
  if (moved) movedAt = now;
  // カメラかマウスが動いている間（止まって STILL_MS たつまで）は、カーソルの下を地形だけで調べ、止まったら建物まで含めて
  // 調べ直す（建物を含めるのは 1 画素を描き直すので、GPU を待たずに少しあとに届く）
  const rough = now - movedAt < STILL_MS;
  const refresh = moved || (cursorRough && !rough) || now - cursorAt > 1000;
  if (refresh) { cursorRough = rough; shownVer = camVersion; cursorAt = now; }
  mouseMoved = false;
  const { heading } = headingPitch();
  $('needle').style.transform = `rotate(${-heading / RAD}deg)`;
  const [cla, clo, ch] = geodetic(cam.pos);
  $('camera').textContent = 'カメラ ' + fmtDist(ch - GE.geoid(cla / RAD, clo / RAD));
  if (refresh) $('date').textContent = capturedAtCenter();
  if (mouse && refresh) {
    const show = r => {
      if (!mouse) return;
      if (!r) { $('cursor').textContent = ''; return; }
      const [la, lo] = geodetic(r.p).map(v => v / RAD);
      $('cursor').textContent = `${fmtLatLon(la, lo)}  標高 ${fmtDist(Math.round(elevation(r.p, r.onGlobe)))}`;
    };
    if (rough) { const p = GE.pickTerrain(...mouse); show(p ? { p, onGlobe: true } : null); }
    else { const [x, y] = mouse; requestHover(x, y); GE.pickAsync(x, y).then(show); }
  }
  // 縮尺（画面の下の方で 100 px が何 m か）。地形の上で測る
  if (refresh) {
    const y = canvas.clientHeight - 80, x = canvas.clientWidth / 2;
    const a = GE.pickTerrain(x - 50, y), b = a && GE.pickTerrain(x + 50, y);
    if (a && b) {
      const mpp = len(sub(a, b)) / 100, target = mpp * 90, p10 = 10 ** Math.floor(Math.log10(target));
      const nice = [5, 2, 1].map(m => m * p10).find(v => v <= target) || p10;
      $('scale').querySelector('b').textContent = fmtDist(nice);
      $('scale').querySelector('i').style.width = (nice / mpp).toFixed(0) + 'px';
      $('scale').hidden = false;
    } else $('scale').hidden = true;
  }
}, 150);
// カーソルを止めたら、その下の点（建物を含む）を先に探しておく（ドラッグを始めたときに使う）
setInterval(() => {
  if (mouse && !drag && performance.now() - movedAt > 120 && (!hover || hover.ver !== camVersion
      || Math.hypot(hover.x - mouse[0], hover.y - mouse[1]) > 4)) requestHover(...mouse);
}, 120);

// ---------------------------------------------------------------- URL に視点を残す

// #緯度,経度,高度m,方位h,傾きt（傾き 0 が真上から）。今のビューアと同じ
let hashTimer = 0, settingHash = false;
function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(viewToHash, 300); }
function viewToHash() {
  const [lat, lon, h] = geodetic(cam.pos), { heading, pitch } = headingPitch();
  settingHash = true;
  history.replaceState(null, '', '#' + [(lat / RAD).toFixed(6), (lon / RAD).toFixed(6), h.toFixed(0) + 'm',
    ((heading / RAD + 360) % 360).toFixed(1) + 'h', (90 + pitch / RAD).toFixed(1) + 't'].join(','));
  settingHash = false;
}
function hashToView() {
  const m = location.hash.slice(1).split(',').map(parseFloat);
  if (m.length < 3 || !m.slice(0, 3).every(Number.isFinite)) return false;
  GE.setView(m[0], m[1], m[2], m[3] || 0, m[4] || 0);
  camVersion++;
  return true;
}
if (!hashToView()) GE.setView(30, 138, 14e6, 0, 0);
addEventListener('hashchange', () => { if (!settingHash) hashToView(); });

// ---------------------------------------------------------------- 検索

const searchInput = $('q'), resultsEl = $('results');
const covered = new Set(cfg.coverage.map(([x, y]) => x + ',' + y));
const PLACES = [
  ['金沢 ひがし茶屋街', 36.5722, 136.6680], ['渋谷スクランブル交差点', 35.6595, 139.7005],
  ['東京タワー', 35.6586, 139.7454], ['東京駅', 35.6812, 139.7671], ['大阪城', 34.6873, 135.5262],
  ['京都駅', 34.9858, 135.7588], ['ニューヨーク ミッドタウン', 40.7580, -73.9855],
  ['ゴールデンゲートブリッジ', 37.8199, -122.4783], ['パリ エッフェル塔', 48.8584, 2.2945],
  ['ロンドン ウェストミンスター', 51.5007, -0.1246], ['ローマ コロッセオ', 41.8902, 12.4922],
  ['バルセロナ サグラダ・ファミリア', 41.4036, 2.1744], ['シドニー オペラハウス', -33.8568, 151.2153],
  ['ラスベガス ストリップ', 36.1147, -115.1728],
];
function isCovered(lat, lon) {
  const n = 2 ** 9, x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2 * n);
  return covered.has(x + ',' + y);
}
function hideResults() { resultsEl.hidden = true; }
function showList(title, items) {
  resultsEl.replaceChildren();
  if (title) { const h = document.createElement('h4'); h.textContent = title; resultsEl.append(h); }
  if (!items.length) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = '見つかりませんでした'; resultsEl.append(d); }
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    const [first, ...rest] = it.name.split(', ');
    b.textContent = first;
    if (isCovered(it.lat, it.lon)) { const s = document.createElement('span'); s.className = 'badge'; s.textContent = '3D'; b.append(s); }
    if (rest.length) { const s = document.createElement('small'); s.textContent = rest.join(', '); b.append(s); }
    b.onclick = () => { flyToPlace(it); hideResults(); searchInput.blur(); };
    resultsEl.append(b);
  }
  resultsEl.hidden = false;
}
// 場所の上に、大きさに合わせた距離で、北を上に（近ければ 40° 傾けて）
function flyToPlace({ lat, lon, bbox }) {
  let range = 1500;
  if (bbox && bbox.length === 4) {
    const [s, n, w, e] = bbox;
    const size = Math.max(len(sub(ecef(s * RAD, w * RAD, 0), ecef(n * RAD, e * RAD, 0))), 300);
    range = clamp(size * 1.1, 800, 3e6);
  }
  const ground = GE.geoid(lat, lon), tilt = range < 50e3 ? -40 : -90;
  const at = ecef(lat * RAD, lon * RAD, ground), { east, north, up } = enu(at), p = tilt * RAD;
  const dir = norm(add(mul(north, Math.cos(p)), mul(up, Math.sin(p))));
  const [la, lo, h] = geodetic(sub(at, mul(dir, range)));
  flyTo(la / RAD, lo / RAD, h, 0, p);
  void east;
}
searchInput.addEventListener('focus', () => {
  if (!searchInput.value) showList('Flyover（3D）のある場所の例',
    PLACES.filter(([, la, lo]) => isCovered(la, lo)).map(([name, lat, lon]) => ({ name, lat, lon })));
});
searchInput.addEventListener('input', () => { if (!searchInput.value) searchInput.dispatchEvent(new Event('focus')); });
document.addEventListener('pointerdown', e => { if (!e.target.closest('#search')) hideResults(); });
$('search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { flyToPlace({ lat: +m[1], lon: +m[2] }); hideResults(); searchInput.blur(); return; }
  showList('検索中…', []);
  resultsEl.querySelector('.empty').textContent = '検索中…';
  try {
    const res = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
    showList('検索結果', res);
    if (res.length) flyToPlace(res[0]);
  } catch (err) {
    showList('検索できませんでした', []);
  }
});

window.gpuEarth = { GE, resetView, zoomTo, flyToPlace, screenshot, set2D, setLook };   // コンソールから触る用
});
