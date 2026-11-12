"""経路探索APIの「読むだけ」のデータを、静的なJSONファイルとして書き出す。

Cloudflare Pages のビルド（deploy_env/pages/build.sh）で実行し、programs/html/data/ に置く。
画面はサーバー（api.iku-navi.net）を通さず、Pages から直接このファイルを読める。
静的なファイルの配信は Pages では無料・無制限で、Pages Functions の回数の枠も使わない。

中身は API の返事とまったく同じにするため、Flask のアプリをそのまま動かし、
テスト用のクライアントで各 API を呼んだ結果をそのまま保存する（計算の仕組みを2つ持たない）。

  data/graph.json        … /api/graph（全ノード・全エッジの座標と種類。3Dマップ用）
  data/all.json          … /api/all（教室・ノード・建物の一覧）
  data/edge_images.json  … /api/edge_images（区間ごとの経路写真のURL）

使い方: python programs/3D_Graph/export_static.py [--out programs/html]
"""
import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ikunavi import create_app  # noqa: E402

# 書き出すファイル名 → 元になる API
EXPORTS = {
    "graph.json": "/api/graph",
    "all.json": "/api/all",
    "edge_images.json": "/api/edge_images",
}


def export(out_dir):
    """out_dir/data/ に JSON を書き出し、書いたファイルのパスを返す"""
    data_dir = Path(out_dir) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    client = create_app().test_client()
    written = []
    for name, url in EXPORTS.items():
        res = client.get(url)
        if res.status_code != 200:
            raise RuntimeError(f"{url} が {res.status_code} を返しました: {res.get_data(as_text=True)[:200]}")
        path = data_dir / name
        path.write_bytes(res.get_data())
        written.append(path)
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(HERE.parents[1] / "programs" / "html"),
                    help="サイトの出力先（この下の data/ に書く）")
    args = ap.parse_args()
    for path in export(args.out):
        print(f"[export] {path} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
