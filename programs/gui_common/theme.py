"""チェッカー系ツール（Route_Checker / Image_Checker）共通のダークテーマ。

色を変えるときはここを直せば両方のツールに反映される。
ツール固有の色（カードの背景など）は各ツール側で定義すること。
"""

BG_WIN      = "#111827"   # ウィンドウ地色
BG_BAR      = "#1F2937"   # ツールバー・スクロールバー
BORDER      = "#2D3748"

TXT_PRIMARY = "#F1F5F9"
TXT_SUB     = "#94A3B8"
TXT_KEY     = "#CBD5E1"

ACCENT      = "#00B8E6"
BTN_ACTIVE  = "#0E7490"
BTN_IDLE    = "#374151"

INPUT_BG     = "#374151"
INPUT_BORDER = "#4B5563"

COL_OK   = "#4ADE80"
COL_WARN = "#FBBF24"
COL_ERR  = "#F87171"


def base_stylesheet() -> str:
    """ウィンドウ・スクロールバー・入力欄・進捗バーの共通スタイル。

    各ツールは自分固有のスタイル（テーブルやカードなど）を後ろに連結して使う。
    """
    return f"""
            QMainWindow, QWidget  {{ background: {BG_WIN}; color: {TXT_PRIMARY}; }}
            QScrollArea           {{ background: {BG_WIN}; border: none; }}
            QScrollBar:vertical   {{ background: {BG_BAR}; width: 8px; border-radius: 4px; }}
            QScrollBar::handle:vertical {{
                background: {INPUT_BORDER}; border-radius: 4px; min-height: 20px;
            }}
            QScrollBar:horizontal {{ background: {BG_BAR}; height: 8px; border-radius: 4px; }}
            QScrollBar::handle:horizontal {{
                background: {INPUT_BORDER}; border-radius: 4px; min-width: 20px;
            }}
            QLineEdit {{
                background: {INPUT_BG}; color: {TXT_PRIMARY};
                border: 1px solid {INPUT_BORDER}; border-radius: 6px;
                padding: 5px 10px; font-size: 15px;
            }}
            QLineEdit:focus {{ border-color: {ACCENT}; }}
            QProgressBar {{
                background: {INPUT_BG}; border: none; border-radius: 4px;
                color: transparent;
            }}
            QProgressBar::chunk {{ background: {ACCENT}; border-radius: 4px; }}
    """
