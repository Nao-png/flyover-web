# flyover-web

日本語 | [English](README.en.md)

Apple マップの Flyover（街の 3D 航空写真）を、Windows のブラウザで見るためのツールです。
Python だけで動き、Mac も Apple のアプリも要りません。

- **地球儀ビューア** — Google Earth のように地球全体から寄っていくと、Flyover のある街が 3D で表示されます。操作も Google Earth と同じです
- **書き出し** — 指定した地点のまわりを、ブラウザで見られる一式や OBJ（Blender などで開ける 3D の形式）に書き出します

> [!WARNING]
> このツールは、Apple が一般には公開していない仕組みを使って Apple マップのデータを取得します。Apple の利用規約に反する可能性があります。使うのは自己責任で、取得したデータを再配布しないでください。このプロジェクトは Apple とは関係ありません。

## 必要なもの

- Python 3（3.13 で動作確認）
- WebGL が使えるブラウザ（Chrome か Edge で確認）
- インターネット接続（データは見るたびに Apple から取得します）

Windows 11 で動作を確認しています。

## はじめかた

```bash
git clone https://github.com/Nao-png/flyover-web
cd flyover-web
pip install -r requirements.txt
python scripts/earth.py
```

ブラウザで http://localhost:8000/ を開きます。ポートを変えるときは `python scripts/earth.py 8080` のように指定します。

## 地球儀ビューア

地球全体から寄っていくと、Flyover のある所では 3D の街が読み込まれます。下地には Apple の衛星画像と地形を使います。

- **検索**: 左上の欄に地名か「緯度, 経度」を入れます。3D のある場所には印が付きます
- **読み込みの速さ**: 最初の 3D は 2〜3 秒で出ます。初めての場所で全部が細かくなるまでは 10〜20 秒ほどかかります（回線の速さしだい）。一度見た場所は `cache/` に保存されるので、2 回目からは 7 秒ほどです
- **視点の保存**: 今の視点は URL（`#緯度,経度,高度m,方位h,傾きt`）に入るので、ブックマークすればその視点から開けます

### 操作

右下の `?` ボタンか `?` キーで、いつでも一覧を出せます。

| 操作 | マウス | キーボード |
|---|---|---|
| 移動 | ドラッグ | 矢印 |
| 拡大・縮小 | ホイール（カーソルの方へ）、右ドラッグ | PageUp / PageDown、+ / - |
| 回転 | Shift + 左右にドラッグ、中ボタンでドラッグ | Shift + ← → |
| 傾き | Shift + 上下にドラッグ、Shift + ホイール | Shift + ↑ ↓ |
| 見回す | Ctrl + ドラッグ | |
| 寄る・離れる | ダブルクリック・右ダブルクリック | |
| 高度を上げる・下げる | | Shift + PageUp / PageDown |
| 北を上に・真上から・両方 | 方位磁針をクリック | N・U・R |
| 2D と 3D の切り替え | 右下のボタン | O |
| 止める・検索・操作一覧 | | Space・/・? |

Alt キーを押しながら動かすと、ゆっくり動きます。

## 書き出し

指定した地点のまわりのタイルを取得して、ブラウザで見られる一式（three.js）に書き出します。

```bash
python scripts/export.py 36.5722 136.6680 --out out/higashi-chaya   # 金沢・ひがし茶屋街
python scripts/serve.py out                                          # http://localhost:8000/higashi-chaya/
```

ひがし茶屋街のまわり 9×9 タイル（約 280 m 四方、88 タイル・15 万三角形）で、取得から書き出しまで約 10 秒です。

| 引数 | 既定 | 意味 |
|---|---|---|
| `--out` | （必須） | 書き出すフォルダ |
| `--zoom` | 20 | タイルの細かさ（20 で 1 タイル約 30 m 四方） |
| `--radius` | 4 | 中心のタイルから前後左右に何タイル取るか（4 で 9×9 タイル） |
| `--heights` | 4 | 要求する高さの区分の数（高い建物ほど多く要る） |
| `--jobs` | 4 | 同時に要求する数 |
| `--obj` | なし | OBJ にも書き出す（ファイル名を指定。例: `--obj out/kanazawa.obj`） |
| `--quality` | 90 | 画像の JPEG の画質 |
| `--cache` | `cache` | 取得したデータの保存先 |

## 仕組み

1. Apple マップのアプリと同じように、設定ファイル（リソースマニフェスト）からタイルの URL と認証に使う値を得ます
2. タイルを位置（`x, y, z`）と高さの区分（`h`）で要求します
3. 届いた 3D モデル（C3M 形式）を展開します。形は Apple 独自の方式で圧縮され、画像は HEIC 形式です
4. ブラウザで扱える形（glb と JPEG）に変換して表示します

詳しい仕組みと、読み込みを速くするための工夫は [docs/how-it-works.md](docs/how-it-works.md) にまとめています。

## ファイル構成

| ファイル | 中身 |
|---|---|
| `scripts/earth.py` | 地球儀ビューアを起動 |
| `scripts/export.py` | 取得から書き出しまで |
| `scripts/serve.py` | 書き出した一式を手元で配るだけのサーバー |
| `scripts/compare_go.py` | Go 版との照合 |
| `flyover/client.py` | Apple への要求（設定ファイル、地域の選択、認証、タイルの取得） |
| `flyover/c3m.py`、`edgebreaker.py`、`huffman.py`、`_fast.py` | C3M の読み取りと展開（`_fast.py` は numba で速くした版） |
| `flyover/glb.py`、`terrain.py`、`earth.py`、`earth/` | 地球儀ビューアのサーバーと画面 |
| `flyover/web.py` | 書き出し（ブラウザ用と OBJ） |
| `tools/retroplasma-2026.patch` | Go 版を今の Apple のサーバーで動かすための修正（照合用） |

## テスト

Apple のデータなしで確かめられる部分のテストです。

```bash
python -m pytest tests -q
```

C3M の読み取りは、元の Go 版と**ビット単位で一致**することを、本物のタイル 209 枚（金沢 88 枚・渋谷 121 枚）で確かめています。確かめ直す手順は [docs/how-it-works.md](docs/how-it-works.md#go-版との照合) にあります。

## 元になったもの

- [retroplasma/flyover-reverse-engineering](https://github.com/retroplasma/flyover-reverse-engineering)（Go、2021 年にアーカイブ）の解析と実装を Python に移しました。C3M の展開は、Go の整数の桁あふれの振る舞いまで含めて書き写しています。2026 年の Apple のサーバーでは当時から変わった所があり、それに合わせて直しています
- 認証の手順は [sk-zk/streetlevel](https://github.com/sk-zk/streetlevel)（Look Around 用）の実装を参考にしました
- 地球儀の表示には [CesiumJS](https://cesium.com/platform/cesiumjs/) を、地名の検索には [OpenStreetMap の Nominatim](https://nominatim.openstreetmap.org/) を使っています

## 注意

- 取得したデータ（`cache/`、`out/`）は Apple の著作物です。リポジトリには入らないようにしてあります（`.gitignore`）。公開や再配布はしないでください
- Apple のサーバーの仕様は予告なく変わります。変わると動かなくなることがあります
- サーバーは自分の PC の中（127.0.0.1〜127.0.0.17）からの接続だけを受け付けます
- 移植元の retroplasma/flyover-reverse-engineering にライセンスの表記がないため、このリポジトリにもライセンスを付けていません
