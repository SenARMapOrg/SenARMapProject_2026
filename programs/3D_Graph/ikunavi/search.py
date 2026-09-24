"""出発地・目的地の「候補ノード」への解決と、その総当たりによる最短経路探索。

教室・トイレ・食堂・イベントはいずれもノードではなくエッジ（または複数ノード）に
紐づくため、候補ノードを列挙して全組み合わせでDijkstraを回し、最短のものを採る。
"""
import networkx as nx


def candidates_from_edges(G, edge_rows, dedupe=False):
    """エッジ行のリスト → [(node_id, edge行), ...]（両端点。グラフに無いノードは除く）"""
    seen, result = set(), []
    for row in edge_rows:
        for nid in (int(row["from"]), int(row["to"])):
            if nid not in G.nodes:
                continue
            if dedupe:
                if nid in seen:
                    continue
                seen.add(nid)
            result.append((nid, row))
    return result


def candidates_from_event(G, event_candidates):
    """イベント索引の候補 → グラフ上に存在するノードだけの [(node_id, edge行|None), ...]"""
    seen, result = set(), []
    for nid, row in event_candidates:
        if nid in G.nodes and nid not in seen:
            seen.add(nid)
            result.append((nid, row))
    return result


def extend_to_far_endpoint(G, path, length, dest_edge_row):
    """
    目的地がエッジ（教室・トイレ・食堂）の場合、最寄り端点で止めず、
    そのエッジのもう一方の端点まで経路を延長する。
    教室はエッジ区間に面しているため、区間そのものを歩かせることで
    必ずドアの前を通る案内になる。
    直前ノードが反対側端点（＝既に目的エッジを歩いて到着）の場合は延長しない。
    """
    if dest_edge_row is None or not path:
        return path, length
    u, v = int(dest_edge_row["from"]), int(dest_edge_row["to"])
    last = path[-1]
    far = v if last == u else u if last == v else None
    if far is None:
        return path, length
    if len(path) >= 2 and path[-2] == far:
        return path, length
    if not G.has_edge(last, far):
        return path, length
    return path + [far], length + G.edges[last, far].get("weight", 0.0)


def best_route(G, start_candidates, dest_candidates, allow_same_node=True):
    """
    出発候補×目的候補の全組み合わせでDijkstraを実行し、最短経路を採用する。

    allow_same_node=False のときは出発と目的が同一ノードの組み合わせをスキップする
    （最寄りトイレ・食堂検索では、出発点自体が目的地そのものである場合を
    経路として扱わないため）。

    戻り値: (best_path|None, best_length, best_start_row, best_dest_row)
    """
    best_path, best_length = None, float("inf")
    best_start_row = best_dest_row = None
    for (s_node, s_row) in start_candidates:
        for (d_node, d_row) in dest_candidates:
            if s_node == d_node:
                if not allow_same_node:
                    continue
                # 出発と目的が同一ノードを共有する場合は距離0の自明な経路
                length, path = 0.0, [s_node]
            else:
                try:
                    length, path = nx.bidirectional_dijkstra(G, s_node, d_node, weight="weight")
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    continue
            if length < best_length:
                best_length, best_path = length, path
                best_start_row, best_dest_row = s_row, d_row
    return best_path, best_length, best_start_row, best_dest_row
