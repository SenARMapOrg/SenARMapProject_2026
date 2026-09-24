// 友達関係と友達申請。

import type {
  FriendRequestRow, UserRow,
} from "../types";

export async function areFriends(db: D1Database, userA: number, userB: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM friend_requests
       WHERE status = 'accepted'
         AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       LIMIT 1`,
    )
    .bind(userA, userB, userB, userA)
    .first();
  return row !== null;
}

// 友達に見せる名前は「あだ名(nickname)があればそれ、無ければGoogle由来の本名(display_name)」。
// フロントは従来通り display_name というキーで受け取るだけでよいよう、ここで解決してから返す。

export async function listFriends(
  db: D1Database, userId: number,
): Promise<{ id: number; email: string; display_name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, COALESCE(u.nickname, u.display_name) AS display_name FROM friend_requests fr
       JOIN users u ON u.id = CASE WHEN fr.from_user_id = ? THEN fr.to_user_id ELSE fr.from_user_id END
       WHERE fr.status = 'accepted' AND (fr.from_user_id = ? OR fr.to_user_id = ?)
       ORDER BY display_name`,
    )
    .bind(userId, userId, userId)
    .all<{ id: number; email: string; display_name: string }>();
  return results;
}

export async function listIncomingRequests(db: D1Database, userId: number): Promise<
  (FriendRequestRow & { from_email: string; from_display_name: string })[]
> {
  const { results } = await db
    .prepare(
      `SELECT fr.*, u.email AS from_email, COALESCE(u.nickname, u.display_name) AS from_display_name
       FROM friend_requests fr JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
    )
    .bind(userId)
    .all<FriendRequestRow & { from_email: string; from_display_name: string }>();
  return results;
}

export async function listOutgoingRequests(db: D1Database, userId: number): Promise<FriendRequestRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM friend_requests WHERE from_user_id = ? AND status = 'pending' ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<FriendRequestRow>();
  return results;
}

export async function findPendingRequestBetween(
  db: D1Database, fromUserId: number, toEmail: string,
): Promise<FriendRequestRow | null> {
  return db
    .prepare(
      "SELECT * FROM friend_requests WHERE from_user_id = ? AND to_email = ? AND status = 'pending'",
    )
    .bind(fromUserId, toEmail)
    .first<FriendRequestRow>();
}

export async function findRequestById(db: D1Database, id: number): Promise<FriendRequestRow | null> {
  return db.prepare("SELECT * FROM friend_requests WHERE id = ?").bind(id).first<FriendRequestRow>();
}

export async function countRecentRequestsFrom(
  db: D1Database, fromUserId: number, sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user_id = ? AND created_at > ?")
    .bind(fromUserId, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** ログイン成功時、自分宛てに来ていた「未登録メール宛の招待」を自分のuser_idに解決する */

export async function resolvePendingInvitesForEmail(
  db: D1Database, email: string, userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE friend_requests SET to_user_id = ? WHERE to_email = ? AND to_user_id IS NULL")
    .bind(userId, email)
    .run();
}

export async function acceptRequest(db: D1Database, requestId: number): Promise<void> {
  await db
    .prepare("UPDATE friend_requests SET status = 'accepted', resolved_at = datetime('now') WHERE id = ?")
    .bind(requestId)
    .run();
}

export async function deleteRequestById(db: D1Database, requestId: number): Promise<void> {
  await db.prepare("DELETE FROM friend_requests WHERE id = ?").bind(requestId).run();
}

/** 承諾済みの友達関係を解消する（unfriend）。相互に見られなくなる */

export async function deleteFriendshipBetween(db: D1Database, userA: number, userB: number): Promise<void> {
  await db
    .prepare(
      `DELETE FROM friend_requests
       WHERE status = 'accepted'
         AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    )
    .bind(userA, userB, userB, userA)
    .run();
}

export async function createFriendRequest(
  db: D1Database, fromUserId: number, toEmail: string, toUserId: number | null,
): Promise<FriendRequestRow> {
  const result = await db
    .prepare(
      "INSERT INTO friend_requests (from_user_id, to_email, to_user_id) VALUES (?, ?, ?) RETURNING *",
    )
    .bind(fromUserId, toEmail, toUserId)
    .first<FriendRequestRow>();
  if (!result) throw new Error("友達申請の作成に失敗しました");
  return result;
}

/**
 * アカウント削除: このユーザーに紐づく全データを削除する。
 * D1(SQLite)の外部キーpragmaがどう設定されていてもデータが残らないよう、
 * ON DELETE CASCADEには頼らずここで明示的に全テーブルを削除する。
 */
