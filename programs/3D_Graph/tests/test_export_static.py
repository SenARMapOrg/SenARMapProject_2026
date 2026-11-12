"""静的データの書き出し（export_static.py）が、API とまったく同じ中身を書くことの確認。

画面は /data/*.json と API のどちらを読んでも同じに動く前提なので、1バイトでも違えば失敗にする。
"""
import json
import subprocess
import sys
from pathlib import Path

import export_static

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "programs" / "3D_Graph" / "export_static.py"


def test_書き出したファイルがAPIの返事と同じ(client, tmp_path):
    written = export_static.export(tmp_path)
    assert sorted(p.name for p in written) == sorted([*export_static.EXPORTS, export_static.ROUTE_DATA_FILE])
    for name, url in export_static.EXPORTS.items():
        assert (tmp_path / "data" / name).read_bytes() == client.get(url).get_data(), name


def test_今のdataで書き出せる(tmp_path):
    # Pages のビルドと同じく、別のプロセスでリポジトリの data/ から書き出す
    subprocess.run([sys.executable, str(SCRIPT), "--out", str(tmp_path)], check=True, capture_output=True)
    graph = json.loads((tmp_path / "data" / "graph.json").read_text(encoding="utf-8"))
    all_ = json.loads((tmp_path / "data" / "all.json").read_text(encoding="utf-8"))
    images = json.loads((tmp_path / "data" / "edge_images.json").read_text(encoding="utf-8"))
    assert graph["nodes"] and graph["edges"]
    assert all_["rooms"] and all_["buildings"]
    assert images and all(url.startswith("https://cdn.iku-navi.net/") for url in images.values())
    route = json.loads((tmp_path / "data" / export_static.ROUTE_DATA_FILE).read_text(encoding="utf-8"))
    assert route["version"] == export_static.ROUTE_DATA_VERSION
    assert len(route["nodes"]) == len(graph["nodes"]) and len(route["edges"]) == len(graph["edges"])
