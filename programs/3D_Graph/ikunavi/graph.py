"""ノード表・エッジ表から NetworkX の有向グラフを組み立てる。

双方向に歩ける通路は往復2本の辺として張り、進行方向で左右が入れ替わるため
right/left 属性も反転させて持たせる。エスカレータ(type 5/6)だけは
高低差から通行可能な向きを決めて片方向のみ張る。
"""
import networkx as nx
import pandas as pd

from .config import ENTRANCE_PENALTY

# 上りエスカレータ(5)・下りエスカレータ(6)は一方向のみ
DIRECTED_EDGE_TYPES = {"5", "6"}
ELEVATOR_EDGE_TYPE = "4"
ENTRANCE_EDGE_TYPE = "7"


def _node_attrs(row):
    attrs = dict(
        x=float(row["x"]),
        y=float(row["y"]),
        z=float(row["z"]),
        building=int(row["building"]),
        floor=int(row["floor"]),
        node_type=int(row["type"]),
    )
    if "lat" in row and pd.notna(row["lat"]):
        attrs["lat"] = float(row["lat"])
    if "lng" in row and pd.notna(row["lng"]):
        attrs["lng"] = float(row["lng"])
    if "svg_x" in row and pd.notna(row["svg_x"]):
        attrs["svg_x"] = float(row["svg_x"])
        attrs["svg_y"] = float(row["svg_y"])
    return attrs


def _edge_attrs(row, edge_type):
    return dict(
        edge_id=int(row["id"]),
        name=str(row["name"]),
        right=str(row.get("right", "")),
        left=str(row.get("left", "")),
        building=int(row["building"]),
        floor=int(row["floor"]),
        weight=float(row["weight"]) * float(row["length"])
               + (ENTRANCE_PENALTY if edge_type == ENTRANCE_EDGE_TYPE else 0.0),
        length=float(row["length"]),
        edge_type=edge_type,
    )


def build_graph(nodes_df, edges_df, use_elevator=True):
    G = nx.DiGraph()
    for _, row in nodes_df.iterrows():
        G.add_node(int(row["id"]), **_node_attrs(row))

    for _, row in edges_df.iterrows():
        edge_type = str(row["type"]).strip()
        if not use_elevator and edge_type == ELEVATOR_EDGE_TYPE:
            continue
        u, v = int(row["from"]), int(row["to"])
        edge_attrs = _edge_attrs(row, edge_type)

        if edge_type == "5":
            # 上りESC: z が低い→高い方向のみ通行可
            lo, hi = (u, v) if G.nodes[u]["z"] <= G.nodes[v]["z"] else (v, u)
            G.add_edge(lo, hi, **edge_attrs)
        elif edge_type == "6":
            # 下りESC: z が高い→低い方向のみ通行可
            hi, lo = (u, v) if G.nodes[u]["z"] >= G.nodes[v]["z"] else (v, u)
            G.add_edge(hi, lo, **edge_attrs)
        else:
            G.add_edge(u, v, **edge_attrs)
            if edge_type not in DIRECTED_EDGE_TYPES:
                # 逆方向(v→u)は進行方向が反転するため、right/leftも入れ替えて渡す
                reversed_attrs = dict(edge_attrs, right=edge_attrs["left"], left=edge_attrs["right"])
                G.add_edge(v, u, **reversed_attrs)
    return G
