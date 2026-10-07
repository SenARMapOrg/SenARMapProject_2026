"""起動前の環境チェックと環境診断（iku_tools/startup.py）。

ほかの人の PC で起動しない原因（古い Python・別の Qt の設定・プラグインの欠け・Linux の不足）を、
画面を作る前に見つけて、直し方を日本語で出せることを確かめる。
"""
import sys
from pathlib import Path

import pytest

pytest.importorskip("PyQt6.QtCore")

from iku_tools import startup  # noqa: E402


def test_古いPythonでは直し方を出して止める(monkeypatch):
    monkeypatch.setattr(sys, "version_info", (3, 8, 18))
    with pytest.raises(startup.StartupError, match="以上が必要"):
        startup.check_python()


def test_別のQtのプラグインを指す設定は消し_PyQt6の中を指す設定は残す(tmp_path):
    plugin_dir = tmp_path / "PyQt6" / "Qt6" / "plugins"
    (plugin_dir / "platforms").mkdir(parents=True)
    env = {
        "QT_PLUGIN_PATH": str(tmp_path / "anaconda3" / "plugins"),            # 別の Qt（Anaconda など）
        "QT_QPA_PLATFORM_PLUGIN_PATH": str(plugin_dir / "platforms"),          # PyQt6 自身の中
        "PATH": "/usr/bin",
    }
    removed = startup.remove_foreign_qt_env(plugin_dir, env)
    assert "QT_PLUGIN_PATH" not in env
    assert env["QT_QPA_PLATFORM_PLUGIN_PATH"] == str(plugin_dir / "platforms")
    assert removed == [f"QT_PLUGIN_PATH={tmp_path / 'anaconda3' / 'plugins'}"]
    assert env["PATH"] == "/usr/bin"   # Qt に関係ない設定はそのまま


def test_画面のプラグインが無ければ入れ直し方を出して止める(tmp_path, monkeypatch):
    monkeypatch.delenv("QT_QPA_PLATFORM", raising=False)
    monkeypatch.setattr(startup, "_os_key", lambda: "darwin")
    (tmp_path / "platforms").mkdir()
    with pytest.raises(startup.StartupError, match="cocoa") as err:
        startup.check_platform_plugin(tmp_path)
    assert "pip install --upgrade --force-reinstall PyQt6 PyQt6-Qt6" in str(err.value)
    (tmp_path / "platforms" / "libqcocoa.dylib").write_bytes(b"")
    startup.check_platform_plugin(tmp_path)   # あれば何も起きない


def test_Windowsでは入れ直し方を_py_コマンドで案内する(monkeypatch):
    monkeypatch.setattr(startup, "_os_key", lambda: "win32")
    assert startup.install_hint().strip().startswith("py -m pip")


def test_Linuxで画面が無い_libxcb_cursorが無い場合を見つける(monkeypatch):
    monkeypatch.setattr(startup, "_os_key", lambda: "linux")
    monkeypatch.setattr(startup.ctypes.util, "find_library", lambda name: None)
    problems = startup.linux_display_problems({})
    assert any("DISPLAY" in p for p in problems)
    assert any("libxcb-cursor0" in p for p in problems)
    monkeypatch.setattr(startup.ctypes.util, "find_library", lambda name: "libxcb-cursor.so.0")
    assert startup.linux_display_problems({"DISPLAY": ":0"}) == []
    assert startup.linux_display_problems({"QT_QPA_PLATFORM": "offscreen"}) == []


def test_起動前のチェックは_別のQtの設定を消したことを知らせる(monkeypatch, tmp_path):
    monkeypatch.setenv("QT_PLUGIN_PATH", str(tmp_path / "other-qt"))
    notes = startup.prepare()
    assert any("QT_PLUGIN_PATH" in n for n in notes)
    import os
    assert "QT_PLUGIN_PATH" not in os.environ


def test_環境診断にはPython_Qt_プラグイン_各タブのライブラリが出る():
    report = startup.doctor_report()
    for word in ("Python", "PyQt6 / Qt", "Qt のプラグイン", "画面のプラグイン", "マップ編集", "人物ぼかし", "まるごとコピー"):
        assert word in report


def test_main_の_doctor_は画面を作らずに診断を出す(capsys):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import main
    monkey_argv = sys.argv
    try:
        sys.argv = ["main.py", "--doctor"]
        assert main.main() == 0
    finally:
        sys.argv = monkey_argv
    assert "環境診断" in capsys.readouterr().out


# ---------------------------------------------------------------- フォント（Qt の警告の元）

def test_OSに無いことがあるフォント名をコードに直接書いていない():
    """"Courier"（Mac に無い）や "Helvetica"（Windows に無い）を書くと、Qt が代わりを探して警告を出す。
    iku_tools/common/fonts.py の ui_font / mono_font（OS の標準のフォント）を使う"""
    import re
    root = Path(__file__).resolve().parents[1] / "iku_tools"
    pattern = re.compile(r"""QFont\(\s*["'](Courier|Courier New|Helvetica|Arial|Menlo|Consolas)["']|font-family:\s*["']?(Courier|Helvetica)""")
    hits = [f"{p.relative_to(root)}:{n}" for p in root.rglob("*.py") if p.name != "fonts.py"
            for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1) if pattern.search(line)]
    assert hits == []


def test_OSの標準フォントを大きさ_太さを指定して使える(qapp):
    from iku_tools.common.fonts import mono_family, mono_font, ui_font
    f = mono_font(11, bold=True)
    assert f.pointSizeF() == 11 and f.bold() and f.family()
    assert ui_font(9).pointSizeF() == 9
    assert mono_family()
