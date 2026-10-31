"""読んだタイル（C3M）を glTF のバイナリ（glb）にする。地球儀のビューア（earth）用。

頂点は地心座標（ECEF）で、軽くするため KHR_mesh_quantization で詰める: 位置はタイルの中心
からの差を int16 に（間隔はノードの scale、中心は translation（float64）に置く。4.9 km の
タイルでも 8 cm 刻み）、UV は uint16 に。軸は ECEF のまま（z が北極）なので、読む側は軸の
変換をしないこと（Cesium なら upAxis: Z、forwardAxis: X）。材質は光の影響を受けない
KHR_materials_unlit で、画像は縦横を 2 のべき乗に縮めた JPEG。地形の上に置くので、Flyover の範囲の端にある、平らな地図に
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
# スプラットの縁のぼかし: 不透明度 = (27 × 重心座標の積) ^ これ。iOS 27 のマップの夢洲の画面 3 枚と、視点を合わせて
# 比べて決めた（0.25〜3 のうち 1.5 がいちばん近い。スプラットの 1 番目の値を 1 枚ずつ使うと少し遠くなる）
SPLAT_SOFTNESS = 1.5
MAIN = 0        # C3M のメッシュの種類のうち、本体（c3m.Mesh.kind を見よ）
# HEVC のまま渡す画像の数の上限。1 枚で Y と UV の 2 つのテクスチャを使い、シェーダーで使えるテクスチャは
# 16 個までのことが多い（R3D は高さ区分ごとにテクスチャが 2 枚以上のこともある）。超えた分は JPEG にする
HEVC_MAX = 6
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def _jpeg_pot(material, quality):
    """材質の画像を、縦横をそれぞれ 1 つ下の 2 のべき乗に縮めた JPEG に。Cesium は 2 のべき乗でない
    画像を、縮小用の段（ミップマップ）を作る前に次の 2 のべき乗まで広げる（新しい Flyover に多い
    1152〜1376 px は 2048 px になり、GPU のメモリが 2.5 倍ほどになる）ので、先にこちらで縮めておく。"""
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    img = Image.open(io.BytesIO(material.image))
    size = tuple(1 << (n.bit_length() - 1) for n in img.size)
    if size == img.size:
        return to_jpeg(material, quality)
    out = io.BytesIO()
    img.convert("RGB").resize(size, Image.LANCZOS).save(out, "JPEG", quality=quality)
    return out.getvalue()


def _box(b, a, z, name):
    """b[a:z] の箱の並びから name の箱を探し、(中身の始まり, 箱の終わり) を返す。"""
    while a + 8 <= z:
        n, t = struct.unpack_from(">I4s", b, a)
        if n < 8 or a + n > z:
            return None
        if t == name:
            return a + 8, a + n
        a += n
    return None


def heif_hevc(heic):
    """HEIC が HEVC の 1 コマだけ（新しい Flyover の画像はそう）なら、(hvcC の中身, コマのデータ
    （4 バイトの長さ付きの NAL の並び）, 幅, 高さ)。分割された画像などほかの形なら None。"""
    try:
        meta = _box(heic, 0, len(heic), b"meta")
        a, z = meta[0] + 4, meta[1]                   # meta は版と旗の 4 バイトのあとに箱が並ぶ
        ii = _box(heic, a, z, b"iinf")
        if heic[ii[0]] != 0 or struct.unpack_from(">H", heic, ii[0] + 4)[0] != 1:   # 項目が 1 つ（版 0）
            return None
        infe = _box(heic, ii[0] + 6, ii[1], b"infe")
        if heic[infe[0]] < 2 or heic[infe[0] + 8:infe[0] + 12] != b"hvc1":
            return None
        ipco = _box(heic, *_box(heic, a, z, b"iprp"), b"ipco")
        hvcc = _box(heic, *ipco, b"hvcC")
        w, h = struct.unpack_from(">II", heic, _box(heic, *ipco, b"ispe")[0] + 4)
        loc = _box(heic, a, z, b"iloc")[0]
        if heic[loc] != 0 or heic[loc + 4:loc + 6] != b"\x44\x00":   # 版 0、位置と長さが 4 バイト
            return None
        n, _, _, ext, off, length = struct.unpack_from(">HHHHII", heic, loc + 6)
        if n != 1 or ext != 1 or off + length > len(heic):
            return None
        return heic[hvcc[0]:hvcc[1]], heic[off:off + length], w, h
    except (TypeError, struct.error):
        return None


def tile_glb(c3ms, quality=85, hevc=False):
    """c3ms: 同じタイルの C3M（高さ区分ごと）の並び。三角形がなければ None。

    hevc なら、新しい Flyover の画像（HEIC）は JPEG にせず、HEVC のままビューアに渡す（ビューアが
    GPU の専用回路で展開して、Y と UV の面のままテクスチャにする）。その材質には画像を付けず、
    extras.hevc に設定（config）とコマ（data）の bufferView、大きさ、番号（slab）を入れる。
    どの材質の画像かは、頂点の属性 _SLAB（位置の 4 つ目の int16。HEVC でない材質は 255）で分ける。"""
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

    def slab_attr(pos):
        # 位置の 4 つ目の int16（もとは詰め物。材質の番号を入れておく）を指す属性
        a = accessors[pos]
        accessors.append({"bufferView": a["bufferView"], "byteOffset": 6, "componentType": INT16,
                          "count": a["count"], "type": "SCALAR"})
        return len(accessors) - 1

    images, materials, mat_index, slabs, prims = [], [], {}, {}, []
    for X, UV, F, key in parts:
        if key not in mat_index:
            ci, mat = key
            m = c3ms[ci].materials[mat]
            nh = sum(s != 255 for s in slabs.values())
            hv = (heif_hevc(m.image) if hevc and m.format == "heic" and not m.repeat and nh < HEVC_MAX
                  else None)              # くり返して貼る画像は JPEG にする（標本の取り方で wrap を指定する）
            if hv:
                config, data, w, h = hv
                slabs[key] = nh
                materials.append({"pbrMetallicRoughness": {"metallicFactor": 0, "roughnessFactor": 1},
                                  "doubleSided": True, "extensions": {"KHR_materials_unlit": {}},
                                  "extras": {"hevc": {"config": view(config), "data": view(data),
                                                      "width": w, "height": h, "slab": slabs[key]}}})
            else:
                slabs[key] = 255
                images.append({"bufferView": view(_jpeg_pot(m, quality)), "mimeType": "image/jpeg",
                               "repeat": m.repeat})
                materials.append({"pbrMetallicRoughness": {"baseColorTexture": {"index": len(images) - 1},
                                                           "metallicFactor": 0, "roughnessFactor": 1},
                                  "doubleSided": True, "extensions": {"KHR_materials_unlit": {}}})
            mat_index[key] = len(materials) - 1
        used, idx = np.unique(F, return_inverse=True)
        idx = idx.reshape(-1)          # numpy 2 は F と同じ形で返す
        q = np.round((X[used] - center) / step).astype(np.int32)
        P = np.zeros((len(used), 4), "<i2")      # 1 頂点 8 バイト（4 バイトの倍数にそろえる）
        P[:, :3] = q
        P[:, 3] = slabs[key] if hevc else 0
        uv = UV[used].astype(np.float64)
        uv[:, 1] = 1 - uv[:, 1]        # C3M は v が上向き、glTF は下向き
        if uv.min() >= 0 and uv.max() <= 1:
            tex = accessor(np.round(uv * 65535).astype("<u2"), UINT16, "VEC2", ARRAY_BUFFER, normalized=True)
        else:
            tex = accessor(uv.astype("<f4"), FLOAT, "VEC2", ARRAY_BUFFER)
        itype, idt = (UINT16, "<u2") if len(used) < 65536 else (UINT32, "<u4")
        pos = accessor(P, INT16, "VEC3", ARRAY_BUFFER, minmax=(q.min(0).tolist(), q.max(0).tolist()), stride=8)
        attrs = {"POSITION": pos, "TEXCOORD_0": tex}
        if hevc:
            attrs["_SLAB"] = slab_attr(pos)
        prims.append({"attributes": attrs,
                      "indices": accessor(idx.astype(idt), itype, "SCALAR", ELEMENT_ARRAY_BUFFER),
                      "material": mat_index[key]})
    if splats:
        # 1 つにまとめて、低いものから順に描く。半透明なので奥から描かないと手前の色が奥の色に塗られて濁る。
        # 視点はたいてい上なので、高さの順で奥からの順の代わりになる（Apple の画面との比べで、視点ごとに
        # 並べ直したのと同じ近さになった）
        X = np.vstack([X for X, _ in splats]).reshape(-1, 3, 3)
        rgba = np.vstack([rgba for _, rgba in splats])
        order = np.argsort(X.mean(1) @ (center / np.linalg.norm(center)), kind="stable")
        splats = [(X[order].reshape(-1, 3), rgba[order])]
        images.append({"bufferView": view(_soft_triangle()), "mimeType": "image/png"})
        materials.append({"pbrMetallicRoughness": {"baseColorTexture": {"index": len(images) - 1},
                                                   "metallicFactor": 0, "roughnessFactor": 1},
                          "alphaMode": "BLEND", "doubleSided": True,
                          "extensions": {"KHR_materials_unlit": {}}})
        for X, rgba in splats:
            q = np.round((X - center) / step).astype(np.int32)
            P = np.zeros((len(q), 4), "<i2")
            P[:, :3] = q
            P[:, 3] = 255                   # HEVC の材質ではない
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
            attrs = {"POSITION": pos, "COLOR_0": col, "TEXCOORD_0": tex}
            if hevc:
                attrs["_SLAB"] = slab_attr(pos)
            prims.append({"attributes": attrs, "material": len(materials) - 1})
    while len(bin_) % 4:
        bin_.append(0)

    gltf = {"asset": {"version": "2.0", "generator": "flyover-web"},
            "extensionsUsed": ["KHR_materials_unlit", "KHR_mesh_quantization"],
            "extensionsRequired": ["KHR_mesh_quantization"],
            "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "translation": center.tolist(), "scale": [step] * 3}],
            "meshes": [{"primitives": prims}],
            "materials": materials, "accessors": accessors, "bufferViews": views,
            "buffers": [{"byteLength": len(bin_)}]}
    if images:                          # glTF では空の並びは書かない
        # 標本の取り方 0 は端で止める、1 はくり返す（水面などの塗りつぶし用の画像）
        gltf.update({"textures": [{"source": i, "sampler": int(im.pop("repeat", False))} for i, im in enumerate(images)],
                     "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071},
                                  {"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
                     "images": images})
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
