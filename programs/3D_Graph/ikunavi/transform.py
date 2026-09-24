"""建物ローカル座標 → キャンパス共通座標 への変換パラメータの算出と適用。

各建物の node.csv はその建物だけのローカル座標で書かれている。これを
anchors.csv（ローカルノードと屋外ノードの対応）から求めた回転・平行移動で
共通座標に載せ替えることで、建物をまたぐ経路探索ができるようになる。
座標系の考え方は docs/XYZ_Design.md を参照。
"""
import json
import math
import os

import pandas as pd

from .config import building_dir, data_path


def load_transform_config():
    """buildings.json に手書きされた変換パラメータを読む（無ければ空）"""
    path = data_path("buildings.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def calc_transforms_from_anchors():
    """
    global_node.csv と anchors.csv から各建物の変換パラメータを自動計算する。
    2点アンカー: 回転+平行移動を自動計算。
    1点アンカー: 平行移動のみ自動計算、rot_deg は buildings.json から取得（なければ 0）。
    tz_offset が buildings.json にあれば加算する。
    """
    global_node_csv = data_path("global_node.csv")
    anchors_csv = data_path("anchors.csv")
    if not os.path.exists(global_node_csv) or not os.path.exists(anchors_csv):
        return {}

    gn = pd.read_csv(global_node_csv)
    gn.columns = gn.columns.str.strip()
    if gn.empty:
        return {}
    gn = gn.set_index("id")

    anchors = pd.read_csv(anchors_csv)
    anchors.columns = anchors.columns.str.strip()
    if anchors.empty:
        return {}

    config = load_transform_config()
    transforms = {}
    for bldg_id, group in anchors.groupby("building"):
        if len(group) < 1:
            continue

        bldg_cfg = config.get(str(int(bldg_id)), {})
        r0 = group.iloc[0]

        local_nodes = pd.read_csv(os.path.join(building_dir(bldg_id), "node.csv"))
        local_nodes.columns = local_nodes.columns.str.strip()
        local_nodes = local_nodes.set_index("id")

        lx1 = float(local_nodes.loc[int(r0["local_node_id"]), "x"])
        ly1 = float(local_nodes.loc[int(r0["local_node_id"]), "y"])
        lz1 = float(local_nodes.loc[int(r0["local_node_id"]), "z"])

        gx1 = float(gn.loc[int(r0["global_node_id"]), "x"])
        gy1 = float(gn.loc[int(r0["global_node_id"]), "y"])
        gz1 = float(gn.loc[int(r0["global_node_id"]), "z"])

        if len(group) >= 2:
            r1 = group.iloc[1]
            lx2 = float(local_nodes.loc[int(r1["local_node_id"]), "x"])
            ly2 = float(local_nodes.loc[int(r1["local_node_id"]), "y"])
            gx2 = float(gn.loc[int(r1["global_node_id"]), "x"])
            gy2 = float(gn.loc[int(r1["global_node_id"]), "y"])
            θ = math.atan2(gy2 - gy1, gx2 - gx1) - math.atan2(ly2 - ly1, lx2 - lx1)
        else:
            # 1点アンカー: buildings.json の rot_deg を回転として使用
            θ = math.radians(bldg_cfg.get("rot_deg", 0.0))

        cos_θ, sin_θ = math.cos(θ), math.sin(θ)
        tx = gx1 - (cos_θ * lx1 - sin_θ * ly1)
        ty = gy1 - (sin_θ * lx1 + cos_θ * ly1)
        tz = gz1 - lz1 + bldg_cfg.get("tz_offset", 0.0)

        transforms[str(int(bldg_id))] = {
            "tx": tx, "ty": ty, "tz": tz,
            "rot_deg": math.degrees(θ),
        }

    return transforms


def resolved_transform_config():
    """buildings.json をベースに、anchors.csv がある建物は自動計算で上書きした設定"""
    config = load_transform_config()
    config.update(calc_transforms_from_anchors())
    return config


def apply_transform(nodes_df, cfg):
    """変換パラメータをノード座標に適用する"""
    θ  = math.radians(cfg.get("rot_deg", 0.0))
    tx = cfg.get("tx", 0.0)
    ty = cfg.get("ty", 0.0)
    tz = cfg.get("tz", 0.0)
    nodes_df = nodes_df.copy()
    if θ != 0:
        cos_θ, sin_θ = math.cos(θ), math.sin(θ)
        lx, ly = nodes_df["x"].copy(), nodes_df["y"].copy()
        nodes_df["x"] = cos_θ * lx - sin_θ * ly + tx
        nodes_df["y"] = sin_θ * lx + cos_θ * ly + ty
    else:
        nodes_df["x"] += tx
        nodes_df["y"] += ty
    nodes_df["z"] += tz
    return nodes_df
