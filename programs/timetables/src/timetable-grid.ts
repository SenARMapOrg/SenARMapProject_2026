import type { Term, TimetableEntry } from "./api";

export const DAY_LABELS = ["月", "火", "水", "木", "金", "土"];
export const PERIOD_COUNT = 7;
export const TERM_LABELS: Record<Term, string> = { spring: "前期", fall: "後期" };

/** 大学の一般的な年間スケジュール(4〜9月=前期, 10〜3月=後期)から今の学期を推測する。あくまで初期選択のヒント */
export function guessCurrentTerm(date: Date = new Date()): Term {
  const month = date.getMonth() + 1;
  return month >= 4 && month <= 9 ? "spring" : "fall";
}

export type SlotMap = Map<string, { course_name: string; location: string }>;

export function entryKey(day: number, period: number): string {
  return `${day}-${period}`;
}

export function entriesToMap(entries: TimetableEntry[]): Map<string, TimetableEntry> {
  const map = new Map<string, TimetableEntry>();
  for (const e of entries) map.set(entryKey(e.day_of_week, e.period), e);
  return map;
}

/** サーバーから取得した時間割エントリ配列を、登録フォームが直接操作できるMap形式にする */
export function buildSlotMap(entries: TimetableEntry[]): SlotMap {
  const map: SlotMap = new Map();
  for (const e of entries) {
    map.set(entryKey(e.day_of_week, e.period), { course_name: e.course_name, location: e.location ?? "" });
  }
  return map;
}

export function slotMapToEntries(courses: SlotMap): TimetableEntry[] {
  const entries: TimetableEntry[] = [];
  for (const [key, value] of courses) {
    const [dayStr, periodStr] = key.split("-");
    entries.push({
      day_of_week: Number(dayStr),
      period: Number(periodStr),
      course_name: value.course_name,
      location: value.location || null,
    });
  }
  return entries;
}

/** 閲覧専用（友達の時間割表示など）のグリッド */
export function renderReadonlyGrid(container: HTMLElement, entries: TimetableEntry[]): void {
  const table = buildGridTable(entries, null, null);
  container.replaceChildren(table);
}

/**
 * 編集画面用のクリック可能なグリッド。セルをクリックすると onCellClick(day, period) が呼ばれる。
 * クリックしても即座に削除はしない（誤操作防止のため、削除は登録欄の明示的なボタンでのみ行う）。
 * selectedSlot と一致するセルには選択中であることを示すクラスを付ける。
 */
export function renderInteractiveGrid(
  container: HTMLElement,
  entries: TimetableEntry[],
  selectedSlot: { day: number; period: number } | null,
  onCellClick: (day: number, period: number) => void,
): void {
  const table = buildGridTable(entries, selectedSlot, onCellClick);
  container.replaceChildren(table);
}

function buildGridTable(
  entries: TimetableEntry[],
  selectedSlot: { day: number; period: number } | null,
  onCellClick: ((day: number, period: number) => void) | null,
): HTMLTableElement {
  const map = entriesToMap(entries);

  const table = document.createElement("table");
  table.className = onCellClick ? "timetable-grid interactive" : "timetable-grid readonly";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const label of DAY_LABELS) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let period = 1; period <= PERIOD_COUNT; period += 1) {
    const row = document.createElement("tr");
    const periodTh = document.createElement("th");
    periodTh.textContent = `${period}限`;
    row.appendChild(periodTh);

    for (let day = 0; day < DAY_LABELS.length; day += 1) {
      const entry = map.get(entryKey(day, period));
      const td = document.createElement("td");
      if (entry) {
        const courseDiv = document.createElement("div");
        courseDiv.className = "cell-course-label";
        courseDiv.textContent = entry.course_name;
        td.appendChild(courseDiv);
        if (entry.location) {
          const locDiv = document.createElement("div");
          locDiv.className = "cell-location-label";
          locDiv.textContent = entry.location;
          td.appendChild(locDiv);
        }
      } else {
        td.className = "cell-empty";
      }
      if (selectedSlot && selectedSlot.day === day && selectedSlot.period === period) {
        td.classList.add("cell-selected");
      }
      if (onCellClick) {
        td.addEventListener("click", () => onCellClick(day, period));
      }
      row.appendChild(td);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  return table;
}
