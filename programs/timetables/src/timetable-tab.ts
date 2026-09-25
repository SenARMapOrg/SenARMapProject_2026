// 「自分の時間割」タブ: 表示画面(読み取り専用グリッド)と編集画面(グリッド+登録欄)を分けて、
// 誤操作で追加・削除されないようにする。編集画面へは「科目を追加・削除する」ボタンを押して
// 明示的に切り替える。
//
// 学年（メイン軸）+学期（サブ軸）で複数のスナップショットを持てる。表示・編集は
// 常に「今選んでいる学年+学期」に対して行われる。スナップショットの取得・保持・保存は
// timetable-store.ts が担当し、このファイルは画面の組み立てに専念する。
//
// ナビ機能（今日・次の授業表示、timetable-nav-panel.ts）は「今表示中の学年」ではなく
// 常に `me.current_grade`（プロフィール設定で選んだ「今の学年」）を見る。過去の学年を
// 見ながら今日の予定を確認したい場合があるため、表示中の学年とは独立にしている。

import { api, ApiError, type Me, type Term } from "./api";
import {
  DAY_LABELS, entryKey, gradeLabel, guessCurrentTerm,
  renderInteractiveGrid, renderReadonlyGrid, slotMapToEntries, TERM_LABELS, type SlotMap,
} from "./timetable-grid";
import { buildNameForm } from "./timetable-name-form";
import { renderNavPanel } from "./timetable-nav-panel";
import { buildSlotForm } from "./timetable-slot-form";
import { createSnapshotStore } from "./timetable-store";
import { renderVisibilityPanel } from "./timetable-visibility";

const NAV_REFRESH_INTERVAL_MS = 30_000;
const MIN_GRADE = 1;
const MAX_GRADE = 8;

export async function renderTimetableTab(content: HTMLElement, me: Me): Promise<void> {
  content.replaceChildren();

  let currentGrade: number = me.current_grade;
  let currentTerm: Term = guessCurrentTerm();
  let selectedSlot: { day: number; period: number } | null = null;
  // 学年タブに表示する学年一覧。listMyGrades()の結果 + me.current_grade + 手動で追加した学年を保持する
  const knownGrades = new Set<number>([me.current_grade]);

  const store = createSnapshotStore((grade, result) => {
    knownGrades.add(grade);
    refreshGradeTabs();
    if (grade === currentGrade) {
      refreshViewGrid();
      refreshEditGrid();
    }
    void refreshNavPanel();
    saveMessageEl.textContent = result.message;
    saveMessageEl.className = result.ok ? "message message-ok" : "message message-error";
    saveMessageEl.hidden = false;
  });

  // ---------------------------------------------------------------- 表示画面（デフォルト）
  const displaySection = document.createElement("section");
  displaySection.className = "panel";
  displaySection.innerHTML = "<h2>自分の時間割</h2>";

  const gradeTabs = document.createElement("div");
  gradeTabs.className = "grade-tabs";
  displaySection.appendChild(gradeTabs);

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

  const visibilityPanel = document.createElement("div");
  visibilityPanel.className = "visibility-panel";
  displaySection.appendChild(visibilityPanel);

  const viewGrid = document.createElement("div");
  displaySection.appendChild(viewGrid);

  const viewActionsRow = document.createElement("div");
  viewActionsRow.className = "save-row";
  const editToggleBtn = document.createElement("button");
  editToggleBtn.className = "btn btn-primary";
  editToggleBtn.textContent = "科目を追加・削除する";
  viewActionsRow.appendChild(editToggleBtn);
  displaySection.appendChild(viewActionsRow);

  const navPanel = document.createElement("div");
  navPanel.className = "nav-panel";
  displaySection.appendChild(navPanel);

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
  saveBtn.textContent = "今すぐ保存（前期・後期まとめて）";
  const saveMessageEl = document.createElement("span");
  saveMessageEl.className = "message";
  saveMessageEl.hidden = true;
  editHeaderRow.append(backToViewBtn, saveBtn, saveMessageEl);
  editSection.appendChild(editHeaderRow);

  const autoSaveHint = document.createElement("p");
  autoSaveHint.className = "hint";
  autoSaveHint.textContent = "追加・削除すると自動的に保存されます（このボタンを押す必要はありません。押すとすぐに保存されます）。";
  editSection.appendChild(autoSaveHint);

  const editGradeTermHint = document.createElement("p");
  editGradeTermHint.className = "hint edit-grade-term-hint";
  editSection.appendChild(editGradeTermHint);

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
    editGradeTermHint.textContent = `${gradeLabel(currentGrade)}に追加・削除されます:`;
    refreshEditGrid();
    // 既定で開いている「科目名から追加」のシラバスデータを読み始める
    // （読み込み済みなら何もしない。タブを手で切り替えていた場合はそのまま）
    if (!nameForm.root.hidden) nameForm.onShow();
  }
  function exitEditMode(): void {
    editSection.hidden = true;
    displaySection.hidden = false;
  }
  editToggleBtn.addEventListener("click", enterEditMode);
  backToViewBtn.addEventListener("click", exitEditMode);

  function currentSlots(): SlotMap {
    return store.slots(currentGrade, currentTerm);
  }

  function refreshViewGrid(): void {
    renderReadonlyGrid(viewGrid, slotMapToEntries(currentSlots()));
  }

  function refreshEditGrid(): void {
    renderInteractiveGrid(editGrid, slotMapToEntries(currentSlots()), selectedSlot, onGridCellClick);
  }

  function refreshGradeTabs(): void {
    gradeTabs.replaceChildren();
    const grades = [...knownGrades].sort((a, b) => a - b);
    for (const grade of grades) {
      const btn = document.createElement("button");
      btn.className = "term-tab";
      btn.classList.toggle("active", grade === currentGrade);
      btn.textContent = gradeLabel(grade);
      btn.addEventListener("click", () => void showGrade(grade));
      gradeTabs.appendChild(btn);
    }
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-link grade-add-btn";
    addBtn.textContent = "+ 学年を追加";
    addBtn.addEventListener("click", () => void addGrade());
    gradeTabs.appendChild(addBtn);

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "btn-link grade-add-btn";
    renameBtn.textContent = `${gradeLabel(currentGrade)}を変更`;
    renameBtn.addEventListener("click", () => void renameGrade());
    gradeTabs.appendChild(renameBtn);
  }

  async function addGrade(): Promise<void> {
    const raw = prompt("追加する学年を入力してください（例: 1〜8の整数）");
    if (raw === null) return;
    const grade = Number(raw.trim());
    if (!Number.isInteger(grade) || grade < MIN_GRADE || grade > MAX_GRADE) {
      alert("学年は1〜8の整数で入力してください。");
      return;
    }
    if (knownGrades.has(grade)) {
      alert(`${gradeLabel(grade)}は既にあります。`);
      return;
    }
    knownGrades.add(grade);
    refreshGradeTabs();
    await showGrade(grade);
  }

  /**
   * 「1年次として登録したけど実は2年次だった」のような、後からの学年の付け替え。
   * 今表示中の学年(currentGrade)を丸ごと別の番号に変更する（前期・後期・公開範囲設定ごと）。
   * 変更先の学年に既に時間割や公開設定がある場合はサーバー側で拒否される
   * （黙って上書き・混在させると既存のデータが消えてしまうため）。
   */
  async function renameGrade(): Promise<void> {
    const raw = prompt(
      `${gradeLabel(currentGrade)}を何年次に変更しますか？（1〜8の整数）`, String(currentGrade),
    );
    if (raw === null) return;
    const toGrade = Number(raw.trim());
    if (!Number.isInteger(toGrade) || toGrade < MIN_GRADE || toGrade > MAX_GRADE) {
      alert("学年は1〜8の整数で入力してください。");
      return;
    }
    if (toGrade === currentGrade) return;
    if (knownGrades.has(toGrade)) {
      alert(`${gradeLabel(toGrade)}は既にあります。先にそちらを削除するか別の番号にしてください。`);
      return;
    }

    const fromGrade = currentGrade;
    try {
      const res = await api.changeGrade(fromGrade, toGrade);
      store.moveGrade(fromGrade, toGrade);
      knownGrades.delete(fromGrade);
      knownGrades.add(toGrade);
      currentGrade = toGrade;
      me.current_grade = res.current_grade;
      refreshGradeTabs();
      refreshViewGrid();
      refreshEditGrid();
      void refreshVisibilityPanel();
      void refreshNavPanel();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "学年の変更に失敗しました");
    }
  }

  async function refreshNavPanel(): Promise<void> {
    // 学年は「今」の学年（me.current_grade）、学期は今開いている学期タブを使う。
    // 詳しい理由は timetable-nav-panel.ts のコメントを参照。
    await renderNavPanel(navPanel, me.current_grade, currentTerm, async (grade, term) => {
      await store.ensureLoaded(grade, term);
      return store.slots(grade, term);
    });
  }

  function onGridCellClick(day: number, period: number): void {
    selectedSlot = { day, period };
    const existing = currentSlots().get(entryKey(day, period)) ?? null;
    slotForm.selectSlot(day, period, existing);
    nameForm.setSlotFilter(existing ? null : { day, period });
    refreshEditGrid();
  }

  function refreshVisibilityPanel(): Promise<void> {
    return renderVisibilityPanel(visibilityPanel, currentGrade, currentTerm);
  }

  async function showTerm(term: Term): Promise<void> {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    editTermButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    selectedSlot = null;
    nameForm.setSlotFilter(null);
    await store.ensureLoaded(currentGrade, term);
    refreshViewGrid();
    refreshEditGrid();
    void refreshVisibilityPanel();
    void refreshNavPanel();
    if (!editSection.hidden) editGradeTermHint.textContent = `${gradeLabel(currentGrade)}に追加・削除されます:`;
  }

  async function showGrade(grade: number): Promise<void> {
    currentGrade = grade;
    refreshGradeTabs();
    await Promise.all([
      store.ensureLoaded(grade, "spring"),
      store.ensureLoaded(grade, "fall"),
    ]);
    await showTerm(currentTerm);
  }

  termButtons.forEach((btn) => {
    btn.addEventListener("click", () => void showTerm(btn.dataset.term as Term));
  });
  editTermButtons.forEach((btn) => {
    btn.addEventListener("click", () => void showTerm(btn.dataset.term as Term));
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveMessageEl.hidden = true;
    try {
      await store.save(currentGrade);
    } finally {
      saveBtn.disabled = false;
    }
  });

  /**
   * 1コマ追加する。term を明示的に指定するため、表示中の学期と異なる学期にも追加できる
   * （「科目名から追加」で前期タブを見ながら後期の科目を選んだ場合など）。学年は常に
   * 「今編集中の学年」(currentGrade)に追加される。既に別の科目が入っている場合は確認する。
   */
  function addSlot(
    term: Term, day: number, period: number, courseName: string, location: string | null,
    instructor: string | null = null,
  ): boolean {
    const key = entryKey(day, period);
    const slots = store.mutableSlots(currentGrade, term);
    const existing = slots.get(key);
    if (existing && existing.course_name !== courseName) {
      const ok = confirm(
        `${gradeLabel(currentGrade)}${TERM_LABELS[term]}の${DAY_LABELS[day]}曜${period}限には既に「${existing.course_name}」が入っています。上書きしますか？`,
      );
      if (!ok) return false;
    }
    slots.set(key, { course_name: courseName, location: location ?? "", instructor });
    if (term === currentTerm) {
      refreshViewGrid();
      refreshEditGrid();
    }
    void refreshNavPanel();
    store.scheduleAutoSave(currentGrade);
    return true;
  }

  /** 1コマ削除する。何も入っていなければ何もしない */
  function removeSlot(term: Term, day: number, period: number): boolean {
    const key = entryKey(day, period);
    const slots = store.slots(currentGrade, term);
    if (!slots.has(key)) return false;
    slots.delete(key);
    if (term === currentTerm) {
      refreshViewGrid();
      refreshEditGrid();
    }
    void refreshNavPanel();
    store.scheduleAutoSave(currentGrade);
    return true;
  }

  // ---------------------------------------------------------------- 登録欄（編集画面の中身）
  const regHeading = document.createElement("h2");
  regHeading.textContent = "科目を追加・削除";
  editSection.appendChild(regHeading);

  // 登録欄は「科目名から追加」を既定にする。シラバスから選べば曜日・時限・教員が埋まるので、
  // 手入力（時間を指定して追加・削除）より先にこちらを見せた方が速い。
  const regTabs = document.createElement("div");
  regTabs.className = "term-tabs";
  const nameModeBtn = document.createElement("button");
  nameModeBtn.className = "term-tab active";
  nameModeBtn.textContent = "科目名から追加";
  const slotModeBtn = document.createElement("button");
  slotModeBtn.className = "term-tab";
  slotModeBtn.textContent = "時間を指定して追加・削除";
  regTabs.append(nameModeBtn, slotModeBtn);
  editSection.appendChild(regTabs);

  const slotForm = buildSlotForm(() => currentTerm, addSlot, removeSlot);
  const nameForm = buildNameForm(addSlot);
  slotForm.root.hidden = true;
  editSection.append(nameForm.root, slotForm.root);

  function showNameForm(): void {
    nameModeBtn.classList.add("active");
    slotModeBtn.classList.remove("active");
    nameForm.root.hidden = false;
    slotForm.root.hidden = true;
    nameForm.onShow();   // 初回だけシラバスデータを読み込む
  }

  function showSlotForm(): void {
    slotModeBtn.classList.add("active");
    nameModeBtn.classList.remove("active");
    slotForm.root.hidden = false;
    nameForm.root.hidden = true;
  }

  nameModeBtn.addEventListener("click", showNameForm);
  slotModeBtn.addEventListener("click", showSlotForm);

  // 今日の曜日・現在時刻のハイライトとナビ状況は時間経過で変わるため、定期的に再描画する。
  // このタブから離れて画面から外れたら(要素がDOMから消えたら)自動的に止める。
  const refreshTimerId = setInterval(() => {
    if (!document.body.contains(displaySection)) {
      clearInterval(refreshTimerId);
      return;
    }
    refreshViewGrid();
    refreshEditGrid();
    void refreshNavPanel();
  }, NAV_REFRESH_INTERVAL_MS);

  const { grades } = await api.listMyGrades();
  for (const g of grades) knownGrades.add(g.grade);
  await showGrade(currentGrade);
}
