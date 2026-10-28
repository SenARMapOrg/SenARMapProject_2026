# Docker Swarm 運用手順

## 概要

平常時は **2GB VPS（マネージャー）** のみで動作し、イベント時に **4GB サーバー（ワーカー）** を追加する構成。

```
平常時                          イベント時
┌─────────────────────┐         ┌─────────────────────┐
│  Manager (2GB VPS)  │         │  Manager (2GB VPS)  │
│  ・db               │   ───→  │  ・db               │
│  ・python ×1        │         │  ・python ×2        │
│  ・counter ×1       │         │  ・counter ×2       │
│  ・grafana          │         │  ・grafana          │
│  ・prometheus       │         │  ・prometheus       │
│  ・cloudflared      │         │  ・cloudflared      │
│  ・cadvisor         │         │  ・cadvisor         │
└─────────────────────┘         └─────────────────────┘
                                ┌─────────────────────┐
                                │  Worker (4GB)       │
                                │  ・python ×2        │
                                │  ・counter ×2       │
                                │  ・cadvisor         │
                                └─────────────────────┘
```

> **注:** 静的コンテンツは Cloudflare Pages が配信し、nginx はスタックから撤去済み。
> `api.iku-navi.net` へのリクエストは cloudflared が python / counter に直接振り分ける
> （詳細: `docs/cloudflare_pages_migration.md`）。

### サービスの配置ルール

| サービス | 配置 | 理由 |
|---|---|---|
| python | 全ノードに分散 | スケール対象 |
| counter | 全ノードに分散 | スケール対象 |
| cadvisor | 全ノード（global） | 各ノードのメトリクス収集 |
| db | マネージャー固定 | ボリュームデータがある |
| prometheus | マネージャー固定 | docker.sock 参照 + ボリューム |
| grafana | マネージャー固定 | ボリュームデータがある |
| cloudflared | マネージャー固定 | トンネルの入口 |

---

## 前提条件

- マネージャー・ワーカー両方に Docker がインストール済み（`deploy.sh` 実行済み）
- 両サーバー間で以下のポートが開いていること（ファイアウォール設定）:
  - `2377/tcp` — Swarm クラスター管理
  - `7946/tcp,udp` — ノード間通信
  - `4789/udp` — オーバーレイネットワーク (VXLAN)
- GHCR イメージの pull 権限があること（`docker login ghcr.io`）
- `.env` に `TUNNEL_TOKEN` が設定されていること（cloudflared に必須）

---

## 初回セットアップ（Swarm 初期化）

### 1. マネージャーノードで Swarm を初期化

```bash
# マネージャー(2GB VPS)で実行
docker swarm init --advertise-addr <MANAGER_の外部IP>
```

成功すると以下のようなトークンが表示される（後で使う）:

```
To add a worker to this swarm, run the following command:
    docker swarm join --token SWMTKN-1-xxxx <MANAGER_IP>:2377
```

### 2. マネージャーの状態確認

```bash
docker node ls
# NAME    STATUS    AVAILABILITY   MANAGER STATUS
# xxx *   Ready     Active         Leader
```

---

## スタックのデプロイ

### 1. リポジトリの取得と .env の配置

```bash
cd /srv
git clone https://github.com/SenARMapOrg/SenARMapProject_2026.git
cd SenARMapProject_2026/deploy_env

# sample.env をコピーして各値を設定
cp sample.env .env
vim .env
```

### 2. GHCR にログイン

```bash
echo <GHCR_TOKEN> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin
```

### 3. スタックをデプロイ

> **重要:** `docker stack deploy` は `.env` を自動で読み込まない。
> `. .env`（ドット）でシェルに読み込んでから deploy する。
>
> `source` は bash 専用コマンドで `/bin/sh` では動かない。
> cron や sh から実行する場面に備えて必ず `. .env` を使うこと。
>
> `docker compose config` を間に挟む方法は**使わない**こと。
> Docker Compose v2 が `depends_on` をマップ形式に正規化するため、
> `docker stack deploy` が "must be a list" エラーを出す。

```bash
cd /srv/SenARMapProject_2026/deploy_env

set -a && . .env && set +a
docker stack deploy \
  --with-registry-auth \
  -c docker-compose.yml \
  iku
```

### 4. デプロイ確認

```bash
# サービス一覧と起動状況
docker service ls

# 各サービスのタスク（コンテナ）の配置確認
docker stack ps iku

# ログ確認 (例: python サービス)
docker service logs iku_python -f
```

---

## 状態確認コマンド集

```bash
# ノード一覧
docker node ls

# スタック全体のサービス状況
docker service ls

# タスク（コンテナ）の配置とノード
docker stack ps iku --no-trunc

# 特定サービスの詳細
docker service ps iku_python

# リソース使用状況
docker stats $(docker ps -q)
```

### モニタリング（cAdvisor + Prometheus）の動作確認

```bash
# cAdvisor がメトリクスを出しているか
docker exec $(docker ps -q -f name=iku_cadvisor) wget -qO- http://localhost:8080/metrics | head -5

# Prometheus が cadvisor を scrape できているか（"1" = UP）
docker exec $(docker ps -q -f name=iku_prometheus) \
  wget -qO- 'http://localhost:9090/api/v1/query?query=up' | python3 -m json.tool
```

---

## コンテナのお掃除（ハウスキーピング）

「ゴミコンテナ」は主に3種類あり、それぞれ対策が異なる。

### 1. 監視に映るsystemdスライス等（cadvisor の設定で解決済み）

cadvisor はデフォルトで Docker 以外の cgroup（`system.slice/*` など）も「コンテナ」として
収集してしまう。`docker-compose.yml` の cadvisor に `--docker_only=true` を設定済みで、
さらに prometheus.yml の `metric_relabel_configs` で Swarm サービス以外の系列を除外している。
Grafana でのグラフ集計は、ローリングアップデートで増えないよう **`service` ラベル**
（例: `iku_python`）で行うこと。コンテナ名ラベルは世代ごとに変わるため使わない。

### 2. 停止済みタスクコンテナの残骸（1回だけ実行）

Swarm はローリングアップデート・再起動のたびに古いタスクコンテナを既定で **5世代** 残す
（`docker stack ps` の `\_` 行、`docker ps -a` の Exited コンテナの正体）。
マネージャーで1回実行すれば、以後クラスタ全体で直近1世代だけ残す設定になる:

```bash
docker swarm update --task-history-limit 1
```

※ 0 にすると障害調査時に直前のコンテナのログが追えなくなるため 1 を推奨。

### 3. 溜まっていく停止コンテナ・宙ぶらりんイメージ（定期実行）

イメージ更新のたびに古いイメージレイヤーがディスクに溜まる。週1回程度の cron で掃除する:

```bash
# 停止コンテナ・未使用ネットワーク・danglingイメージを削除（volumeと稼働中には触れない）
docker system prune -f
```

> **注意:** `docker image prune -a` は「現在使われていない全イメージ」を消すため、
> ロールバック用の旧イメージも消える。`-a` は付けないこと。
> `--volumes` も db_data 等を守るため付けないこと。

### 設定変更の反映方法（cadvisor / prometheus.yml を更新した場合）

> **注意:** Docker config はサービスが参照している間は `docker config rm` できない
> （`config 'iku_prometheus_config' is in use` エラーになる）。
> **先にサービスを削除**する。メトリクスデータは `prometheus_data` ボリュームに
> あるため消えない（監視が数十秒止まるだけ）。

```bash
cd /srv/SenARMapProject_2026/deploy_env
git pull

# 1. config を掴んでいるサービスを先に削除
docker service rm iku_prometheus

# 2. config を削除（1の後なら成功する）
docker config rm iku_prometheus_config

# 3. 再デプロイで config とサービスが新しい内容で再作成される
set -a && . .env && set +a
docker stack deploy --with-registry-auth -c docker-compose.yml iku
```

---

## 自動更新の一時停止（本番中のメンテナンス）

cron が30分ごとに `update.sh` を実行するため、本番中に予期しない再起動が起きる可能性がある。
ロックファイルで手軽に無効化できる。

```bash
# 無効化（update.sh の先頭に [ -f ~/update.lock ] && exit 0 が必要）
touch ~/update.lock

# 有効化
rm ~/update.lock
```

> **前提:** `update.sh` の先頭に以下を追記しておく:
> ```bash
> [ -f ~/update.lock ] && exit 0
> ```

---

## イベント時：ワーカーの増設

### 手順1. トークンを確認（マネージャーで実行）

```bash
docker swarm join-token worker
```

Swarm のワーカートークンに有効期限はない（k8s の 24 時間制限に相当するものは存在しない）。
ただしセキュリティ上の理由でトークンを再生成したい場合:

```bash
docker swarm join-token --rotate worker
```

### 手順2. ワーカー（4GB サーバー）の初期設定

4GB サーバーに SSH し、Docker をインストール:

```bash
# 4GB サーバーで実行
bash /path/to/deploy.sh   # または手動で Docker インストール

# GHCR にログイン
echo <GHCR_TOKEN> | docker login ghcr.io -u <GITHUB_USERNAME> --password-stdin
```

### 手順3. ワーカーを Swarm に参加させる（ワーカーで実行）

```bash
# 手順1 で取得したコマンドをそのまま実行
docker swarm join --token SWMTKN-1-xxxx <MANAGER_IP>:2377
```

### 手順4. ノード参加を確認（マネージャーで実行）

```bash
docker node ls
# HOSTNAME    STATUS    AVAILABILITY   MANAGER STATUS
# manager *   Ready     Active         Leader
# worker      Ready     Active
```

cadvisor は `mode: global` のため、ワーカー参加と同時に自動でデプロイされる。

### 手順5. python / counter をスケールアップ

台数は `.env` の `PYTHON_REPLICAS` / `COUNTER_REPLICAS` で決める（未設定なら2）。
`docker stack deploy` は台数を compose の値に戻すため、`docker service scale` だけで増やすと、
cron の `update.sh`（30分ごと）で2台に戻ってしまう。

```bash
# マネージャーで実行。イベント規模に応じて調整（例: 各4レプリカ）
cd <リポジトリ>/deploy_env
vim .env    # PYTHON_REPLICAS=4 と COUNTER_REPLICAS=4 を書く

set -a && . .env && set +a
docker stack deploy --with-registry-auth -c docker-compose.yml iku

# 分散状況を確認
docker service ps iku_python --filter desired-state=running
```

> **ノードごとの数は指定できない:** `spread: node.id` で均等に分けるだけ（4台なら2:2）。
> マネージャーを `pause` してから増やせば片方に寄せられるが、次の `update.sh` で均等に戻る。

> **workers の調整:** 平常時は `gunicorn -w 4` を使っているが、
> スケールアップ後は 4レプリカ × 4workers = 16並列になる。
> さらに増やしたい場合は `docker service update --args "gunicorn -w 8 ..." iku_python`。

---

## イベント終了後：ワーカーの撤去

### 手順1. ワーカーをドレインしてタスクをマネージャーに移す

```bash
# マネージャーで実行
docker node update --availability drain <WORKER_NODE_ID>

# タスクが移動するまで待つ（30秒程度）
watch docker stack ps iku
```

### 手順2. サービスを平常時のレプリカ数に戻す

`.env` の `PYTHON_REPLICAS` / `COUNTER_REPLICAS` を消す（または 2 にする）。
`docker service scale` で減らしただけだと、次の `update.sh` で `.env` の台数に戻ってしまう。

```bash
vim .env    # PYTHON_REPLICAS / COUNTER_REPLICAS を消す
set -a && . .env && set +a
docker stack deploy --with-registry-auth -c docker-compose.yml iku
```

### 手順3. ワーカーを Swarm から離脱させる

```bash
# ワーカーサーバーで実行
docker swarm leave

# マネージャーで「Down」になったノードを削除
docker node rm <WORKER_NODE_ID>
```

### 手順4. ノードが削除されたか確認

```bash
docker node ls
# manager のみが表示されればOK
```

---

## ローリングアップデート（イメージ更新）

コード変更後に CI で新イメージがビルドされたら:

```bash
cd /srv/SenARMapProject_2026/deploy_env
git pull

# compose.yml の変更も含めて再デプロイ（設定変更 + イメージ更新を一括適用）
set -a && . .env && set +a
docker stack deploy \
  --with-registry-auth \
  -c docker-compose.yml \
  iku
```

イメージだけ更新したい場合:

```bash
# 最新イメージを pull してローリングアップデート
docker service update --image ghcr.io/senarmaporg/iki_project_2026_python:latest \
  --with-registry-auth iku_python
```

`update_config.order: start-first` が設定されているため、新コンテナが先に起動してから
旧コンテナが停止する（ゼロダウンタイムアップデート）。

---

## prometheus の設定変更

prometheus.yml を更新した場合の反映手順は「コンテナのお掃除」内の
**「設定変更の反映方法」** を参照（サービス削除 → config 削除 → 再デプロイの順。
config はサービスが参照中だと削除できない点に注意）。

---

## トラブルシューティング

### サービスが起動しない

```bash
# タスクのエラーを確認
docker service ps iku_python --no-trunc

# ログ確認
docker service logs iku_python --tail 50
```

### counter が DB に繋がらない

Swarm では `depends_on` が無視されるため、DB が起動する前に counter が起動してしまう場合がある。
`restart_policy.delay: 15s` と `max_attempts: 5` が設定されているので、通常は自動リトライで回復する。

手動でリトライを促したい場合:

```bash
docker service update --force iku_counter
```

### cloudflared が起動しない / Cloudflare Tunnel error

**原因:** `TUNNEL_TOKEN` が空のままデプロイされている。

確認:

```bash
docker service inspect iku_cloudflared --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'
# ["TUNNEL_TOKEN="] ← 空なら問題
```

**原因1:** `.env` に `TUNNEL_TOKEN` が書かれていない → `.env` に追記する。

**原因2:** `update.sh` で `. .env` が失敗している（`source` を使っている場合、`/bin/sh` では動かない）。

```bash
# update.sh の該当行を確認
grep -n "source\|TUNNEL" ~/update.sh
```

`.env` を `. .env`（ドット）で読み込むように修正してから再デプロイ:

```bash
set -a && . ~/SenARMapProject_2026/deploy_env/.env && set +a
docker stack deploy --with-registry-auth -c ~/SenARMapProject_2026/deploy_env/docker-compose.yml iku
```

### prometheus が cadvisor を scrape できない（permission denied）

**原因:** prometheus コンテナがデフォルトの非rootユーザーで動いており、`docker.sock` にアクセスできない。

`docker-compose.yml` の prometheus サービスに `user: root` が設定されているか確認する。
設定されていない場合は即時修正:

```bash
docker service update --user root iku_prometheus
```

永続化するには `docker-compose.yml` の prometheus に `user: root` を追加してデプロイし直す。

### cron から update.sh を実行すると環境変数が入らない

**原因:** `/etc/crontab` の `SHELL=/bin/sh` 配下で `source` コマンドが使えない。

`update.sh` の `.env` 読み込み行を修正:

```bash
# NG（bash専用）
set -a && source .env && set +a

# OK（POSIX準拠・sh/bash両対応）
set -a && . /home/project-prod/SenARMapProject_2026/deploy_env/.env && set +a
```

絶対パスを使うことで、スクリプトがどのディレクトリから呼ばれても確実に読み込まれる。

### ワーカーノードが Pending のまま

ファイアウォールのポート（2377/tcp, 7946/tcp+udp, 4789/udp）が開いているか確認:

```bash
# マネージャー側で確認
sudo ufw status
# または
sudo iptables -L -n | grep -E "2377|7946|4789"
```

### cadvisor がワーカーで起動しない

`mode: global` のサービスなのでワーカー参加時に自動起動するはず。
起動していない場合:

```bash
docker service ps iku_cadvisor
docker service logs iku_cadvisor
```

### docker stack ps の履歴が多くて見づらい

`\_` 付きの行は過去の失敗タスクの履歴で、現在のコンテナには影響しない。
現在実行中のもの（`\_` なし）だけ確認したい場合:

```bash
docker stack ps iku --filter "desired-state=running"
```

履歴の保持数自体を減らすには「コンテナのお掃除」の §2（`--task-history-limit 1`）を参照。
