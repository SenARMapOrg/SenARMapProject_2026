// 「科目名から追加」の候補（ほかの学生が登録した授業）。シラバスなどの外部の科目データは使わず、
// 登録済みの行だけから作ること、1人しか登録していない授業（個人の予定かもしれない自由記述）は出さないことを固定する。
import { beforeEach, describe, expect, it } from "vitest";

import { listSharedCourses } from "../functions/api/_lib/db";
import type { SharedCourse } from "../src/api";
import { findOtherTermCourse, searchSharedCourses } from "../src/course-catalog";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

let t: TestD1;

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
  t.exec(`
    INSERT INTO users (id, google_sub, email, display_name) VALUES
      (1, 's1', 'a@senshu-u.jp', 'A'), (2, 's2', 'b@senshu-u.jp', 'B'),
      (3, 's3', 'c@senshu-u.jp', 'C'), (4, 's4', 'd@senshu-u.jp', 'D');
    INSERT INTO timetable_entries (user_id, grade, term, day_of_week, period, course_name, location, instructor) VALUES
      (2, 1, 'spring', 0, 1, '経済学入門', '10101教室', '先生A'),
      (3, 2, 'spring', 0, 1, '経済学入門', '10101教室', '先生A'),  -- 学年が違っても同じ授業
      (4, 1, 'spring', 0, 1, '経済学入門', '10202教室', '先生B'),  -- 別の先生のクラス（1人だけ）
      (2, 1, 'spring', 2, 3, '体育実技',   '体育館',    NULL),
      (3, 1, 'spring', 2, 3, '体育実技',   NULL,        NULL),
      (4, 1, 'spring', 2, 3, '体育実技',   NULL,        NULL),
      (2, 1, 'fall',   4, 5, 'バイト',     NULL,        NULL),     -- 1人だけの予定
      (1, 1, 'spring', 1, 2, '自分の科目', NULL,        NULL),
      (2, 1, 'spring', 1, 2, '自分の科目', NULL,        NULL);
  `);
});

describe("listSharedCourses", () => {
  it("2人以上が登録した授業だけを、登録した人数の多い順に返す（自分の行は数えない）", async () => {
    const got = await listSharedCourses(t.db, 1);
    expect(got).toEqual([
      { term: "spring", day_of_week: 2, period: 3, course_name: "体育実技", instructor: null, user_count: 3 },
      { term: "spring", day_of_week: 0, period: 1, course_name: "経済学入門", instructor: "先生A", user_count: 2 },
    ]);
  });

  it("自分を除いて数えるので、自分ともう1人だけの授業は出ない（その1人の入力がほかの人に見えないように）", async () => {
    const names = (await listSharedCourses(t.db, 2)).map((c) => c.course_name);
    expect(names).toEqual(["体育実技"]); // 経済学入門(先生A)・自分の科目は、2以外では1人だけ
  });
});

const course = (over: Partial<SharedCourse>): SharedCourse => ({
  term: "spring", day_of_week: 0, period: 1, course_name: "経済学入門", instructor: "先生A", user_count: 2, ...over,
});

describe("searchSharedCourses / findOtherTermCourse", () => {
  const courses = [
    course({}),
    course({ term: "fall" }),
    course({ course_name: "Programming演習", day_of_week: 3, period: 2, instructor: null }),
  ];

  it("開いている学期の授業だけを、科目名（大文字・小文字を区別しない）とコマで絞る", () => {
    expect(searchSharedCourses(courses, "programming", "spring", null)).toEqual([courses[2]]);
    expect(searchSharedCourses(courses, "経済", "fall", null)).toEqual([courses[1]]);
    expect(searchSharedCourses(courses, "", "spring", { day: 3, period: 2 })).toEqual([courses[2]]);
  });

  it("同じ授業がもう一方の学期にも登録されていればそれを返す", () => {
    expect(findOtherTermCourse(courses, courses[0])).toBe(courses[1]);
    expect(findOtherTermCourse(courses, courses[2])).toBeUndefined();
  });
});
