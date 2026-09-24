"""最寄り施設（トイレ・食堂）の検索。

いずれも「出発点から一番近い候補エッジ」を全探索で選ぶ点は同じで、
目的地の集め方とレスポンスに添える情報だけが違う。
"""
from flask import Blueprint, jsonify, request

from .. import cache
from ..errors import ApiError
from ..naming import TOILET_LABEL, TOILET_TYPE_MAP
from ..search import best_route, candidates_from_edges, extend_to_far_endpoint
from ..serialize import apply_dest_info, edge_to_dict, path_result
from ._common import FromSpec, use_elevator_param

bp = Blueprint("facilities", __name__)


def _route_to_facility(G, start_candidates, facility_edges, no_path_error):
    """出発点から施設エッジ群への最短経路。出発点そのものは目的地として扱わない"""
    dest_candidates = candidates_from_edges(G, facility_edges)

    best_path, best_length, best_start_row, best_dest_row = best_route(
        G, start_candidates, dest_candidates, allow_same_node=False)
    if best_path is None:
        raise ApiError(no_path_error, 404)

    best_path, best_length = extend_to_far_endpoint(G, best_path, best_length, best_dest_row)
    return path_result(G, best_path, best_length), best_start_row, best_dest_row


def _names_in(edge_row):
    return [n.strip() for n in str(edge_row["name"]).split(";")]


@bp.route("/api/cafeterias")
def api_cafeterias():
    return jsonify(cache.get_cafeteria_list())


@bp.route("/api/nearest_toilet")
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
    toilet_type = request.args.get("type", "all").strip().upper()
    from_spec = FromSpec.from_request().require()

    targets = TOILET_TYPE_MAP.get(toilet_type, TOILET_TYPE_MAP["ALL"])
    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)

    # トイレエッジを全建物から収集（教室名索引から引く。複数種別併記のエッジはIDで重複排除）
    toilet_edges = cache.edges_by_names(targets)
    if not toilet_edges:
        raise ApiError("該当するトイレがデータ内に見つかりません", 404)

    result, best_start_row, best_toilet_row = _route_to_facility(
        G, start_candidates, toilet_edges,
        "指定された出発点から該当するトイレへの経路が見つかりません")

    t_names = _names_in(best_toilet_row)
    found_key = next((t for t in TOILET_TYPE_MAP["ALL"] if t in t_names), "")

    result["toilet_type"]     = found_key.split("_")[0] if found_key else ""
    result["toilet_name"]     = found_key
    result["toilet_label"]    = TOILET_LABEL.get(found_key, "トイレ")
    result["toilet_building"] = int(best_toilet_row["building"])
    result["toilet_floor"]    = int(best_toilet_row["floor"])
    result["toilet_edge"]     = edge_to_dict(best_toilet_row)
    apply_dest_info(result, found_key)
    from_spec.annotate(result, best_start_row)
    return jsonify(result)


@bp.route("/api/nearest_cafeteria")
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
    from_spec = FromSpec.from_request().require()

    cafeteria_names = cache.get_cafeteria_names()
    if not cafeteria_names:
        raise ApiError("cafeteria_edge.csv が見つかりません", 500)

    caf_name = request.args.get("name", "all").strip()
    targets  = [caf_name] if caf_name != "all" else cafeteria_names

    G = cache.get_graph(use_elevator=use_elevator_param())
    start_candidates = from_spec.candidates(G)

    caf_edges = cache.edges_by_names(targets)
    if not caf_edges:
        raise ApiError("食堂エッジがデータ内に見つかりません", 404)

    result, best_start_row, best_caf_row = _route_to_facility(
        G, start_candidates, caf_edges, "食堂への経路が見つかりません")

    matched_caf = next((t for t in targets if t in _names_in(best_caf_row)), "")

    result["cafeteria_building"] = int(best_caf_row["building"])
    result["cafeteria_floor"]    = int(best_caf_row["floor"])
    result["cafeteria_edge"]     = edge_to_dict(best_caf_row)
    apply_dest_info(result, matched_caf)
    from_spec.annotate(result, best_start_row)
    return jsonify(result)
