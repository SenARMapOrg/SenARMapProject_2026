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

export async function findValidSession(db: D1Database, sessionId: string): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(sessionId)
    .first<UserRow>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}
