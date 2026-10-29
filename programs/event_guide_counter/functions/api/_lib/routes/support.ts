// 相談窓口の公開API。IKU NAVI のナビ画面（programs/html/navi/script/help.js）から呼ばれる。
// ログイン不要・クロスオリジン（iku-navi.net から叩かれる）。
//
// 応答を読む必要があるので、track と違って CORS のヘッダを付ける。
// ブラウザの事前確認（プリフライト）が起きないよう、help.js は本文を text/plain の JSON で送り、
// 独自のヘッダを付けない。送ってよいページは TRACK_ALLOWED_ORIGINS（記録APIと同じ）で決める。
//
//   GET  /api/support/status  … オペレーターが受け付けているか
//   POST /api/support/start   … 相談を始める（最初のメッセージ・AI とのやりとり）→ トークン
//   POST /api/support/poll    … 新しいメッセージと相談の状態（数秒ごとに呼ばれる）
//   POST /api/support/send    … メッセージを送る
//   POST /api/support/close   … 利用者が相談を終える

import { Hono, type Context } from "hono";

import {
  addUserMessage, closeConversation, countAcceptingOperators, countActiveConversations, countUserMessages,
  createConversation, findConversationByTokenHash, hashSessionToken, listMessagesAfter, randomToken,
  type SupportConversationRow,
} from "../db";
import {
  isValidSupportToken, MAX_ACTIVE_CONVERSATIONS, MAX_SUPPORT_BODY_BYTES, MAX_SUPPORT_CONTEXT_CHARS,
  MAX_USER_MESSAGES_PER_CONVERSATION, normalizeSupportMessage, readAfterId,
} from "../support-guard";
import { isAllowedTrackOrigin } from "../track-guard";
import type { AppEnv } from "../types";

export const supportRoutes = new Hono<AppEnv>();

const CLOSED_BY_USER_NOTICE = "相談を終了しました。";

/** 許可したページからの呼び出しなら、そのオリジンを返す */
function allowedOrigin(c: Context<AppEnv>): string | null {
  const origin = c.req.header("Origin");
  return origin && isAllowedTrackOrigin(origin, c.req.url, c.env.TRACK_ALLOWED_ORIGINS) ? origin : null;
}

// すべての応答に CORS と、キャッシュさせないヘッダを付ける。許可していないページからは 403
supportRoutes.use("*", async (c, next) => {
  const origin = allowedOrigin(c);
  c.header("Cache-Control", "no-store");
  c.header("Vary", "Origin");
  if (!origin) return c.json({ error: "このページからは使えません。" }, 403);
  c.header("Access-Control-Allow-Origin", origin);
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET, POST");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  }
  await next();
});

/** 本文の JSON を読む。大きすぎる・壊れている・オブジェクトでなければ null */
async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_SUPPORT_BODY_BYTES) return null;
  try {
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_SUPPORT_BODY_BYTES) return null;
    const data = JSON.parse(text);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 本文のトークンから相談を探す。見つからなければ null */
async function findByToken(c: Context<AppEnv>, body: Record<string, unknown> | null): Promise<SupportConversationRow | null> {
  if (!isValidSupportToken(body?.token)) return null;
  return findConversationByTokenHash(c.env.DB, await hashSessionToken(body.token as string));
}

const NOT_FOUND = { error: "相談が見つかりません。もう一度はじめからつないでください。", code: "not_found" } as const;

supportRoutes.get("/status", async (c) => {
  return c.json({ available: (await countAcceptingOperators(c.env.DB)) > 0 });
});

supportRoutes.post("/start", async (c) => {
  const body = await readBody(c);
  const text = normalizeSupportMessage(body?.text);
  if (!text) return c.json({ error: "相談の内容を書いてください（500文字まで）。" }, 400);
  // AI とのやりとりは長ければ新しい方を残す
  const rawContext = typeof body?.context === "string" ? body.context.slice(-MAX_SUPPORT_CONTEXT_CHARS) : "";
  const context = normalizeSupportMessage(rawContext, MAX_SUPPORT_CONTEXT_CHARS) ?? "";

  if ((await countAcceptingOperators(c.env.DB)) === 0) {
    return c.json({ error: "今はオペレーターが対応していません。", code: "unavailable" }, 503);
  }
  if ((await countActiveConversations(c.env.DB)) >= MAX_ACTIVE_CONVERSATIONS) {
    return c.json({ error: "いま相談が混み合っています。少し待ってからもう一度試してください。", code: "busy" }, 503);
  }

  const token = randomToken();
  await createConversation(c.env.DB, await hashSessionToken(token), context, text);
  return c.json({ token }, 201);
});

supportRoutes.post("/poll", async (c) => {
  const body = await readBody(c);
  const conversation = await findByToken(c, body);
  if (!conversation) return c.json(NOT_FOUND, 404);
  const messages = await listMessagesAfter(c.env.DB, conversation.id, readAfterId(body?.after));
  return c.json({ status: conversation.status, messages });
});

supportRoutes.post("/send", async (c) => {
  const body = await readBody(c);
  const conversation = await findByToken(c, body);
  if (!conversation) return c.json(NOT_FOUND, 404);
  if (conversation.status === "closed") {
    return c.json({ error: "この相談は終了しています。", code: "closed" }, 409);
  }
  const text = normalizeSupportMessage(body?.text);
  if (!text) return c.json({ error: "メッセージを書いてください（500文字まで）。" }, 400);
  if ((await countUserMessages(c.env.DB, conversation.id)) >= MAX_USER_MESSAGES_PER_CONVERSATION) {
    return c.json({ error: "この相談で送れるメッセージの数を超えました。", code: "too_many" }, 429);
  }
  await addUserMessage(c.env.DB, conversation.id, text);
  return c.body(null, 204);
});

supportRoutes.post("/close", async (c) => {
  const conversation = await findByToken(c, await readBody(c));
  if (!conversation) return c.json(NOT_FOUND, 404);
  if (conversation.status !== "closed") {
    await closeConversation(c.env.DB, conversation.id, CLOSED_BY_USER_NOTICE);
  }
  return c.body(null, 204);
});

supportRoutes.all("*", (c) => c.json({ error: "Not Found" }, 404));
