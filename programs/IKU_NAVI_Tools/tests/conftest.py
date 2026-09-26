"""IKU NAVI ツールのテスト共通設定。画面を出さない offscreen モードで Qt を動かす。

PyQt6 が入っていない環境（GitHub Actions など）では、各テストファイルの先頭の
pytest.importorskip でテストごとスキップする（ここでは PyQt6 を import しない）。
"""
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))



@pytest.fixture(scope="session")
def qapp():
    from PyQt6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def settings(tmp_path):
    """利用者の設定を汚さないよう、一時ファイルの QSettings を使う"""
    from PyQt6.QtCore import QSettings
    return QSettings(str(tmp_path / "settings.ini"), QSettings.Format.IniFormat)


@pytest.fixture
def make_window(qapp, settings):
    from iku_tools.app import ToolsWindow

    windows = []

    def _make(initial_tool=None):
        w = ToolsWindow(initial_tool=initial_tool, settings=settings)
        w.show()
        qapp.processEvents()
        windows.append(w)
        return w

    yield _make
    for w in windows:
        for tool in w._windows.values():
            # 後片付けでは確認ダイアログを出さない
            if hasattr(tool, "_confirm_discard_if_dirty"):
                tool._confirm_discard_if_dirty = lambda: True
        w.close()
        qapp.processEvents()
