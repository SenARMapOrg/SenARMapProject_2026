import type {
  FriendRequestRow, SessionRow, SnapshotSettingsRow, Term, TimetableEntryRow, UserRow, Visibility,
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

export async function listTimetable(
  db: D1Database, userId: number, grade: number, term: Term,
): Promise<TimetableEntryRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM timetable_entries WHERE user_id = ? AND grade = ? AND term = ? ORDER BY day_of_week, period",
    )
    .bind(userId, grade, term)
    .all<TimetableEntryRow>();
  return results;
}

export interface TimetableEntryInput {
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
  instructor: string | null;
}

/**
 * ユーザーの指定学年・学期(grade, term)の時間割を丸ごと入れ替える（部分編集ではなく全件置き換え。
 * フロントは常にそのスナップショットの全件を送る）。他の学年・学期の行には触れない。
 */
export async function replaceTimetable(
  db: D1Database, userId: number, grade: number, term: Term, entries: TimetableEntryInput[],
): Promise<void> {
  const stmts = [
    db.prepare("DELETE FROM timetable_entries WHERE user_id = ? AND grade = ? AND term = ?")
      .bind(userId, grade, term),
    ...entries.map((e) =>
      db
        .prepare(
          `INSERT INTO timetable_entries
             (user_id, grade, term, day_of_week, period, course_name, location, instructor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(userId, grade, term, e.day_of_week, e.period, e.course_name, e.location, e.instructor),
    ),
  ];
  await db.batch(stmts);
}

/**
 * ユーザーが時間割を持っている(grade, term)の組を一覧する（entriesが1件でもあれば対象。
 * 空のまま公開範囲だけ設定したスナップショットは対象外＝実質「時間割が存在する学年」の一覧になる）。
 * 「学年タブ」に何を並べるかに使う。
 */
export async function listMyGrades(
  db: D1Database, userId: number,
): Promise<{ grade: number; term: Term }[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT grade, term FROM timetable_entries WHERE user_id = ?
       ORDER BY grade, term`,
    )
    .bind(userId)
    .all<{ grade: number; term: Term }>();
  return results;
}

/** スナップショット(grade, term)の公開範囲設定を取得する。行が無ければ既定(friends)を返す */
export async function getSnapshotSettings(
  db: D1Database, userId: number, grade: number, term: Term,
): Promise<SnapshotSettingsRow> {
  const row = await db
    .prepare("SELECT * FROM timetable_snapshot_settings WHERE user_id = ? AND grade = ? AND term = ?")
    .bind(userId, grade, term)
    .first<SnapshotSettingsRow>();
  if (row) return row;
  return { user_id: userId, grade, term, visibility: "friends", share_token: null, updated_at: "" };
}

/**
 * 学年タブそのものを付け替える（前期・後期どちらのtimetable_entriesも、公開範囲設定
 * (timetable_snapshot_settings)も、まとめてfromGrade→toGradeに移動する）。
 * 「1年次として登録したけど実は2年次だった」のような後からの学年訂正に使う。
 *
 * 移動先(toGrade)に既に時間割か公開設定がある場合は失敗させる（黙って上書き・混在させると
 * 既存のスナップショットが消えてしまうため。先にtoGrade側を削除/移動してもらう）。
 * fromGradeがそのユーザーのcurrent_grade（「今の学年」、ナビ機能が見る学年）だった場合は、
 * current_gradeも一緒にtoGradeへスライドさせる（同じスナップショットの番号が変わっただけなので）。
 */
export async function changeGrade(
  db: D1Database, userId: number, fromGrade: number, toGrade: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (fromGrade === toGrade) {
    return { ok: false, error: "変更後の学年が変更前と同じです" };
  }

  const [existingEntries, existingSettings, user] = await Promise.all([
    db.prepare("SELECT 1 FROM timetable_entries WHERE user_id = ? AND grade = ? LIMIT 1")
      .bind(userId, toGrade).first(),
    db.prepare("SELECT 1 FROM timetable_snapshot_settings WHERE user_id = ? AND grade = ? LIMIT 1")
      .bind(userId, toGrade).first(),
    findUserById(db, userId),
  ]);
  if (existingEntries || existingSettings) {
    return { ok: false, error: `${toGrade}年次には既に時間割または公開設定があるため変更できません` };
  }

  const stmts = [
    db.prepare("UPDATE timetable_entries SET grade = ?, updated_at = datetime('now') WHERE user_id = ? AND grade = ?")
      .bind(toGrade, userId, fromGrade),
    db.prepare("UPDATE timetable_snapshot_settings SET grade = ?, updated_at = datetime('now') WHERE user_id = ? AND grade = ?")
      .bind(toGrade, userId, fromGrade),
  ];
  if (user?.current_grade === fromGrade) {
    stmts.push(
      db.prepare("UPDATE users SET current_grade = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(toGrade, userId),
    );
  }
  await db.batch(stmts);
  return { ok: true };
}

/**
 * 公開範囲を変更する。visibilityが'link'/'public'になった時だけ共有トークンを発行し
 * （既にあれば使い回す）、'private'/'friends'に戻したらトークンを破棄する
 * （トークンの存在＝共有リンクが有効、という不変条件をここで維持する）。
 */
export async function upsertSnapshotSettings(
  db: D1Database, userId: number, grade: number, term: Term, visibility: Visibility,
): Promise<SnapshotSettingsRow> {
  const existing = await db
    .prepare("SELECT * FROM timetable_snapshot_settings WHERE user_id = ? AND grade = ? AND term = ?")
    .bind(userId, grade, term)
    .first<SnapshotSettingsRow>();

  const needsToken = visibility === "link" || visibility === "public";
  const shareToken = needsToken ? (existing?.share_token ?? randomToken(16)) : null;

  const result = await db
    .prepare(
      `INSERT INTO timetable_snapshot_settings (user_id, grade, term, visibility, share_token, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (user_id, grade, term)
       DO UPDATE SET visibility = excluded.visibility, share_token = excluded.share_token,
                      updated_at = excluded.updated_at
       RETURNING *`,
    )
    .bind(userId, grade, term, visibility, shareToken)
    .first<SnapshotSettingsRow>();
  if (!result) throw new Error("公開範囲の更新に失敗しました");
  return result;
}

/** 共有トークンからスナップショットの所有者情報を引く（linkモードの専用ルート用） */
export async function findSnapshotByToken(
  db: D1Database, token: string,
): Promise<(SnapshotSettingsRow & { display_name: string }) | null> {
  const row = await db
    .prepare(
      `SELECT s.*, COALESCE(u.nickname, u.display_name) AS display_name
       FROM timetable_snapshot_settings s JOIN users u ON u.id = s.user_id
       WHERE s.share_token = ?`,
    )
    .bind(token)
    .first<SnapshotSettingsRow & { display_name: string }>();
  return row ?? null;
}

/**
 * viewerがownerの(grade, term)スナップショットを閲覧できるかどうかを判定する。
 * 'link'は専用ルート(findSnapshotByToken)でのみ許可するため、ここでは常にfalse扱いにする
 * （このチェックは「友達一覧」「みんなの時間割」経由のuserId指定ビューからのみ呼ぶ想定）。
 */
export async function canViewSnapshot(
  db: D1Database, viewerId: number, ownerId: number, grade: number, term: Term,
): Promise<boolean> {
  if (viewerId === ownerId) return true;
  const settings = await getSnapshotSettings(db, ownerId, grade, term);
  if (settings.visibility === "public") return true;
  if (settings.visibility === "friends") return areFriends(db, viewerId, ownerId);
  return false; // private・link
}

/**
 * 「みんなの時間割を探す」用の一覧。公開(public)設定のスナップショットだけを対象に、
 * 学年・学期・学部・学科（すべて任意）で絞り込む。時間割が1件も無い（entries 0件）
 * スナップショットは除外する（探しても中身が無いため）。
 */
export async function listPublicSnapshots(
  db: D1Database,
  filters: { grade?: number; term?: Term; faculty?: string; department?: string; excludeUserId: number },
): Promise<{ user_id: number; display_name: string; grade: number; term: Term; faculty: string | null; department: string | null }[]> {
  const conditions: string[] = ["s.visibility = 'public'", "u.id != ?"];
  const values: unknown[] = [filters.excludeUserId];
  if (filters.grade !== undefined) { conditions.push("s.grade = ?"); values.push(filters.grade); }
  if (filters.term !== undefined) { conditions.push("s.term = ?"); values.push(filters.term); }
  if (filters.faculty) { conditions.push("u.faculty = ?"); values.push(filters.faculty); }
  if (filters.department) { conditions.push("u.department = ?"); values.push(filters.department); }

  const { results } = await db
    .prepare(
      `SELECT u.id AS user_id, COALESCE(u.nickname, u.display_name) AS display_name,
              s.grade, s.term, u.faculty, u.department
       FROM timetable_snapshot_settings s
       JOIN users u ON u.id = s.user_id
       WHERE ${conditions.join(" AND ")}
         AND EXISTS (
           SELECT 1 FROM timetable_entries e
           WHERE e.user_id = s.user_id AND e.grade = s.grade AND e.term = s.term
         )
       ORDER BY s.grade, s.term, display_name`,
    )
    .bind(...values)
    .all<{
      user_id: number; display_name: string; grade: number; term: Term;
      faculty: string | null; department: string | null;
    }>();
  return results;
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
    db.prepare("DELETE FROM timetable_snapshot_settings WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?").bind(userId, userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
