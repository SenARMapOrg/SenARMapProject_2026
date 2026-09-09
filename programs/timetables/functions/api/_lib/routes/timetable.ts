import type { Context } from "hono";
import { Hono } from "hono";

import {
  areFriends, findCommonLocationForCourse, findUserById, listTimetable, replaceTimetable,
} from "../db";
import { requireAuth } from "../session";
import type { AppEnv, Term } from "../types";
import {
  isValidTerm, MAX_COURSE_NAME_LEN, MAX_DAY_OF_WEEK, MAX_PERIOD, MAX_TIMETABLE_ENTRIES,
  validateTimetableEntry, type RawTimetableEntry,
} from "../validate";

export const timetableRoutes = new Hono<AppEnv>();

/** ?term=spring|fall を取り出して検証する。共通化してGET/PUT/friend閲覧で同じ挙動にする */
function resolveTerm(c: Context): Term | null {
  const term = c.req.query("term");
  return isValidTerm(term) ? term : null;
}

timetableRoutes.get("/", requireAuth(), async (c) => {
  const term = resolveTerm(c);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);
  const user = c.get("user");
  const entries = await listTimetable(c.env.DB, user.id, term);
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

  await replaceTimetable(c.env.DB, user.id, term, validated);
  return c.json({ entries: await listTimetable(c.env.DB, user.id, term) });
});

// 「科目名から追加」の自動入力候補。同じ学期・曜日・時限・科目名で、自分以外の学生が
// 登録している教室のうち最も多いものを返す（個人を特定できる情報は返さない）。
timetableRoutes.get("/location-suggestion", requireAuth(), async (c) => {
  const term = resolveTerm(c);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);

  const day = Number(c.req.query("day_of_week"));
  const period = Number(c.req.query("period"));
  const courseName = (c.req.query("course_name") ?? "").trim();

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
    term, dayOfWeek: day, period, courseName, excludeUserId: user.id,
  });
  return c.json({ location });
});

// 友達の時間割を閲覧する。承諾済みの友達関係がある場合のみ許可する（サーバー側で必ず検証すること。
// フロント側の表示制御だけに頼ると、URLを直接叩かれた場合に他人の時間割が漏洩する）。
timetableRoutes.get("/friend/:userId", requireAuth(), async (c) => {
  const term = resolveTerm(c);
  if (!term) return c.json({ error: "term は spring か fall を指定してください" }, 400);

  const me = c.get("user");
  const friendId = Number(c.req.param("userId"));
  if (!Number.isInteger(friendId)) {
    return c.json({ error: "userId が不正です" }, 400);
  }
  if (friendId === me.id) {
    return c.json({ error: "自分自身は指定できません" }, 400);
  }

  const isFriend = await areFriends(c.env.DB, me.id, friendId);
  if (!isFriend) {
    return c.json({ error: "友達関係が確認できません" }, 403);
  }

  const friend = await findUserById(c.env.DB, friendId);
  if (!friend) {
    return c.json({ error: "ユーザーが見つかりません" }, 404);
  }

  const entries = await listTimetable(c.env.DB, friendId, term);
  return c.json({
    user: { id: friend.id, display_name: friend.nickname ?? friend.display_name },
    entries,
  });
});
