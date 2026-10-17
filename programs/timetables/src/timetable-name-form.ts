// 登録欄「科目名から追加」フォーム: ほかの学生がこの時間割サービスに登録した授業を科目名で検索し、
// 選ぶとその曜日・時限に追加する。シラバスなどの外部の科目データは使わない（候補は course-catalog.ts 参照。
// 2人以上が登録した授業だけが出る）。一覧に無い授業は「時間を指定して追加」で手入力する。
// 一覧は今開いている学期タブの授業だけ。編集画面のグリッドで空きコマをクリックした時、
// setSlotFilter() でその曜日・時限に絞り込める（「そのコマに入れられる科目」を見せるため）。
//
// 各授業（科目名・担当教員・曜日・時限の組）ごとに教室入力欄を1つ持つ。他の学生が同じ授業
// （学期・曜日・時限・科目名・担当教員が一致するもの）に登録した教室があれば自動で下書きするが、
// あくまで下書きであり、自分がここで上書きしてもそれは自分の登録内容が変わるだけで、
// 他の学生のデータを書き換えるわけではない（教室候補は毎回その場で他の学生の入力から
// 再集計されるだけで、共有の正本を持たない）。

import { api, type SharedCourse, type Term } from "./api";
import { findOtherTermCourse, loadSharedCourses, searchSharedCourses } from "./course-catalog";
import { createLocationField, type LocationField } from "./location-field";
import { DAY_LABELS, TERM_LABELS } from "./timetable-grid";

const MAX_COURSE_RESULTS = 30;
const RENDER_DEBOUNCE_MS = 250; // 検索入力のたびに教室候補を取りに行くため、連続入力中は間引く

export interface NameFormHandle {
  root: HTMLElement;
  onShow: () => void;
  setSlotFilter: (slot: { day: number; period: number } | null) => void;
}

export function buildNameForm(
  addSlot: (
    term: Term, day: number, period: number, courseName: string, location: string | null,
    instructor: string | null,
  ) => boolean,
  /** 今開いている学期タブ。一覧はこの学期の授業だけに絞る */
  getCurrentTerm: () => Term,
): NameFormHandle {
  const root = document.createElement("div");
  root.className = "reg-form";
  root.innerHTML = `
    <p class="hint">
      ほかの学生が登録した授業から、科目名で探して追加できます（2人以上が登録した授業だけが出ます）。
      一覧に無い授業は「時間を指定して追加・削除」で入力してください。
      教室欄には、同じ授業（学期・曜日・時限・科目名・担当教員が一致するもの）に他の学生が登録した教室があれば自動で下書きされます。
      内容はいつでも自由に書き換えられ、追加後も「時間を指定して追加」で上書きできます。
      下のグリッドの空いているマスをクリックすると、そのコマの授業だけに絞り込めます。
    </p>
    <p class="hint slot-filter-badge" hidden></p>
    <p class="hint reg-term-note"></p>
    <input type="search" class="reg-query" placeholder="科目名で検索（例: プログラミング）" autocomplete="off">
    <p class="hint reg-loading" hidden>読み込み中...</p>
    <ul class="offering-list" hidden></ul>
    <p class="hint reg-empty" hidden></p>
    <p class="message reg-message" hidden></p>
  `;

  const queryInput = root.querySelector<HTMLInputElement>(".reg-query")!;
  const loadingEl = root.querySelector<HTMLParagraphElement>(".reg-loading")!;
  const listEl = root.querySelector<HTMLUListElement>(".offering-list")!;
  const emptyEl = root.querySelector<HTMLParagraphElement>(".reg-empty")!;
  const termNoteEl = root.querySelector<HTMLParagraphElement>(".reg-term-note")!;
  const messageEl = root.querySelector<HTMLParagraphElement>(".reg-message")!;
  const slotFilterBadge = root.querySelector<HTMLParagraphElement>(".slot-filter-badge")!;

  let courses: SharedCourse[] = [];
  let loaded = false;
  let slotFilter: { day: number; period: number } | null = null;
  let renderDebounceId: ReturnType<typeof setTimeout> | null = null;
  // 授業ごとの教室候補キャッシュ。同じ授業が検索し直すたびに再登場しても再問い合わせしない
  const suggestionCache = new Map<string, string | null>();

  async function onShow(): Promise<void> {
    if (loaded) return;
    loadingEl.textContent = "読み込み中...";
    loadingEl.hidden = false;
    try {
      courses = await loadSharedCourses();
      loaded = true;
      loadingEl.hidden = true;
      render();
    } catch {
      loadingEl.textContent = "授業の一覧を読み込めませんでした。「時間を指定して追加・削除」からは追加できます";
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
    text.textContent = `${DAY_LABELS[slotFilter.day]}曜${slotFilter.period}限の授業のみ表示中　`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn-link";
    clearBtn.textContent = "絞り込み解除";
    clearBtn.addEventListener("click", () => setSlotFilter(null));
    slotFilterBadge.append(text, clearBtn);
  }

  function courseKey(c: SharedCourse): string {
    return [c.term, c.day_of_week, c.period, c.course_name, c.instructor ?? ""].join("\u0000");
  }

  /** 教室入力欄に候補を下書きする。ユーザーが既に何か入力していたら上書きしない */
  async function fillLocationSuggestion(c: SharedCourse, field: LocationField): Promise<void> {
    const key = courseKey(c);
    if (suggestionCache.has(key)) {
      const cached = suggestionCache.get(key) ?? null;
      if (cached && !field.input.value) field.setValue(cached);
      return;
    }
    try {
      const res = await api.getLocationSuggestion(c.term, c.day_of_week, c.period, c.course_name, c.instructor);
      suggestionCache.set(key, res.location);
      // 問い合わせ中にリストが再描画されて要素がDOMから外れていても、
      // 値を入れておけば後で参照された時のためのキャッシュにはなる（無害）
      if (res.location && !field.input.value) field.setValue(res.location);
    } catch {
      // 候補が取得できなくても教室欄は空のまま手入力できるので、追加自体には支障ない
    }
  }

  function showMessage(text: string, ok: boolean): void {
    messageEl.textContent = text;
    messageEl.className = `message ${ok ? "message-ok" : "message-error"} reg-message`;
    messageEl.hidden = false;
  }

  function render(): void {
    const term = getCurrentTerm();
    const otherLabel = TERM_LABELS[term === "spring" ? "fall" : "spring"];
    termNoteEl.textContent = `${TERM_LABELS[term]}タブを表示中のため、${TERM_LABELS[term]}の授業だけを表示しています`
      + `（${otherLabel}の授業は、上の学期タブを${otherLabel}に切り替えると表示されます）。`;

    listEl.replaceChildren();
    listEl.hidden = true;
    emptyEl.hidden = true;
    const query = queryInput.value.trim();
    if (!loaded || (!query && !slotFilter)) return;

    const matched = searchSharedCourses(courses, query, term, slotFilter).slice(0, MAX_COURSE_RESULTS);
    if (matched.length === 0) {
      emptyEl.textContent = "見つかりませんでした。「時間を指定して追加・削除」から入力して追加できます。";
      emptyEl.hidden = false;
      return;
    }
    listEl.hidden = false;
    for (const c of matched) {
      const li = document.createElement("li");
      const slotLabel = `${DAY_LABELS[c.day_of_week]}曜${c.period}限`;
      const termLabel = TERM_LABELS[c.term];
      li.innerHTML = `
        <div class="offering-main">
          <span class="offering-term-badge">${escapeHtml(termLabel)}</span>
          <span class="offering-name">${escapeHtml(c.course_name)}</span>
          <span class="offering-slots">${escapeHtml(slotLabel)}</span>
        </div>
        <div class="offering-sub">${escapeHtml(c.instructor ? `${c.instructor} ・ ` : "")}${c.user_count}人が登録</div>
        <div class="offering-location-row"></div>
      `;
      const locationField = createLocationField({ placeholder: "教室（任意・例: 10101教室・オンライン）" });
      li.querySelector(".offering-location-row")!.appendChild(locationField.root);
      const locationInput = locationField.input;
      void fillLocationSuggestion(c, locationField);

      const siblingRow = document.createElement("div");
      siblingRow.className = "offering-sibling-row";
      siblingRow.hidden = true;
      li.appendChild(siblingRow);

      /** 追加できたあと、もう一方の学期にも同じ授業が登録されていれば「そちらにも追加しますか？」を出す */
      function showSiblingSuggestionIfAny(location: string | null): void {
        const sibling = findOtherTermCourse(courses, c);
        if (!sibling) return;
        const siblingTermLabel = TERM_LABELS[sibling.term];
        siblingRow.replaceChildren();
        const text = document.createElement("span");
        text.textContent = `${siblingTermLabel}の同じコマにも「${sibling.course_name}」が登録されています。`;
        const addSiblingBtn = document.createElement("button");
        addSiblingBtn.type = "button";
        addSiblingBtn.className = "btn btn-ghost btn-sm";
        addSiblingBtn.textContent = `${siblingTermLabel}にも追加する`;
        addSiblingBtn.addEventListener("click", () => {
          addSiblingBtn.disabled = true;
          if (addSlot(sibling.term, sibling.day_of_week, sibling.period, sibling.course_name, location, sibling.instructor)) {
            siblingRow.hidden = true;
            showMessage(`「${sibling.course_name}」を${siblingTermLabel}にも追加しました`, true);
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
          const added = addSlot(c.term, c.day_of_week, c.period, c.course_name, location, c.instructor);
          showMessage(added
            ? `「${c.course_name}」を${termLabel}に追加しました（${slotLabel}）${location ? ` 教室: ${location}` : ""}`
            : "追加しませんでした", added);
          if (added) showSiblingSuggestionIfAny(location);
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
