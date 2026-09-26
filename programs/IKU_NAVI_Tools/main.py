#!/usr/bin/env python3
"""IKU NAVI ツール — データ作成・検証用デスクトップアプリの起動スクリプト

    cd programs/IKU_NAVI_Tools
    pip install -r requirements.txt
    python main.py                 # 前回開いていたタブで起動
    python main.py route_checker   # 指定したタブで起動

タブ: map_editor / events / route_checker / image_checker / image_renamer / human_remover / svg_pointer
"""

import sys

from PyQt6.QtWidgets import QApplication

from iku_tools.app import TOOL_KEYS, ToolsWindow


def main() -> int:
    initial = sys.argv[1] if len(sys.argv) > 1 else None
    if initial is not None and initial not in TOOL_KEYS:
        print(f"不明なタブです: {initial}\n使えるタブ: {', '.join(TOOL_KEYS)}", file=sys.stderr)
        return 2

    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setApplicationName("IKU NAVI ツール")
    window = ToolsWindow(initial_tool=initial)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
