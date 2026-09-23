"""IKU NAVI のデスクトップツール（PyQt6）が共有するモジュール。

各ツールは自分のディレクトリから `python main.py` のように起動されるため、
このパッケージを import する前に親ディレクトリ（programs/）を sys.path に足す:

    import sys
    from pathlib import Path
    sys.path.append(str(Path(__file__).resolve().parents[1]))

    from gui_common.theme import ACCENT, base_stylesheet
"""
