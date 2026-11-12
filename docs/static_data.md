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
| `/data/all.json` | `/api/all`（教室・ノード・建物の一覧） | 3Dマップ |
| `/data/edge_images.json` | `/api/edge_images`（区間ごとの経路写真のURL） | 3Dマップ（写真モード） |
| `/data/events.json` | `/api/events`（大学祭などのイベント一覧） | （段階3でナビが読む） |
| `/data/cafeterias.json` | `/api/cafeterias`（食堂の一覧） | （段階3でナビが読む） |
| `/data/facilities.json` | `/api/facilities`（その他の設備の一覧） | （段階3でナビが読む） |
| `/data/route_data.json` | 経路計算用のデータ（下の「経路計算（JS）」） | JS の経路計算 |

API の名前が付いたファイル（`route_data.json` 以外）の中身は、API の返事と1バイトも違わない。`programs/3D_Graph/export_static.py` が Flask のアプリをそのまま動かし、
各 API を呼んだ結果を保存しているため（計算の仕組みを2つ持たない）。テスト（`test_export_static.py`）でも確かめている。

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

**いまは書き出しに失敗してもビルドは止めない。** 画面は `/data/*.json` が無ければ今までどおり API を読む
（`map3d.js` の `fetchData`）。失敗したときは Pages のビルドログに `[pages] WARN: ... static data was not exported.` が出る。
ナビ本体が静的データだけで動くようになったら（移行の3段目）、失敗したらビルドを止めるように変える。

## ローカルで試す

```bash
python3 programs/3D_Graph/export_static.py --out programs/html   # programs/html/data/ に書き出す
cd programs/html && python3 -m http.server 8765                    # http://127.0.0.1:8765/map3d/
```

書き出さずに開くと、3Dマップは API（ローカルでは同じオリジンの `/api/...`）を読みに行く。

## 移行の段階

1. **静的 JSON の書き出しと、3Dマップの切り替え**（済み）
2. **経路計算を JS のモジュールに移し、Python と答えが同じことを CI で確かめる**（済み。上の「経路計算（JS）」）
3. ナビ・埋め込みマップをブラウザでの計算に切り替える（しばらく Flask も動かしてすぐ戻せるようにする）
4. 同じ JS で Pages Functions の `/api/route` などを用意し、「GET すれば結果が返る」API の形を残す
5. Python（Flask・VPS・Tunnel・監視）を撤去する
