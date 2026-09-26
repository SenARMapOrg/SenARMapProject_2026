// セッションIDのハッシュ化（migrations/0009）で、既存のデータが崩れないことの確認。
//
// 本番に近い状態（0001〜0008 を適用し、ユーザー・時間割・公開設定・友達・閲覧記録・
// 古い形式のセッションが入っている）から 0009 を当て、
//   - ログイン状態以外のデータが1バイトも変わらないこと
//   - 古いセッション（生のトークン）ではログインできなくなること（全員一度ログアウト）
//   - ログインし直すと同じユーザーに戻り、自分のデータがそのまま出ること
// を、アプリの db/*.ts をそのまま使って確かめる。
import { beforeEach, describe, expect, it } from "vitest";

import { resolveAdminAccess } from "../functions/api/_lib/admin-access";
import {
  createSession, deleteSession, findValidSession, getSessionCreatedAt, getSnapshotSettings,
  hashSessionToken, listFriends, listMyGrades, listTimetable, upsertUser,
} from "../functions/api/_lib/db";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;
const migrationFiles = Object.keys(migrations).sort();
const before0009 = migrationFiles.filter((f) => !f.includes("0009"));
const m0009 = migrationFiles.find((f) => f.includes("0009"))!;

/** 本番に近いデータ（旧形式＝生のトークンのセッションを含む） */
const SEED = `
INSERT INTO users (id, google_sub, email, display_name, nickname, auto_fill_location, current_grade, faculty, department)
VALUES
  (1, 'sub-alice', 'alice@senshu-u.jp', '専修 花子', 'はなこ', 1, 2, 'ネットワーク情報学部', 'ネットワーク情報学科'),
  (2, 'sub-bob',   'bob@senshu-u.jp',   '生田 太郎', NULL,     0, 1, NULL, NULL);

INSERT INTO timetable_entries (user_id, grade, term, day_of_week, period, course_name, location, instructor) VALUES
  (1, 1, 'spring', 0, 1, '情報システム基礎', '10101教室', '生亀'),
  (1, 1, 'fall',   2, 3, 'プログラミング演習', '10301教室', NULL),
  (1, 2, 'spring', 4, 2, 'General English', 'オンライン', NULL),
  (2, 1, 'spring', 1, 1, '経済学入門', NULL, NULL);

INSERT INTO timetable_snapshot_settings (user_id, grade, term, visibility, share_token) VALUES
  (1, 1, 'spring', 'public', 'sharetoken-alice-1s'),
  (1, 2, 'spring', 'private', NULL);

INSERT INTO friend_requests (from_user_id, to_email, to_user_id, status, resolved_at) VALUES
  (1, 'bob@senshu-u.jp', 2, 'accepted', datetime('now')),
  (2, 'carol@senshu-u.jp', NULL, 'pending', NULL);

INSERT INTO admin_audit_log (event, user_id, email, path, ip, user_agent) VALUES
  ('admin_access', 1, 'alice@senshu-u.jp', '/api/admin/users', '203.0.113.1', 'Mozilla/5.0');

INSERT INTO sessions (id, user_id, expires_at) VALUES
  ('legacy-raw-token-alice', 1, '2099-01-01T00:00:00.000Z'),
  ('legacy-raw-token-bob',   2, '2099-01-01T00:00:00.000Z');
`;

const DATA_TABLES = ["users", "timetable_entries", "timetable_snapshot_settings", "friend_requests", "admin_audit_log"];

function snapshot(t: TestD1): Record<string, unknown[]> {
  return Object.fromEntries(DATA_TABLES.map((table) => [table, t.query(`SELECT * FROM ${table} ORDER BY rowid`)]));
}

let t: TestD1;

beforeEach(async () => {
  t = await createTestD1();
  for (const f of before0009) t.exec(migrations[f]);
  t.exec(SEED);
});

describe("マイグレーション 0009（古いセッションの削除）", () => {
  it("ログイン状態以外のデータは1バイトも変わらない", () => {
    const beforeData = snapshot(t);
    t.exec(migrations[m0009]);
    expect(snapshot(t)).toEqual(beforeData);
  });

  it("古い形式のセッションはすべて消える", () => {
    t.exec(migrations[m0009]);
    expect(t.query("SELECT COUNT(*) AS n FROM sessions")[0].n).toBe(0);
  });

  it("適用前でも、新しいコードは古い形式のセッションを受け付けない（適用順に依存しない）", async () => {
    expect(await findValidSession(t.db, "legacy-raw-token-alice")).toBeNull();
    t.exec(migrations[m0009]);
    expect(await findValidSession(t.db, "legacy-raw-token-alice")).toBeNull();
  });
});

describe("ログインし直すと同じユーザーの同じデータが出る", () => {
  beforeEach(() => t.exec(migrations[m0009]));

  async function relogin(sub: string, email: string, name: string) {
    // auth.ts の callback と同じ流れ（Google の sub でユーザーを探し、セッションを作る）
    const user = await upsertUser(t.db, sub, email, name);
    const session = await createSession(t.db, user.id);
    return { user, token: session.token };
  }

  it("同じユーザーIDに戻り、あだ名・学年・学部学科もそのまま", async () => {
    const { token } = await relogin("sub-alice", "alice@senshu-u.jp", "専修 花子");
    const me = await findValidSession(t.db, token);
    expect(me).toMatchObject({
      id: 1, email: "alice@senshu-u.jp", nickname: "はなこ", current_grade: 2, auto_fill_location: 1,
      faculty: "ネットワーク情報学部", department: "ネットワーク情報学科",
    });
  });

  it("自分の時間割が学年・学期ごとにそのまま出る", async () => {
    const { user } = await relogin("sub-alice", "alice@senshu-u.jp", "専修 花子");
    const pick = (rows: { course_name: string; location: string | null; day_of_week: number; period: number }[]) =>
      rows.map((r) => [r.day_of_week, r.period, r.course_name, r.location]);
    expect(pick(await listTimetable(t.db, user.id, 1, "spring"))).toEqual([[0, 1, "情報システム基礎", "10101教室"]]);
    expect(pick(await listTimetable(t.db, user.id, 1, "fall"))).toEqual([[2, 3, "プログラミング演習", "10301教室"]]);
    expect(pick(await listTimetable(t.db, user.id, 2, "spring"))).toEqual([[4, 2, "General English", "オンライン"]]);
    expect(await listMyGrades(t.db, user.id)).toEqual(expect.arrayContaining([
      { grade: 1, term: "spring" }, { grade: 1, term: "fall" }, { grade: 2, term: "spring" },
    ]));
  });

  it("公開範囲と共有リンクもそのまま", async () => {
    const { user } = await relogin("sub-alice", "alice@senshu-u.jp", "専修 花子");
    expect(await getSnapshotSettings(t.db, user.id, 1, "spring"))
      .toMatchObject({ visibility: "public", share_token: "sharetoken-alice-1s" });
    expect(await getSnapshotSettings(t.db, user.id, 2, "spring")).toMatchObject({ visibility: "private" });
  });

  it("友達関係もそのまま（相手側から見ても）", async () => {
    const alice = await relogin("sub-alice", "alice@senshu-u.jp", "専修 花子");
    const bob = await relogin("sub-bob", "bob@senshu-u.jp", "生田 太郎");
    expect((await listFriends(t.db, alice.user.id)).map((f) => f.email)).toEqual(["bob@senshu-u.jp"]);
    expect((await listFriends(t.db, bob.user.id)).map((f) => f.email)).toEqual(["alice@senshu-u.jp"]);
  });

  it("他人のデータは混ざらない", async () => {
    const { user } = await relogin("sub-bob", "bob@senshu-u.jp", "生田 太郎");
    const rows = await listTimetable(t.db, user.id, 1, "spring");
    expect(rows.map((r) => r.course_name)).toEqual(["経済学入門"]);
  });
});

describe("ハッシュ化したセッション", () => {
  beforeEach(() => t.exec(migrations[m0009]));

  it("DB にはトークンではなく SHA-256 だけが入る", async () => {
    const { token } = await createSession(t.db, 1);
    const stored = t.query("SELECT id FROM sessions")[0].id as string;
    expect(stored).not.toBe(token);
    expect(stored).toBe(await hashSessionToken(token));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("DB に入っている値（ハッシュ）を Cookie に入れてもログインできない", async () => {
    await createSession(t.db, 1);
    const stored = t.query("SELECT id FROM sessions")[0].id as string;
    expect(await findValidSession(t.db, stored)).toBeNull();
  });

  it("ログアウトでそのセッションだけが消える", async () => {
    const a = await createSession(t.db, 1);
    const b = await createSession(t.db, 1);
    await deleteSession(t.db, a.token);
    expect(await findValidSession(t.db, a.token)).toBeNull();
    expect((await findValidSession(t.db, b.token))?.id).toBe(1);
  });

  it("管理画面の「ログインから12時間以内」の判定もハッシュ経由で動く", async () => {
    const { token } = await createSession(t.db, 1);
    expect(await getSessionCreatedAt(t.db, token)).not.toBeNull();
    const access = await resolveAdminAccess(t.db, "alice@senshu-u.jp", token);
    expect(access).toMatchObject({ kind: "admin", fresh: true });
    expect(await resolveAdminAccess(t.db, "alice@senshu-u.jp", "legacy-raw-token-alice"))
      .toEqual({ kind: "anonymous" });
  });

  it("有効期限が切れたセッションは使えない", async () => {
    const { token } = await createSession(t.db, 1);
    t.exec("UPDATE sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute')");
    expect(await findValidSession(t.db, token)).toBeNull();
  });
});
