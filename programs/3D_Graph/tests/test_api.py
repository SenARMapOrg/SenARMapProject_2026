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


def test_一括取得のノードにはフロアマップ上の座標が入る(client):
    # 埋め込みフロアマップが教室の位置に印を付けるのに使う。svg_x の無い建物のノードには付けない
    _, data = get(client, "/api/all")
    nodes = {n["id"]: n for n in data["nodes"]}
    assert (nodes[B1[1]]["svg_x"], nodes[B1[1]]["svg_y"]) == (100.0, 100.0)
    assert "svg_x" not in nodes[B2[1]]
    assert "svg_x" not in nodes[OUT[1]]


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


def test_通路を目的地にできる(client):
    # 名前の1つだけの通路（男子トイレ）なら、その表示名が目的地の名前になる
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_edge=100003")
    assert status == 200
    assert data["path"][-1] in (B1[3], B1[5])
    assert data["to_edge"]["id"] == 100003
    assert data["dest_display"] == "男子トイレ"


def test_教室が2つ並ぶ通路を目的地にしたときは名前を決めない(client):
    status, data = get(client, f"/api/route?from_node={B1[4]}&to_edge=100001")
    assert status == 200
    assert data["to_edge"]["id"] == 100001
    assert data["dest_display"] is None


def test_通路を出発地にできる(client):
    status, data = get(client, "/api/route?from_edge=100002&to_room=101&to_building=1")
    assert status == 200
    assert data["from_edge"]["id"] == 100002
    assert data["path"][0] in (B1[2], B1[3])


def test_存在しない通路は404(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_edge=999")
    assert status == 404
    assert data["error"] == "エッジ 999 が存在しません"


def test_通路をIDで引く(client):
    status, data = get(client, "/api/edges?id=100003")
    assert status == 200
    assert data == [{"id": 100003, "building": 1, "floor": 2, "from": B1[3], "to": B1[5], "type": "1",
                     "length": 10.0, "name": "M_Toilet", "display": "男子トイレ"}]
    status, _ = get(client, "/api/edges?id=42")
    assert status == 404


def test_通路を名前で引く_教室一覧に出ない名前も引ける(client):
    _, data = get(client, "/api/edges?name=M_Toilet")
    assert [(e["id"], e["display"]) for e in data] == [(100003, "男子トイレ")]
    _, data = get(client, "/api/edges?name=102&building=1")   # ignore.csv の名前
    assert [(e["id"], e["display"]) for e in data] == [(100001, "第一講義室")]
    _, data = get(client, "/api/edges?name=M_Toilet&building=2")
    assert data == []
    status, data = get(client, "/api/edges")
    assert status == 400


def test_エレベータを使わない指定(client):
    status, data = get(client, f"/api/route?from_node={B2[1]}&to_node={B2[5]}")
    assert status == 200 and data["total_weight"] == 4.0
    status, data = get(client, f"/api/route?from_node={B2[1]}&to_node={B2[5]}&use_elevator=0")
    assert status == 404


def test_出発地の指定がなければ400(client):
    status, data = get(client, "/api/route?to_room=101&to_building=1")
    assert status == 400
    assert data["error"] == "from_room（＋from_building）・from_event・from_edge・from_node のいずれかを指定してください"


def test_目的地の指定がなければ400(client):
    status, data = get(client, f"/api/route?from_node={B1[1]}")
    assert status == 400
    assert data["error"] == "to_room（＋to_building）・to_event・to_edge・to_node のいずれかを指定してください"


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


# ------------------------------------------------------------------ その他の設備（facility.csv）

def test_その他の設備の一覧(client):
    status, data = get(client, "/api/facilities")
    assert status == 200
    assert data == [
        {"category": "案内所", "name": "M_Toilet", "building": "1", "display_name": "第一案内所"},
        {"category": "案内所", "name": "Cafe", "building": "2", "display_name": "第二案内所"},
        {"category": "教務課", "name": "201", "building": "2", "display_name": "教務課"},
    ]


def test_同じ種類の設備のうち一番近いものへ案内する(client):
    # 1号館の101からは、同じ号館の2階（階段で4m）の方が、屋外を通る2号館より近い
    status, data = get(client, "/api/nearest_facility?category=案内所&from_room=101&from_building=1")
    assert status == 200
    assert data["facility_category"] == "案内所"
    assert data["facility_name"] == "M_Toilet"
    assert data["facility_display"] == "第一案内所"
    assert (data["facility_building"], data["facility_floor"]) == (1, 2)
    # 2号館の201からは、同じ号館の方へ
    status, data = get(client, "/api/nearest_facility?category=案内所&from_room=201&from_building=2")
    assert status == 200
    assert data["facility_display"] == "第二案内所"
    assert data["facility_building"] == 2


def test_種類が空の設備は表示名が種類になる(client):
    status, data = get(client, "/api/nearest_facility?category=教務課&from_room=101&from_building=1")
    assert status == 200
    assert data["facility_name"] == "201"
    assert data["facility_building"] == 2


def test_登録されていない種類は404(client):
    status, data = get(client, "/api/nearest_facility?category=コンビニ&from_room=101&from_building=1")
    assert status == 404
    assert "登録されていません" in data["error"]


def test_設備の種類を指定しないとエラー(client):
    status, data = get(client, "/api/nearest_facility?from_room=101&from_building=1")
    assert status == 400
    assert "category" in data["error"]


# ------------------------------------------------------------------ イベントモード

def test_イベント一覧(client):
    status, data = get(client, "/api/events")
    assert status == 200
    assert data == [
        {"id": "t1", "title": "たこ焼き", "building": 2, "floor": 1},
        {"id": "", "title": "射的", "building": 0, "floor": 1},
        {"id": "a", "title": "展示A", "building": 1, "floor": 1},
        {"id": "b", "title": "展示B", "building": 1, "floor": 1},
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


def test_イベントはidでも指定できる(client):
    status, data = get(client, f"/api/route?from_event=t1&to_event=b")
    assert status == 200
    assert data["from_event"] == "たこ焼き"
    assert data["to_event"] == "展示B"


def test_通路の展示は左右と何番目かを案内する(client):
    # n1 から n1→n2 の向きに歩く: 展示B は右手、展示A から数えて2番目
    status, data = get(client, f"/api/route?from_node={B1[1]}&to_event=展示B")
    assert status == 200
    assert data["path"][-2:] == [B1[1], B1[2]]
    assert (data["dest_side"], data["dest_position"], data["dest_count"]) == ("right", 2, 2)
    assert data["dest_nearest_display"] == "展示A"
    assert data["dest_display"] == "展示B"


def test_通路の展示を逆向きに歩くと左右と並び順が入れ替わる(client):
    # n4 から来ると n2→n1 の向きに歩く: 右側に書いた展示は左手になり、展示B が手前になる
    status, data = get(client, f"/api/route?from_node={B1[4]}&to_event=展示A")
    assert status == 200
    assert data["path"][-2:] == [B1[2], B1[1]]
    assert (data["dest_side"], data["dest_position"], data["dest_count"]) == ("left", 2, 2)
    assert data["dest_nearest_display"] == "展示B"
    assert data["dest_display"] == "展示A"


def test_教室で場所を指定したイベントは教室の位置を使う(client):
    status, data = get(client, f"/api/route?from_node={B2[1]}&to_event=たこ焼き")
    assert status == 200
    assert data["dest_side"] == "right"
    assert data["dest_display"] == "たこ焼き"


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
