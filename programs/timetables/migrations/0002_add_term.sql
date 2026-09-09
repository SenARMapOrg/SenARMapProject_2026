-- timetable_entries に前期/後期(term)を追加する。
-- SQLiteはUNIQUE制約の変更をALTER TABLEで直接できないため、テーブルを作り直す。
-- 既存行(このマイグレーション以前に登録された分)は暫定的に 'fall' 扱いにする
-- （2026-09時点の運用開始が後期に近いための便宜上の初期値。誤っていれば本人が入力し直す想定）。

CREATE TABLE timetable_entries_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  term         TEXT NOT NULL DEFAULT 'fall',  -- 'spring'(前期) | 'fall'(後期)
  day_of_week  INTEGER NOT NULL,   -- 0=月 1=火 2=水 3=木 4=金 5=土
  period       INTEGER NOT NULL,   -- 1〜7限
  course_name  TEXT NOT NULL,
  location     TEXT,               -- 任意。教室名など（プライバシー配慮についてはREADME参照）
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, term, day_of_week, period)
);

INSERT INTO timetable_entries_new (id, user_id, term, day_of_week, period, course_name, location, created_at, updated_at)
SELECT id, user_id, 'fall', day_of_week, period, course_name, location, created_at, updated_at
FROM timetable_entries;

DROP TABLE timetable_entries;
ALTER TABLE timetable_entries_new RENAME TO timetable_entries;
