// ユーザー（プロフィール・あだ名・学部学科）と、退会時の一括削除。

import type {
  Term, UserRow,
} from "../types";

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

/** 「科目名から追加」時に他の学生の教室を自動入力するかどうかの設定を切り替える */

export async function updateAutoFillLocation(db: D1Database, userId: number, enabled: boolean): Promise<UserRow> {
  const result = await db
    .prepare("UPDATE users SET auto_fill_location = ?, updated_at = datetime('now') WHERE id = ? RETURNING *")
    .bind(enabled ? 1 : 0, userId)
    .first<UserRow>();
  if (!result) throw new Error("設定の更新に失敗しました");
  return result;
}

/**
 * プロフィール(学部・学科・現在の学年)を部分更新する。渡されたキーだけを更新する。
 * faculty/department は "みんなの時間割を探す" の絞り込みに、current_grade はナビ機能
 * （今日・次の授業表示）がどの学年のスナップショットを見るかに使う。
 */

export async function updateProfile(
  db: D1Database, userId: number,
  patch: { faculty?: string | null; department?: string | null; currentGrade?: number },
): Promise<UserRow> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(patch, "faculty")) {
    sets.push("faculty = ?");
    values.push(patch.faculty ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "department")) {
    sets.push("department = ?");
    values.push(patch.department ?? null);
  }
  if (patch.currentGrade !== undefined) {
    sets.push("current_grade = ?");
    values.push(patch.currentGrade);
  }
  if (sets.length === 0) {
    const existing = await findUserById(db, userId);
    if (!existing) throw new Error("ユーザーが見つかりません");
    return existing;
  }
  sets.push("updated_at = datetime('now')");
  const result = await db
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...values, userId)
    .first<UserRow>();
  if (!result) throw new Error("プロフィールの更新に失敗しました");
  return result;
}

/**
 * 同じ学期・曜日・時限・科目名・担当教員の授業について、自分以外の学生が登録した教室のうち
 * もっとも多く使われているものを返す（「科目名から追加」の自動入力候補に使う）。
 * 個人を特定できる情報は返さず、教室名そのものだけを返す。
 *
 * instructorも一致条件に含める: 同じ科目名でも担当教員が違えば別クラス(別教室であることが多い)
 * なので、instructorで絞らないと別クラスの教室が混ざって提案されてしまう
 * （"IS ?" を使うのはSQLiteの"="はNULL同士を一致とみなさないため。instructorがNULL同士
 * 　＝どちらもシラバスに紐づかない手入力同士、の場合だけ一致させたい）。
 */

export async function findCommonLocationForCourse(
  db: D1Database,
  params: {
    term: Term; dayOfWeek: number; period: number; courseName: string; instructor: string | null;
    excludeUserId: number;
  },
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT location FROM timetable_entries
       WHERE term = ? AND day_of_week = ? AND period = ? AND course_name = ? AND instructor IS ?
         AND user_id != ? AND location IS NOT NULL AND location != ''
       GROUP BY location
       ORDER BY COUNT(*) DESC, MAX(updated_at) DESC
       LIMIT 1`,
    )
    .bind(
      params.term, params.dayOfWeek, params.period, params.courseName, params.instructor,
      params.excludeUserId,
    )
    .first<{ location: string }>();
  return row?.location ?? null;
}

export async function deleteUserCascade(db: D1Database, userId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM timetable_entries WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM timetable_snapshot_settings WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?").bind(userId, userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
