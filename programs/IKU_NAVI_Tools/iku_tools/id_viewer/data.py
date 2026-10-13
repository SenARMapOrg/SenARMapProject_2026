"""ID一覧タブ — データ層（読み取りだけ。CSV には書き込まない）

data/{建物}_bldg/node.csv・edge.csv を読み、階ごとのノード・エッジに分ける。

画面の座標は、ノードの x・y（建物ごとの座標、m）から決める。docs/XYZ_Design.md の定義
（X: 山を登る方向、Y: X の右向き）に合わせて、X を画面の上、Y を画面の右に向ける。
フロアマップ（SVG）の座標（svg_x・svg_y）が入っていない建物・ノードがあるため、SVG の座標では描かない。
SVG は、svg_x・svg_y と x・y の両方が入っているノードから位置合わせ（アフィン変換）を求められたときだけ、
背景として重ねる。
"""

from __future__ import annotations

import csv
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..common.paths import DATA_DIR, SVG_DIR, building_dir

ID_OFFSET = 100_000      # 全体ID = 建物番号 × 100000 + 番号（programs/3D_Graph/ikunavi/config.py の ID_OFFSET と同じ）
SCALE = 20.0             # 画面の座標で 1m を何単位で描くか
SVG_FIT_LIMIT = 3.0      # 位置合わせのずれ（m、二乗平均）がこれより大きければ、SVG を重ねない

NODE_TYPE_LABELS = {1: "通常", 2: "出入口"}
EDGE_TYPE_LABELS = {
    1: "通路", 2: "階段", 3: "エスカレーター", 4: "エレベーター",
    5: "上りエスカレーター", 6: "下りエスカレーター", 7: "出入口",
}
VERTICAL_TYPES = {2, 3, 4, 5, 6}


def _int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _float(v, default=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def floor_name(floor) -> str:
    """0 以下は地下（0 = 地下1階）、階が入っていなければ「階なし」"""
    if floor is None:
        return "階なし"
    return f"地下{1 - floor}階" if floor <= 0 else f"{floor}階"


def to_screen(x: float, y: float) -> tuple[float, float]:
    """建物の座標（m）→ 画面の座標（X が上、Y が右）"""
    return y * SCALE, -x * SCALE


@dataclass
class Node:
    id: int
    x: float
    y: float
    z: float
    floor: int | None
    type: int
    svg: tuple[float, float] | None = None

    @property
    def pos(self) -> tuple[float, float]:
        return to_screen(self.x, self.y)


@dataclass
class Edge:
    id: int
    frm: int
    to: int
    type: int
    length: float | None = None
    name: str = ""
    left: str = ""
    right: str = ""


@dataclass
class CrossEdge:
    """端の片方だけがこの階にある線（階段・エレベーターなど）。other は相手のノード（無ければ None）"""
    edge: Edge
    here: Node
    other: Node | None


@dataclass
class BuildingGraph:
    building: int
    nodes: dict[int, Node] = field(default_factory=dict)
    edges: dict[int, Edge] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)   # 読めなかった行など

    def global_id(self, local_id: int) -> int:
        return self.building * ID_OFFSET + local_id

    def floors(self) -> list:
        """ある階の一覧（下から順。階が入っていないノードがあれば最後に None）"""
        fs = {n.floor for n in self.nodes.values()}
        return sorted(f for f in fs if f is not None) + ([None] if None in fs else [])

    def floor_nodes(self, floor) -> list[Node]:
        return sorted((n for n in self.nodes.values() if n.floor == floor), key=lambda n: n.id)

    def floor_edges(self, floor) -> list[Edge]:
        """両端がこの階にある線"""
        out = []
        for e in self.edges.values():
            a, b = self.nodes.get(e.frm), self.nodes.get(e.to)
            if a and b and a.floor == floor and b.floor == floor:
                out.append(e)
        return sorted(out, key=lambda e: e.id)

    def cross_edges(self, floor) -> list[CrossEdge]:
        """片方の端だけがこの階にある線（ほかの階・相手が見つからないものも含む）"""
        out = []
        for e in self.edges.values():
            a, b = self.nodes.get(e.frm), self.nodes.get(e.to)
            for here, other in ((a, b), (b, a)):
                if here and here.floor == floor and not (other and other.floor == floor):
                    out.append(CrossEdge(e, here, other))
        return sorted(out, key=lambda c: (c.edge.id, c.here.id))

    def edge_floor(self, edge_id: int):
        """線を描く階（from の階。from が無ければ to の階）。線が無いか両端とも無ければ (False, None)"""
        e = self.edges.get(edge_id)
        if not e:
            return False, None
        for nid in (e.frm, e.to):
            if nid in self.nodes:
                return True, self.nodes[nid].floor
        return False, None


def list_buildings() -> list[int]:
    ids = []
    for p in DATA_DIR.glob("*_bldg"):
        m = re.fullmatch(r"(\d+)_bldg", p.name)
        if m and (p / "node.csv").exists():
            ids.append(int(m.group(1)))
    return sorted(ids)


def _rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in csv.DictReader(f)]


def load_building(building: int) -> BuildingGraph:
    g = BuildingGraph(building)
    d = building_dir(building)
    for i, row in enumerate(_rows(d / "node.csv"), start=2):
        if not any(v for k, v in row.items() if k != "id"):
            continue   # id だけの空の行（スプレッドシートから書き出すと末尾に残る）
        nid, x, y = _int(row.get("id")), _float(row.get("x")), _float(row.get("y"))
        if nid is None or x is None or y is None:
            g.problems.append(f"node.csv {i}行目: id・x・y を読めないため表示していません")
            continue
        sx, sy = _float(row.get("svg_x")), _float(row.get("svg_y"))
        g.nodes[nid] = Node(nid, x, y, _float(row.get("z"), 0.0), _int(row.get("floor")),
                            _int(row.get("type"), 1), (sx, sy) if sx is not None and sy is not None else None)
    for i, row in enumerate(_rows(d / "edge.csv"), start=2):
        if not any(v for k, v in row.items() if k != "id"):
            continue
        eid, a, b = _int(row.get("id")), _int(row.get("from")), _int(row.get("to"))
        if eid is None or a is None or b is None:
            g.problems.append(f"edge.csv {i}行目: id・from・to を読めないため表示していません")
            continue
        g.edges[eid] = Edge(eid, a, b, _int(row.get("type"), 1), _float(row.get("length")),
                            row.get("name", ""), row.get("left", ""), row.get("right", ""))
    return g


def svg_path(building: int, floor) -> Path | None:
    if floor is None:
        return None
    p = SVG_DIR / f"{building}_{floor}F.svg"
    return p if p.exists() else None


def _solve3(m: list[list[float]], v: list[float]):
    """3元の連立1次方程式（ガウスの消去法）。解けなければ None"""
    a = [row[:] + [v[i]] for i, row in enumerate(m)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(a[r][c]))
        if abs(a[p][c]) < 1e-9:
            return None
        a[c], a[p] = a[p], a[c]
        for r in range(3):
            if r != c:
                k = a[r][c] / a[c][c]
                a[r] = [a[r][j] - k * a[c][j] for j in range(4)]
    return [a[i][3] / a[i][i] for i in range(3)]


def fit_svg(nodes: list[Node]):
    """svg_x・svg_y → 画面の座標 のアフィン変換を、両方が入っているノードから最小二乗で求める。

    戻り値は (m11, m12, m21, m22, dx, dy, ずれ[m]) で、画面の x = m11*svg_x + m21*svg_y + dx、
    画面の y = m12*svg_x + m22*svg_y + dy（QTransform と同じ並び）。求められなければ None。
    """
    pairs = [(n.svg, n.pos) for n in nodes if n.svg is not None]
    if len(pairs) < 3:
        return None
    ata = [[0.0] * 3 for _ in range(3)]
    atx, aty = [0.0] * 3, [0.0] * 3
    for (u, v), (px, py) in pairs:
        row = (u, v, 1.0)
        for i in range(3):
            for j in range(3):
                ata[i][j] += row[i] * row[j]
            atx[i] += row[i] * px
            aty[i] += row[i] * py
    cx, cy = _solve3(ata, atx), _solve3(ata, aty)
    if cx is None or cy is None:
        return None   # 点が一直線に並んでいるなど
    err = 0.0
    for (u, v), (px, py) in pairs:
        qx = cx[0] * u + cx[1] * v + cx[2]
        qy = cy[0] * u + cy[1] * v + cy[2]
        err += (qx - px) ** 2 + (qy - py) ** 2
    rms = math.sqrt(err / len(pairs)) / SCALE
    return cx[0], cy[0], cx[1], cy[1], cx[2], cy[2], rms
