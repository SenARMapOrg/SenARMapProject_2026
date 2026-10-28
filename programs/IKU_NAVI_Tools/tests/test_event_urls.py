"""イベント設定: URLのコピーと、案内係コードを付けたカウンター用URL。"""
import pytest

from iku_tools.events.data_store import (
    EventEntry, event_url, event_url_lines, normalize_ref_code,
)


def test_イベントのURLはto_eventにIDを入れる():
    assert event_url("12") == "https://iku-navi.net/navi/?to_event=12"


def test_案内係コードを付けるとカウンター用のURLになる():
    assert event_url("12", "7KQ2M9XA") == "https://iku-navi.net/navi/?to_event=12&ref=7KQ2M9XA"


@pytest.mark.parametrize("text, code", [("7kq2m9xa", "7KQ2M9XA"), (" 7KQ2M9XA ", "7KQ2M9XA"), ("", "")])
def test_案内係コードは大文字にそろえる(text, code):
    assert normalize_ref_code(text) == (code, "")


@pytest.mark.parametrize("text", ["7KQ2M9X", "7KQ2M9XAB", "7KQ2M9X0", "7KQ2M9XI", "7KQ2-9XA"])
def test_形式の違う案内係コードはエラーにする(text):
    # 集計側（track-guard.ts）は 0・1・I・O を使わない8文字しか受け付けないので、ここで止める
    _, err = normalize_ref_code(text)
    assert err


def test_全イベントのURLは名前とURLを1行ずつ_IDか名前が無いものは飛ばす():
    entries = [EventEntry("本部", "1"), EventEntry("ID無し", ""), EventEntry("  ", "3"), EventEntry("GREEN STAGE", "66")]
    assert event_url_lines(entries, "7KQ2M9XA") == (
        "本部,https://iku-navi.net/navi/?to_event=1&ref=7KQ2M9XA\n"
        "GREEN STAGE,https://iku-navi.net/navi/?to_event=66&ref=7KQ2M9XA"
    )


def test_画面のボタンでURLとカウンター用URLをコピーできる(request):
    pytest.importorskip("PyQt6.QtCore")   # PyQt6 が無い環境では画面のテストだけ飛ばす
    qapp, settings = request.getfixturevalue("qapp"), request.getfixturevalue("settings")
    from iku_tools.events.window import MainWindow

    w = MainWindow(settings=settings)
    entry = w.current_entry
    assert entry is not None and entry.event_id
    assert not w.copy_counter_btn.isEnabled()       # 案内係コードが空のうちは押せない

    w.copy_url_btn.click()
    assert qapp.clipboard().text() == f"https://iku-navi.net/navi/?to_event={entry.event_id}"

    w.ref_edit.setText("7kq2m9xa")
    w.ref_edit.textEdited.emit("7kq2m9xa")
    assert w.copy_counter_btn.isEnabled()
    w.copy_counter_btn.click()
    assert qapp.clipboard().text() == f"https://iku-navi.net/navi/?to_event={entry.event_id}&ref=7KQ2M9XA"
    assert settings.value("events/ref_code") == "7KQ2M9XA"   # 次に開いたときも入っている

    w.ref_edit.setText("ABC")
    w.ref_edit.textEdited.emit("ABC")
    assert not w.copy_counter_btn.isEnabled() and w.ref_warn_label.text()
    w.close()
