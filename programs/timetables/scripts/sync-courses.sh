#!/bin/sh
# programs/syllabus_courses/output/ 配下のシラバスデータを programs/timetables/public/ へコピーする。
#
# なぜコピーが要るのか: Cloudflare Pagesはモノレポの中で「Root directory」に指定した
# ディレクトリ配下しかビルド時に見ないため、programs/timetables から programs/syllabus_courses を
# 直接参照することはできない（symlinkもRoot directory外を指すと同様に解決できない）。
# そのため public/ にコピーを置き、Viteがdist/直下にそのまま出力する。
#
# コピーするもの:
#   - 年度別の開講科目一覧（過去の学年の時間割を登録する際、その年度のシラバスから
#     「科目名から追加」できるようにするため。src/course-catalog.ts が /courses/{年度}.json
#     としてfetchする）:
#       programs/syllabus_courses/output/courses.json        -> public/courses/{当年度}.json
#       programs/syllabus_courses/output/{年度}/courses.json -> public/courses/{年度}.json
#   - 学部/学科一覧（プロフィール設定・「みんなの時間割を探す」の絞り込みセレクトのデータソース。
#     年度に依存しない共通データなので1つだけコピーする）:
#       programs/syllabus_courses/departments.json -> public/departments.json
#
# シラバスを再スクレイピングした後は、このスクリプトを実行してコピーを更新し、
# 差分を通常通りコミットすること（自動化はしていない。scrape.py 自体は大学サイトへの
# アクセスを伴うため、意図せず自動実行されないようにあえて手動運用にしている）。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYLLABUS_DIR="$SCRIPT_DIR/../../syllabus_courses"
OUTPUT_DIR="$SYLLABUS_DIR/output"
DEST_COURSES_DIR="$SCRIPT_DIR/../public/courses"
CURRENT_YEAR_FALLBACK=2026  # output/courses.json（年度別サブディレクトリに入っていない分）の年度

mkdir -p "$DEST_COURSES_DIR"

if [ ! -f "$OUTPUT_DIR/courses.json" ]; then
  echo "ERROR: $OUTPUT_DIR/courses.json が見つかりません。先に programs/syllabus_courses で scrape.py --by-dept を実行してください。" >&2
  exit 1
fi
cp "$OUTPUT_DIR/courses.json" "$DEST_COURSES_DIR/$CURRENT_YEAR_FALLBACK.json"
echo "[sync-courses] $DEST_COURSES_DIR/$CURRENT_YEAR_FALLBACK.json を更新しました"

for dir in "$OUTPUT_DIR"/*/; do
  year="$(basename "$dir")"
  case "$year" in
    ''|*[!0-9]*) continue ;;  # 数字4桁の年度ディレクトリ以外(念のため)はスキップ
  esac
  if [ -f "$dir/courses.json" ]; then
    cp "$dir/courses.json" "$DEST_COURSES_DIR/$year.json"
    echo "[sync-courses] $DEST_COURSES_DIR/$year.json を更新しました"
  fi
done

if [ ! -f "$SYLLABUS_DIR/departments.json" ]; then
  echo "ERROR: $SYLLABUS_DIR/departments.json が見つかりません。" >&2
  exit 1
fi
cp "$SYLLABUS_DIR/departments.json" "$SCRIPT_DIR/../public/departments.json"
echo "[sync-courses] $SCRIPT_DIR/../public/departments.json を更新しました"
