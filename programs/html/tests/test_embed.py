"""埋め込みマップ（/embed/）の計算部分（embed/core.js）と、ページの部品の噛み合わせ。

core.js はトップレベルで宣言しかしないので、Node の vm でそのまま読み込んで関数を呼ぶ。
Node が無い環境では、JS を動かすテストはスキップする。
"""
import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

HTML = Path(__file__).resolve().parents[1]
EMBED = HTML / "embed"

RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const ctx = { console, URLSearchParams, Math, Number, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), ctx);
const out = vm.runInContext(process.argv[2], ctx);
process.stdout.write(JSON.stringify(out === undefined ? null : out));
"""


def run_js(expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    result = subprocess.run([node, "-e", RUNNER, str(EMBED / "core.js"), expr],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# ---------------------------------------------------------------- URL パラメータ

def test_出発地と目的地があれば道順():
    p = run_js('parseEmbedParams("?from=10301&to=131&to_bldg=1&elevator=0")')
    assert p["view"] == "route"
    assert p["from"] == {"room": "10301", "bldg": None, "event": ""}
    assert p["to"] == {"room": "131", "bldg": 1, "event": ""}
    assert p["elevator"] is False and p["header"] is True


def test_展示はイベントのIDで指定できる():
    p = run_js('parseEmbedParams("?from=10301&to_event=b")')
    assert p["view"] == "route" and p["to"]["event"] == "b"


def test_教室だけなら教室の場所():
    assert run_js('parseEmbedParams("?room=10301&bldg=10")') == {
        "view": "room", "room": "10301", "bldg": 10, "elevator": True, "header": True, "floors": True}
    # 出発地の無い to も教室の場所として出す
    p = run_js('parseEmbedParams("?to=131&to_bldg=1&header=0")')
    assert (p["view"], p["room"], p["bldg"], p["header"]) == ("room", "131", 1, False)


def test_号館と階ならフロアマップ():
    p = run_js('parseEmbedParams("?bldg=7&floor=0&floors=0")')
    assert (p["view"], p["bldg"], p["floor"], p["floors"]) == ("floor", 7, 0, False)
    assert run_js('parseEmbedParams("?bldg=abc").view') == "empty"
    assert run_js('parseEmbedParams("").view') == "empty"


def test_出発地の無い展示は道順にできない():
    assert run_js('parseEmbedParams("?to_event=b").view') == "error"


def test_親ページからの指示は知っているキーだけ受け取る():
    q = run_js('messageToSearch({ room: "10301", bldg: 10, header: false, evil: "x", floor: { a: 1 } })')
    assert q == "?room=10301&bldg=10&header=0"
    assert run_js("messageToSearch(null)") == ""


# ---------------------------------------------------------------- 教室の特定

ROOMS = json.dumps([
    {"room": "101", "display": "101教室", "building": 1, "floor": 1},
    {"room": "101", "display": "101教室", "building": 2, "floor": 1},
    {"room": "10301", "display": "10301教室", "building": 10, "floor": 3},
])


def test_教室名は号館が無くても1つに決まれば見つかる():
    assert run_js(f'findRoom({ROOMS}, "10301", null).building') == 10
    assert run_js(f'findRoom({ROOMS}, "10301教室", null).building') == 10
    assert run_js(f'findRoom({ROOMS}, "101", null)') == "ambiguous"
    assert run_js(f'findRoom({ROOMS}, "101", 2).building') == 2
    assert run_js(f'findRoom({ROOMS}, "999", null)') is None


# ---------------------------------------------------------------- 経路の区間分け

def node(i, b, f, **kw):
    return {"id": i, "building": b, "floor": f, **kw}


def edge(t, length=10):
    return {"type": str(t), "length": length}


def test_経路を建物と階ごとの区間に分ける():
    coords = [node(1, 10, 3), node(2, 10, 3), node(3, 10, 1), node(4, 10, 1),
              node(5, 0, 1), node(6, 0, 1), node(7, 1, 1), node(8, 1, 1)]
    edges = [edge(1, 20), edge(4, 0), edge(1, 15), edge(7, 0), edge(1, 100), edge(7, 0), edge(1, 8)]
    segs = run_js(f"splitRouteSegments({json.dumps(coords)}, {json.dumps(edges)})")
    assert [(s["kind"], s["building"], s["floor"], s["start"], s["end"]) for s in segs] == [
        ("floor", 10, 3, 0, 1), ("floor", 10, 1, 2, 3), ("outdoor", 0, 1, 4, 5), ("floor", 1, 1, 6, 7)]
    assert [s["length"] for s in segs] == [20, 15, 100, 8]


def test_階段で通り過ぎるだけの階は区間にしない():
    coords = [node(1, 10, 1), node(2, 10, 1), node(3, 10, 2), node(4, 10, 3), node(5, 10, 3)]
    edges = [edge(1), edge(2, 4), edge(2, 4), edge(1)]
    segs = run_js(f"splitRouteSegments({json.dumps(coords)}, {json.dumps(edges)})")
    assert [s["floor"] for s in segs] == [1, 3]


def test_区間を歩き終えたらすることを案内する():
    coords = [node(1, 10, 3), node(2, 10, 3), node(3, 10, 1), node(4, 10, 1),
              node(5, 0, 1), node(6, 0, 1), node(7, 1, 1), node(8, 1, 1)]
    edges = [edge(1), edge(4), edge(1), edge(7), edge(1), edge(7), edge(1)]
    route = {"path_coords": coords, "path_edges": edges, "dest_side": "right",
             "dest_display": "131教室", "dest_position": 2, "dest_count": 3, "dest_nearest_display": "130教室"}
    texts = run_js(f"""
      const r = {json.dumps(route)};
      const segs = splitRouteSegments(r.path_coords, r.path_edges);
      segs.map((s, k) => segmentNextText(r, segs, k, {{ 1: "1号館", 10: "10号館" }}))
    """)
    assert texts == ["エレベーターで1階へ", "入口から外へ出ます", "1号館の入口へ", "131教室は右手、130教室から数えて2番目です"]


def test_到着の文はナビ画面と同じ言い方():
    base = {"path_edges": [{"right_display": "", "left_display": "201教室"}]}
    assert run_js(f'arrivalText({json.dumps({**base, "dest_side": "left", "dest_display": "201教室", "dest_position": 1, "dest_count": 2})})') == "201教室は左手です"
    assert run_js(f'arrivalText({json.dumps({**base, "dest_side": ""})})') == "左手に目的地です"


def test_表示範囲は地図からはみ出さない():
    box = run_js('fitViewBox([{ x: 10, y: 10 }], 2000, 1000, { min: 500 })')
    assert box["x"] == 0 and box["y"] == 0 and box["w"] == 500
    box = run_js('fitViewBox([], 2000, 1000)')
    assert box == {"x": 0, "y": 0, "w": 2000, "h": 1000}


def test_IKU_NAVIで開くURL():
    assert run_js('fullNaviUrl(parseEmbedParams("?from=10301&to_event=b&elevator=0"))') == \
        "https://iku-navi.net/navi/?from=10301&to_event=b&elevator=0"
    assert run_js('fullNaviUrl(parseEmbedParams("?room=131&bldg=1"))') == "https://iku-navi.net/navi/?to=131&to_bldg=1"
    assert run_js('fullNaviUrl(parseEmbedParams("?bldg=10&floor=3"))') == "https://iku-navi.net/campus/10/#floor-3"


# ---------------------------------------------------------------- ページの部品

def ids_in(path):
    return set(re.findall(r'id="([^"]+)"', path.read_text(encoding="utf-8")))


@pytest.mark.parametrize("page, script", [
    (EMBED / "index.html", EMBED / "viewer.js"),
    (EMBED / "builder" / "index.html", EMBED / "builder" / "builder.js"),
])
def test_スクリプトが使う要素がページにある(page, script):
    used = set(re.findall(r'\$\("([^"]+)"\)', script.read_text(encoding="utf-8")))
    assert used, "要素を1つも参照していない"
    assert used <= ids_in(page), used - ids_in(page)


def test_埋め込み画面はどこからでも埋め込めて検索結果には出さない():
    headers = (HTML / "_headers").read_text(encoding="utf-8")
    block = headers.split("\n/embed/\n", 1)[1].split("\n\n", 1)[0]
    assert "frame-ancestors *" in block
    assert "X-Robots-Tag: noindex" in block
