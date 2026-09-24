# Cloudflare Pages 移行手順書（Nginx 完全撤去版）

静的コンテンツ（`programs/html`）を Cloudflare Pages に移管し、サーバー側から **nginx を完全に撤去**する。
移行後のサーバーは **python（Flask API + 3D ビューア）/ counter / db / 監視基盤（prometheus・grafana・cadvisor）/ cloudflared** のみとなり、2GB VPS の負荷・メモリを削減する。

- メインドメイン `iku-navi.net` → Cloudflare Pages（静的配信）
- サブドメイン `api.iku-navi.net` → cloudflared tunnel → python / counter に直接振り分け

---

## 1. 構成の変化

### 移行前（nginx が入口）

```
ユーザー → Cloudflare → cloudflared tunnel → nginx:80
                                              ├─ /          → 静的ファイル (programs/html)
                                              ├─ /api/      → python:8000 (Flask API)
                                              ├─ /3d/       → python:8000 (3Dビューア)
                                              └─ /redirect/ → counter:3000
```

### 移行後（nginx なし）

```
ユーザー ─┬→ iku-navi.net      (Cloudflare Pages) … 静的配信のみ
          │     ├ /redirect/* → _redirects で api.iku-navi.net へ 301（QRコード互換）
          │     └ /3d/*       → _redirects で api.iku-navi.net へ 301（旧URL互換）
          │
          └→ api.iku-navi.net → cloudflared tunnel（Public Hostname のパスルーティング）
                                 ├─ /redirect/* → counter:3000
                                 └─ それ以外    → python:8000  (/api/, /3d/)

サーバー（Docker Swarm・スタック名 iku）:
  python / counter / db / prometheus / grafana / cadvisor / cloudflared
  ※ nginx は撤去。CORS ヘッダは Flask（ikunavi/__init__.py の after_request）が返す。
```

---

## 2. リポジトリ側の変更（実施済み）

以下はすべてコミット済み。**追加のコード変更は不要。**

| # | 変更 | ファイル |
|---|------|---------|
| 1 | `API_BASE` をホスト名で自動切替（localhost → 同一オリジン、それ以外 → `https://api.iku-navi.net`） | `programs/html/navi/index.html` |
| 2 | Flask に CORS ヘッダ追加（`iku-navi.net` / `www` / `*.pages.dev` を許可） | `programs/3D_Graph/ikunavi/__init__.py` |
| 3 | Pages 用キャッシュ制御 | `programs/html/_headers` |
| 4 | 旧 `/redirect/`・`/3d/` URL の 301 転送（QRコード救済） | `programs/html/_redirects` |
| 5 | Pages 用 404 ページ（nginx の 404.html を流用） | `programs/html/404.html` |
| 6 | Pages ビルドスクリプト（config.js 生成。旧 nginx entrypoint の移植） | `deploy_env/pages/build.sh` |
| 7 | nginx サービス削除・`GOOGLE_MAPS_API_KEY` 削除 | `deploy_env/docker-compose.yml` / `sample.env` |
| 8 | nginx イメージのビルド削除 | `.github/workflows/build-push.yml` |

`deploy_env/nginx/` のファイル自体はロールバック用に残してある（§6 の安定確認後に削除してよい）。

---

## 3. ユーザー側の作業（この順番で実施する）

> 作業前に Discord で作業宣言をすること（本番サーバー運用ルール）。

### Phase 0: 事前確認（本番影響なし）

- [ ] サーバーの `update.sh`（cron で 30 分ごとに自動デプロイ）が `docker stack deploy` に **`--prune` を付けていない**ことを確認する。
  - `--prune` なしなら、compose から消えた nginx サービスは**自動では削除されず動き続ける**ため、切替完了まで旧経路が生きる。
  - もし `--prune` が付いていたら、マージ前に外すか `touch ~/update.lock` で自動更新を止めること。
  ```bash
  grep -n "stack deploy" ~/update.sh
  ```

### Phase 1: マージとサーバー準備（本番影響なし）

1. [ ] このブランチ（ES）を PR → `main` にマージする。CI が python イメージ（CORS 対応版）をビルドする。
2. [ ] サーバーで python サービスを更新する（cron の自動更新を待ってもよい）:
   ```bash
   docker service update --image ghcr.io/senarmaporg/iki_project_2026_python:latest \
     --with-registry-auth iku_python
   ```
   ※ この時点では nginx は動いたままで、メインドメインは従来どおり配信され続ける。

### Phase 2: トンネルに api サブドメインを追加（本番影響なし）

Cloudflare ダッシュボード → Zero Trust → Networks → Tunnels → 対象トンネル → **Public Hostname** に、**上からこの順番で**追加する（上のエントリが優先マッチ）:

| 順番 | Public Hostname | Path | Service |
|---|---|---|---|
| 1 | `api.iku-navi.net` | `redirect/.*` | `http://counter:3000` |
| 2 | `api.iku-navi.net` | （空欄） | `http://python:8000` |

既存の `iku-navi.net` → `nginx:80` のエントリは**切替完了まで残す**（ロールバック保険）。
`api` の DNS レコード（CNAME → トンネル）はダッシュボードが自動作成する。

**動作確認:**

```bash
# API が JSON を返す
curl -s https://api.iku-navi.net/api/all | head -c 200

# CORS ヘッダが付く（Flask が返す）
curl -s -o /dev/null -D - -H "Origin: https://iku-navi.net" \
  https://api.iku-navi.net/api/all | grep -i access-control

# counter が応答する（既存のカウント用パスで確認）
curl -s -o /dev/null -w "%{http_code}\n" https://api.iku-navi.net/redirect/<既存パス>

# 3D ビューアが表示される
curl -s -o /dev/null -w "%{http_code}\n" https://api.iku-navi.net/3d/
```

> ⚠️ counter（Rails）が `Blocked host: api.iku-navi.net` エラーを返す場合は、counter 側の
> `config.hosts` に `api.iku-navi.net` を追加する必要がある（これまでは nginx が `Host` を
> 書き換えていたため顕在化していなかった可能性がある）。

### Phase 3: Pages プロジェクト作成と検証（本番影響なし）

3. [ ] Cloudflare ダッシュボード → Workers & Pages → Create → Pages → **Connect to Git** でこのリポジトリを選択し、以下を設定:

   | 設定項目 | 値 |
   |---|---|
   | Production branch | `main` |
   | Build command | `sh deploy_env/pages/build.sh` |
   | Build output directory | `programs/html` |
   | 環境変数（Production / Preview 両方） | `GOOGLE_MAPS_API_KEY` = （実キー） |

4. [ ] Google Cloud Console → 認証情報 → Maps API キーの「HTTP リファラー制限」に追加:
   - `https://iku-navi.net/*`（既存確認）
   - `https://*.pages.dev/*`（プレビュー確認用。検証後は外してよい）

5. [ ] `https://<プロジェクト名>.pages.dev` で確認:
   - [ ] トップページ・ブログ・navi UI が表示される
   - [ ] `/navi/script/config.js` にキーが入っている（Google Maps が表示される）
   - [ ] 教室検索 → ルート表示（`api.iku-navi.net` への CORS fetch 成功）
   - [ ] navi UI 内の屋外 AR モードで API 取得成功
   - [ ] `/svg/10_1F.svg` が返る
   - [ ] 存在しないパスで 404.html が出る
   - [ ] `/redirect/<既存パス>` が `api.iku-navi.net` へ 301 → counter の遷移が流れる

### Phase 4: 本番ドメイン切替

6. [ ] **現在の DNS レコードの値を控える**（`iku-navi.net` の CNAME 先 = トンネル ID）。ロールバックに必須。
7. [ ] Pages プロジェクト → Custom domains → `iku-navi.net` を追加（`www` を使っていればそれも）。ダッシュボードの案内に従うと DNS レコードが Pages 向けに切り替わる。
8. [ ] 本番ドメインで Phase 3 のチェックリストを再実施し、加えて:
   - [ ] `https://iku-navi.net/redirect/<既存パス>` → 301 → counter → 遷移先、と流れてカウントが計上される
   - [ ] `https://api.iku-navi.net/3d/` で 3D ビューアが表示される
9. [ ] 数日〜2週間、Grafana / Cloudflare Analytics でエラー率・Counter 計上を並行監視する。

### Phase 5: 後片付け（安定確認後）

10. [ ] cloudflared の Public Hostname から旧エントリ（`iku-navi.net` → `nginx:80`）を削除する。
11. [ ] サーバーで nginx サービスを削除する（これで nginx 完全撤去）:
    ```bash
    docker service rm iku_nginx
    ```
12. [ ] サーバーの `.env` から `GOOGLE_MAPS_API_KEY` を削除する（Pages 側に移管済み）。
13. [ ] 任意: リポジトリの `deploy_env/nginx/` を削除し、README / docs の構成図を最新化する。

---

## 4. 今後の運用メモ

- **静的コンテンツの更新**（`programs/html` 配下）: `main` にマージすると Pages が自動で再ビルド・再デプロイする。サーバー作業は不要。PR ごとにプレビュー URL（`*.pages.dev`）が発行される。
- **API・データの更新**（`programs/3D_Graph` / `data` 配下）: 従来どおり CI → イメージ更新 → サーバーのローリングアップデート。
- **今後印刷する QR コード**は最初から `https://api.iku-navi.net/redirect/...` を使う（301 を1回節約できる）。

---

## 5. ロールバック手順

Phase 5 実施前なら数分で戻せる:

1. Pages の Custom domain から `iku-navi.net` を解除し、DNS を控えておいた旧 CNAME（トンネル向き）に戻す。
2. nginx は削除していないので、それだけで旧構成（nginx 経由の静的配信）に復帰する。
   - フロントの `API_BASE` は自動判定のため、旧経路（同一オリジン `/api/`）でもそのまま動く。
   - nginx イメージは CI でビルドされなくなったが、GHCR の既存イメージ（`latest` および過去の SHA タグ）は残っているため再デプロイ可能。

**Phase 5（nginx 削除）はこの安さのロールバックを捨てる操作**なので、最低 1〜2 週間の安定稼働を確認してから実施すること。

---

## 6. 補足・将来の検討事項

- **`/api/graph` の CDN キャッシュ**: レスポンスはデータ更新まで不変なので、Flask で `Cache-Control` を返して Cloudflare にキャッシュさせるとイベント時のオリジン負荷をさらに下げられる。
- **`/3d/` の保護**: 開発・検証ツールの色が濃いので、一般公開が不要なら Cloudflare Access で `api.iku-navi.net/3d/` を保護できる。
- **ローカル開発**: 従来どおり `enviroments/` の compose（nginx 同居）で動く。`API_BASE` は `localhost` アクセス時に空文字になるため変更不要。Pages の挙動（`_headers` / `_redirects` / 404）をローカル再現したい場合は `wrangler pages dev programs/html`。
- **CORS の許可範囲**: 現在 `*.pages.dev` 全体を許可している（公開 GET API のみなので実害なし）。絞りたい場合は `ikunavi/config.py` の `CORS_ORIGIN_PATTERN` を自プロジェクトのサブドメインに限定する。
