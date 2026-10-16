"""建物・教室一覧（/campus/）の生成スクリプトが、今の data/ で動き、必要な情報を出すことの確認。

生成物はビルド時に作るのでリポジトリには無い。ここでは一時ディレクトリに作って中身を見る。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "deploy_env" / "pages" / "generate_campus_pages.py"


def generate(tmp_path):
    (tmp_path / "svg").mkdir()
    subprocess.run([sys.executable, str(SCRIPT), "--out", str(tmp_path)], check=True, capture_output=True)
    return tmp_path


def test_建物ページと一覧とサイトマップができる(tmp_path):
    out = generate(tmp_path)
    index = (out / "campus" / "index.html").read_text(encoding="utf-8")
    buildings = sorted(p.parent.name for p in (out / "campus").glob("*/index.html"))
    assert buildings, "建物ページが1つもできていない"
    sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
    for b in buildings:
        assert f'href="/campus/{b}/"' in index
        assert f"https://iku-navi.net/campus/{b}/" in sitemap
    assert "https://iku-navi.net/navi/" in sitemap


def test_各ページに検索結果用の情報がある(tmp_path):
    out = generate(tmp_path)
    for page in (out / "campus").rglob("index.html"):
        html = page.read_text(encoding="utf-8")
        desc = re.search(r'<meta name="description" content="([^"]+)">', html)
        assert desc and 80 <= len(desc.group(1)) <= 160, f"{page}: 説明文の長さ"
        assert '<link rel="canonical" href="https://iku-navi.net/campus/' in html
        assert '"@type": "BreadcrumbList"' in html


def test_教室からナビを開ける(tmp_path):
    out = generate(tmp_path)
    html = (out / "campus" / "10" / "index.html").read_text(encoding="utf-8")
    assert 'href="/navi/?to=10301&amp;to_bldg=10"' in html
    assert "10301教室" in html
    assert "M_Toilet" not in html   # トイレは教室としてではなく、階の設備として出す
