"""IndexNow の送信スクリプト（deploy_env/pages/indexnow.py）とキーファイルの確認。ネットワークには出ない。"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("indexnow", ROOT / "deploy_env" / "pages" / "indexnow.py")
indexnow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(indexnow)


def test_キーファイルがサイトのルートにあり中身がキーと同じ():
    key_file = ROOT / "programs" / "html" / f"{indexnow.KEY}.txt"
    assert key_file.read_text(encoding="utf-8").strip() == indexnow.KEY
    assert indexnow.KEY_LOCATION == f"https://iku-navi.net/{indexnow.KEY}.txt"


def test_サイトマップからこのサイトのURLだけを重複なしで取り出す():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://iku-navi.net/</loc></url>
<url><loc> https://iku-navi.net/navi/ </loc></url>
<url><loc>https://iku-navi.net/navi/</loc></url>
<url><loc>https://example.com/other/</loc></url>
</urlset>"""
    assert indexnow.urls_from_sitemap(xml) == ["https://iku-navi.net/", "https://iku-navi.net/navi/"]


def test_リポジトリのサイトマップから送る形を作れる():
    xml = (ROOT / "programs" / "html" / "sitemap.xml").read_text(encoding="utf-8")
    urls = indexnow.urls_from_sitemap(xml)
    assert "https://iku-navi.net/navi/" in urls
    body = indexnow.payload(urls)
    assert body["host"] == "iku-navi.net"
    assert body["key"] == indexnow.KEY
    assert body["urlList"] == urls
