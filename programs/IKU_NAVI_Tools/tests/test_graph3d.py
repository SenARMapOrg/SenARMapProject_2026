"""3Dグラフのタブ（/3d を開き、動画撮影用の操作を足す）"""
import pytest

pytest.importorskip("PyQt6.QtWidgets")

from iku_tools.graph3d import window as g  # noqa: E402


@pytest.mark.parametrize("api, url", [
    ("https://old-api.iku-navi.net", "https://old-api.iku-navi.net/3d"),
    ("https://old-api.iku-navi.net/", "https://old-api.iku-navi.net/3d"),
    ("http://localhost:5001/3d", "http://localhost:5001/3d"),
    ("localhost:5001", "http://localhost:5001/3d"),
    ("  ", g.DEFAULT_API + "/3d"),
])
def test_APIの欄から3dのURLを作る(api, url):
    assert g.viewer_url(api) == url


@pytest.mark.parametrize("size, aspect, rect", [
    ((1000, 800), None, (0, 0, 1000, 800)),
    ((1600, 1000), (16, 9), (0, 50, 1600, 900)),
    ((1000, 1000), (9, 16), (219, 0, 562, 1000)),
    ((1200, 600), (1, 1), (300, 0, 600, 600)),
])
def test_縦横比に合わせて真ん中に置く(size, aspect, rect):
    assert g.fit_aspect(*size, aspect) == rect


def test_操作の設定をページに渡す形にする(make_window):
    pytest.importorskip("PyQt6.QtWebEngineWidgets")
    w = make_window(initial_tool="graph3d").tool_window("graph3d")
    assert w.options()["rotate"] is False
    w.rotate_check.setChecked(True)
    w.dir_combo.setCurrentIndex(1)
    w.zoom_combo.setCurrentIndex(1)
    w.period_slider.setValue(60)
    opts = w.options()
    assert (opts["rotate"], opts["dir"], opts["zoom"], opts["period"]) == (True, -1, 1, 60)
    assert w.period_label.text() == "60 秒"


def test_全画面にして戻すと元の場所に戻る(make_window, qapp):
    pytest.importorskip("PyQt6.QtWebEngineWidgets")
    w = make_window(initial_tool="graph3d").tool_window("graph3d")
    home = w.stage.parentWidget()
    w.enter_fullscreen()
    qapp.processEvents()
    assert w.stage.parentWidget() is not home
    w.exit_fullscreen()
    qapp.processEvents()
    assert w.stage.parentWidget() is home
