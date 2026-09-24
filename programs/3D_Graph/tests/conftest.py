"""テスト用の小さなキャンパスデータと、それを読む Flask クライアント。

実データ（リポジトリの data/）はCSVを1行足すだけで件数が変わるため、ロジックの
回帰テストはここで組み立てる合成データに対して行う。環境変数 IKUNAVI_DATA_DIR で
読み込み先を差し替える（ikunavi/config.py の data_path を参照）。

合成キャンパスの構造:

    1号館                     屋外                 2号館
    101号室  102号室          (30,0,0)             201号室
    n1 ──── n2 ──── n4 ====== g1 ──── g2 ====== n4 ──── n1 ──── n2
            │ 階段                                               │ 上りESC(一方向)
            n3 ──── n5                                           n3
            (2F・男子トイレ)                        n1 ──EV── n5(2F)

    === は anchors.csv から自動生成される入口エッジ(type 7, 通過ペナルティ付き)
"""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ikunavi  # noqa: E402
from app import app as flask_app  # noqa: E402

BUILDING_1_NODES = """id,x,y,z,building,floor,type,svg_x,svg_y
1,0,0,0,1,1,1,100,100
2,10,0,0,1,1,1,200,100
3,10,0,4,1,2,1,200,200
4,20,0,0,1,1,2,300,100
5,0,0,4,1,2,1,100,200
"""

BUILDING_1_EDGES = """id,name,from,to,building,floor,weight,length,type,right,left
1,101;102,1,2,1,1,1,10,1,101,102
2,,2,3,1,1,1,4,2,,
3,M_Toilet,3,5,1,2,1,10,1,M_Toilet,
4,,2,4,1,1,1,10,1,,
"""

BUILDING_2_NODES = """id,x,y,z,building,floor,type
1,0,0,0,2,1,1
2,10,0,0,2,1,1
3,10,0,4,2,2,1
4,20,0,0,2,1,2
5,0,0,4,2,2,1
"""

BUILDING_2_EDGES = """id,name,from,to,building,floor,weight,length,type,right,left
1,201,1,2,2,1,1,10,1,201,
2,,2,3,2,1,1,4,5,,
3,Cafe,1,4,2,1,1,10,1,Cafe,
4,,1,5,2,1,1,4,4,,
"""

FILES = {
    "1_bldg/node.csv": BUILDING_1_NODES,
    "1_bldg/edge.csv": BUILDING_1_EDGES,
    "2_bldg/node.csv": BUILDING_2_NODES,
    "2_bldg/edge.csv": BUILDING_2_EDGES,
    "global_node.csv": "id,x,y,z,lat,lng\n1,30,0,0,35.6100,139.5500\n2,60,0,0,35.6101,139.5501\n",
    "global_edge.csv": "id,from,to,building,floor,weight,length,type,name\n1,1,2,0,1,1,30,1,\n",
    "anchors.csv": "building,local_node_id,global_node_id\n1,4,1\n2,4,2\n",
    "buildings.json": '{"1": {"rot_deg": 0}}\n',
    "name.csv": "building,name,display_name\n,101,ゼミ101\n1,102,第一講義室\n",
    "building_name.csv": "building,display_name\n1,第一実験棟\n",
    "ignore.csv": "id\n102\n",
    "cafeteria_edge.csv": "name,building,display_name\nCafe,2,テスト食堂\n",
    "event.csv": "title,building,room,node_id,edge_id\nたこ焼き,2,201,,\n射的,0,,2,\n",
    "edge_image.csv": "id,from,to,image_name\n1,100001,100002,a.jpg\n2,0,0,skip.jpg\n",
}

# 合成キャンパスのグローバルID（テストから参照する）
B1 = {n: 100000 + n for n in range(1, 6)}
B2 = {n: 200000 + n for n in range(1, 6)}
OUT = {1: 9000001, 2: 9000002}


@pytest.fixture(scope="session")
def tiny_campus_dir(tmp_path_factory):
    root = tmp_path_factory.mktemp("tiny_campus")
    for rel, body in FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return root


@pytest.fixture
def tiny_campus(tiny_campus_dir, monkeypatch):
    """合成キャンパスを読ませる。テストごとにキャッシュを捨てる"""
    monkeypatch.setenv("IKUNAVI_DATA_DIR", str(tiny_campus_dir))
    ikunavi.clear_all_caches()
    yield tiny_campus_dir
    ikunavi.clear_all_caches()


@pytest.fixture
def client(tiny_campus):
    return flask_app.test_client()


@pytest.fixture
def real_data(monkeypatch):
    """リポジトリの data/ を読ませる（実データの健全性チェック用）"""
    monkeypatch.delenv("IKUNAVI_DATA_DIR", raising=False)
    ikunavi.clear_all_caches()
    yield
    ikunavi.clear_all_caches()


@pytest.fixture
def real_client(real_data):
    return flask_app.test_client()


@pytest.fixture(autouse=True)
def _isolate_caches():
    """どのテストの影響も次のテストに持ち越さない"""
    ikunavi.clear_all_caches()
    yield
    ikunavi.clear_all_caches()


def pytest_configure(config):
    os.environ.setdefault("PYTHONHASHSEED", "0")
