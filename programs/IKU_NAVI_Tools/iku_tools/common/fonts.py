"""各タブで使うフォント。

"Courier" や "Helvetica" のようにフォント名を書くと、その名前のフォントが無い OS（Mac には "Courier" が無く、
Windows には "Helvetica" が無い）で Qt が代わりのフォントを探し、起動のたびに
「Populating font family aliases took … Replace uses of missing font family "Courier"…」という警告を出す
（探すのに 0.5 秒ほどかかり、利用者には Qt のエラーに見える）。
そこで、どの OS にも必ずある「その OS の標準のフォント」を Qt に聞いて使う。
"""

from __future__ import annotations

from PyQt6.QtGui import QFont, QFontDatabase


def _system(kind: QFontDatabase.SystemFont, size: float, bold: bool) -> QFont:
    font = QFontDatabase.systemFont(kind)
    font.setPointSizeF(size)
    font.setBold(bold)
    return font


def ui_font(size: float, bold: bool = False) -> QFont:
    """その OS の標準のフォント"""
    return _system(QFontDatabase.SystemFont.GeneralFont, size, bold)


def mono_font(size: float, bold: bool = False) -> QFont:
    """その OS の標準の等幅フォント（座標や ID を桁をそろえて並べる所に使う）"""
    return _system(QFontDatabase.SystemFont.FixedFont, size, bold)


def mono_family() -> str:
    """スタイルシート（font-family）に書く、その OS の標準の等幅フォントの名前"""
    return QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont).family()
