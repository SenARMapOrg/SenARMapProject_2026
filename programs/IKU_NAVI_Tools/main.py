#!/usr/bin/env python3
"""IKU NAVI ツール — データ作成・検証用デスクトップアプリの起動スクリプト

    cd programs/IKU_NAVI_Tools
    pip install -r requirements.txt
    python main.py                 # 前回開いていたタブで起動
    python main.py route_checker   # 指定したタブで起動
    python main.py --doctor        # 起動しないときの環境診断（表示をそのまま相談相手に送る）

タブ: map_editor / events / route_checker / image_checker / image_renamer / human_remover / svg_pointer
"""

from __future__ import annotations

import sys

from iku_tools import startup


def main() -> int:
    args = sys.argv[1:]
    if "--doctor" in args:
        print(startup.doctor_report())
        return 0

    # 画面を作る前に、よくある起動できない原因を確かめる（Qt はプラグインを読み込めないと
    # Python のエラーにならずに終了してしまい、原因が分かりにくいため）
    try:
        for note in startup.prepare():
            print(note, file=sys.stderr)
    except startup.StartupError as err:
        print(f"IKU NAVI ツールを起動できません。\n\n{err}\n\n"
              "詳しく調べるには: python main.py --doctor", file=sys.stderr)
        return 1

    from PyQt6.QtWidgets import QApplication
    from iku_tools.app import TOOL_KEYS, ToolsWindow

    initial = args[0] if args else None
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
