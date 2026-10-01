// 教室の自動入力候補（findCommonLocationForCourse）が、索引（migrations/0010）を使って
// 同じ授業の行だけを読むこと。D1 は読んだ行数で課金・無料枠の上限が決まるので、
// 全件を読む問い合わせに戻ると、登録者が増えたときに費用が急に増えたり無料枠で止まったりする。
import { beforeEach, describe, expect, it } from "vitest";

import { findCommonLocationForCourse } from "../functions/api/_lib/db";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

let t: TestD1;
/** findCommonLocationForCourse が実際に投げた SQL と値（実行計画を調べるため） */
let captured: { sql: string; params: unknown[] }[];

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
  t.exec(`
    INSERT INTO users (id, google_sub, email, display_name) VALUES
      (1, 's1', 'a@senshu-u.jp', 'A'), (2, 's2', 'b@senshu-u.jp', 'B'),
      (3, 's3', 'c@senshu-u.jp', 'C'), (4, 's4', 'd@senshu-u.jp', 'D');
    INSERT INTO timetable_entries (user_id, grade, term, day_of_week, period, course_name, location, instructor) VALUES
      (2, 1, 'spring', 0, 1, '経済学入門', '10101教室', '先生A'),
      (3, 1, 'spring', 0, 1, '経済学入門', '10101教室', '先生A'),
      (4, 1, 'spring', 0, 1, '経済学入門', '10202教室', '先生B'),  -- 別の先生のクラス
      (2, 1, 'spring', 2, 3, '体育実技',   '体育館',    NULL),     -- 担当教員なし（手入力）
      (3, 1, 'fall',   0, 1, '経済学入門', '10303教室', '先生A');  -- 後期
  `);
  captured = [];
  const prepare = t.db.prepare.bind(t.db);
  t.db.prepare = ((sql: string) => {
    const stmt = prepare(sql);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...params: unknown[]) => { captured.push({ sql, params }); return bind(...params); };
    return stmt;
  }) as typeof t.db.prepare;
});

const base = { term: "spring" as const, dayOfWeek: 0, period: 1, courseName: "経済学入門", excludeUserId: 1 };

describe("findCommonLocationForCourse", () => {
  it("同じ学期・曜日・時限・科目名・担当教員の、他の学生の教室を返す", async () => {
    expect(await findCommonLocationForCourse(t.db, { ...base, instructor: "先生A" })).toBe("10101教室");
    expect(await findCommonLocationForCourse(t.db, { ...base, instructor: "先生B" })).toBe("10202教室");
    expect(await findCommonLocationForCourse(t.db, { ...base, term: "fall", instructor: "先生A" })).toBe("10303教室");
    expect(await findCommonLocationForCourse(t.db, {
      term: "spring", dayOfWeek: 2, period: 3, courseName: "体育実技", instructor: null, excludeUserId: 1,
    })).toBe("体育館");
    expect(await findCommonLocationForCourse(t.db, { ...base, instructor: "先生A", excludeUserId: 2 })).toBe("10101教室");
    expect(await findCommonLocationForCourse(t.db, { ...base, courseName: "存在しない科目", instructor: null })).toBeNull();
  });

  it.each([
    ["担当教員あり", "先生A"],
    ["担当教員なし（NULL）", null],
  ])("%s: 表を全件読まず、索引で同じ授業の行だけを読む", async (_label, instructor) => {
    await findCommonLocationForCourse(t.db, { ...base, instructor });
    const { sql, params } = captured.at(-1)!;
    const plan = t.query(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => String(r.detail));
    expect(plan.some((d) => d.includes("USING INDEX idx_entries_course_slot"))).toBe(true);
    expect(plan.some((d) => /^SCAN timetable_entries\b/.test(d))).toBe(false);
  });
});
