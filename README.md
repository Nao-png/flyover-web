# flyover-web

Apple Maps の Flyover（3D の航空写真）を Windows のブラウザで見る。Python だけで動き、Mac は要らない。

指定した地点のまわりのタイルを Apple のサーバーから取り、読んで、three.js のビューアで表示する。

```bash
pip install -r requirements.txt
python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya   # 金沢・ひがし茶屋街
python scripts/serve.py out                                          # http://localhost:8000/higashi-chaya/
```

`export.py` の主な引数:

| 引数 | 既定 | 意味 |
|---|---|---|
| `--zoom` | 20 | タイルのズーム（20 で 1 枚約 30 m 四方） |
| `--radius` | 4 | 中心のタイルから ±何枚まで（4 で 9×9 枚、約 280 m 四方） |
| `--heights` | 4 | 要求する高さ区分の数（h = 0〜3） |
| `--jobs` | 4 | 同時に要求する数 |
| `--obj` | なし | OBJ にも書き出す（Blender などで開く用） |

取得したタイルは `cache/` に保存し、次からはそれを使う。ひがし茶屋街の 9×9 枚は 88 タイル・15 万三角形で、取得から書き出しまで約 10 秒。

## 仕組み

1. **リソースマニフェスト**（protobuf）を取り、Flyover のタイル（style 15）の URL と、認証に使う `tokenP2` を得る
2. マニフェストに書かれた**高さ区分の一覧**（`altitude-*.xml`）から、地点を含む地域を選ぶ
3. タイルを `x, y, z, h` で要求する。URL には `sid` と `accessKey`（AES-256-CBC で作る）を付ける
4. **C3M**（1 タイル分の 3D モデル）を読む。メッシュは Apple 独自の Edgebreaker の変種で圧縮されている（ハフマン符号 → CLERS 文字列 → 角の表 → 平行四辺形予測で頂点と UV を復元）。画像は HEIC
5. 地心座標（ECEF）を範囲の中心での東・北・上（メートル）に直し、HEIC を JPEG にして、ブラウザ用に書き出す

| ファイル | 中身 |
|---|---|
| `flyover/client.py` | マニフェスト、地域の選択、認証、タイルの取得 |
| `flyover/c3m.py` | C3M の読み取り（先頭情報、材質、メッシュの組み立て） |
| `flyover/edgebreaker.py` | メッシュの展開 |
| `flyover/huffman.py` | ハフマン符号の表と展開 |
| `flyover/web.py` | ブラウザ用と OBJ の書き出し、ビューア |
| `scripts/export.py` | 取得から書き出しまで |
| `scripts/serve.py` | 手元で配るだけのサーバー |
| `scripts/compare_go.py` | Go 版との照合（下記） |
| `tools/retroplasma-2026.patch` | Go 版を今のサーバーで動かすための修正（照合用） |

## 元になったもの

[retroplasma/flyover-reverse-engineering](https://github.com/retroplasma/flyover-reverse-engineering)（Go、2021 年でアーカイブ）の解析と実装を Python に移した。C3M の展開は、あちらの逆コンパイル由来の処理を、Go の整数の桁あふれやシフトの振る舞いまで含めて書き写している。

2026 年のサーバーでは、当時から次の点が変わっていた。ここではそれに合わせてある:

- マニフェストのファイル置き場（`cache_base_url`）が空になった → `https://gspe21-ssl.ls.apple.com/` を使う
- 地域ごとの目録 C3MM 第 1 版（style 14）が 404 になった（タイル座標で取る第 2 版 style 52 は返るが、形式が未解読）→ 目録を使わず、範囲のタイルと高さ区分を直接要求して、空の応答を飛ばす
- C3M の 5 バイト目（版）が 3 から 7 になった → 第 3 版の読み方でそのまま読める
- 画像が JPEG から HEIC（画像の形式 13）になった

また、元のツールは地域を「中心がいちばん近いもの」で選んでいて、地域の重なる東京などでは外れる（渋谷は 1 枚も取れなかった）。地域の名前 `Reg_z9_X_Y` はその地域が覆うズーム 9 のタイル番号なので、ここではそれで選ぶ。

認証の手順と `tokenP1` は [sk-zk/streetlevel](https://github.com/sk-zk/streetlevel) の Look Around 用の実装と同じ（あちらも retroplasma から来ている）。retroplasma の設定手順は `tokenP1` を取り出すために Xcode のシミュレータ SDK（約 2 GB）をダウンロードするが、ここでは不要。

## Go 版との照合

Python 版の読み取りは、本物のタイルで Go 版と**ビット単位で一致**することを確かめている（金沢 88 タイル・渋谷 121 タイル、計 209 タイルで一致）。確かめ直すには:

```bash
git clone https://github.com/retroplasma/flyover-reverse-engineering
cd flyover-reverse-engineering
git apply ../flyover-web/tools/retroplasma-2026.patch && rm -rf vendor
go build -o dump-json.exe ./cmd/dump-json
cd ../flyover-web
python scripts/compare_go.py ../flyover-reverse-engineering/dump-json.exe cache/c3m/*
```

パッチは Go 版そのものも今のサーバーで動くようにする（`go run ./cmd/export-obj 36.5722 136.6680 20 4 4`）。

テスト（Apple のデータなしで動く部分）:

```bash
python -m pytest tests -q
```

## 注意

- 取得したデータ（`cache/`、`out/`）は Apple の著作物。リポジトリには入れない（`.gitignore` 済み）
- Apple Maps のデータをこの形で取り出すことは Apple の利用規約に抵触しうる。このリポジトリは非公開を前提にしている
- 移植元の retroplasma/flyover-reverse-engineering にはライセンスの表記がない。そのため、このリポジトリにもライセンスを付けていない
