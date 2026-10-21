#!/bin/sh
# Cloudflare Pages のビルドコマンドとして実行するスクリプト。
#   Build command:          sh deploy_env/pages/build.sh
#   Build output directory: programs/html
#   環境変数:               GOOGLE_MAPS_API_KEY（Production / Preview 両方に設定）
#
# 旧 deploy_env/nginx/docker-entrypoint.sh が行っていた config.js 生成の移植。
set -e

if [ -z "$GOOGLE_MAPS_API_KEY" ]; then
    echo "ERROR: GOOGLE_MAPS_API_KEY is not set." >&2
    exit 1
fi

CONFIG_FILE="programs/html/navi/script/config.js"

mkdir -p "$(dirname "$CONFIG_FILE")"
cat > "$CONFIG_FILE" <<EOF
const CONFIG = {
  GOOGLE_MAPS_API_KEY: "${GOOGLE_MAPS_API_KEY}"
};
EOF

echo "[pages] config.js generated."

# 建物ごとの教室一覧・フロアマップ（/campus/）と sitemap.xml を data/ から作る（検索エンジン向け）。
# 失敗してもサイト本体は出せるよう、ビルドは止めない（そのときはリポジトリの sitemap.xml のまま）
if command -v python3 >/dev/null 2>&1; then
    python3 deploy_env/pages/generate_campus_pages.py || echo "[pages] WARN: campus pages were not generated." >&2
else
    echo "[pages] WARN: python3 not found; campus pages were not generated." >&2
fi
