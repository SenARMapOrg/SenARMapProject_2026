"""APIの契約: ステータスコード・レスポンスの形・エラーメッセージ"""
import json

from tiny_campus import B1, B2, OUT


def get(client, path, **kwargs):
    res = client.get(path, **kwargs)
    return res.status_code, json.loads(res.data)


# ------------------------------------------------------------------ 教室一覧

def test_教室一覧(client):
    status, rooms = get(client, "/api/rooms")
    assert status == 200
    assert [r["room"] for r in rooms] == ["101", "201", "Cafe"]
    assert rooms[0] == {"room": "101", "display": "ゼミ101", "building": 1, "floor": 1,
                        "edge_id": 100001, "from": B1[1], "to": B1[2]}


def test_教室一覧は建物で絞り込める(client):
    _, rooms = get(client, "/api/rooms?building=2")
    assert [r["room"] for r in rooms] == ["201", "Cafe"]


def test_教室一覧は部分一致で絞り込める(client):
    _, rooms = get(client, "/api/rooms?q=10")
    assert [r["room"] for r in rooms] == ["101"]


def test_一括取得(client):
    status, data = get(client, "/api/all")
    assert status == 200
    assert set(data) == {"rooms", "nodes", "buildings"}
    assert data["buildings"] == [
        {"id": 0, "display_name": "屋外"},
        {"id": 1, "display_name": "第一実験棟"},
        {"id": 2, "display_name": "2号館"},
    ]
    assert len(data["nodes"]) == 12
    outdoor = next(n for n in data["nodes"] if n["id"] == OUT[1])
    assert outdoor["lat"] == 35.61


# ------------------------------------------------------------------ 経路探索

def test_教室から教室への経路(client):
    status, data = get(client, "/api/route?from_room=101&from_building=1&to_room=201&to_building=2")
    assert status == 200
    # 出発教室のエッジの両端のうち近い方(n2)から探索されるので 170 ではなく 160
    # 10(n2→n4) + 50(入口) + 30(屋外) + 50(入口) + 10(n4→n1) + 10(n1→n2)
    assert data["total_weight"] == 160.0
    assert data["path"][0] == B1[2] and data["path"][-1] == B2[2]
    assert data["from_room"] == "101" and data["to_room"] == "201"
    assert data["from_edge"]["id"] == 100001
    assert data["to_edge"]["id"] == 200001


def test_経路には目的地の左右と順番が入る(client):
    status, data = get(client, f"/api/route?from_node={B1[4]}&to_room=101&to_building=1")
    assert status == 200
    # n4→n2→n1 と進むので、101 は進行方向の左側にある
    assert data["dest_side"] == "left"
    assert data["dest_position"] == 1
    assert data["dest_count"] == 1
    assert data["dest_display"] == "ゼミ101"


def test_ノード指定の経路(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_node={B1[3]}")
    assert status == 200
    assert data["path"] == [B1[1], B1[2], B1[3]]


def test_エレベータを使わない指定(client):
    status, data = get(client, f"/api/route?from_node={B2[1]}&to_node={B2[5]}")
    assert status == 200 and data["total_weight"] == 4.0
    status, data = get(client, f"/api/route?from_node={B2[1]}&to_node={B2[5]}&use_elevator=0")
    assert status == 404


def test_出発地の指定がなければ400(client):
    status, data = get(client, "/api/route?to_room=101&to_building=1")
    assert status == 400
    assert data["error"] == "from_room（＋from_building）・from_event・from_node のいずれかを指定してください"


def test_目的地の指定がなければ400(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}")
    assert status == 400
    assert data["error"] == "to_room（＋to_building）・to_event・to_node のいずれかを指定してください"


def test_建物の指定を忘れたら400(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_room=101")
    assert status == 400
    assert data["error"] == "to_building を指定してください"


def test_存在しない教室は404(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_room=999&to_building=1")
    assert status == 404
    assert data["error"] == "建物 1 に教室 '999' が見つかりません"


def test_存在しないノードは404(client):
    status, data = get(client, f"/api/route?from_node=42&to_node={B1[1]}")
    assert status == 404
    assert data["error"] == "ノード 42 が存在しません"


def test_教室から教室への経路_後方互換API(client):
    status, data = get(client, "/api/navigate_to_room?start_room=101&start_building=1&room=201&building=2")
    assert status == 200
    assert data["destination_room"] == "201"
    assert data["destination_edge"]["id"] == 200001
    assert data["start_room"] == "101"
    assert data["total_weight"] == 160.0


def test_後方互換APIはノードIDの出発も受ける(client):
    status, data = get(client, f"/api/navigate_to_room?start={B1[1]}&room=201&building=2")
    assert status == 200
    assert "start_edge" not in data


def test_後方互換APIの必須パラメータ(client):
    status, data = get(client, "/api/navigate_to_room")
    assert status == 400
    assert data["error"] == "room と building を指定してください"


def test_ノード間の最短経路(client):
    status, data = get(client, f"/api/shortest_path?start={B1[1]}&goal={B1[3]}")
    assert status == 200 and data["total_weight"] == 14.0
    status, data = get(client, "/api/shortest_path?start=1")
    assert status == 400
    assert data["error"] == "start と goal のノードIDを指定してください"


# ------------------------------------------------------------------ 施設検索

def test_最寄りトイレ(client):
    status, data = get(client, "/api/nearest_toilet?from_room=101&from_building=1")
    assert status == 200
    assert data["toilet_type"] == "M"
    assert data["toilet_label"] == "男子トイレ"
    assert data["toilet_building"] == 1
    assert data["toilet_floor"] == 2
    assert data["total_weight"] == 14.0
    assert data["from_room"] == "101"


def test_該当する種別のトイレが無ければ404(client):
    status, data = get(client, "/api/nearest_toilet?type=F&from_room=101&from_building=1")
    assert status == 404
    assert data["error"] == "該当するトイレがデータ内に見つかりません"


def test_食堂一覧(client):
    status, data = get(client, "/api/cafeterias")
    assert status == 200
    assert data == [{"name": "Cafe", "building": "2", "display_name": "テスト食堂"}]


def test_最寄り食堂(client):
    status, data = get(client, "/api/nearest_cafeteria?from_room=101&from_building=1")
    assert status == 200
    assert data["cafeteria_building"] == 2
    assert data["cafeteria_floor"] == 1
    assert data["cafeteria_edge"]["id"] == 200003


# ------------------------------------------------------------------ イベントモード

def test_イベント一覧(client):
    status, data = get(client, "/api/events")
    assert status == 200
    assert data == [
        {"title": "たこ焼き", "building": 2, "floor": 1},
        {"title": "射的", "building": 0, "floor": 1},
    ]


def test_イベントを目的地にできる(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_event=たこ焼き")
    assert status == 200
    assert data["to_event"] == "たこ焼き"


def test_イベントを出発地にできる(client):
    status, data = get(client, "/api/route?from_event=射的&to_room=201&to_building=2")
    assert status == 200
    assert data["from_event"] == "射的"
    assert data["path"][0] == OUT[2]


def test_存在しないイベントは404(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_event=存在しない")
    assert status == 404
    assert data["error"] == "イベント '存在しない' が見つかりません"


# ------------------------------------------------------------------ その他

def test_経路写真のURL一覧(client):
    status, data = get(client, "/api/edge_images")
    assert status == 200
    # from/to が 0,0 の行は無視される
    assert data == {"100001_100002": "https://cdn.iku-navi.net/a.jpg"}


def test_3Dビューア用のグラフ(client):
    status, data = get(client, "/api/graph")
    assert status == 200
    assert set(data) == {"nodes", "edges", "building_colors", "config"}
    assert len(data["nodes"]) == 12
    outdoor = next(n for n in data["nodes"] if n["building"] == 0)
    assert outdoor["color"] == "#5AFF5A"


def test_3Dビューアのページが開ける(client):
    res = client.get("/3d/")
    assert res.status_code == 200


def test_許可オリジンにはCORSヘッダを返す(client):
    res = client.get("/api/rooms", headers={"Origin": "https://iku-navi.net"})
    assert res.headers["Access-Control-Allow-Origin"] == "https://iku-navi.net"
    assert res.headers["Vary"] == "Origin"


def test_Pagesプレビューのオリジンも許可する(client):
    res = client.get("/api/rooms", headers={"Origin": "https://abc123.pages.dev"})
    assert res.headers["Access-Control-Allow-Origin"] == "https://abc123.pages.dev"


def test_許可していないオリジンにはCORSヘッダを返さない(client):
    res = client.get("/api/rooms", headers={"Origin": "https://example.com"})
    assert "Access-Control-Allow-Origin" not in res.headers


def test_時間割共有からの読み込みを許可する(client):
    res = client.get("/api/all", headers={"Origin": "https://timetables.iku-navi.net"})
    assert res.headers["Access-Control-Allow-Origin"] == "https://timetables.iku-navi.net"


def test_環境変数で許可オリジンを足せる(client, monkeypatch):
    monkeypatch.setenv("IKUNAVI_CORS_EXTRA_ORIGINS", "http://127.0.0.1:8127, http://localhost:5173")
    res = client.get("/api/all", headers={"Origin": "http://127.0.0.1:8127"})
    assert res.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:8127"


def test_環境変数が無ければローカルのオリジンは許可しない(client, monkeypatch):
    monkeypatch.delenv("IKUNAVI_CORS_EXTRA_ORIGINS", raising=False)
    res = client.get("/api/all", headers={"Origin": "http://127.0.0.1:8127"})
    assert "Access-Control-Allow-Origin" not in res.headers
