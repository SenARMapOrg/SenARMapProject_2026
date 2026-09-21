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
  current_grade: number;
  faculty: string | null;
  department: string | null;
}

export type Term = "spring" | "fall"; // spring=前期 fall=後期

/**
 * 時間割スナップショット(学年+学期)の公開範囲。
 * private: 自分だけ / friends: 承認済みの友達のみ(既定) / link: 共有リンクを知っている人のみ
 * （一覧には出ない・閲覧にはログインが必要） / public: 「みんなの時間割を探す」一覧にも表示される
 */
export type Visibility = "private" | "friends" | "link" | "public";

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "非公開", friends: "友達のみ", link: "リンク限定", public: "公開",
};

export interface SnapshotSettings {
  grade: number;
  term: Term;
  visibility: Visibility;
  share_url: string | null;
}

export interface PublicSnapshot {
  user_id: number;
  display_name: string;
  grade: number;
  term: Term;
  faculty: string | null;
  department: string | null;
}

export interface TimetableEntry {
  id?: number;
  day_of_week: number;
  period: number;
  course_name: string;
  location: string | null;
  instructor: string | null;
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

  updateProfile(
    patch: { faculty?: string | null; department?: string | null; current_grade?: number },
  ): Promise<Me> {
    return apiFetch("/api/me", { method: "PATCH", body: JSON.stringify(patch) });
  },

  getLocationSuggestion(
    term: Term, day: number, period: number, courseName: string, instructor: string | null,
  ): Promise<{ location: string | null }> {
    const params = new URLSearchParams({
      term, day_of_week: String(day), period: String(period), course_name: courseName,
    });
    if (instructor) params.set("instructor", instructor);
    return apiFetch(`/api/timetable/location-suggestion?${params.toString()}`);
  },

  getTimetable(grade: number, term: Term): Promise<{ entries: TimetableEntry[] }> {
    return apiFetch(`/api/timetable?grade=${grade}&term=${term}`);
  },

  putTimetable(
    grade: number, term: Term, entries: TimetableEntry[],
  ): Promise<{ entries: TimetableEntry[] }> {
    return apiFetch("/api/timetable", { method: "PUT", body: JSON.stringify({ grade, term, entries }) });
  },

  /** 自分が時間割を登録済みの(学年, 学期)一覧。「学年タブ」に何を並べるかに使う */
  listMyGrades(): Promise<{ grades: { grade: number; term: Term }[] }> {
    return apiFetch("/api/timetable/grades");
  },

  /** 学年タブを付け替える（前期・後期・公開設定ごと丸ごと別の学年番号に移動する） */
  changeGrade(
    fromGrade: number, toGrade: number,
  ): Promise<{ from_grade: number; to_grade: number; current_grade: number }> {
    return apiFetch("/api/timetable/grade", {
      method: "PUT", body: JSON.stringify({ from_grade: fromGrade, to_grade: toGrade }),
    });
  },

  getSnapshotSettings(grade: number, term: Term): Promise<SnapshotSettings> {
    return apiFetch(`/api/timetable/visibility?grade=${grade}&term=${term}`);
  },

  updateSnapshotSettings(grade: number, term: Term, visibility: Visibility): Promise<SnapshotSettings> {
    return apiFetch("/api/timetable/visibility", {
      method: "PUT", body: JSON.stringify({ grade, term, visibility }),
    });
  },

  /** 他ユーザーの(学年, 学期)スナップショットを閲覧する（友達 or 公開設定の場合のみサーバー側で許可される） */
  viewUserTimetable(
    userId: number, grade: number, term: Term,
  ): Promise<{ user: { id: number; display_name: string }; grade: number; term: Term; entries: TimetableEntry[] }> {
    return apiFetch(`/api/timetable/view/${userId}?grade=${grade}&term=${term}`);
  },

  /** 共有リンク（?shared=token）経由での閲覧 */
  viewSharedTimetable(
    token: string,
  ): Promise<{ user: { id: number; display_name: string }; grade: number; term: Term; entries: TimetableEntry[] }> {
    return apiFetch(`/api/timetable/shared/${encodeURIComponent(token)}`);
  },

  /** 「みんなの時間割を探す」。フィルタはすべて任意 */
  listPublicSnapshots(
    filters: { grade?: number; term?: Term; faculty?: string; department?: string },
  ): Promise<{ snapshots: PublicSnapshot[] }> {
    const params = new URLSearchParams();
    if (filters.grade !== undefined) params.set("grade", String(filters.grade));
    if (filters.term) params.set("term", filters.term);
    if (filters.faculty) params.set("faculty", filters.faculty);
    if (filters.department) params.set("department", filters.department);
    const qs = params.toString();
    return apiFetch(`/api/timetable/public${qs ? `?${qs}` : ""}`);
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
