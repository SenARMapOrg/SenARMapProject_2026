import type { Term } from "./types";

export const TERMS: readonly Term[] = ["spring", "fall"]; // spring=前期 fall=後期

export function isValidTerm(value: unknown): value is Term {
  return typeof value === "string" && (TERMS as readonly string[]).includes(value);
}

export const MAX_DAY_OF_WEEK = 5; // 0=月 ... 5=土
export const MAX_PERIOD = 7; // 1〜7限
export const MAX_COURSE_NAME_LEN = 100;
export const MAX_LOCATION_LEN = 100;
export const MAX_TIMETABLE_ENTRIES = (MAX_DAY_OF_WEEK + 1) * MAX_PERIOD; // 全コマ数の上限（重複防止用の上限チェックに使う）

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmailFormat(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export function isAllowedDomain(email: string, domain: string): boolean {
  return email.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}

export interface RawTimetableEntry {
  day_of_week?: unknown;
  period?: unknown;
  course_name?: unknown;
  location?: unknown;
}

export interface ValidatedTimetableEntry {
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
}

/** 1件分の時間割入力を検証する。問題なければ正規化済みの値、なければエラーメッセージを返す */
export function validateTimetableEntry(
  raw: RawTimetableEntry,
): { ok: true; value: ValidatedTimetableEntry } | { ok: false; error: string } {
  const day = raw.day_of_week;
  const period = raw.period;
  const courseName = raw.course_name;
  const location = raw.location;

  if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > MAX_DAY_OF_WEEK) {
    return { ok: false, error: `day_of_week は 0〜${MAX_DAY_OF_WEEK} の整数で指定してください` };
  }
  if (typeof period !== "number" || !Number.isInteger(period) || period < 1 || period > MAX_PERIOD) {
    return { ok: false, error: `period は 1〜${MAX_PERIOD} の整数で指定してください` };
  }
  if (typeof courseName !== "string" || courseName.trim().length === 0) {
    return { ok: false, error: "course_name は空にできません" };
  }
  if (courseName.length > MAX_COURSE_NAME_LEN) {
    return { ok: false, error: `course_name は${MAX_COURSE_NAME_LEN}文字以内で指定してください` };
  }
  if (location !== undefined && location !== null && typeof location !== "string") {
    return { ok: false, error: "location は文字列で指定してください" };
  }
  if (typeof location === "string" && location.length > MAX_LOCATION_LEN) {
    return { ok: false, error: `location は${MAX_LOCATION_LEN}文字以内で指定してください` };
  }

  return {
    ok: true,
    value: {
      day_of_week: day,
      period,
      course_name: courseName.trim(),
      location: typeof location === "string" && location.trim() ? location.trim() : null,
    },
  };
}
