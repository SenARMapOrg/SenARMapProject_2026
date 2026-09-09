-- 科目名から追加する際に、他の学生が同じ授業(同じ曜日・時限・学期)に登録した教室があれば
-- 自動で入力するかどうかのユーザー設定。デフォルトは無効(0)にし、有効化はユーザー自身の選択に委ねる。
ALTER TABLE users ADD COLUMN auto_fill_location INTEGER NOT NULL DEFAULT 0;
