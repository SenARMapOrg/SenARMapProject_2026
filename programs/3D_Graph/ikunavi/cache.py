"""起動後に一度だけ構築し、以降は使い回す派生データ。

CSVの読み込みとグラフ構築は数百ms〜秒単位かかるため、リクエストごとにはやらない。
データを更新したときはプロセスを再起動するか clear_caches() を呼ぶ
（ikunavi.clear_all_caches() が全モジュールのキャッシュをまとめて落とす）。
"""
import os

import pandas as pd

from .config import GLOBAL_NODE_OFFSET, ID_OFFSET, data_path
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
_event_extra = None   # event.csv の位置(左右・何番目)とIDの索引（_build_event_index 参照）
_cafeteria_list = None
_facility_list = None  # facility.csv: その他の設備（コンビニ・教務課など）
_edge_by_id = None    # {グローバルなエッジID: edge行}


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
    """/api/all 用の軽量なノード一覧（実座標 x/y/z は持たない）。
    屋外ノードは緯度経度、屋内ノードはフロアマップSVG上の座標（svg_x/svg_y。あるものだけ）を持つ。
    svg_x/svg_y は埋め込みフロアマップ（programs/html/embed/）が教室の位置に印を付けるのに使う"""
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
            if "svg_x" in row and pd.notna(row["svg_x"]) and pd.notna(row.get("svg_y")):
                nd["svg_x"] = float(row["svg_x"])
                nd["svg_y"] = float(row["svg_y"])
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


def find_edge_by_id(edge_id):
    """グローバルなエッジID（建物 × 100000 ＋ edge.csv の id。屋外は global_edge.csv の id のまま）→ edge行。無ければ None"""
    global _edge_by_id
    if _edge_by_id is None:
        _, edges_df = get_data()
        _edge_by_id = {int(row["id"]): row for _, row in edges_df.iterrows()}
    return _edge_by_id.get(int(edge_id))


def find_edges_by_name(name, building=None):
    """名前（教室・トイレ・ignore.csv の名前も含む。name 列の ";" 区切りの1つ）が付いたエッジ行。
    building を省くと全建物から探す。戻り値: [(building, edge行), ...]"""
    index, _ = get_room_index()
    return [(b, row) for (n, b), rows in index.items() if n == name and (building is None or b == int(building))
            for row in rows]


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


EVENT_COLUMNS = ("id", "title", "building", "room", "node_id", "edge_id", "side", "position")
_SIDE_ALIASES = {"right": "right", "r": "right", "右": "right", "left": "left", "l": "left", "左": "left"}


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


def _event_place_from_row(row):
    """
    event.csv の1行の「エッジのどちら側の何番目か」。
      room    … その教室の位置（edge.csv の right/left 列）をそのまま使う → {"room": 教室名}
      edge_id … side（right/left。右/左 でも可）と position（1始まり）を見る
                → {"side": "right"|"left"|"", "position": int|None}
      node_id … 点なので位置は無い → None
    side・position は edge.csv の from→to の向きで見たときの値（教室の right/left 列と同じ決め方）。
    position は同じエッジの同じ側にある展示どうしの並び順で、手前（from 側）ほど小さくする。
    """
    if row["room"]:
        return {"room": row["room"]}
    if not row["edge_id"]:
        return None
    side = _SIDE_ALIASES.get(row["side"].lower(), "")
    try:
        position = int(float(row["position"])) if row["position"] else None
    except ValueError:
        position = None
    if position is not None and position < 1:
        position = None
    return {"side": side, "position": position if side else None}


def _build_event_index():
    """
    event.csv（列: id,title,building,room,node_id,edge_id,side,position。id・side・position は任意）を読み込み、
    イベント名→到達候補ノード の索引と一覧を構築する。

    1行につき room / node_id / edge_id のいずれか1つでタイトルの場所を指定する:
      room    … 既存の教室名（;区切りのエッジ name に含まれる名前）
      node_id … 建物内のローカルノードID（building=0 なら global_node.csv のID）
      edge_id … 建物内のローカルエッジID（building=0 なら global_edge.csv のID）。
                side・position で、教室と同じように「右側の2番目」などの位置も指定できる
    同じ title の行が複数あれば候補を統合する（複数箇所で開催する屋台など）。
    id はナビのURL（navi/?to_event=<id>）でイベントを呼び出すための名前。同じ title の行には同じ id を書く。

    戻り値: (index, events_list, extra)
      extra = {"places":  {title: {エッジの全体ID: 位置}},
               "lineups": {(エッジの全体ID, side): [title, ...]（position 順＝from 側から）},
               "ids":     {id: title}}
    """
    index, events_list, seen_titles = {}, [], set()
    extra = {"places": {}, "lineups": {}, "ids": {}}
    event_csv = data_path("event.csv")
    if not os.path.exists(event_csv):
        return index, events_list, extra

    df = pd.read_csv(event_csv, dtype=str).fillna("")
    df.columns = df.columns.str.strip()
    nodes_df, edges_df = get_data()
    node_floor = {int(r["id"]): int(r["floor"]) for _, r in nodes_df.iterrows()}
    lineups = {}

    for _, raw in df.iterrows():
        row = {c: str(raw.get(c, "")).strip() for c in EVENT_COLUMNS}
        if not row["title"]:
            continue

        candidates, floor = _event_candidates_from_row(row, edges_df, node_floor)
        if not candidates:
            print(f"[event.csv] 位置を解決できない行をスキップ: title={row['title']}")
            continue

        index.setdefault(row["title"], []).extend(candidates)
        place = _event_place_from_row(row)
        if place is not None:
            for gid in {int(e_row["id"]) for _, e_row in candidates if e_row is not None}:
                extra["places"].setdefault(row["title"], {})[gid] = place
                if place.get("position") is not None:
                    lineups.setdefault((gid, place["side"]), []).append((place["position"], row["title"]))
        if row["id"]:
            known = extra["ids"].get(row["id"])
            if known is not None and known != row["title"]:
                print(f"[event.csv] 同じidが別のイベントに使われているため後の行を無視: id={row['id']} title={row['title']}")
            else:
                extra["ids"][row["id"]] = row["title"]
        if row["title"] not in seen_titles:
            seen_titles.add(row["title"])
            events_list.append({
                "id":       row["id"],
                "title":    row["title"],
                "building": int(float(row["building"])) if row["building"] else 0,
                "floor":    floor if floor is not None else 1,
            })

    # 同じ title の後の行で id だけ書かれている場合も一覧に反映する
    title_to_id = {}
    for event_id, title in extra["ids"].items():
        title_to_id.setdefault(title, event_id)
    for ev in events_list:
        ev["id"] = ev["id"] or title_to_id.get(ev["title"], "")

    extra["lineups"] = {key: [title for _, title in sorted(items)] for key, items in lineups.items()}
    return index, events_list, extra


def _ensure_event_index():
    global _event_index, _events_list, _event_extra
    if _event_index is None:
        _event_index, _events_list, _event_extra = _build_event_index()


def get_event_index():
    """({title: [(node_id, edge行|None), ...]}, イベント一覧)"""
    _ensure_event_index()
    return _event_index, _events_list


def find_event_candidates(title):
    """イベント名→ [(node_id, edge行|None), ...]（未登録なら空リスト）"""
    index, _ = get_event_index()
    return index.get(title, [])


def find_event_place(title, edge_gid):
    """イベントがそのエッジ（全体ID）のどこにあるか（_event_place_from_row の形。無ければ None）"""
    _ensure_event_index()
    return _event_extra["places"].get(title, {}).get(int(edge_gid))


def event_lineup(edge_gid, side):
    """そのエッジのその側（edge.csv の from→to の向き）に並ぶ展示名の一覧（from 側から順に）"""
    _ensure_event_index()
    return _event_extra["lineups"].get((int(edge_gid), side), [])


def find_event_title_by_id(event_id):
    """event.csv の id → イベント名（未登録なら None）"""
    _ensure_event_index()
    return _event_extra["ids"].get(str(event_id).strip())


def resolve_event_title(value):
    """API の from_event / to_event に渡された値を、イベント名に直す（イベント名ならそのまま、id ならその名前）"""
    value = str(value or "").strip()
    if not value:
        return ""
    index, _ = get_event_index()
    if value in index:
        return value
    return find_event_title_by_id(value) or value


def get_cafeteria_list():
    """cafeteria_edge.csv の食堂一覧（無ければ空リスト）"""
    global _cafeteria_list
    if _cafeteria_list is None:
        result = []
        path = data_path("cafeteria_edge.csv")
        if os.path.exists(path):
            df = pd.read_csv(path, dtype=str).fillna("")
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


def get_facility_list():
    """
    facility.csv のその他の設備（コンビニ・教務課など）の一覧（無ければ空リスト）。
    category が同じ行は同じ種類の設備としてまとめ、検索ではその中で一番近いものへ案内する。
    category が空の行は display_name（無ければ name）をそのまま種類にする。
    """
    global _facility_list
    if _facility_list is None:
        result = []
        path = data_path("facility.csv")
        if os.path.exists(path):
            df = pd.read_csv(path, dtype=str).fillna("")
            for _, row in df.iterrows():
                name = row.get("name", "").strip()
                if not name:
                    continue
                display = row.get("display_name", "").strip() or name
                result.append({
                    "category":     row.get("category", "").strip() or display,
                    "name":         name,
                    "building":     row.get("building", "").strip(),
                    "display_name": display,
                })
        _facility_list = result
    return _facility_list


def get_facility_categories():
    """facility.csv の設備の種類（ファイルに書かれた順、重複なし）"""
    return list(dict.fromkeys(f["category"] for f in get_facility_list()))


def clear_caches():
    global _nodes_df, _edges_df, _graph_with_ev, _graph_without_ev
    global _room_index, _rooms_list, _nodes_list, _node_xyz
    global _event_index, _events_list, _event_extra, _cafeteria_list, _facility_list, _edge_by_id
    _edge_by_id = None
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
    _event_extra = None
    _cafeteria_list = None
    _facility_list = None
