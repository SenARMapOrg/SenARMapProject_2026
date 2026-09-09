// 登録欄「科目名から追加」フォーム: シラバスの開講科目一覧を検索し、選ぶと該当コマに自動挿入する。
// 表示中の学期に関わらず全学期を検索対象にする（前期タブを見ながら後期の予定も組めるように）。
// 挿入先は科目自身の学期（通年なら前期・後期の両方）であり、表示中の学期とは独立している。
// 編集画面のグリッドで空きコマをクリックした時、setSlotFilter() でその曜日・時限に絞り込める
// （「そのコマに入れられる科目」を見せるため）。

import type { Term } from "./api";
import {
  groupOfferings, listFaculties, loadCatalog, searchOfferings, type CourseOffering, type OfferingTerm,
} from "./course-catalog";
import { DAY_LABELS } from "./timetable-grid";

const MAX_OFFERING_RESULTS = 30;
const OFFERING_TERM_LABELS: Record<OfferingTerm, string> = { spring: "前期", fall: "後期", both: "通年" };

export interface NameFormHandle {
  root: HTMLElement;
  onShow: () => void;
  setSlotFilter: (slot: { day: number; period: number } | null) => void;
}

export function buildNameForm(
  addSlot: (term: Term, day: number, period: number, courseName: string, location: string | null) => boolean,
): NameFormHandle {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      シラバスの開講科目一覧（<a href="/../syllabus_courses/" target="_blank" rel="noopener">programs/syllabus_courses</a>のデータ）から検索して選ぶと、
      科目自身の学期（前期・後期・通年）に応じて自動で挿入されます。今表示している学期とは関係なく、前期タブを見ながら後期の科目を追加することもできます。
      教室情報はシラバスに掲載がないため入りません（必要なら追加後に「時間を指定して追加」で上書きできます）。
      下のグリッドの空いているマスをクリックすると、そのコマに入れられる科目だけに絞り込めます。
    </p>
    <p class="hint slot-filter-badge" hidden></p>
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
  const slotFilterBadge = root.querySelector<HTMLParagraphElement>(".slot-filter-badge")!;

  let loaded = false;
  let offerings: CourseOffering[] = [];
  let slotFilter: { day: number; period: number } | null = null;

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

  function renderSlotFilterBadge(): void {
    if (!slotFilter) {
      slotFilterBadge.hidden = true;
      slotFilterBadge.replaceChildren();
      return;
    }
    slotFilterBadge.hidden = false;
    slotFilterBadge.replaceChildren();
    const text = document.createElement("span");
    text.textContent = `${DAY_LABELS[slotFilter.day]}曜${slotFilter.period}限に入れられる科目のみ表示中　`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn-link";
    clearBtn.textContent = "絞り込み解除";
    clearBtn.addEventListener("click", () => setSlotFilter(null));
    slotFilterBadge.append(text, clearBtn);
  }

  function render(): void {
    const query = queryInput.value.trim();
    const faculty = facultySelect.value;
    const department = departmentSelect.value;
    if (!query && !faculty && !slotFilter) {
      listEl.hidden = true;
      listEl.replaceChildren();
      return;
    }
    let matched = searchOfferings(offerings, query, faculty, department);
    if (slotFilter) {
      matched = matched.filter((o) => o.slots.some(
        (s) => s.day_of_week === slotFilter!.day && s.period === slotFilter!.period,
      ));
    }
    matched = matched.slice(0, MAX_OFFERING_RESULTS);
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

  function setSlotFilter(slot: { day: number; period: number } | null): void {
    slotFilter = slot;
    renderSlotFilterBadge();
    render();
  }

  facultySelect.addEventListener("change", () => {
    refreshDepartmentOptions();
    render();
  });
  departmentSelect.addEventListener("change", render);
  queryInput.addEventListener("input", render);

  return { root, onShow: () => void onShow(), setSlotFilter };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
