"""グラフ構築: 双方向化・エスカレータの一方向制約・エレベータ除外・入口ペナルティ"""
import pandas as pd

from tiny_campus import B1, B2, OUT
from ikunavi.cache import get_data, get_graph
from ikunavi.config import ENTRANCE_PENALTY
from ikunavi.graph import build_graph


def _frames(edge_rows, nodes=None):
    nodes = nodes or [
        {"id": 1, "x": 0, "y": 0, "z": 0, "building": 1, "floor": 1, "type": 1},
        {"id": 2, "x": 10, "y": 0, "z": 0, "building": 1, "floor": 1, "type": 1},
        {"id": 3, "x": 10, "y": 0, "z": 4, "building": 1, "floor": 2, "type": 1},
    ]
    return pd.DataFrame(nodes), pd.DataFrame(edge_rows)


def _edge(**kw):
    base = {"id": 1, "name": "", "from": 1, "to": 2, "building": 1, "floor": 1,
            "weight": 1.0, "length": 10.0, "type": 1, "right": "", "left": ""}
    base.update(kw)
    return base


def test_通常の通路は双方向に張られる():
    G = build_graph(*_frames([_edge()]))
    assert G.has_edge(1, 2) and G.has_edge(2, 1)


def test_逆方向のエッジでは右と左が入れ替わる():
    G = build_graph(*_frames([_edge(right="101", left="102")]))
    assert G.edges[1, 2]["right"] == "101" and G.edges[1, 2]["left"] == "102"
    assert G.edges[2, 1]["right"] == "102" and G.edges[2, 1]["left"] == "101"


def test_上りエスカレータは低い方から高い方へだけ通れる():
    # CSVの from/to の向きに関わらず z 座標で決まる
    G = build_graph(*_frames([_edge(**{"from": 3, "to": 2, "type": 5})]))
    assert G.has_edge(2, 3)
    assert not G.has_edge(3, 2)


def test_下りエスカレータは高い方から低い方へだけ通れる():
    G = build_graph(*_frames([_edge(**{"from": 2, "to": 3, "type": 6})]))
    assert G.has_edge(3, 2)
    assert not G.has_edge(2, 3)


def test_エレベータは無効時にグラフから消える():
    frames = _frames([_edge(**{"from": 2, "to": 3, "type": 4})])
    assert build_graph(*frames, use_elevator=True).has_edge(2, 3)
    assert not build_graph(*frames, use_elevator=False).has_edge(2, 3)


def test_重みは距離かける係数():
    G = build_graph(*_frames([_edge(weight=2.0, length=10.0)]))
    assert G.edges[1, 2]["weight"] == 20.0


def test_入口エッジには通過ペナルティが乗る():
    G = build_graph(*_frames([_edge(type=7, weight=1.0, length=0.0)]))
    assert G.edges[1, 2]["weight"] == ENTRANCE_PENALTY


def test_ノードの緯度経度とSVG座標が属性として載る(tiny_campus):
    G = get_graph()
    assert "lat" in G.nodes[OUT[1]] and "lng" in G.nodes[OUT[1]]
    assert G.nodes[B1[1]]["svg_x"] == 100.0


def test_合成キャンパスのエスカレータが一方向になっている(tiny_campus):
    G = get_graph()
    assert G.has_edge(B2[2], B2[3])
    assert not G.has_edge(B2[3], B2[2])


def test_エレベータ無効のグラフは別にキャッシュされる(tiny_campus):
    with_ev = get_graph(use_elevator=True)
    without_ev = get_graph(use_elevator=False)
    assert with_ev.has_edge(B2[1], B2[5])
    assert not without_ev.has_edge(B2[1], B2[5])
    assert get_graph(use_elevator=True) is with_ev   # 2回目はキャッシュを返す


def test_ノードとエッジの件数(tiny_campus):
    nodes, edges = get_data()
    assert len(nodes) == 12   # 1号館5 + 2号館5 + 屋外2
    assert len(edges) == 11   # 1号館4 + 2号館4 + 屋外1 + 入口2
