-- timetable_entries に学年(grade)を追加し、過去の学年の時間割も別スナップショットとして
-- 登録できるようにする。UNIQUE制約の変更はSQLiteでALTER TABLEできないため、
-- 0002_add_term.sql と同じ「新テーブル作成→コピー→旧テーブルDROP→リネーム」方式で行う。
-- 既存行は暫定的に grade=1 にする（0002がtermを暫定'fall'にした前例と同じ考え方。
-- 誤っていれば本人が学年別UIで登録し直す想定）。

CREATE TABLE timetable_entries_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grade        INTEGER NOT NULL DEFAULT 1,   -- 1年次=1, 2年次=2, ...
  term         TEXT NOT NULL DEFAULT 'fall', -- 'spring'(前期) | 'fall'(後期)
  day_of_week  INTEGER NOT NULL,   -- 0=月 1=火 2=水 3=木 4=金 5=土
  period       INTEGER NOT NULL,   -- 1〜7限
  course_name  TEXT NOT NULL,
  location     TEXT,               -- 任意。教室名など（プライバシー配慮についてはREADME参照）
  instructor   TEXT,               -- 「科目名から追加」でシラバスから追加した場合のみ入る
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, grade, term, day_of_week, period)
);

INSERT INTO timetable_entries_new
  (id, user_id, grade, term, day_of_week, period, course_name, location, instructor, created_at, updated_at)
SELECT id, user_id, 1, term, day_of_week, period, course_name, location, instructor, created_at, updated_at
FROM timetable_entries;

DROP TABLE timetable_entries;
ALTER TABLE timetable_entries_new RENAME TO timetable_entries;

-- 「今」の学年。ナビ機能(今日・次の授業表示)は表示中に選んでいる学年とは独立に、常にこれを見る。
ALTER TABLE users ADD COLUMN current_grade INTEGER NOT NULL DEFAULT 1;
