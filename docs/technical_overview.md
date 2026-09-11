# 技術説明書 — SenARMap 2026

> 作成: 2026-06-02 / 最終更新: 2026-09-11

---

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [システム全体構成](#2-システム全体構成)
3. [バックエンド](#3-バックエンド)
4. [フロントエンド](#4-フロントエンド)
5. [データ構造](#5-データ構造)
6. [CDN](#6-cdn)
7. [インフラ・デプロイ](#7-インフラデプロイ)
8. [経路探索アルゴリズム](#8-経路探索アルゴリズム)
9. [AR 実装](#9-ar-実装)

---

## 1. プロジェクト概要

大学構内を対象にした AR 対応ナビゲーション Web アプリ。  
屋外は Google Maps、屋内は SVG フロアマップでルートを表示し、スマートフォンの GPS と組み合わせてステップ ナビゲーションを行う。  
AR 領域にはエッジ間の経路写真（CDN 配信）を表示する。

---

## 2. システム全体構成

![プロジェクトロゴ](../images/プロジェクト構成図.png)

---

## 3. バックエンド

### 言語・フレームワーク

| 項目 | 内容 |
|------|------|
| 言語 | Python 3 |
| Web フレームワーク | Flask |
| WSGI サーバー | Gunicorn (`-w 4`) — 平常時 2レプリカ × 4 = 8並列 |
| エントリポイント | `programs/3D_Graph/app.py` |

### 主なライブラリ

| ライブラリ | 用途 |
|-----------|------|
| `pandas` | CSV 読み込み・データ整形 |
| `networkx` | グラフ構築・Dijkstra 経路探索 |
| `Flask` | REST API サーバー |
| `gunicorn` | 本番 WSGI サーバー |
| `plotly` / `pyvis` | 3D グラフビューア（`/3d/` パス） |

### API エンドポイント一覧

| エンドポイント | 概要 |
|--------------|------|
| `GET /api/all` | 全教室・全ノード・建物一覧を一括取得（フロントの初期化用） |
| `GET /api/rooms` | 教室一覧（`building`・`q` でフィルタ可） |
| `GET /api/route` | 統合経路探索（教室名・ノード ID・イベント名で出発/目的を指定） |
| `GET /api/navigate_to_room` | 教室→教室の経路探索（後方互換エンドポイント） |
| `GET /api/events` | イベントモード（`event.csv`）の登録イベント一覧 |
| `GET /api/nearest_toilet` | 最寄りトイレへの経路探索（M/F/C/ALL） |
| `GET /api/nearest_cafeteria` | 最寄り食堂への経路探索（`name` 指定または全食堂から最短） |
| `GET /api/cafeterias` | 登録済み食堂一覧（フロントの食堂ドロップダウン初期化用） |
| `GET /api/shortest_path` | ノード ID 直指定の経路探索 |
| `GET /api/graph` | 3D ビューア用全グラフデータ |
| `GET /api/edge_images` | エッジ→画像 URL マッピング（CDN URL を返す） |

詳細なリクエスト/レスポンス仕様は [`API_Destination.md`](./API_Destination.md) を参照。

### キャッシュ

起動後の初回リクエスト時に CSV をすべてロードしてメモリにキャッシュする（モジュールレベルのグローバル変数）。  
エレベーター有り/無しのグラフを別々にキャッシュし、切り替えコストをゼロにしている。  
**CSV を更新した場合はコンテナ（gunicorn）を再起動しないと反映されない**点に注意。

```
_cached_nodes_df           — pandas DataFrame
_cached_edges_df           — pandas DataFrame
_cached_graph_with_ev      — networkx.DiGraph（エレベーターあり）
_cached_graph_without_ev   — networkx.DiGraph（エレベーターなし）
```

---

## 4. フロントエンド

### 言語・ライブラリ

| 項目 | 内容 |
|------|------|
| 言語 | HTML / CSS / Vanilla JavaScript（フレームワークなし） |
| マップ | Google Maps JavaScript API（CDN 経由） |
| SVG マップ | インライン SVG（`/svg/{建物}_{階}F.svg` を `fetch` してインジェクト） |
| API キー | `programs/html/navi/script/config.js` に `CONFIG.GOOGLE_MAPS_API_KEY` として記述（Git 管理外。本番は nginx の entrypoint が環境変数から生成） |

### Google Maps CDN の読み込み方法

フレームワークを使わず、JS でスクリプトタグを動的生成して読み込んでいる。  
`CONFIG.GOOGLE_MAPS_API_KEY` は `config.js` から取得するため、HTML に API キーをハードコードしない。

```javascript
const _ms = document.createElement("script");
_ms.src   = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.GOOGLE_MAPS_API_KEY}&callback=initMap`;
_ms.async = true;
_ms.defer = true;
document.body.appendChild(_ms);
```

### レスポンシブレイアウト

| ブレークポイント | レイアウト |
|----------------|-----------|
| `< 768px`（スマートフォン） | 縦積み：検索パネル → マップ → ナビバー → AR 領域 |
| `>= 768px`（PC・タブレット） | 2カラム：左サイドバー 340px（検索 + ナビ + AR）/ 右マップ全高 |

モバイルでは `#sidebar` に `display: contents` を適用して CSS フレックスの `order` でレイアウトを制御。  
PC では `#sidebar` が通常の `display: flex` に切り替わる。

### 屋内/屋外の自動切り替え

`pathCoords` の各ノードの `building` フィールドで判定する。

- `building === 0` → 屋外 → Google Maps を表示、マーカーを配置、行き先方向に `map.setHeading()` で地図を回転
- `building !== 0` → 屋内 → SVG フロアマップを表示、Dijkstra パスをオーバーレイ描画

### 経路ナビゲーション UI

- 左右矢印ボタンでステップ単位に移動
- SVG マップ：灰色のベースルート → 現在地まで青でハイライト → 赤い三角矢印で進行方向を表示
- Google Maps：行き先方向の方位角（`bearingDeg` 関数）を計算して `setHeading()` に渡す
- SVG の viewBox はルートの範囲から自動計算したウィンドウサイズで `panSvgTo()` によりスクロール追従

### 音声案内

`programs/html/navi/script/app.js` に実装。バックエンドの変更なしに Web Speech API（`SpeechSynthesisUtterance`）をそのまま利用する。

- ON/OFF は AR 画面右下のボタン（`toggleVoiceGuide()`）で切り替え、`localStorage`（キー `navi_voice_guide`）に保存される。次回起動時も設定を維持する。
- 読み上げ文は `buildStepAnnouncement(step)` が `path_edges[step]`（区間の `type`・`length`・`name`・`right`/`left`）と `calcTurnDirection(step)` の右左折判定から組み立てる。
- 文面は「グライスの協調の原理」の4公理（量・質・関係・様態）に沿うよう設計されており、以下は読み上げを省略する:
  - 距離が `ANNOUNCE_DISTANCE_THRESHOLD_M`（10m）未満の直進（曲がる場合は方向だけ案内し、距離は省く）
  - `type 7`（屋内外の連結エッジ、距離0）
  - 階段・エレベーター・エスカレーター（`type 2/3/4/5/6`）が複数区間に連続する場合の2区間目以降（最初の区間でのみ「○階まで上がって/下りてください」を案内）
- 直進は「まっすぐ」を言わず「〇〇メートル直進です」の形で読み上げる。
- `edge.right`/`edge.left`（`edge.csv` の任意列、;区切りの先頭要素を使用）が設定されている区間では、`buildSidePhrase()` が「右手に101教室、左手に102教室があります」のような一言を距離・右左折案内に続けて読み上げる。どちらも未設定（現状ほとんどの建物）の場合は空文字を返し、この一言を追加しない従来通りの文面になる。距離が `ANNOUNCE_DISTANCE_THRESHOLD_M` 未満で通常は省略される短い直進区間でも、`right`/`left` が設定されていればその一言だけは読み上げる。

### カスタムオートコンプリート

`datalist` は使わず、`<div class="suggestions">` による独自ドロップダウンを実装。  
`mousedown` + `e.preventDefault()` で `blur` より先に選択イベントを処理し、クリックが無効になるバグを回避している。

### GPS

`navigator.geolocation.getCurrentPosition` で取得。精度（`accuracy`）が 30m を超えた場合は案内板を参照するよう警告を表示する。GPS 取得後は最近傍の屋外ノードを Haversine 距離で探索し、`from_node` パラメータとして API に渡す。最寄りノードが **500m**（`MAX_GPS_NODE_DIST_M`）より遠い場合はキャンパス外とみなし、出発ノードとして採用しない。

---

## 5. データ構造

### ノード ID の体系

```
屋内ノード  = building_id × 100,000 + local_id
屋外ノード  = local_id + 9,000,000
```

### node.csv（建物ごと）

| カラム | 説明 |
|--------|------|
| `id` | ローカル ID（ロード時にグローバル ID へ変換） |
| `x, y, z` | 建物ローカル座標（メートル） |
| `building` | 建物 ID |
| `floor` | 階数 |
| `type` | ノード種別（1: 通路, 2: エントランス など） |
| `svg_x, svg_y` | SVG フロアマップ上のピクセル座標 |

### global_node.csv（屋外）

| カラム | 説明 |
|--------|------|
| `id` | 屋外ノード ID（ローカル） |
| `x, y, z` | グローバル座標 |
| `lat, lng` | GPS 座標（WGS84） |
| `floor, type` | 屋外ノードは `floor=0`、`building=0` として扱う |

### edge.csv（建物ごと）

| カラム | 説明 |
|--------|------|
| `id` | エッジ ID |
| `name` | 教室名（複数の場合は `;` 区切り）、空欄は通路 |
| `right`, `left` | 進行方向に対して右側・左側にある教室名（`;` 区切り、任意）。`name` の並び順には依存しない独立した列で、無ければ空文字として扱われる（どの建物の CSV にも未入力でも動作に影響しない） |
| `from, to` | 接続ノード ID |
| `building, floor` | 所属建物・階 |
| `weight` | 探索コスト係数 |
| `length` | 実距離（メートル）。コスト = `weight × length` |
| `type` | エッジ種別（下表参照） |

### エッジ種別

| type | 意味 | 方向性 |
|------|------|--------|
| 1 | 通常通路 | 双方向 |
| 2 | 階段 | 双方向 |
| 3 | エスカレーター（上下双方向・停止中扱い） | 双方向 |
| 4 | エレベーター | 双方向（`use_elevator=0` で除外） |
| 5 | 上りエスカレーター | 一方向（Z 低→高） |
| 6 | 下りエスカレーター | 一方向（Z 高→低） |
| 7 | 入口（屋内外接続、`anchors.csv` から自動生成） | 双方向（コストに入口ペナルティ +50 を加算） |

全種別の一覧とデータ入力仕様は [`XYZ_Design.md`](./XYZ_Design.md) を参照。

### 座標系の変換

各建物のローカル座標は `anchors.csv` の 2 点アンカーから回転角 θ と平行移動量 (tx, ty, tz) を自動計算し、グローバル座標系に変換する。1 点アンカーの場合は `buildings.json` の `rot_deg` を使用。

```
X_global = cos(θ)·X_local - sin(θ)·Y_local + tx
Y_global = sin(θ)·X_local + cos(θ)·Y_local + ty
Z_global = Z_local + tz
```

### edge_image.csv

| カラム | 説明 |
|--------|------|
| `id` | 行 ID |
| `from, to` | エッジの両端ノード ID |
| `image_name` | CDN 上の画像ファイル名（例: `1000001_to_1000002.jpg`） |

### cafeteria_edge.csv

| カラム | 説明 |
|--------|------|
| `name` | 食堂の識別名（`edge.csv` の `name` フィールドと一致させる） |
| `building` | 所属建物 ID |
| `display_name` | UI 表示用の日本語名 |

---

## 6. CDN

| 項目 | 内容 |
|------|------|
| ベース URL | `https://cdn.iku-navi.net` |
| 用途 | エッジ間の経路画像（JPG）の配信 |
| 参照方法 | バックエンドの `GET /api/edge_images` がキー `"fromId_toId"` → URL のマッピングを返す。フロントエンドはこれを受け取り、現在のステップに対応する画像を AR 領域に表示する。 |
| アップロード管理 | `data/edge_image.csv` に `from`, `to`, `image_name` を記載して管理 |

CDN の URL は `app.py` の `CDN_BASE` 定数で一元管理している。

```python
CDN_BASE = "https://cdn.iku-navi.net"
```

---

## 7. インフラ・デプロイ

### Docker Swarm 構成（`deploy_env/docker-compose.yml`）

本番は Docker Swarm で運用。平常時は 2GB VPS 1台、イベント時に 4GB サーバーをワーカーとして追加する。

```
[外部]
  Cloudflare → cloudflared (Swarm: manager固定)
                    ↓
              nginx (Swarm: manager固定)
              ├── /api/*, /3d/*  → python × 2レプリカ（gunicorn -w 4）
              └── /redirect/*    → counter × 2レプリカ
                                        ↓
                                   db (MariaDB, manager固定)

[監視]
  cadvisor (global: 全ノード) → prometheus (manager固定) → grafana (manager固定)
```

| サービス | 役割 | 配置 |
|---------|------|------|
| nginx | リバースプロキシ・静的ファイル配信 | manager固定 |
| python | Flask + Gunicorn | 全ノード分散（2→4レプリカ） |
| counter | アクセスカウンター（Rails） | 全ノード分散（2→4レプリカ） |
| db | MariaDB 11 | manager固定（ボリュームあり） |
| cloudflared | Cloudflare Tunnel | manager固定 |
| prometheus | メトリクス収集（dockerswarm_sd） | manager固定 |
| grafana | 監視ダッシュボード | manager固定 |
| cadvisor | コンテナリソース監視 | global（全ノード自動展開） |

詳細な運用手順は [`swarm.md`](./swarm.md) を参照。

### Nginx の役割

- TLS 終端は Cloudflare 側で処理（cloudflared 経由）
- 静的ファイル配信：`/` → `/project/programs/html/` を `try_files` で提供
- API・3D プロキシ：`/api/*` `/3d/*` → `http://python:8000` へ転送
- カスタムエラーページ：400/401/403/404/500/502/503/504

### Cloudflare Tunnel

`TUNNEL_TOKEN` を `.env` に設定するだけで外部からのアクセスが可能になる。  
ポートを直接インターネットに公開しないため、ファイアウォール設定が不要。

```
# deploy_env/.env
TUNNEL_TOKEN=<Cloudflare Tunnel のトークン>
```

### ローカル開発環境

`enviroments/` ディレクトリに開発用の Docker 構成がある（`deploy_env/` は本番用）。  
Flask を直接起動する場合はポート 5001 を使用する。

```bash
cd programs/3D_Graph
python app.py   # localhost:5001 で起動
```

---

## 8. 経路探索アルゴリズム

### グラフ構造

NetworkX の `DiGraph`（有向グラフ）を使用。  
エスカレーターは一方向エッジのみ追加。それ以外のエッジは順・逆の 2 方向を追加することで無向グラフと等価に扱う。

### Dijkstra（双方向）

経路探索には `networkx.bidirectional_dijkstra` を使用。  
エッジのコストは `weight × length`（係数 × 実距離メートル）で定義される。

教室はノードではなくエッジの属性として管理されているため、教室に対応するエッジの両端ノード（from/to）を候補として全組み合わせを探索し、最短のものを採用する。

```
candidates = [
  (from_node_A, from_node_B),   ← 出発教室エッジの両端
  ...
] × [
  (to_node_X, to_node_Y),       ← 目的教室エッジの両端
  ...
]
→ 全組み合わせで bidirectional_dijkstra → 最短パスを採用
```

### 屋内-屋外の接続

`anchors.csv` に記録されたアンカーポイントをもとに、屋内ノードと屋外ノードを繋ぐエッジを自動生成する。これにより建物をまたぐ経路を 1 つのグラフで探索できる。

### 経路探索結果（`path_edges`）

`_path_result()`（`app.py`）が組み立てる経路探索系 API のレスポンスには、`path_coords`（ノード列）に加えて `path_edges`（区間列）が含まれる。フロントエンドの音声案内・矢印表示はこの `path_edges` を1歩ずつ処理して作られる。

| フィールド | 説明 |
|-----------|------|
| `from, to` | 区間の両端ノード ID |
| `name` | 区間に面する教室名（`;` 区切り） |
| `right, left` | 進行方向右側・左側の教室名（`edge.csv` の `right`/`left` 列。無ければ空文字） |
| `length` | 実距離（メートル） |
| `type` | 区間種別（エッジ種別の値と同じ。通路・階段・エレベーター等の区別に使う） |
| `x0, y0, z0` / `x1, y1, z1` | 区間両端の座標 |

---

## 9. AR 実装

### 9.1 2 段階の AR

ナビゲーション中の AR 表示は、ステップのノードが屋内か屋外かで自動切り替えされる。

| モード | 条件 | 実装手法 |
|--------|------|---------|
| 屋内 AR | `node.building !== 0` | CDN から取得した経路写真 + 方向矢印オーバーレイ |
| 屋外 AR | `node.building === 0` かつ `lat/lng` 保持 | Three.js + リアカメラ映像 + GPS + ジャイロ |

切り替えは `updateRouteImage(step)` 内で判定し、屋外時は `arShowView()` / 屋内復帰時は `arHideView()` を呼ぶ。

#### カメラ・GPS のライフサイクル（プライバシー・バッテリー対策）

- **取得**: カメラはルート確定時の `arPrefetchCameraIfNeeded()` で、**ルートに屋外 AR 区間が含まれる場合のみ**先取りする。屋内のみのルートではカメラを一切起動しない。GPS の `watchPosition` は屋外 AR 表示時（`arShowView()`）に開始する。
- **保持**: 屋外→屋内→屋外と続くルートの途中ではストリームを保持し、シームレスに切り替える。
- **解放**: ステップ移動のたびに `releaseArIfUnneeded(step)` が「現在以降に AR を使う屋外区間が残っているか」を判定し、残っていなければ `arReleaseHardware()` でカメラストリーム停止（`track.stop()`）と `clearWatch` を行う。再び屋外区間に入れば `arShowView()` が取得し直す（許可ダイアログは再表示されない）。

---

### 9.2 屋内 AR — 経路写真 + 矢印オーバーレイ

#### 事前プリフェッチ

ルート確定直後に `prefetchRouteImages(coords)` が呼ばれ、全ステップ分の `<img>` を一括生成して `#ar-cache` コンテナに積む。

```javascript
// edgeImages = { "fromId_toId": "https://cdn.iku-navi.net/..." }
const url = edgeImages[`${coords[i].id}_${coords[i + 1].id}`];
const img = document.createElement("img");
img.src = url;          // ← ここで HTTP リクエストが発火（ブラウザキャッシュに乗る）
img.className = "ar-cached-img";
container.appendChild(img);
imgByStep[i] = img;
```

`DOM に積むだけ`で `img.src` に値をセットした瞬間ブラウザがダウンロードを開始するため、ステップ進行時の表示遅延がない。

#### 表示切り替え

ステップ移動時に `active` クラスを付け替えるだけで済む（DOM の生成・削除なし）：

```javascript
Object.values(imgByStep).forEach(img => img.classList.remove("active"));
imgByStep[step].classList.add("active");
```

#### 方向矢印

`#ar-area` 上に `position: absolute` で重畳した `<img id="direction-arrow">` に `ARROW_URL[dir]` を設定。`dir` は `"left"` / `"right"` / `"straight"` の3種で、折れ角が `STRAIGHT_THRESHOLD_DEG`（±45°）以内なら直進とみなす。矢印画像はページ読み込み時に blob URL としてプリフェッチされる。

---

### 9.3 屋外 AR — Three.js + GPS + ジャイロ

`navi/index.html` の 2 番目の `<script>` タグ（`AR Outdoor Integration` ブロック）に実装されている。

#### レイヤー構成

```
┌─────────────────────────────────────────┐
│  HUD（ステップ情報・ナビバー）  z-index 高  │
├─────────────────────────────────────────┤
│  <canvas>  Three.js WebGLRenderer       │
│  alpha: true で透過（AR オーバーレイ）    │
├─────────────────────────────────────────┤
│  <video>   リアカメラ映像（背景）         │
└─────────────────────────────────────────┘
```

#### 座標系（ENU 右手系）

```
+X = 東  /  +Y = 上  /  −Z = 北
```

緯度経度 → Three.js 座標（基準点 `refLat/refLng` からの相対オフセット）：

```
north_m = (lat − refLat) × 111,320
east_m  = (lng − refLng) × 111,320 × cos(refLat × π/180)

Three.js: x = east_m,  z = −north_m
```

#### ノード・エッジの描画

| 要素 | 形状 | 色 |
|------|------|----|
| 屋外ノード | `SphereGeometry` (r=0.5m) | `#22D3EE`（シアン） |
| 屋外エッジ | `CylinderGeometry` (r=0.12m) | `#3B82F6`（ブルー） |
| ノードラベル | `THREE.Sprite`（Canvas テクスチャ）| 白文字・半透明黒背景 |

`worldGroup`（`THREE.Group`）にノード・エッジをまとめ、GPS 更新時に `worldGroup.position` を動かすことで現在地を常に原点とする相対配置を実現している。

#### 向きセンサー処理

端末・OS によって利用できるイベントが異なる。優先順位は下表の通り：

| 優先度 | イベント / プロパティ | 対応環境 | 特徴 |
|:------:|---------------------|----------|------|
| 1 | `deviceorientationabsolute` | Android Chrome | 北基準の絶対方位。`alpha` がそのままヨー角 |
| 2 | `webkitCompassHeading` | iOS Safari | 北基準・時計回り（0=北）。式で `360 − heading` に変換 |
| 3 | `e.alpha`（`deviceorientation`） | Android その他 | 相対方位（起動時を 0 とするため精度が低い） |

カメラ Quaternion 変換（旧 `THREE.DeviceOrientationControls` と同じ式）：

```javascript
_euler.set(beta, alpha, -gamma, "YXZ");
q.setFromEuler(_euler);
q.multiply(_q1);                                    // -90° around X
q.multiply(_q0.setFromAxisAngle(_zee, -orient));    // 画面の回転補正
```

#### iOS 13+ のセンサー許可

`DeviceOrientationEvent.requestPermission()` はユーザー操作コンテキスト（タップイベントのコールスタック内）でしか呼べない。`navi/index.html` では検索ボタン押下時の `arRequestPermissionsEarly()` で先取りリクエストし、実際に屋外 AR が起動するタイミングでのダイアログをなくしている。

---

### 9.4 スタンドアロン AR ページ（廃止）

動作検証用のスタンドアロン AR ページ `ar.html`（A-Frame + AR.js）と `ar-outdoor.html`（Three.js 単体版）は、検証完了に伴い削除した。屋外 AR は `navi/index.html` 内の統合実装（§9.3）のみが実運用機能である。必要になった場合は Git 履歴から復元できる。
