-- 鳳祭 案内人数集計 — 初期スキーマ
-- docs/event_guide_counter_plan.md の設計メモに基づく。
--
-- このアプリには「一般ユーザーのログイン」が無く、ログインできるのは管理者（ADMIN_EMAILSに
-- 登録されたメールアドレス）だけなので、timetablesと違って users テーブルは置かない
-- （sessions.email に直接メールアドレスを持つ）。

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,   -- セッションCookieの値のSHA-256ハッシュ（functions/api/_lib/db/token.ts）
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- 案内係。ref_code はQRに埋め込む短いランダム文字列（個人名を含まない）で、display_name との
-- 対応表はこのDB（管理者だけが見られる）にしか持たない。
CREATE TABLE guides (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 到着記録（QRを読んでIKU NAVIのページが実際に開いた回数）。
-- visit_date はJST基準の "YYYY-MM-DD"（アプリ側で算出してINSERTする。サーバーのTZには依存しない）。
-- 「案内係 × 端末ID × 日付」で1人と数えるため、同じ組み合わせの行は1件だけに制限する
-- （INSERT OR IGNOREで防ぐ。plan.mdの「到着はユニーク制約」方針）。
CREATE TABLE arrivals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ref_code, device_id, visit_date)
);
CREATE INDEX idx_arrivals_ref_code ON arrivals(ref_code);

-- 検索記録（実際にルート検索まで進んだ記録）。ユニーク制約は付けない（全件保存）。
-- 人数の集計は COUNT(DISTINCT device_id) で行う（plan.mdの「検索は全件残して集計で数える」方針）。
CREATE TABLE searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_code   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  from_label TEXT NOT NULL,
  to_label   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_searches_ref_code ON searches(ref_code);

-- 管理画面(/admin)の閲覧記録（timetablesのadmin_audit_logと同じ発想）。
-- 保存期間は当面決めておらず、自動削除（prune）は実装しない。
CREATE TABLE admin_audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,   -- 'admin_access' | 'admin_denied'
  email      TEXT,
  path       TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log(created_at);
