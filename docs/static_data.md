# 静的データ（/data/*.json）

経路探索API（`programs/3D_Graph`、VPS 上の Flask）のうち「読むだけ」のデータを、Cloudflare Pages のビルドで
静的な JSON として書き出し、`https://iku-navi.net/data/` から配っている。

サーバーを通らないので速く、Pages の静的な配信は無料・無制限で、Pages Functions の回数の枠（1日10万回。
AIへの質問・集計・時間割と共有）も使わない。経路計算を Python から JS（ブラウザと Pages Functions）へ移し、
最終的に VPS をなくす移行の1段目にあたる。

## 書き出すファイル

| ファイル | 中身（元の API） | 読んでいる画面 |
|---|---|---|
| `/data/graph.json` | `/api/graph`（全ノード・全エッジの座標と種類、建物の色など） | 3Dマップ |
| `/data/all.json` | `/api/all`（教室・ノード・建物の一覧） | ナビ・埋め込みマップ・3Dマップ |
| `/data/edge_images.json` | `/api/edge_images`（区間ごとの経路写真のURL） | ナビ・3Dマップ（写真モード） |
| `/data/events.json` | `/api/events`（大学祭などのイベント一覧） | ナビ |
| `/data/cafeterias.json` | `/api/cafeterias`（食堂の一覧） | ナビ・埋め込みマップの作成ページ |
| `/data/facilities.json` | `/api/facilities`（その他の設備の一覧） | ナビ |
| `/data/route_data.json` | 経路計算用のデータ（下の「経路計算（JS）」） | JS の経路計算（ナビ・埋め込みマップ・3Dマップ） |

API の名前が付いたファイル（`route_data.json` 以外）の中身は、API の返事と1バイトも違わない。`programs/3D_Graph/export_static.py` が Flask のアプリをそのまま動かし、
各 API を呼んだ結果を保存しているため（計算の仕組みを2つ持たない）。テスト（`test_export_static.py`）でも確かめている。

## 画面からの呼び出し（ikunaviFetch）

ナビ（`/navi/`・`/navi1/`〜`/navi9/`）・埋め込みマップ（`/embed/`・作成ページ）・3Dマップは、経路探索API を
`fetch` ではなく `programs/html/shared/api-client.js` の `ikunaviFetch("/api/...")` で呼ぶ。返事は `fetch` と同じ `Response`。

| 呼んだ API | 答え方 |
|---|---|
| 一覧（`/api/all`・`/api/graph`・`/api/edge_images`・`/api/events`・`/api/cafeterias`・`/api/facilities`） | `/data/*.json` を読む |
| 経路（`/api/route`・`/api/shortest_path`・`/api/nearest_*`・`/api/edges`） | `route-core.mjs` でブラウザの中で計算する（サーバーに聞かない） |
| それ以外・上が使えないとき（静的データが無い・計算で想定外の失敗） | 今までどおりサーバー（Flask。`old-api.iku-navi.net`）に聞く |

経路計算の準備（`route-core.mjs` と `route_data.json`、合わせて gzip で数十KB）は、ナビを開いたときに先に始めるので、
最初の検索も待たせない。

**サーバーでの計算に戻すとき**は、`api-client.js` の `DEFAULT_ENGINE` を `"server"` にしてデプロイする（全画面が今までの動きに戻る）。
1回だけ見比べたいときは、ページの URL に `?engine=server`（または `?engine=local`）を付ける。
Flask（VPS）は段階5まで動かしたままにしてあるので、いつでも戻せる。

## API としての提供（Pages Functions）

`https://iku-navi.net/api/*`（切り替え後は `https://api.iku-navi.net/api/*` も）は、Pages Functions が答える
（`functions/api/[[path]].js` → `functions/_lib/api-handler.mjs`）。返事・エラー・CORS は Flask と同じ。

| API | 答え方 |
|---|---|
| 一覧（`/api/all`・`/api/graph`・`/api/edge_images`・`/api/events`・`/api/cafeterias`・`/api/facilities`） | `/data/*.json` をそのまま返す |
| 経路（`/api/route`・`/api/shortest_path`・`/api/nearest_*`・`/api/edges`） | `route-core.mjs` で計算する（ブラウザと同じ） |
| `/api/rooms`・`/api/navigate_to_room`・`/3d` | 提供しない（404）。Flask の `old-api.iku-navi.net` に残してある |
| `/api/help-chat` | 今までどおり `functions/api/help-chat.js` |

- **回数の上限**: Functions は Workers と合わせて1日10万回まで（無料。超えると課金ではなくエラー）。画面はブラウザで計算するので
  ここを呼ばない。呼ぶのは時間割共有（`/api/all`）と外部の利用者だけ。全教室の組み合わせを調べる IKU NAVI ツールの
  ルート検証は、上限に当たらないよう Flask（`old-api.iku-navi.net`）を使う（`iku_tools/common/api.py` の `DEFAULT_API`）。
- **計算の時間**: 無料の Functions は1回あたり CPU 10ms まで。教室どうしの経路・最寄りの施設とも、ふだんは1ms前後で終わる。
- **CORS**: `iku-navi.net`・`www.iku-navi.net`・`timetables.iku-navi.net`・`*.pages.dev` からの読み込みを許可（Flask と同じ）。

## api.iku-navi.net の切り替え手順（Cloudflare の画面での作業）

**2026-11-13 に切り替え済み。** `api.iku-navi.net` は Pages（Functions）が答え、`/api/` 以外は Redirect Rule（ルール名「api redirect」）で `iku-navi.net` へ 301 で飛ぶ。Flask は `old-api.iku-navi.net` で答える。以下は記録と、戻すときのため。

Flask はすでに `old-api.iku-navi.net`（Tunnel）でも答えている（2026-11-12 設定）。画面の「予備の問い合わせ先」と
`/3d` の転送先はコードで `old-api.iku-navi.net` に変えてある。下の順で進めれば、どこで止まってもサービスは動く。

1. 段階4までのコードを main に入れて、Pages に反映する
2. 本番で確かめる
   - `https://iku-navi.net/data/route_data.json` が開ける（Pages のビルドで書き出せている）
   - `https://iku-navi.net/api/route?from_room=10301&from_building=10&to_room=131&to_building=1` が JSON を返す（Functions）
   - ナビで検索したとき、ブラウザの通信に `old-api.iku-navi.net` が出ない（ブラウザで計算できている）
3. Zero Trust → Networks → Tunnels → 対象のトンネル → Public Hostname から `api.iku-navi.net` の行を消す
4. Workers & Pages → IKU NAVI の Pages プロジェクト → Custom domains → `api.iku-navi.net` を追加する
   （DNS のレコードは Cloudflare が作り直す。消した Tunnel 用の CNAME が残っていたら消す）
5. `api.iku-navi.net` の `/api/` 以外（トップページなど）を `iku-navi.net` へ飛ばす。
   Rules → Redirect Rules → 新しいルール:
   - 条件（式）: `(http.host eq "api.iku-navi.net" and not starts_with(http.request.uri.path, "/api/"))`
   - 飛ばし先: 動的 `concat("https://iku-navi.net", http.request.uri.path)`、301、クエリ文字列を残す
6. 確かめる: `https://api.iku-navi.net/api/all` が JSON を返す・`https://api.iku-navi.net/` が `iku-navi.net` へ飛ぶ・
   時間割共有の教室の選択肢が出る

戻すときは、4 のカスタムドメインを外し、3 の Public Hostname（`api.iku-navi.net` → `http://python:8000`）を足し直す。

## 経路計算（JS）

`programs/html/shared/route-core.mjs` が、経路探索API の経路系エンドポイント
（`/api/route`・`/api/shortest_path`・`/api/nearest_toilet`・`/api/nearest_cafeteria`・`/api/nearest_facility`）を
JS に移したもの。ブラウザからも Pages Functions からも、同じファイルをそのまま使う（段階3・4）。

```js
import { createRouter } from "/shared/route-core.mjs";
const router = createRouter(await (await fetch("/data/route_data.json")).json());
const { status, body } = router.handle("/api/route", new URLSearchParams(location.search));
```

- 返事（`status` と JSON）・引数の読み方・エラーの文言は Flask の API と同じ
- 最短経路は networkx の `bidirectional_dijkstra` と探索の順番まで同じにしてあり、同じ長さの経路が複数あっても同じものを選ぶ
- CSV の読み込み・座標の変換・イベントの場所の解決は、今は Python（`export_static.py` の `build_route_data`）で済ませ、
  その結果を `route_data.json` に並び順もそのまま書き出している。JS はそれを読むだけ

### Python と同じ答えになることの確かめ方

`programs/3D_Graph/route_js_check.py` が、同じ問い合わせを Flask と JS の両方に投げ、1件ずつ比べる
（経路・距離・表示名・左右・エラーの文言まで。1か所でも違えば違いとして出す）。

```bash
python programs/3D_Graph/route_js_check.py          # 約1万件（1分ほど）。CI と同じ
python programs/3D_Graph/route_js_check.py --full   # 全教室の組み合わせ×3条件（約90万件。1時間以上）
```

CI（pytest）では次の3つが毎回動く。node が要る（GitHub Actions には入っている）。

| テスト | 見ていること |
|---|---|
| `test_route_js.py` の今のデータ | 実データの約1万件（教室どうし・ノード・エッジ・イベント・最寄りの施設・エラー）× 3条件が同じ |
| `test_route_js.py` の小さなキャンパス | テスト用の合成データの全部の組み合わせが同じ |
| `test_route_js_dijkstra.py` | 重み1・2だけのグラフで、同じ長さの経路が複数あるときにも networkx と同じ経路を選ぶ |

Python 側（`ikunavi/`）の経路の決め方や返事を変えたら、`route-core.mjs` も同じように直す（直し忘れるとここが落ちる）。

## 作られる流れ

1. Pages のビルド（`deploy_env/pages/build.sh`）が `deploy_env/python/requirements.txt` を pip で入れる
2. `python3 programs/3D_Graph/export_static.py --out programs/html` で `programs/html/data/` に書き出す
3. そのまま Pages に配信される。データ（`data/` の CSV）を変えて push すれば、次のデプロイで作り直される

生成物はリポジトリに入れない（`.gitignore` の `programs/html/data/`）。

**いまは書き出しに失敗してもビルドは止めない。** 画面は `/data/*.json` が無ければ今までどおりサーバーに聞く
（`ikunaviFetch`）。失敗したときは Pages のビルドログに `[pages] WARN: ... static data was not exported.` が出る。
サーバー（Flask）を撤去するとき（移行の5段目）に、失敗したらビルドを止めるように変える。

## ローカルで試す

```bash
python3 programs/3D_Graph/export_static.py --out programs/html   # programs/html/data/ に書き出す
cd programs/html && python3 -m http.server 8765                    # http://127.0.0.1:8765/map3d/
```

書き出さずに開くと、画面はサーバー（ローカルでは同じオリジンの `/api/...`）に聞きに行く。
簡易サーバー（`http.server`）はキャッシュの指示を出さないので、ファイルを変えたあとはブラウザのキャッシュを消して開き直す。

## 移行の段階

1. **静的 JSON の書き出しと、3Dマップの切り替え**（済み）
2. **経路計算を JS のモジュールに移し、Python と答えが同じことを CI で確かめる**（済み。上の「経路計算（JS）」）
3. **ナビ・埋め込みマップ・3Dマップをブラウザでの計算に切り替える**（済み。上の「画面からの呼び出し」。Flask は動かしたままで、すぐ戻せる）
4. **同じ JS で Pages Functions の `/api/route` などを用意し、「GET すれば結果が返る」API の形を残す**（コードは済み。上の「API としての提供」。`api.iku-navi.net` の切り替えは Cloudflare の画面で）
5. Python（Flask・VPS・Tunnel・監視）を撤去する
