#!/usr/bin/env python3
"""イベント設定タブ — メインウィンドウ"""

from __future__ import annotations

from PyQt6.QtCore import QSettings, Qt, QTimer
from PyQt6.QtWidgets import (
    QApplication, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QMainWindow, QMessageBox, QPushButton, QScrollArea, QSplitter,
    QVBoxLayout, QWidget,
)

from .data_store import (
    EVENT_CSV, EventLocation, EventStore, KIND_ROOM, event_url, event_url_lines,
    load_building_name_map, normalize_ref_code, validate_event_id,
)
from .location_row import LocationRowWidget

NEW_EVENT_TITLE = "新しいイベント"
REF_CODE_SETTING = "events/ref_code"   # 最後に入れた案内係コード（次に開いたときも入っているように）


class MainWindow(QMainWindow):

    def __init__(self, settings: QSettings | None = None):
        super().__init__()
        self.setWindowTitle("イベント設定")
        self.resize(1100, 680)

        self.store = EventStore()
        self.name_map = load_building_name_map()
        self.refs_cache = {}   # {building: BuildingRefs} — LocationRowWidget 間で共有し、建物ごとに1回だけ読み込む
        self.current_entry = None
        self.location_rows = []  # 現在表示中の LocationRowWidget 一覧
        self.settings = settings or QSettings("SenARMap", "IKU_NAVI_Tools")

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
        copy_all_btn = QPushButton("📋 全イベントのURLをコピー")
        copy_all_btn.setToolTip("「名前,URL」を1行ずつコピーする。案内係コードを入れていれば、カウンター用のURLになる")
        copy_all_btn.clicked.connect(self._copy_all_urls)
        bar.addWidget(copy_all_btn)
        bar.addStretch(1)
        self.copied_label = QLabel("")
        self.copied_label.setStyleSheet("color:#047857;font-weight:bold;")
        bar.addWidget(self.copied_label)
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

        right_v.addWidget(QLabel("ID（URLでこのイベントを呼び出すための名前。半角の英数字・-・_）"))
        id_row = QHBoxLayout()
        self.id_edit = QLineEdit()
        self.id_edit.setMaximumWidth(200)
        self.id_edit.textEdited.connect(self._on_id_edited)
        id_row.addWidget(self.id_edit)
        self.url_label = QLabel("")
        self.url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.url_label.setStyleSheet("color:#444;font-size:11px;")
        id_row.addWidget(self.url_label, stretch=1)
        self.copy_url_btn = QPushButton("📋 URLをコピー")
        self.copy_url_btn.clicked.connect(lambda: self._copy_url(with_ref=False))
        id_row.addWidget(self.copy_url_btn)
        right_v.addLayout(id_row)
        self.id_warn_label = QLabel("")
        self.id_warn_label.setStyleSheet("color:#B45309;font-size:11px;")
        right_v.addWidget(self.id_warn_label)

        right_v.addWidget(QLabel(
            "案内係コード（案内人数のカウンター用。集計の管理画面で案内係を追加すると出る8文字）"
        ))
        ref_row = QHBoxLayout()
        self.ref_edit = QLineEdit()
        self.ref_edit.setMaximumWidth(200)
        self.ref_edit.setPlaceholderText("例: 7KQ2M9XA")
        self.ref_edit.setText(str(self.settings.value(REF_CODE_SETTING, "") or ""))
        self.ref_edit.textEdited.connect(self._on_ref_edited)
        ref_row.addWidget(self.ref_edit)
        self.counter_url_label = QLabel("")
        self.counter_url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.counter_url_label.setStyleSheet("color:#444;font-size:11px;")
        ref_row.addWidget(self.counter_url_label, stretch=1)
        self.copy_counter_btn = QPushButton("📋 カウンター用URLをコピー")
        self.copy_counter_btn.clicked.connect(lambda: self._copy_url(with_ref=True))
        ref_row.addWidget(self.copy_counter_btn)
        right_v.addLayout(ref_row)
        self.ref_warn_label = QLabel("")
        self.ref_warn_label.setStyleSheet("color:#B45309;font-size:11px;")
        right_v.addWidget(self.ref_warn_label)

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
            "エッジIDのときは、教室と同じように通路のどちら側の何番目かも指定できます（到着時に「右手、○○から数えて2番目」と案内）。"
            "左右と何番目は、そのエッジを from→to の向きに歩いたときの値で、何番目は同じ通路の同じ側の展示どうしの並び順です。\n"
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
        event_id = entry.event_id.strip()
        return f"{title}  [{n}箇所]" + (f"  id={event_id}" if event_id else "")

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
        self.id_edit.blockSignals(True)
        self.id_edit.setText(entry.event_id if entry else "")
        self.id_edit.blockSignals(False)
        self._update_id_warning()

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

    def _on_id_edited(self, text: str):
        if self.current_entry is None:
            return
        self.current_entry.event_id = text.strip()
        self._refresh_current_item_label()
        self._update_id_warning()
        self._mark_dirty()

    def _update_id_warning(self):
        err = self._current_id_error()
        if self.current_entry is None:
            self.id_warn_label.setText("")
            self.url_label.setText("")
        else:
            self.id_warn_label.setText(f"⚠ {err}" if err else "")
            self.url_label.setText(f"呼び出しURL: {event_url(self.current_entry.event_id)}" if not err else "")
        self.copy_url_btn.setEnabled(self.current_entry is not None and not err)
        self._update_counter_url()

    def _current_id_error(self) -> str:
        if self.current_entry is None:
            return "イベントが選ばれていません"
        return validate_event_id(self.current_entry.event_id, self.store.used_ids(exclude=self.current_entry))

    # ------------------------------------------------------------------
    # URLのコピー（案内係コードを付けるとカウンター用）
    # ------------------------------------------------------------------
    def _on_ref_edited(self, text: str):
        code, _ = normalize_ref_code(text)
        self.settings.setValue(REF_CODE_SETTING, code)
        self._update_counter_url()

    def _update_counter_url(self):
        code, ref_err = normalize_ref_code(self.ref_edit.text())
        id_err = self._current_id_error()
        self.ref_warn_label.setText(f"⚠ {ref_err}" if ref_err else "")
        ok = bool(code) and not ref_err and not id_err
        self.counter_url_label.setText(
            f"カウンター用URL: {event_url(self.current_entry.event_id, code)}" if ok else ""
        )
        self.copy_counter_btn.setEnabled(ok)

    def _copy_url(self, with_ref: bool):
        if self.current_entry is None or self._current_id_error():
            return
        code = ""
        if with_ref:
            code, ref_err = normalize_ref_code(self.ref_edit.text())
            if not code or ref_err:
                return
        self._copy_text(event_url(self.current_entry.event_id, code),
                        "カウンター用URLをコピーしました" if with_ref else "URLをコピーしました")

    def _copy_all_urls(self):
        code, ref_err = normalize_ref_code(self.ref_edit.text())
        if ref_err:
            QMessageBox.warning(self, "案内係コード", f"{ref_err}\n直すか空にしてからコピーしてください。")
            return
        text = event_url_lines(self.store.entries, code)
        if not text:
            return
        n = text.count("\n") + 1
        self._copy_text(text, f"{n} 件のカウンター用URLをコピーしました" if code else f"{n} 件のURLをコピーしました")

    def _copy_text(self, text: str, message: str):
        QApplication.clipboard().setText(text)
        self.copied_label.setText(f"✓ {message}")
        QTimer.singleShot(3000, lambda: self.copied_label.setText(""))

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

    def _collect_id_problems(self) -> list:
        problems = []
        for entry in self.store.entries:
            if not entry.title.strip():
                continue
            err = validate_event_id(entry.event_id, self.store.used_ids(exclude=entry))
            if err:
                problems.append(f"・{entry.title.strip()}: {err}")
        return problems

    def _save(self):
        id_problems = self._collect_id_problems()
        if id_problems:
            reply = QMessageBox.question(
                self, "確認",
                "IDに問題があるイベントがあります（URLで呼び出せない・別のイベントが開くことがあります）。\n"
                + "\n".join(id_problems[:10]) + "\n保存を続けますか？",
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
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
