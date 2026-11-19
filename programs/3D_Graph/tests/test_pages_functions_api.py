"""Pages Functions の経路探索API（functions/_lib/api-handler.mjs）が、Flask と同じ答えを返すことの確認。

本番の Pages と同じく、ビルドで書き出した /data/*.json を env.ASSETS から読ませ、node で onRequestGet を呼ぶ。
経路の計算そのものの一致は test_route_js.py で全面的に見ているので、ここでは Functions の包み方
（一覧の返し方・エラー・CORS・無い API）を見る。
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import export_static

ROOT = Path(__file__).resolve().parents[3]
HANDLER = ROOT / "functions" / "_lib" / "api-handler.mjs"
CLIENT = ROOT / "programs" / "html" / "shared" / "api-client.js"

RUNNER = """
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleApiGet as onRequestGet } from %s;
const [siteDir, requestsPath] = process.argv.slice(2);
const env = { ASSETS: { async fetch(url) {
  try { return new Response(readFileSync(join(siteDir, new URL(url).pathname))); }
  catch { return new Response("not found", { status: 404 }); }
} } };
const out = [];
for (const { path, origin } of JSON.parse(readFileSync(requestsPath, "utf-8"))) {
  const headers = origin ? { Origin: origin } : {};
  const res = await onRequestGet({ request: new Request("https://iku-navi.net" + path, { headers }), env });
  out.push({ status: res.status, cors: res.headers.get("Access-Control-Allow-Origin"),
             type: res.headers.get("Content-Type"), body: await res.json() });
}
console.log(JSON.stringify(out));
"""

needs_node = pytest.mark.skipif(shutil.which("node") is None and not os.environ.get("CI"),
                                reason="node が無い（CI では必ず動かす）")


def call(site_dir, requests, tmp_path):
    script = tmp_path / "run.mjs"
    script.write_text(RUNNER % json.dumps(HANDLER.as_uri()), encoding="utf-8")
    req_path = tmp_path / "requests.json"
    req_path.write_text(json.dumps(requests, ensure_ascii=False), encoding="utf-8")
    out = subprocess.run(["node", str(script), str(site_dir), str(req_path)],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


@needs_node
def test_Flaskと同じ答えを返す(client, tmp_path):
    export_static.export(tmp_path / "site")
    paths = [
        "/api/all", "/api/graph", "/api/edge_images", "/api/events", "/api/cafeterias", "/api/facilities",
        "/api/route?from_room=101&from_building=1&to_room=201&to_building=2",
        "/api/route?from_room=101&from_building=1&to_room=201&to_building=2&step_free=1",
        "/api/route?from_room=101&from_building=1&to_room=999&to_building=2",
        "/api/route",
        "/api/nearest_toilet?from_room=201&from_building=2",
        "/api/nearest_cafeteria?from_room=101&from_building=1",
        "/api/shortest_path?start=100001&goal=200001",
        "/api/edges?name=M_Toilet",
    ]
    answers = call(tmp_path / "site", [{"path": p} for p in paths], tmp_path)
    for path, ans in zip(paths, answers):
        res = client.get(path)
        assert (ans["status"], ans["body"]) == (res.status_code, res.get_json()), path
        assert ans["type"] == "application/json", path


@needs_node
def test_CORSはFlaskと同じオリジンだけに付ける(tiny_campus, tmp_path):
    export_static.export(tmp_path / "site")
    origins = ["https://timetables.iku-navi.net", "https://iku-navi.net", "https://abc.iku-navi.pages.dev",
               "https://evil.example", None]
    answers = call(tmp_path / "site", [{"path": "/api/all", "origin": o} for o in origins], tmp_path)
    assert [a["cors"] for a in answers] == origins[:3] + [None, None]


@needs_node
def test_無いAPIとデータが無いとき(tiny_campus, tmp_path):
    export_static.export(tmp_path / "site")
    (tmp_path / "empty").mkdir()
    answers = call(tmp_path / "site", [{"path": "/api/rooms"}, {"path": "/api/navigate_to_room"}], tmp_path)
    assert [a["status"] for a in answers] == [404, 404]
    answers = call(tmp_path / "empty", [{"path": "/api/all"}, {"path": "/api/route"}], tmp_path)
    assert [a["status"] for a in answers] == [503, 503]


def test_一覧の対応表が画面側と同じ():
    def static_files(path, start):
        text = path.read_text(encoding="utf-8")
        i = text.index(start) + len(start)
        return dict(re.findall(r'"(/api/[a-z_]+)":\s*"([a-z_]+\.json)"', text[i:text.index("}", i)]))
    assert static_files(HANDLER, "export const STATIC_FILES = {") == static_files(CLIENT, "const STATIC_FILES = {")
