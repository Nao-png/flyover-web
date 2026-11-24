"""ブラウザで C3M を読む flyover/earth/c3m.js（--r3d なら R3D を読む r3d.js）が、Python 版（flyover/c3m.py、
r3d.py）と同じ結果になるかを確かめる。

    python scripts/check_c3m_js.py [--r3d] [ファイルかフォルダ]... [--every N]

Node.js で動かし、メッシュごとの頂点・UV（float32 のビット単位）、材質ごとの三角形、種類を SHA-1 にして比べる。
R3D では、スプラット（頂点・色・値）、材質の画像（テクスチャ・日の当たり方・ガラスの地図・くり返すか）、撮った時刻も比べる。
指定がなければ cache/c3m/（cache/r3d/）を --every（既定 40）枚に 1 枚ずつ使う。
"""
import glob
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from flyover import c3m, r3d  # noqa: E402

NODE = r"""
const fs = require('fs'), crypto = require('crypto');
const { parse } = require(process.argv[1]), R3D = process.argv[2] === 'r3d';
const h = a => crypto.createHash('sha1').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const out = {};
for (const f of fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const b = fs.readFileSync(f);
  try {
    const t = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    const meshes = t.meshes.map(m => ({ kind: m.kind, v: h(m.vertices), uv: h(m.uv),
      groups: [...m.groups].map(([k, g]) => [k, h(g)]) }));
    if (!R3D) { out[f] = meshes; continue; }
    const sp = t.splats;
    out[f] = { meshes, captured: t.captured,
      splats: sp ? [h(sp.vertices), h(sp.rgba), h(sp.params)] : null,
      materials: t.materials.map(m => [m.format, h(m.image), m.shade ? h(m.shade) : null, m.gloss ? h(m.gloss) : null, m.repeat]) };
  } catch (e) { out[f] = 'error: ' + e.message; }
}
process.stdout.write(JSON.stringify(out));
"""


def sha(a):
    return hashlib.sha1(np.ascontiguousarray(a).tobytes()).hexdigest()


def main(args):
    every = 40
    is_r3d = "--r3d" in args
    if is_r3d:
        args.remove("--r3d")
    ext, parse = (".r3d", r3d.parse) if is_r3d else (".c3m", c3m.parse)
    if "--every" in args:
        i = args.index("--every")
        every = int(args[i + 1])
        del args[i:i + 2]
    files = []
    for a in args or [os.path.join(ROOT, "cache", ext[1:])]:
        files += sorted(glob.glob(os.path.join(a, "**", "*" + ext), recursive=True)) if os.path.isdir(a) else [a]
    files = [f for f in files if os.path.getsize(f) > 0][::every if not args else 1]
    js = os.path.join(ROOT, "flyover", "earth", "r3d.js" if is_r3d else "c3m.js")
    r = subprocess.run(["node", "-e", NODE, js, "r3d" if is_r3d else "c3m"], input="\n".join(files), capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(r.stderr)
    got = json.loads(r.stdout)
    ok = bad = 0
    for f in files:
        try:
            t = parse(open(f, "rb").read())
            ref = [{"kind": m.kind, "v": sha(m.vertices.astype("<f4")), "uv": sha(m.uv.astype("<f4")),
                    "groups": [[k, sha(g.astype("<i4"))] for k, g in m.groups.items()]} for m in t.meshes]
            if is_r3d:
                sp = t.splats
                bh = lambda b: hashlib.sha1(b).hexdigest() if b else None  # noqa: E731
                ref = {"meshes": ref, "captured": t.captured,
                       "splats": [sha(sp.vertices.astype("<f4")), sha(sp.rgba.astype(np.uint8)),
                                  sha(sp.params.astype("<f4"))] if sp is not None else None,
                       "materials": [[m.format, bh(m.image), bh(m.shade), bh(m.gloss), bool(m.repeat)]
                                     for m in t.materials]}
        except Exception as e:
            ref = None
            err = str(e)
        g = got.get(f)
        if ref is None:
            same = isinstance(g, str)
            note = f"どちらも読めない（Python: {err}、JS: {g}）" if same else f"Python だけ読めない: {err}"
        else:
            same = g == ref
            note = "" if same else ("JS だけ読めない: " + g if isinstance(g, str) else "結果が違う")
        ok += same
        bad += not same
        if not same or note:
            print(("MATCH " if same else "DIFF  ") + os.path.relpath(f, ROOT), note)
    print(f"{ok} / {ok + bad} 枚が一致")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
