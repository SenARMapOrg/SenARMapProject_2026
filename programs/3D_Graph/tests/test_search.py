"""経路探索: 候補ノードの列挙・全組み合わせDijkstra・目的エッジへの延長"""
import pandas as pd

from conftest import B1, B2, OUT
from ikunavi.cache import get_graph
from ikunavi.search import (
    best_route,
    candidates_from_edges,
    candidates_from_event,
    extend_to_far_endpoint,
)


def _row(frm, to):
    return pd.Series({"from": frm, "to": to})


def test_エッジ行の両端がそのまま候補になる(tiny_campus):
    G = get_graph()
    got = candidates_from_edges(G, [_row(B1[1], B1[2])])
    assert [nid for nid, _ in got] == [B1[1], B1[2]]


def test_グラフに無いノードは候補から外れる(tiny_campus):
    G = get_graph()
    got = candidates_from_edges(G, [_row(B1[1], 999999)])
    assert [nid for nid, _ in got] == [B1[1]]


def test_重複排除を指定すると同じノードは1回だけになる(tiny_campus):
    G = get_graph()
    rows = [_row(B1[1], B1[2]), _row(B1[2], B1[1])]
    assert len(candidates_from_edges(G, rows, dedupe=True)) == 2
    assert len(candidates_from_edges(G, rows, dedupe=False)) == 4


def test_イベント候補も重複排除される(tiny_campus):
    G = get_graph()
    got = candidates_from_event(G, [(B1[1], None), (B1[1], None), (B1[2], None)])
    assert [nid for nid, _ in got] == [B1[1], B1[2]]


def test_最短の組み合わせが選ばれる(tiny_campus):
    G = get_graph()
    # 1号館 n1 から、n3(階段の上) と n1 自身 を目的候補にする
    path, length, _, _ = best_route(G, [(B1[1], None)], [(B1[3], None)], allow_same_node=False)
    assert path == [B1[1], B1[2], B1[3]]
    assert length == 14.0   # 10m + 階段4m


def test_出発と同じノードは許可すると距離0の経路になる(tiny_campus):
    G = get_graph()
    path, length, _, _ = best_route(G, [(B1[1], None)], [(B1[1], None)], allow_same_node=True)
    assert path == [B1[1]] and length == 0.0


def test_出発と同じノードは禁止するとスキップされる(tiny_campus):
    G = get_graph()
    path, _, _, _ = best_route(G, [(B1[1], None)], [(B1[1], None)], allow_same_node=False)
    assert path is None


def test_到達できない組み合わせはNoneを返す(tiny_campus):
    G = get_graph()
    path, _, _, _ = best_route(G, [(B1[1], None)], [(B2[3], None)], allow_same_node=False)
    # 2号館の n3 へは上りESCで行けるので到達はできる
    assert path is not None
    assert path[-1] == B2[3]


def test_目的エッジの反対側の端点まで延長される(tiny_campus):
    G = get_graph()
    dest_edge = _row(B1[1], B1[2])
    path, length = extend_to_far_endpoint(G, [B1[4], B1[2]], 10.0, dest_edge)
    assert path == [B1[4], B1[2], B1[1]]
    assert length == 20.0


def test_すでに目的エッジを歩いて到着していれば延長しない(tiny_campus):
    G = get_graph()
    dest_edge = _row(B1[1], B1[2])
    path, length = extend_to_far_endpoint(G, [B1[1], B1[2]], 10.0, dest_edge)
    assert path == [B1[1], B1[2]] and length == 10.0


def test_目的地がエッジでなければ延長しない(tiny_campus):
    G = get_graph()
    path, length = extend_to_far_endpoint(G, [B1[1], B1[2]], 10.0, None)
    assert path == [B1[1], B1[2]] and length == 10.0


def test_建物をまたぐ経路は入口ペナルティを2回払う(tiny_campus):
    G = get_graph()
    path, length, _, _ = best_route(G, [(B1[1], None)], [(B2[2], None)])
    # 10(n1→n2) + 10(n2→n4) + 50(入口) + 30(屋外) + 50(入口) + 10(n4→n1) + 10(n1→n2)
    assert length == 170.0
    assert path[0] == B1[1] and path[-1] == B2[2]
    assert OUT[1] in path and OUT[2] in path
