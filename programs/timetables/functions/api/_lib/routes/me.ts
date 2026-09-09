import { Hono } from "hono";

import { deleteUserCascade, updateNickname } from "../db";
import { clearSessionCookie, requireAuth } from "../session";
import type { AppEnv } from "../types";
import { validateNickname } from "../validate";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/", requireAuth(), (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id, email: user.email, display_name: user.display_name, nickname: user.nickname,
  });
});

// あだ名(友達に見せる表示名)の設定・解除。本名(display_name、Google由来)は変更できない。
meRoutes.patch("/", requireAuth(), async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }

  const result = validateNickname((body as { nickname?: unknown } | null)?.nickname ?? null);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  const updated = await updateNickname(c.env.DB, user.id, result.value);
  return c.json({
    id: updated.id, email: updated.email, display_name: updated.display_name, nickname: updated.nickname,
  });
});

// アカウント削除。本人の全データ（セッション・時間割・友達関係）を即座に消去する。
// 個人情報を扱うサービスなので、退会導線は必ず用意しておくこと。
meRoutes.delete("/", requireAuth(), async (c) => {
  const user = c.get("user");
  await deleteUserCascade(c.env.DB, user.id);
  clearSessionCookie(c);
  return c.body(null, 204);
});
