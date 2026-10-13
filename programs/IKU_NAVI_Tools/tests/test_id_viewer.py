"""ID一覧タブ（iku_tools/id_viewer）"""
import pytest

pytest.importorskip("PyQt6.QtWidgets")

from iku_tools.id_viewer import data as d  # noqa: E402


@pytest.fixture
def fake_data(tmp_path, monkeypatch):
    """2階建ての小さな建物（9号館）。1階に3ノード・2エッジ、2階に2ノード、1階と2階を階段でつなぐ"""
    b = tmp_path / "9_bldg"
    b.mkdir()
    (b / "node.csv").write_text(
        "id,x,y,z,building,floor,type,svg_x,svg_y\n"
        "1,0,0,0,9,1,2,100,500\n"
        "2,10,0,0,9,1,1,100,300\n"
        "3,10,5,0,9,1,1,200,300\n"
        "4,10,5,4,9,2,1,,\n"
        "5,20,5,4,9,2,1,,\n"
        "6,,,,,,\n",                      # id だけの空の行は飛ばす
        encoding="utf-8")
    (b / "edge.csv").write_text(
        "id,name,from,to,building,floor,weight,length,type,left,right\n"
        "1,,1,2,9,1,1,10,1,9101,\n"
        "2,,2,3,9,1,1,5,1,,9102\n"
        "3,,3,4,9,1,1,4,2,,\n"
        "4,,4,5,9,2,1,10,1,,\n",
        encoding="utf-8")
    monkeypatch.setattr(d, "DATA_DIR", tmp_path)
    monkeypatch.setattr(d, "building_dir", lambda n: tmp_path / f"{n}_bldg")
    monkeypatch.setattr(d, "SVG_DIR", tmp_path)
    return tmp_path


def test_階ごとにノードとエッジを分け_ほかの階への線も分かる(fake_data):
    g = d.load_building(9)
    assert g.problems == []
    assert g.floors() == [1, 2]
    assert [n.id for n in g.floor_nodes(1)] == [1, 2, 3]
    assert [e.id for e in g.floor_edges(1)] == [1, 2]
    assert [e.id for e in g.floor_edges(2)] == [4]
    cross = g.cross_edges(1)
    assert [(c.edge.id, c.here.id, c.other.floor) for c in cross] == [(3, 3, 2)]
    assert g.global_id(12) == 900012


def test_地下と階なしの呼び方():
    assert d.floor_name(0) == "地下1階"
    assert d.floor_name(-1) == "地下2階"
    assert d.floor_name(3) == "3階"
    assert d.floor_name(None) == "階なし"


def test_座標はXが上_Yが右():
    assert d.to_screen(1, 0) == (0, -d.SCALE)    # X が増えると上へ
    assert d.to_screen(0, 1) == (d.SCALE, 0)     # Y が増えると右へ


def test_SVGの位置合わせ(fake_data):
    g = d.load_building(9)
    fit = d.fit_svg(g.floor_nodes(1))
    m11, m12, m21, m22, dx, dy, rms = fit
    assert rms < 1e-6
    for n in g.floor_nodes(1):
        u, v = n.svg
        assert m11 * u + m21 * v + dx == pytest.approx(n.pos[0], abs=1e-6)
        assert m12 * u + m22 * v + dy == pytest.approx(n.pos[1], abs=1e-6)
    assert d.fit_svg(g.floor_nodes(2)) is None    # SVG上の位置が無い階は重ねない


def test_画面に全部の番号を出し_番号で探せる(qapp, fake_data, tmp_path):
    from iku_tools.id_viewer.window import MainWindow, TagItem
    w = MainWindow()
    w.show()
    qapp.processEvents()
    texts = sorted(i.text for i in w._scene.items() if isinstance(i, TagItem))
    # 1階: ノード 1・2・3、エッジ 1・2、ほかの階への線 3（階段↑2階）
    assert texts == ["1", "1", "2", "2", "3", "3 階段↑2階"]
    assert w._node_table.rowCount() == 3 and w._edge_table.rowCount() == 3

    w._global_ids.setChecked(True)
    assert "900001" in [i.text for i in w._scene.items() if isinstance(i, TagItem)]

    assert w.find_id("e4")                       # 2階のエッジ 4 → 2階に切り替わる
    assert w._floor == 2
    assert w.find_id("900003") and w._floor == 1  # 全体IDでも探せる
    assert not w.find_id("99")

    out = tmp_path / "out.png"
    assert w.export_png(str(out)) and out.stat().st_size > 0
    w.close()


def test_実際のデータを全部の階で描ける(qapp):
    """リポジトリの data/ を読み、どの階でもエラーにならず、ノードの数だけ丸い札が出る"""
    from iku_tools.id_viewer.window import MainWindow, TagItem
    if not d.list_buildings():
        pytest.skip("data/ に建物のデータが無い")
    w = MainWindow()
    for b, g in w._graphs.items():
        for f in g.floors():
            assert w.select_floor(b, f) or (w._building, w._floor) == (b, f)
            nodes = [i for i in w._scene.items() if isinstance(i, TagItem) and i._round]
            assert len(nodes) == len(g.floor_nodes(f)), (b, f)
    w.close()
