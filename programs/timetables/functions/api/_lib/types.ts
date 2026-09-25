export type Bindings = {
  DB: D1Database;
  ALLOWED_EMAIL_DOMAIN: string;
  OAUTH_REDIRECT_URI: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // 管理画面(/admin)を見られるメールアドレス（カンマ区切り）。未設定なら誰も見られない。
  // リポジトリには書かず、Cloudflare Pages の環境変数（本番のみ）で設定する。
  ADMIN_EMAILS?: string;
};

export type Variables = {
  user: UserRow;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  display_name: string;
  nickname: string | null;
  auto_fill_location: number; // SQLiteはbooleanを持たないため0/1
  current_grade: number; // 「今」の学年。ナビ機能(今日・次の授業表示)が見る学年
  faculty: string | null;    // 自己申告制。「みんなの時間割を探す」の絞り込みに使う
  department: string | null; // 同上
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export type Term = "spring" | "fall"; // spring=前期 fall=後期

export interface TimetableEntryRow {
  id: number;
  user_id: number;
  grade: number; // 1年次=1, 2年次=2, ...
  term: Term;
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
  instructor: string | null; // 「科目名から追加」でシラバスから追加した場合のみ入る。手入力ではNULL
  created_at: string;
  updated_at: string;
}

/**
 * 時間割スナップショット(学年+学期)の公開範囲。
 * private: 自分だけ / friends: 承認済みの友達のみ(既定) / link: 共有リンクを知っている人のみ
 * （一覧には出ない・閲覧にはログインが必要） / public: 「みんなの時間割を探す」一覧にも表示される
 */
export type Visibility = "private" | "friends" | "link" | "public";

export interface SnapshotSettingsRow {
  user_id: number;
  grade: number;
  term: Term;
  visibility: Visibility;
  share_token: string | null;
  updated_at: string;
}

export interface FriendRequestRow {
  id: number;
  from_user_id: number;
  to_email: string;
  to_user_id: number | null;
  status: "pending" | "accepted";
  created_at: string;
  resolved_at: string | null;
}
