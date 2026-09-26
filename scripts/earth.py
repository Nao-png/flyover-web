"""地球儀のビューア。Google Earth のように地球全体から寄っていくと、Flyover のある所では
3D の街が見える。Flyover のタイル・衛星画像・地形は、見ている所のものをその場で Apple から
取る（cache/ に保存し、次からはそれを使う）。

    python scripts/earth.py [ポート]          # http://localhost:8000/

ポートは引数、なければ環境変数 PORT、それもなければ 8000。
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flyover import earth  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int, nargs="?", default=int(os.environ.get("PORT", 8000)))
    ap.add_argument("--cache", default="cache", help="取得したものの保存先")
    a = ap.parse_args()
    earth.serve(a.port, a.cache)


if __name__ == "__main__":
    main()
