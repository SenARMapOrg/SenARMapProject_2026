// 管理画面用API。/api/admin/* はすべて管理者専用。
//
// 応答の方針:
//   - 未ログイン・管理者でない → 404（管理APIがあること自体を知らせない）
//   - 管理者だがログインから時間が経ちすぎている → 401 {code:"reauth_required"}
//     （この応答が返るのは管理者本人だけなので、存在を知らせても問題ない）
// 閲覧専用で、データを変更するエンドポイントは置かない。

import { Hono, type Context, type Next } from "hono";
import { getCookie } from "hono/cookie";

import { isAdminEmail, isSessionFresh, parseAdminEmails } from "../admin";
import { findValidSession, getAdminSummary, getSessionCreatedAt, listUsersForAdmin } from "../db";
import { SESSION_COOKIE } from "../session";
import type { AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

const NOT_FOUND = { error: "Not Found" } as const;

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

    const adminEmails = parseAdminEmails(c.env.ADMIN_EMAILS);
    if (adminEmails.size === 0) return c.json(NOT_FOUND, 404);

    const sessionId = getCookie(c, SESSION_COOKIE);
    if (!sessionId) return c.json(NOT_FOUND, 404);

    const user = await findValidSession(c.env.DB, sessionId);
    if (!user || !isAdminEmail(user.email, adminEmails)) {
      if (user) {
        // 管理者でないユーザーが管理APIを叩いた記録（誰かが探っている兆候として見られるように）
        console.warn(JSON.stringify({ event: "admin_denied", user_id: user.id, path: c.req.path }));
      }
      return c.json(NOT_FOUND, 404);
    }

    const sessionCreatedAt = await getSessionCreatedAt(c.env.DB, sessionId);
    if (!isSessionFresh(sessionCreatedAt, new Date())) {
      return c.json({ error: "再ログインが必要です", code: "reauth_required" }, 401);
    }

    // 監査ログ（Cloudflare のリアルタイムログに出る）。閲覧した管理者と日時・接続元を残す
    console.log(JSON.stringify({
      event: "admin_access",
      admin_user_id: user.id,
      path: c.req.path,
      ip: c.req.header("CF-Connecting-IP") ?? null,
      at: new Date().toISOString(),
    }));

    c.set("user", user);
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

// 管理者向けの未知のパスも、一般向けと同じ 404 にそろえる
adminRoutes.all("*", (c) => c.json(NOT_FOUND, 404));
