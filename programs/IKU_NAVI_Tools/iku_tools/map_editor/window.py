#!/usr/bin/env python3
"""マップ編集タブ — メインウィンドウ"""

import cv2

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont
from PyQt6.QtWidgets import (
    QButtonGroup, QComboBox, QFileDialog,
    QHBoxLayout, QLabel, QListWidget, QMainWindow, QMessageBox,
    QPushButton, QSpinBox, QSplitter, QStackedWidget, QVBoxLayout, QWidget,
)

from .camera_panel import bgr_frame_to_pixmap, CameraPanel
from .data_store import (
    EDGE_TYPE_LABELS, EdgeImageStore, BuildingData, NODE_TYPE_LABELS,
    PHOTO_DIR, global_id, list_buildings, svg_path_for, to_int,
)
from .dialogs import EdgeDialog, NodeDialog, suggest_edge_type
from .svg_canvas import SvgCanvas

MODE_LABELS = [
    (SvgCanvas.MODE_MOVE,   "🖐 移動"),
    (SvgCanvas.MODE_INPUT,  "✏️ 入力"),
    (SvgCanvas.MODE_DELETE, "🗑 削除"),
    (SvgCanvas.MODE_CAMERA, "📷 撮影"),
]

MODE_HINT = {
    SvgCanvas.MODE_MOVE:   "ドラッグでパン・ホイールでズームします（クリックでは何も起きません）。",
    SvgCanvas.MODE_INPUT:  "空白をクリックしてノードを追加。既存ノードを2つ順にクリックするとエッジを作成します（Escで選択解除）。",
    SvgCanvas.MODE_DELETE: "ノードまたはエッジをクリックして削除します。ノード削除時は接続エッジも削除されます。",
    SvgCanvas.MODE_CAMERA: "撮影したいエッジ（線）をクリックして選択し、右パネルから撮影してください。",
}


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("マップ編集")
        self.resize(1440, 900)

        self.building_data: BuildingData | None = None
        self.edge_image_store = EdgeImageStore()
        self.current_building: int | None = None
        self.current_floor: int = 1
        self.selected_edge_id: int | None = None

        self._build_ui()
        self._connect_canvas_signals()
        self._reload_building_list()

    # ------------------------------------------------------------------
    # UI 構築
    # ------------------------------------------------------------------
    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        vbox = QVBoxLayout(root)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(0)

        vbox.addWidget(self._build_topbar())
        vbox.addWidget(self._build_modebar())

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.canvas = SvgCanvas()
        splitter.addWidget(self.canvas)

        self.side_stack = QStackedWidget()
        self.side_stack.addWidget(self._build_info_page())
        self.side_stack.addWidget(self._build_camera_page())
        self.side_stack.setFixedWidth(360)
        splitter.addWidget(self.side_stack)
        splitter.setSizes([1080, 360])
        vbox.addWidget(splitter, 1)

        self.statusBar().showMessage("建物を選択してください")

    def _build_topbar(self) -> QWidget:
        bar = QWidget()
        bar.setStyleSheet("background:#1F2937;")
        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 8, 12, 8)
        row.setSpacing(10)

        title = QLabel("マップ編集")
        title.setFont(QFont("", 15, QFont.Weight.Bold))
        title.setStyleSheet("color:#00B8E6;")
        row.addWidget(title)

        row.addSpacing(16)
        row.addWidget(self._lbl("建物:"))
        self.building_combo = QComboBox()
        self.building_combo.currentIndexChanged.connect(self._on_building_changed)
        row.addWidget(self.building_combo)

        rescan_btn = QPushButton("再スキャン")
        rescan_btn.clicked.connect(self._reload_building_list)
        row.addWidget(rescan_btn)

        row.addSpacing(8)
        row.addWidget(self._lbl("階:"))
        self.floor_spin = QSpinBox()
        self.floor_spin.setRange(-5, 50)
        self.floor_spin.setValue(1)
        self.floor_spin.valueChanged.connect(self._on_floor_changed)
        row.addWidget(self.floor_spin)

        self.floors_hint_label = self._lbl("")
        row.addWidget(self.floors_hint_label)

        row.addSpacing(8)
        self.svg_path_label = self._lbl("SVG: —")
        row.addWidget(self.svg_path_label)

        browse_btn = QPushButton("SVGを選択...")
        browse_btn.clicked.connect(self._browse_svg)
        row.addWidget(browse_btn)

        row.addStretch()

        self.dirty_label = QLabel("")
        self.dirty_label.setStyleSheet("color:#FBBF24; font-weight:bold;")
        row.addWidget(self.dirty_label)

        save_btn = QPushButton("💾 保存")
        save_btn.setStyleSheet(
            "QPushButton{background:#059669;color:white;padding:6px 16px;border-radius:6px;font-weight:bold;}"
        )
        save_btn.clicked.connect(self._save_all)
        row.addWidget(save_btn)

        return bar

    def _build_modebar(self) -> QWidget:
        bar = QWidget()
        bar.setStyleSheet("background:#111827; border-bottom:1px solid #2D3748;")
        row = QHBoxLayout(bar)
        row.setContentsMargins(12, 6, 12, 6)
        row.setSpacing(6)

        self.mode_group = QButtonGroup(self)
        self.mode_group.setExclusive(True)
        for mode, label in MODE_LABELS:
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setStyleSheet("""
                QPushButton { padding:6px 14px; border-radius:6px; color:#CBD5E1; background:#1F2937; border:none; }
                QPushButton:checked { background:#0E7490; color:white; font-weight:bold; }
            """)
            btn.clicked.connect(lambda _checked, m=mode: self._set_mode(m))
            self.mode_group.addButton(btn)
            row.addWidget(btn)
            if mode == SvgCanvas.MODE_MOVE:
                btn.setChecked(True)

        row.addSpacing(16)
        self.mode_hint_label = QLabel(MODE_HINT[SvgCanvas.MODE_MOVE])
        self.mode_hint_label.setStyleSheet("color:#94A3B8; font-size:12px;")
        row.addWidget(self.mode_hint_label, 1)

        return bar

    def _build_info_page(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)

        self.info_summary_label = QLabel("ノード: 0　エッジ: 0")
        self.info_summary_label.setFont(QFont("", 12, QFont.Weight.Bold))
        vbox.addWidget(self.info_summary_label)

        vbox.addWidget(self._lbl("ノード一覧 (現在の階):"))
        self.node_list = QListWidget()
        self.node_list.setFont(QFont("Courier", 10))
        vbox.addWidget(self.node_list, 1)

        vbox.addWidget(self._lbl("エッジ一覧 (現在の階):"))
        self.edge_list = QListWidget()
        self.edge_list.setFont(QFont("Courier", 10))
        vbox.addWidget(self.edge_list, 1)

        note = QLabel(
            "※ svg_x/svg_y が未設定のノードは地図上に表示されません。\n"
            "※ 階をまたぐエッジ（階段・EV等）はこの階の地図上には線が表示されません（両端ノードは各階に表示されます）。"
        )
        note.setStyleSheet("color:#888; font-size:10px;")
        note.setWordWrap(True)
        vbox.addWidget(note)

        return w

    def _build_camera_page(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)

        vbox.addWidget(self._lbl("選択中のエッジ:"))
        self.selected_edge_label = QLabel("（撮影モードで地図上のエッジをクリック）")
        self.selected_edge_label.setWordWrap(True)
        self.selected_edge_label.setStyleSheet("font-weight:bold;")
        vbox.addWidget(self.selected_edge_label)

        self.fwd_status_label = QLabel("")
        self.rev_status_label = QLabel("")
        vbox.addWidget(self.fwd_status_label)
        vbox.addWidget(self.rev_status_label)

        self.camera_panel = CameraPanel()
        vbox.addWidget(self.camera_panel, 1)

        btn_row = QHBoxLayout()
        self.capture_fwd_btn = QPushButton("→ 方向を撮影 (from→to)")
        self.capture_fwd_btn.clicked.connect(lambda: self._capture_direction(reverse=False))
        self.capture_fwd_btn.setEnabled(False)
        btn_row.addWidget(self.capture_fwd_btn)
        self.capture_rev_btn = QPushButton("← 方向を撮影 (to→from)")
        self.capture_rev_btn.clicked.connect(lambda: self._capture_direction(reverse=True))
        self.capture_rev_btn.setEnabled(False)
        btn_row.addWidget(self.capture_rev_btn)
        vbox.addLayout(btn_row)

        vbox.addWidget(self._lbl("直近の撮影プレビュー:"))
        self.last_photo_label = QLabel("")
        self.last_photo_label.setFixedHeight(120)
        self.last_photo_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.last_photo_label.setStyleSheet("background:#111827; border-radius:6px;")
        vbox.addWidget(self.last_photo_label)

        hint = QLabel(f"保存先フォルダ: {PHOTO_DIR}\n"
                       "撮影した写真はこのフォルダにファイル名(from_to_to.jpg)で保存され、\n"
                       "edge_image.csv への登録は「💾 保存」で確定します。\n"
                       "CDNへのアップロードは別途手動で行ってください。")
        hint.setStyleSheet("color:#888; font-size:10px;")
        hint.setWordWrap(True)
        vbox.addWidget(hint)

        return w

    @staticmethod
    def _lbl(text: str) -> QLabel:
        lbl = QLabel(text)
        lbl.setStyleSheet("color:#CBD5E1;")
        return lbl

    def _confirm_yes(self, title: str, msg: str) -> bool:
        """はい/いいえの確認ダイアログを表示し、「はい」が選ばれたかを返す"""
        return QMessageBox.question(self, title, msg) == QMessageBox.StandardButton.Yes

    # ------------------------------------------------------------------
    # 建物・階の切り替え
    # ------------------------------------------------------------------
    def _reload_building_list(self):
        buildings = list_buildings()
        self.building_combo.blockSignals(True)
        self.building_combo.clear()
        for b in buildings:
            self.building_combo.addItem(f"{b}号館", b)
        self.building_combo.blockSignals(False)
        if buildings:
            self.building_combo.setCurrentIndex(0)
            self._on_building_changed(0)

    def _on_building_changed(self, _index: int):
        new_building = self.building_combo.currentData()
        if new_building is None:
            return
        if not self._confirm_discard_if_dirty():
            # ユーザーがキャンセル → コンボを元に戻す
            self.building_combo.blockSignals(True)
            idx = self.building_combo.findData(self.current_building)
            if idx >= 0:
                self.building_combo.setCurrentIndex(idx)
            self.building_combo.blockSignals(False)
            return

        self.current_building = new_building
        self.building_data = BuildingData(new_building)

        floors = self.building_data.floors_present()
        self.floors_hint_label.setText(f"(既存: {', '.join(map(str, floors))})" if floors else "(既存フロアなし)")
        default_floor = floors[0] if floors else 1
        self.floor_spin.blockSignals(True)
        self.floor_spin.setValue(default_floor)
        self.floor_spin.blockSignals(False)
        self.current_floor = default_floor

        self._reload_floor()
        self._update_dirty_indicator()

    def _on_floor_changed(self, value: int):
        self.current_floor = value
        self._reload_floor()

    def _reload_floor(self):
        self.selected_edge_id = None
        self._update_camera_edge_info()
        if self.current_building is None:
            return
        path = svg_path_for(self.current_building, self.current_floor)
        if path.exists():
            ok = self.canvas.load_svg(str(path))
            self.svg_path_label.setText(f"SVG: {path.name}" if ok else f"SVG読込失敗: {path.name}")
        else:
            self.canvas.clear_svg()
            self.svg_path_label.setText(f"SVG: 見つかりません ({path.name})")
        self._refresh_canvas_draw()

    def _browse_svg(self):
        path, _ = QFileDialog.getOpenFileName(self, "SVGファイルを選択", str(PHOTO_DIR.parent),
                                               "SVG files (*.svg);;All files (*)")
        if not path:
            return
        ok = self.canvas.load_svg(path)
        self.svg_path_label.setText(f"SVG: {path}" if ok else "SVG読込失敗")
        expected = svg_path_for(self.current_building or 0, self.current_floor)
        if ok and str(expected) != path:
            self.statusBar().showMessage(
                f"注意: 本番配置場所は {expected} です。保存先を合わせてください。", 8000
            )
        self._refresh_canvas_draw()

    # ------------------------------------------------------------------
    # モード切り替え
    # ------------------------------------------------------------------
    def _set_mode(self, mode: str):
        # 撮影モードから離れる際はカメラを解放する
        if self.canvas.mode == SvgCanvas.MODE_CAMERA and mode != SvgCanvas.MODE_CAMERA:
            self.camera_panel.disconnect_camera()

        self.canvas.set_mode(mode)
        self.mode_hint_label.setText(MODE_HINT[mode])
        self.side_stack.setCurrentIndex(1 if mode == SvgCanvas.MODE_CAMERA else 0)

        if mode != SvgCanvas.MODE_CAMERA:
            self.selected_edge_id = None
            self.canvas.highlight_edge(None)
            self._update_camera_edge_info()

    # ------------------------------------------------------------------
    # キャンバス信号
    # ------------------------------------------------------------------
    def _connect_canvas_signals(self):
        self.canvas.nodeCreateRequested.connect(self._on_node_create_requested)
        self.canvas.edgeCreateRequested.connect(self._on_edge_create_requested)
        self.canvas.nodeDeleteRequested.connect(self._on_node_delete_requested)
        self.canvas.edgeDeleteRequested.connect(self._on_edge_delete_requested)
        self.canvas.edgeSelectedForPhoto.connect(self._on_edge_selected_for_photo)
        self.canvas.pendingNodeChanged.connect(self._on_pending_node_changed)

    def _on_pending_node_changed(self, node_id):
        if node_id is None:
            self.mode_hint_label.setText(MODE_HINT[SvgCanvas.MODE_INPUT])
        else:
            label = self.building_data.node_label(node_id) if self.building_data else str(node_id)
            self.mode_hint_label.setText(f"接続元: {label} を選択中 → 接続先のノードをクリック（Escで解除）")

    def _on_node_create_requested(self, sx: float, sy: float):
        if self.building_data is None:
            return
        dlg = NodeDialog(default_floor=self.current_floor,
                          default_id=self.building_data.next_node_id(), parent=self)
        if dlg.exec() != NodeDialog.DialogCode.Accepted:
            return
        v = dlg.values()
        if v["id"] in self.building_data.nodes:
            if not self._confirm_yes("上書き確認", f"ノードID {v['id']} は既に存在します。上書きしますか？"):
                return
        self.building_data.add_node(
            v["x"], v["y"], v["z"], v["floor"], v["type"], svg_x=sx, svg_y=sy, node_id=v["id"],
        )
        self._after_data_change()

    def _on_edge_create_requested(self, a_id: int, b_id: int):
        if self.building_data is None:
            return
        xyz_a = self.building_data.node_xyz(a_id)
        xyz_b = self.building_data.node_xyz(b_id)
        if xyz_a is None or xyz_b is None:
            return
        dist = sum((p - q) ** 2 for p, q in zip(xyz_a, xyz_b)) ** 0.5
        floor_a = to_int(self.building_data.nodes[a_id].get("floor"), self.current_floor)
        floor_b = to_int(self.building_data.nodes[b_id].get("floor"), self.current_floor)
        dlg = EdgeDialog(
            label_a=self.building_data.node_label(a_id),
            label_b=self.building_data.node_label(b_id),
            default_floor=min(floor_a, floor_b),
            default_length=dist,
            default_id=self.building_data.next_edge_id(),
            default_type=suggest_edge_type(floor_a, floor_b),
            parent=self,
        )
        if dlg.exec() != EdgeDialog.DialogCode.Accepted:
            return
        v = dlg.values()
        if v["id"] in self.building_data.edges:
            if not self._confirm_yes("上書き確認", f"エッジID {v['id']} は既に存在します。上書きしますか？"):
                return
        self.building_data.add_edge(
            v["name"], a_id, b_id, v["floor"], v["weight"], v["length"], v["type"], edge_id=v["id"],
        )
        self._after_data_change()

    def _on_node_delete_requested(self, node_id: int):
        if self.building_data is None:
            return
        touching = self.building_data.edges_touching_node(node_id)
        msg = f"ノード {node_id} を削除しますか？"
        if touching:
            msg += f"\n関連する {len(touching)} 件のエッジも同時に削除されます。"
        if not self._confirm_yes("削除確認", msg):
            return
        self.building_data.delete_node(node_id)
        self._after_data_change()

    def _on_edge_delete_requested(self, edge_id: int):
        if self.building_data is None:
            return
        row = self.building_data.edges.get(edge_id, {})
        name = row.get("name", "")
        msg = f"エッジ {edge_id}" + (f"（{name}）" if name else "") + " を削除しますか？"
        if not self._confirm_yes("削除確認", msg):
            return
        self.building_data.delete_edge(edge_id)
        if self.selected_edge_id == edge_id:
            self.selected_edge_id = None
            self._update_camera_edge_info()
        self._after_data_change()

    def _after_data_change(self):
        self._refresh_canvas_draw()
        self._update_dirty_indicator()

    # ------------------------------------------------------------------
    # 描画・一覧更新
    # ------------------------------------------------------------------
    def _refresh_canvas_draw(self):
        self.node_list.clear()
        self.edge_list.clear()

        if self.building_data is None:
            self.canvas.render_nodes_edges([], [])
            self.info_summary_label.setText("ノード: 0　エッジ: 0")
            return

        floor = self.current_floor
        nodes = self.building_data.nodes_for_floor(floor)
        edges = self.building_data.edges_for_floor(floor)

        nodes_draw, skipped = [], 0
        for n in nodes:
            svg_xy = self.building_data.node_svg_xy(n["id"])
            type_label = NODE_TYPE_LABELS.get(to_int(n.get("type")), "?")
            self.node_list.addItem(
                f"#{n['id']:>4} ({n.get('x','')},{n.get('y','')},{n.get('z','')}) {type_label}"
                + ("" if svg_xy else "  [SVG未設定]")
            )
            if svg_xy is None:
                skipped += 1
                continue
            nodes_draw.append({
                "id": n["id"], "sx": svg_xy[0], "sy": svg_xy[1],
                "type": to_int(n.get("type")), "label": str(n["id"]),
            })

        edges_draw = []
        for e in edges:
            a, b = to_int(e.get("from")), to_int(e.get("to"))
            xy_a, xy_b = self.building_data.node_svg_xy(a), self.building_data.node_svg_xy(b)
            type_label = EDGE_TYPE_LABELS.get(to_int(e.get("type")), "?")
            self.edge_list.addItem(
                f"#{e['id']:>4} {a}→{b} {e.get('name','')} w={e.get('weight','')} "
                f"l={e.get('length','')} {type_label}"
            )
            if xy_a is None or xy_b is None:
                continue
            edges_draw.append({
                "id": e["id"], "sx0": xy_a[0], "sy0": xy_a[1], "sx1": xy_b[0], "sy1": xy_b[1],
                "type": to_int(e.get("type")),
            })

        self.canvas.render_nodes_edges(nodes_draw, edges_draw)
        if self.selected_edge_id is not None:
            self.canvas.highlight_edge(self.selected_edge_id)

        summary = f"ノード: {len(nodes)}　エッジ: {len(edges)}"
        if skipped:
            summary += f"　(うちSVG未設定: {skipped})"
        self.info_summary_label.setText(summary)

    # ------------------------------------------------------------------
    # 撮影
    # ------------------------------------------------------------------
    def _on_edge_selected_for_photo(self, edge_id: int):
        self.selected_edge_id = edge_id
        self.canvas.highlight_edge(edge_id)
        self._update_camera_edge_info()

    def _update_camera_edge_info(self):
        if self.selected_edge_id is None or self.building_data is None:
            self.selected_edge_label.setText("（撮影モードで地図上のエッジをクリック）")
            self.fwd_status_label.setText("")
            self.rev_status_label.setText("")
            self.capture_fwd_btn.setEnabled(False)
            self.capture_rev_btn.setEnabled(False)
            return

        row = self.building_data.edges.get(self.selected_edge_id)
        if row is None:
            self.selected_edge_id = None
            self._update_camera_edge_info()
            return

        a, b = to_int(row.get("from")), to_int(row.get("to"))
        name = row.get("name", "") or "(名称なし)"
        self.selected_edge_label.setText(f"エッジ #{self.selected_edge_id}: {name}\n{a} → {b}")

        g_a, g_b = global_id(self.current_building, a), global_id(self.current_building, b)

        fwd = self.edge_image_store.find(g_a, g_b)
        rev = self.edge_image_store.find(g_b, g_a)
        self.fwd_status_label.setText(
            f"→ 方向 ({g_a}→{g_b}): " + (f"登録済み ({fwd['image_name']})" if fwd else "未登録")
        )
        self.rev_status_label.setText(
            f"← 方向 ({g_b}→{g_a}): " + (f"登録済み ({rev['image_name']})" if rev else "未登録")
        )
        self.capture_fwd_btn.setEnabled(True)
        self.capture_rev_btn.setEnabled(True)

    def _capture_direction(self, reverse: bool):
        if self.selected_edge_id is None or self.building_data is None:
            return
        row = self.building_data.edges.get(self.selected_edge_id)
        if row is None:
            QMessageBox.warning(self, "エラー", "選択中のエッジが見つかりません（削除された可能性があります）。")
            return
        frame = self.camera_panel.capture()
        if frame is None:
            QMessageBox.warning(self, "エラー", "カメラが接続されていないか、フレームを取得できません。\n上部の「接続」ボタンでカメラを接続してください。")
            return

        a, b = to_int(row.get("from")), to_int(row.get("to"))
        if reverse:
            a, b = b, a
        g_a, g_b = global_id(self.current_building, a), global_id(self.current_building, b)
        filename = f"{g_a}_to_{g_b}.jpg"
        out_path = PHOTO_DIR / filename

        if out_path.exists():
            if not self._confirm_yes("上書き確認", f"{filename} は既に存在します。上書きしますか？"):
                return

        PHOTO_DIR.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), frame)
        self.edge_image_store.upsert(g_a, g_b, filename)

        self.last_photo_label.setPixmap(bgr_frame_to_pixmap(frame, self.last_photo_label.size()))

        self.statusBar().showMessage(f"撮影しました: {filename}（保存ボタンで edge_image.csv に反映）", 6000)
        self._update_camera_edge_info()
        self._update_dirty_indicator()

    # ------------------------------------------------------------------
    # 保存・終了
    # ------------------------------------------------------------------
    def _is_dirty(self) -> bool:
        return (self.building_data is not None and self.building_data.dirty) or self.edge_image_store.dirty

    def _update_dirty_indicator(self):
        dirty = self._is_dirty()
        self.dirty_label.setText("● 未保存の変更あり" if dirty else "")
        title = "マップ編集"
        if self.current_building is not None:
            title += f" — {self.current_building}号館"
        if dirty:
            title += " *"
        self.setWindowTitle(title)

    def _save_all(self):
        if self.building_data is not None:
            self.building_data.save()
        self.edge_image_store.save()
        self._update_dirty_indicator()
        self.statusBar().showMessage("保存しました。", 4000)

    def _confirm_discard_if_dirty(self) -> bool:
        """未保存の変更があれば確認する。続行してよければ True を返す（保存 or 破棄選択時）"""
        if not self._is_dirty():
            return True
        reply = QMessageBox.question(
            self, "未保存の変更",
            "未保存の変更があります。保存してから続けますか？",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if reply == QMessageBox.StandardButton.Save:
            self._save_all()
            return True
        if reply == QMessageBox.StandardButton.Discard:
            return True
        return False

    def closeEvent(self, event):
        if not self._confirm_discard_if_dirty():
            event.ignore()
            return
        self.camera_panel.disconnect_camera()
        super().closeEvent(event)
