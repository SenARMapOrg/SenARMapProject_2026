-- 相談窓口（オペレーターとのチャット）。docs/help_chat.md の「オペレーターにつなぐ」参照。
--
-- 利用者はログインしないので、相談ごとにランダムなトークンを発行して利用者の端末に持たせ、
-- ここにはそのハッシュ（token_hash）だけを保存する（sessions.id と同じ考え方。db/token.ts）。
-- status: 'waiting'（オペレーターの返事待ち）| 'open'（オペレーターが返事をした）| 'closed'（終了）
CREATE TABLE support_conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'waiting',
  context        TEXT NOT NULL DEFAULT '',   -- つなぐ前に AI とやりとりした内容（オペレーターが読むため）
  user_unread    INTEGER NOT NULL DEFAULT 0,  -- オペレーターがまだ読んでいない利用者のメッセージの数
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT
);
CREATE INDEX idx_support_conversations_status ON support_conversations(status, updated_at);

-- sender: 'user' | 'operator' | 'system'（「オペレーターが対応を終了しました」などのお知らせ）
CREATE TABLE support_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL,
  operator_email  TEXT,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_support_messages_conversation ON support_messages(conversation_id, id);

-- オペレーターの受付状態。管理画面の「相談窓口」を開いて「受け付ける」にしている間、
-- 数秒ごとに last_seen を更新する。accepting = 1 かつ last_seen が新しい人が1人でもいれば、
-- 利用者の画面に「オペレーターにつなぐ」を出す。
CREATE TABLE support_operators (
  email     TEXT PRIMARY KEY,
  accepting INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
