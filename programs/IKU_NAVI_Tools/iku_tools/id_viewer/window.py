"""ID一覧タブ

建物・階ごとに、今のマップデータ（data/{建物}_bldg/node.csv・edge.csv）のノードとエッジを描き、
ノードIDとエッジIDを、クリックで選ばなくてもすべて地図の上に表示する。読み取りだけで、CSV は変更しない。

  - 左の一覧で建物・階を選ぶ（階ごとのノード数・エッジ数も出す）
  - ノードは丸（赤は出入口）の中に番号、エッジは線の真ん中の四角に番号（枠の色が線の種類）
  - 階段・エレベーターなど、ほかの階へつながる線は、ノードの下に「番号 種類↑行き先の階」で出す
  - フロアマップ（SVG）は、位置を合わせられる階だけ背景に重ねる（svg_x・svg_y が入っていない建物は、
    座標 x・y だけで描き、5m ごとの方眼を敷く）
  - 番号は建物ごとの番号と、全体ID（建物番号 × 100000 + 番号）を切り替えられる
  - 右の表でも一覧でき、行を選ぶと地図のその場所に寄る。上の欄に番号を入れても探せる
  - 「画像で保存」で、表示している階を PNG にできる（印刷・共有用）
  - スプレッドシートから CSV を取り込み直したら「再読み込み」
"""

from __future__ import annotations

import re
from pathlib import Path

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QBrush, QColor, QFont, QFontMetricsF, QImage, QPainter, QPainterPath, QPen, QTransform
from PyQt6.QtSvgWidgets import QGraphicsSvgItem
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QFileDialog,
    QGraphicsItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QSlider,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..common.fonts import ui_font
from . import data as d

NODE_FILL = {1: QColor("#334155"), 2: QColor("#DC2626")}   # 通常・出入口
EDGE_COLOR = {
    1: QColor("#64748B"),   # 通路
    2: QColor("#16A34A"),   # 階段
    3: QColor("#9333EA"),   # エスカレーター
    4: QColor("#2563EB"),   # エレベーター
    5: QColor("#9333EA"),
    6: QColor("#9333EA"),
    7: QColor("#EA580C"),   # 出入口
}
EDGE_COLOR_DEFAULT = QColor("#64748B")
HIGHLIGHT = QColor("#F59E0B")
GRID_COLOR = QColor("#D5DAE1")
GRID_STEP = 5.0           # 方眼の間隔（m）
NODE_FONT = 13.0          # ノード番号の文字の大きさ（画面のピクセル。拡大縮小しても同じ大きさで読める）
EDGE_FONT = 11.0
EXPORT_LONG_SIDE = 4000   # 画像で保存するときの長い辺のピクセル数
EXPORT_TEXT = 2.5         # 画像で保存するとき、番号を画面の何倍の大きさで描くか


def edge_color(t: int) -> QColor:
    return EDGE_COLOR.get(t, EDGE_COLOR_DEFAULT)


class TagItem(QGraphicsItem):
    """番号の札。round=True なら丸（ノード）、False なら四角（エッジ）。

    拡大縮小しても画面の上で同じ大きさ（size ピクセル）で描く（地図を縮めても番号が読め、広げると札どうしが離れる）。
    札の中心は center から下へ offset ピクセルずらした所（ノードの下に積む札に使う）
    """

    def __init__(self, text: str, center: QPointF, size: float, fill: QColor, fg: QColor,
                 border: QColor | None = None, round_: bool = True, offset: float = 0.0):
        super().__init__()
        self.text = text
        self._fill, self._fg, self._border, self._round = fill, fg, border, round_
        self._font = QFont(ui_font(10, bold=round_))
        self._font.setPixelSize(max(1, round(size)))
        fm = QFontMetricsF(self._font)
        h = fm.height() * (1.25 if round_ else 1.2)
        w = max(h, fm.horizontalAdvance(text) + h * (0.55 if round_ else 0.45))
        self._rect = QRectF(-w / 2, offset - h / 2, w, h)
        self.setPos(center)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations)

    @property
    def rect(self) -> QRectF:
        return QRectF(self._rect)

    def boundingRect(self) -> QRectF:
        return self._rect.adjusted(-1, -1, 1, 1)

    def paint(self, painter: QPainter, option, widget=None):
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        pen = QPen(self._border, max(1.0, self._rect.height() * 0.09)) if self._border else QPen(QColor("white"), self._rect.height() * 0.08)
        painter.setPen(pen)
        painter.setBrush(QBrush(self._fill))
        r = self._rect.height() / 2 if self._round else self._rect.height() * 0.18
        painter.drawRoundedRect(self._rect, r, r)
        painter.setPen(self._fg)
        painter.setFont(self._font)
        painter.drawText(self._rect, Qt.AlignmentFlag.AlignCenter, self.text)


class MapView(QGraphicsView):
    """ホイール・+/- で拡大縮小、ドラッグで移動、0 で全体"""

    def __init__(self, scene: QGraphicsScene):
        super().__init__(scene)
        self.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform
                            | QPainter.RenderHint.TextAntialiasing)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QBrush(QColor("#F3F5F8")))

    focus: QRectF | None = None   # 「全体を表示」で合わせる範囲（ノードのある範囲）

    def fit_all(self):
        rect = self.focus if self.focus is not None else self.scene().itemsBoundingRect()
        if not rect.isEmpty():
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event):
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

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


def _num_item(value) -> QTableWidgetItem:
    """数値として並べ替えられる表のセル"""
    item = QTableWidgetItem()
    if value is None or value == "":
        item.setData(Qt.ItemDataRole.DisplayRole, "")
    else:
        item.setData(Qt.ItemDataRole.DisplayRole, value)
    return item


def _fmt(v) -> str:
    return "" if v is None else f"{v:g}"


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("ID一覧")
        self._graphs: dict[int, d.BuildingGraph] = {}
        self._building: int | None = None
        self._floor = None
        self._items: dict[tuple[str, int], QGraphicsItem] = {}   # ("node" | "edge", 番号) → 地図の上の札・線
        self._highlight: list[QGraphicsItem] = []

        root = QWidget()
        layout = QVBoxLayout(root)
        layout.setContentsMargins(8, 8, 8, 4)
        layout.setSpacing(6)
        layout.addLayout(self._build_toolbar())

        split = QSplitter(Qt.Orientation.Horizontal)
        self._tree = QTreeWidget()
        self._tree.setHeaderHidden(True)
        self._tree.setMinimumWidth(210)
        self._tree.currentItemChanged.connect(self._on_tree_changed)
        split.addWidget(self._tree)

        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(4)
        self._scene = QGraphicsScene(self)
        self._view = MapView(self._scene)
        cl.addWidget(self._view, 1)
        legend = QLabel(
            '<span style="color:#334155">●</span> ノード（<span style="color:#DC2626">●</span> 出入口）　'
            '<span style="color:#64748B">■</span> エッジ：枠の色が種類（'
            '<span style="color:#64748B">通路</span>・<span style="color:#16A34A">階段</span>・'
            '<span style="color:#2563EB">エレベーター</span>・<span style="color:#9333EA">エスカレーター</span>・'
            '<span style="color:#EA580C">出入口</span>）　ノードの下の札は、ほかの階へつながる線'
        )
        legend.setStyleSheet("color:#475569; font-size:12px;")
        legend.setWordWrap(True)
        cl.addWidget(legend)
        split.addWidget(center)

        self._tables = QTabWidget()
        self._node_table = self._make_table(["ID", "全体ID", "種類", "x", "y", "z", "SVG座標"])
        self._edge_table = self._make_table(["ID", "全体ID", "from", "to", "種類", "長さ", "name", "left", "right"])
        self._node_table.itemSelectionChanged.connect(lambda: self._on_table_selected("node", self._node_table))
        self._edge_table.itemSelectionChanged.connect(lambda: self._on_table_selected("edge", self._edge_table))
        self._tables.addTab(self._node_table, "ノード")
        self._tables.addTab(self._edge_table, "エッジ")
        self._tables.setMinimumWidth(300)
        split.addWidget(self._tables)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 1)
        split.setStretchFactor(2, 0)
        split.setSizes([230, 900, 380])
        layout.addWidget(split, 1)
        self.setCentralWidget(root)

        self.reload()

    # ------------------------------------------------------------------ 画面の部品

    def _build_toolbar(self) -> QHBoxLayout:
        bar = QHBoxLayout()
        bar.setSpacing(10)
        reload_btn = QPushButton("再読み込み")
        reload_btn.setToolTip("data/ の CSV を読み直す（スプレッドシートから取り込み直したあとに）")
        reload_btn.clicked.connect(self.reload)
        bar.addWidget(reload_btn)

        self._search = QLineEdit()
        self._search.setPlaceholderText("番号で探す（例: 12 ／ e12 でエッジ ／ 1000012）")
        self._search.setClearButtonEnabled(True)
        self._search.setMinimumWidth(320)
        self._search.returnPressed.connect(lambda: self.find_id(self._search.text()))
        bar.addWidget(self._search)

        self._show_nodes = QCheckBox("ノードID")
        self._show_edges = QCheckBox("エッジID")
        self._show_cross = QCheckBox("ほかの階への線")
        self._show_svg = QCheckBox("フロアマップ")
        self._global_ids = QCheckBox("全体IDで表示")
        self._global_ids.setToolTip("建物番号 × 100000 + 番号（経路API・edge_image.csv で使う番号）")
        for cb, on in ((self._show_nodes, True), (self._show_edges, True), (self._show_cross, True),
                       (self._show_svg, True), (self._global_ids, False)):
            cb.setChecked(on)
            cb.toggled.connect(lambda _on: self.redraw(keep_view=True))
            bar.addWidget(cb)
        self._global_ids.toggled.connect(lambda _on: self._fill_tables())

        bar.addWidget(QLabel("文字"))
        self._text_size = QSlider(Qt.Orientation.Horizontal)
        self._text_size.setRange(50, 250)
        self._text_size.setValue(100)
        self._text_size.setFixedWidth(110)
        self._text_size.setToolTip("番号の文字の大きさ")
        self._text_size.valueChanged.connect(lambda _v: self.redraw(keep_view=True))
        bar.addWidget(self._text_size)
        bar.addStretch(1)

        fit_btn = QPushButton("全体を表示")
        fit_btn.clicked.connect(self._view_fit)
        bar.addWidget(fit_btn)
        save_btn = QPushButton("画像で保存")
        save_btn.setToolTip("表示している階を PNG で保存する")
        save_btn.clicked.connect(self.save_image)
        bar.addWidget(save_btn)
        return bar

    def _view_fit(self):
        self._view.fit_all()

    def _make_table(self, headers: list[str]) -> QTableWidget:
        t = QTableWidget(0, len(headers))
        t.setHorizontalHeaderLabels(headers)
        t.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        t.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        t.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        t.verticalHeader().setVisible(False)
        t.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        t.horizontalHeader().setStretchLastSection(True)
        t.setSortingEnabled(True)
        return t

    # ------------------------------------------------------------------ 読み込み

    def reload(self):
        """CSV を読み直して、建物・階の一覧を作り直す（見ていた階はそのまま）"""
        keep = (self._building, self._floor)
        self._graphs = {b: d.load_building(b) for b in d.list_buildings()}
        self._tree.blockSignals(True)
        self._tree.clear()
        target = first = None
        for b, g in self._graphs.items():
            top = QTreeWidgetItem([f"{b}号館"])
            top.setData(0, Qt.ItemDataRole.UserRole, (b, "building"))
            top.setFont(0, ui_font(11, bold=True))
            self._tree.addTopLevelItem(top)
            for f in g.floors():
                child = QTreeWidgetItem([f"{d.floor_name(f)}　ノード{len(g.floor_nodes(f))} エッジ{len(g.floor_edges(f))}"])
                child.setData(0, Qt.ItemDataRole.UserRole, (b, f))
                top.addChild(child)
                first = first or child
                if (b, f) == keep:
                    target = child
            top.setExpanded(True)
        self._tree.blockSignals(False)
        target = target or first
        self._building = None   # 同じ階でも描き直す
        if target is not None:
            self._tree.setCurrentItem(target)
        else:
            self._scene.clear()
            self.statusBar().showMessage("data/ に建物のデータ（{建物}_bldg/node.csv）が見つかりません")

    def _on_tree_changed(self, item: QTreeWidgetItem, _prev):
        if item is None:
            return
        b, f = item.data(0, Qt.ItemDataRole.UserRole)
        if f == "building":   # 建物の行を選んだら、その建物の一番下の階
            if item.childCount():
                self._tree.setCurrentItem(item.child(0))
            return
        self.show_floor(b, f)

    def select_floor(self, building: int, floor) -> bool:
        """左の一覧でその階を選ぶ（選べたら True）"""
        for i in range(self._tree.topLevelItemCount()):
            top = self._tree.topLevelItem(i)
            for j in range(top.childCount()):
                child = top.child(j)
                if child.data(0, Qt.ItemDataRole.UserRole) == (building, floor):
                    self._tree.setCurrentItem(child)
                    return True
        return False

    def show_floor(self, building: int, floor):
        self._building, self._floor = building, floor
        self.setWindowTitle(f"ID一覧 — {building}号館 {d.floor_name(floor)}")
        self.redraw()
        self._fill_tables()

    # ------------------------------------------------------------------ 描画

    def _label(self, local_id: int) -> str:
        if self._global_ids.isChecked():
            return str(self._graphs[self._building].global_id(local_id))
        return str(local_id)

    def redraw(self, keep_view: bool = False):
        if self._building is None:
            return
        g = self._graphs[self._building]
        f = self._floor
        k = self._text_size.value() / 100
        transform = self._view.transform() if keep_view else None
        center = self._view.mapToScene(self._view.viewport().rect().center()) if keep_view else None
        self._scene.clear()
        self._items.clear()
        self._highlight.clear()

        nodes = g.floor_nodes(f)
        edges = g.floor_edges(f)
        cross = g.cross_edges(f)
        notes = []

        # 背景: 位置を合わせられればフロアマップ、合わせられなければ 5m ごとの方眼
        svg_shown = False
        svg = d.svg_path(self._building, f)
        if self._show_svg.isChecked() and svg is not None:
            fit = d.fit_svg(nodes)
            if fit is None:
                notes.append("フロアマップ: SVG上の位置（svg_x・svg_y）が入ったノードが3つ未満のため重ねていません")
            elif fit[6] > d.SVG_FIT_LIMIT:
                notes.append(f"フロアマップ: 位置合わせのずれが大きい（{fit[6]:.1f}m）ため重ねていません")
            else:
                item = QGraphicsSvgItem(str(svg))
                item.setTransform(QTransform(*fit[:6]))
                item.setOpacity(0.5)
                item.setZValue(0)
                self._scene.addItem(item)
                svg_shown = True
                notes.append(f"フロアマップ: 重ねています（位置合わせのずれ {fit[6]:.1f}m）")
        elif svg is None and f is not None:
            notes.append(f"フロアマップ: {self._building}_{f}F.svg がありません")
        if not svg_shown and nodes:
            self._draw_grid(nodes)

        # 線
        for e in edges:
            a, b = g.nodes[e.frm].pos, g.nodes[e.to].pos
            pen = QPen(edge_color(e.type), 5)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            line = self._scene.addLine(a[0], a[1], b[0], b[1], pen)
            line.setZValue(1)
            self._items[("edge", e.id)] = line
            if self._show_edges.isChecked():
                tag = TagItem(self._label(e.id), QPointF((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), EDGE_FONT * k,
                              QColor("white"), QColor("#1E293B"), edge_color(e.type), round_=False)
                tag.setZValue(3)
                tag.setToolTip(self._edge_tip(g, e))
                self._scene.addItem(tag)
                self._items[("edge", e.id)] = tag

        # ノード
        node_tags = {}
        for n in nodes:
            x, y = n.pos
            fill = NODE_FILL.get(n.type, NODE_FILL[1])
            if self._show_nodes.isChecked():
                tag = TagItem(self._label(n.id), QPointF(x, y), NODE_FONT * k, fill, QColor("white"))
            else:
                tag = TagItem("", QPointF(x, y), NODE_FONT * k * 0.6, fill, QColor("white"))
            tag.setZValue(4)
            tag.setToolTip(self._node_tip(g, n))
            self._scene.addItem(tag)
            self._items[("node", n.id)] = tag
            node_tags[n.id] = tag

        # ほかの階へつながる線（ノードの下に積む）
        if self._show_cross.isChecked():
            stacked: dict[int, float] = {}   # ノードの番号 → 次の札を置く高さ（ノードの中心から下へ何ピクセルか）
            for c in cross:
                parent = node_tags.get(c.here.id)
                if parent is None:
                    continue
                x, y = c.here.pos
                top = stacked.get(c.here.id, parent.rect.bottom() + 2)
                kind = d.EDGE_TYPE_LABELS.get(c.edge.type, "")
                if c.other is None:
                    where = "→相手なし"
                elif c.other.floor is None or c.here.floor is None:
                    where = f"→{d.floor_name(c.other.floor)}"
                else:
                    where = ("↑" if c.other.floor > c.here.floor else "↓") + d.floor_name(c.other.floor)
                text = f"{self._label(c.edge.id)} {kind}{where}"
                probe = TagItem(text, QPointF(x, y), EDGE_FONT * k * 0.9, QColor("white"), QColor("#1E293B"))
                h = probe.rect.height()
                tag = TagItem(text, QPointF(x, y), EDGE_FONT * k * 0.9, QColor("white"), QColor("#1E293B"),
                              edge_color(c.edge.type), round_=False, offset=top + h / 2)
                tag.setZValue(5)
                tag.setToolTip(self._edge_tip(g, c.edge))
                self._scene.addItem(tag)
                self._items.setdefault(("edge", c.edge.id), tag)
                stacked[c.here.id] = top + h + 1

        # 「全体を表示」は、ノードのある範囲に合わせる（フロアマップは建物の外まで広いことがあるため）
        if nodes:
            xs = [n.pos[0] for n in nodes]
            ys = [n.pos[1] for n in nodes]
            pad = 4 * d.SCALE
            self._view.focus = QRectF(min(xs) - pad, min(ys) - pad, max(xs) - min(xs) + 2 * pad, max(ys) - min(ys) + 2 * pad)
        else:
            self._view.focus = None
        rect = self._scene.itemsBoundingRect()
        self._scene.setSceneRect(rect.adjusted(-400, -400, 400, 400))
        if keep_view and transform is not None:
            self._view.setTransform(transform)
            self._view.centerOn(center)
        else:
            self._view.fit_all()

        counts = f"ノード {len(nodes)}・エッジ {len(edges)}（ほかの階へ {len(cross)}）"
        if g.problems:
            notes.append(f"読めなかった行 {len(g.problems)}件（{g.problems[0]} など）")
        self.statusBar().showMessage(f"{self._building}号館 {d.floor_name(f)} — {counts}　" + "　".join(notes))

    def _draw_grid(self, nodes: list[d.Node]):
        xs = [n.pos[0] for n in nodes]
        ys = [n.pos[1] for n in nodes]
        step = GRID_STEP * d.SCALE
        x0, x1 = (min(xs) // step - 1) * step, (max(xs) // step + 2) * step
        y0, y1 = (min(ys) // step - 1) * step, (max(ys) // step + 2) * step
        pen = QPen(GRID_COLOR, 1)
        pen.setCosmetic(True)
        x = x0
        while x <= x1:
            self._scene.addLine(x, y0, x, y1, pen).setZValue(0)
            x += step
        y = y0
        while y <= y1:
            self._scene.addLine(x0, y, x1, y, pen).setZValue(0)
            y += step

    def _node_tip(self, g: d.BuildingGraph, n: d.Node) -> str:
        return (f"ノード {n.id}（全体ID {g.global_id(n.id)}）\n{d.NODE_TYPE_LABELS.get(n.type, n.type)}"
                f"　x={n.x:g} y={n.y:g} z={n.z:g}")

    def _edge_tip(self, g: d.BuildingGraph, e: d.Edge) -> str:
        lines = [f"エッジ {e.id}（全体ID {g.global_id(e.id)}）　{d.EDGE_TYPE_LABELS.get(e.type, e.type)}",
                 f"from {e.frm} → to {e.to}" + (f"　長さ {e.length:g}m" if e.length is not None else "")]
        if e.name:
            lines.append(f"name: {e.name}")
        if e.left or e.right:
            lines.append(f"left: {e.left}　right: {e.right}")
        return "\n".join(lines)

    # ------------------------------------------------------------------ 表

    def _fill_tables(self):
        if self._building is None:
            return
        g = self._graphs[self._building]
        f = self._floor
        nodes = g.floor_nodes(f)
        rows = [(e, "") for e in g.floor_edges(f)]
        seen = {e.id for e, _ in rows}
        for c in g.cross_edges(f):
            if c.edge.id not in seen:
                seen.add(c.edge.id)
                rows.append((c.edge, f"（→{d.floor_name(c.other.floor)}）" if c.other else "（相手なし）"))

        t = self._node_table
        t.setSortingEnabled(False)
        t.setRowCount(len(nodes))
        for r, n in enumerate(nodes):
            cells = [_num_item(n.id), _num_item(g.global_id(n.id)),
                     QTableWidgetItem(d.NODE_TYPE_LABELS.get(n.type, str(n.type))),
                     QTableWidgetItem(_fmt(n.x)), QTableWidgetItem(_fmt(n.y)), QTableWidgetItem(_fmt(n.z)),
                     QTableWidgetItem("あり" if n.svg else "なし")]
            for c, item in enumerate(cells):
                t.setItem(r, c, item)
            t.item(r, 0).setData(Qt.ItemDataRole.UserRole, n.id)
        t.setSortingEnabled(True)
        t.sortItems(0)

        t = self._edge_table
        t.setSortingEnabled(False)
        t.setRowCount(len(rows))
        for r, (e, extra) in enumerate(rows):
            cells = [_num_item(e.id), _num_item(g.global_id(e.id)), _num_item(e.frm), _num_item(e.to),
                     QTableWidgetItem(d.EDGE_TYPE_LABELS.get(e.type, str(e.type)) + extra),
                     QTableWidgetItem(_fmt(e.length)), QTableWidgetItem(e.name),
                     QTableWidgetItem(e.left), QTableWidgetItem(e.right)]
            for c, item in enumerate(cells):
                t.setItem(r, c, item)
            t.item(r, 0).setData(Qt.ItemDataRole.UserRole, e.id)
        t.setSortingEnabled(True)
        t.sortItems(0)
        self._tables.setTabText(0, f"ノード（{len(nodes)}）")
        self._tables.setTabText(1, f"エッジ（{len(rows)}）")

    def _on_table_selected(self, kind: str, table: QTableWidget):
        rows = table.selectionModel().selectedRows()
        if rows:
            item = table.item(rows[0].row(), 0)
            if item is not None:
                self.highlight(kind, item.data(Qt.ItemDataRole.UserRole))

    # ------------------------------------------------------------------ 探す・目立たせる

    def highlight(self, kind: str, local_id: int) -> bool:
        """その番号のノード・エッジを橙の枠で囲み、そこへ寄る（今の階に無ければ False）"""
        for item in self._highlight:
            self._scene.removeItem(item)
        self._highlight.clear()
        item = self._items.get((kind, local_id))
        if item is None:
            return False
        pen = QPen(HIGHLIGHT, 4)
        pen.setCosmetic(True)
        if isinstance(item, TagItem):
            path = QPainterPath()
            path.addRoundedRect(item.rect.adjusted(-7, -7, 7, 7), 8, 8)
            ring = self._scene.addPath(path, pen)
            ring.setPos(item.pos())
            ring.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations)
        else:   # 番号を出していない線は、線そのものを太くなぞる
            pen.setWidth(9)
            ring = self._scene.addLine(item.line(), pen)
        ring.setZValue(10)
        self._highlight.append(ring)
        self._view.centerOn(item.pos() if isinstance(item, TagItem) else item.line().center())
        return True

    def find_id(self, text: str) -> bool:
        """「12」（ノード優先）・「e12」（エッジ）・「n12」（ノード）・全体ID「1000012」で探して、その階を開いて寄る"""
        m = re.fullmatch(r"\s*([neNE]?)\s*(\d+)\s*", text or "")
        if not m:
            self.statusBar().showMessage("番号を入れてください（例: 12 ／ e12 ／ 1000012）")
            return False
        prefix, num = m.group(1).lower(), int(m.group(2))
        building = self._building
        if num >= d.ID_OFFSET:   # 全体ID
            building, num = num // d.ID_OFFSET, num % d.ID_OFFSET
        g = self._graphs.get(building)
        if g is None:
            self.statusBar().showMessage(f"{building}号館のデータがありません")
            return False
        found = None
        if prefix != "e" and num in g.nodes:
            found = ("node", g.nodes[num].floor)
        elif prefix != "n":
            ok, floor = g.edge_floor(num)
            if ok:
                found = ("edge", floor)
        if found is None:
            what = {"e": "エッジ", "n": "ノード"}.get(prefix, "ノード・エッジ")
            self.statusBar().showMessage(f"{building}号館に{what} {num} は見つかりませんでした")
            return False
        kind, floor = found
        if (building, floor) != (self._building, self._floor):
            self.select_floor(building, floor)
        ok = self.highlight(kind, num)
        if ok:
            both = kind == "node" and prefix == "" and num in g.edges
            self.statusBar().showMessage(
                f"{building}号館 {d.floor_name(floor)} の{'ノード' if kind == 'node' else 'エッジ'} {num}"
                + ("（同じ番号のエッジは e をつけて探せます）" if both else ""))
        return ok

    # ------------------------------------------------------------------ 画像で保存

    def save_image(self):
        if self._building is None:
            return
        name = f"{self._building}号館_{d.floor_name(self._floor)}_ID一覧.png"
        path, _ = QFileDialog.getSaveFileName(self, "画像で保存", str(Path.home() / name), "PNG 画像 (*.png)")
        if path:
            self.export_png(path)

    def export_png(self, path: str) -> bool:
        """表示している階の地図を、長い辺 EXPORT_LONG_SIDE ピクセルの PNG にする"""
        for item in self._highlight:   # 目印は画像に入れない
            item.setVisible(False)
        rect = self._scene.itemsBoundingRect()
        if self._view.focus is not None:
            rect = rect.intersected(self._view.focus.adjusted(-200, -200, 200, 200))
        scale = EXPORT_LONG_SIDE / max(rect.width(), rect.height(), 1)
        # 札は画面では拡大縮小によらない大きさなので、画像の中では地図に合わせて EXPORT_TEXT 倍の大きさで描く
        tags = [i for i in self._scene.items() if isinstance(i, TagItem)]
        for t in tags:
            t.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations, False)
            t.setScale(EXPORT_TEXT / scale)
        image = QImage(max(1, round(rect.width() * scale)), max(1, round(rect.height() * scale)),
                       QImage.Format.Format_ARGB32)
        image.fill(QColor("white"))
        painter = QPainter(image)
        painter.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.TextAntialiasing
                               | QPainter.RenderHint.SmoothPixmapTransform)
        self._scene.render(painter, QRectF(0, 0, image.width(), image.height()), rect)
        painter.end()
        for t in tags:
            t.setScale(1.0)
            t.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIgnoresTransformations)
        for item in self._highlight:
            item.setVisible(True)
        ok = image.save(path, "PNG")
        self.statusBar().showMessage(f"保存しました: {path}" if ok else f"保存できませんでした: {path}")
        return ok
