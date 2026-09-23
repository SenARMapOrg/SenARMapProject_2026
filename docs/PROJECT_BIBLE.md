# IKU NAVI（SenARMap 2026）完全技術ドキュメント

> 2026年度 専修大学 ネットワーク情報学部 生亀プロジェクト
> 本ドキュメントは `docs/technical_overview.md` / `docs/XYZ_Design.md` / `docs/API_Destination.md` / `docs/NonFunctionalRequirements.md` / `docs/NameDB_EventMode.md` / `docs/swarm.md` / `docs/k8s.md` / `docs/cloudflare_pages_migration.md` の内容と、リポジトリ全ファイル（コード・設定・データ）の精読結果を1本に統合したものです。
> 対象コミット: `ce55ecf`（ブランチ `ES`）/ 生成日: 2026-07-30

---

## 0. このドキュメントについて

このファイル1つで、他のドキュメントやコードを参照しなくても IKU NAVI というシステム（アーキテクチャ・データ形式・API仕様・全ソースコード・インフラ構成）を再構築できることを目標にしている。

- 第1部（1〜9章）は**解説**。設計判断の理由（Why）を可能な限り明記した。
- 第10章（付録）は**全ソースコード・全データファイルの完全収録**。バイナリ（画像・SVG・学習済みモデル）とビルド生成物（`__pycache__` 等）、機密ファイル（APIキーを含む `config.js` の実値、`.env` の実値）は除外し、該当箇所はプレースホルダで示す。

既存の `docs/*.md` は個別トピックの一次情報として引き続き有効。本ドキュメントは「一元化されたスナップショット」であり、今後の変更は元の `docs/*.md` 側に先に反映し、本ファイルは適宜再生成する運用を推奨する。

---

## 1. 今後の方向性（提案）

現状のコードベース・データ・運用ドキュメントを精読した上での提案。優先度順ではなく、テーマ別に整理した。

### 1.1 データ整備の完了（最優先・最も効果が大きい）

- **屋内フロアマップSVGが10号館分（`10_1F.svg`〜`10_6F.svg`）しか無い。** `node.csv`/`edge.csv` は1・2・5・7・8号館分も存在するのに、対応する `programs/html/svg/{building}_{floor}F.svg` が無い建物は屋内AR・SVGナビが機能しない（画面上でフロアマップが表示できない）。まずこのギャップを埋めることが体験完成度に直結する。
- **`name.csv`・`building_name.csv`・`event.csv` が全て空（ヘッダー行のみ）。** 表示名DB・イベントモードという機能自体はコードとして完成しているが、実データが入っていないため恩恵をまだ誰も受けていない。学園祭など次のイベント前に `event.csv` を先行して埋めておくと、機能の初適用がスムーズになる。
- `edge_image.csv` は999行と大きいが、`Image_Checker` で欠損検出を行い、抜けているエッジ画像（特に新規建物分）を定期的に埋める運用を継続する。

### 1.2 静的データ配信への移行（既に方針決定済み・実行フェーズへ）

`[[static-data-migration-plan]]` として既に合意済みの通り、経路探索を Flask（`programs/3D_Graph/`）から Cloudflare Pages 上の静的 `graph.json` + ブラウザ側 Dijkstra（JS）へ移行する計画がある。グラフ規模（約360ノード・300エッジ）ならブラウザ計算は1ms未満で終わる。

- **移行の効果**: VPS上の `python` コンテナと CORS 設定が不要になり、2GBサーバーの負荷が下がる。イベント時の同時接続増（現状ピーク100人想定）にも静的配信は強い。
- **移行のタイミング**: 現状のように「全建物データ投入中でロジックがPython1箇所に集中している方が変更が楽」というフェーズが終わり、経路ロジック（エスカレータ一方向・エレベータ除外・入口ペナルティ・目的エッジ延長など）が安定してから着手するのが合理的。1.1のデータ整備が一段落したタイミングが良い節目になる。
- 移行後も `/3d` ビューア・検証ツール群（Route_Checker等）はローカルFlask運用のまま残せる設計にしておくとよい（既にその前提で計画されている）。

### 1.3 テスト・CI の追加

- `.github/workflows/build-push.yml` は Docker イメージのビルド＆GHCRプッシュのみで、**自動テストが一切ない**。経路探索ロジック（`ikunavi/search.py`・`graph.py` の Dijkstra 周り：エスカレータ一方向補正・エレベータ除外・入口ペナルティ・目的エッジ延長）は仕様として文書化されているのに、コードの回帰を検知する仕組みがない。
- `Route_Checker` が持つ異常検出ロジック（`SAME_FLOOR_DETOUR` / `FLOOR_OVERSHOOT` / `FLOOR_REVERSAL` / `UNEXPECTED_BUILDING`）は、GUIツールとしてだけでなく **pytest化してCIに組み込む**と、データ追加やロジック変更のたびに手動チェックしなくて済む。全教室ペアの経路検証は数百〜数千パターンあるが、CIで自動実行できれば「新しい建物を足したら知らないうちに変な迂回ルートが生まれていた」という事故を防げる。
- `ikunavi` の関数（`transform.calc_transforms_from_anchors`・`graph.build_graph`・`search.extend_to_far_endpoint` など）はFlask依存がないので、pytestでのユニットテスト化が比較的容易。

### 1.4 屋内ARの発展

`[[project-senarmap]]` に記録されている通り、このプロジェクトの目標は「完全なARではなく、まず写真に矢印を合成するシンプルな形式のARマップ」であり、現在の実装（事前プリフェッチした経路写真＋方向矢印オーバーレイ）はその方針に忠実。屋外ARは既にThree.js+GPS+ジャイロによる本格的なAR実装がある。今後の発展としては:

- 屋内側も、既にある `svg_x/svg_y`（SVG座標）と `x/y/z`（実座標）の両方をノードが持っていることを活かし、将来的にはカメラ映像に矢印を重畳する簡易AR（WebXRやCSS 3D変換によるオーバーレイ）へ段階的に拡張できる。まずは屋外ARで確立した「カメラ・GPSのライフサイクル管理（必要な区間だけ起動・解放）」のノウハウを屋内にも転用しやすい。
- 音声ガイダンス（Web Speech API の `speechSynthesis`）は、既にステップナビゲーション構造（`path_edges` を1歩ずつ処理）があるため実装コストが低く、視覚障害者・両手が塞がっている利用者への対応として費用対効果が高い。

### 1.5 その他の改善候補

- **2つのプロジェクト紹介ページ（`programs/html/index.html` と `programs/Website/index.html`）がデザイン・内容ともに別物のまま並存している。** 実際に公開されるのは前者のみ（`deploy_env/pages/build.sh` のビルド出力ルートが `programs/html`）。後者は学内発表用と思われるが、リポジトリ内での位置づけが README 上でも曖昧なので、用途をコメントか README に明記しておくと将来の自分・新メンバーが混乱しない。
- **多言語対応（英語UI）が見当たらない。** 生田キャンパスは留学生・オープンキャンパス来場者の利用も想定されるなら、`name.csv`/`building_name.csv` の表示名テーブルの仕組みを流用して英語版表示名列を追加するのは比較的低コスト。
- **アクセシブルルート**（エレベータ優先・階段回避）は `use_elevator` パラメータで土台があるので、UIとして「なるべく階段を避ける」のようなプリセットを増やすのは低コストで価値が高い。
- **k8s関連ファイル（`deploy_env/k8s/`）は検証の末Swarmに敗れた不採用の実験**であることが `docs/k8s.md` に明記されている。新旧2系統のスクリプトが混在しており、今後もk8sに戻る予定がないなら、`archive/` ブランチに退避するかREADMEに「不採用・参考用」と明記して、誤って本番手順として参照されるリスクを下げるとよい。
- **Google Maps APIキー**はCloudflare Pagesのビルド時に環境変数から `config.js` に書き出す方式になっている。HTTPリファラ制限がキーにかかっているか（Google Cloud Console側の設定）を定期的に確認しておくと安全。

---

## 2. プロジェクト概要

**IKU NAVI** は専修大学生田キャンパス向けのAR対応ナビゲーションWebアプリ。CSVベースのノード・エッジグラフから Dijkstra 法で最短経路を計算し、屋外は Google Maps、屋内は SVG フロアマップでルートを可視化する。AR領域には経路上の写真（Cloudflare R2 CDN配信）を表示し、スマートフォンのGPS・ジャイロと組み合わせてステップ単位のナビゲーションを行う。

- 本番サイト: https://iku-navi.net/
- 開発方針（`[[project-senarmap]]`）: 「完全なARではなく、まず写真に矢印を合成するシンプルな形式のARマップ」を目標とし、まず3Dマップ（`/3d`）で経路探索ロジックの動作確認を行ってから、ナビゲーションUI・AR表示へと段階的に発展させてきた。ノードの3D座標 (x, y, z) はそのままカメラ座標系への変換に使える設計になっている。

### 技術スタック

| レイヤー | 技術 |
|---|---|
| バックエンド | Python 3 / Flask / Gunicorn / NetworkX（Dijkstra）/ pandas（CSV処理）|
| フロントエンド | HTML / CSS / Vanilla JavaScript（フレームワークなし）/ Google Maps JavaScript API / Three.js（屋外AR）/ インラインSVG（屋内マップ）|
| インフラ | Docker Swarm（ConoHa VPS）/ Cloudflare Pages（静的配信）/ Cloudflare Tunnel（API公開）/ Cloudflare R2（画像CDN）|
| 監視 | Prometheus / Grafana / cAdvisor |
| CI/CD | GitHub Actions（GHCRへのDockerイメージビルド＆プッシュ）|
| データ運用 | スプレッドシート → スクリプト → GitHub Push（CSV更新）|

### ディレクトリ構成（全体）

```
SenARMapProject_2026/
├── programs/
│   ├── 3D_Graph/        # Flaskバックエンド (app.py + ikunavi/) + 3D経路ビューア (templates/index.html)
│   ├── html/             # Cloudflare Pages 公開ルート（トップページ・navi・blog・SVG等）
│   ├── Website/          # プロジェクト紹介LP（学内発表用、Pagesでは非公開）
│   ├── Map_Editor/       # ノード・エッジ・経路写真の統合編集GUI（PyQt6）
│   ├── Image_Checker/    # CDN上のエッジ画像の存在検証GUI（PyQt6）
│   ├── Route_Checker/    # 全教室ペア経路の異常検出GUI（PyQt6）
│   ├── Image_Renamer/    # 画像一括リネーム/リサイズGUI（PyQt6）
│   ├── SVG_Pointer/      # SVG座標取得ツール（PyQt5）
│   └── Human_Remover/    # YOLOv8による人物匿名化バッチツール（PyQt6）
├── data/                 # CSV/JSON データ（ノード・エッジ・食堂・画像マッピング・名前DB等）
├── docs/                 # 設計ドキュメント（本ファイルを含む）
├── deploy_env/           # 本番Docker Swarm構成 + Cloudflare Pagesビルド + (不採用の)k8s構成
├── enviroments/           # ローカル開発用Docker構成
├── images/               # ロゴ・構成図
└── .github/workflows/    # CI（Dockerイメージビルド）
```

---

## 3. システムアーキテクチャ

### 3.1 全体構成（現行・本番）

```
                         [ユーザー]
                            │
                 ┌──────────┴──────────┐
                 │                     │
         iku-navi.net            api.iku-navi.net
         (Cloudflare Pages)      (Cloudflare Tunnel)
                 │                     │
      静的配信のみ（HTML/CSS/JS/SVG)   │
      Pages Functions等は未使用        │
                                       ▼
                              [ConoHa VPS / Docker Swarm]
                              ┌─────────────────────────┐
                              │ cloudflared（パスルーティング）│
                              │  ├ /redirect/* → counter │
                              │  └ それ以外     → python │
                              ├─────────────────────────┤
                              │ python (Flask+gunicorn)  │
                              │  ×2レプリカ（イベント時4+）│
                              ├─────────────────────────┤
                              │ counter (Rails)          │
                              │  ×2レプリカ               │
                              ├─────────────────────────┤
                              │ db (MariaDB 11)           │
                              ├─────────────────────────┤
                              │ prometheus / grafana /    │
                              │ cadvisor（監視）           │
                              └─────────────────────────┘

  画像配信: Cloudflare R2 → https://cdn.iku-navi.net （edge_image.csv で管理）
```

**2026-07-13 の大きな変更点**: それまで静的配信・リバースプロキシを担っていた `nginx` サービスを完全撤去し、静的コンテンツは Cloudflare Pages、API振り分けは cloudflared のパスルーティング機能で代替した（`[[cloudflare-pages-migration]]`）。理由は2GB VPSの負荷軽減。CORSはFlask側 `ikunavi/__init__.py` の `after_request` フックで対応し、`iku-navi.net` / `www.iku-navi.net` / `*.pages.dev`（Pagesプレビュー環境）を許可している。nginx関連ファイルはロールバック用に温存されているのみで本番稼働はしていない。

### 3.2 データフロー（経路探索1回分）

1. ユーザーがナビ画面（`navi/index.html`）で出発地・目的地（教室名／現在地GPS／イベント名）を指定
2. フロントエンドが `GET https://api.iku-navi.net/api/route?...` を呼び出す
3. Flask (`programs/3D_Graph/`) が起動時にキャッシュ済みの `networkx.DiGraph` に対し `nx.bidirectional_dijkstra` を実行（教室はエッジ属性なので両端点の全組み合わせを試して最短を採用）
4. レスポンス（`path_coords` / `path_edges` 等）をフロントが受け取り、ステップごとに屋外はGoogle Maps、屋内はSVGへ描画を振り分け
5. 各ステップの `from_node_to_node` キーで `GET /api/edge_images` から取得済みのCDN画像URLをAR領域に表示

### 3.3 データパイプライン（新しい建物・経路データを追加する作業の全体像）

```
① SVG_Pointer で既存フロアマップSVG上の座標を取得
        ↓（もしくは統合版の Map_Editor 単体で完結）
② Map_Editor でノード・エッジをCSVに入力しつつ、経路上の写真を撮影
        ↓
③ Human_Remover で撮影写真から通行人を自動匿名化（ぼかし/モザイク/インペイント）
        ↓
④ 写真をリネームして Cloudflare R2 CDN に手動アップロード
   （Image_Renamer で命名規則に一括整形）
        ↓
⑤ Image_Checker でCDN上の画像が全エッジ分揃っているか検証
        ↓
⑥ Route_Checker で全教室ペアの経路に異常（想定外の建物・フロア経由等）がないか検証
        ↓
⑦ 本番反映（gunicornコンテナ再起動でCSVキャッシュを更新）
```

※現行の `Map_Editor` はノード・エッジ入力とエッジ写真撮影（`captured_photos/` への保存 + `edge_image.csv` 登録）を1画面に統合したツールで、旧来 `SVG_Pointer` → 手動CSV編集 → `Image_Renamer` に分かれていた作業を代替する目的で作られた（詳細は7章）。CDNへのアップロード自体は依然として手動。

---

## 4. データ設計

### 4.1 座標系

- 単位: メートル（小数点第1位、10cm単位の精度）
- 各建物は**建物ローカル座標系**で入力し、変換パラメータでグローバル座標に統合する
- 軸: X軸=山を登る方向、Y軸=X軸プラス方向に対して右向き、Z軸=高さ
- 10号館の正面エントランス（node ID: 1）をグローバル座標の基準としている

### 4.2 ノードID体系（最重要）

```
屋内ノード（建物内）: id = building_id × 100,000 + local_id
屋外ノード（global_node.csv 由来）: id = local_id + 9,000,000
```

`ikunavi/config.py` の `ID_OFFSET = 100_000`、`GLOBAL_NODE_OFFSET = 9_000_000` が実装。`connect_edge.csv`（建物間直接接続、現状データなし）や `global_edge.csv` の `from/to` にはグローバルID（`building_id × 100000 + local_id`）または屋外ノードの元の小さいIDをそのまま書け、内部で自動変換される。

### 4.3 データディレクトリ構成

```
data/
├── {building_id}_bldg/       # 建物ごと（現存: 1, 2, 5, 7, 8, 10）
│   ├── node.csv               # 建物ローカル座標のノード
│   └── edge.csv                # エッジ（教室・通路・階段等）
├── global_node.csv            # 屋外ノード（グローバル座標 + 緯度経度）
├── global_edge.csv            # 屋外エッジ
├── connect_edge.csv           # 建物間直接接続エッジ（現状未使用・ファイルなし）
├── anchors.csv                # 建物ローカルID⇔屋外グローバルIDの対応（座標変換の自動計算に使用）
├── buildings.json             # 座標変換パラメータの手動設定・微調整
├── edge_image.csv             # エッジ→AR経路画像（CDNファイル名）マッピング（999行）
├── cafeteria_edge.csv         # 食堂情報（name/building/display_name、現状2件）
├── name.csv                   # 表示名DB（現状未入力・ヘッダーのみ）
├── building_name.csv          # 建物表示名DB（現状未入力・ヘッダーのみ）
└── event.csv                  # イベントモード用データ（現状未入力・ヘッダーのみ）
```

### 4.4 `{building_id}_bldg/node.csv`

| カラム | 型 | 説明 |
|---|---|---|
| `id` | int | 建物内で一意（1始まり推奨）|
| `x, y, z` | float | 建物ローカル座標（m）|
| `building` | int | 建物ID |
| `floor` | int | 階数 |
| `type` | int | 1=通常ノード, 2=出入り口 |
| `svg_x, svg_y` | float | （任意）SVGフロアマップ上のピクセル座標。Map_Editorが自動付与 |

### 4.5 `{building_id}_bldg/edge.csv`

| カラム | 型 | 説明 |
|---|---|---|
| `id` | int | 建物内で一意 |
| `name` | string | 教室名・施設名。複数は `;` 区切り（例 `101A;101B`）。空欄=通路 |
| `from, to` | int | 接続ノードID（同建物の `node.csv` の `id`）|
| `building, floor` | int | 所属建物・階（階をまたぐ場合は低い方）|
| `weight` | float | 探索コスト係数（コスト = weight × length + 入口ペナルティ）|
| `length` | float | 実距離（m）|
| `type` | int | エッジ種別（下表）|

#### エッジ種別 (`type`)

| 値 | 種別 | 方向性 | 備考 |
|:---:|---|:---:|---|
| 1 | 通常通路 | 双方向 | |
| 2 | 階段 | 双方向 | |
| 3 | エスカレータ（両方向可）| 双方向 | 停止中エスカレータ等 |
| 4 | エレベータ | 双方向 | `use_elevator=0` で探索から除外可 |
| 5 | 上りエスカレータ | **一方向**（低z→高z）| from/toの向きに関わらずz座標で自動補正 |
| 6 | 下りエスカレータ | **一方向**（高z→低z）| 同上 |
| 7 | 入口（屋内外接続）| 双方向 | `anchors.csv` から自動生成。`ENTRANCE_PENALTY=50.0` が加算される |

### 4.6 `global_node.csv`（屋外ノード）

| カラム | 型 | 説明 |
|---|---|---|
| `id` | int | 屋外ノードのローカルID（内部で+9,000,000）|
| `x, y, z` | float | グローバル座標（m）|
| `lat, lng` | float | GPS座標（WGS84）。GPSナビ・屋外ARで使用 |
| `floor` | int | 現行データは `0`（屋外判定は `building=0` で行うため探索に影響しない）|
| `type` | int | 1=通常, 2=出入り口 |
| `name` | string | 任意 |

### 4.7 `global_edge.csv`（屋外エッジ）

| カラム | 説明 |
|---|---|
| `id, name, from, to, floor, weight, length, type` | `{building_id}_bldg/edge.csv` に準ずる。`from/to` は屋外ノードなら `global_node.csv` の生ID、建物ノードなら `building_id×100000+local_id` |

### 4.8 座標変換パラメータ（アンカー方式・推奨）

`anchors.csv`（列: `building, local_node_id, global_node_id`）に、建物ローカルノードと対応する屋外グローバルノードのペアを記録すると、`ikunavi/transform.py` の `calc_transforms_from_anchors()` が以下を自動計算する。

| アンカー点数 | 自動計算内容 |
|:---:|---|
| 2点以上 | 平行移動 (tx, ty, tz) + Z軸回転 (rot_deg) を完全自動計算 |
| 1点のみ | 平行移動のみ自動計算。回転は `buildings.json` の `rot_deg`（省略時0°）|

変換式:
```
X_global = cos(θ)·X_local − sin(θ)·Y_local + tx
Y_global = sin(θ)·X_local + cos(θ)·Y_local + ty
Z_global = Z_local + tz
```

`buildings.json` は手動上書き・微調整用（`tz_offset` は常にアンカー計算結果に加算される追加オフセット）。アンカー1行ごとに、建物ローカルノード⇔屋外ノードを結ぶ **type=7（入口）** エッジが自動生成され、`ENTRANCE_PENALTY`（50.0）が経路コストに加算される。これにより「建物を通り抜けるだけの近道」が選ばれにくくなる。

現状の `data/anchors.csv` には10・7・8・2・5号館の計13アンカー行があり、`data/buildings.json` は10号館分のみ（全て0＝未調整）が明示的に設定されている。

### 4.9 その他のデータファイル

| ファイル | 列 | 用途 |
|---|---|---|
| `edge_image.csv` | `id, from, to, image_name` | AR経路写真のCDNファイル名マッピング。`from/to` はグローバルID |
| `cafeteria_edge.csv` | `name, building, display_name` | 食堂情報。`name` は `edge.csv` の `name` と一致させる |
| `name.csv` | `building, name, display_name` | 表示名DB。`building` 空欄なら全建物共通。優先順位: 建物指定 → 共通 → 生の名前 |
| `building_name.csv` | `building, display_name` | 建物表示名DB。未登録は `{building}号館`（0は`屋外`）にフォールバック |
| `event.csv` | `title, building, room, node_id, edge_id` | イベントモード（`navi/?event=1`）用。`room`/`node_id`/`edge_id` のいずれか1つで場所を指定。同一 `title` を複数行書くと最短候補に自動振り分け |

### 4.10 現行データのボリューム（2026-07-30時点）

| ファイル | 行数（ヘッダー除く目安）|
|---|---:|
| `10_bldg/node.csv` | 99 |
| `10_bldg/edge.csv` | 117 |
| `8_bldg/node.csv` | 48 |
| `8_bldg/edge.csv` | 57 |
| `1_bldg/node.csv` | 72 / `edge.csv` | 0（未整備）|
| `2_bldg/node.csv` | 32 / `edge.csv` | 33 |
| `5_bldg/node.csv` | 21 / `edge.csv` | 23 |
| `7_bldg/node.csv` | 31 / `edge.csv` | 29 |
| `global_node.csv` | 60 |
| `global_edge.csv` | 42 |
| `edge_image.csv` | 998 |
| `anchors.csv` | 13 |
| `cafeteria_edge.csv` | 2 |
| `name.csv` / `building_name.csv` / `event.csv` | 0（ヘッダーのみ）|

（フルデータは第10章付録に生CSVとして収録）

---

## 5. バックエンド（`programs/3D_Graph/`）

### 5.1 概要

Flask製のアプリ。データ読み込み・座標変換・グラフ構築・経路探索・API・3Dビューア（`/3d`）配信を担う。
`app.py` は `create_app()` を呼ぶだけのエントリポイントで、実装は `ikunavi/` パッケージにある。

| ファイル | 担当 |
|---|---|
| `app.py` | エントリポイント（gunicorn が読む `app:app`）|
| `ikunavi/config.py` | データファイルのパスと定数（`ID_OFFSET`・`ENTRANCE_PENALTY`・建物色・CORS許可オリジン等）|
| `ikunavi/transform.py` | 建物ローカル座標 → キャンパス共通座標 の変換パラメータ算出・適用 |
| `ikunavi/dataset.py` | CSV読み込み（全建物＋屋外を1組のDataFrameに正規化）|
| `ikunavi/graph.py` | `networkx.DiGraph` の構築 |
| `ikunavi/naming.py` | 内部識別子 → 表示名（`name.csv`・`building_name.csv`・`ignore.csv`）|
| `ikunavi/cache.py` | 起動後に一度だけ作る派生データ（DataFrame・グラフ・教室索引・イベント索引等）|
| `ikunavi/search.py` | 候補ノードへの解決と全組み合わせDijkstra |
| `ikunavi/serialize.py` | 探索結果 → APIレスポンス用dict（`path_result`・`dest_info` 等）|
| `ikunavi/payloads.py` | `/api/graph` 用ペイロード |
| `ikunavi/errors.py` | `ApiError` とそのJSON化 |
| `ikunavi/routes/` | エンドポイント（Blueprint: viewer / rooms / events / navigation / facilities / images）|

`[[static-data-migration-plan]]` により、全建物データ投入・経路ロジック安定化を待ってから、経路探索ロジックをJSへ移植し静的配信に切り替える計画。`dataset.py` + `graph.py` はそのまま `graph.json` の生成側に流用できる。

起動: `cd programs/3D_Graph && python app.py` → `http://localhost:5001`（本番は `gunicorn -w 4 -b 0.0.0.0:8000 app:app`）

### 5.2 キャッシュ機構

初回リクエスト時に全CSVを読み込み、モジュールレベルの変数にキャッシュする。**CSVを更新した場合はプロセス（gunicorn）を再起動しないと反映されない。**

| アクセサ（`ikunavi/cache.py`、表示名のみ `naming.py`）| 内容 |
|---|---|
| `get_data()` | pandas DataFrame（全建物・屋外を結合済み）|
| `get_graph(use_elevator)` | networkx.DiGraph（エレベータ有無で2種類キャッシュし切替コストをゼロに）|
| `get_room_index()` | 教室名→エッジ行の索引、API用整形済みリスト |
| `get_name_map()` / `get_building_name_map()` | 表示名DB |
| `get_event_index()` | イベントDB |
| `get_nodes_list()` / `get_node_xyz()` / `get_cafeteria_list()` | API用の整形済みノード一覧・座標表・食堂一覧 |
| `payloads.get_graph_payload()` | `/api/graph` レスポンス全体 |

`ikunavi.clear_all_caches()` で全キャッシュをリセット可能（現状APIエンドポイントとしては未公開、プロセス再起動が実質的なキャッシュクリア手段）。

### 5.3 データロード処理 (`dataset.load_data()`)

1. `buildings.json` を読み込み、`anchors.csv` があれば自動計算した変換パラメータで上書き
2. `data/*_bldg/` を走査し、各建物の `node.csv`/`edge.csv` にグローバルIDオフセットを付与、`transform.apply_transform()` で座標変換
3. `connect_edge.csv`（存在すれば）・`global_node.csv`（+9,000,000オフセット、`building=0` 付与）・`global_edge.csv`（屋外/建物ノードIDを自動判別して解決）を追加
4. `anchors.csv` の各行から type=7 の入口エッジを自動生成（ID起点は `8000000 + 行インデックス`）
5. 全データを結合し、座標欠損行を除外、`type` 列を整数正規化

### 5.4 グラフ構築 (`graph.build_graph()`)

`networkx.DiGraph`（有向グラフ）を使用。基本は双方向（順・逆エッジを両方追加）で無向グラフと等価に扱うが、エスカレータ（type 5/6）だけは以下のロジックで一方向のみ追加する:

```python
if edge_type == "5":  # 上りESC: z が低い→高い方向のみ
    lo, hi = (u, v) if G.nodes[u]["z"] <= G.nodes[v]["z"] else (v, u)
    G.add_edge(lo, hi, **edge_attrs)
elif edge_type == "6":  # 下りESC: z が高い→低い方向のみ
    hi, lo = (u, v) if G.nodes[u]["z"] >= G.nodes[v]["z"] else (v, u)
    G.add_edge(hi, lo, **edge_attrs)
```

エッジの重み（コスト）は `weight × length + (ENTRANCE_PENALTY if type==7 else 0)`。`use_elevator=False` の場合、type=4（エレベータ）のエッジ自体をグラフに追加しない（`build_graph` 呼び出し時点でスキップ）。

### 5.5 経路探索の考え方

教室・トイレ・食堂・イベントは**ノードではなくエッジの属性**として管理されているため、探索は「対象エッジの両端点」を候補ノード群とし、出発候補×目的候補の全組み合わせで `nx.bidirectional_dijkstra` を実行、最短のものを採用する。

```
for s_node in start_candidates:
    for d_node in dest_candidates:
        length, path = nx.bidirectional_dijkstra(G, s_node, d_node, weight="weight")
        # 最短を採用
```

目的地がエッジ（教室・トイレ・食堂）の場合、最寄り端点で止めず、`search.extend_to_far_endpoint()` によりエッジのもう一方の端点まで経路を延長する（教室はエッジ区間に面しているため、区間を歩き切ることで必ずドアの前を通る案内になる）。ただし到着経路が既にそのエッジを歩いて到着している場合は延長しない。

### 5.6 API一覧

| エンドポイント | 概要 |
|---|---|
| `GET /api/graph` | 3Dビューア用の全ノード・全エッジ・建物色・変換設定 |
| `GET /api/rooms` | 教室一覧（`building`・`q` で絞り込み）|
| `GET /api/all` | 全教室・全ノード・建物一覧を一括取得（フロント初期化用）|
| `GET /api/route` | 統合経路探索（教室名／ノードID／イベント名を柔軟に指定）|
| `GET /api/navigate_to_room` | 教室→教室の経路探索（後方互換）|
| `GET /api/nearest_toilet` | 最寄りトイレ（`type=M/F/C/ALL`）|
| `GET /api/nearest_cafeteria` | 最寄り食堂（`name` 指定 or 全食堂から最短）|
| `GET /api/cafeterias` | 登録済み食堂一覧 |
| `GET /api/events` | `event.csv` 登録イベント一覧 |
| `GET /api/shortest_path` | ノードID直指定の経路探索（従来仕様）|
| `GET /api/edge_images` | `{from}_{to}` → CDN画像URLのマッピング |

各エンドポイントの詳細なクエリパラメータ・レスポンス例は第10章の `docs/API_Destination.md` 原文、および `ikunavi/routes/` の各関数のdocstringを参照（全エンドポイントに日本語docstringあり）。全ての探索系エンドポイントは `use_elevator=0/1`（省略時1）をサポートする。

### 5.7 名前DB・建物名DB・イベントモード

- **`name.csv`**: エッジの生の教室名（例 `101A`）をUI表示名（例 `ゼミ101A`）に置換。優先順位は「建物指定の行 → 全建物共通の行 → 生の名前」。API的には `/api/rooms`・`/api/all` の各教室に `display` フィールドが付与される。経路探索APIへは引き続き生の名前を渡す。
- **`building_name.csv`**: 建物IDに表示名を割り当て。`/api/all` の `buildings` が `[1,2,...]` の数値配列ではなく `[{id,display_name}]` のオブジェクト配列になる。
- **`event.csv` + `navi/?event=1`**: 学園祭等の開催時に、`?event=1` 付きURLでナビを開くと屋台等のイベント名でも出発地・目的地を指定できる。通常の `navi/` は影響を受けない。同じ `title` の行を複数書くと最短候補に自動振り分けられる（同じ屋台が複数箇所で開催されるケース等）。位置解決に失敗した行は起動ログに警告を出してスキップされる。

### 5.8 CORS

nginx撤去後、cloudflaredがFlaskに直結する構成になったため、CORSヘッダはFlask側の `after_request` フック（`ikunavi/__init__.py`）で返す。許可オリジンは `https://iku-navi.net` / `https://www.iku-navi.net` / 正規表現 `^https://[a-z0-9.-]+\.pages\.dev$`（Pagesプレビュー環境）。全APIがGETのみ・カスタムヘッダなしの「単純リクエスト」のため、プリフライト（OPTIONS）対応は実装していない。

---

## 6. フロントエンド

### 6.1 `programs/html/navi/index.html` — ナビゲーションUI（約2600行、単一HTMLファイル）

フレームワークなしのVanilla JS。以下の機能を1画面に統合している。

**レイアウト**: `<768px` はスマホ向けに検索パネル→マップ→ナビバー→AR領域の縦積み、`>=768px` はPC向けに左サイドバー(340px、検索+ナビ+AR)＋右マップ全高の2カラム。モバイルは `#sidebar` に `display: contents` を適用しCSS flexの `order` でレイアウト制御、PCは通常の `display: flex` に切替。

**屋内/屋外自動判定**: `pathCoords` 各ノードの `building` フィールドで判定。`building===0` なら屋外（Google Maps表示、行き先方向へ `map.setHeading()` で地図回転）、それ以外は屋内（SVGフロアマップにDijkstraパスをオーバーレイ）。

**Google Maps読み込み**: `config.js` の `CONFIG.GOOGLE_MAPS_API_KEY` を使い、JSでスクリプトタグを動的生成（APIキーをHTMLにハードコードしない）。

**カスタムオートコンプリート**: `<datalist>` を使わず独自 `<div class="suggestions">` を実装。`mousedown` + `preventDefault()` で `blur` より先に選択イベントを処理し、クリック無効化バグを回避。

**GPS**: `navigator.geolocation.getCurrentPosition` で取得。精度(`accuracy`)が30mを超えると案内板参照を促す警告表示。取得後、Haversine距離で最近傍の屋外ノードを探索し `from_node` としてAPIに渡す。最寄りノードが500m（`MAX_GPS_NODE_DIST_M`）より遠い場合はキャンパス外とみなし出発ノードに採用しない。

**AR — 2段階構成**（ステップのノードが屋内/屋外かで自動切替、`updateRouteImage(step)` 内で判定）:

| モード | 条件 | 実装 |
|---|---|---|
| 屋内AR | `building !== 0` | CDN経路写真 + 方向矢印オーバーレイ |
| 屋外AR | `building === 0` かつ lat/lng あり | Three.js + リアカメラ + GPS + ジャイロ |

- **カメラ・GPSライフサイクル**（プライバシー・バッテリー対策）: カメラは `arPrefetchCameraIfNeeded()` によりルートに屋外AR区間が含まれる場合のみ先取り起動。GPSの `watchPosition` は屋外AR表示時に開始。ステップ移動毎に `releaseArIfUnneeded(step)` が「以降に屋外AR区間が残っているか」を判定し、残っていなければ `arReleaseHardware()`（`track.stop()` + `clearWatch`）で解放。再度屋外区間に入れば許可ダイアログなしで再取得。
- **屋内AR詳細**: ルート確定直後に `prefetchRouteImages(coords)` が全ステップ分の `<img>` を生成し `#ar-cache` に積む（`img.src` セット時点でブラウザがDLを開始しキャッシュに乗るため、ステップ進行時の表示遅延がない）。表示切替は `active` クラスの付け替えのみ（DOM生成・削除なし）。方向矢印は `dir ∈ {left, right, straight}`（折れ角が`±45°`以内なら直進）。
- **屋外AR詳細**: レイヤー構成は HUD → `<canvas>`(Three.js WebGLRenderer, alpha:true) → `<video>`(リアカメラ背景) の3層。座標系はENU右手系（+X=東、+Y=上、−Z=北）。緯度経度→Three.js座標は `north_m=(lat-refLat)×111320`、`east_m=(lng-refLng)×111320×cos(refLat×π/180)` として `x=east_m, z=-north_m`。`worldGroup` にノード・エッジをまとめ、GPS更新時に `worldGroup.position` を動かして現在地を常に原点とする相対配置にしている。向きセンサーは環境により `deviceorientationabsolute`（Android Chrome）> `webkitCompassHeading`（iOS Safari）> `deviceorientation`の`alpha`（その他Android）の優先順で処理。iOS13+のセンサー許可(`DeviceOrientationEvent.requestPermission()`)はユーザー操作コンテキストが必要なため、検索ボタン押下時に `arRequestPermissionsEarly()` で先取りリクエストしている。

（旧スタンドアロンAR検証ページ `ar.html`/`ar-outdoor.html` は検証完了に伴い削除済み。屋外ARは `navi/index.html` 内の統合実装のみが実運用機能。）

### 6.2 `programs/3D_Graph/templates/index.html` — 3Dビューア（約2000行）

`/3d` でFlaskからレンダリングされる開発者向けツール。Plotly.js による3Dインタラクティブなグラフ可視化（ノード・エッジ・建物色分け）と、タブUI（教室検索／ノード指定／情報）を持つ。`/api/graph` から全データを取得して描画する。データ投入・座標変換の目視確認、Route_Checker/Image_Checker が使うAPIの動作確認用として機能する。ピンチズーム対応。

### 6.3 `programs/html/index.html` — 公開ランディングページ

Cloudflare Pagesとして実際に一般公開されるトップページ（`deploy_env/pages/build.sh` のビルド出力ルートが `programs/html`）。フレームワークなし、`style.css` のみのシンプルな構成。SEOを強く意識し、`meta description`/OGP/Twitter Card に加え `WebSite`・`FAQPage` のJSON-LD構造化データを埋め込む。構成はヒーロー見出し→「ナビを使う」「ブログ」への2枚のカードリンク→サービス説明・対応建物・運営情報・FAQ→フッター。JavaScript不使用、アニメーションはCSS `@keyframes` のみ。

### 6.4 `programs/Website/index.html` — プロジェクト紹介LP（非公開・学内発表用）

約1000行の単一HTML。Google Fonts（Space Grotesk / Noto Sans JP / JetBrains Mono）、ダーク基調のブループリント風デザイン、SVGアニメーション背景、`IntersectionObserver` によるスクロール連動演出、機能紹介・技術スタック・開発ロードマップ・チームメンバー紹介セクションを持つ「作り込まれたポートフォリオ的LP」。実サービス（`programs/html`）とは意匠・目的とも別物で、GitHub上での閲覧や学内発表向けと考えられる。Cloudflare Pagesではデプロイされない。

### 6.5 `programs/html/blog/` — 活動報告ブログ

Markdown原稿（`posts/*.md`）を `build.py`（約210行）でHTMLに変換し、`posts.json`（一覧メタデータ）を生成する簡易静的ブログ。`index.html` は `fetch('posts.json')` で一覧をクライアントサイド描画する。`_headers` で `X-Robots-Tag: noindex` を付与し検索エンジン非公開。記事はプロジェクトメンバーによる進捗・所感（Docker苦戦談、AR実装の苦労、Cloudflare Pages移行報告等）が中心で、2026-06-04〜2026-07-17分が11本収録されている（一覧は付録参照）。

### 6.6 `style.css` の設計方針（`programs/html/`）

CSS変数（`:root`）でカラーパレット・フォント・イージング関数を一元管理。`clamp()` による流体タイポグラフィと `@media (min-width: 520px)` / `(max-width: 520px)` の2段階ブレークポイント。カードグリッドはモバイル1列→デスクトップ2列。装飾に `radial-gradient` のドット柄背景、フェードアップ/パルスの `@keyframes` を多用。ベージュ×緑を基調とした「テクニカル・ミニマル」な配色。

### 6.7 Cloudflare Pages設定ファイル

- **`_headers`**: `/svg/*` と `/images/*` は1日キャッシュ（`max-age=86400`）。`navi/script/config.js` はキャッシュ無効化（ビルド毎に最新のAPIキー入りファイルを取得させるため）。`/blog/*` に `X-Robots-Tag: noindex`。
- **`_redirects`**: QRコード経由の `/redirect/*` と旧3Dビューア用 `/3d`・`/3d/*` を `api.iku-navi.net` へ301リダイレクト（`:splat` でクエリ文字列を引き継ぐ）。

### 6.8 SVGフロアマップ (`programs/html/svg/`)

命名規則: `{building}_{floor}F.svg`。現状 `10_1F.svg`〜`10_6F.svg` の6ファイルのみ（10号館分のみ整備済み。他建物は node/edge データはあるがSVG未整備 — 1.1節の課題）。

---

## 7. 開発・検証ツール群

いずれもデータ投入・品質検証を支援するデスクトップGUIツールで、`programs/{ツール名}/` 配下に個別の `requirements.txt` を持つ。

### 7.1 Map_Editor（PyQt6）

SVGフロアマップ上でクリック操作によりノード・エッジ（`{building}_bldg/node.csv`・`edge.csv`）を直感的に編集し、あわせて廊下・階段等の経路写真をカメラ撮影して `edge_image.csv` に登録できる統合データ入力GUI。旧来 `SVG_Pointer`（座標取得）→手動CSV編集→`Image_Renamer`（写真リネーム）に分かれていた作業を1画面に統合したもの。

- **構成**: `main.py`（エントリポイント）、`app_window.py`（メインウィンドウ、`MainWindow`。上部バー＝建物/階選択・SVGパス・保存、モードバー＝移動/入力/削除/撮影の4モード、中央＝`SvgCanvas`、右＝ノード/エッジ一覧またはカメラパネル）、`data_store.py`（CSV読み書き・ID採番・連鎖削除等のデータ層）、`dialogs.py`（`NodeDialog`/`EdgeDialog`）、`svg_canvas.py`（`SvgCanvas`、`QGraphicsView`継承）、`camera_panel.py`（`CameraPanel`、OpenCVによるライブカメラプレビュー）。
- **4モード**: 移動（パン/ズームのみ）、入力（空白クリックでノード作成ダイアログ、既存ノード2つのクリックでエッジ作成ダイアログ。1つ目クリック後はオレンジ色で「接続待ち」表示、階をまたいで選択可）、削除（クリックで削除、ノード削除時は接続エッジも連鎖削除）、撮影（エッジクリックでカメラパネルに切替、撮影ボタンで `captured_photos/{fromグローバルID}_to_{toグローバルID}.jpg` 保存＋`edge_image.csv`登録）。
- **エッジ種別提案**: `suggest_edge_type(floor_a, floor_b)` が階が異なれば階段(2)、同じなら通常通路(1)を初期値提案。エスカレータ上り/下りはz座標で自動判定されるためfrom/to入力順は気にしなくてよい。
- **対象外（手動編集が必要）**: `anchors.csv`・`global_node.csv`・`global_edge.csv`・`connect_edge.csv`・`buildings.json`（座標変換パラメータ、屋外ノード、建物間接続）、SVGファイル自体の作成。
- 保存後は Flask の再起動が必要（キャッシュ機構のため）。
- 依存: `PyQt6>=6.4.0`, `opencv-python>=4.8.0`, `numpy>=1.24.0`

### 7.2 Image_Checker（PyQt6）

`/api/graph` の全エッジ（両方向に展開）に対し、案内画像が `edge_image.csv` に登録され、かつCDN上に実在するかをGUI上で一括検証・可視化するツール。

- **検証ロジック**: 3状態モデル — `ok`（登録済み+CDN取得成功）／`missing`（登録済みだがCDN取得失敗）／`unregistered`（グラフ上にエッジはあるが未登録）。`(from,to)`と`(to,from)`の両方向を展開するため片方向のみ登録漏れも検出できる。
- **実装詳細**: `requests.Session`にリトライ設定（`Retry(total=3, backoff_factor=0.5)`、429/5xx対象）、ブラウザ風User-Agent、`Accept-Encoding: br` 除外（Brotli非対応環境対策）。画像取得は `ThreadPoolExecutor(max_workers=6)` で並列化（Cloudflareレート制限対策で抑制気味の値）。
- **出力**: カードグリッドUI（緑=OK/赤=欠損/グレー=未登録）。`ExportDialog` で欠損・未登録一覧をテキスト表（CJK文字幅考慮）としてクリップボードコピーまたはファイル保存。
- 依存: `PyQt6>=6.4.0`, `requests>=2.31.0`

### 7.3 Route_Checker（PyQt6）

全教室ペア間の最短経路（`/api/route`）に対し、地理的に不合理な迂回がないかをルールベースで自動検出するツール。

- **異常検出ロジック**（`detect_anomalies()`）:
  - `UNEXPECTED_BUILDING`: 経路上の建物集合から `{出発建物, 目的建物, 屋外(0)}` を除いた建物が1つでもあれば検出
  - `SAME_FLOOR_DETOUR`: 同一建物・同一階への移動なのに別フロアを経由していれば検出（検出したらそれ以降のチェックはスキップ）
  - `FLOOR_OVERSHOOT`: 同一建物間フロア移動で `min(from_fl,to_fl)〜max(from_fl,to_fl)` の範囲外フロアを経由
  - `FLOOR_REVERSAL`: 同一建物内でフロア移動方向（上昇/下降）が反転する箇所がある
  - `LOOP_DETECTED`（オプション）: 経路中に同一ノードIDが複数回出現
- **実行**: `/api/all`・`/api/graph` 取得後、`ThreadPoolExecutor(max_workers=8)` で全教室ペア（`n×(n-1)/2` or 双方向なら `n×(n-1)`）を並列に `/api/route` 問い合わせ。結果は300msバッチで `QTableWidget` に反映しUIブロックを回避。
- **UI**: フィルタ（状態/号館/教室名部分一致）、ソート可能テーブル、行ダブルクリックで詳細ダイアログ（ノード別テーブル・異常説明・生JSON表示）、CSV出力（`utf-8-sig`、フィルタ無視で全件）。
- 依存: `PyQt6>=6.4.0`, `requests>=2.31.0`

### 7.4 Image_Renamer（PyQt6）

ドラッグ&ドロップした画像ファイルと、スプレッドシートからペーストした名前リスト（1行1ファイル名）を**行番号（インデックス）で対応付けて**一括リネームするツール。あわせて画像の一括リサイズ（縦横比維持 or 強制変換、`PIL` LANCZOSフィルタ）も可能。プレビューテーブルで名前不足（黄）・重複（赤）を警告表示してから実行する安全設計。
依存: `PyQt6`, `Pillow`

### 7.5 SVG_Pointer（PyQt5）

SVGファイル（フロアマップ）を表示し、クリック位置のSVG内部座標（`svg_x, svg_y`）を取得、タブ区切りテキストとしてクリップボードに自動コピーする座標収集補助ツール（スプレッドシートの2列にそのままペースト可能）。Map_Editor統合前の旧ワークフローで使われていたツール。
依存: `PyQt5>=5.15.0`

### 7.6 Human_Remover（PyQt6）

YOLOv8セグメンテーションモデル（`yolov8n-seg.pt` 同梱）で写真内の人物（COCOクラス0）を検出し、「ぼかし（GaussianBlur）」「モザイク（ピクセレート）」「消去（`cv2.inpaint`, INPAINT_TELEA）」のいずれかで匿名化するCDNアップロード前のプライバシー保護バッチツール。セグメンテーションマスクがあれば優先使用、なければバウンディングボックスで代用。`ProcessWorker`（QThread）でバッチ処理、進捗をシグナルでリアルタイム反映。
依存: `PyQt6>=6.4.0`, `opencv-python>=4.8.0`, `ultralytics>=8.0.0`, `numpy>=1.24.0`

---

## 8. インフラ・デプロイ

### 8.1 本番構成（Docker Swarm、`deploy_env/docker-compose.yml`）

スタック名 `iku`。オーバーレイネットワーク `app_net`（`attachable: true`）上に以下のサービス。

| サービス | 役割 | 配置/レプリカ |
|---|---|---|
| `python` | Flask+gunicorn (`-w 4 -b 0.0.0.0:8000`) | 平常時2（イベント時4+）、`spread: node.id`で分散、ローリング更新`start-first`+自動rollback |
| `db` | MariaDB 11 | manager固定（`db_data`ボリューム）|
| `counter` | アクセスカウンター(Rails) | 平常時2、DB起動待ちのため`restart_policy.delay:15s, max_attempts:5` |
| `prometheus` | メトリクス収集 | manager固定、`user: root`（`docker.sock`読み取りに必要）|
| `grafana` | 監視ダッシュボード | manager固定（`grafana_data`ボリューム）|
| `cadvisor` | コンテナリソース監視 | `mode: global`（全ノード自動展開）、`privileged: true` |
| `cloudflared` | Cloudflare Tunnel | manager固定、`tunnel --no-autoupdate run` |

**nginxサービスはcompose定義から完全削除済み**（撤去理由と参照ドキュメントのみコメント残存）。

### 8.2 Cloudflare Pages / Tunnel

- メインドメイン `iku-navi.net` → Cloudflare Pages（静的配信、ビルド出力 `programs/html`）
- `api.iku-navi.net` → cloudflared tunnel → Flask直結
- ビルドコマンド: `sh deploy_env/pages/build.sh`。環境変数 `GOOGLE_MAPS_API_KEY`（Pages側で設定）から `navi/script/config.js` を生成するのみ
- cloudflaredのPublic Hostnameパスルーティング: `redirect/.*` → counter:3000、それ以外 → python:8000
- QRコード互換は Pages の `_redirects`（`/redirect/*` → `api.iku-navi.net` へ301）で救済
- 移行はPhase 0〜5の段階的手順で実施され、途中まで本番影響なしで進められる設計（`api.iku-navi.net` を先行稼働・検証してから本番ドメイン切替）

### 8.3 CI/CD（`.github/workflows/build-push.yml`）

`main` へのpushをトリガーに、`deploy_env/python/Dockerfile` からDockerイメージをビルドし `ghcr.io/senarmaporg/iki_project_2026_python`（`latest` + short SHA タグ）へプッシュする。**自動テストは無い**（1.3節の改善提案参照）。旧nginxイメージのビルドステップはPages移行に伴い削除済み（コメントとして記録が残る）。

### 8.4 監視（Prometheus / Grafana / cAdvisor）

`prometheus.yml` は `scrape_interval:15s`、`dockerswarm_sd_configs`（`role: tasks`）でSwarmタスクを動的ディスカバリ。`relabel_configs` でcadvisorタスクのみ対象化、`metric_relabel_configs` で `container_label_com_docker_swarm_service_name` から短い `service` ラベル（例 `iku_python`）を生成（ローリング更新での系列増殖対策、Grafana集計は必ずこの `service` ラベル単位）。Grafanaダッシュボードは ID 14282 推奨。cAdvisorは `--docker_only=true`（非コンテナcgroup除外）、`--housekeeping_interval=15s`（負荷抑制）。

### 8.5 ローカル開発環境（`enviroments/`）

`deploy_env/`（本番用）とは別に、開発用の軽量Docker構成。`python`コンテナ（ポート5001、`tail -f /dev/null`で待機しシェル作業、ソース全体をバインドマウント）と`nginx`コンテナ（8081→80, 4430→443、SSL証明書の有無で起動時にHTTP/HTTPSをentrypointが動的切替）の2サービスのみ。`connect.sh` が `docker compose up -d`（`renew`引数で`--build`）→`docker exec -it`で開発者をコンテナ内シェルに導く起動スクリプト。Dockerfileには開発補助として `nodejs npm` / `typescript` も追加インストールされる。

### 8.6 Kubernetes（`deploy_env/k8s/`）— 過去の検証・不採用

**現在の本番構成ではない。** `docs/k8s.md` 冒頭に明記の通り、2GB VPS単体ではkubeadm+CNIのオーバーヘッドが大きく、ワーカートークンの有効期限運用コストも高いため、Docker Swarmへ切り替えられた経緯がある（コミットログにも「【検証】k8s検証（失敗）」の記録あり）。

ディレクトリには世代の異なる2系統のスクリプトが混在:
- 旧系統: `setup-node.sh`/`setup-master.sh`/`add-worker.sh`/`deploy.sh`（`docs/k8s.md`が説明。Calico v3.28 + kubeadm v1.31）
- 新系統: `01-localnet.sh`→`02-k8s-common.sh`→`03-init-master.sh`→`04-join-worker.sh`（Flannel CNI、kubeadm v1.36想定、2ノード専用、`docs/k8s.md`未記載のより新しい試行錯誤）

マニフェスト（`kustomization.yaml`でnamespace `iki-project` に集約）はcompose環境とほぼ1:1対応（python/counter/nginxのDeployment、dbのStatefulSet、cloudflared、prometheus/grafana/cadvisor/node-exporter/kube-state-metrics）。`secrets.yaml.template` が雛形（実ファイルは`.gitignore`対象）。`auto-update-cronjob.yaml` は30分毎のrollout restart相当の仕組み。

### 8.7 nginx（撤去済み・ロールバック資産）

`deploy_env/nginx/`（Dockerfile, nginx.conf, docker-entrypoint.sh, errors/）は本番では不使用だが、意図的にロールバック用として残置。中身はPages移行前の旧ルーティング定義そのもの（`/`→静的配信、`/3d/`・`/api/`→python:8000、`/redirect/`→counter:3000）。ロールバック手順はPagesのカスタムドメイン解除＋DNSを旧トンネル向けに戻すのみで、GHCRに旧イメージが残っている限り再デプロイ可能。

---

## 9. 非機能要件・運用ルール

### 9.1 インフラ

ConoHa VPS 平常時メモリ2GB/3vCPU/SSD100GB、Ubuntu 24.04 LTS。イベント時は4GBサーバーをSwarmワーカーとして追加増設。

### 9.2 可用性・性能

| 項目 | 値 |
|---|---|
| 目標稼働率 | 70%以上（学内利用主目的のためクラスタ構成は不採用）|
| 想定同時接続 | 通常30人以下、ピーク（授業切替）100人以下 |
| レスポンス目標 | 静的500ms以内、API 2秒以内 |
| gunicornワーカー | 4（平常8並列、イベント時16並列）|
| 計画メンテナンス | 水・金 10:45〜12:15 |
| 自動更新 | cron30分毎に`update.sh`（`~/update.lock`存在時は無効化）|
| ローリング更新 | `order: start-first` で無停止更新 |

### 9.3 セキュリティ

TLS終端はCloudflare側（Tunnel経由）。パブリックポート非公開（外部アクセス全てcloudflared経由）。gunicornはoverlay network内部通信のみ。`ufw`でSSHのみ許可。機密情報は`.env`管理（Git対象外）、Swarmでは環境変数として注入。

### 9.4 保守性・運用

デプロイは`update.sh`自動更新（cron30分毎、手動実行も可）。設定変更は`docker stack deploy`で即時反映。ログは`docker service logs <service> --tail 50`。`data/`ディレクトリ（CSV群）を定期手動バックアップ。データ更新はスプレッドシート→スクリプト→GitHub Push運用。

### 9.5 運用上のノウハウ（`docs/swarm.md` より）

- `docker stack deploy`は`.env`を自動読込しないため `set -a && . .env && set +a` が必須（`source`はshで不可）
- `docker compose config`経由のデプロイは禁止（compose v2が`depends_on`をマップ形式に正規化し、Swarmが"must be a list"エラーを出す）
- `docker swarm update --task-history-limit 1`（既定5世代の停止タスク削減）、週次`docker system prune -f`（`-a`/`--volumes`は付けない）
- Prometheus configはサービス参照中は`docker config rm`不可（サービス削除→config削除→再デプロイの順序が必須）
- ワーカー増設: `docker service scale iku_python=4 iku_counter=4`等。撤去: drain→スケールダウン→`swarm leave`→`node rm`

---

## 10. 付録: 全ソースコード・全データファイル

以下、リポジトリ内の全ソースコード・設定ファイル・データファイルを収録する（バイナリ・生成物・機密ファイルの実値を除く）。各ファイルは `### path/to/file` の見出しとフェンス付きコードブロックで示す。

### 10.1 バックエンド

### `programs/3D_Graph/app.py`

```python
"""IKU NAVI 経路探索APIのエントリポイント（gunicorn は app:app を読む）。

実装は ikunavi/ パッケージにある。構成の概要は ikunavi/__init__.py の
docstring と docs/PROJECT_BIBLE.md を参照。
"""
from ikunavi import create_app

app = create_app()

if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5001)
```

### `programs/3D_Graph/ikunavi/__init__.py`

```python
"""IKU NAVI 経路探索API本体。

構成:
  config.py     … データのパスと定数
  transform.py  … 建物ローカル座標 → キャンパス共通座標 の変換
  dataset.py    … CSV読み込み（全建物＋屋外を1組のDataFrameに）
  graph.py      … NetworkXグラフの構築
  naming.py     … 内部識別子 → 表示名
  cache.py      … 起動後に一度だけ作る派生データ
  search.py     … 候補ノードの解決と最短経路探索
  serialize.py  … 探索結果 → APIレスポンス用dict
  payloads.py   … /api/graph 用のペイロード
  routes/       … エンドポイント（Blueprint）
"""
import os
import re

from flask import Flask, request

from . import cache, naming, payloads
from .config import BASE_DIR, CORS_ALLOWED_ORIGINS, CORS_ORIGIN_PATTERN
from .errors import register_error_handler
from .routes import BLUEPRINTS

_cors_origin_pattern = re.compile(CORS_ORIGIN_PATTERN)


def _register_cors(app):
    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin", "")
        if origin in CORS_ALLOWED_ORIGINS or _cors_origin_pattern.match(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response


def create_app():
    app = Flask(
        __name__,
        template_folder=os.path.join(BASE_DIR, "templates"),
        static_folder=os.path.join(BASE_DIR, "static"),
    )
    _register_cors(app)
    register_error_handler(app)
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


def clear_all_caches():
    """CSVを読み直したいときに、全モジュールのキャッシュを捨てる"""
    cache.clear_caches()
    naming.clear_caches()
    payloads.clear_caches()
```

### `programs/3D_Graph/ikunavi/cache.py`

```python
"""起動後に一度だけ構築し、以降は使い回す派生データ。

CSVの読み込みとグラフ構築は数百ms〜秒単位かかるため、リクエストごとにはやらない。
データを更新したときはプロセスを再起動するか clear_caches() を呼ぶ
（ikunavi.clear_all_caches() が全モジュールのキャッシュをまとめて落とす）。
"""
import os

import pandas as pd

from .config import CAFETERIA_CSV, EVENT_CSV, GLOBAL_NODE_OFFSET, ID_OFFSET
from .dataset import load_data
from .graph import build_graph
from .naming import TOILET_NAMES, display_name, get_ignore_set

_nodes_df = None
_edges_df = None
_graph_with_ev = None
_graph_without_ev = None
_room_index = None    # {(教室名, building): [edge行, ...]}
_rooms_list = None    # /api/rooms・/api/all 用の整形済み教室リスト
_nodes_list = None    # /api/all 用の整形済みノードリスト
_node_xyz = None      # {node_id: (x, y, z)}
_event_index = None   # event.csv: {title: [(node_id, edge行|None), ...]}
_events_list = None   # /api/events 用の整形済みイベント一覧
_cafeteria_list = None


def get_data():
    """(nodes_df, edges_df)"""
    global _nodes_df, _edges_df
    if _nodes_df is None or _edges_df is None:
        _nodes_df, _edges_df = load_data()
    return _nodes_df, _edges_df


def get_graph(use_elevator=True):
    """経路探索用グラフ。エレベータ有無で別々にキャッシュする"""
    global _graph_with_ev, _graph_without_ev
    nodes_df, edges_df = get_data()
    if use_elevator:
        if _graph_with_ev is None:
            _graph_with_ev = build_graph(nodes_df, edges_df, use_elevator=True)
        return _graph_with_ev
    if _graph_without_ev is None:
        _graph_without_ev = build_graph(nodes_df, edges_df, use_elevator=False)
    return _graph_without_ev


def get_node_xyz():
    """{node_id: (x, y, z)}"""
    global _node_xyz
    if _node_xyz is None:
        nodes_df, _ = get_data()
        _node_xyz = {
            int(r["id"]): (float(r["x"]), float(r["y"]), float(r["z"]))
            for _, r in nodes_df.iterrows()
        }
    return _node_xyz


def get_nodes_list():
    """/api/all 用の、座標を持たない軽量なノード一覧"""
    global _nodes_list
    if _nodes_list is None:
        nodes_df, _ = get_data()
        nodes = []
        for _, row in nodes_df.iterrows():
            if any(pd.isna(row[c]) for c in ["id", "building", "floor", "type"]):
                continue
            nd = {
                "id":       int(row["id"]),
                "building": int(row["building"]),
                "floor":    int(row["floor"]),
                "type":     int(row["type"]),
            }
            if "lat" in row and pd.notna(row["lat"]):
                nd["lat"] = float(row["lat"])
            if "lng" in row and pd.notna(row["lng"]):
                nd["lng"] = float(row["lng"])
            nodes.append(nd)
        nodes.sort(key=lambda n: n["id"])
        _nodes_list = nodes
    return _nodes_list


def _build_room_index(edges_df):
    """エッジの name 列を分解し、教室名→エッジ行 の索引と教室一覧を一度だけ構築する"""
    ignore_set = get_ignore_set()
    index, rooms_list, seen = {}, [], set()
    for _, row in edges_df.iterrows():
        raw_name = str(row["name"]).strip()
        if not raw_name or raw_name == "nan":
            continue
        building = int(row["building"])
        for room in raw_name.split(";"):
            room = room.strip()
            if not room:
                continue
            index.setdefault((room, building), []).append(row)
            if (room, building) in seen:
                continue
            seen.add((room, building))
            if room in TOILET_NAMES or room in ignore_set:
                continue  # 教室検索の候補には含めない（索引には残す）
            rooms_list.append({
                "room":     room,
                "display":  display_name(building, room),
                "building": building,
                "floor":    int(row["floor"]),
                "edge_id":  int(row["id"]),
                "from":     int(row["from"]),
                "to":       int(row["to"]),
            })
    rooms_list.sort(key=lambda r: (r["building"], r["room"]))
    return index, rooms_list


def get_room_index():
    """({(room, building): [edge行, ...]}, 教室一覧)"""
    global _room_index, _rooms_list
    if _room_index is None:
        _, edges_df = get_data()
        _room_index, _rooms_list = _build_room_index(edges_df)
    return _room_index, _rooms_list


def find_edges_for_room(room_name, building):
    """教室名が含まれるエッジ行のリストを返す（起動時に構築した索引から引く）"""
    index, _ = get_room_index()
    return index.get((room_name, int(building)), [])


def edges_by_names(names):
    """room_index から name が names に含まれるエッジ行を収集する（複数種別併記のエッジはIDで重複排除）"""
    room_index, _ = get_room_index()
    edges, seen_ids = [], set()
    for (name, _bldg), rows in room_index.items():
        if name not in names:
            continue
        for row in rows:
            eid = int(row["id"])
            if eid in seen_ids:
                continue
            seen_ids.add(eid)
            edges.append(row)
    return edges


def _event_candidates_from_row(row, edges_df, node_floor):
    """
    event.csv の1行から到達候補 [(node_id, edge行|None), ...] と階を解決する。
    room / edge_id / node_id の優先順で見る。戻り値: (candidates, floor|None)
    """
    building = int(float(row["building"])) if row["building"] else 0
    candidates, floor = [], None

    if row["room"]:
        for e_row in find_edges_for_room(row["room"], building):
            floor = int(e_row["floor"])
            candidates += [(int(e_row["from"]), e_row), (int(e_row["to"]), e_row)]
    elif row["edge_id"]:
        local_id = int(float(row["edge_id"]))
        gid = local_id if building == 0 else building * ID_OFFSET + local_id
        hits = edges_df[(edges_df["id"].astype(int) == gid)
                        & (edges_df["building"].astype(int) == building)]
        for _, e_row in hits.iterrows():
            floor = int(e_row["floor"])
            candidates += [(int(e_row["from"]), e_row), (int(e_row["to"]), e_row)]
    elif row["node_id"]:
        nid = int(float(row["node_id"]))
        gid = nid + GLOBAL_NODE_OFFSET if building == 0 else building * ID_OFFSET + nid
        if gid in node_floor:
            floor = node_floor[gid]
            candidates.append((gid, None))

    return candidates, floor


def _build_event_index():
    """
    event.csv（列: title,building,room,node_id,edge_id）を読み込み、
    イベント名→到達候補ノード の索引と一覧を構築する。

    1行につき room / node_id / edge_id のいずれか1つでタイトルの場所を指定する:
      room    … 既存の教室名（;区切りのエッジ name に含まれる名前）
      node_id … 建物内のローカルノードID（building=0 なら global_node.csv のID）
      edge_id … 建物内のローカルエッジID（building=0 なら global_edge.csv のID）
    同じ title の行が複数あれば候補を統合する（複数箇所で開催する屋台など）。
    """
    index, events_list, seen_titles = {}, [], set()
    if not os.path.exists(EVENT_CSV):
        return index, events_list

    df = pd.read_csv(EVENT_CSV, dtype=str).fillna("")
    df.columns = df.columns.str.strip()
    nodes_df, edges_df = get_data()
    node_floor = {int(r["id"]): int(r["floor"]) for _, r in nodes_df.iterrows()}

    for _, raw in df.iterrows():
        row = {c: str(raw.get(c, "")).strip()
               for c in ("title", "building", "room", "node_id", "edge_id")}
        if not row["title"]:
            continue

        candidates, floor = _event_candidates_from_row(row, edges_df, node_floor)
        if not candidates:
            print(f"[event.csv] 位置を解決できない行をスキップ: title={row['title']}")
            continue

        index.setdefault(row["title"], []).extend(candidates)
        if row["title"] not in seen_titles:
            seen_titles.add(row["title"])
            events_list.append({
                "title":    row["title"],
                "building": int(float(row["building"])) if row["building"] else 0,
                "floor":    floor if floor is not None else 1,
            })
    return index, events_list


def get_event_index():
    """({title: [(node_id, edge行|None), ...]}, イベント一覧)"""
    global _event_index, _events_list
    if _event_index is None:
        _event_index, _events_list = _build_event_index()
    return _event_index, _events_list


def find_event_candidates(title):
    """イベント名→ [(node_id, edge行|None), ...]（未登録なら空リスト）"""
    index, _ = get_event_index()
    return index.get(title, [])


def get_cafeteria_list():
    """cafeteria_edge.csv の食堂一覧（無ければ空リスト）"""
    global _cafeteria_list
    if _cafeteria_list is None:
        result = []
        if os.path.exists(CAFETERIA_CSV):
            df = pd.read_csv(CAFETERIA_CSV, dtype=str).fillna("")
            for _, row in df.iterrows():
                name = row.get("name", "").strip()
                if not name:
                    continue
                result.append({
                    "name":         name,
                    "building":     row.get("building", "").strip(),
                    "display_name": row.get("display_name", name).strip(),
                })
        _cafeteria_list = result
    return _cafeteria_list


def get_cafeteria_names():
    return [c["name"] for c in get_cafeteria_list()]


def clear_caches():
    global _nodes_df, _edges_df, _graph_with_ev, _graph_without_ev
    global _room_index, _rooms_list, _nodes_list, _node_xyz
    global _event_index, _events_list, _cafeteria_list
    _nodes_df = None
    _edges_df = None
    _graph_with_ev = None
    _graph_without_ev = None
    _room_index = None
    _rooms_list = None
    _nodes_list = None
    _node_xyz = None
    _event_index = None
    _events_list = None
    _cafeteria_list = None
```

### `programs/3D_Graph/ikunavi/config.py`

```python
"""データファイルのパスと、経路探索・描画で使う定数。

ここにある値はデータの意味そのものに関わるため、変更するときは
data/ 配下のCSVの作り方（programs/Map_Editor）と合わせて見直すこと。
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "../../data")

BUILDINGS_JSON    = os.path.join(DATA_DIR, "buildings.json")
ANCHORS_CSV       = os.path.join(DATA_DIR, "anchors.csv")
CONNECT_EDGE_CSV  = os.path.join(DATA_DIR, "connect_edge.csv")
GLOBAL_NODE_CSV   = os.path.join(DATA_DIR, "global_node.csv")
GLOBAL_EDGE_CSV   = os.path.join(DATA_DIR, "global_edge.csv")
EDGE_IMAGE_CSV    = os.path.join(DATA_DIR, "edge_image.csv")
CAFETERIA_CSV     = os.path.join(DATA_DIR, "cafeteria_edge.csv")
NAME_CSV          = os.path.join(DATA_DIR, "name.csv")
BUILDING_NAME_CSV = os.path.join(DATA_DIR, "building_name.csv")
EVENT_CSV         = os.path.join(DATA_DIR, "event.csv")
IGNORE_CSV        = os.path.join(DATA_DIR, "ignore.csv")

CDN_BASE = "https://cdn.iku-navi.net"

# グローバルID = building_id * ID_OFFSET + ローカルID
ID_OFFSET          = 100_000
GLOBAL_NODE_OFFSET = 9_000_000   # 屋外ノードIDのオフセット
ANCHOR_EDGE_ID_BASE = 8_000_000  # anchors.csv から生成する仮想エッジのID開始値

# 建物出入り口を通過するコスト加算（単位: weight×length と同じ ≒ メートル相当）
# 値を大きくするほど建物を通り抜けるルートを避けやすくなる
# 0 にするとペナルティなし（従来動作）
ENTRANCE_PENALTY = 50.0

OUTDOOR_COLOR = "#5AFF5A"

# Building color palette (up to 10 buildings)
BUILDING_COLORS = [
    "#4C9BE8", "#E8774C", "#4CE87A", "#E8D44C",
    "#C44CE8", "#4CE8D4", "#E84C7A", "#9BE84C",
    "#E8A44C", "#4C74E8",
]

# Cloudflare Pages (iku-navi.net) から api.iku-navi.net へのクロスオリジン fetch を許可する。
# nginx 撤去後は cloudflared → Flask 直結のため、CORS ヘッダはここで返す。
# API は GET のみ・カスタムヘッダなしの「単純リクエスト」なのでプリフライト対応は不要。
CORS_ALLOWED_ORIGINS = {
    "https://iku-navi.net",
    "https://www.iku-navi.net",
}
CORS_ORIGIN_PATTERN = r"^https://[a-z0-9.-]+\.pages\.dev$"  # Pages プレビュー用
```

### `programs/3D_Graph/ikunavi/dataset.py`

```python
"""data/ 配下のCSVを読み込み、全建物＋屋外をつないだ1組のDataFrameにまとめる。

出力は「グローバルID空間」に正規化済みのノード表・エッジ表で、以降の
グラフ構築・教室索引はすべてこの2つだけを入力にする。
"""
import glob
import os
import re

import pandas as pd

from .config import (
    ANCHOR_EDGE_ID_BASE,
    ANCHORS_CSV,
    CONNECT_EDGE_CSV,
    DATA_DIR,
    GLOBAL_EDGE_CSV,
    GLOBAL_NODE_CSV,
    GLOBAL_NODE_OFFSET,
    ID_OFFSET,
)
from .transform import apply_transform, resolved_transform_config


def _read_csv(path, **kwargs):
    """列名の前後空白を落としてCSVを読む（手書きCSVの揺れを吸収する）"""
    df = pd.read_csv(path, **kwargs)
    df.columns = df.columns.str.strip()
    return df


def _load_building_frames(config):
    """data/{N}_bldg/ を全て読み、ローカルID→グローバルID変換と座標変換をかける"""
    nodes, edges = [], []
    for bldg_dir in sorted(glob.glob(os.path.join(DATA_DIR, "*_bldg"))):
        m = re.match(r'(\d+)_bldg', os.path.basename(bldg_dir))
        if not m:
            continue
        bldg_id = int(m.group(1))

        nodes_df = _read_csv(os.path.join(bldg_dir, "node.csv"))
        edges_df = _read_csv(os.path.join(bldg_dir, "edge.csv"))
        if nodes_df.empty:
            continue

        # ローカルID → グローバルID (building * ID_OFFSET + local_id)
        offset = bldg_id * ID_OFFSET
        nodes_df["id"]   += offset
        edges_df["id"]   += offset
        edges_df["from"] += offset
        edges_df["to"]   += offset

        # 座標変換 (平行移動 + Z軸回転)
        nodes_df = apply_transform(nodes_df, config.get(str(bldg_id), {}))

        nodes.append(nodes_df)
        edges.append(edges_df)
    return nodes, edges


def _load_connect_edges():
    """建物間接続CSV: グローバルIDで記述、存在する場合のみ読み込む"""
    if not os.path.exists(CONNECT_EDGE_CSV):
        return None
    conn_df = _read_csv(CONNECT_EDGE_CSV)
    return conn_df if not conn_df.empty else None


def _load_global_nodes():
    """屋外ノード (global_node.csv) — building=0 として追加。戻り値: (DataFrame|None, 元のID集合)"""
    if not os.path.exists(GLOBAL_NODE_CSV):
        return None, set()
    gn_raw = _read_csv(GLOBAL_NODE_CSV).dropna(subset=["id", "x", "y", "z"])
    if gn_raw.empty:
        return None, set()

    global_node_ids = set(gn_raw["id"].astype(int))
    gn_raw = gn_raw.copy()
    gn_raw["id"] = gn_raw["id"].astype(int) + GLOBAL_NODE_OFFSET
    gn_raw["building"] = 0
    for col, default in [("floor", 1), ("type", 1)]:
        if col not in gn_raw.columns:
            gn_raw[col] = default
    return gn_raw, global_node_ids


def _load_global_edges(global_node_ids):
    """屋外エッジ (global_edge.csv) — from/to の小さいIDはグローバルノードローカルID"""
    if not os.path.exists(GLOBAL_EDGE_CSV):
        return None
    ge_raw = _read_csv(GLOBAL_EDGE_CSV).dropna(subset=["id", "from", "to"])
    if ge_raw.empty:
        return None

    def _resolve(x):
        xi = int(x)
        return xi + GLOBAL_NODE_OFFSET if xi in global_node_ids else xi

    ge_raw = ge_raw.copy()
    ge_raw["from"] = ge_raw["from"].astype(int).apply(_resolve)
    ge_raw["to"]   = ge_raw["to"].astype(int).apply(_resolve)
    for col, default in [("building", 0), ("name", ""), ("floor", 1),
                         ("type", 1), ("weight", 1.0), ("length", 0.0)]:
        if col not in ge_raw.columns:
            ge_raw[col] = default
    return ge_raw


def _build_anchor_edges():
    """anchors.csv から、グローバルノードとローカルノードを繋ぐエッジを生成する"""
    if not os.path.exists(ANCHORS_CSV):
        return None
    anchors_df = _read_csv(ANCHORS_CSV)
    if anchors_df.empty:
        return None

    anchor_edges = []
    for idx, row in anchors_df.iterrows():
        bldg_id = int(row["building"])
        l_id = int(row["local_node_id"])
        g_id = int(row["global_node_id"])

        anchor_edges.append({
            "id": ANCHOR_EDGE_ID_BASE + idx,
            "from": bldg_id * ID_OFFSET + l_id,
            "to": g_id + GLOBAL_NODE_OFFSET,
            "building": 0,
            "floor": 1,
            "weight": 1.0,
            "length": 0.0,
            "type": 7,
            "name": "",
        })
    return pd.DataFrame(anchor_edges) if anchor_edges else None


def _normalize(nodes_combined, edges_combined):
    """欠損行の除外と、エッジの name/type/right/left 列の型そろえ"""
    # NaN・座標欠損行のみ除外（building=0 = 屋外ノードは許容）
    nodes_combined = nodes_combined.dropna(subset=["id", "x", "y", "z", "building", "floor"])
    valid_ids = set(nodes_combined["id"])
    edges_combined = edges_combined[
        edges_combined["from"].isin(valid_ids) & edges_combined["to"].isin(valid_ids)
    ]

    edges_combined["name"] = edges_combined["name"].fillna("").astype(str)
    # 空行によりfloat化したtype列を整数に正規化 ("1.0" → "1" となるよう)
    edges_combined["type"] = pd.to_numeric(edges_combined["type"], errors="coerce").fillna(1).astype(int)
    # right/left列（進行方向の右側・左側にある教室名を、nameとは独立にfrom→toの正しい順序で
    # ";"区切りで入れたもの。nameのリストは順序通りとは限らないため別立てにしている）は
    # まだ一部の建物のedge.csvにしか無い任意列。無い建物の行はNaNになるので空文字にする。
    for col in ("right", "left"):
        if col not in edges_combined.columns:
            edges_combined[col] = ""
        edges_combined[col] = edges_combined[col].fillna("").astype(str)
    return nodes_combined, edges_combined


def load_data():
    """全建物＋屋外のノード・エッジを読み込み、(nodes_df, edges_df) を返す"""
    config = resolved_transform_config()
    all_nodes, all_edges = _load_building_frames(config)

    conn_df = _load_connect_edges()
    if conn_df is not None:
        all_edges.append(conn_df)

    gn_df, global_node_ids = _load_global_nodes()
    if gn_df is not None:
        all_nodes.append(gn_df)

    ge_df = _load_global_edges(global_node_ids)
    if ge_df is not None:
        all_edges.append(ge_df)

    anchor_df = _build_anchor_edges()
    if anchor_df is not None:
        all_edges.append(anchor_df)

    if not all_nodes:
        return pd.DataFrame(), pd.DataFrame()

    return _normalize(pd.concat(all_nodes, ignore_index=True),
                      pd.concat(all_edges, ignore_index=True))
```

### `programs/3D_Graph/ikunavi/errors.py`

```python
"""APIのエラー応答。

ルート関数の途中で ApiError を送出すると {"error": メッセージ} と
指定ステータスのJSONになる。エラーのたびに return jsonify(...), status を
書かずに済むので、ルート本体は正常系だけを読めばよくなる。
"""
from flask import jsonify


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def register_error_handler(app):
    @app.errorhandler(ApiError)
    def _handle_api_error(err):
        return jsonify({"error": err.message}), err.status
```

### `programs/3D_Graph/ikunavi/graph.py`

```python
"""ノード表・エッジ表から NetworkX の有向グラフを組み立てる。

双方向に歩ける通路は往復2本の辺として張り、進行方向で左右が入れ替わるため
right/left 属性も反転させて持たせる。エスカレータ(type 5/6)だけは
高低差から通行可能な向きを決めて片方向のみ張る。
"""
import networkx as nx
import pandas as pd

from .config import ENTRANCE_PENALTY

# 上りエスカレータ(5)・下りエスカレータ(6)は一方向のみ
DIRECTED_EDGE_TYPES = {"5", "6"}
ELEVATOR_EDGE_TYPE = "4"
ENTRANCE_EDGE_TYPE = "7"


def _node_attrs(row):
    attrs = dict(
        x=float(row["x"]),
        y=float(row["y"]),
        z=float(row["z"]),
        building=int(row["building"]),
        floor=int(row["floor"]),
        node_type=int(row["type"]),
    )
    if "lat" in row and pd.notna(row["lat"]):
        attrs["lat"] = float(row["lat"])
    if "lng" in row and pd.notna(row["lng"]):
        attrs["lng"] = float(row["lng"])
    if "svg_x" in row and pd.notna(row["svg_x"]):
        attrs["svg_x"] = float(row["svg_x"])
        attrs["svg_y"] = float(row["svg_y"])
    return attrs


def _edge_attrs(row, edge_type):
    return dict(
        edge_id=int(row["id"]),
        name=str(row["name"]),
        right=str(row.get("right", "")),
        left=str(row.get("left", "")),
        building=int(row["building"]),
        floor=int(row["floor"]),
        weight=float(row["weight"]) * float(row["length"])
               + (ENTRANCE_PENALTY if edge_type == ENTRANCE_EDGE_TYPE else 0.0),
        length=float(row["length"]),
        edge_type=edge_type,
    )


def build_graph(nodes_df, edges_df, use_elevator=True):
    G = nx.DiGraph()
    for _, row in nodes_df.iterrows():
        G.add_node(int(row["id"]), **_node_attrs(row))

    for _, row in edges_df.iterrows():
        edge_type = str(row["type"]).strip()
        if not use_elevator and edge_type == ELEVATOR_EDGE_TYPE:
            continue
        u, v = int(row["from"]), int(row["to"])
        edge_attrs = _edge_attrs(row, edge_type)

        if edge_type == "5":
            # 上りESC: z が低い→高い方向のみ通行可
            lo, hi = (u, v) if G.nodes[u]["z"] <= G.nodes[v]["z"] else (v, u)
            G.add_edge(lo, hi, **edge_attrs)
        elif edge_type == "6":
            # 下りESC: z が高い→低い方向のみ通行可
            hi, lo = (u, v) if G.nodes[u]["z"] >= G.nodes[v]["z"] else (v, u)
            G.add_edge(hi, lo, **edge_attrs)
        else:
            G.add_edge(u, v, **edge_attrs)
            if edge_type not in DIRECTED_EDGE_TYPES:
                # 逆方向(v→u)は進行方向が反転するため、right/leftも入れ替えて渡す
                reversed_attrs = dict(edge_attrs, right=edge_attrs["left"], left=edge_attrs["right"])
                G.add_edge(v, u, **reversed_attrs)
    return G
```

### `programs/3D_Graph/ikunavi/naming.py`

```python
"""生の名前（CSVに書かれた識別子）→ 画面・音声で使う表示名 の解決。

edge.csv の name/right/left 列には "101A" や "M_Toilet" のような内部識別子が
入っている。利用者に見せる文字列はすべてここを通して組み立てる。
対応表は data/name.csv・data/building_name.csv、候補から隠す名前は data/ignore.csv。
"""
import os

import pandas as pd

from .config import BUILDING_NAME_CSV, IGNORE_CSV, NAME_CSV

# トイレは name.csv に表示名を持たず、種別ごとに固定のラベルを使う
TOILET_LABEL = {"M_Toilet": "男子トイレ", "F_Toilet": "女子トイレ", "C_Toilet": "多目的トイレ"}
TOILET_NAMES = set(TOILET_LABEL)
TOILET_TYPE_MAP = {
    "M":   ["M_Toilet"],
    "F":   ["F_Toilet"],
    "C":   ["C_Toilet"],
    "ALL": ["M_Toilet", "F_Toilet", "C_Toilet"],
}

_name_map          = None   # name.csv: {(building|None, name): display_name}
_building_name_map = None   # building_name.csv: {building: display_name}
_ignore_set        = None   # ignore.csv: {name, ...}


def _read_text_csv(path):
    """全列を文字列として読み、欠損を空文字に揃える（表示名CSV共通の読み方）"""
    df = pd.read_csv(path, dtype=str).fillna("")
    df.columns = df.columns.str.strip()
    return df


def get_name_map():
    """
    name.csv（列: building,name,display_name）を読み込み、
    {(building, name): display_name} の辞書を返す。
    building 列が空の行は全建物共通の表示名として (None, name) キーで保持する。
    """
    global _name_map
    if _name_map is None:
        name_map = {}
        if os.path.exists(NAME_CSV):
            for _, row in _read_text_csv(NAME_CSV).iterrows():
                name    = str(row.get("name", "")).strip()
                display = str(row.get("display_name", "")).strip()
                bldg    = str(row.get("building", "")).strip()
                if not name or not display:
                    continue
                key = (int(float(bldg)), name) if bldg else (None, name)
                name_map[key] = display
        _name_map = name_map
    return _name_map


def get_building_name_map():
    """
    building_name.csv（列: building,display_name）を読み込み、
    {building: display_name} の辞書を返す。
    """
    global _building_name_map
    if _building_name_map is None:
        name_map = {}
        if os.path.exists(BUILDING_NAME_CSV):
            for _, row in _read_text_csv(BUILDING_NAME_CSV).iterrows():
                bldg    = str(row.get("building", "")).strip()
                display = str(row.get("display_name", "")).strip()
                if not bldg or not display:
                    continue
                name_map[int(float(bldg))] = display
        _building_name_map = name_map
    return _building_name_map


def get_ignore_set():
    """
    ignore.csv（列: id）を読み込み、教室検索の候補一覧から隠す生の名前の集合を返す。
    building 列は無く、建物を問わずこの名前に一致するエッジが対象になる。
    ルート検索（from_room/to_room）・最寄りトイレ/食堂検索・event.csvのroom紐付けは
    索引（room_index）を直接参照するため、ここでの除外の影響を受けない。
    """
    global _ignore_set
    if _ignore_set is None:
        ignore_set = set()
        if os.path.exists(IGNORE_CSV):
            for _, row in _read_text_csv(IGNORE_CSV).iterrows():
                name = str(row.get("id", "")).strip()
                if name:
                    ignore_set.add(name)
        _ignore_set = ignore_set
    return _ignore_set


def display_name(building, name):
    """name.csv の表示名を返す。建物指定 → 全建物共通 → 生の名前+「教室」 の順で解決"""
    name_map = get_name_map()
    return (
        name_map.get((int(building), name))
        or name_map.get((None, name))
        or f"{name}教室"
    )


def building_display_name(building):
    """building_name.csv の表示名を返す。未登録なら 屋外/{building}号館 にフォールバック"""
    building = int(building)
    display = get_building_name_map().get(building)
    if display:
        return display
    return "屋外" if building == 0 else f"{building}号館"


def first_display_label(building, raw_value):
    """
    ";"区切りの生の名前（name/right/left列の値）の先頭要素だけを、読み上げ用の表示名に変換する。
    トイレ（M_Toilet等）はname.csvに表示名が無く display_name のフォールバックだと不自然になる
    （例: "M_Toilet教室"）ため、TOILET_LABEL を先に見る。それ以外は name.csv に委ねる。
    """
    first = str(raw_value or "").split(";")[0].strip()
    if not first:
        return ""
    if first in TOILET_LABEL:
        return TOILET_LABEL[first]
    return display_name(building, first)


def clear_caches():
    global _name_map, _building_name_map, _ignore_set
    _name_map = None
    _building_name_map = None
    _ignore_set = None
```

### `programs/3D_Graph/ikunavi/payloads.py`

```python
"""3Dビューア(/3d)向けの、グラフ全体を1レスポンスにまとめたペイロード。

ノード数が数千規模で毎回組み立てると重いので、構築結果をそのまま保持する。
"""
import pandas as pd

from .cache import get_data
from .config import BUILDING_COLORS, OUTDOOR_COLOR
from .serialize import edge_to_dict
from .transform import resolved_transform_config

_graph_payload = None


def _building_color(building):
    if building == 0:
        return OUTDOOR_COLOR
    return BUILDING_COLORS[(building - 1) % len(BUILDING_COLORS)]


def _node_dict(row):
    bldg = int(row["building"])
    node_dict = {
        "id":       int(row["id"]),
        "x":        float(row["x"]),
        "y":        float(row["y"]),
        "z":        float(row["z"]),
        "building": bldg,
        "floor":    int(row["floor"]),
        "type":     int(row["type"]),
        "color":    _building_color(bldg),
        "label":    f"Node {int(row['id'])}<br>{'屋外' if bldg == 0 else f'Building {bldg}'} / Floor {int(row['floor'])}",
    }
    if "lat" in row and pd.notna(row["lat"]):
        node_dict["lat"] = float(row["lat"])
    if "lng" in row and pd.notna(row["lng"]):
        node_dict["lng"] = float(row["lng"])
    return node_dict


def get_graph_payload():
    """/api/graph 用のノード・エッジ・変換設定を一度だけ構築して使い回す"""
    global _graph_payload
    if _graph_payload is None:
        nodes_df, edges_df = get_data()

        nodes = [
            _node_dict(row)
            for _, row in nodes_df.iterrows()
            if not any(pd.isna(row[c]) for c in ["id", "x", "y", "z", "building", "floor"])
        ]
        valid_edges = edges_df.dropna(subset=["id", "from", "to", "building", "floor", "weight", "length"])
        edges = [edge_to_dict(row) for _, row in valid_edges.iterrows()]

        _graph_payload = {
            "nodes": nodes,
            "edges": edges,
            "building_colors": BUILDING_COLORS,
            "config": resolved_transform_config(),
        }
    return _graph_payload


def clear_caches():
    global _graph_payload
    _graph_payload = None
```

### `programs/3D_Graph/ikunavi/search.py`

```python
"""出発地・目的地の「候補ノード」への解決と、その総当たりによる最短経路探索。

教室・トイレ・食堂・イベントはいずれもノードではなくエッジ（または複数ノード）に
紐づくため、候補ノードを列挙して全組み合わせでDijkstraを回し、最短のものを採る。
"""
import networkx as nx


def candidates_from_edges(G, edge_rows, dedupe=False):
    """エッジ行のリスト → [(node_id, edge行), ...]（両端点。グラフに無いノードは除く）"""
    seen, result = set(), []
    for row in edge_rows:
        for nid in (int(row["from"]), int(row["to"])):
            if nid not in G.nodes:
                continue
            if dedupe:
                if nid in seen:
                    continue
                seen.add(nid)
            result.append((nid, row))
    return result


def candidates_from_event(G, event_candidates):
    """イベント索引の候補 → グラフ上に存在するノードだけの [(node_id, edge行|None), ...]"""
    seen, result = set(), []
    for nid, row in event_candidates:
        if nid in G.nodes and nid not in seen:
            seen.add(nid)
            result.append((nid, row))
    return result


def extend_to_far_endpoint(G, path, length, dest_edge_row):
    """
    目的地がエッジ（教室・トイレ・食堂）の場合、最寄り端点で止めず、
    そのエッジのもう一方の端点まで経路を延長する。
    教室はエッジ区間に面しているため、区間そのものを歩かせることで
    必ずドアの前を通る案内になる。
    直前ノードが反対側端点（＝既に目的エッジを歩いて到着）の場合は延長しない。
    """
    if dest_edge_row is None or not path:
        return path, length
    u, v = int(dest_edge_row["from"]), int(dest_edge_row["to"])
    last = path[-1]
    far = v if last == u else u if last == v else None
    if far is None:
        return path, length
    if len(path) >= 2 and path[-2] == far:
        return path, length
    if not G.has_edge(last, far):
        return path, length
    return path + [far], length + G.edges[last, far].get("weight", 0.0)


def best_route(G, start_candidates, dest_candidates, allow_same_node=True):
    """
    出発候補×目的候補の全組み合わせでDijkstraを実行し、最短経路を採用する。

    allow_same_node=False のときは出発と目的が同一ノードの組み合わせをスキップする
    （最寄りトイレ・食堂検索では、出発点自体が目的地そのものである場合を
    経路として扱わないため）。

    戻り値: (best_path|None, best_length, best_start_row, best_dest_row)
    """
    best_path, best_length = None, float("inf")
    best_start_row = best_dest_row = None
    for (s_node, s_row) in start_candidates:
        for (d_node, d_row) in dest_candidates:
            if s_node == d_node:
                if not allow_same_node:
                    continue
                # 出発と目的が同一ノードを共有する場合は距離0の自明な経路
                length, path = 0.0, [s_node]
            else:
                try:
                    length, path = nx.bidirectional_dijkstra(G, s_node, d_node, weight="weight")
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    continue
            if length < best_length:
                best_length, best_path = length, path
                best_start_row, best_dest_row = s_row, d_row
    return best_path, best_length, best_start_row, best_dest_row
```

### `programs/3D_Graph/ikunavi/serialize.py`

```python
"""探索結果とCSV行を、APIレスポンス用のdictに整形する。

「どちら側にあるか」「手前から何番目か」といった案内文言のもとになる情報も
ここで組み立てる。左右は進行方向に補正済みのエッジ属性からしか判定しないこと。
"""
from .cache import get_node_xyz
from .naming import first_display_label


def edge_to_dict(row):
    """edgeの行を座標付きdictに変換するヘルパー"""
    node_xyz = get_node_xyz()
    x0, y0, z0 = node_xyz[int(row["from"])]
    x1, y1, z1 = node_xyz[int(row["to"])]
    return {
        "id":       int(row["id"]),
        "name":     str(row["name"]),
        "right":    str(row.get("right", "")),
        "left":     str(row.get("left", "")),
        "from":     int(row["from"]),
        "to":       int(row["to"]),
        "building": int(row["building"]),
        "floor":    int(row["floor"]),
        "weight":   float(row["weight"]),
        "length":   float(row["length"]),
        "type":     str(row["type"]),
        "x0": x0, "y0": y0, "z0": z0,
        "x1": x1, "y1": y1, "z1": z1,
    }


def path_result(G, path, length):
    """Dijkstraの結果をJSON用dictに整形するヘルパー"""
    path_coords = []
    for node_id in path:
        n = G.nodes[node_id]
        coord_dict = {"id": node_id, "x": n["x"], "y": n["y"], "z": n["z"],
                      "building": n["building"], "floor": n["floor"]}
        if "lat" in n:
            coord_dict["lat"] = n["lat"]
        if "lng" in n:
            coord_dict["lng"] = n["lng"]
        if "svg_x" in n and n["svg_x"] == n["svg_x"]:  # NaN check
            coord_dict["svg_x"] = n["svg_x"]
            coord_dict["svg_y"] = n["svg_y"]
        path_coords.append(coord_dict)

    path_edges = []
    for u, v in zip(path, path[1:]):
        edata = G.edges[u, v]
        n0, n1 = G.nodes[u], G.nodes[v]
        building = edata.get("building")
        name, right, left = edata.get("name", ""), edata.get("right", ""), edata.get("left", "")
        path_edges.append({
            "from": u, "to": v,
            "name":   name,
            "right":  right,
            "left":   left,
            # 読み上げ用の表示名（先頭要素のみ、トイレ等の内部コードも日本語表記に変換済み）。
            # 生の name/right/left はそのままエッジ照合用に残す。
            "name_display":  first_display_label(building, name),
            "right_display": first_display_label(building, right),
            "left_display":  first_display_label(building, left),
            "length": edata.get("length", 0),
            "type":   edata.get("edge_type", "1"),
            "x0": n0["x"], "y0": n0["y"], "z0": n0["z"],
            "x1": n1["x"], "y1": n1["y"], "z1": n1["z"],
        })
    return {"path": path, "total_weight": length,
            "path_coords": path_coords, "path_edges": path_edges}


def _split_names(raw):
    """";"区切りの名前列を、空要素を落としたリストにする"""
    return [n.strip() for n in str(raw or "").split(";") if n.strip()]


def side_for_room(edge_like, room_name):
    """
    edge_like（"right"/"left"キーを持つdict、またはCSV行のように.get()できるもの）を見て、
    room_nameがどちら側にあるかを "right"/"left" で返す。
    right/leftは";"区切りで複数名を持ちうるため、個別の名前として厳密一致で照合する。
    どちらにも無い・room_name未指定・edge_like無しの場合は ""（呼び出し側でフォールバック表示）。

    注意: 必ず「実際に歩く向き」に補正済みのright/left（build_graphが逆方向エッジ用に
    入れ替え済みのもの。例えば path_result() が返す path_edges の各要素）を渡すこと。
    edge.csvの生の行（from→to方向のright/leftのみを持つ）を渡すと、経路がCSVのfrom/toと
    逆向きに通る場合に左右が逆の結果になる。
    """
    if edge_like is None or not room_name:
        return ""
    room_name = str(room_name).strip()
    if room_name in _split_names(edge_like.get("right", "")):
        return "right"
    if room_name in _split_names(edge_like.get("left", "")):
        return "left"
    return ""


_EMPTY_DEST_INFO = {"side": "", "position": None, "count": None,
                    "nearest_display": None, "dest_display": None}


def dest_info(result, room_name):
    """
    path_result() が返した result["path_edges"] の最終区間（実際に歩く向きに補正済み）を見て、
    room_nameの左右・手前から数えた順番を判定する。API各エンドポイントの dest_side 等は
    これ経由で計算すること（edge.csvの生の行を直接 side_for_room に渡さない）。

    right/leftは";"区切りで手前から奥への物理的な並び順を持つ列（edge.csvの想定通り）なので、
    その並び順の中でroom_nameが何番目かがそのまま「手前から数えてN番目」になる。

    戻り値:
      side: "right"/"left"/""（どちらにも一致しなければ""）
      position: 1始まりの順位（一致しなければNone）
      count: その側にある教室の総数（一致しなければNone）
      nearest_display: 一番手前（先頭）の教室の表示名（一致しなければNone）
      dest_display: room_name自体の表示名（一致しなければNone）
    """
    edges = result.get("path_edges") or []
    if not edges or not room_name:
        return dict(_EMPTY_DEST_INFO)
    last = edges[-1]
    room_name = str(room_name).strip()
    coords = result.get("path_coords") or []
    building = coords[-1].get("building") if coords else None

    for side in ("right", "left"):
        names = _split_names(last.get(side, ""))
        if room_name in names:
            return {
                "side": side,
                "position": names.index(room_name) + 1,
                "count": len(names),
                "nearest_display": first_display_label(building, names[0]),
                "dest_display": first_display_label(building, room_name),
            }
    return dict(_EMPTY_DEST_INFO)


def apply_dest_info(result, room_name):
    """dest_info()の結果をresultのdest_*フィールドとして書き込む共通処理"""
    info = dest_info(result, room_name)
    result["dest_side"] = info["side"]
    result["dest_position"] = info["position"]
    result["dest_count"] = info["count"]
    result["dest_nearest_display"] = info["nearest_display"]
    result["dest_display"] = info["dest_display"]
```

### `programs/3D_Graph/ikunavi/transform.py`

```python
"""建物ローカル座標 → キャンパス共通座標 への変換パラメータの算出と適用。

各建物の node.csv はその建物だけのローカル座標で書かれている。これを
anchors.csv（ローカルノードと屋外ノードの対応）から求めた回転・平行移動で
共通座標に載せ替えることで、建物をまたぐ経路探索ができるようになる。
座標系の考え方は docs/XYZ_Design.md を参照。
"""
import json
import math
import os

import pandas as pd

from .config import ANCHORS_CSV, BUILDINGS_JSON, DATA_DIR, GLOBAL_NODE_CSV


def load_transform_config():
    """buildings.json に手書きされた変換パラメータを読む（無ければ空）"""
    if os.path.exists(BUILDINGS_JSON):
        with open(BUILDINGS_JSON) as f:
            return json.load(f)
    return {}


def calc_transforms_from_anchors():
    """
    global_node.csv と anchors.csv から各建物の変換パラメータを自動計算する。
    2点アンカー: 回転+平行移動を自動計算。
    1点アンカー: 平行移動のみ自動計算、rot_deg は buildings.json から取得（なければ 0）。
    tz_offset が buildings.json にあれば加算する。
    """
    if not os.path.exists(GLOBAL_NODE_CSV) or not os.path.exists(ANCHORS_CSV):
        return {}

    gn = pd.read_csv(GLOBAL_NODE_CSV)
    gn.columns = gn.columns.str.strip()
    if gn.empty:
        return {}
    gn = gn.set_index("id")

    anchors = pd.read_csv(ANCHORS_CSV)
    anchors.columns = anchors.columns.str.strip()
    if anchors.empty:
        return {}

    config = load_transform_config()
    transforms = {}
    for bldg_id, group in anchors.groupby("building"):
        if len(group) < 1:
            continue

        bldg_cfg = config.get(str(int(bldg_id)), {})
        r0 = group.iloc[0]

        bldg_dir = os.path.join(DATA_DIR, f"{int(bldg_id)}_bldg")
        local_nodes = pd.read_csv(os.path.join(bldg_dir, "node.csv"))
        local_nodes.columns = local_nodes.columns.str.strip()
        local_nodes = local_nodes.set_index("id")

        lx1 = float(local_nodes.loc[int(r0["local_node_id"]), "x"])
        ly1 = float(local_nodes.loc[int(r0["local_node_id"]), "y"])
        lz1 = float(local_nodes.loc[int(r0["local_node_id"]), "z"])

        gx1 = float(gn.loc[int(r0["global_node_id"]), "x"])
        gy1 = float(gn.loc[int(r0["global_node_id"]), "y"])
        gz1 = float(gn.loc[int(r0["global_node_id"]), "z"])

        if len(group) >= 2:
            r1 = group.iloc[1]
            lx2 = float(local_nodes.loc[int(r1["local_node_id"]), "x"])
            ly2 = float(local_nodes.loc[int(r1["local_node_id"]), "y"])
            gx2 = float(gn.loc[int(r1["global_node_id"]), "x"])
            gy2 = float(gn.loc[int(r1["global_node_id"]), "y"])
            θ = math.atan2(gy2 - gy1, gx2 - gx1) - math.atan2(ly2 - ly1, lx2 - lx1)
        else:
            # 1点アンカー: buildings.json の rot_deg を回転として使用
            θ = math.radians(bldg_cfg.get("rot_deg", 0.0))

        cos_θ, sin_θ = math.cos(θ), math.sin(θ)
        tx = gx1 - (cos_θ * lx1 - sin_θ * ly1)
        ty = gy1 - (sin_θ * lx1 + cos_θ * ly1)
        tz = gz1 - lz1 + bldg_cfg.get("tz_offset", 0.0)

        transforms[str(int(bldg_id))] = {
            "tx": tx, "ty": ty, "tz": tz,
            "rot_deg": math.degrees(θ),
        }

    return transforms


def resolved_transform_config():
    """buildings.json をベースに、anchors.csv がある建物は自動計算で上書きした設定"""
    config = load_transform_config()
    config.update(calc_transforms_from_anchors())
    return config


def apply_transform(nodes_df, cfg):
    """変換パラメータをノード座標に適用する"""
    θ  = math.radians(cfg.get("rot_deg", 0.0))
    tx = cfg.get("tx", 0.0)
    ty = cfg.get("ty", 0.0)
    tz = cfg.get("tz", 0.0)
    nodes_df = nodes_df.copy()
    if θ != 0:
        cos_θ, sin_θ = math.cos(θ), math.sin(θ)
        lx, ly = nodes_df["x"].copy(), nodes_df["y"].copy()
        nodes_df["x"] = cos_θ * lx - sin_θ * ly + tx
        nodes_df["y"] = sin_θ * lx + cos_θ * ly + ty
    else:
        nodes_df["x"] += tx
        nodes_df["y"] += ty
    nodes_df["z"] += tz
    return nodes_df
```

### `programs/3D_Graph/ikunavi/routes/__init__.py`

```python
"""APIのエンドポイント定義。機能ごとにBlueprintを分けている"""
from . import events, facilities, images, navigation, rooms, viewer

BLUEPRINTS = (
    viewer.bp,
    rooms.bp,
    events.bp,
    navigation.bp,
    facilities.bp,
    images.bp,
)
```

### `programs/3D_Graph/ikunavi/routes/_common.py`

```python
"""ルート間で共通のクエリパラメータ解釈。

出発点の指定方法（教室名 / ノードID / イベント名）は複数のエンドポイントで
同じ書式なので、解釈と候補ノードへの解決をここにまとめている。
"""
from flask import request

from .. import cache
from ..errors import ApiError
from ..search import candidates_from_edges, candidates_from_event
from ..serialize import edge_to_dict


def use_elevator_param():
    """use_elevator=0 のときだけエレベータを使わない（省略時は使う）"""
    return request.args.get("use_elevator", "1") != "0"


def edges_for_room_or_404(room_name, building, label="教室"):
    """教室名→エッジ行。見つからなければ404"""
    edges = cache.find_edges_for_room(room_name, building)
    if not edges:
        raise ApiError(f"建物 {building} に{label} '{room_name}' が見つかりません", 404)
    return edges


class FromSpec:
    """出発点の指定（from_room＋from_building / from_node / from_event）"""

    def __init__(self, room="", building=None, node_id=None, event=""):
        self.room = room
        self.building = building
        self.node_id = node_id
        self.event = event

    @classmethod
    def from_request(cls):
        return cls(
            room=request.args.get("from_room", "").strip(),
            building=request.args.get("from_building", type=int),
            node_id=request.args.get("from_node", type=int),
            event=request.args.get("from_event", "").strip(),
        )

    def require(self):
        """いずれも指定されていなければ400"""
        if not self.room and not self.event and self.node_id is None:
            raise ApiError("from_room（＋from_building）・from_event・from_node のいずれかを指定してください")
        return self

    def candidates(self, G):
        """
        出発点指定（from_event / from_room / from_node の優先順）を
        候補ノードのリスト [(node_id, edge行|None), ...] に解決する。
        """
        if self.event:
            result = candidates_from_event(G, cache.find_event_candidates(self.event))
            if not result:
                raise ApiError(f"イベント '{self.event}' が見つかりません", 404)
            return result

        if self.room:
            if self.building is None:
                raise ApiError("from_building を指定してください")
            edges = edges_for_room_or_404(self.room, self.building)
            return candidates_from_edges(G, edges, dedupe=True)

        if self.node_id not in G.nodes:
            raise ApiError(f"ノード {self.node_id} が存在しません", 404)
        return [(self.node_id, None)]

    def annotate(self, result, start_edge_row):
        """レスポンスに出発点情報（from_event / from_room / from_edge）を書き足す"""
        if self.event:
            result["from_event"] = self.event
        if start_edge_row is not None:
            if self.room:
                result["from_room"] = self.room
            result["from_edge"] = edge_to_dict(start_edge_row)
        return result
```

### `programs/3D_Graph/ikunavi/routes/events.py`

```python
"""イベントモード（data/event.csv に登録した屋台・催し）"""
from flask import Blueprint, jsonify

from .. import cache

bp = Blueprint("events", __name__)


@bp.route("/api/events")
def api_events():
    """
    event.csv に登録されたイベント（屋台など）の一覧を返す。
    返却形式: [ { "title": "たこ焼き屋台", "building": 10, "floor": 1 }, ... ]
    """
    _, events_list = cache.get_event_index()
    return jsonify(events_list)
```

### `programs/3D_Graph/ikunavi/routes/facilities.py`

```python
"""最寄り施設（トイレ・食堂）の検索。

いずれも「出発点から一番近い候補エッジ」を全探索で選ぶ点は同じで、
目的地の集め方とレスポンスに添える情報だけが違う。
"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..naming import TOILET_LABEL, TOILET_TYPE_MAP
from ..search import best_route, candidates_from_edges, extend_to_far_endpoint
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import FromSpec, use_elevator_param

bp = Blueprint("facilities", __name__)


def _route_to_facility(G, start_candidates, facility_edges, no_path_error):
    """出発点から施設エッジ群への最短経路。出発点そのものは目的地として扱わない"""
    dest_candidates = candidates_from_edges(G, facility_edges)

    best_path, best_length, best_start_row, best_dest_row = best_route(
        G, start_candidates, dest_candidates, allow_same_node=False)
    if best_path is None:
        raise ApiError(no_path_error, 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_row)
    return path_result(G, best_path, best_length), best_start_row, best_dest_row


def _names_in(edge_row):
    return [n.strip() for n in str(edge_row["name"]).split(";")]


@bp.route("/api/cafeterias")
def api_cafeterias():
    return jsonify(cache.get_cafeteria_list())


@bp.route("/api/nearest_toilet")
def api_nearest_toilet():
    """
    最寄りのトイレへの最短経路を返す。

    出発点（いずれか）:
      from_room=101A&from_building=10
      from_node=100001
      from_event=たこ焼き屋台

    種別:
      type=M / F / C / all (省略時 all)

    条件:
      use_elevator=0/1 (省略時 1)
    """
    toilet_type = request.args.get("type", "all").strip().upper()
    from_spec = FromSpec.from_request().require()

    targets = TOILET_TYPE_MAP.get(toilet_type, TOILET_TYPE_MAP["ALL"])
    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)

    # トイレエッジを全建物から収集（教室名索引から引く。複数種別併記のエッジはIDで重複排除）
    toilet_edges = cache.edges_by_names(targets)
    if not toilet_edges:
        raise ApiError("該当するトイレがデータ内に見つかりません", 404)

    result, best_start_row, best_toilet_row = _route_to_facility(
        G, start_candidates, toilet_edges,
        "指定された出発点から該当するトイレへの経路が見つかりません")

    t_names = _names_in(best_toilet_row)
    found_key = next((t for t in TOILET_TYPE_MAP["ALL"] if t in t_names), "")

    result["toilet_type"]     = found_key.split("_")[0] if found_key else ""
    result["toilet_name"]     = found_key
    result["toilet_label"]    = TOILET_LABEL.get(found_key, "トイレ")
    result["toilet_building"] = int(best_toilet_row["building"])
    result["toilet_floor"]    = int(best_toilet_row["floor"])
    result["toilet_edge"]     = edge_to_dict(best_toilet_row)
    apply_dest_info(result, found_key)
    from_spec.annotate(result, best_start_row)
    return jsonify(result)


@bp.route("/api/nearest_cafeteria")
def api_nearest_cafeteria():
    """
    最寄りの食堂への最短経路を返す。

    出発点（いずれか）:
      from_room=101A&from_building=10
      from_node=100001
      from_event=たこ焼き屋台

    条件:
      use_elevator=0/1 (省略時 1)
    """
    from_spec = FromSpec.from_request().require()

    cafeteria_names = cache.get_cafeteria_names()
    if not cafeteria_names:
        raise ApiError("cafeteria_edge.csv が見つかりません", 500)

    caf_name = request.args.get("name", "all").strip()
    targets  = [caf_name] if caf_name != "all" else cafeteria_names

    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)

    caf_edges = cache.edges_by_names(targets)
    if not caf_edges:
        raise ApiError("食堂エッジがデータ内に見つかりません", 404)

    result, best_start_row, best_caf_row = _route_to_facility(
        G, start_candidates, caf_edges, "食堂への経路が見つかりません")

    matched_caf = next((t for t in targets if t in _names_in(best_caf_row)), "")

    result["cafeteria_building"] = int(best_caf_row["building"])
    result["cafeteria_floor"]    = int(best_caf_row["floor"])
    result["cafeteria_edge"]     = edge_to_dict(best_caf_row)
    apply_dest_info(result, matched_caf)
    from_spec.annotate(result, best_start_row)
    return jsonify(result)
```

### `programs/3D_Graph/ikunavi/routes/images.py`

```python
"""エッジ（区間）ごとの経路写真のURL一覧"""
import os

import pandas as pd
from flask import Blueprint, jsonify

from ..config import CDN_BASE, EDGE_IMAGE_CSV

bp = Blueprint("images", __name__)


@bp.route("/api/edge_images")
def api_edge_images():
    """
    エッジ画像マップを返す。
    返却形式: { "1000001_1000002": "https://cdn.iku-navi.net/1000001_to_1000002.jpg", ... }
    """
    if not os.path.exists(EDGE_IMAGE_CSV):
        return jsonify({})
    df = pd.read_csv(EDGE_IMAGE_CSV)
    df.columns = df.columns.str.strip()
    df = df.dropna(subset=["from", "to"])
    result = {}
    for _, row in df.iterrows():
        f, t = int(row["from"]), int(row["to"])
        if f == 0 and t == 0:
            continue
        name = str(row["image_name"]).strip()
        if not name or name == "nan":
            continue
        result[f"{f}_{t}"] = f"{CDN_BASE}/{name}"
    return jsonify(result)
```

### `programs/3D_Graph/ikunavi/routes/navigation.py`

```python
"""出発地→目的地の経路探索（ナビUIが使う本命のAPI）"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..search import (
    best_route,
    candidates_from_edges,
    candidates_from_event,
    extend_to_far_endpoint,
)
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import FromSpec, edges_for_room_or_404, use_elevator_param

bp = Blueprint("navigation", __name__)


def _dest_candidates(G, to_room, to_building, to_node_id, to_event):
    """目的地指定（to_event / to_room / to_node の優先順）を候補ノードに解決する"""
    if to_event:
        candidates = candidates_from_event(G, cache.find_event_candidates(to_event))
        if not candidates:
            raise ApiError(f"イベント '{to_event}' が見つかりません", 404)
        return candidates

    if to_room:
        if to_building is None:
            raise ApiError("to_building を指定してください")
        return candidates_from_edges(G, edges_for_room_or_404(to_room, to_building))

    if to_node_id not in G.nodes:
        raise ApiError(f"ノード {to_node_id} が存在しません", 404)
    return [(to_node_id, None)]


@bp.route("/api/route")
def api_route():
    """
    出発点と目的地を指定して最短経路をJSONで返す。

    出発点（いずれか）:
      from_room=101A&from_building=10  ← 教室名
      from_node=100001                 ← ノードID
      from_event=たこ焼き屋台          ← イベント名（event.csv）

    目的地（いずれか）:
      to_room=202B&to_building=10      ← 教室名
      to_node=100050                   ← ノードID
      to_event=たこ焼き屋台            ← イベント名（event.csv）

    条件:
      use_elevator=0/1  （省略時 1）
    """
    from_spec = FromSpec.from_request()

    to_room     = request.args.get("to_room",     "").strip()
    to_building = request.args.get("to_building", type=int)
    to_node_id  = request.args.get("to_node",     type=int)
    to_event    = request.args.get("to_event",    "").strip()

    from_spec.require()
    if not to_room and not to_event and to_node_id is None:
        raise ApiError("to_room（＋to_building）・to_event・to_node のいずれかを指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)
    dest_candidates  = _dest_candidates(G, to_room, to_building, to_node_id, to_event)

    best_path, best_length, best_start_edge, best_dest_edge = best_route(
        G, start_candidates, dest_candidates)

    if best_path is None:
        raise ApiError("指定された出発点から目的地への経路が見つかりません", 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = path_result(G, best_path, best_length)
    if to_event:
        result["to_event"] = to_event
    from_spec.annotate(result, best_start_edge)
    if best_dest_edge is not None:
        if to_room:
            result["to_room"] = to_room
        result["to_edge"] = edge_to_dict(best_dest_edge)
        apply_dest_info(result, to_room)
    return jsonify(result)


@bp.route("/api/shortest_path")
def api_shortest_path():
    """ノードIDからノードIDへの最短経路（従来通り）"""
    start = request.args.get("start", type=int)
    goal  = request.args.get("goal",  type=int)

    if start is None or goal is None:
        raise ApiError("start と goal のノードIDを指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())

    if start not in G.nodes:
        raise ApiError(f"ノード {start} が存在しません", 404)
    if goal not in G.nodes:
        raise ApiError(f"ノード {goal} が存在しません", 404)

    best_path, best_length, _, _ = best_route(G, [(start, None)], [(goal, None)])
    if best_path is None:
        raise ApiError(f"ノード {start} から {goal} への経路が見つかりません", 404)
    return jsonify(path_result(G, best_path, best_length))
```

### `programs/3D_Graph/ikunavi/routes/rooms.py`

```python
"""教室の一覧・検索と、教室から教室へのナビゲーション"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..naming import building_display_name
from ..search import best_route, candidates_from_edges, extend_to_far_endpoint
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import edges_for_room_or_404, use_elevator_param

bp = Blueprint("rooms", __name__)


@bp.route("/api/rooms")
def api_rooms():
    """
    教室名の一覧を返す。
    ?building=10  建物IDで絞り込み（省略時は全建物）
    ?q=101        前方一致の絞り込み（省略時は全件）
    返却形式: [ { "room": "101A", "building": 10, "edge_id": 5, "floor": 1 }, ... ]
    """
    building_filter = request.args.get("building", type=int)
    query           = request.args.get("q", "").strip().lower()

    _, rooms_list = cache.get_room_index()
    rooms = [
        r for r in rooms_list
        if (building_filter is None or r["building"] == building_filter)
        and (not query or query in r["room"].lower())
    ]
    return jsonify(rooms)


@bp.route("/api/all")
def api_all():
    """
    全教室・全ノード・建物一覧をまとめて返す。パラメータなし。
    返却形式:
      {
        "rooms":     [ { "room", "building", "floor", "edge_id", "from", "to" }, ... ],
        "nodes":     [ { "id", "building", "floor", "type" }, ... ],
        "buildings": [ { "id": 1, "display_name": "1号館" }, ... ]
      }
    display_name は data/building_name.csv で設定した表示名（未設定なら "{id}号館" / building=0 は "屋外"）。
    """
    nodes_df, _ = cache.get_data()
    _, rooms = cache.get_room_index()
    nodes    = cache.get_nodes_list()
    building_ids = sorted(nodes_df["building"].dropna().astype(int).unique().tolist())
    buildings = [{"id": b, "display_name": building_display_name(b)} for b in building_ids]

    return jsonify({"rooms": rooms, "nodes": nodes, "buildings": buildings})


@bp.route("/api/navigate_to_room")
def api_navigate_to_room():
    """
    教室名から教室名への最短経路を返す。

    出発点の指定方法（いずれか）:
      A) start_room=101A&start_building=10  ← 出発教室名
      B) start=1                            ← 出発ノードID（後方互換）

    必須:
      room=101A&building=10  ← 目的教室名

    教室はエッジの属性なので、各教室エッジの両端点を候補ノードとし、
    全組み合わせ中で最短のパスを採用する。
    レスポンスには経路情報に加え start_edge / destination_edge も含む。
    """
    room_name      = request.args.get("room",           "").strip()
    building       = request.args.get("building",       type=int)
    start_room     = request.args.get("start_room",     "").strip()
    start_building = request.args.get("start_building", type=int)
    start_node     = request.args.get("start",          type=int)  # 後方互換

    if not room_name or building is None:
        raise ApiError("room と building を指定してください")
    if not start_room and start_node is None:
        raise ApiError("start_room（＋start_building）または start を指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())

    dest_edges = edges_for_room_or_404(room_name, building)
    dest_candidates = candidates_from_edges(G, dest_edges)

    if start_room and start_building is not None:
        s_edges = edges_for_room_or_404(start_room, start_building, label="出発教室")
        start_candidates = candidates_from_edges(G, s_edges)
    else:
        # ノードID指定（後方互換）
        if start_node not in G.nodes:
            raise ApiError(f"ノード {start_node} が存在しません", 404)
        start_candidates = [(start_node, None)]

    best_path, best_length, best_start_edge, best_dest_edge = best_route(
        G, start_candidates, dest_candidates)

    if best_path is None:
        label = f"'{start_room}'" if start_room else f"ノード {start_node}"
        raise ApiError(f"{label} から教室 '{room_name}' への経路が見つかりません", 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = path_result(G, best_path, best_length)
    result["destination_room"] = room_name
    result["destination_edge"] = edge_to_dict(best_dest_edge)
    apply_dest_info(result, room_name)
    if best_start_edge is not None:
        result["start_room"] = start_room
        result["start_edge"] = edge_to_dict(best_start_edge)
    return jsonify(result)
```

### `programs/3D_Graph/ikunavi/routes/viewer.py`

```python
"""3Dグラフビューア（開発・データ確認用の画面とそのデータ）"""
from flask import Blueprint, jsonify, render_template

from .. import cache
from ..payloads import get_graph_payload

bp = Blueprint("viewer", __name__)


@bp.route("/3d/")
@bp.route("/3d")
def index():
    nodes_df, _ = cache.get_data()
    node_ids  = sorted(nodes_df["id"].tolist())
    # building=0 (屋外) はフィルタの「すべての建物」(value=0) と衝突するため除外
    buildings = sorted(int(b) for b in nodes_df["building"].unique() if int(b) != 0)
    return render_template("index.html", node_ids=node_ids, buildings=buildings)


@bp.route("/api/graph")
def api_graph():
    return jsonify(get_graph_payload())
```

### `programs/3D_Graph/templates/index.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>大学ARマップ — 3D経路ビューア</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <script src="https://cdn.plot.ly/plotly-2.30.0.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:          #07111d;
      --surface:     #0c1b2d;
      --surface-hi:  #12243e;
      --surface-2:   #162d4a;
      --border:      #1e3450;
      --border-hi:   #2e4e78;
      --text:        #d4e8f8;
      --text-sub:    #6a9abf;
      --text-muted:  #3a5878;
      --accent:      #00c0ee;
      --accent-dim:  rgba(0, 192, 238, 0.12);
      --accent-glow: rgba(0, 192, 238, 0.25);
      --amber:       #f0a030;
      --amber-dim:   rgba(240, 160, 48, 0.12);
      --green:       #00d498;
      --green-dim:   rgba(0, 212, 152, 0.10);
      --red:         #f03858;
      --red-dim:     rgba(240, 56, 88, 0.12);
      --gold:        #f2c437;
      --gold-dim:    rgba(242, 196, 55, 0.12);
      --header-h:    52px;
      --peek-h:      64px;
      --sheet-r:     20px;
      --font:        'Outfit', 'Noto Sans JP', system-ui, sans-serif;
      --font-mono:   'DM Mono', 'Courier New', monospace;
      --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --ease-out:    cubic-bezier(0.16, 1, 0.3, 1);
    }

    html, body { height: 100%; }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ============================================================
       HEADER
    ============================================================ */
    header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 18px;
      height: var(--header-h);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      z-index: 10;
      position: relative;
    }
    header::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent) 30%, var(--accent) 70%, transparent);
      opacity: 0.35;
    }

    .header-icon {
      width: 28px; height: 28px;
      background: var(--accent-dim);
      border: 1px solid rgba(0,192,238,0.3);
      border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }
    .header-title-wrap { display: flex; flex-direction: column; gap: 2px; }
    header h1 {
      font-size: 0.92rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--text);
    }
    header .sub {
      font-size: 0.62rem;
      color: var(--text-muted);
      letter-spacing: 0.06em;
      font-family: var(--font-mono);
    }

    /* ============================================================
       MAIN LAYOUT
    ============================================================ */
    .main-layout {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* ============================================================
       SIDEBAR
    ============================================================ */
    .sidebar {
      width: 280px;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
    }

    .sheet-drag-handle { display: none; }

    .sheet-scroll-area {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: thin;
      scrollbar-color: var(--border-hi) transparent;
    }
    .sheet-scroll-area::-webkit-scrollbar { width: 3px; }
    .sheet-scroll-area::-webkit-scrollbar-track { background: transparent; }
    .sheet-scroll-area::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 2px; }

    /* ============================================================
       TABS
    ============================================================ */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      position: relative;
      background: var(--surface);
    }
    .tab {
      flex: 1;
      padding: 11px 2px 10px;
      font-size: 0.70rem;
      font-weight: 600;
      text-align: center;
      cursor: pointer;
      color: var(--text-muted);
      border-bottom: 2px solid transparent;
      transition: color 0.2s, border-color 0.2s;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
      letter-spacing: 0.02em;
    }
    .tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }
    .tab:hover:not(.active) { color: var(--text-sub); }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ============================================================
       PANELS
    ============================================================ */
    .panel {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
    }
    .panel h2 {
      font-size: 0.60rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--text-muted);
      margin-bottom: 12px;
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .panel h2::before {
      content: '';
      width: 14px; height: 1px;
      background: var(--accent);
      opacity: 0.6;
    }

    /* ============================================================
       LABELS & INPUTS
    ============================================================ */
    label {
      display: block;
      font-size: 0.72rem;
      color: var(--text-sub);
      margin-bottom: 4px;
      letter-spacing: 0.02em;
    }

    select, input[type=text] {
      width: 100%;
      background: var(--surface-hi);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 9px 12px;
      font-size: 1rem;
      font-family: var(--font);
      margin-bottom: 10px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      -webkit-appearance: none;
      appearance: none;
    }
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236a9abf' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 30px;
      cursor: pointer;
    }
    select:focus, input[type=text]:focus {
      border-color: rgba(0, 192, 238, 0.5);
      box-shadow: 0 0 0 3px var(--accent-dim);
    }
    input[type=text]::placeholder { color: var(--text-muted); }

    /* ============================================================
       BUTTONS
    ============================================================ */
    .btn {
      display: block;
      width: 100%;
      padding: 11px;
      border: none;
      border-radius: 9px;
      font-size: 0.85rem;
      font-weight: 700;
      font-family: var(--font);
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
      letter-spacing: 0.04em;
      -webkit-tap-highlight-color: transparent;
    }
    .btn:active { transform: scale(0.97); }

    .btn-primary {
      background: linear-gradient(135deg, #00c0ee, #0098c8);
      color: #07111d;
      font-weight: 700;
      box-shadow: 0 2px 12px rgba(0, 192, 238, 0.3);
    }
    .btn-primary:hover {
      box-shadow: 0 4px 20px rgba(0, 192, 238, 0.45);
      opacity: 0.95;
    }

    .btn-secondary {
      background: transparent;
      color: var(--text-sub);
      border: 1px solid var(--border-hi);
      margin-top: 8px;
    }
    .btn-secondary:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-dim);
    }

    /* ============================================================
       CHECKBOX ROW
    ============================================================ */
    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 0.80rem;
      color: var(--text-sub);
      margin-bottom: 12px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .checkbox-row input[type=checkbox] {
      width: 16px; height: 16px;
      margin: 0;
      cursor: pointer;
      flex-shrink: 0;
      accent-color: var(--accent);
    }

    /* ============================================================
       AUTOCOMPLETE
    ============================================================ */
    .autocomplete-wrap { position: relative; margin-bottom: 10px; }
    .autocomplete-wrap input { margin-bottom: 0; }

    .ac-dropdown {
      position: absolute;
      top: calc(100% + 2px);
      left: 0; right: 0;
      background: var(--surface-2);
      border: 1px solid var(--border-hi);
      border-radius: 10px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 300;
      display: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      scrollbar-width: thin;
      scrollbar-color: var(--border-hi) transparent;
    }

    .room-option {
      padding: 10px 12px;
      font-size: 0.84rem;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 44px;
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }
    .room-option:last-child { border-bottom: none; }
    .room-option:hover, .room-option.ac-active {
      background: var(--accent-dim);
      color: var(--accent);
    }
    .room-option .room-meta {
      font-size: 0.68rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      flex-shrink: 0;
      margin-left: 8px;
    }
    .room-option:hover .room-meta,
    .room-option.ac-active .room-meta { color: var(--accent); opacity: 0.7; }

    /* ============================================================
       ROOM BADGE
    ============================================================ */
    .room-badge {
      display: none;
      margin-bottom: 10px;
      font-size: 0.76rem;
      padding: 6px 10px;
      background: var(--accent-dim);
      border: 1px solid rgba(0,192,238,0.3);
      border-radius: 7px;
      color: var(--accent);
      word-break: break-all;
    }

    /* ============================================================
       RESULT BOXES
    ============================================================ */
    #result-box, #room-result-box, #toilet-result-box {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 9px;
      font-size: 0.80rem;
      line-height: 1.8;
      display: none;
      font-family: var(--font);
    }
    .success {
      background: var(--green-dim);
      border: 1px solid rgba(0, 212, 152, 0.3);
      color: #88f0cc;
    }
    .success b { color: var(--green); font-weight: 600; }
    .error {
      background: var(--red-dim);
      border: 1px solid rgba(240, 56, 88, 0.3);
      color: #f08098;
    }

    /* Distance value highlight */
    .success br + b {
      font-family: var(--font-mono);
    }

    /* ============================================================
       LEGEND & STATS
    ============================================================ */
    .legend-item {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 0.82rem;
      margin-bottom: 7px;
      color: var(--text-sub);
    }
    .legend-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 0 0 6px currentColor;
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.80rem;
      padding: 7px 0;
      border-bottom: 1px solid var(--border);
      color: var(--text-muted);
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-row span:last-child {
      color: var(--text);
      font-weight: 600;
      font-family: var(--font-mono);
      font-size: 0.88rem;
    }

    /* ============================================================
       3D MAP
    ============================================================ */
    #map-container {
      flex: 1;
      position: relative;
      background: var(--bg);
      min-width: 0;
    }
    #map { width: 100%; height: 100%; touch-action: none; }

    .map-hint {
      position: absolute;
      bottom: 14px; right: 14px;
      background: rgba(12, 27, 45, 0.88);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 0.66rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      pointer-events: none;
      user-select: none;
      backdrop-filter: blur(8px);
      letter-spacing: 0.02em;
    }
    .map-hint .hint-desktop { display: inline; }
    .map-hint .hint-mobile  { display: none; }

    /* ============================================================
       MOBILE STYLES  (≤ 767px)
    ============================================================ */
    @media (max-width: 767px) {
      header { padding: 0 14px; }
      header h1  { font-size: 0.86rem; }
      header .sub { display: none; }

      .main-layout {
        flex-direction: column;
        overflow: hidden;
      }

      #map-container {
        position: absolute;
        inset: 0;
        z-index: 0;
      }

      /* ---- BOTTOM SHEET ---- */
      .sidebar {
        position: absolute;
        left: 0; right: 0; bottom: 0;
        width: 100%;
        height: var(--peek-h);
        max-height: 84vh;
        border-right: none;
        border-top: 1px solid var(--border-hi);
        border-radius: var(--sheet-r) var(--sheet-r) 0 0;
        z-index: 100;
        overflow: hidden;
        transition: height 0.38s var(--ease-out);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        background: rgba(10, 22, 36, 0.92);
        backdrop-filter: blur(16px) saturate(1.4);
        -webkit-backdrop-filter: blur(16px) saturate(1.4);
      }

      .sidebar.sheet-open { height: 78vh; }

      .sheet-drag-handle {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 20px;
        flex-shrink: 0;
        cursor: grab;
        touch-action: none;
      }
      .sheet-drag-handle::after {
        content: '';
        display: block;
        width: 34px; height: 3px;
        background: var(--border-hi);
        border-radius: 2px;
        transition: background 0.15s;
      }
      .sidebar.sheet-open .sheet-drag-handle::after { background: var(--accent); opacity: 0.5; }

      .tab-bar {
        height: 44px;
        flex-shrink: 0;
        align-items: center;
        border-bottom-color: transparent;
      }
      .sidebar.sheet-open .tab-bar { border-bottom-color: var(--border); }
      .tab { font-size: 0.72rem; padding: 8px 2px; }

      .sheet-scroll-area {
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
      }

      .map-hint {
        bottom: calc(var(--peek-h) + 10px);
        right: 10px;
        font-size: 0.62rem;
      }
      .map-hint .hint-desktop { display: none; }
      .map-hint .hint-mobile  { display: inline; }

      .room-option { min-height: 48px; }

      #map-container.sheet-open-backdrop::after {
        content: '';
        position: absolute;
        inset: 0;
        z-index: 50;
        background: transparent;
      }
    }

    @media (max-width: 360px) {
      .tab { font-size: 0.58rem; }
      header h1 { font-size: 0.78rem; }
    }


    /* トップへ戻るボタン（モバイルのみ） */
    #scroll-top-btn {
      display: none;
      position: absolute;
      right: 14px;
      bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      z-index: 200;
      width: 42px; height: 42px;
      border-radius: 50%;
      background: rgba(0, 192, 238, 0.18);
      border: 1px solid rgba(0, 192, 238, 0.45);
      color: var(--accent);
      font-size: 1.1rem;
      font-weight: 700;
      cursor: pointer;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 2px 12px rgba(0, 192, 238, 0.2);
      transition: opacity 0.25s var(--ease-out), transform 0.25s var(--ease-out),
                  background 0.15s, box-shadow 0.15s;
      opacity: 0;
      pointer-events: none;
      transform: translateY(10px);
      align-items: center;
      justify-content: center;
      -webkit-tap-highlight-color: transparent;
    }
    #scroll-top-btn.visible {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }
    #scroll-top-btn:active {
      transform: scale(0.9);
      background: rgba(0, 192, 238, 0.32);
    }
    @media (max-width: 767px) {
      #scroll-top-btn { display: flex; }
    }

    /* マップ右上のツールボタン群 */
    #map-tools {
      position: absolute;
      top: 10px; right: 10px;
      z-index: 5;
      display: flex; flex-direction: column; gap: 6px;
      align-items: flex-end;
    }
    .map-tool {
      background: rgba(12, 27, 45, 0.88);
      border: 1px solid var(--border-hi);
      color: var(--text-sub);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      font-weight: 500;
      cursor: pointer;
      letter-spacing: 0.04em;
      backdrop-filter: blur(8px);
      transition: border-color 0.15s, color 0.15s;
    }
    .map-tool:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    #zoom-btns { display: flex; gap: 6px; }
    #zoom-btns .map-tool {
      width: 34px; padding: 7px 0;
      font-size: 0.85rem; line-height: 1;
      text-align: center;
    }
    #zoom-route-btn { display: none; }
    #zoom-route-btn.available { display: block; }
    #zoom-route-btn.zoomed {
      color: var(--gold);
      border-color: rgba(242, 196, 55, 0.5);
      background: var(--gold-dim);
    }

    /* ノードピッカー（3Dクリックで出発→目的を選択） */
    #pick-panel {
      position: absolute; top: 10px; left: 10px; z-index: 5;
      max-width: min(300px, calc(100% - 130px));
      background: rgba(12, 27, 45, 0.88);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 10px;
      backdrop-filter: blur(8px);
      font-size: 0.68rem;
      color: var(--text-muted);
      display: flex; flex-direction: column; gap: 6px;
    }
    .pick-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .pick-chip {
      font-family: var(--font-mono);
      font-size: 0.66rem;
      padding: 2px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-hi);
      color: var(--text);
      background: var(--surface-hi);
    }
    .pick-chip.start { border-color: rgba(0, 212, 152, 0.5); color: var(--green); }
    .pick-chip.goal  { border-color: rgba(242, 196, 55, 0.5); color: var(--gold); }
    .pick-chip.empty { color: var(--text-muted); border-style: dashed; background: transparent; }
    #pick-clear {
      margin-left: auto;
      background: none; border: none; cursor: pointer;
      color: var(--text-muted); font-size: 0.78rem; padding: 0 2px;
      line-height: 1;
    }
    #pick-clear:hover { color: var(--red); }

    /* 経路サマリー（フロア遷移リボン） */
    .journey { margin-top: 10px; }
    .journey-strip {
      display: flex; width: 100%; height: 22px;
      border-radius: 6px; overflow: hidden;
      border: 1px solid var(--border);
    }
    .journey-seg {
      min-width: 24px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.58rem; font-family: var(--font-mono);
      color: #07111d; font-weight: 700;
      white-space: nowrap; overflow: hidden;
    }
    .journey-meta {
      display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px;
    }
    .meta-chip {
      font-size: 0.62rem; font-family: var(--font-mono);
      padding: 2px 8px; border-radius: 10px;
      border: 1px solid var(--border-hi); color: var(--text-sub);
      background: var(--surface-hi);
    }
    .journey-error { margin-top: 8px; font-size: 0.66rem; color: var(--red); }

    /* 検索中インジケータ */
    #busy {
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      z-index: 6; display: none;
      background: rgba(12, 27, 45, 0.92);
      border: 1px solid var(--border-hi);
      color: var(--text-sub); border-radius: 20px; padding: 5px 14px;
      font-size: 0.7rem; font-family: var(--font-mono);
      backdrop-filter: blur(8px);
    }
    #busy.show { display: block; }

    /* 起動失敗画面 */
    #boot-error {
      position: absolute; inset: 0; z-index: 20;
      display: none; flex-direction: column;
      align-items: center; justify-content: center; gap: 10px;
      background: var(--bg); color: var(--text-sub);
      text-align: center; padding: 24px;
    }
    #boot-error.show { display: flex; }
    #boot-error .be-title { font-size: 0.95rem; font-weight: 700; color: var(--text); }
    #boot-error .be-desc  { font-size: 0.78rem; line-height: 1.8; }
    #boot-error button {
      margin-top: 6px; padding: 9px 22px;
      border: 1px solid var(--border-hi);
      background: var(--accent-dim); color: var(--accent);
      border-radius: 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer;
    }
    #boot-error button:hover { border-color: var(--accent); }
  </style>
</head>
<body>

<header>
  <div class="header-icon" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2.2 11.8 C2.2 7.5, 6 8.2, 7 5.2 S 11.8 3.5, 11.8 2.2"
            stroke="#00c0ee" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="2.2" cy="11.8" r="1.7" fill="#00d498"/>
      <circle cx="11.8" cy="2.2" r="1.7" fill="#f2c437"/>
    </svg>
  </div>
  <div class="header-title-wrap">
    <h1>大学 AR マップ</h1>
    <div class="sub">3D ROUTE VIEWER · DIJKSTRA</div>
  </div>
</header>

<div class="main-layout">

  <!-- ========== SIDEBAR / BOTTOM SHEET ========== -->
  <aside class="sidebar" id="sidebar">

    <div class="sheet-drag-handle" id="sheet-handle"></div>

    <div class="tab-bar">
      <div class="tab active" data-tab="room" onclick="switchTab('room')">教室</div>
      <div class="tab" data-tab="node" onclick="switchTab('node')">ノード</div>
      <div class="tab" data-tab="toilet" onclick="switchTab('toilet')">トイレ</div>
      <div class="tab" data-tab="info" onclick="switchTab('info')">情報</div>
    </div>

    <div class="sheet-scroll-area">

      <!-- ===== TAB: 教室検索 ===== -->
      <div id="tab-room" class="tab-panel active">
        <div class="panel">
          <h2>教室で経路を探す</h2>

          <label>出発教室の建物</label>
          <select id="start-building" onchange="acStart.onBuildingChange()">
            <option value="0">すべての建物</option>
            {% for b in buildings %}
            <option value="{{ b }}">Building {{ b }}</option>
            {% endfor %}
          </select>

          <label>出発教室名</label>
          <div class="autocomplete-wrap">
            <input type="text" id="start-room-input" placeholder="例: 101A" autocomplete="off" autocorrect="off" />
            <div class="ac-dropdown" id="start-room-dropdown"></div>
          </div>
          <div class="room-badge" id="start-room-badge"></div>

          <label>目的教室の建物</label>
          <select id="goal-building" onchange="acGoal.onBuildingChange()">
            <option value="0">すべての建物</option>
            {% for b in buildings %}
            <option value="{{ b }}">Building {{ b }}</option>
            {% endfor %}
          </select>

          <label>目的教室名</label>
          <div class="autocomplete-wrap">
            <input type="text" id="goal-room-input" placeholder="例: 10215" autocomplete="off" autocorrect="off" />
            <div class="ac-dropdown" id="goal-room-dropdown"></div>
          </div>
          <div class="room-badge" id="goal-room-badge"></div>

          <label class="checkbox-row">
            <input type="checkbox" id="chk-elevator-room" checked>
            エレベーターを使用する
          </label>

          <button class="btn btn-primary"   onclick="navigateToRoom()">経路を表示</button>
          <button class="btn btn-secondary" onclick="clearPath()">クリア</button>

          <div id="room-result-box"></div>
        </div>
      </div>

      <!-- ===== TAB: ノード指定 ===== -->
      <div id="tab-node" class="tab-panel">
        <div class="panel">
          <h2>ノード間の最短経路</h2>

          <label for="sel-start">出発ノード</label>
          <select id="sel-start">
            {% for nid in node_ids %}
            <option value="{{ nid }}">Node {{ nid }}</option>
            {% endfor %}
          </select>

          <label for="sel-goal">目的地ノード</label>
          <select id="sel-goal">
            {% for nid in node_ids %}
            <option value="{{ nid }}" {% if loop.last %}selected{% endif %}>Node {{ nid }}</option>
            {% endfor %}
          </select>

          <label class="checkbox-row">
            <input type="checkbox" id="chk-elevator-node" checked>
            エレベーターを使用する
          </label>

          <button class="btn btn-primary"   onclick="findPathByNode()">経路を表示</button>
          <button class="btn btn-secondary" onclick="clearPath()">クリア</button>

          <div id="result-box"></div>
        </div>

        <div class="panel">
          <h2>表示フィルタ</h2>
          <label for="filter-building">建物で絞り込み</label>
          <select id="filter-building" onchange="applyFilter()">
            <option value="0">すべての建物</option>
            {% for b in buildings %}
            <option value="{{ b }}">Building {{ b }}</option>
            {% endfor %}
          </select>
          <label for="filter-floor">階で絞り込み</label>
          <select id="filter-floor" onchange="applyFilter()">
            <option value="0">すべての階</option>
          </select>
        </div>
      </div>

      <!-- ===== TAB: トイレ ===== -->
      <div id="tab-toilet" class="tab-panel">
        <div class="panel">
          <h2>最寄りのトイレを探す</h2>

          <label>トイレの種類</label>
          <select id="toilet-type">
            <option value="all">指定なし（最寄り）</option>
            <option value="M">男子トイレ</option>
            <option value="F">女子トイレ</option>
            <option value="C">多目的トイレ</option>
          </select>

          <label>現在地の建物</label>
          <select id="toilet-start-building" onchange="acToiletStart.onBuildingChange()">
            <option value="0">すべての建物</option>
            {% for b in buildings %}
            <option value="{{ b }}">Building {{ b }}</option>
            {% endfor %}
          </select>

          <label>現在地の教室名</label>
          <div class="autocomplete-wrap">
            <input type="text" id="toilet-start-input" placeholder="例: 101A" autocomplete="off" autocorrect="off" />
            <div class="ac-dropdown" id="toilet-start-dropdown"></div>
          </div>
          <div class="room-badge" id="toilet-start-badge"></div>

          <label class="checkbox-row">
            <input type="checkbox" id="chk-elevator-toilet" checked>
            エレベーターを使用する
          </label>

          <button class="btn btn-primary"   onclick="findNearestToilet()">検索</button>
          <button class="btn btn-secondary" onclick="clearPath()">クリア</button>

          <div id="toilet-result-box"></div>
        </div>
      </div>

      <!-- ===== TAB: 情報 ===== -->
      <div id="tab-info" class="tab-panel">
        <div class="panel">
          <h2>建物の凡例</h2>
          <div id="legend-items"></div>
        </div>
        <div class="panel">
          <h2>エッジの種類</h2>
          <div class="legend-item"><div class="legend-dot" style="background:#FFB347;color:#FFB347"></div><span>階段</span></div>
          <div class="legend-item"><div class="legend-dot" style="background:#00CED1;color:#00CED1"></div><span>エスカレーター</span></div>
          <div class="legend-item"><div class="legend-dot" style="background:#DA70D6;color:#DA70D6"></div><span>EV（エレベーター）</span></div>
        </div>
        <div class="panel">
          <h2>グラフ統計</h2>
          <div class="stat-row"><span>ノード数</span><span id="stat-nodes">—</span></div>
          <div class="stat-row"><span>エッジ数</span><span id="stat-edges">—</span></div>
          <div class="stat-row"><span>建物数</span> <span id="stat-buildings">—</span></div>
          <div class="stat-row"><span>教室数</span> <span id="stat-rooms">—</span></div>
        </div>
      </div>


    </div><!-- /.sheet-scroll-area -->

    <button id="scroll-top-btn" aria-label="トップに戻る">↑</button>
  </aside>

  <!-- ========== 3D MAP ========== -->
  <div id="map-container">
    <div id="map"></div>

    <!-- 3Dクリックでの経路作成パネル -->
    <div id="pick-panel">
      <div class="pick-row">
        <span>ノードをクリックして経路を作成</span>
        <button id="pick-clear" onclick="clearPick()" title="選択を解除" aria-label="選択を解除">✕</button>
      </div>
      <div class="pick-row">
        <span class="pick-chip empty" id="pick-start-chip">出発: 未選択</span>
        <span class="pick-chip empty" id="pick-goal-chip">目的: 未選択</span>
      </div>
      <div id="pick-journey"></div>
    </div>

    <div id="busy">検索中…</div>

    <div id="map-tools">
      <button class="map-tool" onclick="setTopView()">俯瞰 ↑</button>
      <button class="map-tool" id="zoom-route-btn" onclick="toggleRouteZoom()">ルートを拡大</button>
      <div id="zoom-btns">
        <button class="map-tool" onclick="zoomCamera(0.72)" aria-label="拡大">＋</button>
        <button class="map-tool" onclick="zoomCamera(1.4)"  aria-label="縮小">−</button>
      </div>
    </div>

    <div id="boot-error">
      <div class="be-title">グラフデータを読み込めませんでした</div>
      <div class="be-desc">Flask が起動しているか、/api/graph が応答するか確認してください。</div>
      <button onclick="location.reload()">再読み込み</button>
    </div>

    <div class="map-hint">
      <span class="hint-desktop">ノードをクリック: 経路作成 ／ 左ドラッグ: 回転 ／ スクロール: ズーム</span>
      <span class="hint-mobile">ノードをタップ: 経路作成 ／ 1本指: 回転 ／ ピンチ: ズーム</span>
    </div>
  </div>

</div><!-- /.main-layout -->

<script>
// ============================================================
//  Globals
// ============================================================
const Z_SCALE   = 3.0;  // 高さ方向の倍率（建物を厚く見せる）
let graphData   = null;
let currentPath = null;
let startEdge   = null;
let destEdge    = null;
let filterBuilding = 0;
let filterFloor    = 0;
let acStart       = null;
let acGoal        = null;
let acToiletStart = null;

let edgeByPair  = null;  // "from-to" → エッジ（種別の逆引き用）
let pickStart   = null;  // 3Dクリックで選択中の出発ノードID
let pickGoal    = null;  // 3Dクリックで選択中の目的ノードID
let routeZoomed = false; // 「ルートを拡大」中か

// フロアカラーパレット (1F〜8F)
const FLOOR_COLORS = [
  "#FF8C42", "#06D6A0", "#118AB2", "#FFD166",
  "#EF476F", "#9B5DE5", "#00BBF9", "#F15BB5",
];
function floorColor(f) {
  return FLOOR_COLORS[(Math.max(f, 1) - 1) % FLOOR_COLORS.length];
}

// ============================================================
//  Boot
// ============================================================
(async () => {
  try {
    const res = await fetch("/api/graph");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    graphData = await res.json();
  } catch {
    document.getElementById("boot-error").classList.add("show");
    return;
  }
  graphData.nodes.forEach(n => { n.z *= Z_SCALE; });
  graphData.edges.forEach(e => { e.z0 *= Z_SCALE; e.z1 *= Z_SCALE; });

  // エッジ種別の逆引き索引（経路サマリーで使用）
  edgeByPair = new Map();
  graphData.edges.forEach(e => {
    edgeByPair.set(`${e.from}-${e.to}`, e);
    edgeByPair.set(`${e.to}-${e.from}`, e);
  });

  buildLegend();
  updateStats();
  buildFloorFilter();
  renderMap();
  initNodePicker();
  initMapResize();
  initPinchZoom();
  prefetchRooms();

  acStart = new RoomAutocomplete({
    inputId: "start-room-input", dropdownId: "start-room-dropdown",
    badgeId: "start-room-badge", buildingId: "start-building",
  });
  acGoal = new RoomAutocomplete({
    inputId: "goal-room-input", dropdownId: "goal-room-dropdown",
    badgeId: "goal-room-badge", buildingId: "goal-building",
  });
  acToiletStart = new RoomAutocomplete({
    inputId: "toilet-start-input", dropdownId: "toilet-start-dropdown",
    badgeId: "toilet-start-badge", buildingId: "toilet-start-building",
  });

  initSheet();
  initScrollTopBtn();
})();

async function prefetchRooms() {
  try {
    const res = await fetch("/api/rooms");
    const all = await res.json();
    document.getElementById("stat-rooms").textContent = new Set(all.map(r => r.room)).size;
  } catch { /* 統計表示のみなので失敗しても続行 */ }
}

// ============================================================
//  Sheet (mobile bottom sheet)
// ============================================================
function isMobile() { return window.innerWidth <= 767; }

function openSheet() {
  if (!isMobile()) return;
  document.getElementById("sidebar").classList.add("sheet-open");
  document.getElementById("map-container").classList.add("sheet-open-backdrop");
}
function closeSheet() {
  document.getElementById("sidebar").classList.remove("sheet-open");
  document.getElementById("map-container").classList.remove("sheet-open-backdrop");
}
function toggleSheet(open) {
  if (open) openSheet(); else closeSheet();
}

function initSheet() {
  const handle = document.getElementById("sheet-handle");
  const sidebar = document.getElementById("sidebar");
  const mapEl   = document.getElementById("map-container");

  mapEl.addEventListener("pointerdown", (e) => {
    if (isMobile() && mapEl.classList.contains("sheet-open-backdrop")) {
      closeSheet();
    }
  });

  let dragStartY = 0;
  let sheetOpenAtStart = false;

  handle.addEventListener("touchstart", (e) => {
    dragStartY = e.touches[0].clientY;
    sheetOpenAtStart = sidebar.classList.contains("sheet-open");
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener("touchmove", (e) => {
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - dragStartY;
    if (dy < -20) openSheet();
    else if (dy > 20) closeSheet();
    else toggleSheet(!sheetOpenAtStart);
  });

  handle.addEventListener("click", () => {
    if (isMobile()) toggleSheet(!sidebar.classList.contains("sheet-open"));
  });
}

// ============================================================
//  Tab switching
// ============================================================
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");

  if (isMobile()) openSheet();
}

// ============================================================
//  Legend & Stats
// ============================================================
function buildLegend() {
  const container = document.getElementById("legend-items");
  container.innerHTML = "";
  const floors = [...new Set(graphData.nodes.filter(n=>n.building!==0).map(n=>n.floor))].sort((a,b)=>a-b);
  floors.forEach(f => {
    const div = document.createElement("div");
    div.className = "legend-item";
    const color = floorColor(f);
    div.innerHTML = `<div class="legend-dot" style="background:${color};color:${color}"></div><span>${f}F</span>`;
    container.appendChild(div);
  });
}
function updateStats() {
  const buildings = new Set(graphData.nodes.map(n => n.building));
  document.getElementById("stat-nodes").textContent     = graphData.nodes.length;
  document.getElementById("stat-edges").textContent     = graphData.edges.length;
  document.getElementById("stat-buildings").textContent = buildings.size;
}

// ============================================================
//  RoomAutocomplete
// ============================================================
class RoomAutocomplete {
  constructor({ inputId, dropdownId, badgeId, buildingId }) {
    this.input       = document.getElementById(inputId);
    this.dropdown    = document.getElementById(dropdownId);
    this.badge       = document.getElementById(badgeId);
    this.buildingSel = document.getElementById(buildingId);
    this.roomList    = [];
    this.acIndex     = -1;
    this.selected    = null;

    this.input.addEventListener("input",   () => this._onInput());
    this.input.addEventListener("blur",    () => setTimeout(() => this._hide(), 200));
    this.input.addEventListener("keydown", (e) => this._onKeydown(e));

    this.input.addEventListener("focus", () => {
      if (isMobile()) {
        openSheet();
        setTimeout(() => this.input.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
      }
    });
  }

  onBuildingChange() {
    this.selected = null;
    this.input.value = "";
    this.badge.style.display = "none";
    this._hide();
  }

  async _onInput() {
    const q        = this.input.value.trim();
    const building = parseInt(this.buildingSel.value) || 0;
    this.selected  = null;
    this.badge.style.display = "none";
    if (!q) { this._hide(); return; }
    const url = `/api/rooms?q=${encodeURIComponent(q)}` + (building ? `&building=${building}` : "");
    const res = await fetch(url);
    this.roomList = await res.json();
    this.acIndex  = -1;
    this._render();
  }

  _render() {
    this.dropdown.innerHTML = "";
    if (!this.roomList.length) { this._hide(); return; }
    this.roomList.forEach((r, i) => {
      const div = document.createElement("div");
      div.className = "room-option";
      div.innerHTML = `<span>${r.room}</span><span class="room-meta">B${r.building}·${r.floor}F</span>`;
      div.addEventListener("pointerdown", (e) => { e.preventDefault(); this._select(i); });
      this.dropdown.appendChild(div);
    });
    this.dropdown.style.display = "block";
  }

  _select(i) {
    if (i < 0 || i >= this.roomList.length) return;
    this.selected    = this.roomList[i];
    this.input.value = this.selected.room;
    this.badge.textContent = `✓ ${this.selected.room}（Building ${this.selected.building} / ${this.selected.floor}F）`;
    this.badge.style.display = "block";
    this._hide();
    this.input.blur();
  }

  _hide() { this.dropdown.style.display = "none"; }

  _onKeydown(e) {
    const items = this.dropdown.querySelectorAll(".room-option");
    if      (e.key === "ArrowDown") this.acIndex = Math.min(this.acIndex + 1, items.length - 1);
    else if (e.key === "ArrowUp")   this.acIndex = Math.max(this.acIndex - 1, 0);
    else if (e.key === "Enter") {
      if (this.acIndex >= 0) { this._select(this.acIndex); e.preventDefault(); }
      return;
    } else { return; }
    items.forEach((el, i) => el.classList.toggle("ac-active", i === this.acIndex));
    e.preventDefault();
  }

  reset() {
    this.selected = null;
    this.input.value = "";
    this.badge.style.display = "none";
    this._hide();
  }
}

// ============================================================
//  APIから返った経路データのz値にZ_SCALEを適用
// ============================================================
function scalePathZ(data) {
  if (!data || data.error) return data;
  (data.path_coords || []).forEach(n => { n.z *= Z_SCALE; });
  (data.path_edges  || []).forEach(e => { e.z0 *= Z_SCALE; e.z1 *= Z_SCALE; });
  ['start_edge','destination_edge','from_edge','toilet_edge'].forEach(k => {
    if (data[k]) { data[k].z0 *= Z_SCALE; data[k].z1 *= Z_SCALE; }
  });
  return data;
}

// ============================================================
//  Navigate: 教室 → 教室
// ============================================================
async function navigateToRoom() {
  const box = document.getElementById("room-result-box");
  box.style.display = "none";

  if (!acStart.selected) {
    showResult(box, "error", "出発教室を選択してください"); return;
  }
  if (!acGoal.selected) {
    showResult(box, "error", "目的教室を選択してください"); return;
  }

  const { room: sRoom, building: sBuilding } = acStart.selected;
  const { room: gRoom, building: gBuilding } = acGoal.selected;
  const useElevatorRoom = document.getElementById("chk-elevator-room").checked ? "1" : "0";

  const url = `/api/navigate_to_room` +
    `?room=${encodeURIComponent(gRoom)}&building=${gBuilding}` +
    `&start_room=${encodeURIComponent(sRoom)}&start_building=${sBuilding}` +
    `&use_elevator=${useElevatorRoom}`;

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(url).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge   = data.start_edge       || null;
    destEdge    = data.destination_edge || null;
    showResult(box, "success",
      `<b>出発:</b> ${sRoom}（Building ${sBuilding}）<br>` +
      `<b>目的地:</b> ${gRoom}（Building ${gBuilding}）` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

// ============================================================
//  Navigate: ノード → ノード
// ============================================================
async function findPathByNode() {
  const start = parseInt(document.getElementById("sel-start").value);
  const goal  = parseInt(document.getElementById("sel-goal").value);
  const box   = document.getElementById("result-box");
  box.style.display = "none";

  const useElevatorNode = document.getElementById("chk-elevator-node").checked ? "1" : "0";

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(`/api/shortest_path?start=${start}&goal=${goal}&use_elevator=${useElevatorNode}`).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge = null; destEdge = null;
    showResult(box, "success",
      `<b>出発:</b> Node ${start}　<b>目的:</b> Node ${goal}` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

// ============================================================
//  最寄りトイレ検索
// ============================================================
async function findNearestToilet() {
  const box = document.getElementById("toilet-result-box");
  box.style.display = "none";

  if (!acToiletStart.selected) {
    showResult(box, "error", "現在地の教室を選択してください"); return;
  }

  const { room, building } = acToiletStart.selected;
  const type        = document.getElementById("toilet-type").value;
  const useElevator = document.getElementById("chk-elevator-toilet").checked ? "1" : "0";

  const url = `/api/nearest_toilet` +
    `?from_room=${encodeURIComponent(room)}&from_building=${building}` +
    `&type=${type}&use_elevator=${useElevator}`;

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(url).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge   = data.from_edge    || null;
    destEdge    = data.toilet_edge  || null;
    showResult(box, "success",
      `<b>出発:</b> ${room}（Building ${building}）<br>` +
      `<b>最寄り:</b> ${data.toilet_label}（Building ${data.toilet_building} / ${data.toilet_floor}F）` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

function clearPath() {
  currentPath = null; startEdge = null; destEdge = null;
  pickStart = null; pickGoal = null;
  updatePickPanel();
  if (routeZoomed) resetRouteZoom();
  acStart?.reset(); acGoal?.reset(); acToiletStart?.reset();
  document.getElementById("room-result-box").style.display   = "none";
  document.getElementById("result-box").style.display        = "none";
  document.getElementById("toilet-result-box").style.display = "none";
  renderMap();
}

function setBusy(on) {
  document.getElementById("busy").classList.toggle("show", on);
}

function showResult(el, type, html) {
  el.className = type;
  el.innerHTML = html;
  el.style.display = "block";
}

// ============================================================
//  Filter
// ============================================================
function applyFilter() {
  filterBuilding = parseInt(document.getElementById("filter-building").value);
  filterFloor    = parseInt(document.getElementById("filter-floor").value);
  renderMap();
}

function buildFloorFilter() {
  const sel = document.getElementById("filter-floor");
  const floors = [...new Set(
    graphData.nodes.filter(n => n.building !== 0).map(n => n.floor)
  )].sort((a, b) => a - b);
  floors.forEach(f => {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = `${f}F`;
    sel.appendChild(o);
  });
}

// ============================================================
//  座標変換・バウンディングボックス計算
// ============================================================
function getLocalCoords(x, y, cfg) {
  const theta = (cfg?.rot_deg || 0) * Math.PI / 180;
  const tx = cfg?.tx || 0;
  const ty = cfg?.ty || 0;
  const dx = x - tx;
  const dy = y - ty;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const lx = cos * dx + sin * dy;
  const ly = -sin * dx + cos * dy;
  return { lx, ly };
}

function getGlobalCoords(lx, ly, cfg) {
  const theta = (cfg?.rot_deg || 0) * Math.PI / 180;
  const tx = cfg?.tx || 0;
  const ty = cfg?.ty || 0;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const x = cos * lx - sin * ly + tx;
  const y = sin * lx + cos * ly + ty;
  return { x, y };
}

function computeBuildingBounds(nodes) {
  const byBuilding = {};
  nodes.forEach(n => {
    (byBuilding[n.building] = byBuilding[n.building] || []).push(n);
  });

  const bounds = {};
  Object.entries(byBuilding).forEach(([b, bNodes]) => {
    const cfg = graphData.config?.[b] || {};

    const localNodes = bNodes.map(n => {
      const { lx, ly } = getLocalCoords(n.x, n.y, cfg);
      return { ...n, lx, ly };
    });

    const lxs = localNodes.map(n => n.lx);
    const lys = localNodes.map(n => n.ly);
    const zs  = localNodes.map(n => n.z);

    const rangeXY = Math.max(Math.max(...lxs) - Math.min(...lxs), Math.max(...lys) - Math.min(...lys));
    const padXY = Math.max(rangeXY * 0.04, 1);

    let minLx = Math.min(...lxs);
    let maxLx = Math.max(...lxs);
    let minLy = Math.min(...lys);
    let maxLy = Math.max(...lys);

    const doorways = localNodes.filter(n => String(n.type) === "2");

    let lx0 = minLx - padXY;
    let lx1 = maxLx + padXY;
    let ly0 = minLy - padXY;
    let ly1 = maxLy + padXY;

    if (doorways.length > 0) {
      const doorMinLx = Math.min(...doorways.map(n => n.lx));
      const doorMaxLx = Math.max(...doorways.map(n => n.lx));
      const doorMinLy = Math.min(...doorways.map(n => n.ly));
      const doorMaxLy = Math.max(...doorways.map(n => n.ly));

      const EPS = 0.001;
      if (doorMinLx <= minLx + EPS) lx0 = doorMinLx;
      if (doorMaxLx >= maxLx - EPS) lx1 = doorMaxLx;
      if (doorMinLy <= minLy + EPS) ly0 = doorMinLy;
      if (doorMaxLy >= maxLy - EPS) ly1 = doorMaxLy;
    }

    const c0 = getGlobalCoords(lx0, ly0, cfg);
    const c1 = getGlobalCoords(lx1, ly0, cfg);
    const c2 = getGlobalCoords(lx1, ly1, cfg);
    const c3 = getGlobalCoords(lx0, ly1, cfg);
    const center = getGlobalCoords((lx0+lx1)/2, (ly0+ly1)/2, cfg);

    bounds[b] = { c0, c1, c2, c3, center, zs };
  });

  return bounds;
}

// ============================================================
//  案1: 建物バウンディングボックス
// ============================================================
function buildBuildingBoxTraces(nodes, bounds) {
  const traces = [];
  const byBuilding = {};
  nodes.forEach(n => { (byBuilding[n.building] = byBuilding[n.building] || []).push(n); });

  Object.entries(byBuilding).forEach(([b, bNodes]) => {
    const color = graphData.building_colors[(parseInt(b) - 1) % graphData.building_colors.length];
    const bData = bounds[b];
    if (!bData) return;
    const { c0, c1, c2, c3, center, zs } = bData;

    const z0 = Math.min(...zs) - 0.5, z1 = Math.max(...zs) + 0.5;

    // 塗りつぶし面(mesh3d)は使わずワイヤーフレームのみ描画する。塗りつぶしメッシュは
    // Plotlyの3Dピッキングで背後のノードマーカーより手前と判定されクリックを奪ってしまい
    // (hoverinfoの設定では回避できない)、建物に囲まれたノードが選択できなくなるため。
    const ex = [c0.x, c1.x, null, c1.x, c2.x, null, c2.x, c3.x, null, c3.x, c0.x, null,
                c0.x, c1.x, null, c1.x, c2.x, null, c2.x, c3.x, null, c3.x, c0.x, null,
                c0.x, c0.x, null, c1.x, c1.x, null, c2.x, c2.x, null, c3.x, c3.x, null];
    const ey = [c0.y, c1.y, null, c1.y, c2.y, null, c2.y, c3.y, null, c3.y, c0.y, null,
                c0.y, c1.y, null, c1.y, c2.y, null, c2.y, c3.y, null, c3.y, c0.y, null,
                c0.y, c0.y, null, c1.y, c1.y, null, c2.y, c2.y, null, c3.y, c3.y, null];
    const ez = [z0,z0,null, z0,z0,null, z0,z0,null, z0,z0,null,
                z1,z1,null, z1,z1,null, z1,z1,null, z1,z1,null,
                z0,z1,null, z0,z1,null, z0,z1,null, z0,z1,null];
    traces.push({
      type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:1.5}, hoverinfo:"skip", showlegend:false,
    });

    traces.push({
      type:"scatter3d", mode:"text",
      x:[center.x], y:[center.y], z:[z1+0.4],
      text:[`B${b}`],
      textfont:{color, size:14, family:"Arial Black"},
      hoverinfo:"skip", showlegend:false,
    });
  });
  return traces;
}

// ============================================================
//  案2: フロア床面
// ============================================================
function buildFloorPlaneTraces(nodes, bounds) {
  const byKey = {};
  nodes.forEach(n => {
    const k = `${n.building}_${n.floor}`;
    if (!byKey[k]) byKey[k] = { building:n.building, floor:n.floor, ns:[] };
    byKey[k].ns.push(n);
  });

  const traces = [];
  Object.values(byKey).forEach(({ building, floor, ns }) => {
    const color = floorColor(floor);
    const zVal = ns.reduce((s, n) => s + n.z, 0) / ns.length;

    const bData = bounds[building];
    if (!bData) return;
    const { c0, c1, c2, c3 } = bData;

    // 塗りつぶし面(mesh3d)は使わずワイヤーフレームのみ描画する。塗りつぶしメッシュは
    // 各フロアのノードとちょうど同じ高さに広がるため、Plotlyの3Dピッキングで
    // ノードマーカーより手前と判定されクリックを奪ってしまうことがあるため。
    traces.push({
      type:"scatter3d", mode:"lines",
      x:[c0.x, c1.x, c2.x, c3.x, c0.x], y:[c0.y, c1.y, c2.y, c3.y, c0.y],
      z:[zVal,zVal,zVal,zVal,zVal],
      line:{color, width:1, dash:"dot"},
      opacity:0.5,
      hoverinfo:"skip", showlegend:false,
    });

    traces.push({
      type:"scatter3d", mode:"text",
      x:[c1.x], y:[c0.y], z:[zVal],
      text:[`${floor}F`],
      textfont:{color, size:9},
      hoverinfo:"skip", showlegend:false,
    });
  });
  return traces;
}

// ============================================================
//  Render 3D map
// ============================================================
function buildPathEdgeSet() {
  const s = new Set();
  if (!currentPath) return s;
  currentPath.path_edges.forEach(e => { s.add(`${e.from}-${e.to}`); s.add(`${e.to}-${e.from}`); });
  return s;
}
function sameEdge(a, b) {
  return a && b && ((a.from===b.from && a.to===b.to)||(a.from===b.to && a.to===b.from));
}

function renderMap() {
  const indoorNodes = graphData.nodes.filter(n =>
    n.building !== 0 &&
    (!filterBuilding || n.building === filterBuilding) &&
    (!filterFloor    || n.floor    === filterFloor));
  const nodes   = indoorNodes;
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges   = (filterBuilding || filterFloor)
    ? graphData.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)) : graphData.edges;

  const dimmed = !!currentPath;  // ルート表示中は背景要素を淡くしてパスを際立たせる

  const traces = [];
  const bounds = computeBuildingBounds(nodes);
  traces.push(...buildFloorPlaneTraces(nodes, bounds));
  traces.push(...buildBuildingBoxTraces(nodes, bounds));

  // --- 屋外ノード・エッジ (building=0) ---
  const outdoorNodes   = graphData.nodes.filter(n => n.building === 0);
  const outdoorNodeIds = new Set(outdoorNodes.map(n => n.id));
  const outdoorEdges   = graphData.edges.filter(e =>
    outdoorNodeIds.has(e.from) || outdoorNodeIds.has(e.to));
  const outdoorEdgeIds = new Set(outdoorEdges.map(e => e.id));

  if (!filterBuilding && !filterFloor) {
    if (outdoorEdges.length) {
      const ox=[],oy=[],oz=[];
      outdoorEdges.forEach(e=>{ox.push(e.x0,e.x1,null);oy.push(e.y0,e.y1,null);oz.push(e.z0,e.z1,null);});
      traces.push({ type:"scatter3d", mode:"lines", x:ox, y:oy, z:oz,
        line:{color:"#5AFF5A", width:3, dash:"dot"}, hoverinfo:"skip",
        opacity: dimmed ? 0.25 : 1,
        name:"屋外通路", showlegend:true });
    }
    if (outdoorNodes.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:outdoorNodes.map(n=>n.x), y:outdoorNodes.map(n=>n.y), z:outdoorNodes.map(n=>n.z),
        customdata:outdoorNodes.map(n=>n.id),
        marker:{size:7, color:"#5AFF5A", opacity: dimmed ? 0.3 : 0.9, symbol:"square",
                line:{color:"#fff", width:1}},
        text:outdoorNodes.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:"屋外ノード", showlegend:true });
    }
  }
  const pathEdgeSet = buildPathEdgeSet();
  const pathNodeSet = new Set(currentPath ? currentPath.path : []);

  // 屋外エッジは上で専用トレースとして描画済みなので除外（二重描画防止）
  const normalEdges = edges.filter(e =>
    !outdoorEdgeIds.has(e.id) &&
    !pathEdgeSet.has(`${e.from}-${e.to}`) && !pathEdgeSet.has(`${e.to}-${e.from}`) &&
    !sameEdge(e, destEdge) && !sameEdge(e, startEdge));

  const edgesByFloor = {};
  normalEdges.filter(e => String(e.type) === "1").forEach(e => {
    (edgesByFloor[e.floor] = edgesByFloor[e.floor] || []).push(e);
  });
  Object.entries(edgesByFloor).forEach(([f, fEdges]) => {
    const color = floorColor(parseInt(f));
    const ex=[],ey=[],ez=[];
    fEdges.forEach(e=>{ex.push(e.x0,e.x1,null);ey.push(e.y0,e.y1,null);ez.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:3}, opacity: dimmed ? 0.22 : 1,
      hoverinfo:"skip", name:`${f}F 通路`, showlegend:false });
  });

  [["2","#FFB347","階段"], ["3","#00CED1","エスカレーター"], ["4","#DA70D6","EV"], ["5","#00FF88","上りESC"], ["6","#FF4500","下りESC"]].forEach(([t, color, label]) => {
    const typeEdges = normalEdges.filter(e => String(e.type) === t);
    if (!typeEdges.length) return;
    const ex=[],ey=[],ez=[];
    typeEdges.forEach(e=>{ex.push(e.x0,e.x1,null);ey.push(e.y0,e.y1,null);ez.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:5}, opacity: dimmed ? 0.25 : 1,
      hoverinfo:"skip", name:label, showlegend:false });
  });

  const byFloor = {};
  nodes.forEach(n => { (byFloor[n.floor] = byFloor[n.floor] || []).push(n); });
  Object.entries(byFloor).forEach(([f, fNodes]) => {
    const color   = floorColor(parseInt(f));
    const regular = fNodes.filter(n => !pathNodeSet.has(n.id) && n.type !== 2);
    const entries = fNodes.filter(n => !pathNodeSet.has(n.id) && n.type === 2);
    if (regular.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:regular.map(n=>n.x), y:regular.map(n=>n.y), z:regular.map(n=>n.z),
        customdata:regular.map(n=>n.id),
        marker:{size:5, color, opacity: dimmed ? 0.25 : 0.9, symbol:"circle", line:{color:"rgba(0,0,0,0.3)",width:.5}},
        text:regular.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:`${f}F`, showlegend:true });
    }
    if (entries.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:entries.map(n=>n.x), y:entries.map(n=>n.y), z:entries.map(n=>n.z),
        customdata:entries.map(n=>n.id),
        marker:{size:10, color, opacity: dimmed ? 0.3 : 1, symbol:"diamond", line:{color:"#fff",width:1}},
        text:entries.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:`${f}F 出入口`, showlegend:true });
    }
  });

  if (currentPath?.path_edges.length) {
    const px=[],py=[],pz=[];
    currentPath.path_edges.forEach(e=>{px.push(e.x0,e.x1,null);py.push(e.y0,e.y1,null);pz.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:px, y:py, z:pz,
      line:{color:"#ffd700",width:6}, hoverinfo:"skip", name:"最短経路" });
  }

  if (startEdge) {
    traces.push({ type:"scatter3d", mode:"lines",
      x:[startEdge.x0,startEdge.x1], y:[startEdge.y0,startEdge.y1], z:[startEdge.z0,startEdge.z1],
      line:{color:"#4ade80",width:10},
      hovertemplate:`出発: ${startEdge.name}<extra></extra>`,
      name:`出発: ${acStart?.selected?.room||startEdge.name}` });
  }

  if (destEdge) {
    traces.push({ type:"scatter3d", mode:"lines",
      x:[destEdge.x0,destEdge.x1], y:[destEdge.y0,destEdge.y1], z:[destEdge.z0,destEdge.z1],
      line:{color:"#ff6b2b",width:10},
      hovertemplate:`目的地: ${destEdge.name}<extra></extra>`,
      name:`目的地: ${acGoal?.selected?.room||destEdge.name}` });
  }

  if (currentPath?.path_coords.length) {
    const pn = currentPath.path_coords;
    traces.push({ type:"scatter3d", mode:"markers+text",
      x:pn.map(n=>n.x), y:pn.map(n=>n.y), z:pn.map(n=>n.z),
      marker:{size:10, color:"#ffd700", symbol:"diamond", line:{color:"#fff",width:1}},
      text:pn.map((n,i)=>i===0?"START":i===pn.length-1?"GOAL":String(i)),
      textposition:"top center", textfont:{color:"#ffd700",size:11},
      hovertemplate:"Node %{text}<extra></extra>", name:"経路ノード" });
  }

  // 3Dクリックで選択中のノードを強調表示
  if (pickStart != null || pickGoal != null) {
    const picked = [];
    const ps = graphData.nodes.find(n => n.id === pickStart);
    const pg = graphData.nodes.find(n => n.id === pickGoal);
    if (ps) picked.push({ ...ps, c: "#00d498", t: "出発" });
    if (pg) picked.push({ ...pg, c: "#f2c437", t: "目的" });
    if (picked.length) {
      traces.push({ type:"scatter3d", mode:"markers+text",
        x:picked.map(n=>n.x), y:picked.map(n=>n.y), z:picked.map(n=>n.z),
        marker:{size:12, color:picked.map(n=>n.c), symbol:"circle", line:{color:"#fff", width:2}},
        text:picked.map(n=>n.t), textposition:"top center",
        textfont:{color:"#fff", size:10},
        hoverinfo:"skip", showlegend:false });
    }
  }

  const layout = {
    paper_bgcolor:"#07111d", plot_bgcolor:"#07111d",
    margin:{l:0,r:0,t:0,b:0},
    scene:{
      bgcolor:"#07111d",
      xaxis:axisStyle("X"), yaxis:{...axisStyle("Y"), autorange:"reversed"}, zaxis:axisStyle("階"),
      camera:{eye:{x:1.8,y:1.8,z:1.4}},
      aspectmode:"data",
    },
    legend:{
      x:.01, y:.99,
      bgcolor:"rgba(10,20,34,.85)", bordercolor:"#1e3450", borderwidth:1,
      font:{color:"#d4e8f8",size:11},
    },
    uirevision:"keep",
  };
  Plotly.react("map", traces, layout, { responsive:true });

  // 「ルートを拡大」ボタンの表示状態を同期
  const zoomBtn = document.getElementById("zoom-route-btn");
  zoomBtn.classList.toggle("available", !!(currentPath?.path_coords?.length));
  if (routeZoomed) {
    if (currentPath?.path_coords?.length) applyRouteZoom();
    else resetRouteZoom();
  }
}

function axisStyle(title) {
  return {
    title:{text:title,font:{color:"#3a5878",size:11}},
    gridcolor:"#122030", linecolor:"#1e3450",
    tickcolor:"#3a5878", tickfont:{color:"#3a5878",size:9},
    backgroundcolor:"#07111d", showbackground:true, zerolinecolor:"#1e3450",
  };
}

// #map-container のサイズが変わるたび（初期レイアウト確定・サイドバー開閉・
// ウィンドウリサイズ・フォント読み込み後のリフローなど）にPlotlyの
// WebGLキャンバスを追従させる。初回描画時にコンテナサイズがまだ確定して
// おらず、reloadを繰り返さないと3Dグラフが表示されない問題への対策。
function initMapResize() {
  const mapContainer = document.getElementById("map-container");
  const mapEl = document.getElementById("map");
  const observer = new ResizeObserver(() => {
    Plotly.Plots.resize(mapEl);
  });
  observer.observe(mapContainer);
}

// ============================================================
//  トップへ戻るボタン（モバイル）
// ============================================================
function initScrollTopBtn() {
  const btn        = document.getElementById("scroll-top-btn");
  const scrollArea = document.querySelector(".sheet-scroll-area");

  scrollArea.addEventListener("scroll", () => {
    btn.classList.toggle("visible", scrollArea.scrollTop > 120);
  }, { passive: true });

  btn.addEventListener("click", () => {
    scrollArea.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// ============================================================
//  ノードピッカー — 3D上のノードをクリックして経路を作成
//  1回目のクリック = 出発、2回目 = 目的（そのまま経路探索）
//  3回目は新しい出発として選び直し。Esc または ✕ で解除。
// ============================================================
function initNodePicker() {
  const gd = document.getElementById("map");
  gd.on("plotly_click", ev => {
    const p = ev.points && ev.points[0];
    if (!p || p.customdata == null) return;
    onNodePicked(Number(p.customdata));
  });
  addEventListener("keydown", e => { if (e.key === "Escape") clearPick(); });
}

function onNodePicked(id) {
  if (pickStart == null || pickGoal != null) {
    // 未選択、または経路確定済み → 新しい出発として選び直し
    pickStart = id;
    pickGoal  = null;
    currentPath = null; startEdge = null; destEdge = null;
    document.getElementById("pick-journey").innerHTML = "";
    renderMap();
  } else if (id !== pickStart) {
    pickGoal = id;
    routeFromPick();
  }
  updatePickPanel();
}

async function routeFromPick() {
  const useElevator = document.getElementById("chk-elevator-node").checked ? "1" : "0";
  const journeyEl   = document.getElementById("pick-journey");
  setBusy(true);
  try {
    const data = scalePathZ(await fetch(
      `/api/shortest_path?start=${pickStart}&goal=${pickGoal}&use_elevator=${useElevator}`
    ).then(r => r.json()));
    if (data.error) {
      journeyEl.innerHTML = `<div class="journey-error">${data.error}</div>`;
      currentPath = null; startEdge = null; destEdge = null;
    } else {
      currentPath = data; startEdge = null; destEdge = null;
      journeyEl.innerHTML = buildJourneyHTML(data);
    }
  } catch {
    journeyEl.innerHTML = `<div class="journey-error">サーバーに接続できません</div>`;
  } finally {
    setBusy(false);
    renderMap();
  }
}

function updatePickPanel() {
  const s = document.getElementById("pick-start-chip");
  const g = document.getElementById("pick-goal-chip");
  s.textContent = pickStart != null ? `出発: ${pickStart}` : "出発: 未選択";
  g.textContent = pickGoal  != null ? `目的: ${pickGoal}`  : "目的: 未選択";
  s.className = "pick-chip" + (pickStart != null ? " start" : " empty");
  g.className = "pick-chip" + (pickGoal  != null ? " goal"  : " empty");
}

function clearPick() {
  const hadRoute = pickGoal != null && currentPath != null;
  pickStart = null; pickGoal = null;
  document.getElementById("pick-journey").innerHTML = "";
  updatePickPanel();
  if (hadRoute) {
    currentPath = null; startEdge = null; destEdge = null;
    if (routeZoomed) resetRouteZoom();
  }
  renderMap();
}

// ============================================================
//  経路サマリー — フロア遷移を距離比例の色帯（リボン）で表示
// ============================================================
function buildJourneyHTML(data) {
  const coords = data.path_coords || [];
  const edges  = data.path_edges  || [];
  if (coords.length < 2) return "";

  // 連続する (building, floor) 区間ごとに距離を集計
  const segs = [];
  coords.forEach((n, i) => {
    const key = `${n.building}_${n.floor}`;
    if (!segs.length || segs[segs.length - 1].key !== key) {
      segs.push({ key, building: n.building, floor: n.floor, dist: 0 });
    }
    if (i < edges.length) segs[segs.length - 1].dist += edges[i].length || 0;
  });

  const total    = edges.reduce((s, e) => s + (e.length || 0), 0);
  const colors   = graphData.building_colors || [];
  const segColor = b => b === 0 ? "#5AFF5A" : colors[(b - 1) % colors.length];
  const segLabel = s => s.building === 0 ? "屋外" : `${s.building}-${s.floor}F`;

  const strip = segs.map(s =>
    `<div class="journey-seg" style="flex:${Math.max(s.dist, total * 0.05) || 1} 1 0;` +
    `background:${segColor(s.building)};" title="${segLabel(s)} ${s.dist.toFixed(0)}m">${segLabel(s)}</div>`
  ).join("");

  // 階段・EV などの内訳（グラフのエッジ種別から逆引き）
  const TYPE_LABEL = { "2": "階段", "3": "エスカレーター", "4": "EV", "5": "上りESC", "6": "下りESC", "7": "入口" };
  const typeDist = {};
  edges.forEach(e => {
    const g = edgeByPair && edgeByPair.get(`${e.from}-${e.to}`);
    if (!g) return;
    const t = String(g.type);
    if (TYPE_LABEL[t]) typeDist[t] = (typeDist[t] || 0) + (e.length || 0);
  });

  const chips = [`<span class="meta-chip">合計 ${total.toFixed(0)}m ・ ${coords.length}ノード</span>`];
  Object.entries(typeDist).forEach(([t, d]) => {
    chips.push(`<span class="meta-chip">${TYPE_LABEL[t]} ${d.toFixed(0)}m</span>`);
  });

  return `<div class="journey">
    <div class="journey-strip">${strip}</div>
    <div class="journey-meta">${chips.join("")}</div>
  </div>`;
}

// ============================================================
//  ルートを拡大 — 経路の範囲にシーンをクロップして注視する
// ============================================================
function applyRouteZoom() {
  const cs = currentPath?.path_coords;
  if (!cs?.length) return;
  const pad = a => {
    const mn = Math.min(...a), mx = Math.max(...a);
    const p = Math.max((mx - mn) * 0.15, 6);
    return [mn - p, mx + p];
  };
  const [x0, x1] = pad(cs.map(n => n.x));
  const [y0, y1] = pad(cs.map(n => n.y));
  const [z0, z1] = pad(cs.map(n => n.z));
  Plotly.relayout("map", {
    "scene.xaxis.autorange": false, "scene.xaxis.range": [x0, x1],
    "scene.yaxis.autorange": false, "scene.yaxis.range": [y1, y0],  // Y軸は反転表示
    "scene.zaxis.autorange": false, "scene.zaxis.range": [z0, z1],
  });
}

function toggleRouteZoom() {
  if (routeZoomed) { resetRouteZoom(); return; }
  if (!currentPath?.path_coords?.length) return;
  applyRouteZoom();
  routeZoomed = true;
  const b = document.getElementById("zoom-route-btn");
  b.textContent = "全体に戻す";
  b.classList.add("zoomed");
}

function resetRouteZoom() {
  Plotly.relayout("map", {
    "scene.xaxis.autorange": true,
    "scene.yaxis.autorange": "reversed",
    "scene.zaxis.autorange": true,
  });
  routeZoomed = false;
  const b = document.getElementById("zoom-route-btn");
  b.textContent = "ルートを拡大";
  b.classList.remove("zoomed");
}

// ============================================================
//  カメラズーム — ＋/−ボタン と 2本指ピンチ（タブレット対応）
//  Plotly gl3d のタッチ操作は回転しか効かないため、ピンチは
//  キャプチャ段階で横取りしてカメラの注視点との距離を直接変える。
// ============================================================
const ZOOM_DIST_MIN = 0.25;  // 注視点へ寄れる最小距離（最大ズームイン）
const ZOOM_DIST_MAX = 12;    // 引ける最大距離（最大ズームアウト）

// 現在のカメラ状態を取得（回転中の内部状態を優先し、無ければレイアウト値）
function getLiveCamera() {
  const gd = document.getElementById("map");
  const scene = gd._fullLayout?.scene?._scene;
  if (scene?.getCamera) return scene.getCamera();
  return gd.layout?.scene?.camera || { eye: { x: 1.8, y: 1.8, z: 1.4 } };
}

// factor < 1 で拡大（注視点へ近づく）、> 1 で縮小
function zoomCamera(factor, baseCam) {
  const cam    = baseCam || getLiveCamera();
  const center = cam.center || { x: 0, y: 0, z: 0 };
  const eye    = cam.eye;
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!dist) return;
  const newDist = Math.max(ZOOM_DIST_MIN, Math.min(dist * factor, ZOOM_DIST_MAX));
  const s = newDist / dist;
  Plotly.relayout("map", {
    "scene.camera": {
      eye:    { x: center.x + dx * s, y: center.y + dy * s, z: center.z + dz * s },
      center: { ...center },
      up:     cam.up || { x: 0, y: 0, z: 1 },
    },
  });
}

function initPinchZoom() {
  const mapEl = document.getElementById("map");
  let pinch    = null;   // { d0, cam0 } ピンチ開始時の指間距離とカメラ
  let blocking = false;  // ピンチ中〜全指が離れるまで Plotly へのタッチ伝播を止める

  const touchDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const block = e => { e.preventDefault(); e.stopPropagation(); };

  // capture:true — Plotly がキャンバスで受け取る前に横取りする
  mapEl.addEventListener("touchstart", e => {
    if (e.touches.length >= 2) {
      pinch    = { d0: touchDist(e.touches), cam0: getLiveCamera() };
      blocking = true;
      block(e);
    } else if (blocking) {
      block(e);
    }
  }, { capture: true, passive: false });

  mapEl.addEventListener("touchmove", e => {
    if (pinch && e.touches.length >= 2) {
      const d = touchDist(e.touches);
      if (d >= 1) zoomCamera(pinch.d0 / d, pinch.cam0);
      block(e);
    } else if (blocking) {
      block(e);
    }
  }, { capture: true, passive: false });

  const endTouch = e => {
    if (!blocking) return;
    if (e.touches.length < 2)   pinch = null;
    if (e.touches.length === 0) blocking = false;  // 全指が離れたら通常操作へ復帰
  };
  mapEl.addEventListener("touchend",    endTouch, { capture: true });
  mapEl.addEventListener("touchcancel", endTouch, { capture: true });
}

// ============================================================
//  俯瞰ビュー
// ============================================================
function setTopView() {
  Plotly.relayout("map", {
    "scene.camera": {
      eye:    { x: 0, y: 0, z: 2.5 },
      up:     { x: 0, y: 1, z: 0 },
      center: { x: 0, y: 0, z: 0 },
    }
  });
}

</script>
</body>
</html>

```

### 10.2 フロントエンド

### `programs/html/index.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="専修大学 生田キャンパスのARキャンパスマップ「IKU NAVI」。教室名で検索するだけで、AR写真ガイドが目的の教室・建物まで道案内。新入生や来訪者のキャンパス内ナビゲーションに。2026年度 生亀プロジェクト。">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <title>IKU NAVI — 専修大学 生田キャンパスARマップ | 生亀プロジェクト 2026</title>
  <link rel="canonical" href="https://iku-navi.net/">

  <!-- OGP / SNSシェア -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="IKU NAVI">
  <meta property="og:title" content="IKU NAVI — 専修大学 生田キャンパスARマップ">
  <meta property="og:description" content="専修大学 生田キャンパスのARキャンパスマップ。教室名で検索するだけで、AR写真ガイドが目的の教室・建物まで道案内します。">
  <meta property="og:url" content="https://iku-navi.net/">
  <meta property="og:image" content="https://iku-navi.net/images/logo.png">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="IKU NAVI — 専修大学 生田キャンパスARマップ">
  <meta name="twitter:description" content="専修大学 生田キャンパスのARキャンパスマップ。教室名で検索して、AR写真ガイドで目的地まで道案内。">
  <meta name="twitter:image" content="https://iku-navi.net/images/logo.png">

  <!-- 構造化データ -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "IKU NAVI",
    "alternateName": ["イクナビ", "専修大学 生田キャンパスマップ"],
    "url": "https://iku-navi.net/",
    "description": "専修大学 生田キャンパスのARキャンパスマップ。教室名で検索するだけで、AR写真ガイドが目的の教室・建物まで道案内します。",
    "inLanguage": "ja",
    "about": {
      "@type": "Place",
      "name": "専修大学 生田キャンパス",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "川崎市多摩区",
        "addressRegion": "神奈川県",
        "addressCountry": "JP"
      }
    }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "専修大学 生田キャンパスの教室の場所はどうやって調べられますか？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "IKU NAVIで教室名（例: 101、10301）を検索すると、出発地点から目的の教室までの最短経路を写真付きのARガイドで案内します。建物をまたぐ移動にも対応しています。"
        }
      },
      {
        "@type": "Question",
        "name": "紙のフロアマップ・キャンパス案内図との違いは？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "フロアごとの地図から自分で経路を考える必要がなく、階段・エレベータ・エスカレータの上下移動まで含めた最短ルートを自動で計算します。エレベータを使わない経路の指定もできます。"
        }
      },
      {
        "@type": "Question",
        "name": "トイレや食堂も探せますか？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "現在地から最寄りのトイレ（男子・女子・多目的）や学生食堂までの経路を検索できます。"
        }
      },
      {
        "@type": "Question",
        "name": "専修大学 生田キャンパスへのアクセスは？",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "小田急線「向ヶ丘遊園」駅が最寄り駅です。IKU NAVIはキャンパス到着後の建物・教室までの道案内を担当します。"
        }
      }
    ]
  }
  </script>

  <link rel="icon" href="images/favicon.ico">
  <link rel="stylesheet" href="style.css">
</head>
<body>

  <main class="page">

    <header class="hero">
      <p class="eyebrow">
        <span class="eyebrow-dot" aria-hidden="true"></span>
        ARキャンパスナビゲーション
      </p>
      <h1 class="logo">
        <span class="logo-iku">IKU</span><span class="logo-navi">NAVI</span>
      </h1>
      <p class="tagline">キャンパスを、もっとスマートに。</p>
      <p class="subline">専修大学 生田キャンパスのARキャンパスマップ — 2026年度 生亀プロジェクト</p>
    </header>

    <nav class="cards" aria-label="メインメニュー">
      <a href="navi/" class="card card-nav">
        <span class="card-label">Navigation</span>
        <div class="card-body">
          <span class="card-glyph" aria-hidden="true">→</span>
          <h2 class="card-heading">ナビを使う</h2>
          <p class="card-text">生田キャンパスの教室名で検索して、AR写真ガイドで目的地まで確実に案内します。</p>
        </div>
        <span class="card-cta">アプリを開く <span aria-hidden="true" class="card-arrow">↗</span></span>
      </a>

      <a href="blog/" class="card card-blog">
        <span class="card-label">Blog</span>
        <div class="card-body">
          <span class="card-glyph" aria-hidden="true">✦</span>
          <h2 class="card-heading">ブログ</h2>
          <p class="card-text">プロジェクトの進捗・技術的な発見・活動記録をまとめています。</p>
        </div>
        <span class="card-cta">記事を読む <span aria-hidden="true" class="card-arrow">↗</span></span>
      </a>
    </nav>

    <section class="info" aria-label="IKU NAVIについて">
      <h2 class="info-heading">専修大学 生田キャンパスの教室検索・道案内ナビ</h2>
      <p class="info-text">
        IKU NAVIは、専修大学 生田キャンパス向けのキャンパスマップ・ナビゲーションアプリです。
        フロアマップを眺めて教室を探す代わりに、教室名で検索するだけで、階段・エレベータ・エスカレータまで
        考慮した最短ルートを、実際の風景写真に矢印を重ねたARガイドで案内します。
        最寄りのトイレや学生食堂の検索にも対応。アプリのインストールは不要で、スマホのブラウザからそのまま使えます。
      </p>
      <p class="info-buildings">
        <span class="info-label">対応建物</span>
        2号館・5号館・7号館・8号館・10号館（130年記念館）と屋外エリア — 順次拡大中
      </p>
      <p class="info-buildings">
        <span class="info-label">運営</span>
        専修大学 ネットワーク情報学部
        <a class="info-link" href="https://project.ne.senshu-u.ac.jp/2026/04/">生亀プロジェクト（公式紹介ページ）</a>
      </p>

      <dl class="faq">
        <div class="faq-item">
          <dt>教室の場所はどうやって調べられますか？</dt>
          <dd>「ナビを使う」から教室名（例: 101、10301）で検索すると、出発地点から目的の教室までの最短経路を写真付きで案内します。建物をまたぐ移動にも対応しています。</dd>
        </div>
        <div class="faq-item">
          <dt>紙のフロアマップ・案内図との違いは？</dt>
          <dd>フロアごとの地図から自分で経路を考える必要がなく、階段・エレベータ・エスカレータの上下移動まで含めたルートを自動で計算します。エレベータを使わない経路の指定もできます。</dd>
        </div>
        <div class="faq-item">
          <dt>トイレや食堂も探せますか？</dt>
          <dd>現在地から最寄りのトイレ（男子・女子・多目的）や学生食堂までの経路を検索できます。</dd>
        </div>
        <div class="faq-item">
          <dt>生田キャンパスへのアクセスは？</dt>
          <dd>小田急線「向ヶ丘遊園」駅が最寄り駅です。IKU NAVIは、キャンパス到着後の建物・教室までの道案内を担当します。</dd>
        </div>
      </dl>
    </section>

  </main>

  <footer class="footer">
    <span class="footer-brand">IKU NAVI</span>
    <span class="footer-sep" aria-hidden="true">—</span>
    <span>生亀プロジェクト &copy; 2026</span>
  </footer>

</body>
</html>

```

### `programs/html/404.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 - ページが見つかりません</title>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif;
            min-height: 100vh;
            background: #f7f8fc;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: #fff;
            border-radius: 20px;
            padding: 3.5rem 3rem;
            max-width: 480px;
            width: calc(100% - 3rem);
            text-align: center;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.08);
        }
        .code {
            font-size: 7rem;
            font-weight: 900;
            line-height: 1;
            letter-spacing: -3px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .accent {
            display: block;
            width: 48px;
            height: 4px;
            background: linear-gradient(90deg, #667eea, #764ba2);
            border-radius: 2px;
            margin: 1.25rem auto 0;
        }
        .title {
            margin-top: 1.25rem;
            font-size: 1.25rem;
            font-weight: 700;
            color: #1a202c;
        }
        .desc {
            margin-top: 0.75rem;
            font-size: 0.9rem;
            color: #718096;
            line-height: 1.9;
        }
        .btn {
            display: inline-block;
            margin-top: 2rem;
            padding: 0.7rem 2.25rem;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: #fff;
            font-size: 0.875rem;
            font-weight: 600;
            text-decoration: none;
            border-radius: 100px;
            letter-spacing: 0.05em;
            transition: opacity 0.15s ease, transform 0.15s ease;
            box-shadow: 0 4px 14px rgba(102, 126, 234, 0.35);
        }
        .btn:hover { opacity: 0.88; transform: translateY(-1px); }
        @media (max-width: 480px) {
            .card { padding: 2rem 1.5rem; border-radius: 16px; }
            .code { font-size: 4.5rem; letter-spacing: -2px; }
            .title { font-size: 1.1rem; }
            .desc { font-size: 0.85rem; }
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="code">404</div>
        <span class="accent"></span>
        <div class="title">ページが見つかりません</div>
        <div class="desc">
            お探しのページは存在しないか、<br>
            移動または削除された可能性があります。
        </div>
        <a class="btn" href="/">ホームに戻る</a>
    </div>
</body>
</html>

```

### `programs/html/style.css`

```css
/* ================================================================
   IKU NAVI — Landing Page
   Design: Technical Minimal / Blueprint
================================================================ */

:root {
  --blue:       #3bab64;
  --blue-dark:  #166534;
  --blue-light: #F0FDF4;

  --dark:       #0F172A;
  --text:       #1E293B;
  --muted:      #64748B;
  --border:     #E2E8F0;

  /* ベージュ背景 */
  --bg:         #f7eaca;
  --white:      #FFFFFF;

  --font: -apple-system, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans',
          'Noto Sans JP', sans-serif;
  --font-mono: 'SF Mono', 'Menlo', 'Courier New', monospace;

  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}

/* ================================================================
   Base
================================================================ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html { height: 100%; }

body {
  min-height: 100%;
  font-family: var(--font);
  background-color: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  display: flex;
  flex-direction: column;

  background-image:
    radial-gradient(circle, #D8CFC1 1px, transparent 1px);

  background-size: 28px 28px;
}

/* ================================================================
   Page layout
================================================================ */
.page {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 100px 20px 32px;
  gap: 32px;
}

/* ================================================================
   Hero
================================================================ */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 8px;
  animation: fadeUp 0.9s var(--ease) both;
}

/* — eyebrow — */
.eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.eyebrow-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blue);
  animation: pulse 2.4s ease infinite;
}

/* — logotype — */
.logo {
  font-size: clamp(76px, 20vw, 148px);
  font-weight: 900;
  letter-spacing: -0.045em;
  line-height: 0.88;
  position: relative;
  padding: 10px 28px;

  display: flex;
  justify-content: center;
}

.logo::before {
  top: 0;
  left: 0;
  border-width: 2px 0 0 2px;
}
.logo::after {
  bottom: 0;
  right: 0;
  border-width: 0 2px 2px 0;
}

.logo-iku  { color: var(--dark); }
.logo-navi { color: var(--blue); }

/* — tagline — */
.tagline {
  font-size: clamp(17px, 3.5vw, 22px);
  font-weight: 500;
  color: var(--text);
  letter-spacing: 0.01em;
}

.subline {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  letter-spacing: 0.06em;
}

/* ================================================================
   Cards
================================================================ */
.cards {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  width: 100%;
  max-width: 640px;
  padding: 0 12px;
}

@media (min-width: 520px) {
  .cards { grid-template-columns: 1fr 1fr; }
}

.card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 20px;
  padding: 26px 24px;
  border-radius: 18px;
  text-decoration: none;
  transition: transform 0.35s var(--ease), box-shadow 0.35s var(--ease);
  animation: fadeUp 0.9s var(--ease) both;
}

.card:nth-child(1) { animation-delay: 0.12s; }
.card:nth-child(2) { animation-delay: 0.22s; }

.card:hover {
  transform: translateY(-5px) scale(1.03);
}

/* — nav card (blue) — */
.card-nav {
  position: relative;
  overflow: hidden;
  background: var(--blue);
  color: var(--white);
  box-shadow: 0 4px 24px rgba(22, 163, 74, 0.3);
}

.card-nav:hover {
  box-shadow: 0 16px 40px rgba(59, 130, 246, 0.38);
}

/* — blog card (white) — */
.card-blog {
  background: var(--white);
  color: var(--text);
  border: 1.5px solid var(--border);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
}
.card-blog:hover {
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.10);
}

/* — card internals — */
.card-label {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  opacity: 0.55;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card-glyph {
  font-size: 26px;
  line-height: 1;
}

.card-heading {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.card-text {
  font-size: 13px;
  line-height: 1.75;
  opacity: 0.78;
}

.card-cta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.card-arrow {
  display: inline-block;
  transition: transform 0.25s var(--ease);
}

.card:hover .card-arrow {
  transform: translate(3px, -3px);
}

/* ================================================================
   Info / FAQ
================================================================ */
.info {
  width: 100%;
  max-width: 640px;
  padding: 26px 24px;
  border-radius: 18px;
  background: var(--white);
  border: 1.5px solid var(--border);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: fadeUp 0.9s var(--ease) 0.32s both;
}

.info-heading {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: -0.01em;
}

.info-text {
  font-size: 13px;
  line-height: 1.85;
  color: var(--text);
  opacity: 0.85;
}

.info-buildings {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.info-label {
  display: inline-block;
  margin-right: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--blue-dark);
  background: var(--blue-light);
  border-radius: 4px;
  padding: 2px 8px;
}

.info-link {
  color: var(--blue-dark);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.info-link:hover {
  color: var(--blue);
}

.faq {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}

.faq-item dt {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 4px;
}

.faq-item dt::before {
  content: "Q. ";
  color: var(--blue);
  font-family: var(--font-mono);
}

.faq-item dd {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
}

@media (max-width: 520px) {
  .info {
    padding: 20px 18px;
  }
}

/* ================================================================
   Footer
================================================================ */
.footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.05em;
}

.footer-brand {
  font-weight: 700;
  color: var(--text);
}

.footer-sep { opacity: 0.35; }

/* ================================================================
   Animations
================================================================ */
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(22px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1;   transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.7); }
}

@media (max-width: 520px) {

  /* ページ全体 */
  .page {
    padding: 56px 12px 24px;
    gap: 24px;
  }

  .logo {
    font-size: clamp(38px, 12vw, 52px);
    padding: 0;
    line-height: 1;
  }

  /* カード */
  .cards {
    width: 100%;
    max-width: 100%;
    padding: 0;
    gap: 12px;
  }

  .card {
    width: 100%;
    padding: 20px 18px;
  }

  .card-heading {
    font-size: 18px;
  }

  .card-text {
    font-size: 12px;
    line-height: 1.6;
  }

  /* フッター */
  .footer {
    flex-direction: column;
    gap: 4px;
    text-align: center;
  }

  .footer-sep {
    display: none;
  }
}
```

### `programs/html/_headers`

```text
# Cloudflare Pages のキャッシュ制御
# https://developers.cloudflare.com/pages/configuration/headers/

/svg/*
  Cache-Control: public, max-age=86400

/images/*
  Cache-Control: public, max-age=86400

/navi/script/config.js
  Cache-Control: no-cache

# ブログは検索エンジンにインデックスさせない
/blog/*
  X-Robots-Tag: noindex

```

### `programs/html/_redirects`

```text
# Cloudflare Pages のリダイレクト定義
# https://developers.cloudflare.com/pages/configuration/redirects/
# 配布済み QR コード（https://iku-navi.net/redirect/...）と旧 3D ビューア URL を
# サーバー側（api サブドメイン）へ転送する。クエリ文字列は自動で引き継がれる。

/redirect/* https://api.iku-navi.net/redirect/:splat 301
/3d/* https://api.iku-navi.net/3d/:splat 301
/3d https://api.iku-navi.net/3d/ 301

```

### `programs/html/robots.txt`

```text
User-agent: *
Allow: /

Sitemap: https://iku-navi.net/sitemap.xml

```

### `programs/html/sitemap.xml`

```text
<?xml version="1.0" encoding="UTF-8"?>
<urlset
      xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
            http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
<!-- created with Free Online Sitemap Generator www.xml-sitemaps.com -->


<url>
  <loc>https://iku-navi.net/</loc>
  <lastmod>2026-07-17T00:00:00+00:00</lastmod>
  <priority>1.00</priority>
</url>
<url>
  <loc>https://iku-navi.net/navi/</loc>
  <lastmod>2026-07-17T00:00:00+00:00</lastmod>
  <priority>0.80</priority>
</url>


</urlset>
```

### `programs/html/navi/index.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <meta name="description" content="専修大学 生田キャンパスの教室検索ナビ。教室名を入力すると、階段・エレベータまで考慮した最短ルートをAR写真ガイドで案内します。最寄りのトイレ・食堂検索にも対応。インストール不要。">
  <title>教室検索ナビ | IKU NAVI — 専修大学 生田キャンパスマップ</title>
  <link rel="canonical" href="https://iku-navi.net/navi/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="IKU NAVI">
  <meta property="og:title" content="教室検索ナビ | IKU NAVI — 専修大学 生田キャンパスマップ">
  <meta property="og:description" content="教室名を入力すると、最短ルートをAR写真ガイドで案内。トイレ・食堂の最寄り検索にも対応。">
  <meta property="og:url" content="https://iku-navi.net/navi/">
  <meta property="og:image" content="https://iku-navi.net/images/logo.png">
  <meta property="og:locale" content="ja_JP">
  <link rel="icon" href="../images/favicon.ico">
  <link rel="stylesheet" href="style.css">
  <script src="script/config.js"></script>
</head>
<body>

<!-- ================================================================
     Sidebar: search + nav + AR
     Mobile: display:contents — children participate in body flex via order
     Desktop: display:flex column, fixed 340px left panel
================================================================ -->
<div id="sidebar">

  <div id="app-header">
    <a href="../index.html" class="hdr-title">IKU NAVI</a>
  </div>

  <!-- Search Panel -->
  <div id="search-panel">
    <div id="search-header">
      <a id="btn-home" href="../index.html" aria-label="トップページに戻る">⌂</a>
      <div class="category-tabs">
        <button class="category-tab active" id="cat-room"     onclick="setCategory('room')">教室</button>
        <button class="category-tab"        id="cat-facility" onclick="setCategory('facility')">設備検索</button>
      </div>
      <span id="event-badge">&#127914; イベント</span>
      <button id="search-toggle" onclick="toggleSearchPanel()" aria-label="検索パネルを開閉">
        <span id="search-chevron" class="open">▾</span>
      </button>
    </div>

    <div id="search-content" class="open">
      <div class="search-content-inner">

        <!-- 教室カテゴリ -->
        <div id="cat-content-room">
        <div class="search-tabs" style="margin-bottom:8px;">
          <button class="search-tab active" id="tab-room" onclick="setMode('room')">教室 → 教室</button>
          <button class="search-tab"        id="tab-gps"  onclick="setMode('gps')">現在地(屋外) → 教室</button>
        </div>

        <div id="panel-room">
          <div class="route-row">
            <span class="route-label">出発</span>
            <select class="building-select" id="from-bldg">
              <option value="">全</option>
            </select>
            <div class="ac-wrap">
              <input id="from-input" placeholder="教室名" autocomplete="off">
              <div class="suggestions" id="from-sugg"></div>
            </div>
          </div>
          <button class="btn-swap" onclick="swapFromTo()" title="出発地と目的地を入れ替え">⇅</button>
          <div class="route-row">
            <span class="route-label">目的</span>
            <select class="building-select" id="to-bldg">
              <option value="">全</option>
            </select>
            <div class="ac-wrap">
              <input id="to-input" placeholder="教室名" autocomplete="off">
              <div class="suggestions" id="to-sugg"></div>
            </div>
          </div>
        </div>

        <div id="panel-gps" style="display:none">
          <div class="gps-wrapper">
            <div class="gps-row">
              <span id="gps-text">GPS未取得 — 右のボタンで現在地を取得</span>
              <button class="btn-gps" onclick="captureGPS()">取得</button>
            </div>
            <div id="accuracy-warn"></div>
          </div>
          <div class="route-row">
            <span class="route-label">目的</span>
            <select class="building-select" id="gps-to-bldg">
              <option value="">全</option>
            </select>
            <div class="ac-wrap">
              <input id="to-input-gps" placeholder="教室名" autocomplete="off">
              <div class="suggestions" id="gps-to-sugg"></div>
            </div>
          </div>
        </div>

        <div class="bottom-row">
          <label class="ev-label">
            <input type="checkbox" id="use-elevator" checked>
            エレベーター使用
          </label>
          <button id="btn-search" onclick="doSearch()">ルート検索</button>
        </div>
        </div><!-- /#cat-content-room -->

        <!-- 設備検索カテゴリ -->
        <div id="cat-content-facility" style="display:none">

          <!-- モードタブ -->
          <div class="search-tabs" style="margin-bottom:8px;">
            <button class="search-tab active" id="fac-tab-room" onclick="setFacMode('room')">教室 → 設備</button>
            <button class="search-tab"        id="fac-tab-gps"  onclick="setFacMode('gps')">現在地(屋外) → 設備</button>
          </div>

          <!-- 教室モード: 出発(教室) -->
          <div id="panel-fac-room">
            <div class="route-row">
              <span class="route-label">出発</span>
              <select class="building-select" id="fac-from-bldg"><option value="">全</option></select>
              <div class="ac-wrap">
                <input id="fac-from-input" placeholder="教室名" autocomplete="off">
                <div class="suggestions" id="fac-from-sugg"></div>
              </div>
            </div>
          </div>

          <!-- GPSモード: 現在地取得 -->
          <div id="panel-fac-gps" style="display:none">
            <div class="gps-wrapper">
              <div class="gps-row">
                <span id="fac-gps-text">GPS未取得 — 右のボタンで現在地を取得</span>
                <button class="btn-gps" onclick="captureFacGPS()">取得</button>
              </div>
              <div id="fac-accuracy-warn"></div>
            </div>
          </div>

          <!-- 目的: 常に表示 -->
          <div class="route-row">
            <span class="route-label">目的</span>
            <select class="building-select" id="fac-category" onchange="onFacCategoryChange()">
              <option value="toilet">トイレ</option>
              <option value="cafeteria">食堂</option>
            </select>
            <select id="fac-toilet-type" style="flex:1;height:38px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:13px;color:#1E293B;background:white;padding:0 6px;cursor:pointer;">
              <option value="all">全て</option>
              <option value="M">男子トイレ</option>
              <option value="F">女子トイレ</option>
              <option value="C">多目的トイレ</option>
            </select>
            <select id="fac-cafeteria-name" style="flex:1;height:38px;border:1.5px solid #E2E8F0;border-radius:8px;font-size:13px;color:#1E293B;background:white;padding:0 6px;cursor:pointer;display:none;">
              <option value="all">全て</option>
            </select>
          </div>

          <div class="bottom-row">
            <label class="ev-label">
              <input type="checkbox" id="fac-use-elevator" checked>エレベーター使用
            </label>
            <button id="btn-fac-search" onclick="doFacSearch()">設備検索</button>
          </div>
        </div><!-- /#cat-content-facility -->

      </div>
    </div>
  </div>

  <!-- AR / Camera Area -->
  <div id="ar-area">
    <video id="ar-bg-video" autoplay playsinline muted></video>
    <canvas id="ar-gl-canvas"></canvas>
    <div id="ar-cache"></div><!-- prefetch済み <img> がここに積まれる -->
    <div id="ar-placeholder">
      <div class="ph-text">AR / Camera</div>
      <div class="arrival-icon" style="display:none"></div>
      <div class="arrival-title" style="display:none">目的地周辺に到達しました！</div>
      <div class="arrival-desc" style="display:none">案内はここで終了です。<br>ご利用いただきありがとうございました。</div>
    </div>
    <div id="ar-label">進行方向</div>
    <img id="direction-arrow" src="" alt="方向矢印">
    <div id="near-goal-badge">この通路沿いが目的地周辺です</div>
    <!-- ステップ操作: 画像上のオーバーレイ -->
    <div id="step-info">
      <div id="step-label">ルートを検索してください</div>
      <div id="step-count"></div>
    </div>
    <button class="nav-arrow" id="prev-btn" onclick="prevStep()" disabled>&#9664;</button>
    <button class="nav-arrow" id="next-btn" onclick="nextStep()" disabled>&#9654;</button>
    <button id="voice-toggle-btn" onclick="toggleVoiceGuide()" title="音声案内のON/OFF" aria-pressed="false">&#128264;</button>
  </div>

</div><!-- /#sidebar -->

<!-- Map / SVG — full height on desktop, flex:1 on mobile -->
<div id="map-area">
  <div id="map"></div>
  <div id="svg-area">
    <div id="floor-badge"></div>
    <div id="svg-container"></div>
  </div>
</div>

<!-- ================================================================
     Completion modal — ナビ終了時に表示
================================================================ -->
<div id="completion-modal">
  <div id="completion-box">
    <div class="modal-icon">✓</div>
    <div class="modal-title">目的地に到着！</div>
    <p class="modal-desc">案内はここで終了です。<br>ご利用いただきありがとうございました。</p>
    <!-- ↓ アンケートURLをここに設定してください -->
    <a class="modal-btn-survey" href="https://docs.google.com/forms/d/e/1FAIpQLScPw9uoXzk2AiQamOm-zchGnQrmi9lcSFvonsVjFDnMIhU7Dg/viewform?usp=sharing&ouid=117616783174955140351" target="_blank" rel="noopener">
      アンケートに答える ↗
    </a>
    <button class="modal-btn-continue" onclick="closeCompletionModal()">引き続きナビを使う</button>
  </div>
</div>

<div id="loading"><div id="loading-box">検索中...</div></div>

<script src="script/state.js"></script>
<script src="script/data.js"></script>
<script src="script/search-form.js"></script>
<script src="script/gps.js"></script>
<script src="script/route.js"></script>
<script src="script/voice.js"></script>
<script src="script/photo.js"></script>
<script src="script/map.js"></script>
<script src="script/floormap.js"></script>
<script src="script/page.js"></script>

<script src="script/ar.js"></script>

<script src="script/maps-loader.js"></script>
</body>
</html>
```

### `programs/html/navi/style.css`

```css
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      /* 「駅の案内サイン」をモチーフにした配色。地図・AR映像が主役なので、周りのUIは
         紙色(--paper)とインク(--ink)、罫線(--line)だけで構成し、色は要所の signal(バーミリオン)
         だけに絞る。カード風の丸み・ドロップシャドウの多用はやめ、線で区切る。 */
      --ink:           #14181F;
      --ink-soft:       #4B5563;
      --paper:          #F6F6F2;
      --line:           #DBDCD4;
      --line-strong:    #C3C5BB;
      --accent:             #E8501E; /* signal: 主要アクション・選択状態にのみ使う */
      --accent-dark:        #B93C14;
      --accent-darker:      #7A2A0D;
      --accent-light:       #FCEEE7;
      --accent-border-light: #F0C3AE;
      --transit-blue:   #1B3A6B; /* 地図・現在地まわりの構造色 */
      --go:             #1E7145; /* 到着・成功状態 */
    }
    /* イベントモード (?event=1): アクセントを祭りの金へ切り替える（案内サインの通常色と混同しないため） */
    body.event-mode {
      --accent:             #A8720A;
      --accent-dark:        #7C5407;
      --accent-darker:      #543905;
      --accent-light:       #FBF1D9;
      --accent-border-light: #E6CB8C;
    }
    html { height: 100%; overscroll-behavior: none; }
    body {
      height: 100%; overflow: hidden;
      overscroll-behavior: none;
      background: var(--paper);
      color: var(--ink);
      font-family: 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', 'Yu Gothic', 'Helvetica Neue', Arial, sans-serif;
      display: flex;
      flex-direction: column; /* mobile: stacked */
    }
    button, a, select, input, label {
      touch-action: manipulation; /* ダブルタップズームを無効化 */
    }

    /* ================================================================
       Mobile layout — sidebar dissolves via display:contents;
       children participate directly in body's flex flow via order.
    ================================================================ */
    #sidebar { display: contents; }

    #app-header  { display: none; } /* mobile: hidden */

    #search-panel {
      order: 1;
      background: var(--paper);
      padding: 0;
      border-bottom: 1px solid var(--line);
      flex-shrink: 0;
      z-index: 100;
    }
    #search-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
    }
    #btn-home {
      flex-shrink: 0;
      width: 28px; height: 28px;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: #fff;
      display: flex; align-items: center; justify-content: center;
      color: var(--ink-soft); font-size: 15px; line-height: 1;
      text-decoration: none;
      -webkit-tap-highlight-color: transparent;
    }
    #btn-home:active { background: var(--line); }
    #search-toggle {
      flex-shrink: 0;
      width: 28px; height: 28px;
      border: 1px solid var(--line-strong); border-radius: 6px;
      background: #fff;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; color: var(--ink-soft); font-size: 13px;
      -webkit-tap-highlight-color: transparent;
    }
    #search-chevron {
      display: inline-block;
      transition: transform 0.3s ease;
      line-height: 1;
    }
    #search-chevron.open { transform: rotate(180deg); }
    #search-content {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.3s ease;
    }
    #search-content.open { grid-template-rows: 1fr; }
    .search-content-inner {
      overflow: hidden;
      padding: 0 10px 8px;
    }
    #map-area {
      order: 2;
      flex: 1;
      position: relative;
      overflow: hidden;
      min-height: 0;
    }
    #ar-area {
      order: 4;
      flex: 1;
      background: #1B1F24;
      position: relative;
      overflow: hidden;
      min-height: 0;
    }

    /* ================================================================
       Desktop layout (>= 768px) — sidebar + map side by side
    ================================================================ */
    @media (min-width: 768px) {
      body { flex-direction: row; }

      #sidebar {
        display: flex;
        flex-direction: column;
        width: 340px;
        flex-shrink: 0;
        height: 100%;
        background: var(--paper);
        border-right: 1px solid var(--line);
        /* no overflow:hidden — needed so suggestions can overflow */
      }

      #app-header {
        display: flex;
        align-items: center;
        gap: 10px;
        height: 52px;
        padding: 0 18px;
        border-bottom: 1px solid var(--line);
        flex-shrink: 0;
        background: var(--paper);
      }
      #app-header .hdr-title {
        font-size: 15px;
        font-weight: 800;
        color: var(--ink);
        letter-spacing: 0.01em;
        text-decoration: none;
      }
      #app-header .hdr-title:hover { color: var(--transit-blue); }
      #app-header .hdr-badge {
        font-size: 11px;
        color: var(--accent-dark);
        background: var(--accent-light);
        padding: 2px 9px;
        border-radius: 4px;
        font-weight: 700;
      }

      #search-panel {
        order: 0;
        border-bottom: 1px solid var(--line);
        padding: 0;
        flex-shrink: 0;
      }
      #search-header { padding: 14px 16px 8px; }
      #search-toggle { display: none; }
      #btn-home      { display: none; } /* desktop: app-header にリンクがあるため不要 */
      #search-content { display: block; }
      .search-content-inner { overflow: visible; padding: 0 16px 14px; }

      #ar-area {
        order: 0;
        flex: 1;
        min-height: 0;
      }

      #map-area {
        flex: 1;
        min-width: 0;
      }
    }

    /* ================================================================
       Search Panel internals
    ================================================================ */
    .search-tabs { display: flex; gap: 4px; flex: 1; border-bottom: 1px solid var(--line); }
    .search-tab {
      flex: 1; height: 34px;
      border: none; border-bottom: 2px solid transparent;
      background: none; font-size: 13px; font-weight: 600;
      color: var(--ink-soft); cursor: pointer; transition: color 0.15s, border-color 0.15s;
    }
    .search-tab.active { color: var(--ink); border-bottom-color: var(--accent); }

    .route-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .route-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--ink-soft);
      width: 28px;
      flex-shrink: 0;
      text-align: center;
    }
    .building-select {
      height: 38px;
      padding: 0 3px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      font-size: 12px;
      color: var(--ink);
      background: #fff;
      width: 76px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .building-select:focus { outline: none; border-color: var(--transit-blue); }

    .ac-wrap { flex: 1; position: relative; }
    .ac-wrap input {
      width: 100%;
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      font-size: 15px;
      color: var(--ink);
      outline: none;
      -webkit-appearance: none;
      background: #fff;
    }
    .ac-wrap input:focus { border-color: var(--transit-blue); }

    .suggestions {
      display: none;
      position: absolute;
      top: calc(100% + 3px);
      left: 0; right: 0;
      background: #fff;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      max-height: 180px;
      overflow-y: auto;
      z-index: 200;
      box-shadow: 0 4px 14px rgba(20,24,31,0.14);
    }
    .suggestions .item {
      padding: 9px 12px;
      font-size: 14px;
      color: var(--ink);
      cursor: pointer;
      border-bottom: 1px solid var(--line);
    }
    .suggestions .item:last-child { border-bottom: none; }
    .suggestions .item:active,
    .suggestions .item:hover { background: var(--accent-light); color: var(--accent-dark); }

    .bottom-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ev-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 13px;
      color: var(--ink-soft);
      white-space: nowrap;
      cursor: pointer;
      flex-shrink: 0;
    }
    .ev-label input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
      cursor: pointer;
    }
    #btn-search {
      flex: 1;
      height: 40px;
      border: none;
      border-radius: 4px;
      background: var(--accent);
      color: white;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    #btn-search:hover { background: var(--accent-dark); }

    .category-tabs { display: flex; gap: 4px; flex: 1; border-bottom: 1px solid var(--line); }
    .category-tab {
      flex: 1; height: 34px;
      border: none; border-bottom: 2px solid transparent;
      background: none; font-size: 13px; font-weight: 600;
      color: var(--ink-soft); cursor: pointer; transition: color 0.15s, border-color 0.15s;
    }
    .category-tab.active { color: var(--ink); border-bottom-color: var(--accent); }

    /* イベントモード (?event=1) のときだけ表示されるバッジ */
    #event-badge {
      display: none;
      align-items: center;
      font-size: 11px; font-weight: 700;
      color: var(--accent-dark); background: var(--accent-light);
      border: 1px solid var(--accent-border-light);
      padding: 3px 8px; border-radius: 4px;
      white-space: nowrap; flex-shrink: 0;
    }
    #btn-fac-search {
      flex: 1; height: 40px; border: none; border-radius: 4px;
      background: var(--accent);
      color: white; font-size: 15px; font-weight: 700;
      cursor: pointer; transition: background 0.15s;
    }
    #btn-fac-search:hover { background: var(--accent-dark); }

    .gps-wrapper {
      border: 1px solid var(--line-strong); border-radius: 4px;
      margin-bottom: 6px; overflow: hidden;
    }
    .gps-row {
      display: flex; gap: 8px; align-items: center;
      padding: 8px 12px; background: var(--paper);
    }
    .gps-row span { flex: 1; font-size: 13px; color: var(--ink-soft); word-break: break-all; }
    .btn-gps {
      height: 32px; padding: 0 14px; border: none; border-radius: 4px;
      background: var(--transit-blue); color: white; font-size: 13px;
      font-weight: 600; cursor: pointer; white-space: nowrap; flex-shrink: 0;
    }
    .btn-swap {
      display: block; width: 28px; height: 28px;
      margin: 0 0 4px 0;
      background: #fff; border: 1px solid var(--line-strong); border-radius: 6px;
      font-size: 16px; line-height: 1; cursor: pointer; color: var(--ink-soft);
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .btn-swap:hover { background: var(--accent-light); color: var(--accent-dark); border-color: var(--accent-border-light); }

    #accuracy-warn,
    #fac-accuracy-warn {
      display: none;
      padding: 6px 12px; font-size: 12px; line-height: 1.6;
    }
    #accuracy-warn.warn-low,  #fac-accuracy-warn.warn-low  { background: #FBF1D9; color: #543905; }
    #accuracy-warn.warn-high, #fac-accuracy-warn.warn-high { background: #FBEAE6; color: #7A2A0D; }

    /* ================================================================
       Map / SVG
    ================================================================ */
    #map { width: 100%; height: 100%; }

    #svg-area {
      display: none; width: 100%; height: 100%;
      position: absolute; inset: 0; background: var(--paper); overflow: hidden;
    }
    #svg-container {
      width: 100%; height: 100%;
      touch-action: none;        /* ブラウザスクロール抑制（ドラッグ用） */
      user-select: none;
      cursor: grab;
    }
    #svg-container:active { cursor: grabbing; }
    #svg-container svg { width: 100%; height: 100%; overflow: visible; }

    .err-box {
      width: 100%; height: 100%; min-height: 180px;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 10px; padding: 24px; text-align: center;
      color: var(--ink-soft);
    }
    .err-box .err-title { font-size: 15px; font-weight: 700; color: var(--ink); }
    .err-box .err-desc  { font-size: 13px; line-height: 1.7; }
    .err-box .err-hint  {
      font-size: 12px; color: var(--ink-soft);
      background: #fff; border: 1px solid var(--line); padding: 8px 16px; border-radius: 4px; margin-top: 4px;
    }

    #floor-badge {
      position: absolute; top: 10px; left: 10px; z-index: 10;
      background: var(--ink); border-radius: 4px; padding: 6px 14px;
      font-size: 13px; font-weight: 700; color: #fff;
      font-variant-numeric: tabular-nums;
      box-shadow: 0 2px 8px rgba(20,24,31,0.28);
    }

    /* ================================================================
       Step navigation — AR画像上のオーバーレイ
    ================================================================ */
    .nav-arrow {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 46px; height: 46px; border-radius: 50%;
      border: none; background: rgba(255,255,255,0.92);
      font-size: 18px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: var(--ink-soft); z-index: 20;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      -webkit-tap-highlight-color: transparent;
      transition: background 0.12s, opacity 0.12s;
    }
    #prev-btn { left: 10px; }
    #next-btn { right: 10px; }
    .nav-arrow:not(:disabled):hover  { background: white; }
    .nav-arrow:not(:disabled):active { transform: translateY(-50%) scale(0.92); }
    .nav-arrow:disabled { opacity: 0.35; cursor: not-allowed; }

    #voice-toggle-btn {
      position: absolute; bottom: 10px; right: 10px;
      width: 38px; height: 38px; border-radius: 50%;
      border: none; background: rgba(255,255,255,0.92);
      font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: var(--ink-soft); z-index: 20;
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      -webkit-tap-highlight-color: transparent;
      transition: background 0.12s, color 0.12s;
    }
    #voice-toggle-btn.active { background: var(--accent); color: #fff; }
    #voice-toggle-btn:hover { background: white; }
    #voice-toggle-btn.active:hover { background: var(--accent-dark); }

    #step-info {
      position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      max-width: calc(100% - 20px);
      z-index: 20; text-align: center;
      background: rgba(20,24,31,0.72); color: rgba(255,255,255,0.96);
      padding: 5px 16px; border-radius: 4px;
      backdrop-filter: blur(4px);
      pointer-events: none;
    }
    #step-label {
      font-size: 13px; font-weight: 700;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #step-count { font-size: 11px; color: rgba(255,255,255,0.75); margin-top: 1px; font-variant-numeric: tabular-nums; }

    @media (min-width: 768px) {
      #step-label { font-size: 14px; }
      .nav-arrow  { width: 50px; height: 50px; }
    }

    /* ================================================================
       AR Area
    ================================================================ */
    .ar-cached-img {
      display: none;
      position: absolute;
      inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
    }
    .ar-cached-img.active { display: block; }
    #ar-placeholder {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 8px;
      color: #fff;
    }
    #ar-placeholder .ph-text {
      font-size: 12px;
      color: rgba(255,255,255,0.55);
      letter-spacing: 0.1em;
    }
    #ar-placeholder.arrival {
      background: linear-gradient(160deg, var(--go) 0%, #133F27 100%);
      gap: 12px;
    }
    #ar-placeholder.arrival .arrival-icon {
      font-size: 48px;
      line-height: 1;
    }
    #ar-placeholder.arrival .arrival-title {
      font-size: 18px; font-weight: 800; color: #fff;
    }
    #ar-placeholder.arrival .arrival-desc {
      font-size: 13px; color: rgba(255,255,255,0.85); text-align: center; line-height: 1.6;
    }
    #ar-label {
      display: none;
      position: absolute; bottom: 10px; left: 10px;
      background: rgba(20,24,31,0.72);
      color: rgba(255,255,255,0.9);
      font-size: 12px; font-weight: 600;
      padding: 4px 12px; border-radius: 4px;
      backdrop-filter: blur(4px);
      pointer-events: none;
    }
    #direction-arrow {
      display: none;
      position: absolute;
      left: 50%;
      /* ↓ 矢印の縦位置: 値を大きくすると画面下（手前）に移動 / 小さくすると奥に移動 */
      top: 80%;
      transform: translate(-50%, -50%);
      /* ↓ 矢印のサイズ: clamp(最小, 基準, 最大) — 基準値を変えると全体的なサイズが変わる */
      width: clamp(130px, 50vmin, 220px);
      height: auto;
      opacity: 0.90;
      pointer-events: none;
      z-index: 10;
      filter: drop-shadow(0 3px 10px rgba(0,0,0,0.65));
    }
    /* 最終区間（目的地エッジ上）で矢印の代わりに出すバッジ */
    #near-goal-badge {
      display: none;
      position: absolute;
      left: 50%;
      top: 80%;
      transform: translate(-50%, -50%);
      background: rgba(30, 113, 69, 0.94);
      color: #fff;
      font-size: 16px; font-weight: 700;
      padding: 10px 22px; border-radius: 4px;
      /* 「<教室>は右手、<手前>から数えてN番目です」等で文言が長くなることがあるため、
         横一行固定(nowrap)ではなくAR領域内で折り返す */
      white-space: normal;
      max-width: calc(100% - 32px);
      text-align: center;
      line-height: 1.4;
      pointer-events: none;
      z-index: 10;
      box-shadow: 0 3px 10px rgba(0,0,0,0.45);
    }

    /* ================================================================
       Completion modal
    ================================================================ */
    #completion-modal {
      display: none;
      position: fixed; inset: 0; z-index: 600;
      align-items: center; justify-content: center;
      padding: 20px;
      background: rgba(20, 24, 31, 0.55);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      animation: modalFadeIn 0.25s ease both;
    }
    #completion-modal.show { display: flex; }

    #completion-box {
      background: #fff;
      border-radius: 6px;
      padding: 36px 32px 28px;
      max-width: 360px;
      width: 100%;
      box-shadow: 0 24px 64px rgba(20,24,31,0.28);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      text-align: center;
      animation: modalSlideUp 0.3s cubic-bezier(0.22,1,0.36,1) both;
    }

    .modal-icon {
      width: 60px; height: 60px;
      border-radius: 50%;
      background: #E9F4EE;
      color: var(--go);
      display: flex; align-items: center; justify-content: center;
      font-size: 26px;
      margin-bottom: 4px;
    }
    .modal-title {
      font-size: 20px; font-weight: 800;
      color: var(--ink); letter-spacing: -0.01em;
      margin-bottom: 2px;
    }
    .modal-desc {
      font-size: 14px; color: var(--ink-soft);
      line-height: 1.65; margin-bottom: 12px;
    }
    .modal-btn-survey {
      width: 100%; height: 48px;
      border: none; border-radius: 4px;
      background: var(--accent);
      color: white; font-size: 15px; font-weight: 700;
      cursor: pointer; transition: background 0.15s;
      text-decoration: none;
      display: flex; align-items: center; justify-content: center;
      gap: 6px;
    }
    .modal-btn-survey:hover { background: var(--accent-dark); }
    .modal-btn-continue {
      width: 100%; height: 44px;
      border: 1px solid var(--line-strong); border-radius: 4px;
      background: #fff; color: var(--ink-soft);
      font-size: 14px; font-weight: 600;
      cursor: pointer; transition: background 0.15s;
      margin-top: 4px;
    }
    .modal-btn-continue:hover { background: var(--paper); }

    @keyframes modalFadeIn {
      from { opacity: 0; } to { opacity: 1; }
    }
    @keyframes modalSlideUp {
      from { opacity: 0; transform: translateY(24px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }

    /* ================================================================
       Loading overlay
    ================================================================ */
    #loading {
      display: none; position: fixed; inset: 0; z-index: 500;
      background: rgba(20,24,31,0.5);
      align-items: center; justify-content: center;
    }
    #loading.show { display: flex; }
    #loading-box {
      background: #fff; border-radius: 6px; padding: 22px 36px;
      font-size: 16px; font-weight: 600; color: var(--ink);
      box-shadow: 0 10px 40px rgba(20,24,31,0.24);
    }

    /* ================================================================
       AR Outdoor Elements
    ================================================================ */
    #ar-bg-video {
      display: none;
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover; z-index: 1;
    }
    #ar-gl-canvas {
      display: none;
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      z-index: 2; pointer-events: none;
    }
```

### `programs/html/navi/script/state.js`

```javascript
// ================================================================
// state.js
// 設定値・全スクリプト共有の状態・矢印画像のプリフェッチ。
// 他のスクリプトより先に読み込むこと（ここで宣言した定数・変数を全員が参照する）。
// ================================================================

// ================================================================
// State
// ================================================================
// ローカル開発（nginx/Flask 同居）では同一オリジン、本番（Cloudflare Pages）では api サブドメインへ
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";

// イベントモード: navi/?event=1 で有効化。
// event.csv に登録されたイベント名（屋台など）を検索候補に加え、イベント名でルート検索できる。
const EVENT_MODE = new URLSearchParams(location.search).get("event") === "1";
// 経路の線・ドットなど、CSS(var(--accent))を参照できないJS描画箇所で使うアクセントカラー
const ACCENT_COLOR = EVENT_MODE ? "#EA580C" : "#3B82F6";
if (EVENT_MODE) {
  document.body.classList.add("event-mode");
  document.getElementById("event-badge").style.display = "inline-flex";
  ["from-input", "to-input", "to-input-gps", "fac-from-input"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.placeholder = "教室名・屋台名";
  });
}

let map;
let mapReady = false;
let _pendingMapCallback = null;

// Google Maps 読み込み完了(initMap)前に地図操作が必要な処理が来た場合は、
// 読み込み完了まで保留してから実行する（教室一覧の表示自体はMapsを待たず即座に行うため）。
function runWhenMapReady(fn) {
  if (mapReady) fn();
  else _pendingMapCallback = fn;
}

function waitForMapReady() {
  return new Promise(resolve => runWhenMapReady(resolve));
}

let searchMode    = "room";
let facSearchMode = "room";
let gpsCoords     = null;
let facGpsCoords  = null;
let allNodes   = [];
let allRooms   = [];        // [{room, display, building, isEvent?}, ...] roomはAPI用の生の名前、displayは表示名
let roomsByBuilding = {};   // {"10": ["101A", ...], ...}
let buildingNames = {};     // {10: "10号館", ...} data/building_name.csv 由来（未登録は "{id}号館"）

let pathCoords  = [];
let pathEdges   = [];  // path_coords[i]→[i+1] に対応する区間情報（type/length/name）。音声案内に使う
let destSide    = "";  // APIが指定した目的地そのものの左右("right"/"left"/"")。dest_side未対応のレスポンスでは""
let destPosition = null;        // その側の教室のうち、手前から数えて何番目か(1始まり)
let destCount     = null;       // その側にある教室の総数
let destDisplay   = "";         // 目的地そのものの表示名
let destNearestDisplay = "";    // 一番手前(先頭)の教室の表示名
let currentStep = 0;

let outdoorPolylines = [];
let stepMarker       = null;
let gpsMarker        = null;
let gpsCircle        = null;

let svgBuilding    = null;
let svgFloor       = null;
let svgOverlay     = null;
let svgOrigViewBox = null;
let svgViewW       = 1400;
let svgViewH       = 1000;

let edgeImages  = {};
let imgByStep = {};  // step_index → <img> DOM element
let svgCache      = {};  // `${building}_${floor}` → SVG text or null (prefetched)
let arrowBlobUrls = {};  // "straight"|"right"|"left" → blob: URL (prefetched)

// ================================================================
// 方向矢印: 閾値設定（後から変更しやすいように定数で管理）
// ================================================================
// 直進と判定する折れ角の上限（絶対値）: 単位は度
// ±STRAIGHT_THRESHOLD_DEG 以内なら直進、それ以上なら左右折とみなす。
// 人間計測データのブレ（廊下直進でも±10〜15度は発生）を考慮すること。
// 推奨範囲: 30（厳しめ） 〜 60（ゆるめ）
const STRAIGHT_THRESHOLD_DEG = 45;  // ← この値を調整してください
// ================================================================

const ARROW_URL = {
  straight: "https://cdn.iku-navi.net/Straight.png",
  right:    "https://cdn.iku-navi.net/right.png",
  left:     "https://cdn.iku-navi.net/left.png",
};

// 矢印画像をblob URLとして事前取得（オフライン時でも表示できるようにメモリに保持）
async function prefetchArrowImages() {
  await Promise.allSettled(
    Object.entries(ARROW_URL).map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        if (res.ok) arrowBlobUrls[key] = URL.createObjectURL(await res.blob());
      } catch {}
    })
  );
}
```

### `programs/html/navi/script/data.js`

```javascript
// ================================================================
// data.js
// 起動時のデータ取得（教室・ノード・画像・食堂・イベント）とURLパラメータによる検索プリセット。
// ================================================================

// ================================================================
// Data loading
// ================================================================
async function loadAllData() {
  prefetchArrowImages(); // ページ読み込み時に矢印画像を事前取得（fire-and-forget）
  try {
    const [dataRes, imgRes, cafRes, evRes] = await Promise.all([
      fetch(`${API_BASE}/api/all`),
      fetch(`${API_BASE}/api/edge_images`),
      fetch(`${API_BASE}/api/cafeterias`),
      EVENT_MODE ? fetch(`${API_BASE}/api/events`) : Promise.resolve(null),
    ]);
    if (dataRes.ok) {
      const data = await dataRes.json();
      allNodes = data.nodes || [];
      initBuildingNames(data.buildings || []);
      initRoomData(data.rooms || []);
    } else {
      console.warn("API unavailable — room autocomplete disabled");
    }
    // イベントモード: イベント名（屋台など）を検索候補プールに追加
    if (evRes && evRes.ok) {
      const events = await evRes.json();
      events.forEach(ev => allRooms.push({
        room: ev.title, display: ev.title, building: ev.building, isEvent: true,
      }));
    }
    if (imgRes.ok) edgeImages = await imgRes.json();
    if (cafRes.ok) {
      const cafList = await cafRes.json();
      const sel = document.getElementById("fac-cafeteria-name");
      cafList.forEach(c => {
        const opt = document.createElement("option");
        opt.value       = c.name;
        opt.textContent = `${c.display_name}(${bldgLabel(c.building)})`;
        sel.appendChild(opt);
      });
    }
  } catch {
    console.warn("API unavailable — room autocomplete disabled");
  }
  applyUrlParams();
}

// Google Maps の読み込み完了（initMap）を待たず、ページ読み込み直後に教室一覧を取得する。
// loadAllData は google.maps を一切参照しないため、Mapsの初期化と切り離して問題ない。
loadAllData();

// ================================================================
// URL パラメータからの検索プリセット（イベント誘導・QRコード用）
//   ?to=131&to_bldg=1                     → 目的地だけ入力済みの状態で開く
//   ?from=101A&from_bldg=10&to=131&to_bldg=1 → 自動でルート検索して表示
//   &elevator=0                           → エレベーター不使用
//   &mode=gps                             → 現在地(屋外)タブで目的地入力済み
// 号館(_bldg)は教室名が1つの号館にしか無い場合は省略可
// ================================================================
function applyUrlParams() {
  const q    = new URLSearchParams(location.search);
  const to   = q.get("to");
  const from = q.get("from");
  if (!to && !from) return;

  const toBldg   = q.get("to_bldg")   || q.get("to_building")   || "";
  const fromBldg = q.get("from_bldg") || q.get("from_building") || "";

  // select は該当 option がある場合のみ反映（API未取得時は空のまま）
  const setSelect = (id, val) => {
    const sel = document.getElementById(id);
    if (!sel || !val) return;
    if ([...sel.options].some(o => o.value === val)) sel.value = val;
  };

  setCategory("room");
  if (q.get("elevator") === "0") document.getElementById("use-elevator").checked = false;

  // 現在地(屋外)モード: 目的地だけ埋めて GPS 取得はユーザー操作に任せる
  if (q.get("mode") === "gps") {
    setMode("gps");
    if (to) {
      document.getElementById("to-input-gps").value = to;
      setSelect("gps-to-bldg", toBldg);
      const info = resolveRoom("to-input-gps", "gps-to-bldg");
      if (info && info !== "ambiguous") setSelect("gps-to-bldg", String(info.building));
    }
    document.getElementById("step-label").textContent = "現在地を取得してルート検索してください";
    if (to) document.getElementById("step-count").textContent = `目的地: ${to}`;
    return;
  }

  setMode("room");
  if (to) {
    document.getElementById("to-input").value = to;
    setSelect("to-bldg", toBldg);
  }
  if (from) {
    document.getElementById("from-input").value = from;
    setSelect("from-bldg", fromBldg);
  }

  // 号館未指定でも教室名から一意に決まる場合は select に反映
  const toInfo   = to   ? resolveRoom("to-input",   "to-bldg")   : null;
  const fromInfo = from ? resolveRoom("from-input", "from-bldg") : null;
  if (toInfo   && toInfo   !== "ambiguous") setSelect("to-bldg",   String(toInfo.building));
  if (fromInfo && fromInfo !== "ambiguous") setSelect("from-bldg", String(fromInfo.building));

  // 出発・目的の両方が確定していれば自動でルート検索
  if (fromInfo && fromInfo !== "ambiguous" && toInfo && toInfo !== "ambiguous") {
    doSearch();
    return;
  }

  // 目的地だけ確定 → 出発教室の入力を促す
  if (to && !from) {
    document.getElementById("step-label").textContent = "出発教室を入力してルート検索してください";
    document.getElementById("step-count").textContent =
      toInfo && toInfo !== "ambiguous" ? `目的地: ${bldgLabel(toInfo.building)} ${toInfo.display}` : `目的地: ${to}`;
  }
}

function bldgLabel(b) {
  return buildingNames[Number(b)] || (Number(b) === 0 ? "屋外" : `${b}号館`);
}

function initBuildingNames(buildings) {
  buildingNames = {};
  buildings.forEach(b => { buildingNames[Number(b.id)] = b.display_name; });
}

function initRoomData(rooms) {
  allRooms = rooms.map(r => ({ room: r.room, display: r.display || r.room, building: r.building }));
  roomsByBuilding = {};
  rooms.forEach(r => {
    const key = String(r.building);
    if (!roomsByBuilding[key]) roomsByBuilding[key] = [];
    roomsByBuilding[key].push(r.room);
  });

  const buildings = Object.keys(roomsByBuilding).sort((a, b) => Number(a) - Number(b));
  ["from-bldg", "to-bldg", "gps-to-bldg", "fac-from-bldg"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    buildings.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = bldgLabel(b);
      sel.appendChild(opt);
    });
  });

  setupAutocomplete("from-input",   "from-sugg",   "from-bldg");
  setupAutocomplete("to-input",     "to-sugg",     "to-bldg");
  setupAutocomplete("to-input-gps", "gps-to-sugg", "gps-to-bldg");
  setupAutocomplete("fac-from-input", "fac-from-sugg", "fac-from-bldg");

  [["from-bldg", "from-input"], ["to-bldg", "to-input"], ["gps-to-bldg", "to-input-gps"], ["fac-from-bldg", "fac-from-input"]].forEach(([bId, iId]) => {
    const sel = document.getElementById(bId);
    if (sel) sel.addEventListener("change", () => {
      const inp = document.getElementById(iId);
      if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input")); }
    });
  });
}
```

### `programs/html/navi/script/search-form.js`

```javascript
// ================================================================
// search-form.js
// 検索フォーム（オートコンプリート・教室/設備の切り替え・検索パネルの開閉）。
// ================================================================

// ================================================================
// Custom autocomplete
// ================================================================
function setupAutocomplete(inputId, suggId, bldgSelectId) {
  const input = document.getElementById(inputId);
  const sugg  = document.getElementById(suggId);
  const bldg  = document.getElementById(bldgSelectId);
  if (!input || !sugg) return;

  function getMatches(q) {
    const selectedBldg = bldg ? bldg.value : "";
    const query = q.trim().toLowerCase();
    let candidates = selectedBldg
      ? allRooms.filter(r => String(r.building) === selectedBldg)
      : allRooms;
    if (query) candidates = candidates.filter(r =>
      r.room.toLowerCase().includes(query) || r.display.toLowerCase().includes(query));
    return candidates.slice(0, 20);
  }

  function renderSugg(matches) {
    const selectedBldg = bldg ? bldg.value : "";
    sugg.innerHTML = "";
    if (!matches.length) { sugg.style.display = "none"; return; }
    matches.forEach(r => {
      const item = document.createElement("div");
      item.className = "item";
      const label = r.isEvent ? `\u{1F3AA} ${r.display}` : r.display;
      item.textContent = selectedBldg ? label : `${bldgLabel(r.building)} ${label}`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        input.value = r.display;
        if (bldg && !bldg.value) bldg.value = String(r.building);
        sugg.style.display = "none";
      });
      sugg.appendChild(item);
    });
    sugg.style.display = "block";
  }

  input.addEventListener("input", () => {
    if (input.value.length === 0) { sugg.style.display = "none"; return; }
    renderSugg(getMatches(input.value));
  });
  input.addEventListener("focus", () => {
    if (input.value.length >= 1) renderSugg(getMatches(input.value));
  });
  input.addEventListener("blur", () => { sugg.style.display = "none"; });
}

// ================================================================
// Room resolution
// ================================================================
function swapFromTo() {
  const fromBldg = document.getElementById("from-bldg");
  const toBldg   = document.getElementById("to-bldg");
  const fromInp  = document.getElementById("from-input");
  const toInp    = document.getElementById("to-input");
  [fromBldg.value, toBldg.value] = [toBldg.value, fromBldg.value];
  [fromInp.value,  toInp.value]  = [toInp.value,  fromInp.value];
  document.getElementById("from-sugg").style.display = "none";
  document.getElementById("to-sugg").style.display = "none";
}

// ================================================================
function resolveRoom(inputId, bldgSelectId) {
  const inputEl = document.getElementById(inputId);
  const bldgEl  = document.getElementById(bldgSelectId);
  if (!inputEl) return null;
  const roomQuery = inputEl.value.trim();
  const bldgVal   = bldgEl ? bldgEl.value : "";
  if (!roomQuery) return null;
  // 生の名前 (room) と表示名 (display) のどちらで入力されてもマッチさせる
  let matches;
  if (bldgVal) {
    matches = allRooms.filter(r => String(r.building) === bldgVal
      && (r.room === roomQuery || r.display === roomQuery));
  } else {
    matches = allRooms.filter(r => r.room === roomQuery || r.display === roomQuery);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1)   return "ambiguous";
  return matches[0];
}

// ================================================================
// Search mode toggle
// ================================================================
function setMode(mode) {
  if (mode !== searchMode) syncDestination(mode);
  searchMode = mode;
  document.getElementById("panel-room").style.display = mode === "room" ? "block" : "none";
  document.getElementById("panel-gps").style.display  = mode === "gps"  ? "block" : "none";
  document.getElementById("tab-room").classList.toggle("active", mode === "room");
  document.getElementById("tab-gps").classList.toggle("active",  mode === "gps");
  // タブ切り替え時にパネルが閉じていれば自動で開く
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// 「教室→教室」と「現在地→教室」で目的地欄は別 input のため、
// タブ切替時に切替元の値を切替先へコピーして1つの目的地として振る舞わせる
function syncDestination(toMode) {
  const [srcInp, srcBldg, dstInp, dstBldg] = toMode === "gps"
    ? ["to-input", "to-bldg", "to-input-gps", "gps-to-bldg"]
    : ["to-input-gps", "gps-to-bldg", "to-input", "to-bldg"];
  document.getElementById(dstInp).value = document.getElementById(srcInp).value;
  const src = document.getElementById(srcBldg);
  const dst = document.getElementById(dstBldg);
  if ([...dst.options].some(o => o.value === src.value)) dst.value = src.value;
}

function setFacMode(mode) {
  facSearchMode = mode;
  document.getElementById("panel-fac-room").style.display = mode === "room" ? "block" : "none";
  document.getElementById("panel-fac-gps").style.display  = mode === "gps"  ? "block" : "none";
  document.getElementById("fac-tab-room").classList.toggle("active", mode === "room");
  document.getElementById("fac-tab-gps").classList.toggle("active",  mode === "gps");
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// ================================================================
// Category toggle (教室 / 設備検索)
// ================================================================
function setCategory(cat) {
  document.getElementById("cat-content-room").style.display     = cat === "room"     ? "block" : "none";
  document.getElementById("cat-content-facility").style.display = cat === "facility" ? "block" : "none";
  document.getElementById("cat-room").classList.toggle("active",     cat === "room");
  document.getElementById("cat-facility").classList.toggle("active", cat === "facility");
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// ================================================================
// Facility autocomplete
// ================================================================
// facSearchMode ("room"/"gps") から設備検索の出発地点を解決して params に埋め込む。
// 失敗時はエラーを alert して false を返す（呼び出し元はそのまま return する）。
function resolveFacFromParams(params) {
  if (facSearchMode === "room") {
    const fromInfo = resolveRoom("fac-from-input", "fac-from-bldg");
    if (!fromInfo)               { alert("出発教室を入力してください。"); return false; }
    if (fromInfo === "ambiguous") { alert("出発教室が複数の号館に存在します。号館を指定してください。"); return false; }
    if (fromInfo.isEvent) {
      params.set("from_event", fromInfo.room);
    } else {
      params.set("from_room",     fromInfo.room);
      params.set("from_building", fromInfo.building);
    }
  } else {
    if (!facGpsCoords) { alert("GPS位置を先に取得してください。"); return false; }
    const nearest = findNearestNode(facGpsCoords.lat, facGpsCoords.lng);
    if (!nearest) { alert("近くの出発ノードが見つかりません。\nキャンパスから離れすぎている可能性があります。"); return false; }
    params.set("from_node", nearest.id);
  }
  return true;
}

// 検索APIを叩いてルート表示まで行う共通処理（doSearch / doToiletSearch / doCafeteriaSearch で共用）
// 経路描画は屋外区間があると google.maps.Polyline/Marker を使うため、地図の初期化を待つ。
async function fetchRouteAndNavigate(url) {
  await waitForMapReady();
  setLoading(true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) { alert("エラー: " + data.error); return; }
    await initRoute(data.path_coords, data.path_edges, {
      side: data.dest_side, position: data.dest_position, count: data.dest_count,
      display: data.dest_display, nearestDisplay: data.dest_nearest_display,
    });
  } catch {
    document.getElementById("step-label").textContent = "サーバーに接続できません";
    document.getElementById("step-count").textContent = "app.py が起動しているか確認してください";
  } finally {
    setLoading(false);
  }
}

async function doToiletSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams({
    type:         document.getElementById("fac-toilet-type").value,
    use_elevator: document.getElementById("fac-use-elevator").checked ? "1" : "0",
  });
  if (!resolveFacFromParams(params)) return;
  await fetchRouteAndNavigate(`${API_BASE}/api/nearest_toilet?${params}`);
}

function onFacCategoryChange() {
  const cat = document.getElementById("fac-category").value;
  document.getElementById("fac-toilet-type").style.display    = cat === "toilet"    ? "" : "none";
  document.getElementById("fac-cafeteria-name").style.display = cat === "cafeteria" ? "" : "none";
}

function doFacSearch() {
  const cat = document.getElementById("fac-category").value;
  if (cat === "cafeteria") doCafeteriaSearch();
  else doToiletSearch();
}

async function doCafeteriaSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams({
    use_elevator: document.getElementById("fac-use-elevator").checked ? "1" : "0",
    name:         document.getElementById("fac-cafeteria-name").value,
  });
  if (!resolveFacFromParams(params)) return;
  await fetchRouteAndNavigate(`${API_BASE}/api/nearest_cafeteria?${params}`);
}

// ================================================================
// Search panel slide toggle (mobile only)
// ================================================================
let searchPanelOpen = true;

function toggleSearchPanel() {
  searchPanelOpen = !searchPanelOpen;
  const content = document.getElementById("search-content");
  const inner   = document.querySelector(".search-content-inner");
  const chevron = document.getElementById("search-chevron");

  if (searchPanelOpen) {
    content.classList.add("open");
    chevron.classList.add("open");
    // アニメーション完了後に overflow を解除してサジェストを表示可能にする
    content.addEventListener("transitionend", () => {
      inner.style.overflow = "";
    }, { once: true });
  } else {
    inner.style.overflow = "hidden";
    content.classList.remove("open");
    chevron.classList.remove("open");
  }
}

function collapseSearchPanel() {
  if (!searchPanelOpen || window.innerWidth >= 768) return;
  const content = document.getElementById("search-content");
  const inner   = document.querySelector(".search-content-inner");
  const chevron = document.getElementById("search-chevron");
  inner.style.overflow = "hidden";
  content.classList.remove("open");
  chevron.classList.remove("open");
  searchPanelOpen = false;
}
```

### `programs/html/navi/script/gps.js`

```javascript
// ================================================================
// gps.js
// 現在地の取得と、現在地からの最寄りノード・方位の計算。
// ================================================================

// ================================================================
// GPS
// ================================================================
function captureGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("gps-text").textContent = "取得中...";
  hideAccuracyWarn();
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      gpsCoords = { lat, lng };
      document.getElementById("gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      showAccuracyWarn(accuracy);
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function captureFacGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("fac-gps-text").textContent = "取得中...";
  const warn = document.getElementById("fac-accuracy-warn");
  warn.style.display = "none"; warn.className = "";
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      facGpsCoords = { lat, lng };
      document.getElementById("fac-gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      if (accuracy > 30) {
        warn.style.display = "block"; warn.className = "warn-low";
        warn.innerHTML = `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>`
          + `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
      }
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("fac-gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function renderGpsOnMap(lat, lng, accuracy) {
  if (gpsMarker) gpsMarker.setMap(null);
  gpsMarker = new google.maps.Marker({
    position: { lat, lng }, map,
    title: "現在地",
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 9,
      fillColor: "#4285F4", fillOpacity: 1,
      strokeColor: "white", strokeWeight: 2.5,
    },
    zIndex: 5,
  });
  if (gpsCircle) gpsCircle.setMap(null);
  gpsCircle = new google.maps.Circle({
    center: { lat, lng }, radius: accuracy, map,
    fillColor: "#4285F4", fillOpacity: 0.08,
    strokeColor: "#4285F4", strokeOpacity: 0.3, strokeWeight: 1.5,
  });
  switchView("map");
  map.panTo({ lat, lng });
}

function showAccuracyWarn(accuracy) {
  const el = document.getElementById("accuracy-warn");
  if (accuracy <= 30) { hideAccuracyWarn(); return; }
  el.style.display = "block";
  el.className = "warn-low";
  el.innerHTML =
    `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>` +
    `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
}

function hideAccuracyWarn() {
  const el = document.getElementById("accuracy-warn");
  el.style.display = "none";
  el.className = "";
}

// 最寄り屋外ノードがこの距離[m]より遠い場合はキャンパス外とみなして null を返す
const MAX_GPS_NODE_DIST_M = 500;

function findNearestNode(lat, lng) {
  const outdoor = allNodes.filter(n => n.building === 0 && n.lat != null && n.lng != null);
  if (!outdoor.length) return null;
  let best = null, bestD = Infinity;
  outdoor.forEach(n => {
    const d = haversine({ lat, lng }, { lat: n.lat, lng: n.lng });
    if (d < bestD) { bestD = d; best = n; }
  });
  return bestD <= MAX_GPS_NODE_DIST_M ? best : null;
}

function haversine(a, b) {
  const R = 6371000;
  const dφ = (b.lat - a.lat) * Math.PI / 180;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const s  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ================================================================
// Route heading
// ================================================================
function calcRouteHeading(step) {
  const cur = pathCoords[step];
  if (!cur || cur.lat == null) return null;
  for (let i = step + 1; i < pathCoords.length; i++) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(cur.lat, cur.lng, n.lat, n.lng);
  }
  for (let i = step - 1; i >= 0; i--) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(n.lat, n.lng, cur.lat, cur.lng);
  }
  return null;
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dl   = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
```

### `programs/html/navi/script/route.js`

```javascript
// ================================================================
// route.js
// ルート検索の実行と、ステップ送り（ナビゲーションの中心）。
// ================================================================

// ================================================================
// Search
// ================================================================
async function doSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams();
  params.set("use_elevator", document.getElementById("use-elevator").checked ? "1" : "0");

  if (searchMode === "room") {
    const fromInfo = resolveRoom("from-input", "from-bldg");
    const toInfo   = resolveRoom("to-input",   "to-bldg");
    if (!fromInfo)              { alert("出発教室を入力してください。"); return; }
    if (fromInfo === "ambiguous") { alert("出発教室が複数の号館に存在します。号館を指定してください。"); return; }
    if (!toInfo)                { alert("目的教室を入力してください。"); return; }
    if (toInfo   === "ambiguous") { alert("目的教室が複数の号館に存在します。号館を指定してください。"); return; }
    if (fromInfo.isEvent) {
      params.set("from_event", fromInfo.room);
    } else {
      params.set("from_room",     fromInfo.room);
      params.set("from_building", fromInfo.building);
    }
    if (toInfo.isEvent) {
      params.set("to_event", toInfo.room);
    } else {
      params.set("to_room",       toInfo.room);
      params.set("to_building",   toInfo.building);
    }
  } else {
    if (!gpsCoords) { alert("GPS位置を先に取得してください。"); return; }
    const toInfo = resolveRoom("to-input-gps", "gps-to-bldg");
    if (!toInfo)              { alert("目的教室を入力してください。"); return; }
    if (toInfo === "ambiguous") { alert("目的教室が複数の号館に存在します。号館を指定してください。"); return; }
    const nearest = findNearestNode(gpsCoords.lat, gpsCoords.lng);
    if (!nearest) { alert("近くの出発ノードが見つかりません。\nキャンパスから離れすぎている可能性があります。"); return; }
    params.set("from_node",   nearest.id);
    if (toInfo.isEvent) {
      params.set("to_event", toInfo.room);
    } else {
      params.set("to_room",     toInfo.room);
      params.set("to_building", toInfo.building);
    }
  }

  await fetchRouteAndNavigate(`${API_BASE}/api/route?${params}`);
}

function setLoading(on) {
  document.getElementById("loading").classList.toggle("show", on);
}

// ================================================================
// SVG prefetch — ルート上の全フロアのSVGをまとめて取得してメモリキャッシュ。
// オフライン時でも loadSvg がキャッシュから即座に返せるようにする。
// ================================================================
async function prefetchSvgs(coords) {
  const keys = new Set();
  coords.forEach(n => {
    if (n.building !== 0) keys.add(`${n.building}_${n.floor}`);
  });

  await Promise.allSettled([...keys].map(async key => {
    if (svgCache[key] !== undefined) return; // すでにキャッシュ済み
    const [building, floor] = key.split('_');
    try {
      const res = await fetch(`/svg/${building}_${floor}F.svg`);
      svgCache[key] = res.ok ? await res.text() : null;
    } catch {
      svgCache[key] = null;
    }
  }));
}

// ================================================================
// Route init
// ================================================================
async function initRoute(coords, edges, destInfo = {}) {
  pathCoords  = coords;
  pathEdges   = edges || [];
  destSide          = destInfo.side || "";
  destPosition       = destInfo.position ?? null;
  destCount          = destInfo.count ?? null;
  destDisplay        = destInfo.display || "";
  destNearestDisplay = destInfo.nearestDisplay || "";
  currentStep = 0;
  svgBuilding = null;
  svgFloor    = null;
  svgOverlay  = null;
  arMarkersBuilt = false;
  arHideView();
  arPrefetchCameraIfNeeded();  // 屋外AR区間がある場合のみカメラを先取り
  clearMapOverlays();
  drawFullOutdoorRoute();
  prefetchRouteImages(coords);               // 写真: 並行ダウンロード開始（fire-and-forget）
  await prefetchSvgs(coords);               // SVG:  全フロア一括取得を待機してからナビ開始
  collapseSearchPanel();  // ルート確定後にパネルを収納
  goToStep(0, { announce: true });
}

// ================================================================
// Step navigation
// ================================================================
// announce: trueの時だけ音声案内を読み上げる。前進(nextStep/ルート開始直後)のときのみ
// trueにする。戻る操作では「右に曲がってください」等が実際の進行方向と逆で誤りになるため読み上げない。
async function goToStep(step, { announce = false } = {}) {
  currentStep = step;
  const node  = pathCoords[step];
  updateNavBar(node, step, pathCoords.length);
  updateRouteImage(step);
  if (announce) speak(buildStepAnnouncement(step));
  if (!node) return;

  // 現在以降にARを使う屋外区間が残っていなければカメラ・GPSを解放する
  releaseArIfUnneeded(step);

  if (node.building === 0 && node.lat != null) {
    switchView("map");
    moveMapTo(node, step);
  } else if (node.building !== 0) {
    switchView("svg");
    if (node.building !== svgBuilding || node.floor !== svgFloor) {
      svgBuilding = node.building;
      svgFloor    = node.floor;
      await loadSvg(node.building, node.floor);
      drawSvgBaseRoute(node.building, node.floor);
    }
    renderSvgStep(step);
  }

  // Three.js AR のルートカラーを更新
  if (arMarkersBuilt) arUpdateRouteColors(step);

  // 最終ステップ（目的地エッジ上・「この辺です」表示区間）に到達したら
  // 一定時間後に完了モーダルを表示
  if (step === pathCoords.length - 2) {
    clearTimeout(window._completionTimer);
    window._completionTimer = setTimeout(showCompletionModal, 3000); // ← 秒数はここで調整（ミリ秒）
  } else {
    clearTimeout(window._completionTimer);
  }
}

// 最終ノード（画像のない到着ステップ）へは進まない。
// 目的地エッジを歩く「この辺です」区間（length-2）がナビの最終ステップ。
function prevStep() { if (currentStep > 0) goToStep(currentStep - 1); }
function nextStep() { if (currentStep < pathCoords.length - 2) goToStep(currentStep + 1, { announce: true }); }

// ================================================================
// AR ハードウェア解放判定
// 屋外→屋内→屋外と続くルートの途中ではストリームを保持して
// シームレスに切り替え、屋外区間を使い切ったら解放する。
// （最終ステップは到着画面なので AR 不要とみなす）
// ================================================================
function releaseArIfUnneeded(step) {
  for (let i = step; i < pathCoords.length - 1; i++) {
    const n = pathCoords[i];
    if (n && n.building === 0 && n.lat != null) return; // まだARを使う
  }
  arReleaseHardware();
}
```

### `programs/html/navi/script/voice.js`

```javascript
// ================================================================
// voice.js
// 音声案内（読み上げのON/OFFと、各ステップの読み上げ文の組み立て）。
// ================================================================

// ================================================================
// 音声案内
//
// Web Speech API (SpeechSynthesis) をそのまま使う。バックエンドの変更は不要。
// 読み上げ文は「グライスの協調の原理」の4公理に沿うよう、以下の方針で組み立てる：
//   量:   そのステップで実際に必要な情報（曲がる方向・距離・エレベータ等の行き先階）だけを言う。
//         距離がANNOUNCE_DISTANCE_THRESHOLD_M未満など無意味なほど短い直進は何も言わない（言っても情報にならない）。
//   質:   実際のデータ（計算済みの距離・曲がる方向・ノードのfloor）にない内容は言わない。
//         教室名も、値がある場合のみ言う（無ければ言わない。それらしい名前を作らない）。
//   関係: 今のステップの行動に関係ない情報は省く。入口（type 7・距離0）の連結エッジは無音。
//         エレベータ/階段/エスカレータが複数の区間に分かれていても、同じ移動の途中は繰り返さない。
//   様態: 曖昧さを避け（「右」「左」を明言）、簡潔で、毎回同じ語順（方向→距離）で話す。
// ================================================================
let voiceGuideEnabled = localStorage.getItem("navi_voice_guide") === "1";

const VERTICAL_LABELS = { "2": "階段", "3": "エスカレーター", "4": "エレベーター", "5": "エスカレーター", "6": "エスカレーター" };
const ANNOUNCE_DISTANCE_THRESHOLD_M = 10; // これ未満の直進距離は案内しない（曲がる場合は距離を省いて方向だけ言う）

function updateVoiceToggleUI() {
  const btn = document.getElementById("voice-toggle-btn");
  if (!btn) return;
  btn.textContent = voiceGuideEnabled ? "\u{1F50A}" : "\u{1F507}"; // 🔊 / 🔇
  btn.classList.toggle("active", voiceGuideEnabled);
  btn.setAttribute("aria-pressed", String(voiceGuideEnabled));
}
updateVoiceToggleUI();

function toggleVoiceGuide() {
  voiceGuideEnabled = !voiceGuideEnabled;
  localStorage.setItem("navi_voice_guide", voiceGuideEnabled ? "1" : "0");
  updateVoiceToggleUI();
  if (!voiceGuideEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

function speak(text) {
  if (!voiceGuideEnabled || !text) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // 前の発話が残っていたら打ち切ってから話す（読み上げの重複防止）
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  window.speechSynthesis.speak(u);
}

/**
 * edge.right_display / edge.left_display（進行方向に対して右手・左手にある教室の読み上げ用表示名。
 * サーバー側で name.csv・トイレ種別に応じて解決済み、生のroom codeではない）から
 * 「右手に101教室、左手に102教室があります」のような一言を組み立てる。
 * どちらも無ければ空文字（呼び出し側は従来通りの案内文にフォールバックする）。
 */
function buildSidePhrase(edge) {
  // *_display はサーバー側でname.csv・トイレ表記に解決済みの表示名（"M_Toilet"ではなく"男子トイレ"等）。
  // 未提供の古いレスポンス形式向けに、生のright/leftの先頭要素へフォールバックする。
  const r = edge.right_display || (edge.right || "").split(";")[0].trim();
  const l = edge.left_display  || (edge.left  || "").split(";")[0].trim();
  if (r && l) return `右手に${r}、左手に${l}があります`;
  if (r) return `右手に${r}があります`;
  if (l) return `左手に${l}があります`;
  return "";
}

/**
 * 目的地バッジ・到着時の音声案内で共通して使う文言を決める。
 * まずAPIが返す destSide（サーバー側で、検索時に指定した実際の目的地名を最終区間の
 * right/left列と厳密照合して判定済み）を見る。"right"/"left" が取れていれば、
 * destDisplay（目的地自体の表示名）・destPosition/destCount（right/leftは手前から奥への
 * 物理的な並び順を持つ列なので、そのままそこでの目的地の順位が「手前から数えてN番目」になる）・
 * destNearestDisplay（一番手前の教室の表示名）を使って具体的な文を組み立てる。
 * ただし、目的地がその側で一番手前（＝destPosition===1）の場合や、その側に他に教室が無い
 * （destCount<=1）場合は「〜から数えて1番目です」という自明な言い回しを避け、単に
 * 「<目的地>は右手です」のように言う。
 * destSideが無い（"" ＝ ノード指定・イベント指定など目的教室名が無い、または
 * このエッジのright/leftどちらにも一致しなかった）場合のみ、最終区間のright_display/
 * left_displayを見て「片方だけ設定されていればその側とみなす」簡易フォールバックを使う
 * （このエッジに複数の部屋が面していてどちらが目的地か特定できない場合は汎用文言のまま）。
 */
function buildNearGoalText(edge) {
  const FALLBACK = "この通路沿いが目的地周辺です";
  if (destSide === "right" || destSide === "left") {
    const sideText = destSide === "right" ? "右手" : "左手";
    const name = destDisplay || "目的地";
    if (destCount > 1 && destPosition > 1) {
      return `${name}は${sideText}、${destNearestDisplay}から数えて${destPosition}番目です`;
    }
    return `${name}は${sideText}です`;
  }
  if (!edge) return FALLBACK;
  const r = edge.right_display || (edge.right || "").split(";")[0].trim();
  const l = edge.left_display  || (edge.left  || "").split(";")[0].trim();
  if (r && !l) return "右手に目的地です";
  if (l && !r) return "左手に目的地です";
  return FALLBACK;
}

/**
 * pathCoords[step] → pathCoords[step+1] の区間（pathEdges[step]）についての案内文を組み立てる。
 * 階段/エレベータ/エスカレータは複数の区間にまたがることがあるため、同種の区間が連続する
 * 最初のステップでのみ「○階まで」を案内し、続きのステップでは何も言わない。
 */
function buildStepAnnouncement(step) {
  const edge = pathEdges[step];
  if (!edge) return "";
  const type = String(edge.type ?? "1");
  if (type === "7") return ""; // 屋内外の連結エッジ（距離0）は案内する内容が無い

  if (VERTICAL_LABELS[type]) {
    const prevType = step > 0 ? String(pathEdges[step - 1]?.type ?? "") : null;
    if (prevType === type) return ""; // 同じ階段/EV/ESCの続き番目のステップ：繰り返さない

    let end = step;
    while (end + 1 < pathEdges.length && String(pathEdges[end + 1]?.type ?? "") === type) end += 1;
    const fromFloor = pathCoords[step]?.floor;
    const toFloor   = pathCoords[end + 1]?.floor;
    const label = VERTICAL_LABELS[type];
    if (fromFloor == null || toFloor == null || fromFloor === toFloor) return `${label}で移動します`;
    return toFloor > fromFloor
      ? `${label}で${toFloor}階まで上がってください`
      : `${label}で${toFloor}階まで下りてください`;
  }

  // 最終区間（目的地エッジ上を歩く「この辺です」区間）
  if (step === pathCoords.length - 2) {
    // dest_sideが判定できている場合は「<目的地>は右手、<手前>から数えてN番目です」を読み上げる。
    // 判定できない場合は従来通り「<name>の付近です」にフォールバックする。
    if (destSide === "right" || destSide === "left") {
      return `まもなく到着します。${buildNearGoalText(edge)}`;
    }
    const name = edge.name_display || (edge.name || "").split(";")[0].trim();
    return name ? `まもなく到着します。${name}の付近です` : "まもなく目的地に到着します";
  }

  const dir  = calcTurnDirection(step);
  const dist = Math.round(edge.length || 0);
  const side = buildSidePhrase(edge); // right/leftが無ければ""（従来の運用のまま）

  if (dir === "right" || dir === "left") {
    const dirText = dir === "right" ? "右に曲がって" : "左に曲がって";
    const base = dist >= ANNOUNCE_DISTANCE_THRESHOLD_M ? `${dirText}${dist}メートル先です` : `${dirText}ください`;
    return side ? `${base}。${side}` : base;
  }
  if (dist >= ANNOUNCE_DISTANCE_THRESHOLD_M) {
    return side ? `${dist}メートル直進です。${side}` : `${dist}メートル直進です`;
  }
  // 距離が短い直進は従来省略していたが、右左に目印があるなら短くてもそれだけ案内する
  return side;
}
```

### `programs/html/navi/script/photo.js`

```javascript
// ================================================================
// photo.js
// AR領域の経路写真と、進行方向の矢印。
// ================================================================

// ================================================================
// Route image (AR area) — active クラスの付け替えで表示切り替え
// 屋外ステップは AR カメラビューを表示、屋内は写真 or プレースホルダー
// ================================================================
function updateRouteImage(step) {
  const label  = document.getElementById("ar-label");
  const phEl   = document.getElementById("ar-placeholder");
  const node   = pathCoords[step];
  const next   = pathCoords[step + 1];
  const isLast = step >= pathCoords.length - 1;
  // 建物内最終ノード（次が屋外ノード＝出口エッジ）も屋外扱いにして、
  // 出口専用の連結写真を用意しなくてもそのままカメラARへ移行する。
  const entersOutdoor = !!next && next.building === 0 && next.lat != null;
  const isOutdoor = node && !isLast &&
    ((node.building === 0 && node.lat != null) || entersOutdoor);

  if (isOutdoor) {
    Object.values(imgByStep).forEach(img => img.classList.remove("active"));
    phEl.style.display  = "none";
    label.style.display = "none";
    document.getElementById("direction-arrow").style.display = "none";
    document.getElementById("near-goal-badge").style.display = "none";
    arShowView();
    return;
  }

  arHideView();
  Object.values(imgByStep).forEach(img => img.classList.remove("active"));

  const img = imgByStep[step];

  if (img && !isLast) {
    img.classList.add("active");
    phEl.style.display  = "none";
    label.style.display = "block";
    phEl.classList.remove("arrival");
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "none");
    phEl.querySelector(".ph-text").style.display = "";
  } else if (isLast) {
    phEl.style.display  = "flex";
    label.style.display = "none";
    phEl.classList.add("arrival");
    phEl.querySelector(".ph-text").style.display = "none";
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "");
  } else {
    phEl.style.display  = "flex";
    label.style.display = "none";
    phEl.classList.remove("arrival");
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "none");
    phEl.querySelector(".ph-text").style.display = "";
  }
  updateDirectionArrow(step);
}

// ================================================================
// 方向矢印: ターン方向の計算
// step区間の画像(node[step] → node[step+1])を表示中に、
// node[step+1]到着時の進む方向を計算して矢印を更新する。
// ================================================================
function calcTurnDirection(step) {
  // pathCoords[step+2] が存在しない最終アプローチ区間は直進とみなす
  if (step >= pathCoords.length - 2) return "straight";

  const prev = pathCoords[step];
  const cur  = pathCoords[step + 1];
  const next = pathCoords[step + 2];

  // --- 屋外: 緯度経度から方位角を計算 ---
  if (prev.lat != null && cur.lat != null && next.lat != null) {
    const inBearing  = bearingDeg(prev.lat, prev.lng, cur.lat, cur.lng);
    const outBearing = bearingDeg(cur.lat, cur.lng, next.lat, next.lng);
    const turnDeg = ((outBearing - inBearing + 540) % 360) - 180;
    if (Math.abs(turnDeg) <= STRAIGHT_THRESHOLD_DEG) return "straight";
    return turnDeg > 0 ? "right" : "left";
  }

  // --- 屋内: SVG座標から角度を計算（Y軸は下向き正）---
  // エスカレータ・階段の遷移ノードは svg_x/svg_y が未設定の場合がある。
  // その場合は前後方向にスキャンして有効な座標を持つ最近傍ノードを使う。
  // 有効なノードが見つからなければ直進とみなす（階移動は直進がほぼ確実）。
  let prevIdx = step;
  while (prevIdx >= 0                  && pathCoords[prevIdx].svg_x == null) prevIdx--;
  let curIdx  = step + 1;
  while (curIdx  < pathCoords.length   && pathCoords[curIdx].svg_x  == null) curIdx++;
  let nextIdx = curIdx + 1;
  while (nextIdx < pathCoords.length   && pathCoords[nextIdx].svg_x == null) nextIdx++;

  if (prevIdx < 0 || curIdx >= pathCoords.length || nextIdx >= pathCoords.length) {
    return "straight";
  }

  const p = pathCoords[prevIdx];
  const c = pathCoords[curIdx];
  const n = pathCoords[nextIdx];

  // 異なるフロア・建物間ではSVG座標系が別物なので比較不能 → 直進とみなす
  if (p.building !== c.building || p.floor !== c.floor ||
      c.building !== n.building || c.floor !== n.floor) {
    return "straight";
  }

  const inAngle  = Math.atan2(c.svg_y - p.svg_y, c.svg_x - p.svg_x) * 180 / Math.PI;
  const outAngle = Math.atan2(n.svg_y - c.svg_y, n.svg_x - c.svg_x) * 180 / Math.PI;
  const turnDeg  = ((outAngle - inAngle + 540) % 360) - 180;

  // STRAIGHT_THRESHOLD_DEG 以内なら直進、それ以上は左右折
  if (Math.abs(turnDeg) <= STRAIGHT_THRESHOLD_DEG) return "straight";
  return turnDeg > 0 ? "right" : "left";
}

function updateDirectionArrow(step) {
  const arrowEl = document.getElementById("direction-arrow");
  const nearEl  = document.getElementById("near-goal-badge");
  if (!arrowEl) return;

  // 最終区間（目的地エッジを歩く区間）は矢印だと「まだ先へ進む」と誤解されるため、
  // 矢印の代わりに「目的地周辺です」バッジを表示する
  const isFinalSegment = step === pathCoords.length - 2;
  if (nearEl) {
    nearEl.style.display = isFinalSegment ? "block" : "none";
    if (isFinalSegment) nearEl.textContent = buildNearGoalText(pathEdges[step]);
  }
  if (isFinalSegment) {
    arrowEl.style.display = "none";
    return;
  }

  // 画像が存在する区間でのみ矢印を表示
  const img = imgByStep[step];
  if (!img || step >= pathCoords.length - 1) {
    arrowEl.style.display = "none";
    return;
  }

  const dir = calcTurnDirection(step);
  if (!dir) {
    arrowEl.style.display = "none";
    return;
  }

  arrowEl.src = arrowBlobUrls[dir] || ARROW_URL[dir];
  arrowEl.style.display = "block";
}

// ================================================================
// Route image prefetch — ルート確定時に全画像を DOM に積む。
// HTTP キャッシュ設定に依存しない（同一 DOM 要素を使い回す）。
// ================================================================
function prefetchRouteImages(coords) {
  const container = document.getElementById("ar-cache");
  container.innerHTML = "";
  imgByStep = {};

  for (let i = 0; i < coords.length - 1; i++) {
    const url = edgeImages[`${coords[i].id}_${coords[i + 1].id}`];
    if (!url) continue;
    const img = document.createElement("img");
    img.className = "ar-cached-img";
    img.src = url;
    container.appendChild(img);
    imgByStep[i] = img;
  }
}
```

### `programs/html/navi/script/map.js`

```javascript
// ================================================================
// map.js
// 屋外の Google Maps 表示（初期化・経路ポリライン・現在ステップのマーカー）。
// ================================================================

// ================================================================
// Google Maps init
// ================================================================
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 17,
    center: { lat: 35.61035, lng: 139.55466 },
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: true,
  });
  mapReady = true;
  if (_pendingMapCallback) {
    const fn = _pendingMapCallback;
    _pendingMapCallback = null;
    fn();
  }
}

function clearMapOverlays() {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];
  if (stepMarker) { stepMarker.setMap(null); stepMarker = null; }
}

function drawFullOutdoorRoute() {
  updateOutdoorPolylines(0);
}

function updateOutdoorPolylines(step) {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];

  let seg = [], segIdx = [];

  const flush = () => {
    if (seg.length < 2) { seg = []; segIdx = []; return; }

    let splitAt = -1;
    for (let i = segIdx.length - 1; i >= 0; i--) {
      if (segIdx[i] <= step) { splitAt = i; break; }
    }

    // 通過済み（グレー）
    if (splitAt > 0) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(0, splitAt + 1).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: "#9E9E9E", strokeOpacity: 0.5, strokeWeight: 5, geodesic: true, map,
      }));
    }

    // これから（青）。通過済み末尾ノードを共有して線を繋ぐ
    const aheadFrom = Math.max(0, splitAt);
    if (aheadFrom < seg.length - 1) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(aheadFrom).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: ACCENT_COLOR, strokeOpacity: 0.85, strokeWeight: 5, geodesic: true, map,
      }));
    }

    seg = []; segIdx = [];
  };

  pathCoords.forEach((n, idx) => {
    if (n.building === 0 && n.lat != null) { seg.push(n); segIdx.push(idx); }
    else flush();
  });
  flush();
}

// ================================================================
// Google Maps — step marker + route-direction heading
// ================================================================
function moveMapTo(node, step) {
  const pos = { lat: node.lat, lng: node.lng };
  if (!stepMarker) {
    stepMarker = new google.maps.Marker({
      position: pos, map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE, scale: 10,
        fillColor: "#EF4444", fillOpacity: 1,
        strokeColor: "white", strokeWeight: 2,
      },
      zIndex: 10,
    });
  } else {
    stepMarker.setPosition(pos);
  }
  updateOutdoorPolylines(step);
  const heading = calcRouteHeading(step);
  if (heading != null) map.setHeading(heading);
  map.setCenter(pos);
  map.setZoom(17);
}
```

### `programs/html/navi/script/floormap.js`

```javascript
// ================================================================
// floormap.js
// 屋内のSVGフロアマップ表示と、パン/ピンチズーム操作。
// ================================================================

// ================================================================
// SVG — load floor plan
// ================================================================
async function loadSvg(building, floor) {
  document.getElementById("floor-badge").textContent = `${bldgLabel(building)} ${floor}階`;
  const container = document.getElementById("svg-container");
  svgOverlay = null;

  const key = `${building}_${floor}`;
  let text = svgCache[key]; // プリフェッチ済みキャッシュを優先使用

  if (text === undefined) {
    // キャッシュ未命中（フォールバック: ネットから取得を試みる）
    try {
      const res = await fetch(`/svg/${building}_${floor}F.svg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      svgCache[key] = text;
    } catch {
      svgCache[key] = null;
      text = null;
    }
  }

  if (!text) {
    container.innerHTML = `
      <div class="err-box">
        <div class="err-title">${bldgLabel(building)} ${floor}階のマップが見つかりません</div>
        <div class="err-desc">このフロアのSVGデータはまだ登録されていません。</div>
        <div class="err-hint">◀ ▶ で他のステップに進んでください</div>
      </div>`;
    return;
  }

  container.innerHTML = text;
  const svgEl = container.querySelector("svg");
  if (!svgEl) return;

  svgOrigViewBox = { width: svgEl.viewBox.baseVal.width, height: svgEl.viewBox.baseVal.height };
  svgEl.style.width    = "100%";
  svgEl.style.height   = "100%";
  svgEl.setAttribute("overflow", "visible");   // オーバーレイ要素がクリップされないように
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

  svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svgOverlay.id = "route-overlay";
  svgOverlay.setAttribute("pointer-events", "none");
  svgEl.appendChild(svgOverlay);
}

// ================================================================
// SVG — base route (gray) + adaptive zoom
// ================================================================
function drawSvgBaseRoute(building, floor) {
  if (!svgOverlay) return;
  svgOverlay.innerHTML = "";

  const nodes = pathCoords.filter(n =>
    n.building === building && n.floor === floor && n.svg_x != null
  );

  const svgW = svgOrigViewBox?.width  || 2481;
  const svgH = svgOrigViewBox?.height || 1748;
  if (nodes.length >= 1) {
    const xs    = nodes.map(n => n.svg_x);
    const ys    = nodes.map(n => n.svg_y);
    const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 50);
    const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 50);
    svgViewW = Math.min(Math.max(spanX * 2.5, Math.min(900, svgW)), svgW);
    svgViewH = Math.min(Math.max(spanY * 2.5, Math.min(700, svgH)), svgH);
  } else {
    svgViewW = svgW;
    svgViewH = svgH;
  }

  if (nodes.length < 2) return;

  // 同じフロアを複数回通る場合に備え、pathCoords上で連続する区間ごとに
  // polyline を分割する。全ノードを1本に繋ぐと別訪問のノード間に
  // 不正な線が描画されてしまうため。
  const segments = [];
  let seg = [];
  for (const n of pathCoords) {
    if (n.building === building && n.floor === floor && n.svg_x != null) {
      seg.push(n);
    } else if (seg.length) {
      segments.push(seg);
      seg = [];
    }
  }
  if (seg.length) segments.push(seg);

  const sw = Math.round(svgViewW / 70);
  for (const s of segments) {
    if (s.length < 2) continue;
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points",          s.map(n => `${n.svg_x},${n.svg_y}`).join(" "));
    pl.setAttribute("stroke",          "#B0BEC5");
    pl.setAttribute("stroke-width",    sw);
    pl.setAttribute("fill",            "none");
    pl.setAttribute("stroke-linecap",  "round");
    pl.setAttribute("stroke-linejoin", "round");
    svgOverlay.appendChild(pl);
  }
}

// ================================================================
// SVG — current step highlight + direction arrow
// ================================================================
function renderSvgStep(step) {
  if (!svgOverlay) return;
  svgOverlay.querySelectorAll(".dyn").forEach(el => el.remove());

  const curNode = pathCoords[step];
  if (!curNode || curNode.building !== svgBuilding || curNode.floor !== svgFloor) return;

  // 現在ステップが属する「連続した同一フロア区間」だけを対象にする。
  // pathCoords.filter で全件取ると、同じフロアを複数回通るルートで
  // 別訪問のノードまで巻き込んで不正な線・ドットが描画される。
  let segStart = step, segEnd = step;
  while (segStart > 0 &&
         pathCoords[segStart - 1].building === svgBuilding &&
         pathCoords[segStart - 1].floor    === svgFloor) segStart--;
  while (segEnd < pathCoords.length - 1 &&
         pathCoords[segEnd + 1].building === svgBuilding &&
         pathCoords[segEnd + 1].floor    === svgFloor) segEnd++;

  const floorNodes  = pathCoords.slice(segStart, segEnd + 1).filter(n => n.svg_x != null);
  const curFloorIdx = floorNodes.findIndex(n => n.id === curNode.id);
  if (curFloorIdx < 0) return;

  const sz  = svgViewW / 1100;
  const sw  = Math.round(14 * sz);
  const rP  = Math.round(12 * sz);
  const rF  = Math.round(9  * sz);
  const rH  = Math.round(36 * sz);
  const aR  = Math.round(40 * sz);
  const aW  = Math.round(20 * sz);
  const aT  = Math.round(10 * sz);
  const aSW = Math.max(2, Math.round(3 * sz));

  // 通過済み部分はベースのグレーをそのまま見せる（done polyline は描かない）

  // 残り経路（現在地 → 終点）を青で上書き
  if (curFloorIdx < floorNodes.length - 1) {
    const ahead = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    ahead.classList.add("dyn");
    ahead.setAttribute("points",          floorNodes.slice(curFloorIdx).map(n => `${n.svg_x},${n.svg_y}`).join(" "));
    ahead.setAttribute("stroke",          ACCENT_COLOR);
    ahead.setAttribute("stroke-width",    sw);
    ahead.setAttribute("fill",            "none");
    ahead.setAttribute("stroke-linecap",  "round");
    ahead.setAttribute("stroke-linejoin", "round");
    svgOverlay.appendChild(ahead);
  }

  floorNodes.forEach((n, idx) => {
    if (idx === curFloorIdx) return;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.classList.add("dyn");
    c.setAttribute("cx", n.svg_x); c.setAttribute("cy", n.svg_y);
    if (idx < curFloorIdx) {
      // 通過済み: 小さいグレードット
      c.setAttribute("r", rF); c.setAttribute("fill", "#9E9E9E"); c.setAttribute("fill-opacity", "0.6");
    } else {
      // これから: 青ドット
      c.setAttribute("r", rF); c.setAttribute("fill", ACCENT_COLOR); c.setAttribute("fill-opacity", "0.75");
    }
    svgOverlay.appendChild(c);
  });

  const prevNode = curFloorIdx > 0 ? floorNodes[curFloorIdx - 1] : null;
  const nextNode = curFloorIdx < floorNodes.length - 1 ? floorNodes[curFloorIdx + 1] : null;
  let angle = 0;
  if (nextNode) {
    angle = Math.atan2(nextNode.svg_y - curNode.svg_y, nextNode.svg_x - curNode.svg_x) * 180 / Math.PI;
  } else if (prevNode) {
    angle = Math.atan2(curNode.svg_y - prevNode.svg_y, curNode.svg_x - prevNode.svg_x) * 180 / Math.PI;
  } else {
    // このフロアにsvg_xノードが1つだけ — ワールド座標で進行方向を推定
    // ワールド座標系↔SVG座標系の対応: SVG方向 = (world_dy, -world_dx)
    const ahead  = pathCoords.slice(step + 1).find(n => Math.abs(n.x - curNode.x) + Math.abs(n.y - curNode.y) > 0.01);
    const behind = [...pathCoords.slice(0, step)].reverse().find(n => Math.abs(n.x - curNode.x) + Math.abs(n.y - curNode.y) > 0.01);
    const ref = ahead || behind;
    if (ref) {
      const dx = ahead ? ref.x - curNode.x : curNode.x - ref.x;
      const dy = ahead ? ref.y - curNode.y : curNode.y - ref.y;
      angle = Math.atan2(-dx, dy) * 180 / Math.PI;
    }
  }

  // 最終到達点では方向矢印を出さない（現在地ハローのみ中心に表示）
  const isGoal = step >= pathCoords.length - 1;

  const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  halo.classList.add("dyn");
  const haloOffset = isGoal ? 0 : Math.round(12 * sz);
  const angleRad = angle * Math.PI / 180;
  halo.setAttribute("cx", curNode.svg_x + Math.round(Math.cos(angleRad) * haloOffset));
  halo.setAttribute("cy", curNode.svg_y + Math.round(Math.sin(angleRad) * haloOffset));
  halo.setAttribute("r", rH); halo.setAttribute("fill", "#32CD32"); halo.setAttribute("fill-opacity", "0.5");
  svgOverlay.appendChild(halo);

  if (!isGoal) {
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    arrow.classList.add("dyn");
    arrow.setAttribute("points", `0,${-aR} ${-aW},${aT} 0,${-Math.round(aR*0.2)} ${aW},${aT}`);
    arrow.setAttribute("fill",   "#EF4444");
    arrow.setAttribute("stroke", "white");
    arrow.setAttribute("stroke-width", aSW);
    arrow.setAttribute("stroke-linejoin", "round");
    arrow.setAttribute("transform", `translate(${curNode.svg_x},${curNode.svg_y}) rotate(${angle + 90})`);
    svgOverlay.appendChild(arrow);
  }

  if (svgOrigViewBox) panSvgTo(curNode.svg_x, curNode.svg_y);
}

// ================================================================
// SVG — pan viewBox to keep current node centered
// ================================================================
function panSvgTo(cx, cy) {
  const svgEl = document.querySelector("#svg-container svg");
  if (!svgEl || !svgOrigViewBox) return;
  const W = svgViewW, H = svgViewH;
  const x = Math.max(0, Math.min(cx - W / 2, svgOrigViewBox.width  - W));
  const y = Math.max(0, Math.min(cy - H / 2, svgOrigViewBox.height - H));
  svgEl.setAttribute("viewBox", `${x} ${y} ${W} ${H}`);
}

// ================================================================
// SVG — finger/mouse drag to pan + pinch/wheel zoom
// ================================================================
const SVG_MAX_ZOOM = 8;  // 原寸viewBoxに対する最大拡大倍率

let _svgPtrs    = new Map();  // pointerId → {x, y}
let _svgGesture = null;       // ジェスチャ開始時点の viewBox とポインタ位置

// ポインタの本数が変わるたびに基準を取り直す（1本=パン / 2本=ピンチ）
function _svgStartGesture(container) {
  if (_svgPtrs.size === 0) { _svgGesture = null; return; }
  const svgEl = container.querySelector("svg");
  if (!svgEl || !svgOrigViewBox) { _svgGesture = null; return; }
  const vb = svgEl.viewBox.baseVal;
  _svgGesture = {
    vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height,
    pts: [..._svgPtrs.values()].map(p => ({ ...p })),
  };
}

// viewBox を範囲内にクランプして適用し、以後のパン・ステップ移動が
// このズーム倍率を引き継ぐよう svgViewW/H も更新する
function _svgApplyView(svgEl, x, y, w, h) {
  const maxW = svgOrigViewBox.width, maxH = svgOrigViewBox.height;
  w = Math.max(maxW / SVG_MAX_ZOOM, Math.min(w, maxW));
  h = Math.max(maxH / SVG_MAX_ZOOM, Math.min(h, maxH));
  x = Math.max(0, Math.min(x, maxW - w));
  y = Math.max(0, Math.min(y, maxH - h));
  svgViewW = w;
  svgViewH = h;
  svgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
}

// ズーム倍率fを、拡大しすぎ・縮小しすぎにならない範囲へクランプ
function _svgClampFactor(f, w, h) {
  const maxW = svgOrigViewBox.width, maxH = svgOrigViewBox.height;
  f = Math.min(f, maxW / w, maxH / h);
  f = Math.max(f, maxW / SVG_MAX_ZOOM / w, maxH / SVG_MAX_ZOOM / h);
  return f;
}

function initSvgPan() {
  const container = document.getElementById("svg-container");

  container.addEventListener("pointerdown", e => {
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;
    e.preventDefault();
    try { container.setPointerCapture(e.pointerId); } catch {}
    _svgPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    _svgStartGesture(container);
  });

  container.addEventListener("pointermove", e => {
    if (!_svgPtrs.has(e.pointerId) || !_svgGesture) return;
    _svgPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;

    const rect = container.getBoundingClientRect();
    const g    = _svgGesture;
    const pts  = [..._svgPtrs.values()];

    if (pts.length >= 2 && g.pts.length >= 2) {
      // ピンチ: 2本指の距離の比でズームし、指の中点にあった地点を維持する
      const d0 = Math.hypot(g.pts[0].x - g.pts[1].x, g.pts[0].y - g.pts[1].y);
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (d0 < 1 || d1 < 1) return;
      const f    = _svgClampFactor(d0 / d1, g.vbW, g.vbH);
      const newW = g.vbW * f;
      const newH = g.vbH * f;
      const m0x = (g.pts[0].x + g.pts[1].x) / 2, m0y = (g.pts[0].y + g.pts[1].y) / 2;
      const m1x = (pts[0].x + pts[1].x) / 2,     m1y = (pts[0].y + pts[1].y) / 2;
      // ジェスチャ開始時に中点の下にあったSVG座標
      const sx = g.vbX + (m0x - rect.left) * g.vbW / rect.width;
      const sy = g.vbY + (m0y - rect.top)  * g.vbH / rect.height;
      _svgApplyView(svgEl,
        sx - (m1x - rect.left) * newW / rect.width,
        sy - (m1y - rect.top)  * newH / rect.height,
        newW, newH);
    } else if (pts.length === 1 && g.pts.length === 1) {
      // 1本指: パン
      const dx = (pts[0].x - g.pts[0].x) * g.vbW / rect.width;
      const dy = (pts[0].y - g.pts[0].y) * g.vbH / rect.height;
      _svgApplyView(svgEl, g.vbX - dx, g.vbY - dy, g.vbW, g.vbH);
    }
  });

  const dropPointer = e => {
    if (!_svgPtrs.delete(e.pointerId)) return;
    _svgStartGesture(container);  // 残った指を基準にパンへ移行（0本ならnull）
  };
  container.addEventListener("pointerup",     dropPointer);
  container.addEventListener("pointercancel", dropPointer);

  // デスクトップ: ホイール／トラックパッドのピンチ(ctrl+wheel)でズーム
  container.addEventListener("wheel", e => {
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const vb   = svgEl.viewBox.baseVal;
    const f    = _svgClampFactor(Math.exp(e.deltaY * 0.002), vb.width, vb.height);
    const newW = vb.width * f;
    const newH = vb.height * f;
    // カーソル位置の下にある地点を維持してズーム
    const sx = vb.x + (e.clientX - rect.left) * vb.width  / rect.width;
    const sy = vb.y + (e.clientY - rect.top)  * vb.height / rect.height;
    _svgApplyView(svgEl,
      sx - (e.clientX - rect.left) * newW / rect.width,
      sy - (e.clientY - rect.top)  * newH / rect.height,
      newW, newH);
  }, { passive: false });
}

// 初期化
initSvgPan();
```

### `programs/html/navi/script/page.js`

```javascript
// ================================================================
// page.js
// 画面共通の小物（完了モーダル・ナビバー・表示切り替え・プルトゥリフレッシュ防止）。
// ================================================================

// ================================================================
// Completion modal
// ================================================================
function showCompletionModal() {
  document.getElementById("completion-modal").classList.add("show");
  speak("到着しました");
}
function closeCompletionModal() {
  document.getElementById("completion-modal").classList.remove("show");
}

// 背景クリックで閉じる
document.getElementById("completion-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeCompletionModal();
});

function updateNavBar(node, step, total) {
  let label = "—";
  if (node) label = node.building === 0 ? "屋外を移動中" : `${bldgLabel(node.building)} ${node.floor}階`;
  document.getElementById("step-label").textContent = label;
  document.getElementById("step-count").textContent = total ? `${step + 1} / ${total - 1}` : "";
  document.getElementById("prev-btn").disabled = step <= 0;
  document.getElementById("next-btn").disabled = step >= total - 2;
}

// ================================================================
// View switching
// ================================================================
function switchView(view) {
  document.getElementById("map").style.display      = view === "map" ? "block" : "none";
  document.getElementById("svg-area").style.display = view === "svg" ? "block" : "none";
  if (view === "map" && map) google.maps.event.trigger(map, "resize");
}

// プルトゥリフレッシュ防止（overscroll-behavior非対応ブラウザ向けフォールバック）
document.addEventListener("touchstart", e => {
  if (e.touches.length > 1) return; // ピンチ操作は許可
  if (e.touches[0].clientY <= 20) e.preventDefault(); // 画面最上部からのスワイプのみ阻止
}, { passive: false });
```

### `programs/html/navi/script/ar.js`

```javascript
// ================================================================
// AR Outdoor Integration
// Three.js + カメラ + ジャイロ を #ar-area 内で動かす。
// 屋外ステップ到達時に arShowView()、屋内に戻ったら arHideView() を呼ぶ。
// ================================================================
const AR_THREE_CDN  = "https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js";
const AR_EYE_HEIGHT = 1.6;
const AR_NODE_R     = 0.5;
const AR_EDGE_R     = 0.12;
const AR_NODE_COLOR = 0x22D3EE;
const AR_EDGE_COLOR = 0x3B82F6;
const AR_CAMERA_FOV = 65;
const AR_TILT_DEG   = 5;

let arPermissionsRequested = false;
let arCamWanted      = false;  // カメラストリームを保持してよいか（解放後の遅延取得を防ぐ）
let arCamRequesting  = false;  // getUserMedia 実行中フラグ（二重取得を防ぐ）
let arOrientAttached = false;
let arHaveAbsolute   = false;
let arGOrient        = null;

let arStream       = null;
let arRenderer     = null;
let arScene3       = null;
let arCamera3      = null;
let arWorldGroup   = null;
let arRefLat       = null;
let arRefLng       = null;
let arUserLat      = null;
let arUserLng      = null;
let arGpsWatchId   = null;
let arRunning      = false;
let arBooting      = false;
let arMarkersBuilt = false;

let _arMeshes = [];   // { mesh, type: "node"|"edge", idx } — per-step color update

let _arZee, _arEuler, _arQ0, _arQ1;

function arLoadThree() {
  return new Promise((resolve, reject) => {
    if (typeof THREE !== "undefined") { resolve(); return; }
    const s = document.createElement("script");
    s.src = AR_THREE_CDN;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function arAttachOrientation() {
  if (arOrientAttached) return;
  arOrientAttached = true;
  const onAbsolute = (e) => {
    if (e.alpha == null) return;
    arHaveAbsolute = true;
    arGOrient = e;
  };
  const onRelative = (e) => {
    if (arHaveAbsolute && typeof e.webkitCompassHeading !== "number") return;
    arGOrient = e;
  };
  window.addEventListener("deviceorientationabsolute", onAbsolute);
  window.addEventListener("deviceorientation",         onRelative);
}

// 検索ボタン押下（ユーザー操作コンテキスト）で呼ぶ。
// iOS の DeviceOrientationEvent.requestPermission は同期的に
// ユーザー操作内で呼ばないと許可ダイアログが出ないため、ここで先取りする。
// カメラはこの時点では取得しない（ルート確定後、屋外AR区間がある場合のみ
// arPrefetchCameraIfNeeded() で取得する）。
function arRequestPermissionsEarly() {
  if (arPermissionsRequested) return;
  arPermissionsRequested = true;

  // Three.js を並行ロード（画面切り替え時のもたつきを減らす）
  arLoadThree().catch(() => {});

  // iOS 向け向きセンサー許可（ユーザー操作コンテキスト内で同期呼び出し必須）
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === "granted") arAttachOrientation(); })
      .catch(() => {});
  } else {
    arAttachOrientation();
  }
}

// ルートに屋外AR区間が含まれる場合のみカメラを先取りしてストリームを温める。
// 屋内のみのルートではカメラを一切起動しない。initRoute() から呼ばれる。
function arPrefetchCameraIfNeeded() {
  let hasOutdoorAR = false;
  for (let i = 0; i < pathCoords.length - 1; i++) {  // 最終ステップは到着画面なのでAR不要
    const n = pathCoords[i];
    if (n && n.building === 0 && n.lat != null) { hasOutdoorAR = true; break; }
  }
  if (!hasOutdoorAR) return;

  arCamWanted = true;
  if (arStream || arCamRequesting) return;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
  arCamRequesting = true;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
      arCamRequesting = false;
      // 取得完了前に解放済みならすぐ止める
      if (!arCamWanted) { stream.getTracks().forEach(t => t.stop()); return; }
      arStream = stream;
    })
    .catch(() => { arCamRequesting = false; });
}

function arEnsureRenderer() {
  if (arRenderer || typeof THREE === "undefined") return;

  const canvas = document.getElementById("ar-gl-canvas");
  arRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  arRenderer.setClearColor(0x000000, 0);

  arScene3 = new THREE.Scene();
  arCamera3 = new THREE.PerspectiveCamera(AR_CAMERA_FOV, 1, 0.1, 5000);
  arCamera3.position.set(0, AR_EYE_HEIGHT, 0);

  arWorldGroup = new THREE.Group();
  arScene3.add(arWorldGroup);
  arScene3.add(new THREE.AmbientLight(0xffffff, 1.0));

  _arZee  = new THREE.Vector3(0, 0, 1);
  _arEuler = new THREE.Euler();
  _arQ0   = new THREE.Quaternion();
  _arQ1   = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

  window.addEventListener("resize",            arResizeCanvas);
  window.addEventListener("orientationchange", () => setTimeout(arResizeCanvas, 300));
  arResizeCanvas();
}

function arResizeCanvas() {
  if (!arRenderer || !arCamera3) return;
  const area = document.getElementById("ar-area");
  if (!area) return;
  const w = area.clientWidth, h = area.clientHeight;
  if (!w || !h) return;
  arRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  arRenderer.setSize(w, h, false);
  arCamera3.aspect = w / h;
  arCamera3.updateProjectionMatrix();
}

function arEnuFromRef(lat, lng) {
  const north = (lat - arRefLat) * 111320;
  const east  = (lng - arRefLng) * 111320 * Math.cos(arRefLat * Math.PI / 180);
  return { east, north };
}

function arUpdateWorldPosition(lat, lng) {
  if (arRefLat == null || !arWorldGroup) return;
  const { east, north } = arEnuFromRef(lat, lng);
  arWorldGroup.position.set(-east, 0, north);
}

// pathCoords から屋外区間のノード・エッジを Three.js シーンに配置する
function arBuildRouteMarkers() {
  if (!arWorldGroup || typeof THREE === "undefined") return;
  while (arWorldGroup.children.length) arWorldGroup.remove(arWorldGroup.children[0]);
  _arMeshes = [];

  const outdoorNodes = pathCoords.filter(
    n => n.building === 0 && n.lat != null && n.lng != null
  );
  if (!outdoorNodes.length) return;

  arRefLat = outdoorNodes[0].lat;
  arRefLng = outdoorNodes[0].lng;

  const pos       = {};
  const sphereGeo = new THREE.SphereGeometry(AR_NODE_R, 24, 16);

  outdoorNodes.forEach((n, localIdx) => {
    const globalIdx = pathCoords.indexOf(n);
    const { east, north } = arEnuFromRef(n.lat, n.lng);
    const x = east, z = -north;
    pos[n.id] = { x, z };
    const mat    = new THREE.MeshBasicMaterial({ color: AR_NODE_COLOR });
    const sphere = new THREE.Mesh(sphereGeo, mat);
    sphere.position.set(x, 0, z);
    arWorldGroup.add(sphere);
    _arMeshes.push({ mesh: sphere, mat, type: "node", idx: globalIdx });
  });

  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const a = pathCoords[i], b = pathCoords[i + 1];
    if (a.building !== 0 || b.building !== 0 || a.lat == null || b.lat == null) continue;
    const pa = pos[a.id], pb = pos[b.id];
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const geo = new THREE.CylinderGeometry(AR_EDGE_R, AR_EDGE_R, len, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: AR_EDGE_COLOR, transparent: true, opacity: 0.85
    });
    const cyl = new THREE.Mesh(geo, mat);
    cyl.position.set(pa.x + dx / 2, 0, pa.z + dz / 2);
    cyl.quaternion.setFromUnitVectors(up, new THREE.Vector3(dx, 0, dz).normalize());
    arWorldGroup.add(cyl);
    _arMeshes.push({ mesh: cyl, mat, type: "edge", idx: i });
  }

  if (arUserLat != null) arUpdateWorldPosition(arUserLat, arUserLng);
  arMarkersBuilt = true;
}

// 現在ステップに合わせてノード・エッジを通過済み(グレー) / これから(青) に塗り替える
function arUpdateRouteColors(step) {
  const PASSED_NODE = 0x9E9E9E;
  const AHEAD_NODE  = AR_NODE_COLOR;     // 0x22D3EE
  const PASSED_EDGE = 0x9E9E9E;
  const AHEAD_EDGE  = AR_EDGE_COLOR;     // 0x3B82F6
  const PASSED_OPACITY = 0.35;
  const AHEAD_OPACITY  = 0.85;

  _arMeshes.forEach(({ mat, type, idx }) => {
    const passed = idx < step;
    if (type === "node") {
      mat.color.setHex(passed ? PASSED_NODE : AHEAD_NODE);
    } else {
      mat.color.setHex(passed ? PASSED_EDGE : AHEAD_EDGE);
      mat.opacity = passed ? PASSED_OPACITY : AHEAD_OPACITY;
    }
  });
}

function arScreenAngle() {
  const a = screen.orientation && screen.orientation.angle;
  return ((a != null ? a : window.orientation) || 0) * Math.PI / 180;
}

function arUpdateCameraOrientation() {
  const e = arGOrient;
  if (!e || !arCamera3) return;

  let headingDeg;
  if (typeof e.webkitCompassHeading === "number") {
    headingDeg = 360 - e.webkitCompassHeading;
  } else {
    headingDeg = e.alpha || 0;
  }

  const alpha  = headingDeg * Math.PI / 180;
  const beta   = ((e.beta  || 0) + AR_TILT_DEG) * Math.PI / 180;
  const gamma  = (e.gamma  || 0) * Math.PI / 180;
  const orient = arScreenAngle();

  _arEuler.set(beta, alpha, -gamma, "YXZ");
  const q = arCamera3.quaternion;
  q.setFromEuler(_arEuler);
  q.multiply(_arQ1);
  q.multiply(_arQ0.setFromAxisAngle(_arZee, -orient));
}

function arAnimate() {
  if (!arRunning) return;
  requestAnimationFrame(arAnimate);
  arUpdateCameraOrientation();
  arRenderer.render(arScene3, arCamera3);
}

async function arShowView() {
  if (arRunning || arBooting) return;
  arCamWanted = true;
  arBooting = true;

  try {
    await arLoadThree();
  } catch {
    arBooting = false;
    return;
  }
  if (!arBooting) return;

  arEnsureRenderer();

  const video = document.getElementById("ar-bg-video");
  if (!video.srcObject) {
    if (arStream) {
      video.srcObject = arStream;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia(
          { video: { facingMode: "environment" } }
        );
        if (!arBooting) { s.getTracks().forEach(t => t.stop()); return; }
        arStream = s;
        video.srcObject = s;
      } catch { /* カメラ利用不可 */ }
    }
  }
  if (!arBooting) return;

  // AR用GPS継続追跡（初回のみ開始）
  if (!arGpsWatchId && navigator.geolocation) {
    arGpsWatchId = navigator.geolocation.watchPosition(
      pos => {
        arUserLat = pos.coords.latitude;
        arUserLng = pos.coords.longitude;
        arUpdateWorldPosition(arUserLat, arUserLng);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 }
    );
  }

  document.getElementById("ar-bg-video").style.display = "block";
  document.getElementById("ar-gl-canvas").style.display = "block";

  if (!arMarkersBuilt) arBuildRouteMarkers();
  arResizeCanvas();

  arRunning = true;
  arBooting = false;
  arAnimate();
}

function arHideView() {
  arBooting = false;
  if (!arRunning) return;
  arRunning = false;
  document.getElementById("ar-bg-video").style.display = "none";
  document.getElementById("ar-gl-canvas").style.display = "none";
}

// カメラストリームと GPS 監視を完全に停止する。
// 再度屋外区間に入れば arShowView() が取得し直す（許可ダイアログは再表示されない）。
function arReleaseHardware() {
  arCamWanted = false;
  arHideView();
  if (arStream) {
    arStream.getTracks().forEach(t => t.stop());
    arStream = null;
  }
  const video = document.getElementById("ar-bg-video");
  if (video.srcObject) video.srcObject = null;
  if (arGpsWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(arGpsWatchId);
    arGpsWatchId = null;
  }
}
```

### `programs/html/navi/script/maps-loader.js`

```javascript
  const _ms = document.createElement("script");
  _ms.src   = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&callback=initMap`;
  _ms.async = true;
  _ms.defer = true;
  document.body.appendChild(_ms);
```

### `programs/Website/index.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IKU NAVI — 専修大学 生亀プロジェクト</title>
  <meta name="description" content="専修大学構内を対象にした AR 対応ナビゲーション Web アプリ「IKU NAVI」。ネットワーク情報学部 生亀プロジェクトによる開発。">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --void:      #080F1A;
      --navy:      #0F2035;
      --deep:      #162840;
      --cyan:      #00B8E6;
      --teal:      #00D4AA;
      --ice:       #EEF6FF;
      --fog:       #8AAABF;
      --faint:     #4A6A80;
      --border:    rgba(0,184,230,0.18);
      --border-lo: rgba(0,184,230,0.10);
    }

    html { scroll-behavior: smooth; }

    body {
      background: var(--void);
      color: var(--fog);
      font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif;
      font-size: 16px;
      line-height: 1.75;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
    }

    /* ── NAVIGATION ── */
    .nav {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 2rem;
      height: 60px;
      background: rgba(8,15,26,0.88);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border-lo);
    }

    .nav-logo {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.2rem;
      font-weight: 700;
      color: var(--ice);
      text-decoration: none;
      letter-spacing: 0.04em;
    }
    .nav-logo em { color: var(--cyan); font-style: normal; }

    .nav-menu {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      list-style: none;
    }
    .nav-menu a {
      color: var(--fog);
      text-decoration: none;
      font-size: 0.875rem;
      padding: 0.4rem 0.75rem;
      border-radius: 4px;
      transition: color 0.2s, background 0.2s;
    }
    .nav-menu a:hover { color: var(--ice); background: rgba(255,255,255,0.06); }
    .nav-menu a.active { color: var(--cyan); }

    .nav-cta-link {
      margin-left: 0.5rem;
      background: var(--cyan) !important;
      color: var(--void) !important;
      font-weight: 600 !important;
    }
    .nav-cta-link:hover { background: var(--teal) !important; }

    .nav-burger {
      display: none;
      flex-direction: column;
      gap: 5px;
      cursor: pointer;
      padding: 6px;
      border: none;
      background: transparent;
    }
    .nav-burger span {
      display: block;
      width: 22px;
      height: 2px;
      background: var(--ice);
      border-radius: 2px;
      transition: transform 0.3s, opacity 0.3s;
    }

    /* ── HERO ── */
    .hero {
      position: relative;
      min-height: 100svh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 80px 1.5rem 5rem;
      overflow: hidden;
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }

    .hero-fade {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse 70% 60% at 50% 50%, rgba(8,15,26,0.2) 0%, rgba(8,15,26,0.93) 72%);
    }

    .hero-body {
      position: relative;
      z-index: 2;
      max-width: 760px;
    }

    .hero-eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      letter-spacing: 0.18em;
      color: var(--cyan);
      text-transform: uppercase;
      margin-bottom: 1.5rem;
      opacity: 0;
      transform: translateY(12px);
      animation: fadeUp 0.8s 0.2s forwards;
    }

    .hero-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: clamp(4rem, 14vw, 9rem);
      font-weight: 700;
      color: var(--ice);
      letter-spacing: -0.025em;
      line-height: 0.88;
      margin-bottom: 0.3rem;
      opacity: 0;
      transform: translateY(16px);
      animation: fadeUp 0.8s 0.35s forwards;
    }

    .hero-tagline {
      font-family: 'Space Grotesk', sans-serif;
      font-size: clamp(0.85rem, 2.5vw, 1.2rem);
      font-weight: 400;
      color: var(--cyan);
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 1.75rem;
      opacity: 0;
      animation: fadeUp 0.8s 0.5s forwards;
    }

    .hero-desc {
      font-size: clamp(0.9rem, 2vw, 1.05rem);
      color: var(--fog);
      max-width: 520px;
      margin: 0 auto 2.5rem;
      line-height: 1.85;
      opacity: 0;
      animation: fadeUp 0.8s 0.65s forwards;
    }

    .hero-ctas {
      display: flex;
      gap: 0.875rem;
      justify-content: center;
      flex-wrap: wrap;
      opacity: 0;
      animation: fadeUp 0.8s 0.8s forwards;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      padding: 0.7rem 1.6rem;
      border-radius: 6px;
      text-decoration: none;
      transition: background 0.2s, border-color 0.2s, transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover { transform: translateY(-2px); }

    .btn-fill { background: var(--cyan); color: var(--void); }
    .btn-fill:hover { background: var(--teal); box-shadow: 0 4px 20px rgba(0,184,230,0.35); }

    .btn-ghost { border: 1px solid var(--border); color: var(--ice); }
    .btn-ghost:hover { border-color: var(--cyan); background: rgba(0,184,230,0.08); }

    .hero-scroll-hint {
      position: absolute;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      opacity: 0;
      animation: fadeIn 1s 1.5s forwards;
    }
    .scroll-bar {
      width: 1px;
      height: 44px;
      background: linear-gradient(to bottom, var(--cyan), transparent);
      animation: barPulse 2.2s ease-in-out infinite;
    }

    @keyframes fadeUp { to { opacity: 1; transform: none; } }
    @keyframes fadeIn { to { opacity: 0.6; } }
    @keyframes barPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }

    /* ── LAYOUT ── */
    .section { padding: 6rem 1.5rem; }
    .wrap { max-width: 1100px; margin: 0 auto; }

    .sec-eye {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      letter-spacing: 0.22em;
      color: var(--cyan);
      text-transform: uppercase;
      margin-bottom: 0.6rem;
    }
    .sec-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: clamp(1.7rem, 4vw, 2.4rem);
      font-weight: 700;
      color: var(--ice);
      line-height: 1.2;
      margin-bottom: 0.875rem;
    }
    .sec-lead {
      font-size: 0.975rem;
      color: var(--fog);
      max-width: 500px;
      line-height: 1.85;
      margin-bottom: 3rem;
    }

    /* ── FEATURES ── */
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 1.25rem;
    }

    .feat-card {
      background: var(--navy);
      border: 1px solid var(--border-lo);
      border-radius: 12px;
      padding: 2rem 1.75rem;
      transition: border-color 0.25s, transform 0.25s, box-shadow 0.25s;
    }
    .feat-card:hover {
      border-color: var(--cyan);
      transform: translateY(-4px);
      box-shadow: 0 8px 32px rgba(0,184,230,0.1);
    }

    .feat-icon {
      width: 44px;
      height: 44px;
      color: var(--cyan);
      margin-bottom: 1.25rem;
    }
    .feat-name {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.05rem;
      font-weight: 600;
      color: var(--ice);
      margin-bottom: 0.5rem;
    }
    .feat-text {
      font-size: 0.875rem;
      line-height: 1.75;
      color: var(--fog);
    }

    /* ── TECH STACK ── */
    .tech-section {
      background: var(--navy);
      border-top: 1px solid var(--border-lo);
      border-bottom: 1px solid var(--border-lo);
    }

    .stack-rows { display: flex; flex-direction: column; gap: 1rem; }

    .stack-row {
      display: flex;
      align-items: flex-start;
      gap: 1.5rem;
      background: rgba(8,15,26,0.5);
      border: 1px solid var(--border-lo);
      border-left: 3px solid var(--cyan);
      border-radius: 0 8px 8px 0;
      padding: 1.25rem 1.5rem;
    }
    .stack-label {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      letter-spacing: 0.14em;
      color: var(--cyan);
      text-transform: uppercase;
      white-space: nowrap;
      padding-top: 0.15rem;
      min-width: 88px;
    }
    .stack-chips { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .chip {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.78rem;
      color: var(--ice);
      background: rgba(0,184,230,0.08);
      border: 1px solid rgba(0,184,230,0.22);
      padding: 0.2rem 0.65rem;
      border-radius: 4px;
      white-space: nowrap;
    }

    /* ── ROADMAP ── */
    .roadmap-track { list-style: none; }

    .rm-item {
      display: flex;
      gap: 1.25rem;
    }
    .rm-item:not(:last-child) { padding-bottom: 2.5rem; }

    .rm-spine {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex-shrink: 0;
      width: 18px;
    }
    .rm-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid var(--faint);
      background: var(--void);
      flex-shrink: 0;
      margin-top: 3px;
    }
    .rm-stem {
      width: 2px;
      flex: 1;
      background: var(--border-lo);
      margin-top: 5px;
    }

    .rm-item.is-done .rm-dot { border-color: var(--teal); background: var(--teal); }
    .rm-item.is-now .rm-dot {
      border-color: var(--cyan);
      background: var(--cyan);
      animation: nowPulse 2.2s ease-in-out infinite;
    }
    @keyframes nowPulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(0,184,230,0.18); }
      50%       { box-shadow: 0 0 0 8px rgba(0,184,230,0.07); }
    }

    .rm-date {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.1em;
      color: var(--faint);
      margin-bottom: 0.2rem;
    }
    .rm-item.is-done .rm-date,
    .rm-item.is-now  .rm-date { color: var(--cyan); }

    .rm-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1rem;
      font-weight: 600;
      color: var(--ice);
      margin-bottom: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .rm-item.is-now .rm-title { color: var(--cyan); }

    .badge-now {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 0.08em;
      background: var(--cyan);
      color: var(--void);
      padding: 0.1rem 0.45rem;
      border-radius: 3px;
      font-weight: 700;
    }
    .rm-detail { font-size: 0.875rem; color: var(--fog); line-height: 1.6; }

    /* ── TEAM ── */
    .team-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
      gap: 1rem;
    }
    .team-card {
      background: var(--navy);
      border: 1px solid var(--border-lo);
      border-radius: 10px;
      padding: 1.5rem 1rem 1.25rem;
      text-align: center;
      transition: border-color 0.25s, transform 0.25s;
    }
    .team-card:hover { border-color: var(--cyan); transform: translateY(-3px); }
    .team-card.is-lead {
      border-color: rgba(0,184,230,0.4);
      background: linear-gradient(160deg, var(--navy), rgba(0,184,230,0.07));
    }
    .avatar {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      background: var(--deep);
      border: 2px solid var(--border);
      margin: 0 auto 0.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.05rem;
      font-weight: 700;
      color: var(--cyan);
    }
    .team-name {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--ice);
      margin-bottom: 0.2rem;
    }
    .team-role { font-size: 0.75rem; color: var(--fog); }
    .team-role-lead {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.68rem;
      color: var(--cyan);
      letter-spacing: 0.08em;
    }

    /* ── FOOTER ── */
    .footer {
      background: var(--navy);
      border-top: 1px solid var(--border-lo);
      padding: 3.5rem 1.5rem;
    }
    .footer-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.75rem;
      text-align: center;
    }
    .footer-logo {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 1.4rem;
      font-weight: 700;
      color: var(--ice);
    }
    .footer-logo em { color: var(--cyan); font-style: normal; }
    .footer-org { font-size: 0.8rem; color: var(--faint); line-height: 1.6; }
    .footer-links {
      display: flex;
      gap: 2rem;
      flex-wrap: wrap;
      justify-content: center;
      list-style: none;
    }
    .footer-links a {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--fog);
      text-decoration: none;
      font-size: 0.85rem;
      transition: color 0.2s;
    }
    .footer-links a:hover { color: var(--cyan); }
    .footer-copy { font-size: 0.75rem; color: var(--faint); }

    /* ── SCROLL REVEAL ── */
    .reveal {
      opacity: 0;
      transform: translateY(20px);
      transition: opacity 0.55s ease, transform 0.55s ease;
    }
    .reveal.in { opacity: 1; transform: none; }

    /* ── RESPONSIVE ── */
    @media (max-width: 768px) {
      .nav { padding: 0 1rem; }
      .nav-menu { display: none; }
      .nav-burger { display: flex; }
      .nav-menu.is-open {
        display: flex;
        flex-direction: column;
        position: fixed;
        top: 60px; left: 0; right: 0; bottom: 0;
        background: rgba(8,15,26,0.97);
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        z-index: 199;
      }
      .nav-menu.is-open a { font-size: 1.2rem; padding: 0.75rem 1.5rem; }
      .section { padding: 4rem 1.25rem; }
      .stack-row { flex-direction: column; gap: 0.625rem; }
      .stack-label { min-width: unset; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
      .reveal { opacity: 1; transform: none; }
    }
  </style>
</head>
<body>

  <!-- NAV -->
  <nav class="nav" id="nav">
    <a href="#top" class="nav-logo">IKU <em>NAVI</em></a>
    <ul class="nav-menu" id="navMenu">
      <li><a href="#features">機能</a></li>
      <li><a href="#tech">技術</a></li>
      <li><a href="#roadmap">ロードマップ</a></li>
      <li><a href="#team">チーム</a></li>
      <li><a href="https://iku-navi.net" class="nav-cta-link" target="_blank" rel="noopener">アプリを試す →</a></li>
    </ul>
    <button class="nav-burger" id="navBurger" aria-label="メニューを開く" aria-expanded="false" aria-controls="navMenu">
      <span></span><span></span><span></span>
    </button>
  </nav>

  <!-- HERO -->
  <section class="hero" id="top">
    <!-- Animated blueprint floor-plan background -->
    <svg class="hero-bg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="#00B8E6" fill="none">
        <!-- Building A -->
        <rect x="70"  y="55"  width="330" height="230" stroke-width="1.5" opacity="0.44"/>
        <line x1="70"  y1="145" x2="210"  y2="145" stroke-width="1" opacity="0.28"/>
        <line x1="210" y1="55"  x2="210"  y2="145" stroke-width="1" opacity="0.28"/>
        <line x1="70"  y1="200" x2="400"  y2="200" stroke-width="1" opacity="0.28"/>
        <line x1="280" y1="55"  x2="280"  y2="200" stroke-width="1" opacity="0.28"/>
        <!-- Building B -->
        <rect x="470" y="90"  width="280" height="185" stroke-width="1.5" opacity="0.42"/>
        <line x1="470" y1="180" x2="750"  y2="180" stroke-width="1" opacity="0.26"/>
        <line x1="610" y1="90"  x2="610"  y2="275" stroke-width="1" opacity="0.26"/>
        <!-- Building C -->
        <rect x="810" y="70"  width="250" height="200" stroke-width="1.5" opacity="0.40"/>
        <line x1="810" y1="165" x2="1060" y2="165" stroke-width="1" opacity="0.26"/>
        <line x1="910" y1="70"  x2="910"  y2="270" stroke-width="1" opacity="0.26"/>
        <!-- Lower row -->
        <rect x="100"  y="370" width="220" height="165" stroke-width="1.5" opacity="0.36"/>
        <rect x="370"  y="390" width="175" height="145" stroke-width="1.5" opacity="0.34"/>
        <rect x="590"  y="355" width="230" height="180" stroke-width="1.5" opacity="0.36"/>
        <rect x="870"  y="370" width="240" height="160" stroke-width="1.5" opacity="0.34"/>
        <!-- Corridor connectors -->
        <line x1="400"  y1="165" x2="470"  y2="165" stroke-width="1" opacity="0.22"/>
        <line x1="750"  y1="165" x2="810"  y2="165" stroke-width="1" opacity="0.22"/>
      </g>

      <!-- Building labels -->
      <g font-family="monospace" font-size="9" fill="#00B8E6" opacity="0.5">
        <text x="78"  y="50">1号館</text>
        <text x="478" y="85">3号館</text>
        <text x="818" y="65">7号館</text>
        <text x="108" y="365">2号館</text>
        <text x="598" y="350">10号館</text>
      </g>

      <!-- Animated navigation path -->
      <path d="M 210 440 L 210 370 L 400 370 L 400 200 L 470 200 L 470 165 L 610 165 L 610 90 L 960 90 L 960 165"
        fill="none" stroke="#00B8E6" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round"
        stroke-dasharray="1300" stroke-dashoffset="1300" opacity="0.85">
        <animate attributeName="stroke-dashoffset" from="1300" to="0" dur="3.5s" begin="0.4s" fill="freeze"/>
      </path>

      <!-- Static waypoints -->
      <circle cx="210" cy="440" r="4.5" fill="#00B8E6" opacity="0.9"/>
      <circle cx="470" cy="165" r="4.5" fill="#00B8E6" opacity="0.9"/>
      <circle cx="610" cy="90"  r="4.5" fill="#00B8E6" opacity="0.9"/>

      <!-- Destination: double-ring AR anchor -->
      <circle cx="960" cy="165" r="5" fill="#00B8E6">
        <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite"/>
      </circle>
      <circle cx="960" cy="165" r="5" fill="none" stroke="#00B8E6" stroke-width="1.5">
        <animate attributeName="r" values="8;20;8" dur="2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.7;0;0.7" dur="2s" repeatCount="indefinite"/>
      </circle>
      <circle cx="960" cy="165" r="5" fill="none" stroke="#00B8E6" stroke-width="1">
        <animate attributeName="r" values="8;30;8" dur="2s" begin="0.4s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.4;0;0.4" dur="2s" begin="0.4s" repeatCount="indefinite"/>
      </circle>
    </svg>
    <div class="hero-fade"></div>

    <div class="hero-body">
      <p class="hero-eyebrow">専修大学 ネットワーク情報学部 生亀プロジェクト</p>
      <h1 class="hero-title">IKU NAVI</h1>
      <p class="hero-tagline">AR Campus Navigation</p>
      <p class="hero-desc">大学構内を対象にした AR 対応ナビゲーション Web アプリ。<br>スマホ一つで、迷わず目的地へ。</p>
      <div class="hero-ctas">
        <a href="https://iku-navi.net" class="btn btn-fill" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          アプリを試す
        </a>
        <a href="https://github.com/SenARMapOrg/SenARMapProject_2026" class="btn btn-ghost" target="_blank" rel="noopener">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          GitHub
        </a>
      </div>
    </div>

    <div class="hero-scroll-hint" aria-hidden="true">
      <div class="scroll-bar"></div>
    </div>
  </section>

  <!-- FEATURES -->
  <section class="section" id="features">
    <div class="wrap">
      <p class="sec-eye reveal">主要機能</p>
      <h2 class="sec-title reveal">スマホで、迷わない。</h2>
      <p class="sec-lead reveal">屋外と屋内を自動で切り替えるハイブリッドマップと、実写 AR ナビで目的地まで案内します。</p>
      <div class="features-grid">

        <div class="feat-card reveal">
          <svg class="feat-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="4" y="8" width="18" height="32" rx="2"/>
            <rect x="26" y="8" width="18" height="32" rx="2"/>
            <line x1="22" y1="18" x2="26" y2="18"/>
            <line x1="22" y1="24" x2="26" y2="24"/>
            <line x1="22" y1="30" x2="26" y2="30"/>
          </svg>
          <h3 class="feat-name">ハイブリッド・マップ</h3>
          <p class="feat-text">屋外では Google Maps、屋内では SVG フロアマップへ自動切り替え。シームレスに構内をナビゲートします。</p>
        </div>

        <div class="feat-card reveal">
          <svg class="feat-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10" cy="24" r="4"/>
            <circle cx="38" cy="14" r="4"/>
            <circle cx="38" cy="34" r="4"/>
            <line x1="14" y1="22" x2="34" y2="16"/>
            <line x1="14" y1="26" x2="34" y2="32"/>
            <polyline points="30 38 38 34 34 42"/>
          </svg>
          <h3 class="feat-name">ステップ・ナビゲーション</h3>
          <p class="feat-text">矢印ボタンで 1 ステップずつ進む経路案内。実写 AR 画像・青ハイライト・赤矢印が連動して誘導します。</p>
        </div>

        <div class="feat-card reveal">
          <svg class="feat-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10" cy="10" r="4"/><circle cx="38" cy="10" r="4"/>
            <circle cx="10" cy="38" r="4"/><circle cx="38" cy="38" r="4"/>
            <circle cx="24" cy="24" r="4"/>
            <line x1="14" y1="11" x2="20" y2="21"/>
            <line x1="28" y1="21" x2="34" y2="11"/>
            <line x1="14" y1="37" x2="20" y2="27"/>
            <line x1="28" y1="27" x2="34" y2="37"/>
          </svg>
          <h3 class="feat-name">ダイクストラ経路探索</h3>
          <p class="feat-text">グラフ理論に基づく Dijkstra 法で最短経路を算出。エレベーターの有無も考慮した経路選択が可能です。</p>
        </div>

        <div class="feat-card reveal">
          <svg class="feat-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M24 6C17.37 6 12 11.37 12 18c0 9 12 24 12 24s12-15 12-24c0-6.63-5.37-12-12-12z"/>
            <circle cx="24" cy="18" r="4"/>
          </svg>
          <h3 class="feat-name">GPS 連動</h3>
          <p class="feat-text">navigator.geolocation で現在地を取得し、最も近い屋外ノードから経路探索を自動で開始します。</p>
        </div>

        <div class="feat-card reveal">
          <svg class="feat-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="6"  y="28" width="10" height="14" rx="1.5"/>
            <rect x="19" y="20" width="10" height="22" rx="1.5"/>
            <rect x="32" y="10" width="10" height="32" rx="1.5"/>
            <path d="M11 28 L11 22 Q11 18 15 18 L19 18"/>
          </svg>
          <h3 class="feat-name">バリアフリー対応</h3>
          <p class="feat-text">検索時にエレベーター使用の有無を選択可能。誰もが快適に移動できるインクルーシブな設計です。</p>
        </div>

      </div>
    </div>
  </section>

  <!-- TECH STACK -->
  <section class="section tech-section" id="tech">
    <div class="wrap">
      <p class="sec-eye reveal">技術スタック</p>
      <h2 class="sec-title reveal">本番環境で動く、<br>本物のシステム構成。</h2>
      <p class="sec-lead reveal">フロントエンドからインフラまで、学生チームが設計・構築・運用するフルスタック Web サービスです。</p>
      <div class="stack-rows reveal">
        <div class="stack-row">
          <span class="stack-label">Frontend</span>
          <div class="stack-chips">
            <span class="chip">HTML / CSS</span>
            <span class="chip">Vanilla JS</span>
            <span class="chip">Google Maps API</span>
            <span class="chip">Inline SVG</span>
          </div>
        </div>
        <div class="stack-row">
          <span class="stack-label">Backend</span>
          <div class="stack-chips">
            <span class="chip">Python 3</span>
            <span class="chip">Flask</span>
            <span class="chip">Gunicorn</span>
            <span class="chip">pandas</span>
          </div>
        </div>
        <div class="stack-row">
          <span class="stack-label">Infra</span>
          <div class="stack-chips">
            <span class="chip">Docker</span>
            <span class="chip">Docker Compose</span>
            <span class="chip">Nginx</span>
            <span class="chip">ConoHa VPS</span>
          </div>
        </div>
        <div class="stack-row">
          <span class="stack-label">Network</span>
          <div class="stack-chips">
            <span class="chip">Cloudflare Tunnels</span>
            <span class="chip">Cloudflare R2</span>
          </div>
        </div>
        <div class="stack-row">
          <span class="stack-label">Data</span>
          <div class="stack-chips">
            <span class="chip">CSV（ノード・エッジ）</span>
            <span class="chip">Google Spreadsheet</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ROADMAP -->
  <section class="section" id="roadmap">
    <div class="wrap">
      <p class="sec-eye reveal">開発ロードマップ</p>
      <h2 class="sec-title reveal">プロジェクトの歩み</h2>
      <p class="sec-lead reveal">2026 年 4 月始動。鳳祭での一般公開、そして最終発表へ。</p>
      <ol class="roadmap-track reveal">

        <li class="rm-item is-done">
          <div class="rm-spine"><div class="rm-dot"></div><div class="rm-stem"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年4月</p>
            <p class="rm-title">プロジェクト始動</p>
            <p class="rm-detail">要件定義、ペーパープロトタイプ作成、座標系の定義</p>
          </div>
        </li>

        <li class="rm-item is-done">
          <div class="rm-spine"><div class="rm-dot"></div><div class="rm-stem"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年5月</p>
            <p class="rm-title">「IKU NAVI」命名</p>
            <p class="rm-detail">各号館（1〜10号館）のデータ計測・ノード ID 振り分け開始</p>
          </div>
        </li>

        <li class="rm-item is-now">
          <div class="rm-spine"><div class="rm-dot"></div><div class="rm-stem"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年6月</p>
            <p class="rm-title">中間発表へ向けた開発 <span class="badge-now">NOW</span></p>
            <p class="rm-detail">Web サイト・発表会デザイン、コア機能の実装</p>
          </div>
        </li>

        <li class="rm-item">
          <div class="rm-spine"><div class="rm-dot"></div><div class="rm-stem"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年7月</p>
            <p class="rm-title">中間発表デモ</p>
            <p class="rm-detail">10 号館内での中間発表用デモ動作</p>
          </div>
        </li>

        <li class="rm-item">
          <div class="rm-spine"><div class="rm-dot"></div><div class="rm-stem"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年11月 6–8日</p>
            <p class="rm-title">鳳祭 一般公開</p>
            <p class="rm-detail">来場者へのサービス提供とフィードバック収集</p>
          </div>
        </li>

        <li class="rm-item">
          <div class="rm-spine"><div class="rm-dot"></div></div>
          <div class="rm-body">
            <p class="rm-date">2026年12月</p>
            <p class="rm-title">最終発表</p>
            <p class="rm-detail">成果報告・プロジェクト完了</p>
          </div>
        </li>

      </ol>
    </div>
  </section>

  <!-- TEAM -->
  <section class="section" id="team">
    <div class="wrap">
      <p class="sec-eye reveal">チーム</p>
      <h2 class="sec-title reveal">9 名のメンバー</h2>
      <p class="sec-lead reveal">専修大学 ネットワーク情報学部の学生チーム。各自が担当号館の責任者を兼任し、実測からサーバ運用まで担います。</p>
      <div class="team-grid reveal">
        <div class="team-card is-lead">
          <div class="avatar">だ</div>
          <p class="team-name">だい</p>
          <p class="team-role-lead">代表</p>
        </div>
        <div class="team-card">
          <div class="avatar">こ</div>
          <p class="team-name">こうた</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">か</div>
          <p class="team-name">かずま</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">ゆ</div>
          <p class="team-name">ゆーだい</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">り</div>
          <p class="team-name">りゅう</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">あ</div>
          <p class="team-name">あおい</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">り</div>
          <p class="team-name">りく</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">こ</div>
          <p class="team-name">こうせい</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">お
          </div>
          <p class="team-name">おうか</p>
          <p class="team-role">メンバー</p>
        </div>
        <div class="team-card">
          <div class="avatar">い</div>
          <p class="team-name">いき きよたか</p>
          <p class="team-role">担当教員</p>
        </div>
      </div>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-logo">IKU <em>NAVI</em></div>
      <p class="footer-org">
        専修大学 ネットワーク情報学部<br>
        生亀プロジェクト（SenARMapOrg）
      </p>
      <ul class="footer-links">
        <li>
          <a href="https://github.com/SenARMapOrg/SenARMapProject_2026" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            GitHub
          </a>
        </li>
        <li>
          <a href="https://iku-navi.net" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            iku-navi.net
          </a>
        </li>
      </ul>
      <p class="footer-copy">© 2026 SenARMapOrg. 専修大学 ネットワーク情報学部 生亀プロジェクト</p>
    </div>
  </footer>

  <script>
    // Hamburger
    const burger = document.getElementById('navBurger');
    const menu  = document.getElementById('navMenu');
    burger.addEventListener('click', () => {
      const open = menu.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
    menu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        menu.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      });
    });

    // Scroll reveal
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));

    // Nav active link
    const secIds = ['features','tech','roadmap','team'];
    const navLinks = document.querySelectorAll('.nav-menu a[href^="#"]');
    window.addEventListener('scroll', () => {
      let active = '';
      secIds.forEach(id => {
        const el = document.getElementById(id);
        if (el && window.scrollY >= el.offsetTop - 100) active = id;
      });
      navLinks.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + active);
      });
    }, { passive: true });
  </script>
</body>
</html>

```

### `programs/html/blog/build.py`

```python
#!/usr/bin/env python3
"""
Blog build script
使い方: python build.py
posts/*.md を読んでHTMLに変換し、posts.json を更新します。
"""

import json
import re
from html import escape
from pathlib import Path

BLOG_DIR = Path(__file__).parent
POSTS_DIR = BLOG_DIR / "posts"
POSTS_JSON = BLOG_DIR / "posts.json"


def parse_frontmatter(content: str) -> tuple[dict, str]:
    if not content.startswith("---"):
        return {}, content
    end = content.find("---", 3)
    if end == -1:
        return {}, content
    fm_str = content[3:end].strip()
    body = content[end + 3:].strip()
    meta = {}
    for line in fm_str.splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            meta[key.strip()] = value.strip()
    return meta, body


def md_to_html(text: str) -> str:
    try:
        import markdown
        return markdown.markdown(
            text,
            extensions=["extra", "toc", "nl2br"],
        )
    except ImportError:
        print("⚠  markdown ライブラリが見つかりません。")
        print("   pip install markdown  でインストールしてください。")
        print("   フォールバックの簡易変換を使います。\n")
        return _simple_md_to_html(text)


def _simple_md_to_html(text: str) -> str:
    """最小限のMarkdown→HTML変換（fallback用）"""
    html = []
    in_ul = False
    for line in text.splitlines():
        if line.startswith("### "):
            if in_ul: html.append("</ul>"); in_ul = False
            html.append(f"<h3>{_inline(line[4:])}</h3>")
        elif line.startswith("## "):
            if in_ul: html.append("</ul>"); in_ul = False
            html.append(f"<h2>{_inline(line[3:])}</h2>")
        elif line.startswith("# "):
            if in_ul: html.append("</ul>"); in_ul = False
            html.append(f"<h1>{_inline(line[2:])}</h1>")
        elif line.startswith("- "):
            if not in_ul: html.append("<ul>"); in_ul = True
            html.append(f"<li>{_inline(line[2:])}</li>")
        elif line.strip() == "---":
            if in_ul: html.append("</ul>"); in_ul = False
            html.append("<hr>")
        elif line.strip() == "":
            if in_ul: html.append("</ul>"); in_ul = False
            html.append("")
        else:
            if in_ul: html.append("</ul>"); in_ul = False
            html.append(f"<p>{_inline(line)}</p>")
    if in_ul:
        html.append("</ul>")
    return "\n".join(html)


def _inline(text: str) -> str:
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    text = re.sub(r"!\[(.+?)\]\((.+?)\)", r'<img src="\2" alt="\1" style="max-width:100%">', text)
    text = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', text)
    return text


POST_HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex">
    <title>{title} | IKU NAVI ブログ</title>
    <link rel="stylesheet" href="../style.css">
    <link rel="icon" href="../../images/favicon.ico">
</head>
<body>
    <header class="site-header">
        <nav class="breadcrumb">
            <a href="../../index.html">IKU NAVI</a>
            <span>›</span>
            <a href="../index.html">ブログ</a>
            <span>›</span>
            <span>{title}</span>
        </nav>
    </header>

    <main class="post-container">
        <article class="post">
            <div class="post-meta">
                <time datetime="{date}">{date_ja}</time>
                {author_html}
            </div>
            <h1 class="post-title">{title}</h1>
            {thumbnail_html}
            <div class="post-body">
                {body}
            </div>
        </article>
    </main>

    <footer class="site-footer">
        <a href="../index.html">← ブログ一覧に戻る</a>
    </footer>
</body>
</html>
"""


def format_date_ja(date_str: str) -> str:
    try:
        from datetime import datetime
        d = datetime.strptime(date_str, "%Y-%m-%d")
        return f"{d.year}年{d.month}月{d.day}日"
    except Exception:
        return date_str


def build_post(md_path: Path) -> dict | None:
    text = md_path.read_text(encoding="utf-8")
    meta, body_md = parse_frontmatter(text)

    title = meta.get("title", md_path.stem)
    date = meta.get("date", "")
    author = meta.get("author", "")
    excerpt = meta.get("excerpt", "")
    thumbnail = meta.get("thumbnail", "")

    body_html = md_to_html(body_md)

    # frontmatter 由来の値は HTML エスケープして埋め込む（本文は Markdown 変換済みなので除く）
    author_html = f'<span class="post-author">{escape(author)}</span>' if author else ""
    thumbnail_html = (
        f'<div class="post-thumbnail"><img src="{escape(thumbnail)}" alt="{escape(title)}"></div>'
        if thumbnail
        else ""
    )

    html = POST_HTML_TEMPLATE.format(
        title=escape(title),
        date=escape(date),
        date_ja=escape(format_date_ja(date)),
        author_html=author_html,
        thumbnail_html=thumbnail_html,
        body=body_html,
    )

    slug = md_path.stem
    out_path = POSTS_DIR / f"{slug}.html"
    out_path.write_text(html, encoding="utf-8")
    print(f"  ✓ {slug}.html")

    return {
        "slug": slug,
        "title": title,
        "date": date,
        "author": author,
        "excerpt": excerpt,
        "thumbnail": thumbnail,
        "path": f"posts/{slug}.html",
    }


def main():
    md_files = sorted(POSTS_DIR.glob("*.md"), reverse=True)
    if not md_files:
        print("posts/*.md が見つかりません。")
        return

    # template.md はスキップ
    md_files = [f for f in md_files if f.stem != "template"]

    print(f"記事を {len(md_files)} 件変換します...\n")
    posts = []
    for md_path in md_files:
        result = build_post(md_path)
        if result:
            posts.append(result)

    # 日付順（新しい順）でソート
    posts.sort(key=lambda p: p["date"], reverse=True)

    POSTS_JSON.write_text(json.dumps(posts, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nposts.json を更新しました（{len(posts)} 件）")
    print("完了！")


if __name__ == "__main__":
    main()

```

### `programs/html/blog/index.html`

```html
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex">
    <title>ブログ | IKU NAVI</title>
    <link rel="icon" href="../images/favicon.ico">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header class="site-header">
        <nav class="breadcrumb">
            <a href="../index.html">IKU NAVI</a>
            <span></span>
            <span>ブログ</span>
        </nav>
    </header>

    <section class="blog-hero">
        <h1>ブログ</h1>
        <p>プロジェクトの進捗・活動報告</p>
    </section>

    <div class="blog-list-wrapper">
        <div class="post-grid" id="post-grid">
            <div class="empty-state">
                <strong>読み込み中...</strong>
            </div>
        </div>
    </div>

    <footer class="site-footer">
        <a href="../index.html">← IKU NAVI トップへ</a>
    </footer>

    <script>
        async function loadPosts() {
            const grid = document.getElementById('post-grid');
            try {
                const res = await fetch('posts.json');
                const posts = await res.json();

                if (posts.length === 0) {
                    grid.innerHTML = `
                        <div class="empty-state">
                            <strong>まだ記事がありません</strong>
                            <p>posts/*.md を作成して build.py を実行してください。</p>
                        </div>`;
                    return;
                }

                grid.innerHTML = posts.map(post => {
                    const thumbHtml = post.thumbnail
                        ? `<img class="post-card-thumb" src="${escHtml(post.thumbnail)}" alt="${escHtml(post.title)}">`
                        : '';
                    const authorHtml = post.author
                        ? `<span class="post-author">${escHtml(post.author)}</span>`
                        : '';
                    return `
                        <a class="post-card" href="${escHtml(post.path)}">
                            ${thumbHtml}
                            <div class="post-card-body">
                                <div class="post-card-meta">
                                    <time datetime="${escHtml(post.date)}">${formatDateJa(post.date)}</time>
                                    ${authorHtml}
                                </div>
                                <div class="post-card-title">${escHtml(post.title)}</div>
                                <div class="post-card-excerpt">${escHtml(post.excerpt)}</div>
                                <div class="post-card-more">続きを読む →</div>
                            </div>
                        </a>`;
                }).join('');
            } catch (e) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <strong>記事を読み込めませんでした</strong>
                        <p>build.py を実行して posts.json を生成してください。</p>
                    </div>`;
            }
        }

        function formatDateJa(str) {
            const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) return str;
            return `${m[1]}年${parseInt(m[2])}月${parseInt(m[3])}日`;
        }

        function escHtml(s) {
            return String(s ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        loadPosts();
    </script>
</body>
</html>

```

### `programs/html/blog/style.css`

```css
/* ========== リセット & ベース ========== */
*, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

:root {
    --color-bg: #fafafa;
    --color-surface: #ffffff;
    --color-primary: #2563eb;
    --color-primary-dark: #1d4ed8;
    --color-text: #1a1a2e;
    --color-text-muted: #6b7280;
    --color-border: #e5e7eb;
    --color-accent: #eff6ff;
    --font-sans: "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif;
    --font-serif: "Hiragino Mincho ProN", "Noto Serif JP", Georgia, serif;
    --max-width: 860px;
    --radius: 10px;
}

body {
    font-family: var(--font-sans);
    background: var(--color-bg);
    color: var(--color-text);
    line-height: 1.7;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
}

a {
    color: var(--color-primary);
    text-decoration: none;
}

a:hover {
    text-decoration: underline;
}

/* ========== ヘッダー ========== */
.site-header {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 14px 24px;
    position: sticky;
    top: 0;
    z-index: 100;
}

.breadcrumb {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.875rem;
    color: var(--color-text-muted);
    max-width: var(--max-width);
    margin: 0 auto;
}

.breadcrumb span {
    color: var(--color-border);
}

.breadcrumb a {
    color: var(--color-text-muted);
    font-weight: 500;
}

.breadcrumb a:hover {
    color: var(--color-primary);
    text-decoration: none;
}

/* ========== フッター ========== */
.site-footer {
    margin-top: auto;
    padding: 28px 24px;
    border-top: 1px solid var(--color-border);
    text-align: center;
    font-size: 0.875rem;
    color: var(--color-text-muted);
}

/* ========== ブログ一覧ページ ========== */
.blog-hero {
    background: var(--color-surface);
    border-bottom: 1px solid var(--color-border);
    padding: 48px 24px 40px;
    text-align: center;
}

.blog-hero h1 {
    font-size: 2rem;
    font-weight: 700;
    letter-spacing: -0.02em;
}

.blog-hero p {
    margin-top: 8px;
    color: var(--color-text-muted);
    font-size: 0.95rem;
}

.blog-list-wrapper {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 40px 24px 64px;
    flex: 1;
}

.post-grid {
    display: grid;
    gap: 24px;
}

/* -------- カード -------- */
.post-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: box-shadow 0.2s, border-color 0.2s;
    text-decoration: none;
    color: inherit;
}

.post-card:hover {
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
    border-color: var(--color-primary);
    text-decoration: none;
}

.post-card-thumb {
    width: 100%;
    aspect-ratio: 16 / 7;
    object-fit: cover;
    display: block;
}

.post-card-body {
    padding: 20px 24px 24px;
    flex: 1;
    display: flex;
    flex-direction: column;
}

.post-card-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 0.8rem;
    color: var(--color-text-muted);
    margin-bottom: 10px;
}

.post-card-title {
    font-size: 1.15rem;
    font-weight: 700;
    line-height: 1.4;
    margin-bottom: 10px;
}

.post-card-excerpt {
    font-size: 0.9rem;
    color: var(--color-text-muted);
    flex: 1;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.post-card-more {
    margin-top: 16px;
    font-size: 0.85rem;
    color: var(--color-primary);
    font-weight: 600;
}

/* 空状態 */
.empty-state {
    text-align: center;
    padding: 80px 0;
    color: var(--color-text-muted);
}

.empty-state p {
    margin-top: 8px;
    font-size: 0.9rem;
}

/* ========== 記事ページ ========== */
.post-container {
    max-width: var(--max-width);
    margin: 0 auto;
    padding: 48px 24px 80px;
    flex: 1;
    width: 100%;
}

.post {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    overflow: hidden;
}

.post-meta {
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 0.85rem;
    color: var(--color-text-muted);
    padding: 28px 40px 0;
}

.post-author {
    background: var(--color-accent);
    color: var(--color-primary);
    padding: 2px 10px;
    border-radius: 20px;
    font-weight: 600;
}

.post-title {
    font-size: 1.75rem;
    font-weight: 800;
    line-height: 1.35;
    letter-spacing: -0.02em;
    padding: 16px 40px 28px;
}

.post-thumbnail {
    margin: 0 0 8px;
}

.post-thumbnail img {
    width: 100%;
    max-height: 420px;
    object-fit: cover;
    display: block;
}

/* 本文 */
.post-body {
    padding: 36px 40px 48px;
    font-size: 1rem;
    line-height: 1.85;
}

.post-body h2 {
    font-size: 1.3rem;
    font-weight: 700;
    margin: 2.5em 0 0.8em;
    padding-bottom: 6px;
    border-bottom: 2px solid var(--color-border);
}

.post-body h3 {
    font-size: 1.1rem;
    font-weight: 700;
    margin: 2em 0 0.6em;
    color: var(--color-primary-dark);
}

.post-body p {
    margin-bottom: 1.2em;
}

.post-body ul, .post-body ol {
    margin: 0.8em 0 1.2em 1.5em;
}

.post-body li {
    margin-bottom: 0.4em;
}

.post-body img {
    max-width: 100%;
    border-radius: 6px;
    margin: 1.5em 0;
    display: block;
}

.post-body strong {
    font-weight: 700;
}

.post-body a {
    color: var(--color-primary);
    border-bottom: 1px solid currentColor;
}

.post-body blockquote {
    border-left: 4px solid var(--color-primary);
    padding: 10px 20px;
    margin: 1.5em 0;
    color: var(--color-text-muted);
    background: var(--color-accent);
    border-radius: 0 6px 6px 0;
}

.post-body code {
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.9em;
    font-family: "SF Mono", Consolas, monospace;
}

.post-body pre {
    background: #1e293b;
    color: #e2e8f0;
    padding: 20px 24px;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.5em 0;
}

.post-body pre code {
    background: none;
    padding: 0;
    font-size: 0.88em;
    color: inherit;
}

.post-body hr {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 2.5em 0;
}

/* ========== レスポンシブ ========== */
@media (max-width: 640px) {
    .blog-hero h1 { font-size: 1.5rem; }
    .post-title { font-size: 1.35rem; padding: 16px 24px 20px; }
    .post-meta { padding: 20px 24px 0; }
    .post-body { padding: 24px 24px 36px; }
}

```

### 10.3 開発・検証ツール群

#### Map_Editor

### `programs/gui_common/__init__.py`

```python
"""IKU NAVI のデスクトップツール（PyQt6）が共有するモジュール。

各ツールは自分のディレクトリから `python main.py` のように起動されるため、
このパッケージを import する前に親ディレクトリ（programs/）を sys.path に足す:

    import sys
    from pathlib import Path
    sys.path.append(str(Path(__file__).resolve().parents[1]))

    from gui_common.theme import ACCENT, base_stylesheet
"""
```

### `programs/gui_common/paths.py`

```python
"""リポジトリ内のデータ・素材ディレクトリの位置。

ツールごとに `Path(__file__).resolve().parents[2]` を書いていると、ファイルを
サブディレクトリへ移した時に静かに壊れるため、ここ一箇所で解決する。
"""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

DATA_DIR  = REPO_ROOT / "data"
SVG_DIR   = REPO_ROOT / "programs" / "html" / "svg"
PHOTO_DIR = REPO_ROOT / "captured_photos"

BUILDING_NAME_CSV = DATA_DIR / "building_name.csv"
EVENT_CSV         = DATA_DIR / "event.csv"
GLOBAL_NODE_CSV   = DATA_DIR / "global_node.csv"
GLOBAL_EDGE_CSV   = DATA_DIR / "global_edge.csv"
EDGE_IMAGE_CSV    = DATA_DIR / "edge_image.csv"


def building_dir(building) -> Path:
    """data/{building}_bldg/"""
    return DATA_DIR / f"{building}_bldg"
```

### `programs/gui_common/api.py`

```python
"""経路探索API（programs/3D_Graph）へのアクセス。

チェッカー系ツールは何百リクエストも並列に投げるため、リトライ付きの
Session を使う。ツールによって必要なヘッダとリトライ回数が違うので引数で渡す。
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_API = "http://localhost:5001"

JSON_HEADERS = {"Accept": "application/json"}

# CDN(Cloudflare)への画像取得はブラウザからのアクセスに見せる必要がある。
# Accept-Encoding に "br" を入れると Cloudflare が Brotli で返し、
# brotli パッケージ未インストール環境では解凍できず空になるため除外。
# requests のデフォルト (gzip, deflate) に任せる。
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Connection":      "keep-alive",
}


def make_session(headers=None, total=2, backoff_factor=0.3,
                 status_forcelist=(500, 502, 503, 504)) -> requests.Session:
    """リトライを設定した requests.Session を返す"""
    session = requests.Session()
    if headers:
        session.headers.update(headers)
    adapter = HTTPAdapter(max_retries=Retry(
        total=total, backoff_factor=backoff_factor,
        status_forcelist=list(status_forcelist)))
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session
```

### `programs/gui_common/labels.py`

```python
"""建物・階・トイレなど、ツール間で表記を揃えたい表示名。"""

TOILET_ROOMS = {"M_Toilet", "F_Toilet", "C_Toilet"}


def building_label(building: int) -> str:
    """0 は屋外、それ以外は「N号館」"""
    return "屋外" if int(building) == 0 else f"{int(building)}号館"


def floor_label(floor: int) -> str:
    """0 は屋外、それ以外は「NF」"""
    return "屋外" if int(floor) == 0 else f"{int(floor)}F"
```

### `programs/gui_common/theme.py`

```python
"""チェッカー系ツール（Route_Checker / Image_Checker）共通のダークテーマ。

色を変えるときはここを直せば両方のツールに反映される。
ツール固有の色（カードの背景など）は各ツール側で定義すること。
"""

BG_WIN      = "#111827"   # ウィンドウ地色
BG_BAR      = "#1F2937"   # ツールバー・スクロールバー
BORDER      = "#2D3748"

TXT_PRIMARY = "#F1F5F9"
TXT_SUB     = "#94A3B8"
TXT_KEY     = "#CBD5E1"

ACCENT      = "#00B8E6"
BTN_ACTIVE  = "#0E7490"
BTN_IDLE    = "#374151"

INPUT_BG     = "#374151"
INPUT_BORDER = "#4B5563"

COL_OK   = "#4ADE80"
COL_WARN = "#FBBF24"
COL_ERR  = "#F87171"


def base_stylesheet() -> str:
    """ウィンドウ・スクロールバー・入力欄・進捗バーの共通スタイル。

    各ツールは自分固有のスタイル（テーブルやカードなど）を後ろに連結して使う。
    """
    return f"""
            QMainWindow, QWidget  {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
            QScrollArea           {{ background: {BG_WIN}; border: none; }}
            QScrollBar:vertical   {{ background: {BG_BAR}; width: 8px; border-radius: 4px; }}
            QScrollBar::handle:vertical {{
                background: {INPUT_BORDER}; border-radius: 4px; min-height: 20px;
            }}
            QScrollBar:horizontal {{ background: {BG_BAR}; height: 8px; border-radius: 4px; }}
            QScrollBar::handle:horizontal {{
                background: {INPUT_BORDER}; border-radius: 4px; min-width: 20px;
            }}
            QLineEdit {{
                background: {INPUT_BG}; color: {TXT_PRIMARY};
                border: 1px solid {INPUT_BORDER}; border-radius: 6px;
                padding: 5px 10px; font-size: 15px;
            }}
            QLineEdit:focus {{ border-color: {ACCENT}; }}
            QProgressBar {{
                background: {INPUT_BG}; border: none; border-radius: 4px;
                color: transparent;
            }}
            QProgressBar::chunk {{ background: {ACCENT}; border-radius: 4px; }}
    """
```

### `programs/gui_common/qt_app.py`

```python
"""PyQt6ツールの起動処理（どのツールも中身が同じなのでまとめている）。"""
import sys

from PyQt6.QtWidgets import QApplication


def run(window_factory):
    """QApplication を作り、window_factory() のウィンドウを表示して実行する"""
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = window_factory()
    window.show()
    sys.exit(app.exec())
```

### `programs/Map_Editor/main.py`

```python
#!/usr/bin/env python3
"""
IKU NAVI Map Editor — エントリーポイント

SVGフロアマップ上でノード/エッジのデータ入力・削除・撮影を1画面で行うツール。
使い方は同ディレクトリの README.md を参照。

Usage:
  python main.py

依存:
  pip install -r requirements.txt
"""

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common import qt_app

from app_window import MainWindow


def main():
    qt_app.run(MainWindow)


if __name__ == "__main__":
    main()
```

### `programs/Map_Editor/app_window.py`

```python
#!/usr/bin/env python3
"""IKU NAVI Map Editor — メインウィンドウ"""

import cv2

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QButtonGroup, QComboBox, QFileDialog,
    QHBoxLayout, QLabel, QListWidget, QMainWindow, QMessageBox,
    QPushButton, QSpinBox, QSplitter, QStackedWidget, QVBoxLayout, QWidget,
)

from camera_panel import bgr_frame_to_pixmap, CameraPanel
from data_store import (
    EDGE_TYPE_LABELS, EdgeImageStore, BuildingData, NODE_TYPE_LABELS,
    PHOTO_DIR, global_id, list_buildings, svg_path_for, to_int,
)
from dialogs import EdgeDialog, NodeDialog, suggest_edge_type
from svg_canvas import SvgCanvas

MODE_LABELS = [
    (SvgCanvas.MODE_MOVE,   "🖐 移動"),
    (SvgCanvas.MODE_INPUT,  "✏️ 入力"),
    (SvgCanvas.MODE_DELETE, "🗑 削除"),
    (SvgCanvas.MODE_CAMERA, "📷 撮影"),
]

MODE_HINT = {
    SvgCanvas.MODE_MOVE:   "ドラッグでパン・ホイールでズームします（クリックでは何も起きません）。",
    SvgCanvas.MODE_INPUT:  "空白をクリックしてノードを追加。既存ノードを2つ順にクリックするとエッジを作成します（Escで選択解除）。",
    SvgCanvas.MODE_DELETE: "ノードまたはエッジをクリックして削除します。ノード削除時は接続エッジも削除されます。",
    SvgCanvas.MODE_CAMERA: "撮影したいエッジ（線）をクリックして選択し、右パネルから撮影してください。",
}


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("IKU NAVI Map Editor")
        self.resize(1440, 900)

        self.building_data: BuildingData | None = None
        self.edge_image_store = EdgeImageStore()
        self.current_building: int | None = None
        self.current_floor: int = 1
        self.selected_edge_id: int | None = None

        self._build_ui()
        self._connect_canvas_signals()
        self._reload_building_list()

    # ------------------------------------------------------------------
    # UI 構築
    # ------------------------------------------------------------------
    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(0)

        vbox.addWidget(self._build_topbar())
        vbox.addWidget(self._build_modebar())

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.canvas = SvgCanvas()
        splitter.addWidget(self.canvas)

        self.side_stack = QStackedWidget()
        self.side_stack.addWidget(self._build_info_page())
        self.side_stack.addWidget(self._build_camera_page())
        self.side_stack.setFixedWidth(360)
        splitter.addWidget(self.side_stack)
        splitter.setSizes([1080, 360])
        vbox.addWidget(splitter, 1)

        self.statusBar().showMessage("建物を選択してください")

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setStyleSheet("background:#1F2937;")
        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 8, 12, 8)
        row.setSpacing(10)

        title = QLabel("IKU NAVI Map Editor")
        title.setFont(QFont("", 15, QFont.Weight.Bold))
        title.setStyleSheet("color:#00B8E6;")
        row.addWidget(title)

        row.addSpacing(16)
        row.addWidget(self._lbl("建物:"))
        self.building_combo = QComboBox()
        self.building_combo.currentIndexChanged.connect(self._on_building_changed)
        row.addWidget(self.building_combo)

        rescan_btn = QPushButton("再スキャン")
        rescan_btn.clicked.connect(self._reload_building_list)
        row.addWidget(rescan_btn)

        row.addSpacing(8)
        row.addWidget(self._lbl("階:"))
        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(1)
        self.floor_spin.valueChanged.connect(self._on_floor_changed)
        row.addWidget(self.floor_spin)

        self.floors_hint_label = self._lbl("")
        row.addWidget(self.floors_hint_label)

        row.addSpacing(8)
        self.svg_path_label = self._lbl("SVG: —")
        row.addWidget(self.svg_path_label)

        browse_btn = QPushButton("SVGを選択...")
        browse_btn.clicked.connect(self._browse_svg)
        row.addWidget(browse_btn)

        row.addStretch()

        self.dirty_label = QLabel("")
        self.dirty_label.setStyleSheet("color:#FBBF24; font-weight:bold;")
        row.addWidget(self.dirty_label)

        save_btn = QPushButton("💾 保存")
        save_btn.setStyleSheet(
            "QPushButton{background:#059669;color:white;padding:6px 16px;border-radius:6px;font-weight:bold;}"
        )
        save_btn.clicked.connect(self._save_all)
        row.addWidget(save_btn)

        return bar

    def _build_modebar(self) -> QWidget:
        bar = QWidget()
        bar.setStyleSheet("background:#111827; border-bottom:1px solid #2D3748;")
        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 6, 12, 6)
        row.setSpacing(6)

        self.mode_group = QButtonGroup(self)
        self.mode_group.setExclusive(True)
        for mode, label in MODE_LABELS:
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setStyleSheet("""
                QPushButton { padding:6px 14px; border-radius:6px; color:#CBD5E1; background:#1F2937; border:none; }
                QPushButton:checked { background:#0E7490; color:white; font-weight:bold; }
            """)
            btn.clicked.connect(lambda _checked, m=mode: self._set_mode(m))
            self.mode_group.addButton(btn)
            row.addWidget(btn)
            if mode == SvgCanvas.MODE_MOVE:
                btn.setChecked(True)

        row.addSpacing(16)
        self.mode_hint_label = QLabel(MODE_HINT[SvgCanvas.MODE_MOVE])
        self.mode_hint_label.setStyleSheet("color:#94A3B8; font-size:12px;")
        row.addWidget(self.mode_hint_label, 1)

        return bar

    def _build_info_page(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)

        self.info_summary_label = QLabel("ノード: 0　エッジ: 0")
        self.info_summary_label.setFont(QFont("", 12, QFont.Weight.Bold))
        vbox.addWidget(self.info_summary_label)

        vbox.addWidget(self._lbl("ノード一覧 (現在の階):"))
        self.node_list = QListWidget()
        self.node_list.setFont(QFont("Courier", 10))
        vbox.addWidget(self.node_list, 1)

        vbox.addWidget(self._lbl("エッジ一覧 (現在の階):"))
        self.edge_list = QListWidget()
        self.edge_list.setFont(QFont("Courier", 10))
        vbox.addWidget(self.edge_list, 1)

        note = QLabel(
            "※ svg_x/svg_y が未設定のノードは地図上に表示されません。\n"
            "※ 階をまたぐエッジ（階段・EV等）はこの階の地図上には線が表示されません（両端ノードは各階に表示されます）。"
        )
        note.setStyleSheet("color:#888; font-size:10px;")
        note.setWordWrap(True)
        vbox.addWidget(note)

        return w

    def _build_camera_page(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)

        vbox.addWidget(self._lbl("選択中のエッジ:"))
        self.selected_edge_label = QLabel("（撮影モードで地図上のエッジをクリック）")
        self.selected_edge_label.setWordWrap(True)
        self.selected_edge_label.setStyleSheet("font-weight:bold;")
        vbox.addWidget(self.selected_edge_label)

        self.fwd_status_label = QLabel("")
        self.rev_status_label = QLabel("")
        vbox.addWidget(self.fwd_status_label)
        vbox.addWidget(self.rev_status_label)

        self.camera_panel = CameraPanel()
        vbox.addWidget(self.camera_panel, 1)

        btn_row = QHBoxLayout()
        self.capture_fwd_btn = QPushButton("→ 方向を撮影 (from→to)")
        self.capture_fwd_btn.clicked.connect(lambda: self._capture_direction(reverse=False))
        self.capture_fwd_btn.setEnabled(False)
        btn_row.addWidget(self.capture_fwd_btn)
        self.capture_rev_btn = QPushButton("← 方向を撮影 (to→from)")
        self.capture_rev_btn.clicked.connect(lambda: self._capture_direction(reverse=True))
        self.capture_rev_btn.setEnabled(False)
        btn_row.addWidget(self.capture_rev_btn)
        vbox.addLayout(btn_row)

        vbox.addWidget(self._lbl("直近の撮影プレビュー:"))
        self.last_photo_label = QLabel("")
        self.last_photo_label.setFixedHeight(120)
        self.last_photo_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.last_photo_label.setStyleSheet("background:#111827; border-radius:6px;")
        vbox.addWidget(self.last_photo_label)

        hint = QLabel(f"保存先フォルダ: {PHOTO_DIR}\n"
                       "撮影した写真はこのフォルダにファイル名(from_to_to.jpg)で保存され、\n"
                       "edge_image.csv への登録は「💾 保存」で確定します。\n"
                       "CDNへのアップロードは別途手動で行ってください。")
        hint.setStyleSheet("color:#888; font-size:10px;")
        hint.setWordWrap(True)
        vbox.addWidget(hint)

        return w

    @staticmethod
    def _lbl(text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet("color:#CBD5E1;")
        return lbl

    def _confirm_yes(self, title: str, msg: str) -> bool:
        """はい/いいえの確認ダイアログを表示し、「はい」が選ばれたかを返す"""
        return QMessageBox.question(self, title, msg) == QMessageBox.StandardButton.Yes

    # ------------------------------------------------------------------
    # 建物・階の切り替え
    # ------------------------------------------------------------------
    def _reload_building_list(self):
        buildings = list_buildings()
        self.building_combo.blockSignals(True)
        self.building_combo.clear()
        for b in buildings:
            self.building_combo.addItem(f"{b}号館", b)
        self.building_combo.blockSignals(False)
        if buildings:
            self.building_combo.setCurrentIndex(0)
            self._on_building_changed(0)

    def _on_building_changed(self, _index: int):
        new_building = self.building_combo.currentData()
        if new_building is None:
            return
        if not self._confirm_discard_if_dirty():
            # ユーザーがキャンセル → コンボを元に戻す
            self.building_combo.blockSignals(True)
            idx = self.building_combo.findData(self.current_building)
            if idx >= 0:
                self.building_combo.setCurrentIndex(idx)
            self.building_combo.blockSignals(False)
            return

        self.current_building = new_building
        self.building_data = BuildingData(new_building)

        floors = self.building_data.floors_present()
        self.floors_hint_label.setText(f"(既存: {', '.join(map(str, floors))})" if floors else "(既存フロアなし)")
        default_floor = floors[0] if floors else 1
        self.floor_spin.blockSignals(True)
        self.floor_spin.setValue(default_floor)
        self.floor_spin.blockSignals(False)
        self.current_floor = default_floor

        self._reload_floor()
        self._update_dirty_indicator()

    def _on_floor_changed(self, value: int):
        self.current_floor = value
        self._reload_floor()

    def _reload_floor(self):
        self.selected_edge_id = None
        self._update_camera_edge_info()
        if self.current_building is None:
            return
        path = svg_path_for(self.current_building, self.current_floor)
        if path.exists():
            ok = self.canvas.load_svg(str(path))
            self.svg_path_label.setText(f"SVG: {path.name}" if ok else f"SVG読込失敗: {path.name}")
        else:
            self.canvas.clear_svg()
            self.svg_path_label.setText(f"SVG: 見つかりません ({path.name})")
        self._refresh_canvas_draw()

    def _browse_svg(self):
        path, _ = QFileDialog.getOpenFileName(self, "SVGファイルを選択", str(PHOTO_DIR.parent),
                                               "SVG files (*.svg);;All files (*)")
        if not path:
            return
        ok = self.canvas.load_svg(path)
        self.svg_path_label.setText(f"SVG: {path}" if ok else "SVG読込失敗")
        expected = svg_path_for(self.current_building or 0, self.current_floor)
        if ok and str(expected) != path:
            self.statusBar().showMessage(
                f"注意: 本番配置場所は {expected} です。保存先を合わせてください。", 8000
            )
        self._refresh_canvas_draw()

    # ------------------------------------------------------------------
    # モード切り替え
    # ------------------------------------------------------------------
    def _set_mode(self, mode: str):
        # 撮影モードから離れる際はカメラを解放する
        if self.canvas.mode == SvgCanvas.MODE_CAMERA and mode != SvgCanvas.MODE_CAMERA:
            self.camera_panel.disconnect_camera()

        self.canvas.set_mode(mode)
        self.mode_hint_label.setText(MODE_HINT[mode])
        self.side_stack.setCurrentIndex(1 if mode == SvgCanvas.MODE_CAMERA else 0)

        if mode != SvgCanvas.MODE_CAMERA:
            self.selected_edge_id = None
            self.canvas.highlight_edge(None)
            self._update_camera_edge_info()

    # ------------------------------------------------------------------
    # キャンバス信号
    # ------------------------------------------------------------------
    def _connect_canvas_signals(self):
        self.canvas.nodeCreateRequested.connect(self._on_node_create_requested)
        self.canvas.edgeCreateRequested.connect(self._on_edge_create_requested)
        self.canvas.nodeDeleteRequested.connect(self._on_node_delete_requested)
        self.canvas.edgeDeleteRequested.connect(self._on_edge_delete_requested)
        self.canvas.edgeSelectedForPhoto.connect(self._on_edge_selected_for_photo)
        self.canvas.pendingNodeChanged.connect(self._on_pending_node_changed)

    def _on_pending_node_changed(self, node_id):
        if node_id is None:
            self.mode_hint_label.setText(MODE_HINT[SvgCanvas.MODE_INPUT])
        else:
            label = self.building_data.node_label(node_id) if self.building_data else str(node_id)
            self.mode_hint_label.setText(f"接続元: {label} を選択中 → 接続先のノードをクリック（Escで解除）")

    def _on_node_create_requested(self, sx: float, sy: float):
        if self.building_data is None:
            return
        dlg = NodeDialog(default_floor=self.current_floor,
                          default_id=self.building_data.next_node_id(), parent=self)
        if dlg.exec() != NodeDialog.DialogCode.Accepted:
            return
        v = dlg.values()
        if v["id"] in self.building_data.nodes:
            if not self._confirm_yes("上書き確認", f"ノードID {v['id']} は既に存在します。上書きしますか？"):
                return
        self.building_data.add_node(
            v["x"], v["y"], v["z"], v["floor"], v["type"], svg_x=sx, svg_y=sy, node_id=v["id"],
        )
        self._after_data_change()

    def _on_edge_create_requested(self, a_id: int, b_id: int):
        if self.building_data is None:
            return
        xyz_a = self.building_data.node_xyz(a_id)
        xyz_b = self.building_data.node_xyz(b_id)
        if xyz_a is None or xyz_b is None:
            return
        dist = sum((p - q) ** 2 for p, q in zip(xyz_a, xyz_b)) ** 0.5
        floor_a = to_int(self.building_data.nodes[a_id].get("floor"), self.current_floor)
        floor_b = to_int(self.building_data.nodes[b_id].get("floor"), self.current_floor)
        dlg = EdgeDialog(
            label_a=self.building_data.node_label(a_id),
            label_b=self.building_data.node_label(b_id),
            default_floor=min(floor_a, floor_b),
            default_length=dist,
            default_id=self.building_data.next_edge_id(),
            default_type=suggest_edge_type(floor_a, floor_b),
            parent=self,
        )
        if dlg.exec() != EdgeDialog.DialogCode.Accepted:
            return
        v = dlg.values()
        if v["id"] in self.building_data.edges:
            if not self._confirm_yes("上書き確認", f"エッジID {v['id']} は既に存在します。上書きしますか？"):
                return
        self.building_data.add_edge(
            v["name"], a_id, b_id, v["floor"], v["weight"], v["length"], v["type"], edge_id=v["id"],
        )
        self._after_data_change()

    def _on_node_delete_requested(self, node_id: int):
        if self.building_data is None:
            return
        touching = self.building_data.edges_touching_node(node_id)
        msg = f"ノード {node_id} を削除しますか？"
        if touching:
            msg += f"\n関連する {len(touching)} 件のエッジも同時に削除されます。"
        if not self._confirm_yes("削除確認", msg):
            return
        self.building_data.delete_node(node_id)
        self._after_data_change()

    def _on_edge_delete_requested(self, edge_id: int):
        if self.building_data is None:
            return
        row = self.building_data.edges.get(edge_id, {})
        name = row.get("name", "")
        msg = f"エッジ {edge_id}" + (f"（{name}）" if name else "") + " を削除しますか？"
        if not self._confirm_yes("削除確認", msg):
            return
        self.building_data.delete_edge(edge_id)
        if self.selected_edge_id == edge_id:
            self.selected_edge_id = None
            self._update_camera_edge_info()
        self._after_data_change()

    def _after_data_change(self):
        self._refresh_canvas_draw()
        self._update_dirty_indicator()

    # ------------------------------------------------------------------
    # 描画・一覧更新
    # ------------------------------------------------------------------
    def _refresh_canvas_draw(self):
        self.node_list.clear()
        self.edge_list.clear()

        if self.building_data is None:
            self.canvas.render_nodes_edges([], [])
            self.info_summary_label.setText("ノード: 0　エッジ: 0")
            return

        floor = self.current_floor
        nodes = self.building_data.nodes_for_floor(floor)
        edges = self.building_data.edges_for_floor(floor)

        nodes_draw, skipped = [], 0
        for n in nodes:
            svg_xy = self.building_data.node_svg_xy(n["id"])
            type_label = NODE_TYPE_LABELS.get(to_int(n.get("type")), "?")
            self.node_list.addItem(
                f"#{n['id']:>4} ({n.get('x','')},{n.get('y','')},{n.get('z','')}) {type_label}"
                + ("" if svg_xy else "  [SVG未設定]")
            )
            if svg_xy is None:
                skipped += 1
                continue
            nodes_draw.append({
                "id": n["id"], "sx": svg_xy[0], "sy": svg_xy[1],
                "type": to_int(n.get("type")), "label": str(n["id"]),
            })

        edges_draw = []
        for e in edges:
            a, b = to_int(e.get("from")), to_int(e.get("to"))
            xy_a, xy_b = self.building_data.node_svg_xy(a), self.building_data.node_svg_xy(b)
            type_label = EDGE_TYPE_LABELS.get(to_int(e.get("type")), "?")
            self.edge_list.addItem(
                f"#{e['id']:>4} {a}→{b} {e.get('name','')} w={e.get('weight','')} "
                f"l={e.get('length','')} {type_label}"
            )
            if xy_a is None or xy_b is None:
                continue
            edges_draw.append({
                "id": e["id"], "sx0": xy_a[0], "sy0": xy_a[1], "sx1": xy_b[0], "sy1": xy_b[1],
                "type": to_int(e.get("type")),
            })

        self.canvas.render_nodes_edges(nodes_draw, edges_draw)
        if self.selected_edge_id is not None:
            self.canvas.highlight_edge(self.selected_edge_id)

        summary = f"ノード: {len(nodes)}　エッジ: {len(edges)}"
        if skipped:
            summary += f"　(うちSVG未設定: {skipped})"
        self.info_summary_label.setText(summary)

    # ------------------------------------------------------------------
    # 撮影
    # ------------------------------------------------------------------
    def _on_edge_selected_for_photo(self, edge_id: int):
        self.selected_edge_id = edge_id
        self.canvas.highlight_edge(edge_id)
        self._update_camera_edge_info()

    def _update_camera_edge_info(self):
        if self.selected_edge_id is None or self.building_data is None:
            self.selected_edge_label.setText("（撮影モードで地図上のエッジをクリック）")
            self.fwd_status_label.setText("")
            self.rev_status_label.setText("")
            self.capture_fwd_btn.setEnabled(False)
            self.capture_rev_btn.setEnabled(False)
            return

        row = self.building_data.edges.get(self.selected_edge_id)
        if row is None:
            self.selected_edge_id = None
            self._update_camera_edge_info()
            return

        a, b = to_int(row.get("from")), to_int(row.get("to"))
        name = row.get("name", "") or "(名称なし)"
        self.selected_edge_label.setText(f"エッジ #{self.selected_edge_id}: {name}\n{a} → {b}")

        g_a, g_b = global_id(self.current_building, a), global_id(self.current_building, b)

        fwd = self.edge_image_store.find(g_a, g_b)
        rev = self.edge_image_store.find(g_b, g_a)
        self.fwd_status_label.setText(
            f"→ 方向 ({g_a}→{g_b}): " + (f"登録済み ({fwd['image_name']})" if fwd else "未登録")
        )
        self.rev_status_label.setText(
            f"← 方向 ({g_b}→{g_a}): " + (f"登録済み ({rev['image_name']})" if rev else "未登録")
        )
        self.capture_fwd_btn.setEnabled(True)
        self.capture_rev_btn.setEnabled(True)

    def _capture_direction(self, reverse: bool):
        if self.selected_edge_id is None or self.building_data is None:
            return
        row = self.building_data.edges.get(self.selected_edge_id)
        if row is None:
            QMessageBox.warning(self, "エラー", "選択中のエッジが見つかりません（削除された可能性があります）。")
            return
        frame = self.camera_panel.capture()
        if frame is None:
            QMessageBox.warning(self, "エラー", "カメラが接続されていないか、フレームを取得できません。\n上部の「接続」ボタンでカメラを接続してください。")
            return

        a, b = to_int(row.get("from")), to_int(row.get("to"))
        if reverse:
            a, b = b, a
        g_a, g_b = global_id(self.current_building, a), global_id(self.current_building, b)
        filename = f"{g_a}_to_{g_b}.jpg"
        out_path = PHOTO_DIR / filename

        if out_path.exists():
            if not self._confirm_yes("上書き確認", f"{filename} は既に存在します。上書きしますか？"):
                return

        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), frame)
        self.edge_image_store.upsert(g_a, g_b, filename)

        self.last_photo_label.setPixmap(bgr_frame_to_pixmap(frame, self.last_photo_label.size()))

        self.statusBar().showMessage(f"撮影しました: {filename}（保存ボタンで edge_image.csv に反映）", 6000)
        self._update_camera_edge_info()
        self._update_dirty_indicator()

    # ------------------------------------------------------------------
    # 保存・終了
    # ------------------------------------------------------------------
    def _is_dirty(self) -> bool:
        return (self.building_data is not None and self.building_data.dirty) or self.edge_image_store.dirty

    def _update_dirty_indicator(self):
        dirty = self._is_dirty()
        self.dirty_label.setText("● 未保存の変更あり" if dirty else "")
        title = "IKU NAVI Map Editor"
        if self.current_building is not None:
            title += f" — {self.current_building}号館"
        if dirty:
            title += " *"
        self.setWindowTitle(title)

    def _save_all(self):
        if self.building_data is not None:
            self.building_data.save()
        self.edge_image_store.save()
        self._update_dirty_indicator()
        self.statusBar().showMessage("保存しました。", 4000)

    def _confirm_discard_if_dirty(self) -> bool:
        """未保存の変更があれば確認する。続行してよければ True を返す（保存 or 破棄選択時）"""
        if not self._is_dirty():
            return True
        reply = QMessageBox.question(
            self, "未保存の変更",
            "未保存の変更があります。保存してから続けますか？",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if reply == QMessageBox.StandardButton.Save:
            self._save_all()
            return True
        if reply == QMessageBox.StandardButton.Discard:
            return True
        return False

    def closeEvent(self, event):
        if not self._confirm_discard_if_dirty():
            event.ignore()
            return
        self.camera_panel.disconnect_camera()
        super().closeEvent(event)

```

### `programs/Map_Editor/camera_panel.py`

```python
#!/usr/bin/env python3
"""
IKU NAVI Map Editor — カメラプレビュー・撮影パネル
OpenCV (cv2.VideoCapture) でライブプレビューを表示し、ボタン押下でフレームを取得する。
実際のファイル保存・edge_image.csv 登録は app_window 側で行う（このクラスは撮影のみ担当）。
"""

import cv2
import numpy as np
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

MAX_DEVICE_INDEX = 4


def bgr_frame_to_pixmap(frame: np.ndarray, target_size) -> QPixmap:
    """OpenCV の BGR numpy フレームを、指定サイズに収まるよう縮小した QPixmap に変換する"""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    h, w, _ = rgb.shape
    qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(qimg).scaled(
        target_size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation,
    )


class CameraPanel(QWidget):

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cap = None
        self._last_frame = None   # numpy BGR
        self._timer = QTimer(self)
        self._timer.setInterval(33)  # ~30fps
        self._timer.timeout.connect(self._grab_frame)
        self._build_ui()

    def _build_ui(self):
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(0, 0, 0, 0)

        row = QHBoxLayout()
        row.addWidget(QLabel("カメラ:"))
        self.device_combo = QComboBox()
        for i in range(MAX_DEVICE_INDEX + 1):
            self.device_combo.addItem(f"デバイス {i}", i)
        row.addWidget(self.device_combo)

        self.connect_btn = QPushButton("接続")
        self.connect_btn.clicked.connect(self._toggle_connect)
        row.addWidget(self.connect_btn)
        row.addStretch()
        vbox.addLayout(row)

        self.preview_label = QLabel("カメラ未接続")
        self.preview_label.setMinimumSize(320, 240)
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setStyleSheet(
            "background:#111827; color:#94A3B8; border-radius:8px; font-size:13px;"
        )
        vbox.addWidget(self.preview_label, 1)

        self.status_label = QLabel("")
        self.status_label.setStyleSheet("color:#666; font-size:11px;")
        vbox.addWidget(self.status_label)

    # ------------------------------------------------------------------
    def _toggle_connect(self):
        if self._cap is not None:
            self.disconnect_camera()
        else:
            self.connect_camera(self.device_combo.currentData())

    def connect_camera(self, device_index: int) -> bool:
        self.disconnect_camera()
        cap = cv2.VideoCapture(device_index)
        if not cap.isOpened():
            cap.release()
            self.status_label.setText(f"デバイス {device_index} に接続できませんでした。")
            return False
        self._cap = cap
        self.connect_btn.setText("切断")
        self.status_label.setText(f"デバイス {device_index} に接続しました。")
        self._timer.start()
        return True

    def disconnect_camera(self):
        self._timer.stop()
        if self._cap is not None:
            self._cap.release()
        self._cap = None
        self._last_frame = None
        self.preview_label.setPixmap(QPixmap())
        self.preview_label.setText("カメラ未接続")
        self.connect_btn.setText("接続")

    def is_connected(self) -> bool:
        return self._cap is not None

    def _grab_frame(self):
        if self._cap is None:
            return
        ok, frame = self._cap.read()
        if not ok:
            return
        self._last_frame = frame
        self.preview_label.setPixmap(bgr_frame_to_pixmap(frame, self.preview_label.size()))

    def capture(self) -> np.ndarray | None:
        """現在のフレーム(BGR numpy array)を返す。未接続・未取得なら None"""
        if self._last_frame is None:
            return None
        return self._last_frame.copy()

    def closeEvent(self, event):
        self.disconnect_camera()
        super().closeEvent(event)

```

### `programs/Map_Editor/data_store.py`

```python
#!/usr/bin/env python3
"""
IKU NAVI Map Editor — データ層
data/{building}_bldg/node.csv・edge.csv・data/edge_image.csv の読み書きを担当する。

座標系・CSV仕様は docs/XYZ_Design.md に準拠:
  - node.csv: id,x,y,z,building,floor,type[,svg_x,svg_y]  (建物ローカル座標)
  - edge.csv: id,name,from,to,building,floor,weight,length,type
  - edge_image.csv: id,from,to,image_name  (from/to はグローバルID)
  - グローバルID = building * 100000 + ローカルID (app.py の ID_OFFSET と同じ)
"""

import csv
import re
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common.paths import DATA_DIR, PHOTO_DIR, REPO_ROOT, SVG_DIR  # noqa: F401  (他モジュールが data_store 経由で参照する)

ID_OFFSET = 100_000  # programs/3D_Graph/ikunavi/config.py の ID_OFFSET と一致させること

NODE_TYPE_LABELS = {1: "通常ノード", 2: "出入り口"}
EDGE_TYPE_LABELS = {
    1: "通常通路",
    2: "階段",
    3: "エスカレータ(両方向)",
    4: "エレベータ",
    5: "上りエスカレータ",
    6: "下りエスカレータ",
    7: "入口(屋内外接続)",
}


def to_int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def global_id(building: int, local_id: int) -> int:
    return int(building) * ID_OFFSET + int(local_id)


def svg_path_for(building: int, floor: int) -> Path:
    return SVG_DIR / f"{building}_{floor}F.svg"


def list_buildings() -> list:
    """data/*_bldg ディレクトリから建物IDの一覧を返す"""
    ids = []
    if not DATA_DIR.exists():
        return ids
    for p in sorted(DATA_DIR.glob("*_bldg")):
        m = re.match(r"(\d+)_bldg", p.name)
        if m:
            ids.append(int(m.group(1)))
    return ids


def _read_csv_by_id(path: Path) -> dict:
    """id列をキーとする辞書として CSV を読み込む（存在しなければ空の辞書を返す）"""
    rows = {}
    if not path.exists():
        return rows
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid = to_int(row.get("id"))
            if rid is None:
                continue
            rows[rid] = dict(row)
    return rows


def _write_csv(path: Path, cols: list, rows: dict):
    """id をキーとする辞書の内容を、id昇順でCSVに書き出す"""
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for key in sorted(rows):
            row = rows[key]
            w.writerow({c: row.get(c, "") for c in cols})


class BuildingData:
    """1建物分の node.csv / edge.csv をメモリに保持し、読み書きする"""

    NODE_BASE_COLS = ["id", "x", "y", "z", "building", "floor", "type"]
    EDGE_COLS = ["id", "name", "from", "to", "building", "floor", "weight", "length", "type"]

    def __init__(self, building: int):
        self.building = building
        self.dir = DATA_DIR / f"{building}_bldg"
        self.node_path = self.dir / "node.csv"
        self.edge_path = self.dir / "edge.csv"
        self.nodes = {}   # id(int) -> row(dict, 値はCSVの生文字列/数値混在)
        self.edges = {}   # id(int) -> row(dict)
        self._node_cols = list(self.NODE_BASE_COLS)
        self.dirty = False
        self.load()

    # ------------------------------------------------------------------
    def load(self):
        self.nodes.clear()
        self.edges.clear()
        self.dirty = False

        if self.node_path.exists():
            with open(self.node_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                self._node_cols = list(reader.fieldnames or self.NODE_BASE_COLS)
                for row in reader:
                    nid = to_int(row.get("id"))
                    if nid is None:
                        continue
                    self.nodes[nid] = dict(row)
        else:
            self._node_cols = list(self.NODE_BASE_COLS)

        if "svg_x" not in self._node_cols:
            self._node_cols = self._node_cols + ["svg_x", "svg_y"]

        self.edges.update(_read_csv_by_id(self.edge_path))

    # ------------------------------------------------------------------
    # 参照系
    # ------------------------------------------------------------------
    def floors_present(self) -> list:
        floors = {to_int(r.get("floor")) for r in self.nodes.values()}
        floors.discard(None)
        return sorted(floors)

    def nodes_for_floor(self, floor: int) -> list:
        return [dict(r, id=nid) for nid, r in self.nodes.items()
                if to_int(r.get("floor")) == floor]

    def edges_for_floor(self, floor: int) -> list:
        """
        両端ノードが「実際に」指定フロアにあるエッジのみを返す（2D描画可能なもの）。
        階段/エレベータ等で両端ノードのフロアが異なる（＝別SVGの座標系にまたがる）
        エッジは、edge.floor列の値に関わらず対象外とする。
        """
        out = []
        for eid, r in self.edges.items():
            fr, to = to_int(r.get("from")), to_int(r.get("to"))
            n_fr, n_to = self.nodes.get(fr), self.nodes.get(to)
            if n_fr is None or n_to is None:
                continue
            if to_int(n_fr.get("floor")) != floor or to_int(n_to.get("floor")) != floor:
                continue
            out.append(dict(r, id=eid))
        return out

    def edges_touching_node(self, node_id: int) -> list:
        """指定ノードを端点に持つ全エッジ（他フロアに跨るものも含む）"""
        out = []
        for eid, r in self.edges.items():
            if to_int(r.get("from")) == node_id or to_int(r.get("to")) == node_id:
                out.append(dict(r, id=eid))
        return out

    def node_label(self, node_id: int) -> str:
        r = self.nodes.get(node_id)
        if not r:
            return f"id={node_id}(不明)"
        fl = to_int(r.get("floor"))
        return f"id={node_id} ({self.building}号館 {fl}F)"

    def node_xyz(self, node_id: int):
        r = self.nodes.get(node_id)
        if not r:
            return None
        return (to_float(r.get("x")), to_float(r.get("y")), to_float(r.get("z")))

    def node_svg_xy(self, node_id: int):
        r = self.nodes.get(node_id)
        if not r or r.get("svg_x") in (None, ""):
            return None
        try:
            return (float(r["svg_x"]), float(r["svg_y"]))
        except (TypeError, ValueError):
            return None

    def next_node_id(self) -> int:
        return (max(self.nodes.keys()) + 1) if self.nodes else 1

    def next_edge_id(self) -> int:
        return (max(self.edges.keys()) + 1) if self.edges else 1

    # ------------------------------------------------------------------
    # 変更系
    # ------------------------------------------------------------------
    def add_node(self, x, y, z, floor, node_type, svg_x=None, svg_y=None, node_id=None) -> int:
        nid = node_id if node_id is not None else self.next_node_id()
        row = {c: "" for c in self._node_cols}
        row.update({
            "id": nid, "x": x, "y": y, "z": z,
            "building": self.building, "floor": floor, "type": node_type,
        })
        if svg_x is not None:
            row["svg_x"] = svg_x
            row["svg_y"] = svg_y
        self.nodes[nid] = row
        self.dirty = True
        return nid

    def delete_node(self, node_id: int) -> list:
        """ノードを削除し、参照していたエッジも連鎖削除する。削除したエッジIDのリストを返す"""
        self.nodes.pop(node_id, None)
        dead = [eid for eid, r in self.edges.items()
                if to_int(r.get("from")) == node_id or to_int(r.get("to")) == node_id]
        for eid in dead:
            self.edges.pop(eid, None)
        self.dirty = True
        return dead

    def add_edge(self, name, from_id, to_id, floor, weight, length, edge_type, edge_id=None) -> int:
        eid = edge_id if edge_id is not None else self.next_edge_id()
        self.edges[eid] = {
            "id": eid, "name": name, "from": from_id, "to": to_id,
            "building": self.building, "floor": floor,
            "weight": weight, "length": length, "type": edge_type,
        }
        self.dirty = True
        return eid

    def delete_edge(self, edge_id: int):
        self.edges.pop(edge_id, None)
        self.dirty = True

    # ------------------------------------------------------------------
    def save(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        _write_csv(self.node_path, self._node_cols, self.nodes)
        _write_csv(self.edge_path, self.EDGE_COLS, self.edges)
        self.dirty = False


class EdgeImageStore:
    """data/edge_image.csv の読み書き"""

    COLS = ["id", "from", "to", "image_name"]

    def __init__(self):
        self.path = DATA_DIR / "edge_image.csv"
        self.rows = {}
        self.dirty = False
        self.load()

    def load(self):
        self.rows.clear()
        self.dirty = False
        self.rows.update(_read_csv_by_id(self.path))

    def find(self, from_id: int, to_id: int):
        for row in self.rows.values():
            if to_int(row.get("from")) == from_id and to_int(row.get("to")) == to_id:
                return row
        return None

    def upsert(self, from_id: int, to_id: int, image_name: str) -> int:
        existing = self.find(from_id, to_id)
        if existing is not None:
            existing["image_name"] = image_name
            self.dirty = True
            return to_int(existing["id"])
        rid = (max(self.rows.keys()) + 1) if self.rows else 1
        self.rows[rid] = {"id": rid, "from": from_id, "to": to_id, "image_name": image_name}
        self.dirty = True
        return rid

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _write_csv(self.path, self.COLS, self.rows)
        self.dirty = False
```

### `programs/Map_Editor/dialogs.py`

```python
#!/usr/bin/env python3
"""IKU NAVI Map Editor — ノード/エッジ入力ダイアログ"""

from PyQt6.QtWidgets import (
    QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFormLayout,
    QLabel, QLineEdit, QSpinBox,
)

from data_store import EDGE_TYPE_LABELS, NODE_TYPE_LABELS


def _add_ok_cancel_buttons(dialog: QDialog, form: QFormLayout):
    """OK/キャンセルの QDialogButtonBox をフォームの最後の行として追加する"""
    buttons = QDialogButtonBox(
        QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
    )
    buttons.accepted.connect(dialog.accept)
    buttons.rejected.connect(dialog.reject)
    form.addRow(buttons)


class NodeDialog(QDialog):
    """入力モードでSVGをクリックした際、実座標(x,y,z)を入力するダイアログ"""

    def __init__(self, default_floor: int, default_id: int, parent=None):
        super().__init__(parent)
        self.setWindowTitle("ノードを追加")
        self.setMinimumWidth(340)

        form = QFormLayout(self)

        self.id_spin = QSpinBox()
        self.id_spin.setRange(1, 999999)
        self.id_spin.setValue(default_id)
        form.addRow("ノードID:", self.id_spin)

        self.x_spin = self._make_coord_spin()
        self.y_spin = self._make_coord_spin()
        self.z_spin = self._make_coord_spin()
        form.addRow("X座標 (m):", self.x_spin)
        form.addRow("Y座標 (m):", self.y_spin)
        form.addRow("Z座標 (m, 高さ):", self.z_spin)

        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(default_floor)
        form.addRow("階:", self.floor_spin)

        self.type_combo = QComboBox()
        for v, label in NODE_TYPE_LABELS.items():
            self.type_combo.addItem(f"{v}: {label}", v)
        form.addRow("種別:", self.type_combo)

        hint = QLabel("SVG上のクリック位置(svg_x/svg_y)は自動で記録されます。\n"
                       "実際のメートル座標(建物ローカル)だけをここで入力してください。")
        hint.setStyleSheet("color:#666;font-size:11px;")
        hint.setWordWrap(True)
        form.addRow(hint)

        _add_ok_cancel_buttons(self, form)

    @staticmethod
    def _make_coord_spin() -> QDoubleSpinBox:
        sp = QDoubleSpinBox()
        sp.setRange(-100000.0, 100000.0)
        sp.setDecimals(1)
        sp.setSingleStep(0.5)
        return sp

    def values(self) -> dict:
        return {
            "id": self.id_spin.value(),
            "x": self.x_spin.value(),
            "y": self.y_spin.value(),
            "z": self.z_spin.value(),
            "floor": self.floor_spin.value(),
            "type": self.type_combo.currentData(),
        }


class EdgeDialog(QDialog):
    """入力モードでノードを2つ選んだ際、エッジ情報を入力するダイアログ"""

    def __init__(self, label_a: str, label_b: str, default_floor: int,
                 default_length: float, default_id: int,
                 default_type: int = 1, parent=None):
        super().__init__(parent)
        self.setWindowTitle("エッジを追加")
        self.setMinimumWidth(360)

        form = QFormLayout(self)
        form.addRow(QLabel(f"開始: {label_a}"))
        form.addRow(QLabel(f"終了: {label_b}"))

        self.id_spin = QSpinBox()
        self.id_spin.setRange(1, 9999999)
        self.id_spin.setValue(default_id)
        form.addRow("エッジID:", self.id_spin)

        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText("教室名など。複数は ; 区切り（例: 101A;101B）。無ければ空欄")
        form.addRow("名前 (教室名):", self.name_edit)

        self.weight_spin = QDoubleSpinBox()
        self.weight_spin.setRange(0.1, 100.0)
        self.weight_spin.setDecimals(2)
        self.weight_spin.setValue(1.0)
        form.addRow("重み (weight):", self.weight_spin)

        self.length_spin = QDoubleSpinBox()
        self.length_spin.setRange(0.0, 100000.0)
        self.length_spin.setDecimals(2)
        self.length_spin.setValue(round(default_length, 2))
        form.addRow("距離 (length, m):", self.length_spin)

        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(default_floor)
        form.addRow("階 (低い方を推奨):", self.floor_spin)

        self.type_combo = QComboBox()
        for v, label in EDGE_TYPE_LABELS.items():
            self.type_combo.addItem(f"{v}: {label}", v)
        idx = self.type_combo.findData(default_type)
        if idx >= 0:
            self.type_combo.setCurrentIndex(idx)
        form.addRow("種別:", self.type_combo)

        hint = QLabel(
            "上りエスカレータ(5)・下りエスカレータ(6)は方向自動判定（z座標基準）のため\n"
            "from/toの向きは気にせず選択してOKです。"
        )
        hint.setStyleSheet("color:#666;font-size:11px;")
        hint.setWordWrap(True)
        form.addRow(hint)

        _add_ok_cancel_buttons(self, form)

    def values(self) -> dict:
        return {
            "id": self.id_spin.value(),
            "name": self.name_edit.text().strip(),
            "weight": self.weight_spin.value(),
            "length": self.length_spin.value(),
            "floor": self.floor_spin.value(),
            "type": self.type_combo.currentData(),
        }


def suggest_edge_type(floor_a: int, floor_b: int) -> int:
    """階が異なる場合は階段(2)を、同じ階なら通常通路(1)を初期値として提案する"""
    return 2 if floor_a != floor_b else 1

```

### `programs/Map_Editor/svg_canvas.py`

```python
#!/usr/bin/env python3
"""
IKU NAVI Map Editor — SVG描画キャンバス
SVGフロアマップを表示し、モードに応じてクリックを解釈する QGraphicsView。

モード:
  MOVE    … 表示のみ。クリックは何もしない（常時ドラッグでパン可能）
  INPUT   … 空白クリックでノード作成要求 / 既存ノードクリックでエッジ接続要求
  DELETE  … 既存ノード・エッジのクリックで削除要求
  CAMERA  … 既存エッジのクリックで撮影対象として選択

ドラッグ（一定以上の移動）は常にパンとして扱い、クリック（ほぼ移動なし）だけが
モード固有のアクションを発火する。ズームはホイールで常時可能。
"""

from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PyQt6.QtSvgWidgets import QGraphicsSvgItem
from PyQt6.QtWidgets import QGraphicsLineItem, QGraphicsScene, QGraphicsView

NODE_COLOR = {1: QColor("#3B82F6"), 2: QColor("#EF4444")}
NODE_COLOR_DEFAULT = QColor("#3B82F6")
NODE_COLOR_PENDING = QColor("#F59E0B")

EDGE_COLOR = {
    1: QColor("#94A3B8"),
    2: QColor("#8B5CF6"),
    3: QColor("#8B5CF6"),
    4: QColor("#10B981"),
    5: QColor("#10B981"),
    6: QColor("#10B981"),
    7: QColor("#F97316"),
}
EDGE_COLOR_DEFAULT = QColor("#94A3B8")
EDGE_COLOR_HIGHLIGHT = QColor("#F59E0B")

ROLE_ID, ROLE_KIND = 0, 1


class SvgCanvas(QGraphicsView):

    MODE_MOVE, MODE_INPUT, MODE_DELETE, MODE_CAMERA = "move", "input", "delete", "camera"

    nodeCreateRequested  = pyqtSignal(float, float)   # svg_x, svg_y
    edgeCreateRequested  = pyqtSignal(int, int)       # node_a_id, node_b_id
    nodeDeleteRequested  = pyqtSignal(int)            # node_id
    edgeDeleteRequested  = pyqtSignal(int)            # edge_id
    edgeSelectedForPhoto = pyqtSignal(int)            # edge_id
    pendingNodeChanged   = pyqtSignal(object)         # node_id | None

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#e8e8e8")))

        self._mode = self.MODE_MOVE
        self._svg_item = None
        self._press_pos = None
        self._pending_node_id = None   # 入力モード: エッジ接続待ちの先頭ノード
        self._pending_item = None
        self._highlight_item = None

    # ------------------------------------------------------------------
    # SVG 読み込み
    # ------------------------------------------------------------------
    def load_svg(self, svg_path: str) -> bool:
        self._scene.clear()
        self._svg_item = None
        self._pending_node_id = None
        self._highlight_item = None
        try:
            item = QGraphicsSvgItem(svg_path)
        except Exception:
            return False
        if item.boundingRect().isEmpty():
            return False
        self._svg_item = item
        self._scene.addItem(item)
        self._scene.setSceneRect(item.boundingRect())
        QTimer.singleShot(50, self.fit_all)
        return True

    def clear_svg(self):
        self._scene.clear()
        self._svg_item = None
        self._pending_node_id = None
        self._highlight_item = None

    def has_svg(self) -> bool:
        return self._svg_item is not None

    def fit_all(self):
        if self._svg_item is not None:
            self.fitInView(self._svg_item.boundingRect(), Qt.AspectRatioMode.KeepAspectRatio)

    # ------------------------------------------------------------------
    # モード
    # ------------------------------------------------------------------
    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str):
        self._mode = mode
        self.clear_pending()

    def clear_pending(self):
        self._pending_node_id = None
        self.highlight_edge(None)
        self.pendingNodeChanged.emit(None)

    # ------------------------------------------------------------------
    # 描画: ノード・エッジ
    # ------------------------------------------------------------------
    def render_nodes_edges(self, nodes_draw: list, edges_draw: list):
        """
        nodes_draw: [{"id", "sx", "sy", "type", "label"}, ...]
        edges_draw: [{"id", "sx0","sy0","sx1","sy1", "type", "label"}, ...]
        既存の動的アイテム（ノード/エッジ）だけを消して再描画する（SVG本体は残す）
        """
        for item in list(self._scene.items()):
            if item is not self._svg_item:
                self._scene.removeItem(item)
        self._highlight_item = None

        r = self._marker_radius()

        for e in edges_draw:
            color = EDGE_COLOR.get(e.get("type"), EDGE_COLOR_DEFAULT)
            pen = QPen(color, max(3.0, r * 0.5))
            pen.setCosmetic(False)
            line = self._scene.addLine(e["sx0"], e["sy0"], e["sx1"], e["sy1"], pen)
            line.setData(ROLE_ID, e["id"])
            line.setData(ROLE_KIND, "edge")
            line.setZValue(5)

        for n in nodes_draw:
            color = NODE_COLOR.get(n.get("type"), NODE_COLOR_DEFAULT)
            if n["id"] == self._pending_node_id:
                color = NODE_COLOR_PENDING
            pen = QPen(QColor("white"), max(1.5, r * 0.2))
            circle = self._scene.addEllipse(
                n["sx"] - r, n["sy"] - r, r * 2, r * 2, pen, QBrush(color)
            )
            circle.setData(ROLE_ID, n["id"])
            circle.setData(ROLE_KIND, "node")
            circle.setZValue(10)

            label = n.get("label")
            if label:
                text = self._scene.addSimpleText(str(label))
                text.setPos(n["sx"] + r + 2, n["sy"] - r - 4)
                text.setBrush(QBrush(QColor("#1E293B")))
                text.setFont(QFont("Helvetica", max(7, int(r))))
                text.setZValue(11)

    def highlight_edge(self, edge_id):
        for item in self._scene.items():
            if isinstance(item, QGraphicsLineItem) and item.data(ROLE_KIND) == "edge":
                pen = item.pen()
                if edge_id is not None and item.data(ROLE_ID) == edge_id:
                    pen.setColor(EDGE_COLOR_HIGHLIGHT)
                    pen.setWidthF(max(pen.widthF(), 6.0))
                    self._highlight_item = item
                else:
                    pen.setColor(EDGE_COLOR.get(item.data(ROLE_ID), EDGE_COLOR_DEFAULT))
                item.setPen(pen)

    def _marker_radius(self) -> float:
        if self._svg_item is None:
            return 10.0
        rect = self._svg_item.boundingRect()
        diag = (rect.width() ** 2 + rect.height() ** 2) ** 0.5
        return max(8.0, diag / 160)

    # ------------------------------------------------------------------
    # イベント
    # ------------------------------------------------------------------
    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.pos()
        elif event.button() == Qt.MouseButton.RightButton:
            self.clear_pending()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if (event.button() == Qt.MouseButton.LeftButton and self._press_pos is not None
                and (event.pos() - self._press_pos).manhattanLength() < 5):
            self._handle_click(event.pos())
        self._press_pos = None
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        k = event.key()
        if k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.scale(1.25, 1.25)
        elif k == Qt.Key.Key_Minus:
            self.scale(0.8, 0.8)
        elif k == Qt.Key.Key_0:
            self.fit_all()
        elif k == Qt.Key.Key_Escape:
            self.clear_pending()
        else:
            super().keyPressEvent(event)

    # ------------------------------------------------------------------
    def _hit_item(self, pos):
        """クリック位置にある node/edge アイテムを1つ返す（ノード優先）"""
        node_item, edge_item = None, None
        for item in self.items(pos):
            kind = item.data(ROLE_KIND)
            if kind == "node" and node_item is None:
                node_item = item
            elif kind == "edge" and edge_item is None:
                edge_item = item
        return node_item or edge_item, (node_item is not None)

    def _handle_click(self, pos):
        item, is_node = self._hit_item(pos)

        if self._mode == self.MODE_MOVE:
            return

        if self._mode == self.MODE_INPUT:
            if item is None:
                if self._svg_item is None:
                    return
                sp = self.mapToScene(pos)
                if self._svg_item.boundingRect().contains(sp):
                    self.nodeCreateRequested.emit(sp.x(), sp.y())
                return
            if is_node:
                node_id = item.data(ROLE_ID)
                if self._pending_node_id is None:
                    self._pending_node_id = node_id
                    self.pendingNodeChanged.emit(node_id)
                elif self._pending_node_id == node_id:
                    self.clear_pending()
                else:
                    a, b = self._pending_node_id, node_id
                    self.clear_pending()
                    self.edgeCreateRequested.emit(a, b)
            return

        if self._mode == self.MODE_DELETE:
            if item is None:
                return
            if is_node:
                self.nodeDeleteRequested.emit(item.data(ROLE_ID))
            else:
                self.edgeDeleteRequested.emit(item.data(ROLE_ID))
            return

        if self._mode == self.MODE_CAMERA:
            if item is not None and not is_node:
                self.edgeSelectedForPhoto.emit(item.data(ROLE_ID))

```

### `programs/Map_Editor/README.md`

```markdown
# IKU NAVI Map Editor

SVGフロアマップを見ながら、ノード・エッジのデータ入力とAR経路写真の撮影を1画面でまとめて行うツール。
これまで `SVG_Pointer`（座標取得）→ 手動でのCSV編集 → `Image_Renamer`（写真リネーム）に分かれていた作業を統合する。

## 起動方法

```bash
cd programs/Map_Editor
pip install -r requirements.txt
python main.py
```

## 画面構成

- **上部バー**: 建物・階の選択、SVGファイルのパス表示、保存ボタン
- **左（地図エリア）**: 選択中の建物・階に対応する `programs/html/svg/{building}_{floor}F.svg` を表示
- **右パネル**: 現在の階のノード・エッジ一覧（モード「撮影」時はカメラプレビューに切り替わる）
- **モードバー**: 🖐 移動 / ✏️ 入力 / 🗑 削除 / 📷 撮影 の4モードを切り替える

SVGは常にドラッグでパン・ホイールでズームできる。モードはクリックの意味だけを切り替える。

## モードの使い方

### 🖐 移動モード
クリックでは何も起きない。パン・ズームのみ行う「安全モード」。

### ✏️ 入力モード
- **空白をクリック** → ダイアログで実座標 (x, y, z, 単位m。`docs/XYZ_Design.md` の建物ローカル座標系) と階・種別を入力すると、
  クリック位置の SVG 座標 (svg_x, svg_y) と同時に `node.csv` の1行が作られる。
- **既存ノードを2つ順にクリック** → 2点間のエッジ作成ダイアログが開く（距離は実座標から自動計算、上書き可）。
  - **階段・エレベータなど階をまたぐ接続**: 片方のノードをクリックして選択した状態のまま、上部の「階」を切り替えると
    選択は保持される。切り替え後の階でもう一方のノード（例: 上の階の踊り場）をクリックすればエッジが作成できる。
    （階をまたぐエッジは2D地図上には線として表示されない。両端のノードはそれぞれの階の地図上に点として表示される）
- Escキー、または右クリックで選択中のノードを解除できる。

### 🗑 削除モード
ノードまたはエッジをクリックすると確認の上、削除する。ノード削除時はそのノードに繋がる全エッジも連鎖削除される。

### 📷 撮影モード
1. 撮影したいエッジ（線）をクリックして選択する。
2. 右パネルでカメラを接続し、プレビューを確認する。
3. 「→ 方向を撮影」「← 方向を撮影」でそれぞれの向きの写真を撮る（廊下は両方向から歩くため）。
4. 撮影した画像は `captured_photos/` フォルダに `{fromの グローバルID}_to_{toのグローバルID}.jpg` の名前で保存され、
   `data/edge_image.csv` への登録は「💾 保存」を押した時点で確定する。
   グローバルID = `建物ID × 100000 + 建物内ローカルID`（`programs/3D_Graph/app.py` の `ID_OFFSET` と同じ計算式）。

CDN（Cloudflare R2）へのアップロードはこのツールの対象外。撮影済みファイルは従来通り手動でアップロードすること。

## 保存について

- 建物・階を切り替える／アプリを閉じる際に未保存の変更があれば確認ダイアログが出る。
- 「💾 保存」で現在の建物の `node.csv` / `edge.csv` と `data/edge_image.csv` をまとめて上書き保存する。
- 保存後は `programs/3D_Graph/app.py` を再起動（またはキャッシュクリア）しないとAPI側には反映されない。

## 制約・対象外の範囲

- 建物内の `node.csv` / `edge.csv`（建物ローカル座標）と `edge_image.csv` のみを対象とする。
- `anchors.csv`・`global_node.csv`・`global_edge.csv`・`connect_edge.csv`・`buildings.json`（座標変換パラメータ、
  屋外ノード、建物間接続）の編集はサポートしない。これらは引き続き手動で編集すること（`docs/XYZ_Design.md` 参照）。
- SVGファイル自体の作成・編集は対象外（既存のSVGを読み込んで座標を取得するのみ）。

```

### `programs/Map_Editor/requirements.txt`

```text
PyQt6>=6.4.0
opencv-python>=4.8.0
numpy>=1.24.0

```

#### Image_Checker

### `programs/Image_Checker/image_checker.py`

```python
#!/usr/bin/env python3
"""IKU NAVI 画像チェッカー — 全グラフエッジの経路画像 存在確認ツール

/api/graph でグラフ上の全エッジを取得し、その両方向を網羅的に確認する。
/api/edge_images で登録済み URL を取得し、実際に CDN へアクセスして判定。

カードの状態:
  ok           … CSV 登録済み + CDN に実在
  missing      … CSV 登録済み + CDN に存在しない
  unregistered … グラフ上にエッジがあるが edge_image.csv に未登録
  not_required … 建物出入口エッジ（type=7, anchors.csv由来）。
                 navi側はこの区間で写真の代わりにカメラARを起動するため、
                 edge_image.csv 未登録でも欠損・未登録として扱わない。
"""

import sys
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import requests

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget,
    QHBoxLayout, QVBoxLayout, QGridLayout,
    QLabel, QPushButton, QLineEdit, QScrollArea,
    QFrame, QProgressBar, QMessageBox,
    QDialog, QTextEdit, QComboBox, QFileDialog,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QFont, QColor, QPixmap, QPainter, QPen

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common import qt_app
from gui_common.api import BROWSER_HEADERS, DEFAULT_API, make_session
from gui_common.labels import building_label as _bldg_label
from gui_common.theme import (
    ACCENT,
    BG_BAR,
    BG_WIN,
    BORDER,
    BTN_ACTIVE,
    BTN_IDLE,
    COL_ERR,
    COL_OK,
    COL_WARN,
    INPUT_BG,
    TXT_KEY,
    TXT_PRIMARY,
    TXT_SUB,
    base_stylesheet,
)


# ── 設定 ──────────────────────────────────────────────────────────────────────
CARD_W      = 230
CARD_H      = 215
THUMB_H     = 135
MAX_WORKERS = 6     # Cloudflare レート制限対策で抑え気味

def _make_session() -> requests.Session:
    return make_session(headers=BROWSER_HEADERS, total=3, backoff_factor=0.5,
                        status_forcelist=(429, 500, 502, 503, 504))


# ── パレット（共通色は gui_common.theme、ここはこのツール固有の色だけ）──────────
BG_CARD_OK     = "#0C2318"
BG_CARD_NG     = "#2B0F0F"
BG_CARD_UNREG  = "#1A1A2A"
BG_CARD_LOAD   = "#1A2233"
BG_CARD_NOTREQ = "#12283A"
BG_THUMB       = "#0D1626"
COL_UNREG      = "#6B7280"
COL_NOTREQ     = "#38BDF8"


# ─────────────────────────────────────────────────────────────────────────────
# 共通ユーティリティ
# ─────────────────────────────────────────────────────────────────────────────

def _bldg_label(building: int) -> str:
    """号館番号を表示用ラベルに変換する（0 = 屋外）"""
    return "屋外" if building == 0 else f"{building}号館"


def _edge_sort_key(card):
    """カードを (building, floor, from_id) の順に並べるためのキー"""
    return (card.building, card.floor, int(card.key.split("_")[0]))


def _count_states(cards) -> tuple[int, int, int, int]:
    """カード集合から (ok, missing, unregistered, not_required) の件数を返す"""
    ok           = sum(1 for c in cards if c.state == "ok")
    missing      = sum(1 for c in cards if c.state == "missing")
    unreg        = sum(1 for c in cards if c.state == "unregistered")
    not_required = sum(1 for c in cards if c.state == "not_required")
    return ok, missing, unreg, not_required


# ─────────────────────────────────────────────────────────────────────────────
# ワーカー
# ─────────────────────────────────────────────────────────────────────────────

class FetchGraphWorker(QThread):
    """/api/graph と /api/edge_images を取得する"""
    # nodes_map: {node_id: {building, floor, ...}}
    # edges_list: [{id, from, to, building, floor, ...}]
    # edge_images: {"from_to": url}
    finished = pyqtSignal(dict, list, dict)
    error    = pyqtSignal(str)

    def __init__(self, api_url: str):
        super().__init__()
        self.api_url = api_url.rstrip("/")

    def run(self):
        session = _make_session()
        session.headers["Accept"] = "application/json"
        try:
            graph_data  = self._get(session, f"{self.api_url}/api/graph")
            edge_images = self._get(session, f"{self.api_url}/api/edge_images")
        except Exception as e:
            self.error.emit(str(e))
            return

        nodes_map  = {int(n["id"]): n for n in graph_data.get("nodes", [])}
        edges_list = graph_data.get("edges", [])
        self.finished.emit(nodes_map, edges_list, edge_images)

    def _get(self, session: requests.Session, url: str) -> dict:
        r = session.get(url, timeout=15)
        r.raise_for_status()
        ct = r.headers.get("Content-Type", "")
        if "text/html" in ct:
            raise RuntimeError(
                f"HTML が返りました（Cloudflare チャレンジ？）\n"
                f"URL: {url}  HTTP {r.status_code}"
            )
        return r.json()


class ImageFetchWorker(QThread):
    """登録済みエッジ画像を並列フェッチして結果を emit する"""
    image_ready = pyqtSignal(str, bytes)   # key, bytes (空 = 欠損)
    progress    = pyqtSignal(int, int)     # done, total

    def __init__(self, tasks: list):
        super().__init__()
        self._tasks = tasks   # [(key, url), ...]
        self._done  = 0
        self._lock  = threading.Lock()

    def run(self):
        total = len(self._tasks)
        tls   = threading.local()

        def get_session() -> requests.Session:
            if not hasattr(tls, "s"):
                tls.s = _make_session()
                tls.s.headers["Accept"] = "image/*,*/*;q=0.8"
            return tls.s

        def fetch_one(task):
            key, url = task
            try:
                r    = get_session().get(url, timeout=12)
                data = r.content if r.status_code == 200 else b""
            except Exception:
                data = b""
            with self._lock:
                self._done += 1
                n = self._done
            self.image_ready.emit(key, data)
            self.progress.emit(n, total)

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            list(pool.map(fetch_one, self._tasks))


# ─────────────────────────────────────────────────────────────────────────────
# 画像カード
# ─────────────────────────────────────────────────────────────────────────────

class ImageCard(QFrame):
    """1 directed-edge = 1 カード"""

    _BG = {
        "loading":      BG_CARD_LOAD,
        "ok":           BG_CARD_OK,
        "missing":      BG_CARD_NG,
        "unregistered": BG_CARD_UNREG,
        "not_required": BG_CARD_NOTREQ,
    }

    def __init__(self, key: str, url: str | None,
                 building: int, floor: int, initial_state: str = "loading",
                 parent=None):
        super().__init__(parent)
        self.key      = key
        self.url      = url
        self.building = building
        self.floor    = floor
        self._state   = initial_state
        self.setFixedSize(CARD_W, CARD_H)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self._build_ui()
        self._apply_style()

    # ── UI ───────────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 6)
        root.setSpacing(0)

        # サムネイル
        self._thumb = QLabel()
        self._thumb.setFixedSize(CARD_W, THUMB_H)
        self._thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._thumb.setStyleSheet(
            f"background: {BG_THUMB}; border-radius: 8px 8px 0 0;"
        )
        self._draw_thumb_for_state()
        root.addWidget(self._thumb)

        # 情報
        info = QWidget()
        info.setStyleSheet("background: transparent;")
        vb = QVBoxLayout(info)
        vb.setContentsMargins(8, 5, 8, 0)
        vb.setSpacing(2)

        parts    = self.key.split("_")
        key_lbl  = QLabel(f"{parts[0]} →\n{parts[1]}")
        key_lbl.setFont(QFont("Courier New", 10, QFont.Weight.Bold))
        key_lbl.setStyleSheet(f"color: {TXT_KEY}; background: transparent;")
        vb.addWidget(key_lbl)

        bldg_txt = _bldg_label(self.building)
        if self.building != 0:
            bldg_txt += f" {self.floor}階"
        bldg_lbl = QLabel(bldg_txt)
        bldg_lbl.setFont(QFont("", 11))
        bldg_lbl.setStyleSheet(f"color: {TXT_SUB}; background: transparent;")
        vb.addWidget(bldg_lbl)

        root.addWidget(info)

        # ステータス
        self._status = QLabel()
        self._status.setFont(QFont("", 11, QFont.Weight.Bold))
        self._status.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._update_status_label()
        root.addWidget(self._status)

    def _apply_style(self):
        bg = self._BG.get(self._state, BG_CARD_LOAD)
        self.setStyleSheet(f"""
            ImageCard {{
                background: {bg};
                border-radius: 8px;
                border: 1px solid {BORDER};
            }}
        """)

    def _update_status_label(self):
        conf = {
            "loading":      ("読み込み中...",      COL_WARN),
            "ok":           ("✔  OK",              COL_OK),
            "missing":      ("✕  CDN に存在しない", COL_ERR),
            "unregistered": ("—  CSV 未登録",       COL_UNREG),
            "not_required": ("◎  AR起動区間（不要）", COL_NOTREQ),
        }
        text, color = conf.get(self._state, ("", TXT_SUB))
        self._status.setText(text)
        self._status.setStyleSheet(
            f"color: {color}; background: transparent; padding-bottom: 2px;"
        )

    # ── サムネイル描画 ────────────────────────────────────────────────────────

    def _draw_thumb_for_state(self):
        if self._state == "loading":
            self._draw_text_thumb("取得中...", TXT_SUB, BG_THUMB)
        elif self._state == "missing":
            self._draw_text_thumb("✕  画像なし", COL_ERR, "#180808")
        elif self._state == "unregistered":
            self._draw_text_thumb("—  未登録", COL_UNREG, "#111120")
        elif self._state == "not_required":
            self._draw_text_thumb("◎  AR起動区間", COL_NOTREQ, "#0B1C2A")
        # ok はセット時に上書き

    def _draw_text_thumb(self, text: str, color: str, bg: str):
        pix = QPixmap(CARD_W, THUMB_H)
        pix.fill(QColor(bg))
        p = QPainter(pix)
        p.setPen(QPen(QColor(color), 2))
        p.setFont(QFont("", 14, QFont.Weight.Bold))
        p.drawText(pix.rect(), Qt.AlignmentFlag.AlignCenter, text)
        p.end()
        self._thumb.setPixmap(pix)

    # ── 外部 API ─────────────────────────────────────────────────────────────

    def set_image(self, data: bytes):
        """ImageFetchWorker から呼ばれる（必ず登録済みカードのみ）"""
        if data:
            pix = QPixmap()
            if pix.loadFromData(data) and not pix.isNull():
                scaled = pix.scaled(
                    CARD_W, THUMB_H,
                    Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                    Qt.TransformationMode.SmoothTransformation,
                )
                x = max(0, (scaled.width()  - CARD_W)  // 2)
                y = max(0, (scaled.height() - THUMB_H) // 2)
                self._thumb.setPixmap(scaled.copy(x, y, CARD_W, THUMB_H))
                self._state = "ok"
                self._update_status_label()
                self._apply_style()
                return

        self._state = "missing"
        self._draw_text_thumb("✕  画像なし", COL_ERR, "#180808")
        self._update_status_label()
        self._apply_style()

    @property
    def state(self) -> str:
        return self._state


# ─────────────────────────────────────────────────────────────────────────────
# テキスト出力ダイアログ
# ─────────────────────────────────────────────────────────────────────────────

def _cjk_pad(text: str, width: int) -> str:
    """CJK 全角文字を 2 カラム幅として計算してスペースで右埋めする"""
    disp = sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)
    return text + " " * max(0, width - disp)


class ExportDialog(QDialog):
    """欠損・未登録エッジをテキスト表形式で出力するダイアログ"""

    def __init__(self, cards: dict, buildings: list, parent=None):
        super().__init__(parent)
        self._cards     = cards
        self._buildings = buildings
        self._sel_bldg  = -1

        self.setWindowTitle("テキスト出力 — 欠損・未登録一覧")
        self.setMinimumSize(720, 520)
        self.resize(860, 640)
        self.setStyleSheet(f"""
            QDialog, QWidget  {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
            QTextEdit {{
                background: #1A2233; color: {TXT_PRIMARY};
                border: 1px solid {BORDER}; border-radius: 6px;
                font-family: "Courier New", monospace; font-size: 13px;
            }}
            QComboBox {{
                background: #374151; color: {TXT_PRIMARY};
                border: 1px solid #4B5563; border-radius: 6px;
                padding: 4px 10px; font-size: 14px; min-width: 110px;
            }}
            QComboBox QAbstractItemView {{
                background: #374151; color: {TXT_PRIMARY};
                selection-background-color: {BTN_ACTIVE};
            }}
        """)
        self._build_ui()
        self._refresh()

    def _build_ui(self):
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(16, 16, 16, 16)
        vbox.setSpacing(10)

        row = QHBoxLayout()
        lbl = QLabel("対象号館:")
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 15px;")
        row.addWidget(lbl)

        self._combo = QComboBox()
        self._combo.addItem("全て", -1)
        for b in self._buildings:
            self._combo.addItem(_bldg_label(b), b)
        self._combo.currentIndexChanged.connect(lambda _: self._on_bldg_changed())
        row.addWidget(self._combo)
        row.addStretch()

        copy_btn = QPushButton("クリップボードにコピー")
        copy_btn.setFont(QFont("", 12))
        copy_btn.setStyleSheet(f"""
            QPushButton {{
                background: {BTN_ACTIVE}; color: #FFF;
                border-radius: 5px; padding: 4px 14px; border: none;
            }}
            QPushButton:hover {{ background: #22D4FF; color: #000; }}
        """)
        copy_btn.clicked.connect(self._copy)
        row.addWidget(copy_btn)

        save_btn = QPushButton("ファイルに保存")
        save_btn.setFont(QFont("", 12))
        save_btn.setStyleSheet(f"""
            QPushButton {{
                background: {BTN_IDLE}; color: {TXT_PRIMARY};
                border-radius: 5px; padding: 4px 14px; border: none;
            }}
            QPushButton:hover {{ background: #4B5563; }}
        """)
        save_btn.clicked.connect(self._save)
        row.addWidget(save_btn)

        vbox.addLayout(row)

        self._text = QTextEdit()
        self._text.setReadOnly(True)
        vbox.addWidget(self._text)

    def _on_bldg_changed(self):
        self._sel_bldg = self._combo.currentData()
        self._refresh()

    def _generate(self) -> str:
        target = {"missing", "unregistered"}
        cards = [
            c for c in self._cards.values()
            if c.state in target
            and (self._sel_bldg == -1 or c.building == self._sel_bldg)
        ]
        cards.sort(key=_edge_sort_key)

        bldg_label = "全て" if self._sel_bldg == -1 else _bldg_label(self._sel_bldg)

        now   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        lines = [
            "IKU NAVI 画像チェッカー — 欠損・未登録エッジ一覧",
            f"生成日時: {now}",
            f"対象号館: {bldg_label}",
            "",
        ]

        if not cards:
            lines.append("※ 欠損・未登録エッジはありません")
            return "\n".join(lines)

        W_KEY   = max(len("エッジキー"), max(len(c.key) for c in cards)) + 2
        W_BLDG  = 8   # 表示幅（CJK 考慮）
        W_FLOOR = 4
        SEP     = "-" * (W_KEY + W_BLDG + W_FLOOR + 28 + 6)

        lines += [
            SEP,
            _cjk_pad("エッジキー", W_KEY)
            + "  " + _cjk_pad("号館", W_BLDG)
            + "  " + _cjk_pad("階", W_FLOOR)
            + "  状態",
            SEP,
        ]

        for c in cards:
            bldg_str  = _bldg_label(c.building)
            floor_str = f"{c.floor}階"
            state_str = "欠損 (CDN に存在しない)" if c.state == "missing" else "未登録 (CSV 未登録)"
            lines.append(
                f"{c.key:<{W_KEY}}"
                "  " + _cjk_pad(bldg_str, W_BLDG)
                + "  " + _cjk_pad(floor_str, W_FLOOR)
                + f"  {state_str}"
            )

        n_miss  = sum(1 for c in cards if c.state == "missing")
        n_unreg = sum(1 for c in cards if c.state == "unregistered")
        lines += [SEP, f"合計: {len(cards)} 件  (欠損: {n_miss}  未登録: {n_unreg})"]
        return "\n".join(lines)

    def _refresh(self):
        self._text.setPlainText(self._generate())

    def _copy(self):
        QApplication.clipboard().setText(self._text.toPlainText())

    def _save(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "ファイルに保存", "missing_edges.txt",
            "テキストファイル (*.txt);;すべてのファイル (*)",
        )
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(self._text.toPlainText())


# ─────────────────────────────────────────────────────────────────────────────
# メインウィンドウ
# ─────────────────────────────────────────────────────────────────────────────

# フィルタ定数
FILTER_ALL     = "all"
FILTER_NG      = "missing"        # CDN 欠損
FILTER_UNREG   = "unregistered"   # CSV 未登録
FILTER_ATTN    = "attention"      # 欠損 + 未登録まとめて
FILTER_NOTREQ  = "not_required"   # 建物出入口エッジ（AR起動のため写真不要）


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("IKU NAVI 画像チェッカー")
        self.setMinimumSize(980, 680)
        self.resize(1280, 820)

        self._cards:            dict[str, ImageCard] = {}
        self._buildings:        list[int] = []
        self._bldg_btn_map:     dict[int, QPushButton] = {}
        self._current_building: int = -1
        self._filter_state:     str = FILTER_ALL

        self._fetch_worker: FetchGraphWorker  | None = None
        self._img_worker:   ImageFetchWorker  | None = None

        self._resize_timer = QTimer(self)
        self._resize_timer.setSingleShot(True)
        self._resize_timer.timeout.connect(self._refresh_grid)

        self._build_ui()
        self._apply_theme()

    # ── テーマ ────────────────────────────────────────────────────────────────

    def _apply_theme(self):
        self.setStyleSheet(base_stylesheet())

    # ── UI 構築 ───────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(0)
        vbox.addWidget(self._build_topbar())
        vbox.addWidget(self._build_filterbar())
        vbox.addWidget(self._build_scroll(), stretch=1)

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(62)
        bar.setStyleSheet(f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};")
        row = QHBoxLayout(bar)
        row.setContentsMargins(16, 0, 16, 0)
        row.setSpacing(10)

        title = QLabel("IKU NAVI 画像チェッカー")
        title.setFont(QFont("", 18, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {ACCENT};")
        row.addWidget(title)

        row.addSpacing(12)
        lbl = QLabel("API URL:")
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        row.addWidget(lbl)

        self._api_edit = QLineEdit(DEFAULT_API)
        self._api_edit.setFixedWidth(260)
        self._api_edit.returnPressed.connect(self._start_fetch)
        row.addWidget(self._api_edit)

        self._fetch_btn = QPushButton("取得開始")
        self._fetch_btn.setFixedSize(100, 34)
        self._fetch_btn.setFont(QFont("", 13, QFont.Weight.Bold))
        self._fetch_btn.setStyleSheet(f"""
            QPushButton {{
                background: {ACCENT}; color: #001A22; border-radius: 6px;
            }}
            QPushButton:hover    {{ background: #22D4FF; }}
            QPushButton:pressed  {{ background: #0099BB; }}
            QPushButton:disabled {{ background: {INPUT_BG}; color: {TXT_SUB}; }}
        """)
        self._fetch_btn.clicked.connect(self._start_fetch)
        row.addWidget(self._fetch_btn)

        row.addSpacing(6)

        self._export_btn = QPushButton("欠損を出力")
        self._export_btn.setFixedSize(110, 34)
        self._export_btn.setFont(QFont("", 13, QFont.Weight.Bold))
        self._export_btn.setEnabled(False)
        self._export_btn.setStyleSheet(f"""
            QPushButton {{
                background: {BTN_IDLE}; color: {TXT_PRIMARY}; border-radius: 6px;
            }}
            QPushButton:hover    {{ background: #4B5563; }}
            QPushButton:pressed  {{ background: #374151; }}
            QPushButton:disabled {{ background: #2D3748; color: #4B5563; }}
        """)
        self._export_btn.clicked.connect(self._open_export_dialog)
        row.addWidget(self._export_btn)

        row.addSpacing(6)

        self._progress = QProgressBar()
        self._progress.setFixedSize(180, 8)
        self._progress.setRange(0, 1)
        self._progress.setValue(0)
        self._progress.setTextVisible(False)
        row.addWidget(self._progress)

        row.addStretch()

        self._status_lbl = QLabel("API URL を入力して「取得開始」")
        self._status_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        row.addWidget(self._status_lbl)

        return bar

    def _build_filterbar(self) -> QWidget:
        self._filterbar = QWidget()
        self._filterbar.setFixedHeight(48)
        self._filterbar.setStyleSheet(
            f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};"
        )
        self._filterbar_row = QHBoxLayout(self._filterbar)
        self._filterbar_row.setContentsMargins(16, 0, 16, 0)
        self._filterbar_row.setSpacing(6)
        self._filterbar_row.addStretch()
        return self._filterbar

    def _rebuild_filterbar(self):
        while self._filterbar_row.count():
            item = self._filterbar_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        self._bldg_btn_map = {}

        # ── 号館フィルタ ─────────────────────────────────────────────────────
        lbl1 = QLabel("号館:")
        lbl1.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        self._filterbar_row.addWidget(lbl1)

        all_bldg = self._make_pill("全て", True)
        all_bldg.clicked.connect(lambda: self._filter_building(-1))
        self._filterbar_row.addWidget(all_bldg)
        self._bldg_btn_map[-1] = all_bldg

        for bldg in self._buildings:
            btn = self._make_pill(_bldg_label(bldg), False)
            btn.clicked.connect(lambda _=False, b=bldg: self._filter_building(b))
            self._filterbar_row.addWidget(btn)
            self._bldg_btn_map[bldg] = btn

        # ── セパレータ ────────────────────────────────────────────────────────
        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(24)
        sep.setStyleSheet(f"color: {BORDER};")
        self._filterbar_row.addSpacing(8)
        self._filterbar_row.addWidget(sep)
        self._filterbar_row.addSpacing(8)

        # ── 状態フィルタ ──────────────────────────────────────────────────────
        lbl2 = QLabel("表示:")
        lbl2.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        self._filterbar_row.addWidget(lbl2)

        self._state_btns: dict[str, QPushButton] = {}
        filters = [
            (FILTER_ALL,    "全て"),
            (FILTER_NG,     "欠損"),
            (FILTER_UNREG,  "未登録"),
            (FILTER_ATTN,   "要対応"),
            (FILTER_NOTREQ, "AR区間(不要)"),
        ]
        for fkey, flabel in filters:
            btn = self._make_pill(flabel, fkey == FILTER_ALL)
            btn.clicked.connect(lambda _=False, k=fkey: self._filter_state_set(k))
            self._filterbar_row.addWidget(btn)
            self._state_btns[fkey] = btn

        self._filterbar_row.addStretch()

        self._count_lbl = QLabel("")
        self._count_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        self._filterbar_row.addWidget(self._count_lbl)

    def _make_pill(self, text: str, active: bool) -> QPushButton:
        btn = QPushButton(text)
        btn.setFixedHeight(28)
        btn.setFont(QFont("", 12))
        self._set_pill(btn, active)
        return btn

    def _set_pill(self, btn: QPushButton, active: bool):
        if active:
            btn.setStyleSheet(f"""
                QPushButton {{
                    background: {BTN_ACTIVE}; color: #FFF;
                    border-radius: 5px; padding: 0 12px; border: none;
                }}
            """)
        else:
            btn.setStyleSheet(f"""
                QPushButton {{
                    background: {BTN_IDLE}; color: {TXT_PRIMARY};
                    border-radius: 5px; padding: 0 12px; border: none;
                }}
                QPushButton:hover {{ background: #4B5563; }}
            """)

    def _new_grid_widget(self) -> tuple[QWidget, QGridLayout]:
        """カードを並べるためのグリッドウィジェットを新規生成する"""
        gw = QWidget()
        gw.setStyleSheet(f"background: {BG_WIN};")
        gl = QGridLayout(gw)
        gl.setContentsMargins(16, 16, 16, 16)
        gl.setSpacing(12)
        gl.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        return gw, gl

    def _placeholder_label(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 16px;")
        return lbl

    def _build_scroll(self) -> QScrollArea:
        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)

        gw, gl = self._new_grid_widget()
        gl.addWidget(
            self._placeholder_label("API URL を入力して「取得開始」をクリックしてください"), 0, 0
        )

        self._scroll.setWidget(gw)
        return self._scroll

    # ── フェッチ ──────────────────────────────────────────────────────────────

    def _start_fetch(self):
        api_url = self._api_edit.text().strip()
        if not api_url:
            QMessageBox.warning(self, "エラー", "API URL を入力してください。")
            return

        self._cards.clear()
        self._buildings.clear()
        self._current_building = -1
        self._filter_state     = FILTER_ALL

        self._fetch_btn.setEnabled(False)
        self._set_status("API に接続中...", TXT_SUB)
        self._progress.setRange(0, 1)
        self._progress.setValue(0)

        self._fetch_worker = FetchGraphWorker(api_url)
        self._fetch_worker.finished.connect(self._on_graph_data)
        self._fetch_worker.error.connect(self._on_fetch_error)
        self._fetch_worker.start()

    def _on_fetch_error(self, msg: str):
        self._fetch_btn.setEnabled(True)
        self._set_status(f"エラー: {msg}", COL_ERR)
        QMessageBox.critical(
            self, "取得エラー",
            f"API への接続に失敗しました:\n\n{msg}\n\n"
            "サーバーが起動しているか確認してください。"
        )

    def _on_graph_data(self, nodes_map: dict, edges_list: list, edge_images: dict):
        """グラフ上の全エッジ（両方向）を網羅してカードを生成する"""

        self._set_status("グラフを解析中...", TXT_SUB)

        buildings_set: set[int] = set()
        tasks: list[tuple[str, str]] = []   # 登録済みエッジの (key, url) リスト
        seen:  set[str] = set()

        # 全エッジ × 両方向を処理
        for edge in edges_list:
            from_id  = int(edge["from"])
            to_id    = int(edge["to"])
            # type=7 は anchors.csv から自動生成される建物出入口エッジ。
            # navi側はこの区間で写真を使わずカメラARを起動するため写真登録は不要。
            is_entrance_edge = str(edge.get("type", "1")) == "7"
            # エッジのノードが nodes_map になければ from_id を参照
            nf       = nodes_map.get(from_id, {})
            building = nf.get("building", edge.get("building", -1))
            floor    = nf.get("floor",    edge.get("floor",    1))
            buildings_set.add(building)

            for f, t in [(from_id, to_id), (to_id, from_id)]:
                key = f"{f}_{t}"
                if key in seen:
                    continue
                seen.add(key)

                # 方向を反転した場合は to_id の建物情報を使う
                if f == to_id:
                    nt       = nodes_map.get(to_id, {})
                    building = nt.get("building", edge.get("building", -1))
                    floor    = nt.get("floor",    edge.get("floor",    1))
                    buildings_set.add(building)

                if is_entrance_edge:
                    card = ImageCard(key, None, building, floor, "not_required")
                else:
                    url = edge_images.get(key)
                    if url:
                        card = ImageCard(key, url, building, floor, "loading")
                        tasks.append((key, url))
                    else:
                        card = ImageCard(key, None, building, floor, "unregistered")

                self._cards[key] = card

        self._buildings = sorted(buildings_set)
        self._rebuild_filterbar()
        self._refresh_grid()
        self._export_btn.setEnabled(True)

        total_edges = len(self._cards)
        registered  = len(tasks)
        _, _, unreg, not_required = _count_states(self._cards.values())
        self._set_status(
            f"全 {total_edges} エッジ  登録済 {registered}  未登録 {unreg}  "
            f"AR起動区間(不要) {not_required}  — 画像取得中...",
            TXT_SUB,
        )
        self._progress.setRange(0, max(1, registered))
        self._progress.setValue(0)

        if not tasks:
            self._fetch_btn.setEnabled(True)
            self._set_status(
                f"全 {total_edges} エッジ中、CSV 登録済みが 0 件でした", COL_WARN
            )
            return

        self._img_worker = ImageFetchWorker(tasks)
        self._img_worker.image_ready.connect(self._on_image_ready)
        self._img_worker.progress.connect(self._on_progress)
        self._img_worker.finished.connect(self._on_images_done)
        self._img_worker.start()

    def _on_image_ready(self, key: str, data: bytes):
        card = self._cards.get(key)
        if card:
            card.set_image(data)
            self._update_count_lbl()

    def _on_progress(self, done: int, total: int):
        self._progress.setValue(done)
        self._set_status(f"画像取得中... {done} / {total}", TXT_SUB)

    def _on_images_done(self):
        self._fetch_btn.setEnabled(True)
        ok, missing, unreg, _ = _count_states(self._cards.values())
        total = len(self._cards)

        if missing or unreg:
            self._set_status(
                f"完了: 全 {total} エッジ  ✔ {ok}  ✕ 欠損 {missing}  — 未登録 {unreg}",
                COL_ERR,
            )
        else:
            self._set_status(f"完了: 全 {total} エッジ  ✔ 全て OK", COL_OK)

        self._update_count_lbl()
        if self._filter_state != FILTER_ALL:
            self._refresh_grid()

    # ── グリッド制御 ──────────────────────────────────────────────────────────

    def _visible_cards(self) -> list[ImageCard]:
        def match_state(c: ImageCard) -> bool:
            if self._filter_state == FILTER_ALL:   return True
            if self._filter_state == FILTER_NG:     return c.state == "missing"
            if self._filter_state == FILTER_UNREG:  return c.state == "unregistered"
            if self._filter_state == FILTER_ATTN:   return c.state in ("missing", "unregistered")
            if self._filter_state == FILTER_NOTREQ: return c.state == "not_required"
            return True

        cards = [
            c for c in self._cards.values()
            if (self._current_building == -1 or c.building == self._current_building)
            and match_state(c)
        ]
        return sorted(cards, key=_edge_sort_key)

    def _refresh_grid(self):
        for card in self._cards.values():
            card.setParent(None)

        old = self._scroll.takeWidget()
        if old:
            old.deleteLater()

        gw, gl = self._new_grid_widget()

        visible = self._visible_cards()

        if not visible and not self._cards:
            gl.addWidget(
                self._placeholder_label("API URL を入力して「取得開始」をクリックしてください"), 0, 0
            )
        elif not visible:
            gl.addWidget(self._placeholder_label("該当するエッジがありません"), 0, 0)
        else:
            vw   = max(1, self._scroll.viewport().width() - 32)
            cols = max(1, vw // (CARD_W + 12))
            for i, card in enumerate(visible):
                gl.addWidget(card, i // cols, i % cols)

        self._scroll.setWidget(gw)
        self._update_count_lbl()

    def _filter_building(self, building: int):
        self._current_building = building
        for b, btn in self._bldg_btn_map.items():
            self._set_pill(btn, b == building)
        self._refresh_grid()

    def _filter_state_set(self, fkey: str):
        self._filter_state = fkey
        for k, btn in self._state_btns.items():
            self._set_pill(btn, k == fkey)
        self._refresh_grid()

    # ── テキスト出力 ──────────────────────────────────────────────────────────

    def _open_export_dialog(self):
        dlg = ExportDialog(self._cards, self._buildings, parent=self)
        dlg.exec()

    # ── ユーティリティ ────────────────────────────────────────────────────────

    def _set_status(self, text: str, color: str):
        self._status_lbl.setText(text)
        self._status_lbl.setStyleSheet(f"color: {color}; font-size: 16px;")

    def _update_count_lbl(self):
        if not hasattr(self, "_count_lbl"):
            return

        total   = len(self._cards)
        ok, missing, unreg, not_required = _count_states(self._cards.values())
        loading = total - ok - missing - unreg - not_required
        visible = len(self._visible_cards())

        parts = [f"全 {total} エッジ"]
        if loading:
            parts.append(f"読込中 {loading}")
        parts += [f"✔ {ok}", f"✕ 欠損 {missing}", f"— 未登録 {unreg}", f"◎ AR区間 {not_required}"]

        if self._current_building != -1:
            bldg_cards = [c for c in self._cards.values() if c.building == self._current_building]
            bldg_total = len(bldg_cards)
            bldg_ok, bldg_miss, bldg_unreg, bldg_notreq = _count_states(bldg_cards)
            bldg_name  = _bldg_label(self._current_building)
            parts.append(
                f"[{bldg_name}: 全 {bldg_total}  ✔ {bldg_ok}  ✕ {bldg_miss}  "
                f"— {bldg_unreg}  ◎ {bldg_notreq}  表示 {visible}]"
            )
        else:
            parts.append(f"[表示 {visible}]")

        color = COL_ERR if (missing or unreg) else (TXT_SUB if loading else COL_OK)
        self._count_lbl.setText("  ".join(parts))
        self._count_lbl.setStyleSheet(f"color: {color}; font-size: 16px;")

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._cards:
            self._resize_timer.start(180)


# ─────────────────────────────────────────────────────────────────────────────
# エントリーポイント
# ─────────────────────────────────────────────────────────────────────────────

def main():
    qt_app.run(MainWindow)


if __name__ == "__main__":
    main()
```

### `programs/Image_Checker/requirements.txt`

```text
PyQt6>=6.4.0
requests>=2.31.0

```

#### Route_Checker

### `programs/Route_Checker/route_checker.py`

```python
#!/usr/bin/env python3
"""IKU NAVI ルートチェッカー — 登録教室間の全ルートを取得・異常検出ツール

使い方:
  1. API URL を入力して「教室取得」を押す
  2. フィルタ（トイレ除外など）を設定して「検証開始」を押す
  3. 全教室ペアのルートが並列取得され、テーブルに表示される
  4. 行をダブルクリックすると経路詳細と異常の原因を確認できる
"""

import csv
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QFont
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common import qt_app
from gui_common.api import DEFAULT_API, JSON_HEADERS, make_session
from gui_common.labels import TOILET_ROOMS, building_label, floor_label
from gui_common.theme import (
    ACCENT,
    BG_BAR,
    BG_WIN,
    BORDER,
    BTN_ACTIVE,
    BTN_IDLE,
    COL_ERR,
    COL_OK,
    COL_WARN,
    INPUT_BG,
    INPUT_BORDER,
    TXT_KEY,
    TXT_PRIMARY,
    TXT_SUB,
    base_stylesheet,
)

# ── 定数 ──────────────────────────────────────────────────────────────────────
MAX_WORKERS = 8

EDGE_TYPE_LABELS = {
    "1": "通路",
    "2": "階段",
    "3": "エスカレータ",
    "4": "エレベータ",
    "5": "上りESC",
    "6": "下りESC",
    "7": "入口",
}

# ── パレット（共通色は gui_common.theme、ここはこのツール固有の色だけ）──────────
BG_TABLE    = "#141E2E"
BG_ROW_ALT  = "#1A2436"
BG_SEL      = "#0E3A50"
COL_NOPATH  = "#A855F7"
COL_PEND    = "#4B5563"

STATUS_COLOR = {"ok": COL_OK, "anomaly": COL_WARN,
                "no_path": COL_NOPATH, "error": COL_ERR, "pending": COL_PEND}
STATUS_LABEL = {"ok": "OK", "anomaly": "異常",
                "no_path": "経路なし", "error": "エラー", "pending": "待機中"}

ANOMALY_LABEL = {
    "SAME_FLOOR_DETOUR":   "同フロア階移動",
    "FLOOR_OVERSHOOT":     "フロアOV",
    "FLOOR_REVERSAL":      "フロア往復",
    "UNEXPECTED_BUILDING": "想定外建物",
    "LOOP_DETECTED":       "ループ",
}

# テーブル列インデックス
C_FROM_ROOM, C_FROM_BLDG, C_FROM_FL = 0, 1, 2
C_TO_ROOM,   C_TO_BLDG,   C_TO_FL   = 3, 4, 5
C_STATUS, C_DIST, C_SEQ, C_ANOM     = 6, 7, 8, 9

TABLE_HEADERS = [
    "出発教室", "出発号館", "出発階",
    "目的教室", "目的号館", "目的階",
    "状態", "距離(m)", "経路概要", "異常内容",
]


# ── ヘルパー ──────────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    return make_session(headers={"User-Agent": "IKU-NAVI-RouteChecker/1.0", **JSON_HEADERS})


_fl = floor_label
_bl = building_label


def floor_sequence_str(path_coords: list) -> str:
    """経路の建物・フロア遷移を圧縮した文字列で返す"""
    seq, prev = [], None
    for n in path_coords:
        cur = (n["building"], n["floor"])
        if cur != prev:
            seq.append(cur)
            prev = cur
    parts = []
    for b, f in seq:
        parts.append("屋外" if b == 0 else f"{b}号館{_fl(f)}")
    # 隣接重複をまとめる
    out = []
    for p in parts:
        if not out or out[-1] != p:
            out.append(p)
    return " → ".join(out)


def detect_anomalies(
    path_coords: list,
    from_bldg: int, from_fl: int,
    to_bldg:   int, to_fl:   int,
    detect_loop: bool = False,
) -> list[tuple[str, str]]:
    """
    異常を検出して [(type_key, human_readable_description), ...] を返す。

    検出する異常:
      SAME_FLOOR_DETOUR   - 同号館・同フロア間なのに別フロアを経由
      FLOOR_OVERSHOOT     - 同号館間で必要フロア範囲を超えたフロアを経由
      FLOOR_REVERSAL      - 同号館内でフロアの往復（単調でない移動）
      UNEXPECTED_BUILDING - 出発・目的・屋外以外の建物を経由
      LOOP_DETECTED       - 経路中に同一ノードが複数回登場（detect_loop=True 時のみ）
    """
    if not path_coords or len(path_coords) < 2:
        return []

    anomalies: list[tuple[str, str]] = []
    bldg_seq = [n["building"] for n in path_coords]

    # ─ 1. 想定外の建物を経由 ─────────────────────────────────────────────────
    expected_bldgs = {from_bldg, to_bldg, 0}
    unexpected = sorted({b for b in bldg_seq if b not in expected_bldgs})
    if unexpected:
        names = ", ".join(_bl(b) for b in unexpected)
        anomalies.append((
            "UNEXPECTED_BUILDING",
            f"想定外の建物を経由しています: {names}\n"
            f"（出発:{_bl(from_bldg)} → 目的:{_bl(to_bldg)} の場合、"
            f"屋外のみ通過が想定されます）\n"
            f"→ connect_edge.csv や global_edge.csv の重みが不適切な可能性があります。",
        ))

    # ─ 2. 同号館・同フロア間で別フロアを経由 ────────────────────────────────
    if from_bldg == to_bldg and from_fl == to_fl and from_bldg != 0:
        bfloors = [n["floor"] for n in path_coords if n["building"] == from_bldg]
        other = sorted(set(f for f in bfloors if f != from_fl))
        if other:
            floor_names = ", ".join(_fl(f) for f in other)
            anomalies.append((
                "SAME_FLOOR_DETOUR",
                f"{_bl(from_bldg)} {_fl(from_fl)}→{_fl(to_fl)} (同フロア) なのに\n"
                f"別のフロア（{floor_names}）を経由しています。\n"
                f"→ 該当フロアの階段/エレベータエッジの weight×length が低すぎる、\n"
                f"  または同フロア廊下に未接続箇所があり迂回している可能性があります。",
            ))
            return anomalies  # これ以上の検出は冗長

    # ─ 3. 同号館内でフロアがオーバーシュート ─────────────────────────────────
    if from_bldg == to_bldg and from_bldg != 0 and from_fl != to_fl:
        min_f, max_f = min(from_fl, to_fl), max(from_fl, to_fl)
        bfloors = [n["floor"] for n in path_coords if n["building"] == from_bldg]
        overshoot = sorted(set(f for f in bfloors if f < min_f or f > max_f))
        if overshoot:
            floor_names = ", ".join(_fl(f) for f in overshoot)
            anomalies.append((
                "FLOOR_OVERSHOOT",
                f"{_bl(from_bldg)} {_fl(from_fl)}→{_fl(to_fl)} への移動に\n"
                f"必要範囲（{_fl(min_f)}〜{_fl(max_f)}）外のフロア（{floor_names}）を経由しています。\n"
                f"→ 階段グラフの接続が途切れており、一度別フロアを迂回している可能性があります。",
            ))

    # ─ 4. フロアの往復（行き来） ─────────────────────────────────────────────
    # 既に上記で検出済みの場合は追加しない
    if not anomalies:
        for bldg in sorted(set(bldg_seq)):
            if bldg == 0:
                continue
            floors = [n["floor"] for n in path_coords if n["building"] == bldg]
            dirs = [
                1 if floors[i + 1] > floors[i] else -1
                for i in range(len(floors) - 1)
                if floors[i + 1] != floors[i]
            ]
            if len(dirs) >= 2:
                reversals = sum(1 for i in range(len(dirs) - 1) if dirs[i] != dirs[i + 1])
                if reversals > 0:
                    seq_str = " → ".join(_fl(f) for f in floors)
                    anomalies.append((
                        "FLOOR_REVERSAL",
                        f"{_bl(bldg)} 内でフロアの行き来があります。\n"
                        f"フロア順序: {seq_str}\n"
                        f"→ 本来は単調に移動できるはずです。\n"
                        f"  階段/エレベータの weight が非対称になっている可能性があります。",
                    ))

    # ─ 5. ループ検出（同一ノードの再訪） ────────────────────────────────────
    if detect_loop:
        seen: dict[int, int] = {}   # node_id → 最初の登場インデックス
        loop_nodes: list[tuple[int, int, int]] = []  # (node_id, 初回index, 再登場index)
        for i, n in enumerate(path_coords):
            nid = int(n["id"])
            if nid in seen:
                loop_nodes.append((nid, seen[nid], i))
            else:
                seen[nid] = i
        if loop_nodes:
            details = "\n".join(
                f"  ノード{nid}: ステップ{fi + 1} → ステップ{ri + 1}"
                f"（{_bl(path_coords[fi]['building'])} {_fl(path_coords[fi]['floor'])}）"
                for nid, fi, ri in loop_nodes[:5]   # 最大5件表示
            )
            suffix = f"\n  … 他 {len(loop_nodes) - 5} 件" if len(loop_nodes) > 5 else ""
            anomalies.append((
                "LOOP_DETECTED",
                f"経路中に同一ノードが {len(loop_nodes)} か所で再訪されています。\n"
                f"{details}{suffix}\n"
                f"→ Dijkstra は通常ループを生成しません。\n"
                f"  グラフに負の重みや孤立した連結成分が存在する可能性があります。",
            ))

    return anomalies


# ── ワーカー ──────────────────────────────────────────────────────────────────

class FetchAllWorker(QThread):
    """/api/all と /api/graph を取得する"""
    finished = pyqtSignal(list, dict)   # rooms_list, edges_by_pair
    error    = pyqtSignal(str)

    def __init__(self, api_url: str):
        super().__init__()
        self.api_url = api_url.rstrip("/")

    def run(self):
        session = _make_session()
        try:
            all_data   = self._get(session, f"{self.api_url}/api/all")
            graph_data = self._get(session, f"{self.api_url}/api/graph")
        except Exception as e:
            self.error.emit(str(e))
            return

        rooms_list    = all_data.get("rooms", [])
        edges_by_pair = {
            (int(e["from"]), int(e["to"])): e
            for e in graph_data.get("edges", [])
        }
        self.finished.emit(rooms_list, edges_by_pair)

    def _get(self, session: requests.Session, url: str) -> dict:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        return r.json()


class RouteCheckWorker(QThread):
    """全ペアの経路を並列取得する"""
    route_ready = pyqtSignal(dict)
    progress    = pyqtSignal(int, int)
    finished    = pyqtSignal()

    def __init__(self, api_url: str, pairs: list,
                 max_workers: int = MAX_WORKERS, detect_loop: bool = False):
        super().__init__()
        self.api_url     = api_url.rstrip("/")
        self.pairs       = pairs
        self.max_workers = max_workers
        self.detect_loop = detect_loop
        self._stop       = False
        self._done       = 0
        self._lock       = threading.Lock()

    def stop(self):
        self._stop = True

    def run(self):
        total = len(self.pairs)
        tls   = threading.local()

        def get_session():
            if not hasattr(tls, "s"):
                tls.s = _make_session()
            return tls.s

        def fetch_one(pair):
            if self._stop:
                return
            fr, fb, ff, tr, tb, tf = pair
            result = {
                "from_room": fr, "from_building": fb, "from_floor": ff,
                "to_room":   tr, "to_building":   tb, "to_floor":   tf,
                "status": "error", "total_weight": None,
                "path_coords": [], "path_edges": [],
                "anomalies": [], "error_msg": "", "floor_sequence": "",
            }
            url = (f"{self.api_url}/api/route"
                   f"?from_room={fr}&from_building={fb}"
                   f"&to_room={tr}&to_building={tb}")
            try:
                r = get_session().get(url, timeout=15)
                if r.status_code == 404:
                    result["status"]    = "no_path"
                    result["error_msg"] = r.json().get("error", "経路なし")
                elif r.status_code == 200:
                    data   = r.json()
                    coords = data.get("path_coords", [])
                    edges  = data.get("path_edges",  [])
                    anom   = detect_anomalies(coords, fb, ff, tb, tf,
                                              detect_loop=self.detect_loop)
                    result.update({
                        "status":         "anomaly" if anom else "ok",
                        "total_weight":   data.get("total_weight"),
                        "path_coords":    coords,
                        "path_edges":     edges,
                        "anomalies":      anom,
                        "floor_sequence": floor_sequence_str(coords),
                    })
                else:
                    result["error_msg"] = f"HTTP {r.status_code}"
            except Exception as e:
                result["error_msg"] = str(e)

            with self._lock:
                self._done += 1
                n = self._done
            self.route_ready.emit(result)
            self.progress.emit(n, total)

        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            list(pool.map(fetch_one, self.pairs))
        self.finished.emit()


# ── 経路詳細ダイアログ ────────────────────────────────────────────────────────

class _NumItem(QTableWidgetItem):
    """数値ソート対応の QTableWidgetItem"""
    def __lt__(self, other: QTableWidgetItem) -> bool:
        try:
            return float(self.text()) < float(other.text())
        except ValueError:
            return super().__lt__(other)


class PathDetailDialog(QDialog):
    """1ペアの経路詳細・異常原因を表示するダイアログ"""

    _STYLE = f"""
        QDialog, QWidget  {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
        QTextEdit, QTableWidget {{
            background: #1A2233; color: {TXT_PRIMARY};
            border: 1px solid {BORDER}; border-radius: 6px;
        }}
        QHeaderView::section {{
            background: #2D3748; color: {TXT_KEY};
            border: none; padding: 4px 8px; font-size: 13px;
        }}
        QTableWidget::item:selected {{ background: {BG_SEL}; }}
        QPushButton {{
            background: {BTN_IDLE}; color: {TXT_PRIMARY};
            border-radius: 5px; padding: 4px 14px; border: none;
        }}
        QPushButton:hover {{ background: #4B5563; }}
    """

    def __init__(self, result: dict, edges_by_pair: dict, parent=None):
        super().__init__(parent)
        self._result        = result
        self._edges_by_pair = edges_by_pair
        self.setStyleSheet(self._STYLE)

        fr, fb, ff = result["from_room"], result["from_building"], result["from_floor"]
        tr, tb, tf = result["to_room"],   result["to_building"],   result["to_floor"]
        self.setWindowTitle(
            f"経路詳細: {fr}({_bl(fb)} {_fl(ff)}) → {tr}({_bl(tb)} {_fl(tf)})"
        )
        self.setMinimumSize(820, 600)
        self.resize(1020, 700)
        self._build_ui()

    def _build_ui(self):
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(16, 16, 16, 16)
        vbox.setSpacing(10)

        r  = self._result
        fr, fb, ff = r["from_room"], r["from_building"], r["from_floor"]
        tr, tb, tf = r["to_room"],   r["to_building"],   r["to_floor"]

        # ── タイトル ──────────────────────────────────────────────────────────
        title = QLabel(
            f"{fr}（{_bl(fb)} {_fl(ff)}）  →  {tr}（{_bl(tb)} {_fl(tf)}）"
        )
        title.setFont(QFont("", 14, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {ACCENT};")
        title.setWordWrap(True)
        vbox.addWidget(title)

        # 状態・距離
        dist_str = f"{r['total_weight']:.1f} m" if r.get("total_weight") is not None else "—"
        color    = STATUS_COLOR.get(r["status"], TXT_SUB)
        info = QLabel(f"状態: {STATUS_LABEL.get(r['status'], r['status'])}   距離: {dist_str}")
        info.setFont(QFont("", 12))
        info.setStyleSheet(f"color: {color};")
        vbox.addWidget(info)

        if r.get("floor_sequence"):
            seq_lbl = QLabel(f"経路概要:  {r['floor_sequence']}")
            seq_lbl.setFont(QFont("", 11))
            seq_lbl.setStyleSheet(f"color: {TXT_SUB};")
            seq_lbl.setWordWrap(True)
            vbox.addWidget(seq_lbl)

        # ── 異常パネル ────────────────────────────────────────────────────────
        anomalies = r.get("anomalies", [])
        if anomalies:
            box = QFrame()
            box.setStyleSheet(
                f"QFrame {{ background: #2B1A0A; border: 1px solid {COL_WARN}; border-radius: 6px; }}"
            )
            bvbox = QVBoxLayout(box)
            bvbox.setContentsMargins(12, 8, 12, 8)
            bvbox.setSpacing(8)
            warn = QLabel(f"⚠  {len(anomalies)} 件の異常が検出されました")
            warn.setFont(QFont("", 12, QFont.Weight.Bold))
            warn.setStyleSheet(f"color: {COL_WARN}; background: transparent;")
            bvbox.addWidget(warn)
            for atype, adesc in anomalies:
                lbl = QLabel(f"【{ANOMALY_LABEL.get(atype, atype)}】\n{adesc}")
                lbl.setFont(QFont("", 11))
                lbl.setWordWrap(True)
                lbl.setStyleSheet(f"color: {TXT_PRIMARY}; background: transparent;")
                bvbox.addWidget(lbl)
            vbox.addWidget(box)

        elif r["status"] == "error":
            vbox.addWidget(self._build_message_box(
                "#2B0F0F", COL_ERR, f"エラー: {r.get('error_msg', '')}"
            ))

        elif r["status"] == "no_path":
            vbox.addWidget(self._build_message_box(
                "#1A0B2E", COL_NOPATH, f"経路なし: {r.get('error_msg', '')}"
            ))

        # ── 経路テーブル ──────────────────────────────────────────────────────
        coords = r.get("path_coords", [])
        edges  = r.get("path_edges",  [])
        if coords:
            vbox.addWidget(self._build_path_table(coords, edges, fb, ff, tb, tf))

        # ── ボタン ────────────────────────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        json_btn = QPushButton("JSON 表示")
        json_btn.clicked.connect(self._show_json)
        btn_row.addWidget(json_btn)
        close_btn = QPushButton("閉じる")
        close_btn.setStyleSheet(
            f"QPushButton {{ background:{BTN_ACTIVE}; color:#FFF; border-radius:5px; padding:4px 14px; }}"
        )
        close_btn.clicked.connect(self.accept)
        btn_row.addWidget(close_btn)
        vbox.addLayout(btn_row)

    def _build_message_box(self, bg: str, color: str, text: str) -> QFrame:
        """背景色・アクセント色付きの単一メッセージ枠を作る（エラー/経路なし表示用）"""
        box = QFrame()
        box.setStyleSheet(
            f"QFrame {{ background: {bg}; border: 1px solid {color}; border-radius: 6px; }}"
        )
        bvbox = QVBoxLayout(box)
        lbl = QLabel(text)
        lbl.setWordWrap(True)
        lbl.setStyleSheet(f"color: {color}; background: transparent;")
        bvbox.addWidget(lbl)
        return box

    def _build_path_table(
        self, coords: list, edges: list,
        from_bldg: int, from_fl: int, to_bldg: int, to_fl: int,
    ) -> QTableWidget:
        cols = ["#", "ノードID", "号館", "階", "→ エッジ種別", "区間距離(m)", "重み(計算値)"]
        tbl  = QTableWidget(len(coords), len(cols))
        tbl.setHorizontalHeaderLabels(cols)
        tbl.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        tbl.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        tbl.setAlternatingRowColors(True)
        tbl.verticalHeader().setVisible(False)
        tbl.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        tbl.horizontalHeader().setStretchLastSection(True)
        tbl.setFont(QFont("Courier New", 11))
        tbl.setStyleSheet(f"""
            QTableWidget {{
                alternate-background-color: {BG_ROW_ALT};
                background: {BG_TABLE}; gridline-color: {BORDER};
            }}
            QTableWidget::item {{ padding: 3px 8px; }}
        """)

        ep = self._edges_by_pair
        expected_bldgs  = {from_bldg, to_bldg, 0}
        same_floor_trip = (from_bldg == to_bldg and from_fl == to_fl and from_bldg != 0)

        for row_i, node in enumerate(coords):
            nid  = node.get("id", "")
            bldg = node.get("building", 0)
            fl   = node.get("floor", 0)

            # エッジ情報（このノード → 次ノードへ）
            etype_str = seg_len_str = wt_str = ""
            if row_i < len(edges):
                e = edges[row_i]
                key = (int(e.get("from", 0)), int(e.get("to", 0)))
                if key in ep:
                    etype     = str(ep[key].get("type", ""))
                    etype_str = EDGE_TYPE_LABELS.get(etype, f"type{etype}")
                    raw_w     = float(ep[key].get("weight", 0))
                    raw_l     = float(ep[key].get("length", 0))
                    penalty   = 50.0 if ep[key].get("type") in ("7", 7) else 0.0
                    wt_str    = f"{raw_w * raw_l + penalty:.2f}"
                seg_len_str = f"{e.get('length', 0):.2f}"

            vals = [str(row_i + 1), str(nid), _bl(bldg), _fl(fl),
                    etype_str, seg_len_str, wt_str]
            for ci, v in enumerate(vals):
                item = QTableWidgetItem(v)
                item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                tbl.setItem(row_i, ci, item)

            # 異常行ハイライト
            is_anom = (
                bldg not in expected_bldgs
                or (same_floor_trip and bldg == from_bldg and fl != from_fl)
            )
            if is_anom:
                for ci in range(len(cols)):
                    it = tbl.item(row_i, ci)
                    if it:
                        it.setBackground(QBrush(QColor("#3B1515")))
                        it.setForeground(QBrush(QColor(COL_ERR)))
            elif row_i > 0:
                prev = coords[row_i - 1]
                if bldg != prev["building"] or fl != prev["floor"]:
                    for ci in range(len(cols)):
                        it = tbl.item(row_i, ci)
                        if it:
                            it.setBackground(QBrush(QColor("#1C2F1C")))

        return tbl

    def _show_json(self):
        dlg = QDialog(self)
        dlg.setWindowTitle("生データ (JSON)")
        dlg.resize(700, 500)
        dlg.setStyleSheet(f"""
            QDialog {{ background: {BG_WIN}; }}
            QTextEdit {{ background: #1A2233; color: {TXT_PRIMARY};
                border: 1px solid {BORDER}; border-radius: 4px;
                font-family: "Courier New"; font-size: 12px; }}
            QPushButton {{ background: {BTN_IDLE}; color: {TXT_PRIMARY};
                border-radius: 5px; padding: 4px 14px; border: none; }}
        """)
        vb = QVBoxLayout(dlg)
        te = QTextEdit()
        te.setReadOnly(True)
        disp = dict(self._result)
        coords = disp.get("path_coords", [])
        if len(coords) > 10:
            disp["path_coords"] = coords[:5] + [f"... ({len(coords)-10} 省略) ..."] + coords[-5:]
        te.setPlainText(json.dumps(disp, ensure_ascii=False, indent=2))
        vb.addWidget(te)
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        copy_btn = QPushButton("コピー")
        copy_btn.setStyleSheet(
            f"QPushButton {{ background:{BTN_ACTIVE}; color:#FFF; border-radius:5px; padding:4px 14px; }}"
        )
        copy_btn.clicked.connect(lambda: QApplication.clipboard().setText(te.toPlainText()))
        btn_row.addWidget(copy_btn)
        ok_btn = QPushButton("閉じる")
        ok_btn.clicked.connect(dlg.accept)
        btn_row.addWidget(ok_btn)
        vb.addLayout(btn_row)
        dlg.exec()


# ── メインウィンドウ ──────────────────────────────────────────────────────────

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("IKU NAVI ルートチェッカー")
        self.setMinimumSize(1100, 680)
        self.resize(1440, 860)

        self._rooms_list:     list = []
        self._edges_by_pair:  dict = {}
        self._all_results:    list = []   # CSV出力用に全結果を保持
        self._pending_results: list = []  # バッチ挿入バッファ

        self._fetch_worker: FetchAllWorker   | None = None
        self._route_worker: RouteCheckWorker | None = None

        # 検証中は 300ms ごとにまとめてテーブルへ挿入する
        self._flush_timer = QTimer(self)
        self._flush_timer.setInterval(300)
        self._flush_timer.timeout.connect(self._flush_pending)

        self._build_ui()
        self._apply_theme()

    # ── テーマ ────────────────────────────────────────────────────────────────

    def _apply_theme(self):
        self.setStyleSheet(base_stylesheet() + f"""
            QComboBox {{
                background: {INPUT_BG}; color: {TXT_PRIMARY};
                border: 1px solid {INPUT_BORDER}; border-radius: 6px;
                padding: 3px 8px; font-size: 13px; min-width: 80px;
            }}
            QComboBox QAbstractItemView {{
                background: {INPUT_BG}; color: {TXT_PRIMARY};
                selection-background-color: {BTN_ACTIVE};
            }}
            QCheckBox {{ color: {TXT_SUB}; font-size: 13px; spacing: 6px; }}
            QTableWidget {{
                background: {BG_TABLE}; color: {TXT_PRIMARY};
                alternate-background-color: {BG_ROW_ALT};
                gridline-color: {BORDER}; border: 1px solid {BORDER};
                font-size: 13px;
            }}
            QTableWidget::item {{ padding: 3px 8px; }}
            QTableWidget::item:selected {{ background: {BG_SEL}; }}
            QHeaderView::section {{
                background: {BG_BAR}; color: {TXT_KEY};
                border: none; border-right: 1px solid {BORDER};
                padding: 5px 8px; font-size: 13px; font-weight: bold;
            }}
            QHeaderView::section:hover {{ background: {BORDER}; }}
        """)

    # ── UI構築 ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(0)
        vbox.addWidget(self._build_topbar())
        vbox.addWidget(self._build_filterbar())
        vbox.addWidget(self._build_table(), stretch=1)

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(62)
        bar.setStyleSheet(f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};")
        row = QHBoxLayout(bar)
        row.setContentsMargins(16, 0, 16, 0)
        row.setSpacing(10)

        title = QLabel("IKU NAVI ルートチェッカー")
        title.setFont(QFont("", 18, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {ACCENT};")
        row.addWidget(title)

        row.addSpacing(16)
        lbl = QLabel("API URL:")
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 15px;")
        row.addWidget(lbl)

        self._api_edit = QLineEdit(DEFAULT_API)
        self._api_edit.setFixedWidth(240)
        self._api_edit.returnPressed.connect(self._start_fetch)
        row.addWidget(self._api_edit)

        self._fetch_btn = self._btn("教室取得", ACCENT, "#001A22")
        self._fetch_btn.setFixedSize(90, 34)
        self._fetch_btn.clicked.connect(self._start_fetch)
        row.addWidget(self._fetch_btn)

        self._start_btn = self._btn("検証開始", "#059669", "#FFF")
        self._start_btn.setFixedSize(90, 34)
        self._start_btn.setEnabled(False)
        self._start_btn.clicked.connect(self._start_check)
        row.addWidget(self._start_btn)

        self._stop_btn = self._btn("停止", "#7F1D1D", "#FFF")
        self._stop_btn.setFixedSize(60, 34)
        self._stop_btn.setEnabled(False)
        self._stop_btn.clicked.connect(self._stop_check)
        row.addWidget(self._stop_btn)

        self._export_btn = self._btn("CSV出力", BTN_IDLE, TXT_PRIMARY)
        self._export_btn.setFixedSize(80, 34)
        self._export_btn.setEnabled(False)
        self._export_btn.clicked.connect(self._export_csv)
        row.addWidget(self._export_btn)

        row.addSpacing(8)
        self._progress = QProgressBar()
        self._progress.setFixedSize(200, 8)
        self._progress.setRange(0, 1)
        self._progress.setValue(0)
        self._progress.setTextVisible(False)
        row.addWidget(self._progress)

        row.addStretch()

        self._status_lbl = QLabel("API URL を入力して「教室取得」を押してください")
        self._status_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 14px;")
        row.addWidget(self._status_lbl)

        return bar

    def _build_filterbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(46)
        bar.setStyleSheet(f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};")
        row = QHBoxLayout(bar)
        row.setContentsMargins(16, 0, 16, 0)
        row.setSpacing(10)

        # 検証設定
        self._excl_toilet = QCheckBox("トイレ除外")
        self._excl_toilet.setChecked(True)
        row.addWidget(self._excl_toilet)

        self._directed = QCheckBox("双方向 (A→B と B→A 両方)")
        self._directed.setChecked(False)
        row.addWidget(self._directed)

        self._detect_loop = QCheckBox("ループ検出")
        self._detect_loop.setChecked(False)
        self._detect_loop.setToolTip(
            "経路中に同一ノードが2回以上登場する場合（グラフループ）を異常として検出します。\n"
            "Dijkstra は通常ループを生成しないため、検出された場合はデータの問題を示します。"
        )
        row.addWidget(self._detect_loop)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(24)
        sep.setStyleSheet(f"color: {BORDER};")
        row.addWidget(sep)

        # 表示フィルタ
        row.addWidget(self._sub_lbl("表示:"))
        self._f_status = QComboBox()
        self._f_status.addItems(["全て", "OK", "異常", "経路なし", "エラー"])
        self._f_status.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_status)

        row.addWidget(self._sub_lbl("出発号館:"))
        self._f_from = QComboBox()
        self._f_from.addItem("全て", -1)
        self._f_from.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_from)

        row.addWidget(self._sub_lbl("目的号館:"))
        self._f_to = QComboBox()
        self._f_to.addItem("全て", -1)
        self._f_to.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_to)

        row.addWidget(self._sub_lbl("検索:"))
        self._search = QLineEdit()
        self._search.setPlaceholderText("教室名…")
        self._search.setFixedWidth(130)
        self._search.textChanged.connect(self._apply_filter)
        row.addWidget(self._search)

        row.addStretch()

        self._count_lbl = QLabel("")
        self._count_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 13px;")
        row.addWidget(self._count_lbl)

        return bar

    def _build_table(self) -> QTableWidget:
        self._table = QTableWidget(0, len(TABLE_HEADERS))
        self._table.setHorizontalHeaderLabels(TABLE_HEADERS)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setAlternatingRowColors(True)
        self._table.setSortingEnabled(True)
        self._table.verticalHeader().setVisible(False)
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.cellDoubleClicked.connect(self._on_double_click)

        for i, w in enumerate([90, 70, 55, 90, 70, 55, 75, 70, 260, 200]):
            self._table.setColumnWidth(i, w)

        return self._table

    # ── ウィジェットファクトリ ────────────────────────────────────────────────

    def _btn(self, text: str, bg: str, fg: str) -> QPushButton:
        b = QPushButton(text)
        b.setFont(QFont("", 13, QFont.Weight.Bold))
        b.setStyleSheet(f"""
            QPushButton {{ background: {bg}; color: {fg}; border-radius: 6px; border: none; }}
            QPushButton:disabled {{ background: #374151; color: #4B5563; }}
        """)
        return b

    def _sub_lbl(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 13px;")
        return lbl

    # ── 教室取得 ──────────────────────────────────────────────────────────────

    def _start_fetch(self):
        url = self._api_edit.text().strip()
        if not url:
            QMessageBox.warning(self, "エラー", "API URL を入力してください。")
            return
        self._fetch_btn.setEnabled(False)
        self._start_btn.setEnabled(False)
        self._set_status("教室一覧とグラフを取得中...", TXT_SUB)

        self._fetch_worker = FetchAllWorker(url)
        self._fetch_worker.finished.connect(self._on_rooms_fetched)
        self._fetch_worker.error.connect(self._on_fetch_error)
        self._fetch_worker.start()

    def _on_fetch_error(self, msg: str):
        self._fetch_btn.setEnabled(True)
        self._set_status(f"取得エラー: {msg}", COL_ERR)
        QMessageBox.critical(self, "取得エラー", f"API に接続できませんでした:\n\n{msg}")

    def _on_rooms_fetched(self, rooms_list: list, edges_by_pair: dict):
        self._rooms_list    = rooms_list
        self._edges_by_pair = edges_by_pair

        buildings = sorted({r["building"] for r in rooms_list})
        for combo in (self._f_from, self._f_to):
            combo.blockSignals(True)
            combo.clear()
            combo.addItem("全て", -1)
            for b in buildings:
                combo.addItem(_bl(b), b)
            combo.blockSignals(False)

        n = len(rooms_list)
        self._set_status(
            f"教室 {n} 室を取得しました（トイレ除外後 {self._count_pairs()} ペアを検証予定）",
            COL_OK,
        )
        self._fetch_btn.setEnabled(True)
        self._start_btn.setEnabled(True)

    def _count_pairs(self) -> int:
        n = len(self._filtered_rooms())
        return n * (n - 1) if self._directed.isChecked() else n * (n - 1) // 2

    def _filtered_rooms(self) -> list:
        rooms = self._rooms_list
        if self._excl_toilet.isChecked():
            rooms = [r for r in rooms if r["room"] not in TOILET_ROOMS]
        return rooms

    # ── ルート検証 ───────────────────────────────────────────────────────────

    def _start_check(self):
        rooms = self._filtered_rooms()
        if len(rooms) < 2:
            QMessageBox.warning(self, "教室不足", "検証対象の教室が 2 室以上必要です。")
            return

        keys = [(r["room"], r["building"], r["floor"]) for r in rooms]
        directed = self._directed.isChecked()
        n = len(keys)

        if directed:
            pairs = [
                (*keys[i], *keys[j])
                for i in range(n) for j in range(n) if i != j
            ]
        else:
            pairs = [
                (*keys[i], *keys[j])
                for i in range(n) for j in range(i + 1, n)
            ]

        # テーブルをリセット
        self._table.setSortingEnabled(False)
        self._table.setRowCount(0)
        self._all_results.clear()
        self._pending_results.clear()

        self._start_btn.setEnabled(False)
        self._stop_btn.setEnabled(True)
        self._export_btn.setEnabled(False)
        self._progress.setRange(0, len(pairs))
        self._progress.setValue(0)
        self._set_status(f"0 / {len(pairs)} ペアを検証中...", TXT_SUB)

        self._route_worker = RouteCheckWorker(
            self._api_edit.text().strip(), pairs,
            detect_loop=self._detect_loop.isChecked(),
        )
        self._route_worker.route_ready.connect(self._on_route_ready)
        self._route_worker.progress.connect(self._on_progress)
        self._route_worker.finished.connect(self._on_finished)
        self._route_worker.start()
        self._flush_timer.start()

    def _stop_check(self):
        if self._route_worker:
            self._route_worker.stop()
        self._flush_timer.stop()
        self._flush_pending()
        self._stop_btn.setEnabled(False)
        self._set_status("停止中...", COL_WARN)

    def _on_route_ready(self, result: dict):
        # メインスレッドのブロックを避けるためバッファに積むだけ
        self._all_results.append(result)
        self._pending_results.append(result)

    def _on_progress(self, done: int, total: int):
        self._progress.setValue(done)
        self._set_status(f"{done} / {total} ペアを検証中...", TXT_SUB)
        # フィルタ全走査は行わず件数表示のみ更新
        self._count_lbl.setText(f"取得済み: {self._table.rowCount()} 件")

    def _flush_pending(self):
        """バッファに溜まった結果をまとめてテーブルへ挿入する（300ms 間隔）"""
        if not self._pending_results:
            return
        batch, self._pending_results = self._pending_results, []

        tbl = self._table
        tbl.setUpdatesEnabled(False)
        for r in batch:
            self._add_row(r)
        tbl.setUpdatesEnabled(True)

        self._count_lbl.setText(f"取得済み: {tbl.rowCount()} 件")

    def _on_finished(self):
        self._flush_timer.stop()
        self._flush_pending()   # 残りをすべて挿入

        self._stop_btn.setEnabled(False)
        self._start_btn.setEnabled(True)
        self._export_btn.setEnabled(True)
        self._table.setSortingEnabled(True)

        ok  = sum(1 for r in self._all_results if r["status"] == "ok")
        an  = sum(1 for r in self._all_results if r["status"] == "anomaly")
        np_ = sum(1 for r in self._all_results if r["status"] == "no_path")
        er  = sum(1 for r in self._all_results if r["status"] == "error")
        tot = len(self._all_results)
        col = COL_WARN if (an or er) else COL_OK
        self._set_status(
            f"完了: 全{tot}ペア  ✔OK:{ok}  ⚠異常:{an}  ✕経路なし:{np_}  ✕エラー:{er}",
            col,
        )
        self._apply_filter()   # 完了後に1回だけフィルタを適用

    # ── テーブル操作 ─────────────────────────────────────────────────────────

    def _add_row(self, r: dict):
        row_i = self._table.rowCount()
        self._table.insertRow(row_i)

        status   = r["status"]
        scol     = QColor(STATUS_COLOR.get(status, TXT_SUB))
        dist_str = f"{r['total_weight']:.1f}" if r.get("total_weight") is not None else "—"
        anom_str = "; ".join(ANOMALY_LABEL.get(t, t) for t, _ in r.get("anomalies", []))

        vals = [
            r["from_room"], _bl(r["from_building"]), _fl(r["from_floor"]),
            r["to_room"],   _bl(r["to_building"]),   _fl(r["to_floor"]),
            STATUS_LABEL.get(status, status),
            dist_str,
            r.get("floor_sequence", ""),
            anom_str or r.get("error_msg", ""),
        ]

        for ci, val in enumerate(vals):
            if ci == C_DIST:
                item = _NumItem(val)
            else:
                item = QTableWidgetItem(val)
            item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)

            if ci == C_STATUS:
                item.setForeground(QBrush(scol))
                if status == "anomaly":
                    item.setFont(QFont("", 12, QFont.Weight.Bold))
            elif ci == C_ANOM and anom_str:
                item.setForeground(QBrush(QColor(COL_WARN)))

            # 結果dictを col 0 アイテムに格納（ダブルクリック時に取得）
            if ci == 0:
                item.setData(Qt.ItemDataRole.UserRole, r)

            self._table.setItem(row_i, ci, item)

        # 異常行の背景
        if status == "anomaly":
            for ci in range(len(TABLE_HEADERS)):
                it = self._table.item(row_i, ci)
                if it:
                    it.setBackground(QBrush(QColor("#241800")))

    def _apply_filter(self):
        status_map = {"全て": None, "OK": "ok", "異常": "anomaly",
                      "経路なし": "no_path", "エラー": "error"}
        sel_st   = status_map.get(self._f_status.currentText())
        sel_from = self._f_from.currentData()
        sel_to   = self._f_to.currentData()
        query    = self._search.text().strip().lower()

        visible = 0
        for row_i in range(self._table.rowCount()):
            item = self._table.item(row_i, 0)
            if item is None:
                self._table.setRowHidden(row_i, False)
                continue
            r    = item.data(Qt.ItemDataRole.UserRole)
            show = True
            if r:
                if sel_st   and r["status"]        != sel_st:   show = False
                if sel_from != -1 and r["from_building"] != sel_from: show = False
                if sel_to   != -1 and r["to_building"]   != sel_to:   show = False
                if query and query not in r["from_room"].lower() \
                         and query not in r["to_room"].lower():        show = False
            self._table.setRowHidden(row_i, not show)
            if show:
                visible += 1

        self._count_lbl.setText(
            f"表示: {visible} / {self._table.rowCount()} 件"
        )

    def _on_double_click(self, row: int, _col: int):
        item = self._table.item(row, 0)
        if item is None:
            return
        result = item.data(Qt.ItemDataRole.UserRole)
        if result is None:
            return
        PathDetailDialog(result, self._edges_by_pair, parent=self).exec()

    # ── CSV 出力 ─────────────────────────────────────────────────────────────

    def _export_csv(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "CSV に保存", "route_check_result.csv",
            "CSV ファイル (*.csv);;全ファイル (*)",
        )
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(TABLE_HEADERS[:-1] + ["異常詳細"])
            for r in self._all_results:
                anom_str = " | ".join(desc for _, desc in r.get("anomalies", []))
                w.writerow([
                    r["from_room"], r["from_building"], r["from_floor"],
                    r["to_room"],   r["to_building"],   r["to_floor"],
                    r["status"],
                    f"{r['total_weight']:.2f}" if r.get("total_weight") is not None else "",
                    r.get("floor_sequence", ""),
                    anom_str or r.get("error_msg", ""),
                ])
        self._set_status(f"保存しました: {path}", COL_OK)

    # ── ユーティリティ ────────────────────────────────────────────────────────

    def _set_status(self, text: str, color: str):
        self._status_lbl.setText(text)
        self._status_lbl.setStyleSheet(f"color: {color}; font-size: 14px;")


# ── エントリーポイント ────────────────────────────────────────────────────────

def main():
    qt_app.run(MainWindow)


if __name__ == "__main__":
    main()
```

### `programs/Route_Checker/requirements.txt`

```text
PyQt6>=6.4.0
requests>=2.31.0

```

#### Image_Renamer

### `programs/Image_Renamer/image_renamer.py`

```python
#!/usr/bin/env python3
"""画像バッチリネーマー — 左にD&D、右に名前をペーストするだけ"""

import sys
import os
from pathlib import Path

from PIL import Image

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget,
    QHBoxLayout, QVBoxLayout,
    QLabel, QTextEdit, QListWidget, QPushButton,
    QAbstractItemView, QListWidgetItem,
    QMessageBox, QTableWidget, QTableWidgetItem, QHeaderView,
    QGroupBox, QLineEdit, QFrame,
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QColor, QPainter, QKeySequence, QShortcut, QIntValidator

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common import qt_app

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp",
              ".tiff", ".tif", ".webp", ".heic", ".heif"}


class DropListWidget(QListWidget):
    """画像ファイルのドロップ先リスト"""

    def __init__(self, on_change=None, parent=None):
        super().__init__(parent)
        self._on_change = on_change
        self._paths: list[str] = []
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DropOnly)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)

    # ── drag & drop ──────────────────────────────────────────────────

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and self._has_images(event.mimeData()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        added = False
        for url in event.mimeData().urls():
            path = url.toLocalFile()
            if path not in self._paths and self._is_image(path):
                self._paths.append(path)
                self.addItem(QListWidgetItem(os.path.basename(path)))
                added = True
        if added:
            event.acceptProposedAction()
            self._notify()

    # ── empty-state hint ─────────────────────────────────────────────

    def paintEvent(self, event):
        super().paintEvent(event)
        if self.count() == 0:
            p = QPainter(self.viewport())
            p.setPen(QColor("#aaaaaa"))
            p.setFont(QFont("", 12))
            p.drawText(
                self.viewport().rect(),
                Qt.AlignmentFlag.AlignCenter,
                "画像ファイルをここに\nドラッグ＆ドロップ\n\n.jpg .png .gif .bmp .tiff .webp .heic",
            )

    # ── public API ───────────────────────────────────────────────────

    def paths(self) -> list[str]:
        return list(self._paths)

    def clear_all(self):
        self.clear()
        self._paths.clear()
        self._notify()

    def remove_selected(self):
        rows = sorted({self.row(i) for i in self.selectedItems()}, reverse=True)
        for row in rows:
            self.takeItem(row)
            self._paths.pop(row)
        self._notify()

    # ── helpers ──────────────────────────────────────────────────────

    def _has_images(self, mime_data) -> bool:
        return any(self._is_image(u.toLocalFile()) for u in mime_data.urls())

    def _is_image(self, path: str) -> bool:
        return os.path.isfile(path) and Path(path).suffix.lower() in IMAGE_EXTS

    def _notify(self):
        if self._on_change:
            self._on_change()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("画像リネーマー")
        self.setMinimumSize(960, 780)
        self._build_ui()

    # ── UI construction ──────────────────────────────────────────────

    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        title = QLabel("画像リネーマー")
        title.setFont(QFont("", 18, QFont.Weight.Bold))
        layout.addWidget(title)

        sub = QLabel("①左に画像をドロップ　②右に名前リストをペースト　③「名前を変更する」をクリック")
        sub.setStyleSheet("color: #555; font-size: 12px;")
        layout.addWidget(sub)

        panels = QHBoxLayout()
        panels.setSpacing(16)
        panels.addLayout(self._left_panel(), stretch=1)
        panels.addLayout(self._right_panel(), stretch=1)
        layout.addLayout(panels)

        layout.addWidget(self._preview_section())
        layout.addWidget(self._rename_button())

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("color: #ddd;")
        layout.addWidget(sep)

        layout.addWidget(self._resize_section())

        QShortcut(QKeySequence.StandardKey.Delete, self).activated.connect(
            self.drop_list.remove_selected
        )

    def _left_panel(self) -> QVBoxLayout:
        vbox = QVBoxLayout()

        lbl = QLabel("① 画像をドラッグ＆ドロップ")
        lbl.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(lbl)

        hint = QLabel("複数まとめてドロップ可。Deleteキーで選択行を削除。")
        hint.setStyleSheet("color: #777; font-size: 11px;")
        vbox.addWidget(hint)

        self.drop_list = DropListWidget(on_change=self._refresh_preview)
        self.drop_list.setStyleSheet("""
            QListWidget {
                border: 2px dashed #bbb;
                border-radius: 10px;
                background: #f5f5f5;
                font-size: 13px;
            }
            QListWidget::item:selected {
                background: #bbdefb;
                color: #000;
            }
        """)
        vbox.addWidget(self.drop_list)

        clear_btn = QPushButton("リストをクリア")
        clear_btn.setStyleSheet("padding: 6px; font-size: 12px;")
        clear_btn.clicked.connect(self.drop_list.clear_all)
        vbox.addWidget(clear_btn)
        return vbox

    def _right_panel(self) -> QVBoxLayout:
        vbox = QVBoxLayout()

        lbl = QLabel("② 新しい名前をペースト（1行 = 1ファイル）")
        lbl.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(lbl)

        hint = QLabel("スプレッドシートからそのままコピペ。拡張子は自動で補完。")
        hint.setStyleSheet("color: #777; font-size: 11px;")
        vbox.addWidget(hint)

        self.name_edit = QTextEdit()
        self.name_edit.setPlaceholderText(
            "例:\n田中太郎\n山田花子\n佐藤次郎\n\n※ スプレッドシートの列をコピーしてここにペーストするだけでOK"
        )
        self.name_edit.setStyleSheet("""
            QTextEdit {
                border: 2px solid #ddd;
                border-radius: 10px;
                background: #fff;
                color: #000;
                font-size: 13px;
                padding: 8px;
            }
        """)
        self.name_edit.textChanged.connect(self._refresh_preview)
        vbox.addWidget(self.name_edit)

        clear_btn = QPushButton("名前リストをクリア")
        clear_btn.setStyleSheet("padding: 6px; font-size: 12px;")
        clear_btn.clicked.connect(self.name_edit.clear)
        vbox.addWidget(clear_btn)
        return vbox

    def _preview_section(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(4)

        self._preview_label = QLabel("プレビュー")
        self._preview_label.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(self._preview_label)

        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["変更前", "変更後"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setMaximumHeight(160)
        self.table.setStyleSheet("font-size: 13px;")
        vbox.addWidget(self.table)
        return w

    def _rename_button(self) -> QPushButton:
        btn = QPushButton("名前を変更する")
        btn.setFont(QFont("", 13, QFont.Weight.Bold))
        btn.setMinimumHeight(52)
        btn.setStyleSheet("""
            QPushButton {
                background: #1976D2;
                color: white;
                border-radius: 8px;
            }
            QPushButton:hover   { background: #1565C0; }
            QPushButton:pressed { background: #0D47A1; }
        """)
        btn.clicked.connect(self._do_rename)
        return btn

    def _resize_section(self) -> QGroupBox:
        box = QGroupBox("画像リスケール（ドロップした画像を一括変換）")
        box.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox = QVBoxLayout(box)
        vbox.setSpacing(8)

        hint = QLabel(
            "片方のみ入力 → もう一方を自動計算（縦横比維持）　両方入力 → 指定サイズに強制変換（縦横比無視）"
        )
        hint.setStyleSheet("color: #555; font-size: 11px; font-weight: normal;")
        vbox.addWidget(hint)

        size_row = QHBoxLayout()
        size_row.setSpacing(12)

        validator = QIntValidator(1, 99999)

        size_row.addWidget(QLabel("幅:"))
        self.width_edit = QLineEdit()
        self.width_edit.setPlaceholderText("未指定")
        self.width_edit.setValidator(validator)
        self.width_edit.setFixedWidth(90)
        self.width_edit.setStyleSheet("font-size: 13px; padding: 4px;")
        self.width_edit.textChanged.connect(self._refresh_resize_hint)
        size_row.addWidget(self.width_edit)
        size_row.addWidget(QLabel("px"))

        size_row.addSpacing(20)

        size_row.addWidget(QLabel("高さ:"))
        self.height_edit = QLineEdit()
        self.height_edit.setPlaceholderText("未指定")
        self.height_edit.setValidator(validator)
        self.height_edit.setFixedWidth(90)
        self.height_edit.setStyleSheet("font-size: 13px; padding: 4px;")
        self.height_edit.textChanged.connect(self._refresh_resize_hint)
        size_row.addWidget(self.height_edit)
        size_row.addWidget(QLabel("px"))

        size_row.addStretch()
        vbox.addLayout(size_row)

        self._resize_hint = QLabel("")
        self._resize_hint.setStyleSheet("color: #1976D2; font-size: 11px; font-weight: normal;")
        vbox.addWidget(self._resize_hint)

        resize_btn = QPushButton("一括リスケールする")
        resize_btn.setFont(QFont("", 13, QFont.Weight.Bold))
        resize_btn.setMinimumHeight(52)
        resize_btn.setStyleSheet("""
            QPushButton {
                background: #388E3C;
                color: white;
                border-radius: 8px;
            }
            QPushButton:hover   { background: #2E7D32; }
            QPushButton:pressed { background: #1B5E20; }
        """)
        resize_btn.clicked.connect(self._do_resize)
        vbox.addWidget(resize_btn)

        return box

    # ── shared dialogs ───────────────────────────────────────────────

    def _confirm(self, message: str) -> bool:
        reply = QMessageBox.question(
            self, "確認", message,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        return reply == QMessageBox.StandardButton.Yes

    def _show_result(self, ok: int, errors: list[str], success_message: str):
        if errors:
            QMessageBox.warning(self, "完了（エラーあり）",
                f"{ok} 件成功 / {len(errors)} 件失敗:\n\n" + "\n".join(errors))
        else:
            QMessageBox.information(self, "完了", success_message)

    # ── resize hint ──────────────────────────────────────────────────

    def _refresh_resize_hint(self):
        w = self.width_edit.text().strip()
        h = self.height_edit.text().strip()
        if w and h:
            self._resize_hint.setText(f"→ {w} × {h} px に強制変換（縦横比無視）")
        elif w:
            self._resize_hint.setText(f"→ 幅 {w} px に合わせ、高さを自動計算（縦横比維持）")
        elif h:
            self._resize_hint.setText(f"→ 高さ {h} px に合わせ、幅を自動計算（縦横比維持）")
        else:
            self._resize_hint.setText("")

    # ── resize logic ─────────────────────────────────────────────────

    def _do_resize(self):
        paths = self.drop_list.paths()
        if not paths:
            QMessageBox.warning(self, "警告", "画像がドロップされていません。")
            return

        w_text = self.width_edit.text().strip()
        h_text = self.height_edit.text().strip()
        new_w = int(w_text) if w_text else None
        new_h = int(h_text) if h_text else None

        if new_w is None and new_h is None:
            QMessageBox.warning(self, "警告", "幅または高さを入力してください。")
            return

        if new_w and new_h:
            mode_desc = f"{new_w} × {new_h} px に強制変換（縦横比無視）"
        elif new_w:
            mode_desc = f"幅 {new_w} px 基準でリスケール（縦横比維持）"
        else:
            mode_desc = f"高さ {new_h} px 基準でリスケール（縦横比維持）"

        if not self._confirm(
            f"{len(paths)} 件の画像を上書きリスケールします。\n\nモード: {mode_desc}\n\nよろしいですか？"
        ):
            return

        ok, errors = 0, []
        for path in paths:
            try:
                img = Image.open(path)
                orig_w, orig_h = img.size

                if new_w and new_h:
                    target = (new_w, new_h)
                elif new_w:
                    target = (new_w, max(1, round(orig_h * new_w / orig_w)))
                else:
                    target = (max(1, round(orig_w * new_h / orig_h)), new_h)

                resized = img.resize(target, Image.LANCZOS)
                resized.save(path)
                ok += 1
            except Exception as e:
                errors.append(f"{os.path.basename(path)}: {e}")

        self._show_result(ok, errors, f"{ok} 件の画像をリスケールしました。")

    # ── rename logic ─────────────────────────────────────────────────

    def _names(self) -> list[str]:
        return [ln.strip() for ln in self.name_edit.toPlainText().splitlines() if ln.strip()]

    def _resolve_new_name(self, orig_path: str, raw_name: str) -> str:
        """拡張子が省略されていれば元の拡張子を付ける。"""
        if Path(raw_name).suffix:
            return raw_name
        return raw_name + Path(orig_path).suffix

    def _refresh_preview(self):
        all_paths = self.drop_list.paths()
        names = self._names()
        matched = min(len(all_paths), len(names))

        self._preview_label.setText(
            f"プレビュー　{matched} 件がリネーム対象"
            + (f"　（名前不足: {len(all_paths) - matched} 件スキップ）"
               if len(all_paths) > len(names) else "")
        )

        self.table.setRowCount(len(all_paths))
        for i, path in enumerate(all_paths):
            orig_item = QTableWidgetItem(os.path.basename(path))

            if i < len(names):
                new_name = self._resolve_new_name(path, names[i])
                new_item = QTableWidgetItem(new_name)
                new_path = Path(path).parent / new_name
                if new_path.exists() and str(new_path) != path:
                    new_item.setBackground(QColor("#FFCDD2"))
                    new_item.setToolTip("同名ファイルが既に存在します — スキップされます")
                else:
                    new_item.setBackground(QColor("#C8E6C9"))
            else:
                new_item = QTableWidgetItem("— 名前なし（スキップ）")
                new_item.setBackground(QColor("#FFF9C4"))
                new_item.setForeground(QColor("#888"))

            self.table.setItem(i, 0, orig_item)
            self.table.setItem(i, 1, new_item)

    def _do_rename(self):
        all_paths = self.drop_list.paths()
        names = self._names()

        pairs: list[tuple[str, str]] = []
        for i, path in enumerate(all_paths):
            if i >= len(names):
                break
            pairs.append((path, self._resolve_new_name(path, names[i])))

        if not pairs:
            QMessageBox.warning(self, "警告",
                "変更できるファイルがありません。\n画像をドロップして名前リストを入力してください。")
            return

        if not self._confirm(f"{len(pairs)} 件のファイル名を変更します。よろしいですか？"):
            return

        ok, errors = 0, []
        for orig_path, new_name in pairs:
            new_path = Path(orig_path).parent / new_name
            if new_path.exists() and str(new_path) != orig_path:
                errors.append(f"{os.path.basename(orig_path)}: 同名ファイルが既に存在します（スキップ）")
                continue
            try:
                Path(orig_path).rename(new_path)
                ok += 1
            except OSError as e:
                errors.append(f"{os.path.basename(orig_path)}: {e}")

        self._show_result(ok, errors, f"{ok} 件のファイルをリネームしました。")

        self.drop_list.clear_all()
        self.name_edit.clear()


def main():
    qt_app.run(MainWindow)


if __name__ == "__main__":
    main()
```

### `programs/Image_Renamer/requirements.txt`

```text
PyQt6
Pillow

```

#### SVG_Pointer

### `programs/SVG_Pointer/svg_picker.py`

```python
#!/usr/bin/env python3
"""
SVG Coordinate Picker (PyQt5)
------------------------------
SVGファイルを画面に表示し、クリックした位置のSVG座標(x, y)を取得する。
クリックするたびに全点がクリップボードにタブ区切りでコピーされ、
スプレッドシートに2列でペースト可能。

Usage:
  python svg_picker.py [file.svg]
  python svg_picker.py             # ファイルダイアログで選択

依存:
  pip install PyQt5
"""

import sys
from pathlib import Path

try:
    from PyQt5.QtWidgets import (
        QApplication, QMainWindow, QGraphicsView, QGraphicsScene,
        QWidget, QVBoxLayout, QPushButton, QListWidget,
        QLabel, QFileDialog, QSplitter,
    )
    from PyQt5.QtSvg import QGraphicsSvgItem
    from PyQt5.QtCore import Qt, QTimer
    from PyQt5.QtGui import QPen, QBrush, QColor, QFont, QPainter
except ImportError:
    print("PyQt5が必要です:  pip install PyQt5")
    sys.exit(1)


PIN_R = 6
PIN_FILL    = QColor("#ff3333")
PIN_OUTLINE = QColor("white")
PIN_TEXT    = QColor("#cc0000")


# ---------------------------------------------------------------------------
# カスタム QGraphicsView — ズーム・パン・クリック
# ---------------------------------------------------------------------------

class SVGView(QGraphicsView):

    def __init__(self, scene: QGraphicsScene, on_click):
        super().__init__(scene)
        self._on_click = on_click
        self._press_pos = None

        self.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#e8e8e8")))

    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._press_pos = event.pos()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton and self._press_pos is not None:
            # 5px以内の移動ならクリック扱い（ドラッグと区別）
            if (event.pos() - self._press_pos).manhattanLength() < 5:
                scene_pos = self.mapToScene(event.pos())
                self._on_click(scene_pos.x(), scene_pos.y())
            self._press_pos = None
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event):
        k = event.key()
        if k in (Qt.Key_Plus, Qt.Key_Equal):
            self.scale(1.25, 1.25)
        elif k == Qt.Key_Minus:
            self.scale(0.8, 0.8)
        elif k == Qt.Key_0:
            self.fit_all()
        else:
            super().keyPressEvent(event)

    def fit_all(self):
        rect = self.scene().itemsBoundingRect()
        if not rect.isEmpty():
            self.fitInView(rect, Qt.KeepAspectRatio)


# ---------------------------------------------------------------------------
# メインウィンドウ
# ---------------------------------------------------------------------------

class MainWindow(QMainWindow):

    def __init__(self, svg_path: str):
        super().__init__()
        self.svg_path = svg_path
        self.points: list = []   # (svg_x, svg_y)

        self.setWindowTitle(f"SVG Coord Picker — {Path(svg_path).name}")
        self.resize(1280, 820)

        self._build_ui()
        self._load_svg()

    # ------------------------------------------------------------------
    # UI
    # ------------------------------------------------------------------

    def _build_ui(self):
        splitter = QSplitter(Qt.Horizontal)
        self.setCentralWidget(splitter)

        # 左: SVGビュー
        self._scene = QGraphicsScene()
        self._view = SVGView(self._scene, self._on_click)
        splitter.addWidget(self._view)

        # 右: サイドパネル
        side = QWidget()
        side.setFixedWidth(240)
        side.setStyleSheet("background:#f5f5f5;")
        vl = QVBoxLayout(side)
        vl.setContentsMargins(8, 12, 8, 8)
        vl.setSpacing(4)

        vl.addWidget(QLabel("<b>取得座標一覧</b>"))

        self._list = QListWidget()
        self._list.setFont(QFont("Courier", 11))
        self._list.setStyleSheet("background:white; color:black;")
        vl.addWidget(self._list, 1)

        for label, fn, color in [
            ("クリップボードにコピー (全点)", self._copy_all,       "#4CAF50"),
            ("選択した点を削除",              self._delete_selected, "#757575"),
            ("全消去",                        self._clear_all,       "#e53935"),
        ]:
            btn = QPushButton(label)
            btn.clicked.connect(fn)
            btn.setStyleSheet(
                f"QPushButton{{background:{color};color:white;"
                f"padding:6px;border:none;border-radius:3px;}}"
                f"QPushButton:hover{{background:{color};opacity:0.9;}}"
            )
            vl.addWidget(btn)

        note = QLabel("ズーム: スクロール / + −\n全体表示: キー 0\nパン: 左ドラッグ")
        note.setStyleSheet("color:#888;font-size:10px;")
        vl.addWidget(note)

        splitter.addWidget(side)
        splitter.setSizes([1040, 240])

        self.statusBar().showMessage("SVGをクリックして座標を取得")

    def _load_svg(self):
        self._svg_item = QGraphicsSvgItem(self.svg_path)
        self._scene.addItem(self._svg_item)
        self._scene.setSceneRect(self._svg_item.boundingRect())
        # ウィンドウ表示後に全体フィット
        QTimer.singleShot(100, self._view.fit_all)

    # ------------------------------------------------------------------
    # ピン描画
    # ------------------------------------------------------------------

    def _draw_pin(self, sx: float, sy: float, n: int):
        r = PIN_R
        pen_w = QPen(PIN_OUTLINE, 2)
        pen_r = QPen(PIN_FILL, 2)

        line = self._scene.addLine(sx, sy - r - 8, sx, sy - r, pen_r)
        line.setZValue(10)

        circle = self._scene.addEllipse(
            sx - r, sy - r, r * 2, r * 2, pen_w, QBrush(PIN_FILL)
        )
        circle.setZValue(10)

        text = self._scene.addSimpleText(str(n))
        text.setPos(sx + r + 2, sy - 8)
        text.setBrush(QBrush(PIN_TEXT))
        text.setFont(QFont("Helvetica", 8, QFont.Bold))
        text.setZValue(10)

    # ------------------------------------------------------------------
    # クリック
    # ------------------------------------------------------------------

    def _on_click(self, sx: float, sy: float):
        # SVG範囲外は無視
        if not self._svg_item.boundingRect().contains(sx, sy):
            return

        self.points.append((sx, sy))
        n = len(self.points)
        self._draw_pin(sx, sy, n)

        self._list.addItem(self._point_line(n, sx, sy))
        self._list.scrollToBottom()
        self._copy_all()
        self.statusBar().showMessage(
            f"点 {n} 追加 → クリップボードにコピー済み  (x={sx:.3f}, y={sy:.3f})"
        )

    # ------------------------------------------------------------------
    # クリップボード (タブ区切り → スプレッドシートに2列ペースト)
    # ------------------------------------------------------------------

    def _copy_all(self):
        if not self.points:
            return
        text = "\n".join(f"{x:.3f}\t{y:.3f}" for x, y in self.points)
        QApplication.clipboard().setText(text)

    # ------------------------------------------------------------------
    # リスト操作
    # ------------------------------------------------------------------

    def _delete_selected(self):
        row = self._list.currentRow()
        if row < 0:
            return
        self.points.pop(row)
        self._redraw_all()
        self._rebuild_list()
        self._copy_all()

    def _clear_all(self):
        self.points.clear()
        self._redraw_all()
        self._list.clear()
        QApplication.clipboard().clear()
        self.statusBar().showMessage("全消去しました")

    def _redraw_all(self):
        for item in list(self._scene.items()):
            if item is not self._svg_item:
                self._scene.removeItem(item)
        for i, (sx, sy) in enumerate(self.points, 1):
            self._draw_pin(sx, sy, i)

    def _rebuild_list(self):
        self._list.clear()
        for i, (x, y) in enumerate(self.points, 1):
            self._list.addItem(self._point_line(i, x, y))

    @staticmethod
    def _point_line(n: int, x: float, y: float) -> str:
        return f"{n:>3}: {x:>10.3f}, {y:>10.3f}"


# ---------------------------------------------------------------------------
# エントリーポイント
# ---------------------------------------------------------------------------

def main():
    app = QApplication(sys.argv)

    if len(sys.argv) > 1:
        svg_path = sys.argv[1]
    else:
        svg_path, _ = QFileDialog.getOpenFileName(
            None, "SVGファイルを選択", "",
            "SVG files (*.svg);;All files (*)"
        )
        if not svg_path:
            sys.exit(0)

    win = MainWindow(svg_path)
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()

```

### `programs/SVG_Pointer/requirements.txt`

```text
PyQt5>=5.15.0

```

#### Human_Remover

### `programs/Human_Remover/main.py`

```python
#!/usr/bin/env python3
"""
Human Remover
写真内の人物（立ち/座り問わず）を自動検出してぼかし・モザイク・消去するツール
"""

import sys
import os
import cv2
import numpy as np
from pathlib import Path
from typing import Optional, List, Dict

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QListWidget, QListWidgetItem, QSlider,
    QComboBox, QProgressBar, QFileDialog, QAbstractItemView,
    QMessageBox, QSizePolicy,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QSize
from PyQt6.QtGui import (
    QPixmap, QImage, QIcon, QColor, QPainter, QBrush,
    QDragEnterEvent, QDropEvent,
)

# ──────────────────────────────────────────────────────────────────────
#  定数
# ──────────────────────────────────────────────────────────────────────
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif"}
MODEL_NAME     = "yolov8n-seg.pt"   # 初回起動時に自動ダウンロード (~6 MB)
PERSON_CLS     = 0                  # COCO person class

STATUS_WAIT  = "wait"
STATUS_OK    = "ok"
STATUS_SKIP  = "skip"   # 人物なし
STATUS_ERROR = "error"

STATUS_COLORS = {
    STATUS_WAIT:  "#475569",
    STATUS_OK:    "#22c55e",
    STATUS_SKIP:  "#eab308",
    STATUS_ERROR: "#ef4444",
}


# ──────────────────────────────────────────────────────────────────────
#  ヘルパー
# ──────────────────────────────────────────────────────────────────────
def rgb_to_qpixmap(arr: np.ndarray) -> QPixmap:
    h, w, _ = arr.shape
    qimg = QImage(arr.data, w, h, w * 3, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())   # .copy() でバッファ参照を切る


def make_dot_icon(status: str, size: int = 12) -> QIcon:
    color = QColor(STATUS_COLORS.get(status, "#475569"))
    px = QPixmap(size, size)
    px.fill(Qt.GlobalColor.transparent)
    p = QPainter(px)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QBrush(color))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(0, 0, size, size)
    p.end()
    return QIcon(px)


# ──────────────────────────────────────────────────────────────────────
#  ドラッグ&ドロップ対応ファイルリスト
# ──────────────────────────────────────────────────────────────────────
class DropList(QListWidget):
    files_dropped = pyqtSignal(list)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DropOnly)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setIconSize(QSize(12, 12))
        self.setSpacing(1)

    def dragEnterEvent(self, e: QDragEnterEvent):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e: QDropEvent):
        paths = []
        for url in e.mimeData().urls():
            lf = url.toLocalFile()
            if os.path.isfile(lf) and Path(lf).suffix.lower() in SUPPORTED_EXTS:
                paths.append(lf)
            elif os.path.isdir(lf):
                for child in sorted(Path(lf).iterdir()):
                    if child.suffix.lower() in SUPPORTED_EXTS:
                        paths.append(str(child))
        if paths:
            self.files_dropped.emit(paths)


# ──────────────────────────────────────────────────────────────────────
#  スケーリング対応プレビュー QLabel
# ──────────────────────────────────────────────────────────────────────
class ImageLabel(QLabel):
    def __init__(self, placeholder: str = "", parent=None):
        super().__init__(parent)
        self._pixmap: Optional[QPixmap] = None
        self._placeholder = placeholder
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setStyleSheet("background:#1e1e35; border-radius:8px;")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMinimumSize(180, 120)
        self.setText(placeholder)

    def set_image(self, arr: Optional[np.ndarray]):
        if arr is None:
            self._pixmap = None
            super().setPixmap(QPixmap())
            self.setText(self._placeholder)
        else:
            self._pixmap = rgb_to_qpixmap(arr)
            self.setText("")
            self._refresh_scaled()

    def _refresh_scaled(self):
        if self._pixmap is None or self._pixmap.isNull():
            return
        scaled = self._pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        super().setPixmap(scaled)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._refresh_scaled()


# ──────────────────────────────────────────────────────────────────────
#  処理ワーカー (別スレッド)
# ──────────────────────────────────────────────────────────────────────
class ProcessWorker(QThread):
    # シグナル
    progress   = pyqtSignal(int, int)               # (done, total)
    item_done  = pyqtSignal(str, object, object, int)  # (path, orig_rgb, proc_rgb, n)
    item_error = pyqtSignal(str, str)               # (path, msg)
    finished   = pyqtSignal()

    def __init__(
        self,
        paths: List[str],
        mode: str,
        strength: int,
        confidence: float,
    ):
        super().__init__()
        self.paths      = paths
        self.mode       = mode          # "blur" | "mosaic" | "inpaint"
        self.strength   = strength
        self.confidence = confidence
        self._stop      = False

    def request_stop(self):
        self._stop = True

    # ── メイン ──────────────────────────────────────────────────────
    def run(self):
        try:
            from ultralytics import YOLO
            model = YOLO(MODEL_NAME)
        except Exception as exc:
            self.item_error.emit("", f"モデルの読み込みに失敗しました:\n{exc}")
            self.finished.emit()
            return

        total = len(self.paths)
        for idx, path in enumerate(self.paths):
            if self._stop:
                break
            self.progress.emit(idx, total)

            try:
                img_bgr = cv2.imread(path)
                if img_bgr is None:
                    raise ValueError("画像を読み込めません")

                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                h, w    = img_rgb.shape[:2]

                results = model(
                    img_rgb,
                    classes=[PERSON_CLS],
                    conf=self.confidence,
                    verbose=False,
                )
                r = results[0]

                mask = np.zeros((h, w), dtype=np.uint8)
                n_persons = 0

                # セグメンテーションマスク優先
                if r.masks is not None and len(r.masks):
                    n_persons = len(r.masks)
                    for m in r.masks.data.cpu().numpy():
                        m_r = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
                        mask = np.maximum(mask, (m_r > 0.5).astype(np.uint8))

                # マスクがなければバウンディングボックスで代用
                elif r.boxes is not None and len(r.boxes):
                    n_persons = len(r.boxes)
                    for box in r.boxes.xyxy.cpu().numpy():
                        x1, y1, x2, y2 = map(int, box)
                        mask[y1:y2, x1:x2] = 1

                if n_persons > 0:
                    if self.mode == "blur":
                        processed = self._apply_blur(img_rgb, mask)
                    elif self.mode == "mosaic":
                        processed = self._apply_mosaic(img_rgb, mask)
                    else:
                        processed = self._apply_inpaint(img_rgb, mask)
                else:
                    processed = img_rgb.copy()

                self.item_done.emit(path, img_rgb, processed, n_persons)

            except Exception as exc:
                self.item_error.emit(path, str(exc))

        self.progress.emit(total, total)
        self.finished.emit()

    # ── 処理メソッド ────────────────────────────────────────────────
    def _apply_blur(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """ガウシアンぼかし"""
        k = (self.strength // 2) * 2 + 1   # 奇数に揃える
        k = max(k, 11)
        blurred = cv2.GaussianBlur(img, (k, k), 0)
        m3 = mask[:, :, np.newaxis]
        return np.where(m3, blurred, img).astype(np.uint8)

    def _apply_mosaic(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """モザイク（ピクセレート）"""
        block = max(self.strength // 5, 4)
        h, w  = img.shape[:2]
        small  = cv2.resize(img, (max(w // block, 1), max(h // block, 1)),
                            interpolation=cv2.INTER_LINEAR)
        mosaic = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        m3 = mask[:, :, np.newaxis]
        return np.where(m3, mosaic, img).astype(np.uint8)

    def _apply_inpaint(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """インペイント（人物を背景で塗りつぶし）"""
        kernel  = np.ones((25, 25), np.uint8)
        dilated = cv2.dilate(mask, kernel, iterations=2)
        mask255 = (dilated * 255).astype(np.uint8)
        bgr     = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        result  = cv2.inpaint(bgr, mask255, 5, cv2.INPAINT_TELEA)
        return cv2.cvtColor(result, cv2.COLOR_BGR2RGB)


# ──────────────────────────────────────────────────────────────────────
#  メインウィンドウ
# ──────────────────────────────────────────────────────────────────────
class MainWindow(QMainWindow):

    APP_STYLE = """
        QMainWindow { background:#0f0f17; }

        /* ── 左パネル ── */
        #leftPanel {
            background:#16162a;
            border-right:1px solid #252540;
        }
        #appTitle  { font-size:20px; font-weight:700; color:#e2e8f0; }
        #appSub    { font-size:12px; color:#475569; margin-bottom:4px; }
        #secLabel  {
            font-size:10px; font-weight:700;
            color:#3b82f6; letter-spacing:.08em;
            margin-top:6px;
        }
        #hintLabel { font-size:11px; color:#334155; }
        #outLabel  { font-size:11px; color:#64748b; }

        /* ── ファイルリスト ── */
        QListWidget {
            background:#1a1a2e; border:1px solid #252540;
            border-radius:8px; color:#cbd5e1;
            font-size:12px; outline:none;
        }
        QListWidget::item { padding:5px 8px; border-radius:4px; }
        QListWidget::item:selected { background:#1d4ed8; color:#fff; }
        QListWidget::item:hover:!selected { background:#1e293b; }

        /* ── 右パネル / プレビュー ── */
        #rightPanel { background:#0f0f17; }
        #previewHdr {
            font-size:12px; font-weight:600;
            color:#475569; padding-bottom:2px;
        }
        #infoLabel  { font-size:13px; color:#64748b; }

        /* ── ボトムバー ── */
        #bottomBar  { background:#13131f; border-top:1px solid #252540; }
        #statusLabel{ font-size:12px; color:#64748b; }

        /* ── ボタン共通 ── */
        QPushButton {
            background:#1e293b; color:#cbd5e1;
            border:1px solid #334155;
            border-radius:8px; padding:7px 14px; font-size:13px;
        }
        QPushButton:hover   { background:#253449; }
        QPushButton:disabled{ color:#334155; border-color:#1a2332; }

        #runBtn {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #2563eb,stop:1 #7c3aed);
            color:#fff; border:none;
            font-size:15px; font-weight:700;
            border-radius:10px; min-width:140px;
        }
        #runBtn:hover {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #3b82f6,stop:1 #8b5cf6);
        }
        #runBtn:disabled { background:#1e293b; color:#334155; }

        #stopBtn  { color:#ef4444; border-color:#ef4444; }
        #stopBtn:hover { background:#2d1b1b; }

        #clearBtn { color:#f87171; border-color:#3d1515; }
        #clearBtn:hover { background:#2d1515; }

        /* ── コンボ・スライダー ── */
        QComboBox {
            background:#1e293b; color:#cbd5e1;
            border:1px solid #334155;
            border-radius:6px; padding:5px 10px; font-size:13px;
        }
        QComboBox::drop-down { border:none; width:22px; }
        QComboBox QAbstractItemView {
            background:#1e293b; color:#cbd5e1;
            selection-background-color:#1d4ed8;
            border:1px solid #334155;
        }

        QSlider::groove:horizontal {
            height:6px; background:#1e293b; border-radius:3px;
        }
        QSlider::handle:horizontal {
            width:16px; height:16px; background:#3b82f6;
            border-radius:8px; margin:-5px 0;
        }
        QSlider::sub-page:horizontal {
            background:#3b82f6; border-radius:3px;
        }
        QSlider:disabled::sub-page:horizontal { background:#1e293b; }
        QSlider:disabled::handle:horizontal   { background:#334155; }

        QProgressBar {
            background:#1e293b; border-radius:4px; border:none;
        }
        QProgressBar::chunk {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #2563eb,stop:1 #7c3aed);
            border-radius:4px;
        }

        QLabel { color:#94a3b8; }
    """

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Human Remover")
        self.setMinimumSize(1000, 660)
        self.resize(1260, 780)

        self._file_data: Dict[str, dict] = {}
        self._worker: Optional[ProcessWorker] = None
        self._output_dir: Optional[str] = None

        self._build_ui()
        self.setStyleSheet(self.APP_STYLE)

    # ── UI 構築 ──────────────────────────────────────────────────────
    def _build_ui(self):
        root_w = QWidget()
        self.setCentralWidget(root_w)
        root = QHBoxLayout(root_w)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_left())
        root.addWidget(self._build_right(), stretch=1)

    # ── 左パネル ─────────────────────────────────────────────────────
    def _build_left(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("leftPanel")
        panel.setFixedWidth(290)
        lv = QVBoxLayout(panel)
        lv.setContentsMargins(14, 16, 14, 14)
        lv.setSpacing(8)

        # タイトル
        lv.addWidget(self._lbl("Human Remover", "appTitle"))
        lv.addWidget(self._lbl("写真内の人物を自動検出・処理", "appSub"))

        # ── ファイルリスト ──
        lv.addWidget(self._sec("📁  処理対象ファイル"))
        self.file_list = DropList()
        self.file_list.files_dropped.connect(self._add_files)
        self.file_list.currentRowChanged.connect(self._on_select)
        lv.addWidget(self.file_list, stretch=1)

        hint = self._lbl("ファイル/フォルダをここにドラッグ&ドロップ", "hintLabel")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setWordWrap(True)
        lv.addWidget(hint)

        fb = QHBoxLayout()
        fb.setSpacing(6)
        self.btn_add   = QPushButton("ファイルを追加")
        self.btn_clear = QPushButton("クリア")
        self.btn_clear.setObjectName("clearBtn")
        self.btn_add.clicked.connect(self._pick_files)
        self.btn_clear.clicked.connect(self._clear_list)
        fb.addWidget(self.btn_add)
        fb.addWidget(self.btn_clear)
        lv.addLayout(fb)

        # ── 処理設定 ──
        lv.addWidget(self._sec("⚙   処理設定"))

        # モード
        ml = QHBoxLayout()
        ml.addWidget(QLabel("処理モード:"))
        self.combo_mode = QComboBox()
        self.combo_mode.addItems(["ぼかし (Gaussian)", "モザイク", "消去 (Inpaint)"])
        self.combo_mode.currentIndexChanged.connect(self._on_mode_change)
        ml.addWidget(self.combo_mode, stretch=1)
        lv.addLayout(ml)

        # 強度
        self.lbl_strength = QLabel("ぼかし強度: 51")
        lv.addWidget(self.lbl_strength)
        self.slider_strength = QSlider(Qt.Orientation.Horizontal)
        self.slider_strength.setRange(11, 151)
        self.slider_strength.setValue(51)
        self.slider_strength.setSingleStep(2)
        self.slider_strength.valueChanged.connect(self._on_strength_change)
        lv.addWidget(self.slider_strength)

        # 信頼度
        lv.addWidget(QLabel("検出信頼度 (高いほど厳密):"))
        cr = QHBoxLayout()
        self.slider_conf = QSlider(Qt.Orientation.Horizontal)
        self.slider_conf.setRange(10, 90)
        self.slider_conf.setValue(40)
        self.slider_conf.valueChanged.connect(
            lambda v: self.lbl_conf.setText(f"{v/100:.2f}")
        )
        self.lbl_conf = QLabel("0.40")
        self.lbl_conf.setFixedWidth(32)
        cr.addWidget(self.slider_conf, stretch=1)
        cr.addWidget(self.lbl_conf)
        lv.addLayout(cr)

        # ── 出力先 ──
        lv.addWidget(self._sec("💾  出力先"))
        or_ = QHBoxLayout()
        self.lbl_out = self._lbl("(各画像と同フォルダの output/)", "outLabel")
        self.lbl_out.setWordWrap(True)
        btn_out = QPushButton("変更")
        btn_out.setFixedWidth(46)
        btn_out.clicked.connect(self._pick_outdir)
        or_.addWidget(self.lbl_out, stretch=1)
        or_.addWidget(btn_out)
        lv.addLayout(or_)

        return panel

    # ── 右パネル ─────────────────────────────────────────────────────
    def _build_right(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("rightPanel")
        rv = QVBoxLayout(panel)
        rv.setContentsMargins(16, 16, 16, 0)
        rv.setSpacing(8)

        # プレビューヘッダ
        hdr = QHBoxLayout()
        for txt in ("処理前", "処理後"):
            l = self._lbl(txt, "previewHdr")
            l.setAlignment(Qt.AlignmentFlag.AlignCenter)
            hdr.addWidget(l, stretch=1)
        rv.addLayout(hdr)

        # Before / After 画像
        pr = QHBoxLayout()
        pr.setSpacing(8)
        self.img_before = ImageLabel("処理前プレビュー")
        self.img_after  = ImageLabel("処理後プレビュー")
        pr.addWidget(self.img_before, stretch=1)
        pr.addWidget(self.img_after,  stretch=1)
        rv.addLayout(pr, stretch=1)

        # 情報ラベル
        self.lbl_info = self._lbl("ファイルを選択するとプレビューが表示されます", "infoLabel")
        self.lbl_info.setAlignment(Qt.AlignmentFlag.AlignCenter)
        rv.addWidget(self.lbl_info)

        # ── ボトムバー ──
        bot = QWidget()
        bot.setObjectName("bottomBar")
        bv = QVBoxLayout(bot)
        bv.setContentsMargins(0, 10, 0, 14)
        bv.setSpacing(6)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        self.progress.setFixedHeight(8)
        bv.addWidget(self.progress)

        br = QHBoxLayout()
        br.setSpacing(10)
        self.lbl_status = self._lbl("準備完了", "statusLabel")
        br.addWidget(self.lbl_status, stretch=1)

        self.btn_stop = QPushButton("■ 停止")
        self.btn_stop.setObjectName("stopBtn")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self._stop_processing)

        self.btn_run = QPushButton("▶  処理開始")
        self.btn_run.setObjectName("runBtn")
        self.btn_run.setFixedHeight(44)
        self.btn_run.clicked.connect(self._start_processing)

        br.addWidget(self.btn_stop)
        br.addWidget(self.btn_run)
        bv.addLayout(br)

        rv.addWidget(bot)
        return panel

    # ── ヘルパー ──────────────────────────────────────────────────────
    @staticmethod
    def _lbl(text: str, obj: str = "") -> QLabel:
        l = QLabel(text)
        if obj:
            l.setObjectName(obj)
        return l

    @staticmethod
    def _sec(text: str) -> QLabel:
        l = QLabel(text.upper())
        l.setObjectName("secLabel")
        return l

    # ── ファイル管理 ─────────────────────────────────────────────────
    def _add_files(self, paths: List[str]):
        existing = set(self._file_data)
        for p in paths:
            if p in existing:
                continue
            self._file_data[p] = {
                "status":    STATUS_WAIT,
                "orig":      None,
                "processed": None,
                "n":         0,
            }
            item = QListWidgetItem(make_dot_icon(STATUS_WAIT), Path(p).name)
            item.setData(Qt.ItemDataRole.UserRole, p)
            item.setToolTip(p)
            self.file_list.addItem(item)

        total = len(self._file_data)
        self.lbl_status.setText(f"{total} ファイル登録済み")

    def _pick_files(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "画像を選択", "",
            "画像 (*.jpg *.jpeg *.png *.bmp *.webp *.tiff *.tif)"
        )
        if paths:
            self._add_files(paths)

    def _clear_list(self):
        if self._worker and self._worker.isRunning():
            QMessageBox.warning(self, "処理中", "処理中はクリアできません。")
            return
        self.file_list.clear()
        self._file_data.clear()
        self.img_before.set_image(None)
        self.img_after.set_image(None)
        self.lbl_info.setText("ファイルを選択するとプレビューが表示されます")
        self.lbl_status.setText("準備完了")
        self.progress.setValue(0)

    def _pick_outdir(self):
        d = QFileDialog.getExistingDirectory(self, "出力フォルダを選択", "")
        if d:
            self._output_dir = d
            self.lbl_out.setText(d)

    def _find_item_by_path(self, path: str) -> Optional[QListWidgetItem]:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            if item.data(Qt.ItemDataRole.UserRole) == path:
                return item
        return None

    # ── プレビュー更新 ────────────────────────────────────────────────
    def _on_select(self, row: int):
        item = self.file_list.item(row)
        if item is None:
            return
        path = item.data(Qt.ItemDataRole.UserRole)
        data = self._file_data.get(path)
        if data is None:
            return
        name = Path(path).name
        st   = data["status"]

        if st == STATUS_WAIT:
            self.img_before.set_image(None)
            self.img_after.set_image(None)
            self.lbl_info.setText(f"{name}  ─  未処理")

        elif st == STATUS_OK:
            self.img_before.set_image(data["orig"])
            self.img_after.set_image(data["processed"])
            n = data["n"]
            self.lbl_info.setText(f"{name}  ─  {n} 人を検出・処理")

        elif st == STATUS_SKIP:
            self.img_before.set_image(data["orig"])
            self.img_after.set_image(data["orig"])
            self.lbl_info.setText(f"{name}  ─  人物なし（変更なし）")

        elif st == STATUS_ERROR:
            self.img_before.set_image(None)
            self.img_after.set_image(None)
            self.lbl_info.setText(f"{name}  ─  ❌ エラーが発生しました")

    # ── スライダー ────────────────────────────────────────────────────
    @staticmethod
    def _strength_text(idx: int, v: int) -> str:
        if idx == 0:
            return f"ぼかし強度: {(v // 2) * 2 + 1}"
        if idx == 1:
            return f"ブロックサイズ: {max(v // 5, 4)}px"
        return "消去モード (強度設定なし)"

    def _on_strength_change(self, v: int):
        idx = self.combo_mode.currentIndex()
        if idx in (0, 1):
            self.lbl_strength.setText(self._strength_text(idx, v))

    def _on_mode_change(self, idx: int):
        v = self.slider_strength.value()
        self.lbl_strength.setText(self._strength_text(idx, v))
        self.slider_strength.setEnabled(idx != 2)

    # ── 処理 ─────────────────────────────────────────────────────────
    def _get_mode(self) -> str:
        return ["blur", "mosaic", "inpaint"][self.combo_mode.currentIndex()]

    def _start_processing(self):
        wait_paths = [p for p, d in self._file_data.items()
                      if d["status"] == STATUS_WAIT]

        if not wait_paths:
            if not self._file_data:
                QMessageBox.information(self, "ファイルなし",
                    "処理するファイルを追加してください。")
                return
            reply = QMessageBox.question(
                self, "再処理確認",
                "未処理のファイルがありません。\n全ファイルを再処理しますか？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
            # 全てをリセット
            for d in self._file_data.values():
                d["status"] = STATUS_WAIT
            for i in range(self.file_list.count()):
                item = self.file_list.item(i)
                item.setIcon(make_dot_icon(STATUS_WAIT))
                item.setText(Path(item.data(Qt.ItemDataRole.UserRole)).name)
            wait_paths = list(self._file_data.keys())

        self.btn_run.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.progress.setValue(0)

        v        = self.slider_strength.value()
        strength = (v // 2) * 2 + 1   # 奇数
        conf     = self.slider_conf.value() / 100

        self._worker = ProcessWorker(wait_paths, self._get_mode(), strength, conf)
        self._worker.progress.connect(self._on_progress)
        self._worker.item_done.connect(self._on_item_done)
        self._worker.item_error.connect(self._on_item_error)
        self._worker.finished.connect(self._on_finished)
        self._worker.start()

        self.lbl_status.setText(f"処理中…  0 / {len(wait_paths)}")

    def _stop_processing(self):
        if self._worker:
            self._worker.request_stop()
        self.lbl_status.setText("停止リクエスト中…")
        self.btn_stop.setEnabled(False)

    # ── ワーカーシグナルハンドラ ─────────────────────────────────────
    def _on_progress(self, done: int, total: int):
        pct = int(done / total * 100) if total else 0
        self.progress.setValue(pct)
        self.lbl_status.setText(f"処理中…  {done} / {total}")

    def _on_item_done(self, path: str, orig: np.ndarray,
                      processed: np.ndarray, n: int):
        data = self._file_data.get(path)
        if data is None:
            return
        data["orig"]      = orig
        data["processed"] = processed
        data["n"]         = n
        data["status"]    = STATUS_OK if n > 0 else STATUS_SKIP

        # リストアイテム更新
        item = self._find_item_by_path(path)
        if item:
            item.setIcon(make_dot_icon(data["status"]))
            label = Path(path).name
            if n > 0:
                label += f"  ({n}人)"
            item.setText(label)

        # 保存
        self._save(path, processed)

        # 選択中ならプレビュー即反映
        cur = self.file_list.currentItem()
        if cur and cur.data(Qt.ItemDataRole.UserRole) == path:
            self._on_select(self.file_list.currentRow())

    def _on_item_error(self, path: str, msg: str):
        if not path:
            QMessageBox.critical(self, "致命的なエラー", msg)
            self._on_finished()
            return
        data = self._file_data.get(path)
        if data:
            data["status"] = STATUS_ERROR
        item = self._find_item_by_path(path)
        if item:
            item.setIcon(make_dot_icon(STATUS_ERROR))
            item.setText(f"❌  {Path(path).name}")

    def _on_finished(self):
        self.btn_run.setEnabled(True)
        self.btn_stop.setEnabled(False)
        done  = sum(1 for d in self._file_data.values()
                    if d["status"] in (STATUS_OK, STATUS_SKIP))
        total = len(self._file_data)
        self.lbl_status.setText(f"完了  ─  {done} / {total} ファイル処理済み")
        self.progress.setValue(100)

    # ── ファイル保存 ─────────────────────────────────────────────────
    def _save(self, src: str, rgb: np.ndarray):
        p = Path(src)
        if self._output_dir:
            out_dir = Path(self._output_dir)
        else:
            out_dir = p.parent / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / p.name
        if out_path.exists():
            out_path = out_dir / (p.stem + "_processed" + p.suffix)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        cv2.imwrite(str(out_path), bgr)


# ──────────────────────────────────────────────────────────────────────
#  エントリポイント
# ──────────────────────────────────────────────────────────────────────
def check_deps() -> List[str]:
    missing = []
    try:
        import cv2          # noqa: F401
    except ImportError:
        missing.append("opencv-python")
    try:
        import ultralytics  # noqa: F401
    except ImportError:
        missing.append("ultralytics")
    return missing


def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    missing = check_deps()
    if missing:
        cmd = "pip install " + " ".join(missing)
        msg = QMessageBox()
        msg.setWindowTitle("依存ライブラリが不足しています")
        msg.setText(
            "以下のライブラリが必要です:\n\n"
            + "\n".join(f"  • {m}" for m in missing)
            + f"\n\nターミナルで以下を実行してください:\n\n  {cmd}"
        )
        msg.setIcon(QMessageBox.Icon.Critical)
        msg.exec()
        sys.exit(1)

    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

```

### `programs/Human_Remover/requirements.txt`

```text
PyQt6>=6.4.0
opencv-python>=4.8.0
ultralytics>=8.0.0
numpy>=1.24.0

```

### 10.4 インフラ・デプロイ設定

### `deploy_env/docker-compose.yml`

```yaml
networks:
  app_net:
    driver: overlay   # Swarm のオーバーレイネットワーク（ノード間通信）
    attachable: true  # デバッグ時に docker run でアタッチ可能にする

configs:
  prometheus_config:
    file: ./prometheus/prometheus.yml

services:
  python:
    image: ghcr.io/senarmaporg/iki_project_2026_python:latest
    # workers: 複数レプリカ構成なので 1コンテナあたり 4 に削減
    # (イベント時: 4レプリカ × 4workers = 16並列、平常時: 2 × 4 = 8並列)
    command: gunicorn -w 4 -b 0.0.0.0:8000 app:app
    networks:
      - app_net
    deploy:
      replicas: 2           # 平常時: manager/worker に1つずつ
      placement:
        preferences:
          - spread: node.id # ノードに均等分散
      update_config:
        parallelism: 1      # ローリングアップデート: 1台ずつ
        delay: 10s
        order: start-first  # 新コンテナを先に起動してからold削除 → ゼロダウンタイム
        failure_action: rollback
      rollback_config:
        parallelism: 1
        order: start-first
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3

  # nginx は Cloudflare Pages 移行に伴い撤去済み。
  # 静的配信は Pages、/api・/3d → python、/redirect → counter は
  # cloudflared の Public Hostname（パスルーティング）が直接振り分ける。
  # 詳細: docs/cloudflare_pages_migration.md

  db:
    image: mariadb:11
    environment:
      MARIADB_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MARIADB_DATABASE: ${DB_NAME}
      MARIADB_USER: ${DB_USER}
      MARIADB_PASSWORD: ${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql  # ボリュームがマネージャーにあるため固定
    networks:
      - app_net
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 15
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure

  counter:
    image: ghcr.io/senarmaporg/iki_project_2026_counter:latest
    environment:
      SECRET_KEY_BASE: ${SECRET_KEY_BASE}
      DB_HOST: db
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASSWORD: ${DB_PASSWORD}
    networks:
      - app_net
    deploy:
      replicas: 2
      placement:
        preferences:
          - spread: node.id
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
        failure_action: rollback
      restart_policy:
        condition: on-failure
        # Swarm は depends_on を無視するため delay で DB 起動を待つ
        delay: 15s
        max_attempts: 5

  prometheus:
    image: prom/prometheus:latest
    user: root
    configs:
      - source: prometheus_config
        target: /etc/prometheus/prometheus.yml
    volumes:
      - prometheus_data:/prometheus
      # Swarm サービスディスカバリのために docker.sock をマウント
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - app_net
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure

  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_USER: ${GF_SECURITY_ADMIN_USER}
      GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD}
    volumes:
      - grafana_data:/var/lib/grafana
    networks:
      - app_net
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager
      restart_policy:
        condition: on-failure

  cadvisor:
    image: gcr.io/cadvisor/cadvisor:latest
    command:
      # Dockerコンテナ以外のcgroup（system.slice等のsystemdスライス）を
      # 「コンテナ」として収集しない — Grafanaのゴミコンテナ対策
      - --docker_only=true
      # 収集間隔を既定1秒→15秒（Prometheusのscrape間隔と同じ）に広げてCPU負荷を削減
      - --housekeeping_interval=15s
    privileged: true
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:ro
      - /sys:/sys:ro
      - /var/lib/docker:/var/lib/docker:ro
      - /dev/disk:/dev/disk:ro
    networks:
      - app_net
    deploy:
      mode: global          # 全ノードで1つずつ起動（ノード追加時に自動展開）
      restart_policy:
        condition: on-failure

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=${TUNNEL_TOKEN}
    networks:
      - app_net
    deploy:
      replicas: 1
      placement:
        constraints:
          - node.role == manager  # トンネルの入口はマネージャー1台
      restart_policy:
        condition: on-failure

volumes:
  db_data:
  grafana_data:
  prometheus_data:

```

### `deploy_env/pages/build.sh`

```bash
#!/bin/sh
# Cloudflare Pages のビルドコマンドとして実行するスクリプト。
#   Build command:          sh deploy_env/pages/build.sh
#   Build output directory: programs/html
#   環境変数:               GOOGLE_MAPS_API_KEY（Production / Preview 両方に設定）
#
# 旧 deploy_env/nginx/docker-entrypoint.sh が行っていた config.js 生成の移植。
set -e

if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    echo "ERROR: GOOGLE_MAPS_API_KEY is not set." >&2
    exit 1
fi

CONFIG_FILE="programs/html/navi/script/config.js"

mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOF
const CONFIG = {
  GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}"
};
EOF

echo "[pages] config.js generated."

```

### `deploy_env/python/Dockerfile`

```dockerfile
FROM python:3.13-slim-trixie

ENV TERM=xterm-256color

RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc && \
    echo "alias grep='grep --color=auto'" >> /root/.bashrc && \
    echo "export PS1='\[\e[1;32m\][PRODUCTION] \u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '" >> /root/.bashrc

RUN apt-get update && apt-get install -y --no-install-recommends \
    vim \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project/enviroments

COPY deploy_env/python/requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

COPY . /project/

RUN find /project -type d -exec chmod 755 {} \; && \
    find /project -type f -exec chmod 644 {} \;

WORKDIR /project/programs/3D_Graph
```

### `deploy_env/python/requirements.txt`

```text
pandas
networkx
Flask
plotly
gunicorn
pyvis
```

### `deploy_env/nginx/Dockerfile`

```dockerfile
FROM nginx:stable-alpine

WORKDIR /app

COPY . /project/

RUN find /project -type d -exec chmod 755 {} \; && \
    find /project -type f -exec chmod 644 {} \;

COPY deploy_env/nginx/errors/ /etc/nginx/errors/

COPY deploy_env/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy_env/nginx/docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
```

### `deploy_env/nginx/nginx.conf`

```nginx
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    server {
        listen 80;
        server_name _;

        error_page 400 /errors/400.html;
        error_page 401 /errors/401.html;
        error_page 403 /errors/403.html;
        error_page 404 /errors/404.html;
        error_page 500 /errors/500.html;
        error_page 502 /errors/502.html;
        error_page 503 /errors/503.html;
        error_page 504 /errors/504.html;

        location ^~ /errors/ {
            root /etc/nginx;
            internal;
        }

        location /3d/ {
            proxy_pass         http://python:8000/3d/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $http_x_forwarded_proto;
        }

        location /api/ {
            proxy_pass         http://python:8000/api/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $http_x_forwarded_proto;
        }

        location /redirect/ {
            proxy_pass         http://counter:3000/redirect/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto https;
        }

        location / {
            root      /project/programs/html;
            try_files $uri $uri/ =404;
        }
    }
}

```

### `deploy_env/nginx/docker-entrypoint.sh`

```bash
#!/bin/sh
set -e

mkdir -p /project/programs/html/navi/script/

CONFIG_FILE="/project/programs/html/navi/script/config.js"

# ファイルが既に存在する場合はスキップする
if [ ! -f "$CONFIG_FILE" ]; then
    echo "const CONFIG = {" > "$CONFIG_FILE"
    echo "  GOOGLE_MAPS_API_KEY: \"${GOOGLE_MAPS_API_KEY}\"" >> "$CONFIG_FILE"
    echo "};" >> "$CONFIG_FILE"
    echo "[nginx] config.js generated."
else
    echo "[nginx] config.js already exists. Skipping generation."
fi

exec nginx -g "daemon off;"
```

### `deploy_env/prometheus/prometheus.yml`

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  # cadvisor: Swarm の全ノードで mode:global で動いているため
  # dockerswarm_sd_configs でタスク単位に動的ディスカバリする
  - job_name: cadvisor
    dockerswarm_sd_configs:
      - host: unix:///var/run/docker.sock
        role: tasks
    relabel_configs:
      # サービス名に "cadvisor" を含むタスクだけ対象にする
      - source_labels: [__meta_dockerswarm_service_name]
        regex: '.*cadvisor.*'
        action: keep
      # 起動済みタスクのみ
      - source_labels: [__meta_dockerswarm_task_desired_state]
        regex: 'running'
        action: keep
      # アドレスのポートを cadvisor の 8080 に上書き
      - source_labels: [__address__]
        regex: '([^:]+)(?::\d+)?'
        replacement: '$1:8080'
        target_label: __address__
      # Grafana で「どのノードか」判別できるようにホスト名をラベルに
      - source_labels: [__meta_dockerswarm_node_hostname]
        target_label: instance
    metric_relabel_configs:
      # Swarmサービスに属さないコンテナの系列を捨てる。
      # systemdスライス等は cadvisor 側の --docker_only で除外済みなので、
      # ここでは単発 docker run などの非Swarmコンテナを除外する。
      # id="/" のノード全体合計はサービスラベルを持たないがidが /docker/ で
      # 始まらないため残る。
      - source_labels: [id, container_label_com_docker_swarm_service_name]
        regex: '/docker/.+;'
        action: drop
      # ダッシュボードで使いやすい短い service ラベルを付与（例: iku_python）。
      # コンテナ名（タスクIDつき）でグラフを作るとローリングアップデートの
      # たびに系列が増えるため、集計は service ラベルで行うこと。
      - source_labels: [container_label_com_docker_swarm_service_name]
        regex: '(.+)'
        target_label: service

```

### `deploy_env/sample.env`

```text
TUNNEL_TOKEN=
DB_ROOT_PASSWORD=
DB_NAME=
DB_USER=
DB_PASSWORD=
SECRET_KEY_BASE=
GF_SECURITY_ADMIN_USER=
GF_SECURITY_ADMIN_PASSWORD=
# GOOGLE_MAPS_API_KEY はサーバーでは不要になった（Cloudflare Pages の環境変数に設定する）

```

#### Kubernetes構成（不採用・参考用）

### `deploy_env/k8s/01-localnet.sh`

```bash
#!/usr/bin/env bash
#
# 01-localnet.sh
#   ConoHa の「ローカルネットワーク」用 NIC (eth1 相当) に静的IPを設定する。
#   両ノードでそれぞれ実行する。PRIV_IP / PREFIX だけ各ノードに合わせて書き換える。
#
#   事前に ConoHa コントロールパネルで:
#     1) ローカルネットワークを作成 (例: 192.168.0.0/24)
#     2) サーバーを停止 → ローカルネットワークにアタッチ → サーバー起動
#   ※ ConoHa のローカルネットワークは x.x.x.11〜x.x.x.254 が利用可能
#     (x.x.x.1〜10 は予約)。DHCP は無いので静的設定が必須。
#
set -euo pipefail

# ===== ここを各ノードで設定 =====
PRIV_IP="192.168.0.11"   # control-plane(node1)=.11 / worker(node2)=.12 など
PREFIX="24"
# ================================

if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください (sudo)"; exit 1; fi

# 既定ルートを持つ(=公開側)インターフェイスを特定
PUB_IF="$(ip route show default | awk '{print $5; exit}')"
echo "公開側インターフェイス: ${PUB_IF}"

# 公開側でない最初の物理 ethernet を「ローカルネットワーク側」とみなす
PRIV_IF=""
for i in $(ls /sys/class/net); do
  case "$i" in lo|"$PUB_IF") continue ;; esac
  if [[ "$i" =~ ^(eth|ens|enp) ]]; then PRIV_IF="$i"; break; fi
done

if [ -z "$PRIV_IF" ]; then
  echo "ローカルネットワーク用 NIC が見つかりません。ConoHa 側でアタッチ済みか確認してください。"
  echo "現在の NIC 一覧:"; ip -br link
  exit 1
fi
echo "ローカルネットワーク側インターフェイス: ${PRIV_IF}"

cat > /etc/netplan/11-localnetwork.yaml <<EOF
network:
  version: 2
  ethernets:
    ${PRIV_IF}:
      dhcp4: false
      dhcp6: false
      addresses: [${PRIV_IP}/${PREFIX}]
EOF
chmod 600 /etc/netplan/11-localnetwork.yaml

netplan apply
sleep 2
echo "----- 設定結果 -----"
ip -4 addr show "${PRIV_IF}" | sed -n 's/^[[:space:]]*\(inet .*\)/  \1/p'
echo "完了。相手ノードと ping が通るか確認してください: ping -c3 <相手のローカルIP>"

```

### `deploy_env/k8s/02-k8s-common.sh`

```bash
#!/usr/bin/env bash
#
# 02-k8s-common.sh
#   Kubernetes ノード共通のセットアップ。
#   control-plane / worker の両方で、そのまま実行する(編集不要)。
#   server-world (Ubuntu 24.04 / Kubernetes) の手順に準拠 + containerd 利用。
#
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください (sudo)"; exit 1; fi

K8S_MINOR="v1.36"   # 2026年時点の安定版。揃えたい場合は両ノードで同じ値に。

echo "=== 1. swap 無効化 ==="
swapoff -a || true
sed -i.bak -E '/\sswap\s/ s/^/#/' /etc/fstab || true

echo "=== 2. カーネルモジュール (overlay, br_netfilter) ==="
cat > /etc/modules-load.d/k8s.conf <<EOF
overlay
br_netfilter
EOF
modprobe overlay
modprobe br_netfilter

echo "=== 3. sysctl (ブリッジ/フォワーディング) ==="
cat > /etc/sysctl.d/k8s.conf <<EOF
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system >/dev/null

echo "=== 4. containerd インストール & SystemdCgroup 有効化 ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y containerd apt-transport-https ca-certificates curl gpg
mkdir -p /etc/containerd
containerd config default | tee /etc/containerd/config.toml >/dev/null
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl restart containerd
systemctl enable containerd

echo "=== 5. Kubernetes リポジトリ追加 (${K8S_MINOR}) ==="
mkdir -p /etc/apt/keyrings
curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
  | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /" \
  > /etc/apt/sources.list.d/kubernetes.list

echo "=== 6. kubelet / kubeadm / kubectl インストール ==="
apt-get update
apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl
systemctl enable kubelet

echo "完了。次は control-plane で 03-init-master.sh、worker で 04-join-worker.sh を実行してください。"

```

### `deploy_env/k8s/03-init-master.sh`

```bash
#!/usr/bin/env bash
#
# 03-init-master.sh
#   control-plane(node1) のみで実行。
#   - kubelet がローカルネットワークIPを名乗るよう --node-ip を固定
#   - kubeadm init (API Server はローカルIPで待ち受け / 証明書には公開IPも追加)
#   - Flannel CNI を導入し、VXLAN をローカルネットワーク(eth1)に固定
#   - worker 用の join コマンドを表示
#
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください (sudo)"; exit 1; fi

POD_CIDR="10.244.0.0/16"   # Flannel 既定。変更不要。

# 公開側 / ローカル側インターフェイスとIPを特定
PUB_IF="$(ip route show default | awk '{print $5; exit}')"
PRIV_IF=""
for i in $(ls /sys/class/net); do
  case "$i" in lo|"$PUB_IF") continue ;; esac
  if [[ "$i" =~ ^(eth|ens|enp) ]]; then PRIV_IF="$i"; break; fi
done
[ -n "$PRIV_IF" ] || { echo "ローカルNICが見つかりません。01-localnet.sh を先に実行してください"; exit 1; }

PRIV_IP="$(ip -4 -o addr show "$PRIV_IF" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
PUB_IP="$(ip -4 -o addr show "$PUB_IF" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[ -n "$PRIV_IP" ] || { echo "ローカルIPが未設定です。01-localnet.sh を先に実行してください"; exit 1; }
echo "ローカルIP(${PRIV_IF})=${PRIV_IP} / 公開IP(${PUB_IF})=${PUB_IP}"

echo "=== kubelet の node-ip をローカルIPに固定 ==="
echo "KUBELET_EXTRA_ARGS=--node-ip=${PRIV_IP}" > /etc/default/kubelet
systemctl daemon-reload || true

echo "=== kubeadm init ==="
kubeadm init \
  --apiserver-advertise-address="${PRIV_IP}" \
  --apiserver-cert-extra-sans="${PUB_IP}" \
  --pod-network-cidr="${POD_CIDR}"

echo "=== kubeconfig 配置 (root 用) ==="
mkdir -p "$HOME/.kube"
cp -f /etc/kubernetes/admin.conf "$HOME/.kube/config"
chown "$(id -u):$(id -g)" "$HOME/.kube/config"
export KUBECONFIG="$HOME/.kube/config"

# sudo を呼んだ実ユーザー側にも配置(任意)
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  U_HOME="$(eval echo "~${SUDO_USER}")"
  mkdir -p "${U_HOME}/.kube"
  cp -f /etc/kubernetes/admin.conf "${U_HOME}/.kube/config"
  chown -R "${SUDO_USER}:${SUDO_USER}" "${U_HOME}/.kube"
fi

echo "=== Flannel CNI 導入 ==="
curl -fsSL -o /tmp/kube-flannel.yml \
  https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
kubectl apply -f /tmp/kube-flannel.yml
# VXLAN をローカルネットワーク側 NIC に固定
kubectl -n kube-flannel patch ds kube-flannel-ds --type=json \
  -p="[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--iface=${PRIV_IF}\"}]"

echo
echo "=================================================================="
echo " worker(node2) で実行する join コマンド:"
echo "   ※ 先に node2 で /etc/default/kubelet に node-ip を設定すること"
echo "------------------------------------------------------------------"
kubeadm token create --print-join-command
echo "=================================================================="
echo
echo "確認: kubectl get nodes  /  kubectl get pods -A"

```

### `deploy_env/k8s/04-join-worker.sh`

```bash
#!/usr/bin/env bash
#
# 04-join-worker.sh
#   worker(node2) のみで実行。
#   kubelet の node-ip をローカルIPに固定してから、03 が出力した join コマンドを実行する。
#
#   使い方:
#     sudo ./04-join-worker.sh 'kubeadm join 192.168.0.11:6443 --token xxxx \
#         --discovery-token-ca-cert-hash sha256:yyyy'
#   (03-init-master.sh が表示した join コマンドを丸ごと ' ' で囲んで渡す)
#
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "root で実行してください (sudo)"; exit 1; fi

JOIN_CMD="${1:-}"
if [ -z "$JOIN_CMD" ]; then
  echo "引数に join コマンドを渡してください。例:"
  echo "  sudo $0 'kubeadm join 192.168.0.11:6443 --token ... --discovery-token-ca-cert-hash sha256:...'"
  exit 1
fi

# ローカル側 NIC / IP を特定
PUB_IF="$(ip route show default | awk '{print $5; exit}')"
PRIV_IF=""
for i in $(ls /sys/class/net); do
  case "$i" in lo|"$PUB_IF") continue ;; esac
  if [[ "$i" =~ ^(eth|ens|enp) ]]; then PRIV_IF="$i"; break; fi
done
[ -n "$PRIV_IF" ] || { echo "ローカルNICが見つかりません。01-localnet.sh を先に実行してください"; exit 1; }
PRIV_IP="$(ip -4 -o addr show "$PRIV_IF" | awk '{print $4}' | cut -d/ -f1 | head -n1)"
[ -n "$PRIV_IP" ] || { echo "ローカルIPが未設定です。01-localnet.sh を先に実行してください"; exit 1; }
echo "ローカルIP(${PRIV_IF})=${PRIV_IP}"

echo "=== kubelet の node-ip をローカルIPに固定 ==="
echo "KUBELET_EXTRA_ARGS=--node-ip=${PRIV_IP}" > /etc/default/kubelet
systemctl daemon-reload || true

echo "=== クラスタに参加 ==="
eval "${JOIN_CMD}"

echo "完了。control-plane 側で kubectl get nodes を実行し Ready を確認してください。"

```

### `deploy_env/k8s/add-worker.sh`

```bash
#!/bin/bash
# masterノードで実行する
# 新しいworkerノードに渡すjoinコマンドを生成する
set -e

echo "【新しいVPSで以下を順番に実行してください】"
echo ""
echo "# 1. ノードのセットアップ（所要時間: 約3分）"
echo "bash setup-node.sh"
echo ""
echo "# 2. クラスターに参加（以下のコマンドをコピペ）"
kubeadm token create --print-join-command --ttl 1h
echo ""
echo "# 3. 参加確認（masterで）"
echo "kubectl get nodes"

```

### `deploy_env/k8s/deploy.sh`

```bash
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> [1/4] Namespace を作成します..."
kubectl apply -f namespace.yaml

echo "==> [2/4] Secrets を適用します..."
if [ ! -f "secrets.yaml" ]; then
    echo "ERROR: secrets.yaml が見つかりません。"
    echo "  secrets.yaml.template をコピーして値を入力してください:"
    echo "  cp secrets.yaml.template secrets.yaml"
    echo "  # secrets.yaml を編集して各値を入力（平文でOK）"
    exit 1
fi
kubectl apply -f secrets.yaml

echo "==> [3/4] K8s マニフェストを適用します..."
kubectl apply -k .

echo "==> [4/4] デプロイ状況を確認します..."
kubectl rollout status deployment/python      -n iki-project
kubectl rollout status deployment/nginx       -n iki-project
kubectl rollout status deployment/counter     -n iki-project
kubectl rollout status statefulset/db         -n iki-project
kubectl rollout status deployment/cloudflared -n iki-project
kubectl rollout status deployment/prometheus  -n iki-project
kubectl rollout status deployment/grafana     -n iki-project

echo ""
echo "=================================================="
echo "デプロイ完了！"
echo ""
echo "Pod 一覧:"
kubectl get pods -n iki-project
echo "=================================================="

```

### `deploy_env/k8s/setup-master.sh`

```bash
#!/bin/bash
# masterノードのみで実行するスクリプト
# setup-node.sh を実行した後に実行すること
set -e

PRIVATE_IP="${1:-}"

if [ -z "$PRIVATE_IP" ]; then
  echo "使い方: bash setup-master.sh <追加ネットワークのIP>"
  echo "  例:  bash setup-master.sh 10.10.10.208"
  echo ""
  echo "IPアドレスは「ip a」で eth1 のアドレスを確認してください"
  exit 1
fi

echo "==> [1/4] K8sクラスターを初期化します (API endpoint: ${PRIVATE_IP})..."
sudo kubeadm init \
  --apiserver-advertise-address="${PRIVATE_IP}" \
  --pod-network-cidr=10.244.0.0/16

echo "==> [2/4] kubectl の設定..."
# rootでも使えるように設定
mkdir -p /root/.kube
cp /etc/kubernetes/admin.conf /root/.kube/config

# project-prod ユーザーでも kubectl を使えるように設定
# 日常操作は project-prod で行うこと（rootは使わない）
if id "project-prod" &>/dev/null; then
  mkdir -p /home/project-prod/.kube
  cp /etc/kubernetes/admin.conf /home/project-prod/.kube/config
  chown -R project-prod:project-prod /home/project-prod/.kube
  echo "project-prod ユーザーにも kubectl を設定しました"
fi

echo "==> [3/4] CNIプラグイン（Calico）インストール..."
# Calico: Flannel と違い NetworkPolicy（Pod間の通信制限）に対応
kubectl create -f \
  https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/tigera-operator.yaml

kubectl apply -f - <<EOF
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - name: default-ipv4-ippool
        cidr: 10.244.0.0/16
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
---
apiVersion: operator.tigera.io/v1
kind: APIServer
metadata:
  name: default
spec: {}
EOF

echo "==> [4/4] ストレージプロビジョナー（local-path）インストール..."
# kubeadm はデフォルト StorageClass を持たないため PVC が Pending になる。
# local-path-provisioner をデフォルト SC として設定する。
kubectl apply -f \
  https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.30/deploy/local-path-storage.yaml
kubectl patch storageclass local-path \
  -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

echo ""
echo "=================================================="
echo "masterセットアップ完了！"
echo ""
echo "ノードのReady確認（1〜2分かかります）:"
echo "  kubectl get nodes"
echo ""
echo "デフォルト StorageClass 確認:"
echo "  kubectl get storageclass"
echo ""
echo "workerを追加する場合:"
echo "  bash add-worker.sh"
echo "=================================================="

```

### `deploy_env/k8s/setup-node.sh`

```bash
#!/bin/bash
# 全ノード（master / worker 共通）で実行するスクリプト
# k3sが入っている場合は先にアンインストールしてから実行する
set -e

# k3sが入っていればアンインストール
if command -v k3s &>/dev/null; then
  echo "==> k3s を検出しました。アンインストールします..."
  /usr/local/bin/k3s-uninstall.sh 2>/dev/null || \
  /usr/local/bin/k3s-agent-uninstall.sh 2>/dev/null || true
  echo "k3s アンインストール完了"
fi

echo "==> [1/5] スワップを無効化（K8s必須要件）..."
sudo swapoff -a
sudo sed -i '/swap/d' /etc/fstab

echo "==> [2/5] カーネルモジュールとネットワーク設定..."
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system

echo "==> [3/5] containerd インストール..."
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg conntrack
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y containerd.io

sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml > /dev/null
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd
sudo systemctl enable containerd

echo "==> [4/5] kubeadm / kubelet / kubectl インストール..."
sudo apt-get install -y apt-transport-https
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
sudo systemctl enable kubelet

echo "==> [5/5] プロダクション警告を設定..."
PROMPT_SETTING='export PS1="\[\e[41;1;37m\][PRODUCTION/K8s] \u@\h:\w $ \[\e[0m\] "'
if ! grep -q "\[PRODUCTION/K8s\]" ~/.bashrc; then
  echo "$PROMPT_SETTING" >> ~/.bashrc
fi

echo ""
echo "=================================================="
echo "ノードセットアップ完了！"
echo ""
echo "【masterノードの場合】"
echo "  bash setup-master.sh <追加ネットワークのIP>"
echo ""
echo "【workerノードの場合】"
echo "  masterで「bash add-worker.sh」を実行してjoinコマンドを取得してください"
echo "=================================================="

```

### `deploy_env/k8s/kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: iki-project

resources:
  # Namespace (先に適用すること)
  - namespace.yaml

  # アプリケーション
  - app/python-deployment.yaml
  - app/python-service.yaml
  - app/nginx-deployment.yaml
  - app/nginx-service.yaml
  - app/counter-deployment.yaml
  - app/counter-service.yaml
  - app/db-statefulset.yaml
  - app/db-service.yaml
  - app/auto-update-cronjob.yaml

  # Cloudflare Tunnel
  - tunnel/cloudflared-deployment.yaml

  # 監視基盤
  - monitoring/prometheus-rbac.yaml
  - monitoring/prometheus-configmap.yaml
  - monitoring/prometheus-pvc.yaml
  - monitoring/prometheus-deployment.yaml
  - monitoring/prometheus-service.yaml
  - monitoring/grafana-provisioning-configmap.yaml
  - monitoring/grafana-pvc.yaml
  - monitoring/grafana-deployment.yaml
  - monitoring/grafana-service.yaml
  - monitoring/cadvisor-daemonset.yaml
  - monitoring/cadvisor-service.yaml
  - monitoring/node-exporter-daemonset.yaml
  - monitoring/node-exporter-service.yaml
  - monitoring/kube-state-metrics-rbac.yaml
  - monitoring/kube-state-metrics-deployment.yaml
  - monitoring/kube-state-metrics-service.yaml

# secrets.yaml は Git 管理外のため kustomization には含めない。
# deploy.sh の手順に従って別途適用してください。

```

### `deploy_env/k8s/namespace.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: iki-project
  labels:
    app.kubernetes.io/managed-by: kubectl

```

### `deploy_env/k8s/secrets.yaml`

> **本ドキュメントには収録しない。** このファイルは `.gitignore` により正しくGit管理対象外になっており、ローカル環境に実際の認証情報（DBパスワード・`SECRET_KEY_BASE`・Google Maps APIキー・Grafana認証情報・Cloudflare Tunnelトークン）を平文で保持している。構造は直前の `secrets.yaml.template`（プレースホルダー版）と同一。

### `deploy_env/k8s/app/auto-update-cronjob.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: auto-updater
  namespace: iki-project
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: auto-updater
  namespace: iki-project
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: auto-updater
  namespace: iki-project
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: auto-updater
subjects:
  - kind: ServiceAccount
    name: auto-updater
    namespace: iki-project
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: auto-update
  namespace: iki-project
spec:
  schedule: "*/30 * * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: auto-updater
          restartPolicy: OnFailure
          containers:
            - name: kubectl
              image: bitnami/kubectl:1.31
              command:
                - kubectl
                - rollout
                - restart
                - deployment/python
                - deployment/nginx
                - deployment/counter
                - -n
                - iki-project

```

### `deploy_env/k8s/app/counter-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: counter
  namespace: iki-project
  labels:
    app: counter
spec:
  replicas: 2
  selector:
    matchLabels:
      app: counter
  template:
    metadata:
      labels:
        app: counter
    spec:
      initContainers:
        - name: wait-for-db
          image: busybox:latest
          command:
            - sh
            - -c
            - until nc -z db 3306; do echo "waiting for db..."; sleep 2; done
      containers:
        - name: counter
          # docker-compose では ./Counters からビルドされます。
          # GHCR にイメージをプッシュした後、このイメージ名を更新してください。
          image: ghcr.io/senarmaporg/iki_project_2026_counter:latest
          ports:
            - containerPort: 3000
          env:
            - name: SECRET_KEY_BASE
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: SECRET_KEY_BASE
            - name: DB_HOST
              value: "db"
            - name: DB_NAME
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_NAME
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_USER
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_PASSWORD
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            httpGet:
              path: /redirect/health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /redirect/health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30

```

### `deploy_env/k8s/app/counter-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: counter
  namespace: iki-project
spec:
  selector:
    app: counter
  ports:
    - port: 3000
      targetPort: 3000
  type: ClusterIP

```

### `deploy_env/k8s/app/db-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: db
  namespace: iki-project
spec:
  selector:
    app: db
  ports:
    - port: 3306
      targetPort: 3306
  clusterIP: None

```

### `deploy_env/k8s/app/db-statefulset.yaml`

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: iki-project
  labels:
    app: db
spec:
  serviceName: db
  replicas: 1
  selector:
    matchLabels:
      app: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: mariadb
          image: mariadb:11
          ports:
            - containerPort: 3306
          env:
            - name: MARIADB_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_ROOT_PASSWORD
            - name: MARIADB_DATABASE
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_NAME
            - name: MARIADB_USER
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_USER
            - name: MARIADB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: DB_PASSWORD
          resources:
            requests:
              cpu: "200m"
              memory: "256Mi"
            limits:
              cpu: "1000m"
              memory: "1Gi"
          readinessProbe:
            exec:
              command:
                - healthcheck.sh
                - --connect
                - --innodb_initialized
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 15
          livenessProbe:
            exec:
              command:
                - healthcheck.sh
                - --connect
            initialDelaySeconds: 30
            periodSeconds: 10
          volumeMounts:
            - name: db-data
              mountPath: /var/lib/mysql
  volumeClaimTemplates:
    - metadata:
        name: db-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi

```

### `deploy_env/k8s/app/nginx-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  namespace: iki-project
  labels:
    app: nginx
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: ghcr.io/senarmaporg/iki_project_2026_nginx:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 80
          env:
            - name: GOOGLE_MAPS_API_KEY
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: GOOGLE_MAPS_API_KEY
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
          readinessProbe:
            tcpSocket:
              port: 80
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 80
            initialDelaySeconds: 10
            periodSeconds: 30

```

### `deploy_env/k8s/app/nginx-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx
  namespace: iki-project
spec:
  selector:
    app: nginx
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP

```

### `deploy_env/k8s/app/python-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: python
  namespace: iki-project
  labels:
    app: python
spec:
  replicas: 2
  selector:
    matchLabels:
      app: python
  template:
    metadata:
      labels:
        app: python
    spec:
      containers:
        - name: python
          image: ghcr.io/senarmaporg/iki_project_2026_python:latest
          imagePullPolicy: Always
          command: ["gunicorn", "-w", "4", "-b", "0.0.0.0:8000", "app:app"]
          ports:
            - containerPort: 8000
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          readinessProbe:
            tcpSocket:
              port: 8000
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: 8000
            initialDelaySeconds: 15
            periodSeconds: 30

```

### `deploy_env/k8s/app/python-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: python
  namespace: iki-project
spec:
  selector:
    app: python
  ports:
    - port: 8000
      targetPort: 8000
  type: ClusterIP

```

### `deploy_env/k8s/monitoring/cadvisor-daemonset.yaml`

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: cadvisor
  namespace: iki-project
  labels:
    app: cadvisor
spec:
  selector:
    matchLabels:
      app: cadvisor
  template:
    metadata:
      labels:
        app: cadvisor
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: cadvisor
          image: gcr.io/cadvisor/cadvisor:latest
          ports:
            - containerPort: 8080
              hostPort: 8080
          args:
            - --housekeeping_interval=10s
            - --max_housekeeping_interval=15s
            - --event_storage_event_limit=default=0
            - --event_storage_age_limit=default=0
            # k3s は containerd を使用するため socket パスを指定
            - --containerd=/run/k3s/containerd/containerd.sock
          securityContext:
            privileged: true
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "300m"
              memory: "256Mi"
          volumeMounts:
            - name: rootfs
              mountPath: /rootfs
              readOnly: true
            - name: var-run
              mountPath: /var/run
              readOnly: true
            - name: sys
              mountPath: /sys
              readOnly: true
            - name: containerd
              mountPath: /run/k3s/containerd
              readOnly: true
            - name: disk
              mountPath: /dev/disk
              readOnly: true
      volumes:
        - name: rootfs
          hostPath:
            path: /
        - name: var-run
          hostPath:
            path: /var/run
        - name: sys
          hostPath:
            path: /sys
        - name: containerd
          hostPath:
            path: /run/k3s/containerd
        - name: disk
          hostPath:
            path: /dev/disk
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule

```

### `deploy_env/k8s/monitoring/cadvisor-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: cadvisor
  namespace: iki-project
spec:
  selector:
    app: cadvisor
  ports:
    - port: 8080
      targetPort: 8080
  type: ClusterIP

```

### `deploy_env/k8s/monitoring/grafana-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
  namespace: iki-project
  labels:
    app: grafana
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      securityContext:
        fsGroup: 472
        runAsUser: 472
      containers:
        - name: grafana
          image: grafana/grafana:latest
          ports:
            - containerPort: 3000
          env:
            - name: GF_SECURITY_ADMIN_USER
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: GF_SECURITY_ADMIN_USER
            - name: GF_SECURITY_ADMIN_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: GF_SECURITY_ADMIN_PASSWORD
            - name: GF_PATHS_PROVISIONING
              value: /etc/grafana/provisioning
          resources:
            requests:
              cpu: "100m"
              memory: "256Mi"
            limits:
              cpu: "300m"
              memory: "512Mi"
          volumeMounts:
            - name: data
              mountPath: /var/lib/grafana
            - name: provisioning-datasources
              mountPath: /etc/grafana/provisioning/datasources
            - name: provisioning-dashboards
              mountPath: /etc/grafana/provisioning/dashboards
          readinessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: grafana-data
        - name: provisioning-datasources
          configMap:
            name: grafana-provisioning
            items:
              - key: datasource.yaml
                path: datasource.yaml
        - name: provisioning-dashboards
          configMap:
            name: grafana-provisioning
            items:
              - key: dashboard-provider.yaml
                path: dashboard-provider.yaml

```

### `deploy_env/k8s/monitoring/grafana-provisioning-configmap.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-provisioning
  namespace: iki-project
data:
  datasource.yaml: |
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        access: proxy
        url: http://prometheus:9090
        isDefault: true
        editable: false

  dashboard-provider.yaml: |
    apiVersion: 1
    providers:
      - name: default
        orgId: 1
        folder: ''
        type: file
        disableDeletion: false
        updateIntervalSeconds: 30
        options:
          path: /var/lib/grafana/dashboards

```

### `deploy_env/k8s/monitoring/grafana-pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: grafana-data
  namespace: iki-project
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi

```

### `deploy_env/k8s/monitoring/grafana-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: grafana
  namespace: iki-project
spec:
  selector:
    app: grafana
  ports:
    - port: 3000
      targetPort: 3000
  type: ClusterIP

```

### `deploy_env/k8s/monitoring/kube-state-metrics-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: iki-project
  labels:
    app: kube-state-metrics
spec:
  replicas: 1
  selector:
    matchLabels:
      app: kube-state-metrics
  template:
    metadata:
      labels:
        app: kube-state-metrics
    spec:
      serviceAccountName: kube-state-metrics
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
          ports:
            - containerPort: 8080
              name: http-metrics
            - containerPort: 8081
              name: telemetry
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "256Mi"
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10

```

### `deploy_env/k8s/monitoring/kube-state-metrics-rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-state-metrics
  namespace: iki-project
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics
rules:
  - apiGroups: [""]
    resources:
      - configmaps
      - secrets
      - nodes
      - pods
      - services
      - serviceaccounts
      - resourcequotas
      - replicationcontrollers
      - limitranges
      - persistentvolumeclaims
      - persistentvolumes
      - namespaces
      - endpoints
    verbs: ["list", "watch"]
  - apiGroups: ["apps"]
    resources:
      - statefulsets
      - daemonsets
      - deployments
      - replicasets
    verbs: ["list", "watch"]
  - apiGroups: ["batch"]
    resources:
      - cronjobs
      - jobs
    verbs: ["list", "watch"]
  - apiGroups: ["autoscaling"]
    resources:
      - horizontalpodautoscalers
    verbs: ["list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources:
      - networkpolicies
      - ingressclasses
      - ingresses
    verbs: ["list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources:
      - storageclasses
      - volumeattachments
    verbs: ["list", "watch"]
  - apiGroups: ["policy"]
    resources:
      - poddisruptionbudgets
    verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-state-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-state-metrics
subjects:
  - kind: ServiceAccount
    name: kube-state-metrics
    namespace: iki-project

```

### `deploy_env/k8s/monitoring/kube-state-metrics-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kube-state-metrics
  namespace: iki-project
spec:
  selector:
    app: kube-state-metrics
  ports:
    - name: http-metrics
      port: 8080
      targetPort: 8080
    - name: telemetry
      port: 8081
      targetPort: 8081
  type: ClusterIP

```

### `deploy_env/k8s/monitoring/node-exporter-daemonset.yaml`

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: iki-project
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      hostNetwork: true
      hostPID: true
      containers:
        - name: node-exporter
          image: prom/node-exporter:latest
          args:
            - --path.procfs=/host/proc
            - --path.rootfs=/rootfs
            - --path.sysfs=/host/sys
            - --collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)
          ports:
            - containerPort: 9100
              hostPort: 9100
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
          volumeMounts:
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: sys
              mountPath: /host/sys
              readOnly: true
            - name: rootfs
              mountPath: /rootfs
              readOnly: true
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: sys
          hostPath:
            path: /sys
        - name: rootfs
          hostPath:
            path: /
      tolerations:
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule

```

### `deploy_env/k8s/monitoring/node-exporter-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: node-exporter
  namespace: iki-project
spec:
  selector:
    app: node-exporter
  ports:
    - port: 9100
      targetPort: 9100
  type: ClusterIP

```

### `deploy_env/k8s/monitoring/prometheus-configmap.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-config
  namespace: iki-project
data:
  prometheus.yml: |
    global:
      scrape_interval: 15s
      evaluation_interval: 15s

    scrape_configs:
      - job_name: 'prometheus'
        static_configs:
          - targets: ['localhost:9090']

      # kubelet 組み込みの cAdvisor (ノードごとのコンテナメトリクス)
      - job_name: 'kubernetes-cadvisor'
        kubernetes_sd_configs:
          - role: node
        scheme: https
        tls_config:
          ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
          insecure_skip_verify: true
        bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
        relabel_configs:
          - action: labelmap
            regex: __meta_kubernetes_node_label_(.+)
          - target_label: __address__
            replacement: kubernetes.default.svc:443
          - source_labels: [__meta_kubernetes_node_name]
            regex: (.+)
            target_label: __metrics_path__
            replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor

      # cAdvisor DaemonSet (デプロイした場合の詳細なコンテナメトリクス)
      - job_name: 'cadvisor'
        kubernetes_sd_configs:
          - role: endpoints
            namespaces:
              names:
                - iki-project
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_name]
            action: keep
            regex: cadvisor

      # node-exporter (ノードのホストメトリクス)
      - job_name: 'node-exporter'
        kubernetes_sd_configs:
          - role: endpoints
            namespaces:
              names:
                - iki-project
        relabel_configs:
          - source_labels: [__meta_kubernetes_service_name]
            action: keep
            regex: node-exporter
          - source_labels: [__meta_kubernetes_endpoint_node_name]
            target_label: node

      # kube-state-metrics (K8sオブジェクトの状態)
      - job_name: 'kube-state-metrics'
        static_configs:
          - targets: ['kube-state-metrics:8080']

      # アノテーションでスクレイプを有効にしたPod
      # Pod に prometheus.io/scrape: "true" を付けると自動収集される
      - job_name: 'kubernetes-pods'
        kubernetes_sd_configs:
          - role: pod
            namespaces:
              names:
                - iki-project
        relabel_configs:
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
            action: keep
            regex: 'true'
          - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
            action: replace
            target_label: __metrics_path__
            regex: (.+)
          - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
            action: replace
            regex: ([^:]+)(?::\d+)?;(\d+)
            replacement: $1:$2
            target_label: __address__
          - action: labelmap
            regex: __meta_kubernetes_pod_label_(.+)
          - source_labels: [__meta_kubernetes_namespace]
            target_label: namespace
          - source_labels: [__meta_kubernetes_pod_name]
            target_label: pod

```

### `deploy_env/k8s/monitoring/prometheus-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus
  namespace: iki-project
  labels:
    app: prometheus
spec:
  replicas: 1
  selector:
    matchLabels:
      app: prometheus
  template:
    metadata:
      labels:
        app: prometheus
    spec:
      serviceAccountName: prometheus
      containers:
        - name: prometheus
          image: prom/prometheus:latest
          args:
            - "--config.file=/etc/prometheus/prometheus.yml"
            - "--storage.tsdb.path=/prometheus"
            - "--storage.tsdb.retention.time=15d"
            - "--web.enable-lifecycle"
          ports:
            - containerPort: 9090
          resources:
            requests:
              cpu: "200m"
              memory: "512Mi"
            limits:
              cpu: "500m"
              memory: "1Gi"
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
            - name: data
              mountPath: /prometheus
          readinessProbe:
            httpGet:
              path: /-/ready
              port: 9090
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /-/healthy
              port: 9090
            initialDelaySeconds: 30
            periodSeconds: 30
      volumes:
        - name: config
          configMap:
            name: prometheus-config
        - name: data
          persistentVolumeClaim:
            claimName: prometheus-data

```

### `deploy_env/k8s/monitoring/prometheus-pvc.yaml`

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-data
  namespace: iki-project
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi

```

### `deploy_env/k8s/monitoring/prometheus-rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
  namespace: iki-project
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - nodes/proxy
      - nodes/metrics
      - services
      - endpoints
      - pods
    verbs: ["get", "list", "watch"]
  - apiGroups: ["extensions", "networking.k8s.io"]
    resources:
      - ingresses
    verbs: ["get", "list", "watch"]
  - nonResourceURLs: ["/metrics", "/metrics/cadvisor"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
  - kind: ServiceAccount
    name: prometheus
    namespace: iki-project

```

### `deploy_env/k8s/monitoring/prometheus-service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata:
  name: prometheus
  namespace: iki-project
spec:
  selector:
    app: prometheus
  ports:
    - port: 9090
      targetPort: 9090
  type: ClusterIP

```

### `deploy_env/k8s/tunnel/cloudflared-deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: iki-project
  labels:
    app: cloudflared
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cloudflared
  template:
    metadata:
      labels:
        app: cloudflared
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          command: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: app-secrets
                  key: TUNNEL_TOKEN
          resources:
            requests:
              cpu: "50m"
              memory: "64Mi"
            limits:
              cpu: "200m"
              memory: "128Mi"
          livenessProbe:
            httpGet:
              path: /ready
              port: 2000
            initialDelaySeconds: 10
            periodSeconds: 30

```

### `deploy_env/k8s/secrets.yaml.template`

```text
# secrets.yaml.template
#
# このファイルをコピーして secrets.yaml を作成してください。
# secrets.yaml は .gitignore 済みです。絶対にコミットしないでください。
#
# 適用方法:
#   cp secrets.yaml.template secrets.yaml
#   # secrets.yaml を編集して各値を平文で入力（stringData のため base64 不要）
#   kubectl apply -f secrets.yaml

apiVersion: v1
kind: Secret
metadata:
  name: app-secrets
  namespace: iki-project
type: Opaque
stringData:
  # MariaDB
  DB_ROOT_PASSWORD: "your-root-password"
  DB_NAME: "counters"
  DB_USER: "counters"
  DB_PASSWORD: "your-db-password"

  # Counter (Rails)
  SECRET_KEY_BASE: "your-64-char-hex-secret"

  # Nginx (Google Maps)
  GOOGLE_MAPS_API_KEY: "your-google-maps-api-key"

  # Grafana
  GF_SECURITY_ADMIN_USER: "your-grafana-user"
  GF_SECURITY_ADMIN_PASSWORD: "your-grafana-password"

  # Cloudflare Tunnel
  TUNNEL_TOKEN: "your-cloudflare-tunnel-token"

```

#### ローカル開発環境 (enviroments/)

### `enviroments/docker-compose.yml`

```yaml
services:
  python:
    image: iki_project_2026:1.0
    build: ./
    container_name: 'iki_project_2026'
    ports:
      - 5001:5001
    working_dir: '/project/programs'
    volumes:
      - ../:/project/
    command: tail -f /dev/null
  nginx:
    image: iki_project_2026_nginx
    build: ./nginx/
    container_name: 'iki_project_2026_nginx'
    ports:
      - 8081:80
      - 4430:443
    volumes:
      - ./nginx/ssl/:/etc/nginx/certs/
      - ../:/project/

```

### `enviroments/Dockerfile`

```dockerfile
FROM python:3.13-slim-trixie

WORKDIR /project/enviroments

ENV TERM=xterm-256color

RUN echo "alias ls='ls --color=auto'" >> /root/.bashrc && \
    echo "alias grep='grep --color=auto'" >> /root/.bashrc && \
    echo "export PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ '" >> /root/.bashrc

RUN apt-get update && apt-get install -y --no-install-recommends \
    vim nodejs npm \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g typescript

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

WORKDIR /project/programs
```

### `enviroments/connect.sh`

```bash
#!/bin/sh
if [ "$1" = "renew" ]; then
    docker compose up -d --build
else
    docker compose up -d
fi

docker exec -it iki_project_2026 /bin/bash
```

### `enviroments/requirements.txt`

```text
pandas
networkx
Flask
plotly
gunicorn
pyvis
```

### `enviroments/nginx/Dockerfile`

```dockerfile
FROM nginx:stable-alpine

WORKDIR /app

# SSL証明書マウント先ディレクトリ
RUN mkdir -p /etc/nginx/certs

# confテンプレート (entrypointがSSL有効時にnginx.confとして使用)
COPY ./nginx-flask.conf /etc/nginx/templates/nginx-flask.conf

# エラーページ
COPY ./errors/ /etc/nginx/errors/

# 起動スクリプト (SSL証明書の有無でHTTP/HTTPSを切り替え)
COPY ./docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]

```

### `enviroments/nginx/docker-entrypoint.sh`

```bash
#!/bin/sh
set -e

CERT=/etc/nginx/certs/server.crt
KEY=/etc/nginx/certs/server.key

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
    echo "[nginx] SSL証明書を検出 → HTTPSモード (port 80 → 443)"
    cp /etc/nginx/templates/nginx-flask.conf /etc/nginx/nginx.conf
else
    echo "[nginx] SSL証明書なし → HTTPのみ (port 80)"
    cat > /etc/nginx/nginx.conf << 'NGINXCONF'
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    server {
        listen 80;
        server_name _;

        error_page 400 /errors/400.html;
        error_page 401 /errors/401.html;
        error_page 403 /errors/403.html;
        error_page 404 /errors/404.html;
        error_page 500 /errors/500.html;
        error_page 502 /errors/502.html;
        error_page 503 /errors/503.html;
        error_page 504 /errors/504.html;

        location ^~ /errors/ {
            root /etc/nginx;
            internal;
        }

        location /3d/ {
            proxy_pass         http://python:5001/3d/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location /api/ {
            proxy_pass         http://python:5001/api/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }

        location / {
            root      /project/programs/html;
            try_files $uri $uri/ =404;
        }
    }
}
NGINXCONF
fi

exec nginx -g "daemon off;"

```

### `enviroments/nginx/nginx-flask.conf`

```nginx
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;

    server {
        listen 80;
        server_name _;

        location /3d/ {
            proxy_pass         http://python:5001/3d/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location /api/ {
            proxy_pass         http://python:5001/api/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location / {
            root      /project/programs/html;
            try_files $uri $uri/ =404;
        }
    }

    server {
        listen 443 ssl;
        server_name _;

        ssl_certificate     /etc/nginx/certs/server.crt;
        ssl_certificate_key /etc/nginx/certs/server.key;
        ssl_protocols       TLSv1.2 TLSv1.3;
        ssl_ciphers         HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;
        ssl_session_cache   shared:SSL:10m;
        ssl_session_timeout 10m;

        error_page 400 /errors/400.html;
        error_page 401 /errors/401.html;
        error_page 403 /errors/403.html;
        error_page 404 /errors/404.html;
        error_page 500 /errors/500.html;
        error_page 502 /errors/502.html;
        error_page 503 /errors/503.html;
        error_page 504 /errors/504.html;

        location ^~ /errors/ {
            root /etc/nginx;
            internal;
        }

        location /3d/ {
            proxy_pass         http://python:5001/3d/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }
        location /api/ {
            proxy_pass         http://python:5001/api/;
            proxy_set_header   Host              $host;
            proxy_set_header   X-Real-IP         $remote_addr;
            proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;
        }

        location / {
            root      /project/programs/html;
            try_files $uri $uri/ =404;
        }
    }
}

```

#### CI/CD

### `.github/workflows/build-push.yml`

```yaml
name: Build and Push Docker Images to GHCR

on:
  push:
    branches:
      - main

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    
    permissions:
      contents: read
      packages: write

    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      # 💡 1. 【追加】コミットハッシュの最初の7文字（Short SHA）を取得して保存するステップ
      - name: Set Short SHA
        id: vars
        run: echo "sha_short=$(git rev-parse --short HEAD)" >> $GITHUB_OUTPUT

      - name: Log in to the Container registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push Python image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./deploy_env/python/Dockerfile
          push: true
          tags: |
            ghcr.io/senarmaporg/iki_project_2026_python:latest
            ghcr.io/senarmaporg/iki_project_2026_python:${{ steps.vars.outputs.sha_short }}

      # Nginx イメージのビルドは Cloudflare Pages 移行（nginx 撤去）に伴い削除。
      # ロールバック用の既存イメージは GHCR に残っている。
```

### `.github/CODEOWNERS`

```text
* @SenARMapOrg/Program_Admin
/programs/ @SenARMapOrg/Backend_Team
/programs/html/ @SenARMapOrg/Frontend_Team
/data/ @SenARMapOrg/CSVMake_Team
/programs/Website/ @SenARMapOrg/WebDesigner_Team
/programs/html/blog/ @SenARMapOrg/Program_Partner
```

### 10.5 データファイル全文

#### 全建物 node.csv / edge.csv

### `data/1_bldg/node.csv`

```csv
id,x,y,z,building,floor,type
1,,,,,,
2,,,,,,
3,,,,,,
4,,,,,,
5,,,,,,
6,,,,,,
7,,,,,,
8,,,,,,
9,,,,,,
10,,,,,,
11,,,,,,
12,,,,,,
13,,,,,,
14,,,,,,
15,,,,,,
16,,,,,,
17,,,,,,
18,,,,,,
19,,,,,,
20,,,,,,
21,,,,,,
22,,,,,,
23,,,,,,
24,,,,,,
25,,,,,,
26,,,,,,
27,,,,,,
28,,,,,,
29,,,,,,
30,,,,,,
31,,,,,,
32,,,,,,
33,,,,,,
34,,,,,,
35,,,,,,
36,,,,,,
37,,,,,,
38,,,,,,
39,,,,,,
40,,,,,,
41,,,,,,
42,,,,,,
43,,,,,,
44,,,,,,
45,,,,,,
46,,,,,,
47,,,,,,
48,,,,,,
49,,,,,,
50,,,,,,
51,,,,,,
52,,,,,,
53,,,,,,
54,,,,,,
55,,,,,,
56,,,,,,
57,,,,,,
58,,,,,,
59,,,,,,
60,,,,,,
61,,,,,,
62,,,,,,
63,,,,,,
64,,,,,,
65,,,,,,
66,,,,,,
67,,,,,,
68,,,,,,
69,,,,,,
70,,,,,,
71,,,,,,
72,,,,,,
73,,,,,,
```

### `data/1_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
```

### `data/10_bldg/node.csv`

```csv
id,x,y,z,building,floor,type,svg_x,svg_y
1,0,0,0,10,1,2,493,1630.122
2,6,0,0,10,1,1,493,1530
3,6,19.4,0,10,1,1,870,1530
4,30.9,19.4,0,10,1,1,870,1060
5,30.9,-4,0,10,1,1,302.497,1060
6,54.9,19.4,0,10,1,1,870,590
7,54.9,-14,0,10,1,1,228,590
8,63.099999999999994,-14,0,10,1,1,228,424.336
9,61.3,19.4,0,10,1,1,870,500
10,70.2,19.4,0,10,1,1,870,315
11,70.2,23.9,0,10,1,1,930,315
12,61.3,29.5,0,10,1,1,1069.243,500
13,61.3,34.599999999999994,0,10,1,1,1138.565,500
14,64.39999999999999,34.599999999999994,0,10,1,1,1144.867,413.833
15,61.3,60.99999999999999,0,10,1,1,1636.424,500
16,61.3,82,0,10,1,1,2031.351,500
17,61.3,92.4,0,10,1,1,2256.123,500
18,65.89999999999999,92.4,0,10,1,1,2260.324,373.92
19,65.9,96.7,0,10,1,1,2321.244,371.819
20,56.29999999999999,92.4,0,10,1,1,2251.922,628.101
21,56.3,105.4,0,10,1,2,2449.385,632.303
22,6,14.299999999999999,0,10,1,1,760,1530
23,12.7,14.3,0,10,1,1,760,1432.554
24,30.9,13.299999999999999,0,10,1,1,760,1060
25,39.2,13.3,0,10,1,1,760,934.905
26,28.1,14.3,5,10,2,1,758.553,1180
27,28.1,9.399999999999999,5,10,2,1,670,1180
28,11.3,9.399999999999999,5,10,2,1,670,1500.196
29,30.9,9.399999999999999,5,10,2,1,670,1108.84
30,30.9,-4,5,10,2,1,415.513,1120.919
31,54.5,9.399999999999999,5,10,2,1,670,666
32,54.5,-14,5,10,2,1,230,666
33,63,-14,5,10,2,1,230,500.065
34,67.3,29.5,0,10,1,1,,
35,54.5,13.6,5,10,2,1,729.564,666
36,54.5,18.7,5,10,2,1,830,666
37,59.7,18.7,5,10,2,1,830,560
38,59.7,29.5,5,10,2,1,1043.614,560
39,70.2,23.9,5,10,2,1,930,355
40,67.3,29.5,5,10,2,1,1041.199,417.929
41,59.7,36.9,5,10,2,1,1176.482,560
42,59.7,61,5,10,2,1,1645.142,560
43,59.7,92.4,5,10,2,1,2220,560
44,65.89999999999999,92.4,5,10,2,1,2220,450
45,65.89999999999999,96.7,5,10,2,1,2294.985,450
46,59.7,23.9,5,10,2,1,930,560
47,70.2,23.9,10,10,3,1,940,400
48,59.3,23.9,10,10,3,1,940,603
49,59.3,20.1,10,10,3,1,875,603
50,59.3,17.8,10,10,3,1,825,603
51,43.9,17.8,10,10,3,1,825,900
52,43.9,14.3,10,10,3,1,765.8,900
53,43.9,20.1,10,10,3,1,875,900
54,59.3,-13.2,10,10,3,1,215,603
55,65.3,-13.2,10,10,3,1,215,538.718
56,59.3,29.5,10,10,3,1,1048.446,603
57,67.3,29.5,10,10,3,1,1055.693,485.571
58,59.3,36.9,10,10,3,1,1200.64,603
59,59.3,60.9,10,10,3,1,1635.479,603
60,59.3,92.4,10,10,3,1,2275,603
61,65.9,92.4,10,10,3,1,2275,480
62,65.9,96.7,10,10,3,1,2338.469,480
63,70.2,23.9,15,10,4,1,930,450
64,63.2,23.9,15,10,4,1,930,610
65,63.2,20.599999999999998,15,10,4,1,879.342,610
66,63.2,19.499999999999996,15,10,4,1,840.689,610
67,63.2,14.699999999999996,15,10,4,1,770.632,610
68,63.2,-13.200000000000003,15,10,4,1,236.746,610
69,65.9,-13.200000000000003,15,10,4,1,234.33,548.381
70,54.800000000000004,23.9,15,10,4,1,930,785
71,54.8,29.5,15,10,4,1,1048.446,785
72,67.39999999999999,29.5,15,10,4,1,1055.693,543.549
73,54.8,87,15,10,4,1,2125,785
74,59.8,87,15,10,4,1,2125,685
75,59.8,92.9,15,10,4,1,2237.007,685
76,66.6,92.9,15,10,4,1,2239.423,616.022
77,70.2,23.9,20,10,5,1,940,935
78,65.8,23.9,20,10,5,1,940,1025
79,65.8,16.2,20,10,5,1,795,1025
80,65.8,-13.600000000000001,20,10,5,1,210,1025
81,65.8,-16.3,20,10,5,1,157.025,1025
82,62.9,-13.6,20,10,5,1,210,1080
83,65.8,29.799999999999997,20,10,5,1,1055.693,1025
84,65.8,37,20,10,5,1,1195.808,1025
85,65.8,67.3,20,10,5,1,1763.515,1025
86,65.8,93.19999999999999,20,10,5,1,2275,1025
87,65.8,97.69999999999999,20,10,5,1,2348.132,1025
88,63,93.19999999999999,20,10,5,1,2275,1079.851
89,84.8,14.2,20,10,5,1,756,645.012
90,95.6,14.2,20,10,5,1,756,460
91,95.6,16.2,20,10,5,1,795,460
92,95.6,19.2,20,10,5,1,852.768,460
93,102.3,16.2,20,10,5,2,795,222.251
94,,,,,,,,
95,,,,,,,,
96,,,,,,,,
97,,,,,,,,
98,,,,,,,,
99,,,,,,,,
100,,,,,,,,
```

### `data/10_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
1,,1,2,10,1,1,6,1
2,,2,22,10,1,1,14.299999999999999,1
3,,22,3,10,1,1,5.1,1
4,,22,23,10,1,1,6.699999999999999,1
5,10101,3,4,10,1,1,24.9,1
6,,23,26,10,1,1,16.19135571840728,3
7,,4,24,10,1,1,6.1,1
8,,24,5,10,1,1,17.299999999999997,1
9,,24,25,10,1,1,8.300000000000004,1
10,10102,4,6,10,1,1,24,1
11,10103,6,7,10,1,1,33.4,1
12,M_Toilet,7,8,10,1,1,8.199999999999996,1
13,,6,9,10,1,1,6.399999999999999,1
14,,9,10,10,1,1,8.900000000000006,1
15,,10,11,10,1,1,4.5,1
16,,9,12,10,1,1,10.100000000000001,1
17,,12,13,10,1,1,5.099999999999994,1
18,M_Toilet;F_Toilet;C_Toilet,13,14,10,1,1,3.0999999999999943,1
19,101A;101B;101C;101D;,13,15,10,1,1,26.4,1
20,101E;101F;101G,15,16,10,1,1,21.000000000000007,1
21,101H,16,17,10,1,1,10.400000000000006,1
22,,17,18,10,1,1,4.599999999999994,1
23,F_Toilet,18,19,10,1,1,4.299999999999997,1
24,,17,20,10,1,1,5.000000000000007,1
25,,20,21,10,1,1,13,1
26,,17,43,10,1,5,5.249761899362673,2
27,,8,33,10,1,5,5.000999900019995,2
28,,15,42,10,1,5,5.249761899362673,2
29,,11,39,10,1,1,5,4
30,,18,44,10,1,1,5,4
31,,12,34,10,1,1,6,1
32,,34,40,10,1,5,5,2
33,,25,35,10,1,5,16.099068296022597,2
34,10201,27,28,10,2,1,16.8,1
35,,26,27,10,2,1,4.900000000000002,1
36,,27,29,10,2,1,2.799999999999997,1
37,,29,30,10,2,1,13.399999999999999,1
38,10202,29,31,10,2,1,23.6,1
39,10203,31,32,10,2,1,23.4,1
40,F_Toilet,32,33,10,2,1,8.5,1
41,,31,35,10,2,1,4.200000000000001,1
42,10204,35,36,10,2,1,5.1,1
43,,36,37,10,2,1,5.200000000000003,1
44,,37,46,10,2,1,5.199999999999999,1
45,,39,46,10,2,1,10.5,1
46,10215,46,38,10,2,1,5.600000000000001,1
47,,38,40,10,2,1,7.599999999999994,1
48,F_Toilet;M_Toilet,38,41,10,2,1,7.399999999999999,1
49,10205;10206;10213;10214,41,42,10,2,1,24.1,1
50,10207;10208;10209;10210;10211;10212,42,43,10,2,1,31.400000000000006,1
51,,43,44,10,2,1,6.199999999999989,1
52,M_Toilet,44,45,10,2,1,4.299999999999997,1
53,,47,48,10,3,1,10.900000000000006,1
54,,48,49,10,3,1,3.799999999999997,1
55,,49,50,10,3,1,2.3000000000000007,1
56,,50,51,10,3,1,15.399999999999999,1
57,,51,52,10,3,1,3.5,1
58,,51,53,10,3,1,2.3000000000000007,1
59,10301;10302;10303;10304,50,54,10,3,1,31,1
60,M_Toilet,54,55,10,3,1,6,1
61,10315,48,56,10,3,1,5.600000000000001,1
62,,56,57,10,3,1,8,1
63,F_Toilet;M_Toilet,56,58,10,3,1,7.399999999999999,1
64,10305;10306;10313;10314,58,59,10,3,1,24,1
65,10307;10308;10309;10310;10311;10312,59,60,10,3,1,31.500000000000007,1
66,,60,61,10,3,1,6.6000000000000085,1
67,F_Toilet,61,62,10,3,1,4.299999999999997,1
68,,60,43,10,3,5,5.015974481593782,2
69,,57,40,10,3,5,5,2
70,,63,47,10,4,1,5,4
71,,63,64,10,4,1,7,1
72,,64,65,10,4,1,3.3000000000000007,1
73,,65,66,10,4,1,1.1000000000000014,1
74,10301,67,68,10,4,1,27.9,1
75,,67,52,10,4,1,19.941163456528813,3
76,F_Toilet,68,69,10,4,1,2.700000000000003,1
77,,68,55,10,4,5,5.4230987451824975,2
78,,64,70,10,4,1,8.399999999999999,1
79,,70,71,10,4,1,5.600000000000001,1
80,F_Toilet;M_Toilet;C_Toilet,71,72,10,4,1,12.599999999999994,1
81,Sky_Terrace;SUBWAY,71,73,10,4,1,57.5,1
82,,73,74,10,4,1,5,1
83,,74,75,10,4,1,5.900000000000006,1
84,,75,76,10,4,1,6.799999999999997,1
85,,75,60,10,4,5,5.049752469181039,2
86,,76,61,10,4,1,5.0734603575863275,4
87,,61,44,10,3,1,5,4
88,,66,92,10,5,5,32.78490506315367,2
89,,77,78,10,5,1,4.400000000000006,1
90,105T,78,79,10,5,1,7.699999999999999,1
91,,79,91,10,5,1,29.799999999999997,2
92,105A;105B;105C;105D;105U;105V;105W;105X,79,80,10,5,1,29.8,1
93,M_Toilet,80,81,10,5,1,2.6999999999999993,1
94,,80,82,10,5,1,2.8999999999999986,1
95,,82,68,10,5,1,5.024937810560445,2
96,,78,83,10,5,1,5.899999999999999,1
97,105S;F_Toilet;M_Toilet,83,84,10,5,1,7.200000000000003,1
98,105E;105F;105G;105O;105P;105Q;105R,84,85,10,5,1,30.299999999999997,1
99,105H;105I;105J;105L;105N;105M;105N,85,86,10,5,1,25.89999999999999,1
100,F_Toilet,86,87,10,5,1,4.5,1
101,,86,88,10,5,1,2.799999999999997,1
102,,86,76,10,5,1,5.072474741188958,4
103,,88,75,10,5,5,5.943904440685433,2
104,,89,67,10,5,1,22.176789668479966,5
105,,65,53,10,3,1,19.943419967498055,2
106,,89,90,10,5,1,10.799999999999997,1
107,,90,91,10,5,1,2,1
108,,91,92,10,5,1,3,1
109,,91,93,10,5,1,6.700000000000003,1
110,,33,55,10,5,5,5.561474624593732,2
111,,63,77,10,4,1,5,4
112,,39,47,10,4,1,5,4
113,,57,72,10,3,5,5.000999900019995,2
114,,72,83,10,3,5,5.258326730053961,2
115,,5,30,10,1,5,5,2
116,,36,49,10,1,5,7.071067811865474,2
117,,26,52,10,2,1,16.572265988693275,3
118,,42,59,10,2,5,5.016971197844374,2
```

### `data/2_bldg/node.csv`

```csv
id,x,y,z,building,floor,type
1,7.8,-11,-4.9,2,0,1
2,7.8,-8.7,-4.9,2,0,1
3,7.8,-1.7,-4.9,2,0,1
4,34.9,-1.7,-4.9,2,0,1
5,34.9,-11.8,-4.9,2,0,1
6,47.5,0.7,-4.9,2,0,1
7,47.5,-1.7,-4.9,2,0,1
8,54.5,-1.7,-4.9,2,0,1
9,0,0,0,2,1,2
10,7.8,0,0,2,1,1
11,7.8,-8.7,0,2,1,1
12,7.8,-10.9,0,2,1,1
13,34.9,0,0,2,1,1
14,34.9,-10.2,0,2,1,1
15,39.1,2,0,2,1,1
16,60.2,0,0,2,1,1
17,60.2,2.4,0,2,1,1
18,49.9,0.3,4.2,2,2,1
19,58.9,-6.1,4.2,2,2,2
20,34.8,-6.1,4.2,2,2,1
21,34.8,-11.9,4.2,2,2,1
22,7.8,-6.1,4.2,2,2,1
23,7.8,-8.7,4.2,2,2,1
24,7.8,-11,4.2,2,2,1
25,-16.2,-6.1,4.2,2,2,1
26,34.9,2,0,2,1,1
27,55.8,0,0,2,1,1
28,55.8,-9.6,0,2,1,1
29,49.9,-6.1,4.2,2,2,1
30,66,-6.1,4.2,2,2,1
31,67.9,-6.1,4.2,2,2,1
32,67.9,-4.5,4.2,2,2,1
33,-6.6,0,0,2,1,1
```

### `data/2_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
1,,9,10,2,1,1,7.8,1
2,,33,9,2,1,1,6.6,1
3,,10,11,2,1,1,8.7,1
4,,11,12,2,1,1,2.200000000000001,1
5,211,10,13,2,1,1,27.099999999999998,1
6,M_Toilet;F_Toilet;,13,14,2,1,1,10.2,1
7,,13,27,2,1,1,20.9,1
8,,13,26,2,1,1,2,1
9,,27,28,2,1,1,9.6,1
10,,16,17,2,1,1,2.4,1
11,,27,16,2,1,1,4.400000000000006,1
12,,15,18,2,1,5,11.711959699384213,2
13,,11,2,2,0,1,4.9,4
14,,12,1,2,0,5,4.901020301937139,2
15,,1,2,2,0,1,2.3000000000000007,1
16,,2,3,2,0,1,6.999999999999999,1
17,201,3,4,2,0,1,27.099999999999998,1
18,M_Toilet;F_Toilet;C_Toilet,4,5,2,0,1,10.100000000000001,1
19,,4,7,2,0,1,12.600000000000001,1
20,202,7,8,2,0,1,7,1
21,,6,7,2,0,1,2.4,1
22,,6,17,2,0,5,13.718236038208413,2
23,,11,23,2,1,1,4.2,4
24,,12,24,2,1,5,4.201190307520001,2
25,,24,23,2,2,1,2.3000000000000007,1
26,,23,22,2,2,1,2.5999999999999996,1
27,221;222;223;224,22,20,2,2,1,26.999999999999996,1
28,M_Toilet;F_Toilet;C_Toilet,21,20,2,2,1,5.800000000000001,1
29,,20,29,2,2,1,15.100000000000001,1
30,,29,18,2,2,1,6.3999999999999995,1
31,225;226;227,29,19,2,2,1,9,1
32,,19,30,2,2,1,7.100000000000001,1
33,,30,32,2,2,1,2.483948469674848,1
34,,22,25,2,2,1,24,1
```

### `data/5_bldg/node.csv`

```csv
id,x,y,z,building,floor,type
1,0,0,0,5,1,1
2,2.1,58.4,0,5,1,2
3,0,-0.30000000000000027,4.18,5,2,2
4,-2.1,3.9,4.18,5,2,1
5,0,3.9,0,5,1,1
6,2.4,3.9,0,5,1,1
7,2.4,1.9,0,5,1,1
8,0,53.699999999999996,0,5,1,1
9,2.1,53.7,0,5,1,1
10,2.1,56,0,5,1,1
11,0,3.9,4.18,5,2,1
12,2.4,3.9,4.18,5,2,1
13,2.4,1.9,4.18,5,2,1
14,8.9,3.9,4.18,5,2,1
15,8.9,53.7,4.18,5,2,1
16,2.1,53.7,4.18,5,2,1
17,0,53.699999999999996,4.18,5,2,1
18,2.1,56,4.18,5,2,1
19,2.4,1.9,8.36,5,3,1
20,2.1,56,8.36,5,3,1
21,-20,3.9,0,5,1,2
22,-20,0,0,5,1,2
```

### `data/5_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
1,,1,5,5,1,1,3.9,1
2,M_Toilet,5,6,5,1,1,2.4,1
3,,6,7,5,1,1,2,1
4,511;Natural_Science_Laboratory1;Natural_Science_Laboratory2;Life_Science_Laboratory1;Life_Science_Laboratory2;Life_Science_Laboratory3;PE_Practice _Room;Social _And_PE_Laboratory;Physiological_Laboratory;Physical_Fitness_Measurement Room;PE_Laboratory;Electrical_Room;Changing_Room,5,8,5,1,1,49.8,1
5,,8,9,5,1,1,2.1,1
6,,9,10,5,1,1,2.299999999999997,1
7,,10,2,5,1,1,2.3999999999999986,1
8,,7,13,5,1,5,4.18,2
9,,10,18,5,1,5,4.18,2
10,,13,12,5,2,1,2,1
11,,12,11,5,2,1,2.4,1
12,,11,3,5,2,1,4.2,1
13,,11,4,5,2,1,2.1,1
14,,12,14,5,2,1,6.5,1
15,G1;G2;G3;G4;G5;G6;G7;G8;G9;G10;G11;G12,14,15,5,2,1,49.800000000000004,1
16,521;522;523;524;525;526;527;528;M_Toilet,11,17,5,2,1,49.8,1
17,,15,16,5,2,1,6.800000000000001,1
18,,16,17,5,2,1,2.1,1
19,,16,18,5,2,1,2.299999999999997,1
20,,13,19,5,2,5,4.18,2
21,,18,20,5,2,5,4.18,2
22,51;52;53;54;55;56;G13;G14;G15,19,20,5,3,1,54.10083178658162,1
23,,4,21,5,1,5,18.38157773424251,2
24,,1,22,5,1,5,20,1
```

### `data/7_bldg/node.csv`

```csv
id,x,y,z,building,floor,type
1,0,0,0,7,1,2
2,0,6.7,0,7,1,1
3,0,13.5,0,7,1,1
4,8,13.5,0,7,1,1
5,8,10.1,0,7,1,1
6,10.5,13.5,0,7,1,1
7,-20.8,13.5,0,7,1,1
8,-20.8,10.1,0,7,1,1
9,-23,10.1,0,7,1,1
10,14.5,13.5,0,7,1,2
11,8,10.1,4.25,7,2,1
12,8,13.5,4.25,7,2,1
13,10.5,13.5,4.25,7,2,1
14,-20.8,13.5,4.25,7,2,1
15,-20.8,10.1,4.25,7,2,1
16,-23,13.5,4.25,7,2,1
17,8,10.1,8.5,7,3,1
18,8,13.5,8.5,7,3,1
19,10.5,13.5,8.5,7,3,1
20,-20.8,13.5,8.5,7,3,1
21,-20.8,10.1,8.5,7,3,1
22,-23,13.5,8.5,7,3,1
23,8,10.100000000000001,-4.59,7,0,1
24,4,10.1,-4.59,7,0,1
25,4,6.4,-4.59,7,0,1
26,-16.8,10.1,-4.59,7,0,1
27,-16.8,6.4,-4.59,7,0,1
28,-20.8,10.1,-4.59,7,0,1
29,,,,,,
30,,,,,,
11,,,,,,
11,,,,,,
```

### `data/7_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
1,,1,2,7,1,1,6.7,1
2,,2,3,7,1,1,6.8,1
3,711;712;714,3,7,7,1,1,20.8,1
4,713,3,4,7,1,1,8,1
5,,4,5,7,1,1,3.4000000000000004,1
6,M_Toilet,4,6,7,1,1,2.5,1
7,,5,11,7,1,5,4.25,2
8,,5,23,7,0,5,4.59,2
9,,6,10,7,1,1,4,1
10,,7,8,7,1,1,3.4000000000000004,1
11,F_Toilet;C_Toilet,7,9,7,1,1,4.049691346263317,1
12,,8,15,7,1,5,4.25,2
13,,8,28,7,0,5,4.59,2
14,,11,12,7,2,1,3.4000000000000004,1
15,,11,17,7,2,5,4.25,2
16,M_Toilet,12,13,7,2,1,2.5,1
17,721;722;723;724;725,12,14,7,2,1,28.8,1
18,,14,15,7,2,1,3.4000000000000004,1
19,F_Toilet,14,16,7,2,1,2.1999999999999993,1
20,,15,21,7,2,5,4.25,1
21,,17,18,7,3,1,3.4000000000000004,1
22,M_Toilet,18,19,7,3,1,2.5,1
23,70;71;72;73;74;75;76;77;78;79,18,20,7,3,1,28.8,1
24,,20,21,7,3,1,3.4000000000000004,1
25,F_Toilet,20,22,7,3,1,2.1999999999999993,1
26,,23,24,7,0,1,4,1
27,M_Toilet,24,25,7,0,1,3.6999999999999993,1
28,702;701,24,26,7,0,1,20.8,1
29,F_Toilet,26,27,7,0,1,3.6999999999999993,1
30,,26,28,7,0,1,4,1
```

### `data/8_bldg/node.csv`

```csv
id,x,y,z,building,floor,type
1,0,0,0,8,5,2
2,-4.1,0,0,8,5,1
3,21.5,-3.5,0,8,5,1
4,21.5,-1,0,8,5,1
5,28,-1,0,8,5,1
6,33,-1,0,8,5,1
7,28,3.5,0,8,5,2
8,62.7,0,0,8,5,2
9,67.9,0,0,8,5,1
10,-4.1,0,-4.375,8,4,1
11,-4.1,4.8,-4.375,8,4,1
12,27.9,4.8,-4.375,8,4,1
13,27.9,-1,-4.375,8,4,1
14,33,-1,-4.375,8,4,1
15,21.5,-1,-4.375,8,4,1
16,21.5,-3.5,-4.375,8,4,1
17,67.9,4.8,-4.375,8,4,1
18,67.9,0,-4.375,8,4,1
19,87.4,4.8,-4.375,8,4,1
20,-4.1,0,-8.4,8,3,1
21,-4.1,4.9,-8.4,8,3,1
22,27.9,4.9,-8.4,8,3,1
23,27.9,10.9,-8.4,8,3,1
24,27.9,-1,-8.4,8,3,1
25,33,-1,-8.4,8,3,1
26,21.5,-1,-8.4,8,3,1
27,21.5,-3.5,-8.4,8,3,1
28,67.9,4.9,-8.4,8,3,1
29,67.9,0,-8.4,8,3,1
30,-4.1,0,-12.775,8,2,1
31,-0.6999999999999997,0,-12.775,8,2,1
32,-0.7,5.4,-12.775,8,2,1
33,21.5,0,-12.775,8,2,1
34,21.5,-3.5,-12.775,8,2,1
35,38.5,0,-12.775,8,2,1
36,38.5,-3.8,-12.775,8,2,1
37,63.9,0,-12.775,8,2,1
38,63.9,5.8,-12.775,8,2,1
39,67.9,0,-12.775,8,2,1
40,-4.1,0,-17.15,8,1,1
41,-0.6999999999999997,0,-17.15,8,1,1
42,-0.7,5.4,-17.15,8,1,1
43,21.8,0,-17.15,8,1,1
44,21.8,-2.7,-17.15,8,1,1
45,38.8,0,-17.15,8,1,1
46,38.8,-3.8,-17.15,8,1,1
47,64.19999999999999,0,-17.15,8,1,1
48,64.2,5.8,-17.15,8,1,1
49,67.89999999999999,0,-17.15,8,1,1
```

### `data/8_bldg/edge.csv`

```csv
id,name,from,to,building,floor,weight,length,type
1,,1,2,8,5,1,4.1,1
2,,3,4,8,5,1,2.5,1
3,,4,5,8,5,1,6.5,1
4,,5,6,8,5,1,5,1
5,,5,7,8,5,1,4.5,1
6,,8,9,8,5,1,5.200000000000003,1
7,,2,10,8,4,5,4.375,2
8,,6,14,8,4,5,4.375,2
9,,3,16,8,4,1,4.375,4
10,,9,18,8,4,5,4.375,2
11,F_Toilet,10,11,8,4,1,4.8,1
12,,11,12,8,4,1,32,1
13,,12,13,8,4,1,5.8,1
14,,13,14,8,4,1,5.100000000000001,1
15,,13,15,8,4,1,6.399999999999999,1
16,,15,16,8,4,1,2.5,1
17,M841;8401;8402;8403;8404;8405;8406;8407;8408;8409;8410;8419;8420;8421;8422;8423;8424,12,17,8,4,1,40.00000000000001,1
18,M_Toilet,17,18,8,4,1,4.8,1
19,8430;8431;8432;8433;8434;8435;8436;8437;8438,17,19,8,4,1,19.5,1
20,,10,20,8,3,5,4.025,2
21,,14,25,8,3,5,4.025,2
22,,18,29,8,3,5,4.025,2
23,,16,27,8,3,1,4.025,4
24,F_Toilet,20,21,8,3,1,4.9,1
25,8311;8312;8313;8314;8315;8316;8317;8318;8325;8326;8327;8328;8329;Boilerroom,21,22,8,3,1,32,1
26,,22,23,8,3,1,6,1
27,,22,24,8,3,1,5.9,1
28,,24,25,8,3,1,5.100000000000001,1
29,,24,26,8,3,1,6.399999999999999,1
30,,26,27,8,3,1,2.5,1
31,8301;8302;8303;8304;8305;8306;8307;8308;8309;8310;8319;8320;8321;8322;8323;8324;M831,22,28,8,3,1,40.00000000000001,1
32,M_Toilet,28,29,8,3,1,4.9,1
33,,20,30,8,2,5,4.375,2
34,,25,36,8,2,5,7.565092530828688,2
35,,29,39,8,2,5,4.375,2
36,,27,34,8,2,1,4.375,4
37,,30,31,8,2,1,3.4,1
38,F_Toilet,31,32,8,2,1,5.4,1
39,824,31,33,8,2,1,22.2,1
40,,33,34,8,2,1,3.5,1
41,823,33,35,8,2,1,17,1
42,,35,36,8,2,1,3.8,1
43,822;821,35,37,8,2,1,25.4,1
44,M_Toilet,37,38,8,2,1,5.8,1
45,,37,39,8,2,1,4.000000000000007,1
46,,30,40,8,1,5,4.374999999999998,2
47,,34,44,8,1,1,4.457647922391358,4
48,,36,46,8,1,5,4.385273651666449,2
49,,39,49,8,1,5,4.374999999999998,2
50,,40,41,8,1,1,3.4,1
51,F_Toilet,41,42,8,1,1,5.4,1
52,814,41,43,8,1,1,22.5,1
53,,43,44,8,1,1,2.7,1
54,813,43,45,8,1,1,16.999999999999996,1
55,,45,46,8,1,1,3.8,1
56,812;811,45,47,8,1,1,25.39999999999999,1
57,M_Toilet,47,48,8,1,1,5.8,1
58,,47,49,8,1,1,3.700000000000003,1
```

#### 屋外・共通データ

### `data/global_node.csv`

```csv
id,x,y,z,lat,lng,floor,type,name
1,0,0,0,35.61084,139.55369,0,1,
2,1.261386203121774e-15,-20.6,0,35.61087,139.55393,0,1,
3,-53.5,-20.60000000000001,0,35.61118,139.55389,0,1,
4,-57.09451727770546,-40.985520487352716,6.8,35.6112,139.55413,0,1,
5,-3.02857163733524,-50.51880544126719,8.8,35.61091,139.55416,0,1,
6,-11.094517277705457,-130.18552048735273,28.8,35.61092,139.55514,0,1,
7,-6.4928405695318006,-104.08811503252922,28.8,35.61086,139.55483,0,1,
8,34.5717269588124,-89.14183476919749,29.4,35.61056,139.55473,0,1,
9,58.62785805093166,-80.38611910006037,36.5,35.61035,139.55466,0,1,
10,56.04050020369439,-65.71248358017847,35.3,35.6104,139.55448,0,1,
11,67.3284128064835,-84.44325441277108,35.9,35.61026,139.55473,0,1,
12,120.84878276036181,-53.54325441277109,41.3,35.60978,139.55455,0,1,
13,139.45467855727819,-104.6625329835245,41.3,35.60965,139.55504,0,1,
14,140.61754704458545,-107.8574878941966,41.3,35.60963,139.55513,0,1,
15,141.2673853169042,-109.64290387368982,41.3,35.6096,139.55521,0,1,
16,46.2846493581748,-68.32655593571393,29.3,35.61045,139.5545,0,1,
17,54.00881652499131,-54.19023286993564,34.7,35.61042,139.55435,0,1,
18,53.244764543256814,-49.85707875668193,34.7,35.61043,139.55427,0,1,
19,80.58046542723744,-42.53249978028059,34.7,35.61013,139.55417,0,1,
20,111.49009186848762,-34.250290336999925,34.7,35.60989,139.5541,0,1,
21,112.99498049912057,-38.384937868457925,34.7,35.60987,139.55418,0,1,
22,72.73824836063106,-13.264947243721817,34.7,35.61022,139.55385,0,1,
23,69.74387829913495,-14.067286283539632,34.7,35.61028,139.55388,0,1,
24,63.66163073922571,8.631970634253472,34.7,35.61035,139.5536,0,1,
25,7.066752332887557,-180.08319865108447,28.8,35.6108,139.5557,0,1,
26,87.97428698255428,-150.6352643107444,36.30411265848407,35.61008,139.55539,0,1,
27,-67.92740256083974,-39.07539053301648,6.8,35.61142,139.55411,0,1,
28,-81.29831224119337,-114.9055875149565,6.8,35.61151,139.55492,0,1,
29,-125.22073802553786,-107.1608787910114,6.8,35.6119,139.55488,0,1,
30,-125.22073802553786,-136.66087879101138,6.8,35.61195,139.55519,0,1,
31,184.67952831595974,-89.39948913631031,43,35.60917,139.55503,0,1,
32,189.57041636551682,-102.8370936135488,44,35.60914,139.55517,0,1,
33,191.31353122047,-122.76098757538371,44,35.60909,139.55534,0,1,
34,195.27382710825518,-121.69982949046337,45,35.60905,139.55533,0,1,
35,195.9100640303131,-128.97205078653312,45,35.60903,139.55539,0,1,
36,196.39813618969998,-134.5507410958469,45,35.60902,139.55545,0,1,
37,267.3318937494197,-102.39192872581532,47,35.60835,139.55505,0,1,
38,268.22959789972055,-112.6527341161603,47.3,35.60831,139.55517,0,1,
39,276.99115201231035,-99.8037382747901,47,35.60827,139.55502,0,1,
40,305.9689268009824,-92.03916692171448,47,35.60804,139.55492,0,1,
41,142.06640515308055,-41.29325441277109,41.3,35.60957,139.55445,0,1,
42,,,,,,,,
43,,,,,,,,
44,,,,,,,,
45,,,,,,,,
46,,,,,,,,
47,,,,,,,,
48,,,,,,,,
49,,,,,,,,
50,,,,,,,,
51,,,,,,,,
52,,,,,,,,
53,,,,,,,,
54,,,,,,,,
55,,,,,,,,
56,,,,,,,,
57,,,,,,,,
58,,,,,,,,
59,,,,,,,,
60,,,,,,,,
61,,,,,,,,
```

### `data/global_edge.csv`

```csv
id,name,from,to,floor,weight,length,type
1,,1,2,1,1,20.6,1
2,,2,3,1,1,53.5,1
3,,3,4,1,1,21.788299612406657,2
4,,4,5,1,1,54.93641779366397,1
5,,6,7,1,1,26.500000000000004,1
6,,7,8,1,1,43.704118799033125,1
7,,8,9,1,1,26.566332076521217,1
8,,9,10,1,1,14.948244044034068,2
9,,9,11,1,1,9.61873172512884,1
10,,11,12,1,1,62.035473722701596,2
11,,12,13,1,1,54.39999999999999,1
12,,13,14,1,1,3.400000000000003,1
13,,14,15,1,1,1.8999999999999937,1
14,,10,16,1,1,11.74776574502573,1
15,,10,17,1,1,11.715374513859976,1
16,,17,18,1,1,4.399999999999998,1
17,,18,19,1,1,28.299999999999997,1
18,,19,20,1,1,31.999999999999996,1
19,,20,21,1,1,4.400000000000005,1
20,,19,22,1,1,30.3,1
21,,22,23,1,1,3.1000000000000014,1
22,,23,24,1,1,23.5,2
23,,12,21,1,3,18.303463344850236,2
24,,6,25,1,1,53.10000000000001,1
25,,25,26,1,1,86.42639473442833,1
26,,26,15,1,1,67.42022570864924,1
27,,11,26,1,1,69.33828381109738,1
28,,4,27,1,1,10.999999999999993,1
29,,27,28,1,1,77,1
30,,28,29,1,1,44.6,1
31,,29,30,1,1,29.499999999999986,1
32,,15,31,1,1,47.93015752112651,1
33,,31,32,1,1,14.334922392534962,1
34,,32,33,1,1,19.999999999999996,1
35,,33,34,1,1,4.220189569201838,1
36,,34,35,1,1,7.300000000000003,1
37,,35,36,1,1,5.599999999999996,1
38,,34,37,1,1,74.62680483579612,1
39,,37,38,1,1,10.304368005850726,1
40,,38,39,1,1,15.55479104968588,1
41,,39,40,1,1,29.99999999999999,1
42,,37,39,1,1,9.999999999999979,1
43,,12,41,1,1,31.30849067730801,1
```

### `data/anchors.csv`

```csv
building,local_node_id,global_node_id
10,21,4
10,93,6
10,1,30
7,1,8
7,10,16
8,1,17
8,7,19
8,8,21
2,33,35
2,32,38
5,21,13
5,22,14
5,2,41
```

### `data/buildings.json`

```json
{
  "10": {
    "tx": 0.0,
    "ty": 0.0,
    "tz": 0.0,
    "rot_deg": 0.0,
    "tz_offset": 0.0
  }
}
```

### `data/edge_image.csv`

```csv
id,from,to,image_name
1,1000001,1000002,1000001_to_1000002.jpg
2,1000002,1000001,1000002_to_1000001.jpg
3,1000022,1000002,1000022_to_1000002.jpg
4,1000002,1000022,1000002_to_1000022.jpg
5,1000003,1000022,1000003_to_1000022.jpg
6,1000022,1000003,1000022_to_1000003.jpg
7,1000022,1000023,1000022_to_1000023.jpg
8,1000023,1000022,1000023_to_1000022.jpg
9,1000003,1000004,1000003_to_1000004.jpg
10,1000004,1000024,1000004_to_1000024.jpg
11,1000024,1000004,1000024_to_1000004.jpg
12,1000024,1000025,1000024_to_1000025.jpg
13,1000025,1000024,1000025_to_1000024.jpg
14,1000004,1000003,1000004_to_1000003.jpg
15,1000004,1000006,1000004_to_1000006.jpg
16,1000006,1000007,1000006_to_1000007.jpg
17,1000007,1000006,1000007_to_1000006.jpg
18,1000007,1000008,1000007_to_1000008.jpg
19,1000008,1000007,1000008_to_1000007.jpg
20,1000006,1000009,1000006_to_1000009.jpg
21,1000009,1000006,1000009_to_1000006.jpg
22,1000009,1000010,1000009_to_1000010.jpg
23,1000010,1000009,1000010_to_1000009.jpg
24,1000010,1000011,1000010_to_1000011.jpg
25,1000011,1000010,1000011_to_1000010.jpg
26,1000009,1000012,1000009_to_1000012.jpg
27,1000012,1000009,1000012_to_1000009.jpg
28,1000012,1000034,1000012_to_1000034.jpg
29,1000034,1000012,1000034_to_1000012.jpg
30,1000012,1000013,1000012_to_1000013.jpg
31,1000013,1000012,1000013_to_1000012.jpg
32,1000013,1000014,1000013_to_1000014.jpg
33,1000014,1000013,1000014_to_1000013.jpg
34,1000013,1000015,1000013_to_1000015.jpg
35,1000015,1000013,1000015_to_1000013.jpg
36,1000015,1000016,1000015_to_1000016.jpg
37,1000016,1000015,1000016_to_1000015.jpg
38,1000016,1000017,1000016_to_1000017.jpg
39,1000017,1000016,1000017_to_1000016.jpg
40,1000017,1000020,1000017_to_1000020.jpg
41,1000020,1000017,1000020_to_1000017.jpg
42,1000020,1000021,1000020_to_1000021.jpg
43,1000021,1000020,1000021_to_1000020.jpg
44,1000017,1000018,1000017_to_1000018.jpg
45,1000018,1000017,1000018_to_1000017.jpg
46,1000018,1000019,1000018_to_1000019.jpg
47,1000019,1000018,1000019_to_1000018.jpg
48,1000026,1000027,1000026_to_1000027.jpg
49,1000027,1000026,1000027_to_1000026.jpg
50,1000027,1000028,1000027_to_1000028.jpg
51,1000028,1000027,1000028_to_1000027.jpg
52,1000027,1000029,1000027_to_1000029.jpg
53,1000029,1000030,1000029_to_1000030.jpg
54,1000029,1000027,1000029_to_1000027.jpg
55,1000029,1000031,1000029_to_1000031.jpg
56,1000031,1000029,1000031_to_1000029.jpg
57,1000030,1000029,1000030_to_1000029.jpg
58,1000031,1000032,1000031_to_1000032.jpg
59,1000032,1000033,1000032_to_1000033.jpg
60,1000032,1000031,1000032_to_1000031.jpg
61,1000033,1000008,1000033_to_1000008.jpg
62,1000033,1000055,1000033_to_1000055.jpg
63,1000033,1000032,1000033_to_1000032.jpg
64,1000031,1000035,1000031_to_1000035.jpg
65,1000035,1000025,1000035_to_1000025.jpg
66,1000035,1000031,1000035_to_1000031.jpg
67,1000035,1000036,1000035_to_1000036.jpg
68,1000036,1000049,1000036_to_1000049.jpg
69,1000036,1000035,1000036_to_1000035.jpg
70,1000036,1000037,1000036_to_1000037.jpg
71,1000037,1000036,1000037_to_1000036.jpg
72,1000046,1000037,1000046_to_1000037.jpg
73,1000037,1000046,1000037_to_1000046.jpg
74,1000039,1000046,1000039_to_1000046.jpg
75,1000040,1000034,1000040_to_1000034.jpg
76,1000040,1000057,1000040_to_1000057.jpg
77,1000040,1000038,1000040_to_1000038.jpg
78,1000038,1000040,1000038_to_1000040.jpg
79,1000038,1000046,1000038_to_1000046.jpg
80,1000038,1000041,1000038_to_1000041.jpg
81,1000041,1000042,1000041_to_1000042.jpg
82,1000042,1000015,1000042_to_1000015.jpg
83,1000042,1000059,1000042_to_1000059.jpg
84,1000042,1000041,1000042_to_1000041.jpg
85,1000042,1000043,1000042_to_1000043.jpg
86,1000043,1000042,1000043_to_1000042.jpg
87,1000043,1000044,1000043_to_1000044.jpg
88,1000043,1000017,1000043_to_1000017.jpg
89,1000044,1000045,1000044_to_1000045.jpg
90,1000044,1000043,1000044_to_1000043.jpg
91,1000045,1000044,1000045_to_1000044.jpg
92,1000047,1000048,1000047_to_1000048.jpg
93,1000049,1000048,1000049_to_1000048.jpg
94,1000056,1000057,1000056_to_1000057.jpg
95,1000048,1000047,1000048_to_1000047.jpg
96,1000056,1000048,1000056_to_1000048.jpg
97,1000057,1000056,1000057_to_1000056.jpg
98,1000056,1000058,1000056_to_1000058.jpg
99,1000058,1000056,1000058_to_1000056.jpg
100,1000058,1000059,1000058_to_1000059.jpg
101,1000059,1000058,1000059_to_1000058.jpg
102,1000059,1000060,1000059_to_1000060.jpg
103,1000060,1000059,1000060_to_1000059.jpg
104,1000060,1000061,1000060_to_1000061.jpg
105,1000061,1000060,1000061_to_1000060.jpg
106,1000061,1000062,1000061_to_1000062.jpg
107,1000062,1000061,1000062_to_1000061.jpg
108,1000049,1000050,1000049_to_1000050.jpg
109,1000048,1000056,1000048_to_1000056.jpg
110,1000049,1000036,1000049_to_1000036.jpg
111,1000050,1000054,1000050_to_1000054.jpg
112,1000050,1000051,1000050_to_1000051.jpg
113,1000050,1000049,1000050_to_1000049.jpg
114,1000051,1000050,1000051_to_1000050.jpg
115,1000053,1000051,1000053_to_1000051.jpg
116,1000075,1000076,1000075_to_1000076.jpg
117,1000076,1000075,1000076_to_1000075.jpg
118,1000075,1000074,1000075_to_1000074.jpg
119,1000074,1000075,1000074_to_1000075.jpg
120,1000074,1000073,1000074_to_1000073.jpg
121,1000073,1000074,1000073_to_1000074.jpg
122,1000071,1000070,1000071_to_1000070.jpg
123,1000070,1000071,1000070_to_1000071.jpg
124,1000071,1000072,1000071_to_1000072.jpg
125,1000072,1000071,1000072_to_1000071.jpg
126,1000070,1000064,1000070_to_1000064.jpg
127,1000064,1000070,1000064_to_1000070.jpg
128,1000064,1000065,1000064_to_1000065.jpg
129,1000067,1000068,1000067_to_1000068.jpg
130,1000068,1000067,1000068_to_1000067.jpg
131,1000068,1000069,1000068_to_1000069.jpg
132,1000069,1000068,1000069_to_1000068.jpg
133,1000064,1000063,1000064_to_1000063.jpg
134,1000063,1000064,1000063_to_1000064.jpg
135,1000066,1000091,1000066_to_1000091.jpg
136,1000065,1000053,1000065_to_1000053.jpg
137,1000077,1000078,1000077_to_1000078.jpg
138,1000078,1000083,1000078_to_1000083.jpg
139,1000083,1000078,1000083_to_1000078.jpg
140,1000083,1000072,1000083_to_1000072.jpg
141,1000083,1000084,1000083_to_1000084.jpg
142,1000084,1000083,1000084_to_1000083.jpg
143,1000084,1000085,1000084_to_1000085.jpg
144,1000085,1000084,1000085_to_1000084.jpg
145,1000085,1000086,1000085_to_1000086.jpg
146,1000086,1000087,1000086_to_1000087.jpg
147,1000086,1000088,1000086_to_1000088.jpg
148,1000088,1000086,1000088_to_1000086.jpg
149,1000078,1000079,1000078_to_1000079.jpg
150,1000079,1000078,1000079_to_1000078.jpg
151,1000079,1000090,1000079_to_1000090.jpg
152,1000091,1000079,1000091_to_1000079.jpg
153,1000090,1000089,1000090_to_1000089.jpg
154,1000092,1000066,1000092_to_1000066.jpg
155,1000091,1000093,1000091_to_1000093.jpg
156,1000093,1000091,1000093_to_1000091.jpg
157,1000089,1000067,1000089_to_1000067.jpg
158,1000089,1000090,1000089_to_1000090.jpg
159,1000079,1000080,1000079_to_1000080.jpg
160,1000080,1000079,1000080_to_1000079.jpg
161,1000080,1000081,1000080_to_1000081.jpg
162,1000082,1000068,1000082_to_1000068.jpg
163,1000081,1000080,1000081_to_1000080.jpg
164,1000077,1000063,1000077_to_1000063.jpg
165,1000063,1000077,1000063_to_1000077.jpg
166,1000063,1000047,1000063_to_1000047.jpg
167,1000047,1000063,1000047_to_1000063.jpg
168,1000047,1000039,1000047_to_1000039.jpg
169,1000039,1000047,1000039_to_1000047.jpg
170,1000039,1000011,1000039_to_1000011.jpg
171,1000011,1000039,1000011_to_1000039.jpg
172,1000078,1000077,1000078_to_1000077.jpg
173,1000079,1000091,1000079_to_1000091.jpg
174,1000080,1000082,1000080_to_1000082.jpg
175,1000082,1000080,1000082_to_1000080.jpg
176,1000086,1000085,1000086_to_1000085.jpg
177,1000088,1000086,1000088_to_1000086.jpg
178,1000087,1000086,1000087_to_1000086.jpg
179,1000088,1000075,1000088_to_1000075.jpg
180,1000090,1000091,1000090_to_1000091.jpg
181,1000091,1000090,1000091_to_1000090.jpg
182,1000091,1000092,1000091_to_1000092.jpg
183,1000092,1000091,1000092_to_1000091.jpg
184,1000065,1000066,1000065_to_1000066.jpg
185,1000072,1000057,1000072_to_1000057.jpg
186,1000072,1000083,1000072_to_1000083.jpg
187,1000075,1000060,1000075_to_1000060.jpg
188,1000075,1000088,1000075_to_1000088.jpg
189,1000024,1000005,1000024_to_1000005.jpg
190,1000005,1000024,1000005_to_1000024.jpg
191,1000005,1000030,1000005_to_1000030.jpg
192,1000030,1000005,1000030_to_1000005.jpg
193,1000006,1000004,1000006_to_1000004.jpg
194,1000008,1000033,1000008_to_1000033.jpg
195,1000015,1000042,1000015_to_1000042.jpg
196,1000017,1000043,1000017_to_1000043.jpg
197,1000023,1000026,1000023_to_1000026.jpg
198,1000025,1000035,1000025_to_1000035.jpg
199,1000034,1000040,1000034_to_1000040.jpg
200,1000026,1000023,1000026_to_1000023.jpg
201,1000026,1000052,1000026_to_1000052.jpg
202,1000041,1000038,1000041_to_1000038.jpg
203,1000046,1000039,1000046_to_1000039.jpg
204,1000048,1000049,1000048_to_1000049.jpg
205,1000051,1000052,1000051_to_1000052.jpg
206,1000051,1000053,1000051_to_1000053.jpg
207,1000052,1000026,1000052_to_1000026.jpg
208,1000052,1000067,1000052_to_1000067.jpg
209,1000052,1000051,1000052_to_1000051.jpg
210,1000053,1000065,1000053_to_1000065.jpg
211,1000054,1000050,1000054_to_1000050.jpg
212,1000054,1000055,1000054_to_1000055.jpg
213,1000055,1000068,1000055_to_1000068.jpg
214,1000055,1000033,1000055_to_1000033.jpg
215,1000055,1000054,1000055_to_1000054.jpg
216,1000057,1000040,1000057_to_1000040.jpg
217,1000057,1000072,1000057_to_1000072.jpg
218,1000059,1000042,1000059_to_1000042.jpg
219,1000060,1000043,1000060_to_1000043.jpg
220,1000060,1000075,1000060_to_1000075.jpg
221,1000018,1000044,1000018_to_1000044.jpg
222,1000044,1000018,1000044_to_1000018.jpg
223,1000044,1000061,1000044_to_1000061.jpg
224,1000061,1000044,1000061_to_1000044.jpg
225,1000061,1000076,1000061_to_1000076.jpg
226,1000076,1000061,1000076_to_1000061.jpg
227,1000076,1000086,1000076_to_1000086.jpg
228,1000086,1000076,1000086_to_1000076.jpg
229,1000068,1000055,1000068_to_1000055.jpg
230,1000068,1000082,1000068_to_1000082.jpg
231,1000043,1000060,1000043_to_1000060.jpg
232,1000065,1000064,1000065_to_1000064.jpg
233,1000066,1000065,1000066_to_1000065.jpg
234,1000066,1000092,1000066_to_1000092.jpg
235,1000067,1000052,1000067_to_1000052.jpg
236,1000067,1000089,1000067_to_1000089.jpg
237,1000071,1000073,1000071_to_1000073.jpg
238,1000073,1000071,1000073_to_1000071.jpg
239,1000046,1000038,1000046_to_1000038.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,0,0,0_to_0.jpg
,,,_to_.jpg
,,,_to_.jpg
```

### `data/cafeteria_edge.csv`

```csv
name,building,display_name
Sky_Terrace,10,スカイテラス
SUBWAY,10,サブウェイ

```

### `data/name.csv`

```csv
building,name,display_name

```

### `data/building_name.csv`

```csv
building,display_name

```

### `data/event.csv`

```csv
title,building,room,node_id,edge_id

```

### 10.6 補足: 付録から除外したファイルの扱い

#### `programs/html/navi/script/config.js`（Git管理外・機密のため実値は非掲載）

Cloudflare Pagesビルド時に `deploy_env/pages/build.sh` が環境変数 `GOOGLE_MAPS_API_KEY` から自動生成するファイル。構造は以下の通り（値はプレースホルダ）:

```javascript
const CONFIG = {
  GOOGLE_MAPS_API_KEY: "<GOOGLE_MAPS_API_KEY>"
};
```

#### `programs/html/blog/posts/` — ブログ記事一覧（Markdown原稿、本文は割愛）

`build.py` が `posts/*.md` を `posts/*.html` に変換し `posts.json` を生成する。2026-07-30時点の記事一覧:

| 日付 | タイトル（ファイル名より） |
|---|---|
| 2026-06-04 | welcome |
| 2026-06-04 | ひとりごと |
| 2026-06-05 | AIについての考え |
| 2026-06-07 | 矢印を作った話 |
| 2026-06-11 | 無線の話 |
| 2026-06-16 | ARに苦戦してる話 |
| 2026-06-19 | 外のデータを取るのが難しい件 |
| 2026-06-21 | 小杉プロの凄さに圧倒された。 |
| 2026-06-30 | Dockerに嫌われた。 |
| 2026-07-10 | 中間発表前の決意 |
| 2026-07-13 | 中間発表後のお話 |
| 2026-07-17 | Pagesに移行完了して今後の見通し |

`posts/template.md` に新規記事作成用のテンプレートがある。

#### バイナリ・生成物（内容は非掲載、パスのみ記録）

| パス | 内容 |
|---|---|
| `images/logo.png`, `images/プロジェクト構成図.png` | ロゴ・構成図 |
| `programs/html/svg/10_1F.svg`〜`10_6F.svg` | 10号館フロアマップSVG（6ファイル） |
| `programs/html/blog/images/01_01.png` | ブログ記事内画像 |
| `programs/Human_Remover/yolov8n-seg.pt` | YOLOv8セグメンテーション学習済みモデル（約6.7MB、Ultralytics配布の軽量モデル） |
| `deploy_env/nginx/errors/*.html`, `enviroments/nginx/errors/*.html` | 400/401/403/404/500/502/503/504 の汎用エラーページ（両ディレクトリで同一内容） |
| `**/__pycache__/`, `.DS_Store` | ビルド生成物・OS生成物 |

#### `.env` 実体・`deploy_env/k8s/secrets.yaml`

いずれも `.gitignore` 対象で実値はリポジトリに存在しない。雛形は `deploy_env/sample.env`（10.4節に収録）と `deploy_env/k8s/secrets.yaml.template`（同節に収録）を参照。
