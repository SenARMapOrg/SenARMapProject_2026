export type Bindings = {
  DB: D1Database;
  OAUTH_REDIRECT_URI: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // QRコードの宛先（IKU NAVI本体）のベースURL。例: "https://iku-navi.net"
  NAVI_BASE_URL: string;
  // 管理画面(/admin)にログインできるメールアドレス（カンマ区切り）。未設定なら誰もログインできない。
  // リポジトリには書かず、Cloudflare Pages の環境変数（本番のみ）で設定する。
  ADMIN_EMAILS?: string;
};

export type Variables = {
  adminEmail: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

export interface SessionRow {
  id: string;         // セッショントークンのSHA-256（Cookieに入る生のトークンではない）
  email: string;
  created_at: string;
  expires_at: string;
}

export interface GuideRow {
  id: number;
  ref_code: string;
  display_name: string;
  created_at: string;
}

export interface GuideWithCounts extends GuideRow {
  arrival_count: number;
  search_count: number;
}

export interface SearchRow {
  id: number;
  ref_code: string;
  device_id: string;
  from_label: string;
  to_label: string;
  created_at: string;
}
