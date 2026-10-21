# 埋め込みマップ（/embed/）

他のサイト・ブログ・学内システムに、IKU NAVI のフロアマップや道順を iframe で載せるための仕組み。
Google マップの埋め込みと同じように、URL だけで表示する内容が決まる。AR・カメラ・GPS は使わない。

- 埋め込み用の画面: `https://iku-navi.net/embed/?...`（`programs/html/embed/`）
- コードを作るページ: `https://iku-navi.net/embed/builder/`（選ぶと iframe のコードと見本が出る）

```html
<iframe src="https://iku-navi.net/embed/?from=10301&to=131&to_bldg=1"
        title="10301教室から131教室への道順（IKU NAVI）"
        width="100%" style="border:0;width:100%;aspect-ratio:4/3" loading="lazy" allow="fullscreen"></iframe>
```

## 表示できるもの

| 表示 | パラメータ | 例 | 画面 |
|---|---|---|---|
| 場所 | `room`・`edge`・`node` のどれか（＋`bldg`・`label`） | `?room=10301` `?room=M_Toilet&bldg=10` `?edge=74&bldg=10&label=受付` | 場所のある階のフロアマップに、位置のピン（通路なら通路も薄く塗る）。階は切り替えられる。屋外の通路・地点は方眼の上に出す |
| 道順 | 出発地 `from_*` と目的地 `to_*`（下の「場所の指定」） | `?from=10301&to=131&to_bldg=1` `?from=811&to_edge=12&to_bldg=10&to_label=受付` | 経路を「同じ建物の同じ階にいる間」ごとの区間に分け、1区間ずつ見せる |
| フロアマップ | `bldg`（＋`floor`） | `?bldg=10&floor=3` | その階のフロアマップだけ。`floor` を省くと1階（無ければ一番下の階） |

### 場所の指定

場所・出発地・目的地は同じ書き方。出発地は頭に `from_`、目的地は `to_` を付ける（教室名だけは `from`・`to` そのままでもよい）。

| 指定 | 場所 | 出発地 | 目的地 | 中身 |
|---|---|---|---|---|
| 名前 | `room` | `from`（`from_room`） | `to`（`to_room`） | 教室名。教室検索と同じ書き方で、API用の名前（`10301`）でも表示名（`10301教室`）でもよい。トイレ（`M_Toilet`・`F_Toilet`・`C_Toilet`）・食堂・ignore.csv の名前など、教室一覧に出ない名前も指定できる |
| 通路 | `edge` | `from_edge` | `to_edge` | edge.csv の id（＋号館）。号館を付けずにグローバルなエッジID（建物 × 100000 ＋ id）でもよい |
| 地点 | `node` | `from_node` | `to_node` | node.csv の id（＋号館）。号館を付けずにグローバルなノードIDでもよい（屋外は 9000000 ＋ id） |
| 展示 | – | `from_event` | `to_event` | イベントの展示名（event.csv に id 列があるブランチでは id でも） |
| 号館 | `bldg` | `from_bldg` | `to_bldg` | 号館の番号（`building` でもよい）。屋外は 0。名前が1つの号館にしか無ければ省ける |
| 名前 | `label` | `from_label` | `to_label` | ピンや見出しに出す名前を変える（「受付」など、名前の無い通路に名前を付けたいとき） |

- id は IKU NAVI ツールのマップ編集で見られる番号（CSV の id）。100000 以上の数はグローバルなIDとみなす
- 名前の付いていない通路・地点は「指定した通路」「指定した地点」と出るので、`label` を付けるとよい
- 通路を目的地にすると、名前が1つだけの通路（トイレなど）はその名前で案内する。複数の教室が面する通路では「この通路沿いが目的地です」
- 優先順: 出発地と目的地の両方がある → 道順 / 場所（`room`・`edge`・`node`）か、出発地の無い目的地 → 場所 / `bldg` → フロアマップ

共通のパラメータ:

| パラメータ | 意味 |
|---|---|
| `elevator=0` | エレベーターを使わない道順にする（道順のみ） |
| `header=0` | 上の帯（建物名・「IKU NAVI で開く」）を出さない |
| `floors=0` | 階の切り替えボタンを出さない（場所・フロアマップ） |

## 大きさとスマートフォン

iframe の大きさは自由。中身は枠の大きさに合わせて組み替わる。

- 地図の線の太さ・ピンや丸の大きさ・文字は、拡大縮小や枠の大きさにかかわらず画面上で同じ大きさ（線は `vector-effect: non-scaling-stroke`、印は表示範囲が変わるたびに倍率を掛け直す）
- 最初に見せる範囲は、印が枠の端で切れないよう画面上の px で余白を取る。枠の大きさが変わったら（画面の回転など）、見ていた中心と縮尺を保って合わせ直す
- ふつう（スマホの幅を含む）: 地図の下に道順の帯（◀ 区間 ▶）。帯は左右にスワイプしても切り替えられる
- 横に広い枠（幅 720px 以上・高さ 380px 以上）: 地図の右に全区間の一覧。押すとその区間へ
- 低い枠（高さ 300px 以下）: 帯を1行に詰め、階のボタンを横に並べ、－と枠のボタンを隠す。高さ 220px 以下では上の帯も隠す
- 幅 380px 以下: 「IKU NAVI で開く」を「開く」に縮める
- 指で操作する端末（`pointer: coarse`）: ボタンを 44px に
- 直接開いたとき（スマホのブラウザなど）: ノッチなどを避ける（`viewport-fit=cover` と `env(safe-area-inset-*)`）
- 埋め込みコードを作るページでは、大きさに「横幅に合わせる（4:3・16:9・縦長 3:4）」も選べる（`style="width:100%;aspect-ratio:4/3"`。親ページの幅に合わせて縮む）

## 道順の区間

`embed/core.js` の `splitRouteSegments` が `/api/route` の `path_coords` を区間に分ける。

- 建物（`building`）か階（`floor`）が変わるところで区切る。屋外（`building=0`）は1つの区間
- 階段・エレベーター・エスカレーターで何階も移るとき、途中の階を1点だけ通る区間は飛ばす
- 区間の下の帯に「何番目／全部で何区間」「10号館 3階」「約40m」と、その区間を歩き終えたらすること
  （「階段で1階へ」「入口から外へ出ます」「1号館の入口へ」、最後の区間は「131教室は右手、130教室から数えて2番目です」）を出す。
  到着の文はナビ画面（`navi/script/voice.js` の `buildNearGoalText`）と同じ言い方
- 屋内の区間はフロアマップに経路の線（朱）・区間の出発点（白丸）・終点（紺丸）・目的地のピンを描く。
  同じ階を別の区間でも通るときは、その部分を点線で薄く出す
- 屋外の区間はフロアマップが無いので、緯度経度から北を上にした経路の形だけを方眼の上に描く

フロアマップ上の位置は、ノードの `svg_x`・`svg_y`（node.csv）を使う。これがまだ入っていない建物
（2026-10-17 時点で 1・3・4・9号館）は、フロアマップは出すが線やピンは描けないので、地図の上に注記を出す。

## 地図の操作

- ＋ / － / 照準のボタンで拡大・縮小・最初の範囲に戻す。キーボードの ＋ / － でも拡大縮小、← → で道順の区間を切り替える
- ダブルクリック・ダブルタップで、その場所を中心に拡大（Shift＋ダブルクリックで縮小）
- 埋め込み（iframe の中）では、ページのスクロールを邪魔しないよう、Google マップと同じく
  1本指のスワイプとホイールはページに渡す。2本指・Ctrl＋ホイール（トラックパッドのピンチ）で地図を動かす・拡大縮小する
- `/embed/` を直接開いたときと全画面のときは、1本指・ホイールでも動かせる
- 上の帯の全画面ボタン: 小さな枠の中でも大きくして見られる。iframe に `allow="fullscreen"` があり、
  ブラウザが対応しているときだけ出る（iPhone の Safari は iframe の中の全画面に対応していないので出ない）

## 親ページとのやり取り（postMessage）

埋め込んだ側のページは、`postMessage` で表示を差し替えたり、表示の変化を受け取ったりできる。

親 → マップ:

```js
const frame = document.querySelector("iframe");
// 表示を差し替える（params は URL パラメータと同じ。知らないキー・文字列/数値/真偽値以外は捨てる）
frame.contentWindow.postMessage({ type: "ikunavi:show", params: { from: "10301", to: "131", to_bldg: 1 } }, "https://iku-navi.net");
// 道順の n 番目（0始まり）の区間を見せる
frame.contentWindow.postMessage({ type: "ikunavi:segment", index: 2 }, "https://iku-navi.net");
```

マップ → 親（`source` はいつも `"ikunavi-embed"`。iframe の中にいるときだけ送る）:

| type | 送るとき | 中身 |
|---|---|---|
| `ready` | 表示し終えた | `view`（`"route"`・`"place"`・`"floor"`）。道順なら `segments`（区間の数）・`total_length`（m）、それ以外は `building`・`floor` |
| `segment` | 道順の区間を切り替えた | `index`・`total`・`kind`（`"floor"`/`"outdoor"`）・`building`・`floor`・`title` |
| `error` | 表示できなかった | `message` |

```js
addEventListener("message", e => {
  if (e.origin === "https://iku-navi.net" && e.data?.source === "ikunavi-embed") console.log(e.data);
});
```

## 配信

- `/embed/` は Cloudflare Pages の静的ページ。データは教室検索ナビと同じく `https://api.iku-navi.net` の
  `/api/all`（教室・ノード・建物名）と `/api/route` から読む。iframe の中のページのオリジンは iku-navi.net なので、
  埋め込む側のサイトを API の CORS 許可に足す必要はない
- `/api/all` のノードには、屋内ノードのフロアマップ上の座標（`svg_x`・`svg_y`）を入れている（場所のピンに使う）
- 通路・教室一覧に出ない名前は `/api/edges`（`docs/API_Destination.md`）で引き、道順は `/api/route` の `from_edge`・`to_edge`・`from_node`・`to_node` で探す
- `programs/html/_headers` で `/embed/` に `Content-Security-Policy: frame-ancestors *`（どのサイトからでも埋め込める）と
  `X-Robots-Tag: noindex`（埋め込み用の画面は検索結果に出さない）を付けている。作り方のページ `/embed/builder/` は検索に出す（sitemap.xml にも載せる）
- 右下の「IKU NAVI」の表示はクレジットとして残してもらう（作り方のページに書いている）

## テスト

`programs/html/tests/test_embed.py`: URL パラメータの読み取り（場所・通路・地点の指定、CSV の id とグローバルな id の変換）・教室の特定・区間分け・案内文・「IKU NAVI で開く」の URL を
Node の vm で `embed/core.js` を読んで確かめる。あわせて、スクリプトが使う要素 ID がページにあること、`_headers` の設定を確かめる。
