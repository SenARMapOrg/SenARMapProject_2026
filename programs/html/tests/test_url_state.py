"""検索の条件を URL に書き込み、再読み込みしても続けられるようにする処理（navi/script/data.js）。

data.js を Node の vm で読み込み、location・history の代わりを置いて、書き込まれる URL を確かめる。
再読み込みで経路とステップが戻るところまでは、ブラウザで確かめている（このテストでは扱わない）。
Node が無い環境ではスキップする。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

DATA_JS = Path(__file__).resolve().parents[1] / "navi" / "script" / "data.js"

# history.replaceState で location も書き換わる。
# 読み込み時の loadAllData() は、通信できない（ikunaviFetch が失敗する）ものとして素通りさせる
RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const [file, expr] = process.argv.slice(1);
const location = { pathname: "/navi/", search: "", hash: "" };
const replaced = [];
const ctx = {
  console: { ...console, warn() {} }, URLSearchParams, location, replaced,
  fetch: () => Promise.reject(new Error("offline")),
  ikunaviFetch: () => Promise.reject(new Error("offline")),
  ikunaviPreload() {},
  EVENT_MODE: false,   // state.js で決まる値（このテストでは state.js を読まない）
  history: {
    state: null,
    replaceState(state, title, url) {
      replaced.push(url);
      const i = url.indexOf("?");
      location.search = i < 0 ? "" : url.slice(i);
    },
  },
};
vm.createContext(ctx);
vm.runInContext("var allRooms = []; function prefetchArrowImages() {}", ctx);
vm.runInContext(fs.readFileSync(file, "utf8"), ctx);
setTimeout(() => process.stdout.write(JSON.stringify(vm.runInContext(expr, ctx))), 0);
"""


def run_js(expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    result = subprocess.run(
        [node, "-e", RUNNER, str(DATA_JS), expr],
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_検索の条件を書き込み_案内係のrefなどは残す():
    # 前の検索の条件（from・to_event・step）が URL に残っているところで、新しく検索した
    out = run_js("""
        location.search = "?ref=ABC&event=1&from=999&to_event=7&step=4";
        const p = new URLSearchParams();
        setPlaceUrlParam(p, "from", { room: "10301", building: 10 });
        setPlaceUrlParam(p, "to",   { room: "131",   building: 1 });
        saveSearchToUrl(p);
        location.search
    """)
    assert out == "?ref=ABC&event=1&from=10301&from_bldg=10&to=131&to_bldg=1"


def test_展示はidで書き込む():
    out = run_js("""
        const p = new URLSearchParams();
        setPlaceUrlParam(p, "to", { room: "鳳祭実行委員会本部", building: 10, isEvent: true, eventId: "1" });
        saveSearchToUrl(p);
        location.search
    """)
    assert out == "?to_event=1"


def test_ステップは2つ目から書き込み_最初に戻したら消す():
    out = run_js("""
        saveSearchToUrl(new URLSearchParams({ to: "131" }));
        saveStepToUrl(3);
        const moved = location.search;
        saveStepToUrl(0);
        [moved, location.search]
    """)
    assert out == ["?to=131&step=3", "?to=131"]


def test_ページは読み込み直さず履歴も増やさない():
    # history.replaceState だけで書き換え、パスと #以降 はそのまま
    out = run_js("""
        saveSearchToUrl(new URLSearchParams({ to: "131" }));
        replaced
    """)
    assert out == ["/navi/?to=131"]
