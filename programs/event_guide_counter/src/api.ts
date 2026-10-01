// バックエンド(functions/api)へのfetchラッパー。エラー時は ApiError を投げる。

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Guide {
  id: number;
  ref_code: string;
  display_name: string;
  created_at: string;
  arrival_count: number;
  search_count: number;
}

export interface GuidesResponse {
  guides: Guide[];
  navi_base_url: string;
  admin_email: string;
}

export interface SearchLogEntry {
  id: number;
  device_id: string;
  from_label: string;
  to_label: string;
  created_at: string;
}

export type AuditEvent = "admin_access" | "admin_denied";

export interface AuditLogEntry {
  id: number;
  event: AuditEvent;
  email: string | null;
  path: string;
  ip: string | null;
  created_at: string;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && typeof data === "object" && "error" in data)
      ? String((data as { error: unknown }).error)
      : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  logout(): Promise<void> {
    return apiFetch("/api/auth/logout", { method: "POST" });
  },

  listGuides(): Promise<GuidesResponse> {
    return apiFetch("/api/admin/guides");
  },

  createGuide(displayName: string): Promise<{ guide: Guide }> {
    return apiFetch("/api/admin/guides", { method: "POST", body: JSON.stringify({ display_name: displayName }) });
  },

  deleteGuide(id: number): Promise<void> {
    return apiFetch(`/api/admin/guides/${id}`, { method: "DELETE" });
  },

  resetGuide(id: number): Promise<void> {
    return apiFetch(`/api/admin/guides/${id}/reset`, { method: "POST" });
  },

  listGuideSearches(id: number): Promise<{ searches: SearchLogEntry[] }> {
    return apiFetch(`/api/admin/guides/${id}/searches`);
  },

  listAuditLog(): Promise<{ entries: AuditLogEntry[] }> {
    return apiFetch("/api/admin/audit-log");
  },
};
