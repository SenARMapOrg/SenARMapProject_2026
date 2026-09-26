"""リポジトリ内のデータ・素材ディレクトリの位置。

各ツールが `Path(__file__)` から相対でパスを組み立てていると、ファイルを移したときに
静かに壊れるため、ここ一箇所で解決する。
"""
from pathlib import Path

# このファイル → common → iku_tools → IKU_NAVI_Tools → programs → リポジトリ直下
REPO_ROOT = Path(__file__).resolve().parents[4]

DATA_DIR  = REPO_ROOT / "data"
SVG_DIR   = REPO_ROOT / "programs" / "html" / "svg"
PHOTO_DIR = REPO_ROOT / "captured_photos"

BUILDING_NAME_CSV = DATA_DIR / "building_name.csv"
EVENT_CSV         = DATA_DIR / "event.csv"
GLOBAL_NODE_CSV   = DATA_DIR / "global_node.csv"
GLOBAL_EDGE_CSV   = DATA_DIR / "global_edge.csv"
EDGE_IMAGE_CSV    = DATA_DIR / "edge_image.csv"


def building_dir(building) -> Path:
    """data/{building}_bldg/"""
    return DATA_DIR / f"{building}_bldg"
