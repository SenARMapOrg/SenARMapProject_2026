#!/usr/bin/env python3
"""
Human Remover
写真内の人物（立ち/座り問わず）を自動検出してぼかし・モザイク・消去するツール
"""

import os
import cv2
import numpy as np
from pathlib import Path
from typing import Optional, List, Dict

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QListWidget, QListWidgetItem, QSlider,
    QComboBox, QProgressBar, QFileDialog, QAbstractItemView,
    QMessageBox, QSizePolicy,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QSize
from PyQt6.QtGui import (
    QPixmap, QImage, QIcon, QColor, QPainter, QBrush,
    QDragEnterEvent, QDropEvent,
)

# ──────────────────────────────────────────────────────────────────────
#  定数
# ──────────────────────────────────────────────────────────────────────
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff", ".tif"}
MODEL_NAME     = "yolov8n-seg.pt"   # 無ければ初回の処理時に自動ダウンロード (~6 MB)
# このフォルダに置いたモデルを優先する（以前は「起動したフォルダ」から探していたため、
# 起動する場所によって毎回ダウンロードし直すことがあった）
MODEL_PATH     = Path(__file__).with_name(MODEL_NAME)
PERSON_CLS     = 0                  # COCO person class

STATUS_WAIT  = "wait"
STATUS_OK    = "ok"
STATUS_SKIP  = "skip"   # 人物なし
STATUS_ERROR = "error"

STATUS_COLORS = {
    STATUS_WAIT:  "#475569",
    STATUS_OK:    "#22c55e",
    STATUS_SKIP:  "#eab308",
    STATUS_ERROR: "#ef4444",
}


# ──────────────────────────────────────────────────────────────────────
#  ヘルパー
# ──────────────────────────────────────────────────────────────────────
def rgb_to_qpixmap(arr: np.ndarray) -> QPixmap:
    h, w, _ = arr.shape
    qimg = QImage(arr.data, w, h, w * 3, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())   # .copy() でバッファ参照を切る


def make_dot_icon(status: str, size: int = 12) -> QIcon:
    color = QColor(STATUS_COLORS.get(status, "#475569"))
    px = QPixmap(size, size)
    px.fill(Qt.GlobalColor.transparent)
    p = QPainter(px)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QBrush(color))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(0, 0, size, size)
    p.end()
    return QIcon(px)


# ──────────────────────────────────────────────────────────────────────
#  ドラッグ&ドロップ対応ファイルリスト
# ──────────────────────────────────────────────────────────────────────
class DropList(QListWidget):
    files_dropped = pyqtSignal(list)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DropOnly)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setIconSize(QSize(12, 12))
        self.setSpacing(1)

    def dragEnterEvent(self, e: QDragEnterEvent):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e: QDropEvent):
        paths = []
        for url in e.mimeData().urls():
            lf = url.toLocalFile()
            if os.path.isfile(lf) and Path(lf).suffix.lower() in SUPPORTED_EXTS:
                paths.append(lf)
            elif os.path.isdir(lf):
                for child in sorted(Path(lf).iterdir()):
                    if child.suffix.lower() in SUPPORTED_EXTS:
                        paths.append(str(child))
        if paths:
            self.files_dropped.emit(paths)


# ──────────────────────────────────────────────────────────────────────
#  スケーリング対応プレビュー QLabel
# ──────────────────────────────────────────────────────────────────────
class ImageLabel(QLabel):
    def __init__(self, placeholder: str = "", parent=None):
        super().__init__(parent)
        self._pixmap: Optional[QPixmap] = None
        self._placeholder = placeholder
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setStyleSheet("background:#1e1e35; border-radius:8px;")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMinimumSize(180, 120)
        self.setText(placeholder)

    def set_image(self, arr: Optional[np.ndarray]):
        if arr is None:
            self._pixmap = None
            super().setPixmap(QPixmap())
            self.setText(self._placeholder)
        else:
            self._pixmap = rgb_to_qpixmap(arr)
            self.setText("")
            self._refresh_scaled()

    def _refresh_scaled(self):
        if self._pixmap is None or self._pixmap.isNull():
            return
        scaled = self._pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        super().setPixmap(scaled)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._refresh_scaled()


# ──────────────────────────────────────────────────────────────────────
#  処理ワーカー (別スレッド)
# ──────────────────────────────────────────────────────────────────────
class ProcessWorker(QThread):
    # シグナル
    progress   = pyqtSignal(int, int)               # (done, total)
    item_done  = pyqtSignal(str, object, object, int)  # (path, orig_rgb, proc_rgb, n)
    item_error = pyqtSignal(str, str)               # (path, msg)
    finished   = pyqtSignal()

    def __init__(
        self,
        paths: List[str],
        mode: str,
        strength: int,
        confidence: float,
    ):
        super().__init__()
        self.paths      = paths
        self.mode       = mode          # "blur" | "mosaic" | "inpaint"
        self.strength   = strength
        self.confidence = confidence
        self._stop      = False

    def request_stop(self):
        self._stop = True

    # ── メイン ──────────────────────────────────────────────────────
    def run(self):
        try:
            from ultralytics import YOLO
            model = YOLO(str(MODEL_PATH) if MODEL_PATH.exists() else MODEL_NAME)
        except Exception as exc:
            self.item_error.emit("", f"モデルの読み込みに失敗しました:\n{exc}")
            self.finished.emit()
            return

        total = len(self.paths)
        for idx, path in enumerate(self.paths):
            if self._stop:
                break
            self.progress.emit(idx, total)

            try:
                img_bgr = cv2.imread(path)
                if img_bgr is None:
                    raise ValueError("画像を読み込めません")

                img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
                h, w    = img_rgb.shape[:2]

                results = model(
                    img_rgb,
                    classes=[PERSON_CLS],
                    conf=self.confidence,
                    verbose=False,
                )
                r = results[0]

                mask = np.zeros((h, w), dtype=np.uint8)
                n_persons = 0

                # セグメンテーションマスク優先
                if r.masks is not None and len(r.masks):
                    n_persons = len(r.masks)
                    for m in r.masks.data.cpu().numpy():
                        m_r = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
                        mask = np.maximum(mask, (m_r > 0.5).astype(np.uint8))

                # マスクがなければバウンディングボックスで代用
                elif r.boxes is not None and len(r.boxes):
                    n_persons = len(r.boxes)
                    for box in r.boxes.xyxy.cpu().numpy():
                        x1, y1, x2, y2 = map(int, box)
                        mask[y1:y2, x1:x2] = 1

                if n_persons > 0:
                    if self.mode == "blur":
                        processed = self._apply_blur(img_rgb, mask)
                    elif self.mode == "mosaic":
                        processed = self._apply_mosaic(img_rgb, mask)
                    else:
                        processed = self._apply_inpaint(img_rgb, mask)
                else:
                    processed = img_rgb.copy()

                self.item_done.emit(path, img_rgb, processed, n_persons)

            except Exception as exc:
                self.item_error.emit(path, str(exc))

        self.progress.emit(total, total)
        self.finished.emit()

    # ── 処理メソッド ────────────────────────────────────────────────
    def _apply_blur(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """ガウシアンぼかし"""
        k = (self.strength // 2) * 2 + 1   # 奇数に揃える
        k = max(k, 11)
        blurred = cv2.GaussianBlur(img, (k, k), 0)
        m3 = mask[:, :, np.newaxis]
        return np.where(m3, blurred, img).astype(np.uint8)

    def _apply_mosaic(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """モザイク（ピクセレート）"""
        block = max(self.strength // 5, 4)
        h, w  = img.shape[:2]
        small  = cv2.resize(img, (max(w // block, 1), max(h // block, 1)),
                            interpolation=cv2.INTER_LINEAR)
        mosaic = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        m3 = mask[:, :, np.newaxis]
        return np.where(m3, mosaic, img).astype(np.uint8)

    def _apply_inpaint(self, img: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """インペイント（人物を背景で塗りつぶし）"""
        kernel  = np.ones((25, 25), np.uint8)
        dilated = cv2.dilate(mask, kernel, iterations=2)
        mask255 = (dilated * 255).astype(np.uint8)
        bgr     = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        result  = cv2.inpaint(bgr, mask255, 5, cv2.INPAINT_TELEA)
        return cv2.cvtColor(result, cv2.COLOR_BGR2RGB)


# ──────────────────────────────────────────────────────────────────────
#  メインウィンドウ
# ──────────────────────────────────────────────────────────────────────
class MainWindow(QMainWindow):

    APP_STYLE = """
        QMainWindow { background:#0f0f17; }

        /* ── 左パネル ── */
        #leftPanel {
            background:#16162a;
            border-right:1px solid #252540;
        }
        #appTitle  { font-size:20px; font-weight:700; color:#e2e8f0; }
        #appSub    { font-size:12px; color:#475569; margin-bottom:4px; }
        #secLabel  {
            font-size:10px; font-weight:700;
            color:#3b82f6; letter-spacing:.08em;
            margin-top:6px;
        }
        #hintLabel { font-size:11px; color:#334155; }
        #outLabel  { font-size:11px; color:#64748b; }

        /* ── ファイルリスト ── */
        QListWidget {
            background:#1a1a2e; border:1px solid #252540;
            border-radius:8px; color:#cbd5e1;
            font-size:12px; outline:none;
        }
        QListWidget::item { padding:5px 8px; border-radius:4px; }
        QListWidget::item:selected { background:#1d4ed8; color:#fff; }
        QListWidget::item:hover:!selected { background:#1e293b; }

        /* ── 右パネル / プレビュー ── */
        #rightPanel { background:#0f0f17; }
        #previewHdr {
            font-size:12px; font-weight:600;
            color:#475569; padding-bottom:2px;
        }
        #infoLabel  { font-size:13px; color:#64748b; }

        /* ── ボトムバー ── */
        #bottomBar  { background:#13131f; border-top:1px solid #252540; }
        #statusLabel{ font-size:12px; color:#64748b; }

        /* ── ボタン共通 ── */
        QPushButton {
            background:#1e293b; color:#cbd5e1;
            border:1px solid #334155;
            border-radius:8px; padding:7px 14px; font-size:13px;
        }
        QPushButton:hover   { background:#253449; }
        QPushButton:disabled{ color:#334155; border-color:#1a2332; }

        #runBtn {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #2563eb,stop:1 #7c3aed);
            color:#fff; border:none;
            font-size:15px; font-weight:700;
            border-radius:10px; min-width:140px;
        }
        #runBtn:hover {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #3b82f6,stop:1 #8b5cf6);
        }
        #runBtn:disabled { background:#1e293b; color:#334155; }

        #stopBtn  { color:#ef4444; border-color:#ef4444; }
        #stopBtn:hover { background:#2d1b1b; }

        #clearBtn { color:#f87171; border-color:#3d1515; }
        #clearBtn:hover { background:#2d1515; }

        /* ── コンボ・スライダー ── */
        QComboBox {
            background:#1e293b; color:#cbd5e1;
            border:1px solid #334155;
            border-radius:6px; padding:5px 10px; font-size:13px;
        }
        QComboBox::drop-down { border:none; width:22px; }
        QComboBox QAbstractItemView {
            background:#1e293b; color:#cbd5e1;
            selection-background-color:#1d4ed8;
            border:1px solid #334155;
        }

        QSlider::groove:horizontal {
            height:6px; background:#1e293b; border-radius:3px;
        }
        QSlider::handle:horizontal {
            width:16px; height:16px; background:#3b82f6;
            border-radius:8px; margin:-5px 0;
        }
        QSlider::sub-page:horizontal {
            background:#3b82f6; border-radius:3px;
        }
        QSlider:disabled::sub-page:horizontal { background:#1e293b; }
        QSlider:disabled::handle:horizontal   { background:#334155; }

        QProgressBar {
            background:#1e293b; border-radius:4px; border:none;
        }
        QProgressBar::chunk {
            background:qlineargradient(
                x1:0,y1:0,x2:1,y2:0,
                stop:0 #2563eb,stop:1 #7c3aed);
            border-radius:4px;
        }

        QLabel { color:#94a3b8; }
    """

    def __init__(self):
        super().__init__()
        self.setWindowTitle("人物ぼかし")
        self.setMinimumSize(1000, 660)
        self.resize(1260, 780)

        self._file_data: Dict[str, dict] = {}
        self._worker: Optional[ProcessWorker] = None
        self._output_dir: Optional[str] = None

        self._build_ui()
        self.setStyleSheet(self.APP_STYLE)

    # ── UI 構築 ──────────────────────────────────────────────────────
    def _build_ui(self):
        root_w = QWidget()
        self.setCentralWidget(root_w)
        root = QHBoxLayout(root_w)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        root.addWidget(self._build_left())
        root.addWidget(self._build_right(), stretch=1)

    # ── 左パネル ─────────────────────────────────────────────────────
    def _build_left(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("leftPanel")
        panel.setFixedWidth(290)
        lv = QVBoxLayout(panel)
        lv.setContentsMargins(14, 16, 14, 14)
        lv.setSpacing(8)

        # タイトル
        lv.addWidget(self._lbl("Human Remover", "appTitle"))
        lv.addWidget(self._lbl("写真内の人物を自動検出・処理", "appSub"))

        # ── ファイルリスト ──
        lv.addWidget(self._sec("📁  処理対象ファイル"))
        self.file_list = DropList()
        self.file_list.files_dropped.connect(self._add_files)
        self.file_list.currentRowChanged.connect(self._on_select)
        lv.addWidget(self.file_list, stretch=1)

        hint = self._lbl("ファイル/フォルダをここにドラッグ&ドロップ", "hintLabel")
        hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hint.setWordWrap(True)
        lv.addWidget(hint)

        fb = QHBoxLayout()
        fb.setSpacing(6)
        self.btn_add   = QPushButton("ファイルを追加")
        self.btn_clear = QPushButton("クリア")
        self.btn_clear.setObjectName("clearBtn")
        self.btn_add.clicked.connect(self._pick_files)
        self.btn_clear.clicked.connect(self._clear_list)
        fb.addWidget(self.btn_add)
        fb.addWidget(self.btn_clear)
        lv.addLayout(fb)

        # ── 処理設定 ──
        lv.addWidget(self._sec("⚙   処理設定"))

        # モード
        ml = QHBoxLayout()
        ml.addWidget(QLabel("処理モード:"))
        self.combo_mode = QComboBox()
        self.combo_mode.addItems(["ぼかし (Gaussian)", "モザイク", "消去 (Inpaint)"])
        self.combo_mode.currentIndexChanged.connect(self._on_mode_change)
        ml.addWidget(self.combo_mode, stretch=1)
        lv.addLayout(ml)

        # 強度
        self.lbl_strength = QLabel("ぼかし強度: 51")
        lv.addWidget(self.lbl_strength)
        self.slider_strength = QSlider(Qt.Orientation.Horizontal)
        self.slider_strength.setRange(11, 151)
        self.slider_strength.setValue(51)
        self.slider_strength.setSingleStep(2)
        self.slider_strength.valueChanged.connect(self._on_strength_change)
        lv.addWidget(self.slider_strength)

        # 信頼度
        lv.addWidget(QLabel("検出信頼度 (高いほど厳密):"))
        cr = QHBoxLayout()
        self.slider_conf = QSlider(Qt.Orientation.Horizontal)
        self.slider_conf.setRange(10, 90)
        self.slider_conf.setValue(40)
        self.slider_conf.valueChanged.connect(
            lambda v: self.lbl_conf.setText(f"{v/100:.2f}")
        )
        self.lbl_conf = QLabel("0.40")
        self.lbl_conf.setFixedWidth(32)
        cr.addWidget(self.slider_conf, stretch=1)
        cr.addWidget(self.lbl_conf)
        lv.addLayout(cr)

        # ── 出力先 ──
        lv.addWidget(self._sec("💾  出力先"))
        or_ = QHBoxLayout()
        self.lbl_out = self._lbl("(各画像と同フォルダの output/)", "outLabel")
        self.lbl_out.setWordWrap(True)
        btn_out = QPushButton("変更")
        btn_out.setFixedWidth(46)
        btn_out.clicked.connect(self._pick_outdir)
        or_.addWidget(self.lbl_out, stretch=1)
        or_.addWidget(btn_out)
        lv.addLayout(or_)

        return panel

    # ── 右パネル ─────────────────────────────────────────────────────
    def _build_right(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("rightPanel")
        rv = QVBoxLayout(panel)
        rv.setContentsMargins(16, 16, 16, 0)
        rv.setSpacing(8)

        # プレビューヘッダ
        hdr = QHBoxLayout()
        for txt in ("処理前", "処理後"):
            l = self._lbl(txt, "previewHdr")
            l.setAlignment(Qt.AlignmentFlag.AlignCenter)
            hdr.addWidget(l, stretch=1)
        rv.addLayout(hdr)

        # Before / After 画像
        pr = QHBoxLayout()
        pr.setSpacing(8)
        self.img_before = ImageLabel("処理前プレビュー")
        self.img_after  = ImageLabel("処理後プレビュー")
        pr.addWidget(self.img_before, stretch=1)
        pr.addWidget(self.img_after,  stretch=1)
        rv.addLayout(pr, stretch=1)

        # 情報ラベル
        self.lbl_info = self._lbl("ファイルを選択するとプレビューが表示されます", "infoLabel")
        self.lbl_info.setAlignment(Qt.AlignmentFlag.AlignCenter)
        rv.addWidget(self.lbl_info)

        # ── ボトムバー ──
        bot = QWidget()
        bot.setObjectName("bottomBar")
        bv = QVBoxLayout(bot)
        bv.setContentsMargins(0, 10, 0, 14)
        bv.setSpacing(6)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        self.progress.setFixedHeight(8)
        bv.addWidget(self.progress)

        br = QHBoxLayout()
        br.setSpacing(10)
        self.lbl_status = self._lbl("準備完了", "statusLabel")
        br.addWidget(self.lbl_status, stretch=1)

        self.btn_stop = QPushButton("■ 停止")
        self.btn_stop.setObjectName("stopBtn")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self._stop_processing)

        self.btn_run = QPushButton("▶  処理開始")
        self.btn_run.setObjectName("runBtn")
        self.btn_run.setFixedHeight(44)
        self.btn_run.clicked.connect(self._start_processing)

        br.addWidget(self.btn_stop)
        br.addWidget(self.btn_run)
        bv.addLayout(br)

        rv.addWidget(bot)
        return panel

    # ── ヘルパー ──────────────────────────────────────────────────────
    @staticmethod
    def _lbl(text: str, obj: str = "") -> QLabel:
        l = QLabel(text)
        if obj:
            l.setObjectName(obj)
        return l

    @staticmethod
    def _sec(text: str) -> QLabel:
        l = QLabel(text.upper())
        l.setObjectName("secLabel")
        return l

    # ── ファイル管理 ─────────────────────────────────────────────────
    def _add_files(self, paths: List[str]):
        existing = set(self._file_data)
        for p in paths:
            if p in existing:
                continue
            self._file_data[p] = {
                "status":    STATUS_WAIT,
                "orig":      None,
                "processed": None,
                "n":         0,
            }
            item = QListWidgetItem(make_dot_icon(STATUS_WAIT), Path(p).name)
            item.setData(Qt.ItemDataRole.UserRole, p)
            item.setToolTip(p)
            self.file_list.addItem(item)

        total = len(self._file_data)
        self.lbl_status.setText(f"{total} ファイル登録済み")

    def _pick_files(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "画像を選択", "",
            "画像 (*.jpg *.jpeg *.png *.bmp *.webp *.tiff *.tif)"
        )
        if paths:
            self._add_files(paths)

    def _clear_list(self):
        if self._worker and self._worker.isRunning():
            QMessageBox.warning(self, "処理中", "処理中はクリアできません。")
            return
        self.file_list.clear()
        self._file_data.clear()
        self.img_before.set_image(None)
        self.img_after.set_image(None)
        self.lbl_info.setText("ファイルを選択するとプレビューが表示されます")
        self.lbl_status.setText("準備完了")
        self.progress.setValue(0)

    def _pick_outdir(self):
        d = QFileDialog.getExistingDirectory(self, "出力フォルダを選択", "")
        if d:
            self._output_dir = d
            self.lbl_out.setText(d)

    def _find_item_by_path(self, path: str) -> Optional[QListWidgetItem]:
        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            if item.data(Qt.ItemDataRole.UserRole) == path:
                return item
        return None

    # ── プレビュー更新 ────────────────────────────────────────────────
    def _on_select(self, row: int):
        item = self.file_list.item(row)
        if item is None:
            return
        path = item.data(Qt.ItemDataRole.UserRole)
        data = self._file_data.get(path)
        if data is None:
            return
        name = Path(path).name
        st   = data["status"]

        if st == STATUS_WAIT:
            self.img_before.set_image(None)
            self.img_after.set_image(None)
            self.lbl_info.setText(f"{name}  ─  未処理")

        elif st == STATUS_OK:
            self.img_before.set_image(data["orig"])
            self.img_after.set_image(data["processed"])
            n = data["n"]
            self.lbl_info.setText(f"{name}  ─  {n} 人を検出・処理")

        elif st == STATUS_SKIP:
            self.img_before.set_image(data["orig"])
            self.img_after.set_image(data["orig"])
            self.lbl_info.setText(f"{name}  ─  人物なし（変更なし）")

        elif st == STATUS_ERROR:
            self.img_before.set_image(None)
            self.img_after.set_image(None)
            self.lbl_info.setText(f"{name}  ─  ❌ エラーが発生しました")

    # ── スライダー ────────────────────────────────────────────────────
    @staticmethod
    def _strength_text(idx: int, v: int) -> str:
        if idx == 0:
            return f"ぼかし強度: {(v // 2) * 2 + 1}"
        if idx == 1:
            return f"ブロックサイズ: {max(v // 5, 4)}px"
        return "消去モード (強度設定なし)"

    def _on_strength_change(self, v: int):
        idx = self.combo_mode.currentIndex()
        if idx in (0, 1):
            self.lbl_strength.setText(self._strength_text(idx, v))

    def _on_mode_change(self, idx: int):
        v = self.slider_strength.value()
        self.lbl_strength.setText(self._strength_text(idx, v))
        self.slider_strength.setEnabled(idx != 2)

    # ── 処理 ─────────────────────────────────────────────────────────
    def _get_mode(self) -> str:
        return ["blur", "mosaic", "inpaint"][self.combo_mode.currentIndex()]

    def _start_processing(self):
        wait_paths = [p for p, d in self._file_data.items()
                      if d["status"] == STATUS_WAIT]

        if not wait_paths:
            if not self._file_data:
                QMessageBox.information(self, "ファイルなし",
                    "処理するファイルを追加してください。")
                return
            reply = QMessageBox.question(
                self, "再処理確認",
                "未処理のファイルがありません。\n全ファイルを再処理しますか？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
            # 全てをリセット
            for d in self._file_data.values():
                d["status"] = STATUS_WAIT
            for i in range(self.file_list.count()):
                item = self.file_list.item(i)
                item.setIcon(make_dot_icon(STATUS_WAIT))
                item.setText(Path(item.data(Qt.ItemDataRole.UserRole)).name)
            wait_paths = list(self._file_data.keys())

        self.btn_run.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.progress.setValue(0)

        v        = self.slider_strength.value()
        strength = (v // 2) * 2 + 1   # 奇数
        conf     = self.slider_conf.value() / 100

        self._worker = ProcessWorker(wait_paths, self._get_mode(), strength, conf)
        self._worker.progress.connect(self._on_progress)
        self._worker.item_done.connect(self._on_item_done)
        self._worker.item_error.connect(self._on_item_error)
        self._worker.finished.connect(self._on_finished)
        self._worker.start()

        self.lbl_status.setText(f"処理中…  0 / {len(wait_paths)}")

    def _stop_processing(self):
        if self._worker:
            self._worker.request_stop()
        self.lbl_status.setText("停止リクエスト中…")
        self.btn_stop.setEnabled(False)

    # ── ワーカーシグナルハンドラ ─────────────────────────────────────
    def _on_progress(self, done: int, total: int):
        pct = int(done / total * 100) if total else 0
        self.progress.setValue(pct)
        self.lbl_status.setText(f"処理中…  {done} / {total}")

    def _on_item_done(self, path: str, orig: np.ndarray,
                      processed: np.ndarray, n: int):
        data = self._file_data.get(path)
        if data is None:
            return
        data["orig"]      = orig
        data["processed"] = processed
        data["n"]         = n
        data["status"]    = STATUS_OK if n > 0 else STATUS_SKIP

        # リストアイテム更新
        item = self._find_item_by_path(path)
        if item:
            item.setIcon(make_dot_icon(data["status"]))
            label = Path(path).name
            if n > 0:
                label += f"  ({n}人)"
            item.setText(label)

        # 保存
        self._save(path, processed)

        # 選択中ならプレビュー即反映
        cur = self.file_list.currentItem()
        if cur and cur.data(Qt.ItemDataRole.UserRole) == path:
            self._on_select(self.file_list.currentRow())

    def _on_item_error(self, path: str, msg: str):
        if not path:
            QMessageBox.critical(self, "致命的なエラー", msg)
            self._on_finished()
            return
        data = self._file_data.get(path)
        if data:
            data["status"] = STATUS_ERROR
        item = self._find_item_by_path(path)
        if item:
            item.setIcon(make_dot_icon(STATUS_ERROR))
            item.setText(f"❌  {Path(path).name}")

    def _on_finished(self):
        self.btn_run.setEnabled(True)
        self.btn_stop.setEnabled(False)
        done  = sum(1 for d in self._file_data.values()
                    if d["status"] in (STATUS_OK, STATUS_SKIP))
        total = len(self._file_data)
        self.lbl_status.setText(f"完了  ─  {done} / {total} ファイル処理済み")
        self.progress.setValue(100)

    # ── ファイル保存 ─────────────────────────────────────────────────
    def _save(self, src: str, rgb: np.ndarray):
        p = Path(src)
        if self._output_dir:
            out_dir = Path(self._output_dir)
        else:
            out_dir = p.parent / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / p.name
        if out_path.exists():
            out_path = out_dir / (p.stem + "_processed" + p.suffix)
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        cv2.imwrite(str(out_path), bgr)


# ──────────────────────────────────────────────────────────────────────
#  エントリポイント
# ──────────────────────────────────────────────────────────────────────
def missing_dependencies() -> List[str]:
    missing = []
    try:
        import cv2          # noqa: F401
    except ImportError:
        missing.append("opencv-python")
    try:
        import ultralytics  # noqa: F401
    except ImportError:
        missing.append("ultralytics")
    return missing
