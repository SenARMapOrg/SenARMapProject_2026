"""shared/api-client.js（ikunaviFetch）の対応表が、ビルドで書き出すファイル・JS の経路計算と食い違っていないことの確認。

食い違うと、本番では毎回 /data/*.json が見つからなかったり、ブラウザで計算できずにサーバーに聞きに行ったりする
（動くので気付きにくい）。
"""
import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
HTML = ROOT / "programs" / "html"
CLIENT = HTML / "shared" / "api-client.js"
CORE = HTML / "shared" / "route-core.mjs"
EXPORT_SCRIPT = ROOT / "programs" / "3D_Graph" / "export_static.py"


def load_export_static():
    spec = importlib.util.spec_from_file_location("export_static_for_client_test", EXPORT_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def block(text, start):
    """text の start から、対応する閉じ括弧までの中身"""
    i = text.index(start) + len(start)
    return text[i:text.index("}" if start.endswith("{") else "]", i)]


def test_静的データの対応がビルドで書き出すファイルと同じ():
    text = CLIENT.read_text(encoding="utf-8")
    static = dict(re.findall(r'"(/api/[a-z_]+)":\s*"([a-z_]+\.json)"', block(text, "const STATIC_FILES = {")))
    exports = load_export_static().EXPORTS
    assert static, "STATIC_FILES が読めない"
    assert {f: a for a, f in static.items()} == exports


def test_ブラウザで計算するAPIはJSの経路計算が答えられるもの():
    computed = set(re.findall(r'"(/api/[a-z_]+)"', block(CLIENT.read_text(encoding="utf-8"), "const COMPUTED = new Set([")))
    handlers = set(re.findall(r'"(/api/[a-z_]+)":', block(CORE.read_text(encoding="utf-8"), "const HANDLERS = {")))
    assert computed and computed == handlers


@pytest.mark.parametrize("page", ["embed/index.html", "embed/builder/index.html", "map3d/index.html"])
def test_APIを呼ぶページはapi_clientを先に読む(page):
    html = (HTML / page).read_text(encoding="utf-8")
    srcs = re.findall(r'<script src="([^"]+)"></script>', html)
    assert "/shared/api-client.js" in srcs, f"{page}: /shared/api-client.js を読み込んでいない"
    first_app = next(i for i, s in enumerate(srcs) if "cdn.jsdelivr" not in s and s != "/shared/api-client.js")
    assert srcs.index("/shared/api-client.js") < first_app


def test_画面からサーバーを直接呼んでいない():
    # 経路探索API は ikunaviFetch を通す（直接 fetch すると、ブラウザでの計算に切り替わらない）
    offenders = []
    for path in [*HTML.glob("navi/script/*.js"), *HTML.glob("embed/**/*.js"), HTML / "map3d" / "map3d.js"]:
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\bfetch\([^)]*/api/(?!support|help-chat)", line):
                offenders.append(f"{path.relative_to(HTML)}:{n}: {line.strip()}")
    assert not offenders, "\n".join(offenders)
