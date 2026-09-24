"""ナビ画面（/navi と /navi1〜/navi9）のHTMLとスクリプトの噛み合わせチェック。

スクリプトは通常のスクリプトとして読み込まれ、HTML側は `onclick="doSearch()"` の
ように関数をグローバルから呼び、スクリプト側は `document.getElementById(id)` で
要素を探す。この「HTMLとJSの契約」はどこにも型がないので、ここで機械的に照合する。
仕様は docs/navi_ui_variants_spec.md を参照。
"""
import re
from pathlib import Path

import pytest

HTML_DIR = Path(__file__).resolve().parents[1]
SCRIPT_DIR = HTML_DIR / "navi" / "script"

# 読み込み順の規約（config.js はビルド時生成なのでリポジトリには無い）
APP_SCRIPTS = ["state.js", "data.js", "search-form.js", "gps.js", "route.js",
               "voice.js", "photo.js", "map.js", "floormap.js", "page.js"]
TRAILING_SCRIPTS = ["ar.js", "maps-loader.js"]

# 動的に生成される・存在しないこともある要素（スクリプト側で null を許容している）
OPTIONAL_IDS = {"event-badge"}

SCRIPT_SRC = re.compile(r'<script src="([^"]+)"></script>')
GET_BY_ID = re.compile(r'getElementById\(\s*"([^"]+)"\s*\)')
ELEMENT_ID = re.compile(r'\bid="([^"]+)"')
ONCLICK = re.compile(r'on(?:click|change|input|submit)="([a-zA-Z_$][\w$]*)\(')
FUNCTION_DEF = re.compile(r'^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(', re.M)


def navi_pages():
    pages = [HTML_DIR / "navi" / "index.html"]
    pages += sorted(HTML_DIR.glob("navi[0-9]/index.html"))
    return pages


PAGES = navi_pages()
PAGE_IDS = [p.parent.name for p in PAGES]


@pytest.fixture(scope="module")
def script_text():
    """navi/script/*.js（ビルド時生成の config.js を除く）を連結したもの"""
    return "\n".join(
        (SCRIPT_DIR / name).read_text(encoding="utf-8")
        for name in APP_SCRIPTS + TRAILING_SCRIPTS
    )


def test_バリエーションが9つある():
    assert len(PAGES) == 10, [p.parent.name for p in PAGES]


@pytest.mark.parametrize("page", PAGES, ids=PAGE_IDS)
def test_参照しているスクリプトが実在する(page):
    for src in SCRIPT_SRC.findall(page.read_text(encoding="utf-8")):
        if src.endswith("config.js"):
            continue  # Cloudflare Pages のビルド時に生成される
        assert (page.parent / src).resolve().exists(), f"{page.parent.name}: {src} が無い"


@pytest.mark.parametrize("page", PAGES, ids=PAGE_IDS)
def test_スクリプトの読み込み順が規約通り(page):
    srcs = [Path(s).name for s in SCRIPT_SRC.findall(page.read_text(encoding="utf-8"))]
    app_scripts = [s for s in srcs if s in APP_SCRIPTS]
    assert app_scripts == APP_SCRIPTS, f"{page.parent.name}: {app_scripts}"
    # 共有する定数・変数を宣言する state.js が先頭、ar/maps-loader が最後
    assert srcs.index("state.js") < srcs.index("data.js")
    assert srcs.index("page.js") < srcs.index("ar.js") < srcs.index("maps-loader.js")


@pytest.mark.parametrize("page", PAGES, ids=PAGE_IDS)
def test_スクリプトが探す要素がページに存在する(page, script_text):
    html = page.read_text(encoding="utf-8")
    page_ids = set(ELEMENT_ID.findall(html))
    needed = set(GET_BY_ID.findall(script_text)) - OPTIONAL_IDS
    missing = sorted(needed - page_ids)
    assert not missing, f"{page.parent.name} に無いID: {missing}"


@pytest.mark.parametrize("page", PAGES, ids=PAGE_IDS)
def test_HTMLから呼ぶ関数がスクリプトに定義されている(page, script_text):
    defined = set(FUNCTION_DEF.findall(script_text))
    called = set(ONCLICK.findall(page.read_text(encoding="utf-8")))
    missing = sorted(called - defined)
    assert not missing, f"{page.parent.name} が呼ぶ未定義の関数: {missing}"


def test_分割したスクリプトに重複定義がない(script_text):
    names = FUNCTION_DEF.findall(script_text)
    duplicates = sorted({n for n in names if names.count(n) > 1})
    assert not duplicates, f"複数のファイルで定義されている関数: {duplicates}"


def test_state_js以外はトップレベルの共有変数を宣言していない():
    """共有する状態は state.js に集約する（宣言順で壊れるのを防ぐため）"""
    shared = re.compile(r"^let\s+([a-zA-Z_$][\w$]*)", re.M)
    declared = {}
    for name in APP_SCRIPTS:
        for var in shared.findall((SCRIPT_DIR / name).read_text(encoding="utf-8")):
            declared.setdefault(var, []).append(name)
    duplicated = {v: files for v, files in declared.items() if len(files) > 1}
    assert not duplicated, f"複数ファイルで let 宣言されている変数: {duplicated}"
