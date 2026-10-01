// 案内係(guide)のCRUDと、ref_code（QRに埋め込む短いランダム文字列）の生成。

import type { GuideRow, GuideWithCounts } from "../types";

// 0/O・1/I のような見間違いやすい文字を避けた英数字（印刷したQRの下に文字で書いても読み違えにくい）
const REF_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REF_CODE_LENGTH = 8;
const MAX_CREATE_ATTEMPTS = 5;

function generateRefCode(): string {
  const bytes = new Uint8Array(REF_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => REF_CODE_ALPHABET[b % REF_CODE_ALPHABET.length]).join("");
}

/**
 * 案内係を新規作成する。ref_codeはランダム生成なので、ごくまれな重複はリトライする
 * （UNIQUE制約違反を検出して作り直す。REF_CODE_LENGTH=8・33文字の英数字なら
 * 衝突はほぼ起きないが、起きても呼び出し元にエラーを返さないための保険）。
 */
export async function createGuide(db: D1Database, displayName: string): Promise<GuideRow> {
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const refCode = generateRefCode();
    try {
      const result = await db
        .prepare("INSERT INTO guides (ref_code, display_name) VALUES (?, ?) RETURNING *")
        .bind(refCode, displayName)
        .first<GuideRow>();
      if (!result) throw new Error("案内係の作成に失敗しました");
      return result;
    } catch (err) {
      const message = String(err);
      if (attempt < MAX_CREATE_ATTEMPTS - 1 && message.includes("UNIQUE")) continue;
      throw err;
    }
  }
  throw new Error("案内係の作成に失敗しました（ref_codeの生成を繰り返しても衝突しました）");
}

export async function findGuideById(db: D1Database, id: number): Promise<GuideRow | null> {
  const row = await db.prepare("SELECT * FROM guides WHERE id = ?").bind(id).first<GuideRow>();
  return row ?? null;
}

export async function findGuideByRefCode(db: D1Database, refCode: string): Promise<GuideRow | null> {
  const row = await db.prepare("SELECT * FROM guides WHERE ref_code = ?").bind(refCode).first<GuideRow>();
  return row ?? null;
}

/**
 * 案内係一覧を、到着・検索それぞれのユニーク端末数（＝案内した人数）付きで返す。
 * 到着記録(arrivals)はINSERT OR IGNOREで端末×日付の重複をあらかじめ防いでいるが、
 * 検索記録(searches)は全件保存しているため、ここでCOUNT(DISTINCT device_id)で数える
 * （docs/event_guide_counter_plan.md の「検索は全件残して集計で数える」方針）。
 */
export async function listGuidesWithCounts(db: D1Database): Promise<GuideWithCounts[]> {
  const { results } = await db
    .prepare(
      `SELECT g.*,
         (SELECT COUNT(DISTINCT a.device_id) FROM arrivals a WHERE a.ref_code = g.ref_code) AS arrival_count,
         (SELECT COUNT(DISTINCT s.device_id) FROM searches s WHERE s.ref_code = g.ref_code) AS search_count
       FROM guides g
       ORDER BY g.created_at DESC`,
    )
    .all<GuideWithCounts>();
  return results ?? [];
}

/**
 * 案内係を削除する。到着・検索の記録も一緒に消す
 * （arrivals/searches は ref_code で紐づくだけで外部キーを張っていないため、残すと
 * 　どの画面からも見えない行として溜まり続けてしまう）。
 */
export async function deleteGuide(db: D1Database, id: number, refCode: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM arrivals WHERE ref_code = ?").bind(refCode),
    db.prepare("DELETE FROM searches WHERE ref_code = ?").bind(refCode),
    db.prepare("DELETE FROM guides WHERE id = ?").bind(id),
  ]);
}

/** その案内係の到着・検索の記録をすべて削除する（Rails版の「カウントのリセット」に相当） */
export async function resetGuideRecords(db: D1Database, refCode: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM arrivals WHERE ref_code = ?").bind(refCode),
    db.prepare("DELETE FROM searches WHERE ref_code = ?").bind(refCode),
  ]);
}
