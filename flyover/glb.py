"""読んだタイル（C3M）を glTF のバイナリ（glb）にする。地球儀のビューア（earth）用。

頂点は地心座標（ECEF）で、軽くするため KHR_mesh_quantization で詰める: 位置はタイルの中心
からの差を int16 に（間隔はノードの scale、中心は translation（float64）に置く。4.9 km の
タイルでも 8 cm 刻み）、UV は uint16 に。軸は ECEF のまま（z が北極）なので、読む側は軸の
変換をしないこと（Cesium なら upAxis: Z、forwardAxis: X）。材質は光の影響を受けない
KHR_materials_unlit で、画像は JPEG。地形の上に置くので、Flyover の範囲の端にある、平らな地図に
つなぐための帯と面（c3m.Mesh.kind が 0 でないもの）は入れない。
"""
import json
import struct

import numpy as np

from .web import to_jpeg

FLOAT, INT16, UINT16, UINT32 = 5126, 5122, 5123, 5125
MAIN = 0        # C3M のメッシュの種類のうち、本体（c3m.Mesh.kind を見よ）
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def tile_glb(c3ms, quality=85):
    """c3ms: 同じタイルの C3M（高さ区分ごと）の並び。三角形がなければ None。"""
    parts = []   # (ECEF の頂点, UV, 三角形, (C3M の番号, 材質の番号))
    for ci, c in enumerate(c3ms):
        for m in c.meshes:
            if m.kind != MAIN:          # 範囲の端の、平らな地図につなぐための帯や面は入れない
                continue
            X = c.to_ecef(m.vertices)
            for mat, F in m.groups.items():
                if len(F):
                    parts.append((X, m.uv, F, (ci, mat)))
    if not parts:
        return None
    lo = np.min([X.min(0) for X, *_ in parts], axis=0)
    hi = np.max([X.max(0) for X, *_ in parts], axis=0)
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
