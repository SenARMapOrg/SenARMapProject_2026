#!/usr/bin/env python3
"""画像リネームタブ — 左に画像をドロップ、右に名前をペーストして一括リネーム・一括リスケール

一括リスケールは画像の枚数が多いと時間がかかるため、裏のスレッド（ResizeWorker）で1枚ずつ処理し、
進み具合をステータスバーに出す。処理中も画面は固まらず、「中止」で途中で止められる。
"""

import os
from pathlib import Path

from PIL import Image

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget,
    QHBoxLayout, QVBoxLayout,
    QLabel, QTextEdit, QListWidget, QPushButton,
    QAbstractItemView, QListWidgetItem,
    QMessageBox, QTableWidget, QTableWidgetItem, QHeaderView,
    QGroupBox, QLineEdit, QFrame, QProgressBar,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont, QColor, QPainter, QKeySequence, QShortcut, QIntValidator


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp",
              ".tiff", ".tif", ".webp", ".heic", ".heif"}


def resize_target(orig_size: tuple[int, int], new_w: int | None, new_h: int | None) -> tuple[int, int]:
    """変換後の大きさ。両方指定なら強制変換（縦横比無視）、片方だけならもう一方を縦横比から計算する"""
    orig_w, orig_h = orig_size
    if new_w and new_h:
        return (new_w, new_h)
    if new_w:
        return (new_w, max(1, round(orig_h * new_w / orig_w)))
    if new_h:
        return (max(1, round(orig_w * new_h / orig_h)), new_h)
    raise ValueError("幅か高さのどちらかは指定が必要です")


def resize_image_file(path: str, new_w: int | None, new_h: int | None) -> tuple[int, int]:
    """画像を上書きでリスケールする。戻り値は変換後の大きさ。

    いったん同じフォルダの一時ファイルに書き出してから差し替えるので、書き込みの途中で
    アプリが終了しても、元の画像が壊れた状態で残ることはない。
    """
    src = Path(path)
    tmp = src.with_name(f".{src.stem}.resizing{src.suffix}")
    try:
        with Image.open(src) as img:
            target = resize_target(img.size, new_w, new_h)
            resized = img.resize(target, Image.LANCZOS)
            resized.save(tmp, format=img.format)
        os.replace(tmp, src)
    finally:
        if tmp.exists():
            tmp.unlink()
    return target


class ResizeWorker(QThread):
    """一括リスケールを裏で進める（画面を固まらせないため）"""
    progress = pyqtSignal(int, int, str)          # (処理済み枚数, 全体の枚数, 今処理しているファイル名)
    completed = pyqtSignal(int, list, bool)       # (成功枚数, エラーの一覧, 中止したか)

    def __init__(self, paths: list[str], new_w: int | None, new_h: int | None, parent=None):
        super().__init__(parent)
        self._paths = list(paths)
        self._new_w = new_w
        self._new_h = new_h

    def run(self):
        ok, errors = 0, []
        total = len(self._paths)
        for i, path in enumerate(self._paths):
            if self.isInterruptionRequested():
                self.completed.emit(ok, errors, True)
                return
            self.progress.emit(i, total, os.path.basename(path))
            try:
                resize_image_file(path, self._new_w, self._new_h)
                ok += 1
            except Exception as e:  # noqa: BLE001  1枚失敗しても残りは続ける
                errors.append(f"{os.path.basename(path)}: {e}")
        self.progress.emit(total, total, "")
        self.completed.emit(ok, errors, False)


class DropListWidget(QListWidget):
    """画像ファイルのドロップ先リスト"""

    def __init__(self, on_change=None, parent=None):
        super().__init__(parent)
        self._on_change = on_change
        self._paths: list[str] = []
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DropOnly)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)

    # ── drag & drop ──────────────────────────────────────────────────

    def dragEnterEvent(self, event):
        if event.mimeData().hasUrls() and self._has_images(event.mimeData()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragMoveEvent(self, event):
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event):
        if self.add_paths([url.toLocalFile() for url in event.mimeData().urls()]):
            event.acceptProposedAction()

    def add_paths(self, paths: list[str]) -> bool:
        """画像ファイルを一覧に足す（重複・画像以外は無視）。1件でも足したら True"""
        added = False
        for path in paths:
            if path not in self._paths and self._is_image(path):
                self._paths.append(path)
                self.addItem(QListWidgetItem(os.path.basename(path)))
                added = True
        if added:
            self._notify()
        return added

    # ── empty-state hint ─────────────────────────────────────────────

    def paintEvent(self, event):
        super().paintEvent(event)
        if self.count() == 0:
            p = QPainter(self.viewport())
            p.setPen(QColor("#aaaaaa"))
            p.setFont(QFont("", 12))
            p.drawText(
                self.viewport().rect(),
                Qt.AlignmentFlag.AlignCenter,
                "画像ファイルをここに\nドラッグ＆ドロップ\n\n.jpg .png .gif .bmp .tiff .webp .heic",
            )

    # ── public API ───────────────────────────────────────────────────

    def paths(self) -> list[str]:
        return list(self._paths)

    def clear_all(self):
        self.clear()
        self._paths.clear()
        self._notify()

    def remove_selected(self):
        rows = sorted({self.row(i) for i in self.selectedItems()}, reverse=True)
        for row in rows:
            self.takeItem(row)
            self._paths.pop(row)
        self._notify()

    # ── helpers ──────────────────────────────────────────────────────

    def _has_images(self, mime_data) -> bool:
        return any(self._is_image(u.toLocalFile()) for u in mime_data.urls())

    def _is_image(self, path: str) -> bool:
        return os.path.isfile(path) and Path(path).suffix.lower() in IMAGE_EXTS

    def _notify(self):
        if self._on_change:
            self._on_change()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("画像リネーム")
        self.setMinimumSize(960, 780)
        self._resize_worker: ResizeWorker | None = None
        self._build_ui()
        self._build_status_bar()

    # ── UI construction ──────────────────────────────────────────────

    def _build_ui(self):
        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 16, 16, 16)

        title = QLabel("画像リネーム")
        title.setFont(QFont("", 18, QFont.Weight.Bold))
        layout.addWidget(title)

        sub = QLabel("①左に画像をドロップ　②右に名前リストをペースト　③「名前を変更する」をクリック")
        sub.setStyleSheet("color: #555; font-size: 12px;")
        layout.addWidget(sub)

        panels = QHBoxLayout()
        panels.setSpacing(16)
        panels.addLayout(self._left_panel(), stretch=1)
        panels.addLayout(self._right_panel(), stretch=1)
        layout.addLayout(panels)

        layout.addWidget(self._preview_section())
        layout.addWidget(self._rename_button())

        sep = QFrame()
        sep.setFrameShape(QFrame.Shape.HLine)
        sep.setStyleSheet("color: #ddd;")
        layout.addWidget(sep)

        layout.addWidget(self._resize_section())

        # Delete キーで選択した画像を外す。ほかのタブを操作しているときに反応しないよう、
        # このタブの中にフォーカスがあるときだけ効くようにする
        delete_shortcut = QShortcut(QKeySequence.StandardKey.Delete, self)
        delete_shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        delete_shortcut.activated.connect(self.drop_list.remove_selected)

    def _left_panel(self) -> QVBoxLayout:
        vbox = QVBoxLayout()

        lbl = QLabel("① 画像をドラッグ＆ドロップ")
        lbl.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(lbl)

        hint = QLabel("複数まとめてドロップ可。Deleteキーで選択行を削除。")
        hint.setStyleSheet("color: #777; font-size: 11px;")
        vbox.addWidget(hint)

        self.drop_list = DropListWidget(on_change=self._refresh_preview)
        self.drop_list.setStyleSheet("""
            QListWidget {
                border: 2px dashed #bbb;
                border-radius: 10px;
                background: #f5f5f5;
                font-size: 13px;
            }
            QListWidget::item:selected {
                background: #bbdefb;
                color: #000;
            }
        """)
        vbox.addWidget(self.drop_list)

        clear_btn = QPushButton("リストをクリア")
        clear_btn.setStyleSheet("padding: 6px; font-size: 12px;")
        clear_btn.clicked.connect(self.drop_list.clear_all)
        vbox.addWidget(clear_btn)
        return vbox

    def _right_panel(self) -> QVBoxLayout:
        vbox = QVBoxLayout()

        lbl = QLabel("② 新しい名前をペースト（1行 = 1ファイル）")
        lbl.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(lbl)

        hint = QLabel("スプレッドシートからそのままコピペ。拡張子は自動で補完。")
        hint.setStyleSheet("color: #777; font-size: 11px;")
        vbox.addWidget(hint)

        self.name_edit = QTextEdit()
        self.name_edit.setPlaceholderText(
            "例:\n田中太郎\n山田花子\n佐藤次郎\n\n※ スプレッドシートの列をコピーしてここにペーストするだけでOK"
        )
        self.name_edit.setStyleSheet("""
            QTextEdit {
                border: 2px solid #ddd;
                border-radius: 10px;
                background: #fff;
                color: #000;
                font-size: 13px;
                padding: 8px;
            }
        """)
        self.name_edit.textChanged.connect(self._refresh_preview)
        vbox.addWidget(self.name_edit)

        clear_btn = QPushButton("名前リストをクリア")
        clear_btn.setStyleSheet("padding: 6px; font-size: 12px;")
        clear_btn.clicked.connect(self.name_edit.clear)
        vbox.addWidget(clear_btn)
        return vbox

    def _preview_section(self) -> QWidget:
        w = QWidget()
        vbox = QVBoxLayout(w)
        vbox.setContentsMargins(0, 0, 0, 0)
        vbox.setSpacing(4)

        self._preview_label = QLabel("プレビュー")
        self._preview_label.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox.addWidget(self._preview_label)

        self.table = QTableWidget(0, 2)
        self.table.setHorizontalHeaderLabels(["変更前", "変更後"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setMaximumHeight(160)
        self.table.setStyleSheet("font-size: 13px;")
        vbox.addWidget(self.table)
        return w

    def _rename_button(self) -> QPushButton:
        btn = QPushButton("名前を変更する")
        btn.setFont(QFont("", 13, QFont.Weight.Bold))
        btn.setMinimumHeight(52)
        btn.setStyleSheet("""
            QPushButton {
                background: #1976D2;
                color: white;
                border-radius: 8px;
            }
            QPushButton:hover   { background: #1565C0; }
            QPushButton:pressed { background: #0D47A1; }
            QPushButton:disabled { background: #BDBDBD; color: #F5F5F5; }
        """)
        btn.clicked.connect(self._do_rename)
        self._rename_btn = btn
        return btn

    def _resize_section(self) -> QGroupBox:
        box = QGroupBox("画像リスケール（ドロップした画像を一括変換）")
        box.setFont(QFont("", 11, QFont.Weight.Bold))
        vbox = QVBoxLayout(box)
        vbox.setSpacing(8)

        hint = QLabel(
            "片方のみ入力 → もう一方を自動計算（縦横比維持）　両方入力 → 指定サイズに強制変換（縦横比無視）"
        )
        hint.setStyleSheet("color: #555; font-size: 11px; font-weight: normal;")
        vbox.addWidget(hint)

        size_row = QHBoxLayout()
        size_row.setSpacing(12)

        validator = QIntValidator(1, 99999)

        size_row.addWidget(QLabel("幅:"))
        self.width_edit = QLineEdit()
        self.width_edit.setPlaceholderText("未指定")
        self.width_edit.setValidator(validator)
        self.width_edit.setFixedWidth(90)
        self.width_edit.setStyleSheet("font-size: 13px; padding: 4px;")
        self.width_edit.textChanged.connect(self._refresh_resize_hint)
        size_row.addWidget(self.width_edit)
        size_row.addWidget(QLabel("px"))

        size_row.addSpacing(20)

        size_row.addWidget(QLabel("高さ:"))
        self.height_edit = QLineEdit()
        self.height_edit.setPlaceholderText("未指定")
        self.height_edit.setValidator(validator)
        self.height_edit.setFixedWidth(90)
        self.height_edit.setStyleSheet("font-size: 13px; padding: 4px;")
        self.height_edit.textChanged.connect(self._refresh_resize_hint)
        size_row.addWidget(self.height_edit)
        size_row.addWidget(QLabel("px"))

        size_row.addStretch()
        vbox.addLayout(size_row)

        self._resize_hint = QLabel("")
        self._resize_hint.setStyleSheet("color: #1976D2; font-size: 11px; font-weight: normal;")
        vbox.addWidget(self._resize_hint)

        resize_btn = QPushButton("一括リスケールする")
        resize_btn.setFont(QFont("", 13, QFont.Weight.Bold))
        resize_btn.setMinimumHeight(52)
        resize_btn.setStyleSheet("""
            QPushButton {
                background: #388E3C;
                color: white;
                border-radius: 8px;
            }
            QPushButton:hover   { background: #2E7D32; }
            QPushButton:pressed { background: #1B5E20; }
            QPushButton:disabled { background: #BDBDBD; color: #F5F5F5; }
        """)
        resize_btn.clicked.connect(self._do_resize)
        vbox.addWidget(resize_btn)
        self._resize_btn = resize_btn

        return box

    # ── status bar ───────────────────────────────────────────────────

    def _build_status_bar(self):
        bar = self.statusBar()
        self._progress = QProgressBar()
        self._progress.setFixedWidth(240)
        self._progress.setTextVisible(True)
        self._progress.hide()
        self._cancel_btn = QPushButton("中止")
        self._cancel_btn.clicked.connect(self._cancel_resize)
        self._cancel_btn.hide()
        bar.addPermanentWidget(self._progress)
        bar.addPermanentWidget(self._cancel_btn)
        bar.showMessage("画像をドロップしてください")

    def _set_busy(self, busy: bool):
        """リスケール中は、対象の画像や設定を変えられないようにする（処理中のリストがずれないように）"""
        for w in (self.drop_list, self.name_edit, self.width_edit, self.height_edit,
                  self._resize_btn, self._rename_btn):
            w.setEnabled(not busy)
        self._progress.setVisible(busy)
        self._cancel_btn.setVisible(busy)
        self._cancel_btn.setEnabled(busy)

    def is_resizing(self) -> bool:
        return self._resize_worker is not None and self._resize_worker.isRunning()

    # ── shared dialogs ───────────────────────────────────────────────

    def _confirm(self, message: str) -> bool:
        reply = QMessageBox.question(
            self, "確認", message,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        return reply == QMessageBox.StandardButton.Yes

    def _show_result(self, ok: int, errors: list[str], success_message: str):
        if errors:
            QMessageBox.warning(self, "完了（エラーあり）",
                f"{ok} 件成功 / {len(errors)} 件失敗:\n\n" + "\n".join(errors))
        else:
            QMessageBox.information(self, "完了", success_message)

    # ── resize hint ──────────────────────────────────────────────────

    def _refresh_resize_hint(self):
        w = self.width_edit.text().strip()
        h = self.height_edit.text().strip()
        if w and h:
            self._resize_hint.setText(f"→ {w} × {h} px に強制変換（縦横比無視）")
        elif w:
            self._resize_hint.setText(f"→ 幅 {w} px に合わせ、高さを自動計算（縦横比維持）")
        elif h:
            self._resize_hint.setText(f"→ 高さ {h} px に合わせ、幅を自動計算（縦横比維持）")
        else:
            self._resize_hint.setText("")

    # ── resize logic ─────────────────────────────────────────────────

    def _do_resize(self):
        paths = self.drop_list.paths()
        if not paths:
            QMessageBox.warning(self, "警告", "画像がドロップされていません。")
            return

        w_text = self.width_edit.text().strip()
        h_text = self.height_edit.text().strip()
        new_w = int(w_text) if w_text else None
        new_h = int(h_text) if h_text else None

        if new_w is None and new_h is None:
            QMessageBox.warning(self, "警告", "幅または高さを入力してください。")
            return

        if new_w and new_h:
            mode_desc = f"{new_w} × {new_h} px に強制変換（縦横比無視）"
        elif new_w:
            mode_desc = f"幅 {new_w} px 基準でリスケール（縦横比維持）"
        else:
            mode_desc = f"高さ {new_h} px 基準でリスケール（縦横比維持）"

        if not self._confirm(
            f"{len(paths)} 件の画像を上書きリスケールします。\n\nモード: {mode_desc}\n\nよろしいですか？"
        ):
            return

        self._start_resize(paths, new_w, new_h)

    def _start_resize(self, paths: list[str], new_w: int | None, new_h: int | None):
        """確認済みのリスケールを裏で始める（画面は固まらない）"""
        self._progress.setRange(0, len(paths))
        self._progress.setValue(0)
        self._set_busy(True)
        self.statusBar().showMessage(f"リスケールを開始します（{len(paths)} 枚）")
        worker = ResizeWorker(paths, new_w, new_h, self)
        worker.progress.connect(self._on_resize_progress)
        worker.completed.connect(self._on_resize_completed)
        worker.finished.connect(worker.deleteLater)
        self._resize_worker = worker
        worker.start()

    def _on_resize_progress(self, done: int, total: int, name: str):
        self._progress.setValue(done)
        self._progress.setFormat("%v / %m 枚")
        if name:
            self.statusBar().showMessage(f"リスケール中… {done + 1} / {total} 枚目: {name}")

    def _cancel_resize(self):
        if self.is_resizing():
            self._resize_worker.requestInterruption()
            self._cancel_btn.setEnabled(False)
            self.statusBar().showMessage("中止しています…（処理中の1枚が終わったら止まります）")

    def _on_resize_completed(self, ok: int, errors: list, cancelled: bool):
        self._resize_worker = None
        self._set_busy(False)
        if cancelled:
            message = f"中止しました（{ok} 枚はリスケール済み）"
            self.statusBar().showMessage(message)
            QMessageBox.information(self, "中止", message)
            return
        self.statusBar().showMessage(
            f"{ok} 枚をリスケールしました" + (f"（{len(errors)} 枚は失敗）" if errors else ""))
        self._show_result(ok, errors, f"{ok} 件の画像をリスケールしました。")

    # ── rename logic ─────────────────────────────────────────────────

    def _names(self) -> list[str]:
        return [ln.strip() for ln in self.name_edit.toPlainText().splitlines() if ln.strip()]

    def _resolve_new_name(self, orig_path: str, raw_name: str) -> str:
        """拡張子が省略されていれば元の拡張子を付ける。"""
        if Path(raw_name).suffix:
            return raw_name
        return raw_name + Path(orig_path).suffix

    def _refresh_preview(self):
        all_paths = self.drop_list.paths()
        names = self._names()
        matched = min(len(all_paths), len(names))

        self._preview_label.setText(
            f"プレビュー　{matched} 件がリネーム対象"
            + (f"　（名前不足: {len(all_paths) - matched} 件スキップ）"
               if len(all_paths) > len(names) else "")
        )

        self.table.setRowCount(len(all_paths))
        for i, path in enumerate(all_paths):
            orig_item = QTableWidgetItem(os.path.basename(path))

            if i < len(names):
                new_name = self._resolve_new_name(path, names[i])
                new_item = QTableWidgetItem(new_name)
                new_path = Path(path).parent / new_name
                if new_path.exists() and str(new_path) != path:
                    new_item.setBackground(QColor("#FFCDD2"))
                    new_item.setToolTip("同名ファイルが既に存在します — スキップされます")
                else:
                    new_item.setBackground(QColor("#C8E6C9"))
            else:
                new_item = QTableWidgetItem("— 名前なし（スキップ）")
                new_item.setBackground(QColor("#FFF9C4"))
                new_item.setForeground(QColor("#888"))

            self.table.setItem(i, 0, orig_item)
            self.table.setItem(i, 1, new_item)

    def _do_rename(self):
        all_paths = self.drop_list.paths()
        names = self._names()

        pairs: list[tuple[str, str]] = []
        for i, path in enumerate(all_paths):
            if i >= len(names):
                break
            pairs.append((path, self._resolve_new_name(path, names[i])))

        if not pairs:
            QMessageBox.warning(self, "警告",
                "変更できるファイルがありません。\n画像をドロップして名前リストを入力してください。")
            return

        if not self._confirm(f"{len(pairs)} 件のファイル名を変更します。よろしいですか？"):
            return

        ok, errors = 0, []
        for orig_path, new_name in pairs:
            new_path = Path(orig_path).parent / new_name
            if new_path.exists() and str(new_path) != orig_path:
                errors.append(f"{os.path.basename(orig_path)}: 同名ファイルが既に存在します（スキップ）")
                continue
            try:
                Path(orig_path).rename(new_path)
                ok += 1
            except OSError as e:
                errors.append(f"{os.path.basename(orig_path)}: {e}")

        self.statusBar().showMessage(
            f"{ok} 件のファイルをリネームしました" + (f"（{len(errors)} 件は失敗）" if errors else ""))
        self._show_result(ok, errors, f"{ok} 件のファイルをリネームしました。")

        self.drop_list.clear_all()
        self.name_edit.clear()

    # ── close ────────────────────────────────────────────────────────

    def closeEvent(self, event):
        # リスケールの途中で閉じたら、処理中の1枚が終わるのを待ってから閉じる
        # （一時ファイルに書いてから差し替えているので、待たずに終わっても元の画像は壊れない）
        if self.is_resizing():
            worker = self._resize_worker
            # 閉じた後に「中止しました」などのダイアログが出ないよう、通知を受け取らないようにしてから止める
            worker.progress.disconnect()
            worker.completed.disconnect()
            worker.requestInterruption()
            worker.wait()
            self._resize_worker = None
            self._set_busy(False)
        super().closeEvent(event)
