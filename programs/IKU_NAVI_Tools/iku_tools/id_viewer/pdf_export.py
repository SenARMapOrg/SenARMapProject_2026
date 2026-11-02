"""ID一覧タブ — PDF で保存（建物ごとに、1ページ1フロア・A3横）

フロアマップ（SVG）を描き、その上にノードID・エッジIDを重ねる。画面とは違い、フロアマップの座標
（svg_x・svg_y）にそのまま置くので、位置合わせが要らない（ノードが1〜2個しかない階や、x・y との
位置合わせのずれが大きい階でも重ねられる）。svg_x・svg_y が無いノードは、同じ階のほかのノードから
位置を推定し、オレンジの点線で囲む（data.svg_positions）。フロアマップが無い階は飛ばす。

大きさは紙の上の mm で決める（印刷しても番号が読める大きさ）。
"""

from __future__ import annotations

import math

from PyQt6.QtCore import QMarginsF, QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QFont, QFontMetricsF, QPageLayout, QPageSize, QPainter, QPdfWriter, QPen
from PyQt6.QtSvg import QSvgRenderer

from ..common.fonts import ui_font
from . import data as d

RESOLUTION = 300          # PDF の中で使う解像度（dpi）
MARGIN_MM = 8.0
NODE_TEXT_MM = 2.9        # ノード番号の文字の高さ
EDGE_TEXT_MM = 2.5        # エッジ番号
CROSS_TEXT_MM = 2.3       # ほかの階へつながる線
LINE_MM = 0.85            # エッジの線の太さ
NODE_FILL = {1: "#334155", 2: "#DC2626"}   # 通常・出入口（画面と同じ）
EDGE_COLOR = {1: "#64748B", 2: "#16A34A", 3: "#9333EA", 4: "#2563EB", 5: "#9333EA", 6: "#9333EA", 7: "#EA580C"}
GUESSED = "#F59E0B"


def _edge_color(t: int) -> QColor:
    return QColor(EDGE_COLOR.get(t, EDGE_COLOR[1]))


class _Page:
    """1ページ分の描画。mm → PDF の座標（dpi）への換算と、札を描く部品"""

    def __init__(self, painter: QPainter):
        self.p = painter
        self.mm = RESOLUTION / 25.4

    def font(self, size_mm: float, bold: bool = True) -> QFont:
        f = QFont(ui_font(10, bold=bold))
        f.setPixelSize(max(1, round(size_mm * self.mm)))
        return f

    def tag_rect(self, text: str, size_mm: float, round_: bool) -> QRectF:
        fm = QFontMetricsF(self.font(size_mm))
        h = fm.height() * (1.2 if round_ else 1.15)
        w = max(h, fm.horizontalAdvance(text) + h * (0.5 if round_ else 0.45))
        return QRectF(-w / 2, -h / 2, w, h)

    def tag(self, text: str, center: QPointF, size_mm: float, fill: QColor, fg: QColor,
            border: QColor | None = None, round_: bool = True, dashed: QColor | None = None):
        """番号の札（round_=True でノードの丸、False でエッジの四角）"""
        r = self.tag_rect(text, size_mm, round_).translated(center)
        pen = QPen(border or QColor("white"), max(1.0, r.height() * (0.09 if border else 0.1)))
        if dashed is not None:
            pen = QPen(dashed, r.height() * 0.14, Qt.PenStyle.DashLine)
        self.p.setPen(pen)
        self.p.setBrush(fill)
        radius = r.height() / 2 if round_ else r.height() * 0.18
        self.p.drawRoundedRect(r, radius, radius)
        self.p.setPen(fg)
        self.p.setFont(self.font(size_mm))
        self.p.drawText(r, Qt.AlignmentFlag.AlignCenter, text)
        return r


def _floor_page(page: _Page, g: d.BuildingGraph, floor, area: QRectF, label) -> list[str]:
    """area（PDF の座標）にその階のフロアマップと番号を描く。下に書く注意書きを返す"""
    p = page.p
    renderer = QSvgRenderer(str(d.svg_path(g.building, floor)))
    vb = renderer.viewBoxF()
    if vb.isEmpty():
        vb = QRectF(0, 0, renderer.defaultSize().width(), renderer.defaultSize().height())
    # SVG の viewBox を area にはみ出さないように合わせる（縦横比はそのまま、真ん中に置く）
    s = min(area.width() / vb.width(), area.height() / vb.height())
    target = QRectF(0, 0, vb.width() * s, vb.height() * s)
    target.moveCenter(area.center())
    renderer.render(p, target)

    def at(svg_xy) -> QPointF:
        return QPointF(target.left() + (svg_xy[0] - vb.left()) * s, target.top() + (svg_xy[1] - vb.top()) * s)

    nodes = g.floor_nodes(floor)
    edges = g.floor_edges(floor)
    svg_pos, guessed, missing = d.svg_positions(nodes)
    pos = {nid: at(xy) for nid, xy in svg_pos.items()}
    node_r = page.tag_rect("00", NODE_TEXT_MM, True).height() / 2

    # 線
    for e in edges:
        if e.frm in pos and e.to in pos:
            pen = QPen(_edge_color(e.type), LINE_MM * page.mm)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            p.setPen(pen)
            p.drawLine(pos[e.frm], pos[e.to])

    # ノード（線の上）
    node_rects = {}
    for n in nodes:
        if n.id in pos:
            fill = QColor(NODE_FILL.get(n.type, NODE_FILL[1]))
            node_rects[n.id] = page.tag(label(n.id), pos[n.id], NODE_TEXT_MM, fill, QColor("white"),
                                        dashed=QColor(GUESSED) if n.id in guessed else None)

    # エッジの番号（線の真ん中。線が短く両端の丸に隠れるときは、線の横にずらす）
    for e in edges:
        if e.frm in pos and e.to in pos:
            a, b = pos[e.frm], pos[e.to]
            c = (a + b) / 2
            text = f"e{label(e.id)}"
            r = page.tag_rect(text, EDGE_TEXT_MM, False)
            length = math.hypot(b.x() - a.x(), b.y() - a.y())
            if length < 2 * node_r + r.width() + 0.6 * page.mm:
                nx, ny = ((a.y() - b.y()) / length, (b.x() - a.x()) / length) if length > 0 else (0.0, 1.0)
                if ny < 0 or (ny == 0 and nx < 0):   # 下か右へずらす
                    nx, ny = -nx, -ny
                off = node_r + max(r.width(), r.height()) / 2
                c = QPointF(c.x() + nx * off, c.y() + ny * off)
            page.tag(text, c, EDGE_TEXT_MM, QColor("white"), _edge_color(e.type), _edge_color(e.type), round_=False)

    # ほかの階へつながる線（ノードの下に積む）
    below: dict[int, float] = {}
    for c in g.cross_edges(floor):
        if c.here.id not in node_rects:
            continue
        kind = d.EDGE_TYPE_LABELS.get(c.edge.type, "")
        if c.other is None:
            where = "→相手なし"
        elif c.other.floor is None or floor is None:
            where = f"→{d.floor_name(c.other.floor)}"
        else:
            where = ("↑" if c.other.floor > floor else "↓") + d.floor_name(c.other.floor)
        text = f"e{label(c.edge.id)} {kind}{where}"
        r = page.tag_rect(text, CROSS_TEXT_MM, False)
        top = below.get(c.here.id, node_rects[c.here.id].bottom() + 0.3 * page.mm)
        center = QPointF(pos[c.here.id].x(), top + r.height() / 2)
        page.tag(text, center, CROSS_TEXT_MM, QColor("white"), _edge_color(c.edge.type), _edge_color(c.edge.type),
                 round_=False)
        below[c.here.id] = top + r.height() + 0.3 * page.mm

    notes = [f"ノード {len(nodes)} 個・この階の中のエッジ {len(edges)} 本"]
    if guessed:
        notes.append("オレンジの点線 = svg_x・svg_y が無く、x・y から位置を推定したノード（"
                     + "・".join(label(i) for i in sorted(guessed)) + "）")
    if missing:
        notes.append("svg_x・svg_y が無く位置を推定できないため描いていないノード："
                     + "・".join(label(i) for i in missing))
    return notes


def export_building_pdf(g: d.BuildingGraph, path: str, global_ids: bool = False) -> list:
    """その建物の、フロアマップがある階を1ページずつ PDF にする。描いた階のリストを返す（無ければ空で、ファイルも作らない）"""
    floors = [f for f in g.floors() if d.svg_path(g.building, f) is not None]
    if not floors:
        return []

    def label(local_id: int) -> str:
        return str(g.global_id(local_id) if global_ids else local_id)

    writer = QPdfWriter(path)
    writer.setResolution(RESOLUTION)
    writer.setPageLayout(QPageLayout(QPageSize(QPageSize.PageSizeId.A3), QPageLayout.Orientation.Landscape,
                                     QMarginsF(MARGIN_MM, MARGIN_MM, MARGIN_MM, MARGIN_MM), QPageLayout.Unit.Millimeter))
    writer.setTitle(f"{g.building}号館 ID一覧")
    painter = QPainter(writer)
    painter.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.TextAntialiasing)
    page = _Page(painter)
    mm = page.mm
    full = QRectF(0, 0, writer.width(), writer.height())
    id_note = ("番号は全体ID（建物番号×100000＋番号）" if global_ids
               else f"番号は node.csv・edge.csv の id（全体ID = {g.building}×100000 + id）")
    legend = ("線の色：灰＝通路　緑＝階段　紫＝エスカレーター　青＝エレベーター　橙＝出入口　／　"
              "丸の色：紺＝ノード　赤＝出入口のノード　／　ノードの下の「e12 階段↑3階」＝ほかの階へつながる線")

    for i, floor in enumerate(floors):
        if i:
            writer.newPage()
        # 見出し
        painter.setPen(QColor("#0F172A"))
        painter.setFont(page.font(6.3))
        title = f"{g.building}号館 {d.floor_name(floor)}"
        painter.drawText(QRectF(0, 0, full.width(), 9 * mm), Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, title)
        title_w = QFontMetricsF(page.font(6.3)).horizontalAdvance(title)
        painter.setPen(QColor("#475569"))
        painter.setFont(page.font(3.2, bold=False))
        painter.drawText(QRectF(title_w + 6 * mm, 0, full.width(), 9 * mm),
                         Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, id_note)
        painter.setPen(QPen(QColor("#0F172A"), 0.4 * mm))
        painter.drawLine(QPointF(0, 10 * mm), QPointF(full.width(), 10 * mm))

        area = QRectF(0, 12 * mm, full.width(), full.height() - 12 * mm - 12 * mm)
        notes = _floor_page(page, g, floor, area, label)

        painter.setPen(QColor("#334155"))
        painter.setFont(page.font(3.0, bold=False))
        painter.drawText(QRectF(0, full.height() - 11 * mm, full.width(), 5 * mm),
                         Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, "　／　".join(notes))
        painter.drawText(QRectF(0, full.height() - 5.5 * mm, full.width(), 5 * mm),
                         Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, legend)
    painter.end()
    return floors
