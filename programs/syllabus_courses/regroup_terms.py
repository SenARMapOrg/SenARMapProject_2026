#!/usr/bin/env python3
"""既存の courses_raw.jsonl から courses.json を作り直すツール（大学サイトへの再アクセスなし）。

学部/学科の集約（同じ科目が複数学科のカリキュラムに入っている場合に departments 配列へまとめる）
だけを行う。term は生データに入っている値をそのまま使い、ここでは一切推測しない。

## 通年(term="both")の扱いと、古い生データについての注意

通年かどうかはサイトの「開講期間」欄に「通年」と書かれているかどうかで決まり、
scrape.py の parse_rows() がその時点で確定させている（2026-09-25 以降）。

それ以前の scrape.py は「通年」を spring と fall の2行に分解して保存していたため、
**その頃に取得した courses_raw.jsonl からは通年科目を復元できない**。さらに当時の
このスクリプトは「同じ科目名・担当教員が連続して並んでいる区間の中で、同じ曜日・時限に
前期と後期の両方があれば通年とみなす」というヒューリスティックで通年を復元しようとしていたが、
同じ科目を前期にも後期にも開講しているだけの科目（体育実技や語学など）まで通年に統合してしまい、
時間割に追加すると前期・後期の両方に入ってしまう不具合の原因になっていた。

そのためこのスクリプトは推測をやめ、生データに term="both" が1件も無い場合は
「その生データは修正前のもので通年情報を持っていない」と警告する。正しい通年情報が必要なら
scrape.py で取り直すこと。

## 使い方

    python regroup_terms.py                       # 全年度分(output/{year}/、および直下)を作り直す
    python regroup_terms.py --year 2026            # 指定年度だけ作り直す

出力は各年度の courses.json を直接上書きする（courses_raw.jsonl は読み取り専用、変更しない）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

OUT_DIR = Path(__file__).parent / "output"


def rebuild_with_departments(raw_path: Path, final_path: Path) -> tuple[int, int]:
    """courses_raw.jsonl を読み、学部/学科を集約した courses.json を書く。

    戻り値: (出力件数, うち通年の件数)
    """
    groups: dict[tuple, dict] = {}
    with raw_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            key = (obj["course_name"], obj["day_of_week"], obj["period"], obj["term"], obj["instructor"])
            if key not in groups:
                groups[key] = {
                    "course_name": obj["course_name"],
                    "day_of_week": obj["day_of_week"],
                    "period": obj["period"],
                    "term": obj["term"],
                    "room": obj["room"],
                    "instructor": obj["instructor"],
                    "_dept_set": set(),
                }
            groups[key]["_dept_set"].add((obj["faculty"], obj["department"]))

    entries = []
    both_count = 0
    for g in groups.values():
        dept_set = g.pop("_dept_set")
        g["departments"] = [{"faculty": f, "department": d} for f, d in sorted(dept_set)]
        if g["term"] == "both":
            both_count += 1
        entries.append(g)

    final_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(entries), both_count


def process_year(out_dir: Path, label: str) -> None:
    raw_path = out_dir / "courses_raw.jsonl"
    final_path = out_dir / "courses.json"
    if not raw_path.exists():
        print(f"[skip] {label}: {raw_path} が見つかりません")
        return
    n, both = rebuild_with_departments(raw_path, final_path)
    print(f"[done] {label}: {final_path} に {n}件を出力（うち通年 {both}件）")
    if both == 0:
        print(f"[warn] {label}: 通年科目が0件です。この生データは 2026-09-25 の修正より前に")
        print("       取得したもので、通年の情報を持っていない可能性があります")
        print("       （通年が前期行＋後期行に分解されて保存されているため復元できません）。")
        print("       正しい通年情報が必要な場合は scrape.py で取り直してください。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=None, help="指定年度だけ作り直す（省略時は全年度）")
    args = parser.parse_args()

    if args.year is not None:
        out_dir = OUT_DIR / str(args.year) if (OUT_DIR / str(args.year)).exists() else OUT_DIR
        process_year(out_dir, str(args.year))
        return 0

    process_year(OUT_DIR, "(直下・最新年度)")
    for sub in sorted(OUT_DIR.iterdir()):
        if sub.is_dir():
            process_year(sub, sub.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
