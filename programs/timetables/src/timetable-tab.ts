// 「自分の時間割」タブ: 表示画面(読み取り専用グリッド)と編集画面(グリッド+登録欄)を分けて、
// 誤操作で追加・削除されないようにする。編集画面へは「科目を追加・削除する」ボタンを押して
// 明示的に切り替える。
//
// 前期・後期のデータは常に両方メモリに保持する（表示は選択中の学期だけだが、
// 「科目名から追加」は学期をまたいで全件を検索対象にし、選んだ科目自身の学期に挿入するため、
// 表示中の学期と挿入先の学期が食い違うことがある。片方だけ持つ設計だとここでバグる）。

import { api, ApiError, type Term } from "./api";
import {
  buildSlotMap, DAY_LABELS, entryKey, guessCurrentTerm, renderInteractiveGrid, renderReadonlyGrid,
  slotMapToEntries, TERM_LABELS, type SlotMap,
} from "./timetable-grid";
import { buildNameForm } from "./timetable-name-form";
import { buildSlotForm } from "./timetable-slot-form";

export async function renderTimetableTab(content: HTMLElement): Promise<void> {
  content.replaceChildren();
  let currentTerm: Term = guessCurrentTerm();
  let selectedSlot: { day: number; period: number } | null = null;
  const slotsByTerm: Record<Term, SlotMap> = { spring: new Map(), fall: new Map() };

  // ---------------------------------------------------------------- 表示画面（デフォルト）
  const displaySection = document.createElement("section");
  displaySection.className = "panel";
  displaySection.innerHTML = "<h2>自分の時間割</h2>";

  const termTabs = document.createElement("div");
  termTabs.className = "term-tabs";
  const termButtons = (["spring", "fall"] as Term[]).map((term) => {
    const btn = document.createElement("button");
    btn.className = "term-tab";
    btn.textContent = TERM_LABELS[term];
    btn.dataset.term = term;
    termTabs.appendChild(btn);
    return btn;
  });
  displaySection.appendChild(termTabs);

  const viewGrid = document.createElement("div");
  displaySection.appendChild(viewGrid);

  const viewActionsRow = document.createElement("div");
  viewActionsRow.className = "save-row";
  const editToggleBtn = document.createElement("button");
  editToggleBtn.className = "btn btn-primary";
  editToggleBtn.textContent = "科目を追加・削除する";
  viewActionsRow.appendChild(editToggleBtn);
  displaySection.appendChild(viewActionsRow);

  content.appendChild(displaySection);

  // ---------------------------------------------------------------- 編集画面（誤操作防止のため明示的に切り替えるまで非表示）
  const editSection = document.createElement("section");
  editSection.className = "panel";
  editSection.hidden = true;

  const editHeaderRow = document.createElement("div");
  editHeaderRow.className = "save-row";
  const backToViewBtn = document.createElement("button");
  backToViewBtn.className = "btn btn-ghost";
  backToViewBtn.textContent = "← 表示に戻る";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "保存（前期・後期まとめて）";
  const saveMessageEl = document.createElement("span");
  saveMessageEl.className = "message";
  saveMessageEl.hidden = true;
  editHeaderRow.append(backToViewBtn, saveBtn, saveMessageEl);
  editSection.appendChild(editHeaderRow);

  const editTermHint = document.createElement("p");
  editTermHint.className = "hint";
  editTermHint.textContent = "ここで選んだ学期に追加・削除されます:";
  editSection.appendChild(editTermHint);

  const editTermTabs = document.createElement("div");
  editTermTabs.className = "term-tabs";
  const editTermButtons = (["spring", "fall"] as Term[]).map((term) => {
    const btn = document.createElement("button");
    btn.className = "term-tab";
    btn.textContent = TERM_LABELS[term];
    btn.dataset.term = term;
    editTermTabs.appendChild(btn);
    return btn;
  });
  editSection.appendChild(editTermTabs);

  const editGridHint = document.createElement("p");
  editGridHint.className = "hint";
  editGridHint.textContent = "マスをクリックすると、下のフォームにその曜日・時限が反映されます（クリックしただけでは追加・削除されません）。";
  editSection.appendChild(editGridHint);

  const editGrid = document.createElement("div");
  editSection.appendChild(editGrid);

  content.appendChild(editSection);

  function enterEditMode(): void {
    editSection.hidden = false;
    displaySection.hidden = true;
    refreshEditGrid();
  }
  function exitEditMode(): void {
    editSection.hidden = true;
    displaySection.hidden = false;
  }
  editToggleBtn.addEventListener("click", enterEditMode);
  backToViewBtn.addEventListener("click", exitEditMode);

  function refreshViewGrid(): void {
    renderReadonlyGrid(viewGrid, slotMapToEntries(slotsByTerm[currentTerm]));
  }

  function refreshEditGrid(): void {
    renderInteractiveGrid(editGrid, slotMapToEntries(slotsByTerm[currentTerm]), selectedSlot, onGridCellClick);
  }

  function onGridCellClick(day: number, period: number): void {
    selectedSlot = { day, period };
    const existing = slotsByTerm[currentTerm].get(entryKey(day, period)) ?? null;
    slotForm.selectSlot(day, period, existing);
    nameForm.setSlotFilter(existing ? null : { day, period });
    refreshEditGrid();
  }

  function showTerm(term: Term): void {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    editTermButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    selectedSlot = null;
    nameForm.setSlotFilter(null);
    refreshViewGrid();
    refreshEditGrid();
  }

  termButtons.forEach((btn) => {
    btn.addEventListener("click", () => showTerm(btn.dataset.term as Term));
  });
  editTermButtons.forEach((btn) => {
    btn.addEventListener("click", () => showTerm(btn.dataset.term as Term));
  });

  async function loadAllTerms(): Promise<void> {
    const [springRes, fallRes] = await Promise.all([
      api.getTimetable("spring"),
      api.getTimetable("fall"),
    ]);
    slotsByTerm.spring = buildSlotMap(springRes.entries);
    slotsByTerm.fall = buildSlotMap(fallRes.entries);
    showTerm(currentTerm);
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveMessageEl.hidden = true;
    try {
      const [springRes, fallRes] = await Promise.all([
        api.putTimetable("spring", slotMapToEntries(slotsByTerm.spring)),
        api.putTimetable("fall", slotMapToEntries(slotsByTerm.fall)),
      ]);
      slotsByTerm.spring = buildSlotMap(springRes.entries);
      slotsByTerm.fall = buildSlotMap(fallRes.entries);
      refreshViewGrid();
      refreshEditGrid();
      saveMessageEl.textContent = "前期・後期どちらも保存しました";
      saveMessageEl.className = "message message-ok";
    } catch (err) {
      saveMessageEl.textContent = err instanceof ApiError ? err.message : "保存に失敗しました";
      saveMessageEl.className = "message message-error";
    } finally {
      saveMessageEl.hidden = false;
      saveBtn.disabled = false;
    }
  });

  /**
   * 1コマ追加する。term を明示的に指定するため、表示中の学期と異なる学期にも追加できる
   * （「科目名から追加」で前期タブを見ながら後期の科目を選んだ場合など）。
   * 既に別の科目が入っている場合は確認する。表示欄は「今表示している学期」の分だけ更新する。
   */
  function addSlot(
    term: Term, day: number, period: number, courseName: string, location: string | null,
  ): boolean {
    const key = entryKey(day, period);
    const slots = slotsByTerm[term];
    const existing = slots.get(key);
    if (existing && existing.course_name !== courseName) {
      const ok = confirm(
        `${TERM_LABELS[term]}の${DAY_LABELS[day]}曜${period}限には既に「${existing.course_name}」が入っています。上書きしますか？`,
      );
      if (!ok) return false;
    }
    slots.set(key, { course_name: courseName, location: location ?? "" });
    if (term === currentTerm) {
      refreshViewGrid();
      refreshEditGrid();
    }
    return true;
  }

  /** 1コマ削除する。何も入っていなければ何もしない */
  function removeSlot(term: Term, day: number, period: number): boolean {
    const key = entryKey(day, period);
    const slots = slotsByTerm[term];
    if (!slots.has(key)) return false;
    slots.delete(key);
    if (term === currentTerm) {
      refreshViewGrid();
      refreshEditGrid();
    }
    return true;
  }

  // ---------------------------------------------------------------- 登録欄（編集画面の中身）
  const regHeading = document.createElement("h2");
  regHeading.textContent = "科目を追加・削除";
  editSection.appendChild(regHeading);

  const regTabs = document.createElement("div");
  regTabs.className = "term-tabs";
  const slotModeBtn = document.createElement("button");
  slotModeBtn.className = "term-tab active";
  slotModeBtn.textContent = "時間を指定して追加・削除";
  const nameModeBtn = document.createElement("button");
  nameModeBtn.className = "term-tab";
  nameModeBtn.textContent = "科目名から追加";
  regTabs.append(slotModeBtn, nameModeBtn);
  editSection.appendChild(regTabs);

  const slotForm = buildSlotForm(() => currentTerm, addSlot, removeSlot);
  const nameForm = buildNameForm(addSlot);
  nameForm.root.hidden = true;
  editSection.append(slotForm.root, nameForm.root);

  slotModeBtn.addEventListener("click", () => {
    slotModeBtn.classList.add("active");
    nameModeBtn.classList.remove("active");
    slotForm.root.hidden = false;
    nameForm.root.hidden = true;
  });
  nameModeBtn.addEventListener("click", () => {
    nameModeBtn.classList.add("active");
    slotModeBtn.classList.remove("active");
    nameForm.root.hidden = false;
    slotForm.root.hidden = true;
    nameForm.onShow();
  });

  await loadAllTerms();
}
