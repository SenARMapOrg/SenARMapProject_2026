// IKU NAVI (programs/html/navi/script/track.js) から navigator.sendBeacon で呼ばれる公開API。
// ログイン不要・クロスオリジン（navi側のオリジンから叩かれる）。
//
// sendBeacon はレスポンスを読まないため、エラーでも常に 204 を返す（詳細はログにだけ残す）。
// body は "text/plain" の Blob として送られてくる想定（sendBeaconでJSONのContent-Typeを使うと
// CORSプリフライトが必要になり、プリフライトに応答しないこの公開APIでは失敗するため）。

import { Hono } from "hono";

import { findGuideByRefCode, insertArrival, insertSearch } from "../db";
import type { AppEnv } from "../types";

export const trackRoutes = new Hono<AppEnv>();

const NO_CONTENT = () => new Response(null, { status: 204 });

async function readJsonBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown> | null> {
  try {
    const text = await c.req.text();
    const data = JSON.parse(text);
    return typeof data === "object" && data !== null ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asNonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

trackRoutes.post("/arrival", async (c) => {
  const body = await readJsonBody(c);
  const refCode = asNonEmptyString(body?.ref, 32);
  const deviceId = asNonEmptyString(body?.deviceId, 64);
  if (!refCode || !deviceId) return NO_CONTENT();

  const guide = await findGuideByRefCode(c.env.DB, refCode);
  if (!guide) return NO_CONTENT(); // 未登録・削除済みのref_codeは静かに無視する

  try {
    await insertArrival(c.env.DB, refCode, deviceId);
  } catch (err) {
    console.error("track/arrival failed", err);
  }
  return NO_CONTENT();
});

trackRoutes.post("/search", async (c) => {
  const body = await readJsonBody(c);
  const refCode = asNonEmptyString(body?.ref, 32);
  const deviceId = asNonEmptyString(body?.deviceId, 64);
  const fromLabel = asNonEmptyString(body?.fromLabel, 200) ?? "";
  const toLabel = asNonEmptyString(body?.toLabel, 200) ?? "";
  if (!refCode || !deviceId) return NO_CONTENT();

  const guide = await findGuideByRefCode(c.env.DB, refCode);
  if (!guide) return NO_CONTENT();

  try {
    await insertSearch(c.env.DB, refCode, deviceId, fromLabel, toLabel);
  } catch (err) {
    console.error("track/search failed", err);
  }
  return NO_CONTENT();
});
