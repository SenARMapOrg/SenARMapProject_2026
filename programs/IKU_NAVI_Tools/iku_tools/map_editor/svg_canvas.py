#!/usr/bin/env python3
"""
IKU NAVI Map Editor — SVG描画キャンバス
SVGフロアマップを表示し、モードに応じてクリックを解釈する QGraphicsView。

モード:
  MOVE    … 表示のみ。クリックは何もしない（常時ドラッグでパン可能）
  INPUT   … 空白クリックでノード作成要求 / 既存ノードクリックでエッジ接続要求
  DELETE  … 既存ノード・エッジのクリックで削除要求
  CAMERA  … 既存エッジのクリックで撮影対象として選択

ドラッグ（一定以上の移動）は常にパンとして扱い、クリック（ほぼ移動なし）だけが
モード固有のアクションを発火する。ズームはホイールで常時可能。
"""

from PyQt6.QtCore import Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QFont, QPainter, QPen
from PyQt6.QtSvgWidgets import QGraphicsSvgItem
from PyQt6.QtWidgets import QGraphicsLineItem, QGraphicsScene, QGraphicsView

NODE_COLOR = {1: QColor("#3B82F6"), 2: QColor("#EF4444")}
NODE_COLOR_DEFAULT = QColor("#3B82F6")
NODE_COLOR_PENDING = QColor("#F59E0B")

EDGE_COLOR = {
    1: QColor("#94A3B8"),
    2: QColor("#8B5CF6"),
    3: QColor("#8B5CF6"),
    4: QColor("#10B981"),
    5: QColor("#10B981"),
    6: QColor("#10B981"),
    7: QColor("#F97316"),
}
EDGE_COLOR_DEFAULT = QColor("#94A3B8")
EDGE_COLOR_HIGHLIGHT = QColor("#F59E0B")

ROLE_ID, ROLE_KIND = 0, 1


class SvgCanvas(QGraphicsView):

    MODE_MOVE, MODE_INPUT, MODE_DELETE, MODE_CAMERA = "move", "input", "delete", "camera"

    nodeCreateRequested  = pyqtSignal(float, float)   # svg_x, svg_y
    edgeCreateRequested  = pyqtSignal(int, int)       # node_a_id, node_b_id
    nodeDeleteRequested  = pyqtSignal(int)            # node_id
    edgeDeleteRequested  = pyqtSignal(int)            # edge_id
    edgeSelectedForPhoto = pyqtSignal(int)            # edge_id
    pendingNodeChanged   = pyqtSignal(object)         # node_id | None

    def __init__(self, parent=None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#e8e8e8")))

        self._mode = self.MODE_MOVE
        self._svg_item = None
        self._press_pos = None
        self._pending_node_id = None   # 入力モード: エッジ接続待ちの先頭ノード
        self._pending_item = None
        self._highlight_item = None

    # ------------------------------------------------------------------
    # SVG 読み込み
    # ------------------------------------------------------------------
    def load_svg(self, svg_path: str) -> bool:
        self._scene.clear()
        self._svg_item = None
        self._pending_node_id = None
        self._highlight_item = None
        try:
            item = QGraphicsSvgItem(svg_path)
        except Exception:
            return False
        if item.boundingRect().isEmpty():
            return False
        self._svg_item = item
        self._scene.addItem(item)
        self._scene.setSceneRect(item.boundingRect())
        QTimer.singleShot(50, self.fit_all)
        return True

    def clear_svg(self):
        self._scene.clear()
        self._svg_item = None
        self._pending_node_id = None
        self._highlight_item = None

    def has_svg(self) -> bool:
        return self._svg_item is not None

    def fit_all(self):
        if self._svg_item is not None:
            self.fitInView(self._svg_item.boundingRect(), Qt.AspectRatioMode.KeepAspectRatio)

    # ------------------------------------------------------------------
    # モード
    # ------------------------------------------------------------------
    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str):
        self._mode = mode
        self.clear_pending()

    def clear_pending(self):
        self._pending_node_id = None
        self.highlight_edge(None)
        self.pendingNodeChanged.emit(None)

    # ------------------------------------------------------------------
    # 描画: ノード・エッジ
    # ------------------------------------------------------------------
    def render_nodes_edges(self, nodes_draw: list, edges_draw: list):
        """
        nodes_draw: [{"id", "sx", "sy", "type", "label"}, ...]
        edges_draw: [{"id", "sx0","sy0","sx1","sy1", "type", "label"}, ...]
        既存の動的アイテム（ノード/エッジ）だけを消して再描画する（SVG本体は残す）
        """
        for item in list(self._scene.items()):
            if item is not self._svg_item:
                self._scene.removeItem(item)
        self._highlight_item = None

        r = self._marker_radius()

        for e in edges_draw:
            color = EDGE_COLOR.get(e.get("type"), EDGE_COLOR_DEFAULT)
            pen = QPen(color, max(3.0, r * 0.5))
            pen.setCosmetic(False)
            line = self._scene.addLine(e["sx0"], e["sy0"], e["sx1"], e["sy1"], pen)
            line.setData(ROLE_ID, e["id"])
            line.setData(ROLE_KIND, "edge")
            line.setZValue(5)

        for n in nodes_draw:
            color = NODE_COLOR.get(n.get("type"), NODE_COLOR_DEFAULT)
            if n["id"] == self._pending_node_id:
                color = NODE_COLOR_PENDING
            pen = QPen(QColor("white"), max(1.5, r * 0.2))
            circle = self._scene.addEllipse(
                n["sx"] - r, n["sy"] - r, r * 2, r * 2, pen, QBrush(color)
            )
            circle.setData(ROLE_ID, n["id"])
            circle.setData(ROLE_KIND, "node")
            circle.setZValue(10)

            label = n.get("label")
            if label:
                text = self._scene.addSimpleText(str(label))
                text.setPos(n["sx"] + r + 2, n["sy"] - r - 4)
                text.setBrush(QBrush(QColor("#1E293B")))
                text.setFont(QFont("Helvetica", max(7, int(r))))
                text.setZValue(11)

    def highlight_edge(self, edge_id):
        for item in self._scene.items():
            if isinstance(item, QGraphicsLineItem) and item.data(ROLE_KIND) == "edge":
                pen = item.pen()
                if edge_id is not None and item.data(ROLE_ID) == edge_id:
                    pen.setColor(EDGE_COLOR_HIGHLIGHT)
                    pen.setWidthF(max(pen.widthF(), 6.0))
                    self._highlight_item = item
                else:
                    pen.setColor(EDGE_COLOR.get(item.data(ROLE_ID), EDGE_COLOR_DEFAULT))
                item.setPen(pen)

    def _marker_radius(self) -> float:
        if self._svg_item is None:
            return 10.0
        rect = self._svg_item.boundingRect()
        diag = (rect.width() ** 2 + rect.height() ** 2) ** 0.5
        return max(8.0, diag / 160)

    # ------------------------------------------------------------------
    # イベント
    # ------------------------------------------------------------------
    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._press_pos = event.pos()
        elif event.button() == Qt.MouseButton.RightButton:
            self.clear_pending()
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event):
        if (event.button() == Qt.MouseButton.LeftButton and self._press_pos is not None
                and (event.pos() - self._press_pos).manhattanLength() < 5):
            self._handle_click(event.pos())
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
        elif k == Qt.Key.Key_Escape:
            self.clear_pending()
        else:
            super().keyPressEvent(event)

    # ------------------------------------------------------------------
    def _hit_item(self, pos):
        """クリック位置にある node/edge アイテムを1つ返す（ノード優先）"""
        node_item, edge_item = None, None
        for item in self.items(pos):
            kind = item.data(ROLE_KIND)
            if kind == "node" and node_item is None:
                node_item = item
            elif kind == "edge" and edge_item is None:
                edge_item = item
        return node_item or edge_item, (node_item is not None)

    def _handle_click(self, pos):
        item, is_node = self._hit_item(pos)

        if self._mode == self.MODE_MOVE:
            return

        if self._mode == self.MODE_INPUT:
            if item is None:
                if self._svg_item is None:
                    return
                sp = self.mapToScene(pos)
                if self._svg_item.boundingRect().contains(sp):
                    self.nodeCreateRequested.emit(sp.x(), sp.y())
                return
            if is_node:
                node_id = item.data(ROLE_ID)
                if self._pending_node_id is None:
                    self._pending_node_id = node_id
                    self.pendingNodeChanged.emit(node_id)
                elif self._pending_node_id == node_id:
                    self.clear_pending()
                else:
                    a, b = self._pending_node_id, node_id
                    self.clear_pending()
                    self.edgeCreateRequested.emit(a, b)
            return

        if self._mode == self.MODE_DELETE:
            if item is None:
                return
            if is_node:
                self.nodeDeleteRequested.emit(item.data(ROLE_ID))
            else:
                self.edgeDeleteRequested.emit(item.data(ROLE_ID))
            return

        if self._mode == self.MODE_CAMERA:
            if item is not None and not is_node:
                self.edgeSelectedForPhoto.emit(item.data(ROLE_ID))
