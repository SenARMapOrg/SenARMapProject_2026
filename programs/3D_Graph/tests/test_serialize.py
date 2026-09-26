"""レスポンス整形: 経路のノード列・区間列と、目的地の左右・順番の判定"""
from tiny_campus import B1
from ikunavi.cache import get_graph
from ikunavi.serialize import apply_dest_info, dest_info, path_result, side_for_room


def test_経路のノード列と区間列が対応する(tiny_campus):
    G = get_graph()
    result = path_result(G, [B1[1], B1[2], B1[3]], 14.0)
    assert len(result["path_coords"]) == 3
    assert len(result["path_edges"]) == 2
    assert result["total_weight"] == 14.0


def test_区間には表示名と生の名前の両方が入る(tiny_campus):
    G = get_graph()
    result = path_result(G, [B1[1], B1[2]], 10.0)
    edge = result["path_edges"][0]
    assert edge["name"] == "101;102"          # 生の名前は照合用にそのまま残す
    assert edge["name_display"] == "ゼミ101"  # 表示名は先頭要素だけ
    assert edge["right_display"] == "ゼミ101"


def test_ノードのSVG座標と緯度経度は持っているものだけ載る(tiny_campus):
    G = get_graph()
    coords = path_result(G, [B1[1]], 0.0)["path_coords"][0]
    assert coords["svg_x"] == 100.0
    assert "lat" not in coords    # 1号館の屋内ノードは緯度経度を持たない


def test_左右は進行方向に補正済みの区間から判定する(tiny_campus):
    G = get_graph()
    # n1→n2 に進むと 101 は右、n2→n1 に進むと 101 は左
    assert side_for_room(G.edges[B1[1], B1[2]], "101") == "right"
    assert side_for_room(G.edges[B1[2], B1[1]], "101") == "left"


def test_どちらにも無い名前は空文字(tiny_campus):
    G = get_graph()
    assert side_for_room(G.edges[B1[1], B1[2]], "999") == ""
    assert side_for_room(None, "101") == ""
    assert side_for_room(G.edges[B1[1], B1[2]], "") == ""


def test_目的地の左右と手前からの順番を返す(tiny_campus):
    G = get_graph()
    result = path_result(G, [B1[2], B1[1]], 10.0)   # n2→n1 の向きで到着
    info = dest_info(result, "101")
    assert info["side"] == "left"
    assert info["position"] == 1
    assert info["count"] == 1
    assert info["dest_display"] == "ゼミ101"
    assert info["nearest_display"] == "ゼミ101"


def test_一致しない目的地は空の情報になる(tiny_campus):
    G = get_graph()
    result = path_result(G, [B1[1], B1[2]], 10.0)
    info = dest_info(result, "999")
    assert info == {"side": "", "position": None, "count": None,
                    "nearest_display": None, "dest_display": None}


def test_dest情報はレスポンスのフィールドとして書き込まれる(tiny_campus):
    G = get_graph()
    result = path_result(G, [B1[2], B1[1]], 10.0)
    apply_dest_info(result, "101")
    assert result["dest_side"] == "left"
    assert result["dest_position"] == 1
    assert result["dest_count"] == 1
    assert result["dest_display"] == "ゼミ101"
