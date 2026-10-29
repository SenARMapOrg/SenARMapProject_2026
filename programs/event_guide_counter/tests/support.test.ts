// 相談窓口。公開API（/api/support/*）は誰でも送れるので、トークンを持つ本人の相談しか読めない・書けないこと、
// オペレーターがいないときは始められないことを確かめる。オペレーター側はDBの読み書きを確かめる。
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import {
  addOperatorMessage, closeConversation, countAcceptingOperators, createConversation, hashSessionToken,
  listConversations, pruneClosedConversations, touchOperator,
} from "../functions/api/_lib/db";
import { supportRoutes } from "../functions/api/_lib/routes/support";
import { MAX_USER_MESSAGES_PER_CONVERSATION, normalizeSupportMessage } from "../functions/api/_lib/support-guard";
import type { AppEnv } from "../functions/api/_lib/types";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

const ALLOWED = "https://iku-navi.net,https://www.iku-navi.net";
const NAVI = "https://iku-navi.net";

let t: TestD1;
const app = new Hono<AppEnv>().basePath("/api").route("/support", supportRoutes);

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
});

function call(path: string, body?: unknown, origin: string | null = NAVI) {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  const init: RequestInit = body === undefined
    ? { method: "GET", headers }
    : { method: "POST", headers: { ...headers, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) };
  return app.request(`https://event-guide-counter.iku-navi.net/api/support/${path}`, init,
    { DB: t.db, TRACK_ALLOWED_ORIGINS: ALLOWED } as unknown as AppEnv["Bindings"]);
}

const acceptOperator = () => touchOperator(t.db, "op@example.jp", true);

async function startConversation(text = "4号館の入口がわかりません"): Promise<string> {
  const res = await call("start", { text, context: "利用者: 4号館は？\nAI: 目的地に入れてください" });
  expect(res.status).toBe(201);
  return (await res.json() as { token: string }).token;
}

describe("受付の状態", () => {
  it("受け付けているオペレーターがいなければ、つなげない", async () => {
    expect(await (await call("status")).json()).toEqual({ available: false });
    const res = await call("start", { text: "こんにちは" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "unavailable" });
  });

  it("受け付けていても、確認が30秒以上止まっているオペレーターは数えない", async () => {
    await acceptOperator();
    expect(await countAcceptingOperators(t.db)).toBe(1);
    t.exec("UPDATE support_operators SET last_seen = datetime('now', '-31 seconds')");
    expect(await countAcceptingOperators(t.db)).toBe(0);
  });

  it("「受け付けない」にしたオペレーターは数えない", async () => {
    await touchOperator(t.db, "op@example.jp", false);
    expect(await countAcceptingOperators(t.db)).toBe(0);
  });
});

describe("/api/support（利用者）", () => {
  beforeEach(acceptOperator);

  it("許可していないページ・Origin の無いリクエストは 403 で、CORS のヘッダも付けない", async () => {
    const res = await call("status", undefined, "https://evil.example");
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect((await call("start", { text: "a" }, null)).status).toBe(403);
  });

  it("許可したページには、そのオリジンだけを CORS で許可する", async () => {
    const res = await call("status");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(NAVI);
    expect(await res.json()).toEqual({ available: true });
  });

  it("相談を始めると、DBにはトークンそのものではなくハッシュだけが残る", async () => {
    const token = await startConversation();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const rows = t.query("SELECT token_hash, status, context, user_unread FROM support_conversations");
    expect(rows).toEqual([{
      token_hash: await hashSessionToken(token), status: "waiting",
      context: "利用者: 4号館は？\nAI: 目的地に入れてください", user_unread: 1,
    }]);
  });

  it("送ったメッセージとオペレーターの返事を、after より新しいものだけ受け取れる", async () => {
    const token = await startConversation();
    expect((await call("send", { token, text: "正門から来ました" })).status).toBe(204);
    await addOperatorMessage(t.db, 1, "op@example.jp", "3号館の横から入れます");

    const all = await (await call("poll", { token, after: 0 })).json() as {
      status: string; messages: { id: number; sender: string; body: string }[];
    };
    expect(all.status).toBe("open");
    expect(all.messages.map((m) => [m.sender, m.body])).toEqual([
      ["user", "4号館の入口がわかりません"], ["user", "正門から来ました"], ["operator", "3号館の横から入れます"],
    ]);
    // オペレーターのメールアドレスは利用者に見せない
    expect(JSON.stringify(all)).not.toContain("op@example.jp");

    const newer = await (await call("poll", { token, after: all.messages[1].id })).json() as { messages: unknown[] };
    expect(newer.messages).toHaveLength(1);
  });

  it("知らないトークン・形式の違うトークンでは、ほかの人の相談を読めない", async () => {
    await startConversation();
    expect((await call("poll", { token: "0".repeat(64) })).status).toBe(404);
    expect((await call("poll", { token: "' OR 1=1 --" })).status).toBe(404);
    expect((await call("poll", {})).status).toBe(404);
  });

  it("終わった相談には送れず、利用者が終えるとお知らせが残る", async () => {
    const token = await startConversation();
    expect((await call("close", { token })).status).toBe(204);
    expect((await call("send", { token, text: "まだ聞きたい" })).status).toBe(409);
    const data = await (await call("poll", { token })).json() as { status: string; messages: { sender: string }[] };
    expect(data.status).toBe("closed");
    expect(data.messages.at(-1)?.sender).toBe("system");
  });

  it("空・長すぎるメッセージ、壊れた本文は受け付けない", async () => {
    expect((await call("start", { text: "   " })).status).toBe(400);
    expect((await call("start", { text: "あ".repeat(501) })).status).toBe(400);
    const res = await app.request("https://event-guide-counter.iku-navi.net/api/support/start", {
      method: "POST", headers: { Origin: NAVI }, body: "{broken",
    }, { DB: t.db, TRACK_ALLOWED_ORIGINS: ALLOWED } as unknown as AppEnv["Bindings"]);
    expect(res.status).toBe(400);
    expect(t.query("SELECT COUNT(*) AS n FROM support_conversations")[0].n).toBe(0);
  });

  it("1つの相談で送れるメッセージの数に上限がある", async () => {
    const token = await startConversation();
    for (let i = 1; i < MAX_USER_MESSAGES_PER_CONVERSATION; i++) {
      t.exec(`INSERT INTO support_messages (conversation_id, sender, body) VALUES (1, 'user', 'x')`);
    }
    expect((await call("send", { token, text: "もう1通" })).status).toBe(429);
  });

  it("同時に続けられる相談の数を超えたら、新しい相談は受け付けない", async () => {
    for (let i = 0; i < 50; i++) await createConversation(t.db, `hash${i}`, "", "a");
    const res = await call("start", { text: "こんにちは" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "busy" });
  });
});

describe("相談のDB（オペレーター）", () => {
  it("返事をすると対応中になり、未読が消える。終えるとお知らせが残る", async () => {
    const id = await createConversation(t.db, "h", "", "こんにちは");
    await addOperatorMessage(t.db, id, "op@example.jp", "どうしましたか");
    expect(t.query("SELECT status, user_unread FROM support_conversations")).toEqual([{ status: "open", user_unread: 0 }]);
    await closeConversation(t.db, id, "終了しました");
    expect(t.query("SELECT status FROM support_conversations")).toEqual([{ status: "closed" }]);
    // 終わった相談に返事をしても、状態は戻らない
    await addOperatorMessage(t.db, id, "op@example.jp", "追加");
    expect(t.query("SELECT status FROM support_conversations")).toEqual([{ status: "closed" }]);
  });

  it("一覧は続いている相談が先で、最後のメッセージが付く", async () => {
    const a = await createConversation(t.db, "a", "", "最初の相談");
    await createConversation(t.db, "b", "", "次の相談");
    await closeConversation(t.db, a, "終了しました");
    const list = await listConversations(t.db);
    expect(list.map((c) => [c.status, c.last_body])).toEqual([["waiting", "次の相談"], ["closed", "終了しました"]]);
  });

  it("終わってから14日を過ぎた相談だけを消す", async () => {
    const old = await createConversation(t.db, "old", "", "古い");
    const recent = await createConversation(t.db, "recent", "", "新しい");
    await createConversation(t.db, "active", "", "続いている");
    await closeConversation(t.db, old, "終了");
    await closeConversation(t.db, recent, "終了");
    t.exec(`UPDATE support_conversations SET closed_at = datetime('now', '-15 days') WHERE id = ${old}`);
    await pruneClosedConversations(t.db);
    expect(t.query("SELECT token_hash FROM support_conversations ORDER BY id")).toEqual([
      { token_hash: "recent" }, { token_hash: "active" },
    ]);
    expect(t.query(`SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ${old}`)[0].n).toBe(0);
  });
});

describe("support-guard", () => {
  it("制御文字を取り除き、改行は残す", () => {
    expect(normalizeSupportMessage("a\u0000b\nc\u0007")).toBe("ab\nc");
    expect(normalizeSupportMessage(123)).toBeNull();
  });
});
