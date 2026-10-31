"""読んだタイルを、ブラウザ（three.js）で見る一式に書き出す。

出力: index.html、mesh.bin（材質ごとの頂点・UV・三角形）、tex/*.jpg（材質ごとの画像）、
meta.json。新しい Flyover（R3D）のスプラットは、まとめて 1 つの組（頂点の色付き、低いものから順）にする。座標は範囲の中心での東・北・上（メートル）で、いちばん低いあたりを高さ 0 にする。
"""
import io
import json
import os
import shutil
import struct
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HTML = """<!DOCTYPE html>
<meta charset="utf-8">
<title>Flyover</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #cfd6dd;
               font: 13px/1.5 system-ui, sans-serif; overflow: hidden; }
  #ui { position: fixed; left: 12px; top: 12px; padding: 10px 12px; border-radius: 8px;
        background: rgba(20,24,28,.82); }
  #ui b { color: #fff; font-weight: 600; }
  label { display: block; margin-top: 6px; }
  input[type=range] { width: 150px; vertical-align: middle; }
</style>
<div id="ui">
  <b id="n">読み込み中…</b>
  <div id="place" style="opacity:.75"></div>
  <label>明るさ <input id="gain" type="range" min="50" max="250" step="5" value="100"></label>
  <label><input id="wire" type="checkbox"> 三角形の辺</label>
  <div style="margin-top:6px;opacity:.75">左ドラッグ: 回転 / 右ドラッグ: 平行移動 / ホイール: 拡大<br>
  ダブルクリック: そこを回転の中心に<br>
  WASD: 移動 / Q・E: 下・上 / Shift: 速く</div>
</div>
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
               "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const meta = await (await fetch('meta.json')).json();
const buf = await (await fetch('mesh.bin')).arrayBuffer();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const loader = new THREE.TextureLoader();
// HEVC のまま書き出した画像（--hevc）は、作業用のスレッド（hevc.js）で GPU の専用回路を使って展開し、
// 明るさ（Y）と色（UV）の面にする。ファイルは [hvcC の長さ（LE の u32）][hvcC][コマ]
let hevcWorker = null, hevcId = 0;
const hevcWait = new Map();
async function decodeHevc(file) {
  if (!('VideoDecoder' in window)) throw new Error('このブラウザは HEVC を展開できない（WebCodecs がない）');
  if (!hevcWorker) {
    hevcWorker = new Worker('hevc.js');
    hevcWorker.onmessage = ({ data }) => { const w = hevcWait.get(data.id); hevcWait.delete(data.id); w(data); };
  }
  const b = new Uint8Array(await (await fetch(file)).arrayBuffer());
  const n = new DataView(b.buffer).getUint32(0, true);
  const id = ++hevcId;
  const r = await new Promise(res => { hevcWait.set(id, res);
    hevcWorker.postMessage({ id, images: [{ config: b.slice(4, 4 + n), data: b.slice(4 + n) }] }); });
  if (r.error) throw new Error(file + ': ' + r.error);
  return r.out[0];
}
let texs;
try {
  texs = await Promise.all(meta.groups.map(g => g.file ? loader.loadAsync(g.file) : g.hevc ? decodeHevc(g.hevc) : null));   // 並行して読む
} catch (e) {
  document.getElementById('n').textContent = '画像を展開できない: ' + e.message + '（HEVC を GPU で展開できる Chrome などで開くか、--hevc なしで書き出す）';
  throw e;
}
// HEVC の Y と UV から色にする（HEIC には色の決め方が入っていないので、HEIF の決まりどおり BT.601 の
// フルレンジ。sRGB の値を線形に直す。UV の v は上向きで、面は上の行から並ぶので上下を返す）
function hevcColor(uvTex) {
  return sh => {
    sh.uniforms.uvTex = { value: uvTex };
    sh.fragmentShader = 'uniform sampler2D uvTex;\\n' + sh.fragmentShader.replace('#include <map_fragment>', `vec2 t_ = vec2(vMapUv.x, 1.0 - vMapUv.y);
  float y_ = texture2D(map, t_).r;
  vec2 c_ = texture2D(uvTex, t_).rg - 0.5;
  vec3 s_ = clamp(vec3(y_ + 1.402 * c_.y, y_ - 0.344136 * c_.x - 0.714136 * c_.y, y_ + 1.772 * c_.x), 0.0, 1.0);
  diffuseColor.rgb *= mix(s_ / 12.92, pow((s_ + 0.055) / 1.055, vec3(2.4)), step(0.04045, s_));`);
  };
}
function plane(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format);
  t.unpackAlignment = 1;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
// スプラットの不透明度 = (27 × 重心座標の積) ^ 指数（中心で 1、縁で 0。指数は glb.SPLAT_SOFTNESS）
const softness = { value: meta.splatSoftness || 1.5 };
function softSplats(sh) {
  sh.uniforms.softness = softness;
  sh.vertexShader = 'attribute vec2 bary;\\nvarying vec2 vBary;\\n' +
    sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\\nvBary = bary;');
  sh.fragmentShader = 'uniform float softness;\\nvarying vec2 vBary;\\n' +
    sh.fragmentShader.replace('#include <map_fragment>', `float w_ = 1.0 - vBary.x - vBary.y;
  diffuseColor.a *= pow(clamp(27.0 * vBary.x * vBary.y * w_, 0.0, 1.0), softness);`);
}
const mats = [], meshes = [];
let tris = 0;
for (const [k, g] of meta.groups.entries()) {
  const tex = texs[k];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, g.pos, g.nv * 3), 3));
  const uv = new THREE.BufferAttribute(new Float32Array(buf, g.uv, g.nv * 2), 2);
  let mat;
  if (g.splat) {   // スプラット: 頂点の色（線形の RGBA）の三角形を、縁ほど透明にして、並んでいる順（低いものから）に描く
    geo.setAttribute('bary', uv);
    geo.setAttribute('color', new THREE.BufferAttribute(new Uint16Array(buf, g.col, g.nv * 4), 4, true));
    mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.onBeforeCompile = softSplats;
  } else if (g.hevc) {
    const yTex = plane(tex.y, tex.w, tex.h, THREE.RedFormat);
    const uvTex = plane(tex.uv, (tex.w + 1) >> 1, (tex.h + 1) >> 1, THREE.RGFormat);
    geo.setAttribute('uv', uv);
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, g.idx, g.nt * 3), 1));
    mat = new THREE.MeshBasicMaterial({ map: yTex, side: THREE.DoubleSide });
    mat.onBeforeCompile = hevcColor(uvTex);
  } else {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (g.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    geo.setAttribute('uv', uv);
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, g.idx, g.nt * 3), 1));
    mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  }
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  if (g.splat) m.renderOrder = 1;
  scene.add(m); mats.push(mat); meshes.push(m);
  tris += g.nt;
}

const cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 20000);
const r = meta.radius;
cam.position.set(-r * 0.2, -r * 1.1, r * 0.8);
cam.up.set(0, 0, 1);

const ren = new THREE.WebGLRenderer({ antialias: true });
ren.setPixelRatio(devicePixelRatio);
ren.setSize(innerWidth, innerHeight);
document.body.appendChild(ren.domElement);

const ctl = new OrbitControls(cam, ren.domElement);
ctl.target.set(0, 0, 0);
ctl.enableDamping = true;
ctl.update();
window.view = { cam, ctl, meta, ren, scene };   // コンソールから視点を動かしたり、描いたりする用

document.getElementById('n').textContent =
  tris.toLocaleString() + ' 三角形 · タイル ' + meta.tiles + ' 枚';
document.getElementById('place').textContent =
  meta.lat.toFixed(5) + ', ' + meta.lon.toFixed(5) + ' · ' + meta.region;
document.getElementById('gain').oninput = e => {
  for (const m of mats) m.color.setScalar(+e.target.value / 100);
};
document.getElementById('wire').onchange = e => {
  for (const m of mats) m.wireframe = e.target.checked;
};

const ray = new THREE.Raycaster();
ren.domElement.addEventListener('dblclick', e => {
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), cam);
  const hit = ray.intersectObjects(meshes, false)[0];
  if (!hit) return;
  cam.position.add(hit.point.clone().sub(ctl.target));
  ctl.target.copy(hit.point);
});
addEventListener('resize', () => {
  cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
  ren.setSize(innerWidth, innerHeight);
});
// WASD で前後左右（水平）、Q・E で上下に、視点と回転の中心をいっしょに動かす。
// 速さは回転の中心までの距離に比例（近くではゆっくり、引いた所では速く）
const keys = new Set();
addEventListener('keydown', e => { if (!e.ctrlKey && !e.metaKey && !e.altKey) keys.add(e.code); });
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
const clock = new THREE.Clock();
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), step = new THREE.Vector3(), UP = new THREE.Vector3(0, 0, 1);
function move(dt) {
  const k = c => keys.has(c) ? 1 : 0;
  const f = k('KeyW') - k('KeyS'), s = k('KeyD') - k('KeyA'), u = k('KeyE') - k('KeyQ');
  if (!f && !s && !u) return;
  cam.getWorldDirection(fwd).setZ(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 1, 0).applyQuaternion(cam.quaternion).setZ(0);   // 真下を見ているときは画面の上を前に
  fwd.normalize();
  right.crossVectors(fwd, UP);
  const speed = Math.min(Math.max(cam.position.distanceTo(ctl.target) * 0.8, 4), 200) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 3 : 1);
  step.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, s).addScaledVector(UP, u).normalize().multiplyScalar(speed * dt);
  cam.position.add(step);
  ctl.target.add(step);
}
(function loop() {
  requestAnimationFrame(loop);
  move(Math.min(clock.getDelta(), 0.1));
  ctl.update(); ren.render(scene, cam);
})();
</script>
"""


def enu_basis(p):
    """ECEF の点 p での東・北・上の単位ベクトル（行）。"""
    up = p / np.linalg.norm(p)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    return np.array([east, np.cross(up, east), up])


def to_jpeg(material, quality=90):
    """材質の画像を JPEG のバイト列に（HEIC は変換する）。画質 95 以上なら色を間引かない（4:4:4）。"""
    if material.format == "jpeg":
        return material.image
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    out = io.BytesIO()
    Image.open(io.BytesIO(material.image)).convert("RGB").save(out, "JPEG", quality=quality,
                                                         subsampling=0 if quality >= 95 else -1)
    return out.getvalue()


def _save_jpeg(material, path, quality):
    open(path, "wb").write(to_jpeg(material, quality))


def _parts(tiles):
    """(名前, 材質, ECEF の頂点, UV, 三角形) の並びと、スプラットの (ECEF の頂点 (3N, 3), RGBA (N, 4)) の
    並び。
    範囲の端の、平らな地図につなぐための帯や面（Mesh.kind が 0 でないもの）は入れない。"""
    parts, splats = [], []
    for name, c in tiles:
        for mi, m in enumerate(c.meshes):
            if m.kind != 0:
                continue
            X = c.to_ecef(m.vertices)
            for mat, F in m.groups.items():
                if len(F):
                    parts.append((f"{name}_{mi}_{mat}", c.materials[mat], X, m.uv, F))
        sp = getattr(c, "splats", None)
        if sp is not None:
            keep = sp.rgba[:, 3] > 0    # 見えないもの（不透明度 0）は入れない
            if keep.any():
                splats.append((c.to_ecef(sp.vertices[keep].reshape(-1, 3)), sp.rgba[keep]))
    return parts, splats


def write(tiles, out, info, quality=90, hevc=False):
    """tiles: [(名前, C3M)]。info: meta.json に足す情報（lat, lon, region）。hevc なら、新しい Flyover の
    HEVC の 1 コマの画像（くり返して貼るもの以外）を、JPEG にせずそのまま書く（ブラウザの GPU で展開する。
    JPEG にしないので速いが、HEVC を GPU で展開できるブラウザでしか見られない）。"""
    parts, splats = _parts(tiles)
    if not parts:
        raise ValueError("三角形が 1 つもない")
    allv = np.vstack([p[2] for p in parts])
    mid = (allv.min(0) + allv.max(0)) / 2
    R = enu_basis(mid)
    ground = np.percentile((allv - mid) @ R.T[:, 2], 2)

    from . import glb

    os.makedirs(os.path.join(out, "tex"), exist_ok=True)
    # 画像の変換（HEIC の展開と JPEG）は GIL を放すので、スレッドで並べる（8 本で 4 倍ほど速い）
    pool = ThreadPoolExecutor(min(8, os.cpu_count() or 1))
    saving = []
    groups, blobs, off = [], [], 0
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for key, material, X, UV, F in parts:
        used, F = np.unique(F, return_inverse=True)
        F = F.reshape(-1, 3)
        P = (X[used] - mid) @ R.T
        P[:, 2] -= ground
        lo, hi = np.minimum(lo, P.min(0)), np.maximum(hi, P.max(0))
        uv = UV[used]   # v は上向き（OBJ と同じ）。three.js の既定（flipY）にそのまま合う
        hv = glb.heif_hevc(material.image) if hevc and material.format == "heic" and not getattr(material, "repeat", False) else None
        if hv:
            fn = f"tex/{key}.hevc"
            with open(os.path.join(out, fn), "wb") as fh:
                fh.write(struct.pack("<I", len(hv[0])) + hv[0] + hv[1])
            g = {"file": None, "hevc": fn, "nv": len(used), "nt": len(F)}
        else:
            fn = f"tex/{key}.jpg"
            saving.append(pool.submit(_save_jpeg, material, os.path.join(out, fn), quality))
            g = {"file": fn, "nv": len(used), "nt": len(F)}
        if getattr(material, "repeat", False):
            g["repeat"] = True           # 水面などの塗りつぶし用の画像。くり返して貼る
        for k, arr in (("pos", P.astype("<f4")), ("uv", uv.astype("<f4")), ("idx", F.astype("<u4"))):
            g[k] = off
            blobs.append(arr.tobytes())
            off += len(blobs[-1])
        groups.append(g)
    if splats:
        P = (np.vstack([X for X, _ in splats]) - mid) @ R.T
        P[:, 2] -= ground
        c = np.vstack([rgba for _, rgba in splats]).astype(np.float64) / 255
        # 低いものから順に描く（glb.tile_glb と同じ。奥から描かないと色が濁る）
        order = np.argsort(P.reshape(-1, 3, 3)[:, :, 2].mean(1), kind="stable")
        P, c = P.reshape(-1, 3, 3)[order].reshape(-1, 3), c[order]
        # three.js の頂点の色は線形の値なので、sRGB の色を線形に直す（暗い色が潰れないよう 16 ビットで）
        c[:, :3] = np.where(c[:, :3] <= 0.04045, c[:, :3] / 12.92, ((c[:, :3] + 0.055) / 1.055) ** 2.4)
        uv = np.tile(np.array([[0, 0], [1, 0], [0, 1]], np.float32), (len(c), 1))  # 3 つの頂点の重心座標 (u, v)
        g = {"file": None, "nv": len(P), "nt": len(c), "splat": True}
        for k, arr in (("pos", P.astype("<f4")), ("uv", uv.astype("<f4")),
                       ("col", np.repeat(np.round(c * 65535).astype("<u2"), 3, axis=0))):
            g[k] = off
            blobs.append(arr.tobytes())
            off += len(blobs[-1])
        groups.append(g)
    for s in saving:
        s.result()
    pool.shutdown()
    with open(os.path.join(out, "mesh.bin"), "wb") as fh:
        for b in blobs:
            fh.write(b)
    from .glb import SPLAT_SOFTNESS

    meta = dict(info, tiles=len(tiles), groups=groups, splatSoftness=SPLAT_SOFTNESS,
                radius=float(max(np.abs(lo[:2]).max(), np.abs(hi[:2]).max())))
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"))
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(HTML)
    if any("hevc" in g for g in groups):
        shutil.copyfile(os.path.join(os.path.dirname(__file__), "earth", "hevc.js"), os.path.join(out, "hevc.js"))
    return sum(g["nt"] for g in groups), hi - lo


def write_obj(tiles, path, quality=90):
    """OBJ と MTL と画像に書き出す（Blender などで開く用）。座標は write と同じ東・北・上。"""
    base = os.path.splitext(path)[0]
    d = os.path.dirname(os.path.abspath(path))
    allv = np.vstack([c.to_ecef(m.vertices) for _, c in tiles for m in c.meshes if m.kind == 0])
    mid = (allv.min(0) + allv.max(0)) / 2
    R = enu_basis(mid)
    ground = np.percentile((allv - mid) @ R.T[:, 2], 2)
    obj, mtl, n = [f"mtllib {os.path.basename(base)}.mtl"], [], 1
    for name, c in tiles:
        for mi, m in enumerate(c.meshes):
            if m.kind != 0:             # 範囲の端の帯や面は入れない
                continue
            P = (c.to_ecef(m.vertices) - mid) @ R.T
            P[:, 2] -= ground
            obj.append(f"o {name}_{mi}")
            obj += [f"v {x:.3f} {y:.3f} {z:.3f}" for x, y, z in P]
            obj += [f"vt {u:.6f} {v:.6f}" for u, v in m.uv]
            for mat, F in m.groups.items():
                key = f"{name}_{mi}_{mat}"
                img = f"{os.path.basename(base)}_{key}.jpg"
                open(os.path.join(d, img), "wb").write(to_jpeg(c.materials[mat], quality))
                mtl += [f"newmtl {key}", "Kd 1 1 1", "illum 0", f"map_Kd {img}", ""]
                obj.append(f"usemtl {key}")
                obj += [f"f {a + n}/{a + n} {b + n}/{b + n} {cc + n}/{cc + n}" for a, b, cc in F]
            n += len(P)
    open(base + ".obj", "w").write("\n".join(obj) + "\n")
    open(base + ".mtl", "w").write("\n".join(mtl) + "\n")
