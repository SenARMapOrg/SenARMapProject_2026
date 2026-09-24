#!/usr/bin/env python3
"""
IKU NAVI Event Editor — データ層
data/event.csv の読み書きと、紐付け先（教室名・ノードID・エッジID）の検証用参照データを扱う。

仕様は docs/NameDB_EventMode.md の「4. イベントモード」に準拠:
  - event.csv: title,building,room,node_id,edge_id
  - 1行につき room / node_id / edge_id のいずれか1つで場所を指定する
  - room    … data/{building}_bldg/edge.csv の name 列（;区切り）に含まれる教室名
  - node_id … 建物内ローカルノードID（building=0 なら data/global_node.csv のID）
  - edge_id … 建物内ローカルエッジID（building=0 なら data/global_edge.csv のID）
  - 同じ title の行が複数あれば、複数箇所で開催するイベントとして統合される
"""

import csv
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common.paths import (  # noqa: F401  (他モジュールが data_store 経由で参照する)
    BUILDING_NAME_CSV,
    DATA_DIR,
    EVENT_CSV,
    GLOBAL_EDGE_CSV,
    GLOBAL_NODE_CSV,
    REPO_ROOT,
)

EVENT_COLS = ["title", "building", "room", "node_id", "edge_id"]

KIND_ROOM, KIND_NODE, KIND_EDGE = "room", "node_id", "edge_id"
KIND_LABELS = {KIND_ROOM: "教室名", KIND_NODE: "ノードID", KIND_EDGE: "エッジID"}


def to_int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def building_label(building: int, name_map: dict) -> str:
    if building == 0:
        return "屋外"
    return name_map.get(building, f"{building}号館")


def load_building_name_map() -> dict:
    """building_name.csv（列: building,display_name）→ {building: display_name}"""
    name_map = {}
    if not BUILDING_NAME_CSV.exists():
        return name_map
    with open(BUILDING_NAME_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            bldg = to_int(row.get("building"))
            display = (row.get("display_name") or "").strip()
            if bldg is None or not display:
                continue
            name_map[bldg] = display
    return name_map


def list_buildings() -> list:
    """紐付け先を持てる建物IDの一覧（屋外=0 + data/*_bldg のある建物）を返す"""
    ids = [0]
    if DATA_DIR.exists():
        for p in DATA_DIR.glob("*_bldg"):
            n = to_int(p.name.split("_")[0])
            if n is not None:
                ids.append(n)
    return sorted(ids)


class BuildingRefs:
    """1建物分の「有効な教室名・ノードID・エッジID」を保持する参照専用データ（イベント紐付けの検証用）"""

    def __init__(self, building: int):
        self.building = building
        self.rooms = []       # 教室名（重複なし・元の表記順）
        self.node_ids = []    # ノードID（昇順）
        self.edges = []       # [(edge_id, label), ...]（昇順）
        self._load()

    def _load(self):
        if self.building == 0:
            node_path, edge_path = GLOBAL_NODE_CSV, GLOBAL_EDGE_CSV
        else:
            bldg_dir = DATA_DIR / f"{self.building}_bldg"
            node_path, edge_path = bldg_dir / "node.csv", bldg_dir / "edge.csv"

        if node_path.exists():
            with open(node_path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    nid = to_int(row.get("id"))
                    if nid is not None:
                        self.node_ids.append(nid)
        self.node_ids.sort()

        seen_rooms = set()
        if edge_path.exists():
            with open(edge_path, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    eid = to_int(row.get("id"))
                    if eid is not None:
                        name = (row.get("name") or "").strip()
                        floor = row.get("floor", "")
                        label = f"{eid}（{name}）" if name else f"{eid}（{floor}F）"
                        self.edges.append((eid, label))
                    raw_name = (row.get("name") or "").strip()
                    if not raw_name:
                        continue
                    for room in raw_name.split(";"):
                        room = room.strip()
                        if room and room not in seen_rooms:
                            seen_rooms.add(room)
                            self.rooms.append(room)
        self.edges.sort(key=lambda t: t[0])

    def validate(self, kind: str, value: str) -> str:
        """問題なければ空文字、問題があればエラーメッセージを返す"""
        value = (value or "").strip()
        if not value:
            return "値が入力されていません"
        if kind == KIND_ROOM:
            if value not in self.rooms:
                return f"教室名 '{value}' がこの建物の edge.csv に見つかりません"
        else:
            n = to_int(value)
            if n is None:
                return "IDは数値で入力してください"
            pool = self.node_ids if kind == KIND_NODE else [eid for eid, _ in self.edges]
            if n not in pool:
                return f"{KIND_LABELS[kind]} {n} がこの建物に見つかりません"
        return ""


class EventLocation:
    def __init__(self, building: int = 0, kind: str = KIND_ROOM, value: str = ""):
        self.building = building
        self.kind = kind
        self.value = value


class EventEntry:
    def __init__(self, title: str = ""):
        self.title = title
        self.locations = []  # [EventLocation, ...]


class EventStore:
    """data/event.csv 全体をメモリ上で保持し、読み書きする"""

    def __init__(self):
        self.entries = []  # [EventEntry, ...]（初出順）
        self.dirty = False
        self.load()

    def load(self):
        self.entries.clear()
        self.dirty = False
        by_title = {}
        if not EVENT_CSV.exists():
            return
        with open(EVENT_CSV, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                title = (row.get("title") or "").strip()
                if not title:
                    continue
                building = to_int(row.get("building"), 0) or 0
                room    = (row.get("room") or "").strip()
                node_id = (row.get("node_id") or "").strip()
                edge_id = (row.get("edge_id") or "").strip()
                if room:
                    kind, value = KIND_ROOM, room
                elif node_id:
                    kind, value = KIND_NODE, node_id
                elif edge_id:
                    kind, value = KIND_EDGE, edge_id
                else:
                    continue

                entry = by_title.get(title)
                if entry is None:
                    entry = EventEntry(title)
                    by_title[title] = entry
                    self.entries.append(entry)
                entry.locations.append(EventLocation(building, kind, value))

    def add_entry(self, title: str) -> EventEntry:
        entry = EventEntry(title)
        self.entries.append(entry)
        self.dirty = True
        return entry

    def remove_entry(self, entry: EventEntry):
        if entry in self.entries:
            self.entries.remove(entry)
            self.dirty = True

    def save(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        rows = []
        for entry in self.entries:
            title = entry.title.strip()
            if not title:
                continue
            for loc in entry.locations:
                value = (loc.value or "").strip()
                if not value:
                    continue
                row = {"title": title, "building": loc.building, "room": "", "node_id": "", "edge_id": ""}
                row[loc.kind] = value
                rows.append(row)
        with open(EVENT_CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=EVENT_COLS)
            w.writeheader()
            w.writerows(rows)
        self.dirty = False
