"""表示名の解決: name.csv / building_name.csv / ignore.csv とトイレの固定ラベル"""
from ikunavi.cache import get_room_index
from ikunavi.naming import (
    building_display_name,
    display_name,
    first_display_label,
    get_ignore_set,
)


def test_建物指定の行が全建物共通より優先される(tiny_campus):
    assert display_name(1, "102") == "第一講義室"   # building=1 の行
    assert display_name(1, "101") == "ゼミ101"      # building 空欄の共通行


def test_未登録の名前は教室を付けて返す(tiny_campus):
    assert display_name(2, "201") == "201教室"


def test_建物名は未登録なら号館にフォールバックする(tiny_campus):
    assert building_display_name(1) == "第一実験棟"
    assert building_display_name(2) == "2号館"
    assert building_display_name(0) == "屋外"


def test_トイレはname_csvではなく固定ラベルを使う(tiny_campus):
    assert first_display_label(1, "M_Toilet") == "男子トイレ"
    assert first_display_label(1, "F_Toilet") == "女子トイレ"


def test_セミコロン区切りは先頭だけを表示名にする(tiny_campus):
    assert first_display_label(1, "101;102") == "ゼミ101"


def test_空の値は空文字になる(tiny_campus):
    assert first_display_label(1, "") == ""
    assert first_display_label(1, None) == ""


def test_ignore_csvの名前は教室一覧から隠れる(tiny_campus):
    assert get_ignore_set() == {"102"}
    _, rooms = get_room_index()
    assert "102" not in [r["room"] for r in rooms]


def test_隠した教室も索引には残る(tiny_campus):
    index, _ = get_room_index()
    assert ("102", 1) in index


def test_トイレも教室一覧には出ないが索引には残る(tiny_campus):
    index, rooms = get_room_index()
    assert "M_Toilet" not in [r["room"] for r in rooms]
    assert ("M_Toilet", 1) in index


def test_教室一覧は建物と名前の順に並ぶ(tiny_campus):
    _, rooms = get_room_index()
    assert [(r["building"], r["room"]) for r in rooms] == [(1, "101"), (2, "201"), (2, "Cafe")]
