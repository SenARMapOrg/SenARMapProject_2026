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

# 経路探索APIの「読むだけ」のデータ（/api/graph・/api/all・/api/edge_images）を、静的なJSON（/data/*.json）として書き出す。
# Pages から直接配るので、サーバー（api.iku-navi.net）に頼らず速く読める（静的な配信は無料・無制限）。
# 中身は API とまったく同じにするため、programs/3D_Graph の Flask アプリをそのまま動かして作る（docs/static_data.md）。
# いまは失敗してもビルドは止めない（画面は /data/*.json が無ければ今までどおり API を読む）
if command -v python3 >/dev/null 2>&1; then
    if python3 -m pip install --quiet --disable-pip-version-check -r deploy_env/python/requirements.txt; then
        python3 programs/3D_Graph/export_static.py --out programs/html || echo "[pages] WARN: static data was not exported." >&2
    else
        echo "[pages] WARN: could not install Python packages; static data was not exported." >&2
    fi
else
    echo "[pages] WARN: python3 not found; static data was not exported." >&2
fi
