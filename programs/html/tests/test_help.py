"""ナビの「使い方」（navi/faq.json・navi/script/help.js・functions/api/help-chat.js）の噛み合わせチェック。
説明は docs/help_chat.md。"""
import json
import re
from pathlib import Path

HTML_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = HTML_DIR.parents[1]
FAQ = HTML_DIR / "navi" / "faq.json"
HELP_JS = HTML_DIR / "navi" / "script" / "help.js"
CHAT_FN = REPO_DIR / "functions" / "api" / "help-chat.js"
SUPPORT_GUARD = REPO_DIR / "programs" / "event_guide_counter" / "functions" / "api" / "_lib" / "support-guard.ts"


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


def test_サーバーがよくある質問を読む場所が正しい():
    path = re.search(r'FAQ_PATH = "([^"]+)"', CHAT_FN.read_text(encoding="utf-8")).group(1)
    assert (HTML_DIR / path.lstrip("/")) == FAQ


def test_画面とサーバーで上限の値が同じ():
    def consts(path):
        text = path.read_text(encoding="utf-8")
        return {name: int(re.search(rf"const {name} = (\d+);", text).group(1)) for name in ("MAX_CHARS", "MAX_TURNS")}
    assert consts(HELP_JS) == consts(CHAT_FN)


def test_オペレーターへのメッセージの上限が集計システムと同じ():
    front = re.search(r"const SUPPORT_MAX_CHARS = (\d+);", HELP_JS.read_text(encoding="utf-8")).group(1)
    server = re.search(r"export const MAX_SUPPORT_MESSAGE_CHARS = (\d+);", SUPPORT_GUARD.read_text(encoding="utf-8")).group(1)
    assert front == server
