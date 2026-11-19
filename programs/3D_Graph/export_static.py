"""経路探索APIのデータを、静的なJSONファイルとして書き出す。

Cloudflare Pages のビルド（deploy_env/pages/build.sh）で実行し、programs/html/data/ に置く。
画面はサーバー（api.iku-navi.net）を通さず、Pages から直接このファイルを読める。
静的なファイルの配信は Pages では無料・無制限で、Pages Functions の回数の枠も使わない。

書き出すものは2種類（docs/static_data.md）:

1. 「読むだけ」の API の返事そのもの（EXPORTS）。Flask のアプリをそのまま動かし、テスト用の
   クライアントで各 API を呼んだ結果をそのまま保存する（計算の仕組みを2つ持たない）。
2. 経路計算用のデータ（data/route_data.json）。JS の経路計算（programs/html/shared/route-core.mjs）が読む。
   CSV の読み込み・座標の変換・イベントの場所の解決までは Python（ikunavi）で済ませ、
   その結果（ノード・エッジ・表示名・イベントの索引など）を並び順もそのまま書き出す。
   並び順は、同じ長さの経路が複数あるときにどれを選ぶかに関わるので、変えてはいけない。

使い方: python programs/3D_Graph/export_static.py [--out programs/html]
"""
import argparse
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ikunavi import cache, create_app, naming  # noqa: E402

# 書き出すファイル名 → 元になる API
EXPORTS = {
    "graph.json": "/api/graph",
    "all.json": "/api/all",
    "edge_images.json": "/api/edge_images",
    "events.json": "/api/events",
    "cafeterias.json": "/api/cafeterias",
    "facilities.json": "/api/facilities",
}

ROUTE_DATA_FILE = "route_data.json"
ROUTE_DATA_VERSION = 1


def _num(value):
    """数値。欠損（NaN）は null にする（JSON に NaN は書けない。JS 側で NaN に戻す）"""
    value = float(value)
    return None if math.isnan(value) else value


def _present(row, col):
    return col in row and row[col] == row[col]   # NaN でない


def build_route_data():
    """JS の経路計算に渡すデータ（ikunavi の get_data・索引をそのまま並べたもの）"""
    nodes_df, edges_df = cache.get_data()

    nodes = []
    for _, row in nodes_df.iterrows():
        node = {
            "id": int(row["id"]),
            "x": _num(row["x"]), "y": _num(row["y"]), "z": _num(row["z"]),
            "building": int(row["building"]),
            "floor": int(row["floor"]),
            "type": int(row["type"]),
        }
        # graph.py の _node_attrs と同じ条件で持たせる
        if _present(row, "lat"):
            node["lat"] = _num(row["lat"])
        if _present(row, "lng"):
            node["lng"] = _num(row["lng"])
        if _present(row, "svg_x"):
            node["svg_x"] = _num(row["svg_x"])
            node["svg_y"] = _num(row["svg_y"])
        nodes.append(node)

    # edges_df の行ラベル → 並び順（イベントの索引がエッジ行を指すのに使う）
    position = {label: i for i, label in enumerate(edges_df.index)}
    edges = []
    for _, row in edges_df.iterrows():
        edges.append({
            "id": int(row["id"]),
            "name": str(row["name"]),
            "right": str(row.get("right", "")),
            "left": str(row.get("left", "")),
            "from": int(row["from"]),
            "to": int(row["to"]),
            "building": int(row["building"]),
            "floor": int(row["floor"]),
            "weight": _num(row["weight"]),
            "length": _num(row["length"]),
            "type": str(row["type"]),
        })

    def edge_ref(row):
        return None if row is None else position[row.name]

    event_index, _ = cache.get_event_index()
    cache.find_event_place("", 0)   # _event_extra を作らせる
    extra = cache._event_extra
    events = {
        "index": [[title, [[int(nid), edge_ref(row)] for nid, row in cands]]
                  for title, cands in event_index.items()],
        "places": [[title, gid, place] for title, places in extra["places"].items()
                   for gid, place in places.items()],
        "lineups": [[gid, side, titles] for (gid, side), titles in extra["lineups"].items()],
        "ids": [[event_id, title] for event_id, title in extra["ids"].items()],
    }

    name_map = naming.get_name_map()
    return {
        "version": ROUTE_DATA_VERSION,
        "nodes": nodes,
        "edges": edges,
        "names": [[building, name, display] for (building, name), display in name_map.items()],
        "events": events,
        "cafeteria_names": cache.get_cafeteria_names(),
        "facilities": cache.get_facility_list(),
    }


def export(out_dir):
    """out_dir/data/ に JSON を書き出し、書いたファイルのパスを返す"""
    data_dir = Path(out_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    client = create_app().test_client()
    written = []
    for name, url in EXPORTS.items():
        res = client.get(url)
        if res.status_code != 200:
            raise RuntimeError(f"{url} が {res.status_code} を返しました: {res.get_data(as_text=True)[:200]}")
        path = data_dir / name
        path.write_bytes(res.get_data())
        written.append(path)

    path = data_dir / ROUTE_DATA_FILE
    path.write_text(json.dumps(build_route_data(), ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    encoding="utf-8")
    written.append(path)
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(HERE.parents[1] / "programs" / "html"),
                    help="サイトの出力先（この下の data/ に書く）")
    args = ap.parse_args()
    for path in export(args.out):
        print(f"[export] {path} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
