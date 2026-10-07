"""起動前の環境チェックと、環境の診断（python main.py --doctor）。

ほかの人の PC でツールが起動しないとき、Qt は「プラグインを読み込めない」とだけ出して
Python のエラーにならずに終了してしまうことが多く、原因が分かりにくい。そこで画面を作る前に、
よくある原因を順に確かめ、分かったものは直し方を日本語で表示する。

  - Python が古い（3.9 未満）
  - PyQt6 を読み込めない（入っていない・Windows の実行環境が無い・PyQt6 と PyQt6-Qt6 の版が合わない）
  - 画面の表示に使う Qt のプラグイン（macOS: cocoa / Windows: windows / Linux: xcb）が無い
  - Anaconda や別の Qt が残した設定（QT_PLUGIN_PATH など）が、別の版の Qt のプラグインを指している
  - Linux で、Qt 6.5 以降に必要な libxcb-cursor0 が入っていない
あわせて、害は無いのにエラーに見える Qt の警告（無いフォントの代わりを探した、など）を出さないようにする。

このファイルの一番上では PyQt6 を読み込まない（PyQt6 が読み込めない環境でも案内を出すため）。
"""

from __future__ import annotations

import ctypes.util
import importlib
import os
import platform
import subprocess
import sys
from pathlib import Path

MIN_PYTHON = (3, 9)

# ほかの Qt（Anaconda・OpenCV・別の PyQt など）が残していくと、PyQt6 に別の版のプラグインを読ませてしまう設定
FOREIGN_QT_ENV = ("QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH")

# OS ごとの、画面の表示に使うプラグインのファイル名
PLATFORM_PLUGIN = {
    "darwin": ("cocoa", "libqcocoa.dylib"),
    "win32": ("windows", "qwindows.dll"),
    "linux": ("xcb", "libqxcb.so"),
}

# タブごとに必要なライブラリ（import 名, pip で入れる名前）
TAB_REQUIREMENTS = {
    "全タブ共通": [("PyQt6.QtWidgets", "PyQt6"), ("PyQt6.QtSvgWidgets", "PyQt6")],
    "マップ編集": [("cv2", "opencv-python"), ("numpy", "numpy")],
    "ルート検証・画像チェック": [("requests", "requests")],
    "画像リネーム": [("PIL", "Pillow")],
    "人物ぼかし": [("cv2", "opencv-python"), ("numpy", "numpy"), ("ultralytics", "ultralytics")],
}


class StartupError(Exception):
    """起動できない原因が分かったとき。message は利用者に見せる直し方"""


def _os_key() -> str:
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def install_hint() -> str:
    """OS に合わせた、ライブラリの入れ直し方"""
    if _os_key() == "win32":
        return "  py -m pip install --upgrade --force-reinstall PyQt6 PyQt6-Qt6"
    return "  python3 -m pip install --upgrade --force-reinstall PyQt6 PyQt6-Qt6"


def check_python() -> None:
    if sys.version_info < MIN_PYTHON:
        raise StartupError(
            f"Python {platform.python_version()} では動きません（{MIN_PYTHON[0]}.{MIN_PYTHON[1]} 以上が必要です）。\n"
            "新しい Python を入れてから、そちらで実行してください（docs/setup_mac.md 参照）。"
        )


def import_qtcore():
    """PyQt6.QtCore を読み込む。読み込めなければ、原因に合った直し方を付けて StartupError にする"""
    try:
        from PyQt6 import QtCore
        return QtCore
    except ModuleNotFoundError:
        raise StartupError(
            "PyQt6 が入っていません。ツールのフォルダで次を実行してください:\n"
            + ("  py -m pip install -r requirements.txt" if _os_key() == "win32"
               else "  python3 -m pip install -r requirements.txt")
        ) from None
    except ImportError as err:
        text = str(err)
        lines = [f"PyQt6 を読み込めませんでした: {text}", ""]
        if _os_key() == "win32" and "DLL" in text:
            lines += [
                "Windows に必要な実行環境（Microsoft Visual C++ 再頒布可能パッケージ）が無い可能性が高いです。",
                "https://aka.ms/vs/17/release/vc_redist.x64.exe を入れてから、もう一度実行してください。",
                "それでも直らなければ、PyQt6 を入れ直してください:",
            ]
        else:
            lines += ["PyQt6 と PyQt6-Qt6 の版が合っていないか、入り方が壊れている可能性があります。入れ直してください:"]
        lines.append(install_hint())
        raise StartupError("\n".join(lines)) from None


def qt_plugin_dir(QtCore) -> Path:
    return Path(QtCore.QLibraryInfo.path(QtCore.QLibraryInfo.LibraryPath.PluginsPath))


def remove_foreign_qt_env(plugin_dir: Path, environ=os.environ) -> list[str]:
    """PyQt6 以外の場所を指す Qt のプラグインの設定を消す。消したものの説明を返す（PyQt6 の中を指す設定は残す）"""
    removed = []
    for name in FOREIGN_QT_ENV:
        value = environ.get(name)
        if not value:
            continue
        paths = [Path(p) for p in value.split(os.pathsep) if p]
        if paths and all(_is_inside(p, plugin_dir) for p in paths):
            continue
        del environ[name]
        removed.append(f"{name}={value}")
    return removed


def _is_inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def check_platform_plugin(plugin_dir: Path) -> None:
    """画面の表示に使うプラグインのファイルが、PyQt6 の中にあるか"""
    if os.environ.get("QT_QPA_PLATFORM", "") in ("offscreen", "minimal"):
        return   # 画面を出さない動かし方（テストなど）
    key = _os_key()
    if key not in PLATFORM_PLUGIN:
        return
    name, filename = PLATFORM_PLUGIN[key]
    if not (plugin_dir / "platforms" / filename).exists():
        raise StartupError(
            f"画面の表示に使う Qt のプラグイン（{name}）が見つかりません: {plugin_dir / 'platforms'}\n"
            "PyQt6 の入り方が壊れている可能性があります。入れ直してください:\n" + install_hint()
        )


def linux_display_problems(environ=os.environ) -> list[str]:
    """Linux で画面を出すのに足りないもの"""
    if _os_key() != "linux" or environ.get("QT_QPA_PLATFORM", "") in ("offscreen", "minimal"):
        return []
    problems = []
    if not environ.get("DISPLAY") and not environ.get("WAYLAND_DISPLAY"):
        problems.append("画面（DISPLAY / WAYLAND_DISPLAY）がありません。WSL なら WSLg が使える状態か、"
                        "SSH なら画面の転送（ssh -X）を確かめてください。")
    if environ.get("WAYLAND_DISPLAY") is None and ctypes.util.find_library("xcb-cursor") is None:
        problems.append("Qt 6.5 以降に必要な libxcb-cursor0 がありません。次で入れてください:\n"
                        "  sudo apt install libxcb-cursor0   （Fedora は sudo dnf install xcb-util-cursor）")
    return problems


# Qt が出すメッセージのうち、害が無いのに利用者にはエラーに見えるものを出さないようにする設定。
#   qt.qpa.fonts: 指定されたフォントが無いときの「Populating font family aliases took … Replace uses of missing
#   font family …」。手描きのフロアマップ（SVG）の中のフォント指定（'HiraginoSans-W4', 'Hiragino Sans', sans-serif）を
#   Qt が1つの名前として読んでしまうため、地図を開くたびに出る。文字は代わりのフォントで正しく表示される
QUIET_QT_LOG_RULES = "qt.qpa.fonts.warning=false"


def quiet_harmless_qt_warnings(QtCore) -> None:
    QtCore.QLoggingCategory.setFilterRules(QUIET_QT_LOG_RULES)


def prepare() -> list[str]:
    """画面を作る前に呼ぶ。起動できない原因が分かれば StartupError、直せたもの・注意は説明の一覧で返す"""
    check_python()
    QtCore = import_qtcore()
    quiet_harmless_qt_warnings(QtCore)
    plugin_dir = qt_plugin_dir(QtCore)
    notes = [f"別の Qt のプラグインを指す設定を無視しました（PyQt6 自身のプラグインを使います）: {r}"
             for r in remove_foreign_qt_env(plugin_dir)]
    check_platform_plugin(plugin_dir)
    # Linux の不足は、見つけ方によっては入っていても見つからないことがあるので、止めずに注意として出す
    # （本当に足りなければ、このあと Qt が同じ趣旨のエラーを出して終了する）
    notes += [f"注意: {problem}" for problem in linux_display_problems()]
    return notes


# ---------------------------------------------------------------- 診断（python main.py --doctor）

def _apple_silicon_under_rosetta() -> bool:
    if sys.platform != "darwin" or platform.machine() != "x86_64":
        return False
    try:
        out = subprocess.run(["sysctl", "-n", "hw.optional.arm64"], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() == "1"
    except (OSError, subprocess.SubprocessError):
        return False


# 読み込むと重い・余計な表示が出るライブラリは、入っているかと版だけを見る（人物ぼかしの ultralytics は PyTorch ごと読み込む）
LIGHT_CHECK = {"ultralytics"}


def _module_status(module: str) -> str:
    if module in LIGHT_CHECK:
        import importlib.metadata
        import importlib.util
        if importlib.util.find_spec(module) is None:
            return "× 入っていない"
        try:
            return f"○ {importlib.metadata.version(module)}"
        except importlib.metadata.PackageNotFoundError:
            return "○"
    try:
        mod = importlib.import_module(module)
    except Exception as err:   # 読み込み中のあらゆる失敗をそのまま見せる
        return f"× 読み込めない（{type(err).__name__}: {str(err).splitlines()[0] if str(err) else ''}）"
    version = getattr(mod, "__version__", None) or getattr(mod, "PYQT_VERSION_STR", None) or ""
    return f"○ {version}".rstrip()


def doctor_report() -> str:
    """ツールが動かないときに、相談相手に送ってもらう情報"""
    lines = ["===== IKU NAVI ツール 環境診断 =====", ""]
    lines.append(f"OS            : {platform.platform()}")
    lines.append(f"CPU           : {platform.machine()}"
                 + ("（Apple シリコンの Mac で Intel 用の Python が動いています。arm64 版の Python を入れてください）"
                    if _apple_silicon_under_rosetta() else ""))
    lines.append(f"Python        : {platform.python_version()}（{sys.executable}）")
    if sys.version_info < MIN_PYTHON:
        lines.append(f"  → {MIN_PYTHON[0]}.{MIN_PYTHON[1]} 以上が必要です")
    lines.append("")
    try:
        QtCore = import_qtcore()
        plugin_dir = qt_plugin_dir(QtCore)
        lines.append(f"PyQt6 / Qt    : {QtCore.PYQT_VERSION_STR} / {QtCore.QT_VERSION_STR}")
        lines.append(f"Qt のプラグイン: {plugin_dir}")
        key = _os_key()
        if key in PLATFORM_PLUGIN:
            name, filename = PLATFORM_PLUGIN[key]
            found = (plugin_dir / "platforms" / filename).exists()
            lines.append(f"  画面のプラグイン（{name}）: {'○ あり' if found else '× 無い → PyQt6 を入れ直す'}")
    except StartupError as err:
        lines.append(str(err))
    lines.append("")
    lines.append("Qt に関係する環境変数:")
    qt_env = {k: v for k, v in os.environ.items() if k.startswith("QT_")}
    lines += [f"  {k}={v}" for k, v in sorted(qt_env.items())] or ["  （なし）"]
    for problem in linux_display_problems():
        lines.append(f"  → {problem}")
    lines.append("")
    lines.append("タブごとのライブラリ:")
    for tab, mods in TAB_REQUIREMENTS.items():
        lines.append(f"  {tab}")
        for module, package in mods:
            lines.append(f"    {module:<20} {_module_status(module)}（pip: {package}）")
    lines.append("")
    lines.append("困ったときは、この表示をまるごとコピーして送ってください。")
    return "\n".join(lines)
