// 管理画面(/admin)の表示用の型と整形処理（DOM に触れないのでテストから直接呼べる）

export interface AdminUser {
  id: number;
  email: string;
  display_name: string;
  nickname: string | null;
  faculty: string | null;
  department: string | null;
  current_grade: number;
  created_at: string;
  last_login_at: string | null;
  entry_count: number;
  grade_count: number;
}

export interface AdminUsersResponse {
  summary: { total_users: number; total_entries: number; users_with_entries: number };
  users: AdminUser[];
}

export type AuditEvent = "admin_access" | "admin_denied" | "admin_page_denied";

export interface AuditLogEntry {
  id: number;
  event: AuditEvent;
  user_id: number | null;
  email: string | null;
  path: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

const AUDIT_EVENT_LABELS: Record<AuditEvent, string> = {
  admin_access: "閲覧",
  admin_denied: "拒否（管理API）",
  admin_page_denied: "拒否（管理画面→トップへ）",
};

/** 閲覧記録の種類の表示名。想定外の値はそのまま出す */
export function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event as AuditEvent] ?? event;
}

/** D1 の "YYYY-MM-DD HH:MM:SS"(UTC) を日本時間の表示にする */
export function formatDbTime(value: string | null): string {
  if (!value) return "—";
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

/** 検索欄に入れた文字列が、メール・名前・あだ名・学部学科のどれかに含まれるか */
export function matchesFilter(user: AdminUser, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [user.email, user.display_name, user.nickname, user.faculty, user.department]
    .some((v) => (v ?? "").toLowerCase().includes(q));
}
