"""エッジ（区間）ごとの経路写真のURL一覧"""
import os

import pandas as pd
from flask import Blueprint, jsonify

from ..config import CDN_BASE, data_path

bp = Blueprint("images", __name__)


@bp.route("/api/edge_images")
def api_edge_images():
    """
    エッジ画像マップを返す。
    返却形式: { "1000001_1000002": "https://cdn.iku-navi.net/1000001_to_1000002.jpg", ... }
    """
    edge_image_csv = data_path("edge_image.csv")
    if not os.path.exists(edge_image_csv):
        return jsonify({})
    df = pd.read_csv(edge_image_csv)
    df.columns = df.columns.str.strip()
    df = df.dropna(subset=["from", "to"])
    result = {}
    for _, row in df.iterrows():
        f, t = int(row["from"]), int(row["to"])
        if f == 0 and t == 0:
            continue
        name = str(row["image_name"]).strip()
        if not name or name == "nan":
            continue
        result[f"{f}_{t}"] = f"{CDN_BASE}/{name}"
    return jsonify(result)
