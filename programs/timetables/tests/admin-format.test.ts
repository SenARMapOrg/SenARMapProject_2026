// 管理画面の表示用の整形処理
import { describe, expect, it } from "vitest";

import { formatDbTime, matchesFilter, type AdminUser } from "../src/admin-format";

const user: AdminUser = {
  id: 1, email: "taro@senshu-u.jp", display_name: "専修 太郎", nickname: "たろう",
  faculty: "経済学部", department: "現代経済学科", current_grade: 2,
  created_at: "2026-09-01 00:00:00", last_login_at: null, entry_count: 3, grade_count: 1,
};

describe("formatDbTime", () => {
  it("UTC の時刻を日本時間で表示する", () => {
    expect(formatDbTime("2026-09-25 03:00:00")).toBe("2026/09/25 12:00");
  });

  it("値が無ければダッシュ", () => {
    expect(formatDbTime(null)).toBe("—");
  });
});

describe("matchesFilter", () => {
  it.each([["taro@"], ["太郎"], ["たろう"], ["経済学部"], ["現代経済"], ["TARO"]])("%s で見つかる", (q) => {
    expect(matchesFilter(user, q)).toBe(true);
  });

  it("どれにも含まれなければ出さない", () => {
    expect(matchesFilter(user, "心理学")).toBe(false);
  });

  it("空の検索は全員出す", () => {
    expect(matchesFilter(user, "  ")).toBe(true);
  });

  it("あだ名・学部が未設定でも落ちない", () => {
    expect(matchesFilter({ ...user, nickname: null, faculty: null, department: null }, "x")).toBe(false);
  });
});
