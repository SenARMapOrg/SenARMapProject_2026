"""3Dマップ（/map3d/）が読む静的なJSONの名前と、ビルドで書き出す名前（export_static.py）が合っていることの確認。

名前が食い違うと、本番では毎回 /data/*.json が見つからず、黙って API に戻ってしまう（動くので気付きにくい）。
"""
import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MAP3D_JS = ROOT / "programs" / "html" / "map3d" / "map3d.js"
EXPORT_SCRIPT = ROOT / "programs" / "3D_Graph" / "export_static.py"

FETCH_DATA = re.compile(r'fetchData\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)')


def load_exports():
    spec = importlib.util.spec_from_file_location("export_static_for_test", EXPORT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.EXPORTS


def test_3Dマップが読むファイルはビルドで書き出している():
    calls = FETCH_DATA.findall(MAP3D_JS.read_text(encoding="utf-8"))
    assert calls, "map3d.js に fetchData の呼び出しが無い"
    exports = load_exports()
    for file, api in calls:
        assert exports.get(file) == api, f"{file}（{api}）はビルドで書き出していない、または元の API が違う"
