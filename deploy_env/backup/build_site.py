#!/usr/bin/env python3
"""バックアップ環境で配信するサイトを programs/html から作り、public/site に置く。

本番のコードを変えなくて済むよう、本番のURLをここでバックアップ用のドメインに置き換える。
event-guide-counter.iku-navi.net（案内人数の集計・有人サポート）は Cloudflare でしか動かないので置き換えない。
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SOURCE = ROOT / "programs" / "html"

TEXT_SUFFIXES = {".html", ".js", ".css", ".csv", ".json", ".webmanifest", ".xml", ".txt", ".md"}
# Cloudflare Pages 用の設定とテストは配信しない
EXCLUDE = shutil.ignore_patterns("tests", "__pycache__", "_headers", "_redirects", "config.js", ".DS_Store")


def rewrite_urls(text, domain):
    for sub in ("api.", "cdn.", ""):
        text = text.replace(f"https://{sub}iku-navi.net", f"https://{sub}{domain}")
    return text


def build(domain, maps_key, out):
    work = out.with_name(out.name + ".tmp")
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(SOURCE, work, ignore=EXCLUDE)

    # /campus/ と sitemap は本番のビルドと同じスクリプトで作る。失敗してもサイト本体は出す
    generator = ROOT / "deploy_env" / "pages" / "generate_campus_pages.py"
    result = subprocess.run([sys.executable, str(generator), "--out", str(work)])
    if result.returncode != 0:
        print("[backup] WARN: campus pages were not generated.", file=sys.stderr)

    for path in work.rglob("*"):
        if path.is_file() and path.suffix in TEXT_SUFFIXES:
            original = path.read_text(encoding="utf-8")
            rewritten = rewrite_urls(original, domain)
            if rewritten != original:
                path.write_text(rewritten, encoding="utf-8")

    # 文字列は置き換えの対象にせず、最後に書く
    config = work / "navi" / "script" / "config.js"
    config.write_text(f'const CONFIG = {{\n  GOOGLE_MAPS_API_KEY: "{maps_key}"\n}};\n', encoding="utf-8")
    (work / "robots.txt").write_text("User-agent: *\nDisallow: /\n", encoding="utf-8")
    (work / "sitemap.xml").unlink(missing_ok=True)

    shutil.rmtree(out, ignore_errors=True)
    work.rename(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(HERE / "public" / "site"))
    args = ap.parse_args()

    domain = os.environ.get("BACKUP_DOMAIN", "").strip()
    maps_key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not domain or "/" in domain or domain.endswith("iku-navi.net"):
        sys.exit("ERROR: BACKUP_DOMAIN にバックアップ用のドメインを入れてください（https:// なし）")
    if not maps_key:
        sys.exit("ERROR: GOOGLE_MAPS_API_KEY が空です")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    build(domain, maps_key, out)
    print(f"[backup] site built: {out}")


if __name__ == "__main__":
    main()
