// 科目データ（src/data/courses/{年度}.json）が、シラバスの元データ（programs/syllabus_courses/output）を
// 欠けなく小さな形式にしたものになっているか。変換の取りこぼしや、シラバスを取り直したのに
// sync-courses を実行し忘れた状態を検出する。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error 型定義の無い .mjs（ビルド用スクリプト）を直接テストする
import { compactCourses } from "../scripts/compact-courses.mjs";
import {
  AVAILABLE_COURSE_YEARS, decodeCatalog, type CompactCatalog, type CourseCatalogEntry,
} from "../src/course-catalog";

const SYLLABUS_OUTPUT = resolve(__dirname, "../../syllabus_courses/output");
const DATA_DIR = resolve(__dirname, "../src/data/courses");
const CURRENT_YEAR = 2026; // output/courses.json（年度別フォルダに入っていない分）の年度。sync-courses.sh と同じ

interface RawEntry extends CourseCatalogEntry { room?: string | null }

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function rawFor(year: number): RawEntry[] {
  return readJson(year === CURRENT_YEAR
    ? `${SYLLABUS_OUTPUT}/courses.json`
    : `${SYLLABUS_OUTPUT}/${year}/courses.json`);
}

/** 画面で使う項目だけにする（教室は元データでも常に空で、画面でも使わないので変換時に落としている） */
function withoutRoom(entries: RawEntry[]): CourseCatalogEntry[] {
  return entries.map(({ room: _room, ...rest }) => rest);
}

describe("科目データ", () => {
  it("2020〜2026年度が選べる（新しい年度が先）", () => {
    expect(AVAILABLE_COURSE_YEARS).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020]);
  });

  it.each([2020, 2021, 2022, 2023, 2024, 2025, 2026])("%i年度: 元に戻すとシラバスの元データと一致する", (year) => {
    const compact = readJson<CompactCatalog>(`${DATA_DIR}/${year}.json`);
    expect(compact.format).toBe(2);
    expect(decodeCatalog(compact)).toEqual(withoutRoom(rawFor(year)));
  });

  it("変換→復元で、学部・学科の並び・担当教員なし・通年がそのまま残る", () => {
    const raw: RawEntry[] = [
      {
        course_name: "卒業研究", day_of_week: 5, period: 3, term: "both", instructor: null, room: null,
        departments: [{ faculty: "経済学部", department: "経済学科" }, { faculty: "商学部", department: "会計学科" }],
      },
      {
        course_name: "英語", day_of_week: 0, period: 1, term: "spring", instructor: "先生A", room: null,
        departments: [{ faculty: "商学部", department: "会計学科" }, { faculty: "経済学部", department: "経済学科" }],
      },
      {
        course_name: "英語", day_of_week: 0, period: 1, term: "fall", instructor: "先生A", room: null,
        departments: [{ faculty: "経済学部", department: "経済学科" }, { faculty: "商学部", department: "会計学科" }],
      },
    ];
    const compact = compactCourses(raw) as CompactCatalog;
    expect(compact.departments).toHaveLength(2);
    expect(compact.departmentSets).toHaveLength(2); // 並びが違う組み合わせは別物として持つ
    expect(decodeCatalog(compact)).toEqual(withoutRoom(raw));
  });
});
