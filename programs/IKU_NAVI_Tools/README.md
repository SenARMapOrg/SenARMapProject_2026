# IKU NAVI ツール

IKU NAVI のデータ作成・検証に使うデスクトップアプリ（PyQt6）。以前は別々のプログラムだった7つのツールを、
1つのアプリにまとめ、画面上部のタブで切り替えて使う。

## 起動方法

```bash
cd programs/IKU_NAVI_Tools
python3.13 -m venv .venv && source .venv/bin/activate   # 初回のみ venv を作る（2回目からは source だけ）
pip install -r requirements.txt
python main.py                 # 前回開いていたタブで起動
python main.py route_checker   # 指定したタブで起動
```

Mac での Python のインストールから、つまずきやすい点（カメラの許可など）までは
[docs/setup_mac.md](../../docs/setup_mac.md) を参照。

Python は **3.9 以上**で動く（Mac に最初から入っている `python3`（3.9）でも可）。

## 起動しないとき

まず次を実行し、表示されたものをまるごとコピーして相談相手に送る。OS・Python・Qt の版、Qt のプラグインの場所、
タブごとに必要なライブラリが入っているかが一度に分かる。

```bash
python main.py --doctor
```

`python main.py` は画面を作る前に、よくある原因（古い Python・PyQt6 が入っていない／壊れている・画面のプラグインが無い・
別の Qt の設定が混ざっている）を確かめ、分かったものは直し方を日本語で表示する。
Anaconda や別の Qt が残した `QT_PLUGIN_PATH` などの設定は、自動で無視して PyQt6 自身のプラグインを使う。

| 症状 | 直し方 |
|---|---|
| `TypeError: unsupported operand type(s) for \|`（古い版のツール） | 最新のツールに更新する（Python 3.9 でも動くよう直してある） |
| `No module named 'PyQt6'` | `pip install -r requirements.txt`（venv を使っているなら、有効にしてから） |
| **Windows**: `DLL load failed while importing QtCore` | Microsoft Visual C++ 再頒布可能パッケージ（https://aka.ms/vs/17/release/vc_redist.x64.exe ）を入れる。直らなければ `py -m pip install --upgrade --force-reinstall PyQt6 PyQt6-Qt6` |
| `Could not find the Qt platform plugin "cocoa"/"windows"` / `no Qt platform plugin could be initialized` | PyQt6 を入れ直す: `pip install --upgrade --force-reinstall PyQt6 PyQt6-Qt6`。Anaconda の環境で動かしている場合は、Anaconda ではない Python の venv で動かす |
| **Linux**: `Could not load the Qt platform plugin "xcb"` | `sudo apt install libxcb-cursor0`（Qt 6.5 以降で必要）。WSL なら WSLg が使えるか、SSH なら `ssh -X` を確かめる |
| **Mac（Apple シリコン）**: ライブラリが入らない・`incompatible architecture` | Intel 用の Python（Rosetta）で動いている。`--doctor` の CPU が `arm64` になる Python（Homebrew など）を使う |
| `Populating font family aliases took … Replace uses of missing font family …` | 害の無い警告（無いフォントの代わりを探した）。最新のツールでは出ないようにしてある（ツール内のフォント指定を OS の標準フォントに変え、手描きのフロアマップの中のフォント指定による警告は表示しない） |
| 人物ぼかしのタブだけ使えない | `pip install ultralytics`（PyTorch ごと入るので数百MB〜1GB）。ほかのタブはこれが無くても使える |

## タブ一覧

| タブ | 引数名 | 内容 | 旧プログラム |
|---|---|---|---|
| マップ編集 | `map_editor` | SVGフロアマップ上でノード・エッジを入力し、経路写真を撮影する（[詳しい使い方](iku_tools/map_editor/README.md)） | `programs/Map_Editor` |
| イベント設定 | `events` | イベントモードの検索候補（`data/event.csv`）を編集する（[詳しい使い方](iku_tools/events/README.md)） | `programs/events` |
| ルート検証 | `route_checker` | 全教室ペア間のルートを経路探索APIから取得し、異常を検出する | `programs/Route_Checker` |
| 画像チェック | `image_checker` | CDN 上の経路写真がエッジごとに揃っているかを確認する | `programs/Image_Checker` |
| 画像リネーム | `image_renamer` | 経路写真を一括でリネーム・リサイズする（リサイズは裏で進み、下のステータスバーに進み具合と中止ボタンが出る） | `programs/Image_Renamer` |
| 人物ぼかし | `human_remover` | YOLOv8 で経路写真の人物を検出し、ぼかし・モザイクで匿名化する | `programs/Human_Remover` |
| SVG座標取得 | `svg_pointer` | SVGをクリックして座標を取得し、クリップボードにコピーする。既存の点の x・y の近くをクリックするとぴったり合わせる（吸着。Alt/option+クリックで解除）ほか、一覧で選んだ点を縦・横にそろえられる | `programs/SVG_Pointer`（PyQt5 から移植） |

ルート検証・画像チェックは経路探索API（`programs/3D_Graph`、既定は `http://localhost:5001`）を使うので、
先に `cd programs/3D_Graph && python app.py` で起動しておく。

## 使い勝手について

- **タブは最初に開いたときに読み込む。** 起動が速く、人物ぼかしのように重いライブラリ（OpenCV・ultralytics）が
  必要なタブがあっても、それが入っていない環境で他のタブは使える。読み込めなかったタブには、原因と
  対処（`pip install -r requirements.txt` など）が表示される
- **閉じるときは各タブに確認する。** マップ編集・イベント設定に未保存の変更があれば、それぞれの確認が出る。
  そこでキャンセルすると、アプリは閉じずにそのタブに切り替わる
- 最後に開いていたタブとウィンドウの大きさは次回に引き継ぐ
- ウィンドウのタイトルには、開いているタブの状態（編集中の建物など）が出る

## 構成

```
IKU_NAVI_Tools/
├── main.py              # 起動スクリプト
├── requirements.txt     # 全タブ分の依存
├── iku_tools/
│   ├── app.py           # タブで各ツールを切り替えるメインウィンドウ（タブの並びは TOOLS）
│   ├── common/          # 各ツールが共有する部品（データの場所・APIアクセス・配色・表示名）
│   ├── map_editor/      # 各ツール。どれも window.py の MainWindow がタブの中身になる
│   ├── events/
│   ├── route_checker/
│   ├── image_checker/
│   ├── image_renamer/
│   ├── human_remover/   # yolov8n-seg.pt を置くとそれを使う（無ければ初回に自動ダウンロード。Git 管理外）
│   └── svg_pointer/
└── tests/               # pytest（PyQt6 が入っていない環境では自動でスキップ）
```

### ツールを追加するには

1. `iku_tools/<名前>/window.py` に、引数なしで作れる `MainWindow`（`QMainWindow`）を置く
2. 必要なライブラリが入っているかを事前に調べたい場合は、同じファイルに `missing_dependencies()`
   （足りないパッケージ名のリストを返す関数）を置く
3. `iku_tools/app.py` の `TOOLS` に1行足す

各ツールは互いに import しない。共通で使うものは `common/` に置く。

## テスト

```bash
# リポジトリ直下で（他のテストと一緒に実行される）
pytest programs/IKU_NAVI_Tools/tests
```

全タブが読み込めること、タブの切り替え・前回のタブの復元、読み込めないタブがあっても他が使えること、
未保存のタブがあるときに閉じないこと、SVG座標取得の基本操作を確認している。
