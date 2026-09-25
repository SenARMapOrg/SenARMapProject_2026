-- 管理画面(/admin)の閲覧記録。誰が・いつ・どこから登録ユーザー一覧を見たか、
-- 管理者でない人が管理画面・管理APIを開こうとしたかを残す。
--
-- user_id は外部キーにしない（ユーザーが退会して users の行が消えても記録は残すため）。
-- 同じ理由で、その時点のメールアドレスも email に控えておく。
-- 保存期間は1年。アプリ側で記録を書くたびに1年より古い行を削除する（functions/api/_lib/db/audit.ts）。
CREATE TABLE admin_audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,   -- 'admin_access' | 'admin_denied' | 'admin_page_denied'
  user_id    INTEGER,
  email      TEXT,
  path       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);
