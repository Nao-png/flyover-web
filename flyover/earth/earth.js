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
const flyUrl = t => `${hostBase(t.x + t.y + 1)}/api/flyover/${t.z}/${t.x}/${t.y}.glb`;
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
    this.abort = null; this.failedAt = 0;
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
    const r = await fetch(flyUrl(t), { signal: t.abort.signal });
    if (r.status === 204) { t.state = 'empty'; return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    const t1 = performance.now();
    await makeModel(t, buf);
    loadLog.push({ z: t.z, x: t.x, y: t.y, off: offscreen, at: t0, bytes: buf.length, fetch: t1 - t0, model: performance.now() - t1,
      server: r.headers.get('Server-Timing') });
    if (loadLog.length > 500) loadLog.shift();
  } catch (e) {
    if (e.name === 'AbortError') { t.state = 'none'; }
    else { t.state = 'failed'; t.failedAt = performance.now(); console.warn('Flyover', t.z, t.x, t.y, e); }
  } finally {
    active--; t.abort = null;
    if (offscreen) activeOff--;
    dirty = true;              // 選び直す
  }
}
const NO_IBL = new C.ImageBasedLighting({ imageBasedLightingFactor: new C.Cartesian2(0, 0) });
async function makeModel(t, buf) {
  const model = await C.Model.fromGltfAsync({
    // basePath はタイルごとに変える。Cesium は glb の中身（バッファや画像）を basePath を鍵に
    // 使い回すので、同じだと別のタイルの中身が混ざる
    gltf: buf, basePath: flyUrl(t), upAxis: C.Axis.Z, forwardAxis: C.Axis.X, show: false,
    incrementallyLoadTextures: false, backFaceCulling: false, releaseGltfJson: true,
    // 光を当てない（写真そのまま）ので、映り込みの計算は要らない。これがあると、映り込みの準備が
    // できたところでシェーダーを全部作り直し、読み込み中の数秒をそれに取られる。Scene#pick も使わない
    environmentMapOptions: { enabled: false }, imageBasedLighting: NO_IBL, allowPicking: false,
  });
  flyover.add(model);
  await new Promise((res, rej) => {
    model.readyEvent.addEventListener(res);
    model.errorEvent.addEventListener(rej);
  });
  t.model = model; t.clip = 0; t.state = 'ready';
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
    const k = canvas.clientHeight / (2 * Math.tan(camera.frustum.fovy / 2));
    const now = performance.now();
    // 回したときにすぐ出せるよう、カメラのまわりこの距離までは、画面の外（後ろ側）も先に読む
    const aroundR = C.Math.clamp(altitude() * 2.5, 1500, 20000);
    const dist = t => Math.max(1, Math.sqrt(t.flat().distanceSquaredTo(camPos)));
    const visible = t => cv.computeVisibility(t.box()) !== C.Intersect.OUTSIDE;
    const want = (t, d, vis) => {
      t.wanted = frame; t.wantedAt = now;
      if (t.state === 'failed' && now - t.failedAt > 15000) t.state = 'none';
      // 画面で大きく見えるものから。画面の外のものは後回し
      if (t.state === 'none') queue.push({ t, vis, pri: d / t.width });
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
      if (!t.vis && d > (t.z <= FLY.min ? aroundR * 4 : aroundR)) return true;
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
  if (n > MAX_MODELS) {             // 毎コマにならないよう、20 個ぶん余裕を作る
    const old = [...tiles.values()].filter(t => t.model && t.touched !== frame).sort((a, b) => (a.touched || 0) - (b.touched || 0));
    for (const t of old.slice(0, n - MAX_MODELS + 20)) {
      flyover.remove(t.model);      // remove は destroy もする
      t.model = null; t.state = 'none';
    }
  }
  return active + queue.length;
}

// ---------------------------------------------------------------- 毎コマ

let last = performance.now(), pendingFly = 0, globeQueue = 0, updateMs = 0;
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
  // 読み込み中（モデルや地形は描くときに処理が進む）や、動きがあるときは次のコマも描く。
  // 地球儀は描かないと読み込みが始まらないので、最初は読み終えるまで描き続ける
  if (anim || held.size || active > 0 || globeQueue > 0 || !globe.tilesLoaded) scene.requestRender();
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
  $('loading').hidden = !(pendingFly > 0 || globeQueue > 0);
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
  viewer, tiles, pick, resetView, setClip, loadLog, stats: () => ({ flyover: pendingFly, globe: globeQueue, updateMs }) };
})();
