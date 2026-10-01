// 管理画面の表示用の整形処理（DOMに触れないのでテストから直接呼べる）

import type { AuditEvent } from "./api";

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
