#!/usr/bin/env python3
"""IKU NAVI Event Editor — イベント1箇所分（建物・種別・値）を編集する行ウィジェット"""

from PyQt6.QtCore import pyqtSignal
from PyQt6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QPushButton, QWidget

from .data_store import KIND_EDGE, KIND_LABELS, KIND_NODE, KIND_ROOM, building_label, list_buildings

PLACEHOLDER = "-- 選択してください --"


class LocationRowWidget(QWidget):
    """1つの EventLocation を編集する行。建物・種別・値（教室名 or ID）を選ぶUI。"""

    changed = pyqtSignal()
    removeRequested = pyqtSignal(QWidget)

    def __init__(self, location, name_map: dict, refs_cache: dict, parent=None):
        super().__init__(parent)
        self.location = location
        self.name_map = name_map
        self.refs_cache = refs_cache  # {building: BuildingRefs}（呼び出し元と共有し、建物ごとに1回だけ読み込む）

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.building_combo = QComboBox()
        self.building_combo.setMinimumWidth(110)
        for bid in list_buildings():
            self.building_combo.addItem(building_label(bid, name_map), bid)
        layout.addWidget(self.building_combo)

        self.kind_combo = QComboBox()
        self.kind_combo.setMinimumWidth(90)
        for kind in (KIND_ROOM, KIND_NODE, KIND_EDGE):
            self.kind_combo.addItem(KIND_LABELS[kind], kind)
        layout.addWidget(self.kind_combo)

        self.value_combo = QComboBox()
        self.value_combo.setMinimumWidth(220)
        layout.addWidget(self.value_combo, stretch=1)

        self.error_label = QLabel("")
        self.error_label.setStyleSheet("color:#DC2626;font-size:11px;")
        layout.addWidget(self.error_label, stretch=1)

        self.delete_btn = QPushButton("✕")
        self.delete_btn.setFixedWidth(28)
        self.delete_btn.setToolTip("この場所を削除")
        layout.addWidget(self.delete_btn)

        # 初期表示をlocationの内容に合わせる
        idx = self.building_combo.findData(location.building)
        self.building_combo.setCurrentIndex(idx if idx >= 0 else 0)
        idx = self.kind_combo.findData(location.kind)
        self.kind_combo.setCurrentIndex(idx if idx >= 0 else 0)
        self._rebuild_value_combo(preselect=location.value)

        self.building_combo.currentIndexChanged.connect(self._on_building_changed)
        self.kind_combo.currentIndexChanged.connect(self._on_kind_changed)
        self.value_combo.currentIndexChanged.connect(self._on_value_changed)
        self.value_combo.editTextChanged.connect(self._on_value_changed)
        self.delete_btn.clicked.connect(lambda: self.removeRequested.emit(self))

    # ------------------------------------------------------------------
    def _refs(self, building: int):
        if building not in self.refs_cache:
            from .data_store import BuildingRefs
            self.refs_cache[building] = BuildingRefs(building)
        return self.refs_cache[building]

    def _rebuild_value_combo(self, preselect: str = ""):
        """建物・種別に応じて選択肢を作り直す。既存値が候補になければ警告付きで先頭に残す。"""
        kind = self.location.kind
        refs = self._refs(self.location.building)

        self.value_combo.blockSignals(True)
        self.value_combo.clear()

        if kind == KIND_ROOM:
            self.value_combo.setEditable(True)
            self.value_combo.addItem("", "")
            for room in refs.rooms:
                self.value_combo.addItem(room, room)
            known = set(refs.rooms)
        elif kind == KIND_NODE:
            self.value_combo.setEditable(False)
            self.value_combo.addItem(PLACEHOLDER, "")
            for nid in refs.node_ids:
                self.value_combo.addItem(str(nid), str(nid))
            known = {str(n) for n in refs.node_ids}
        else:
            self.value_combo.setEditable(False)
            self.value_combo.addItem(PLACEHOLDER, "")
            for eid, label in refs.edges:
                self.value_combo.addItem(label, str(eid))
            known = {str(eid) for eid, _ in refs.edges}

        if preselect and preselect not in known:
            self.value_combo.insertItem(1, f"⚠ {preselect}（現在は無効な値）", preselect)

        idx = self.value_combo.findData(preselect) if preselect else 0
        self.value_combo.setCurrentIndex(idx if idx >= 0 else 0)
        if kind == KIND_ROOM:
            self.value_combo.setEditText(preselect or "")

        self.value_combo.blockSignals(False)
        self.location.value = preselect or ""
        self._update_validation()

    # ------------------------------------------------------------------
    def _on_building_changed(self):
        self.location.building = self.building_combo.currentData()
        self._rebuild_value_combo(preselect="")
        self.changed.emit()

    def _on_kind_changed(self):
        self.location.kind = self.kind_combo.currentData()
        self._rebuild_value_combo(preselect="")
        self.changed.emit()

    def _on_value_changed(self):
        if self.location.kind == KIND_ROOM:
            self.location.value = self.value_combo.currentText().strip()
        else:
            data = self.value_combo.currentData()
            self.location.value = data or ""
        self._update_validation()
        self.changed.emit()

    def _update_validation(self):
        refs = self._refs(self.location.building)
        err = refs.validate(self.location.kind, self.location.value)
        self.error_label.setText(err)
        self.value_combo.setStyleSheet("" if not err else "background:#FEE2E2;")

    def is_valid(self) -> bool:
        refs = self._refs(self.location.building)
        return not refs.validate(self.location.kind, self.location.value)
