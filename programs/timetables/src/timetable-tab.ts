// 「自分の時間割」タブ: 上部に表示欄(読み取り専用グリッド)、下部に登録欄(2種類の追加方法)を分けて表示する。

import { api, ApiError, type TimetableEntry, type Term } from "./api";
import {
  groupOfferings, listDepartments, listFaculties, loadCatalog, searchOfferings,
  type CourseOffering,
} from "./course-catalog";
import {
  buildSlotMap, DAY_LABELS, entryKey, guessCurrentTerm, PERIOD_COUNT, renderReadonlyGrid,
  slotMapToEntries, TERM_LABELS, type SlotMap,
} from "./timetable-grid";

const MAX_OFFERING_RESULTS = 30;

export async function renderTimetableTab(content: HTMLElement): Promise<void> {
  content.replaceChildren();
  let currentTerm: Term = guessCurrentTerm();
  let slots: SlotMap = new Map();

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

  const saveRow = document.createElement("div");
  saveRow.className = "save-row";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "保存";
  const saveMessageEl = document.createElement("span");
  saveMessageEl.className = "message";
  saveMessageEl.hidden = true;
  saveRow.append(saveBtn, saveMessageEl);
  displaySection.appendChild(saveRow);

  content.appendChild(displaySection);

  function refreshDisplay(): void {
    renderReadonlyGrid(grid, slotMapToEntries(slots));
  }

  async function loadTerm(term: Term): Promise<void> {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    saveMessageEl.hidden = true;
    const { entries } = await api.getTimetable(term);
    slots = buildSlotMap(entries);
    refreshDisplay();
  }

  termButtons.forEach((btn) => {
    btn.addEventListener("click", () => void loadTerm(btn.dataset.term as Term));
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveMessageEl.hidden = true;
    try {
      const payload: TimetableEntry[] = slotMapToEntries(slots);
      const { entries } = await api.putTimetable(currentTerm, payload);
      slots = buildSlotMap(entries);
      refreshDisplay();
      saveMessageEl.textContent = "保存しました";
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
   * 1コマ追加する。既に別の科目が入っている場合は確認する。
   * 呼び出し後は表示欄を更新するが、サーバーへの保存は「保存」ボタンを押すまで行わない。
   */
  function addSlot(day: number, period: number, courseName: string, location: string | null): boolean {
    const key = entryKey(day, period);
    const existing = slots.get(key);
    if (existing && existing.course_name !== courseName) {
      const ok = confirm(
        `${DAY_LABELS[day]}曜${period}限には既に「${existing.course_name}」が入っています。上書きしますか？`,
      );
      if (!ok) return false;
    }
    slots.set(key, { course_name: courseName, location: location ?? "" });
    return true;
  }

  // ---------------------------------------------------------------- 登録欄
  const regSection = document.createElement("section");
  regSection.className = "panel";
  regSection.innerHTML = "<h2>科目を追加</h2>";

  const regTabs = document.createElement("div");
  regTabs.className = "term-tabs";
  const slotModeBtn = document.createElement("button");
  slotModeBtn.className = "term-tab active";
  slotModeBtn.textContent = "時間を指定して追加";
  const nameModeBtn = document.createElement("button");
  nameModeBtn.className = "term-tab";
  nameModeBtn.textContent = "科目名から追加";
  regTabs.append(slotModeBtn, nameModeBtn);
  regSection.appendChild(regTabs);

  const slotForm = buildSlotForm(addSlot, refreshDisplay);
  const nameForm = buildNameForm(() => currentTerm, addSlot, refreshDisplay);
  nameForm.root.hidden = true;
  regSection.append(slotForm.root, nameForm.root);
  content.appendChild(regSection);

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

  await loadTerm(currentTerm);
}

// ================================================================
// 登録欄 その1: 時間を指定して追加（曜日・時限・科目名・教室を手入力）
// ================================================================
function buildSlotForm(
  addSlot: (day: number, period: number, courseName: string, location: string | null) => boolean,
  refreshDisplay: () => void,
): { root: HTMLElement } {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">曜日・時限を選び、科目名を入力して追加します。シラバスに載っていない科目（学外の予定など）にも使えます。</p>
    <form class="slot-form">
      <label>曜日 <select class="reg-day"></select></label>
      <label>時限 <select class="reg-period"></select></label>
      <label>科目名 <input type="text" class="reg-course-name" maxlength="100" placeholder="科目名" required></label>
      <label>教室(任意) <input type="text" class="reg-location" maxlength="100" placeholder="教室"></label>
      <button type="submit" class="btn btn-primary">追加</button>
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
  const messageEl = root.querySelector<HTMLParagraphElement>(".reg-message")!;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const courseName = courseNameInput.value.trim();
    if (!courseName) return;
    const added = addSlot(
      Number(daySelect.value), Number(periodSelect.value), courseName, locationInput.value.trim() || null,
    );
    if (added) {
      refreshDisplay();
      messageEl.textContent = `${DAY_LABELS[Number(daySelect.value)]}曜${periodSelect.value}限に追加しました`;
      messageEl.className = "message message-ok reg-message";
      messageEl.hidden = false;
      courseNameInput.value = "";
      locationInput.value = "";
      courseNameInput.focus();
    }
  });

  return { root };
}

// ================================================================
// 登録欄 その2: 科目名から追加（シラバスデータを検索し、選ぶと該当コマ全てに自動挿入）
// ================================================================
function buildNameForm(
  getCurrentTerm: () => Term,
  addSlot: (day: number, period: number, courseName: string, location: string | null) => boolean,
  refreshDisplay: () => void,
): { root: HTMLElement; onShow: () => void } {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      シラバスの開講科目一覧（<a href="/../syllabus_courses/" target="_blank" rel="noopener">programs/syllabus_courses</a>のデータ）から検索して選ぶと、
      曜日・時限に自動で挿入されます。教室情報はシラバスに掲載がないため入りません（必要なら追加後に「時間を指定して追加」で上書きできます）。
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
      offerings = groupOfferings(catalog, getCurrentTerm());
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
    // offerings はまだ絞り込まれていない全件から学科一覧を作る必要があるため、catalogではなくofferings由来のdepartmentsを使う
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
          <span class="offering-name">${escapeHtml(o.course_name)}</span>
          <span class="offering-slots">${escapeHtml(slotsLabel)}</span>
        </div>
        <div class="offering-sub">${escapeHtml(o.instructor ?? "")} ・ ${escapeHtml(deptLabel)}</div>
      `;
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-primary btn-sm";
      addBtn.textContent = "追加";
      addBtn.addEventListener("click", () => {
        let addedCount = 0;
        for (const s of o.slots) {
          if (addSlot(s.day_of_week, s.period, o.course_name, null)) addedCount += 1;
        }
        refreshDisplay();
        messageEl.textContent = addedCount > 0
          ? `「${o.course_name}」を追加しました（${slotsLabel}）`
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
