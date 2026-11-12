"""JS の経路計算（programs/html/shared/route-core.mjs）が、Python の経路探索API とまったく同じ答えを返すかを確かめる。

同じ問い合わせを、Flask のアプリ（テスト用のクライアント）と JS（node で route_js_runner.mjs を動かす）の
両方に投げ、ステータスと JSON の中身を1件ずつ比べる。経路・距離・表示名・左右・エラーの文言まで、
1か所でも違えば「違う」とする。

  python programs/3D_Graph/route_js_check.py           # CI と同じ量（数千件。1〜2分）
  python programs/3D_Graph/route_js_check.py --full    # 全教室の組み合わせ×3条件（時間がかかる）

CI では tests/test_route_js.py がこれを呼ぶ。必要なもの: node（v18 以上）。
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import export_static  # noqa: E402
from ikunavi import create_app  # noqa: E402

RUNNER = HERE / "route_js_runner.mjs"
# 経路の条件（なし・エレベーターを使わない・階段とエスカレーターを使わない）
CONDITIONS = [{}, {"use_elevator": "0"}, {"step_free": "1"}]
REFERENCE_ROOM = ("10101", 10)   # check_data.py と同じ基準の教室
CHUNK = 3000


def _q(path, **params):
    return {"path": path, "query": urlencode({k: v for k, v in params.items() if v is not None})}


def build_queries(client, full=False, seed=20261112):
    """問い合わせの一覧。full なら全教室の組み合わせ、そうでなければ偏りなく選んだ一部"""
    all_ = client.get("/api/all").get_json()
    rooms = [(r["room"], r["building"]) for r in all_["rooms"]]
    nodes = [n["id"] for n in all_["nodes"]]
    graph = client.get("/api/graph").get_json()
    edge_ids = [e["id"] for e in graph["edges"]]
    events = client.get("/api/events").get_json()
    facilities = client.get("/api/facilities").get_json()
    cafeterias = client.get("/api/cafeterias").get_json()
    rng = random.Random(seed)
    ref = REFERENCE_ROOM if REFERENCE_ROOM in rooms else rooms[0]

    queries = []

    def route(cond, **params):
        queries.append(_q("/api/route", **params, **cond))

    for cond in CONDITIONS:
        # 教室 → 教室
        if full:
            pairs = [(a, b) for a in rooms for b in rooms if a != b]
        else:
            pairs = [(r, ref) for r in rooms] + [(ref, r) for r in rooms]
            pairs += [tuple(rng.sample(rooms, 2)) for _ in range(800)]
        for (fr, fb), (tr, tb) in pairs:
            route(cond, from_room=fr, from_building=fb, to_room=tr, to_building=tb)

        # 同じ教室どうし・ノード・エッジ・イベント
        for r, b in rng.sample(rooms, min(30, len(rooms))):
            route(cond, from_room=r, from_building=b, to_room=r, to_building=b)
        for n in rng.sample(nodes, min(150, len(nodes))):
            route(cond, from_node=n, to_room=ref[0], to_building=ref[1])
            route(cond, from_room=ref[0], from_building=ref[1], to_node=n)
        for e in rng.sample(edge_ids, min(150, len(edge_ids))):
            route(cond, from_edge=e, to_room=ref[0], to_building=ref[1])
            route(cond, from_room=ref[0], from_building=ref[1], to_edge=e)
        for ev in events:
            route(cond, from_room=ref[0], from_building=ref[1], to_event=ev["title"])
            route(cond, from_event=ev["title"], to_room=ref[0], to_building=ref[1])
            if ev["id"]:
                route(cond, from_room=ref[0], from_building=ref[1], to_event=ev["id"])
        for a, b in [tuple(rng.sample(nodes, 2)) for _ in range(150)]:
            queries.append(_q("/api/shortest_path", start=a, goal=b, **cond))

        # 最寄りのトイレ・食堂・設備
        starts = rooms if full else rng.sample(rooms, min(25, len(rooms)))
        for r, b in starts:
            for t in ("all", "M", "F", "C"):
                queries.append(_q("/api/nearest_toilet", from_room=r, from_building=b, type=t, **cond))
            queries.append(_q("/api/nearest_cafeteria", from_room=r, from_building=b, **cond))
            for c in cafeterias[:1]:
                queries.append(_q("/api/nearest_cafeteria", from_room=r, from_building=b, name=c["name"], **cond))
            for cat in dict.fromkeys(f["category"] for f in facilities):
                queries.append(_q("/api/nearest_facility", from_room=r, from_building=b, category=cat, **cond))
        for ev in events[:10]:
            queries.append(_q("/api/nearest_toilet", from_event=ev["title"], **cond))

    # 引数の誤り・見つからないとき（エラーの文言とステータスも同じにする）
    some_room, some_b = rooms[0]
    queries += [
        _q("/api/route"),
        _q("/api/route", from_room=some_room, from_building=some_b),
        _q("/api/route", from_room=some_room, to_room=some_room, to_building=some_b),
        _q("/api/route", from_room=some_room, from_building=some_b, to_room=some_room),
        _q("/api/route", from_room="存在しない教室", from_building=some_b, to_room=some_room, to_building=some_b),
        _q("/api/route", from_room=some_room, from_building=some_b, to_room="存在しない教室", to_building=some_b),
        _q("/api/route", from_node=1, to_room=some_room, to_building=some_b),
        _q("/api/route", from_node="abc", to_room=some_room, to_building=some_b),
        _q("/api/route", from_room=some_room, from_building=some_b, to_node=1),
        _q("/api/route", from_edge=1, to_room=some_room, to_building=some_b),
        _q("/api/route", from_room=some_room, from_building=some_b, to_edge=1),
        _q("/api/route", from_event="存在しないイベント", to_room=some_room, to_building=some_b),
        _q("/api/route", from_room=some_room, from_building=some_b, to_event="存在しないイベント"),
        _q("/api/route", from_room=f"  {some_room}  ", from_building=f" {some_b} ", to_room=ref[0], to_building=ref[1]),
        _q("/api/route", from_room=some_room, from_building=some_b, to_room=ref[0], to_building=ref[1], use_elevator=""),
        _q("/api/shortest_path"),
        _q("/api/shortest_path", start=nodes[0], goal=1),
        _q("/api/nearest_toilet"),
        _q("/api/nearest_toilet", from_room=some_room, from_building=some_b, type="x"),
        _q("/api/nearest_cafeteria", from_room=some_room, from_building=some_b, name="存在しない食堂"),
        _q("/api/nearest_facility", from_room=some_room, from_building=some_b),
        _q("/api/nearest_facility", from_room=some_room, from_building=some_b, category="存在しない設備"),
    ]
    return queries


def _expected(client, queries):
    out = []
    for q in queries:
        res = client.get(f"{q['path']}?{q['query']}")
        out.append({"status": res.status_code, "body": json.loads(res.get_data())})
    return out


def _run_js(data_path, queries, workdir):
    qpath, apath = Path(workdir) / "queries.json", Path(workdir) / "answers.json"
    qpath.write_text(json.dumps(queries, ensure_ascii=False), encoding="utf-8")
    subprocess.run(["node", str(RUNNER), str(data_path), str(qpath), str(apath)], check=True)
    return json.loads(apath.read_text(encoding="utf-8"))


def _first_difference(a, b, where="body"):
    """2つの JSON の最初の違い（どこが・どう違うか）。同じなら None"""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{where}.{k}: Python={'(無し)' if k not in a else repr(a[k])[:120]} / JS={'(無し)' if k not in b else repr(b[k])[:120]}"
            d = _first_difference(a[k], b[k], f"{where}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{where}: 長さ Python={len(a)} / JS={len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _first_difference(x, y, f"{where}[{i}]")
            if d:
                return d
        return None
    if isinstance(a, bool) or isinstance(b, bool):
        return None if a is b else f"{where}: Python={a!r} / JS={b!r}"
    return None if a == b else f"{where}: Python={a!r} / JS={b!r}"


def check(full=False, data_dir=None, progress=print):
    """違いの一覧 [(問い合わせ, 違い), ...] と件数を返す。違いが無ければ空リスト"""
    if shutil.which("node") is None:
        raise RuntimeError("node が見つかりません（JS の経路計算を動かすのに必要です）")
    client = create_app().test_client()
    queries = build_queries(client, full=full)
    progress(f"[route-js] 問い合わせ {len(queries):,} 件")
    mismatches = []
    with tempfile.TemporaryDirectory() as tmp:
        data_path = Path(tmp) / export_static.ROUTE_DATA_FILE
        data_path.write_text(json.dumps(export_static.build_route_data(), ensure_ascii=False, allow_nan=False),
                             encoding="utf-8")
        for start in range(0, len(queries), CHUNK):
            chunk = queries[start:start + CHUNK]
            expected = _expected(client, chunk)
            actual = _run_js(data_path, chunk, tmp)
            for q, exp, act in zip(chunk, expected, actual):
                diff = (f"status: Python={exp['status']} / JS={act['status']}"
                        if exp["status"] != act["status"] else _first_difference(exp["body"], act["body"]))
                if diff:
                    mismatches.append((f"{q['path']}?{q['query']}", diff))
            progress(f"[route-js] {min(start + CHUNK, len(queries)):,} / {len(queries):,} 件（違い {len(mismatches)} 件）")
    return mismatches, len(queries)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="全教室の組み合わせで確かめる（時間がかかる）")
    args = ap.parse_args()
    mismatches, total = check(full=args.full)
    for query, diff in mismatches[:30]:
        print(f"違い: {query}\n  {diff}")
    if mismatches:
        print(f"[route-js] {total:,} 件中 {len(mismatches):,} 件で Python と JS の答えが違います")
        sys.exit(1)
    print(f"[route-js] {total:,} 件すべて Python と JS の答えが同じでした")


if __name__ == "__main__":
    main()
