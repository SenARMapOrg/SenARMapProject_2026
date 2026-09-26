#!/usr/bin/env python3
"""
IKU NAVI Map Editor — カメラプレビュー・撮影パネル
OpenCV (cv2.VideoCapture) でライブプレビューを表示し、ボタン押下でフレームを取得する。
実際のファイル保存・edge_image.csv 登録は app_window 側で行う（このクラスは撮影のみ担当）。
"""

import cv2
import numpy as np
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QImage, QPixmap
from PyQt6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

MAX_DEVICE_INDEX = 4


def bgr_frame_to_pixmap(frame: np.ndarray, target_size) -> QPixmap:
    """OpenCV の BGR numpy フレームを、指定サイズに収まるよう縮小した QPixmap に変換する"""
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    h, w, _ = rgb.shape
    qimg = QImage(rgb.data, w, h, w * 3, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(qimg).scaled(
        target_size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation,
    )


class CameraPanel(QWidget):

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cap = None
        self._last_frame = None   # numpy BGR
        self._timer = QTimer(self)
        self._timer.setInterval(33)  # ~30fps
        self._timer.timeout.connect(self._grab_frame)
        self._build_ui()

    def _build_ui(self):
        vbox = QVBoxLayout(self)
        vbox.setContentsMargins(0, 0, 0, 0)

        row = QHBoxLayout()
        row.addWidget(QLabel("カメラ:"))
        self.device_combo = QComboBox()
        for i in range(MAX_DEVICE_INDEX + 1):
            self.device_combo.addItem(f"デバイス {i}", i)
        row.addWidget(self.device_combo)

        self.connect_btn = QPushButton("接続")
        self.connect_btn.clicked.connect(self._toggle_connect)
        row.addWidget(self.connect_btn)
        row.addStretch()
        vbox.addLayout(row)

        self.preview_label = QLabel("カメラ未接続")
        self.preview_label.setMinimumSize(320, 240)
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setStyleSheet(
            "background:#111827; color:#94A3B8; border-radius:8px; font-size:13px;"
        )
        vbox.addWidget(self.preview_label, 1)

        self.status_label = QLabel("")
        self.status_label.setStyleSheet("color:#666; font-size:11px;")
        vbox.addWidget(self.status_label)

    # ------------------------------------------------------------------
    def _toggle_connect(self):
        if self._cap is not None:
            self.disconnect_camera()
        else:
            self.connect_camera(self.device_combo.currentData())

    def connect_camera(self, device_index: int) -> bool:
        self.disconnect_camera()
        cap = cv2.VideoCapture(device_index)
        if not cap.isOpened():
            cap.release()
            self.status_label.setText(f"デバイス {device_index} に接続できませんでした。")
            return False
        self._cap = cap
        self.connect_btn.setText("切断")
        self.status_label.setText(f"デバイス {device_index} に接続しました。")
        self._timer.start()
        return True

    def disconnect_camera(self):
        self._timer.stop()
        if self._cap is not None:
            self._cap.release()
        self._cap = None
        self._last_frame = None
        self.preview_label.setPixmap(QPixmap())
        self.preview_label.setText("カメラ未接続")
        self.connect_btn.setText("接続")

    def is_connected(self) -> bool:
        return self._cap is not None

    def _grab_frame(self):
        if self._cap is None:
            return
        ok, frame = self._cap.read()
        if not ok:
            return
        self._last_frame = frame
        self.preview_label.setPixmap(bgr_frame_to_pixmap(frame, self.preview_label.size()))

    def capture(self) -> np.ndarray | None:
        """現在のフレーム(BGR numpy array)を返す。未接続・未取得なら None"""
        if self._last_frame is None:
            return None
        return self._last_frame.copy()

    def closeEvent(self, event):
        self.disconnect_camera()
        super().closeEvent(event)
