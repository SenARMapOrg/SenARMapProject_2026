import type { Context } from "hono";
import { Hono } from "hono";

import {
  canViewSnapshot, findCommonLocationForCourse, findSnapshotByToken, findUserById,
  getSnapshotSettings, listMyGrades, listPublicSnapshots, listTimetable, replaceTimetable,
  upsertSnapshotSettings,
} from "../db";
import { requireAuth } from "../session";
import type { AppEnv, Term, Visibility } from "../types";
import {
  isValidGrade, isValidTerm, isValidVisibility, MAX_COURSE_NAME_LEN, MAX_DAY_OF_WEEK, MAX_PERIOD,
  MAX_TIMETABLE_ENTRIES, validateTimetableEntry, type RawTimetableEntry,
} from "../validate";

export const timetableRoutes = new Hono<AppEnv>();

/** ?term=spring|fall を取り出して検証する。共通化してGET/PUT/閲覧系で同じ挙動にする */
function resolveTerm(c: Context): Term | null {
  const term = c.req.query("term");
  return isValidTerm(term) ? term : null;
}

/** ?grade=1〜MAX_GRADE を取り出して検証する */
function resolveGrade(c: Context): number | null {
  const grade = Number(c.req.query("grade"));
  return isValidGrade(grade) ? grade : null;
}

function shareUrl(c: Context, token: string): string {
  return `${new URL(c.req.url).origin}/?shared=${token}`;
}

timetableRoutes.get("/", requireAuth(), async (c) => {
  const grade = resolveGrade(c);
  const term = resolveTerm(c);
  if (grade === null) return c.json({ error: "grade を正しく指定してください" }, 400);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);
  const user = c.get("user");
  const entries = await listTimetable(c.env.DB, user.id, grade, term);
  return c.json({ entries });
});

timetableRoutes.put("/", requireAuth(), async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }

  const grade = (body as { grade?: unknown } | null)?.grade;
  if (!isValidGrade(grade)) {
    return c.json({ error: "grade を正しく指定してください" }, 400);
  }

  const term = (body as { term?: unknown } | null)?.term;
  if (!isValidTerm(term)) {
    return c.json({ error: "term は spring か fall を指定してください" }, 400);
  }

  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) {
    return c.json({ error: "entries は配列で指定してください" }, 400);
  }
  if (entries.length > MAX_TIMETABLE_ENTRIES) {
    return c.json({ error: `entries は最大${MAX_TIMETABLE_ENTRIES}件までです` }, 400);
  }

  const validated = [];
  const seen = new Set<string>();
  for (const raw of entries as RawTimetableEntry[]) {
    const result = validateTimetableEntry(raw ?? {});
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    const key = `${result.value.day_of_week}-${result.value.period}`;
    if (seen.has(key)) {
      return c.json({ error: `同じ曜日・時限のコマが重複しています (${key})` }, 400);
    }
    seen.add(key);
    validated.push(result.value);
  }

  await replaceTimetable(c.env.DB, user.id, grade, term, validated);
  return c.json({ entries: await listTimetable(c.env.DB, user.id, grade, term) });
});

// 「科目名から追加」の自動入力候補。同じ学期・曜日・時限・科目名・担当教員で、自分以外の学生が
// 登録している教室のうち最も多いものを返す（個人を特定できる情報は返さない）。
// gradeでは絞らない: 同じ授業は毎年ほぼ同じ曜日・時限に開講されるため、学年をまたいで
// プールした方が候補の母数が増えて有用（instructor+曜日+時限+科目名が既に十分具体的）。
// instructor は任意（手入力科目など担当教員が無い場合は省略してよい＝NULL扱いで照合する）。
timetableRoutes.get("/location-suggestion", requireAuth(), async (c) => {
  const term = resolveTerm(c);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);

  const day = Number(c.req.query("day_of_week"));
  const period = Number(c.req.query("period"));
  const courseName = (c.req.query("course_name") ?? "").trim();
  const instructorRaw = c.req.query("instructor");
  const instructor = instructorRaw && instructorRaw.trim() ? instructorRaw.trim() : null;

  if (!Number.isInteger(day) || day < 0 || day > MAX_DAY_OF_WEEK) {
    return c.json({ error: `day_of_week は 0〜${MAX_DAY_OF_WEEK} の整数で指定してください` }, 400);
  }
  if (!Number.isInteger(period) || period < 1 || period > MAX_PERIOD) {
    return c.json({ error: `period は 1〜${MAX_PERIOD} の整数で指定してください` }, 400);
  }
  if (!courseName || courseName.length > MAX_COURSE_NAME_LEN) {
    return c.json({ error: "course_name を正しく指定してください" }, 400);
  }

  const user = c.get("user");
  const location = await findCommonLocationForCourse(c.env.DB, {
    term, dayOfWeek: day, period, courseName, instructor, excludeUserId: user.id,
  });
  return c.json({ location });
});

// 自分が時間割を登録済みの(学年, 学期)一覧。「学年タブ」に何を並べるかに使う。
timetableRoutes.get("/grades", requireAuth(), async (c) => {
  const user = c.get("user");
  const grades = await listMyGrades(c.env.DB, user.id);
  return c.json({ grades });
});

// 指定(学年, 学期)スナップショットの公開範囲を取得する。
timetableRoutes.get("/visibility", requireAuth(), async (c) => {
  const grade = resolveGrade(c);
  const term = resolveTerm(c);
  if (grade === null) return c.json({ error: "grade を正しく指定してください" }, 400);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);

  const user = c.get("user");
  const settings = await getSnapshotSettings(c.env.DB, user.id, grade, term);
  return c.json({
    grade: settings.grade, term: settings.term, visibility: settings.visibility,
    share_url: settings.share_token ? shareUrl(c, settings.share_token) : null,
  });
});

// 指定(学年, 学期)スナップショットの公開範囲を変更する。
timetableRoutes.put("/visibility", requireAuth(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }
  const grade = (body as { grade?: unknown } | null)?.grade;
  const term = (body as { term?: unknown } | null)?.term;
  const visibility = (body as { visibility?: unknown } | null)?.visibility;
  if (!isValidGrade(grade)) return c.json({ error: "grade を正しく指定してください" }, 400);
  if (!isValidTerm(term)) return c.json({ error: "term は spring か fall を指定してください" }, 400);
  if (!isValidVisibility(visibility)) {
    return c.json({ error: "visibility は private/friends/link/public のいずれかで指定してください" }, 400);
  }

  const user = c.get("user");
  const settings = await upsertSnapshotSettings(c.env.DB, user.id, grade, term, visibility as Visibility);
  return c.json({
    grade: settings.grade, term: settings.term, visibility: settings.visibility,
    share_url: settings.share_token ? shareUrl(c, settings.share_token) : null,
  });
});

// 「みんなの時間割を探す」一覧。公開(public)設定のスナップショットのみ、学年/学期/学部/学科
// （すべて任意）で絞り込む。
timetableRoutes.get("/public", requireAuth(), async (c) => {
  const gradeRaw = c.req.query("grade");
  const grade = gradeRaw ? Number(gradeRaw) : undefined;
  if (grade !== undefined && !isValidGrade(grade)) {
    return c.json({ error: "grade を正しく指定してください" }, 400);
  }
  const termRaw = c.req.query("term");
  if (termRaw && !isValidTerm(termRaw)) {
    return c.json({ error: "term は spring か fall を指定してください" }, 400);
  }
  const faculty = c.req.query("faculty") || undefined;
  const department = c.req.query("department") || undefined;

  const user = c.get("user");
  const snapshots = await listPublicSnapshots(c.env.DB, {
    grade, term: termRaw as Term | undefined, faculty, department, excludeUserId: user.id,
  });
  return c.json({ snapshots });
});

// 他のユーザーの(学年, 学期)スナップショットを閲覧する。公開範囲(private/friends/public)を
// サーバー側で必ず検証する（フロント側の表示制御だけに頼ると、URLを直接叩かれた場合に
// 他人の時間割が漏洩する）。'link'モードのスナップショットはこのルートでは見られない
// （/shared/:token 専用。userIdが分かれば誰でも直接呼べてしまうこのルートで許可すると
// 「リンクを知っている人だけ」という前提が崩れるため）。
timetableRoutes.get("/view/:userId", requireAuth(), async (c) => {
  const grade = resolveGrade(c);
  const term = resolveTerm(c);
  if (grade === null) return c.json({ error: "grade を正しく指定してください" }, 400);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);

  const me = c.get("user");
  const targetId = Number(c.req.param("userId"));
  if (!Number.isInteger(targetId)) {
    return c.json({ error: "userId が不正です" }, 400);
  }

  const allowed = await canViewSnapshot(c.env.DB, me.id, targetId, grade, term);
  if (!allowed) {
    return c.json({ error: "この時間割を閲覧する権限がありません" }, 403);
  }

  const target = await findUserById(c.env.DB, targetId);
  if (!target) {
    return c.json({ error: "ユーザーが見つかりません" }, 404);
  }

  const entries = await listTimetable(c.env.DB, targetId, grade, term);
  return c.json({
    user: { id: target.id, display_name: target.nickname ?? target.display_name },
    grade, term, entries,
  });
});

// 共有リンク（?shared=token）経由での閲覧。ログイン（大学Googleアカウント）は必須。
// トークンが一致すれば、友達関係の有無に関わらず閲覧できる
// （visibilityが'link'/'public'の間だけトークンが発行されている前提。upsertSnapshotSettings参照）。
timetableRoutes.get("/shared/:token", requireAuth(), async (c) => {
  const token = c.req.param("token") ?? "";
  const snapshot = token ? await findSnapshotByToken(c.env.DB, token) : null;
  if (!snapshot) {
    return c.json({ error: "共有リンクが無効です" }, 404);
  }

  const entries = await listTimetable(c.env.DB, snapshot.user_id, snapshot.grade, snapshot.term);
  return c.json({
    user: { id: snapshot.user_id, display_name: snapshot.display_name },
    grade: snapshot.grade, term: snapshot.term, entries,
  });
});
