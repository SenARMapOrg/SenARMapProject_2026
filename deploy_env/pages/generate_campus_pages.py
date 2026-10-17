"""建物ごとの「教室一覧・フロアマップ」ページ（/campus/）と sitemap.xml を、data/ から作る。

「専修大学 10号館 フロアマップ」「専修大学 10301」のように、建物名や教室番号で検索した人が
IKU NAVI にたどり着けるようにするためのページ。Cloudflare Pages のビルド（build.sh）で毎回作り直すので、
スプレッドシートからデータを更新すれば次のデプロイで自動的に追従する（生成物はリポジトリに入れない）。

Pages のビルド環境には pandas が無いため、標準ライブラリだけで読む。教室の集め方は経路探索API
（programs/3D_Graph/ikunavi/cache.py の _build_room_index、naming.py の display_name）と同じにしている:
  - 教室は各建物の edge.csv の name 列（";" 区切り）。同じ教室が複数の線にあれば、最初の線の階を使う
  - トイレ（M_Toilet など）と ignore.csv の名前は教室の一覧に出さない（トイレは階ごとの設備として出す）
  - 表示名は name.csv（建物指定 → 建物共通）、無ければ「{名前}教室」

使い方: python3 deploy_env/pages/generate_campus_pages.py [--out programs/html]
"""
import argparse
import csv
import datetime
import html
import json
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
SITE = "https://iku-navi.net"
CAMPUS = "専修大学 生田キャンパス"

TOILET_LABEL = {"M_Toilet": "男子トイレ", "F_Toilet": "女子トイレ", "C_Toilet": "多目的トイレ"}
# サイトマップに必ず載せるページ（建物ページはこのあとに足す）
STATIC_PAGES = [("/", "1.00"), ("/navi/", "0.90"), ("/map3d/", "0.80"), ("/campus/", "0.80"), ("/embed/builder/", "0.50")]


def read_csv(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)]


def floor_name(f):
    return f"地下{1 - f}階" if f <= 0 else f"{f}階"


def natural_key(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def load():
    building_names = {int(r["building"]): r["display_name"] for r in read_csv(DATA / "building_name.csv") if r.get("building", "").isdigit() and r.get("display_name")}
    name_map = {}
    for r in read_csv(DATA / "name.csv"):
        if not r.get("name") or not r.get("display_name"):
            continue
        b = int(r["building"]) if r.get("building", "").isdigit() else None
        name_map[(b, r["name"])] = r["display_name"]
    ignore = {r["id"] for r in read_csv(DATA / "ignore.csv") if r.get("id")}
    cafeterias = defaultdict(list)   # (building, 生の名前) -> 表示名
    for r in read_csv(DATA / "cafeteria_edge.csv"):
        if r.get("building", "").isdigit() and r.get("name"):
            cafeterias[(int(r["building"]), r["name"])] = r.get("display_name") or r["name"]

    buildings = {}
    for d in sorted(DATA.glob("*_bldg")):
        b = int(d.name.split("_")[0])
        seen = set()
        floors = defaultdict(lambda: {"rooms": [], "toilets": set(), "cafeterias": []})
        for row in read_csv(d / "edge.csv"):
            try:
                floor = int(float(row.get("floor") or ""))
            except ValueError:
                continue
            for raw in (row.get("name") or "").split(";"):
                name = raw.strip()
                if not name or name in seen:
                    continue
                seen.add(name)
                if name in TOILET_LABEL:
                    floors[floor]["toilets"].add(name)
                elif (b, name) in cafeterias:
                    floors[floor]["cafeterias"].append(cafeterias[(b, name)])
                elif name not in ignore:
                    display = name_map.get((b, name)) or name_map.get((None, name)) or f"{name}教室"
                    floors[floor]["rooms"].append({"room": name, "display": display})
        if not any(fl["rooms"] for fl in floors.values()):
            continue
        for fl in floors.values():
            fl["rooms"].sort(key=lambda r: natural_key(r["room"]))
        buildings[b] = {
            "id": b,
            "name": building_names.get(b) or f"{b}号館",
            "floors": dict(sorted(floors.items())),
        }
    return dict(sorted(buildings.items()))


def floor_svg(out, b, f):
    name = f"{b}_{f}F.svg"
    return f"/svg/{name}" if (out / "svg" / name).exists() else None


HEAD_ASSETS = """  <link rel="icon" href="/images/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="theme-color" content="#14181F">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&family=Barlow+Semi+Condensed:wght@500;600&display=swap">
  <link rel="stylesheet" href="/campus.css">"""


def page(title, description, path, body, json_ld):
    e = html.escape
    url = SITE + path
    ld = "\n".join(f'  <script type="application/ld+json">{json.dumps(x, ensure_ascii=False)}</script>' for x in json_ld)
    return f"""<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(description)}">
  <link rel="canonical" href="{url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="IKU NAVI">
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(description)}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{SITE}/images/og-image.png">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary_large_image">
{HEAD_ASSETS}
{ld}
</head>
<body>
{body}
</body>
</html>
"""


def breadcrumb(items):
    return {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + p} for i, (n, p) in enumerate(items)],
    }


def site_header():
    return """<header class="site-head">
  <a class="brand" href="/">IKU NAVI</a>
  <nav aria-label="サイト内のページ">
    <a href="/navi/">教室検索ナビ</a>
    <a href="/map3d/">3Dマップ</a>
    <a href="/campus/">建物・教室一覧</a>
  </nav>
</header>"""


def site_footer():
    return """<footer class="site-foot">
  <p>IKU NAVI は、専修大学 ネットワーク情報学部の学生プロジェクト「生亀プロジェクト」が作っている、生田キャンパスの教室検索・道案内アプリです。大学の公式サービスではありません。</p>
  <p><a href="/">トップページ</a> ／ <a href="/navi/">教室検索ナビ</a> ／ <a href="/map3d/">3Dキャンパスマップ</a> ／ <a href="/campus/">建物・教室一覧</a></p>
</footer>"""


def floor_range(bd):
    fs = list(bd["floors"])
    return floor_name(fs[0]) if len(fs) == 1 else f"{floor_name(fs[0])}〜{floor_name(fs[-1])}"


def room_count(bd):
    return sum(len(fl["rooms"]) for fl in bd["floors"].values())


def building_page(out, bd):
    e = html.escape
    b, name = bd["id"], bd["name"]
    count = room_count(bd)
    # 説明文の例には、番号だけの教室（検索されやすい「10301」など）を優先して、違う階から選ぶ
    plain = [fl["rooms"] and next((r for r in fl["rooms"] if r["room"].isdigit()), None) for fl in bd["floors"].values()]
    samples = [r["display"] for r in plain if r][:3] or [r["display"] for fl in bd["floors"].values() for r in fl["rooms"]][:3]
    title = f"{name}の教室一覧・フロアマップ | {CAMPUS} | IKU NAVI"
    description = (f"{CAMPUS} {name}の教室一覧とフロアマップ。{floor_range(bd)}の{count}教室"
                   f"（{'・'.join(samples)}など）の場所を階ごとに掲載しています。教室を選ぶと、IKU NAVIがその教室までの道順を写真付きで案内します。")
    floor_links = "".join(f'<a href="#floor-{f}">{floor_name(f)}</a>' for f in bd["floors"])
    sections = []
    for f, fl in bd["floors"].items():
        rooms = "".join(
            f'<li id="room-{e(r["room"])}"><a href="/navi/?{e(urlencode({"to": r["room"], "to_bldg": b}))}">'
            f'<span class="room-name">{e(r["display"])}</span><span class="room-go">ここまでナビ</span></a></li>'
            for r in fl["rooms"])
        facts = []
        if fl["toilets"]:
            facts.append("トイレ: " + "・".join(TOILET_LABEL[t] for t in TOILET_LABEL if t in fl["toilets"]))
        if fl["cafeterias"]:
            facts.append("食堂・お店: " + "・".join(fl["cafeterias"]))
        svg = floor_svg(out, b, f)
        figure = (f'<figure class="floor-map"><img src="{svg}" alt="{e(name)} {floor_name(f)}のフロアマップ" loading="lazy" decoding="async">'
                  f'<figcaption>{e(name)} {floor_name(f)}のフロアマップ</figcaption></figure>') if svg else ""
        sections.append(f"""<section class="floor" id="floor-{f}">
  <h2><span class="floor-no">{floor_name(f)}</span>{f'<span class="floor-count">{len(fl["rooms"])}教室</span>' if fl["rooms"] else ''}</h2>
  {f'<p class="floor-facts">{e("　".join(facts))}</p>' if facts else ''}
  {figure}
  {f'<ul class="rooms">{rooms}</ul>' if rooms else '<p class="floor-facts">この階に登録されている教室はありません。</p>'}
</section>""")
    body = f"""{site_header()}
<main class="wrap">
  <nav class="crumbs" aria-label="現在の場所"><a href="/">IKU NAVI</a> › <a href="/campus/">建物・教室一覧</a> › {e(name)}</nav>
  <h1><span class="plate">{e(name)}</span>教室一覧・フロアマップ</h1>
  <p class="lead">{CAMPUS} {e(name)}にある{count}の教室を、階ごとにまとめました。教室名を押すと、教室検索ナビがその教室までの道順を写真付きで案内します（出発する教室を入れると検索できます）。</p>
  <p class="actions"><a class="btn primary" href="/navi/">教室検索ナビを開く</a><a class="btn" href="/map3d/">3Dマップで建物を見る</a></p>
  <nav class="floor-index" aria-label="階">{floor_links}</nav>
  {''.join(sections)}
</main>
{site_footer()}"""
    path = f"/campus/{b}/"
    ld = [
        breadcrumb([("IKU NAVI", "/"), ("建物・教室一覧", "/campus/"), (name, path)]),
        {"@context": "https://schema.org", "@type": "Place", "name": f"{CAMPUS} {name}",
         "containedInPlace": {"@type": "Place", "name": CAMPUS}, "url": SITE + path},
    ]
    return path, page(title, description, path, body, ld)


def index_page(buildings):
    e = html.escape
    total = sum(room_count(bd) for bd in buildings.values())
    names = "・".join(bd["name"] for bd in buildings.values())
    title = f"{CAMPUS}の建物・教室一覧（フロアマップ付き） | IKU NAVI"
    description = (f"{CAMPUS}の建物と教室の一覧です。{names}の{total}教室の場所を、建物・階ごとのフロアマップと一緒に"
                   "掲載しています。教室を選ぶと、IKU NAVIがその教室までの道順を写真付きで案内します。")
    cards = "".join(f"""<li><a href="/campus/{bd['id']}/">
  <span class="plate">{e(bd['name'])}</span>
  <span class="b-meta">{floor_range(bd)}・{room_count(bd)}教室</span>
  <span class="b-rooms">{e('、'.join(r['display'] for fl in bd['floors'].values() for r in fl['rooms'][:1]))} など</span>
</a></li>""" for bd in buildings.values())
    body = f"""{site_header()}
<main class="wrap">
  <nav class="crumbs" aria-label="現在の場所"><a href="/">IKU NAVI</a> › 建物・教室一覧</nav>
  <h1>{CAMPUS}の建物・教室一覧</h1>
  <p class="lead">IKU NAVIで案内している建物と教室の一覧です（全{total}教室）。建物を選ぶと、階ごとの教室とフロアマップを見られ、教室までの道順を写真付きで調べられます。</p>
  <p class="actions"><a class="btn primary" href="/navi/">教室検索ナビを開く</a><a class="btn" href="/map3d/">3Dマップでキャンパスを見る</a></p>
  <ul class="buildings">{cards}</ul>
</main>
{site_footer()}"""
    ld = [
        breadcrumb([("IKU NAVI", "/"), ("建物・教室一覧", "/campus/")]),
        {"@context": "https://schema.org", "@type": "ItemList", "name": f"{CAMPUS}の建物",
         "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": f"{CAMPUS} {bd['name']}", "url": f"{SITE}/campus/{bd['id']}/"}
                             for i, bd in enumerate(buildings.values())]},
    ]
    return "/campus/", page(title, description, "/campus/", body, ld)


def sitemap(paths, today):
    urls = "\n".join(f"<url>\n  <loc>{SITE}{p}</loc>\n  <lastmod>{today}</lastmod>\n  <priority>{prio}</priority>\n</url>" for p, prio in paths)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- deploy_env/pages/generate_campus_pages.py がビルドのたびに作り直す -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}
</urlset>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "programs" / "html"))
    out = Path(ap.parse_args().out)
    buildings = load()
    pages = [index_page(buildings)] + [building_page(out, bd) for bd in buildings.values()]
    for path, text in pages:
        dest = out / path.strip("/") / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
    today = datetime.date.today().isoformat()
    paths = STATIC_PAGES + [(p, "0.70") for p, _ in pages if p != "/campus/"]
    (out / "sitemap.xml").write_text(sitemap(paths, today), encoding="utf-8")
    print(f"[pages] campus pages generated: {len(pages)} pages, {sum(room_count(b) for b in buildings.values())} rooms")


if __name__ == "__main__":
    main()
