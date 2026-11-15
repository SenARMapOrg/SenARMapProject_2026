"""ナビの「使い方」（navi/faq.json・navi/script/help.js）の噛み合わせチェック。
説明は docs/help_chat.md。"""
import json
from pathlib import Path

HTML_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = HTML_DIR.parents[1]
FAQ = HTML_DIR / "navi" / "faq.json"
HELP_JS = HTML_DIR / "navi" / "script" / "help.js"


def test_よくある質問の形が正しい():
    items = json.loads(FAQ.read_text(encoding="utf-8"))
    assert items
    for item in items:
        assert set(item) == {"q", "a"}, item
        assert item["q"].strip() and item["a"].strip(), item
    questions = [item["q"] for item in items]
    assert len(questions) == len(set(questions)), "同じ質問が2つある"


def test_ナビ画面にボタンとスクリプトがある():
    html = (HTML_DIR / "navi" / "index.html").read_text(encoding="utf-8")
    assert 'id="help-btn"' in html
    assert '<script src="script/help.js"></script>' in html


def test_よくある質問だけを出しサーバーには送らない():
    # AI への質問（/api/help-chat）とオペレーターへの相談（/api/support/*）は 2026-11-15 に外した
    js = HELP_JS.read_text(encoding="utf-8")
    assert 'FAQ_URL = "faq.json"' in js
    for gone in ("/api/help-chat", "/api/support", "method: \"POST\""):
        assert gone not in js, gone
    assert not (REPO_DIR / "functions" / "api" / "help-chat.js").exists()
