-- timetable_entries に担当教員名(instructor)を追加する。
-- 「科目名から追加」でシラバスの開講(course_name + instructor + 曜日/時限)から追加した場合のみ
-- 担当教員名を保存する。「時間を指定して追加」の手入力ではNULLのまま（シラバスに紐づかないため）。
--
-- 同じ科目名でも担当教員が違えば別クラス(別教室であることが多い)なのに、教室の自動入力候補
-- (findCommonLocationForCourse)がこれまでcourse_name+曜日+時限+学期だけで照合しており、
-- 別クラスの教室が混ざって提案されてしまう問題があった。instructorも照合条件に加えることで解消する。
-- 既存行(このマイグレーション以前に登録された分)はinstructorがNULLのままになるが、
-- 自動入力候補の照合対象から自然に外れるだけで実害はない。
ALTER TABLE timetable_entries ADD COLUMN instructor TEXT;
