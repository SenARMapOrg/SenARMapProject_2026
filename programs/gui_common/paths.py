"""リポジトリ内のデータ・素材ディレクトリの位置。

ツールごとに `Path(__file__).resolve().parents[2]` を書いていると、ファイルを
サブディレクトリへ移した時に静かに壊れるため、ここ一箇所で解決する。
"""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

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
