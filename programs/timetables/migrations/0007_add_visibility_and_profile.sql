-- 時間割スナップショット(学年+学期)ごとの公開範囲設定。
-- 行が存在しないスナップショットは既定 'friends' として扱う（アプリ側のロジックで解釈する。
-- 全スナップショットに先回りして行を作る必要はなく、公開範囲を明示的に変更した時だけ upsert する）。
--
-- share_token は visibility が 'link' または 'public' になった時だけ生成し、
-- 'private'/'friends' に戻したらNULLに戻す（トークンの存在＝共有リンクが有効、という
-- 不変条件にする。アプリ側で維持する）。
CREATE TABLE timetable_snapshot_settings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grade       INTEGER NOT NULL,
  term        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'friends', -- 'private' | 'friends' | 'link' | 'public'
  share_token TEXT UNIQUE,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, grade, term)
);
CREATE INDEX idx_snapshot_settings_token  ON timetable_snapshot_settings(share_token);
CREATE INDEX idx_snapshot_settings_public ON timetable_snapshot_settings(visibility);

-- 「みんなの時間割を探す」の学部・学科フィルタ用。自己申告制（Googleアカウント情報には無いため）。
ALTER TABLE users ADD COLUMN faculty TEXT;
ALTER TABLE users ADD COLUMN department TEXT;
