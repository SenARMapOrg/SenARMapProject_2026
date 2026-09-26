#!/usr/bin/env python3
"""IKU NAVI Map Editor — ノード/エッジ入力ダイアログ"""

from PyQt6.QtWidgets import (
    QComboBox, QDialog, QDialogButtonBox, QDoubleSpinBox, QFormLayout,
    QLabel, QLineEdit, QSpinBox,
)

from .data_store import EDGE_TYPE_LABELS, NODE_TYPE_LABELS


def _add_ok_cancel_buttons(dialog: QDialog, form: QFormLayout):
    """OK/キャンセルの QDialogButtonBox をフォームの最後の行として追加する"""
    buttons = QDialogButtonBox(
        QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
    )
    buttons.accepted.connect(dialog.accept)
    buttons.rejected.connect(dialog.reject)
    form.addRow(buttons)


class NodeDialog(QDialog):
    """入力モードでSVGをクリックした際、実座標(x,y,z)を入力するダイアログ"""

    def __init__(self, default_floor: int, default_id: int, parent=None):
        super().__init__(parent)
        self.setWindowTitle("ノードを追加")
        self.setMinimumWidth(340)

        form = QFormLayout(self)

        self.id_spin = QSpinBox()
        self.id_spin.setRange(1, 999999)
        self.id_spin.setValue(default_id)
        form.addRow("ノードID:", self.id_spin)

        self.x_spin = self._make_coord_spin()
        self.y_spin = self._make_coord_spin()
        self.z_spin = self._make_coord_spin()
        form.addRow("X座標 (m):", self.x_spin)
        form.addRow("Y座標 (m):", self.y_spin)
        form.addRow("Z座標 (m, 高さ):", self.z_spin)

        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(default_floor)
        form.addRow("階:", self.floor_spin)

        self.type_combo = QComboBox()
        for v, label in NODE_TYPE_LABELS.items():
            self.type_combo.addItem(f"{v}: {label}", v)
        form.addRow("種別:", self.type_combo)

        hint = QLabel("SVG上のクリック位置(svg_x/svg_y)は自動で記録されます。\n"
                       "実際のメートル座標(建物ローカル)だけをここで入力してください。")
        hint.setStyleSheet("color:#666;font-size:11px;")
        hint.setWordWrap(True)
        form.addRow(hint)

        _add_ok_cancel_buttons(self, form)

    @staticmethod
    def _make_coord_spin() -> QDoubleSpinBox:
        sp = QDoubleSpinBox()
        sp.setRange(-100000.0, 100000.0)
        sp.setDecimals(1)
        sp.setSingleStep(0.5)
        return sp

    def values(self) -> dict:
        return {
            "id": self.id_spin.value(),
            "x": self.x_spin.value(),
            "y": self.y_spin.value(),
            "z": self.z_spin.value(),
            "floor": self.floor_spin.value(),
            "type": self.type_combo.currentData(),
        }


class EdgeDialog(QDialog):
    """入力モードでノードを2つ選んだ際、エッジ情報を入力するダイアログ"""

    def __init__(self, label_a: str, label_b: str, default_floor: int,
                 default_length: float, default_id: int,
                 default_type: int = 1, parent=None):
        super().__init__(parent)
        self.setWindowTitle("エッジを追加")
        self.setMinimumWidth(360)

        form = QFormLayout(self)
        form.addRow(QLabel(f"開始: {label_a}"))
        form.addRow(QLabel(f"終了: {label_b}"))

        self.id_spin = QSpinBox()
        self.id_spin.setRange(1, 9999999)
        self.id_spin.setValue(default_id)
        form.addRow("エッジID:", self.id_spin)

        self.name_edit = QLineEdit()
        self.name_edit.setPlaceholderText("教室名など。複数は ; 区切り（例: 101A;101B）。無ければ空欄")
        form.addRow("名前 (教室名):", self.name_edit)

        self.weight_spin = QDoubleSpinBox()
        self.weight_spin.setRange(0.1, 100.0)
        self.weight_spin.setDecimals(2)
        self.weight_spin.setValue(1.0)
        form.addRow("重み (weight):", self.weight_spin)

        self.length_spin = QDoubleSpinBox()
        self.length_spin.setRange(0.0, 100000.0)
        self.length_spin.setDecimals(2)
        self.length_spin.setValue(round(default_length, 2))
        form.addRow("距離 (length, m):", self.length_spin)

        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(default_floor)
        form.addRow("階 (低い方を推奨):", self.floor_spin)

        self.type_combo = QComboBox()
        for v, label in EDGE_TYPE_LABELS.items():
            self.type_combo.addItem(f"{v}: {label}", v)
        idx = self.type_combo.findData(default_type)
        if idx >= 0:
            self.type_combo.setCurrentIndex(idx)
        form.addRow("種別:", self.type_combo)

        hint = QLabel(
            "上りエスカレータ(5)・下りエスカレータ(6)は方向自動判定（z座標基準）のため\n"
            "from/toの向きは気にせず選択してOKです。"
        )
        hint.setStyleSheet("color:#666;font-size:11px;")
        hint.setWordWrap(True)
        form.addRow(hint)

        _add_ok_cancel_buttons(self, form)

    def values(self) -> dict:
        return {
            "id": self.id_spin.value(),
            "name": self.name_edit.text().strip(),
            "weight": self.weight_spin.value(),
            "length": self.length_spin.value(),
            "floor": self.floor_spin.value(),
            "type": self.type_combo.currentData(),
        }


def suggest_edge_type(floor_a: int, floor_b: int) -> int:
    """階が異なる場合は階段(2)を、同じ階なら通常通路(1)を初期値として提案する"""
    return 2 if floor_a != floor_b else 1
