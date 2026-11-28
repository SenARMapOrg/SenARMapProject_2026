"""3Dグラフ — 経路探索API（programs/3D_Graph）の /3d（Plotly の3D経路ビューア）をツールの中で開く。

ページはそのまま使い、動画を撮るための操作（自動で回る・ゆっくり寄る・操作パネルを隠す・縦横比・全画面）を
右のパネルから足す。操作は video.js をページに流し込んで、Plotly のカメラを外から動かす（ページとデータは変えない）。

- 既定は本番（old-api.iku-navi.net の Flask）。手元で編集した data/ を映すときは、
  `cd programs/3D_Graph && python app.py` で起動し、API の欄を http://localhost:5001 にする
- 画面の録画は、OS の画面収録（Mac は Shift+Command+5）で「全画面で映す」か、3Dの部分だけを選んで撮る
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import List

from PyQt6.QtCore import QSize, Qt, QTimer, QUrl
from PyQt6.QtGui import QKeySequence, QShortcut
from PyQt6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from ..common.api import DEFAULT_API

try:
    from PyQt6.QtWebEngineCore import QWebEngineSettings
    from PyQt6.QtWebEngineWidgets import QWebEngineView
except ImportError:   # missing_dependencies() で案内する
    QWebEngineView = None

VIDEO_JS = Path(__file__).with_name("video.js")

# テストではページを読み込まない（ネットワークに出ない）
AUTOLOAD = os.environ.get("IKU_TOOLS_GRAPH3D_NO_AUTOLOAD") != "1"

# 映像の縦横比（None = ウィンドウいっぱい）
ASPECTS = (
    ("ウィンドウいっぱい", None),
    ("16:9（横長・YouTube など）", (16, 9)),
    ("9:16（縦長・ショート）", (9, 16)),
    ("1:1（正方形）", (1, 1)),
    ("4:3", (4, 3)),
)


def missing_dependencies() -> List[str]:
    return [] if QWebEngineView is not None else ["PyQt6-WebEngine"]


def viewer_url(api: str) -> str:
    """API の欄の値から /3d の URL を作る（末尾の / や /3d の有無を気にしなくてよい）"""
    base = api.strip().rstrip("/") or DEFAULT_API
    if base.endswith("/3d"):
        base = base[: -len("/3d")]
    if "://" not in base:
        base = "http://" + base
    return base + "/3d"


def fit_aspect(width: int, height: int, aspect) -> tuple[int, int, int, int]:
    """width×height の枠に、縦横比 aspect の映像を真ん中に最大で置いたときの (x, y, w, h)"""
    if not aspect:
        return 0, 0, width, height
    aw, ah = aspect
    w, h = width, width * ah // aw
    if h > height:
        w, h = height * aw // ah, height
    return (width - w) // 2, (height - h) // 2, w, h


class Stage(QWidget):
    """3Dグラフを、選んだ縦横比で真ん中に置く黒い台"""

    def __init__(self, view: QWidget):
        super().__init__()
        self.view = view
        self.aspect = None
        view.setParent(self)
        self.setStyleSheet("background: #000;")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)

    def set_aspect(self, aspect) -> None:
        self.aspect = aspect
        self._place()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._place()

    def _place(self) -> None:
        self.view.setGeometry(*fit_aspect(self.width(), self.height(), self.aspect))


class MainWindow(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("3Dグラフ")
        self._fullscreen: QWidget | None = None

        self.view = QWebEngineView()
        self.view.settings().setAttribute(QWebEngineSettings.WebAttribute.ShowScrollBars, False)
        self.view.loadFinished.connect(self._on_loaded)
        self.stage = Stage(self.view)
        self._video_js = VIDEO_JS.read_text(encoding="utf-8")

        central = QWidget()
        row = QHBoxLayout(central)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(0)
        row.addWidget(self.stage, 1)
        row.addWidget(self._build_panel())
        self.setCentralWidget(central)

        self._size_timer = QTimer(self, interval=500, timeout=self._update_size_label)
        self._size_timer.start()

        QShortcut(QKeySequence(Qt.Key.Key_Escape), self, activated=self.exit_fullscreen)
        if AUTOLOAD:
            QTimer.singleShot(0, self.load)

    # ------------------------------------------------------------------ 右のパネル

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(12, 12, 12, 12)
        lay.setSpacing(10)

        # データ
        box = QGroupBox("データ")
        form = QVBoxLayout(box)
        self.api_edit = QLineEdit(DEFAULT_API)
        self.api_edit.setToolTip("手元の data/ を映すときは、programs/3D_Graph で python app.py を起動して "
                                 "http://localhost:5001 にする")
        self.api_edit.returnPressed.connect(self.load)
        load_btn = QPushButton("読み込む")
        load_btn.setToolTip("ページを読み込み直す（データを読み込んで3Dグラフが出るところも撮れる）")
        load_btn.clicked.connect(self.load)
        form.addWidget(QLabel("API（/3d を開くサーバー）"))
        form.addWidget(self.api_edit)
        form.addWidget(load_btn)
        lay.addWidget(box)

        # 回転
        box = QGroupBox("回転")
        form = QFormLayout(box)
        self.rotate_check = QCheckBox("自動で回る")
        self.period_slider = QSlider(Qt.Orientation.Horizontal, minimum=8, maximum=180, value=40)
        self.period_label = QLabel()
        self.dir_combo = QComboBox()
        self.dir_combo.addItems(["左回り", "右回り"])
        self.bob_check = QCheckBox("高さも変えながら回る")
        self.bob_check.setToolTip("見下ろす角度を、ゆっくり上げ下げする")
        form.addRow(self.rotate_check)
        form.addRow("1周", self.period_label)
        form.addRow(self.period_slider)
        form.addRow("向き", self.dir_combo)
        form.addRow(self.bob_check)
        lay.addWidget(box)

        # 寄る・離れる
        box = QGroupBox("寄る・離れる")
        form = QFormLayout(box)
        self.zoom_combo = QComboBox()
        self.zoom_combo.addItems(["止める", "ゆっくり寄る", "ゆっくり離れる"])
        self.zoom_slider = QSlider(Qt.Orientation.Horizontal, minimum=1, maximum=30, value=5)
        form.addRow("動き", self.zoom_combo)
        form.addRow("速さ", self.zoom_slider)
        lay.addWidget(box)

        # 視点
        box = QGroupBox("視点")
        views = QHBoxLayout(box)
        for text, name in (("斜め", "oblique"), ("真上", "top"), ("横から", "side")):
            btn = QPushButton(text)
            btn.clicked.connect(lambda _c, n=name: self.set_view(n))
            views.addWidget(btn)
        lay.addWidget(box)

        # 見た目
        box = QGroupBox("見た目")
        form = QVBoxLayout(box)
        self.clean_check = QCheckBox("ページの操作パネル・ヒントを隠す")
        self.clean_check.setToolTip("経路を出したいときは、隠す前にページの左のパネルで検索しておく")
        self.legend_check = QCheckBox("凡例を隠す")
        self.axes_check = QCheckBox("軸と目盛りを隠す")
        for w in (self.clean_check, self.legend_check, self.axes_check):
            form.addWidget(w)
        lay.addWidget(box)

        # 映像
        box = QGroupBox("映像")
        form = QFormLayout(box)
        self.aspect_combo = QComboBox()
        for text, _ in ASPECTS:
            self.aspect_combo.addItem(text)
        self.aspect_combo.currentIndexChanged.connect(lambda i: self.stage.set_aspect(ASPECTS[i][1]))
        self.size_label = QLabel()
        full_btn = QPushButton("全画面で映す（Esc で戻る）")
        full_btn.clicked.connect(self.enter_fullscreen)
        form.addRow("縦横比", self.aspect_combo)
        form.addRow("大きさ", self.size_label)
        form.addRow(full_btn)
        lay.addWidget(box)

        hint = QLabel("マウスで回したり拡大したりすると、自動の動きはその向きから続きます。"
                      "録画は OS の画面収録（Mac は Shift+Command+5）で撮ります。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #888;")
        lay.addWidget(hint)
        lay.addStretch(1)

        for w in (self.rotate_check, self.bob_check, self.clean_check, self.legend_check, self.axes_check):
            w.toggled.connect(self._push_options)
        for w in (self.dir_combo, self.zoom_combo):
            w.currentIndexChanged.connect(self._push_options)
        for w in (self.period_slider, self.zoom_slider):
            w.valueChanged.connect(self._push_options)
        self._push_options()

        scroll = QScrollArea()
        scroll.setWidget(panel)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setFixedWidth(300)
        return scroll

    # ------------------------------------------------------------------ ページ

    def load(self) -> None:
        self.view.setUrl(QUrl(viewer_url(self.api_edit.text())))

    def _on_loaded(self, ok: bool) -> None:
        if not ok:
            return
        self.view.page().runJavaScript(self._video_js)
        self._push_options()

    def options(self) -> dict:
        """ページの window.__ikuVideo.set に渡す設定"""
        return {
            "rotate": self.rotate_check.isChecked(),
            "period": self.period_slider.value(),
            "dir": 1 if self.dir_combo.currentIndex() == 0 else -1,
            "bob": self.bob_check.isChecked(),
            "zoom": (0, 1, -1)[self.zoom_combo.currentIndex()],
            "zoomSpeed": self.zoom_slider.value() / 100,
            "clean": self.clean_check.isChecked(),
            "hideLegend": self.legend_check.isChecked(),
            "hideAxes": self.axes_check.isChecked(),
        }

    def _push_options(self) -> None:
        self.period_label.setText(f"{self.period_slider.value()} 秒")
        self._run(f"window.__ikuVideo && window.__ikuVideo.set({json.dumps(self.options())})")

    def set_view(self, name: str) -> None:
        self._run(f"window.__ikuVideo && window.__ikuVideo.view({name!r})")

    def _run(self, script: str) -> None:
        self.view.page().runJavaScript(script)

    # ------------------------------------------------------------------ 映像

    def _update_size_label(self) -> None:
        v = self.view
        dpr = v.devicePixelRatioF()
        self.size_label.setText(f"{v.width()}×{v.height()}（録画では約 {round(v.width() * dpr)}×{round(v.height() * dpr)}）")

    def enter_fullscreen(self) -> None:
        """3Dの部分だけを、別の窓で画面いっぱいに出す（縦横比はそのまま）"""
        if self._fullscreen is not None:
            return
        win = QWidget(None, Qt.WindowType.Window)
        win.setWindowTitle("3Dグラフ（Esc で戻る）")
        QVBoxLayout(win).setContentsMargins(0, 0, 0, 0)
        self._home = self.stage.parentWidget()
        self._home_index = self._home.layout().indexOf(self.stage)
        win.layout().addWidget(self.stage)
        QShortcut(QKeySequence(Qt.Key.Key_Escape), win, activated=self.exit_fullscreen)
        win.closeEvent = lambda e: (self.exit_fullscreen(), e.accept())
        self._fullscreen = win
        win.showFullScreen()

    def exit_fullscreen(self) -> None:
        win, self._fullscreen = self._fullscreen, None
        if win is None:
            return
        self._home.layout().insertWidget(self._home_index, self.stage, 1)
        win.hide()
        win.deleteLater()

    def sizeHint(self) -> QSize:
        return QSize(1280, 800)

    def closeEvent(self, event):
        self.exit_fullscreen()
        super().closeEvent(event)
