// 管理画面のアクセス制御（Cloudflare Pages Functions 側）。
// ここが緩むと、大学アカウントのメールアドレスと名前の一覧が第三者に見えてしまう。
import { describe, expect, it } from "vitest";

import {
  ADMIN_SESSION_MAX_AGE_MS, isAdminEmail, isSessionFresh, parseAdminEmails, parseDbTimestamp,
  sanitizeNextPath,
} from "../functions/api/_lib/admin";

describe("管理者の許可リスト", () => {
  it("カンマ区切りを読み、前後の空白と大文字小文字をそろえる", () => {
    expect(parseAdminEmails(" A@Senshu-u.jp , b@senshu-u.jp,")).toEqual(new Set(["a@senshu-u.jp", "b@senshu-u.jp"]));
  });

  it("未設定・空文字・区切りだけなら誰も管理者にならない", () => {
    expect(parseAdminEmails(undefined).size).toBe(0);
    expect(parseAdminEmails("").size).toBe(0);
    expect(parseAdminEmails(" , ,").size).toBe(0);
  });

  it("完全一致でだけ管理者とみなす", () => {
    const admins = parseAdminEmails("admin@senshu-u.jp");
    expect(isAdminEmail("admin@senshu-u.jp", admins)).toBe(true);
    expect(isAdminEmail("ADMIN@senshu-u.jp", admins)).toBe(true);
    expect(isAdminEmail("admin@senshu-u.jp.evil.com", admins)).toBe(false);
    expect(isAdminEmail("xadmin@senshu-u.jp", admins)).toBe(false);
    expect(isAdminEmail("", admins)).toBe(false);
  });

  it("空の許可リストでは空文字のメールも通さない", () => {
    expect(isAdminEmail("", parseAdminEmails(""))).toBe(false);
  });
});

describe("D1 の時刻の読み取り", () => {
  it("datetime('now') 形式は UTC として読む", () => {
    expect(parseDbTimestamp("2026-09-25 03:00:00")?.toISOString()).toBe("2026-09-25T03:00:00.000Z");
  });

  it("ISO 形式もそのまま読む", () => {
    expect(parseDbTimestamp("2026-09-25T03:00:00.000Z")?.toISOString()).toBe("2026-09-25T03:00:00.000Z");
  });

  it("読めない値は null", () => {
    expect(parseDbTimestamp("not a date")).toBeNull();
    expect(parseDbTimestamp(null)).toBeNull();
    expect(parseDbTimestamp("")).toBeNull();
  });
});

describe("管理画面のログインの新しさ", () => {
  const now = new Date("2026-09-25T12:00:00Z");

  it("ログイン直後は新しい", () => {
    expect(isSessionFresh("2026-09-25 11:59:00", now)).toBe(true);
  });

  it("12時間ちょうどまでは新しい", () => {
    const created = new Date(now.getTime() - ADMIN_SESSION_MAX_AGE_MS).toISOString();
    expect(isSessionFresh(created, now)).toBe(true);
  });

  it("12時間を過ぎたら再ログインが必要", () => {
    const created = new Date(now.getTime() - ADMIN_SESSION_MAX_AGE_MS - 1000).toISOString();
    expect(isSessionFresh(created, now)).toBe(false);
  });

  it("作成時刻が未来・不明なら新しくないとみなす", () => {
    expect(isSessionFresh("2026-09-26 00:00:00", now)).toBe(false);
    expect(isSessionFresh(null, now)).toBe(false);
    expect(isSessionFresh("garbage", now)).toBe(false);
  });
});

describe("ログイン後の戻り先", () => {
  it("許可した /admin だけ通す", () => {
    expect(sanitizeNextPath("/admin")).toBe("/admin");
  });

  it.each([
    ["外部サイト", "https://evil.example.com/"],
    ["プロトコル相対URL", "//evil.example.com"],
    ["バックスラッシュを使った抜け道", "/\\evil.example.com"],
    ["許可していないパス", "/api/admin/users"],
    ["許可したパスの後ろに付け足したもの", "/admin/../../evil"],
    ["クエリ付き", "/admin?x=1"],
    ["javascript: スキーム", "javascript:alert(1)"],
    ["空", ""],
  ])("%s は通さない", (_label, next) => {
    expect(sanitizeNextPath(next)).toBeNull();
  });

  it("未指定なら null", () => {
    expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath(null)).toBeNull();
  });
});
