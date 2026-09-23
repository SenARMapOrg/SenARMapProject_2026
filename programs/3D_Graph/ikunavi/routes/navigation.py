"""出発地→目的地の経路探索（ナビUIが使う本命のAPI）"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..search import (
    best_route,
    candidates_from_edges,
    candidates_from_event,
    extend_to_far_endpoint,
)
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import FromSpec, edges_for_room_or_404, use_elevator_param

bp = Blueprint("navigation", __name__)


def _dest_candidates(G, to_room, to_building, to_node_id, to_event):
    """目的地指定（to_event / to_room / to_node の優先順）を候補ノードに解決する"""
    if to_event:
        candidates = candidates_from_event(G, cache.find_event_candidates(to_event))
        if not candidates:
            raise ApiError(f"イベント '{to_event}' が見つかりません", 404)
        return candidates

    if to_room:
        if to_building is None:
            raise ApiError("to_building を指定してください")
        return candidates_from_edges(G, edges_for_room_or_404(to_room, to_building))

    if to_node_id not in G.nodes:
        raise ApiError(f"ノード {to_node_id} が存在しません", 404)
    return [(to_node_id, None)]


@bp.route("/api/route")
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
    from_spec = FromSpec.from_request()

    to_room     = request.args.get("to_room",     "").strip()
    to_building = request.args.get("to_building", type=int)
    to_node_id  = request.args.get("to_node",     type=int)
    to_event    = request.args.get("to_event",    "").strip()

    from_spec.require()
    if not to_room and not to_event and to_node_id is None:
        raise ApiError("to_room（＋to_building）・to_event・to_node のいずれかを指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)
    dest_candidates  = _dest_candidates(G, to_room, to_building, to_node_id, to_event)

    best_path, best_length, best_start_edge, best_dest_edge = best_route(
        G, start_candidates, dest_candidates)

    if best_path is None:
        raise ApiError("指定された出発点から目的地への経路が見つかりません", 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_edge)
    result = path_result(G, best_path, best_length)
    if to_event:
        result["to_event"] = to_event
    from_spec.annotate(result, best_start_edge)
    if best_dest_edge is not None:
        if to_room:
            result["to_room"] = to_room
        result["to_edge"] = edge_to_dict(best_dest_edge)
        apply_dest_info(result, to_room)
    return jsonify(result)


@bp.route("/api/shortest_path")
def api_shortest_path():
    """ノードIDからノードIDへの最短経路（従来通り）"""
    start = request.args.get("start", type=int)
    goal  = request.args.get("goal",  type=int)

    if start is None or goal is None:
        raise ApiError("start と goal のノードIDを指定してください")

    G = cache.get_graph(use_elevator=use_elevator_param())

    if start not in G.nodes:
        raise ApiError(f"ノード {start} が存在しません", 404)
    if goal not in G.nodes:
        raise ApiError(f"ノード {goal} が存在しません", 404)

    best_path, best_length, _, _ = best_route(G, [(start, None)], [(goal, None)])
    if best_path is None:
        raise ApiError(f"ノード {start} から {goal} への経路が見つかりません", 404)
    return jsonify(path_result(G, best_path, best_length))
