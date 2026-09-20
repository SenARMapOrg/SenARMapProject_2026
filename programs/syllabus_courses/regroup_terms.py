#!/usr/bin/env python3
"""既存の courses_raw.jsonl から courses.json を作り直すツール（大学サイトへの再アクセスなし）。

## 直した問題

これまでの scrape.py は、1つの開講行（同じ<tr>＝同じ科目名・担当教員の行）が「前期」「後期」
どちらの時限にも同じ曜日・時限で載っている場合（＝通年科目、または前期/後期が別行で並記されて
いる場合）に、その行の中でだけ前期・後期をペアにするべきところを、それをしていなかった。
scrape.py の parse_rows() は行ごとの前期/後期/通年を単純に "spring"/"fall" の行としてフラットに
出力するだけで、「どの前期行とどの後期行が同じ開講由来か」という情報をその時点で捨てていた。

そのため、それを受け取る timetables アプリ側（course-catalog.ts の groupOfferings()）は
「科目名・担当教員・曜日・時限が完全一致する前期の行と後期の行があれば通年とみなす」という
ヒューリスティックで後から通年判定をするしかなく、**たまたま同じ曜日・時限に前期だけ／後期だけで
別々に開講されている、実際には無関係の2つの科目**まで誤って「通年科目」として1つに統合してしまう
（時間割に追加すると前期・後期の両方に入ってしまう）バグがあった。

## この修正のアプローチ

courses_raw.jsonl は scrape.py の parse_rows() が1つの<tr>を処理し終わるまで、その行から生まれた
行（複数曜日・時限を持つ科目や、通年科目の前期/後期ペアを含む）を連続して書き出す実装になっている
ため、**同じ科目名・担当教員が連続して並んでいる区間は、（ほぼ必ず）同じ元の<tr>由来である**という
性質がある（scrape.py内のコメント・README「出力ファイル」の節にも、生データから
dedupe_and_write_with_departments() を再実行すれば大学サイトへの再アクセスなしにcourses.jsonを
作り直せる、という運用が明記されている）。

この性質を使い、生データを順番通りに読みながら「科目名+担当教員が連続する区間」を1つの元の行と
みなしてグループ化し、**そのグループの中だけ**で同じ曜日・時限に前期・後期の両方が存在する場合に
限って term="both" に統合する（グループをまたいだ、たまたまの一致では統合しない）。

## 使い方

    python regroup_terms.py                       # 全年度分(output/{year}/、および直下)を作り直す
    python regroup_terms.py --year 2026            # 指定年度だけ作り直す（直下の output/ を使う）
    python regroup_terms.py --year 2025            # output/2025/ を使う

出力は各年度の courses.json を直接上書きする（courses_raw.jsonl は読み取り専用、変更しない）。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

OUT_DIR = Path(__file__).parent / "output"


def resolve_both_terms(raw_rows: list[dict]) -> list[dict]:
    """生データ（出力順のまま）を受け取り、同じ元<tr>由来の区間内でだけ前期・後期を
    term="both" に統合した行リストを返す。"""
    # 同じ科目名+担当教員が連続する区間ごとにグループ化する
    groups: list[list[dict]] = []
    cur: list[dict] = []
    cur_key: tuple | None = None
    for r in raw_rows:
        key = (r["course_name"], r.get("instructor"))
        if key != cur_key:
            if cur:
                groups.append(cur)
            cur = [r]
            cur_key = key
        else:
            cur.append(r)
    if cur:
        groups.append(cur)

    resolved: list[dict] = []
    for group in groups:
        # このグループ内で、同じ (day_of_week, period) に前期・後期の両方があるか調べる
        slot_terms: dict[tuple[int, int], set[str]] = {}
        for r in group:
            slot = (r["day_of_week"], r["period"])
            slot_terms.setdefault(slot, set()).add(r["term"])

        both_slots = {slot for slot, terms in slot_terms.items() if {"spring", "fall"} <= terms}
        emitted_both_slots: set[tuple[int, int]] = set()
        for r in group:
            slot = (r["day_of_week"], r["period"])
            if slot in both_slots:
                if slot in emitted_both_slots:
                    continue  # 前期側・後期側の2行が来るはずなので、1回だけ出力する
                emitted_both_slots.add(slot)
                merged = dict(r)
                merged["term"] = "both"
                resolved.append(merged)
            else:
                resolved.append(r)
    return resolved


def rebuild_with_departments(raw_path: Path, final_path: Path) -> tuple[int, int]:
    with raw_path.open(encoding="utf-8") as f:
        raw_rows = [json.loads(line) for line in f if line.strip()]

    resolved_rows = resolve_both_terms(raw_rows)

    groups: dict[tuple, dict] = {}
    for obj in resolved_rows:
        key = (obj["course_name"], obj["day_of_week"], obj["period"], obj["term"], obj["instructor"])
        dept_pair = (obj["faculty"], obj["department"])
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
        groups[key]["_dept_set"].add(dept_pair)

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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=None, help="指定年度だけ作り直す（省略時は全年度）")
    args = parser.parse_args()

    if args.year is not None:
        out_dir = OUT_DIR / str(args.year) if (OUT_DIR / str(args.year)).exists() else OUT_DIR
        process_year(out_dir, str(args.year))
        return 0

    # 直下(最新年度) + サブディレクトリの各年度
    process_year(OUT_DIR, "(直下・最新年度)")
    for sub in sorted(OUT_DIR.iterdir()):
        if sub.is_dir():
            process_year(sub, sub.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
