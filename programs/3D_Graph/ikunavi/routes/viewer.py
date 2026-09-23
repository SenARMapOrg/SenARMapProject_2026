"""3Dグラフビューア（開発・データ確認用の画面とそのデータ）"""
from flask import Blueprint, jsonify, render_template

from .. import cache
from ..payloads import get_graph_payload

bp = Blueprint("viewer", __name__)


@bp.route("/3d/")
@bp.route("/3d")
def index():
    nodes_df, _ = cache.get_data()
    node_ids  = sorted(nodes_df["id"].tolist())
    # building=0 (屋外) はフィルタの「すべての建物」(value=0) と衝突するため除外
    buildings = sorted(int(b) for b in nodes_df["building"].unique() if int(b) != 0)
    return render_template("index.html", node_ids=node_ids, buildings=buildings)


@bp.route("/api/graph")
def api_graph():
    return jsonify(get_graph_payload())
