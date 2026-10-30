"""階段・エレベーターで何階へ行くかの案内（navi/script/voice.js の buildVerticalMoveText）。

エレベーターの中では、写真の上にこの文言を出す（photo.js）。何階か続けて乗るときも、降りる階を出すことを確かめる。
voice.js は Node の vm で読み込み、ブラウザの API は最低限の代わりを用意する。Node が無い環境ではスキップする。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

VOICE_JS = Path(__file__).resolve().parents[1] / "navi" / "script" / "voice.js"

RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const ctx = { console, Math, localStorage: { getItem: () => null }, window: {},
              document: { getElementById: () => null, addEventListener() {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), ctx);
vm.runInContext(`function floorLabel(f) { return f < 0 ? "B" + (-f) + "階" : f + "階"; }`, ctx);
process.stdout.write(JSON.stringify(vm.runInContext(process.argv[2], ctx)));
"""


def run_js(setup: str, expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    result = subprocess.run([node, "-e", RUNNER, str(VOICE_JS), f"{setup}; {expr}"],
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def route(floors, types):
    coords = json.dumps([{"floor": f} for f in floors])
    edges = json.dumps([{"type": t} for t in types])
    return f"var pathCoords = {coords}; var pathEdges = {edges};"


def test_エレベーターで続けて上がるときは降りる階を出す():
    setup = route([1, 1, 2, 3, 6, 6], ["1", "4", "4", "4", "1"])
    out = run_js(setup, "[1, 2, 3].map(buildVerticalMoveText)")
    assert out == ["エレベーターで6階まで上がってください"] * 3


def test_下りるとき():
    setup = route([5, 4, 1, 1], ["4", "4", "1"])
    assert run_js(setup, "buildVerticalMoveText(1)") == "エレベーターで1階まで下りてください"


def test_音声は乗り始めのステップだけで読む():
    setup = route([1, 1, 2, 3, 3], ["1", "4", "4", "1"])
    assert run_js(setup, "[buildStepAnnouncement(1), buildStepAnnouncement(2)]") == [
        "エレベーターで3階まで上がってください", ""]


def test_通路では出さない():
    setup = route([1, 1, 1], ["1", "1"])
    assert run_js(setup, "buildVerticalMoveText(0)") == ""
