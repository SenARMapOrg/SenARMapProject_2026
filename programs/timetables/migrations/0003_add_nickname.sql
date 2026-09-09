-- ユーザーが友達に見せる表示名を、Googleアカウントの本名とは別に「あだ名」として設定できるようにする。
-- nickname が NULL の間は従来通り display_name(Google由来の本名)がそのまま使われる。
ALTER TABLE users ADD COLUMN nickname TEXT;
