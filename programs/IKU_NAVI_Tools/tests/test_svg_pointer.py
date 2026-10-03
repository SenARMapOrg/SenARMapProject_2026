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


# ---------------------------------------------------------------- 吸着・整列

def test_snap_pointは近い既存の点のxとyに別々に合わせる():
    from iku_tools.svg_pointer.window import snap_point
    points = [(100.0, 50.0), (300.0, 200.0)]
    # x は点1（100）に近い、y はどれにも近くない → x だけ合わせる
    assert snap_point(102.5, 120.0, points, 5) == (100.0, 120.0, 0, None)
    # x は点1、y は点2 に近い → 両方合わせる
    assert snap_point(97.0, 203.0, points, 5) == (100.0, 200.0, 0, 1)
    # どれからも遠い → そのまま
    assert snap_point(200.0, 120.0, points, 5) == (200.0, 120.0, None, None)
    # 候補が複数あれば一番近い方
    assert snap_point(101.0, 0, [(98.0, 999.0), (102.0, 999.0)], 5)[0] == 102.0


def test_align_pointsは選んだ点だけを平均にそろえる():
    from iku_tools.svg_pointer.window import align_points
    points = [(100.0, 10.0), (103.0, 20.0), (500.0, 30.0), (97.0, 40.0)]
    got = align_points(points, [0, 1, 3], "x")
    assert got == [(100.0, 10.0), (100.0, 20.0), (500.0, 30.0), (100.0, 40.0)]
    assert points[1] == (103.0, 20.0)   # 元の一覧は書き換えない
    assert align_points(points, [0, 1], "y") == [(100.0, 15.0), (103.0, 15.0), (500.0, 30.0), (97.0, 40.0)]


def open_floor(svg_tab):
    svg = sorted(SVG_DIR.glob("*.svg"))[0]
    svg_tab.load_svg(str(svg))
    return svg_tab._svg_item.boundingRect()


def test_既存の点の近くをクリックすると同じxにそろう(svg_tab):
    rect = open_floor(svg_tab)
    tol = svg_tab._view.snap_tolerance()
    x0, y0 = rect.center().x(), rect.top() + rect.height() * 0.2
    svg_tab._on_click(x0, y0)
    svg_tab._on_click(x0 + tol * 0.5, y0 + rect.height() * 0.5)   # 少し横にずれた、下の方の点
    assert svg_tab.points[1][0] == svg_tab.points[0][0]
    assert "x を点 1 に合わせました" in svg_tab.statusBar().currentMessage()
    assert QApplication.clipboard().text().splitlines()[1].split("\t")[0] == f"{x0:.3f}"


def test_吸着を切る_またはAlt押下中は吸着しない(svg_tab):
    rect = open_floor(svg_tab)
    tol = svg_tab._view.snap_tolerance()
    x0, y0 = rect.center().x(), rect.top() + rect.height() * 0.2
    svg_tab._on_click(x0, y0)
    svg_tab._on_click(x0 + tol * 0.5, y0 + rect.height() * 0.3, snap=False)   # Alt+クリック
    assert svg_tab.points[1][0] == pytest.approx(x0 + tol * 0.5)
    svg_tab._snap_check.setChecked(False)
    svg_tab._on_click(x0 + tol * 0.4, y0 + rect.height() * 0.6)
    assert svg_tab.points[2][0] == pytest.approx(x0 + tol * 0.4)


def test_マウスを近づけると吸着先のガイドが出て_離すと消える(svg_tab):
    rect = open_floor(svg_tab)
    tol = svg_tab._view.snap_tolerance()
    x0, y0 = rect.center().x(), rect.top() + rect.height() * 0.2
    svg_tab._on_click(x0, y0)
    svg_tab._on_hover((x0 + tol * 0.5, y0 + rect.height() * 0.5))
    assert len(svg_tab._guides) == 2     # 縦の点線 + 置かれる位置の丸
    svg_tab._on_hover((x0 + tol * 5, y0 + rect.height() * 0.5))
    assert svg_tab._guides == []
    svg_tab._on_hover((x0 + tol * 0.5, y0 + rect.height() * 0.5))
    svg_tab._on_hover(None)               # 図面の外にマウスが出た
    assert svg_tab._guides == []


def test_一覧で選んだ点を縦にそろえて_クリップボードも更新する(svg_tab):
    rect = open_floor(svg_tab)
    svg_tab._snap_check.setChecked(False)
    cx, top, h = rect.center().x(), rect.top(), rect.height()
    for dx, fy in [(0, 0.1), (3, 0.3), (-3, 0.5), (200, 0.7)]:
        svg_tab._on_click(cx + dx, top + h * fy)
    for row in (0, 1, 2):
        svg_tab._list.item(row).setSelected(True)
    svg_tab._align_selected("x")
    xs = [p[0] for p in svg_tab.points]
    assert xs[0] == xs[1] == xs[2] == pytest.approx(cx)
    assert xs[3] == pytest.approx(cx + 200)   # 選んでいない点はそのまま
    assert svg_tab._list.count() == 4 and len(svg_tab._selected_rows()) == 3
    assert {line.split("\t")[0] for line in QApplication.clipboard().text().splitlines()[:3]} == {f"{cx:.3f}"}


def test_1点しか選んでいなければそろえずに知らせる(svg_tab):
    rect = open_floor(svg_tab)
    svg_tab._on_click(rect.center().x(), rect.center().y())
    svg_tab._list.item(0).setSelected(True)
    before = list(svg_tab.points)
    svg_tab._align_selected("y")
    assert svg_tab.points == before
    assert "2つ以上" in svg_tab.statusBar().currentMessage()


def test_選択した複数の点をまとめて削除する(svg_tab):
    rect = open_floor(svg_tab)
    svg_tab._snap_check.setChecked(False)
    for fy in (0.1, 0.4, 0.7):
        svg_tab._on_click(rect.center().x(), rect.top() + rect.height() * fy)
    svg_tab._list.item(0).setSelected(True)
    svg_tab._list.item(2).setSelected(True)
    svg_tab._delete_selected()
    assert len(svg_tab.points) == 1 and svg_tab._list.count() == 1
