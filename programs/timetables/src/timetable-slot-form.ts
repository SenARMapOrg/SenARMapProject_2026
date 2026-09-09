// 登録欄「時間を指定して追加」フォーム: 曜日・時限・科目名・教室を手入力する。
// 編集画面のグリッドでセルをクリックした時、selectSlot() で外部から曜日・時限とその場の内容を反映できる。

import type { Term } from "./api";
import { DAY_LABELS, PERIOD_COUNT, TERM_LABELS } from "./timetable-grid";

export interface SlotFormHandle {
  root: HTMLElement;
  /** グリッドのセルクリックなど外部から呼び出し、フォームの内容をそのコマに合わせる */
  selectSlot: (day: number, period: number, existing: { course_name: string; location: string } | null) => void;
}

export function buildSlotForm(
  getCurrentTerm: () => Term,
  addSlot: (term: Term, day: number, period: number, courseName: string, location: string | null) => boolean,
  removeSlot: (term: Term, day: number, period: number) => boolean,
): SlotFormHandle {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      曜日・時限を選び、科目名を入力して追加します。今表示している学期（上のタブ）に追加されます。
      シラバスに載っていない科目（学外の予定など）にも使えます。「削除」で指定した曜日・時限のコマを消せます。
      下のグリッドのマスをクリックしても曜日・時限を選べます。
    </p>
    <form class="slot-form">
      <label>曜日 <select class="reg-day"></select></label>
      <label>時限 <select class="reg-period"></select></label>
      <label>科目名 <input type="text" class="reg-course-name" maxlength="100" placeholder="科目名" required></label>
      <label>教室(任意) <input type="text" class="reg-location" maxlength="100" placeholder="教室"></label>
      <button type="submit" class="btn btn-primary">追加</button>
      <button type="button" class="btn btn-ghost reg-delete-btn">このコマを削除</button>
    </form>
    <p class="message reg-message" hidden></p>
  `;

  const daySelect = root.querySelector<HTMLSelectElement>(".reg-day")!;
  DAY_LABELS.forEach((label, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${label}曜`;
    daySelect.appendChild(opt);
  });

  const periodSelect = root.querySelector<HTMLSelectElement>(".reg-period")!;
  for (let p = 1; p <= PERIOD_COUNT; p += 1) {
    const opt = document.createElement("option");
    opt.value = String(p);
    opt.textContent = `${p}限`;
    periodSelect.appendChild(opt);
  }

  const form = root.querySelector<HTMLFormElement>(".slot-form")!;
  const courseNameInput = root.querySelector<HTMLInputElement>(".reg-course-name")!;
  const locationInput = root.querySelector<HTMLInputElement>(".reg-location")!;
  const deleteBtn = root.querySelector<HTMLButtonElement>(".reg-delete-btn")!;
  const messageEl = root.querySelector<HTMLParagraphElement>(".reg-message")!;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const courseName = courseNameInput.value.trim();
    if (!courseName) return;
    const term = getCurrentTerm();
    const added = addSlot(
      term, Number(daySelect.value), Number(periodSelect.value), courseName, locationInput.value.trim() || null,
    );
    if (added) {
      messageEl.textContent = `${TERM_LABELS[term]}の${DAY_LABELS[Number(daySelect.value)]}曜${periodSelect.value}限に追加しました`;
      messageEl.className = "message message-ok reg-message";
      messageEl.hidden = false;
      courseNameInput.value = "";
      locationInput.value = "";
      courseNameInput.focus();
    }
  });

  deleteBtn.addEventListener("click", () => {
    const term = getCurrentTerm();
    const day = Number(daySelect.value);
    const period = Number(periodSelect.value);
    const removed = removeSlot(term, day, period);
    messageEl.textContent = removed
      ? `${TERM_LABELS[term]}の${DAY_LABELS[day]}曜${period}限を削除しました`
      : `${TERM_LABELS[term]}の${DAY_LABELS[day]}曜${period}限には何も入っていません`;
    messageEl.className = `message ${removed ? "message-ok" : "message-error"} reg-message`;
    messageEl.hidden = false;
    if (removed) {
      courseNameInput.value = "";
      locationInput.value = "";
    }
  });

  function selectSlot(
    day: number, period: number, existing: { course_name: string; location: string } | null,
  ): void {
    daySelect.value = String(day);
    periodSelect.value = String(period);
    courseNameInput.value = existing?.course_name ?? "";
    locationInput.value = existing?.location ?? "";
    messageEl.hidden = true;
  }

  return { root, selectSlot };
}
