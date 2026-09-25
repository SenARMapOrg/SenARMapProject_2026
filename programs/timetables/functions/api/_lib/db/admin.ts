// 管理画面用の集計クエリ。時間割の中身（科目名・教室）は返さない。件数だけを返す。

export interface AdminUserRow {
  id: number;
  email: string;
  display_name: string;
  nickname: string | null;
  faculty: string | null;
  department: string | null;
  current_grade: number;
  created_at: string;
  last_login_at: string | null;  // 残っているセッションのうち最新の作成時刻（ログアウト済みなら null）
  entry_count: number;           // 登録しているコマ数（全学年・全学期の合計）
  grade_count: number;           // 時間割が1コマ以上ある学年の数
}

export interface AdminSummary {
  total_users: number;
  total_entries: number;
  users_with_entries: number;
}

export async function getSessionCreatedAt(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT created_at FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

export async function listUsersForAdmin(db: D1Database): Promise<AdminUserRow[]> {
  const { results } = await db
    .prepare(
      `SELECT
         u.id, u.email, u.display_name, u.nickname, u.faculty, u.department, u.current_grade,
         u.created_at,
         (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login_at,
         (SELECT COUNT(*) FROM timetable_entries e WHERE e.user_id = u.id) AS entry_count,
         (SELECT COUNT(DISTINCT e.grade) FROM timetable_entries e WHERE e.user_id = u.id) AS grade_count
       FROM users u
       ORDER BY u.created_at DESC, u.id DESC`,
    )
    .all<AdminUserRow>();
  return results ?? [];
}

export async function getAdminSummary(db: D1Database): Promise<AdminSummary> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS total_users,
         (SELECT COUNT(*) FROM timetable_entries) AS total_entries,
         (SELECT COUNT(DISTINCT user_id) FROM timetable_entries) AS users_with_entries`,
    )
    .first<AdminSummary>();
  return row ?? { total_users: 0, total_entries: 0, users_with_entries: 0 };
}
