// 相談窓口（support_* テーブル。migrations/0002_support.sql 参照）の読み書き。
// 公開API（routes/support.ts）と管理API（routes/admin-support.ts）から呼ばれる。

export type SupportStatus = "waiting" | "open" | "closed";
export type SupportSender = "user" | "operator" | "system";

export interface SupportConversationRow {
  id: number;
  status: SupportStatus;
  context: string;
  user_unread: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SupportConversationSummary extends SupportConversationRow {
  last_body: string | null;
  last_sender: SupportSender | null;
}

export interface SupportMessageRow {
  id: number;
  sender: SupportSender;
  body: string;
  created_at: string;
}

/**
 * オペレーターが「受け付けている」とみなす、最後の確認からの時間。
 * 管理画面は4秒ごとに確認するが、裏のタブではブラウザが間隔を最大1分ほどに延ばすので、それより長くする
 */
export const OPERATOR_FRESH_SECONDS = 90;
/** 終了した相談を残しておく日数。これより古いものは、オペレーターが一覧を開いたときに消す */
export const SUPPORT_RETENTION_DAYS = 14;

// ---- 相談 ----

export async function createConversation(
  db: D1Database, tokenHash: string, context: string, firstMessage: string,
): Promise<number> {
  const row = await db
    .prepare("INSERT INTO support_conversations (token_hash, context, user_unread) VALUES (?, ?, 1) RETURNING id")
    .bind(tokenHash, context)
    .first<{ id: number }>();
  if (!row) throw new Error("support conversation was not created");
  await db
    .prepare("INSERT INTO support_messages (conversation_id, sender, body) VALUES (?, 'user', ?)")
    .bind(row.id, firstMessage)
    .run();
  return row.id;
}

export async function findConversationByTokenHash(
  db: D1Database, tokenHash: string,
): Promise<SupportConversationRow | null> {
  return db
    .prepare(
      `SELECT id, status, context, user_unread, created_at, updated_at, closed_at
       FROM support_conversations WHERE token_hash = ?`,
    )
    .bind(tokenHash)
    .first<SupportConversationRow>();
}

export async function findConversationById(db: D1Database, id: number): Promise<SupportConversationRow | null> {
  return db
    .prepare(
      `SELECT id, status, context, user_unread, created_at, updated_at, closed_at
       FROM support_conversations WHERE id = ?`,
    )
    .bind(id)
    .first<SupportConversationRow>();
}

/** 今 'waiting'・'open' の相談の数（受け付けすぎを防ぐため） */
export async function countActiveConversations(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM support_conversations WHERE status != 'closed'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 利用者がメッセージを送った */
export async function addUserMessage(db: D1Database, conversationId: number, body: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO support_messages (conversation_id, sender, body) VALUES (?, 'user', ?)")
      .bind(conversationId, body),
    db.prepare(
      `UPDATE support_conversations SET user_unread = user_unread + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(conversationId),
  ]);
}

/** オペレーターが返事をした。返事をした時点で、それまでの利用者のメッセージは読んだことにする */
export async function addOperatorMessage(
  db: D1Database, conversationId: number, operatorEmail: string, body: string,
): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO support_messages (conversation_id, sender, operator_email, body) VALUES (?, 'operator', ?, ?)")
      .bind(conversationId, operatorEmail, body),
    db.prepare(
      `UPDATE support_conversations SET status = 'open', user_unread = 0, updated_at = datetime('now')
       WHERE id = ? AND status != 'closed'`,
    ).bind(conversationId),
  ]);
}

export async function markConversationRead(db: D1Database, conversationId: number): Promise<void> {
  await db.prepare("UPDATE support_conversations SET user_unread = 0 WHERE id = ?").bind(conversationId).run();
}

/** 相談を終える。終わりのお知らせ（system）を残し、利用者の画面にも出す */
export async function closeConversation(db: D1Database, conversationId: number, notice: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO support_messages (conversation_id, sender, body) VALUES (?, 'system', ?)")
      .bind(conversationId, notice),
    db.prepare(
      `UPDATE support_conversations SET status = 'closed', user_unread = 0,
         closed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(conversationId),
  ]);
}

/** id が afterId より大きいメッセージ（古い順）。afterId = 0 なら全部 */
export async function listMessagesAfter(
  db: D1Database, conversationId: number, afterId: number, limit = 200,
): Promise<SupportMessageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, sender, body, created_at FROM support_messages
       WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .bind(conversationId, afterId, limit)
    .all<SupportMessageRow>();
  return results;
}

export async function countUserMessages(db: D1Database, conversationId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND sender = 'user'")
    .bind(conversationId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 管理画面の一覧。続いている相談（新しく動いた順）と、直近に終わった相談 */
export async function listConversations(
  db: D1Database, closedLimit = 20,
): Promise<SupportConversationSummary[]> {
  const select = `
    SELECT c.id, c.status, c.context, c.user_unread, c.created_at, c.updated_at, c.closed_at,
      (SELECT body   FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT sender FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender
    FROM support_conversations c`;
  const [active, closed] = await db.batch<SupportConversationSummary>([
    db.prepare(`${select} WHERE c.status != 'closed' ORDER BY c.updated_at DESC`),
    db.prepare(`${select} WHERE c.status = 'closed' ORDER BY c.closed_at DESC LIMIT ?`).bind(closedLimit),
  ]);
  return [...active.results, ...closed.results];
}

/** 終わってから SUPPORT_RETENTION_DAYS 日を過ぎた相談を消す */
export async function pruneClosedConversations(db: D1Database): Promise<void> {
  const cutoff = `-${SUPPORT_RETENTION_DAYS} days`;
  await db.batch([
    db.prepare(
      `DELETE FROM support_messages WHERE conversation_id IN (
         SELECT id FROM support_conversations WHERE status = 'closed' AND closed_at < datetime('now', ?))`,
    ).bind(cutoff),
    db.prepare("DELETE FROM support_conversations WHERE status = 'closed' AND closed_at < datetime('now', ?)")
      .bind(cutoff),
  ]);
}

// ---- オペレーターの受付状態 ----

export async function touchOperator(db: D1Database, email: string, accepting: boolean | null): Promise<void> {
  if (accepting === null) {
    await db
      .prepare(
        `INSERT INTO support_operators (email) VALUES (?)
         ON CONFLICT(email) DO UPDATE SET last_seen = datetime('now')`,
      )
      .bind(email)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO support_operators (email, accepting) VALUES (?, ?)
       ON CONFLICT(email) DO UPDATE SET accepting = excluded.accepting, last_seen = datetime('now')`,
    )
    .bind(email, accepting ? 1 : 0)
    .run();
}

export async function isOperatorAccepting(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT accepting FROM support_operators WHERE email = ?")
    .bind(email)
    .first<{ accepting: number }>();
  return row?.accepting === 1;
}

/** 受け付けているオペレーターの数（最後の確認が OPERATOR_FRESH_SECONDS 秒以内の人だけ） */
export async function countAcceptingOperators(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM support_operators
       WHERE accepting = 1 AND last_seen >= datetime('now', ?)`,
    )
    .bind(`-${OPERATOR_FRESH_SECONDS} seconds`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
