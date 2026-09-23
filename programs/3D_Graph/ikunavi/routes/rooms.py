"""教室の一覧・検索と、教室から教室へのナビゲーション"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..naming import building_display_name
from ..search import best_route, candidates_from_edges, extend_to_far_endpoint
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import edges_for_room_or_404, use_elevator_param

bp = Blueprint("rooms", __name__)


@bp.route("/api/rooms")
def api_rooms():
    """
    教室名の一覧を返す。
    ?building=10  建物IDで絞り込み（省略時は全建物）
    ?q=101        前方一致の絞り込み（省略時は全件）
    返却形式: [ { "room": "101A", "building": 10, "edge_id": 5, "floor": 1 }, ... ]
    """
    building_filter = request.args.get("building", type=int)
    query           = request.args.get("q", "").strip().lower()

    _, rooms_list = cache.get_room_index()
    rooms = [
        r for r in rooms_list
        if (building_filter is None or r["building"] == building_filter)
        and (not query or query in r["room"].lower())
    ]
    return jsonify(rooms)


@bp.route("/api/all")
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
    nodes_df, _ = cache.get_data()
    _, rooms = cache.get_room_index()
    nodes    = cache.get_nodes_list()
    building_ids = sorted(nodes_df["building"].dropna().astype(int).unique().tolist())
    buildings = [{"id": b, "display_name": building_display_name(b)} for b in building_ids]

    return jsonify({"rooms": rooms, "nodes": nodes, "buildings": buildings})


@bp.route("/api/navigate_to_room")
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
        raise ApiError("room と building を指定してください")
    if not start_room and start_node is None:
        raise ApiError("start_room（＋start_building）または start を指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())

    dest_edges = edges_for_room_or_404(room_name, building)
    dest_candidates = candidates_from_edges(G, dest_edges)

    if start_room and start_building is not None:
        s_edges = edges_for_room_or_404(start_room, start_building, label="出発教室")
        start_candidates = candidates_from_edges(G, s_edges)
    else:
        # ノードID指定（後方互換）
        if start_node not in G.nodes:
            raise ApiError(f"ノード {start_node} が存在しません", 404)
        start_candidates = [(start_node, None)]

    best_path, best_length, best_start_edge, best_dest_edge = best_route(
        G, start_candidates, dest_candidates)

    if best_path is None:
        label = f"'{start_room}'" if start_room else f"ノード {start_node}"
        raise ApiError(f"{label} から教室 '{room_name}' への経路が見つかりません", 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = path_result(G, best_path, best_length)
    result["destination_room"] = room_name
    result["destination_edge"] = edge_to_dict(best_dest_edge)
    apply_dest_info(result, room_name)
    if best_start_edge is not None:
        result["start_room"] = start_room
        result["start_edge"] = edge_to_dict(best_start_edge)
    return jsonify(result)
