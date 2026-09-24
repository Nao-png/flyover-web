"""Python 版の C3M の読み取りが、retroplasma の Go 版と同じ結果になるかを確かめる。

    python scripts/compare_go.py <dump-json.exe> <C3M ファイルかフォルダ>...

dump-json は Go 版で C3M を読んで JSON に書き出す小さな道具（README の「Go 版との照合」）。
頂点・UV（float32 のビット単位）と、材質ごとの三角形が完全に一致すれば MATCH。
"""
import glob
import json
import os
import subprocess
import sys
import time
import traceback

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import flyover  # noqa: E402


def compare(exe, path):
    ref = json.loads(subprocess.run([exe, path], capture_output=True, text=True, check=True).stdout)
    t = time.time()
    c = flyover.parse(open(path, "rb").read())
    dt = time.time() - t
    same = (np.allclose(c.rotation.ravel(), ref["rotation"])
            and np.allclose(c.translation, ref["translation"])
            and len(c.meshes) == len(ref["meshes"]))
    for m, r in zip(c.meshes, ref["meshes"]):
        same &= np.array_equal(m.vertices, np.array(r["v"], np.float32))
        same &= np.array_equal(m.uv, np.array(r["uv"], np.float32))
        same &= sorted(map(str, m.groups)) == sorted(r["groups"])
        for k, F in m.groups.items():
            same &= np.array_equal(F, np.array(r["groups"].get(str(k), [])))
    return same, dt, [len(m.vertices) for m in c.meshes]


def main():
    exe, paths = sys.argv[1], sys.argv[2:]
    files = [f for p in paths
             for f in (sorted(glob.glob(os.path.join(p, "*.c3m"))) if os.path.isdir(p) else [p])]
    ok = 0
    for f in files:
        try:
            same, dt, nv = compare(exe, f)
        except Exception:
            print(os.path.basename(f), "ERROR")
            traceback.print_exc()
            continue
        ok += same
        print(f"{os.path.basename(f):28s} {'MATCH' if same else 'DIFF '} {dt:5.2f}s  頂点 {nv}")
    print(f"{ok}/{len(files)} 一致")
    sys.exit(0 if ok == len(files) else 1)


if __name__ == "__main__":
    main()
