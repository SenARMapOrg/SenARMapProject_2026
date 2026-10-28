"""data/event.csv から、イベントごとのナビのURL（navi/?to_event=<id>）の一覧を Markdown で書き出す。

    python3 event_urls.py                 # docs/event_urls.md に書き出す
    python3 event_urls.py --out -         # 画面に出す

event.csv を変えたら実行し直す。URL は id で書くので、展示名を直しても変わらない。
"""
import argparse
import csv
import os
import sys

BASE_URL = "https://iku-navi.net/navi/?to_event="
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))


def load_events(path):
    """[(id, title, 号館, 場所の説明)]。同じ title の行は1つにまとめる"""
    events = {}
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            title = (row.get("title") or "").strip()
            if not title:
                continue
            ev = events.setdefault(title, {"id": "", "building": (row.get("building") or "").strip(), "places": []})
            ev["id"] = ev["id"] or (row.get("id") or "").strip()
            room, node, edge = (row.get(c, "").strip() for c in ("room", "node_id", "edge_id"))
            if room:
                ev["places"].append(room)
            elif edge:
                ev["places"].append(f"エッジ{edge}")
            elif node:
                ev["places"].append(f"ノード{node}")
    return [(ev["id"], title, ev["building"], "・".join(ev["places"])) for title, ev in events.items()]


def building_label(b):
    return "屋外" if b in ("", "0") else f"{b}号館"


def render(events):
    lines = [
        "# イベントのナビURL一覧",
        "",
        "`data/event.csv` から `programs/3D_Graph/event_urls.py` で書き出したもの。手で直さず、event.csv を変えたら実行し直す。",
        "URL を開くと、目的地にその展示が入った状態でナビが開く（イベントモードも自動で有効）。",
        "場所が「未設定」のイベントは、event.csv に場所を入れるまでURLを開いても目的地に入らない。",
        "",
        "## まとめてコピーする（名前,URL）",
        "",
        "```",
    ]
    lines += [f"{title},{BASE_URL}{eid}" for eid, title, _, _ in events if eid]
    lines += ["```", "", "## 一覧", "", "| id | 名前 | 号館 | 場所 | URL |", "|---|---|---|---|---|"]
    for eid, title, b, places in events:
        url = f"{BASE_URL}{eid}" if eid else "（id が無い）"
        lines.append(f"| {eid} | {title.replace('|', '｜')} | {building_label(b)} | {places or '未設定'} | {url} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=os.path.join(ROOT, "data", "event.csv"))
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "event_urls.md"), help="- なら画面に出す")
    args = ap.parse_args()
    text = render(load_events(args.data))
    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"{args.out} に書き出しました")


if __name__ == "__main__":
    main()
