"""起動後に一度だけ構築し、以降は使い回す派生データ。

CSVの読み込みとグラフ構築は数百ms〜秒単位かかるため、リクエストごとにはやらない。
データを更新したときはプロセスを再起動するか clear_caches() を呼ぶ
（ikunavi.clear_all_caches() が全モジュールのキャッシュをまとめて落とす）。
"""
import os

import pandas as pd

from .config import CAFETERIA_CSV, EVENT_CSV, GLOBAL_NODE_OFFSET, ID_OFFSET
from .dataset import load_data
from .graph import build_graph
from .naming import TOILET_NAMES, display_name, get_ignore_set

_nodes_df = None
_edges_df = None
_graph_with_ev = None
_graph_without_ev = None
_room_index = None    # {(教室名, building): [edge行, ...]}
_rooms_list = None    # /api/rooms・/api/all 用の整形済み教室リスト
_nodes_list = None    # /api/all 用の整形済みノードリスト
_node_xyz = None      # {node_id: (x, y, z)}
_event_index = None   # event.csv: {title: [(node_id, edge行|None), ...]}
_events_list = None   # /api/events 用の整形済みイベント一覧
_cafeteria_list = None


def get_data():
    """(nodes_df, edges_df)"""
    global _nodes_df, _edges_df
    if _nodes_df is None or _edges_df is None:
        _nodes_df, _edges_df = load_data()
    return _nodes_df, _edges_df


def get_graph(use_elevator=True):
    """経路探索用グラフ。エレベータ有無で別々にキャッシュする"""
    global _graph_with_ev, _graph_without_ev
    nodes_df, edges_df = get_data()
    if use_elevator:
        if _graph_with_ev is None:
            _graph_with_ev = build_graph(nodes_df, edges_df, use_elevator=True)
        return _graph_with_ev
    if _graph_without_ev is None:
        _graph_without_ev = build_graph(nodes_df, edges_df, use_elevator=False)
    return _graph_without_ev


def get_node_xyz():
    """{node_id: (x, y, z)}"""
    global _node_xyz
    if _node_xyz is None:
        nodes_df, _ = get_data()
        _node_xyz = {
            int(r["id"]): (float(r["x"]), float(r["y"]), float(r["z"]))
            for _, r in nodes_df.iterrows()
        }
    return _node_xyz


def get_nodes_list():
    """/api/all 用の、座標を持たない軽量なノード一覧"""
    global _nodes_list
    if _nodes_list is None:
        nodes_df, _ = get_data()
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
        _nodes_list = nodes
    return _nodes_list


def _build_room_index(edges_df):
    """エッジの name 列を分解し、教室名→エッジ行 の索引と教室一覧を一度だけ構築する"""
    ignore_set = get_ignore_set()
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
            if room in TOILET_NAMES or room in ignore_set:
                continue  # 教室検索の候補には含めない（索引には残す）
            rooms_list.append({
                "room":     room,
                "display":  display_name(building, room),
                "building": building,
                "floor":    int(row["floor"]),
                "edge_id":  int(row["id"]),
                "from":     int(row["from"]),
                "to":       int(row["to"]),
            })
    rooms_list.sort(key=lambda r: (r["building"], r["room"]))
    return index, rooms_list


def get_room_index():
    """({(room, building): [edge行, ...]}, 教室一覧)"""
    global _room_index, _rooms_list
    if _room_index is None:
        _, edges_df = get_data()
        _room_index, _rooms_list = _build_room_index(edges_df)
    return _room_index, _rooms_list


def find_edges_for_room(room_name, building):
    """教室名が含まれるエッジ行のリストを返す（起動時に構築した索引から引く）"""
    index, _ = get_room_index()
    return index.get((room_name, int(building)), [])


def edges_by_names(names):
    """room_index から name が names に含まれるエッジ行を収集する（複数種別併記のエッジはIDで重複排除）"""
    room_index, _ = get_room_index()
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


def _event_candidates_from_row(row, edges_df, node_floor):
    """
    event.csv の1行から到達候補 [(node_id, edge行|None), ...] と階を解決する。
    room / edge_id / node_id の優先順で見る。戻り値: (candidates, floor|None)
    """
    building = int(float(row["building"])) if row["building"] else 0
    candidates, floor = [], None

    if row["room"]:
        for e_row in find_edges_for_room(row["room"], building):
            floor = int(e_row["floor"])
            candidates += [(int(e_row["from"]), e_row), (int(e_row["to"]), e_row)]
    elif row["edge_id"]:
        local_id = int(float(row["edge_id"]))
        gid = local_id if building == 0 else building * ID_OFFSET + local_id
        hits = edges_df[(edges_df["id"].astype(int) == gid)
                        & (edges_df["building"].astype(int) == building)]
        for _, e_row in hits.iterrows():
            floor = int(e_row["floor"])
            candidates += [(int(e_row["from"]), e_row), (int(e_row["to"]), e_row)]
    elif row["node_id"]:
        nid = int(float(row["node_id"]))
        gid = nid + GLOBAL_NODE_OFFSET if building == 0 else building * ID_OFFSET + nid
        if gid in node_floor:
            floor = node_floor[gid]
            candidates.append((gid, None))

    return candidates, floor


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
    nodes_df, edges_df = get_data()
    node_floor = {int(r["id"]): int(r["floor"]) for _, r in nodes_df.iterrows()}

    for _, raw in df.iterrows():
        row = {c: str(raw.get(c, "")).strip()
               for c in ("title", "building", "room", "node_id", "edge_id")}
        if not row["title"]:
            continue

        candidates, floor = _event_candidates_from_row(row, edges_df, node_floor)
        if not candidates:
            print(f"[event.csv] 位置を解決できない行をスキップ: title={row['title']}")
            continue

        index.setdefault(row["title"], []).extend(candidates)
        if row["title"] not in seen_titles:
            seen_titles.add(row["title"])
            events_list.append({
                "title":    row["title"],
                "building": int(float(row["building"])) if row["building"] else 0,
                "floor":    floor if floor is not None else 1,
            })
    return index, events_list


def get_event_index():
    """({title: [(node_id, edge行|None), ...]}, イベント一覧)"""
    global _event_index, _events_list
    if _event_index is None:
        _event_index, _events_list = _build_event_index()
    return _event_index, _events_list


def find_event_candidates(title):
    """イベント名→ [(node_id, edge行|None), ...]（未登録なら空リスト）"""
    index, _ = get_event_index()
    return index.get(title, [])


def get_cafeteria_list():
    """cafeteria_edge.csv の食堂一覧（無ければ空リスト）"""
    global _cafeteria_list
    if _cafeteria_list is None:
        result = []
        if os.path.exists(CAFETERIA_CSV):
            df = pd.read_csv(CAFETERIA_CSV, dtype=str).fillna("")
            for _, row in df.iterrows():
                name = row.get("name", "").strip()
                if not name:
                    continue
                result.append({
                    "name":         name,
                    "building":     row.get("building", "").strip(),
                    "display_name": row.get("display_name", name).strip(),
                })
        _cafeteria_list = result
    return _cafeteria_list


def get_cafeteria_names():
    return [c["name"] for c in get_cafeteria_list()]


def clear_caches():
    global _nodes_df, _edges_df, _graph_with_ev, _graph_without_ev
    global _room_index, _rooms_list, _nodes_list, _node_xyz
    global _event_index, _events_list, _cafeteria_list
    _nodes_df = None
    _edges_df = None
    _graph_with_ev = None
    _graph_without_ev = None
    _room_index = None
    _rooms_list = None
    _nodes_list = None
    _node_xyz = None
    _event_index = None
    _events_list = None
    _cafeteria_list = None
