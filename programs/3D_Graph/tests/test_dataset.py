"""CSV読み込み: グローバルID採番・屋外ノード・入口エッジの自動生成・列の正規化"""
import pandas as pd

from tiny_campus import B1, B2, OUT
from ikunavi.config import ANCHOR_EDGE_ID_BASE
from ikunavi.dataset import load_data


def test_ローカルIDに建物ごとのオフセットが付く(tiny_campus):
    nodes, _ = load_data()
    ids = set(nodes["id"].astype(int))
    assert B1[1] in ids and B1[5] in ids
    assert B2[1] in ids and B2[5] in ids


def test_屋外ノードはbuilding0でオフセットされる(tiny_campus):
    nodes, _ = load_data()
    outdoor = nodes[nodes["building"] == 0]
    assert set(outdoor["id"].astype(int)) == {OUT[1], OUT[2]}
    assert outdoor["lat"].notna().all()


def test_建物ローカル座標がアンカーで共通座標に移る(tiny_campus):
    # 1号館の node4(ローカル20,0,0) が屋外の g1(30,0,0) に重なるよう平行移動される
    nodes, _ = load_data()
    n4 = nodes[nodes["id"] == B1[4]].iloc[0]
    assert n4["x"] == 30.0 and n4["y"] == 0.0 and n4["z"] == 0.0
    n1 = nodes[nodes["id"] == B1[1]].iloc[0]
    assert n1["x"] == 10.0


def test_アンカーから入口エッジが自動生成される(tiny_campus):
    _, edges = load_data()
    entrance = edges[edges["type"] == 7]
    assert len(entrance) == 2
    assert set(entrance["id"].astype(int)) == {ANCHOR_EDGE_ID_BASE, ANCHOR_EDGE_ID_BASE + 1}
    pairs = {(int(r["from"]), int(r["to"])) for _, r in entrance.iterrows()}
    assert pairs == {(B1[4], OUT[1]), (B2[4], OUT[2])}


def test_屋外エッジのIDが屋外ノードとして解決される(tiny_campus):
    _, edges = load_data()
    outdoor = edges[(edges["from"] == OUT[1]) & (edges["to"] == OUT[2])]
    assert len(outdoor) == 1


def test_name_right_left列は欠損なしの文字列になる(tiny_campus):
    _, edges = load_data()
    for col in ("name", "right", "left"):
        assert edges[col].map(lambda v: isinstance(v, str)).all()
        assert not edges[col].isna().any()


def test_type列は整数に正規化される(tiny_campus):
    _, edges = load_data()
    assert pd.api.types.is_integer_dtype(edges["type"])


def test_端点が存在しないエッジは捨てられる(tiny_campus, tmp_path, monkeypatch):
    # 壊れた行（存在しないノードを指すエッジ）を足しても読み込みは落ちない
    broken = tmp_path / "broken"
    broken.mkdir()
    for src in tiny_campus.rglob("*"):
        if src.is_file():
            dst = broken / src.relative_to(tiny_campus)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    edge_csv = broken / "1_bldg" / "edge.csv"
    edge_csv.write_text(edge_csv.read_text(encoding="utf-8") + "9,,1,999,1,1,1,10,1,,\n", encoding="utf-8")

    monkeypatch.setenv("IKUNAVI_DATA_DIR", str(broken))
    _, edges = load_data()
    assert not (edges["to"] == 100999).any()
