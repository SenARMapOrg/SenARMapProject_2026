export type Bindings = {
  DB: D1Database;
  ALLOWED_EMAIL_DOMAIN: string;
  OAUTH_REDIRECT_URI: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
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
  term: Term;
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
  instructor: string | null; // 「科目名から追加」でシラバスから追加した場合のみ入る。手入力ではNULL
  created_at: string;
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
