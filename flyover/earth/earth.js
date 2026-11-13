// 地球儀のビューア。Cesium の地球儀に Apple の衛星画像と地形を貼り、Flyover のある所では
// 見ている範囲の Flyover のタイルを細かさを変えながら読み込む。操作は Google Earth に合わせる。
'use strict';
(async function () {
const C = Cesium;
const cfg = await (await fetch('/api/config')).json();

// ブラウザは同じホストへの同時接続を 6 本に絞るので、タイルはページと別の名前（サーバーが受けて
// いるループバックのアドレス）に振り分けて取りに行く。同じタイルはいつも同じアドレスから取る
// （ブラウザのキャッシュが効くように）
const hosts = (cfg.tileHosts || []).filter(h => h !== location.hostname);
const hostBase = k => hosts.length ? `${location.protocol}//${hosts[k % hosts.length]}:${location.port}` : '';

// ---------------------------------------------------------------- 地形

// サーバーが Apple の地形を地理座標のタイルに直したもの（65 x 65 の楕円体高 + 末尾に「これより
// 細かいものがない」印）。印のあるタイルより先は Cesium が自分で細かく割る。
class AppleTerrain {
  constructor() {
    this.tilingScheme = new C.GeographicTilingScheme();
    this.errorEvent = new C.Event();
    this.credit = undefined;
    this.hasWaterMask = false;
    this.hasVertexNormals = false;
    this.availability = undefined;
    this._error0 = C.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this.tilingScheme.ellipsoid, 65, this.tilingScheme.getNumberOfXTilesAtLevel(0));
  }
  get ready() { return true; }
  requestTileGeometry(x, y, level, request) {
    // ?v= は読み方を変えたときに上げる（ブラウザに覚えさせた古い地形を使わないように）
    const url = `${hostBase(x + y + level)}/api/terrain/${level}/${x}/${y}.bin?v=2`;
    const p = new C.Resource({ url, request }).fetchArrayBuffer();
    if (!p) return undefined;          // 混んでいるので後で
    return p.then(buf => {
      const a = new Float32Array(buf);
      return new C.HeightmapTerrainData({
        buffer: a.subarray(0, 65 * 65), width: 65, height: 65, childTileMask: a[65 * 65] ? 0 : 15 });
    });
  }
  getLevelMaximumGeometricError(level) { return this._error0 / (1 << level); }
  getTileDataAvailable() { return undefined; }
  loadTileDataAvailability() { return undefined; }
}

// ---------------------------------------------------------------- 地球儀

const viewer = new C.Viewer('globe', {
  baseLayer: new C.ImageryLayer(new C.UrlTemplateImageryProvider({
    url: hosts.length ? `${location.protocol}//{s}:${location.port}/api/sat/{z}/{x}/{y}.jpg` : '/api/sat/{z}/{x}/{y}.jpg',
    subdomains: hosts.length ? hosts : undefined, tilingScheme: new C.WebMercatorTilingScheme(),
    maximumLevel: 20, credit: new C.Credit('画像・3D © Apple', true),
  })),
  terrainProvider: new AppleTerrain(),
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false, projectionPicker: false, scene3DOnly: true,
  creditContainer: document.getElementById('credits'),
  msaaSamples: 4, useBrowserRecommendedResolution: false,
  // 止まっているときは描かない（カメラが動いたときと、読み込みや動きがあるときだけ描く）
  requestRenderMode: true, maximumRenderTimeChange: Infinity,
});
const scene = viewer.scene, camera = scene.camera, globe = scene.globe, canvas = scene.canvas;
const ellipsoid = C.Ellipsoid.WGS84;
globe.depthTestAgainstTerrain = true;
globe.maximumScreenSpaceError = 1.5;
globe.tileCacheSize = 150;
// 地球儀が 1 コマで読み込みを進める時間 [ms]（Cesium の既定は 5 ms）。既定では、画像が手元にあっても
// 300 枚ほど貼るのに 3 秒ほどかかり、3D の街が出そろった後まで地面が粗いままになる。公開された
// 設定がないので、内部の値を変える（なければ何もしない）
if (globe._surface && '_loadQueueTimeSlice' in globe._surface) globe._surface._loadQueueTimeSlice = 20;
globe.showGroundAtmosphere = true;
globe.baseColor = C.Color.fromCssColorString('#0b1a2e');
scene.highDynamicRange = false;
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);

// Google Earth の割り当て: ドラッグ = 移動、ホイールと右ドラッグ = 拡大、Ctrl + ドラッグ = 見回す。
// Shift + ドラッグと中ボタンのドラッグ（回転・傾き）は下で自前で扱う。
const ssc = scene.screenSpaceCameraController;
const T = C.CameraEventType, M = C.KeyboardEventModifier;
ssc.rotateEventTypes = T.LEFT_DRAG;
ssc.translateEventTypes = T.LEFT_DRAG;
ssc.zoomEventTypes = [T.RIGHT_DRAG, T.WHEEL, T.PINCH];
ssc.tiltEventTypes = [T.PINCH];
ssc.lookEventTypes = [{ eventType: T.LEFT_DRAG, modifier: M.CTRL }];
ssc.minimumZoomDistance = 1;
ssc.maximumZoomDistance = 4e7;
ssc.inertiaSpin = 0.9;
ssc.inertiaTranslate = 0.9;
ssc.inertiaZoom = 0.75;

// ---------------------------------------------------------------- 高さ（ジオイド）

function geoid(latDeg, lonDeg) {
  const g = cfg.geoid, rows = g.rows;
  const fy = C.Math.clamp((90 - latDeg) / g.step, 0, rows.length - 1.001);
  const fx = C.Math.clamp((C.Math.negativePiToPi(C.Math.toRadians(lonDeg)) / Math.PI * 180 + 180) / g.step,
    0, rows[0].length - 1.001);
  const y0 = Math.floor(fy), x0 = Math.floor(fx), ty = fy - y0, tx = fx - x0;
  const r0 = rows[y0], r1 = rows[y0 + 1];
  return (r0[x0] * (1 - tx) + r0[x0 + 1] * tx) * (1 - ty) + (r1[x0] * (1 - tx) + r1[x0 + 1] * tx) * ty;
}

// 地面（地形か Flyover）の高さ。見つからないか、ありえない値なら undefined。読み込み直後の
// 粗い地形では、何千 m も低い値が返ることがある
function groundHeight(carto) {
  const h = globe.getHeight(carto);
  if (h === undefined) return undefined;
  const g = geoid(C.Math.toDegrees(carto.latitude), C.Math.toDegrees(carto.longitude));
  return h > g - 500 && h < 9000 ? h : undefined;
}

// ---------------------------------------------------------------- 画面上の点を地面に

function pick(winPos, globeOnly) {
  // Flyover の建物（深度）と地形（光線）の近いほう。どちらも外れたら楕円体。深度を読むのは
  // GPU を待たせる（readPixels）ので、地形だけでよいときは globeOnly
  let depth, onGlobe = false;
  if (scene.pickPositionSupported && !globeOnly) {
    try { depth = scene.pickPosition(winPos); } catch (e) { depth = undefined; }
  }
  const ray = camera.getPickRay(winPos);
  const hit = ray && globe.pick(ray, scene);
  let p = depth;
  if (hit && (!depth || C.Cartesian3.distance(hit, camera.positionWC) <= C.Cartesian3.distance(depth, camera.positionWC) + 0.5)) {
    p = hit; onGlobe = true;
  }
  if (!p) { p = camera.pickEllipsoid(winPos, ellipsoid); onGlobe = !!p; }
  return p ? { p, onGlobe } : undefined;
}

function center() { return new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2); }
function pivot() { const r = pick(center()); return r && r.p; }

// ---------------------------------------------------------------- 視点の計算

const scratchM = new C.Matrix4();
// 点 at から見たカメラの向き（東・北・上）と距離
function orbitState(at) {
  const inv = C.Matrix4.inverseTransformation(C.Transforms.eastNorthUpToFixedFrame(at, ellipsoid, scratchM), new C.Matrix4());
  const d = C.Matrix4.multiplyByPointAsVector(inv, camera.directionWC, new C.Cartesian3());
  const u = C.Matrix4.multiplyByPointAsVector(inv, camera.upWC, new C.Cartesian3());
  const pitch = Math.asin(C.Math.clamp(d.z, -1, 1));
  const heading = Math.hypot(d.x, d.y) > 1e-3 ? Math.atan2(d.x, d.y) : Math.atan2(u.x, u.y);
  return { heading, pitch, range: C.Cartesian3.distance(at, camera.positionWC) };
}

function saveCamera() {
  return { p: camera.positionWC.clone(), d: camera.directionWC.clone(), u: camera.upWC.clone() };
}
function restoreCamera(s) {
  camera.setView({ destination: s.p, orientation: { direction: s.d, up: s.u } });
}
function underground() {
  const c = ellipsoid.cartesianToCartographic(camera.positionWC);
  if (!c) return false;
  const h = groundHeight(c);
  return h !== undefined && c.height < h + 1;
}

const MAX_PITCH = -0.02;     // 傾けても地平線より上は見上げない
// at を中心に、カメラの向きを heading, pitch に（距離は保つ）
function orbitTo(at, heading, pitch, range) {
  const before = saveCamera();
  camera.lookAt(at, new C.HeadingPitchRange(heading, pitch, range));
  camera.lookAtTransform(C.Matrix4.IDENTITY);
  if (underground()) restoreCamera(before);
}
function orbitBy(at, dHeading, dPitch) {
  if (!at) {           // 空を見ている: その場で向きを変える
    camera.setView({ orientation: { heading: camera.heading + dHeading,
      pitch: C.Math.clamp(camera.pitch + dPitch, -C.Math.PI_OVER_TWO, 0.3), roll: 0 } });
    return;
  }
  const s = orbitState(at);
  const lo = Math.min(-C.Math.PI_OVER_TWO, s.pitch), hi = Math.max(MAX_PITCH, s.pitch);
  orbitTo(at, s.heading + dHeading, C.Math.clamp(s.pitch + dPitch, lo, hi), s.range);
}

// 地球の中心のまわりにカメラを回して、画面の向きに沿って地面の上を動かす
function panBy(forward, right) {
  const pos = camera.positionWC;
  const up = ellipsoid.geodeticSurfaceNormal(pos, new C.Cartesian3());
  const f = C.Cartesian3.clone(camera.directionWC);
  C.Cartesian3.subtract(f, C.Cartesian3.multiplyByScalar(up, C.Cartesian3.dot(f, up), new C.Cartesian3()), f);
  if (C.Cartesian3.magnitude(f) < 0.2) {     // 真下を見ている: 画面の上方向を前にする
    C.Cartesian3.clone(camera.upWC, f);
    C.Cartesian3.subtract(f, C.Cartesian3.multiplyByScalar(up, C.Cartesian3.dot(f, up), new C.Cartesian3()), f);
  }
  C.Cartesian3.normalize(f, f);
  const r = C.Cartesian3.cross(f, up, new C.Cartesian3());
  const move = C.Cartesian3.add(C.Cartesian3.multiplyByScalar(f, forward, new C.Cartesian3()),
    C.Cartesian3.multiplyByScalar(r, right, new C.Cartesian3()), new C.Cartesian3());
  const dist = C.Cartesian3.magnitude(move);
  if (dist === 0) return;
  const axis = C.Cartesian3.normalize(C.Cartesian3.cross(up, move, new C.Cartesian3()), new C.Cartesian3());
  const R = C.Matrix3.fromQuaternion(C.Quaternion.fromAxisAngle(axis, dist / C.Cartesian3.magnitude(pos)));
  const rot = v => C.Matrix3.multiplyByVector(R, v, new C.Cartesian3());
  camera.setView({ destination: rot(pos), orientation: { direction: rot(camera.directionWC), up: rot(camera.upWC) } });
}

// カメラから at までの距離を factor 倍に（向きは保つ）
function zoomAround(at, factor) {
  const before = saveCamera();
  const pos = C.Cartesian3.lerp(at, camera.positionWC, factor, new C.Cartesian3());
  if (C.Cartesian3.distance(pos, at) < 1 && factor < 1) return;
  camera.setView({ destination: pos, orientation: { direction: camera.directionWC, up: camera.upWC } });
  if (underground()) restoreCamera(before);
}

function altitude() {
  const c = ellipsoid.cartesianToCartographic(camera.positionWC);
  const g = c && groundHeight(c);
  return c ? Math.max(1, c.height - (g === undefined ? 0 : g)) : 1;
}

// ---------------------------------------------------------------- 動き（アニメーション）

let anim = null;      // { update(t) を毎コマ呼ぶ, start, duration }
const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
function animate(duration, update) {
  anim = { start: performance.now(), duration, update };
}
function stopAll() {
  anim = null;
  camera.cancelFlight();
  for (const k of Object.keys(ssc)) {          // Cesium の慣性を止める
    if (k.startsWith('_lastInertia') && ssc[k]) ssc[k].inertiaEnabled = false;
  }
}

// 画面の中央の点を中心に、北を上に・真上からに戻す
function resetView({ north = false, top = false, duration = 0.9 } = {}) {
  stopAll();
  const at = pivot();
  if (!at) {
    camera.flyTo({ destination: camera.positionWC.clone(),
      orientation: { heading: north ? 0 : camera.heading, pitch: top ? -C.Math.PI_OVER_TWO : camera.pitch, roll: 0 },
      duration });
    return;
  }
  const s = orbitState(at);
  const h0 = s.heading, p0 = s.pitch;
  const h1 = north ? 0 : h0, p1 = top ? -C.Math.PI_OVER_TWO : p0;
  const dh = C.Math.negativePiToPi(h1 - h0);
  animate(duration, t => {
    const k = ease(t);
    camera.lookAt(at, new C.HeadingPitchRange(h0 + dh * k, p0 + (p1 - p0) * k, s.range));
    camera.lookAtTransform(C.Matrix4.IDENTITY);
  });
}

// カーソルの方へ寄る（factor < 1）・離れる（factor > 1）
function zoomTo(winPos, factor, duration = 0.5) {
  stopAll();
  const r = pick(winPos);
  if (!r) return;
  const at = r.p, from = camera.positionWC.clone(), d = camera.directionWC.clone(), u = camera.upWC.clone();
  const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(at, from, new C.Cartesian3()), new C.Cartesian3());
  const dist = C.Cartesian3.distance(at, from);
  const target = Math.max(dist * factor, 2);
  animate(duration, t => {
    const k = 1 - Math.pow(1 - t, 3);
    const along = dist - (dist - target) * k;
    const pos = C.Cartesian3.subtract(at, C.Cartesian3.multiplyByScalar(dir, along, new C.Cartesian3()), new C.Cartesian3());
    camera.setView({ destination: pos, orientation: { direction: d, up: u } });
  });
}

// ---------------------------------------------------------------- マウス

let orbitDrag = null;
canvas.addEventListener('pointerdown', e => {
  stopAll();
  if ((e.button === 0 && e.shiftKey) || e.button === 1) {
    if (mode2D) return;
    orbitDrag = { x: e.clientX, y: e.clientY, at: pivot(), id: e.pointerId };
    e.preventDefault();
  }
}, true);
addEventListener('pointermove', e => {
  if (!orbitDrag || e.pointerId !== orbitDrag.id) return;
  const dx = e.clientX - orbitDrag.x, dy = e.clientY - orbitDrag.y;
  orbitDrag.x = e.clientX; orbitDrag.y = e.clientY;
  orbitBy(orbitDrag.at, dx * 0.006, -dy * 0.005);
});
addEventListener('pointerup', e => { if (orbitDrag && e.pointerId === orbitDrag.id) orbitDrag = null; });
canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // 中ボタンの自動スクロールを止める

// Shift + ホイール = 傾き（Windows の Chrome は Shift + ホイールを横スクロール deltaX にする）
canvas.addEventListener('wheel', e => {
  stopAll();
  if (!e.shiftKey || mode2D) return;
  e.preventDefault();
  const d = e.deltaY || e.deltaX;
  orbitBy(pivot(), 0, -Math.sign(d) * 0.06);
}, { passive: false, capture: true });

canvas.addEventListener('dblclick', e => {
  zoomTo(new C.Cartesian2(e.offsetX, e.offsetY), 0.5);
});
// 右ダブルクリック = 離れる
let lastRight = null;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 2) return;
  const now = performance.now();
  if (lastRight && now - lastRight.t < 350 && Math.hypot(e.clientX - lastRight.x, e.clientY - lastRight.y) < 6) {
    zoomTo(new C.Cartesian2(e.offsetX, e.offsetY), 2);
    lastRight = null;
  } else {
    lastRight = { t: now, x: e.clientX, y: e.clientY };
  }
});
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ---------------------------------------------------------------- キーボード

const held = new Map();     // e.code -> 動作
let alt = false;
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
    if (mode2D && /^(tilt|rot)/.test(act)) return;
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
    case 'o': set2D(!mode2D); break;
    case 'p': screenshot(e.shiftKey ? '4k' : 'screen'); break;
    case ' ': e.preventDefault(); stopAll(); held.clear(); break;
  }
});
addEventListener('keyup', e => {
  alt = e.altKey;
  held.delete(e.code);
});
addEventListener('blur', () => held.clear());

function keyTick(dt) {
  if (!held.size) return;
  const slow = alt ? 0.25 : 1;
  const h = altitude();
  let at;
  const need = () => at === undefined ? (at = pivot() || null) : at;
  for (const act of new Set(held.values())) {
    const pan = Math.max(h, 30) * 0.9 * dt * slow;
    switch (act) {
      case 'panUp': panBy(pan, 0); break;
      case 'panDown': panBy(-pan, 0); break;
      case 'panLeft': panBy(0, -pan); break;
      case 'panRight': panBy(0, pan); break;
      case 'rotLeft': orbitBy(need(), 1.0 * dt * slow, 0); break;
      case 'rotRight': orbitBy(need(), -1.0 * dt * slow, 0); break;
      case 'tiltUp': orbitBy(need(), 0, 0.7 * dt * slow); break;
      case 'tiltDown': orbitBy(need(), 0, -0.7 * dt * slow); break;
      case 'zoomIn': case 'zoomOut': {
        const k = Math.exp((act === 'zoomIn' ? -1.8 : 1.8) * dt * slow);
        if (need()) zoomAround(at, k);
        else camera.moveForward((act === 'zoomIn' ? 1 : -1) * h * 1.5 * dt * slow);
        break;
      }
      case 'altUp': case 'altDown': {
        const before = saveCamera();
        const up = ellipsoid.geodeticSurfaceNormal(camera.positionWC, new C.Cartesian3());
        const pos = C.Cartesian3.add(camera.positionWC,
          C.Cartesian3.multiplyByScalar(up, (act === 'altUp' ? 1 : -1) * Math.max(h, 20) * 1.2 * dt * slow, up), new C.Cartesian3());
        camera.setView({ destination: pos, orientation: { direction: camera.directionWC, up: camera.upWC } });
        if (underground()) restoreCamera(before);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- ボタン

document.getElementById('compass').onclick = () => resetView({ north: true });
document.getElementById('zoom-in').onclick = () => zoomTo(center(), 0.5, 0.4);
document.getElementById('zoom-out').onclick = () => zoomTo(center(), 2, 0.4);
document.getElementById('help-btn').onclick = () => toggleHelp();
const helpEl = document.getElementById('help');
function toggleHelp(show = helpEl.hidden) { helpEl.hidden = !show; }
helpEl.addEventListener('click', e => { if (e.target === helpEl || e.target.closest('.close')) toggleHelp(false); });

// 2D: 真上から見て、Flyover を隠し、傾けられないようにする
let mode2D = false;
const dimBtn = document.getElementById('dim-btn');
function set2D(on) {
  mode2D = on;
  dirty = true;
  scene.requestRender();
  dimBtn.textContent = on ? '2D' : '3D';
  ssc.tiltEventTypes = on ? [] : [T.PINCH];
  ssc.lookEventTypes = on ? [] : [{ eventType: T.LEFT_DRAG, modifier: M.CTRL }];
  if (on) resetView({ top: true });
}
dimBtn.onclick = () => set2D(!mode2D);

// スクリーンショット: 地球儀と 3D だけ（ボタンなどは入らない）を PNG で保存する。大きさは今の画面か、
// HD・2K・4K。データは Apple のものなので、画面と同じ出典を右下に入れる。
// 新しい Flyover をきれいに写すため、写す間は画面の外のタイルを読まず、地球儀・地形・3D を読み終えて
// 落ち着くまで待つ（最大 90 秒）。大きな画面で描きながらだとモデルを作るのが遅い（1 コマごとに少しずつ
// 進む）ので、読み込みは写す大きさと同じ縦横比の小さな画面で、タイルの細かさだけ写す大きさに合わせて
// （lodScale 倍）行い、読み終えてから写す大きさにして描く。WebGL のキャンバスは描いた直後でないと
// 空なので、描いたとき（postRender）に写す
const SHOT_SIZES = { screen: null, hd: [1920, 1080], '2k': [2560, 1440], '4k': [3840, 2160] };
let shooting = false, lodScale = 1;
function waitSettled(limit) {
  const t0 = performance.now();
  let calm = 0;
  return new Promise(res => {
    const tick = () => {
      scene.requestRender();
      calm = pendingFly === 0 && globeQueue === 0 && globe.tilesLoaded ? calm + 1 : 0;
      if ((calm >= 10 && performance.now() - t0 > 500) || performance.now() - t0 > limit) res(); else setTimeout(tick, 100);
    };
    tick();
  });
}
async function screenshot(key = 'screen') {
  if (shooting) return;
  shooting = true;
  const size = SHOT_SIZES[key], el = viewer.container, old = viewer.resolutionScale, dpr = devicePixelRatio;
  const css = { width: el.style.width, height: el.style.height, right: el.style.right, bottom: el.style.bottom };
  const setSize = (w, h) => {
    Object.assign(el.style, { right: 'auto', bottom: 'auto', width: w + 'px', height: h + 'px' });
    viewer.resize();
  };
  try {
    let W, H;
    if (size) {
      const gl = scene.context._gl;
      const lim = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
      const f = Math.min(1, lim / Math.max(...size));
      W = Math.round(size[0] * f); H = Math.round(size[1] * f);
      viewer.resolutionScale = 1;
      // 読み込み: 画面に収まる大きさで（同じ縦横比）
      const s = Math.max(1, W / dpr / innerWidth, H / dpr / innerHeight);
      setSize(W / dpr / s, H / dpr / s);
      lodScale = s;
    }
    dirty = true;
    await waitSettled(90000);
    if (size) {
      // 写す大きさにする（タイルの細かさは同じ。地球儀の画像は細かいものを読むので、もう一度待つ）
      lodScale = 1;
      setSize(W / dpr, H / dpr);
      dirty = true;
      await waitSettled(30000);
    }
    await new Promise(res => {
      const remove = scene.postRender.addEventListener(() => { remove(); saveShot(); res(); });
      scene.requestRender();
    });
  } finally {
    lodScale = 1;
    dirty = true;
    Object.assign(el.style, css);
    viewer.resolutionScale = old;
    viewer.resize();
    scene.requestRender();
    shooting = false;
  }
}
function saveShot() {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0);
  const s = Math.max(1, c.height / 900), text = '画像・3D © Apple';
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
const shotMenu = document.getElementById('shot-menu');
document.getElementById('shot-btn').onclick = () => { shotMenu.hidden = !shotMenu.hidden; };
shotMenu.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  shotMenu.hidden = true;
  screenshot(b.dataset.size);
});

// ---------------------------------------------------------------- Flyover のある地域

const covered = new Set(cfg.coverage.map(([x, y]) => x + ',' + y));
function tileRect(z, x, y) {
  const n = 2 ** z, lat = j => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n)));
  return C.Rectangle.fromRadians(x / n * 2 * Math.PI - Math.PI, lat(y + 1), (x + 1) / n * 2 * Math.PI - Math.PI, lat(y));
}

// ---------------------------------------------------------------- Flyover のタイル

// ズーム 9 の地域から四分木をたどり、ズーム 13〜20 のタイルを、画面での大きさに応じて選ぶ。
// 子がそろうまでは親を表示する（穴が開かない）。画面で大きく見えるものから読む。
const FLY = { min: cfg.minZoom, max: cfg.maxZoom };
// 大きさは画面の実際の画素で決める（高精細な画面では細かいタイルを使う）。画像は 1 タイルに
// 512 px 角が 2 枚ほどなので、520 px ほどまでなら 1 段粗いタイルでも見た目はほとんど変わらない
const SHOW_PX = 175 / devicePixelRatio;     // ズーム 13 のタイルがこの幅（CSS px）より大きく見えたら出す
const REFINE_PX = 520 / devicePixelRatio;   // タイルがこの幅より大きく見えたら 1 段細かいものにする
// 同時に読み込む数。Apple は 1 枚 1 秒ほどかかるので並べるほど速いが、48 本ほどで回線（手元では
// 65 Mbps ほど）が埋まり、それ以上並べても 1 枚ごとの待ちが延びるだけ
const MAX_ACTIVE = 48;
const MAX_OFFSCREEN = 24;  // そのうち画面の外の先読みに使う数（見えているものの枠を空けておく）
const MAX_MODELS = 240;    // これを超えたら、しばらく使っていないものから捨てる（GPU のメモリを食うので）
const MAX_MODELS_SHOT = 600;   // スクリーンショットを写す間（4K では 240 では足りず、捨てては読み直す）
// 新しい Flyover の画像は、HEVC のまま受け取って GPU の専用回路で展開し（hevc.js）、Y と UV の面の
// ままテクスチャにする。サーバーで JPEG にする手間がなく、GPU のメモリも RGBA の 4 割ほどで済む。
// 専用回路で展開できない（Chrome は HEVC をソフトウェアでは展開しない）ときと ?hevc=0 のときは JPEG
let hevc = cfg.r3d && typeof VideoDecoder !== 'undefined' && new URLSearchParams(location.search).get('hevc') !== '0'
  && (await VideoDecoder.isConfigSupported({ codec: 'hvc1.3.E.L120.B0', hardwareAcceleration: 'prefer-hardware' })
    .catch(() => ({}))).supported === true;
const flyUrl = (t, h = hevc) => `${hostBase(t.x + t.y + 1)}/api/flyover/${t.z}/${t.x}/${t.y}.glb${h ? '?hevc=1' : ''}`;
const BOX_BUDGET = 4;      // 1 コマに地面の高さを調べてよいタイルの数
let boxBudget = BOX_BUDGET;
const flyover = scene.primitives.add(new C.PrimitiveCollection());
const tiles = new Map();
let frame = 0, active = 0, activeOff = 0;

class Tile {
  constructor(z, x, y) {
    this.z = z; this.x = x; this.y = y;
    this.rect = tileRect(z, x, y);
    this.width = this.rect.width * 6378137 * Math.cos(C.Rectangle.center(this.rect).latitude);
    this.state = 'none';     // none | loading | ready | empty | failed
    this.model = null; this.obb = null; this.used = 0; this.wanted = 0; this.wantedAt = 0; this.touched = 0;
    this.abort = null; this.failedAt = 0; this.pri = Infinity;
    this.mask = 0; this.clip = 0;   // 表示する 4 分の 1（0 は全部）と、モデルに今かけてある切り方
  }
  // 見えるかどうかを調べる箱（建物の高さまで含める）と、距離を測る薄い箱（地面のあたり）。
  // 厚い箱で距離を測ると、カメラが箱の中に入って距離が 0 になり、細かくしすぎる。
  // 読み込んだタイルは、見えるかどうかをモデルの実際の範囲で調べる
  box() { return this.model ? this.model.boundingSphere : this.boxes().tall; }
  flat() { return this.boxes().flat; }
  boxes() {
    // 地面の高さが取れたら、その箱をずっと使う。調べるのは重い（光線で地形と交わる所を探す）ので、
    // 粗いズーム 13・14 だけ、1 コマに BOX_BUDGET 個まで。それより細かいタイル（1 km 以下）は
    // 親の高さを使い、坂の分だけ箱を厚くする。取れないうち（地形がまだない）は仮の箱
    if (this.obb && (this.exact || boxBudget <= 0)) return this.obb;
    let ground = 0, exact = this.z < FLY.min, slope = 0;
    const p = this.parent;
    if (!exact && this.z >= FLY.min + 2 && p && p.exact && p.obb) {
      ground = p.ground; exact = true; slope = 250;
    } else if (!exact && boxBudget > 0) {
      boxBudget--;
      const h = groundHeight(C.Rectangle.center(this.rect));
      if (h !== undefined) { ground = h; exact = true; }
    }
    const tall = this.z < FLY.min || !exact ? [-200, 4500] : [ground - 150 - slope, ground + 900 + slope];
    this.obb = { tall: C.OrientedBoundingBox.fromRectangle(this.rect, tall[0], tall[1], ellipsoid),
                 flat: C.OrientedBoundingBox.fromRectangle(this.rect, ground - 30, ground + 60, ellipsoid) };
    this.exact = exact;
    this.ground = ground;
    return this.obb;
  }
  children() {
    if (!this.kids) {
      this.kids = [];
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) this.kids.push(tileAt(this.z + 1, this.x * 2 + i, this.y * 2 + j));
      for (const c of this.kids) c.parent = this;
    }
    return this.kids;
  }
  get settled() { return this.state === 'ready' || this.state === 'empty' || this.state === 'failed'; }
}
function tileAt(z, x, y) {
  const k = z + '/' + x + '/' + y;
  let t = tiles.get(k);
  if (!t) tiles.set(k, t = new Tile(z, x, y));
  return t;
}
const roots = cfg.coverage.map(([x, y]) => tileAt(9, x, y));
for (const r of roots) r.sphere = C.BoundingSphere.fromRectangle3D(r.rect, ellipsoid, 0);

// 飛んでいく先の粗いタイル（ズーム 13 と 15 の 3 x 3 枚）を、飛んでいる間に読んでおく
function prefetch(lat, lon, range) {
  if (range > 20e3 || mode2D) return;
  for (const z of [FLY.min, FLY.min + 2]) {
    const n = 2 ** z, x0 = Math.floor((lon + 180) / 360 * n);
    const y0 = Math.floor((1 - Math.asinh(Math.tan(C.Math.toRadians(lat))) / Math.PI) / 2 * n);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const t = tileAt(z, x0 + dx, y0 + dy);
      t.wantedAt = performance.now() + 3000;   // 着くまで（3 秒ほど）は、見えていなくても取りやめない
      if (t.state === 'none') load(t);
    }
  }
}

const loadLog = [];     // 読み込みにかかった時間（調べる用）
async function load(t, offscreen) {
  t.state = 'loading'; active++;
  if (offscreen) activeOff++;
  t.abort = new AbortController();
  const t0 = performance.now();
  try {
    const useHevc = hevc;
    const r = await fetch(flyUrl(t, useHevc), { signal: t.abort.signal });
    if (r.status === 204) { t.state = 'empty'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const t1 = performance.now();
    await makeModel(t, buf, useHevc);
    loadLog.push({ z: t.z, x: t.x, y: t.y, off: offscreen, at: t0, bytes: buf.length, fetch: t1 - t0, model: performance.now() - t1,
      hevc: t.hevcMs, hevcWork: t.hevcWork, cesium: t.cesiumMs, server: r.headers.get('Server-Timing') });
    if (loadLog.length > 500) loadLog.shift();
  } catch (e) {
    if (e.name === 'AbortError') { t.state = 'none'; }
    else if (e.retry) { t.state = 'none'; console.warn(e.retry, e); }
    else { t.state = 'failed'; t.failedAt = performance.now(); console.warn('Flyover', t.z, t.x, t.y, e); }
  } finally {
    active--; t.abort = null;
    if (offscreen) activeOff--;
    dirty = true;              // 選び直す
  }
}
// 展開は作業用のスレッド HEVC_WORKERS 本に 1 タイルずつ渡し、渡す順はそのときに選ぶ（届いた順に
// 渡すと、先に届いた画面の外のタイルや小さく見えるタイルの後ろで、見えているタイルが待たされる）。
// 今見えているものを先に、画面で大きく見えるもの（Tile#pri が小さいもの）から。梅田（HEVC）で、見えて
// いる範囲が出るまでが 1 本では 18 秒、2 本で 14 秒、3 本で 12 秒（6 本でも 12 秒。どれもコマを CPU に読み戻して
// いたころの数字）
const HEVC_WORKERS = 3;
const hevcWorkers = hevc ? Array.from({ length: HEVC_WORKERS }, () => ({ worker: new Worker('hevc.js'), job: null })) : [];
const hevcPending = [];
for (const w of hevcWorkers) w.worker.onmessage = ({ data }) => {
  const job = w.job;
  w.job = null;
  job.t.hevcWork = data.ms;
  data.error ? job.reject(new Error(data.error)) : job.resolve(data.out);
  hevcNext();
};
function hevcNext() {
  // しばらく（4 秒）要らなかったものは展開しない（読みかけを取りやめるのと同じ）
  const now = performance.now();
  for (let i = hevcPending.length - 1; i >= 0; i--) {
    if (now - hevcPending[i].t.wantedAt > 4000) hevcPending.splice(i, 1)[0].reject(new DOMException('要らなくなった', 'AbortError'));
  }
  const rank = ({ t }) => (t.vis && t.wanted === frame ? 0 : 1e9) + t.pri;
  for (const w of hevcWorkers) {
    if (w.job || !hevcPending.length) continue;
    let best = 0;
    for (let i = 1; i < hevcPending.length; i++) if (rank(hevcPending[i]) < rank(hevcPending[best])) best = i;
    w.job = hevcPending.splice(best, 1)[0];
    w.worker.postMessage({ id: 0, images: w.job.images, gpu: gpuTex && !seasonGlsl });
  }
}
// 展開したコマを CPU に読み戻さず、GPU の中でテクスチャにする（gpuPlanes）。季節の色では、写真の色を
// CPU で読むので読み戻す。?gpu=0 で、いつも読み戻す（比べる用）
// GPU の中で変換できなければ（gpuPlanes が失敗したら）、以後は読み戻す
let gpuTex = new URLSearchParams(location.search).get('gpu') !== '0';
const hevcDecode = (t, images) => new Promise((resolve, reject) => {
  hevcPending.push({ t, images, resolve, reject });
  hevcNext();
});

// glb の材質の extras.hevc（flyover/glb.py の tile_glb を見よ）から、HEVC の設定とコマを番号順に取り出す
function glbHevc(buf) {
  const jl = new DataView(buf.buffer, buf.byteOffset).getUint32(12, true);
  const g = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl)));
  const part = i => {
    const v = g.bufferViews[i], o = 28 + jl + (v.byteOffset || 0);
    return buf.slice(o, o + v.byteLength);
  };
  return g.materials.map(m => m.extras && m.extras.hevc).filter(Boolean).sort((a, b) => a.slab - b.slab)
    .map(h => ({ config: part(h.config), data: part(h.data) }));
}

// ?light=morning（朝）・evening（夕方）・cloudy（曇り）・night（夜）で、光の当たり方を変える。新しい Flyover の写真には
// 撮ったときの日なたと日かげが写っている。タイルには日の当たり方の画像（日なたが白、日かげが黒。glb の
// occlusionTexture）と、スプラットごとの日の当たり方（不透明度の下位 6 ビット）が入っているので（flyover/glb.py）、
// 日かげを明るくして影を取り除いた色（反射率）を求め、別の空の光と太陽で描き直す。面の向きは画面上の位置の変化から
// 求める。建物が落とす影は新しくは作らない（元の影を消すだけ）。日の当たり方のない所（パリなど）は日なたとみなす
const LIGHTS = {
  // sun: 太陽の方位（北から時計回り）と高さ [°]、sunColor: 太陽の光、sky: 空の光（上を向いた面に当たる量）
  morning: { sun: [100, 18], sunColor: [1.25, 1.05, 0.8], sky: [0.42, 0.5, 0.66] },
  evening: { sun: [255, 9], sunColor: [1.5, 0.78, 0.4], sky: [0.34, 0.3, 0.45] },
  cloudy: { sun: null, sky: [0.92, 0.95, 1.0] },
  night: { sun: null, sky: [0.07, 0.09, 0.17] },
  check: { check: true, sun: null, sky: [1, 1, 1] },   // 撮ったときの日なた（白）・日かげ（黒）をそのまま見る（確かめ用）
};
const light = cfg.r3d ? LIGHTS[new URLSearchParams(location.search).get('light')] : undefined;
const glslVec = v => `vec3(${v.map(x => x.toFixed(4)).join(', ')})`;
const lightGlsl = !light ? '' : (() => {
  const sun = light.sun && light.sun.map(d => d * Math.PI / 180);
  const sunENU = sun ? [Math.sin(sun[0]) * Math.cos(sun[1]), Math.cos(sun[0]) * Math.cos(sun[1]), Math.sin(sun[1])] : [0, 0, 1];
  return `
// color: 頂点の色（メッシュには頂点の色がなく、Cesium が白を入れる）
void lightApply(inout czm_modelMaterial material, vec3 pe, vec3 pw, vec4 color) {
  // 撮ったときの日なた（1）・日かげ（0）。メッシュは日の当たり方の画像、スプラットは不透明度の下位 6 ビット
  float lit = color == vec4(1.0) ? material.occlusion : mod(floor(color.a * 65535.0 + 0.5), 64.0) / 63.0;
  // 影を取り除いた色。日かげは日なたの R 0.10・G 0.15・B 0.17 倍ほど（線形の値。青い空の光だけが当たる）に写っている
  // （新しい Flyover の 67 枚の写真の、日の当たり方の画像が白い所と黒い所の中央値の比）
  vec3 albedo = material.diffuse / mix(vec3(0.10, 0.15, 0.17), vec3(1.0), clamp(lit, 0.0, 1.0));
  ${light.check ? 'material.diffuse = vec3(lit); return;' : ''}
  vec3 n = normalize(cross(dFdx(pe), dFdy(pe)));
  if (dot(n, pe) > 0.0) n = -n;                       // 見ている側を向ける（目の位置が原点）
  vec3 up = normalize(pw), east = normalize(cross(vec3(0.0, 0.0, 1.0), up)), north = cross(up, east);
  vec3 upE = normalize(czm_viewRotation * up);
  vec3 sunE = normalize(czm_viewRotation * (east * ${sunENU[0].toFixed(5)} + north * ${sunENU[1].toFixed(5)} + up * ${sunENU[2].toFixed(5)}));
  float sky = 0.65 + 0.35 * dot(n, upE);              // 上を向いた面ほど空の光が多い
  vec3 L = ${glslVec(light.sky)} * sky${light.sun ? ` + ${glslVec(light.sunColor)} * max(dot(n, sunE), 0.0)` : ''};
  material.diffuse = albedo * L;
}`;
})();

// ?season=sakura（桜）か ?season=momiji（紅葉）で、木（緑のスプラット）の色を変える。芝生などはメッシュの写真
// なので、スプラットだけを変えれば、おもに木が変わる（新宿御苑で、緑のスプラットのうち地面から 3 m 未満は 4%）。
// メッシュの写真は変えない。木の一部がメッシュでできている所（大手町の街路樹など）では、メッシュの緑が残るので、
// スプラットも変えずに木ごと緑のままにする（markTreeSplats）。古い Flyover を入れ直した地域（パリなど）には
// スプラットがないので、木も変わらない。色のむらは地球の座標から作るなめらかな雑音で決める（タイルの境目や
// 細かさが変わっても同じ。升目ごとにばらばらの色にすると、森で市松模様に見える）
const SEASONS = { sakura: 0, momiji: 1, check: 2 };   // check: スプラットの見分け方を色で見る（確かめ用）
const season = cfg.r3d ? SEASONS[new URLSearchParams(location.search).get('season')] : undefined;
const seasonGlsl = season === undefined ? '' : `
float seasonHash(vec3 p) {
  p = mod(p, 1024.0);              // 大きな数のまま sin に入れると精度が落ちて模様が崩れる
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}
// 升目の角の値をなめらかにつないだ雑音（0〜1）
float seasonNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(seasonHash(i), seasonHash(i + vec3(1, 0, 0)), f.x),
                 mix(seasonHash(i + vec3(0, 1, 0)), seasonHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(seasonHash(i + vec3(0, 0, 1)), seasonHash(i + vec3(1, 0, 1)), f.x),
                 mix(seasonHash(i + vec3(0, 1, 1)), seasonHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// 頂点の色の最下位ビットの印（markTreeSplats）
float seasonBit(float v) {
  return mod(floor(v * 65535.0 + 0.5), 2.0);
}
void seasonTint(inout czm_modelMaterial material, vec3 pw, vec4 color) {
  vec3 c = czm_linearToSrgb(color.rgb);
  bool leafy = seasonBit(color.r) > 0.5, many = seasonBit(color.g) > 0.5, keep = seasonBit(color.b) > 0.5;
  if (${season} == 2) {            // 緑: 緑のまま、赤紫: 葉の形で茂みの中、黄: 葉の形でまばら、水色: 細長い
    if (color != vec4(1.0))
      material.diffuse = keep ? vec3(0.0, 1.0, 0.2) : !leafy ? vec3(0.0, 0.8, 1.0) : many ? vec3(1.0, 0.0, 1.0) : vec3(1.0, 0.9, 0.0);
    return;
  }
  if (keep || !leafy) return;      // 緑のメッシュのある木（markTreeSplats）と、葉の形でないもの
  float mx = max(c.r, max(c.g, c.b)), d = mx - min(c.r, min(c.g, c.b));
  if (d < 0.012) return;           // ほぼ灰色（暗いスプラットの色相はあてにならない）
  float h = mx == c.g ? 60.0 * ((c.b - c.r) / d + 2.0)
          : mx == c.r ? 60.0 * mod((c.g - c.b) / d, 6.0) : 60.0 * ((c.r - c.g) / d + 4.0);
  // 葉の形のスプラットの緑だけ。境目はなだらかに。建物の縁のスプラットにも、白っぽい緑や銅ぶきの屋根の青緑の
  // ものがあり、色では葉と分けられないので、形とまわりの数で分ける（宮内庁庁舎と大手町の街路樹で確かめた）。
  // 茂みの中のものは広く（色相 45〜195°。青緑や淡い緑の葉もある）、まばらなものは、はっきりした葉の緑
  // （色相 55〜150°で、ある程度あざやかなもの）だけ変える。木の内側の暗い緑は、色の差は小さくても彩度はあるので変わる
  float w = many ? smoothstep(38.0, 50.0, h) * (1.0 - smoothstep(190.0, 205.0, h)) * smoothstep(0.03, 0.08, d / mx)
                 : smoothstep(48.0, 62.0, h) * (1.0 - smoothstep(145.0, 160.0, h)) * smoothstep(0.10, 0.18, d / mx);
  w *= smoothstep(0.012, 0.025, d);
  if (w <= 0.0) return;
  float L = dot(c, vec3(0.299, 0.587, 0.114));
  // t: 木のまとまりくらい（十数 m）でゆっくり変わる値。f: 枝くらい（2〜3 m）で変わる値。どちらも 0〜1 に広げる
  float t = clamp((0.7 * seasonNoise(pw / 14.0) + 0.3 * seasonNoise(pw / 5.0) - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  float f = clamp((seasonNoise(pw / 2.5) - 0.5) * 2.0 + 0.5, 0.0, 1.0);
  vec3 col;
  if (${season} == 0) {
    // 桜: 薄いピンクから白。明るさは元の明るさに比例させる（陰を持ち上げると、木の形が平らになり、
    // スプラットの縁が白くけば立って見える）。花は葉より明るいので全体は少し明るく
    vec3 pink = mix(vec3(0.96, 0.66, 0.76), vec3(1.0, 0.90, 0.93), clamp(0.6 * t + 0.4 * f, 0.0, 1.0));
    col = pink * clamp(L * 2.8, 0.0, 1.15);
  } else {
    // 紅葉: 木ごとに赤・橙・黄色。色合いだけを変え、明るさは画素ごとに元の明るさに比例させる（明るさに
    // 下限を付けると、木の間の陰まで橙になって平らに見える）。黄色は元の葉の明るさのままだと濁るので明るめに
    vec3 red = vec3(0.78, 0.13, 0.07), orange = vec3(0.92, 0.42, 0.08), yellow = vec3(0.93, 0.74, 0.16);
    float k = clamp(t + 0.25 * (f - 0.5), 0.0, 1.0);
    col = k < 0.5 ? mix(red, orange, k * 2.0) : mix(orange, yellow, k * 2.0 - 1.0);
    col *= mix(1.05, 1.7, k) * L / dot(col, vec3(0.299, 0.587, 0.114));
  }
  material.diffuse = czm_srgbToLinear(mix(c, clamp(col, 0.0, 1.0), w));
}`;

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

// 季節の色と光の当たり方を、材質の色が決まったあとに加える（スプラットと、HEVC でないメッシュ）
const tweakGlsl = seasonGlsl + lightGlsl;
const tweakCall = (seasonGlsl ? 'seasonTint(material, fsInput.attributes.positionWC, fsInput.attributes.color_0);' : '')
  + (lightGlsl ? 'lightApply(material, fsInput.attributes.positionEC, fsInput.attributes.positionWC, fsInput.attributes.color_0);' : '');

// 季節の色と光の当たり方だけのシェーダー（HEVC でない glb）。頂点の色があるのはスプラットだけで、メッシュには
// Cesium が白を入れるので、季節の色では写真（パリのような JPEG のテクスチャも）は変わらない
function tweakShader() {
  return new C.CustomShader({ fragmentShaderText: `${tweakGlsl}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  ${tweakCall}
}` });
}

// GPU の中で、ブラウザが RGB にしたコマ（ImageBitmap）を、CPU で詰めたときと同じ Y（LUMINANCE）と、縦横半分の
// UV（LUMINANCE_ALPHA）のテクスチャに戻す。コマを CPU に読み戻す（VideoFrame#copyTo）と 1 枚 100 ms ほど
// かかるが、これは GPU の中だけで済み、GPU のメモリも CPU で詰めたときと同じ。RGBA のテクスチャに BT.601
// フルレンジで変換して描き（UV は RGB の 2 x 2 画素の真ん中を線形補間で引いて平均する）、それを写して
// ミップマップを作る（1 チャンネルの R8 に描いてミップマップを作ると、この PC では 1 枚に数秒かかった）。
// ブラウザの RGB は、hevc.js で色の決め方を渡しているので BT.601 フルレンジで変換されている
let computeEngine = null;
const TO_YUV = ['vec4(y, y, y, 1.0)', 'vec4((c.b - y) / 1.772 + 0.5, 0.0, 0.0, (c.r - y) / 1.402 + 0.5)'].map(v => `
uniform sampler2D u_rgb;
in vec2 v_textureCoordinates;
void main() {
  vec3 c = texture(u_rgb, v_textureCoordinates).rgb;
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  out_FragColor = ${v};
}`);
function gpuPlanes({ bitmap, w, h }) {
  const context = scene.context, clamp = C.TextureWrap.CLAMP_TO_EDGE, U8 = C.PixelDatatype.UNSIGNED_BYTE;
  const filter = (min) => new C.Sampler({ wrapS: clamp, wrapT: clamp, minificationFilter: min,
    magnificationFilter: C.TextureMagnificationFilter.LINEAR });
  computeEngine = computeEngine || new C.ComputeEngine(context);
  const rgb = new C.Texture({ context, source: bitmap, sampler: filter(C.TextureMinificationFilter.LINEAR) });
  bitmap.close();
  const out = [[w, h, C.PixelFormat.LUMINANCE], [(w + 1) >> 1, (h + 1) >> 1, C.PixelFormat.LUMINANCE_ALPHA]].map(([width, height, pixelFormat], i) => {
    const tmp = new C.Texture({ context, width, height, pixelFormat: C.PixelFormat.RGBA, pixelDatatype: U8 });
    // persists: シェーダーは Cesium の控えにあるものを使い回す（毎回作り直さない）
    computeEngine.execute(new C.ComputeCommand({ fragmentShaderSource: new C.ShaderSource({ sources: [TO_YUV[i]] }),
      outputTexture: tmp, uniformMap: { u_rgb: () => rgb }, persists: true }));
    const tex = new C.Texture({ context, width, height, pixelFormat, pixelDatatype: U8,
      sampler: filter(C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR) });
    const fb = new C.Framebuffer({ context, colorTextures: [tmp], destroyAttachments: false });
    fb._bind();
    tex.copyFromFramebuffer(0, 0, 0, 0, width, height);
    fb._unBind();
    fb.destroy();
    tmp.destroy();
    tex.generateMipmap();
    return tex;
  });
  rgb.destroy();
  return out;
}

// HEVC を展開した面を貼るシェーダー。どの面かは頂点の属性 _SLAB（slab）で選ぶ（HEVC でない材質（スプラット
// など）は 255 で、そのまま）。面は、CPU で詰めた Y と UV の配列（季節の色のとき）か、GPU のコマ（gpuPlanes で
// Y と UV のテクスチャにする）。テクスチャは元の大きさのまま（WebGL2 では、配列から作るテクスチャは 2 の
// べき乗に広げられない）
function hevcShader(planes) {
  const filters = { repeat: false, minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
    magnificationFilter: C.TextureMagnificationFilter.LINEAR };
  const tex = (typedArray, width, height, pixelFormat) => ({
    type: C.UniformType.SAMPLER_2D, value: new C.TextureUniform({ typedArray, width, height, pixelFormat, ...filters }),
  });
  // GPU で作ったテクスチャは、シェーダーを作ったあとでテクスチャの控えに入れる（読み込み元は何も返さない）。
  // 控えのテクスチャは、シェーダーを捨てるときに一緒に捨てられる
  const made = {}, never = { fetchImage: () => new Promise(() => {}) };
  const ready = () => ({ type: C.UniformType.SAMPLER_2D, value: new C.TextureUniform({ url: never, ...filters }) });
  const uniforms = {};
  let pick = '';
  planes.forEach((p, i) => {
    if (p.bitmap) {
      [made['u_y' + i], made['u_uv' + i]] = gpuPlanes(p);
      uniforms['u_y' + i] = ready();
      uniforms['u_uv' + i] = ready();
    } else {
      uniforms['u_y' + i] = tex(p.y, p.w, p.h, C.PixelFormat.LUMINANCE);
      uniforms['u_uv' + i] = tex(p.uv, (p.w + 1) >> 1, (p.h + 1) >> 1, C.PixelFormat.LUMINANCE_ALPHA);
    }
    pick += `${i ? 'else ' : ''}if (s == ${i}) { y = textureGrad(u_y${i}, st, dx, dy).r; c = textureGrad(u_uv${i}, st, dx, dy).ra; }\n`;
  });
  const shader = new C.CustomShader({ uniforms, fragmentShaderText: `${tweakGlsl}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  int s = int(fsInput.attributes.slab + 0.5);
  ${tweakGlsl ? `if (s == 255) { ${tweakCall} return; }` : ''}
  if (s >= ${planes.length}) return;
  vec2 st = fsInput.attributes.texCoord_0, dx = dFdx(st), dy = dFdy(st);
  float y = 0.0;
  vec2 c = vec2(0.5);
  ${pick}
  c -= 0.5;
  // BT.601 のフルレンジ（hevc.js を見よ）。Cesium の材質の色は線形の値
  vec3 rgb = clamp(vec3(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x), 0.0, 1.0);
  material.diffuse = czm_srgbToLinear(rgb);
  ${lightGlsl ? 'lightApply(material, fsInput.attributes.positionEC, fsInput.attributes.positionWC, vec4(1.0));' : ''}
}` });
  Object.assign(shader._textureManager._textures, made);
  return shader;
}

// テクスチャを作り終えたら、元の Y と UV の配列を手放す（JS のメモリに残さない）
function releasePlanes(t) {
  const tm = t.shader._textureManager, u = t.shader.uniforms;
  if (!tm || !Object.keys(u).every(k => tm._textures[k])) return;
  for (const k in u) u[k].value.typedArray = undefined;
  t.planesFreed = true;
}

const NO_IBL = new C.ImageBasedLighting({ imageBasedLightingFactor: new C.Cartesian2(0, 0) });
async function makeModel(t, buf, useHevc) {
  let shader, planes = null;
  if (useHevc) {
    const images = glbHevc(buf);
    if (images.length) {
      try {
        const th = performance.now();
        planes = await hevcDecode(t, images);
        t.hevcMs = performance.now() - th;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        hevc = false;           // 以後は JPEG で受け取る
        e.retry = 'HEVC を展開できないので、JPEG にする';
        throw e;
      }
    }
  }
  if (seasonGlsl) {
    try {
      await markTreeSplats(buf, planes, t.z >= 19);
    } catch (e) {
      console.warn('季節の色の印', t.z, t.x, t.y, e);
    }
  }
  if (planes) {
    try {
      shader = hevcShader(planes);
    } catch (e) {
      if (!planes.some(p => p.bitmap)) throw e;
      gpuTex = false;
      e.retry = 'GPU の中でテクスチャにできないので、CPU に読み戻す';
      throw e;
    }
  }
  else if (tweakGlsl) shader = useHevc ? hevcShader([]) : tweakShader();   // スプラットだけのタイルなど
  let model;
  const tm = performance.now();
  try {
    model = await C.Model.fromGltfAsync({
      // basePath はタイルごとに変える。Cesium は glb の中身（バッファや画像）を basePath を鍵に
      // 使い回すので、同じだと別のタイルの中身が混ざる
      gltf: buf, basePath: flyUrl(t, useHevc), upAxis: C.Axis.Z, forwardAxis: C.Axis.X, show: false,
      incrementallyLoadTextures: false, backFaceCulling: false, releaseGltfJson: true,
      // 光を当てない（写真そのまま）ので、映り込みの計算は要らない。これがあると、映り込みの準備が
      // できたところでシェーダーを全部作り直し、読み込み中の数秒をそれに取られる。Scene#pick も使わない
      environmentMapOptions: { enabled: false }, imageBasedLighting: NO_IBL, allowPicking: false,
      customShader: shader,
    });
    flyover.add(model);
    await new Promise((res, rej) => {
      model.readyEvent.addEventListener(res);
      model.errorEvent.addEventListener(rej);
    });
  } catch (e) {
    if (shader) shader.destroy();      // モデルはシェーダーを捨てない
    throw e;
  }
  t.cesiumMs = performance.now() - tm;
  t.model = model; t.shader = shader; t.planesFreed = !shader; t.clip = 0; t.state = 'ready';
}

// 親のタイルを、子の 4 分の 1（北西・北東・南西・南東 = ビット 0〜3）のうち mask のものだけ
// 見えるように切る。境目は経線と緯線なので、タイルの中心での東・北の面で切れる。
function setClip(t, mask) {
  t.clip = mask;
  if (!mask) { t.model.clippingPlanes = undefined; return; }
  const q = [0, 1, 2, 3].filter(i => mask & (1 << i));
  const east = c => new C.ClippingPlane(new C.Cartesian3(c ? 1 : -1, 0, 0), 0);    // 法線の側を残す
  const north = r => new C.ClippingPlane(new C.Cartesian3(0, r ? -1 : 1, 0), 0);
  let planes, union = true;
  if (q.length === 1) planes = [east(q[0] % 2), north(q[0] >> 1)];
  else if (q.length === 2) planes = [q[0] >> 1 === q[1] >> 1 ? north(q[0] >> 1) : east(q[0] % 2)];
  else {                         // 3 つ: 残りの 1 つの 4 分の 1 だけを切る
    const r = [0, 1, 2, 3].find(i => !(mask & (1 << i)));
    planes = [east(1 - r % 2), north(1 - (r >> 1))];
    union = false;
  }
  if (!t.enu) {
    const n = 2 ** t.z, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (t.y + 0.5) / n)));
    t.enu = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromRadians((t.x + 0.5) / n * 2 * Math.PI - Math.PI, lat, 0));
  }
  t.model.clippingPlanes = new C.ClippingPlaneCollection({ planes, unionClippingRegions: union, modelMatrix: t.enu, edgeWidth: 0 });
}

// タイルの選び方と読み方:
// - 画面で REFINE_PX より大きく見えるタイルは、子に分けて細かくする（refine）
// - 読むのは、細かくしない（いちばん細かい）タイルと、細かくするタイルのうちズーム 13 と、
//   親を読まない（読んでいない）もの。途中の階層は 1 段おきに読み、読む量を減らす
// - 描くときは、子孫で埋め尽くせる 4 分の 1 は子孫を描き、埋まらない 4 分の 1 だけ親を切り出して
//   描く（子にデータがない水面などもここで親が埋める）。こうすると、揃った所から細かくなる
let lastView = null, dirty = true;
function viewChanged() {
  const v = [...C.Cartesian3.pack(camera.positionWC, []), ...C.Cartesian3.pack(camera.directionWC, []),
    canvas.clientWidth, canvas.clientHeight];
  const changed = !lastView || v.some((x, i) => Math.abs(x - lastView[i]) > 1e-9 * Math.max(1, Math.abs(x)));
  lastView = v;
  return changed;
}

function updateFlyover() {
  // カメラも読み込みの状態も変わっていなければ、選び直さない（止まっているときは何もしない）
  if (!viewChanged() && !dirty && active === 0) return 0;
  dirty = false;
  frame++;
  boxBudget = BOX_BUDGET;
  const queue = [];
  const camPos = camera.positionWC;
  const cam = ellipsoid.cartesianToCartographic(camPos);
  if (!mode2D && cam && cam.height < 400e3) {
    const cv = camera.frustum.computeCullingVolume(camPos, camera.directionWC, camera.upWC);
    const k = lodScale * canvas.clientHeight / (2 * Math.tan(camera.frustum.fovy / 2));   // 写すときは写す大きさの細かさ
    const now = performance.now();
    // 回したときにすぐ出せるよう、カメラのまわりこの距離までは、画面の外（後ろ側）も先に読む
    const aroundR = C.Math.clamp(altitude() * 2.5, 1500, 20000);
    const dist = t => Math.max(1, Math.sqrt(t.flat().distanceSquaredTo(camPos)));
    const visible = t => cv.computeVisibility(t.box()) !== C.Intersect.OUTSIDE;
    const want = (t, d, vis) => {
      t.wanted = frame; t.wantedAt = now; t.pri = d / t.width;
      if (t.state === 'failed' && now - t.failedAt > 15000) t.state = 'none';
      // 画面で大きく見えるものから。画面の外のものは後回し
      if (t.state === 'none') queue.push({ t, vis, pri: t.pri });
    };
    // 読み込み済みの子孫（3 段下まで）で埋め尽くせるか。必要なタイルが届くまでの代わりに使う
    // （離れたときに、手持ちの細かいタイルを隠して穴にしない）
    const loadedCover = (t, depth) => {
      if (t.state === 'ready') return true;
      if (!depth || !t.kids) return false;
      return t.kids.every(c => { c.lvis = visible(c); return !c.lvis || loadedCover(c, depth - 1); });
    };
    // 1 回目: 見えるか・細かくするかを決めて読むものを選び、子孫で埋め尽くせるか（cov）を返す
    const visit = (t, parentLoads) => {
      t.vis = visible(t);
      t.refine = false;
      const d = dist(t);
      // 粗いズーム 13 のタイル（遠景）は数が少ないので、もっと遠くまで先に読んでおく
      if (!t.vis && (shooting || d > (t.z <= FLY.min ? aroundR * 4 : aroundR))) return true;   // 写す間は画面の外を読まない
      t.touched = frame;                 // 見ている所か、そのまわり（捨てるときの順番に使う）
      if (t.z < FLY.min) {
        t.refine = t.width / 2 ** (FLY.min - t.z) * k / d >= SHOW_PX;
        if (t.refine) for (const c of t.children()) visit(c, false);
        return true;
      }
      const px = t.width * k / d;
      if (t.z === FLY.min && px < SHOW_PX) { t.vis = false; return true; }
      const settledEmpty = t.state === 'empty' || t.state === 'failed';
      t.refine = t.z < FLY.max && px > REFINE_PX && !settledEmpty;
      if (!t.refine || t.z === FLY.min || !parentLoads) want(t, d, t.vis);
      const loads = t.wanted === frame || t.state === 'ready' || t.state === 'loading';
      let kidsCov = true;
      if (t.refine) for (const c of t.children()) kidsCov = visit(c, loads) && kidsCov;
      t.kidsCov = kidsCov;
      t.descCov = !t.refine && t.vis && t.state !== 'ready' && loadedCover(t, 3);
      t.cov = !t.vis || (t.refine && kidsCov) || t.state === 'ready' || t.descCov;
      return t.cov;
    };
    // 2 回目: 描くタイルと、親を切り出す 4 分の 1 を決める
    const show = (t, mask) => { t.used = frame; t.mask = mask; };
    const drawLoaded = t => {
      if (t.state === 'ready') show(t, 0);
      else t.kids.forEach(c => { if (c.lvis) drawLoaded(c); });
    };
    const draw = t => {
      if (!t.vis) return;
      const kids = t.refine ? t.children() : [];
      if (t.z < FLY.min || t.refine && t.kidsCov) { kids.forEach(draw); return; }
      if (t.descCov) { drawLoaded(t); return; }
      if (t.refine && t.state === 'ready') {
        let mask = 0;
        kids.forEach((c, i) => { if (c.vis && !c.cov) mask |= 1 << i; });
        if (mask === 15 || mask === 6 || mask === 9) { show(t, 0); return; }   // 全部か対角は親だけ
        show(t, mask);
      } else if (t.state === 'ready') {
        show(t, 0);
        return;
      }
      kids.forEach(c => { if (c.vis && c.cov) draw(c); });
    };
    // 遠い地域（ズーム 13 のタイルも出さない距離より遠いもの）は、中心からの距離だけで外す
    const far = Math.max(aroundR * 4, 6000 * k / SHOW_PX);
    const near = new Set(roots.filter(r => C.Cartesian3.distance(r.sphere.center, camPos) - r.sphere.radius < far));
    for (const r of roots) if (!near.has(r)) { r.vis = false; r.refine = false; }
    for (const r of near) visit(r, false);
    for (const r of near) draw(r);
  }
  // 表示の切り替え
  const now = performance.now();
  let n = 0;
  for (const t of tiles.values()) {
    if (t.model) {
      const show = t.used === frame;
      if (t.model.show !== show || show && t.clip !== t.mask) scene.requestRender();
      t.model.show = show;
      if (show && t.clip !== t.mask) setClip(t, t.mask);
      if (!t.planesFreed) releasePlanes(t);
      n++;
    }
    // 読みかけは、しばらく（4 秒）要らなかったときだけ取りやめる（回している間に取りやめると、
    // 戻ってきたときに初めからになる）
    if (t.state === 'loading' && now - t.wantedAt > 4000 && t.abort) t.abort.abort();
  }
  // 読み込み
  // 画面に見えているものを先に、画面で大きく見えるものから。画面の外の先読みは、見えているものが
  // 全部届いてから（同時に読むと、ブラウザがモデルを作る手間を取り合って遅くなる）、MAX_OFFSCREEN 本まで
  queue.sort((a, b) => b.vis - a.vis || a.pri - b.pri);
  const visWaiting = active > activeOff || queue.some(q => q.vis);
  for (const { t, vis } of queue) {
    if (active >= MAX_ACTIVE) break;
    if (!vis && (visWaiting || activeOff >= MAX_OFFSCREEN)) break;
    load(t, !vis);
  }
  // 捨てる: 見ている所とそのまわりで最近たどっていないものから（親は子で置き換わって表示して
  // いなくても、穴を埋める役なので残す）
  const maxModels = shooting ? MAX_MODELS_SHOT : MAX_MODELS;
  if (n > maxModels) {              // 毎コマにならないよう、20 個ぶん余裕を作る
    const old = [...tiles.values()].filter(t => t.model && t.touched !== frame).sort((a, b) => (a.touched || 0) - (b.touched || 0));
    for (const t of old.slice(0, n - maxModels + 20)) {
      flyover.remove(t.model);      // remove は destroy もする（シェーダーは捨てないので別に捨てる）
      if (t.shader) t.shader.destroy();
      t.model = null; t.shader = null; t.state = 'none';
    }
  }
  return active + queue.length;
}

// ---------------------------------------------------------------- 毎コマ

// 読み込みだけが進んでいる間に描く間隔。HEVC の梅田（171 タイル）で、毎コマ描くと 38 秒で 81 タイル
// しか出なかったのが、100 ms では 14 秒で全部出た（50 ms では 16 秒）
const LOADING_FRAME_MS = 100;
let last = performance.now(), pendingFly = 0, globeQueue = 0, updateMs = 0, loadingFrame = 0;
globe.tileLoadProgressEvent.addEventListener(n => { globeQueue = n; dirty = true; });
scene.preUpdate.addEventListener(() => {
  const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (anim) {
    const t = Math.min(1, (now - anim.start) / (anim.duration * 1000));
    anim.update(t);
    if (t >= 1) anim = null;
  }
  keyTick(dt);
  const t0 = performance.now();
  pendingFly = updateFlyover();
  updateMs = performance.now() - t0;
  // 動きがあるときは次のコマも描く。読み込み中（モデルや地形は描くときに処理が進む。地球儀は描かないと
  // 読み込みが始まらないので、最初は読み終えるまで描く）も描くが、止まっているなら LOADING_FRAME_MS ごとに
  // 間引く。毎コマ描くと GPU が埋まり、HEVC の画像の展開（GPU の専用回路）がほとんど進まなくなる
  if (anim || held.size) scene.requestRender();
  else if ((active > 0 || globeQueue > 0 || !globe.tilesLoaded) && !loadingFrame)
    loadingFrame = setTimeout(() => { loadingFrame = 0; scene.requestRender(); }, LOADING_FRAME_MS);
});

// ---------------------------------------------------------------- 下の帯

const $ = id => document.getElementById(id);
const fmt = (v, d = 0) => v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });
function fmtDist(m) { return m >= 1000 ? fmt(m / 1000, m >= 10000 ? 0 : 1) + ' km' : fmt(m) + ' m'; }
function fmtLatLon(c) {
  const la = C.Math.toDegrees(c.latitude), lo = C.Math.toDegrees(c.longitude);
  return `${fmt(Math.abs(la), 5)}°${la >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lo), 5)}°${lo >= 0 ? 'E' : 'W'}`;
}
function elevation(p, onGlobe) {
  const c = ellipsoid.cartesianToCartographic(p);
  return c.height - geoid(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude)) + (onGlobe ? cfg.terrainDrop : 0);
}

let mouse = null, mouseMoved = false, rendered = 0, shownRender = -1;
canvas.addEventListener('pointermove', e => { mouse = new C.Cartesian2(e.offsetX, e.offsetY); mouseMoved = true; });
canvas.addEventListener('pointerleave', () => { mouse = null; $('cursor').textContent = ''; });
scene.postRender.addEventListener(() => { rendered++; });

const needle = document.getElementById('needle');
const shownView = new C.Matrix4();
let cursorAt = 0;
setInterval(() => {
  // 読み込み中
  $('loading').hidden = !(pendingFly > 0 || globeQueue > 0 || shooting);
  // 描き直しもマウスの動きもなければ、同じ表示のままなので何もしない
  if (rendered === shownRender && !mouseMoved) return;
  shownRender = rendered;
  // 読み込み中は毎コマ描き直すが、カメラもマウスも動いていなければ、カーソルの標高と縮尺は
  // 1 秒ごとに直せば足りる（カーソルの下を調べるのは GPU を待たせる）
  const now = performance.now();
  const moved = mouseMoved || !C.Matrix4.equalsEpsilon(camera.viewMatrix, shownView, 1e-9);
  const refresh = moved || now - cursorAt > 1000;
  if (refresh) { C.Matrix4.clone(camera.viewMatrix, shownView); cursorAt = now; }
  mouseMoved = false;
  // 方位
  needle.style.transform = `rotate(${-C.Math.toDegrees(camera.heading)}deg)`;
  // カメラの高度（海抜）
  const c = ellipsoid.cartesianToCartographic(camera.positionWC);
  if (c) $('camera').textContent = 'カメラ ' + fmtDist(c.height - geoid(C.Math.toDegrees(c.latitude), C.Math.toDegrees(c.longitude)));
  // カーソルの位置と標高
  if (mouse && refresh) {
    const r = pick(mouse);
    $('cursor').textContent = r ? `${fmtLatLon(ellipsoid.cartesianToCartographic(r.p))}  標高 ${fmtDist(Math.round(elevation(r.p, r.onGlobe)))}` : '';
  }
  // 縮尺（画面の下の方で 100 px が何 m か）。地形の上で測れば足りる
  const y = canvas.clientHeight - 80, x = canvas.clientWidth / 2;
  const a = refresh && pick(new C.Cartesian2(x - 50, y), true), b = a && pick(new C.Cartesian2(x + 50, y), true);
  if (!refresh) {
    // そのまま
  } else if (a && b) {
    const mpp = C.Cartesian3.distance(a.p, b.p) / 100;
    const target = mpp * 90, p10 = 10 ** Math.floor(Math.log10(target));
    const nice = [5, 2, 1].map(m => m * p10).find(v => v <= target) || p10;
    $('scale').querySelector('b').textContent = fmtDist(nice);
    $('scale').querySelector('i').style.width = (nice / mpp).toFixed(0) + 'px';
    $('scale').hidden = false;
  } else {
    $('scale').hidden = true;
  }
}, 150);

// ---------------------------------------------------------------- URL に視点を残す

// #緯度,経度,高度m,方位h,傾きt（傾き 0 が真上から）
function viewToHash() {
  const c = ellipsoid.cartesianToCartographic(camera.positionWC);
  if (!c) return;
  const s = [C.Math.toDegrees(c.latitude).toFixed(6), C.Math.toDegrees(c.longitude).toFixed(6),
    c.height.toFixed(0) + 'm', C.Math.toDegrees(C.Math.zeroToTwoPi(camera.heading)).toFixed(1) + 'h',
    (90 + C.Math.toDegrees(camera.pitch)).toFixed(1) + 't'].join(',');
  history.replaceState(null, '', '#' + s);
}
function hashToView() {
  const m = location.hash.slice(1).split(',');
  if (m.length < 3) return false;
  const [lat, lon, h, hd = '0', tl = '0'] = m.map(v => parseFloat(v));
  if (![lat, lon, h].every(Number.isFinite)) return false;
  camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, h),
    orientation: { heading: C.Math.toRadians(hd || 0), pitch: C.Math.toRadians((tl || 0) - 90), roll: 0 } });
  return true;
}
if (!hashToView()) {
  camera.setView({ destination: C.Cartesian3.fromDegrees(138, 30, 14e6) });
}
camera.moveEnd.addEventListener(viewToHash);
addEventListener('hashchange', hashToView);

// ---------------------------------------------------------------- 検索

const searchInput = $('q'), resultsEl = $('results');
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
  const y = Math.floor((1 - Math.asinh(Math.tan(C.Math.toRadians(lat))) / Math.PI) / 2 * n);
  return covered.has(x + ',' + y);
}
function hideResults() { resultsEl.hidden = true; }
function showList(title, items) {
  resultsEl.replaceChildren();
  if (title) { const h = document.createElement('h4'); h.textContent = title; resultsEl.append(h); }
  if (!items.length) {
    const d = document.createElement('div'); d.className = 'empty'; d.textContent = '見つかりませんでした'; resultsEl.append(d);
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    const [first, ...rest] = it.name.split(', ');
    b.textContent = first;
    if (isCovered(it.lat, it.lon)) {
      const s = document.createElement('span'); s.className = 'badge'; s.textContent = '3D'; b.append(s);
    }
    if (rest.length) { const s = document.createElement('small'); s.textContent = rest.join(', '); b.append(s); }
    b.onclick = () => { flyToPlace(it); hideResults(); searchInput.blur(); };
    resultsEl.append(b);
  }
  resultsEl.hidden = false;
}
function flyToPlace({ lat, lon, bbox }) {
  stopAll();
  let range = 1500;
  if (bbox && bbox.length === 4) {
    const [s, n, w, e] = bbox;
    const size = Math.max(C.Cartesian3.distance(C.Cartesian3.fromDegrees(w, s), C.Cartesian3.fromDegrees(e, n)), 300);
    range = C.Math.clamp(size * 1.1, 800, 3e6);
  }
  prefetch(lat, lon, range);
  const ground = geoid(lat, lon);
  const tilt = range < 50e3 ? -40 : -90;
  camera.flyToBoundingSphere(new C.BoundingSphere(C.Cartesian3.fromDegrees(lon, lat, ground), 0), {
    offset: new C.HeadingPitchRange(0, C.Math.toRadians(tilt), range), duration: 3,
  });
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

window.earth = {   // コンソールから触る用
  viewer, tiles, pick, resetView, setClip, loadLog, hevc: () => hevc,
  stats: () => ({ flyover: pendingFly, globe: globeQueue, updateMs }) };
})();
