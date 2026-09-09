// バックエンド(functions/api)へのfetchラッパー。エラー時は ApiError を投げる。

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Me {
  id: number;
  email: string;
  display_name: string;
  nickname: string | null;
  auto_fill_location: boolean;
}

export type Term = "spring" | "fall"; // spring=前期 fall=後期

export interface TimetableEntry {
  id?: number;
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
}

export interface Friend {
  id: number;
  email: string;
  display_name: string;
}

export interface FriendRequest {
  id: number;
  from_user_id: number;
  to_email: string;
  to_user_id: number | null;
  status: "pending" | "accepted";
  created_at: string;
  from_email?: string;
  from_display_name?: string;
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
  async me(): Promise<Me | null> {
    try {
      return await apiFetch<Me>("/api/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },

  logout(): Promise<void> {
    return apiFetch("/api/auth/logout", { method: "POST" });
  },

  deleteAccount(): Promise<void> {
    return apiFetch("/api/me", { method: "DELETE" });
  },

  updateNickname(nickname: string | null): Promise<Me> {
    return apiFetch("/api/me", { method: "PATCH", body: JSON.stringify({ nickname }) });
  },

  updateAutoFillLocation(enabled: boolean): Promise<Me> {
    return apiFetch("/api/me", { method: "PATCH", body: JSON.stringify({ auto_fill_location: enabled }) });
  },

  getLocationSuggestion(
    term: Term, day: number, period: number, courseName: string,
  ): Promise<{ location: string | null }> {
    const params = new URLSearchParams({
      term, day_of_week: String(day), period: String(period), course_name: courseName,
    });
    return apiFetch(`/api/timetable/location-suggestion?${params.toString()}`);
  },

  getTimetable(term: Term): Promise<{ entries: TimetableEntry[] }> {
    return apiFetch(`/api/timetable?term=${term}`);
  },

  putTimetable(term: Term, entries: TimetableEntry[]): Promise<{ entries: TimetableEntry[] }> {
    return apiFetch("/api/timetable", { method: "PUT", body: JSON.stringify({ term, entries }) });
  },

  getFriendTimetable(
    userId: number, term: Term,
  ): Promise<{ user: { id: number; display_name: string }; entries: TimetableEntry[] }> {
    return apiFetch(`/api/timetable/friend/${userId}?term=${term}`);
  },

  listFriends(): Promise<{ friends: Friend[] }> {
    return apiFetch("/api/friends");
  },

  listRequests(): Promise<{ incoming: FriendRequest[]; outgoing: FriendRequest[] }> {
    return apiFetch("/api/friends/requests");
  },

  sendFriendRequest(toEmail: string): Promise<{ status: string }> {
    return apiFetch("/api/friends/requests", { method: "POST", body: JSON.stringify({ to_email: toEmail }) });
  },

  acceptFriendRequest(id: number): Promise<void> {
    return apiFetch(`/api/friends/requests/${id}/accept`, { method: "POST" });
  },

  rejectFriendRequest(id: number): Promise<void> {
    return apiFetch(`/api/friends/requests/${id}/reject`, { method: "POST" });
  },

  unfriend(userId: number): Promise<void> {
    return apiFetch(`/api/friends/${userId}`, { method: "DELETE" });
  },
};
