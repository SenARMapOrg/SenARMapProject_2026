"""SVG座標取得タブ（PyQt5 から移植）"""
import pytest

pytest.importorskip("PyQt6.QtWidgets")

from PyQt6.QtWidgets import QApplication  # noqa: E402

from iku_tools.common.paths import SVG_DIR  # noqa: E402


@pytest.fixture
def svg_tab(qapp):
    from iku_tools.svg_pointer.window import MainWindow
    w = MainWindow()
    w.show()
    qapp.processEvents()
    yield w
    w.close()


def test_SVGを開くまではクリックしても何も起きない(svg_tab):
    svg_tab._on_click(10, 10)
    assert svg_tab.points == []


def test_フロアマップを開いてクリックすると座標がクリップボードに入る(svg_tab):
    svg = sorted(SVG_DIR.glob("*.svg"))[0]
    svg_tab.load_svg(str(svg))
    rect = svg_tab._svg_item.boundingRect()
    svg_tab._on_click(rect.center().x(), rect.center().y())
    svg_tab._on_click(rect.left() + 1, rect.top() + 1)
    assert len(svg_tab.points) == 2
    assert svg_tab._list.count() == 2
    lines = QApplication.clipboard().text().splitlines()
    assert len(lines) == 2 and "\t" in lines[0]


def test_図面の外のクリックは無視する(svg_tab):
    svg = sorted(SVG_DIR.glob("*.svg"))[0]
    svg_tab.load_svg(str(svg))
    rect = svg_tab._svg_item.boundingRect()
    svg_tab._on_click(rect.right() + 100, rect.bottom() + 100)
    assert svg_tab.points == []


def test_別の図面を開くと前の点は消える(svg_tab):
    svgs = sorted(SVG_DIR.glob("*.svg"))
    svg_tab.load_svg(str(svgs[0]))
    rect = svg_tab._svg_item.boundingRect()
    svg_tab._on_click(rect.center().x(), rect.center().y())
    svg_tab.load_svg(str(svgs[-1]))
    assert svg_tab.points == [] and svg_tab._list.count() == 0


def test_SVGでないファイルは読み込まずに知らせる(svg_tab, tmp_path):
    bad = tmp_path / "not.svg"
    bad.write_text("これはSVGではない", encoding="utf-8")
    svg_tab.load_svg(str(bad))
    assert svg_tab.svg_path is None
    assert "読み込めません" in svg_tab.statusBar().currentMessage()
