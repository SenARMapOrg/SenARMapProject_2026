// 管理画面用API。/api/admin/* はすべて管理者専用。
//
// 応答の方針（timetablesのadmin APIと同じ):
//   - 未ログイン・管理者でない → 404（管理APIがあること自体を知らせない）
//   - 管理者だがログインから時間が経ちすぎている → 401 {code:"reauth_required"}
//     （この応答が返るのは管理者本人だけなので、存在を知らせても問題ない）
//   - 閲覧記録（admin_audit_log）を書けなかった → 503。記録を残せない状態では一覧を見せない
//   - 自サイトのページ以外からのリクエスト（Sec-Fetch-Site が same-origin 以外）→ 404

import { Hono, type Context, type Next } from "hono";

import { ADMIN_SECURITY_HEADERS, isSameOriginRequest } from "../admin";
import { recordAudit, recordDenial, requestMeta, resolveAdminAccess } from "../admin-access";
import {
  createGuide, deleteGuide, findGuideById, listGuidesWithCounts, listRecentAuditLog,
  listSearchesForGuide, resetGuideRecords,
} from "../db";
import { readSessionToken } from "../session";
import type { AppEnv } from "../types";

export const adminRoutes = new Hono<AppEnv>();

const NOT_FOUND = { error: "Not Found" } as const;

/** 管理画面に表示する閲覧記録・検索ログの件数 */
const AUDIT_LOG_LIMIT = 100;
const GUIDE_SEARCHES_LIMIT = 200;
const MAX_DISPLAY_NAME_LENGTH = 50;

function setAdminResponseHeaders(c: Context<AppEnv>): void {
  for (const [name, value] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(name, value);
}

function requireAdmin() {
  return async (c: Context<AppEnv>, next: Next) => {
    setAdminResponseHeaders(c);

    // 別サイトから管理者のブラウザ経由で叩かせるリクエストは、判定より前に門前払いする
    if (!isSameOriginRequest(c.req.header("Sec-Fetch-Site"))) return c.json(NOT_FOUND, 404);

    const access = await resolveAdminAccess(c.env.DB, c.env.ADMIN_EMAILS, readSessionToken(c) ?? null);
    const meta = requestMeta(c.req.raw);

    if (access.kind === "anonymous") return c.json(NOT_FOUND, 404);
    if (access.kind === "not_admin") {
      await recordDenial(c.env.DB, "admin_denied", access.email, meta);
      return c.json(NOT_FOUND, 404);
    }
    if (!access.fresh) {
      return c.json({ error: "再ログインが必要です", code: "reauth_required" }, 401);
    }

    // 記録を残せないなら見せない（記録が欠けた閲覧を作らない）
    try {
      await recordAudit(c.env.DB, "admin_access", access.email, meta);
    } catch (err) {
      console.error(JSON.stringify({ event: "audit_write_failed", admin_email: access.email, error: String(err) }));
      return c.json({ error: "閲覧記録を保存できないため表示できません。管理者に連絡してください。" }, 503);
    }

    c.set("adminEmail", access.email);
    await next();
  };
}

adminRoutes.use("*", requireAdmin());

adminRoutes.get("/guides", async (c) => {
  return c.json({
    guides: await listGuidesWithCounts(c.env.DB),
    navi_base_url: c.env.NAVI_BASE_URL,
    admin_email: c.get("adminEmail"),
  });
});

adminRoutes.post("/guides", async (c) => {
  const body = await c.req.json().catch(() => null) as { display_name?: unknown } | null;
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return c.json({ error: "名前を入力してください（50文字以内）" }, 400);
  }
  const guide = await createGuide(c.env.DB, displayName);
  return c.json({ guide }, 201);
});

/**
 * パスの :id に対応する案内係。IDが数値でない・存在しない場合は null
 * （数値以外をそのままD1に渡さないよう、ここで弾く）。
 */
async function findGuideFromPath(c: Context<AppEnv>, idParam: string | undefined) {
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) return null;
  return findGuideById(c.env.DB, id);
}

adminRoutes.delete("/guides/:id", async (c) => {
  const guide = await findGuideFromPath(c, c.req.param("id"));
  if (!guide) return c.json(NOT_FOUND, 404);
  await deleteGuide(c.env.DB, guide.id, guide.ref_code);
  return c.body(null, 204);
});

adminRoutes.post("/guides/:id/reset", async (c) => {
  const guide = await findGuideFromPath(c, c.req.param("id"));
  if (!guide) return c.json(NOT_FOUND, 404);
  await resetGuideRecords(c.env.DB, guide.ref_code);
  return c.body(null, 204);
});

adminRoutes.get("/guides/:id/searches", async (c) => {
  const guide = await findGuideFromPath(c, c.req.param("id"));
  if (!guide) return c.json(NOT_FOUND, 404);
  return c.json({ searches: await listSearchesForGuide(c.env.DB, guide.ref_code, GUIDE_SEARCHES_LIMIT) });
});

adminRoutes.get("/audit-log", async (c) => {
  return c.json({ entries: await listRecentAuditLog(c.env.DB, AUDIT_LOG_LIMIT) });
});

// 管理者向けの未知のパスも、一般向けと同じ 404 にそろえる
adminRoutes.all("*", (c) => c.json(NOT_FOUND, 404));
