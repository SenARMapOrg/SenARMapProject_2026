"""リポジトリの data/ が壊れていないかのチェック。

ロジックの回帰テストは合成データ（conftest.py）で行い、ここでは
「CSVを編集した結果アプリが起動しなくなる／経路が引けなくなる」類の
事故を拾うことだけを狙う。件数など編集で普通に変わる値は見ない。
"""
import json

from ikunavi.cache import (
    get_cafeteria_list,
    get_data,
    get_graph,
    get_event_index,
    get_room_index,
)
from ikunavi.naming import TOILET_NAMES


def test_実データを読み込める(real_data):
    nodes, edges = get_data()
    assert not nodes.empty
    assert not edges.empty


def test_ノードIDが重複していない(real_data):
    nodes, _ = get_data()
    ids = nodes["id"].astype(int)
    assert ids.is_unique, f"重複しているノードID: {sorted(ids[ids.duplicated()].unique())}"


def test_全エッジの両端がノードとして存在する(real_data):
    nodes, edges = get_data()
    node_ids = set(nodes["id"].astype(int))
    dangling = [
        int(r["id"]) for _, r in edges.iterrows()
        if int(r["from"]) not in node_ids or int(r["to"]) not in node_ids
    ]
    assert not dangling, f"端点が存在しないエッジ: {dangling}"


def test_グラフを構築できる(real_data):
    G = get_graph()
    assert G.number_of_nodes() > 0
    assert G.number_of_edges() > 0


def test_教室がすべてグラフ上のノードに紐づく(real_data):
    G = get_graph()
    index, _ = get_room_index()
    orphans = [
        key for key, rows in index.items()
        if not any(int(r["from"]) in G.nodes and int(r["to"]) in G.nodes for r in rows)
    ]
    assert not orphans, f"グラフに載っていない教室: {orphans}"


def test_食堂の名前がエッジに存在する(real_data):
    index, _ = get_room_index()
    registered = {name for name, _bldg in index}
    missing = [c["name"] for c in get_cafeteria_list() if c["name"] not in registered]
    assert not missing, f"cafeteria_edge.csv にあるがエッジに無い食堂: {missing}"


def test_トイレがどこかに登録されている(real_data):
    index, _ = get_room_index()
    registered = {name for name, _bldg in index}
    assert registered & TOILET_NAMES, "トイレのエッジが1つも登録されていない"


def test_イベントの行がすべて解決できる(real_data):
    # 解決できない行は起動時に警告を出してスキップされる。件数が合わなければ設定ミス
    import csv
    import os

    from ikunavi.config import data_path

    path = data_path("event.csv")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        titles = {row["title"].strip() for row in csv.DictReader(f) if row.get("title", "").strip()}
    index, _ = get_event_index()
    assert titles == set(index), f"位置を解決できないイベント: {sorted(titles - set(index))}"


def test_主要なAPIが応答する(real_client):
    for path in ["/api/all", "/api/rooms", "/api/graph", "/api/cafeterias",
                 "/api/events", "/api/edge_images"]:
        res = real_client.get(path)
        assert res.status_code == 200, f"{path} が {res.status_code}"
        json.loads(res.data)


def test_実データで教室から教室への経路が引ける(real_client):
    rooms = json.loads(real_client.get("/api/all").data)["rooms"]
    assert len(rooms) >= 2
    a, b = rooms[0], rooms[-1]
    res = real_client.get(
        f"/api/route?from_room={a['room']}&from_building={a['building']}"
        f"&to_room={b['room']}&to_building={b['building']}")
    assert res.status_code == 200, res.data.decode()
    data = json.loads(res.data)
    assert len(data["path"]) >= 2


def test_実データで最寄りトイレが引ける(real_client):
    rooms = json.loads(real_client.get("/api/all").data)["rooms"]
    res = real_client.get(
        f"/api/nearest_toilet?from_room={rooms[0]['room']}&from_building={rooms[0]['building']}")
    assert res.status_code == 200, res.data.decode()
