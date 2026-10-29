// 管理画面の表示用の整形処理（DOMに触れないのでテストから直接呼べる）

import type { AuditEvent, SupportStatus } from "./api";

const AUDIT_EVENT_LABELS: Record<AuditEvent, string> = {
  admin_access: "閲覧",
  admin_denied: "拒否",
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

/** 案内係ごとのQR宛先URL（IKU NAVIを直接指す。Railsの/redirectは経由しない） */
export function buildGuideUrl(naviBaseUrl: string, refCode: string): string {
  const base = naviBaseUrl.replace(/\/+$/, "");
  return `${base}/navi/?event=1&ref=${encodeURIComponent(refCode)}`;
}

const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  waiting: "返事待ち",
  open: "対応中",
  closed: "終了",
};

/** 相談の状態の表示名。想定外の値はそのまま出す */
export function supportStatusLabel(status: string): string {
  return SUPPORT_STATUS_LABELS[status as SupportStatus] ?? status;
}

/** D1 の "YYYY-MM-DD HH:MM:SS"(UTC) か ISO 形式を、ミリ秒の時刻にする。読めなければ null */
function parseTime(value: string): number | null {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 利用者が返事を待っている時間（分）。待っていない・読めないときは null */
export function waitingMinutes(waitingSince: string | null | undefined, now: string): number | null {
  if (!waitingSince) return null;
  const since = parseTime(waitingSince);
  const current = parseTime(now);
  if (since === null || current === null) return null;
  return Math.max(0, Math.floor((current - since) / 60000));
}

/** 待ち時間の表示（「1分未満」「5分」「1時間20分」） */
export function formatWaiting(minutes: number): string {
  if (minutes < 1) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

/** 待ち時間の段階（色分け用）。3分以上で注意、10分以上で警告 */
export function waitingLevel(minutes: number): "ok" | "warn" | "alert" {
  if (minutes >= 10) return "alert";
  if (minutes >= 3) return "warn";
  return "ok";
}
