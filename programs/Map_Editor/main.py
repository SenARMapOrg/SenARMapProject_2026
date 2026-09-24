#!/usr/bin/env python3
"""
IKU NAVI Map Editor — エントリーポイント

SVGフロアマップ上でノード/エッジのデータ入力・削除・撮影を1画面で行うツール。
使い方は同ディレクトリの README.md を参照。

Usage:
  python main.py

依存:
  pip install -r requirements.txt
"""

import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))
from gui_common import qt_app

from app_window import MainWindow


def main():
    qt_app.run(MainWindow)


if __name__ == "__main__":
    main()
