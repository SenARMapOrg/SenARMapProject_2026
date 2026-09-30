# Mac での開発環境のセットアップ

IKU NAVI のサブプログラム（Python 製のツール・API・スクレイパー）を Mac で動かすまでの手順。
Apple シリコン（M1〜）・Intel のどちらの Mac でも同じ手順で動く。

| プログラム | 場所 | 使う依存ファイル | 用途 |
|---|---|---|---|
| IKU NAVI ツール | `programs/IKU_NAVI_Tools` | `requirements.txt` | マップ編集・イベント設定・ルート検証・画像チェック・画像リネーム・人物ぼかし・SVG座標取得（デスクトップアプリ） |
| 経路探索API | `programs/3D_Graph` | `requirements.txt`（テストもするなら `requirements-dev.txt`） | ナビの経路探索。ルート検証・画像チェックのタブもこれを使う |
| シラバス取得 | `programs/syllabus_courses` | `requirements.txt` | 時間割共有の科目データを作る |
| 時間割共有 | `programs/timetables` | `package.json`（Node.js） | Web アプリ（Python ではない。[最後の章](#7-時間割共有nodejs)を参照） |

## 1. Homebrew と Python を入れる（初回のみ）

「ターミナル」アプリを開いて、以下を1行ずつ実行する。

```bash
# Homebrew（Mac 用のパッケージ管理ツール）。すでに入っていれば不要
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

インストールの最後に「Next steps」として `echo ... >> ~/.zprofile` と `eval ...` の2行が表示されるので、
それもそのままコピーして実行する（これをしないと `brew` コマンドが見つからない）。
途中でコマンドライン・デベロッパツール（Xcode Command Line Tools）のインストールも自動で行われる。

```bash
brew install python@3.13 git
python3.13 --version    # Python 3.13.x と出れば OK
```

> 本番サーバー（Docker）と GitHub Actions も Python 3.13 を使っているので、合わせておくと安全。
> 3.10 でも動くことは確認している。

## 2. リポジトリを取得する（初回のみ）

```bash
cd ~/Documents     # 置きたい場所
git clone https://github.com/SenARMapOrg/SenARMapProject_2026.git
cd SenARMapProject_2026
```

## 3. 仮想環境（venv）を作る

Homebrew の Python に直接 `pip install` すると `error: externally-managed-environment` で止まる。
**仮想環境（venv）を作って、その中に入れる**。ツールは PyTorch を含んで重いので、
API・スクレイパー用（リポジトリ直下の `.venv`）とは分けて、ツールのフォルダの中に作る。

以下はすべてリポジトリの一番上（`SenARMapProject_2026/`）で実行する。

### 3-1. IKU NAVI ツール

```bash
python3.13 -m venv programs/IKU_NAVI_Tools/.venv
source programs/IKU_NAVI_Tools/.venv/bin/activate    # 行頭に (.venv) と出れば有効
pip install -r programs/IKU_NAVI_Tools/requirements.txt
```

- ダウンロードは合計で約 1.3GB あり、数分かかる。大半は人物ぼかし用の ultralytics（PyTorch）
- **人物ぼかしを使わない場合**は、`requirements.txt` の `ultralytics` の行を除いて入れれば数百MBで済む
  （入っていなくても他のタブは普通に使える）

### 3-2. 経路探索API・シラバス取得

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r programs/3D_Graph/requirements-dev.txt    # API＋シラバス取得＋テスト（pytest）一式
```

API を動かすだけなら `programs/3D_Graph/requirements.txt`、シラバス取得だけなら
`programs/syllabus_courses/requirements.txt` でもよい。

> どちらの `.venv` もリポジトリには含まれない（`.gitignore` 済み）。
> 別の venv に切り替えるときは `deactivate` してから、使いたい方を `source .../bin/activate` する。

## 4. 起動する

新しくターミナルを開いたときは、毎回まずリポジトリの一番上に `cd` して、`source .../bin/activate` をする。

### IKU NAVI ツール

```bash
source programs/IKU_NAVI_Tools/.venv/bin/activate
cd programs/IKU_NAVI_Tools
python main.py                 # 前回開いていたタブで起動
python main.py route_checker   # タブを指定して起動（map_editor / events / route_checker / image_checker /
                               #   image_renamer / human_remover / svg_pointer）
```

ルート検証・画像チェックのタブは経路探索API（`http://localhost:5001`）を使うので、
**別のターミナル**で次の API を先に起動しておく。

### 経路探索API

```bash
source .venv/bin/activate
cd programs/3D_Graph
python app.py                  # http://localhost:5001 で起動。止めるときは Ctrl + C
```

ブラウザで http://localhost:5001/3d/ を開くと 3D の経路グラフが見られる。

### シラバス取得

```bash
source .venv/bin/activate
cd programs/syllabus_courses
python scrape.py --by-dept     # 詳しいオプションは programs/syllabus_courses/README.md
```

## 5. テスト

```bash
source .venv/bin/activate
pytest                         # リポジトリの一番上で。経路探索API・ナビ画面・シラバス取得のテスト

source programs/IKU_NAVI_Tools/.venv/bin/activate
pip install pytest             # 初回のみ
pytest programs/IKU_NAVI_Tools/tests    # ツールのテスト
```

## 6. Mac でつまずきやすい点

| 症状 | 対処 |
|---|---|
| `zsh: command not found: python`（または `pip`） | venv を有効にしていない。`source .venv/bin/activate` などをしてから実行する（venv の外では `python3.13` と打つ） |
| `error: externally-managed-environment` | venv の外で `pip install` している。3章の手順で venv を作ってその中で入れる |
| `zsh: command not found: brew` | Homebrew のインストール後に表示された「Next steps」の2行を実行していない。ターミナルを開き直して再実行する |
| マップ編集でカメラが映らない | 「システム設定」→「プライバシーとセキュリティ」→「カメラ」で、使っているアプリ（ターミナル / VS Code など）を許可し、アプリを再起動する |
| ルート検証・画像チェックで接続エラー | 経路探索API（`python app.py`）が別のターミナルで起動しているか確認する |
| 人物ぼかしの初回だけ時間がかかる | 初回に YOLOv8 のモデル（`yolov8n-seg.pt`、約6MB）を自動でダウンロードしている。2回目以降は不要 |
| 人物ぼかしのタブに「必要なライブラリが入っていません」 | `ultralytics` を入れていない。`pip install ultralytics`（または requirements.txt を丸ごと）を実行する |
| `SSL: CERTIFICATE_VERIFY_FAILED` | python.org のインストーラーで入れた Python を使っている。「アプリケーション」→「Python 3.x」→「Install Certificates.command」を実行するか、Homebrew の Python で venv を作り直す |

## 7. 時間割共有（Node.js）

時間割共有（`programs/timetables`）だけは Python ではなく Node.js で動く。GitHub Actions と同じ Node 22 を入れる。

```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zprofile   # Intel Mac は /usr/local/opt/node@22/bin
source ~/.zprofile
node --version       # v22.x と出れば OK

cd programs/timetables
npm install          # 依存を入れる（初回・package-lock.json が変わったとき）
npm run build        # 初回は先に1回ビルドしておく
npm run dev          # http://localhost:8788 で起動（詳しくは programs/timetables/README.md の「1. ローカル開発」）
```
