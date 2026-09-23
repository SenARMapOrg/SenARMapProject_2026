"""3Dビューア(/3d)向けの、グラフ全体を1レスポンスにまとめたペイロード。

ノード数が数千規模で毎回組み立てると重いので、構築結果をそのまま保持する。
"""
import pandas as pd

from .cache import get_data
from .config import BUILDING_COLORS, OUTDOOR_COLOR
from .serialize import edge_to_dict
from .transform import resolved_transform_config

_graph_payload = None


def _building_color(building):
    if building == 0:
        return OUTDOOR_COLOR
    return BUILDING_COLORS[(building - 1) % len(BUILDING_COLORS)]


def _node_dict(row):
    bldg = int(row["building"])
    node_dict = {
        "id":       int(row["id"]),
        "x":        float(row["x"]),
        "y":        float(row["y"]),
        "z":        float(row["z"]),
        "building": bldg,
        "floor":    int(row["floor"]),
        "type":     int(row["type"]),
        "color":    _building_color(bldg),
        "label":    f"Node {int(row['id'])}<br>{'屋外' if bldg == 0 else f'Building {bldg}'} / Floor {int(row['floor'])}",
    }
    if "lat" in row and pd.notna(row["lat"]):
        node_dict["lat"] = float(row["lat"])
    if "lng" in row and pd.notna(row["lng"]):
        node_dict["lng"] = float(row["lng"])
    return node_dict


def get_graph_payload():
    """/api/graph 用のノード・エッジ・変換設定を一度だけ構築して使い回す"""
    global _graph_payload
    if _graph_payload is None:
        nodes_df, edges_df = get_data()

        nodes = [
            _node_dict(row)
            for _, row in nodes_df.iterrows()
            if not any(pd.isna(row[c]) for c in ["id", "x", "y", "z", "building", "floor"])
        ]
        valid_edges = edges_df.dropna(subset=["id", "from", "to", "building", "floor", "weight", "length"])
        edges = [edge_to_dict(row) for _, row in valid_edges.iterrows()]

        _graph_payload = {
            "nodes": nodes,
            "edges": edges,
            "building_colors": BUILDING_COLORS,
            "config": resolved_transform_config(),
        }
    return _graph_payload


def clear_caches():
    global _graph_payload
    _graph_payload = None
