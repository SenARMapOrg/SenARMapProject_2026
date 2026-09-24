// 「今の教室→次の教室」ナビ。今日の現在時限と次の時限を出し、次のコマの教室へ
// IKU NAVI のルート検索を開くリンクを作る。
//
// 学年は表示中の学年タブとは無関係に、実際の「今」の学年（me.current_grade）を見る。
// 学期は「今が前期か後期か」をカレンダーだけから機械的に判定すると学期の切り替わり時期に
// ずれることがあるため、呼び出し側が今開いている学期タブをそのまま渡す。
// 次の時限に教室が登録されていない場合はナビを開けない（行き先が無いと案内できないため）。
// 今の時限に教室が無い場合は「空」のまま出発地なしで開く。

import { type Term } from "./api";
import { entryKey, getNowInfo, PERIOD_TIMES, TERM_LABELS, type SlotMap } from "./timetable-grid";

// ナビ(programs/html/navi)は別サブドメインで公開されている。?from=&to= で教室名を渡すと
// 自動でルート検索まで行ってくれる（該当する教室が見つからない場合は入力済みの状態で開くだけ）。
const NAVI_BASE_URL = "https://iku-navi.net/navi/";

interface SlotEntry {
  course_name: string;
  location: string;
}

function describe(period: number | null, entry: SlotEntry | null): string {
  if (period === null) return "";
  const time = `${PERIOD_TIMES[period].start}〜${PERIOD_TIMES[period].end}`;
  if (!entry) return `${period}限 (${time}) 空きコマ`;
  return `${period}限 (${time}) ${entry.course_name}${entry.location ? ` / ${entry.location}` : ""}`;
}

function hintParagraph(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

export async function renderNavPanel(
  panel: HTMLElement,
  liveGrade: number,
  liveTerm: Term,
  loadSlots: (grade: number, term: Term) => Promise<SlotMap>,
): Promise<void> {
  panel.replaceChildren();
  const now = getNowInfo();

  if (now.todayIndex === null) {
    panel.appendChild(hintParagraph("本日(日曜)は時限がありません。"));
    return;
  }

  const todaySlots = await loadSlots(liveGrade, liveTerm);
  const currentEntry = now.currentPeriod !== null
    ? todaySlots.get(entryKey(now.todayIndex, now.currentPeriod)) ?? null : null;
  const nextEntry = now.nextPeriod !== null
    ? todaySlots.get(entryKey(now.todayIndex, now.nextPeriod)) ?? null : null;

  const statusEl = document.createElement("p");
  statusEl.className = "hint nav-status";
  statusEl.textContent = `(${TERM_LABELS[liveTerm]}の時間割を表示中) 現在: ${now.currentPeriod !== null ? describe(now.currentPeriod, currentEntry) : "授業時間外"}　次: ${now.nextPeriod !== null ? describe(now.nextPeriod, nextEntry) : "本日はこれ以上時限がありません"}`;
  panel.appendChild(statusEl);

  if (now.nextPeriod === null) return;
  if (!nextEntry?.location) {
    panel.appendChild(hintParagraph("次のコマの教室が登録されていないため、ナビを開けません。"));
    return;
  }

  const link = document.createElement("a");
  link.className = "btn btn-primary";
  link.target = "_blank";
  link.rel = "noopener";
  const params = new URLSearchParams({ to: nextEntry.location });
  if (currentEntry?.location) params.set("from", currentEntry.location);
  link.href = `${NAVI_BASE_URL}?${params.toString()}`;
  link.textContent = "次の教室へのナビを開く";
  panel.appendChild(link);
}
