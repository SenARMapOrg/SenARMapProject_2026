#!/bin/sh
# programs/syllabus_courses/output/courses.json を programs/timetables/public/courses.json へコピーする。
#
# なぜコピーが要るのか: Cloudflare Pagesはモノレポの中で「Root directory」に指定した
# ディレクトリ配下しかビルド時に見ないため、programs/timetables から programs/syllabus_courses を
# 直接参照することはできない（symlinkもRoot directory外を指すと同様に解決できない）。
# そのため courses.json は public/ にコピーを置き、Viteがdist/直下にそのまま出力する
# （src/course-catalog.ts が実行時に /courses.json としてfetchする）。
#
# シラバスを再スクレイピングした後は、このスクリプトを実行してコピーを更新し、
# 差分を通常通りコミットすること（自動化はしていない。scrape.py 自体は大学サイトへの
# アクセスを伴うため、意図せず自動実行されないようにあえて手動運用にしている）。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/../../syllabus_courses/output/courses.json"
DEST="$SCRIPT_DIR/../public/courses.json"

if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC が見つかりません。先に programs/syllabus_courses で scrape.py --by-dept を実行してください。" >&2
  exit 1
fi

cp "$SRC" "$DEST"
echo "[sync-courses] $DEST を更新しました ($(wc -c < "$DEST") bytes)"
