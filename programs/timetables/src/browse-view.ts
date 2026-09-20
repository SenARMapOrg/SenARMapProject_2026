// 「みんなの時間割を探す」タブ: 公開範囲を「公開」に設定したスナップショットだけを対象に、
// 学年・学期・学部・学科（すべて任意）で絞り込んで探せる。後輩が先輩の過去の時間割を
// 参考にする、といった使い方を想定している。
//
// 「友達のみ」「リンク限定」「非公開」のスナップショットはここには一切出てこない
// （サーバー側 GET /api/timetable/public が visibility='public' のものしか返さないため）。

import { api, ApiError, type PublicSnapshot, type Term } from "./api";
import { loadDepartmentCatalog } from "./course-catalog";
import { gradeLabel, guessCurrentTerm, renderReadonlyGrid, TERM_LABELS } from "./timetable-grid";

const MAX_RESULTS = 100;
const MIN_GRADE = 1;
const MAX_GRADE = 8;

export async function renderBrowsePanel(container: HTMLElement): Promise<void> {
  container.replaceChildren();

  const filterSection = document.createElement("section");
  filterSection.className = "panel";
  filterSection.innerHTML = `
    <h2>みんなの時間割を探す</h2>
    <p class="hint">
      「公開」に設定された時間割だけを、学年・学期・学部・学科で絞り込んで探せます
      （「友達のみ」「リンク限定」「非公開」のものはここには出ません）。
    </p>
    <div class="filters">
      <label>学年 <select class="browse-grade"><option value="">すべての学年</option></select></label>
      <label>学期 <select class="browse-term"><option value="">すべての学期</option></select></label>
      <label>学部 <select class="browse-faculty"><option value="">すべての学部</option></select></label>
      <label>学科 <select class="browse-department" disabled><option value="">すべての学科</option></select></label>
    </div>
    <p class="hint browse-loading">読み込み中...</p>
    <p class="message browse-message" hidden></p>
    <ul class="offering-list browse-results" hidden></ul>
  `;
  container.appendChild(filterSection);

  const viewerSection = document.createElement("section");
  viewerSection.className = "panel";
  viewerSection.id = "browse-viewer";
  viewerSection.hidden = true;
  container.appendChild(viewerSection);

  const gradeSelect = filterSection.querySelector<HTMLSelectElement>(".browse-grade")!;
  const termSelect = filterSection.querySelector<HTMLSelectElement>(".browse-term")!;
  const facultySelect = filterSection.querySelector<HTMLSelectElement>(".browse-faculty")!;
  const departmentSelect = filterSection.querySelector<HTMLSelectElement>(".browse-department")!;
  const loadingEl = filterSection.querySelector<HTMLParagraphElement>(".browse-loading")!;
  const messageEl = filterSection.querySelector<HTMLParagraphElement>(".browse-message")!;
  const resultsEl = filterSection.querySelector<HTMLUListElement>(".browse-results")!;

  for (let g = MIN_GRADE; g <= MAX_GRADE; g += 1) {
    const opt = document.createElement("option");
    opt.value = String(g);
    opt.textContent = gradeLabel(g);
    gradeSelect.appendChild(opt);
  }
  for (const term of ["spring", "fall"] as Term[]) {
    const opt = document.createElement("option");
    opt.value = term;
    opt.textContent = TERM_LABELS[term];
    termSelect.appendChild(opt);
  }

  try {
    const catalog = await loadDepartmentCatalog();
    const departmentsByFaculty: Record<string, string[]> = {};
    for (const f of catalog.faculties) {
      const opt = document.createElement("option");
      opt.value = f.name;
      opt.textContent = f.name;
      facultySelect.appendChild(opt);
      departmentsByFaculty[f.name] = f.departments.map((d) => d.name);
    }
    facultySelect.addEventListener("change", () => {
      departmentSelect.innerHTML = '<option value="">すべての学科</option>';
      departmentSelect.disabled = !facultySelect.value;
      for (const d of departmentsByFaculty[facultySelect.value] ?? []) {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        departmentSelect.appendChild(opt);
      }
      void search();
    });
  } catch {
    // 学部/学科データが読み込めなくても、学年・学期だけでの絞り込みは使えるようにしておく
  }

  async function search(): Promise<void> {
    loadingEl.hidden = false;
    messageEl.hidden = true;
    resultsEl.hidden = true;
    try {
      const { snapshots } = await api.listPublicSnapshots({
        grade: gradeSelect.value ? Number(gradeSelect.value) : undefined,
        term: (termSelect.value || undefined) as Term | undefined,
        faculty: facultySelect.value || undefined,
        department: departmentSelect.value || undefined,
      });
      renderResults(snapshots);
    } catch (err) {
      messageEl.textContent = err instanceof ApiError ? err.message : "検索に失敗しました";
      messageEl.className = "message message-error browse-message";
      messageEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
    }
  }

  function renderResults(snapshots: PublicSnapshot[]): void {
    resultsEl.replaceChildren();
    if (snapshots.length === 0) {
      messageEl.textContent = "条件に一致する公開中の時間割はありませんでした。";
      messageEl.className = "message browse-message";
      messageEl.hidden = false;
      return;
    }
    resultsEl.hidden = false;
    for (const s of snapshots.slice(0, MAX_RESULTS)) {
      const li = document.createElement("li");
      const deptLabel = [s.faculty, s.department].filter(Boolean).join("/");
      li.innerHTML = `
        <div class="offering-main">
          <span class="offering-term-badge">${escapeHtml(gradeLabel(s.grade))}${escapeHtml(TERM_LABELS[s.term])}</span>
          <span class="offering-name">${escapeHtml(s.display_name)}</span>
        </div>
        <div class="offering-sub">${escapeHtml(deptLabel || "学部/学科未設定")}</div>
      `;
      const viewBtn = document.createElement("button");
      viewBtn.className = "btn btn-primary btn-sm";
      viewBtn.textContent = "見る";
      viewBtn.addEventListener("click", () => void showSnapshot(s));
      li.appendChild(viewBtn);
      resultsEl.appendChild(li);
    }
  }

  async function showSnapshot(s: PublicSnapshot): Promise<void> {
    viewerSection.hidden = false;
    viewerSection.replaceChildren();
    const h = document.createElement("h2");
    h.textContent = `${s.display_name} さんの${gradeLabel(s.grade)}${TERM_LABELS[s.term]}`;
    const grid = document.createElement("div");
    const errorEl = document.createElement("p");
    errorEl.className = "message message-error";
    errorEl.hidden = true;
    viewerSection.append(h, grid, errorEl);
    try {
      const { entries } = await api.viewUserTimetable(s.user_id, s.grade, s.term);
      renderReadonlyGrid(grid, entries);
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : "時間割を取得できませんでした";
      errorEl.hidden = false;
    }
    viewerSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  gradeSelect.addEventListener("change", () => void search());
  termSelect.addEventListener("change", () => void search());
  departmentSelect.addEventListener("change", () => void search());

  // 初期表示は「今の学期」に絞って検索しておく（無条件の全件表示は情報量が多すぎるため）
  termSelect.value = guessCurrentTerm();
  await search();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
