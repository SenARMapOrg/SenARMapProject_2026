"""ルート間で共通のクエリパラメータ解釈。

出発点の指定方法（教室名 / ノードID / イベント名）は複数のエンドポイントで
同じ書式なので、解釈と候補ノードへの解決をここにまとめている。
"""
from flask import request

from .. import cache
from ..errors import ApiError
from ..search import candidates_from_edges, candidates_from_event
from ..serialize import edge_to_dict


def use_elevator_param():
    """use_elevator=0 のときだけエレベータを使わない（省略時は使う）"""
    return request.args.get("use_elevator", "1") != "0"


def edges_for_room_or_404(room_name, building, label="教室"):
    """教室名→エッジ行。見つからなければ404"""
    edges = cache.find_edges_for_room(room_name, building)
    if not edges:
        raise ApiError(f"建物 {building} に{label} '{room_name}' が見つかりません", 404)
    return edges


class FromSpec:
    """出発点の指定（from_room＋from_building / from_node / from_event）"""

    def __init__(self, room="", building=None, node_id=None, event=""):
        self.room = room
        self.building = building
        self.node_id = node_id
        self.event = event

    @classmethod
    def from_request(cls):
        return cls(
            room=request.args.get("from_room", "").strip(),
            building=request.args.get("from_building", type=int),
            node_id=request.args.get("from_node", type=int),
            event=request.args.get("from_event", "").strip(),
        )

    def require(self):
        """いずれも指定されていなければ400"""
        if not self.room and not self.event and self.node_id is None:
            raise ApiError("from_room（＋from_building）・from_event・from_node のいずれかを指定してください")
        return self

    def candidates(self, G):
        """
        出発点指定（from_event / from_room / from_node の優先順）を
        候補ノードのリスト [(node_id, edge行|None), ...] に解決する。
        """
        if self.event:
            result = candidates_from_event(G, cache.find_event_candidates(self.event))
            if not result:
                raise ApiError(f"イベント '{self.event}' が見つかりません", 404)
            return result

        if self.room:
            if self.building is None:
                raise ApiError("from_building を指定してください")
            edges = edges_for_room_or_404(self.room, self.building)
            return candidates_from_edges(G, edges, dedupe=True)

        if self.node_id not in G.nodes:
            raise ApiError(f"ノード {self.node_id} が存在しません", 404)
        return [(self.node_id, None)]

    def annotate(self, result, start_edge_row):
        """レスポンスに出発点情報（from_event / from_room / from_edge）を書き足す"""
        if self.event:
            result["from_event"] = self.event
        if start_edge_row is not None:
            if self.room:
                result["from_room"] = self.room
            result["from_edge"] = edge_to_dict(start_edge_row)
        return result
