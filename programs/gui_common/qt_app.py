"""PyQt6ツールの起動処理（どのツールも中身が同じなのでまとめている）。"""
import sys

from PyQt6.QtWidgets import QApplication


def run(window_factory):
    """QApplication を作り、window_factory() のウィンドウを表示して実行する"""
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = window_factory()
    window.show()
    sys.exit(app.exec())
