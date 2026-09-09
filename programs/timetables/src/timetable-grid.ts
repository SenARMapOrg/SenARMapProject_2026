import type { Term, TimetableEntry } from "./api";

export const DAY_LABELS = ["月", "火", "水", "木", "金", "土"];
export const PERIOD_COUNT = 7;
export const TERM_LABELS: Record<Term, string> = { spring: "前期", fall: "後期" };

/** 土曜日の曜日インデックス（DAY_LABELS の並びに対応）。土曜は5限までしかない */
export const SATURDAY_DAY_INDEX = 5;
export const SATURDAY_MAX_PERIOD = 4;

export interface PeriodTime { start: string; end: string } // "HH:MM"

/** 大学の時限表。5〜7限は月〜金のみ（土曜はSATURDAY_MAX_PERIODまで） */
export const PERIOD_TIMES: Record<number, PeriodTime> = {
  1: { start: "09:00", end: "10:30" },
  2: { start: "10:45", end: "12:15" },
  3: { start: "13:05", end: "14:35" },
  4: { start: "14:50", end: "16:20" },
  5: { start: "16:35", end: "18:05" },
  6: { start: "18:15", end: "19:45" },
  7: { start: "19:55", end: "21:25" },
};

/** その曜日・時限に、そもそもコマが存在するか（土曜の5〜7限は存在しない） */
export function isPeriodAvailable(day: number, period: number): boolean {
  return day !== SATURDAY_DAY_INDEX || period <= SATURDAY_MAX_PERIOD;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export interface NowInfo {
  todayIndex: number | null;    // 0=月...5=土。日曜はnull（授業日ではない）
  currentPeriod: number | null; // 今の時刻がその時限の時間内であれば、その時限番号
  nextPeriod: number | null;    // 本日の残り時限のうち、開始時刻が最も近い未来の時限
}

/** 現在時刻から「今日は何曜日か」「今は何限か」「次は何限か」を求める。グリッドの今日・現在時刻ハイライトに使う */
export function getNowInfo(date: Date = new Date()): NowInfo {
  const jsDay = date.getDay(); // 0=日 1=月 ... 6=土
  const todayIndex = jsDay === 0 ? null : jsDay - 1; // 0=月...5=土
  const nowMinutes = date.getHours() * 60 + date.getMinutes();

  let currentPeriod: number | null = null;
  let nextPeriod: number | null = null;
  if (todayIndex !== null) {
    for (let p = 1; p <= PERIOD_COUNT; p += 1) {
      if (!isPeriodAvailable(todayIndex, p)) continue;
      const { start, end } = PERIOD_TIMES[p];
      const startMin = toMinutes(start);
      const endMin = toMinutes(end);
      if (nowMinutes >= startMin && nowMinutes <= endMin) currentPeriod = p;
      if (nextPeriod === null && nowMinutes < startMin) nextPeriod = p;
    }
  }
  return { todayIndex, currentPeriod, nextPeriod };
}

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
  container.replaceChildren(wrapGridScroll(table));
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
  container.replaceChildren(wrapGridScroll(table));
}

/** 幅の狭い画面では表全体を縮めず、この枠の中だけを横スクロールさせる */
function wrapGridScroll(table: HTMLTableElement): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "timetable-grid-scroll";
  wrapper.appendChild(table);
  return wrapper;
}

function buildGridTable(
  entries: TimetableEntry[],
  selectedSlot: { day: number; period: number } | null,
  onCellClick: ((day: number, period: number) => void) | null,
): HTMLTableElement {
  const map = entriesToMap(entries);
  const now = getNowInfo();

  const table = document.createElement("table");
  table.className = onCellClick ? "timetable-grid interactive" : "timetable-grid readonly";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  DAY_LABELS.forEach((label, day) => {
    const th = document.createElement("th");
    th.textContent = label;
    if (day === now.todayIndex) th.classList.add("col-today");
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let period = 1; period <= PERIOD_COUNT; period += 1) {
    const row = document.createElement("tr");
    const periodTh = document.createElement("th");
    const periodLabel = document.createElement("div");
    periodLabel.className = "period-label";
    periodLabel.textContent = `${period}限`;
    const periodTime = document.createElement("div");
    periodTime.className = "period-time";
    periodTime.textContent = `${PERIOD_TIMES[period].start}〜${PERIOD_TIMES[period].end}`;
    periodTh.append(periodLabel, periodTime);
    if (period === now.currentPeriod) periodTh.classList.add("row-now");
    row.appendChild(periodTh);

    for (let day = 0; day < DAY_LABELS.length; day += 1) {
      const td = document.createElement("td");
      const isToday = day === now.todayIndex;

      if (!isPeriodAvailable(day, period)) {
        td.className = "cell-unavailable";
        row.appendChild(td);
        continue;
      }

      const entry = map.get(entryKey(day, period));
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
        td.classList.add("cell-empty");
      }
      if (isToday) td.classList.add("col-today");
      if (isToday && period === now.currentPeriod) td.classList.add("cell-now");
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
