// 案内係(guide)のCRUDとref_code生成。
import { beforeEach, describe, expect, it } from "vitest";

import {
  createGuide, deleteGuide, findGuideByRefCode, findGuideById, listGuidesWithCounts, resetGuideRecords,
} from "../functions/api/_lib/db";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

let t: TestD1;

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
});

describe("createGuide", () => {
  it("見間違いやすい文字(0/O・1/I)を含まない8文字のref_codeを生成する", async () => {
    const guide = await createGuide(t.db, "正門担当");
    expect(guide.ref_code).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);
    expect(guide.display_name).toBe("正門担当");
  });

  it("同じ名前でも毎回別のref_codeになる", async () => {
    const a = await createGuide(t.db, "正門担当");
    const b = await createGuide(t.db, "正門担当");
    expect(a.ref_code).not.toBe(b.ref_code);
  });
});

describe("findGuideByRefCode / findGuideById", () => {
  it("見つかる・見つからない", async () => {
    const guide = await createGuide(t.db, "東門担当");
    expect((await findGuideByRefCode(t.db, guide.ref_code))?.id).toBe(guide.id);
    expect(await findGuideByRefCode(t.db, "NOPE0000")).toBeNull();
    expect((await findGuideById(t.db, guide.id))?.ref_code).toBe(guide.ref_code);
    expect(await findGuideById(t.db, 9999)).toBeNull();
  });
});

describe("listGuidesWithCounts", () => {
  it("到着・検索それぞれのユニーク端末数を集計する", async () => {
    const guide = await createGuide(t.db, "正門担当");
    const other = await createGuide(t.db, "東門担当");

    // 正門担当: 到着2端末（同じ端末が同日に2回は1人）、検索は1端末から2回（人数としては1）
    t.exec(`
      INSERT INTO arrivals (ref_code, device_id, visit_date) VALUES
        ('${guide.ref_code}', 'device-a', '2026-11-01'),
        ('${guide.ref_code}', 'device-b', '2026-11-01');
      INSERT INTO searches (ref_code, device_id, from_label, to_label) VALUES
        ('${guide.ref_code}', 'device-a', '正門', '生田キャンパス 1号館'),
        ('${guide.ref_code}', 'device-a', '正門', '生田キャンパス 2号館');
    `);

    const rows = await listGuidesWithCounts(t.db);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[guide.id]).toMatchObject({ arrival_count: 2, search_count: 1 });
    expect(byId[other.id]).toMatchObject({ arrival_count: 0, search_count: 0 });
  });
});

describe("deleteGuide / resetGuideRecords", () => {
  it("削除すると案内係と記録の両方が消える（見えない行が残らない）", async () => {
    const guide = await createGuide(t.db, "正門担当");
    t.exec(`
      INSERT INTO arrivals (ref_code, device_id, visit_date) VALUES ('${guide.ref_code}', 'device-a', '2026-11-01');
      INSERT INTO searches (ref_code, device_id, from_label, to_label) VALUES ('${guide.ref_code}', 'device-a', 'a', 'b');
    `);
    await deleteGuide(t.db, guide.id, guide.ref_code);
    expect(await findGuideById(t.db, guide.id)).toBeNull();
    expect(t.query("SELECT COUNT(*) AS n FROM arrivals")[0].n).toBe(0);
    expect(t.query("SELECT COUNT(*) AS n FROM searches")[0].n).toBe(0);
  });

  it("他の案内係の記録は消さない", async () => {
    const guide = await createGuide(t.db, "正門担当");
    const other = await createGuide(t.db, "東門担当");
    t.exec(`
      INSERT INTO arrivals (ref_code, device_id, visit_date) VALUES
        ('${guide.ref_code}', 'device-a', '2026-11-01'),
        ('${other.ref_code}', 'device-a', '2026-11-01');
    `);
    await deleteGuide(t.db, guide.id, guide.ref_code);
    expect(t.query("SELECT ref_code FROM arrivals").map((r) => r.ref_code)).toEqual([other.ref_code]);
  });

  it("リセットすると到着・検索の記録だけが消え、案内係自体は残る", async () => {
    const guide = await createGuide(t.db, "正門担当");
    t.exec(`
      INSERT INTO arrivals (ref_code, device_id, visit_date) VALUES ('${guide.ref_code}', 'device-a', '2026-11-01');
      INSERT INTO searches (ref_code, device_id, from_label, to_label) VALUES ('${guide.ref_code}', 'device-a', 'a', 'b');
    `);
    await resetGuideRecords(t.db, guide.ref_code);
    expect(t.query("SELECT COUNT(*) AS n FROM arrivals")[0].n).toBe(0);
    expect(t.query("SELECT COUNT(*) AS n FROM searches")[0].n).toBe(0);
    expect(await findGuideById(t.db, guide.id)).not.toBeNull();
  });
});
