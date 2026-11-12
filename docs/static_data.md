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

中身は API の返事と1バイトも違わない。`programs/3D_Graph/export_static.py` が Flask のアプリをそのまま動かし、
各 API を呼んだ結果を保存しているため（計算の仕組みを2つ持たない）。テスト（`test_export_static.py`）でも確かめている。

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

1. **静的 JSON の書き出しと、3Dマップの切り替え**（この文書。済み）
2. 経路計算を JS のモジュールに移し、全教室の組み合わせ×条件（エレベーター・階段を使わない）で Python と結果が同じことを CI で確かめる
3. ナビ・埋め込みマップをブラウザでの計算に切り替える（しばらく Flask も動かしてすぐ戻せるようにする）
4. 同じ JS で Pages Functions の `/api/route` などを用意し、「GET すれば結果が返る」API の形を残す
5. Python（Flask・VPS・Tunnel・監視）を撤去する
