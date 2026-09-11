# 非機能要件定義書

**プロジェクト名:** キャンパスマップARシステム（IKU NAVI）  
**作成日:** 2026-05-07  
**最終更新:** 2026-09-11  
**対象環境:** ConoHa VPS（本番・API側）/ Docker Swarm + Cloudflare Pages（静的配信）

---

## 1. インフラ構成

### サーバースペック（ConoHa VPS）

| 項目 | 値 |
| :--- | :--- |
| プラン（平常時） | メモリ 2GB |
| vCPU | 3コア |
| SSD | 100GB |
| OS | Ubuntu 24.04 LTS（推奨） |
| ネットワーク | 上り/下り 無制限 |

イベント時は 4GB サーバーを追加増設し、Docker Swarm のワーカーとして参加させる。詳細は [`swarm.md`](./swarm.md) を参照。

> 静的コンテンツ（`programs/html`）は Cloudflare Pages 上で配信されており、上記 VPS はホストしない（[`cloudflare_pages_migration.md`](./cloudflare_pages_migration.md) 参照）。VPS が担うのは Flask API・3D ビューア・アクセスカウンター・DB・監視基盤・Cloudflare Tunnel の入口のみ。

### コスト試算（まとめトク 6ヶ月契約）

| | 月額単価 | 6ヶ月合計 |
| :--- | ---: | ---: |
| 初回契約 | ¥940 | **¥5,640** |
| 更新時 | ¥1,056 | **¥6,336** |

> 時間課金（¥3.7/時）と比較して約53%割引。  
> 料金はすべて税込。最新情報は[公式サイト](https://vps.conoha.jp/pricing/)を参照。

### コンテナ（Swarm サービス）構成

nginx は Cloudflare Pages 移行に伴い完全撤去済み（`deploy_env/docker-compose.yml` にサービス定義なし）。外部からの振り分けは cloudflared の Public Hostname パスルーティングが直接行う（`/redirect/*` → counter、それ以外 → python）。CORS ヘッダは Flask（`app.py` の `after_request`）が返す。

| サービス名 | 役割 | 平常時レプリカ |
| :--- | :--- | :---: |
| `iku_python` | Flask API + `/3d` ビューア（gunicorn 4 workers） | 2 |
| `iku_counter` | アクセスカウンター（Rails） | 2 |
| `iku_db` | MariaDB 11 | 1 |
| `iku_cloudflared` | Cloudflare Tunnel（外部公開・パスルーティング） | 1 |
| `iku_prometheus` | メトリクス収集 | 1 |
| `iku_grafana` | 監視ダッシュボード | 1 |
| `iku_cadvisor` | コンテナリソース監視 | global（全ノード） |

静的コンテンツ（トップページ・navi UI・blog・SVGフロアマップ等）は上記 Swarm の外、Cloudflare Pages が独立してホスティングする（VPS 上にコンテナは存在しない）。

---

## 2. 可用性

| 項目 | 要件 |
| :--- | :--- |
| 目標稼働率 | 70%以上 |
| 計画メンテナンス | 水・金（10:45〜12:15）に実施 |
| 障害検知 | Prometheus + Grafana でリソース監視。サービスダウンは手動対応 |
| 自動更新 | cron（30分ごと）で `update.sh` を実行。本番中は `~/update.lock` で無効化可 |
| ローリングアップデート | `update_config.order: start-first` により無停止更新 |

> 大学内利用を主目的とするため、高可用性クラスタ構成は採用しない。

---

## 3. 性能

| 項目 | 要件 |
| :--- | :--- |
| 想定同時接続数 | 通常時 30人以下、ピーク時（授業切替）100人以下 |
| レスポンスタイム | 静的ページ：500ms以内、APIレスポンス：2秒以内 |
| gunicorn ワーカー数 | 4（平常時: 2レプリカ × 4 = 8並列、イベント時: 4レプリカ × 4 = 16並列） |
| 静的ファイルキャッシュ | Cloudflare Pages（CDN配信）＋ `_headers` によるキャッシュ制御、ブラウザキャッシュ活用 |

---

## 4. セキュリティ

| 項目 | 要件 |
| :--- | :--- |
| 通信暗号化 | 静的サイト（Cloudflare Pages）・API（Cloudflare Tunnel）ともに Cloudflare 側で TLS 終端 |
| 不要ポートの閉鎖 | パブリックポート公開なし。外部アクセスはすべて Pages または cloudflared 経由 |
| gunicorn 外部非公開 | ポート 8000 はコンテナ内部通信のみ（Swarm overlay network）。cloudflared → python 直結（nginx 等の中継なし） |
| CORS | Flask（`app.py` の `after_request`）が `iku-navi.net` / `www.iku-navi.net` / `*.pages.dev` のみ許可（GETのみの単純リクエストのためプリフライト対応は不要） |
| ファイアウォール | `ufw` で SSH のみ許可（Swarm ノード間は 2377/7946/4789 を追加） |
| パッケージ更新 | OS・依存ライブラリを月1回以上アップデート |
| 機密情報管理 | `.env` で管理（Git 管理対象外）。Swarm では環境変数としてサービスに渡す。`GOOGLE_MAPS_API_KEY` はサーバー側では不要（Cloudflare Pages のビルド時環境変数として管理） |

---

## 5. 保守性

| 項目 | 要件 |
| :--- | :--- |
| デプロイ方式（API側/VPS） | `update.sh` による自動更新（cron 30分ごと）。手動実行も可。CI（GitHub Actions）が `main` push 時に python イメージのみをビルド・GHCRへプッシュ |
| デプロイ方式（静的側） | `main` への push を Cloudflare Pages が検知し `deploy_env/pages/build.sh` を実行して自動デプロイ。VPS側の作業は不要。PRごとにプレビューURL（`*.pages.dev`）が発行される |
| 設定変更 | `docker-compose.yml` 変更後 `docker stack deploy` で即時反映 |
| ログ確認 | `docker service logs <service名> --tail 50` で確認 |
| バックアップ対象 | `data/` ディレクトリ（CSVファイル群）を定期的に手動バックアップ |
| コード管理 | GitHub リポジトリで管理、`main` ブランチが本番対応 |

---

## 6. 運用・監視

| 項目 | 要件 |
| :--- | :--- |
| ログ保持 | Flask（gunicorn）アプリログは `docker service logs` で確認。静的配信側は Cloudflare Pages / Analytics のログに依存（VPS上にアクセスログは残らない） |
| リソース監視 | Prometheus + Grafana + cAdvisor による自動監視（Swarm 全ノードを `dockerswarm_sd_configs` で動的ディスカバリ） |
| ディスク使用量 | 100GB SSD のうち OS + Docker + データで 20GB 以内を目安 |
| 監視確認 | Grafana ダッシュボードでコンテナリソースを確認。サービス系列は `com.docker.swarm.service.name` ラベル（例: `iku_python`）で集計する |

---

## 7. 制約・前提条件

- 本システムは学内利用を主目的とするが、学外からのアクセスを許容する。
- データ（CSV）はスプレッドシートからスクリプトを用いてGitHub経由で更新する運用とする。
- VPS の物理障害・ConoHa 側の障害については対応不可（SLAに準拠）。
- 本番環境に対するスケールアップは、イベント時に 4GB サーバーを Swarm ワーカーとして追加することで対応する。
