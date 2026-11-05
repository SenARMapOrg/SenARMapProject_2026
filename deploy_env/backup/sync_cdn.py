#!/usr/bin/env python3
"""cdn.iku-navi.net の経路写真と矢印画像を public/cdn へ複製する。

公開URLから取るので R2 の認証情報は要らない。取得済みのファイルは飛ばすので、途中で止まっても続きから動く。
同じ名前で差し替えられた写真も取り直すときは --verify を付ける（全件のサイズを確認する）。
"""
import argparse
import csv
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CDN = "https://cdn.iku-navi.net"
FIXED_FILES = ["Straight.png", "right.png", "left.png"]  # programs/html/navi/script/state.js
USER_AGENT = "iku-navi-backup-sync/1.0"
TIMEOUT = 60


def image_names(csv_path):
    names = set(FIXED_FILES)
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("image_name") or "").strip()
            # 保存先がフォルダの外に出ないよう、ファイル名だけを受け付ける
            if name and name.lower() != "nan" and name == os.path.basename(name):
                names.add(name)
    return sorted(names)


def request(name, method="GET"):
    url = f"{CDN}/{urllib.parse.quote(name)}"
    return urllib.request.urlopen(
        urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT}), timeout=TIMEOUT
    )


def sync_one(name, out, verify):
    """戻り値: skipped / downloaded / missing / failed"""
    dest = out / name
    try:
        if dest.exists():
            if not verify:
                return name, "skipped"
            with request(name, "HEAD") as res:
                if res.headers.get("Content-Length") == str(dest.stat().st_size):
                    return name, "skipped"
        tmp = dest.with_name(dest.name + ".part")
        with request(name) as res, open(tmp, "wb") as f:
            while chunk := res.read(1024 * 256):
                f.write(chunk)
        tmp.replace(dest)
        return name, "downloaded"
    except urllib.error.HTTPError as e:
        return name, "missing" if e.code == 404 else "failed"
    except OSError:
        return name, "failed"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(HERE / "public" / "cdn"))
    ap.add_argument("--csv", default=str(ROOT / "data" / "edge_image.csv"))
    ap.add_argument("--verify", action="store_true", help="取得済みのファイルもサイズを確認する")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    names = image_names(args.csv)

    results = {"skipped": [], "downloaded": [], "missing": [], "failed": []}
    with ThreadPoolExecutor(args.workers) as pool:
        for name, status in pool.map(lambda n: sync_one(n, out, args.verify), names):
            results[status].append(name)

    print(
        f"[backup] cdn: {len(names)}件 "
        f"取得 {len(results['downloaded'])} / 取得済み {len(results['skipped'])} / "
        f"CDNに無い {len(results['missing'])} / 失敗 {len(results['failed'])}"
    )
    for name in results["missing"]:
        print(f"  CDNに無い: {name}")
    for name in results["failed"]:
        print(f"  失敗: {name}", file=sys.stderr)
    return 1 if results["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
