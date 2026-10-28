"""check_data.py（CI の「データの確認」）が、データの事故を見つけられるか。

合成キャンパス（conftest.py）をコピーし、経路写真の CSV などを書き換えて確かめる。
"""
import os
import shutil

import pytest

import check_data

# 合成キャンパスの 1号館の通路 n1→n2・n2→n1 の写真
PHOTOS = (
    "id,from,to,image_name\n"
    "1,100001,100002,100001_to_100002.jpg\n"
    "2,100002,100001,100002_to_100001.jpg\n"
    ",0,0,0_to_0.jpg\n"
)


@pytest.fixture
def make_campus(tiny_campus_dir, tmp_path):
    """合成キャンパスをコピーし、files（相対パス → 中身）で上書きした data/ のパスを返す"""
    count = 0

    def make(files=None):
        nonlocal count
        count += 1
        root = tmp_path / f"campus{count}"
        shutil.copytree(tiny_campus_dir, root)
        for rel, body in {"edge_image.csv": PHOTOS, **(files or {})}.items():
            (root / rel).write_text(body, encoding="utf-8")
        return str(root)

    return make


def run(data, base=None):
    cur = check_data.collect(data)
    old = check_data.collect(base) if base else None
    errors, notes = check_data.judge(cur, old)
    return "\n".join(errors), "\n".join(notes)


def test_問題の無いデータでは失敗しない(make_campus):
    errors, notes = run(make_campus())
    assert errors == ""
    assert "写真が無い区間" in notes


def test_同じ区間が2回書かれていたら失敗する(make_campus):
    data = make_campus({"edge_image.csv": PHOTOS + "3,100001,100002,100001_to_100002.jpg\n"})
    errors, _ = run(data)
    assert "同じ区間が2回以上" in errors
    assert "| 100001→100002 | 1, 3 |" in errors


def test_同じidの行が2つあったら失敗する(make_campus):
    data = make_campus({"edge_image.csv": PHOTOS + "2,100001,100003,100001_to_100003.jpg\n"})
    errors, _ = run(data)
    assert "同じ id の行" in errors


def test_ファイル名の形が違ったら失敗する(make_campus):
    data = make_campus({"edge_image.csv": PHOTOS + "3,100002,100003,100002_to_100004.jpg\n"})
    errors, _ = run(data)
    assert "ファイル名" in errors
    assert "100002_to_100004.jpg" in errors


def test_mainより写真が減ったら失敗する(make_campus):
    base = make_campus()
    # 行を消しすぎて n2→n1 の写真が無くなった
    data = make_campus({"edge_image.csv": "id,from,to,image_name\n1,100001,100002,100001_to_100002.jpg\n"})
    errors, notes = run(data, base)
    assert "写真が無くなった（1 区間）" in errors
    assert "100002→100001" in errors
    assert "+1" in notes


def test_区間ごと経路から無くなった写真は数えない(make_campus, tiny_campus_dir):
    base = make_campus()
    edges = (tiny_campus_dir / "1_bldg" / "edge.csv").read_text(encoding="utf-8")
    # 1号館の通路 n1→n2（エッジ1）を消し、写真の行も消した
    edges = "\n".join(line for line in edges.splitlines() if not line.startswith("1,")) + "\n"
    data = make_campus({"1_bldg/edge.csv": edges, "edge_image.csv": "id,from,to,image_name\n"})
    errors, _ = run(data, base)
    assert "写真が無くなった" not in errors


def test_つながっていないノードが増えたら失敗する(make_campus, tiny_campus_dir):
    base = make_campus()
    nodes = (tiny_campus_dir / "1_bldg" / "node.csv").read_text(encoding="utf-8")
    data = make_campus({"1_bldg/node.csv": nodes + "9,50,50,0,1,1,1,,\n"})
    errors, notes = run(data, base)
    assert "つながっていないノードが増えた（1 個）" in errors
    assert "100009" in errors
    # main と同じなら（もともとあるなら）知らせるだけ
    errors, notes = run(data, data)
    assert "つながっていないノード" not in errors
    assert "100009" in notes


def test_経路が引けない教室があったら失敗する(make_campus, tiny_campus_dir):
    edges = (tiny_campus_dir / "2_bldg" / "edge.csv").read_text(encoding="utf-8")
    # 2号館の外とつながる入口ノード n4 を切り離すと、2号館の教室へ行けなくなる
    nodes = (tiny_campus_dir / "2_bldg" / "node.csv").read_text(encoding="utf-8")
    nodes = nodes.replace("4,20,0,0,2,1,2\n", "4,20,0,0,2,1,2\n6,30,0,0,2,1,1\n")
    edges = edges.replace("3,Cafe,1,4,2,1,1,10,1,Cafe,", "3,Cafe,6,6,2,1,1,10,1,Cafe,")
    data = make_campus({"2_bldg/node.csv": nodes, "2_bldg/edge.csv": edges})
    errors, _ = run(data)
    assert "経路が引けない" in errors
    assert "201" in errors


def test_調べ終わったら読み込み先の環境変数を元に戻す(make_campus, monkeypatch):
    monkeypatch.delenv(check_data.DATA_DIR_ENV, raising=False)
    check_data.collect(make_campus())
    assert check_data.DATA_DIR_ENV not in os.environ
