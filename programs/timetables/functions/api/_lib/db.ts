import type {
  FriendRequestRow, SessionRow, Term, TimetableEntryRow, UserRow,
} from "./types";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function findUserBySub(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").bind(sub).first<UserRow>();
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
}

export async function findUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/**
 * Googleログイン成功時にユーザーをupsertする。
 * google_sub をキーにする（emailはGoogle Workspace側の設定変更で理論上変わり得るため、
 * 不変な sub を主キーとして扱い、email/display_nameは毎回最新の値で上書きする）。
 */
export async function upsertUser(
  db: D1Database, sub: string, email: string, displayName: string,
): Promise<UserRow> {
  const existing = await findUserBySub(db, sub);
  if (existing) {
    await db
      .prepare("UPDATE users SET email = ?, display_name = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(email, displayName, existing.id)
      .run();
    return { ...existing, email, display_name: displayName };
  }
  const result = await db
    .prepare("INSERT INTO users (google_sub, email, display_name) VALUES (?, ?, ?) RETURNING *")
    .bind(sub, email, displayName)
    .first<UserRow>();
  if (!result) throw new Error("ユーザー作成に失敗しました");
  return result;
}

/** あだ名を設定・解除する。null(または空)で解除し、以後は display_name(Googleの本名)が表示される */
export async function updateNickname(db: D1Database, userId: number, nickname: string | null): Promise<UserRow> {
  const result = await db
    .prepare("UPDATE users SET nickname = ?, updated_at = datetime('now') WHERE id = ? RETURNING *")
    .bind(nickname, userId)
    .first<UserRow>();
  if (!result) throw new Error("あだ名の更新に失敗しました");
  return result;
}

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

export async function listTimetable(db: D1Database, userId: number, term: Term): Promise<TimetableEntryRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM timetable_entries WHERE user_id = ? AND term = ? ORDER BY day_of_week, period")
    .bind(userId, term)
    .all<TimetableEntryRow>();
  return results;
}

export interface TimetableEntryInput {
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
}

/**
 * ユーザーの指定学期(term)の時間割を丸ごと入れ替える（部分編集ではなく全件置き換え。
 * フロントは常にその学期の全件を送る）。他学期の行には触れない。
 */
export async function replaceTimetable(
  db: D1Database, userId: number, term: Term, entries: TimetableEntryInput[],
): Promise<void> {
  const stmts = [
    db.prepare("DELETE FROM timetable_entries WHERE user_id = ? AND term = ?").bind(userId, term),
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO timetable_entries (user_id, term, day_of_week, period, course_name, location)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, term, e.day_of_week, e.period, e.course_name, e.location),
    ),
  ];
  await db.batch(stmts);
}

/** 2人のユーザーが承諾済みの友達関係にあるかどうか */
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
export async function deleteUserCascade(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM timetable_entries WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?").bind(userId, userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
