"""SVG座標取得タブ

SVGファイルを表示し、クリックした位置のSVG座標(x, y)を取得する。
クリックするたびに全点がクリップボードにタブ区切りでコピーされ、
スプレッドシートに2列でそのまま貼り付けられる。

同じ縦列・横列に並ぶ点の座標がわずかにずれないよう、次の2つでそろえられる:
  - 吸着（スナップ）: すでに取った点の x（または y）の近くをクリックすると、その値にぴったり合わせる。
    マウスを動かしている間は、合わせる先を青い点線で表示する。Alt（Mac は option）を押しながらだと吸着しない
  - 整列: 一覧で複数の点を選び、「縦にそろえる」で x を、「横にそろえる」で y を、選んだ点の平均にそろえる

もとは PyQt5 製の単独ツール（programs/SVG_Pointer/svg_picker.py）で、起動時にファイルを
選ぶ作りだった。タブとして開けるよう、ファイルはタブ内の「SVGを開く」で選ぶようにしている。
"""

from pathlib import Path

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PyQt6.QtSvgWidgets import QGraphicsSvgItem
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QFileDialog,
    QGraphicsItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QPushButton,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from ..common.paths import SVG_DIR

PIN_R = 6
PIN_FILL = QColor("#ff3333")
PIN_OUTLINE = QColor("white")
PIN_TEXT = QColor("#cc0000")
GUIDE_COLOR = QColor("#1e88e5")
SNAP_PX = 10   # 画面上でこのピクセル数以内なら、既存の点の x / y に吸着する（拡大率によらず同じ感覚になるよう画面の距離で決める）


def snap_point(x: float, y: float, points: list[tuple[float, float]], tolerance: float):
    """(x, y) を、既存の点の x・y のうち tolerance 以内で一番近いものに合わせる。

    x と y は別々に合わせる（縦の列にだけ合わせる・横の行にだけ合わせる・両方に合わせる、のどれもありうる）。
    戻り値は (合わせた x, 合わせた y, x を合わせた点の番号 or None, y を合わせた点の番号 or None)。番号は0始まり。
    """
    best_x = best_y = None
    for i, (px, py) in enumerate(points):
        dx, dy = abs(px - x), abs(py - y)
        if dx <= tolerance and (best_x is None or dx < abs(points[best_x][0] - x)):
            best_x = i
        if dy <= tolerance and (best_y is None or dy < abs(points[best_y][1] - y)):
            best_y = i
    sx = points[best_x][0] if best_x is not None else x
    sy = points[best_y][1] if best_y is not None else y
    return sx, sy, best_x, best_y


def align_points(points: list[tuple[float, float]], indices: list[int], axis: str) -> list[tuple[float, float]]:
    """indices の点の x（axis="x"、縦にそろえる）か y（axis="y"、横にそろえる）を、それらの平均にそろえた新しい一覧を返す"""
    if axis not in ("x", "y"):
        raise ValueError(axis)
    k = 0 if axis == "x" else 1
    mean = sum(points[i][k] for i in indices) / len(indices)
    result = list(points)
    for i in indices:
        p = list(result[i])
        p[k] = mean
        result[i] = (p[0], p[1])
    return result


class SVGView(QGraphicsView):
    """ズーム（ホイール・+/-）・パン（ドラッグ）・クリックでの座標取得"""

    def __init__(self, scene: QGraphicsScene, on_click, on_hover=None):
        super().__init__(scene)
        self._on_click = on_click
        self._on_hover = on_hover
        self._press_pos = None
        self.setMouseTracking(True)   # ボタンを押していなくても、マウスの位置で吸着のガイドを出すため

        self.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#e8e8e8")))

    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.position().toPoint()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        pos = event.position().toPoint()
        if event.button() == Qt.MouseButton.LeftButton and self._press_pos is not None:
            # 5px以内の移動ならクリック扱い（ドラッグと区別）
            if (pos - self._press_pos).manhattanLength() < 5:
                scene_pos = self.mapToScene(pos)
                self._on_click(scene_pos.x(), scene_pos.y(), snap=not self._snap_disabled(event))
            self._press_pos = None
        super().mouseReleaseEvent(event)

    def mouseMoveEvent(self, event):
        super().mouseMoveEvent(event)
        if self._on_hover is None:
            return
        if event.buttons() != Qt.MouseButton.NoButton:   # ドラッグ（パン）中はガイドを出さない
            self._on_hover(None)
            return
        scene_pos = self.mapToScene(event.position().toPoint())
        self._on_hover((scene_pos.x(), scene_pos.y()), snap=not self._snap_disabled(event))

    def leaveEvent(self, event):
        if self._on_hover is not None:
            self._on_hover(None)
        super().leaveEvent(event)

    @staticmethod
    def _snap_disabled(event) -> bool:
        return bool(event.modifiers() & Qt.KeyboardModifier.AltModifier)

    def snap_tolerance(self) -> float:
        """SNAP_PX（画面のピクセル）を、今の拡大率でのSVG座標の距離に直す"""
        scale = abs(self.transform().m11()) or 1.0
        return SNAP_PX / scale

    def keyPressEvent(self, event):
        k = event.key()
        if k in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.scale(1.25, 1.25)
        elif k == Qt.Key.Key_Minus:
            self.scale(0.8, 0.8)
        elif k == Qt.Key.Key_0:
            self.fit_all()
        else:
            super().keyPressEvent(event)

    def fit_all(self):
        rect = self.scene().itemsBoundingRect()
        if not rect.isEmpty():
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.svg_path: str | None = None
        self.points: list[tuple[float, float]] = []   # (svg_x, svg_y)
        self._svg_item: QGraphicsSvgItem | None = None
        self._guides: list = []   # 吸着のガイド（点線・予定位置）の図形

        self.setWindowTitle("SVG座標取得")
        self._build_ui()

    # ------------------------------------------------------------------ UI

    def _build_ui(self):
        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(8, 8, 8, 8)
        self.setCentralWidget(root)

        bar = QHBoxLayout()
        open_btn = QPushButton("SVGを開く…")
        open_btn.clicked.connect(self._choose_file)
        bar.addWidget(open_btn)
        self._file_label = QLabel("SVGファイルを開いてください（IKU NAVI のフロアマップは programs/html/svg/ にあります）")
        self._file_label.setStyleSheet("color:#555;")
        bar.addWidget(self._file_label, 1)
        layout.addLayout(bar)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter, 1)

        # 左: SVGビュー
        self._scene = QGraphicsScene()
        self._view = SVGView(self._scene, self._on_click, self._on_hover)
        splitter.addWidget(self._view)

        # 右: サイドパネル
        side = QWidget()
        side.setFixedWidth(300)
        side.setStyleSheet("background:#f5f5f5;")
        vl = QVBoxLayout(side)
        vl.setContentsMargins(8, 12, 8, 8)
        vl.setSpacing(4)

        vl.addWidget(QLabel("<b>取得座標一覧</b>"))

        self._list = QListWidget()
        self._list.setFont(QFont("Courier", 11))
        self._list.setStyleSheet("background:white; color:black;")
        # Shift・Cmd(Ctrl)クリックで複数選べる（整列に使う）
        self._list.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        vl.addWidget(self._list, 1)

        self._snap_check = QCheckBox("既存の点の x・y に吸着する")
        self._snap_check.setChecked(True)
        self._snap_check.setToolTip(
            f"すでに取った点の x（または y）から画面上で{SNAP_PX}px以内をクリックすると、その値にぴったり合わせます。\n"
            "Alt（Mac は option）を押しながらクリックすると、その時だけ吸着しません。"
        )
        self._snap_check.toggled.connect(lambda _checked: self._on_hover(None))
        vl.addWidget(self._snap_check)

        for label, fn, color in [
            ("選択した点を縦にそろえる（x）", lambda: self._align_selected("x"), "#1e88e5"),
            ("選択した点を横にそろえる（y）", lambda: self._align_selected("y"), "#1e88e5"),
            ("クリップボードにコピー (全点)", self._copy_all, "#4CAF50"),
            ("選択した点を削除", self._delete_selected, "#757575"),
            ("全消去", self._clear_all, "#e53935"),
        ]:
            btn = QPushButton(label)
            btn.clicked.connect(fn)
            btn.setStyleSheet(
                f"QPushButton{{background:{color};color:white;"
                f"padding:6px;border:none;border-radius:3px;}}"
            )
            vl.addWidget(btn)

        note = QLabel(
            "ズーム: スクロール / + −\n全体表示: キー 0\nパン: 左ドラッグ\n"
            "吸着しない: Alt(option)+クリック\n複数選択: Shift / Cmd(Ctrl)+クリック"
        )
        note.setStyleSheet("color:#888;font-size:10px;")
        vl.addWidget(note)

        splitter.addWidget(side)
        splitter.setSizes([980, 300])

        self.statusBar().showMessage("「SVGを開く…」でファイルを選んでください")

    # ------------------------------------------------------------------ ファイル

    def _choose_file(self):
        start_dir = str(Path(self.svg_path).parent) if self.svg_path else str(SVG_DIR)
        path, _ = QFileDialog.getOpenFileName(
            self, "SVGファイルを選択", start_dir, "SVG files (*.svg);;All files (*)",
        )
        if path:
            self.load_svg(path)

    def load_svg(self, path: str):
        """SVGを読み込み直す。取得済みの点は、別の図面の座標と混ざらないよう消す"""
        item = QGraphicsSvgItem(path)
        if item.boundingRect().isEmpty():
            self.statusBar().showMessage(f"SVGとして読み込めませんでした: {Path(path).name}")
            return
        self.svg_path = path
        self.points.clear()
        self._list.clear()
        self._scene.clear()
        self._guides = []
        self._svg_item = item
        self._scene.addItem(item)
        self._scene.setSceneRect(item.boundingRect())
        self._file_label.setText(path)
        self.setWindowTitle(f"SVG座標取得 — {Path(path).name}")
        self.statusBar().showMessage("SVGをクリックして座標を取得")
        # レイアウトが決まってから全体を表示する
        QTimer.singleShot(100, self._view.fit_all)

    # ------------------------------------------------------------------ ピン描画

    @staticmethod
    def _keep_screen_size(item, sx: float, sy: float, z: float):
        """図形を (sx, sy) に置き、拡大・縮小しても画面上の大きさが変わらないようにする
        （図面全体を表示しても点が小さくなりすぎず、並び具合が見えるように）"""
        item.setPos(sx, sy)
        item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations)
        item.setZValue(z)
        return item

    def _draw_pin(self, sx: float, sy: float, n: int):
        r = PIN_R
        pen_w = QPen(PIN_OUTLINE, 2)
        pen_r = QPen(PIN_FILL, 2)

        # 位置は (sx, sy) に置き、形は点を原点とした画面のピクセルで描く
        self._keep_screen_size(self._scene.addLine(0, -r - 8, 0, -r, pen_r), sx, sy, 10)
        self._keep_screen_size(self._scene.addEllipse(-r, -r, r * 2, r * 2, pen_w, QBrush(PIN_FILL)), sx, sy, 10)

        text = self._scene.addSimpleText(str(n))
        text.setBrush(QBrush(PIN_TEXT))
        text.setFont(QFont("Helvetica", 8, QFont.Weight.Bold))
        self._keep_screen_size(text, sx, sy, 10)
        text.setTransform(text.transform().translate(r + 2, -8))

    # ------------------------------------------------------------------ クリック

    def _snapped(self, sx: float, sy: float, snap: bool):
        """吸着を効かせた位置。吸着しない設定・Alt 押下中はそのまま返す"""
        if not snap or not self._snap_check.isChecked():
            return sx, sy, None, None
        return snap_point(sx, sy, self.points, self._view.snap_tolerance())

    def _on_click(self, sx: float, sy: float, snap: bool = True):
        # SVG未読み込み・SVG範囲外は無視
        if self._svg_item is None or not self._svg_item.boundingRect().contains(sx, sy):
            return

        sx, sy, from_x, from_y = self._snapped(sx, sy, snap)
        self._clear_guides()
        self.points.append((sx, sy))
        n = len(self.points)
        self._draw_pin(sx, sy, n)

        self._list.addItem(self._point_line(n, sx, sy))
        self._list.scrollToBottom()
        self._copy_all()
        snapped = []
        if from_x is not None:
            snapped.append(f"x を点 {from_x + 1} に合わせました")
        if from_y is not None:
            snapped.append(f"y を点 {from_y + 1} に合わせました")
        self.statusBar().showMessage(
            f"点 {n} 追加 → クリップボードにコピー済み  (x={sx:.3f}, y={sy:.3f})"
            + (f"  ／ {'・'.join(snapped)}" if snapped else "")
        )

    # ------------------------------------------------------------------ 吸着のガイド

    def _clear_guides(self):
        for item in self._guides:
            if item.scene() is self._scene:
                self._scene.removeItem(item)
        self._guides = []

    def _on_hover(self, pos, snap: bool = True):
        """マウスの位置に応じて、吸着する先を点線で、クリックしたら置かれる位置を薄い丸で示す"""
        self._clear_guides()
        if pos is None or self._svg_item is None or not self.points:
            return
        sx, sy, from_x, from_y = self._snapped(pos[0], pos[1], snap)
        if from_x is None and from_y is None:
            return
        rect = self._svg_item.boundingRect()
        pen = QPen(GUIDE_COLOR, 0, Qt.PenStyle.DashLine)   # 太さ0 = 拡大率によらず1px
        if from_x is not None:
            self._guides.append(self._scene.addLine(sx, rect.top(), sx, rect.bottom(), pen))
        if from_y is not None:
            self._guides.append(self._scene.addLine(rect.left(), sy, rect.right(), sy, pen))
        r = PIN_R
        ghost = self._scene.addEllipse(-r, -r, r * 2, r * 2, QPen(GUIDE_COLOR, 1.5), QBrush(QColor(30, 136, 229, 80)))
        self._keep_screen_size(ghost, sx, sy, 20)
        self._guides.append(ghost)
        for item in self._guides:
            item.setZValue(20)

    # ------------------------------------------------------------------ 整列

    def _selected_rows(self) -> list[int]:
        return sorted(self._list.row(item) for item in self._list.selectedItems())

    def _align_selected(self, axis: str):
        rows = self._selected_rows()
        if len(rows) < 2:
            self.statusBar().showMessage("そろえる点を一覧で2つ以上選んでください（Shift / Cmd(Ctrl)+クリック）")
            return
        self.points = align_points(self.points, rows, axis)
        self._redraw_all()
        self._rebuild_list()
        for row in rows:   # 続けて別の軸もそろえられるよう、選択を残す
            self._list.item(row).setSelected(True)
        self._copy_all()
        value = self.points[rows[0]][0 if axis == "x" else 1]
        direction = "縦" if axis == "x" else "横"
        self.statusBar().showMessage(
            f"{len(rows)} 点を{direction}にそろえました（{axis}={value:.3f}）→ クリップボードにコピー済み"
        )

    # ------------------------------------------------------------------ クリップボード

    def _copy_all(self):
        """タブ区切りでコピー（スプレッドシートに2列で貼り付けられる）"""
        if not self.points:
            return
        text = "\n".join(f"{x:.3f}\t{y:.3f}" for x, y in self.points)
        QApplication.clipboard().setText(text)

    # ------------------------------------------------------------------ リスト操作

    def _delete_selected(self):
        rows = self._selected_rows()
        if not rows:
            return
        for row in reversed(rows):
            self.points.pop(row)
        self._redraw_all()
        self._rebuild_list()
        self._copy_all()

    def _clear_all(self):
        self.points.clear()
        self._redraw_all()
        self._list.clear()
        QApplication.clipboard().clear()
        self.statusBar().showMessage("全消去しました")

    def _redraw_all(self):
        for item in list(self._scene.items()):
            if item is not self._svg_item:
                self._scene.removeItem(item)
        self._guides = []
        for i, (sx, sy) in enumerate(self.points, 1):
            self._draw_pin(sx, sy, i)

    def _rebuild_list(self):
        self._list.clear()
        for i, (x, y) in enumerate(self.points, 1):
            self._list.addItem(self._point_line(i, x, y))

    @staticmethod
    def _point_line(n: int, x: float, y: float) -> str:
        return f"{n:>3}: {x:>10.3f}, {y:>10.3f}"
