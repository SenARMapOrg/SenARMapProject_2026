// 管理画面用API。/api/admin/* はすべて管理者専用。
//
// 応答の方針:
//   - 未ログイン・管理者でない → 404（管理APIがあること自体を知らせない）
//   - 管理者だがログインから時間が経ちすぎている → 401 {code:"reauth_required"}
//     （この応答が返るのは管理者本人だけなので、存在を知らせても問題ない）
//   - 閲覧記録（admin_audit_log）を書けなかった → 503。記録を残せない状態では一覧を見せない
// 閲覧専用で、データを変更するエンドポイントは置かない。

import { Hono, type Context, type Next } from "hono";
import { getCookie } from "hono/cookie";

import { recordAudit, recordDenial, requestMeta, resolveAdminAccess } from "../admin-access";
import { getAdminSummary, listRecentAuditLog, listUsersForAdmin } from "../db";
import { SESSION_COOKIE } from "../session";
import type { AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

const NOT_FOUND = { error: "Not Found" } as const;

/** 管理画面に表示する閲覧記録の件数 */
const AUDIT_LOG_LIMIT = 100;

/** 管理APIの応答に必ず付けるヘッダ（個人情報を含むのでキャッシュ・インデックス・埋め込みを禁止） */
function setAdminResponseHeaders(c: Context<AppEnv>): void {
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
}

function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next) => {
    setAdminResponseHeaders(c);

    const access = await resolveAdminAccess(c.env.DB, c.env.ADMIN_EMAILS, getCookie(c, SESSION_COOKIE) ?? null);
    const meta = requestMeta(c.req.raw);

    if (access.kind === "anonymous") return c.json(NOT_FOUND, 404);
    if (access.kind === "not_admin") {
      await recordDenial(c.env.DB, "admin_denied", access.user, meta);
      return c.json(NOT_FOUND, 404);
    }
    if (!access.fresh) {
      return c.json({ error: "再ログインが必要です", code: "reauth_required" }, 401);
    }

    // 記録を残せないなら見せない（記録が欠けた閲覧を作らない）
    try {
      await recordAudit(c.env.DB, "admin_access", access.user, meta);
    } catch (err) {
      console.error(JSON.stringify({ event: "audit_write_failed", admin_user_id: access.user.id, error: String(err) }));
      return c.json({ error: "閲覧記録を保存できないため表示できません。管理者に連絡してください。" }, 503);
    }

    c.set("user", access.user);
    await next();
  };
}

adminRoutes.use("*", requireAdmin());

adminRoutes.get("/users", async (c) => {
  const [summary, users] = await Promise.all([
    getAdminSummary(c.env.DB),
    listUsersForAdmin(c.env.DB),
  ]);
  return c.json({ summary, users });
});

adminRoutes.get("/audit-log", async (c) => {
  return c.json({ entries: await listRecentAuditLog(c.env.DB, AUDIT_LOG_LIMIT) });
});

// 管理者向けの未知のパスも、一般向けと同じ 404 にそろえる
adminRoutes.all("*", (c) => c.json(NOT_FOUND, 404));
