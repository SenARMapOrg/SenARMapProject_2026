// 公開の記録API（/api/track/*）。誰でも送れるAPIなので、記録してよいものだけを記録することを確かめる。
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { trackRoutes } from "../functions/api/_lib/routes/track";
import { isAllowedTrackOrigin, isValidDeviceId, isValidRefCode } from "../functions/api/_lib/track-guard";
import type { AppEnv } from "../functions/api/_lib/types";
import { createTestD1, type TestD1 } from "./helpers/d1-sqlite";

const migrations = import.meta.glob("../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>;

const ALLOWED = "https://iku-navi.net,https://www.iku-navi.net";
const REF = "ABCD2345";
const DEVICE = "0b6f5c1e-3a7d-4f7e-9b1c-2d3e4f5a6b7c";

let t: TestD1;
const app = new Hono<AppEnv>().basePath("/api").route("/track", trackRoutes);

beforeEach(async () => {
  t = await createTestD1();
  for (const file of Object.keys(migrations).sort()) t.exec(migrations[file]);
  t.exec(`INSERT INTO guides (ref_code, display_name) VALUES ('${REF}', '正門担当')`);
});

function send(path: string, body: unknown, headers: Record<string, string> = { Origin: "https://iku-navi.net" }) {
  return app.request(`https://event-guide-counter.iku-navi.net/api/track/${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, { DB: t.db, TRACK_ALLOWED_ORIGINS: ALLOWED } as unknown as AppEnv["Bindings"]);
}

const count = (table: string) => t.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

describe("/api/track/arrival", () => {
  it("IKU NAVI から送られた到着を記録し、同じ端末の2回目は数えない", async () => {
    expect((await send("arrival", { ref: REF, deviceId: DEVICE })).status).toBe(204);
    expect((await send("arrival", { ref: REF, deviceId: DEVICE })).status).toBe(204);
    expect(count("arrivals")).toBe(1);
  });

  it("許可していないページから・Origin の無いリクエストは記録しない（応答は同じ204）", async () => {
    expect((await send("arrival", { ref: REF, deviceId: DEVICE }, { Origin: "https://evil.example" })).status).toBe(204);
    expect((await send("arrival", { ref: REF, deviceId: DEVICE }, {})).status).toBe(204);
    expect(count("arrivals")).toBe(0);
  });

  it("登録されていない案内係コード・形式の違う値・壊れた本文・大きすぎる本文は記録しない", async () => {
    await send("arrival", { ref: "ZZZZ9999", deviceId: DEVICE });
    await send("arrival", { ref: REF, deviceId: "anything-goes" });
    await send("arrival", { ref: `${REF}'--`, deviceId: DEVICE });
    await send("arrival", "{broken");
    await send("arrival", { ref: REF, deviceId: DEVICE, padding: "x".repeat(5000) });
    expect(count("arrivals")).toBe(0);
  });
});

describe("/api/track/search", () => {
  it("出発地・目的地付きで記録する", async () => {
    await send("search", { ref: REF, deviceId: DEVICE, fromLabel: "現在地", toLabel: "焼きそば屋" });
    expect(t.query("SELECT from_label, to_label FROM searches")).toEqual([{ from_label: "現在地", to_label: "焼きそば屋" }]);
  });

  it("許可していないページからは記録しない", async () => {
    await send("search", { ref: REF, deviceId: DEVICE, fromLabel: "a", toLabel: "b" }, { Origin: "https://evil.example" });
    expect(count("searches")).toBe(0);
  });
});

describe("track-guard", () => {
  it("Origin: 許可リストのもの、またはローカル開発どうしだけ通す", () => {
    expect(isAllowedTrackOrigin("https://iku-navi.net", "https://event-guide-counter.iku-navi.net/x", ALLOWED)).toBe(true);
    expect(isAllowedTrackOrigin("https://iku-navi.net.evil.example", "https://event-guide-counter.iku-navi.net/x", ALLOWED)).toBe(false);
    expect(isAllowedTrackOrigin("http://localhost:8000", "https://event-guide-counter.iku-navi.net/x", ALLOWED)).toBe(false);
    expect(isAllowedTrackOrigin("http://localhost:8000", "http://localhost:8788/x", ALLOWED)).toBe(true);
    expect(isAllowedTrackOrigin(null, "http://localhost:8788/x", ALLOWED)).toBe(false);
    expect(isAllowedTrackOrigin("https://iku-navi.net", "https://event-guide-counter.iku-navi.net/x", undefined)).toBe(false);
  });

  it("端末ID・案内係コードの形式", () => {
    expect(isValidDeviceId(DEVICE)).toBe(true);
    expect(isValidDeviceId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidDeviceId("device-a")).toBe(false);
    expect(isValidRefCode(REF)).toBe(true);
    expect(isValidRefCode("ABCD234O")).toBe(false); // O は使わない文字
    expect(isValidRefCode("ABCD23456")).toBe(false);
  });
});
