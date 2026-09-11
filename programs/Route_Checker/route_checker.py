#!/usr/bin/env python3
"""IKU NAVI ルートチェッカー — 登録教室間の全ルートを取得・異常検出ツール

使い方:
  1. API URL を入力して「教室取得」を押す
  2. フィルタ（トイレ除外など）を設定して「検証開始」を押す
  3. 全教室ペアのルートが並列取得され、テーブルに表示される
  4. 行をダブルクリックすると経路詳細と異常の原因を確認できる
"""

import csv
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from PyQt6.QtCore import Qt, QThread, QTimer, pyqtSignal
from PyQt6.QtGui import QBrush, QColor, QFont
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

# ── 定数 ──────────────────────────────────────────────────────────────────────
DEFAULT_API = "http://localhost:5001"
MAX_WORKERS = 8

EDGE_TYPE_LABELS = {
    "1": "通路",
    "2": "階段",
    "3": "エスカレータ",
    "4": "エレベータ",
    "5": "上りESC",
    "6": "下りESC",
    "7": "入口",
}

TOILET_ROOMS = {"M_Toilet", "F_Toilet", "C_Toilet"}

# ── パレット ──────────────────────────────────────────────────────────────────
BG_WIN      = "#111827"
BG_BAR      = "#1F2937"
BG_TABLE    = "#141E2E"
BG_ROW_ALT  = "#1A2436"
BG_SEL      = "#0E3A50"
TXT_PRIMARY = "#F1F5F9"
TXT_SUB     = "#94A3B8"
TXT_KEY     = "#CBD5E1"
ACCENT      = "#00B8E6"
COL_OK      = "#4ADE80"
COL_ANOM    = "#FBBF24"
COL_NOPATH  = "#A855F7"
COL_ERR     = "#F87171"
COL_PEND    = "#4B5563"
BTN_ACTIVE  = "#0E7490"
BTN_IDLE    = "#374151"
BORDER      = "#2D3748"

STATUS_COLOR = {"ok": COL_OK, "anomaly": COL_ANOM,
                "no_path": COL_NOPATH, "error": COL_ERR, "pending": COL_PEND}
STATUS_LABEL = {"ok": "OK", "anomaly": "異常",
                "no_path": "経路なし", "error": "エラー", "pending": "待機中"}

ANOMALY_LABEL = {
    "SAME_FLOOR_DETOUR":   "同フロア階移動",
    "FLOOR_OVERSHOOT":     "フロアOV",
    "FLOOR_REVERSAL":      "フロア往復",
    "UNEXPECTED_BUILDING": "想定外建物",
    "LOOP_DETECTED":       "ループ",
}

# テーブル列インデックス
C_FROM_ROOM, C_FROM_BLDG, C_FROM_FL = 0, 1, 2
C_TO_ROOM,   C_TO_BLDG,   C_TO_FL   = 3, 4, 5
C_STATUS, C_DIST, C_SEQ, C_ANOM     = 6, 7, 8, 9

TABLE_HEADERS = [
    "出発教室", "出発号館", "出発階",
    "目的教室", "目的号館", "目的階",
    "状態", "距離(m)", "経路概要", "異常内容",
]


# ── ヘルパー ──────────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": "IKU-NAVI-RouteChecker/1.0",
                       "Accept": "application/json"})
    retry = Retry(total=2, backoff_factor=0.3, status_forcelist=[500, 502, 503, 504])
    adp = HTTPAdapter(max_retries=retry)
    s.mount("https://", adp)
    s.mount("http://", adp)
    return s


def _fl(floor: int) -> str:
    return "屋外" if floor == 0 else f"{floor}F"


def _bl(building: int) -> str:
    return "屋外" if building == 0 else f"{building}号館"


def floor_sequence_str(path_coords: list) -> str:
    """経路の建物・フロア遷移を圧縮した文字列で返す"""
    seq, prev = [], None
    for n in path_coords:
        cur = (n["building"], n["floor"])
        if cur != prev:
            seq.append(cur)
            prev = cur
    parts = []
    for b, f in seq:
        parts.append("屋外" if b == 0 else f"{b}号館{_fl(f)}")
    # 隣接重複をまとめる
    out = []
    for p in parts:
        if not out or out[-1] != p:
            out.append(p)
    return " → ".join(out)


def detect_anomalies(
    path_coords: list,
    from_bldg: int, from_fl: int,
    to_bldg:   int, to_fl:   int,
    detect_loop: bool = False,
) -> list[tuple[str, str]]:
    """
    異常を検出して [(type_key, human_readable_description), ...] を返す。

    検出する異常:
      SAME_FLOOR_DETOUR   - 同号館・同フロア間なのに別フロアを経由
      FLOOR_OVERSHOOT     - 同号館間で必要フロア範囲を超えたフロアを経由
      FLOOR_REVERSAL      - 同号館内でフロアの往復（単調でない移動）
      UNEXPECTED_BUILDING - 出発・目的・屋外以外の建物を経由
      LOOP_DETECTED       - 経路中に同一ノードが複数回登場（detect_loop=True 時のみ）
    """
    if not path_coords or len(path_coords) < 2:
        return []

    anomalies: list[tuple[str, str]] = []
    bldg_seq = [n["building"] for n in path_coords]

    # ─ 1. 想定外の建物を経由 ─────────────────────────────────────────────────
    expected_bldgs = {from_bldg, to_bldg, 0}
    unexpected = sorted({b for b in bldg_seq if b not in expected_bldgs})
    if unexpected:
        names = ", ".join(_bl(b) for b in unexpected)
        anomalies.append((
            "UNEXPECTED_BUILDING",
            f"想定外の建物を経由しています: {names}\n"
            f"（出発:{_bl(from_bldg)} → 目的:{_bl(to_bldg)} の場合、"
            f"屋外のみ通過が想定されます）\n"
            f"→ connect_edge.csv や global_edge.csv の重みが不適切な可能性があります。",
        ))

    # ─ 2. 同号館・同フロア間で別フロアを経由 ────────────────────────────────
    if from_bldg == to_bldg and from_fl == to_fl and from_bldg != 0:
        bfloors = [n["floor"] for n in path_coords if n["building"] == from_bldg]
        other = sorted(set(f for f in bfloors if f != from_fl))
        if other:
            floor_names = ", ".join(_fl(f) for f in other)
            anomalies.append((
                "SAME_FLOOR_DETOUR",
                f"{_bl(from_bldg)} {_fl(from_fl)}→{_fl(to_fl)} (同フロア) なのに\n"
                f"別のフロア（{floor_names}）を経由しています。\n"
                f"→ 該当フロアの階段/エレベータエッジの weight×length が低すぎる、\n"
                f"  または同フロア廊下に未接続箇所があり迂回している可能性があります。",
            ))
            return anomalies  # これ以上の検出は冗長

    # ─ 3. 同号館内でフロアがオーバーシュート ─────────────────────────────────
    if from_bldg == to_bldg and from_bldg != 0 and from_fl != to_fl:
        min_f, max_f = min(from_fl, to_fl), max(from_fl, to_fl)
        bfloors = [n["floor"] for n in path_coords if n["building"] == from_bldg]
        overshoot = sorted(set(f for f in bfloors if f < min_f or f > max_f))
        if overshoot:
            floor_names = ", ".join(_fl(f) for f in overshoot)
            anomalies.append((
                "FLOOR_OVERSHOOT",
                f"{_bl(from_bldg)} {_fl(from_fl)}→{_fl(to_fl)} への移動に\n"
                f"必要範囲（{_fl(min_f)}〜{_fl(max_f)}）外のフロア（{floor_names}）を経由しています。\n"
                f"→ 階段グラフの接続が途切れており、一度別フロアを迂回している可能性があります。",
            ))

    # ─ 4. フロアの往復（行き来） ─────────────────────────────────────────────
    # 既に上記で検出済みの場合は追加しない
    if not anomalies:
        for bldg in sorted(set(bldg_seq)):
            if bldg == 0:
                continue
            floors = [n["floor"] for n in path_coords if n["building"] == bldg]
            dirs = [
                1 if floors[i + 1] > floors[i] else -1
                for i in range(len(floors) - 1)
                if floors[i + 1] != floors[i]
            ]
            if len(dirs) >= 2:
                reversals = sum(1 for i in range(len(dirs) - 1) if dirs[i] != dirs[i + 1])
                if reversals > 0:
                    seq_str = " → ".join(_fl(f) for f in floors)
                    anomalies.append((
                        "FLOOR_REVERSAL",
                        f"{_bl(bldg)} 内でフロアの行き来があります。\n"
                        f"フロア順序: {seq_str}\n"
                        f"→ 本来は単調に移動できるはずです。\n"
                        f"  階段/エレベータの weight が非対称になっている可能性があります。",
                    ))

    # ─ 5. ループ検出（同一ノードの再訪） ────────────────────────────────────
    if detect_loop:
        seen: dict[int, int] = {}   # node_id → 最初の登場インデックス
        loop_nodes: list[tuple[int, int, int]] = []  # (node_id, 初回index, 再登場index)
        for i, n in enumerate(path_coords):
            nid = int(n["id"])
            if nid in seen:
                loop_nodes.append((nid, seen[nid], i))
            else:
                seen[nid] = i
        if loop_nodes:
            details = "\n".join(
                f"  ノード{nid}: ステップ{fi + 1} → ステップ{ri + 1}"
                f"（{_bl(path_coords[fi]['building'])} {_fl(path_coords[fi]['floor'])}）"
                for nid, fi, ri in loop_nodes[:5]   # 最大5件表示
            )
            suffix = f"\n  … 他 {len(loop_nodes) - 5} 件" if len(loop_nodes) > 5 else ""
            anomalies.append((
                "LOOP_DETECTED",
                f"経路中に同一ノードが {len(loop_nodes)} か所で再訪されています。\n"
                f"{details}{suffix}\n"
                f"→ Dijkstra は通常ループを生成しません。\n"
                f"  グラフに負の重みや孤立した連結成分が存在する可能性があります。",
            ))

    return anomalies


# ── ワーカー ──────────────────────────────────────────────────────────────────

class FetchAllWorker(QThread):
    """/api/all と /api/graph を取得する"""
    finished = pyqtSignal(list, dict)   # rooms_list, edges_by_pair
    error    = pyqtSignal(str)

    def __init__(self, api_url: str):
        super().__init__()
        self.api_url = api_url.rstrip("/")

    def run(self):
        session = _make_session()
        try:
            all_data   = self._get(session, f"{self.api_url}/api/all")
            graph_data = self._get(session, f"{self.api_url}/api/graph")
        except Exception as e:
            self.error.emit(str(e))
            return

        rooms_list    = all_data.get("rooms", [])
        edges_by_pair = {
            (int(e["from"]), int(e["to"])): e
            for e in graph_data.get("edges", [])
        }
        self.finished.emit(rooms_list, edges_by_pair)

    def _get(self, session: requests.Session, url: str) -> dict:
        r = session.get(url, timeout=20)
        r.raise_for_status()
        return r.json()


class RouteCheckWorker(QThread):
    """全ペアの経路を並列取得する"""
    route_ready = pyqtSignal(dict)
    progress    = pyqtSignal(int, int)
    finished    = pyqtSignal()

    def __init__(self, api_url: str, pairs: list,
                 max_workers: int = MAX_WORKERS, detect_loop: bool = False):
        super().__init__()
        self.api_url     = api_url.rstrip("/")
        self.pairs       = pairs
        self.max_workers = max_workers
        self.detect_loop = detect_loop
        self._stop       = False
        self._done       = 0
        self._lock       = threading.Lock()

    def stop(self):
        self._stop = True

    def run(self):
        total = len(self.pairs)
        tls   = threading.local()

        def get_session():
            if not hasattr(tls, "s"):
                tls.s = _make_session()
            return tls.s

        def fetch_one(pair):
            if self._stop:
                return
            fr, fb, ff, tr, tb, tf = pair
            result = {
                "from_room": fr, "from_building": fb, "from_floor": ff,
                "to_room":   tr, "to_building":   tb, "to_floor":   tf,
                "status": "error", "total_weight": None,
                "path_coords": [], "path_edges": [],
                "anomalies": [], "error_msg": "", "floor_sequence": "",
            }
            url = (f"{self.api_url}/api/route"
                   f"?from_room={fr}&from_building={fb}"
                   f"&to_room={tr}&to_building={tb}")
            try:
                r = get_session().get(url, timeout=15)
                if r.status_code == 404:
                    result["status"]    = "no_path"
                    result["error_msg"] = r.json().get("error", "経路なし")
                elif r.status_code == 200:
                    data   = r.json()
                    coords = data.get("path_coords", [])
                    edges  = data.get("path_edges",  [])
                    anom   = detect_anomalies(coords, fb, ff, tb, tf,
                                              detect_loop=self.detect_loop)
                    result.update({
                        "status":         "anomaly" if anom else "ok",
                        "total_weight":   data.get("total_weight"),
                        "path_coords":    coords,
                        "path_edges":     edges,
                        "anomalies":      anom,
                        "floor_sequence": floor_sequence_str(coords),
                    })
                else:
                    result["error_msg"] = f"HTTP {r.status_code}"
            except Exception as e:
                result["error_msg"] = str(e)

            with self._lock:
                self._done += 1
                n = self._done
            self.route_ready.emit(result)
            self.progress.emit(n, total)

        with ThreadPoolExecutor(max_workers=self.max_workers) as pool:
            list(pool.map(fetch_one, self.pairs))
        self.finished.emit()


# ── 経路詳細ダイアログ ────────────────────────────────────────────────────────

class _NumItem(QTableWidgetItem):
    """数値ソート対応の QTableWidgetItem"""
    def __lt__(self, other: QTableWidgetItem) -> bool:
        try:
            return float(self.text()) < float(other.text())
        except ValueError:
            return super().__lt__(other)


class PathDetailDialog(QDialog):
    """1ペアの経路詳細・異常原因を表示するダイアログ"""

    _STYLE = f"""
        QDialog, QWidget  {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
        QTextEdit, QTableWidget {{
            background: #1A2233; color: {TXT_PRIMARY};
            border: 1px solid {BORDER}; border-radius: 6px;
        }}
        QHeaderView::section {{
            background: #2D3748; color: {TXT_KEY};
            border: none; padding: 4px 8px; font-size: 13px;
        }}
        QTableWidget::item:selected {{ background: {BG_SEL}; }}
        QPushButton {{
            background: {BTN_IDLE}; color: {TXT_PRIMARY};
            border-radius: 5px; padding: 4px 14px; border: none;
        }}
        QPushButton:hover {{ background: #4B5563; }}
    """

    def __init__(self, result: dict, edges_by_pair: dict, parent=None):
        super().__init__(parent)
        self._result        = result
        self._edges_by_pair = edges_by_pair
        self.setStyleSheet(self._STYLE)

        fr, fb, ff = result["from_room"], result["from_building"], result["from_floor"]
        tr, tb, tf = result["to_room"],   result["to_building"],   result["to_floor"]
        self.setWindowTitle(
            f"経路詳細: {fr}({_bl(fb)} {_fl(ff)}) → {tr}({_bl(tb)} {_fl(tf)})"
        )
        self.setMinimumSize(820, 600)
        self.resize(1020, 700)
        self._build_ui()

    def _build_ui(self):
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(16, 16, 16, 16)
        vbox.setSpacing(10)

        r  = self._result
        fr, fb, ff = r["from_room"], r["from_building"], r["from_floor"]
        tr, tb, tf = r["to_room"],   r["to_building"],   r["to_floor"]

        # ── タイトル ──────────────────────────────────────────────────────────
        title = QLabel(
            f"{fr}（{_bl(fb)} {_fl(ff)}）  →  {tr}（{_bl(tb)} {_fl(tf)}）"
        )
        title.setFont(QFont("", 14, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {ACCENT};")
        title.setWordWrap(True)
        vbox.addWidget(title)

        # 状態・距離
        dist_str = f"{r['total_weight']:.1f} m" if r.get("total_weight") is not None else "—"
        color    = STATUS_COLOR.get(r["status"], TXT_SUB)
        info = QLabel(f"状態: {STATUS_LABEL.get(r['status'], r['status'])}   距離: {dist_str}")
        info.setFont(QFont("", 12))
        info.setStyleSheet(f"color: {color};")
        vbox.addWidget(info)

        if r.get("floor_sequence"):
            seq_lbl = QLabel(f"経路概要:  {r['floor_sequence']}")
            seq_lbl.setFont(QFont("", 11))
            seq_lbl.setStyleSheet(f"color: {TXT_SUB};")
            seq_lbl.setWordWrap(True)
            vbox.addWidget(seq_lbl)

        # ── 異常パネル ────────────────────────────────────────────────────────
        anomalies = r.get("anomalies", [])
        if anomalies:
            box = QFrame()
            box.setStyleSheet(
                f"QFrame {{ background: #2B1A0A; border: 1px solid {COL_ANOM}; border-radius: 6px; }}"
            )
            bvbox = QVBoxLayout(box)
            bvbox.setContentsMargins(12, 8, 12, 8)
            bvbox.setSpacing(8)
            warn = QLabel(f"⚠  {len(anomalies)} 件の異常が検出されました")
            warn.setFont(QFont("", 12, QFont.Weight.Bold))
            warn.setStyleSheet(f"color: {COL_ANOM}; background: transparent;")
            bvbox.addWidget(warn)
            for atype, adesc in anomalies:
                lbl = QLabel(f"【{ANOMALY_LABEL.get(atype, atype)}】\n{adesc}")
                lbl.setFont(QFont("", 11))
                lbl.setWordWrap(True)
                lbl.setStyleSheet(f"color: {TXT_PRIMARY}; background: transparent;")
                bvbox.addWidget(lbl)
            vbox.addWidget(box)

        elif r["status"] == "error":
            vbox.addWidget(self._build_message_box(
                "#2B0F0F", COL_ERR, f"エラー: {r.get('error_msg', '')}"
            ))

        elif r["status"] == "no_path":
            vbox.addWidget(self._build_message_box(
                "#1A0B2E", COL_NOPATH, f"経路なし: {r.get('error_msg', '')}"
            ))

        # ── 経路テーブル ──────────────────────────────────────────────────────
        coords = r.get("path_coords", [])
        edges  = r.get("path_edges",  [])
        if coords:
            vbox.addWidget(self._build_path_table(coords, edges, fb, ff, tb, tf))

        # ── ボタン ────────────────────────────────────────────────────────────
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        json_btn = QPushButton("JSON 表示")
        json_btn.clicked.connect(self._show_json)
        btn_row.addWidget(json_btn)
        close_btn = QPushButton("閉じる")
        close_btn.setStyleSheet(
            f"QPushButton {{ background:{BTN_ACTIVE}; color:#FFF; border-radius:5px; padding:4px 14px; }}"
        )
        close_btn.clicked.connect(self.accept)
        btn_row.addWidget(close_btn)
        vbox.addLayout(btn_row)

    def _build_message_box(self, bg: str, color: str, text: str) -> QFrame:
        """背景色・アクセント色付きの単一メッセージ枠を作る（エラー/経路なし表示用）"""
        box = QFrame()
        box.setStyleSheet(
            f"QFrame {{ background: {bg}; border: 1px solid {color}; border-radius: 6px; }}"
        )
        bvbox = QVBoxLayout(box)
        lbl = QLabel(text)
        lbl.setWordWrap(True)
        lbl.setStyleSheet(f"color: {color}; background: transparent;")
        bvbox.addWidget(lbl)
        return box

    def _build_path_table(
        self, coords: list, edges: list,
        from_bldg: int, from_fl: int, to_bldg: int, to_fl: int,
    ) -> QTableWidget:
        cols = ["#", "ノードID", "号館", "階", "→ エッジ種別", "区間距離(m)", "重み(計算値)"]
        tbl  = QTableWidget(len(coords), len(cols))
        tbl.setHorizontalHeaderLabels(cols)
        tbl.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        tbl.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        tbl.setAlternatingRowColors(True)
        tbl.verticalHeader().setVisible(False)
        tbl.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        tbl.horizontalHeader().setStretchLastSection(True)
        tbl.setFont(QFont("Courier New", 11))
        tbl.setStyleSheet(f"""
            QTableWidget {{
                alternate-background-color: {BG_ROW_ALT};
                background: {BG_TABLE}; gridline-color: {BORDER};
            }}
            QTableWidget::item {{ padding: 3px 8px; }}
        """)

        ep = self._edges_by_pair
        expected_bldgs  = {from_bldg, to_bldg, 0}
        same_floor_trip = (from_bldg == to_bldg and from_fl == to_fl and from_bldg != 0)

        for row_i, node in enumerate(coords):
            nid  = node.get("id", "")
            bldg = node.get("building", 0)
            fl   = node.get("floor", 0)

            # エッジ情報（このノード → 次ノードへ）
            etype_str = seg_len_str = wt_str = ""
            if row_i < len(edges):
                e = edges[row_i]
                key = (int(e.get("from", 0)), int(e.get("to", 0)))
                if key in ep:
                    etype     = str(ep[key].get("type", ""))
                    etype_str = EDGE_TYPE_LABELS.get(etype, f"type{etype}")
                    raw_w     = float(ep[key].get("weight", 0))
                    raw_l     = float(ep[key].get("length", 0))
                    penalty   = 50.0 if ep[key].get("type") in ("7", 7) else 0.0
                    wt_str    = f"{raw_w * raw_l + penalty:.2f}"
                seg_len_str = f"{e.get('length', 0):.2f}"

            vals = [str(row_i + 1), str(nid), _bl(bldg), _fl(fl),
                    etype_str, seg_len_str, wt_str]
            for ci, v in enumerate(vals):
                item = QTableWidgetItem(v)
                item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                tbl.setItem(row_i, ci, item)

            # 異常行ハイライト
            is_anom = (
                bldg not in expected_bldgs
                or (same_floor_trip and bldg == from_bldg and fl != from_fl)
            )
            if is_anom:
                for ci in range(len(cols)):
                    it = tbl.item(row_i, ci)
                    if it:
                        it.setBackground(QBrush(QColor("#3B1515")))
                        it.setForeground(QBrush(QColor(COL_ERR)))
            elif row_i > 0:
                prev = coords[row_i - 1]
                if bldg != prev["building"] or fl != prev["floor"]:
                    for ci in range(len(cols)):
                        it = tbl.item(row_i, ci)
                        if it:
                            it.setBackground(QBrush(QColor("#1C2F1C")))

        return tbl

    def _show_json(self):
        dlg = QDialog(self)
        dlg.setWindowTitle("生データ (JSON)")
        dlg.resize(700, 500)
        dlg.setStyleSheet(f"""
            QDialog {{ background: {BG_WIN}; }}
            QTextEdit {{ background: #1A2233; color: {TXT_PRIMARY};
                border: 1px solid {BORDER}; border-radius: 4px;
                font-family: "Courier New"; font-size: 12px; }}
            QPushButton {{ background: {BTN_IDLE}; color: {TXT_PRIMARY};
                border-radius: 5px; padding: 4px 14px; border: none; }}
        """)
        vb = QVBoxLayout(dlg)
        te = QTextEdit()
        te.setReadOnly(True)
        disp = dict(self._result)
        coords = disp.get("path_coords", [])
        if len(coords) > 10:
            disp["path_coords"] = coords[:5] + [f"... ({len(coords)-10} 省略) ..."] + coords[-5:]
        te.setPlainText(json.dumps(disp, ensure_ascii=False, indent=2))
        vb.addWidget(te)
        btn_row = QHBoxLayout()
        btn_row.addStretch()
        copy_btn = QPushButton("コピー")
        copy_btn.setStyleSheet(
            f"QPushButton {{ background:{BTN_ACTIVE}; color:#FFF; border-radius:5px; padding:4px 14px; }}"
        )
        copy_btn.clicked.connect(lambda: QApplication.clipboard().setText(te.toPlainText()))
        btn_row.addWidget(copy_btn)
        ok_btn = QPushButton("閉じる")
        ok_btn.clicked.connect(dlg.accept)
        btn_row.addWidget(ok_btn)
        vb.addLayout(btn_row)
        dlg.exec()


# ── メインウィンドウ ──────────────────────────────────────────────────────────

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("IKU NAVI ルートチェッカー")
        self.setMinimumSize(1100, 680)
        self.resize(1440, 860)

        self._rooms_list:     list = []
        self._edges_by_pair:  dict = {}
        self._all_results:    list = []   # CSV出力用に全結果を保持
        self._pending_results: list = []  # バッチ挿入バッファ

        self._fetch_worker: FetchAllWorker   | None = None
        self._route_worker: RouteCheckWorker | None = None

        # 検証中は 300ms ごとにまとめてテーブルへ挿入する
        self._flush_timer = QTimer(self)
        self._flush_timer.setInterval(300)
        self._flush_timer.timeout.connect(self._flush_pending)

        self._build_ui()
        self._apply_theme()

    # ── テーマ ────────────────────────────────────────────────────────────────

    def _apply_theme(self):
        self.setStyleSheet(f"""
            QMainWindow, QWidget {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
            QScrollBar:vertical   {{ background: {BG_BAR}; width: 8px; border-radius: 4px; }}
            QScrollBar::handle:vertical {{ background: #4B5563; border-radius: 4px; min-height: 20px; }}
            QScrollBar:horizontal {{ background: {BG_BAR}; height: 8px; border-radius: 4px; }}
            QScrollBar::handle:horizontal {{ background: #4B5563; border-radius: 4px; min-width: 20px; }}
            QLineEdit {{
                background: #374151; color: {TXT_PRIMARY};
                border: 1px solid #4B5563; border-radius: 6px;
                padding: 5px 10px; font-size: 15px;
            }}
            QLineEdit:focus {{ border-color: {ACCENT}; }}
            QProgressBar {{
                background: #374151; border: none; border-radius: 4px; color: transparent;
            }}
            QProgressBar::chunk {{ background: {ACCENT}; border-radius: 4px; }}
            QComboBox {{
                background: #374151; color: {TXT_PRIMARY};
                border: 1px solid #4B5563; border-radius: 6px;
                padding: 3px 8px; font-size: 13px; min-width: 80px;
            }}
            QComboBox QAbstractItemView {{
                background: #374151; color: {TXT_PRIMARY};
                selection-background-color: {BTN_ACTIVE};
            }}
            QCheckBox {{ color: {TXT_SUB}; font-size: 13px; spacing: 6px; }}
            QTableWidget {{
                background: {BG_TABLE}; color: {TXT_PRIMARY};
                alternate-background-color: {BG_ROW_ALT};
                gridline-color: {BORDER}; border: 1px solid {BORDER};
                font-size: 13px;
            }}
            QTableWidget::item {{ padding: 3px 8px; }}
            QTableWidget::item:selected {{ background: {BG_SEL}; }}
            QHeaderView::section {{
                background: #1F2937; color: {TXT_KEY};
                border: none; border-right: 1px solid {BORDER};
                padding: 5px 8px; font-size: 13px; font-weight: bold;
            }}
            QHeaderView::section:hover {{ background: #2D3748; }}
        """)

    # ── UI構築 ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(0)
        vbox.addWidget(self._build_topbar())
        vbox.addWidget(self._build_filterbar())
        vbox.addWidget(self._build_table(), stretch=1)

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(62)
        bar.setStyleSheet(f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};")
        row = QHBoxLayout(bar)
        row.setContentsMargins(16, 0, 16, 0)
        row.setSpacing(10)

        title = QLabel("IKU NAVI ルートチェッカー")
        title.setFont(QFont("", 18, QFont.Weight.Bold))
        title.setStyleSheet(f"color: {ACCENT};")
        row.addWidget(title)

        row.addSpacing(16)
        lbl = QLabel("API URL:")
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 15px;")
        row.addWidget(lbl)

        self._api_edit = QLineEdit(DEFAULT_API)
        self._api_edit.setFixedWidth(240)
        self._api_edit.returnPressed.connect(self._start_fetch)
        row.addWidget(self._api_edit)

        self._fetch_btn = self._btn("教室取得", ACCENT, "#001A22")
        self._fetch_btn.setFixedSize(90, 34)
        self._fetch_btn.clicked.connect(self._start_fetch)
        row.addWidget(self._fetch_btn)

        self._start_btn = self._btn("検証開始", "#059669", "#FFF")
        self._start_btn.setFixedSize(90, 34)
        self._start_btn.setEnabled(False)
        self._start_btn.clicked.connect(self._start_check)
        row.addWidget(self._start_btn)

        self._stop_btn = self._btn("停止", "#7F1D1D", "#FFF")
        self._stop_btn.setFixedSize(60, 34)
        self._stop_btn.setEnabled(False)
        self._stop_btn.clicked.connect(self._stop_check)
        row.addWidget(self._stop_btn)

        self._export_btn = self._btn("CSV出力", BTN_IDLE, TXT_PRIMARY)
        self._export_btn.setFixedSize(80, 34)
        self._export_btn.setEnabled(False)
        self._export_btn.clicked.connect(self._export_csv)
        row.addWidget(self._export_btn)

        row.addSpacing(8)
        self._progress = QProgressBar()
        self._progress.setFixedSize(200, 8)
        self._progress.setRange(0, 1)
        self._progress.setValue(0)
        self._progress.setTextVisible(False)
        row.addWidget(self._progress)

        row.addStretch()

        self._status_lbl = QLabel("API URL を入力して「教室取得」を押してください")
        self._status_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 14px;")
        row.addWidget(self._status_lbl)

        return bar

    def _build_filterbar(self) -> QWidget:
        bar = QWidget()
        bar.setFixedHeight(46)
        bar.setStyleSheet(f"background: {BG_BAR}; border-bottom: 1px solid {BORDER};")
        row = QHBoxLayout(bar)
        row.setContentsMargins(16, 0, 16, 0)
        row.setSpacing(10)

        # 検証設定
        self._excl_toilet = QCheckBox("トイレ除外")
        self._excl_toilet.setChecked(True)
        row.addWidget(self._excl_toilet)

        self._directed = QCheckBox("双方向 (A→B と B→A 両方)")
        self._directed.setChecked(False)
        row.addWidget(self._directed)

        self._detect_loop = QCheckBox("ループ検出")
        self._detect_loop.setChecked(False)
        self._detect_loop.setToolTip(
            "経路中に同一ノードが2回以上登場する場合（グラフループ）を異常として検出します。\n"
            "Dijkstra は通常ループを生成しないため、検出された場合はデータの問題を示します。"
        )
        row.addWidget(self._detect_loop)

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.VLine)
        sep.setFixedHeight(24)
        sep.setStyleSheet(f"color: {BORDER};")
        row.addWidget(sep)

        # 表示フィルタ
        row.addWidget(self._sub_lbl("表示:"))
        self._f_status = QComboBox()
        self._f_status.addItems(["全て", "OK", "異常", "経路なし", "エラー"])
        self._f_status.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_status)

        row.addWidget(self._sub_lbl("出発号館:"))
        self._f_from = QComboBox()
        self._f_from.addItem("全て", -1)
        self._f_from.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_from)

        row.addWidget(self._sub_lbl("目的号館:"))
        self._f_to = QComboBox()
        self._f_to.addItem("全て", -1)
        self._f_to.currentIndexChanged.connect(self._apply_filter)
        row.addWidget(self._f_to)

        row.addWidget(self._sub_lbl("検索:"))
        self._search = QLineEdit()
        self._search.setPlaceholderText("教室名…")
        self._search.setFixedWidth(130)
        self._search.textChanged.connect(self._apply_filter)
        row.addWidget(self._search)

        row.addStretch()

        self._count_lbl = QLabel("")
        self._count_lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 13px;")
        row.addWidget(self._count_lbl)

        return bar

    def _build_table(self) -> QTableWidget:
        self._table = QTableWidget(0, len(TABLE_HEADERS))
        self._table.setHorizontalHeaderLabels(TABLE_HEADERS)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setAlternatingRowColors(True)
        self._table.setSortingEnabled(True)
        self._table.verticalHeader().setVisible(False)
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self._table.horizontalHeader().setStretchLastSection(True)
        self._table.cellDoubleClicked.connect(self._on_double_click)

        for i, w in enumerate([90, 70, 55, 90, 70, 55, 75, 70, 260, 200]):
            self._table.setColumnWidth(i, w)

        return self._table

    # ── ウィジェットファクトリ ────────────────────────────────────────────────

    def _btn(self, text: str, bg: str, fg: str) -> QPushButton:
        b = QPushButton(text)
        b.setFont(QFont("", 13, QFont.Weight.Bold))
        b.setStyleSheet(f"""
            QPushButton {{ background: {bg}; color: {fg}; border-radius: 6px; border: none; }}
            QPushButton:disabled {{ background: #374151; color: #4B5563; }}
        """)
        return b

    def _sub_lbl(self, text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet(f"color: {TXT_SUB}; font-size: 13px;")
        return lbl

    # ── 教室取得 ──────────────────────────────────────────────────────────────

    def _start_fetch(self):
        url = self._api_edit.text().strip()
        if not url:
            QMessageBox.warning(self, "エラー", "API URL を入力してください。")
            return
        self._fetch_btn.setEnabled(False)
        self._start_btn.setEnabled(False)
        self._set_status("教室一覧とグラフを取得中...", TXT_SUB)

        self._fetch_worker = FetchAllWorker(url)
        self._fetch_worker.finished.connect(self._on_rooms_fetched)
        self._fetch_worker.error.connect(self._on_fetch_error)
        self._fetch_worker.start()

    def _on_fetch_error(self, msg: str):
        self._fetch_btn.setEnabled(True)
        self._set_status(f"取得エラー: {msg}", COL_ERR)
        QMessageBox.critical(self, "取得エラー", f"API に接続できませんでした:\n\n{msg}")

    def _on_rooms_fetched(self, rooms_list: list, edges_by_pair: dict):
        self._rooms_list    = rooms_list
        self._edges_by_pair = edges_by_pair

        buildings = sorted({r["building"] for r in rooms_list})
        for combo in (self._f_from, self._f_to):
            combo.blockSignals(True)
            combo.clear()
            combo.addItem("全て", -1)
            for b in buildings:
                combo.addItem(_bl(b), b)
            combo.blockSignals(False)

        n = len(rooms_list)
        self._set_status(
            f"教室 {n} 室を取得しました（トイレ除外後 {self._count_pairs()} ペアを検証予定）",
            COL_OK,
        )
        self._fetch_btn.setEnabled(True)
        self._start_btn.setEnabled(True)

    def _count_pairs(self) -> int:
        n = len(self._filtered_rooms())
        return n * (n - 1) if self._directed.isChecked() else n * (n - 1) // 2

    def _filtered_rooms(self) -> list:
        rooms = self._rooms_list
        if self._excl_toilet.isChecked():
            rooms = [r for r in rooms if r["room"] not in TOILET_ROOMS]
        return rooms

    # ── ルート検証 ───────────────────────────────────────────────────────────

    def _start_check(self):
        rooms = self._filtered_rooms()
        if len(rooms) < 2:
            QMessageBox.warning(self, "教室不足", "検証対象の教室が 2 室以上必要です。")
            return

        keys = [(r["room"], r["building"], r["floor"]) for r in rooms]
        directed = self._directed.isChecked()
        n = len(keys)

        if directed:
            pairs = [
                (*keys[i], *keys[j])
                for i in range(n) for j in range(n) if i != j
            ]
        else:
            pairs = [
                (*keys[i], *keys[j])
                for i in range(n) for j in range(i + 1, n)
            ]

        # テーブルをリセット
        self._table.setSortingEnabled(False)
        self._table.setRowCount(0)
        self._all_results.clear()
        self._pending_results.clear()

        self._start_btn.setEnabled(False)
        self._stop_btn.setEnabled(True)
        self._export_btn.setEnabled(False)
        self._progress.setRange(0, len(pairs))
        self._progress.setValue(0)
        self._set_status(f"0 / {len(pairs)} ペアを検証中...", TXT_SUB)

        self._route_worker = RouteCheckWorker(
            self._api_edit.text().strip(), pairs,
            detect_loop=self._detect_loop.isChecked(),
        )
        self._route_worker.route_ready.connect(self._on_route_ready)
        self._route_worker.progress.connect(self._on_progress)
        self._route_worker.finished.connect(self._on_finished)
        self._route_worker.start()
        self._flush_timer.start()

    def _stop_check(self):
        if self._route_worker:
            self._route_worker.stop()
        self._flush_timer.stop()
        self._flush_pending()
        self._stop_btn.setEnabled(False)
        self._set_status("停止中...", COL_ANOM)

    def _on_route_ready(self, result: dict):
        # メインスレッドのブロックを避けるためバッファに積むだけ
        self._all_results.append(result)
        self._pending_results.append(result)

    def _on_progress(self, done: int, total: int):
        self._progress.setValue(done)
        self._set_status(f"{done} / {total} ペアを検証中...", TXT_SUB)
        # フィルタ全走査は行わず件数表示のみ更新
        self._count_lbl.setText(f"取得済み: {self._table.rowCount()} 件")

    def _flush_pending(self):
        """バッファに溜まった結果をまとめてテーブルへ挿入する（300ms 間隔）"""
        if not self._pending_results:
            return
        batch, self._pending_results = self._pending_results, []

        tbl = self._table
        tbl.setUpdatesEnabled(False)
        for r in batch:
            self._add_row(r)
        tbl.setUpdatesEnabled(True)

        self._count_lbl.setText(f"取得済み: {tbl.rowCount()} 件")

    def _on_finished(self):
        self._flush_timer.stop()
        self._flush_pending()   # 残りをすべて挿入

        self._stop_btn.setEnabled(False)
        self._start_btn.setEnabled(True)
        self._export_btn.setEnabled(True)
        self._table.setSortingEnabled(True)

        ok  = sum(1 for r in self._all_results if r["status"] == "ok")
        an  = sum(1 for r in self._all_results if r["status"] == "anomaly")
        np_ = sum(1 for r in self._all_results if r["status"] == "no_path")
        er  = sum(1 for r in self._all_results if r["status"] == "error")
        tot = len(self._all_results)
        col = COL_ANOM if (an or er) else COL_OK
        self._set_status(
            f"完了: 全{tot}ペア  ✔OK:{ok}  ⚠異常:{an}  ✕経路なし:{np_}  ✕エラー:{er}",
            col,
        )
        self._apply_filter()   # 完了後に1回だけフィルタを適用

    # ── テーブル操作 ─────────────────────────────────────────────────────────

    def _add_row(self, r: dict):
        row_i = self._table.rowCount()
        self._table.insertRow(row_i)

        status   = r["status"]
        scol     = QColor(STATUS_COLOR.get(status, TXT_SUB))
        dist_str = f"{r['total_weight']:.1f}" if r.get("total_weight") is not None else "—"
        anom_str = "; ".join(ANOMALY_LABEL.get(t, t) for t, _ in r.get("anomalies", []))

        vals = [
            r["from_room"], _bl(r["from_building"]), _fl(r["from_floor"]),
            r["to_room"],   _bl(r["to_building"]),   _fl(r["to_floor"]),
            STATUS_LABEL.get(status, status),
            dist_str,
            r.get("floor_sequence", ""),
            anom_str or r.get("error_msg", ""),
        ]

        for ci, val in enumerate(vals):
            if ci == C_DIST:
                item = _NumItem(val)
            else:
                item = QTableWidgetItem(val)
            item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)

            if ci == C_STATUS:
                item.setForeground(QBrush(scol))
                if status == "anomaly":
                    item.setFont(QFont("", 12, QFont.Weight.Bold))
            elif ci == C_ANOM and anom_str:
                item.setForeground(QBrush(QColor(COL_ANOM)))

            # 結果dictを col 0 アイテムに格納（ダブルクリック時に取得）
            if ci == 0:
                item.setData(Qt.ItemDataRole.UserRole, r)

            self._table.setItem(row_i, ci, item)

        # 異常行の背景
        if status == "anomaly":
            for ci in range(len(TABLE_HEADERS)):
                it = self._table.item(row_i, ci)
                if it:
                    it.setBackground(QBrush(QColor("#241800")))

    def _apply_filter(self):
        status_map = {"全て": None, "OK": "ok", "異常": "anomaly",
                      "経路なし": "no_path", "エラー": "error"}
        sel_st   = status_map.get(self._f_status.currentText())
        sel_from = self._f_from.currentData()
        sel_to   = self._f_to.currentData()
        query    = self._search.text().strip().lower()

        visible = 0
        for row_i in range(self._table.rowCount()):
            item = self._table.item(row_i, 0)
            if item is None:
                self._table.setRowHidden(row_i, False)
                continue
            r    = item.data(Qt.ItemDataRole.UserRole)
            show = True
            if r:
                if sel_st   and r["status"]        != sel_st:   show = False
                if sel_from != -1 and r["from_building"] != sel_from: show = False
                if sel_to   != -1 and r["to_building"]   != sel_to:   show = False
                if query and query not in r["from_room"].lower() \
                         and query not in r["to_room"].lower():        show = False
            self._table.setRowHidden(row_i, not show)
            if show:
                visible += 1

        self._count_lbl.setText(
            f"表示: {visible} / {self._table.rowCount()} 件"
        )

    def _on_double_click(self, row: int, _col: int):
        item = self._table.item(row, 0)
        if item is None:
            return
        result = item.data(Qt.ItemDataRole.UserRole)
        if result is None:
            return
        PathDetailDialog(result, self._edges_by_pair, parent=self).exec()

    # ── CSV 出力 ─────────────────────────────────────────────────────────────

    def _export_csv(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "CSV に保存", "route_check_result.csv",
            "CSV ファイル (*.csv);;全ファイル (*)",
        )
        if not path:
            return
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(TABLE_HEADERS[:-1] + ["異常詳細"])
            for r in self._all_results:
                anom_str = " | ".join(desc for _, desc in r.get("anomalies", []))
                w.writerow([
                    r["from_room"], r["from_building"], r["from_floor"],
                    r["to_room"],   r["to_building"],   r["to_floor"],
                    r["status"],
                    f"{r['total_weight']:.2f}" if r.get("total_weight") is not None else "",
                    r.get("floor_sequence", ""),
                    anom_str or r.get("error_msg", ""),
                ])
        self._set_status(f"保存しました: {path}", COL_OK)

    # ── ユーティリティ ────────────────────────────────────────────────────────

    def _set_status(self, text: str, color: str):
        self._status_lbl.setText(text)
        self._status_lbl.setStyleSheet(f"color: {color}; font-size: 14px;")


# ── エントリーポイント ────────────────────────────────────────────────────────

def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
