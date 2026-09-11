# IKU NAVI — 教室検索ナビ UIバリエーション制作仕様書（navi1〜navi9）

## これは何か

IKU NAVI（専修大学 生田キャンパスのAR教室検索ナビ）には現在 `/navi/` という1つのUIしかない。
これと**全く同じ機能**を持ちながら、見た目・レイアウト・体験がそれぞれ異なるUIバリエーションを
`/navi1/` 〜 `/navi9/` として9パターン作る。どのデザインが実際に使いやすいかを比較検討するための
プロトタイプ群であり、最終的に本番採用するデザインを選ぶ材料にする。

あなたの仕事は、このうち**1つの番号（何番かは依頼者から指示される）**について、
`programs/html/navi{N}/index.html` を新規作成することです。中身は下記の「必須要素」を
すべて満たしつつ、見た目・レイアウト・配色・タイポグラフィ・モーション・情報の見せ方は
完全に自由に設計してください。既存の `/navi/` のデザイン（紙色×インク色×バーミリオンアクセントの
「駅の案内サイン」モチーフ、`programs/html/navi/style.css` 参照）とは明確に異なる、
あなた独自の方向性を打ち出すこと。

## ファイル構成のルール（重要）

- 作るファイルは **`programs/html/navi{N}/index.html` の1つだけ**。CSSは別ファイルに分けず
  `<style>` タグ内にすべて書く。JS用の別ディレクトリ・別ファイルも作らない。
- JSは既存の4ファイルを**そのまま**外部参照する（中身は一切変更しない・コピーしない・
  改造しない。相対パスで既存ファイルを参照するだけ）。読み込み順・配置は次の通り厳守:

  ```html
  <head>
    ...
    <script src="../navi/script/config.js"></script>
  </head>
  <body>
    ...（あなたのHTML）...

    <script src="../navi/script/app.js"></script>
    <script src="../navi/script/ar.js"></script>
    <script src="../navi/script/maps-loader.js"></script>
  </body>
  ```

  - `config.js` は Cloudflare Pages のビルド時に自動生成される（Google Maps APIキーを含む）。
    `programs/html/navi/script/config.js` にしか生成されないため、必ず `../navi/script/config.js`
    という相対パスで参照すること（コピーしても動かない）。
  - `app.js` がページの全ロジック（検索・経路計算・音声案内・SVGフロアマップ・写真AR）を持つ。
    `ar.js` は屋外AR（Three.js + GPS + ジャイロ）、`maps-loader.js` はGoogle Maps APIの読み込み。
- 画像・トップページへのリンクなど `../images/...` `../index.html` 形式の相対パスは、
  `navi{N}/` も `navi/` と同じ階層（`programs/html/` 直下）に置かれるのでそのまま使える。
- 外部ライブラリ（フォント等）を追加する場合は Google Fonts などCDN経由で `<link>` すればよい。

## 必須DOM要素（絶対に外せない契約）

`app.js`・`ar.js` は変更しない前提なので、以下の **ID** を持つ要素が実在しないと動作しません。
IDの綴りは1文字も変えられません。**配置場所・タグの種類（一部を除く）・見た目・親子構造・
DOM上の順序は完全に自由**です（`app.js` は基本的に `document.getElementById(id)` でしか
要素を探さないので、どこに置いても、どんな入れ子構造にしても構いません）。

### 検索パネル — 教室 → 教室

| ID | タグの目安 | 役割 |
|---|---|---|
| `search-toggle` | `<button>` | 検索パネルの開閉（`onclick="toggleSearchPanel()"`） |
| `search-chevron` | `<span>`等 | 開閉インジケータ（`.open`クラスが付け外しされる） |
| `search-content` | `<div>` | 検索パネル本体（`.open`クラスが付け外しされる） |
| `cat-room` | `<button>` | カテゴリタブ「教室」（`onclick="setCategory('room')"`） |
| `cat-facility` | `<button>` | カテゴリタブ「設備検索」（`onclick="setCategory('facility')"`） |
| `cat-content-room` | `<div>` | 教室カテゴリの中身コンテナ |
| `cat-content-facility` | `<div>` | 設備検索カテゴリの中身コンテナ |
| `tab-room` | `<button>` | モードタブ「教室→教室」（`onclick="setMode('room')"`） |
| `tab-gps` | `<button>` | モードタブ「現在地(屋外)→教室」（`onclick="setMode('gps')"`） |
| `panel-room` | `<div>` | 教室→教室モードの入力欄コンテナ |
| `panel-gps` | `<div>` | GPS→教室モードの入力欄コンテナ |
| `from-bldg` | `<select>` | 出発地の建物選択（`<option value="">全</option>` を含めること。他は自動追加） |
| `from-input` | `<input>` | 出発教室名の入力欄 |
| `from-sugg` | `<div>` | 出発教室のオートコンプリート候補を表示する要素（中身・`display`はJSが操作） |
| `to-bldg` | `<select>` | 目的地の建物選択（同上） |
| `to-input` | `<input>` | 目的教室名の入力欄 |
| `to-sugg` | `<div>` | 目的教室のオートコンプリート候補 |
| `gps-text` | `<span>`等 | GPS取得状況の表示テキスト |
| `accuracy-warn` | `<div>` | GPS精度が低い場合の警告（`.warn-low`/`.warn-high`クラスが付く） |
| `gps-to-bldg` | `<select>` | GPSモードでの目的地建物選択 |
| `to-input-gps` | `<input>` | GPSモードでの目的教室名入力欄 |
| `gps-to-sugg` | `<div>` | GPSモードのオートコンプリート候補 |
| `use-elevator` | `<input type="checkbox">` | エレベーター使用チェックボックス |
| `event-badge` | 任意要素 | イベントモード時のみ表示するバッジ（無くても動作に支障なし。`?event=1`パラメータ時に`display`をJSが変えようとする） |

検索実行ボタンは `onclick="doSearch()"` を持つ要素であればIDは不要（`<button onclick="doSearch()">経路を探す</button>` のように自由に書ける）。

**重要（ID表に無いが必須のクラス）**: `app.js` の `toggleSearchPanel()`/`collapseSearchPanel()` は
`document.querySelector(".search-content-inner")` で**クラス名から**要素を取得します（IDではない）。
検索パネルの中身を囲む要素のどこかに **`search-content-inner` というクラス**を必ず付けてください
（`#search-content`の直下である必要はなく、ページ内に1つあれば足ります）。付け忘れるとパネルの
開閉時にJSエラーで停止します。

### 検索パネル — 設備検索（トイレ・食堂）

| ID | タグの目安 | 役割 |
|---|---|---|
| `fac-tab-room` | `<button>` | モードタブ「教室→設備」（`onclick="setFacMode('room')"`） |
| `fac-tab-gps` | `<button>` | モードタブ「現在地(屋外)→設備」（`onclick="setFacMode('gps')"`） |
| `panel-fac-room` | `<div>` | 教室モードの入力欄コンテナ |
| `panel-fac-gps` | `<div>` | GPSモードの入力欄コンテナ |
| `fac-from-bldg` | `<select>` | 出発地の建物選択 |
| `fac-from-input` | `<input>` | 出発教室名入力欄 |
| `fac-from-sugg` | `<div>` | オートコンプリート候補 |
| `fac-gps-text` | `<span>`等 | GPS取得状況テキスト |
| `fac-accuracy-warn` | `<div>` | GPS精度警告 |
| `fac-category` | `<select>` | 設備種別（`<option value="toilet">トイレ</option>` `<option value="cafeteria">食堂</option>` を含める。`onchange="onFacCategoryChange()"`必須） |
| `fac-toilet-type` | `<select>` | トイレ種別（`<option value="all">全て</option> <option value="M">男子トイレ</option> <option value="F">女子トイレ</option> <option value="C">多目的トイレ</option>` を含める） |
| `fac-cafeteria-name` | `<select>` | 食堂名（`<option value="all">全て</option>` を含める。他はJSが自動追加） |
| `fac-use-elevator` | `<input type="checkbox">` | エレベーター使用チェックボックス |

検索実行ボタンは `onclick="doFacSearch()"` を持つ要素であればIDは不要。

### AR / カメラエリア

| ID | タグ | 役割 |
|---|---|---|
| `ar-area` | `<div>` | AR表示エリア全体のコンテナ（`position:relative`にして中の絶対配置要素の基準にする） |
| `ar-bg-video` | `<video autoplay playsinline muted>` | 屋外AR用のカメラ映像。`ar.js`が`style.display`を操作 |
| `ar-gl-canvas` | `<canvas>` | 屋外AR用のThree.js描画キャンバス |
| `ar-cache` | `<div>` | 経路写真の`<img class="ar-cached-img">`がJSによって動的に追加される入れ物 |
| `ar-placeholder` | `<div>` | 写真が無いとき・到着時に表示するプレースホルダ。内部に以下4つが必要 |
| `ar-placeholder` 内の `.ph-text` | 要素 | 「AR / Camera」等のプレースホルダ文言（class名 `ph-text` で参照される） |
| `ar-placeholder` 内の `.arrival-icon` | 要素 | 到着時アイコン（初期は非表示。JSが`style.display`と`#ar-placeholder`への`.arrival`クラス付与で切り替える） |
| `ar-placeholder` 内の `.arrival-title` | 要素 | 到着時タイトル文言 |
| `ar-placeholder` 内の `.arrival-desc` | 要素 | 到着時の説明文言 |
| `ar-label` | 要素 | 「進行方向」等のラベル（屋外ARで方位表示時に使用） |
| `direction-arrow` | `<img>` | 進行方向を示す矢印画像。`src`をJSが動的に設定する |
| `near-goal-badge` | 要素 | 最終区間で矢印の代わりに出す「目的地バッジ」。テキストはJSが動的に書き換える（`buildNearGoalText()`。「右手に目的地です」等） |
| `step-label` | 要素 | 現在のステップの案内文言 |
| `step-count` | 要素 | 「3 / 8」のようなステップ数表示 |
| `prev-btn` | `<button onclick="prevStep()">` | 前のステップへ |
| `next-btn` | `<button onclick="nextStep()">` | 次のステップへ |
| `voice-toggle-btn` | `<button onclick="toggleVoiceGuide()">` | 音声案内ON/OFF。ONのとき`.active`クラスが付く。**注意**: JSが`btn.textContent = "🔊"/"🔇"`のようにボタン内のテキストを毎回まるごと上書きするため、ボタンの中に自前のラベル文字（アイコン以外のテキスト等）を入れても消えてしまう。キャプションを付けたい場合はボタンの外側（隣接する`<span>`等）に置くこと |

### 地図・屋内SVGフロアマップ

| ID | タグ | 役割 |
|---|---|---|
| `map` | `<div>` | Google Maps がここに描画される（屋外ルート表示） |
| `svg-area` | `<div>` | 屋内SVGフロアマップのコンテナ（`display`をJSが操作。`position:relative`推奨） |
| `svg-container` | `<div>` | SVG本体が`innerHTML`で挿入される要素。JSが`querySelector("svg")`するので直下にSVGが入る |
| `floor-badge` | 要素 | 現在の階数バッジ |

### モーダル・ローディング

| ID | タグ | 役割 |
|---|---|---|
| `completion-modal` | `<div>` | 到着完了モーダル。`.show`クラスで表示/非表示（`onclick="closeCompletionModal()"`のボタンを中に置く） |
| `loading` | `<div>` | 検索中のローディングオーバーレイ。`.show`クラスで表示/非表示 |

## JSが自動的に付け外しするクラス名（CSSで見た目を定義するのはあなたの仕事）

`app.js`・`ar.js` は次のクラス名を `classList` で操作します。**クラス名自体は固定**なので、
それぞれの状態をどう見せるかはCSSで自由に設計してください（例: `.open`のとき`display:block`にする、
矢印を回転させる、アニメーションさせる、など）。

| クラス | 付く場所 | 意味 |
|---|---|---|
| `.open` | `#search-chevron`, `#search-content` | 検索パネルが開いている |
| `.active` | `.category-tab`要素, `.search-tab`要素 | 選択中のタブ（`category-tab`/`search-tab`というクラス自体は必須ではなく、あなたがタブ要素に付けたい任意のクラスでよい。JSは`getElementById`で個々のタブ要素を直接操作するため） |
| `.active` | `#voice-toggle-btn` | 音声案内ON |
| `.active` | `#ar-cache`内の`<img class="ar-cached-img">` | 現在表示すべき経路写真 |
| `.arrival` | `#ar-placeholder` | 到着間近（内部の`.arrival-icon`等と組み合わせて演出する） |
| `.show` | `#completion-modal`, `#loading` | 表示中 |
| `.warn-low` / `.warn-high` | `#accuracy-warn`, `#fac-accuracy-warn` | GPS精度警告のレベル |
| `event-mode` | `<body>` | `?event=1`のときのみ付く（イベントモード。対応は任意） |

## 動的に生成される要素（あらかじめHTMLに書く必要はない）

- `.item`: オートコンプリート候補の1件（`*-sugg`要素の中にJSが`<div class="item">`を追加する）
- `.ar-cached-img`: 経路写真（`#ar-cache`の中にJSが`<img>`を追加する。`object-fit:cover`推奨）
- `.dyn`: SVGフロアマップ上に描画される矢印・現在地マーカー等（`#svg-container`内のSVGの中にJSが追加する）
- `.err-box`: SVG読み込み失敗時に`#svg-container`に挿入されるエラー表示（中に`.err-title`/`.err-desc`/`.err-hint`）

これらは全部JSが`createElement`するので、あなたはこれらのクラスに対して**CSSだけ**書けば十分です
（要素自体をHTMLにあらかじめ用意する必要はありません）。

## 参考実装（現行の `/navi/`）

以下は現在実際に動いている `programs/html/navi/index.html` の全文です。このままコピーしても
一応動きますが、それでは「別のデザイン」になりません。**構造・配置・タグの種類は大胆に変えて
構わない**ので、上表のIDさえ満たせば自由に組み替えてください（例: サイドバー形式をやめてタブ切替に
する、検索を全画面モーダルにする、AR/地図/検索を1画面に収めずスワイプで切り替える、など）。

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>教室検索ナビ | IKU NAVI</title>
  <link rel="icon" href="../images/favicon.ico">
  <script src="script/config.js"></script>
</head>
<body>

<div id="sidebar">
  <div id="app-header">
    <a href="../index.html" class="hdr-title">IKU NAVI</a>
  </div>

  <div id="search-panel">
    <div id="search-header">
      <a id="btn-home" href="../index.html">⌂</a>
      <div class="category-tabs">
        <button class="category-tab active" id="cat-room" onclick="setCategory('room')">教室</button>
        <button class="category-tab" id="cat-facility" onclick="setCategory('facility')">設備検索</button>
      </div>
      <span id="event-badge">イベント</span>
      <button id="search-toggle" onclick="toggleSearchPanel()">
        <span id="search-chevron" class="open">▾</span>
      </button>
    </div>

    <div id="search-content" class="open">
      <div class="search-content-inner">

        <div id="cat-content-room">
          <div class="search-tabs">
            <button class="search-tab active" id="tab-room" onclick="setMode('room')">教室 → 教室</button>
            <button class="search-tab" id="tab-gps" onclick="setMode('gps')">現在地(屋外) → 教室</button>
          </div>

          <div id="panel-room">
            <div class="route-row">
              <span class="route-label">出発</span>
              <select class="building-select" id="from-bldg"><option value="">全</option></select>
              <div class="ac-wrap">
                <input id="from-input" placeholder="教室名" autocomplete="off">
                <div class="suggestions" id="from-sugg"></div>
              </div>
            </div>
            <button class="btn-swap" onclick="swapFromTo()">⇅</button>
            <div class="route-row">
              <span class="route-label">目的</span>
              <select class="building-select" id="to-bldg"><option value="">全</option></select>
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
              <select class="building-select" id="gps-to-bldg"><option value="">全</option></select>
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
        </div>

        <div id="cat-content-facility" style="display:none">
          <div class="search-tabs">
            <button class="search-tab active" id="fac-tab-room" onclick="setFacMode('room')">教室 → 設備</button>
            <button class="search-tab" id="fac-tab-gps" onclick="setFacMode('gps')">現在地(屋外) → 設備</button>
          </div>

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

          <div id="panel-fac-gps" style="display:none">
            <div class="gps-wrapper">
              <div class="gps-row">
                <span id="fac-gps-text">GPS未取得 — 右のボタンで現在地を取得</span>
                <button class="btn-gps" onclick="captureFacGPS()">取得</button>
              </div>
              <div id="fac-accuracy-warn"></div>
            </div>
          </div>

          <div class="route-row">
            <span class="route-label">目的</span>
            <select class="building-select" id="fac-category" onchange="onFacCategoryChange()">
              <option value="toilet">トイレ</option>
              <option value="cafeteria">食堂</option>
            </select>
            <select id="fac-toilet-type">
              <option value="all">全て</option>
              <option value="M">男子トイレ</option>
              <option value="F">女子トイレ</option>
              <option value="C">多目的トイレ</option>
            </select>
            <select id="fac-cafeteria-name" style="display:none;">
              <option value="all">全て</option>
            </select>
          </div>

          <div class="bottom-row">
            <label class="ev-label">
              <input type="checkbox" id="fac-use-elevator" checked>エレベーター使用
            </label>
            <button id="btn-fac-search" onclick="doFacSearch()">設備検索</button>
          </div>
        </div>

      </div>
    </div>
  </div>

  <div id="ar-area">
    <video id="ar-bg-video" autoplay playsinline muted></video>
    <canvas id="ar-gl-canvas"></canvas>
    <div id="ar-cache"></div>
    <div id="ar-placeholder">
      <div class="ph-text">AR / Camera</div>
      <div class="arrival-icon" style="display:none"></div>
      <div class="arrival-title" style="display:none">目的地周辺に到達しました！</div>
      <div class="arrival-desc" style="display:none">案内はここで終了です。<br>ご利用いただきありがとうございました。</div>
    </div>
    <div id="ar-label">進行方向</div>
    <img id="direction-arrow" src="" alt="方向矢印">
    <div id="near-goal-badge">この通路沿いが目的地周辺です</div>
    <div id="step-info">
      <div id="step-label">ルートを検索してください</div>
      <div id="step-count"></div>
    </div>
    <button class="nav-arrow" id="prev-btn" onclick="prevStep()" disabled>&#9664;</button>
    <button class="nav-arrow" id="next-btn" onclick="nextStep()" disabled>&#9654;</button>
    <button id="voice-toggle-btn" onclick="toggleVoiceGuide()">&#128264;</button>
  </div>
</div>

<div id="map-area">
  <div id="map"></div>
  <div id="svg-area">
    <div id="floor-badge"></div>
    <div id="svg-container"></div>
  </div>
</div>

<div id="completion-modal">
  <div id="completion-box">
    <div class="modal-icon">✓</div>
    <div class="modal-title">目的地に到着！</div>
    <p class="modal-desc">案内はここで終了です。<br>ご利用いただきありがとうございました。</p>
    <button class="modal-btn-continue" onclick="closeCompletionModal()">引き続きナビを使う</button>
  </div>
</div>

<div id="loading"><div id="loading-box">検索中...</div></div>

<script src="script/app.js"></script>
<script src="script/ar.js"></script>
<script src="script/maps-loader.js"></script>
</body>
</html>
```

（このコードは `navi/` のもので、あなたが作るのは `navi{N}/` なのでJSのパスは
`script/app.js` ではなく `../navi/script/app.js` に変える必要があります。）

## デザインの方向性について

「シンプル」「使いやすさ重視」「派手め」のような方向性は既に他の担当者がカバーしている
可能性が高いので、**自分の番号のために独自のコンセプトを考えてください**。決める際は:

- 対象は「専修大学生田キャンパスに来た学生・来訪者がスマホで教室を探す」という具体的な
  利用シーン。派手にするにしても機能面（文字の読みやすさ、ボタンの押しやすさ、AR映像の
  視認性）を犠牲にしないこと。
- 配色・タイポグラフィ・レイアウトは既存の「駅の案内サイン」モチーフと被らない、かつ
  AIが生成しがちなテンプレート的パターン（暖色クリーム背景+セリフ体の見出し+テラコッタの
  アクセント、真っ黒背景+単色ネオン、SaaS的な均一な角丸カード+薄い影、全部にALL CAPS
  ラベルを付ける、など）に逃げずに、あなたなりの具体的な理由づけのある選択をすること。
- モバイル幅（375px程度）でも実用に耐えるレスポンシブ対応を必ず行う（このナビは主にスマホで
  使われる）。`@media (min-width: 768px)` 以上でデスクトップ向けレイアウトに切り替える、
  という現行と同じブレークポイントの考え方を踏襲してよい。

## 動作確認チェックリスト

実装後、`python -m http.server 8080` などで `programs/html/` を配信し、
`http://localhost:8080/navi{N}/` で以下を確認してください（Google Maps APIキー・カメラ権限が
無い環境では地図/AR自体は動かないことがありますが、それ以外は確認できます）:

- [ ] 「教室」カテゴリタブと「設備検索」カテゴリタブを切り替えられる
- [ ] 「教室→教室」と「現在地(屋外)→教室」のモードタブを切り替えられる
- [ ] 出発・目的の教室名入力欄にオートコンプリート候補が出る（`allRooms`読み込み後）
- [ ] 「ルート検索」ボタンを押すとローディング表示が出て、経路が計算される
      （実際のAPI呼び出しが必要。ローカルでは `programs/3D_Graph/app.py` を起動していれば動く）
- [ ] 経路計算後、前へ/次へボタンでステップを移動できる
- [ ] 音声案内トグルボタンのON/OFFが切り替わる（見た目が変わる）
- [ ] 設備検索で「トイレ」「食堂」を切り替えられ、トイレ種別セレクトの表示/非表示が連動する
- [ ] エレベーター使用チェックボックスが機能する
- [ ] ブラウザのコンソールにJSエラーが出ていない

以上を満たした上で、`programs/html/navi{N}/index.html` として保存してください。
