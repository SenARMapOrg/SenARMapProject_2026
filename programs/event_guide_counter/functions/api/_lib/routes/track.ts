// IKU NAVI (programs/html/navi/script/track.js) から navigator.sendBeacon で呼ばれる公開API。
// ログイン不要・クロスオリジン（navi側のオリジンから叩かれる）。
//
// sendBeacon はレスポンスを読まないため、エラーでも常に 204 を返す（詳細はログにだけ残す）。
// body は "text/plain" の Blob として送られてくる想定（sendBeaconでJSONのContent-Typeを使うと
// CORSプリフライトが必要になり、プリフライトに応答しないこの公開APIでは失敗するため）。

import { Hono, type Context } from "hono";

import { findGuideByRefCode, insertArrival, insertSearch } from "../db";
import { isAllowedTrackOrigin, isValidDeviceId, isValidRefCode, MAX_TRACK_BODY_BYTES } from "../track-guard";
import type { AppEnv } from "../types";

export const trackRoutes = new Hono<AppEnv>();

const NO_CONTENT = () => new Response(null, { status: 204 });

/**
 * 記録してよいリクエストなら本文のJSONを、そうでなければ null を返す（track-guard.ts 参照）。
 * 許可されていないページからの送信・大きすぎる本文・壊れたJSONは、記録せずに黙って捨てる。
 */
async function readTrackBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  if (!isAllowedTrackOrigin(c.req.header("Origin"), c.req.url, c.env.TRACK_ALLOWED_ORIGINS)) return null;
  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (declaredLength > MAX_TRACK_BODY_BYTES) return null;
  try {
    const text = await c.req.text();
    if (text.length > MAX_TRACK_BODY_BYTES) return null;
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

/** 案内係コードと端末IDを取り出す。形式が違えば null */
function readIds(body: Record<string, unknown> | null): { refCode: string; deviceId: string } | null {
  const refCode = asNonEmptyString(body?.ref, 32);
  const deviceId = asNonEmptyString(body?.deviceId, 64);
  if (!refCode || !deviceId || !isValidRefCode(refCode) || !isValidDeviceId(deviceId)) return null;
  return { refCode, deviceId };
}

trackRoutes.post("/arrival", async (c) => {
  const ids = readIds(await readTrackBody(c));
  if (!ids) return NO_CONTENT();
  const { refCode, deviceId } = ids;

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
  const body = await readTrackBody(c);
  const ids = readIds(body);
  if (!ids) return NO_CONTENT();
  const { refCode, deviceId } = ids;
  const fromLabel = asNonEmptyString(body?.fromLabel, 200) ?? "";
  const toLabel = asNonEmptyString(body?.toLabel, 200) ?? "";

  const guide = await findGuideByRefCode(c.env.DB, refCode);
  if (!guide) return NO_CONTENT();

  try {
    await insertSearch(c.env.DB, refCode, deviceId, fromLabel, toLabel);
  } catch (err) {
    console.error("track/search failed", err);
  }
  return NO_CONTENT();
});
