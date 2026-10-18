"""探索結果とCSV行を、APIレスポンス用のdictに整形する。

「どちら側にあるか」「手前から何番目か」といった案内文言のもとになる情報も
ここで組み立てる。左右は進行方向に補正済みのエッジ属性からしか判定しないこと。
"""
from .cache import event_lineup, find_event_place, get_node_xyz
from .naming import first_display_label


def edge_to_dict(row):
    """edgeの行を座標付きdictに変換するヘルパー"""
    node_xyz = get_node_xyz()
    x0, y0, z0 = node_xyz[int(row["from"])]
    x1, y1, z1 = node_xyz[int(row["to"])]
    return {
        "id":       int(row["id"]),
        "name":     str(row["name"]),
        "right":    str(row.get("right", "")),
        "left":     str(row.get("left", "")),
        "from":     int(row["from"]),
        "to":       int(row["to"]),
        "building": int(row["building"]),
        "floor":    int(row["floor"]),
        "weight":   float(row["weight"]),
        "length":   float(row["length"]),
        "type":     str(row["type"]),
        "x0": x0, "y0": y0, "z0": z0,
        "x1": x1, "y1": y1, "z1": z1,
    }


def path_result(G, path, length):
    """Dijkstraの結果をJSON用dictに整形するヘルパー"""
    path_coords = []
    for node_id in path:
        n = G.nodes[node_id]
        coord_dict = {"id": node_id, "x": n["x"], "y": n["y"], "z": n["z"],
                      "building": n["building"], "floor": n["floor"]}
        if "lat" in n:
            coord_dict["lat"] = n["lat"]
        if "lng" in n:
            coord_dict["lng"] = n["lng"]
        if "svg_x" in n and n["svg_x"] == n["svg_x"]:  # NaN check
            coord_dict["svg_x"] = n["svg_x"]
            coord_dict["svg_y"] = n["svg_y"]
        path_coords.append(coord_dict)

    path_edges = []
    for u, v in zip(path, path[1:]):
        edata = G.edges[u, v]
        n0, n1 = G.nodes[u], G.nodes[v]
        building = edata.get("building")
        name, right, left = edata.get("name", ""), edata.get("right", ""), edata.get("left", "")
        path_edges.append({
            "from": u, "to": v,
            "name":   name,
            "right":  right,
            "left":   left,
            # 読み上げ用の表示名（先頭要素のみ、トイレ等の内部コードも日本語表記に変換済み）。
            # 生の name/right/left はそのままエッジ照合用に残す。
            "name_display":  first_display_label(building, name),
            "right_display": first_display_label(building, right),
            "left_display":  first_display_label(building, left),
            "length": edata.get("length", 0),
            "type":   edata.get("edge_type", "1"),
            "x0": n0["x"], "y0": n0["y"], "z0": n0["z"],
            "x1": n1["x"], "y1": n1["y"], "z1": n1["z"],
        })
    return {"path": path, "total_weight": length,
            "path_coords": path_coords, "path_edges": path_edges}


def _split_names(raw):
    """";"区切りの名前列を、空要素を落としたリストにする"""
    return [n.strip() for n in str(raw or "").split(";") if n.strip()]


def side_for_room(edge_like, room_name):
    """
    edge_like（"right"/"left"キーを持つdict、またはCSV行のように.get()できるもの）を見て、
    room_nameがどちら側にあるかを "right"/"left" で返す。
    right/leftは";"区切りで複数名を持ちうるため、個別の名前として厳密一致で照合する。
    どちらにも無い・room_name未指定・edge_like無しの場合は ""（呼び出し側でフォールバック表示）。

    注意: 必ず「実際に歩く向き」に補正済みのright/left（build_graphが逆方向エッジ用に
    入れ替え済みのもの。例えば path_result() が返す path_edges の各要素）を渡すこと。
    edge.csvの生の行（from→to方向のright/leftのみを持つ）を渡すと、経路がCSVのfrom/toと
    逆向きに通る場合に左右が逆の結果になる。
    """
    if edge_like is None or not room_name:
        return ""
    room_name = str(room_name).strip()
    if room_name in _split_names(edge_like.get("right", "")):
        return "right"
    if room_name in _split_names(edge_like.get("left", "")):
        return "left"
    return ""


_EMPTY_DEST_INFO = {"side": "", "position": None, "count": None,
                    "nearest_display": None, "dest_display": None}


def dest_info(result, room_name):
    """
    path_result() が返した result["path_edges"] の最終区間（実際に歩く向きに補正済み）を見て、
    room_nameの左右・手前から数えた順番を判定する。API各エンドポイントの dest_side 等は
    これ経由で計算すること（edge.csvの生の行を直接 side_for_room に渡さない）。

    right/leftは";"区切りで手前から奥への物理的な並び順を持つ列（edge.csvの想定通り）なので、
    その並び順の中でroom_nameが何番目かがそのまま「手前から数えてN番目」になる。

    戻り値:
      side: "right"/"left"/""（どちらにも一致しなければ""）
      position: 1始まりの順位（一致しなければNone）
      count: その側にある教室の総数（一致しなければNone）
      nearest_display: 一番手前（先頭）の教室の表示名（一致しなければNone）
      dest_display: room_name自体の表示名（一致しなければNone）
    """
    edges = result.get("path_edges") or []
    if not edges or not room_name:
        return dict(_EMPTY_DEST_INFO)
    last = edges[-1]
    room_name = str(room_name).strip()
    coords = result.get("path_coords") or []
    building = coords[-1].get("building") if coords else None

    for side in ("right", "left"):
        names = _split_names(last.get(side, ""))
        if room_name in names:
            return {
                "side": side,
                "position": names.index(room_name) + 1,
                "count": len(names),
                "nearest_display": first_display_label(building, names[0]),
                "dest_display": first_display_label(building, room_name),
            }
    return dict(_EMPTY_DEST_INFO)


def apply_dest_info(result, room_name):
    """dest_info()の結果をresultのdest_*フィールドとして書き込む共通処理"""
    info = dest_info(result, room_name)
    result["dest_side"] = info["side"]
    result["dest_position"] = info["position"]
    result["dest_count"] = info["count"]
    result["dest_nearest_display"] = info["nearest_display"]
    result["dest_display"] = info["dest_display"]


_OTHER_SIDE = {"right": "left", "left": "right"}


def event_dest_info(result, title, dest_edge_row):
    """
    イベント（event.csv）を目的地にしたときの dest_info()。最終区間（目的のエッジ）のどちら側の何番目かを返す。
      - 教室名で場所を指定したイベントは、その教室の位置をそのまま使い、名前だけイベント名にする
      - エッジIDで場所を指定し side・position を書いたイベントは、同じエッジの同じ側に並ぶ展示どうしで数える
        （「たこ焼きは右手、射的から数えて2番目です」）。side・position は edge.csv の from→to の向きの値なので、
        逆向きに歩くときは左右と並び順を入れ替える
    """
    edges = result.get("path_edges") or []
    if not edges or dest_edge_row is None:
        return dict(_EMPTY_DEST_INFO)
    last = edges[-1]
    u, v = int(dest_edge_row["from"]), int(dest_edge_row["to"])
    if {int(last["from"]), int(last["to"])} != {u, v}:
        return dict(_EMPTY_DEST_INFO)
    place = find_event_place(title, dest_edge_row["id"])
    if not place:
        return dict(_EMPTY_DEST_INFO)

    if place.get("room"):
        info = dest_info(result, place["room"])
        if info["side"]:
            info["dest_display"] = title
        return info

    side = place.get("side")
    if side not in _OTHER_SIDE:
        return dict(_EMPTY_DEST_INFO)
    forward = int(last["from"]) == u
    walk_side = side if forward else _OTHER_SIDE[side]
    lineup = event_lineup(dest_edge_row["id"], side)
    if not forward:
        lineup = lineup[::-1]
    if place.get("position") is None or title not in lineup:
        return {"side": walk_side, "position": None, "count": None,
                "nearest_display": None, "dest_display": title}
    return {
        "side": walk_side,
        "position": lineup.index(title) + 1,
        "count": len(lineup),
        "nearest_display": lineup[0],
        "dest_display": title,
    }


def apply_event_dest_info(result, title, dest_edge_row):
    """event_dest_info() の結果を result の dest_* フィールドとして書き込む（apply_dest_info と同じ形）"""
    info = event_dest_info(result, title, dest_edge_row)
    result["dest_side"] = info["side"]
    result["dest_position"] = info["position"]
    result["dest_count"] = info["count"]
    result["dest_nearest_display"] = info["nearest_display"]
    result["dest_display"] = info["dest_display"]
