// 管理画面の閲覧記録（admin_audit_log テーブル。migrations/0008 参照）。

export type AuditEvent = "admin_access" | "admin_denied" | "admin_page_denied";

export interface AuditEntry {
  event: AuditEvent;
  user_id: number | null;
  email: string | null;
  path: string;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditLogRow extends AuditEntry {
  id: number;
  created_at: string;
}

/** 保存期間。これより古い記録は、新しい記録を書くたびに削除する */
export const AUDIT_RETENTION_DAYS = 365;

/** User-Agent は長さに上限が無いので、保存前に切り詰める */
const MAX_USER_AGENT_LENGTH = 300;

export async function insertAuditLog(db: D1Database, entry: AuditEntry): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO admin_audit_log (event, user_id, email, path, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      entry.event, entry.user_id, entry.email, entry.path, entry.ip,
      entry.user_agent ? entry.user_agent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    ),
    db.prepare("DELETE FROM admin_audit_log WHERE created_at < datetime('now', ?)")
      .bind(`-${AUDIT_RETENTION_DAYS} days`),
  ]);
}

export async function listRecentAuditLog(db: D1Database, limit: number): Promise<AuditLogRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(limit)
    .all<AuditLogRow>();
  return results ?? [];
}
