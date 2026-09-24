#!/usr/bin/env python3
"""
IKU NAVI Map Editor — データ層
data/{building}_bldg/node.csv・edge.csv・data/edge_image.csv の読み書きを担当する。

座標系・CSV仕様は docs/XYZ_Design.md に準拠:
  - node.csv: id,x,y,z,building,floor,type[,svg_x,svg_y]  (建物ローカル座標)
  - edge.csv: id,name,from,to,building,floor,weight,length,type
  - edge_image.csv: id,from,to,image_name  (from/to はグローバルID)
  - グローバルID = building * 100000 + ローカルID (app.py の ID_OFFSET と同じ)
"""

import csv
import re
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common.paths import DATA_DIR, PHOTO_DIR, REPO_ROOT, SVG_DIR  # noqa: F401  (他モジュールが data_store 経由で参照する)

ID_OFFSET = 100_000  # programs/3D_Graph/ikunavi/config.py の ID_OFFSET と一致させること

NODE_TYPE_LABELS = {1: "通常ノード", 2: "出入り口"}
EDGE_TYPE_LABELS = {
    1: "通常通路",
    2: "階段",
    3: "エスカレータ(両方向)",
    4: "エレベータ",
    5: "上りエスカレータ",
    6: "下りエスカレータ",
    7: "入口(屋内外接続)",
}


def to_int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def to_float(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def global_id(building: int, local_id: int) -> int:
    return int(building) * ID_OFFSET + int(local_id)


def svg_path_for(building: int, floor: int) -> Path:
    return SVG_DIR / f"{building}_{floor}F.svg"


def list_buildings() -> list:
    """data/*_bldg ディレクトリから建物IDの一覧を返す"""
    ids = []
    if not DATA_DIR.exists():
        return ids
    for p in sorted(DATA_DIR.glob("*_bldg")):
        m = re.match(r"(\d+)_bldg", p.name)
        if m:
            ids.append(int(m.group(1)))
    return ids


def _read_csv_by_id(path: Path) -> dict:
    """id列をキーとする辞書として CSV を読み込む（存在しなければ空の辞書を返す）"""
    rows = {}
    if not path.exists():
        return rows
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid = to_int(row.get("id"))
            if rid is None:
                continue
            rows[rid] = dict(row)
    return rows


def _write_csv(path: Path, cols: list, rows: dict):
    """id をキーとする辞書の内容を、id昇順でCSVに書き出す"""
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        for key in sorted(rows):
            row = rows[key]
            w.writerow({c: row.get(c, "") for c in cols})


class BuildingData:
    """1建物分の node.csv / edge.csv をメモリに保持し、読み書きする"""

    NODE_BASE_COLS = ["id", "x", "y", "z", "building", "floor", "type"]
    EDGE_COLS = ["id", "name", "from", "to", "building", "floor", "weight", "length", "type"]

    def __init__(self, building: int):
        self.building = building
        self.dir = DATA_DIR / f"{building}_bldg"
        self.node_path = self.dir / "node.csv"
        self.edge_path = self.dir / "edge.csv"
        self.nodes = {}   # id(int) -> row(dict, 値はCSVの生文字列/数値混在)
        self.edges = {}   # id(int) -> row(dict)
        self._node_cols = list(self.NODE_BASE_COLS)
        self.dirty = False
        self.load()

    # ------------------------------------------------------------------
    def load(self):
        self.nodes.clear()
        self.edges.clear()
        self.dirty = False

        if self.node_path.exists():
            with open(self.node_path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                self._node_cols = list(reader.fieldnames or self.NODE_BASE_COLS)
                for row in reader:
                    nid = to_int(row.get("id"))
                    if nid is None:
                        continue
                    self.nodes[nid] = dict(row)
        else:
            self._node_cols = list(self.NODE_BASE_COLS)

        if "svg_x" not in self._node_cols:
            self._node_cols = self._node_cols + ["svg_x", "svg_y"]

        self.edges.update(_read_csv_by_id(self.edge_path))

    # ------------------------------------------------------------------
    # 参照系
    # ------------------------------------------------------------------
    def floors_present(self) -> list:
        floors = {to_int(r.get("floor")) for r in self.nodes.values()}
        floors.discard(None)
        return sorted(floors)

    def nodes_for_floor(self, floor: int) -> list:
        return [dict(r, id=nid) for nid, r in self.nodes.items()
                if to_int(r.get("floor")) == floor]

    def edges_for_floor(self, floor: int) -> list:
        """
        両端ノードが「実際に」指定フロアにあるエッジのみを返す（2D描画可能なもの）。
        階段/エレベータ等で両端ノードのフロアが異なる（＝別SVGの座標系にまたがる）
        エッジは、edge.floor列の値に関わらず対象外とする。
        """
        out = []
        for eid, r in self.edges.items():
            fr, to = to_int(r.get("from")), to_int(r.get("to"))
            n_fr, n_to = self.nodes.get(fr), self.nodes.get(to)
            if n_fr is None or n_to is None:
                continue
            if to_int(n_fr.get("floor")) != floor or to_int(n_to.get("floor")) != floor:
                continue
            out.append(dict(r, id=eid))
        return out

    def edges_touching_node(self, node_id: int) -> list:
        """指定ノードを端点に持つ全エッジ（他フロアに跨るものも含む）"""
        out = []
        for eid, r in self.edges.items():
            if to_int(r.get("from")) == node_id or to_int(r.get("to")) == node_id:
                out.append(dict(r, id=eid))
        return out

    def node_label(self, node_id: int) -> str:
        r = self.nodes.get(node_id)
        if not r:
            return f"id={node_id}(不明)"
        fl = to_int(r.get("floor"))
        return f"id={node_id} ({self.building}号館 {fl}F)"

    def node_xyz(self, node_id: int):
        r = self.nodes.get(node_id)
        if not r:
            return None
        return (to_float(r.get("x")), to_float(r.get("y")), to_float(r.get("z")))

    def node_svg_xy(self, node_id: int):
        r = self.nodes.get(node_id)
        if not r or r.get("svg_x") in (None, ""):
            return None
        try:
            return (float(r["svg_x"]), float(r["svg_y"]))
        except (TypeError, ValueError):
            return None

    def next_node_id(self) -> int:
        return (max(self.nodes.keys()) + 1) if self.nodes else 1

    def next_edge_id(self) -> int:
        return (max(self.edges.keys()) + 1) if self.edges else 1

    # ------------------------------------------------------------------
    # 変更系
    # ------------------------------------------------------------------
    def add_node(self, x, y, z, floor, node_type, svg_x=None, svg_y=None, node_id=None) -> int:
        nid = node_id if node_id is not None else self.next_node_id()
        row = {c: "" for c in self._node_cols}
        row.update({
            "id": nid, "x": x, "y": y, "z": z,
            "building": self.building, "floor": floor, "type": node_type,
        })
        if svg_x is not None:
            row["svg_x"] = svg_x
            row["svg_y"] = svg_y
        self.nodes[nid] = row
        self.dirty = True
        return nid

    def delete_node(self, node_id: int) -> list:
        """ノードを削除し、参照していたエッジも連鎖削除する。削除したエッジIDのリストを返す"""
        self.nodes.pop(node_id, None)
        dead = [eid for eid, r in self.edges.items()
                if to_int(r.get("from")) == node_id or to_int(r.get("to")) == node_id]
        for eid in dead:
            self.edges.pop(eid, None)
        self.dirty = True
        return dead

    def add_edge(self, name, from_id, to_id, floor, weight, length, edge_type, edge_id=None) -> int:
        eid = edge_id if edge_id is not None else self.next_edge_id()
        self.edges[eid] = {
            "id": eid, "name": name, "from": from_id, "to": to_id,
            "building": self.building, "floor": floor,
            "weight": weight, "length": length, "type": edge_type,
        }
        self.dirty = True
        return eid

    def delete_edge(self, edge_id: int):
        self.edges.pop(edge_id, None)
        self.dirty = True

    # ------------------------------------------------------------------
    def save(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        _write_csv(self.node_path, self._node_cols, self.nodes)
        _write_csv(self.edge_path, self.EDGE_COLS, self.edges)
        self.dirty = False


class EdgeImageStore:
    """data/edge_image.csv の読み書き"""

    COLS = ["id", "from", "to", "image_name"]

    def __init__(self):
        self.path = DATA_DIR / "edge_image.csv"
        self.rows = {}
        self.dirty = False
        self.load()

    def load(self):
        self.rows.clear()
        self.dirty = False
        self.rows.update(_read_csv_by_id(self.path))

    def find(self, from_id: int, to_id: int):
        for row in self.rows.values():
            if to_int(row.get("from")) == from_id and to_int(row.get("to")) == to_id:
                return row
        return None

    def upsert(self, from_id: int, to_id: int, image_name: str) -> int:
        existing = self.find(from_id, to_id)
        if existing is not None:
            existing["image_name"] = image_name
            self.dirty = True
            return to_int(existing["id"])
        rid = (max(self.rows.keys()) + 1) if self.rows else 1
        self.rows[rid] = {"id": rid, "from": from_id, "to": to_id, "image_name": image_name}
        self.dirty = True
        return rid

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _write_csv(self.path, self.COLS, self.rows)
        self.dirty = False
