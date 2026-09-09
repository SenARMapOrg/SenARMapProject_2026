import { Hono } from "hono";

import {
  acceptRequest, areFriends, countRecentRequestsFrom, createFriendRequest, deleteFriendshipBetween,
  deleteRequestById, findPendingRequestBetween, findRequestById, findUserByEmail, listFriends,
  listIncomingRequests, listOutgoingRequests,
} from "../db";
import { requireAuth } from "../session";
import type { AppEnv } from "../types";
import { isAllowedDomain, isValidEmailFormat, normalizeEmail } from "../validate";

export const friendsRoutes = new Hono<AppEnv>();

const MAX_REQUESTS_PER_HOUR = 20; // 招待の連投・嫌がらせ的な大量送信を防ぐための簡易レート制限

friendsRoutes.get("/", requireAuth(), async (c) => {
  const user = c.get("user");
  return c.json({ friends: await listFriends(c.env.DB, user.id) });
});

friendsRoutes.get("/requests", requireAuth(), async (c) => {
  const user = c.get("user");
  const [incoming, outgoing] = await Promise.all([
    listIncomingRequests(c.env.DB, user.id),
    listOutgoingRequests(c.env.DB, user.id),
  ]);
  return c.json({ incoming, outgoing });
});

friendsRoutes.post("/requests", requireAuth(), async (c) => {
  const user = c.get("user");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "リクエストボディが不正なJSONです" }, 400);
  }
  const rawEmail = (body as { to_email?: unknown } | null)?.to_email;
  if (typeof rawEmail !== "string") {
    return c.json({ error: "to_email を指定してください" }, 400);
  }
  const toEmail = normalizeEmail(rawEmail);
  if (!isValidEmailFormat(toEmail)) {
    return c.json({ error: "メールアドレスの形式が正しくありません" }, 400);
  }
  if (toEmail === user.email) {
    return c.json({ error: "自分自身には申請できません" }, 400);
  }
  // 友達申請も大学関係者間に閉じる（この制限が無いとメール総当たりで学外にスパムを送る踏み台になり得る）
  if (!isAllowedDomain(toEmail, c.env.ALLOWED_EMAIL_DOMAIN)) {
    return c.json({ error: `@${c.env.ALLOWED_EMAIL_DOMAIN} 宛にのみ申請できます` }, 400);
  }

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentCount = await countRecentRequestsFrom(c.env.DB, user.id, since);
  if (recentCount >= MAX_REQUESTS_PER_HOUR) {
    return c.json({ error: "申請の送信数が多すぎます。しばらく時間をおいてから再度お試しください" }, 429);
  }

  const targetUser = await findUserByEmail(c.env.DB, toEmail);
  if (targetUser && (await areFriends(c.env.DB, user.id, targetUser.id))) {
    return c.json({ error: "すでに友達です" }, 409);
  }

  const existingOutgoing = await findPendingRequestBetween(c.env.DB, user.id, toEmail);
  if (existingOutgoing) {
    return c.json({ error: "すでに申請を送信済みです" }, 409);
  }

  // 相手が先に自分宛てに送ってくれていた場合は、承認画面を挟まず自動的に友達成立させる
  if (targetUser) {
    const reverseRequest = await findPendingRequestBetween(c.env.DB, targetUser.id, user.email);
    if (reverseRequest) {
      await acceptRequest(c.env.DB, reverseRequest.id);
      return c.json({ status: "auto_accepted" });
    }
  }

  const created = await createFriendRequest(c.env.DB, user.id, toEmail, targetUser?.id ?? null);
  return c.json({ status: "pending", request: created }, 201);
});

friendsRoutes.post("/requests/:id/accept", requireAuth(), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正です" }, 400);
  const request = await findRequestById(c.env.DB, id);
  if (!request || request.to_user_id !== user.id || request.status !== "pending") {
    return c.json({ error: "申請が見つかりません" }, 404);
  }
  await acceptRequest(c.env.DB, id);
  return c.json({ status: "accepted" });
});

// 拒否・自分が送った申請の取り消しの両方をこれで扱う（行を削除するだけで、
// 「拒否された」という記録自体を残さない = 相手に既読/拒否は通知されない）
friendsRoutes.post("/requests/:id/reject", requireAuth(), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "id が不正です" }, 400);
  const request = await findRequestById(c.env.DB, id);
  if (!request || request.status !== "pending") {
    return c.json({ error: "申請が見つかりません" }, 404);
  }
  if (request.to_user_id !== user.id && request.from_user_id !== user.id) {
    return c.json({ error: "この申請を操作する権限がありません" }, 403);
  }
  await deleteRequestById(c.env.DB, id);
  return c.body(null, 204);
});

friendsRoutes.delete("/:userId", requireAuth(), async (c) => {
  const user = c.get("user");
  const friendId = Number(c.req.param("userId"));
  if (!Number.isInteger(friendId)) {
    return c.json({ error: "userId が不正です" }, 400);
  }
  await deleteFriendshipBetween(c.env.DB, user.id, friendId);
  return c.body(null, 204);
});
