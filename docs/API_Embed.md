# 埋め込みマップ（/embed/）

他のサイト・ブログ・学内システムに、IKU NAVI のフロアマップや道順を iframe で載せるための仕組み。
Google マップの埋め込みと同じように、URL だけで表示する内容が決まる。AR・カメラ・GPS は使わない。

- 埋め込み用の画面: `https://iku-navi.net/embed/?...`（`programs/html/embed/`）
- コードを作るページ: `https://iku-navi.net/embed/builder/`（選ぶと iframe のコードと見本が出る）

```html
<iframe src="https://iku-navi.net/embed/?from=10301&to=131&to_bldg=1"
        title="10301教室から131教室への道順（IKU NAVI）"
        width="100%" height="480" style="border:0" loading="lazy" allow="fullscreen"></iframe>
```

## 表示できるもの

| 表示 | パラメータ | 例 | 画面 |
|---|---|---|---|
| 教室の場所 | `room`（＋`bldg`） | `?room=10301` | 教室のある階のフロアマップに、教室の位置のピン。階は切り替えられる |
| 道順 | `from`（＋`from_bldg`）か `from_event`、`to`（＋`to_bldg`）か `to_event` | `?from=10301&to=131&to_bldg=1` | 経路を「同じ建物の同じ階にいる間」ごとの区間に分け、◀ ▶ で1区間ずつ見せる |
| フロアマップ | `bldg`（＋`floor`） | `?bldg=10&floor=3` | その階のフロアマップだけ。`floor` を省くと1階（無ければ一番下の階） |

共通のパラメータ:

| パラメータ | 意味 |
|---|---|
| `elevator=0` | エレベーターを使わない道順にする（道順のみ） |
| `header=0` | 上の帯（建物名・「IKU NAVI で開く」）を出さない |
| `floors=0` | 階の切り替えボタンを出さない（教室の場所・フロアマップ） |

- 教室名は教室検索ナビ（`/navi/?to=`）と同じ。API用の名前（`10301`）でも表示名（`10301教室`）でもよい。教室名が1つの号館にしか無ければ号館は省ける
- 出発地の無い `to`（＋`to_bldg`）は、教室の場所として表示する
- `to_event`・`from_event` は `/api/route` にそのまま渡す（イベントの展示名。event.csv に id 列があるブランチでは id でも指定できる）
- 優先順: 出発地と目的地の両方がある → 道順 / `room` か `to` → 教室の場所 / `bldg` → フロアマップ

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

- ＋ / － / 枠のボタンで拡大・縮小・最初の範囲に戻す
- 埋め込み（iframe の中）では、ページのスクロールを邪魔しないよう、Google マップと同じく
  1本指のスワイプとホイールはページに渡す。2本指・Ctrl＋ホイール（トラックパッドのピンチ）で地図を動かす・拡大縮小する
- `/embed/` を直接開いたときは、1本指・ホイールでも動かせる

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
| `ready` | 表示し終えた | `view`（`"route"`・`"room"`・`"floor"`）。道順なら `segments`（区間の数）・`total_length`（m）、それ以外は `building`・`floor` |
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
- `/api/all` のノードには、屋内ノードのフロアマップ上の座標（`svg_x`・`svg_y`）を入れている（教室の場所のピンに使う）
- `programs/html/_headers` で `/embed/` に `Content-Security-Policy: frame-ancestors *`（どのサイトからでも埋め込める）と
  `X-Robots-Tag: noindex`（埋め込み用の画面は検索結果に出さない）を付けている。作り方のページ `/embed/builder/` は検索に出す（sitemap.xml にも載せる）
- 右下の「IKU NAVI」の表示はクレジットとして残してもらう（作り方のページに書いている）

## テスト

`programs/html/tests/test_embed.py`: URL パラメータの読み取り・教室の特定・区間分け・案内文・「IKU NAVI で開く」の URL を
Node の vm で `embed/core.js` を読んで確かめる。あわせて、スクリプトが使う要素 ID がページにあること、`_headers` の設定を確かめる。
