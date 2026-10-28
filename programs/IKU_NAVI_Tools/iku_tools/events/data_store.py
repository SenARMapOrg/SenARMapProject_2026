#!/usr/bin/env python3
"""
イベント設定タブ — データ層
data/event.csv の読み書きと、紐付け先（教室名・ノードID・エッジID）の検証用参照データを扱う。

仕様は docs/NameDB_EventMode.md の「4. イベントモード」に準拠:
  - event.csv: id,title,building,room,node_id,edge_id,side,position
  - id … ナビのURL（navi/?to_event=<id>）でイベントを呼び出すための名前。同じ title の行には同じ id を書く
  - 1行につき room / node_id / edge_id のいずれか1つで場所を指定する
  - room    … data/{building}_bldg/edge.csv の name 列（;区切り）に含まれる教室名
  - node_id … 建物内ローカルノードID（building=0 なら data/global_node.csv のID）
  - edge_id … 建物内ローカルエッジID（building=0 なら data/global_edge.csv のID）。
               side（right/left）・position（1始まり）で、教室と同じように通路のどちら側の何番目かも指定できる
               （edge.csv の from→to の向きで見た値。position は同じ通路の同じ側の展示どうしの並び順）
  - 同じ title の行が複数あれば、複数箇所で開催するイベントとして統合される
"""

from __future__ import annotations

import csv
import re

from ..common.paths import (  # noqa: F401  (他モジュールが data_store 経由で参照する)
    BUILDING_NAME_CSV,
    DATA_DIR,
    EVENT_CSV,
    GLOBAL_EDGE_CSV,
    GLOBAL_NODE_CSV,
    REPO_ROOT,
)

EVENT_COLS = ["id", "title", "building", "room", "node_id", "edge_id", "side", "position"]

SIDE_RIGHT, SIDE_LEFT = "right", "left"
SIDE_LABELS = {"": "左右なし", SIDE_RIGHT: "右側", SIDE_LEFT: "左側"}
_SIDE_ALIASES = {"right": SIDE_RIGHT, "r": SIDE_RIGHT, "右": SIDE_RIGHT,
                 "left": SIDE_LEFT, "l": SIDE_LEFT, "左": SIDE_LEFT}
MAX_POSITION = 30

# URLにそのまま書けるよう、英数字・ハイフン・アンダースコアだけにする
EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def validate_event_id(event_id: str, others: list) -> str:
    """問題なければ空文字。others は他のイベントの id の一覧"""
    event_id = (event_id or "").strip()
    if not event_id:
        return "IDが空です（URLでこのイベントを呼び出せません）"
    if not EVENT_ID_PATTERN.match(event_id):
        return "IDは半角の英数字・-・_ だけで、40文字までにしてください"
    if event_id in others:
        return f"ID '{event_id}' は他のイベントでも使われています"
    return ""


# ナビのURL。to_event でイベントモードも自動で有効になる
NAVI_EVENT_URL = "https://iku-navi.net/navi/?to_event={}"

# 案内人数集計（programs/event_guide_counter）の案内係コード。管理画面で案内係を追加すると出る8文字
# （functions/api/_lib/track-guard.ts の REF_CODE_PATTERN と同じ。違う形式のコードは記録されない）
REF_CODE_PATTERN = re.compile(r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$")


def normalize_ref_code(text: str) -> tuple:
    """(コード, エラー)。空なら ("", "")。小文字で入れても大文字に直す"""
    code = (text or "").strip().upper()
    if not code:
        return "", ""
    if not REF_CODE_PATTERN.match(code):
        return code, "案内係コードは集計の管理画面で出る8文字（数字の2〜9と、I・Oを除く英大文字）です"
    return code, ""


def event_url(event_id: str, ref_code: str = "") -> str:
    """イベントを目的地にしてナビを開くURL。ref_code を付けると案内人数の集計に記録される"""
    url = NAVI_EVENT_URL.format(event_id.strip())
    return f"{url}&ref={ref_code}" if ref_code else url


def event_url_lines(entries: list, ref_code: str = "") -> str:
    """「名前,URL」を1行ずつ。IDが無い・名前が空のイベントは飛ばす"""
    return "\n".join(
        f"{e.title.strip()},{event_url(e.event_id, ref_code)}"
        for e in entries if e.title.strip() and e.event_id.strip()
    )


def next_event_id(used: list) -> str:
    """まだ使われていない一番小さい番号のID（1, 2, 3, ...）"""
    n = 1
    while str(n) in used:
        n += 1
    return str(n)

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
        self._edge_sides = {} # {edge_id: {"right", "left", "from", "to"}}
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
                        self._edge_sides[eid] = {
                            "right": (row.get("right") or "").strip(), "left": (row.get("left") or "").strip(),
                            "from": (row.get("from") or "").strip(), "to": (row.get("to") or "").strip(),
                        }
                    raw_name = (row.get("name") or "").strip()
                    if not raw_name:
                        continue
                    for room in raw_name.split(";"):
                        room = room.strip()
                        if room and room not in seen_rooms:
                            seen_rooms.add(room)
                            self.rooms.append(room)
        self.edges.sort(key=lambda t: t[0])

    def edge_sides(self, edge_id) -> dict:
        """そのエッジの from→to の向きで見た右側・左側の教室名（edge.csv の right/left 列）。位置を決める目安に出す"""
        return self._edge_sides.get(to_int(edge_id), {"right": "", "left": "", "from": "", "to": ""})

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
    def __init__(self, building: int = 0, kind: str = KIND_ROOM, value: str = "",
                 side: str = "", position=None):
        self.building = building
        self.kind = kind
        self.value = value
        self.side = side          # エッジIDのときだけ使う: "right" / "left" / ""（左右なし）
        self.position = position  # エッジIDのときだけ使う: 1始まりの何番目か / None


class EventEntry:
    def __init__(self, title: str = "", event_id: str = ""):
        self.title = title
        self.event_id = event_id
        self.building = 0    # 場所がまだ無いイベントを保存するときの号館
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
                event_id = (row.get("id") or "").strip()
                side = _SIDE_ALIASES.get((row.get("side") or "").strip().lower(), "")
                position = to_int(row.get("position"))
                if position is not None and position < 1:
                    position = None
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
                    kind, value = None, ""

                entry = by_title.get(title)
                if entry is None:
                    entry = EventEntry(title, event_id)
                    entry.building = building
                    by_title[title] = entry
                    self.entries.append(entry)
                elif not entry.event_id:
                    entry.event_id = event_id
                if kind is None:
                    # 場所が決まっていない（IDだけ先に振った）イベント。消さずに残す
                    continue
                if kind != KIND_EDGE:
                    side, position = "", None
                entry.locations.append(EventLocation(building, kind, value, side, position))

    def used_ids(self, exclude=None) -> list:
        return [e.event_id.strip() for e in self.entries if e is not exclude and e.event_id.strip()]

    def add_entry(self, title: str) -> EventEntry:
        entry = EventEntry(title, next_event_id(self.used_ids()))
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
            n_rows = len(rows)
            for loc in entry.locations:
                value = (loc.value or "").strip()
                if not value:
                    continue
                row = {"id": entry.event_id.strip(), "title": title, "building": loc.building,
                       "room": "", "node_id": "", "edge_id": "", "side": "", "position": ""}
                row[loc.kind] = value
                if loc.kind == KIND_EDGE and loc.side:
                    row["side"] = loc.side
                    row["position"] = loc.position or ""
                rows.append(row)
            if len(rows) == n_rows:
                # 場所が1つも無くても、IDを残すために場所の列が空の行を書く
                rows.append({"id": entry.event_id.strip(), "title": title, "building": entry.building,
                             "room": "", "node_id": "", "edge_id": "", "side": "", "position": ""})
        with open(EVENT_CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=EVENT_COLS)
            w.writeheader()
            w.writerows(rows)
        self.dirty = False
