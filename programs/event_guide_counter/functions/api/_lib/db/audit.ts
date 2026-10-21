// 管理画面の閲覧記録（admin_audit_log テーブル。migrations/0001_init.sql 参照）。
//
// timetablesの同名ファイルと違い、保存期間はまだ決めていないため自動削除（prune）は実装しない
// （docs/event_guide_counter_plan.md の「未定: 記録の保存期間」。必要になったら
// DELETE FROM admin_audit_log WHERE created_at < ... を足すだけで対応できる）。

export type AuditEvent = "admin_access" | "admin_denied";

export interface AuditEntry {
  event: AuditEvent;
  email: string | null;
  path: string;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditLogRow extends AuditEntry {
  id: number;
  created_at: string;
}

/** User-Agent は長さに上限が無いので、保存前に切り詰める */
const MAX_USER_AGENT_LENGTH = 300;

export async function insertAuditLog(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (event, email, path, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.event, entry.email, entry.path, entry.ip,
      entry.user_agent ? entry.user_agent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    )
    .run();
}

export async function listRecentAuditLog(db: D1Database, limit: number): Promise<AuditLogRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(limit)
    .all<AuditLogRow>();
  return results ?? [];
}
