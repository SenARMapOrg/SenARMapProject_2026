"""data/ 配下のCSVを読み込み、全建物＋屋外をつないだ1組のDataFrameにまとめる。

出力は「グローバルID空間」に正規化済みのノード表・エッジ表で、以降の
グラフ構築・教室索引はすべてこの2つだけを入力にする。
"""
import glob
import os
import re

import pandas as pd

from .config import (
    ANCHOR_EDGE_ID_BASE,
    GLOBAL_NODE_OFFSET,
    ID_OFFSET,
    data_dir,
    data_path,
)
from .transform import apply_transform, resolved_transform_config


def _read_csv(path, **kwargs):
    """列名の前後空白を落としてCSVを読む（手書きCSVの揺れを吸収する）"""
    df = pd.read_csv(path, **kwargs)
    df.columns = df.columns.str.strip()
    return df


def _load_building_frames(config):
    """data/{N}_bldg/ を全て読み、ローカルID→グローバルID変換と座標変換をかける"""
    nodes, edges = [], []
    for bldg_dir in sorted(glob.glob(os.path.join(data_dir(), "*_bldg"))):
        m = re.match(r'(\d+)_bldg', os.path.basename(bldg_dir))
        if not m:
            continue
        bldg_id = int(m.group(1))

        nodes_df = _read_csv(os.path.join(bldg_dir, "node.csv"))
        edges_df = _read_csv(os.path.join(bldg_dir, "edge.csv"))
        if nodes_df.empty:
            continue

        # ローカルID → グローバルID (building * ID_OFFSET + local_id)
        offset = bldg_id * ID_OFFSET
        nodes_df["id"]   += offset
        edges_df["id"]   += offset
        edges_df["from"] += offset
        edges_df["to"]   += offset

        # 座標変換 (平行移動 + Z軸回転)
        nodes_df = apply_transform(nodes_df, config.get(str(bldg_id), {}))

        nodes.append(nodes_df)
        edges.append(edges_df)
    return nodes, edges


def _load_connect_edges():
    """建物間接続CSV: グローバルIDで記述、存在する場合のみ読み込む"""
    path = data_path("connect_edge.csv")
    if not os.path.exists(path):
        return None
    conn_df = _read_csv(path)
    return conn_df if not conn_df.empty else None


def _load_global_nodes():
    """屋外ノード (global_node.csv) — building=0 として追加。戻り値: (DataFrame|None, 元のID集合)"""
    path = data_path("global_node.csv")
    if not os.path.exists(path):
        return None, set()
    gn_raw = _read_csv(path).dropna(subset=["id", "x", "y", "z"])
    if gn_raw.empty:
        return None, set()

    global_node_ids = set(gn_raw["id"].astype(int))
    gn_raw = gn_raw.copy()
    gn_raw["id"] = gn_raw["id"].astype(int) + GLOBAL_NODE_OFFSET
    gn_raw["building"] = 0
    for col, default in [("floor", 1), ("type", 1)]:
        if col not in gn_raw.columns:
            gn_raw[col] = default
    return gn_raw, global_node_ids


def _load_global_edges(global_node_ids):
    """屋外エッジ (global_edge.csv) — from/to の小さいIDはグローバルノードローカルID"""
    path = data_path("global_edge.csv")
    if not os.path.exists(path):
        return None
    ge_raw = _read_csv(path).dropna(subset=["id", "from", "to"])
    if ge_raw.empty:
        return None

    def _resolve(x):
        xi = int(x)
        return xi + GLOBAL_NODE_OFFSET if xi in global_node_ids else xi

    ge_raw = ge_raw.copy()
    ge_raw["from"] = ge_raw["from"].astype(int).apply(_resolve)
    ge_raw["to"]   = ge_raw["to"].astype(int).apply(_resolve)
    for col, default in [("building", 0), ("name", ""), ("floor", 1),
                         ("type", 1), ("weight", 1.0), ("length", 0.0)]:
        if col not in ge_raw.columns:
            ge_raw[col] = default
    return ge_raw


def _build_anchor_edges():
    """anchors.csv から、グローバルノードとローカルノードを繋ぐエッジを生成する"""
    path = data_path("anchors.csv")
    if not os.path.exists(path):
        return None
    anchors_df = _read_csv(path)
    if anchors_df.empty:
        return None

    anchor_edges = []
    for idx, row in anchors_df.iterrows():
        bldg_id = int(row["building"])
        l_id = int(row["local_node_id"])
        g_id = int(row["global_node_id"])

        anchor_edges.append({
            "id": ANCHOR_EDGE_ID_BASE + idx,
            "from": bldg_id * ID_OFFSET + l_id,
            "to": g_id + GLOBAL_NODE_OFFSET,
            "building": 0,
            "floor": 1,
            "weight": 1.0,
            "length": 0.0,
            "type": 7,
            "name": "",
        })
    return pd.DataFrame(anchor_edges) if anchor_edges else None


def _normalize(nodes_combined, edges_combined):
    """欠損行の除外と、エッジの name/type/right/left 列の型そろえ"""
    # NaN・座標欠損行のみ除外（building=0 = 屋外ノードは許容）
    nodes_combined = nodes_combined.dropna(subset=["id", "x", "y", "z", "building", "floor"])
    valid_ids = set(nodes_combined["id"])
    edges_combined = edges_combined[
        edges_combined["from"].isin(valid_ids) & edges_combined["to"].isin(valid_ids)
    ].copy()   # 以降の列の書き換えが元のDataFrameのスライスにならないようにする

    edges_combined["name"] = edges_combined["name"].fillna("").astype(str)
    # 空行によりfloat化したtype列を整数に正規化 ("1.0" → "1" となるよう)
    edges_combined["type"] = pd.to_numeric(edges_combined["type"], errors="coerce").fillna(1).astype(int)
    # right/left列（進行方向の右側・左側にある教室名を、nameとは独立にfrom→toの正しい順序で
    # ";"区切りで入れたもの。nameのリストは順序通りとは限らないため別立てにしている）は
    # まだ一部の建物のedge.csvにしか無い任意列。無い建物の行はNaNになるので空文字にする。
    for col in ("right", "left"):
        if col not in edges_combined.columns:
            edges_combined[col] = ""
        edges_combined[col] = edges_combined[col].fillna("").astype(str)
    return nodes_combined, edges_combined


def load_data():
    """全建物＋屋外のノード・エッジを読み込み、(nodes_df, edges_df) を返す"""
    config = resolved_transform_config()
    all_nodes, all_edges = _load_building_frames(config)

    conn_df = _load_connect_edges()
    if conn_df is not None:
        all_edges.append(conn_df)

    gn_df, global_node_ids = _load_global_nodes()
    if gn_df is not None:
        all_nodes.append(gn_df)

    ge_df = _load_global_edges(global_node_ids)
    if ge_df is not None:
        all_edges.append(ge_df)

    anchor_df = _build_anchor_edges()
    if anchor_df is not None:
        all_edges.append(anchor_df)

    if not all_nodes:
        return pd.DataFrame(), pd.DataFrame()

    return _normalize(pd.concat(all_nodes, ignore_index=True),
                      pd.concat(all_edges, ignore_index=True))
