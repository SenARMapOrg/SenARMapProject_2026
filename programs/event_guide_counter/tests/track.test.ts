// 到着(arrivals)・検索(searches)イベントの記録。
import { beforeEach, describe, expect, it } from "vitest";

import { insertArrival, insertSearch, jstDateString, listSearchesForGuide } from "../functions/api/_lib/db";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

let t: TestD1;

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
  t.exec("INSERT INTO guides (ref_code, display_name) VALUES ('REF00001', '正門担当')");
});

describe("jstDateString", () => {
  it("UTCの日付が変わる前後でも日本時間の日付にする", () => {
    // UTC 2026-11-01 15:00 = JST 2026-11-02 00:00（日付が変わった直後）
    expect(jstDateString(new Date("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
    // UTC 2026-11-01 14:59 = JST 2026-11-01 23:59（日付が変わる直前）
    expect(jstDateString(new Date("2026-11-01T14:59:00Z"))).toBe("2026-11-01");
  });
});

describe("insertArrival", () => {
  it("同じ案内係×端末×日付は1件のまま（INSERT OR IGNORE）", async () => {
    const now = new Date("2026-11-01T06:00:00Z");
    await insertArrival(t.db, "REF00001", "device-a", now);
    await insertArrival(t.db, "REF00001", "device-a", now);
    await insertArrival(t.db, "REF00001", "device-a", new Date("2026-11-01T08:00:00Z"));
    expect(t.query("SELECT COUNT(*) AS n FROM arrivals")[0].n).toBe(1);
  });

  it("日付が変わればもう1件追加できる（1人が別日に来たら別カウント）", async () => {
    await insertArrival(t.db, "REF00001", "device-a", new Date("2026-11-01T06:00:00Z"));
    await insertArrival(t.db, "REF00001", "device-a", new Date("2026-11-02T06:00:00Z"));
    expect(t.query("SELECT COUNT(*) AS n FROM arrivals")[0].n).toBe(2);
  });

  it("端末が違えば同日でも別カウント", async () => {
    const now = new Date("2026-11-01T06:00:00Z");
    await insertArrival(t.db, "REF00001", "device-a", now);
    await insertArrival(t.db, "REF00001", "device-b", now);
    expect(t.query("SELECT COUNT(*) AS n FROM arrivals")[0].n).toBe(2);
  });
});

describe("insertSearch / listSearchesForGuide", () => {
  it("重複排除せず全件保存し、新しい順に返す", async () => {
    await insertSearch(t.db, "REF00001", "device-a", "正門", "1号館");
    await insertSearch(t.db, "REF00001", "device-a", "正門", "2号館");
    const rows = await listSearchesForGuide(t.db, "REF00001", 10);
    expect(rows.map((r) => r.to_label)).toEqual(["2号館", "1号館"]);
  });

  it("長すぎるラベルは切り詰める", async () => {
    await insertSearch(t.db, "REF00001", "device-a", "a".repeat(500), "b".repeat(500));
    const rows = await listSearchesForGuide(t.db, "REF00001", 10);
    expect(rows[0].from_label.length).toBe(200);
    expect(rows[0].to_label.length).toBe(200);
  });
});
