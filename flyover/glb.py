"""読んだタイル（C3M）を glTF のバイナリ（glb）にする。地球儀のビューア（earth）用。

頂点は地心座標（ECEF）で、軽くするため KHR_mesh_quantization で詰める: 位置はタイルの中心
からの差を int16 に（間隔はノードの scale、中心は translation（float64）に置く。4.9 km の
タイルでも 8 cm 刻み）、UV は uint16 に。軸は ECEF のまま（z が北極）なので、読む側は軸の
変換をしないこと（Cesium なら upAxis: Z、forwardAxis: X）。材質は光の影響を受けない
KHR_materials_unlit で、画像は JPEG。地形の上に置くので、Flyover の範囲の端にある、平らな地図に
つなぐための帯と面（c3m.Mesh.kind が 0 でないもの）は入れない。

新しい Flyover の三角形のスプラット（木など。r3d.Splats）は、頂点の色（RGBA）を付けた半透明の
三角形にする。Apple は三角形の内側ほど濃く縁で消えるように描くので、共通の小さな画像（重心座標の
積から作った、縁ほど透明になるもの）を貼って近い見た目にする。
"""
import io
import json
import struct

import numpy as np

from .web import to_jpeg

UINT8, FLOAT, INT16, UINT16, UINT32 = 5121, 5126, 5122, 5123, 5125
SPLAT_SOFTNESS = 0.5     # スプラットの縁のぼかし: 不透明度 = (27 × 重心座標の積) ^ これ
MAIN = 0        # C3M のメッシュの種類のうち、本体（c3m.Mesh.kind を見よ）
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def tile_glb(c3ms, quality=85):
    """c3ms: 同じタイルの C3M（高さ区分ごと）の並び。三角形がなければ None。"""
    parts = []   # (ECEF の頂点, UV, 三角形, (C3M の番号, 材質の番号))
    splats = []  # (ECEF の頂点 (3N, 3), RGBA (N, 4))
    for ci, c in enumerate(c3ms):
        for m in c.meshes:
            if m.kind != MAIN:          # 範囲の端の、平らな地図につなぐための帯や面は入れない
                continue
            X = c.to_ecef(m.vertices)
            for mat, F in m.groups.items():
                if len(F):
                    parts.append((X, m.uv, F, (ci, mat)))
        sp = getattr(c, "splats", None)
        if sp is not None:
            keep = sp.rgba[:, 3] > 0    # 見えないもの（不透明度 0）は入れない
            if keep.any():
                splats.append((c.to_ecef(sp.vertices[keep].reshape(-1, 3)), sp.rgba[keep]))
    if not parts and not splats:
        return None
    lo = np.min([X.min(0) for X, *_ in parts] + [X.min(0) for X, _ in splats], axis=0)
    hi = np.max([X.max(0) for X, *_ in parts] + [X.max(0) for X, _ in splats], axis=0)
    center = (lo + hi) / 2
    step = max((hi - lo).max() / 2, 1e-3) / 32767     # int16 の 1 刻みの長さ [m]

    bin_, views, accessors = bytearray(), [], []

    def view(data, target=None, stride=None):
        while len(bin_) % 4:
            bin_.append(0)
        v = {"buffer": 0, "byteOffset": len(bin_), "byteLength": len(data)}
        if target:
            v["target"] = target
        if stride:
            v["byteStride"] = stride
        bin_.extend(data)
        views.append(v)
        return len(views) - 1

    def accessor(arr, ctype, kind, target=None, minmax=False, stride=None, normalized=False, count=None):
        a = {"bufferView": view(arr.tobytes(), target, stride), "componentType": ctype,
             "count": count or len(arr), "type": kind}
        if minmax:
            a["min"], a["max"] = minmax
        if normalized:
            a["normalized"] = True
        accessors.append(a)
        return len(accessors) - 1

    images, materials, mat_index, prims = [], [], {}, []
    for X, UV, F, key in parts:
        if key not in mat_index:
            ci, mat = key
            images.append({"bufferView": view(to_jpeg(c3ms[ci].materials[mat], quality)),
                           "mimeType": "image/jpeg"})
            materials.append({"pbrMetallicRoughness": {"baseColorTexture": {"index": len(images) - 1},
                                                       "metallicFactor": 0, "roughnessFactor": 1},
                              "doubleSided": True, "extensions": {"KHR_materials_unlit": {}}})
            mat_index[key] = len(materials) - 1
        used, idx = np.unique(F, return_inverse=True)
        idx = idx.reshape(-1)          # numpy 2 は F と同じ形で返す
        q = np.round((X[used] - center) / step).astype(np.int32)
        P = np.zeros((len(used), 4), "<i2")      # 1 頂点 8 バイト（4 バイトの倍数にそろえる）
        P[:, :3] = q
        uv = UV[used].astype(np.float64)
        uv[:, 1] = 1 - uv[:, 1]        # C3M は v が上向き、glTF は下向き
        if uv.min() >= 0 and uv.max() <= 1:
            tex = accessor(np.round(uv * 65535).astype("<u2"), UINT16, "VEC2", ARRAY_BUFFER, normalized=True)
        else:
            tex = accessor(uv.astype("<f4"), FLOAT, "VEC2", ARRAY_BUFFER)
        itype, idt = (UINT16, "<u2") if len(used) < 65536 else (UINT32, "<u4")
        pos = accessor(P, INT16, "VEC3", ARRAY_BUFFER, minmax=(q.min(0).tolist(), q.max(0).tolist()), stride=8)
        prims.append({"attributes": {"POSITION": pos, "TEXCOORD_0": tex},
                      "indices": accessor(idx.astype(idt), itype, "SCALAR", ELEMENT_ARRAY_BUFFER),
                      "material": mat_index[key]})
    if splats:
        images.append({"bufferView": view(_soft_triangle()), "mimeType": "image/png"})
        materials.append({"pbrMetallicRoughness": {"baseColorTexture": {"index": len(images) - 1},
                                                   "metallicFactor": 0, "roughnessFactor": 1},
                          "alphaMode": "BLEND", "doubleSided": True,
                          "extensions": {"KHR_materials_unlit": {}}})
        for X, rgba in splats:
            q = np.round((X - center) / step).astype(np.int32)
            P = np.zeros((len(q), 4), "<i2")
            P[:, :3] = q
            pos = accessor(P, INT16, "VEC3", ARRAY_BUFFER, minmax=(q.min(0).tolist(), q.max(0).tolist()), stride=8)
            # glTF の頂点の色は線形の値なので、sRGB の色を線形に直す（暗い色が潰れないよう 16 ビットで）
            c = rgba.astype(np.float64) / 255
            c[:, :3] = np.where(c[:, :3] <= 0.04045, c[:, :3] / 12.92, ((c[:, :3] + 0.055) / 1.055) ** 2.4)
            col = accessor(np.repeat(np.round(c * 65535).astype("<u2"), 3, axis=0), UINT16, "VEC4",
                           ARRAY_BUFFER, normalized=True)
            # 三角形ごとに、画像の (0,0)・(1,0)・(0,1) の角を当てる（4 バイトの倍数にそろえて 2 バイト空ける）
            T = np.zeros((len(q), 4), np.uint8)
            T[1::3, 0] = 255
            T[2::3, 1] = 255
            tex = accessor(T, UINT8, "VEC2", ARRAY_BUFFER, normalized=True, stride=4)
            prims.append({"attributes": {"POSITION": pos, "COLOR_0": col, "TEXCOORD_0": tex},
                          "material": len(materials) - 1})
    while len(bin_) % 4:
        bin_.append(0)

    gltf = {"asset": {"version": "2.0", "generator": "flyover-web"},
            "extensionsUsed": ["KHR_materials_unlit", "KHR_mesh_quantization"],
            "extensionsRequired": ["KHR_mesh_quantization"],
            "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "translation": center.tolist(), "scale": [step] * 3}],
            "meshes": [{"primitives": prims}],
            "materials": materials,
            "textures": [{"source": i, "sampler": 0} for i in range(len(images))],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
            "images": images, "accessors": accessors, "bufferViews": views,
            "buffers": [{"byteLength": len(bin_)}]}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    return b"".join([struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(js) + 8 + len(bin_)),
                     struct.pack("<I4s", len(js), b"JSON"), js,
                     struct.pack("<I4s", len(bin_), b"BIN\0"), bytes(bin_)])


def _soft_triangle(size=64):
    """スプラット用の画像（PNG）。u, v を重心座標の 2 つとみなし、三角形 u + v <= 1 の内側だけ、
    (27 × 3 つの重心座標の積) ^ SPLAT_SOFTNESS の不透明度（中心で 1、縁で 0）。色は白。"""
    from PIL import Image

    u, v = np.meshgrid((np.arange(size) + 0.5) / size, (np.arange(size) + 0.5) / size)
    w = 1 - u - v
    a = np.clip(27 * u * v * w, 0, 1) ** SPLAT_SOFTNESS
    img = np.full((size, size, 4), 255, np.uint8)
    img[..., 3] = np.round(a * 255)
    out = io.BytesIO()
    Image.fromarray(img).save(out, "PNG")          # (size, size, 4) の uint8 は RGBA になる
    return out.getvalue()
