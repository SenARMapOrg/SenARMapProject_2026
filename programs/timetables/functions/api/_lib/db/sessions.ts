// ログインセッション（Cookieに入れるセッショントークンの発行と検証）。
//
// DB の sessions.id にはトークンそのものではなく SHA-256 ハッシュを保存する（hashSessionToken）。
// 呼び出し側は常に Cookie に入っている生のトークンを渡せばよく、ハッシュ化はここで行う。

import type { UserRow } from "../types";
import { hashSessionToken, randomToken } from "./token";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

export interface NewSession {
  token: string;      // Cookie に入れる生のトークン（DB には保存しない）
  expiresAt: string;  // ISO 8601
}

export async function createSession(db: D1Database, userId: number): Promise<NewSession> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await hashSessionToken(token), userId, expiresAt)
    .run();
  return { token, expiresAt };
}

/**
 * 有効期限内のセッションに対応するユーザーを返す。
 * expires_at は ISO 8601（"2026-10-25T03:00:00.000Z"）で保存しているのに対し、datetime('now') は
 * "2026-10-25 03:00:00" 形式なので、文字列のまま比べると期限当日は日付の後ろの 'T' と ' ' の比較になり
 * 期限切れ後も最大1日有効なままになる。datetime() で同じ形式にそろえてから比べる。
 */
export async function findValidSession(db: D1Database, token: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND datetime(s.expires_at) > datetime('now')`,
    )
    .bind(await hashSessionToken(token))
    .first<UserRow>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await hashSessionToken(token)).run();
}

/** セッションが作られた時刻（管理画面の「ログインから12時間以内」の判定に使う） */
export async function getSessionCreatedAt(db: D1Database, token: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT created_at FROM sessions WHERE id = ?")
    .bind(await hashSessionToken(token))
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}
