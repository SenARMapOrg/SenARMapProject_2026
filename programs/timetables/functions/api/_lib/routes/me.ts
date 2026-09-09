import { Hono } from "hono";

import {
  deleteUserCascade, updateAutoFillLocation, updateNickname,
} from "../db";
import { clearSessionCookie, requireAuth } from "../session";
import type { AppEnv, UserRow } from "../types";
import { validateNickname } from "../validate";

export const meRoutes = new Hono<AppEnv>();

function serializeUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    nickname: user.nickname,
    auto_fill_location: Boolean(user.auto_fill_location),
  };
}

meRoutes.get("/", requireAuth(), (c) => {
  return c.json(serializeUser(c.get("user")));
});

// 設定の部分更新。nickname(友達に見せる表示名)・auto_fill_location(他の学生の教室を自動入力するか)を
// それぞれ独立に更新する。bodyに含まれていないキーには触れない（片方だけ変更したい場合に
// もう片方をnull/falseで上書きしてしまわないようにするため、hasOwnPropertyで判定する）。
meRoutes.patch("/", requireAuth(), async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }
  const raw = body as { nickname?: unknown; auto_fill_location?: unknown } | null;
  if (!raw || typeof raw !== "object") {
    return c.json({ error: "リクエストボディが不正です" }, 400);
  }

  let current = user;

  if (Object.prototype.hasOwnProperty.call(raw, "nickname")) {
    const result = validateNickname(raw.nickname ?? null);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    current = await updateNickname(c.env.DB, user.id, result.value);
  }

  if (Object.prototype.hasOwnProperty.call(raw, "auto_fill_location")) {
    if (typeof raw.auto_fill_location !== "boolean") {
      return c.json({ error: "auto_fill_location はtrue/falseで指定してください" }, 400);
    }
    current = await updateAutoFillLocation(c.env.DB, user.id, raw.auto_fill_location);
  }

  return c.json(serializeUser(current));
});

// アカウント削除。本人の全データ（セッション・時間割・友達関係）を即座に消去する。
// 個人情報を扱うサービスなので、退会導線は必ず用意しておくこと。
meRoutes.delete("/", requireAuth(), async (c) => {
  const user = c.get("user");
  await deleteUserCascade(c.env.DB, user.id);
  clearSessionCookie(c);
  return c.body(null, 204);
});
