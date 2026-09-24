"""座標変換: アンカーからの回転・平行移動の算出"""
import math

import pandas as pd

from ikunavi.transform import apply_transform, calc_transforms_from_anchors, resolved_transform_config


def test_1点アンカーは平行移動だけを求める(tiny_campus):
    transforms = calc_transforms_from_anchors()
    assert transforms["1"]["tx"] == 10.0   # ローカル(20,0,0) → 共通(30,0,0)
    assert transforms["1"]["ty"] == 0.0
    assert transforms["2"]["tx"] == 40.0   # ローカル(20,0,0) → 共通(60,0,0)


def test_1点アンカーの回転はbuildings_jsonのrot_degを使う(tiny_campus):
    transforms = calc_transforms_from_anchors()
    assert transforms["1"]["rot_deg"] == 0.0


def test_2点アンカーは回転角も自動計算する(tiny_campus, tmp_path, monkeypatch):
    # 1号館のローカルX軸(+x)が、共通座標では+y方向を向くようにアンカーを2点置く
    root = tmp_path / "rotated"
    root.mkdir()
    (root / "1_bldg").mkdir()
    (root / "1_bldg" / "node.csv").write_text(
        "id,x,y,z,building,floor,type\n1,0,0,0,1,1,1\n2,10,0,0,1,1,1\n", encoding="utf-8")
    (root / "1_bldg" / "edge.csv").write_text(
        "id,name,from,to,building,floor,weight,length,type\n1,,1,2,1,1,1,10,1\n", encoding="utf-8")
    (root / "global_node.csv").write_text("id,x,y,z\n1,0,0,0\n2,0,10,0\n", encoding="utf-8")
    (root / "anchors.csv").write_text(
        "building,local_node_id,global_node_id\n1,1,1\n1,2,2\n", encoding="utf-8")

    monkeypatch.setenv("IKUNAVI_DATA_DIR", str(root))
    transforms = calc_transforms_from_anchors()
    assert math.isclose(transforms["1"]["rot_deg"], 90.0, abs_tol=1e-9)


def test_回転付きの変換をノード座標に適用できる():
    nodes = pd.DataFrame({"x": [1.0], "y": [0.0], "z": [0.0]})
    moved = apply_transform(nodes, {"rot_deg": 90.0, "tx": 0.0, "ty": 0.0, "tz": 5.0})
    assert math.isclose(moved.loc[0, "x"], 0.0, abs_tol=1e-9)
    assert math.isclose(moved.loc[0, "y"], 1.0, abs_tol=1e-9)
    assert moved.loc[0, "z"] == 5.0


def test_元のDataFrameは書き換えない():
    nodes = pd.DataFrame({"x": [1.0], "y": [2.0], "z": [3.0]})
    apply_transform(nodes, {"tx": 100.0, "ty": 100.0, "tz": 100.0})
    assert nodes.loc[0, "x"] == 1.0


def test_buildings_jsonはアンカーの計算結果で上書きされる(tiny_campus):
    config = resolved_transform_config()
    assert config["1"]["tx"] == 10.0
