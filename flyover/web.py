"""読んだタイルを、ブラウザ（three.js）で見る一式に書き出す。

出力: index.html、mesh.bin（材質ごとの頂点・UV・三角形）、tex/*.jpg（材質ごとの画像）、
meta.json。座標は範囲の中心での東・北・上（メートル）で、いちばん低いあたりを高さ 0 にする。
"""
import io
import json
import os

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
  ダブルクリック: そこを回転の中心に</div>
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
const texs = await Promise.all(meta.groups.map(g => loader.loadAsync(g.file)));   // 並行して読む
const mats = [], meshes = [];
let tris = 0;
for (const [k, g] of meta.groups.entries()) {
  const tex = texs[k];
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, g.pos, g.nv * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, g.uv, g.nv * 2), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, g.idx, g.nt * 3), 1));
  geo.computeBoundingSphere();
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
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
window.view = { cam, ctl, meta };   // コンソールから視点を動かす用

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
(function loop() { requestAnimationFrame(loop); ctl.update(); ren.render(scene, cam); })();
</script>
"""


def enu_basis(p):
    """ECEF の点 p での東・北・上の単位ベクトル（行）。"""
    up = p / np.linalg.norm(p)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    return np.array([east, np.cross(up, east), up])


def to_jpeg(material, quality=90):
    """材質の画像を JPEG のバイト列に（HEIC は変換する）。"""
    if material.format == "jpeg":
        return material.image
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    out = io.BytesIO()
    Image.open(io.BytesIO(material.image)).convert("RGB").save(out, "JPEG", quality=quality)
    return out.getvalue()


def write(tiles, out, info, quality=90):
    """tiles: [(名前, C3M)]。info: meta.json に足す情報（lat, lon, region）。"""
    parts = []   # (名前, 材質, ECEF の頂点, UV, 三角形)
    for name, c in tiles:
        for mi, m in enumerate(c.meshes):
            X = c.to_ecef(m.vertices)
            for mat, F in m.groups.items():
                parts.append((f"{name}_{mi}_{mat}", c.materials[mat], X, m.uv, F))
    if not parts:
        raise ValueError("三角形が 1 つもない")
    allv = np.vstack([p[2] for p in parts])
    mid = (allv.min(0) + allv.max(0)) / 2
    R = enu_basis(mid)
    ground = np.percentile((allv - mid) @ R.T[:, 2], 2)

    os.makedirs(os.path.join(out, "tex"), exist_ok=True)
    groups, blobs, off = [], [], 0
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for key, material, X, UV, F in parts:
        used, F = np.unique(F, return_inverse=True)
        F = F.reshape(-1, 3)
        P = (X[used] - mid) @ R.T
        P[:, 2] -= ground
        lo, hi = np.minimum(lo, P.min(0)), np.maximum(hi, P.max(0))
        uv = UV[used]   # v は上向き（OBJ と同じ）。three.js の既定（flipY）にそのまま合う
        fn = f"tex/{key}.jpg"
        open(os.path.join(out, fn), "wb").write(to_jpeg(material, quality))
        g = {"file": fn, "nv": len(used), "nt": len(F)}
        for k, arr in (("pos", P.astype("<f4")), ("uv", uv.astype("<f4")), ("idx", F.astype("<u4"))):
            g[k] = off
            blobs.append(arr.tobytes())
            off += len(blobs[-1])
        groups.append(g)
    with open(os.path.join(out, "mesh.bin"), "wb") as fh:
        for b in blobs:
            fh.write(b)
    meta = dict(info, tiles=len(tiles), groups=groups,
                radius=float(max(np.abs(lo[:2]).max(), np.abs(hi[:2]).max())))
    json.dump(meta, open(os.path.join(out, "meta.json"), "w"))
    open(os.path.join(out, "index.html"), "w", encoding="utf-8").write(HTML)
    return sum(g["nt"] for g in groups), hi - lo


def write_obj(tiles, path, quality=90):
    """OBJ と MTL と画像に書き出す（Blender などで開く用）。座標は write と同じ東・北・上。"""
    base = os.path.splitext(path)[0]
    d = os.path.dirname(os.path.abspath(path))
    allv = np.vstack([c.to_ecef(m.vertices) for _, c in tiles for m in c.meshes])
    mid = (allv.min(0) + allv.max(0)) / 2
    R = enu_basis(mid)
    ground = np.percentile((allv - mid) @ R.T[:, 2], 2)
    obj, mtl, n = [f"mtllib {os.path.basename(base)}.mtl"], [], 1
    for name, c in tiles:
        for mi, m in enumerate(c.meshes):
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
