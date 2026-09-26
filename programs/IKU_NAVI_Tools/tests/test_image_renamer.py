"""画像リネームタブの一括リスケール（裏で処理して画面を固まらせない）"""
import time

import pytest

pytest.importorskip("PyQt6.QtWidgets")
Image = pytest.importorskip("PIL.Image")

from iku_tools.image_renamer.window import (  # noqa: E402
    MainWindow, resize_image_file, resize_target,
)


def make_images(tmp_path, n, size=(400, 300), ext="jpg"):
    paths = []
    for i in range(n):
        p = tmp_path / f"img{i:03d}.{ext}"
        Image.new("RGB", size, (i * 10 % 255, 100, 150)).save(p)
        paths.append(str(p))
    return paths


def wait_until(qapp, cond, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        qapp.processEvents()
        if cond():
            return True
        time.sleep(0.01)
    return False


# ── 大きさの計算・ファイルの書き換え ─────────────────────────────

@pytest.mark.parametrize("w,h,expected", [
    (200, None, (200, 150)),     # 幅だけ → 縦横比を保つ
    (None, 150, (200, 150)),     # 高さだけ → 縦横比を保つ
    (100, 100, (100, 100)),      # 両方 → 強制
])
def test_変換後の大きさ(w, h, expected):
    assert resize_target((400, 300), w, h) == expected


def test_幅も高さも無ければエラー():
    with pytest.raises(ValueError):
        resize_target((400, 300), None, None)


@pytest.mark.parametrize("ext", ["jpg", "png"])
def test_画像を上書きでリスケールし一時ファイルを残さない(tmp_path, ext):
    (path,) = make_images(tmp_path, 1, ext=ext)
    assert resize_image_file(path, 200, None) == (200, 150)
    with Image.open(path) as img:
        assert img.size == (200, 150)
        assert img.format == ("JPEG" if ext == "jpg" else "PNG")
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"img000.{ext}"]


def test_読めないファイルでも元のファイルは壊さない(tmp_path):
    bad = tmp_path / "broken.jpg"
    bad.write_bytes(b"not an image")
    with pytest.raises(Exception):
        resize_image_file(str(bad), 100, None)
    assert bad.read_bytes() == b"not an image"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["broken.jpg"]


# ── 画面（裏で処理・ステータスバー・中止）───────────────────────

@pytest.fixture
def renamer(qapp, monkeypatch):
    w = MainWindow()
    monkeypatch.setattr(w, "_confirm", lambda _msg: True)
    results = []
    monkeypatch.setattr(w, "_show_result", lambda ok, errors, msg: results.append((ok, errors)))
    # 中止時の情報ダイアログも出さない
    monkeypatch.setattr("iku_tools.image_renamer.window.QMessageBox.information", lambda *a, **k: None)
    w.results = results
    w.show()
    qapp.processEvents()
    yield w
    w.close()


def test_リスケール中も画面は応答しステータスバーに進み具合が出る(renamer, qapp, tmp_path):
    paths = make_images(tmp_path, 40, size=(1600, 1200))
    renamer.drop_list.add_paths(paths)
    renamer.width_edit.setText("320")

    renamer._do_resize()
    # _do_resize はすぐに戻る（ここまで来られること自体が、画面が固まっていない証拠）
    assert renamer.is_resizing()
    assert not renamer._resize_btn.isEnabled()          # 処理中は操作できない
    assert not renamer.drop_list.isEnabled()
    assert renamer._progress.isVisible() and renamer._cancel_btn.isVisible()

    seen_messages = set()
    assert wait_until(qapp, lambda: (seen_messages.add(renamer.statusBar().currentMessage()) or not renamer.is_resizing()))
    assert any(m.startswith("リスケール中") for m in seen_messages)

    assert renamer.results == [(40, [])]
    assert renamer.statusBar().currentMessage() == "40 枚をリスケールしました"
    assert renamer._resize_btn.isEnabled() and renamer.drop_list.isEnabled()
    assert not renamer._progress.isVisible()
    for p in paths:
        with Image.open(p) as img:
            assert img.size == (320, 240)


def test_中止すると残りは処理しない(renamer, qapp, tmp_path):
    paths = make_images(tmp_path, 60, size=(2000, 1500))
    renamer.drop_list.add_paths(paths)
    renamer.width_edit.setText("100")
    renamer._do_resize()
    assert wait_until(qapp, lambda: renamer._progress.value() >= 1)
    renamer._cancel_resize()
    assert wait_until(qapp, lambda: not renamer.is_resizing())
    assert renamer.statusBar().currentMessage().startswith("中止しました")
    done = sum(Image.open(p).size == (100, 75) for p in paths)
    assert 1 <= done < len(paths)
    assert renamer._resize_btn.isEnabled()


def test_失敗した画像があっても残りは続ける(renamer, qapp, tmp_path):
    paths = make_images(tmp_path, 3)
    bad = tmp_path / "zzz_broken.jpg"
    bad.write_bytes(b"not an image")
    renamer.drop_list.add_paths(paths + [str(bad)])
    renamer.width_edit.setText("200")
    renamer._do_resize()
    assert wait_until(qapp, lambda: not renamer.is_resizing())
    ok, errors = renamer.results[0]
    assert ok == 3 and len(errors) == 1 and "zzz_broken.jpg" in errors[0]
    assert "1 枚は失敗" in renamer.statusBar().currentMessage()


def test_処理中に閉じても処理中の1枚を待ってから閉じる(qapp, tmp_path, monkeypatch):
    w = MainWindow()
    monkeypatch.setattr(w, "_confirm", lambda _msg: True)
    w.show()
    paths = make_images(tmp_path, 30, size=(2000, 1500))
    w.drop_list.add_paths(paths)
    w.width_edit.setText("100")
    w._do_resize()
    assert wait_until(qapp, lambda: w._progress.value() >= 1)
    dialogs = []
    monkeypatch.setattr("iku_tools.image_renamer.window.QMessageBox.information", lambda *a, **k: dialogs.append(a))
    monkeypatch.setattr("iku_tools.image_renamer.window.QMessageBox.warning", lambda *a, **k: dialogs.append(a))
    assert w.close() is True
    assert not w.is_resizing()
    for _ in range(50):          # 遅れて届く通知があれば、ここで処理される
        qapp.processEvents()
    assert dialogs == []         # 閉じた後に「中止しました」などのダイアログは出ない
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(".")) == []   # 一時ファイルが残らない
