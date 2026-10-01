#!/usr/bin/env node
// シラバスの開講科目一覧（programs/syllabus_courses の courses.json）を、時間割共有の画面で読み込む
// 小さな形式に変換する。
//
//   node scripts/compact-courses.mjs <入力: courses.json> <出力: src/data/courses/{年度}.json>
//
// 元のデータは1コマごとに学部・学科の一覧をそのまま持っているため、1年度で約6MBあり、
// スマホでは読み込み（展開・JSONの解析）に時間がかかっていた。学部・学科の組み合わせは1年度で
// 150通り程度しかないので、組み合わせを一度だけ書き、各コマからは番号で参照する。
// 画面で使わない教室（room。シラバスの一覧には載っておらず常に空）は落とす。
//
// 出力の形式（src/course-catalog.ts の decodeCatalog() が元の形に戻す）:
//   {
//     "format": 2,
//     "departments": [["経済学部", "経済学科"], ...],          // 学部・学科
//     "departmentSets": [[0, 3, 5], ...],                      // departments の番号の組み合わせ
//     "courses": [["科目名", "担当教員" | null, "spring" | "fall" | "both", 曜日, 時限, departmentSets の番号], ...]
//   }
// コマの並び・学部学科の並びは元のデータのまま変えない（画面の検索結果の順番が変わらないように）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function compactCourses(entries) {
  const departments = [];
  const departmentIndex = new Map();
  const departmentSets = [];
  const setIndex = new Map();
  const courses = entries.map((e) => {
    const ids = e.departments.map((d) => {
      const key = `${d.faculty}\u0000${d.department}`;
      let id = departmentIndex.get(key);
      if (id === undefined) {
        id = departments.length;
        departments.push([d.faculty, d.department]);
        departmentIndex.set(key, id);
      }
      return id;
    });
    const setKey = ids.join(",");
    let set = setIndex.get(setKey);
    if (set === undefined) {
      set = departmentSets.length;
      departmentSets.push(ids);
      setIndex.set(setKey, set);
    }
    return [e.course_name, e.instructor ?? null, e.term, e.day_of_week, e.period, set];
  });
  return { format: 2, departments, departmentSets, courses };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("使い方: node scripts/compact-courses.mjs <courses.json> <出力先.json>");
    process.exit(1);
  }
  const entries = JSON.parse(readFileSync(input, "utf8"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(compactCourses(entries)));
  console.log(`[compact-courses] ${output}（${entries.length}コマ）`);
}
