// 時間割スナップショット（学年×学期）のメモリキャッシュと保存。
//
// 学年・学期を切り替えるたびにサーバーへ取りに行くのではなく、一度取得したものは
// `${grade}-${term}` キーで持ち回す（保存時は最新のレスポンスで上書きする）。
// 追加・削除のたびに毎回即保存すると連続操作中に無駄なPUTが増えるので、
// scheduleAutoSave() で少し間引いてからまとめて保存する。

import { api, ApiError, type Term } from "./api";
import { buildSlotMap, gradeLabel, slotMapToEntries, type SlotMap } from "./timetable-grid";

const TERMS: Term[] = ["spring", "fall"];
const AUTO_SAVE_DEBOUNCE_MS = 600;

export interface SaveResult {
  ok: boolean;
  message: string;
}

function snapshotKey(grade: number, term: Term): string {
  return `${grade}-${term}`;
}

export function createSnapshotStore(onSaved: (grade: number, result: SaveResult) => void) {
  const slotsByKey: Record<string, SlotMap> = {};
  // 間引いている間に複数の学年をまたいで編集された場合に備え、保存待ちの学年を集合で持つ
  const dirtyGrades = new Set<number>();
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function slots(grade: number, term: Term): SlotMap {
    return slotsByKey[snapshotKey(grade, term)] ?? new Map();
  }

  /** 未取得ならサーバーから読み込む。取得済みなら何もしない */
  async function ensureLoaded(grade: number, term: Term): Promise<void> {
    const key = snapshotKey(grade, term);
    if (slotsByKey[key]) return;
    const res = await api.getTimetable(grade, term);
    slotsByKey[key] = buildSlotMap(res.entries);
  }

  /** 書き換え用に（無ければ空の）SlotMapを用意して返す */
  function mutableSlots(grade: number, term: Term): SlotMap {
    const key = snapshotKey(grade, term);
    const map = slotsByKey[key] ?? new Map();
    slotsByKey[key] = map;
    return map;
  }

  /** 学年の付け替え。キャッシュ上のキーを移し替えるだけで、サーバーへの反映は呼び出し側の責任 */
  function moveGrade(fromGrade: number, toGrade: number): void {
    for (const term of TERMS) {
      const moved = slotsByKey[snapshotKey(fromGrade, term)];
      delete slotsByKey[snapshotKey(fromGrade, term)];
      if (moved) slotsByKey[snapshotKey(toGrade, term)] = moved;
    }
  }

  /**
   * 指定した学年の前期・後期をまとめて保存する。追加・削除のたびに自動保存
   * （scheduleAutoSave）される他、保存ボタンからも即時呼び出される
   * （保存し忘れによる編集内容のロストを防ぐため、手動保存を必須にしない）。
   */
  async function save(grade: number): Promise<SaveResult> {
    let result: SaveResult;
    try {
      const [springRes, fallRes] = await Promise.all(
        TERMS.map((term) => api.putTimetable(grade, term, slotMapToEntries(slots(grade, term)))),
      );
      slotsByKey[snapshotKey(grade, "spring")] = buildSlotMap(springRes.entries);
      slotsByKey[snapshotKey(grade, "fall")] = buildSlotMap(fallRes.entries);
      result = { ok: true, message: `${gradeLabel(grade)}の前期・後期どちらも保存しました` };
    } catch (err) {
      result = { ok: false, message: err instanceof ApiError ? err.message : "保存に失敗しました" };
    }
    onSaved(grade, result);
    return result;
  }

  function scheduleAutoSave(grade: number): void {
    dirtyGrades.add(grade);
    if (autoSaveTimer !== null) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      const grades = [...dirtyGrades];
      dirtyGrades.clear();
      for (const g of grades) void save(g);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  return { slots, ensureLoaded, mutableSlots, moveGrade, save, scheduleAutoSave };
}

export type SnapshotStore = ReturnType<typeof createSnapshotStore>;
