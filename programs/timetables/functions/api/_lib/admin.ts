// 管理画面（/admin）のアクセス制御。
//
// 管理者は Cloudflare Pages の環境変数 ADMIN_EMAILS（カンマ区切りのメールアドレス）で決める。
// リポジトリにもブラウザ側のコードにもアドレスは書かない。未設定・空なら誰も管理者にならない
// （設定し忘れたときに全員が見られる、という事故が起きない向きに倒している）。
//
// 管理画面は大学アカウントのメールアドレスと名前を一覧できるため、通常の画面より条件を厳しくする:
//   - 管理者かどうかはサーバー側でだけ判定する（画面の出し分けはおまけで、APIが最後の砦）
//   - 管理者以外・未ログインには API の存在自体を見せない（404 を返す）
//   - セッションは30日有効だが、管理APIはログインから ADMIN_SESSION_MAX_AGE_MS 以内に限る
//     （共用PCにログインしたまま放置されたセッションや、盗まれた古いセッションで見られないように）

export const ADMIN_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12時間

/** ログイン後に戻ってよいパス。オープンリダイレクトを防ぐため、任意の値は受け付けず完全一致で許可する */
const ALLOWED_NEXT_PATHS = new Set(["/admin"]);

/** "a@x.jp, B@x.jp ," → {"a@x.jp", "b@x.jp"} */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const email = part.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

export function isAdminEmail(email: string, adminEmails: Set<string>): boolean {
  return adminEmails.has(email.trim().toLowerCase());
}

/**
 * D1 の datetime('now') 形式（"YYYY-MM-DD HH:MM:SS"、UTC）か ISO 8601 の文字列を Date にする。
 * タイムゾーンが書かれていない値は UTC として扱う。読めなければ null。
 */
export function parseDbTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** セッションが作られてから maxAgeMs 以内か。作成時刻が読めない・未来の時刻になっている場合は新しくないとみなす */
export function isSessionFresh(
  createdAt: string | null | undefined, now: Date, maxAgeMs = ADMIN_SESSION_MAX_AGE_MS,
): boolean {
  const created = parseDbTimestamp(createdAt);
  if (!created) return false;
  const age = now.getTime() - created.getTime();
  return age >= 0 && age <= maxAgeMs;
}

/** ログイン後の戻り先として許可されたパスならそれを、そうでなければ null を返す */
export function sanitizeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  return ALLOWED_NEXT_PATHS.has(next) ? next : null;
}

/**
 * Cookie ヘッダから指定した名前の値を取り出す（Hono の Context が無い場所＝/admin のページ用関数で使う）。
 * 見つからない・壊れている場合は null。
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}
