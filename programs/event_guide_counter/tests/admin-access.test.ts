// 「このリクエストは管理者からのものか」の判定（resolveAdminAccess）。
import { beforeEach, describe, expect, it } from "vitest";

import { resolveAdminAccess } from "../functions/api/_lib/admin-access";
import { createSession, insertAuditLog, listRecentAuditLog } from "../functions/api/_lib/db";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

let t: TestD1;

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
});

describe("resolveAdminAccess", () => {
  it("未ログイン(Cookie無し)はanonymous", async () => {
    expect(await resolveAdminAccess(t.db, "admin@example.jp", null)).toEqual({ kind: "anonymous" });
  });

  it("無効なトークンもanonymous", async () => {
    expect(await resolveAdminAccess(t.db, "admin@example.jp", "no-such-token")).toEqual({ kind: "anonymous" });
  });

  it("ログイン済みだがADMIN_EMAILSに無ければnot_admin", async () => {
    const { token } = await createSession(t.db, "guest@example.jp");
    expect(await resolveAdminAccess(t.db, "admin@example.jp", token))
      .toEqual({ kind: "not_admin", email: "guest@example.jp" });
  });

  it("ADMIN_EMAILS未設定なら誰もadminにならない", async () => {
    const { token } = await createSession(t.db, "admin@example.jp");
    expect(await resolveAdminAccess(t.db, undefined, token))
      .toEqual({ kind: "not_admin", email: "admin@example.jp" });
  });

  it("ADMIN_EMAILSにあればadmin。ログイン直後はfresh:true", async () => {
    const { token } = await createSession(t.db, "admin@example.jp");
    expect(await resolveAdminAccess(t.db, "admin@example.jp", token))
      .toEqual({ kind: "admin", email: "admin@example.jp", fresh: true });
  });

  it("ログインから時間が経つとfresh:false", async () => {
    const { token } = await createSession(t.db, "admin@example.jp");
    t.exec("UPDATE sessions SET created_at = datetime('now', '-13 hours')");
    expect(await resolveAdminAccess(t.db, "admin@example.jp", token))
      .toMatchObject({ kind: "admin", fresh: false });
  });

  it("ログイン後にADMIN_EMAILSから外れると、既存セッションもnot_adminになる", async () => {
    const { token } = await createSession(t.db, "admin@example.jp");
    expect(await resolveAdminAccess(t.db, "admin@example.jp", token)).toMatchObject({ kind: "admin" });
    expect(await resolveAdminAccess(t.db, "other@example.jp", token))
      .toEqual({ kind: "not_admin", email: "admin@example.jp" });
  });
});

describe("閲覧記録", () => {
  it("書き込んだ記録が新しい順で読める", async () => {
    await insertAuditLog(t.db, { event: "admin_access", email: "admin@example.jp", path: "/api/admin/guides", ip: "203.0.113.1", user_agent: "UA" });
    await insertAuditLog(t.db, { event: "admin_denied", email: "guest@example.jp", path: "/admin", ip: "203.0.113.2", user_agent: "UA" });
    const entries = await listRecentAuditLog(t.db, 10);
    expect(entries.map((e) => e.event)).toEqual(["admin_denied", "admin_access"]);
  });
});
