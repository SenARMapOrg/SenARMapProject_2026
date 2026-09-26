#!/usr/bin/env python3
"""イベント設定タブ — メインウィンドウ"""

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMainWindow, QMessageBox, QPushButton, QScrollArea, QSplitter,
    QVBoxLayout, QWidget,
)

from .data_store import EVENT_CSV, EventLocation, EventStore, KIND_ROOM, load_building_name_map
from .location_row import LocationRowWidget

NEW_EVENT_TITLE = "新しいイベント"


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("イベント設定")
        self.resize(1100, 680)

        self.store = EventStore()
        self.name_map = load_building_name_map()
        self.refs_cache = {}   # {building: BuildingRefs} — LocationRowWidget 間で共有し、建物ごとに1回だけ読み込む
        self.current_entry = None
        self.location_rows = []  # 現在表示中の LocationRowWidget 一覧

        self._build_ui()
        self._reload_list()

    # ------------------------------------------------------------------
    # UI 構築
    # ------------------------------------------------------------------
    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)

        # --- 上部バー ---
        bar = QHBoxLayout()
        save_btn = QPushButton("💾 保存")
        save_btn.clicked.connect(self._save)
        reload_btn = QPushButton("🔄 再読み込み")
        reload_btn.clicked.connect(self._reload_from_disk)
        bar.addWidget(save_btn)
        bar.addWidget(reload_btn)
        bar.addStretch(1)
        self.dirty_label = QLabel("")
        self.dirty_label.setStyleSheet("color:#B45309;font-weight:bold;")
        bar.addWidget(self.dirty_label)
        outer.addLayout(bar)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        outer.addWidget(splitter, stretch=1)

        # --- 左: イベント一覧 ---
        left = QWidget()
        left_v = QVBoxLayout(left)
        left_v.setContentsMargins(0, 0, 0, 0)
        self.list_widget = QListWidget()
        self.list_widget.currentItemChanged.connect(self._on_selection_changed)
        left_v.addWidget(self.list_widget, stretch=1)

        left_btns = QHBoxLayout()
        add_event_btn = QPushButton("+ 新規イベント")
        add_event_btn.clicked.connect(self._add_event)
        del_event_btn = QPushButton("🗑 削除")
        del_event_btn.clicked.connect(self._delete_event)
        left_btns.addWidget(add_event_btn)
        left_btns.addWidget(del_event_btn)
        left_v.addLayout(left_btns)
        splitter.addWidget(left)

        # --- 右: 詳細編集 ---
        right = QWidget()
        right_v = QVBoxLayout(right)

        right_v.addWidget(QLabel("イベント名（検索候補に表示される名前）"))
        self.title_edit = QLineEdit()
        self.title_edit.textEdited.connect(self._on_title_edited)
        right_v.addWidget(self.title_edit)
        self.title_warn_label = QLabel("")
        self.title_warn_label.setStyleSheet("color:#B45309;font-size:11px;")
        right_v.addWidget(self.title_warn_label)

        right_v.addWidget(QLabel(
            "場所（複数登録すると、検索時に最短で行ける候補が自動で選ばれます）"
        ))

        self.locations_container = QWidget()
        self.locations_layout = QVBoxLayout(self.locations_container)
        self.locations_layout.setContentsMargins(0, 0, 0, 0)
        self.locations_layout.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.locations_container)
        right_v.addWidget(scroll, stretch=1)

        add_loc_btn = QPushButton("+ 場所を追加")
        add_loc_btn.clicked.connect(self._add_location)
        right_v.addWidget(add_loc_btn)

        hint = QLabel(
            "教室名・ノードID・エッジIDのいずれか1つで場所を指定します。\n"
            "屋外(建物=屋外)の場合、ノードID/エッジIDは global_node.csv / global_edge.csv のIDです。\n"
            "詳細は docs/NameDB_EventMode.md を参照してください。"
        )
        hint.setStyleSheet("color:#666;font-size:11px;")
        hint.setWordWrap(True)
        right_v.addWidget(hint)

        splitter.addWidget(right)
        splitter.setSizes([260, 840])

        self.right_panel = right
        self.right_panel.setEnabled(False)

    # ------------------------------------------------------------------
    # イベント一覧
    # ------------------------------------------------------------------
    def _reload_list(self):
        self.list_widget.blockSignals(True)
        self.list_widget.clear()
        for entry in self.store.entries:
            item = QListWidgetItem(self._list_label(entry))
            item.setData(Qt.ItemDataRole.UserRole, entry)
            self.list_widget.addItem(item)
        self.list_widget.blockSignals(False)
        if self.store.entries:
            self.list_widget.setCurrentRow(0)
        else:
            self._show_entry(None)
        self._update_dirty_indicator()

    @staticmethod
    def _list_label(entry) -> str:
        n = len(entry.locations)
        title = entry.title.strip() or "(名称未設定)"
        return f"{title}  [{n}箇所]"

    def _refresh_current_item_label(self):
        item = self.list_widget.currentItem()
        if item is not None and self.current_entry is not None:
            item.setText(self._list_label(self.current_entry))

    def _on_selection_changed(self, current: QListWidgetItem, _previous):
        entry = current.data(Qt.ItemDataRole.UserRole) if current is not None else None
        self._show_entry(entry)

    # ------------------------------------------------------------------
    # 詳細パネル
    # ------------------------------------------------------------------
    def _show_entry(self, entry):
        self.current_entry = entry
        self.right_panel.setEnabled(entry is not None)

        self.title_edit.blockSignals(True)
        self.title_edit.setText(entry.title if entry else "")
        self.title_edit.blockSignals(False)
        self._update_title_warning()

        self._clear_location_rows()
        if entry is not None:
            for loc in entry.locations:
                self._create_location_row(loc)

    def _clear_location_rows(self):
        for row in self.location_rows:
            self.locations_layout.removeWidget(row)
            row.deleteLater()
        self.location_rows = []

    def _create_location_row(self, location: EventLocation):
        row = LocationRowWidget(location, self.name_map, self.refs_cache)
        row.changed.connect(self._mark_dirty)
        row.removeRequested.connect(self._remove_location_row)
        self.locations_layout.insertWidget(self.locations_layout.count() - 1, row)
        self.location_rows.append(row)
        return row

    def _add_location(self):
        if self.current_entry is None:
            return
        loc = EventLocation(building=0, kind=KIND_ROOM, value="")
        self.current_entry.locations.append(loc)
        self._create_location_row(loc)
        self._mark_dirty()
        self._refresh_current_item_label()

    def _remove_location_row(self, row: LocationRowWidget):
        if self.current_entry is not None and row.location in self.current_entry.locations:
            self.current_entry.locations.remove(row.location)
        self.locations_layout.removeWidget(row)
        row.deleteLater()
        if row in self.location_rows:
            self.location_rows.remove(row)
        self._mark_dirty()
        self._refresh_current_item_label()

    # ------------------------------------------------------------------
    # イベント名編集
    # ------------------------------------------------------------------
    def _on_title_edited(self, text: str):
        if self.current_entry is None:
            return
        self.current_entry.title = text
        self._refresh_current_item_label()
        self._update_title_warning()
        self._mark_dirty()

    def _update_title_warning(self):
        if self.current_entry is None:
            self.title_warn_label.setText("")
            return
        title = self.current_entry.title.strip()
        dup = title and any(
            e is not self.current_entry and e.title.strip() == title for e in self.store.entries
        )
        self.title_warn_label.setText(
            "⚠ 同じ名前のイベントが既にあります（保存すると自動的に1つに統合されます）" if dup else ""
        )

    # ------------------------------------------------------------------
    # イベントの追加・削除
    # ------------------------------------------------------------------
    def _add_event(self):
        entry = self.store.add_entry(NEW_EVENT_TITLE)
        item = QListWidgetItem(self._list_label(entry))
        item.setData(Qt.ItemDataRole.UserRole, entry)
        self.list_widget.addItem(item)
        self.list_widget.setCurrentItem(item)
        self.title_edit.setFocus()
        self.title_edit.selectAll()
        self._update_dirty_indicator()

    def _delete_event(self):
        item = self.list_widget.currentItem()
        if item is None or self.current_entry is None:
            return
        title = self.current_entry.title.strip() or "(名称未設定)"
        reply = QMessageBox.question(
            self, "確認", f"イベント「{title}」を削除しますか？\n（保存するまでファイルには反映されません）"
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        self.store.remove_entry(self.current_entry)
        self.list_widget.takeItem(self.list_widget.row(item))
        self._update_dirty_indicator()

    # ------------------------------------------------------------------
    # 保存・再読み込み
    # ------------------------------------------------------------------
    def _mark_dirty(self):
        self.store.dirty = True
        self._update_dirty_indicator()

    def _update_dirty_indicator(self):
        self.dirty_label.setText("● 未保存の変更あり" if self.store.dirty else "")

    def _collect_invalid_count(self) -> int:
        count = 0
        for entry in self.store.entries:
            for loc in entry.locations:
                from .data_store import BuildingRefs
                refs = self.refs_cache.setdefault(loc.building, BuildingRefs(loc.building))
                if refs.validate(loc.kind, loc.value):
                    count += 1
        return count

    def _save(self):
        invalid = self._collect_invalid_count()
        if invalid:
            reply = QMessageBox.question(
                self, "確認",
                f"内容に問題がある場所が {invalid} 件あります（赤色表示の行）。\n"
                "このまま保存すると、該当の場所はナビ側で無視されます。\n保存を続けますか？",
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
        self.store.save()
        self._update_dirty_indicator()
        QMessageBox.information(
            self, "保存完了",
            f"{EVENT_CSV} に保存しました。\nFlask側（app.py）は再起動またはキャッシュクリアで反映されます。",
        )

    def _reload_from_disk(self):
        if not self._confirm_discard_if_dirty():
            return
        self.store = EventStore()
        self.refs_cache = {}
        self._reload_list()

    # ------------------------------------------------------------------
    def _confirm_discard_if_dirty(self) -> bool:
        if not self.store.dirty:
            return True
        reply = QMessageBox.question(
            self, "未保存の変更があります", "保存しますか？",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if reply == QMessageBox.StandardButton.Save:
            self._save()
            return True
        if reply == QMessageBox.StandardButton.Discard:
            return True
        return False

    def closeEvent(self, event):
        if not self._confirm_discard_if_dirty():
            event.ignore()
            return
        super().closeEvent(event)
