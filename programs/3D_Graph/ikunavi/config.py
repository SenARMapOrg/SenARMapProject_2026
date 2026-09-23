"""データファイルのパスと、経路探索・描画で使う定数。

ここにある値はデータの意味そのものに関わるため、変更するときは
data/ 配下のCSVの作り方（programs/Map_Editor）と合わせて見直すこと。
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "../../data")

BUILDINGS_JSON    = os.path.join(DATA_DIR, "buildings.json")
ANCHORS_CSV       = os.path.join(DATA_DIR, "anchors.csv")
CONNECT_EDGE_CSV  = os.path.join(DATA_DIR, "connect_edge.csv")
GLOBAL_NODE_CSV   = os.path.join(DATA_DIR, "global_node.csv")
GLOBAL_EDGE_CSV   = os.path.join(DATA_DIR, "global_edge.csv")
EDGE_IMAGE_CSV    = os.path.join(DATA_DIR, "edge_image.csv")
CAFETERIA_CSV     = os.path.join(DATA_DIR, "cafeteria_edge.csv")
NAME_CSV          = os.path.join(DATA_DIR, "name.csv")
BUILDING_NAME_CSV = os.path.join(DATA_DIR, "building_name.csv")
EVENT_CSV         = os.path.join(DATA_DIR, "event.csv")
IGNORE_CSV        = os.path.join(DATA_DIR, "ignore.csv")

CDN_BASE = "https://cdn.iku-navi.net"

# グローバルID = building_id * ID_OFFSET + ローカルID
ID_OFFSET          = 100_000
GLOBAL_NODE_OFFSET = 9_000_000   # 屋外ノードIDのオフセット
ANCHOR_EDGE_ID_BASE = 8_000_000  # anchors.csv から生成する仮想エッジのID開始値

# 建物出入り口を通過するコスト加算（単位: weight×length と同じ ≒ メートル相当）
# 値を大きくするほど建物を通り抜けるルートを避けやすくなる
# 0 にするとペナルティなし（従来動作）
ENTRANCE_PENALTY = 50.0

OUTDOOR_COLOR = "#5AFF5A"

# Building color palette (up to 10 buildings)
BUILDING_COLORS = [
    "#4C9BE8", "#E8774C", "#4CE87A", "#E8D44C",
    "#C44CE8", "#4CE8D4", "#E84C7A", "#9BE84C",
    "#E8A44C", "#4C74E8",
]

# Cloudflare Pages (iku-navi.net) から api.iku-navi.net へのクロスオリジン fetch を許可する。
# nginx 撤去後は cloudflared → Flask 直結のため、CORS ヘッダはここで返す。
# API は GET のみ・カスタムヘッダなしの「単純リクエスト」なのでプリフライト対応は不要。
CORS_ALLOWED_ORIGINS = {
    "https://iku-navi.net",
    "https://www.iku-navi.net",
}
CORS_ORIGIN_PATTERN = r"^https://[a-z0-9.-]+\.pages\.dev$"  # Pages プレビュー用
