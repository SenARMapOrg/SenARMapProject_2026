// 時間割のコマと、学年+学期ごとのスナップショット設定（公開範囲・共有リンク）。

import type {
  SnapshotSettingsRow, Term, TimetableEntryRow, UserRow, Visibility,
} from "../types";
import { areFriends } from "./friends";
import { randomToken } from "./token";
import { findUserById } from "./users";

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
