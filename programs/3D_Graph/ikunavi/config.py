"""データファイルのパスと、経路探索・描画で使う定数。

ここにある値はデータの意味そのものに関わるため、変更するときは
data/ 配下のCSVの作り方（programs/IKU_NAVI_Tools の「マップ編集」タブ）と合わせて見直すこと。
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DATA_DIR = os.path.join(BASE_DIR, "../../data")

# 環境変数 IKUNAVI_DATA_DIR を設定すると、リポジトリの data/ ではなくそちらを読む。
# テスト（programs/3D_Graph/tests）や、別のデータセットで動きを確かめたいときに使う。
# パスは読み込みのたびに解決するので、実行中に切り替えても次の読み込みから反映される
# （キャッシュ済みのデータは ikunavi.clear_all_caches() で捨てること）。
DATA_DIR_ENV = "IKUNAVI_DATA_DIR"


def data_dir():
    return os.environ.get(DATA_DIR_ENV) or DEFAULT_DATA_DIR


def data_path(name):
    """data/ 配下のファイルの絶対パス"""
    return os.path.join(data_dir(), name)


def building_dir(building):
    """data/{building}_bldg/"""
    return data_path(f"{int(building)}_bldg")

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
    # 時間割共有（programs/timetables）が、教室の選択肢を作るために /api/all を読む
    "https://timetables.iku-navi.net",
}


def cors_extra_origins():
    """環境変数 IKUNAVI_CORS_EXTRA_ORIGINS（カンマ区切り）で許可オリジンを足す。
    ローカルで時間割共有（wrangler pages dev）からこのAPIを読んで動作確認するとき用。本番では設定しない。"""
    raw = os.environ.get("IKUNAVI_CORS_EXTRA_ORIGINS", "")
    return {o.strip() for o in raw.split(",") if o.strip()}


CORS_ORIGIN_PATTERN = r"^https://[a-z0-9.-]+\.pages\.dev$"  # Pages プレビュー用
