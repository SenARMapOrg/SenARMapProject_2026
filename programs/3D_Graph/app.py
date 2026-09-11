import os
import glob
import json
import math
import re
import pandas as pd
import networkx as nx
from flask import Flask, render_template, jsonify, request

app = Flask(__name__)

# Cloudflare Pages (iku-navi.net) から api.iku-navi.net へのクロスオリジン fetch を許可する。
# nginx 撤去後は cloudflared → Flask 直結のため、CORS ヘッダはここで返す。
# API は GET のみ・カスタムヘッダなしの「単純リクエスト」なのでプリフライト対応は不要。
CORS_ALLOWED_ORIGINS = {
    "https://iku-navi.net",
    "https://www.iku-navi.net",
}
CORS_ORIGIN_PATTERN = re.compile(r"^https://[a-z0-9.-]+\.pages\.dev$")  # Pages プレビュー用


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if origin in CORS_ALLOWED_ORIGINS or CORS_ORIGIN_PATTERN.match(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


BASE_DIR        = os.path.dirname(os.path.abspath(__file__))
DATA_DIR        = os.path.join(BASE_DIR, "../../data")
BUILDINGS_JSON  = os.path.join(DATA_DIR, "buildings.json")
CONNECT_EDGE_CSV = os.path.join(DATA_DIR, "connect_edge.csv")
GLOBAL_NODE_CSV  = os.path.join(DATA_DIR, "global_node.csv")
GLOBAL_EDGE_CSV  = os.path.join(DATA_DIR, "global_edge.csv")
EDGE_IMAGE_CSV      = os.path.join(DATA_DIR, "edge_image.csv")
CAFETERIA_CSV       = os.path.join(DATA_DIR, "cafeteria_edge.csv")
NAME_CSV            = os.path.join(DATA_DIR, "name.csv")
BUILDING_NAME_CSV   = os.path.join(DATA_DIR, "building_name.csv")
EVENT_CSV           = os.path.join(DATA_DIR, "event.csv")
IGNORE_CSV          = os.path.join(DATA_DIR, "ignore.csv")
CDN_BASE         = "https://cdn.iku-navi.net"

# グローバルID = building_id * ID_OFFSET + ローカルID
ID_OFFSET          = 100_000
GLOBAL_NODE_OFFSET = 9_000_000   # 屋外ノードIDのオフセット

# 建物出入り口を通過するコスト加算（単位: weight×length と同じ ≒ メートル相当）
# 値を大きくするほど建物を通り抜けるルートを避けやすくなる
# 0 にするとペナルティなし（従来動作）
ENTRANCE_PENALTY   = 50.0
OUTDOOR_COLOR      = "#5AFF5A"

# Building color palette (up to 10 buildings)
BUILDING_COLORS = [
    "#4C9BE8", "#E8774C", "#4CE87A", "#E8D44C",
    "#C44CE8", "#4CE8D4", "#E84C7A", "#9BE84C",
    "#E8A44C", "#4C74E8",
]


def _load_transform_config():
    if os.path.exists(BUILDINGS_JSON):
        with open(BUILDINGS_JSON) as f:
            return json.load(f)
    return {}


def _calc_transforms_from_anchors():
    """
    global_node.csv と anchors.csv から各建物の変換パラメータを自動計算する。
    2点アンカー: 回転+平行移動を自動計算。
    1点アンカー: 平行移動のみ自動計算、rot_deg は buildings.json から取得（なければ 0）。
    tz_offset が buildings.json にあれば加算する。
    """
    anchor_path = os.path.join(DATA_DIR, "anchors.csv")

    if not os.path.exists(GLOBAL_NODE_CSV) or not os.path.exists(anchor_path):
        return {}

    gn = pd.read_csv(GLOBAL_NODE_CSV)
    gn.columns = gn.columns.str.strip()
    if gn.empty:
        return {}
    gn = gn.set_index("id")

    anchors = pd.read_csv(anchor_path)
    anchors.columns = anchors.columns.str.strip()
    if anchors.empty:
        return {}

    config = _load_transform_config()
    transforms = {}
    for bldg_id, group in anchors.groupby("building"):
        if len(group) < 1:
            continue

        bldg_cfg = config.get(str(int(bldg_id)), {})
        r0 = group.iloc[0]

        bldg_dir = os.path.join(DATA_DIR, f"{int(bldg_id)}_bldg")
        local_nodes = pd.read_csv(os.path.join(bldg_dir, "node.csv"))
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


def _apply_transform(nodes_df, cfg):
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


def load_data():
    # buildings.json をベースに、anchors.csv がある建物は自動計算で上書き
    config = _load_transform_config()
    config.update(_calc_transforms_from_anchors())
    all_nodes, all_edges = [], []

    for bldg_dir in sorted(glob.glob(os.path.join(DATA_DIR, "*_bldg"))):
        m = re.match(r'(\d+)_bldg', os.path.basename(bldg_dir))
        if not m:
            continue
        bldg_id = int(m.group(1))

        nodes_df = pd.read_csv(os.path.join(bldg_dir, "node.csv"))
        edges_df = pd.read_csv(os.path.join(bldg_dir, "edge.csv"))
        nodes_df.columns = nodes_df.columns.str.strip()
        edges_df.columns = edges_df.columns.str.strip()

        if nodes_df.empty:
            continue

        # ローカルID → グローバルID (building * ID_OFFSET + local_id)
        offset = bldg_id * ID_OFFSET
        nodes_df["id"]   += offset
        edges_df["id"]   += offset
        edges_df["from"] += offset
        edges_df["to"]   += offset

        # 座標変換 (平行移動 + Z軸回転)
        nodes_df = _apply_transform(nodes_df, config.get(str(bldg_id), {}))

        all_nodes.append(nodes_df)
        all_edges.append(edges_df)

    # 建物間接続CSV: グローバルIDで記述、存在する場合のみ読み込む
    if os.path.exists(CONNECT_EDGE_CSV):
        conn_df = pd.read_csv(CONNECT_EDGE_CSV)
        conn_df.columns = conn_df.columns.str.strip()
        if not conn_df.empty:
            all_edges.append(conn_df)

    # 屋外ノード (global_node.csv) — building=0 として追加
    global_node_ids: set = set()
    if os.path.exists(GLOBAL_NODE_CSV):
        gn_raw = pd.read_csv(GLOBAL_NODE_CSV)
        gn_raw.columns = gn_raw.columns.str.strip()
        gn_raw = gn_raw.dropna(subset=["id", "x", "y", "z"])
        if not gn_raw.empty:
            global_node_ids = set(gn_raw["id"].astype(int))
            gn_raw = gn_raw.copy()
            gn_raw["id"] = gn_raw["id"].astype(int) + GLOBAL_NODE_OFFSET
            gn_raw["building"] = 0
            for col, default in [("floor", 1), ("type", 1)]:
                if col not in gn_raw.columns:
                    gn_raw[col] = default
            all_nodes.append(gn_raw)

    # 屋外エッジ (global_edge.csv) — from/to の小さいIDはグローバルノードローカルID
    if os.path.exists(GLOBAL_EDGE_CSV):
        ge_raw = pd.read_csv(GLOBAL_EDGE_CSV)
        ge_raw.columns = ge_raw.columns.str.strip()
        ge_raw = ge_raw.dropna(subset=["id", "from", "to"])
        if not ge_raw.empty:
            def _resolve(x, _ids=global_node_ids):
                xi = int(x)
                return xi + GLOBAL_NODE_OFFSET if xi in _ids else xi
            ge_raw = ge_raw.copy()
            ge_raw["from"] = ge_raw["from"].astype(int).apply(_resolve)
            ge_raw["to"]   = ge_raw["to"].astype(int).apply(_resolve)
            for col, default in [("building", 0), ("name", ""), ("floor", 1),
                                  ("type", 1), ("weight", 1.0), ("length", 0.0)]:
                if col not in ge_raw.columns:
                    ge_raw[col] = default
            all_edges.append(ge_raw)

    # anchors.csvから、グローバルノードとローカルノードを繋ぐエッジを生成
    anchor_path = os.path.join(DATA_DIR, "anchors.csv")
    if os.path.exists(anchor_path):
        anchors_df = pd.read_csv(anchor_path)
        anchors_df.columns = anchors_df.columns.str.strip()
        if not anchors_df.empty:
            anchor_edges = []
            for idx, row in anchors_df.iterrows():
                bldg_id = int(row["building"])
                l_id = int(row["local_node_id"])
                g_id = int(row["global_node_id"])

                local_global_id = bldg_id * ID_OFFSET + l_id
                outdoor_global_id = g_id + GLOBAL_NODE_OFFSET

                anchor_edges.append({
                    "id": 8000000 + idx,
                    "from": local_global_id,
                    "to": outdoor_global_id,
                    "building": 0,
                    "floor": 1,
                    "weight": 1.0,
                    "length": 0.0,
                    "type": 7,
                    "name": ""
                })
            if anchor_edges:
                all_edges.append(pd.DataFrame(anchor_edges))

    if not all_nodes:
        return pd.DataFrame(), pd.DataFrame()

    nodes_combined = pd.concat(all_nodes, ignore_index=True)
    edges_combined = pd.concat(all_edges, ignore_index=True)

    # NaN・座標欠損行のみ除外（building=0 = 屋外ノードは許容）
    nodes_combined = nodes_combined.dropna(subset=["id", "x", "y", "z", "building", "floor"])
    valid_ids = set(nodes_combined["id"])
    edges_combined = edges_combined[
        edges_combined["from"].isin(valid_ids) & edges_combined["to"].isin(valid_ids)
    ]

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


_DIRECTED_EDGE_TYPES = {"5", "6"}  # 上りエスカレータ(5)・下りエスカレータ(6)は一方向のみ


def build_graph(nodes_df, edges_df, use_elevator=True):
    G = nx.DiGraph()
    for _, row in nodes_df.iterrows():
        node_attrs = dict(
            x=float(row["x"]),
            y=float(row["y"]),
            z=float(row["z"]),
            building=int(row["building"]),
            floor=int(row["floor"]),
            node_type=int(row["type"]),
        )
        if "lat" in row and pd.notna(row["lat"]):
            node_attrs["lat"] = float(row["lat"])
        if "lng" in row and pd.notna(row["lng"]):
            node_attrs["lng"] = float(row["lng"])
        if "svg_x" in row and pd.notna(row["svg_x"]):
            node_attrs["svg_x"] = float(row["svg_x"])
            node_attrs["svg_y"] = float(row["svg_y"])
        G.add_node(int(row["id"]), **node_attrs)
    for _, row in edges_df.iterrows():
        edge_type = str(row["type"]).strip()
        if not use_elevator and edge_type == "4":
            continue
        u, v = int(row["from"]), int(row["to"])
        edge_attrs = dict(
            edge_id=int(row["id"]),
            name=str(row["name"]),
            right=str(row.get("right", "")),
            left=str(row.get("left", "")),
            building=int(row["building"]),
            floor=int(row["floor"]),
            weight=float(row["weight"]) * float(row["length"]) + (ENTRANCE_PENALTY if edge_type == "7" else 0.0),
            length=float(row["length"]),
            edge_type=edge_type,
        )
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
            if edge_type not in _DIRECTED_EDGE_TYPES:
                # 逆方向(v→u)は進行方向が反転するため、right/leftも入れ替えて渡す
                reversed_attrs = dict(edge_attrs, right=edge_attrs["left"], left=edge_attrs["right"])
                G.add_edge(v, u, **reversed_attrs)
    return G


# ------------------------------------------------------------------ #
#  Cache Mechanism
# ------------------------------------------------------------------ #
_cached_nodes_df = None
_cached_edges_df = None
_cached_graph_with_ev = None
_cached_graph_without_ev = None
_cached_room_index = None   # {(教室名, building): [edge行, ...]}
_cached_rooms_list = None   # api_rooms / api_all 用の整形済み教室リスト
_cached_nodes_list = None   # api_all 用の整形済みノードリスト
_cached_node_xyz   = None   # {node_id: (x, y, z)}
_cached_graph_payload = None   # /api/graph レスポンス全体
_cached_name_map    = None   # name.csv: {(building|None, name): display_name}
_cached_event_index = None   # event.csv: {title: [(node_id, edge行|None), ...]}
_cached_events_list = None   # /api/events 用の整形済みイベント一覧

def get_cached_data():
    global _cached_nodes_df, _cached_edges_df
    if _cached_nodes_df is None or _cached_edges_df is None:
        _cached_nodes_df, _cached_edges_df = load_data()
    return _cached_nodes_df, _cached_edges_df


def get_cached_name_map():
    """
    name.csv（列: building,name,display_name）を読み込み、
    {(building, name): display_name} の辞書を返す。
    building 列が空の行は全建物共通の表示名として (None, name) キーで保持する。
    """
    global _cached_name_map
    if _cached_name_map is None:
        name_map = {}
        if os.path.exists(NAME_CSV):
            df = pd.read_csv(NAME_CSV, dtype=str).fillna("")
            df.columns = df.columns.str.strip()
            for _, row in df.iterrows():
                name    = str(row.get("name", "")).strip()
                display = str(row.get("display_name", "")).strip()
                bldg    = str(row.get("building", "")).strip()
                if not name or not display:
                    continue
                key = (int(float(bldg)), name) if bldg else (None, name)
                name_map[key] = display
        _cached_name_map = name_map
    return _cached_name_map


def _display_name(building, name):
    """name.csv の表示名を返す。建物指定 → 全建物共通 → 生の名前+「教室」 の順で解決"""
    name_map = get_cached_name_map()
    return (
        name_map.get((int(building), name))
        or name_map.get((None, name))
        or f"{name}教室"
    )


def _first_display_label(building, raw_value):
    """
    ";"区切りの生の名前（name/right/left列の値）の先頭要素だけを、読み上げ用の表示名に変換する。
    トイレ（M_Toilet等）はname.csvに表示名が無く_display_nameのフォールバックだと不自然になる
    （例: "M_Toilet教室"）ため、_TOILET_LABEL（後方で定義、モジュール読み込み後に参照するので
    問題ない）を先に見る。それ以外はname.csv（_display_name）に委ねる。
    """
    first = str(raw_value or "").split(";")[0].strip()
    if not first:
        return ""
    if first in _TOILET_LABEL:
        return _TOILET_LABEL[first]
    return _display_name(building, first)


_cached_building_name_map = None   # building_name.csv: {building: display_name}


def get_cached_building_name_map():
    """
    building_name.csv（列: building,display_name）を読み込み、
    {building: display_name} の辞書を返す。
    """
    global _cached_building_name_map
    if _cached_building_name_map is None:
        name_map = {}
        if os.path.exists(BUILDING_NAME_CSV):
            df = pd.read_csv(BUILDING_NAME_CSV, dtype=str).fillna("")
            df.columns = df.columns.str.strip()
            for _, row in df.iterrows():
                bldg    = str(row.get("building", "")).strip()
                display = str(row.get("display_name", "")).strip()
                if not bldg or not display:
                    continue
                name_map[int(float(bldg))] = display
        _cached_building_name_map = name_map
    return _cached_building_name_map


def _building_display_name(building):
    """building_name.csv の表示名を返す。未登録なら 屋外/{building}号館 にフォールバック"""
    building = int(building)
    display = get_cached_building_name_map().get(building)
    if display:
        return display
    return "屋外" if building == 0 else f"{building}号館"


_cached_ignore_set = None   # ignore.csv: {name, ...}（建物を問わず教室検索の候補から隠す生の名前）


def get_cached_ignore_set():
    """
    ignore.csv（列: id）を読み込み、教室検索の候補一覧から隠す生の名前の集合を返す。
    building 列は無く、建物を問わずこの名前に一致するエッジが対象になる。
    ルート検索（from_room/to_room）・最寄りトイレ/食堂検索・event.csvのroom紐付けは
    索引（room_index）を直接参照するため、ここでの除外の影響を受けない。
    """
    global _cached_ignore_set
    if _cached_ignore_set is None:
        ignore_set = set()
        if os.path.exists(IGNORE_CSV):
            df = pd.read_csv(IGNORE_CSV, dtype=str).fillna("")
            df.columns = df.columns.str.strip()
            for _, row in df.iterrows():
                name = str(row.get("id", "")).strip()
                if name:
                    ignore_set.add(name)
        _cached_ignore_set = ignore_set
    return _cached_ignore_set


# 教室検索の候補一覧には出さないが、索引（room_index）には残す生の名前。
# トイレは最寄りトイレ検索、ignore.csv登録分はルート検索・event.csv・食堂検索などで
# 個別に参照され続けるため、rooms_list からのみ除外する。
_TOILET_NAMES = {"M_Toilet", "F_Toilet", "C_Toilet"}


def _build_room_index(edges_df):
    """エッジの name 列を分解し、教室名→エッジ行 の索引と教室一覧を一度だけ構築する"""
    ignore_set = get_cached_ignore_set()
    index, rooms_list, seen = {}, [], set()
    for _, row in edges_df.iterrows():
        raw_name = str(row["name"]).strip()
        if not raw_name or raw_name == "nan":
            continue
        building = int(row["building"])
        for room in raw_name.split(";"):
            room = room.strip()
            if not room:
                continue
            index.setdefault((room, building), []).append(row)
            if (room, building) in seen:
                continue
            seen.add((room, building))
            if room in _TOILET_NAMES or room in ignore_set:
                continue  # 教室検索の候補には含めない（索引には残す）
            rooms_list.append({
                "room":     room,
                "display":  _display_name(building, room),
                "building": building,
                "floor":    int(row["floor"]),
                "edge_id":  int(row["id"]),
                "from":     int(row["from"]),
                "to":       int(row["to"]),
            })
    rooms_list.sort(key=lambda r: (r["building"], r["room"]))
    return index, rooms_list


def get_cached_room_index():
    global _cached_room_index, _cached_rooms_list
    if _cached_room_index is None:
        _, edges_df = get_cached_data()
        _cached_room_index, _cached_rooms_list = _build_room_index(edges_df)
    return _cached_room_index, _cached_rooms_list


def _build_event_index():
    """
    event.csv（列: title,building,room,node_id,edge_id）を読み込み、
    イベント名→到達候補ノード の索引と一覧を構築する。

    1行につき room / node_id / edge_id のいずれか1つでタイトルの場所を指定する:
      room    … 既存の教室名（;区切りのエッジ name に含まれる名前）
      node_id … 建物内のローカルノードID（building=0 なら global_node.csv のID）
      edge_id … 建物内のローカルエッジID（building=0 なら global_edge.csv のID）
    同じ title の行が複数あれば候補を統合する（複数箇所で開催する屋台など）。
    """
    index, events_list, seen_titles = {}, [], set()
    if not os.path.exists(EVENT_CSV):
        return index, events_list

    df = pd.read_csv(EVENT_CSV, dtype=str).fillna("")
    df.columns = df.columns.str.strip()
    nodes_df, edges_df = get_cached_data()
    node_floor = {int(r["id"]): int(r["floor"]) for _, r in nodes_df.iterrows()}

    for _, row in df.iterrows():
        title = str(row.get("title", "")).strip()
        if not title:
            continue
        bldg    = str(row.get("building", "")).strip()
        room    = str(row.get("room", "")).strip()
        node_id = str(row.get("node_id", "")).strip()
        edge_id = str(row.get("edge_id", "")).strip()
        building = int(float(bldg)) if bldg else 0

        candidates, floor = [], None
        if room:
            for e_row in _find_edges_for_room(room, building):
                floor = int(e_row["floor"])
                for nid in (int(e_row["from"]), int(e_row["to"])):
                    candidates.append((nid, e_row))
        elif edge_id:
            gid = int(float(edge_id)) if building == 0 else building * ID_OFFSET + int(float(edge_id))
            hits = edges_df[(edges_df["id"].astype(int) == gid)
                            & (edges_df["building"].astype(int) == building)]
            for _, e_row in hits.iterrows():
                floor = int(e_row["floor"])
                for nid in (int(e_row["from"]), int(e_row["to"])):
                    candidates.append((nid, e_row))
        elif node_id:
            nid = int(float(node_id))
            gid = nid + GLOBAL_NODE_OFFSET if building == 0 else building * ID_OFFSET + nid
            if gid in node_floor:
                floor = node_floor[gid]
                candidates.append((gid, None))

        if not candidates:
            print(f"[event.csv] 位置を解決できない行をスキップ: title={title}")
            continue

        index.setdefault(title, []).extend(candidates)
        if title not in seen_titles:
            seen_titles.add(title)
            events_list.append({
                "title":    title,
                "building": building,
                "floor":    floor if floor is not None else 1,
            })
    return index, events_list


def get_cached_event_index():
    global _cached_event_index, _cached_events_list
    if _cached_event_index is None:
        _cached_event_index, _cached_events_list = _build_event_index()
    return _cached_event_index, _cached_events_list


def _find_event_candidates(title):
    """イベント名→ [(node_id, edge行|None), ...]（未登録なら空リスト）"""
    index, _ = get_cached_event_index()
    return index.get(title, [])


def get_cached_node_xyz():
    global _cached_node_xyz
    if _cached_node_xyz is None:
        nodes_df, _ = get_cached_data()
        _cached_node_xyz = {
            int(r["id"]): (float(r["x"]), float(r["y"]), float(r["z"]))
            for _, r in nodes_df.iterrows()
        }
    return _cached_node_xyz


def get_cached_nodes_list():
    global _cached_nodes_list
    if _cached_nodes_list is None:
        nodes_df, _ = get_cached_data()
        nodes = []
        for _, row in nodes_df.iterrows():
            if any(pd.isna(row[c]) for c in ["id", "building", "floor", "type"]):
                continue
            nd = {
                "id":       int(row["id"]),
                "building": int(row["building"]),
                "floor":    int(row["floor"]),
                "type":     int(row["type"]),
            }
            if "lat" in row and pd.notna(row["lat"]):
                nd["lat"] = float(row["lat"])
            if "lng" in row and pd.notna(row["lng"]):
                nd["lng"] = float(row["lng"])
            nodes.append(nd)
        nodes.sort(key=lambda n: n["id"])
        _cached_nodes_list = nodes
    return _cached_nodes_list


def get_cached_graph(use_elevator=True):
    global _cached_graph_with_ev, _cached_graph_without_ev
    nodes_df, edges_df = get_cached_data()
    if use_elevator:
        if _cached_graph_with_ev is None:
            _cached_graph_with_ev = build_graph(nodes_df, edges_df, use_elevator=True)
        return _cached_graph_with_ev
    else:
        if _cached_graph_without_ev is None:
            _cached_graph_without_ev = build_graph(nodes_df, edges_df, use_elevator=False)
        return _cached_graph_without_ev


def get_cached_graph_payload():
    """/api/graph 用のノード・エッジ・変換設定を一度だけ構築して使い回す"""
    global _cached_graph_payload
    if _cached_graph_payload is None:
        nodes_df, edges_df = get_cached_data()

        nodes = []
        for _, row in nodes_df.iterrows():
            if any(pd.isna(row[c]) for c in ["id", "x", "y", "z", "building", "floor"]):
                continue
            bldg = int(row["building"])
            if bldg == 0:
                color = OUTDOOR_COLOR
            else:
                color = BUILDING_COLORS[(bldg - 1) % len(BUILDING_COLORS)]
            node_dict = {
                "id":       int(row["id"]),
                "x":        float(row["x"]),
                "y":        float(row["y"]),
                "z":        float(row["z"]),
                "building": bldg,
                "floor":    int(row["floor"]),
                "type":     int(row["type"]),
                "color":    color,
                "label":    f"Node {int(row['id'])}<br>{'屋外' if bldg == 0 else f'Building {bldg}'} / Floor {int(row['floor'])}",
            }
            if "lat" in row and pd.notna(row["lat"]):
                node_dict["lat"] = float(row["lat"])
            if "lng" in row and pd.notna(row["lng"]):
                node_dict["lng"] = float(row["lng"])
            nodes.append(node_dict)

        valid_edges = edges_df.dropna(subset=["id", "from", "to", "building", "floor", "weight", "length"])
        edges = [_edge_to_dict(row) for _, row in valid_edges.iterrows()]

        config = _load_transform_config()
        config.update(_calc_transforms_from_anchors())

        _cached_graph_payload = {
            "nodes": nodes,
            "edges": edges,
            "building_colors": BUILDING_COLORS,
            "config": config,
        }
    return _cached_graph_payload


def clear_cache():
    global _cached_nodes_df, _cached_edges_df, _cached_graph_with_ev, _cached_graph_without_ev
    global _cached_room_index, _cached_rooms_list, _cached_nodes_list, _cached_node_xyz
    global _cached_graph_payload, _cached_name_map, _cached_event_index, _cached_events_list
    global _cached_ignore_set
    _cached_nodes_df = None
    _cached_edges_df = None
    _cached_graph_with_ev = None
    _cached_graph_without_ev = None
    _cached_room_index = None
    _cached_rooms_list = None
    _cached_nodes_list = None
    _cached_node_xyz = None
    _cached_graph_payload = None
    _cached_name_map = None
    _cached_event_index = None
    _cached_events_list = None
    _cached_ignore_set = None


def _edge_to_dict(row):
    """edgeの行を座標付きdictに変換するヘルパー"""
    node_xyz = get_cached_node_xyz()
    x0, y0, z0 = node_xyz[int(row["from"])]
    x1, y1, z1 = node_xyz[int(row["to"])]
    return {
        "id":       int(row["id"]),
        "name":     str(row["name"]),
        "right":    str(row.get("right", "")),
        "left":     str(row.get("left", "")),
        "from":     int(row["from"]),
        "to":       int(row["to"]),
        "building": int(row["building"]),
        "floor":    int(row["floor"]),
        "weight":   float(row["weight"]),
        "length":   float(row["length"]),
        "type":     str(row["type"]),
        "x0": x0, "y0": y0, "z0": z0,
        "x1": x1, "y1": y1, "z1": z1,
    }


def _extend_to_far_endpoint(G, path, length, dest_edge_row):
    """
    目的地がエッジ（教室・トイレ・食堂）の場合、最寄り端点で止めず、
    そのエッジのもう一方の端点まで経路を延長する。
    教室はエッジ区間に面しているため、区間そのものを歩かせることで
    必ずドアの前を通る案内になる。
    直前ノードが反対側端点（＝既に目的エッジを歩いて到着）の場合は延長しない。
    """
    if dest_edge_row is None or not path:
        return path, length
    u, v = int(dest_edge_row["from"]), int(dest_edge_row["to"])
    last = path[-1]
    far = v if last == u else u if last == v else None
    if far is None:
        return path, length
    if len(path) >= 2 and path[-2] == far:
        return path, length
    if not G.has_edge(last, far):
        return path, length
    return path + [far], length + G.edges[last, far].get("weight", 0.0)


def _path_result(G, path, length):
    """Dijkstraの結果をJSON用dictに整形するヘルパー"""
    path_coords = []
    for node_id in path:
        n = G.nodes[node_id]
        coord_dict = {"id": node_id, "x": n["x"], "y": n["y"], "z": n["z"],
                      "building": n["building"], "floor": n["floor"]}
        if "lat" in n:
            coord_dict["lat"] = n["lat"]
        if "lng" in n:
            coord_dict["lng"] = n["lng"]
        if "svg_x" in n and n["svg_x"] == n["svg_x"]:  # NaN check
            coord_dict["svg_x"] = n["svg_x"]
            coord_dict["svg_y"] = n["svg_y"]
        path_coords.append(coord_dict)

    path_edges = []
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        edata = G.edges[u, v]
        n0, n1 = G.nodes[u], G.nodes[v]
        building = edata.get("building")
        name, right, left = edata.get("name", ""), edata.get("right", ""), edata.get("left", "")
        path_edges.append({
            "from": u, "to": v,
            "name":   name,
            "right":  right,
            "left":   left,
            # 読み上げ用の表示名（先頭要素のみ、トイレ等の内部コードも日本語表記に変換済み）。
            # 生の name/right/left はそのままエッジ照合用に残す。
            "name_display":  _first_display_label(building, name),
            "right_display": _first_display_label(building, right),
            "left_display":  _first_display_label(building, left),
            "length": edata.get("length", 0),
            "type":   edata.get("edge_type", "1"),
            "x0": n0["x"], "y0": n0["y"], "z0": n0["z"],
            "x1": n1["x"], "y1": n1["y"], "z1": n1["z"],
        })
    return {"path": path, "total_weight": length,
            "path_coords": path_coords, "path_edges": path_edges}


# ------------------------------------------------------------------ #
#  Routes
# ------------------------------------------------------------------ #

@app.route("/3d/")
@app.route("/3d")
def index():
    nodes_df, edges_df = get_cached_data()
    node_ids  = sorted(nodes_df["id"].tolist())
    # building=0 (屋外) はフィルタの「すべての建物」(value=0) と衝突するため除外
    buildings = sorted(int(b) for b in nodes_df["building"].unique() if int(b) != 0)
    return render_template("index.html", node_ids=node_ids, buildings=buildings)


@app.route("/api/graph")
def api_graph():
    return jsonify(get_cached_graph_payload())


# ------------------------------------------------------------------ #
#  教室検索 API
# ------------------------------------------------------------------ #

@app.route("/api/rooms")
def api_rooms():
    """
    教室名の一覧を返す。
    ?building=10  建物IDで絞り込み（省略時は全建物）
    ?q=101        前方一致の絞り込み（省略時は全件）
    返却形式: [ { "room": "101A", "building": 10, "edge_id": 5, "floor": 1 }, ... ]
    """
    building_filter = request.args.get("building", type=int)
    query           = request.args.get("q", "").strip().lower()

    _, rooms_list = get_cached_room_index()
    rooms = [
        r for r in rooms_list
        if (building_filter is None or r["building"] == building_filter)
        and (not query or query in r["room"].lower())
    ]
    return jsonify(rooms)


@app.route("/api/all")
def api_all():
    """
    全教室・全ノード・建物一覧をまとめて返す。パラメータなし。
    返却形式:
      {
        "rooms":     [ { "room", "building", "floor", "edge_id", "from", "to" }, ... ],
        "nodes":     [ { "id", "building", "floor", "type" }, ... ],
        "buildings": [ { "id": 1, "display_name": "1号館" }, ... ]
      }
    display_name は data/building_name.csv で設定した表示名（未設定なら "{id}号館" / building=0 は "屋外"）。
    """
    nodes_df, _ = get_cached_data()
    _, rooms = get_cached_room_index()
    nodes    = get_cached_nodes_list()
    building_ids = sorted(nodes_df["building"].dropna().astype(int).unique().tolist())
    buildings = [{"id": b, "display_name": _building_display_name(b)} for b in building_ids]

    return jsonify({"rooms": rooms, "nodes": nodes, "buildings": buildings})


def _find_edges_for_room(room_name, building):
    """教室名が含まれるエッジ行のリストを返す（起動時に構築した索引から引く）"""
    index, _ = get_cached_room_index()
    return index.get((room_name, int(building)), [])


@app.route("/api/navigate_to_room")
def api_navigate_to_room():
    """
    教室名から教室名への最短経路を返す。

    出発点の指定方法（いずれか）:
      A) start_room=101A&start_building=10  ← 出発教室名
      B) start=1                            ← 出発ノードID（後方互換）

    必須:
      room=101A&building=10  ← 目的教室名

    教室はエッジの属性なので、各教室エッジの両端点を候補ノードとし、
    全組み合わせ中で最短のパスを採用する。
    レスポンスには経路情報に加え start_edge / destination_edge も含む。
    """
    room_name      = request.args.get("room",           "").strip()
    building       = request.args.get("building",       type=int)
    start_room     = request.args.get("start_room",     "").strip()
    start_building = request.args.get("start_building", type=int)
    start_node     = request.args.get("start",          type=int)  # 後方互換

    if not room_name or building is None:
        return jsonify({"error": "room と building を指定してください"}), 400
    if not start_room and start_node is None:
        return jsonify({"error": "start_room（＋start_building）または start を指定してください"}), 400

    use_elevator = request.args.get("use_elevator", "1") != "0"
    G = get_cached_graph(use_elevator=use_elevator)

    # --- 目的教室のエッジを検索 ---
    dest_edges = _find_edges_for_room(room_name, building)
    if not dest_edges:
        return jsonify({"error": f"建物 {building} に教室 '{room_name}' が見つかりません"}), 404

    # --- 出発点の候補ノードを決定 ---
    start_candidates = []  # (node_id, start_edge_row or None)
    start_edge_row = None

    if start_room and start_building is not None:
        s_edges = _find_edges_for_room(start_room, start_building)
        if not s_edges:
            return jsonify({"error": f"建物 {start_building} に出発教室 '{start_room}' が見つかりません"}), 404
        for row in s_edges:
            for nid in (int(row["from"]), int(row["to"])):
                if nid in G.nodes:
                    start_candidates.append((nid, row))
    else:
        # ノードID指定（後方互換）
        if start_node not in G.nodes:
            return jsonify({"error": f"ノード {start_node} が存在しません"}), 404
        start_candidates = [(start_node, None)]

    # --- 全組み合わせでDijkstra、最短を採用 ---
    best_path   = None
    best_length = float("inf")
    best_dest_edge   = None
    best_start_edge  = None

    for (s_node, s_edge_row) in start_candidates:
        for d_row in dest_edges:
            for g_node in (int(d_row["from"]), int(d_row["to"])):
                if g_node not in G.nodes:
                    continue
                try:
                    l, p = nx.bidirectional_dijkstra(G, s_node, g_node, weight="weight")
                    if l < best_length:
                        best_length     = l
                        best_path       = p
                        best_dest_edge  = d_row
                        best_start_edge = s_edge_row
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    continue

    if best_path is None:
        label = f"'{start_room}'" if start_room else f"ノード {start_node}"
        return jsonify({"error": f"{label} から教室 '{room_name}' への経路が見つかりません"}), 404

    best_path, best_length = _extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = _path_result(G, best_path, best_length)
    result["destination_room"] = room_name
    result["destination_edge"] = _edge_to_dict(best_dest_edge)
    if best_start_edge is not None:
        result["start_room"] = start_room
        result["start_edge"] = _edge_to_dict(best_start_edge)
    return jsonify(result)


# ------------------------------------------------------------------ #
#  イベント API
# ------------------------------------------------------------------ #

@app.route("/api/events")
def api_events():
    """
    event.csv に登録されたイベント（屋台など）の一覧を返す。
    返却形式: [ { "title": "たこ焼き屋台", "building": 10, "floor": 1 }, ... ]
    """
    _, events_list = get_cached_event_index()
    return jsonify(events_list)


def _resolve_start_candidates(G, from_room, from_building, from_node_id, from_event):
    """
    出発点指定（from_event / from_room / from_node の優先順）を
    候補ノードのリスト [(node_id, edge行|None), ...] に解決する。
    戻り値: (start_candidates, エラーメッセージ|None, HTTPステータス|None)
    """
    if from_event:
        seen, result = set(), []
        for nid, row in _find_event_candidates(from_event):
            if nid in G.nodes and nid not in seen:
                seen.add(nid)
                result.append((nid, row))
        if not result:
            return None, f"イベント '{from_event}' が見つかりません", 404
        return result, None, None

    if from_room:
        if from_building is None:
            return None, "from_building を指定してください", 400
        s_edges = _find_edges_for_room(from_room, from_building)
        if not s_edges:
            return None, f"建物 {from_building} に教室 '{from_room}' が見つかりません", 404
        seen, result = set(), []
        for r in s_edges:
            for nid in (int(r["from"]), int(r["to"])):
                if nid in G.nodes and nid not in seen:
                    seen.add(nid)
                    result.append((nid, r))
        return result, None, None

    if from_node_id not in G.nodes:
        return None, f"ノード {from_node_id} が存在しません", 404
    return [(from_node_id, None)], None, None


def _require_from_spec(from_room, from_event, from_node_id):
    """from_room・from_event・from_node のいずれも指定されていない場合はエラーレスポンスを返す（未指定エラー無しなら None）"""
    if not from_room and not from_event and from_node_id is None:
        return jsonify({"error": "from_room（＋from_building）・from_event・from_node のいずれかを指定してください"}), 400
    return None


# ------------------------------------------------------------------ #
#  統合ルーティング API
# ------------------------------------------------------------------ #

@app.route("/api/route")
def api_route():
    """
    出発点と目的地を指定して最短経路をJSONで返す。

    出発点（いずれか）:
      from_room=101A&from_building=10  ← 教室名
      from_node=100001                 ← ノードID
      from_event=たこ焼き屋台          ← イベント名（event.csv）

    目的地（いずれか）:
      to_room=202B&to_building=10      ← 教室名
      to_node=100050                   ← ノードID
      to_event=たこ焼き屋台            ← イベント名（event.csv）

    条件:
      use_elevator=0/1  （省略時 1）
    """
    use_elevator = request.args.get("use_elevator", "1") != "0"

    from_room     = request.args.get("from_room",     "").strip()
    from_building = request.args.get("from_building", type=int)
    from_node_id  = request.args.get("from_node",     type=int)
    from_event    = request.args.get("from_event",    "").strip()

    to_room       = request.args.get("to_room",       "").strip()
    to_building   = request.args.get("to_building",   type=int)
    to_node_id    = request.args.get("to_node",       type=int)
    to_event      = request.args.get("to_event",      "").strip()

    err = _require_from_spec(from_room, from_event, from_node_id)
    if err:
        return err
    if not to_room and not to_event and to_node_id is None:
        return jsonify({"error": "to_room（＋to_building）・to_event・to_node のいずれかを指定してください"}), 400

    G = get_cached_graph(use_elevator=use_elevator)

    # --- 出発候補ノード ---
    start_candidates, err, status = _resolve_start_candidates(
        G, from_room, from_building, from_node_id, from_event)
    if err:
        return jsonify({"error": err}), status

    # --- 目的候補ノード ---
    if to_event:
        seen_d = set()
        dest_candidates = []
        for nid, row in _find_event_candidates(to_event):
            if nid in G.nodes and nid not in seen_d:
                seen_d.add(nid)
                dest_candidates.append((nid, row))
        if not dest_candidates:
            return jsonify({"error": f"イベント '{to_event}' が見つかりません"}), 404
    elif to_room:
        if to_building is None:
            return jsonify({"error": "to_building を指定してください"}), 400
        d_edges = _find_edges_for_room(to_room, to_building)
        if not d_edges:
            return jsonify({"error": f"建物 {to_building} に教室 '{to_room}' が見つかりません"}), 404
        dest_candidates = [(nid, r) for r in d_edges
                           for nid in (int(r["from"]), int(r["to"]))
                           if nid in G.nodes]
    else:
        if to_node_id not in G.nodes:
            return jsonify({"error": f"ノード {to_node_id} が存在しません"}), 404
        dest_candidates = [(to_node_id, None)]

    # --- 全組み合わせでDijkstra、最短を採用 ---
    best_path, best_length = None, float("inf")
    best_start_edge = best_dest_edge = None

    for (s_node, s_row) in start_candidates:
        for (d_node, d_row) in dest_candidates:
            if s_node == d_node:
                # 出発と目的が同一ノードを共有する場合は距離0の自明な経路
                l, p = 0.0, [s_node]
            else:
                try:
                    l, p = nx.bidirectional_dijkstra(G, s_node, d_node, weight="weight")
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    continue
            if l < best_length:
                best_length, best_path = l, p
                best_start_edge, best_dest_edge = s_row, d_row

    if best_path is None:
        return jsonify({"error": "指定された出発点から目的地への経路が見つかりません"}), 404

    best_path, best_length = _extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = _path_result(G, best_path, best_length)
    if from_event:
        result["from_event"] = from_event
    if to_event:
        result["to_event"]   = to_event
    if best_start_edge is not None:
        if from_room:
            result["from_room"] = from_room
        result["from_edge"]  = _edge_to_dict(best_start_edge)
    if best_dest_edge is not None:
        if to_room:
            result["to_room"] = to_room
        result["to_edge"]    = _edge_to_dict(best_dest_edge)
    return jsonify(result)


# ------------------------------------------------------------------ #
#  最寄りトイレ検索 API
# ------------------------------------------------------------------ #

_TOILET_TYPE_MAP = {
    "M":   ["M_Toilet"],
    "F":   ["F_Toilet"],
    "C":   ["C_Toilet"],
    "ALL": ["M_Toilet", "F_Toilet", "C_Toilet"],
}
_TOILET_LABEL = {"M_Toilet": "男子トイレ", "F_Toilet": "女子トイレ", "C_Toilet": "多目的トイレ"}


def _load_cafeteria_list():
    if not os.path.exists(CAFETERIA_CSV):
        return []
    df = pd.read_csv(CAFETERIA_CSV, dtype=str).fillna("")
    result = []
    for _, row in df.iterrows():
        name = row.get("name", "").strip()
        if not name:
            continue
        result.append({
            "name":         name,
            "building":     row.get("building", "").strip(),
            "display_name": row.get("display_name", name).strip(),
        })
    return result

_CAFETERIA_LIST  = _load_cafeteria_list()
_CAFETERIA_NAMES = [c["name"] for c in _CAFETERIA_LIST]


@app.route("/api/cafeterias")
def api_cafeterias():
    return jsonify(_CAFETERIA_LIST)


def _edges_by_names(names):
    """room_index から name が names に含まれるエッジ行を収集する（複数種別併記のエッジはIDで重複排除）"""
    room_index, _ = get_cached_room_index()
    edges, seen_ids = [], set()
    for (name, _bldg), rows in room_index.items():
        if name not in names:
            continue
        for row in rows:
            eid = int(row["id"])
            if eid in seen_ids:
                continue
            seen_ids.add(eid)
            edges.append(row)
    return edges


def _best_route_to_candidates(G, start_candidates, dest_candidates):
    """
    出発候補×目的候補の全組み合わせでDijkstraを実行し、最短経路を採用する。
    出発と目的が同一ノードの組み合わせはスキップする（最寄りトイレ・食堂検索では、
    出発点自体が目的地そのものである場合を経路として扱わないため）。
    戻り値: (best_path, best_length, best_start_row, best_dest_row)
    """
    best_path, best_length = None, float("inf")
    best_start_row = best_dest_row = None
    for (s_node, s_row) in start_candidates:
        for (d_node, d_row) in dest_candidates:
            if s_node == d_node:
                continue
            try:
                l, p = nx.bidirectional_dijkstra(G, s_node, d_node, weight="weight")
                if l < best_length:
                    best_length, best_path = l, p
                    best_start_row, best_dest_row = s_row, d_row
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
    return best_path, best_length, best_start_row, best_dest_row


@app.route("/api/nearest_toilet")
def api_nearest_toilet():
    """
    最寄りのトイレへの最短経路を返す。

    出発点（いずれか）:
      from_room=101A&from_building=10
      from_node=100001
      from_event=たこ焼き屋台

    種別:
      type=M / F / C / all (省略時 all)

    条件:
      use_elevator=0/1 (省略時 1)
    """
    toilet_type  = request.args.get("type", "all").strip().upper()
    use_elevator = request.args.get("use_elevator", "1") != "0"
    from_room     = request.args.get("from_room",     "").strip()
    from_building = request.args.get("from_building", type=int)
    from_node_id  = request.args.get("from_node",     type=int)
    from_event    = request.args.get("from_event",    "").strip()

    err = _require_from_spec(from_room, from_event, from_node_id)
    if err:
        return err

    targets = _TOILET_TYPE_MAP.get(toilet_type, _TOILET_TYPE_MAP["ALL"])

    G = get_cached_graph(use_elevator=use_elevator)

    # 出発候補
    start_candidates, err, status = _resolve_start_candidates(
        G, from_room, from_building, from_node_id, from_event)
    if err:
        return jsonify({"error": err}), status

    # トイレエッジを全建物から収集（教室名索引から引く。複数種別併記のエッジはIDで重複排除）
    toilet_edges = _edges_by_names(targets)
    if not toilet_edges:
        return jsonify({"error": "該当するトイレがデータ内に見つかりません"}), 404

    dest_candidates = [
        (nid, row) for row in toilet_edges
        for nid in (int(row["from"]), int(row["to"]))
        if nid in G.nodes
    ]

    # 全組み合わせでDijkstra、最短を採用
    best_path, best_length, best_start_row, best_toilet_row = _best_route_to_candidates(
        G, start_candidates, dest_candidates)

    if best_path is None:
        return jsonify({"error": "指定された出発点から該当するトイレへの経路が見つかりません"}), 404

    t_names = [n.strip() for n in str(best_toilet_row["name"]).split(";")]
    found_key = next((t for t in ["M_Toilet", "F_Toilet", "C_Toilet"] if t in t_names), "")

    best_path, best_length = _extend_to_far_endpoint(G, best_path, best_length, best_toilet_row)
    result = _path_result(G, best_path, best_length)
    result["toilet_type"]     = found_key.split("_")[0] if found_key else ""
    result["toilet_name"]     = found_key
    result["toilet_label"]    = _TOILET_LABEL.get(found_key, "トイレ")
    result["toilet_building"] = int(best_toilet_row["building"])
    result["toilet_floor"]    = int(best_toilet_row["floor"])
    result["toilet_edge"]     = _edge_to_dict(best_toilet_row)
    if from_event:
        result["from_event"]  = from_event
    if best_start_row is not None:
        if from_room:
            result["from_room"] = from_room
        result["from_edge"]   = _edge_to_dict(best_start_row)
    return jsonify(result)


# ------------------------------------------------------------------ #
#  最寄り食堂検索 API
# ------------------------------------------------------------------ #

@app.route("/api/nearest_cafeteria")
def api_nearest_cafeteria():
    """
    最寄りの食堂への最短経路を返す。

    出発点（いずれか）:
      from_room=101A&from_building=10
      from_node=100001
      from_event=たこ焼き屋台

    条件:
      use_elevator=0/1 (省略時 1)
    """
    use_elevator  = request.args.get("use_elevator", "1") != "0"
    from_room     = request.args.get("from_room",     "").strip()
    from_building = request.args.get("from_building", type=int)
    from_node_id  = request.args.get("from_node",     type=int)
    from_event    = request.args.get("from_event",    "").strip()

    err = _require_from_spec(from_room, from_event, from_node_id)
    if err:
        return err

    if not _CAFETERIA_NAMES:
        return jsonify({"error": "cafeteria_edge.csv が見つかりません"}), 500

    caf_name = request.args.get("name", "all").strip()
    targets  = [caf_name] if caf_name != "all" else _CAFETERIA_NAMES

    G = get_cached_graph(use_elevator=use_elevator)

    # 出発候補
    start_candidates, err, status = _resolve_start_candidates(
        G, from_room, from_building, from_node_id, from_event)
    if err:
        return jsonify({"error": err}), status

    # 食堂エッジを room_index から収集
    caf_edges = _edges_by_names(targets)
    if not caf_edges:
        return jsonify({"error": "食堂エッジがデータ内に見つかりません"}), 404

    dest_candidates = [
        (nid, row) for row in caf_edges
        for nid in (int(row["from"]), int(row["to"]))
        if nid in G.nodes
    ]

    best_path, best_length, best_start_row, best_caf_row = _best_route_to_candidates(
        G, start_candidates, dest_candidates)

    if best_path is None:
        return jsonify({"error": "食堂への経路が見つかりません"}), 404

    best_path, best_length = _extend_to_far_endpoint(G, best_path, best_length, best_caf_row)
    result = _path_result(G, best_path, best_length)
    result["cafeteria_building"] = int(best_caf_row["building"])
    result["cafeteria_floor"]    = int(best_caf_row["floor"])
    result["cafeteria_edge"]     = _edge_to_dict(best_caf_row)
    if from_event:
        result["from_event"] = from_event
    if best_start_row is not None:
        if from_room:
            result["from_room"] = from_room
        result["from_edge"] = _edge_to_dict(best_start_row)
    return jsonify(result)


# ------------------------------------------------------------------ #
#  ノード間最短経路 API（従来通り）
# ------------------------------------------------------------------ #

@app.route("/api/shortest_path")
def api_shortest_path():
    start = request.args.get("start", type=int)
    goal  = request.args.get("goal",  type=int)

    if start is None or goal is None:
        return jsonify({"error": "start と goal のノードIDを指定してください"}), 400

    use_elevator = request.args.get("use_elevator", "1") != "0"
    G = get_cached_graph(use_elevator=use_elevator)

    if start not in G.nodes:
        return jsonify({"error": f"ノード {start} が存在しません"}), 404
    if goal not in G.nodes:
        return jsonify({"error": f"ノード {goal} が存在しません"}), 404

    try:
        length, path = nx.bidirectional_dijkstra(G, start, goal, weight="weight")
        return jsonify(_path_result(G, path, length))
    except nx.NetworkXNoPath:
        return jsonify({"error": f"ノード {start} から {goal} への経路が見つかりません"}), 404
    except nx.NodeNotFound as e:
        return jsonify({"error": str(e)}), 404


@app.route("/api/edge_images")
def api_edge_images():
    """
    エッジ画像マップを返す。
    返却形式: { "1000001_1000002": "https://cdn.iku-navi.net/1000001_to_1000002.jpg", ... }
    """
    if not os.path.exists(EDGE_IMAGE_CSV):
        return jsonify({})
    df = pd.read_csv(EDGE_IMAGE_CSV)
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


if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0" , port=5001)
