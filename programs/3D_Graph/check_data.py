"""data/ の中身の確認（CI の「データの確認」で動かす）。

スプレッドシートから CSV_Data に Push されたデータに、次のような事故が無いかを調べる。
pytest の実データのテスト（tests/test_real_data.py）は「アプリが起動するか」までしか見ないので、
経路写真の行の消しすぎや重複は、これまで見つけられなかった。

  失敗にするもの（今は1件も無いので、1件でもあれば事故）
    - 経路写真（edge_image.csv）で、同じ区間が2回以上書かれている・id が重複している
    - 経路写真のファイル名が「<from>_to_<to>.jpg」の形になっていない
    - 基準の教室との間で、行き・帰りの経路が引けない教室がある

  比べる相手（--base）より悪くなったら失敗にするもの（今もあるので、増えたときだけ）
    - 写真があった区間の写真が無くなった（行の消しすぎ）
    - ほかとつながっていないノードが増えた

  知らせるだけのもの
    - 写真が無い区間の数（建物ごと）
    - 今の経路に無い区間の写真
    - ほかとつながっていないノード

使い方:
  python check_data.py                         # リポジトリの data/ を調べる
  python check_data.py --base /tmp/base/data   # main の data/ と比べる
  結果は Markdown で標準出力に出す（GITHUB_STEP_SUMMARY があればそこにも書く）。
  失敗にするものがあれば終了コード 1。
"""
import argparse
import csv
import os
import sys
from collections import Counter, defaultdict

import networkx as nx

import ikunavi
from app import app
from ikunavi.cache import get_graph
from ikunavi.config import DATA_DIR_ENV, data_path

# 経路が引けるかを調べるときの基準の教室。無ければ 10号館の最初の教室を使う
BASE_ROOM = ("10101", 10)

# 一覧に出す件数の上限（多すぎると読めないので）
LIST_LIMIT = 30


def _use_data_dir(path):
    if path:
        os.environ[DATA_DIR_ENV] = path
    else:
        os.environ.pop(DATA_DIR_ENV, None)
    ikunavi.clear_all_caches()


def read_edge_image_rows():
    """edge_image.csv の id がある行を [(id, from, to, image_name), ...] で返す（空き行は飛ばす）"""
    path = data_path("edge_image.csv")
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
            if not r.get("id"):
                continue
            rows.append((r["id"], r.get("from", ""), r.get("to", ""), r.get("image_name", "")))
    return rows


def collect(data_dir=None):
    """data_dir（None ならリポジトリの data/）のデータを調べて、結果を dict で返す"""
    _use_data_dir(data_dir)
    try:
        G = get_graph(use_elevator=True)
        client = app.test_client()

        # ── 経路写真の CSV ──
        rows = read_edge_image_rows()
        by_section = defaultdict(list)
        for rid, f, t, _ in rows:
            by_section[(f, t)].append(rid)
        duplicates = {k: v for k, v in by_section.items() if len(v) > 1}
        id_counts = Counter(rid for rid, *_ in rows)
        duplicate_ids = sorted((rid for rid, n in id_counts.items() if n > 1), key=_num)
        bad_names = [(rid, f, t, name) for rid, f, t, name in rows if name != f"{f}_to_{t}.jpg"]

        # ── 写真と経路（グラフ）の照合。アプリが使うのと同じ /api/edge_images で見る ──
        photos = set(client.get("/api/edge_images").get_json() or {})
        edges = {f"{u}_{v}": (u, v) for u, v in G.edges()}
        with_photo = {k for k in edges if k in photos}
        not_in_graph = sorted(photos - set(edges), key=_section_key)
        missing_by_area = Counter()
        total_by_area = Counter()
        for key, (u, v) in edges.items():
            area = _area(G, u, v)
            total_by_area[area] += 1
            if key not in photos:
                missing_by_area[area] += 1

        # ── グラフのつながり ──
        comps = sorted(nx.strongly_connected_components(G), key=len, reverse=True)
        main = comps[0] if comps else set()
        detached = sorted(n for c in comps[1:] for n in c)

        # ── 基準の教室との間で経路が引けるか ──
        rooms = (client.get("/api/all").get_json() or {}).get("rooms", [])
        base = _pick_base_room(rooms)
        unreachable = []
        if base:
            for r in rooms:
                if (r["room"], r["building"]) == (base["room"], base["building"]):
                    continue
                for direction, s, t in (("行き", base, r), ("帰り", r, base)):
                    res = client.get(
                        f"/api/route?from_room={s['room']}&from_building={s['building']}"
                        f"&to_room={t['room']}&to_building={t['building']}")
                    if res.status_code != 200:
                        err = (res.get_json(silent=True) or {}).get("error", f"HTTP {res.status_code}")
                        unreachable.append((r["building"], r["room"], direction, err))

        return {
            "rows": len(rows),
            "duplicates": duplicates,
            "duplicate_ids": duplicate_ids,
            "bad_names": bad_names,
            "edge_keys": set(edges),
            "with_photo": with_photo,
            "not_in_graph": not_in_graph,
            "missing_by_area": missing_by_area,
            "total_by_area": total_by_area,
            "nodes": G.number_of_nodes(),
            "main_size": len(main),
            "detached": detached,
            "rooms": len(rooms),
            "base_room": base,
            "unreachable": unreachable,
        }
    finally:
        _use_data_dir(None)


def _num(s):
    try:
        return (0, int(s))
    except ValueError:
        return (1, s)


def _area(G, u, v):
    """区間の場所（建物番号・屋外・つなぎ）"""
    bu, bv = G.nodes[u].get("building"), G.nodes[v].get("building")
    if bu != bv:
        return "建物と屋外のつなぎ"
    if bu == 0:
        return "屋外"
    return f"{bu}号館"


def _pick_base_room(rooms):
    for r in rooms:
        if (str(r["room"]), r["building"]) == BASE_ROOM:
            return r
    return next((r for r in rooms if r["building"] == BASE_ROOM[1]), rooms[0] if rooms else None)


def _area_key(area):
    return (0, int(area[:-2])) if area.endswith("号館") else (1, area)


def _section_key(key):
    """「<from>_<to>」を数字の順に並べるためのキー"""
    return tuple(_num(x) for x in key.split("_"))


def _section(key):
    return key.replace("_", "→")


def _limited(items):
    items = list(items)
    if len(items) > LIST_LIMIT:
        return items[:LIST_LIMIT] + [f"…ほか {len(items) - LIST_LIMIT} 件"]
    return items


def judge(cur, base=None):
    """(失敗の一覧, 知らせるだけの一覧) を Markdown の行のリストで返す"""
    errors, notes = [], []

    if cur["duplicates"]:
        errors.append(f"### 経路写真で、同じ区間が2回以上書かれている（{len(cur['duplicates'])} 区間）")
        errors.append("どれか1行だけ残して、ほかの行を消す。")
        errors.append("")
        errors.append("| 区間（from→to） | 行の id |")
        errors.append("|---|---|")
        for (f, t), ids in sorted(cur["duplicates"].items(), key=lambda kv: (_num(kv[0][0]), _num(kv[0][1])))[:LIST_LIMIT]:
            errors.append(f"| {f}→{t} | {', '.join(ids)} |")
        if len(cur["duplicates"]) > LIST_LIMIT:
            errors.append(f"| …ほか {len(cur['duplicates']) - LIST_LIMIT} 区間 | |")
        errors.append("")
    if cur["duplicate_ids"]:
        errors.append(f"### 経路写真で、同じ id の行が2つ以上ある（{len(cur['duplicate_ids'])} 件）")
        errors.append("")
        errors.append(", ".join(_limited(cur["duplicate_ids"])))
        errors.append("")
    if cur["bad_names"]:
        errors.append(f"### 経路写真のファイル名が「<from>_to_<to>.jpg」になっていない（{len(cur['bad_names'])} 行）")
        errors.append("")
        errors.append("| id | from | to | image_name |")
        errors.append("|---|---|---|---|")
        for rid, f, t, name in cur["bad_names"][:LIST_LIMIT]:
            errors.append(f"| {rid} | {f} | {t} | {name} |")
        errors.append("")
    if cur["unreachable"]:
        b = cur["base_room"]
        errors.append(f"### 基準の教室（{b['building']}号館 {b['room']}）との間で経路が引けない（{len(cur['unreachable'])} 件）")
        errors.append("")
        errors.append("| 建物 | 教室 | 向き | エラー |")
        errors.append("|---|---|---|---|")
        for bld, room, direction, err in cur["unreachable"][:LIST_LIMIT]:
            errors.append(f"| {bld} | {room} | 基準から{direction} | {err} |")
        errors.append("")

    if base is not None:
        lost = sorted(base["with_photo"] - cur["with_photo"], key=_section_key)
        # 区間そのものが経路から無くなったものは「写真が消えた」に数えない
        lost = [k for k in lost if k in cur["edge_keys"]]
        if lost:
            errors.append(f"### main では写真があった区間の写真が無くなった（{len(lost)} 区間）")
            errors.append("edge_image.csv の行を消しすぎていないか確認する。")
            errors.append("")
            errors.append(", ".join(_limited(_section(k) for k in lost)))
            errors.append("")
        new_detached = sorted(set(cur["detached"]) - set(base["detached"]))
        if new_detached:
            errors.append(f"### ほかとつながっていないノードが増えた（{len(new_detached)} 個）")
            errors.append("エッジの書き忘れや、ノードの消し忘れが無いか確認する。")
            errors.append("")
            errors.append(", ".join(_limited(str(n) for n in new_detached)))
            errors.append("")

    # ── 知らせるだけ ──
    missing = cur["missing_by_area"]
    notes.append(f"### 写真が無い区間（向き別。全 {sum(cur['total_by_area'].values())} 区間のうち {sum(missing.values())}）")
    notes.append("")
    notes.append("| 場所 | 写真が無い / 全区間 |" + (" main との差 |" if base is not None else ""))
    notes.append("|---|---|" + ("---|" if base is not None else ""))
    for area in sorted(cur["total_by_area"], key=_area_key):
        line = f"| {area} | {missing[area]} / {cur['total_by_area'][area]} |"
        if base is not None:
            diff = missing[area] - base["missing_by_area"][area]
            line += f" {diff:+d} |" if diff else " |"
        notes.append(line)
    notes.append("")
    if cur["not_in_graph"]:
        notes.append(f"### 今の経路に無い区間の写真（{len(cur['not_in_graph'])} 件。ナビでは使われない）")
        notes.append("")
        notes.append(", ".join(_limited(_section(k) for k in cur["not_in_graph"])))
        notes.append("")
    if cur["detached"]:
        notes.append(f"### ほかとつながっていないノード（{len(cur['detached'])} 個。全 {cur['nodes']} 個のうち、"
                     f"一番大きなまとまりは {cur['main_size']} 個）")
        notes.append("")
        notes.append(", ".join(_limited(str(n) for n in cur["detached"])))
        notes.append("")
    return errors, notes


def report(cur, base=None):
    errors, notes = judge(cur, base)
    lines = ["## データの確認", ""]
    b = cur["base_room"]
    summary = (f"教室 {cur['rooms']} 室・ノード {cur['nodes']} 個・経路写真の行 {cur['rows']} 行を調べた"
               + (f"（経路は {b['building']}号館 {b['room']} との行き・帰りで確認）" if b else ""))
    lines.append(summary + ("。main のデータと比べた。" if base is not None else "。"))
    lines.append("")
    if errors:
        lines.append("## ❌ 直す必要があるもの")
        lines.append("")
        lines += errors
    else:
        lines.append("✅ 直す必要があるものはありません。")
        lines.append("")
    lines.append("## 知らせるだけのもの（今までもあったもの）")
    lines.append("")
    lines += notes
    return "\n".join(lines), bool(errors)


def main(argv=None):
    parser = argparse.ArgumentParser(description="data/ の中身を確認する")
    parser.add_argument("--data", help="調べる data/ のパス（省略するとリポジトリの data/）")
    parser.add_argument("--base", help="比べる相手の data/ のパス（main のデータなど）")
    args = parser.parse_args(argv)

    cur = collect(args.data)
    base = collect(args.base) if args.base and os.path.isdir(args.base) else None
    text, failed = report(cur, base)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
