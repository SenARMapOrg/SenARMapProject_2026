// APIの入力検証（Cloudflare Pages Functions 側）
import { describe, expect, it } from "vitest";

import {
  isAllowedDomain, isValidEmailFormat, isValidGrade, isValidTerm, isValidVisibility,
  MAX_COURSE_NAME_LEN, MAX_NICKNAME_LEN, normalizeEmail, validateDepartment,
  validateFaculty, validateNickname, validateTimetableEntry,
} from "../functions/api/_lib/validate";

describe("列挙値", () => {
  it("学期", () => {
    expect(isValidTerm("spring")).toBe(true);
    expect(isValidTerm("summer")).toBe(false);
    expect(isValidTerm(1)).toBe(false);
  });

  it("公開範囲", () => {
    for (const v of ["private", "friends", "link", "public"]) expect(isValidVisibility(v)).toBe(true);
    expect(isValidVisibility("everyone")).toBe(false);
  });

  it("学年は1〜8の整数", () => {
    expect(isValidGrade(1)).toBe(true);
    expect(isValidGrade(8)).toBe(true);
    expect(isValidGrade(0)).toBe(false);
    expect(isValidGrade(9)).toBe(false);
    expect(isValidGrade(1.5)).toBe(false);
    expect(isValidGrade("2")).toBe(false);
  });
});

describe("メールアドレス", () => {
  it("前後の空白を落として小文字にそろえる", () => {
    expect(normalizeEmail("  Foo@Senshu-U.JP ")).toBe("foo@senshu-u.jp");
  });

  it("形式を検査する", () => {
    expect(isValidEmailFormat("a@b.jp")).toBe(true);
    expect(isValidEmailFormat("a@b")).toBe(false);
    expect(isValidEmailFormat("a b@c.jp")).toBe(false);
    expect(isValidEmailFormat(`${"a".repeat(250)}@b.jp`)).toBe(false);
  });

  it("許可ドメインは大文字小文字を無視して判定する", () => {
    expect(isAllowedDomain("foo@senshu-u.jp", "senshu-u.jp")).toBe(true);
    expect(isAllowedDomain("FOO@SENSHU-U.JP", "senshu-u.jp")).toBe(true);
    expect(isAllowedDomain("foo@example.com", "senshu-u.jp")).toBe(false);
    // ドメインの部分一致では通さない
    expect(isAllowedDomain("foo@evil-senshu-u.jp.example.com", "senshu-u.jp")).toBe(false);
  });
});

describe("あだ名", () => {
  it("空白のみは未設定(null)として扱う", () => {
    expect(validateNickname("   ")).toEqual({ ok: true, value: null });
    expect(validateNickname(null)).toEqual({ ok: true, value: null });
  });

  it("前後の空白を落とす", () => {
    expect(validateNickname("  たろう ")).toEqual({ ok: true, value: "たろう" });
  });

  it("長すぎる・文字列でないものは弾く", () => {
    expect(validateNickname("あ".repeat(MAX_NICKNAME_LEN + 1)).ok).toBe(false);
    expect(validateNickname(123).ok).toBe(false);
  });
});

describe("学部・学科", () => {
  it("空欄は未設定として扱う", () => {
    expect(validateFaculty("")).toEqual({ ok: true, value: null });
    expect(validateDepartment(null)).toEqual({ ok: true, value: null });
  });

  it("長すぎるものは弾き、項目名をエラーに含める", () => {
    const res = validateFaculty("あ".repeat(51));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("faculty");
  });
});

describe("時間割の1コマ", () => {
  const valid = { day_of_week: 0, period: 1, course_name: "情報システム基礎", location: "10101" };

  it("正しい入力は正規化して通す", () => {
    const res = validateTimetableEntry({ ...valid, course_name: " 情報 ", location: " 10101 " });
    expect(res).toEqual({
      ok: true,
      value: { day_of_week: 0, period: 1, course_name: "情報", location: "10101", instructor: null },
    });
  });

  it("教室の空欄はnullにする", () => {
    const res = validateTimetableEntry({ ...valid, location: "   " });
    expect(res.ok && res.value.location).toBeNull();
  });

  it("曜日の範囲外を弾く", () => {
    expect(validateTimetableEntry({ ...valid, day_of_week: -1 }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, day_of_week: 6 }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, day_of_week: 1.5 }).ok).toBe(false);
  });

  it("時限の範囲外を弾く", () => {
    expect(validateTimetableEntry({ ...valid, period: 0 }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, period: 8 }).ok).toBe(false);
  });

  it("科目名は必須", () => {
    expect(validateTimetableEntry({ ...valid, course_name: "  " }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, course_name: undefined }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, course_name: "あ".repeat(MAX_COURSE_NAME_LEN + 1) }).ok).toBe(false);
  });

  it("教員名は任意だが型と長さは見る", () => {
    expect(validateTimetableEntry({ ...valid, instructor: undefined }).ok).toBe(true);
    expect(validateTimetableEntry({ ...valid, instructor: 1 }).ok).toBe(false);
    expect(validateTimetableEntry({ ...valid, instructor: "あ".repeat(101) }).ok).toBe(false);
  });
});
