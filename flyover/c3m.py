"""C3M（Flyover の 1 タイル分の 3D モデル）を読む。

retroplasma/flyover-reverse-engineering の pkg/fly/c3m/c3m.go の移植。2026 年の
サーバーが返すものは先頭が `C3M 03 07` で、5 バイト目が当時の 3 から 7 に上がって
いるが、第 3 版の読み方でそのまま読める。画像は JPEG（形式 0）か HEIC（形式 13）。
"""
import struct
from dataclasses import dataclass, field

import numpy as np

from . import edgebreaker, huffman


@dataclass
class Material:
    image: bytes
    format: str          # "jpeg" か "heic"


@dataclass
class Mesh:
    vertices: np.ndarray                     # (n, 3) float32、タイルの局所座標
    uv: np.ndarray                           # (n, 2) float32、v は上向き（OBJ と同じ）
    groups: dict = field(default_factory=dict)   # 材質の番号 -> 三角形 (k, 3) int32
    # メッシュの種類（見出しの 4 バイト目）。0 が本体。Flyover の範囲の端のタイルには、平らな地図に
    # つなぐためのものが入っている: 4 は縁の帯（ほぼ一様な灰色）、3 は高さ 0（海面）の平らな面
    kind: int = 0


@dataclass
class C3M:
    rotation: np.ndarray                     # (3, 3) 局所 -> 地心（ECEF）
    translation: np.ndarray                  # (3,) ECEF [m]
    materials: list
    meshes: list

    def to_ecef(self, v):
        return np.asarray(v, np.float64) @ self.rotation.T + self.translation


def quaternion_matrix(qx, qy, qz, qw):
    return np.array([
        [1 - 2 * qy * qy - 2 * qz * qz, 2 * qx * qy - 2 * qw * qz, 2 * qx * qz + 2 * qw * qy],
        [2 * qx * qy + 2 * qw * qz, 1 - 2 * qx * qx - 2 * qz * qz, 2 * qy * qz - 2 * qw * qx],
        [2 * qx * qz - 2 * qw * qy, 2 * qy * qz + 2 * qw * qx, 1 - 2 * qx * qx - 2 * qy * qy]])


TEXTURE_FORMATS = {0: "jpeg", 13: "heic"}


def parse(data):
    if len(data) < 134 or data[:3] != b"C3M" or data[3] != 3:
        raise ValueError("C3M 第 3 版ではない")
    if data[4] not in (3, 7):
        raise NotImplementedError(f"C3M のサブ版 {data[4]}")
    rot = trans = None
    materials, meshes = [], []
    off = 6
    for _ in range(data[5]):
        kind = data[off]
        if kind == 0:
            q = struct.unpack_from("<4d", data, off + 9)
            rot = quaternion_matrix(*q)
            trans = np.array(struct.unpack_from("<3d", data, off + 41))
            off += 113
        elif kind == 1:
            off, materials = _materials(data, off)
        elif kind == 2:
            off, meshes = _meshes(data, off)
        elif kind == 3:      # シーングラフかアニメーション。読み飛ばし方が分からない
            break
        else:
            raise ValueError(f"不明な項目 {kind}")
    return C3M(rot, trans, materials, meshes)


def _materials(data, off):
    off += 5
    n = struct.unpack_from("<i", data, off)[0]
    off += 4
    out = []
    for _ in range(n):
        mtype = data[off]
        if mtype > 10:
            raise NotImplementedError(f"材質の種類 {mtype}")
        fmt = data[off + 3]
        toff, _, tlen2 = struct.unpack_from("<iii", data, off + 4)
        if fmt not in TEXTURE_FORMATS:
            raise NotImplementedError(f"画像の形式 {fmt}")
        out.append(Material(bytes(data[toff:toff + tlen2]), TEXTURE_FORMATS[fmt]))
        off += 16
    return off, out


def _meshes(data, off):
    off += 5
    n = struct.unpack_from("<i", data, off)[0]
    off += 4
    out = []
    for _ in range(n):
        mtype = huffman.i8(data[off])
        size = huffman.i8(data[off + 1]) + (huffman.i8(data[off + 2]) << 8)
        if mtype != 2:
            raise NotImplementedError(f"メッシュの種類 {mtype}")
        o3 = off + 3
        a8 = huffman.i8(data[o3])
        ta = huffman.make_table(*huffman.read_params(data, o3 + 1))
        tb = huffman.make_table(*huffman.read_params(data, o3 + 15))
        uv_count, faces_count, group_count, data_off = struct.unpack_from("<iiii", data, o3 + 29)
        if group_count == 0 and a8 == 6:
            raise NotImplementedError("??? 1")
        if a8 == 8:
            raise NotImplementedError("??? 2")
        rmd = edgebreaker.decompress(data, data_off, ta, tb)
        if rmd["uv_count"] != uv_count or rmd["faces_count"] != faces_count:
            raise ValueError("展開したメッシュの数が先頭の数と合わない")
        mesh = _assemble(rmd)
        mesh.kind = data[o3]
        out.append(mesh)
        off += size
    return off, out


def _assemble(rmd):
    """角ごとの UV 番号で頂点を並べ直す（UV の継ぎ目で頂点が分かれる）。c3m.go の parseMesh の後半を
    numpy でまとめて計算したもの（あちらは 1 つずつ、前から詰めるか後ろから詰めるかを決める）。"""
    n_uv, n_f = rmd["uv_count"], rmd["faces_count"]
    faces = np.asarray(rmd["faces"], np.int64)[:3 * n_f]
    res5 = np.asarray(rmd["res5"], np.int64)
    res8 = np.asarray(rmd["res8"], np.int64)
    # fst[res5[c]] = faces[c] を前から順に（同じ番号は後のもので上書き）
    fst = np.zeros(n_uv, np.int64)
    u, last = np.unique(res5[:3 * n_f][::-1], return_index=True)
    fst[u] = faces[::-1][last]
    # res8 が 0 でない頂点は後ろから、0 の頂点は前から詰める
    back = res8[fst] != 0
    snd = np.where(back, n_uv - np.cumsum(back), np.cumsum(~back) - 1)
    V = np.empty((n_uv, 3), np.float32)
    UV = np.empty((n_uv, 2), np.float32)
    V[snd] = rmd["vertices"][fst]
    UV[snd] = rmd["uv"][:n_uv]
    corner = snd[res5].astype(np.int32).reshape(-1, 3)
    groups = {}
    g = np.asarray(rmd["groups"])
    for mat in dict.fromkeys(g.tolist()):     # 出てきた順
        groups[int(mat)] = corner[g == mat]
    return Mesh(V, UV, groups)
