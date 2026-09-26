"""ツール群をタブで切り替えて使うメインウィンドウ。

各ツールは、もともと単独のアプリとして作られた QMainWindow（各サブパッケージの window.MainWindow）を
そのままタブの中に埋め込んでいる。ツール同士は互いに依存せず、共通部品は common/ にまとめている。

- タブは最初に開いたときに読み込む。起動が速くなり、人物ぼかしのように重いライブラリ
  （OpenCV・ultralytics）が必要なツールがあっても、入っていない環境で他のツールは使える
- 読み込みに失敗したタブには、原因と対処（pip install のコマンドなど）を表示する
- 閉じるときは、読み込み済みの各ツールに閉じてよいかを確認する（未保存の変更がある場合の確認など）
- 最後に開いていたタブとウィンドウの大きさを覚えておく
"""

from __future__ import annotations

import importlib
import traceback
from dataclasses import dataclass

from PyQt6.QtCore import QSettings, Qt
from PyQt6.QtWidgets import (
    QLabel,
    QMainWindow,
    QPlainTextEdit,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

APP_TITLE = "IKU NAVI ツール"


@dataclass(frozen=True)
class ToolSpec:
    key: str           # サブパッケージ名（iku_tools.<key>.window に MainWindow がある）
    label: str         # タブに表示する名前
    description: str   # タブにマウスを乗せたときの説明


# タブの並び。データを作る流れ（地図の入力 → イベント → 検証 → 写真）の順にしている
TOOLS: tuple[ToolSpec, ...] = (
    ToolSpec("map_editor", "マップ編集", "SVGフロアマップ上でノード・エッジ・経路写真を入力する"),
    ToolSpec("events", "イベント設定", "イベントモードの検索候補（data/event.csv）を編集する"),
    ToolSpec("route_checker", "ルート検証", "全教室ペア間のルートを取得して異常を検出する"),
    ToolSpec("image_checker", "画像チェック", "CDN 上の経路写真の有無をエッジごとに確認する"),
    ToolSpec("image_renamer", "画像リネーム", "経路写真を一括でリネーム・リサイズする"),
    ToolSpec("human_remover", "人物ぼかし", "経路写真に写った人物を検出してぼかす"),
    ToolSpec("svg_pointer", "SVG座標取得", "SVGをクリックして座標を取得する"),
)

TOOL_KEYS = tuple(t.key for t in TOOLS)


def load_tool_window(key: str) -> QMainWindow:
    """ツールの MainWindow を作る。必要なライブラリが無ければ ImportError"""
    module = importlib.import_module(f"iku_tools.{key}.window")
    missing = getattr(module, "missing_dependencies", lambda: [])()
    if missing:
        raise ModuleNotFoundError(
            "このツールに必要なライブラリが入っていません: " + ", ".join(missing),
            name=missing[0],
        )
    return module.MainWindow()


def _error_page(spec: ToolSpec, err: BaseException) -> QWidget:
    page = QWidget()
    layout = QVBoxLayout(page)
    layout.setContentsMargins(24, 24, 24, 24)
    if isinstance(err, ImportError):
        missing = getattr(err, "name", None) or "（不明）"
        title = f"「{spec.label}」を開くのに必要なライブラリが入っていません（{missing}）"
        hint = ("programs/IKU_NAVI_Tools で次を実行してから、このアプリを起動し直してください:\n\n"
                "    pip install -r requirements.txt")
    else:
        title = f"「{spec.label}」を開けませんでした"
        hint = "下のエラー内容を開発メンバーに共有してください。"
    head = QLabel(title)
    head.setStyleSheet("font-size:16px; font-weight:bold;")
    head.setWordWrap(True)
    body = QLabel(hint)
    body.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    detail = QPlainTextEdit("".join(traceback.format_exception(err)))
    detail.setReadOnly(True)
    layout.addWidget(head)
    layout.addWidget(body)
    layout.addWidget(detail, 1)
    return page


class ToolsWindow(QMainWindow):

    def __init__(self, initial_tool: str | None = None, settings: QSettings | None = None):
        super().__init__()
        # 最後に開いていたタブ・ウィンドウの大きさの保存先（テストでは一時ファイルに差し替える）
        self._settings = settings or QSettings("SenARMap", "IKU_NAVI_Tools")
        self._pages: list[QWidget] = []                 # 各タブの入れ物
        self._windows: dict[int, QMainWindow] = {}      # 読み込み済みのツール（タブ番号 → ウィンドウ）

        self.setWindowTitle(APP_TITLE)
        self.resize(1440, 900)
        geometry = self._settings.value("geometry")
        if geometry is not None:
            self.restoreGeometry(geometry)

        self._tabs = QTabWidget()
        self._tabs.setDocumentMode(True)
        self._tabs.setTabPosition(QTabWidget.TabPosition.North)
        # タブを押しやすい大きさにする（タブバーにだけ効かせ、各ツールの中のタブには影響させない）
        self._tabs.tabBar().setStyleSheet("QTabBar::tab { padding: 8px 18px; font-size: 13px; }")
        for i, spec in enumerate(TOOLS):
            page = QWidget()
            QVBoxLayout(page).setContentsMargins(0, 0, 0, 0)
            self._pages.append(page)
            self._tabs.addTab(page, spec.label)
            self._tabs.setTabToolTip(i, spec.description)
        self._tabs.currentChanged.connect(self._on_tab_changed)
        self.setCentralWidget(self._tabs)

        start = initial_tool or str(self._settings.value("last_tool", TOOLS[0].key))
        index = TOOL_KEYS.index(start) if start in TOOL_KEYS else 0
        if index == self._tabs.currentIndex():
            self._on_tab_changed(index)   # 0番目なら currentChanged が発火しないので自分で呼ぶ
        else:
            self._tabs.setCurrentIndex(index)

    # ------------------------------------------------------------------ タブ

    def _ensure_loaded(self, index: int) -> None:
        page = self._pages[index]
        if index in self._windows or page.layout().count() > 0:
            return
        spec = TOOLS[index]
        try:
            window = load_tool_window(spec.key)
        except Exception as err:  # noqa: BLE001  どのツールが壊れても他のタブは使えるようにする
            page.layout().addWidget(_error_page(spec, err))
            return
        # 単独アプリとして作られたウィンドウを、タブの中の部品として扱う
        window.setWindowFlags(Qt.WindowType.Widget)
        window.windowTitleChanged.connect(lambda _t, i=index: self._refresh_title(i))
        page.layout().addWidget(window)
        self._windows[index] = window

    def _on_tab_changed(self, index: int) -> None:
        if index < 0:
            return
        self._ensure_loaded(index)
        self._settings.setValue("last_tool", TOOLS[index].key)
        self._refresh_title(index)

    def _refresh_title(self, index: int) -> None:
        """ウィンドウのタイトルに、開いているツールのタイトル（編集中の建物名など）を出す"""
        if index != self._tabs.currentIndex():
            return
        window = self._windows.get(index)
        tool_title = window.windowTitle() if window else TOOLS[index].label
        self.setWindowTitle(f"{tool_title} — {APP_TITLE}")

    def current_tool_key(self) -> str:
        return TOOLS[self._tabs.currentIndex()].key

    def tool_window(self, key: str) -> QMainWindow | None:
        """読み込み済みのツールのウィンドウ（テスト・デバッグ用）"""
        return self._windows.get(TOOL_KEYS.index(key))

    # ------------------------------------------------------------------ 終了

    def closeEvent(self, event):
        # 読み込み済みの各ツールに閉じてよいか確認する（未保存の変更の確認はツール側が出す）。
        # 途中のツールが閉じるのを断ったら、先に閉じたツールを表示し直してアプリは閉じない
        closed: list[QMainWindow] = []
        for index, window in sorted(self._windows.items()):
            if not window.close():
                for w in closed:
                    w.show()
                self._tabs.setCurrentIndex(index)
                event.ignore()
                return
            closed.append(window)
        self._settings.setValue("geometry", self.saveGeometry())
        super().closeEvent(event)
