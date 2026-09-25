// 登録欄「科目名から追加」フォーム: シラバスの開講科目一覧を検索し、選ぶと該当コマに自動挿入する。
// 表示中の学期に関わらず全学期を検索対象にする（前期タブを見ながら後期の予定も組めるように）。
// 挿入先は科目自身の学期（通年なら前期・後期の両方）であり、表示中の学期とは独立している。
// 編集画面のグリッドで空きコマをクリックした時、setSlotFilter() でその曜日・時限に絞り込める
// （「そのコマに入れられる科目」を見せるため）。
//
// 各開講（科目名・担当教員・曜日・時限の組）ごとに教室入力欄を1つ持つ。他の学生が同じ開講
// （学期・曜日・時限・科目名・担当教員が一致するもの）に登録した教室があれば自動で下書きするが、
// あくまで下書きであり、自分がここで上書きしてもそれは自分の登録内容が変わるだけで、
// 他の学生のデータを書き換えるわけではない（教室候補は毎回その場で他の学生の入力から
// 再集計されるだけで、共有の正本を持たない）。

import { api, type Term } from "./api";
import {
  AVAILABLE_COURSE_YEARS, DEFAULT_COURSE_YEAR, filterOfferingsByTerm, groupOfferings, loadCatalog,
  loadDepartmentCatalog, searchOfferings, type CourseOffering, type OfferingTerm,
} from "./course-catalog";
import { DAY_LABELS, TERM_LABELS } from "./timetable-grid";

const MAX_OFFERING_RESULTS = 30;
const OFFERING_TERM_LABELS: Record<OfferingTerm, string> = { spring: "前期", fall: "後期", both: "通年" };
const RENDER_DEBOUNCE_MS = 250; // 検索入力のたびに教室候補を取りに行くため、連続入力中は間引く

export interface NameFormHandle {
  root: HTMLElement;
  onShow: () => void;
  setSlotFilter: (slot: { day: number; period: number } | null) => void;
}

/** 「通年」は前期・後期どちらに実体を持つ開講データを使っても曜日・時限・科目名・担当教員は同じなので、
 * 教室候補の問い合わせには代表として前期を使う。 */
function representativeTerm(term: OfferingTerm): Term {
  return term === "both" ? "spring" : term;
}

export function buildNameForm(
  addSlot: (
    term: Term, day: number, period: number, courseName: string, location: string | null,
    instructor: string | null,
  ) => boolean,
  /** 今開いている学期タブ。一覧はこの学期と通年の科目だけに絞る */
  getCurrentTerm: () => Term,
): NameFormHandle {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      シラバスの開講科目一覧（<a href="/../syllabus_courses/" target="_blank" rel="noopener">programs/syllabus_courses</a>のデータ、2020〜2026年度分）から検索して選ぶと、
      科目自身の学期（前期・後期・通年）に応じて自動で挿入されます。一覧には、今開いている学期タブの科目と通年の科目だけが出ます
      （前期タブなら前期と通年、後期タブなら後期と通年。もう一方の学期の科目を探すときは、上の学期タブを切り替えてください）。
      過去の学年の時間割を登録する場合は、下の年度セレクトでその当時の年度に切り替えて検索してください。
      教室欄には、同じ開講（学期・曜日・時限・科目名・担当教員が一致するもの）に他の学生が登録した教室があれば自動で下書きされます
      （担当教員まで一致するものだけを見るので、同じ科目名でも別の先生が担当する別クラスの教室が混ざることはありません）。
      内容はいつでも自由に書き換えられ、追加後も「時間を指定して追加」で上書きできます。
      下のグリッドの空いているマスをクリックすると、そのコマに入れられる科目だけに絞り込めます。
    </p>
    <p class="hint slot-filter-badge" hidden></p>
    <p class="hint reg-term-note"></p>
    <div class="filters">
      <label>年度 <select class="reg-year"></select></label>
      <label>学部 <select class="reg-faculty"><option value="">すべての学部</option></select></label>
      <label>学科 <select class="reg-department" disabled><option value="">すべての学科</option></select></label>
    </div>
    <input type="search" class="reg-query" placeholder="科目名で検索（例: プログラミング）" autocomplete="off">
    <p class="hint reg-loading">読み込み中...</p>
    <ul class="offering-list" hidden></ul>
    <p class="message reg-message" hidden></p>
  `;

  const yearSelect = root.querySelector<HTMLSelectElement>(".reg-year")!;
  for (const y of AVAILABLE_COURSE_YEARS) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = `${y}年度`;
    if (y === DEFAULT_COURSE_YEAR) opt.selected = true;
    yearSelect.appendChild(opt);
  }

  const facultySelect = root.querySelector<HTMLSelectElement>(".reg-faculty")!;
  const departmentSelect = root.querySelector<HTMLSelectElement>(".reg-department")!;
  const queryInput = root.querySelector<HTMLInputElement>(".reg-query")!;
  const loadingEl = root.querySelector<HTMLParagraphElement>(".reg-loading")!;
  const listEl = root.querySelector<HTMLUListElement>(".offering-list")!;
  const termNoteEl = root.querySelector<HTMLParagraphElement>(".reg-term-note")!;
  const messageEl = root.querySelector<HTMLParagraphElement>(".reg-message")!;
  const slotFilterBadge = root.querySelector<HTMLParagraphElement>(".slot-filter-badge")!;

  let filtersLoaded = false;
  let offerings: CourseOffering[] = [];
  let slotFilter: { day: number; period: number } | null = null;
  let renderDebounceId: ReturnType<typeof setTimeout> | null = null;
  // 開講キー(年度込み)ごとの教室候補キャッシュ。同じ開講が検索し直すたびに再登場しても再問い合わせしない
  const suggestionCache = new Map<string, string | null>();

  /** 学部/学科の絞り込みセレクトは年度に依存しない共通データから作る（年度を切り替えても選択肢が変わらないように） */
  async function loadFilterOptions(): Promise<void> {
    if (filtersLoaded) return;
    const catalog = await loadDepartmentCatalog();
    for (const f of catalog.faculties) {
      const opt = document.createElement("option");
      opt.value = f.name;
      opt.textContent = f.name;
      facultySelect.appendChild(opt);
    }
    filtersLoaded = true;
  }

  async function loadOfferingsForYear(year: number): Promise<void> {
    loadingEl.hidden = false;
    listEl.hidden = true;
    try {
      const catalog = await loadCatalog(year);
      offerings = groupOfferings(catalog);
      render();
    } catch {
      loadingEl.textContent = `${year}年度の科目データを読み込めませんでした`;
      offerings = [];
    } finally {
      loadingEl.hidden = true;
    }
  }

  async function onShow(): Promise<void> {
    await loadFilterOptions();
    if (offerings.length === 0) {
      await loadOfferingsForYear(Number(yearSelect.value));
    }
  }

  yearSelect.addEventListener("change", () => {
    void loadOfferingsForYear(Number(yearSelect.value));
  });

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

  function offeringKey(o: CourseOffering): string {
    const slot = o.slots[0];
    return [representativeTerm(o.term), slot.day_of_week, slot.period, o.course_name, o.instructor ?? ""].join(" ");
  }

  /**
   * シラバス上は前期・後期が別々の行（＝通年とはラベルされていない）でも、同じ科目名・担当教員が
   * 同じ曜日・時限でもう一方の学期にも見つかる場合、それを返す。
   * 本当は同じ授業が前期・後期通して行われているだけ（シラバスの都合で行が分かれているだけ）の
   * ケースが実際にあるため、追加後に「もう一方の学期にも追加しますか？」と一括登録をワンクリックで
   * 提案するためだけに使う参考情報。自動で両学期に登録すると、無関係な2科目を誤って両学期に登録して
   * しまう不具合が過去にあったため、判断は必ずユーザーのクリックを介す。
   */
  function findSiblingTermOffering(o: CourseOffering): CourseOffering | undefined {
    if (o.term === "both") return undefined;
    const otherTerm: Term = o.term === "spring" ? "fall" : "spring";
    const slot = o.slots[0];
    return offerings.find((c) => (
      c.term === otherTerm && c.course_name === o.course_name && c.instructor === o.instructor
      && c.slots[0].day_of_week === slot.day_of_week && c.slots[0].period === slot.period
    ));
  }

  /** 教室入力欄に候補を下書きする。ユーザーが既に何か入力していたら上書きしない */
  async function fillLocationSuggestion(o: CourseOffering, input: HTMLInputElement): Promise<void> {
    const key = offeringKey(o);
    if (suggestionCache.has(key)) {
      const cached = suggestionCache.get(key) ?? null;
      if (cached && !input.value) input.value = cached;
      return;
    }
    try {
      const slot = o.slots[0];
      const res = await api.getLocationSuggestion(
        representativeTerm(o.term), slot.day_of_week, slot.period, o.course_name, o.instructor,
      );
      suggestionCache.set(key, res.location);
      // 問い合わせ中にリストが再描画されて要素がDOMから外れていても、
      // 値を入れておけば後で参照された時のためのキャッシュにはなる（無害）
      if (res.location && !input.value) input.value = res.location;
    } catch {
      // 候補が取得できなくても教室欄は空のまま手入力できるので、追加自体には支障ない
    }
  }

  function render(): void {
    const term = getCurrentTerm();
    const otherLabel = TERM_LABELS[term === "spring" ? "fall" : "spring"];
    termNoteEl.textContent = `${TERM_LABELS[term]}タブを表示中のため、${TERM_LABELS[term]}と通年の科目だけを表示しています`
      + `（${otherLabel}の科目は、上の学期タブを${otherLabel}に切り替えると表示されます）。`;

    const query = queryInput.value.trim();
    const faculty = facultySelect.value;
    const department = departmentSelect.value;
    if (!query && !faculty && !slotFilter) {
      listEl.hidden = true;
      listEl.replaceChildren();
      return;
    }
    let matched = filterOfferingsByTerm(searchOfferings(offerings, query, faculty, department), term);
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
        <div class="offering-location-row">
          <input type="text" class="offering-location-input" maxlength="100" placeholder="教室（任意）">
        </div>
      `;
      const locationInput = li.querySelector<HTMLInputElement>(".offering-location-input")!;
      void fillLocationSuggestion(o, locationInput);

      const siblingRow = document.createElement("div");
      siblingRow.className = "offering-sibling-row";
      siblingRow.hidden = true;
      li.appendChild(siblingRow);

      function addOffering(target: CourseOffering, location: string | null): number {
        const targetTerms: Term[] = target.term === "both" ? ["spring", "fall"] : [target.term];
        let addedCount = 0;
        for (const term of targetTerms) {
          for (const s of target.slots) {
            if (addSlot(term, s.day_of_week, s.period, target.course_name, location, target.instructor)) addedCount += 1;
          }
        }
        return addedCount;
      }

      /** 追加成功後、もう一方の学期にも同じ枠の科目があれば「そちらにも追加しますか？」を出す */
      function showSiblingSuggestionIfAny(location: string | null): void {
        const sibling = findSiblingTermOffering(o);
        if (!sibling) return;
        const siblingTermLabel = OFFERING_TERM_LABELS[sibling.term];
        siblingRow.replaceChildren();
        const text = document.createElement("span");
        text.textContent = `同じ枠に${siblingTermLabel}にも「${sibling.course_name}」があります。`;
        const addSiblingBtn = document.createElement("button");
        addSiblingBtn.type = "button";
        addSiblingBtn.className = "btn btn-ghost btn-sm";
        addSiblingBtn.textContent = `${siblingTermLabel}にも追加する`;
        addSiblingBtn.addEventListener("click", () => {
          addSiblingBtn.disabled = true;
          const addedCount = addOffering(sibling, location);
          if (addedCount > 0) {
            siblingRow.hidden = true;
            messageEl.textContent = `「${sibling.course_name}」を${siblingTermLabel}にも追加しました`;
            messageEl.className = "message message-ok reg-message";
            messageEl.hidden = false;
          } else {
            addSiblingBtn.disabled = false;
          }
        });
        siblingRow.append(text, addSiblingBtn);
        siblingRow.hidden = false;
      }

      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-primary btn-sm";
      addBtn.textContent = "追加";
      addBtn.addEventListener("click", () => {
        addBtn.disabled = true;
        try {
          const location = locationInput.value.trim() || null;
          const addedCount = addOffering(o, location);
          const termLabel = OFFERING_TERM_LABELS[o.term];
          messageEl.textContent = addedCount > 0
            ? `「${o.course_name}」を${termLabel}に追加しました（${slotsLabel}）${location ? ` 教室: ${location}` : ""}`
            : "追加しませんでした";
          messageEl.className = `message ${addedCount > 0 ? "message-ok" : "message-error"} reg-message`;
          messageEl.hidden = false;
          if (addedCount > 0) showSiblingSuggestionIfAny(location);
        } finally {
          addBtn.disabled = false;
        }
      });
      li.appendChild(addBtn);
      listEl.appendChild(li);
    }
  }

  /** 検索入力のたびに教室候補を再問い合わせすると連続入力中に無駄が多いので少し間引く */
  function scheduleRender(): void {
    if (renderDebounceId !== null) clearTimeout(renderDebounceId);
    renderDebounceId = setTimeout(() => {
      renderDebounceId = null;
      render();
    }, RENDER_DEBOUNCE_MS);
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
  queryInput.addEventListener("input", scheduleRender);

  return { root, onShow: () => void onShow(), setSlotFilter };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
