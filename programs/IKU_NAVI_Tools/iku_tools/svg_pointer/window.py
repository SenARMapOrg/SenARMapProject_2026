"""SVG座標取得タブ

SVGファイルを表示し、クリックした位置のSVG座標(x, y)を取得する。
クリックするたびに全点がクリップボードにタブ区切りでコピーされ、
スプレッドシートに2列でそのまま貼り付けられる。

もとは PyQt5 製の単独ツール（programs/SVG_Pointer/svg_picker.py）で、起動時にファイルを
選ぶ作りだった。タブとして開けるよう、ファイルはタブ内の「SVGを開く」で選ぶようにしている。
"""

from pathlib import Path

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PyQt6.QtSvgWidgets import QGraphicsSvgItem
from PyQt6.QtWidgets import (
    QApplication,
    QFileDialog,
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


class SVGView(QGraphicsView):
    """ズーム（ホイール・+/-）・パン（ドラッグ）・クリックでの座標取得"""

    def __init__(self, scene: QGraphicsScene, on_click):
        super().__init__(scene)
        self._on_click = on_click
        self._press_pos = None

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
                self._on_click(scene_pos.x(), scene_pos.y())
            self._press_pos = None
        super().mouseReleaseEvent(event)

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
        self._view = SVGView(self._scene, self._on_click)
        splitter.addWidget(self._view)

        # 右: サイドパネル
        side = QWidget()
        side.setFixedWidth(240)
        side.setStyleSheet("background:#f5f5f5;")
        vl = QVBoxLayout(side)
        vl.setContentsMargins(8, 12, 8, 8)
        vl.setSpacing(4)

        vl.addWidget(QLabel("<b>取得座標一覧</b>"))

        self._list = QListWidget()
        self._list.setFont(QFont("Courier", 11))
        self._list.setStyleSheet("background:white; color:black;")
        vl.addWidget(self._list, 1)

        for label, fn, color in [
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

        note = QLabel("ズーム: スクロール / + −\n全体表示: キー 0\nパン: 左ドラッグ")
        note.setStyleSheet("color:#888;font-size:10px;")
        vl.addWidget(note)

        splitter.addWidget(side)
        splitter.setSizes([1040, 240])

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
        self._svg_item = item
        self._scene.addItem(item)
        self._scene.setSceneRect(item.boundingRect())
        self._file_label.setText(path)
        self.setWindowTitle(f"SVG座標取得 — {Path(path).name}")
        self.statusBar().showMessage("SVGをクリックして座標を取得")
        # レイアウトが決まってから全体を表示する
        QTimer.singleShot(100, self._view.fit_all)

    # ------------------------------------------------------------------ ピン描画

    def _draw_pin(self, sx: float, sy: float, n: int):
        r = PIN_R
        pen_w = QPen(PIN_OUTLINE, 2)
        pen_r = QPen(PIN_FILL, 2)

        line = self._scene.addLine(sx, sy - r - 8, sx, sy - r, pen_r)
        line.setZValue(10)

        circle = self._scene.addEllipse(sx - r, sy - r, r * 2, r * 2, pen_w, QBrush(PIN_FILL))
        circle.setZValue(10)

        text = self._scene.addSimpleText(str(n))
        text.setPos(sx + r + 2, sy - 8)
        text.setBrush(QBrush(PIN_TEXT))
        text.setFont(QFont("Helvetica", 8, QFont.Weight.Bold))
        text.setZValue(10)

    # ------------------------------------------------------------------ クリック

    def _on_click(self, sx: float, sy: float):
        # SVG未読み込み・SVG範囲外は無視
        if self._svg_item is None or not self._svg_item.boundingRect().contains(sx, sy):
            return

        self.points.append((sx, sy))
        n = len(self.points)
        self._draw_pin(sx, sy, n)

        self._list.addItem(self._point_line(n, sx, sy))
        self._list.scrollToBottom()
        self._copy_all()
        self.statusBar().showMessage(
            f"点 {n} 追加 → クリップボードにコピー済み  (x={sx:.3f}, y={sy:.3f})"
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
        row = self._list.currentRow()
        if row < 0:
            return
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
        for i, (sx, sy) in enumerate(self.points, 1):
            self._draw_pin(sx, sy, i)

    def _rebuild_list(self):
        self._list.clear()
        for i, (x, y) in enumerate(self.points, 1):
            self._list.addItem(self._point_line(i, x, y))

    @staticmethod
    def _point_line(n: int, x: float, y: float) -> str:
        return f"{n:>3}: {x:>10.3f}, {y:>10.3f}"
