"""シラバス一覧HTMLの解析: 前期・後期・通年の切り分け。

ここが壊れると「前期と後期の両方で開講されているだけの科目」が通年扱いになり、
時間割に追加したときに前期・後期の両方へ登録されてしまう（過去に2回起きている）。
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scrape import SkipReason, parse_rows  # noqa: E402


def build_html(rows):
    """(科目名, 開講期間の行リスト, 担当教員) から一覧テーブルのHTMLを組み立てる"""
    trs = []
    for i, (name, schedule_lines, instructor) in enumerate(rows):
        cls = "column_odd" if i % 2 == 0 else "column_even"
        schedule = "<br>".join(schedule_lines)
        trs.append(
            f'<tr class="{cls}"><td>{i + 1}</td><td><a href="#">{name}</a></td>'
            f"<td>{schedule}</td><td>{instructor}</td></tr>"
        )
    return "<table>" + "".join(trs) + "</table>"


def parse(rows):
    return parse_rows(build_html(rows), SkipReason())


def terms_of(parsed):
    return sorted((r["course_name"], r["day_of_week"], r["period"], r["term"]) for r in parsed)


def test_前期の科目はspringになる():
    got = parse([("経済学", ["前期　月曜日　1時限"], "先生A")])
    assert terms_of(got) == [("経済学", 0, 1, "spring")]


def test_後期の科目はfallになる():
    got = parse([("経済学", ["後期　火曜日　3時限"], "先生A")])
    assert terms_of(got) == [("経済学", 1, 3, "fall")]


def test_通年と書かれていればbothになる():
    got = parse([("卒業研究", ["通年　水曜日　4時限"], "先生B")])
    assert terms_of(got) == [("卒業研究", 2, 4, "both")]


def test_前期と後期が並んでいる行は統合せず2件のまま出す():
    """これが通年に統合されると、追加時に前期・後期の両方へ入ってしまう"""
    got = parse([("バレーボール", ["前期　月曜日　2時限", "後期　月曜日　2時限"], "先生C")])
    assert terms_of(got) == [
        ("バレーボール", 0, 2, "fall"),
        ("バレーボール", 0, 2, "spring"),
    ]


def test_別々の行の前期と後期は当然まとめない():
    got = parse([
        ("英語", ["前期　金曜日　1時限"], "先生D"),
        ("英語", ["後期　金曜日　1時限"], "先生D"),
    ])
    assert terms_of(got) == [
        ("英語", 4, 1, "fall"),
        ("英語", 4, 1, "spring"),
    ]


def test_複数の曜日時限を持つ行はコマごとに出す():
    got = parse([("実習", ["前期　月曜日　1時限", "前期　木曜日　2時限"], "先生E")])
    assert terms_of(got) == [
        ("実習", 0, 1, "spring"),
        ("実習", 3, 2, "spring"),
    ]


def test_同じ内容が2回書かれていても1件にする():
    got = parse([("重複", ["前期　月曜日　1時限", "前期　月曜日　1時限"], "先生F")])
    assert terms_of(got) == [("重複", 0, 1, "spring")]


def test_通年と前期が混在する行はそれぞれ別のコマとして出す():
    got = parse([("ゼミ", ["通年　月曜日　3時限", "前期　水曜日　5時限"], "先生G")])
    assert terms_of(got) == [
        ("ゼミ", 0, 3, "both"),
        ("ゼミ", 2, 5, "spring"),
    ]


@pytest.mark.parametrize("line,reason", [
    ("前期　集中", "曜日・時限が固定されていない"),
    ("前期　日曜日　1時限", "未対応の曜日"),
    ("前期　月曜日　8時限", "未対応の時限"),
])
def test_対応できない開講形式はスキップする(line, reason):
    skips = SkipReason()
    got = parse_rows(build_html([("特殊", [line], "先生H")]), skips)
    assert got == []


def test_担当教員が複数いる場合はまとめて1つの文字列にする():
    got = parse([("共同授業", ["前期　月曜日　1時限"], "先生I<br>先生J")])
    assert got[0]["instructor"] == "先生I / 先生J"
