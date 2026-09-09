// 「自分の時間割」タブ: 上部に表示欄(読み取り専用グリッド)、下部に登録欄(2種類の追加方法)を分けて表示する。
//
// 前期・後期のデータは常に両方メモリに保持する（表示は選択中の学期だけだが、
// 「科目名から追加」は学期をまたいで全件を検索対象にし、選んだ科目自身の学期に挿入するため、
// 表示中の学期と挿入先の学期が食い違うことがある。片方だけ持つ設計だとここでバグる）。

import { api, ApiError, type Term } from "./api";
import {
  groupOfferings, listDepartments, listFaculties, loadCatalog, searchOfferings,
  type CourseOffering, type OfferingTerm,
} from "./course-catalog";
import {
  buildSlotMap, DAY_LABELS, entryKey, guessCurrentTerm, PERIOD_COUNT, renderReadonlyGrid,
  slotMapToEntries, TERM_LABELS, type SlotMap,
} from "./timetable-grid";

const MAX_OFFERING_RESULTS = 30;
const OFFERING_TERM_LABELS: Record<OfferingTerm, string> = { spring: "前期", fall: "後期", both: "通年" };

export async function renderTimetableTab(content: HTMLElement): Promise<void> {
  content.replaceChildren();
  let currentTerm: Term = guessCurrentTerm();
  const slotsByTerm: Record<Term, SlotMap> = { spring: new Map(), fall: new Map() };

  // ---------------------------------------------------------------- 表示欄
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

  const grid = document.createElement("div");
  displaySection.appendChild(grid);

  const viewActionsRow = document.createElement("div");
  viewActionsRow.className = "save-row";
  const editToggleBtn = document.createElement("button");
  editToggleBtn.className = "btn btn-primary";
  editToggleBtn.textContent = "科目を追加・削除する";
  viewActionsRow.appendChild(editToggleBtn);
  displaySection.appendChild(viewActionsRow);

  content.appendChild(displaySection);

  // ---------------------------------------------------------------- 編集欄（誤操作防止のため「科目を追加・削除する」を押すまで表示しない）
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

  content.appendChild(editSection);

  function enterEditMode(): void {
    editSection.hidden = false;
    displaySection.hidden = true;
  }
  function exitEditMode(): void {
    editSection.hidden = true;
    displaySection.hidden = false;
  }
  editToggleBtn.addEventListener("click", enterEditMode);
  backToViewBtn.addEventListener("click", exitEditMode);

  function refreshDisplay(): void {
    renderReadonlyGrid(grid, slotMapToEntries(slotsByTerm[currentTerm]));
  }

  function showTerm(term: Term): void {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    editTermButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    refreshDisplay();
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
      refreshDisplay();
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
    if (term === currentTerm) refreshDisplay();
    return true;
  }

  /** 1コマ削除する。何も入っていなければ何もしない */
  function removeSlot(term: Term, day: number, period: number): boolean {
    const key = entryKey(day, period);
    const slots = slotsByTerm[term];
    if (!slots.has(key)) return false;
    slots.delete(key);
    if (term === currentTerm) refreshDisplay();
    return true;
  }

  // ---------------------------------------------------------------- 登録欄（編集欄の中身）
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

// ================================================================
// 登録欄 その1: 時間を指定して追加（曜日・時限・科目名・教室を手入力。表示中の学期に追加する）
// ================================================================
function buildSlotForm(
  getCurrentTerm: () => Term,
  addSlot: (term: Term, day: number, period: number, courseName: string, location: string | null) => boolean,
  removeSlot: (term: Term, day: number, period: number) => boolean,
): { root: HTMLElement } {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">曜日・時限を選び、科目名を入力して追加します。今表示している学期（上のタブ）に追加されます。シラバスに載っていない科目（学外の予定など）にも使えます。「削除」で指定した曜日・時限のコマを消せます。</p>
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
  });

  return { root };
}

// ================================================================
// 登録欄 その2: 科目名から追加
// シラバスデータ(前期・後期・通年 全件)を検索し、選ぶと該当コマに自動挿入する。
// 表示中の学期に関わらず全学期を検索対象にする（前期タブを見ながら後期の予定も組めるように）。
// 挿入先は科目自身の学期（通年なら前期・後期の両方）であり、表示中の学期とは独立している。
// ================================================================
function buildNameForm(
  addSlot: (term: Term, day: number, period: number, courseName: string, location: string | null) => boolean,
): { root: HTMLElement; onShow: () => void } {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      シラバスの開講科目一覧（<a href="/../syllabus_courses/" target="_blank" rel="noopener">programs/syllabus_courses</a>のデータ）から検索して選ぶと、
      科目自身の学期（前期・後期・通年）に応じて自動で挿入されます。今表示している学期とは関係なく、前期タブを見ながら後期の科目を追加することもできます。
      教室情報はシラバスに掲載がないため入りません（必要なら追加後に「時間を指定して追加」で上書きできます）。
    </p>
    <div class="filters">
      <label>学部 <select class="reg-faculty"><option value="">すべての学部</option></select></label>
      <label>学科 <select class="reg-department" disabled><option value="">すべての学科</option></select></label>
    </div>
    <input type="search" class="reg-query" placeholder="科目名で検索（例: プログラミング）" autocomplete="off">
    <p class="hint reg-loading">読み込み中...</p>
    <ul class="offering-list" hidden></ul>
    <p class="message reg-message" hidden></p>
  `;

  const facultySelect = root.querySelector<HTMLSelectElement>(".reg-faculty")!;
  const departmentSelect = root.querySelector<HTMLSelectElement>(".reg-department")!;
  const queryInput = root.querySelector<HTMLInputElement>(".reg-query")!;
  const loadingEl = root.querySelector<HTMLParagraphElement>(".reg-loading")!;
  const listEl = root.querySelector<HTMLUListElement>(".offering-list")!;
  const messageEl = root.querySelector<HTMLParagraphElement>(".reg-message")!;

  let loaded = false;
  let offerings: CourseOffering[] = [];

  async function onShow(): Promise<void> {
    if (loaded) return;
    loadingEl.hidden = false;
    try {
      const catalog = await loadCatalog();
      for (const f of listFaculties(catalog)) {
        const opt = document.createElement("option");
        opt.value = f;
        opt.textContent = f;
        facultySelect.appendChild(opt);
      }
      offerings = groupOfferings(catalog);
      loaded = true;
      render();
    } catch {
      loadingEl.textContent = "科目データを読み込めませんでした";
    } finally {
      loadingEl.hidden = loaded;
    }
  }

  function refreshDepartmentOptions(): void {
    departmentSelect.innerHTML = '<option value="">すべての学科</option>';
    departmentSelect.disabled = !facultySelect.value;
    if (!facultySelect.value || offerings.length === 0) return;
    const depts = new Set<string>();
    for (const o of offerings) {
      for (const d of o.departments) if (d.faculty === facultySelect.value) depts.add(d.department);
    }
    for (const d of [...depts].sort((a, b) => a.localeCompare(b, "ja"))) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      departmentSelect.appendChild(opt);
    }
  }

  function render(): void {
    const query = queryInput.value.trim();
    const faculty = facultySelect.value;
    const department = departmentSelect.value;
    if (!query && !faculty) {
      listEl.hidden = true;
      listEl.replaceChildren();
      return;
    }
    const matched = searchOfferings(offerings, query, faculty, department).slice(0, MAX_OFFERING_RESULTS);
    listEl.replaceChildren();
    listEl.hidden = matched.length === 0;
    for (const o of matched) {
      const li = document.createElement("li");
      const slotsLabel = o.slots.map((s) => `${DAY_LABELS[s.day_of_week]}曜${s.period}限`).join(", ");
      const deptLabel = o.departments.map((d) => `${d.faculty}/${d.department}`).join(", ");
      li.innerHTML = `
        <div class="offering-main">
          <span class="offering-term-badge">${escapeHtml(OFFERING_TERM_LABELS[o.term])}</span>
          <span class="offering-name">${escapeHtml(o.course_name)}</span>
          <span class="offering-slots">${escapeHtml(slotsLabel)}</span>
        </div>
        <div class="offering-sub">${escapeHtml(o.instructor ?? "")} ・ ${escapeHtml(deptLabel)}</div>
      `;
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-primary btn-sm";
      addBtn.textContent = "追加";
      addBtn.addEventListener("click", () => {
        const targetTerms: Term[] = o.term === "both" ? ["spring", "fall"] : [o.term];
        let addedCount = 0;
        for (const term of targetTerms) {
          for (const s of o.slots) {
            if (addSlot(term, s.day_of_week, s.period, o.course_name, null)) addedCount += 1;
          }
        }
        const termLabel = OFFERING_TERM_LABELS[o.term];
        messageEl.textContent = addedCount > 0
          ? `「${o.course_name}」を${termLabel}に追加しました（${slotsLabel}）`
          : "追加しませんでした";
        messageEl.className = `message ${addedCount > 0 ? "message-ok" : "message-error"} reg-message`;
        messageEl.hidden = false;
      });
      li.appendChild(addBtn);
      listEl.appendChild(li);
    }
  }

  facultySelect.addEventListener("change", () => {
    refreshDepartmentOptions();
    render();
  });
  departmentSelect.addEventListener("change", render);
  queryInput.addEventListener("input", render);

  return { root, onShow: () => void onShow() };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
