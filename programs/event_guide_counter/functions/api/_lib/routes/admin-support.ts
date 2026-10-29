// 管理画面の「相談窓口」用API（/api/admin/support/*）。routes/admin.ts の requireAdmin の内側に置く。
//
// 管理画面は数秒ごとに GET /state を呼ぶ。ほかの管理APIと同じく、どの呼び出しも閲覧記録（admin_audit_log）に残る。
// D1 の書き込みの回数（無料枠は1日10万回）を抑えるため、一覧と開いている相談のメッセージを1回で返す。
//
//   GET  /state?open=<id>&after=<id>     … 自分の受付状態・受け付けているオペレーターの数・相談の一覧と、
//                                          open を付けたらその相談の after より新しいメッセージ（読んだことにする）。
//                                          オペレーターが画面を開いていることの確認も兼ねる
//   POST /accepting                      … 受け付ける / 受け付けない
//   POST /conversations/:id/messages     … 返事を送る
//   POST /conversations/:id/close        … 相談を終える

import { Hono, type Context } from "hono";

import {
  addOperatorMessage, closeConversation, countAcceptingOperators, findConversationById, isOperatorAccepting,
  listConversations, listMessagesAfter, markConversationRead, pruneClosedConversations, touchOperator,
} from "../db";
import { normalizeSupportMessage, readAfterId } from "../support-guard";
import type { AppEnv } from "../types";

export const adminSupportRoutes = new Hono<AppEnv>();

const NOT_FOUND = { error: "Not Found" } as const;
const CLOSED_BY_OPERATOR_NOTICE = "オペレーターが相談を終了しました。ほかにも困ったことがあれば、もう一度つないでください。";

async function findConversationFromPath(c: Context<AppEnv>) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return null;
  return findConversationById(c.env.DB, id);
}

adminSupportRoutes.get("/state", async (c) => {
  const email = c.get("adminEmail");
  await touchOperator(c.env.DB, email, null);
  const [accepting, operators, conversations] = await Promise.all([
    isOperatorAccepting(c.env.DB, email),
    countAcceptingOperators(c.env.DB),
    listConversations(c.env.DB),
  ]);

  let open = null;
  const openId = Number(c.req.query("open"));
  if (Number.isInteger(openId) && openId > 0) {
    const conversation = await findConversationById(c.env.DB, openId);
    if (conversation) {
      const messages = await listMessagesAfter(c.env.DB, conversation.id, readAfterId(c.req.query("after")));
      if (conversation.user_unread > 0) await markConversationRead(c.env.DB, conversation.id);
      open = { conversation, messages };
    }
  }
  return c.json({ accepting, accepting_operators: operators, conversations, open });
});

adminSupportRoutes.post("/accepting", async (c) => {
  const body = await c.req.json().catch(() => null) as { accepting?: unknown } | null;
  if (typeof body?.accepting !== "boolean") return c.json({ error: "accepting を true か false で送ってください" }, 400);
  await touchOperator(c.env.DB, c.get("adminEmail"), body.accepting);
  // 古い相談の片付けは、受付を始めたときにまとめて行う（数秒ごとの一覧では行わない）
  if (body.accepting) await pruneClosedConversations(c.env.DB);
  return c.body(null, 204);
});

adminSupportRoutes.post("/conversations/:id/messages", async (c) => {
  const conversation = await findConversationFromPath(c);
  if (!conversation) return c.json(NOT_FOUND, 404);
  if (conversation.status === "closed") return c.json({ error: "この相談は終了しています" }, 409);
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const text = normalizeSupportMessage(body?.text);
  if (!text) return c.json({ error: "返事を入力してください（500文字まで）" }, 400);
  await addOperatorMessage(c.env.DB, conversation.id, c.get("adminEmail"), text);
  return c.body(null, 204);
});

adminSupportRoutes.post("/conversations/:id/close", async (c) => {
  const conversation = await findConversationFromPath(c);
  if (!conversation) return c.json(NOT_FOUND, 404);
  if (conversation.status !== "closed") {
    await closeConversation(c.env.DB, conversation.id, CLOSED_BY_OPERATOR_NOTICE);
  }
  return c.body(null, 204);
});
