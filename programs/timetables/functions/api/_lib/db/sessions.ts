// ログインセッション（Cookieに入れるセッションIDの発行と検証）。

import type {
  SessionRow, UserRow,
} from "../types";
import { randomToken } from "./token";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

export async function createSession(db: D1Database, userId: number): Promise<SessionRow> {
  const id = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expiresAt)
    .run();
  return { id, user_id: userId, created_at: new Date().toISOString(), expires_at: expiresAt };
}

/**
 * 有効期限内のセッションに対応するユーザーを返す。
 * expires_at は ISO 8601（"2026-10-25T03:00:00.000Z"）で保存しているのに対し、datetime('now') は
 * "2026-10-25 03:00:00" 形式なので、文字列のまま比べると期限当日は日付の後ろの 'T' と ' ' の比較になり
 * 期限切れ後も最大1日有効なままになる。datetime() で同じ形式にそろえてから比べる。
 */
export async function findValidSession(db: D1Database, sessionId: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')`,
    )
    .bind(sessionId)
    .first<UserRow>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}
