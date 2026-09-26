"""タブで各ツールを切り替えるアプリ本体の動作"""
import pytest

pytest.importorskip("PyQt6.QtWidgets")

from PyQt6.QtWidgets import QPlainTextEdit  # noqa: E402

from iku_tools import app as app_module  # noqa: E402
from iku_tools.app import TOOL_KEYS, TOOLS  # noqa: E402


def _error_text(window, index):
    err = window._pages[index].findChild(QPlainTextEdit)
    return err.toPlainText() if err else None


def test_タブは7つで決まった順に並ぶ(make_window):
    w = make_window()
    assert [w._tabs.tabText(i) for i in range(w._tabs.count())] == [t.label for t in TOOLS]
    assert TOOL_KEYS == ("map_editor", "events", "route_checker", "image_checker",
                         "image_renamer", "human_remover", "svg_pointer")


@pytest.mark.parametrize("key", TOOL_KEYS)
def test_どのタブも読み込める(make_window, qapp, key):
    if key == "human_remover":
        pytest.importorskip("cv2")
        pytest.importorskip("ultralytics")
    w = make_window(initial_tool=key)
    index = TOOL_KEYS.index(key)
    assert w._tabs.currentIndex() == index
    assert w.tool_window(key) is not None, _error_text(w, index)


def test_タブは開くまで読み込まない(make_window):
    w = make_window(initial_tool="svg_pointer")
    assert list(w._windows) == [TOOL_KEYS.index("svg_pointer")]


def test_最後に開いたタブで次回起動する(make_window, qapp):
    w = make_window()
    w._tabs.setCurrentIndex(TOOL_KEYS.index("image_renamer"))
    qapp.processEvents()
    w2 = make_window()
    assert w2.current_tool_key() == "image_renamer"


def test_ウィンドウのタイトルに開いているツールのタイトルが出る(make_window):
    w = make_window(initial_tool="route_checker")
    assert w.windowTitle() == "ルート検証 — IKU NAVI ツール"


def test_必要なライブラリが無いタブにはエラーを出し他のタブは使える(make_window, monkeypatch):
    import iku_tools.svg_pointer.window as svg_window
    monkeypatch.setattr(svg_window, "missing_dependencies", lambda: ["some-package"], raising=False)
    w = make_window(initial_tool="svg_pointer")
    index = TOOL_KEYS.index("svg_pointer")
    assert w.tool_window("svg_pointer") is None
    assert "some-package" in _error_text(w, index)
    w._tabs.setCurrentIndex(TOOL_KEYS.index("image_renamer"))
    assert w.tool_window("image_renamer") is not None


def test_読み込み中の例外でもアプリは落ちない(make_window, monkeypatch):
    def broken(key):
        raise RuntimeError(f"{key} が壊れた")
    monkeypatch.setattr(app_module, "load_tool_window", broken)
    w = make_window(initial_tool="events")
    assert "events が壊れた" in _error_text(w, TOOL_KEYS.index("events"))


def test_未保存のツールが閉じるのを断るとアプリも閉じない(make_window, qapp):
    w = make_window(initial_tool="events")
    w._tabs.setCurrentIndex(TOOL_KEYS.index("map_editor"))
    qapp.processEvents()
    map_editor = w.tool_window("map_editor")
    events = w.tool_window("events")
    events._confirm_discard_if_dirty = lambda: False       # 「イベント設定」に未保存の変更がある
    w._tabs.setCurrentIndex(TOOL_KEYS.index("svg_pointer"))

    assert w.close() is False
    assert w.isVisible()
    # 断ったツールのタブに切り替わり、先に閉じたツールも表示し直されている
    assert w.current_tool_key() == "events"
    assert not map_editor.isHidden()


def test_全ツールが閉じてよければアプリも閉じる(make_window):
    w = make_window(initial_tool="events")
    w.tool_window("events")._confirm_discard_if_dirty = lambda: True
    assert w.close() is True
