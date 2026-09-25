// 「このリクエストは管理者からのものか」の判定と、閲覧記録の書き込み。
// 管理API（routes/admin.ts）と、管理画面のページ本体（functions/admin.ts）の両方から使う。

import { isAdminEmail, isSessionFresh, parseAdminEmails } from "./admin";
import { findValidSession, getSessionCreatedAt, insertAuditLog, type AuditEvent } from "./db";
import type { UserRow } from "./types";

export type AdminAccess =
  | { kind: "anonymous" }                              // 未ログイン・セッションが無効
  | { kind: "not_admin"; user: UserRow }               // ログインしているが管理者ではない（ADMIN_EMAILS 未設定も含む）
  | { kind: "admin"; user: UserRow; fresh: boolean };  // 管理者。fresh=false ならログインから時間が経ちすぎている

export async function resolveAdminAccess(
  db: D1Database, adminEmailsRaw: string | undefined, sessionId: string | null,
): Promise<AdminAccess> {
  if (!sessionId) return { kind: "anonymous" };
  const user = await findValidSession(db, sessionId);
  if (!user) return { kind: "anonymous" };

  const adminEmails = parseAdminEmails(adminEmailsRaw);
  if (!isAdminEmail(user.email, adminEmails)) return { kind: "not_admin", user };

  const createdAt = await getSessionCreatedAt(db, sessionId);
  return { kind: "admin", user, fresh: isSessionFresh(createdAt, new Date()) };
}

export interface RequestMeta {
  path: string;
  ip: string | null;
  user_agent: string | null;
}

export function requestMeta(request: Request): RequestMeta {
  return {
    path: new URL(request.url).pathname,
    ip: request.headers.get("CF-Connecting-IP"),
    user_agent: request.headers.get("User-Agent"),
  };
}

/**
 * 閲覧記録を D1 に書く。書けなかった場合は例外をそのまま投げる
 * （一覧を見せる前に呼び、記録できないなら見せない、という使い方をするため）。
 */
export async function recordAudit(
  db: D1Database, event: AuditEvent, user: UserRow | null, meta: RequestMeta,
): Promise<void> {
  await insertAuditLog(db, {
    event,
    user_id: user?.id ?? null,
    email: user?.email ?? null,
    ...meta,
  });
}

/**
 * 拒否の記録。拒否そのものは記録の成否に関係なく必ず行うので、書けなくても例外にしない
 * （マイグレーション適用前などでテーブルが無くても、管理者以外を締め出す動作は変わらない）。
 */
export async function recordDenial(
  db: D1Database, event: AuditEvent, user: UserRow, meta: RequestMeta,
): Promise<void> {
  try {
    await recordAudit(db, event, user, meta);
  } catch (err) {
    console.error(JSON.stringify({ event: "audit_write_failed", denied_event: event, user_id: user.id, error: String(err) }));
  }
}
