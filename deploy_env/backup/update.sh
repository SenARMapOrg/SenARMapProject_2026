#!/bin/sh
# バックアップ環境を今のブランチの最新にする。cron からも実行できる。
# 止めたいときは、このフォルダに update.lock を置く。
set -eu
cd "$(dirname "$0")"

[ -f update.lock ] && exit 0

# Cloudflare が使えないときでも、手元のデータのまま動かし続けられるようにする
git pull --ff-only || echo "[backup] WARN: git pull failed; using the current checkout." >&2

set -a
. ./.env
set +a

python3 build_site.py
python3 sync_cdn.py || echo "[backup] WARN: some images were not copied." >&2

docker compose up -d --build --remove-orphans
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
docker image prune -f >/dev/null
