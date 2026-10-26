"""フロアマップの矢印の向き（navi/script/floormap.js の floorChangeExitAngle）。

エレベーター・階段・エスカレーターで階を移る前の階・途中の階では、降りた階で次に進む向きを矢印に使う。
floormap.js はブラウザで普通のスクリプトとして読み込むファイルなので、Node の vm でそのまま読み込み、
関数を呼んで確かめる。読み込み時に initSvgPan() が document を触るので、何もしない代わりを渡す。
Node が無い環境ではスキップする。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

FLOORMAP_JS = Path(__file__).resolve().parents[1] / "navi" / "script" / "floormap.js"

RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const ctx = { console, Math, document: { getElementById: () => ({ addEventListener() {} }) } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), ctx);
const data = JSON.parse(process.argv[2]);
vm.runInContext(`var pathCoords = ${JSON.stringify(data.coords)}; var pathEdges = ${JSON.stringify(data.edges)};`, ctx);
const out = data.steps.map(s => vm.runInContext(`floorChangeExitAngle(${s})`, ctx));
process.stdout.write(JSON.stringify(out));
"""


def exit_angles(coords, edges, steps):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    data = json.dumps({"coords": coords, "edges": edges, "steps": steps})
    result = subprocess.run(
        [node, "-e", RUNNER, str(FLOORMAP_JS), data],
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def n(floor, svg_x, svg_y, building=8):
    return {"building": building, "floor": floor, "svg_x": svg_x, "svg_y": svg_y}


# 1階を右へ歩いてエレベーターに乗り、3階で降りて下（SVG の +y）へ進む経路。
# エレベーターの位置は階ごとに少しずれている（実データにもある）
ROUTE = [n(1, 0, 0), n(1, 100, 0), n(2, 103, 2), n(3, 101, 1), n(3, 101, 200)]
EDGES = [{"type": "1"}, {"type": "4"}, {"type": "4"}, {"type": "1"}]


def test_乗る階と途中の階では降りた階の次に進む向きを向く():
    # 90° = SVG の下向き
    assert exit_angles(ROUTE, EDGES, [1, 2]) == [90, 90]


def test_階段やエスカレーターでも同じように降りた階の次に進む向きを向く():
    # 区間の種類ではなく、同じ号館の別の階へ移るかどうかで決める
    stairs = [{"type": "1"}, {"type": "2"}, {"type": "5"}, {"type": "1"}]
    assert exit_angles(ROUTE, stairs, [1, 2]) == [90, 90]


def test_階を移らないステップでは使わない():
    # 歩いている途中・降りた階では、今までどおり次のノードへの向きを使う
    assert exit_angles(ROUTE, EDGES, [0, 3, 4]) == [None, None, None]


def test_降りた所が終点なら使わない():
    route = ROUTE[:4]
    assert exit_angles(route, EDGES[:3], [1, 2]) == [None, None]


def test_降りた階のSVG座標が無ければ使わない():
    route = [*ROUTE[:3], n(3, None, None), n(3, 101, 200)]
    assert exit_angles(route, EDGES, [1, 2]) == [None, None]


def test_降りた後すぐ別の号館に出るなら使わない():
    route = [*ROUTE[:4], n(1, 500, 500, building=9)]
    assert exit_angles(route, EDGES, [1]) == [None]


def test_同じ位置のノードは飛ばして次のノードの向きを使う():
    route = [*ROUTE[:4], n(3, 101, 1), n(3, 0, 1)]
    edges = [*EDGES, {"type": "1"}]
    assert exit_angles(route, edges, [1]) == [180]
