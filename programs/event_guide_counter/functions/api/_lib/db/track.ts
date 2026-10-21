// 到着(arrivals)・検索(searches)イベントの記録。routes/track.ts（公開API）から呼ばれる。

import type { SearchRow } from "../types";

const MAX_LABEL_LENGTH = 200;

// JST基準の "YYYY-MM-DD"。サーバー(Workers)はUTCで動くため、timeZone指定で明示的に求める。
// ロケール名に形式を任せず（"en-CA" が "YYYY-MM-DD" を返すかはICUの版に依る）、部品を取り出して組む。
const JST_DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
});

export function jstDateString(now: Date): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of JST_DATE_PARTS.formatToParts(now)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function truncateLabel(label: string): string {
  return label.slice(0, MAX_LABEL_LENGTH);
}

/**
 * 到着記録を追加する。「案内係 × 端末ID × 日付」の組み合わせがすでにあれば何もしない
 * （INSERT OR IGNORE。arrivals.UNIQUE(ref_code, device_id, visit_date)に委ねる）。
 */
export async function insertArrival(
  db: D1Database, refCode: string, deviceId: string, now: Date = new Date(),
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO arrivals (ref_code, device_id, visit_date) VALUES (?, ?, ?)")
    .bind(refCode, deviceId, jstDateString(now))
    .run();
}

/** 検索記録を追加する。全件保存する（重複排除しない。集計時にCOUNT(DISTINCT device_id)で数える） */
export async function insertSearch(
  db: D1Database, refCode: string, deviceId: string, fromLabel: string, toLabel: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO searches (ref_code, device_id, from_label, to_label) VALUES (?, ?, ?, ?)")
    .bind(refCode, deviceId, truncateLabel(fromLabel), truncateLabel(toLabel))
    .run();
}

export async function listSearchesForGuide(db: D1Database, refCode: string, limit: number): Promise<SearchRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM searches WHERE ref_code = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(refCode, limit)
    .all<SearchRow>();
  return results ?? [];
}
