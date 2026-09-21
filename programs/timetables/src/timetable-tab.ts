// 「自分の時間割」タブ: 表示画面(読み取り専用グリッド)と編集画面(グリッド+登録欄)を分けて、
// 誤操作で追加・削除されないようにする。編集画面へは「科目を追加・削除する」ボタンを押して
// 明示的に切り替える。
//
// 学年（メイン軸）+学期（サブ軸）で複数のスナップショットを持てる。表示・編集は
// 常に「今選んでいる学年+学期」に対して行われる。データはメモリ上に学年×学期ごとに
// 個別キャッシュし（`${grade}-${term}` キー）、切り替えるたびにサーバーへ取りに行くのではなく
// 一度取得したものは使い回す（保存時は最新のレスポンスで上書きする）。
//
// ナビ機能（今日・次の授業表示）は「今表示中の学年」ではなく常に `me.current_grade`
// （プロフィール設定で選んだ「今の学年」）を見る。過去の学年を見ながら今日の予定を確認したい
// 場合があるため、表示中の学年とは独立にしている。

import {
  api, ApiError, type Me, type Term, type Visibility, VISIBILITY_LABELS,
} from "./api";
import {
  buildSlotMap, DAY_LABELS, entryKey, getNowInfo, gradeLabel, guessCurrentTerm, PERIOD_TIMES,
  renderInteractiveGrid, renderReadonlyGrid, slotMapToEntries, TERM_LABELS, type SlotMap,
} from "./timetable-grid";
import { buildNameForm } from "./timetable-name-form";
import { buildSlotForm } from "./timetable-slot-form";

// ナビ(programs/html/navi)は別サブドメインで公開されている。?from=&to= で教室名を渡すと
// 自動でルート検索まで行ってくれる（該当する教室が見つからない場合は入力済みの状態で開くだけ）。
const NAVI_BASE_URL = "https://iku-navi.net/navi/";
const NAV_REFRESH_INTERVAL_MS = 30_000;

function snapshotKey(grade: number, term: Term): string {
  return `${grade}-${term}`;
}

export async function renderTimetableTab(content: HTMLElement, me: Me): Promise<void> {
  content.replaceChildren();

  let currentGrade: number = me.current_grade;
  let currentTerm: Term = guessCurrentTerm();
  let selectedSlot: { day: number; period: number } | null = null;
  const slotsByKey: Record<string, SlotMap> = {};
  // 学年タブに表示する学年一覧。listMyGrades()の結果 + me.current_grade + 手動で追加した学年を保持する
  const knownGrades = new Set<number>([me.current_grade]);

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
  }
  function exitEditMode(): void {
    editSection.hidden = true;
    displaySection.hidden = false;
  }
  editToggleBtn.addEventListener("click", enterEditMode);
  backToViewBtn.addEventListener("click", exitEditMode);

  function currentSlots(): SlotMap {
    return slotsByKey[snapshotKey(currentGrade, currentTerm)] ?? new Map();
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
  }

  async function addGrade(): Promise<void> {
    const raw = prompt("追加する学年を入力してください（例: 1〜8の整数）");
    if (raw === null) return;
    const grade = Number(raw.trim());
    if (!Number.isInteger(grade) || grade < 1 || grade > 8) {
      alert("学年は1〜8の整数で入力してください。");
      return;
    }
    knownGrades.add(grade);
    refreshGradeTabs();
    await showGrade(grade);
  }

  /**
   * 「今の教室→次の教室」ナビボタン。学年は表示中の学年タブとは無関係に、実際の「今」の学年
   * （me.current_grade）を見る。学期は「今が前期か後期か」をカレンダーだけから機械的に
   * 判定すると学期の切り替わり時期にずれることがあるため、代わりに今開いている学期タブ
   * （currentTerm）をそのまま「今の学期」として使う。学期タブを切り替えると、この案内も
   * その学期の登録内容に基づいて更新される。
   * 次の時限に教室が登録されていない場合はナビを開けない（行き先が無いと案内できないため）。
   * 今の時限に教室が無い場合は「空」のまま出発地なしで開く。
   */
  async function refreshNavPanel(): Promise<void> {
    navPanel.replaceChildren();
    const now = getNowInfo();

    if (now.todayIndex === null) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "本日(日曜)は時限がありません。";
      navPanel.appendChild(p);
      return;
    }

    const liveTerm = currentTerm;
    await ensureSnapshotLoaded(me.current_grade, liveTerm);
    const todaySlots = slotsByKey[snapshotKey(me.current_grade, liveTerm)] ?? new Map();
    const currentEntry = now.currentPeriod !== null
      ? todaySlots.get(entryKey(now.todayIndex, now.currentPeriod)) ?? null : null;
    const nextEntry = now.nextPeriod !== null
      ? todaySlots.get(entryKey(now.todayIndex, now.nextPeriod)) ?? null : null;

    const describe = (period: number | null, entry: { course_name: string; location: string } | null): string => {
      if (period === null) return "";
      const time = `${PERIOD_TIMES[period].start}〜${PERIOD_TIMES[period].end}`;
      if (!entry) return `${period}限 (${time}) 空きコマ`;
      return `${period}限 (${time}) ${entry.course_name}${entry.location ? ` / ${entry.location}` : ""}`;
    };

    const statusEl = document.createElement("p");
    statusEl.className = "hint nav-status";
    statusEl.textContent = `(${TERM_LABELS[liveTerm]}の時間割を表示中) 現在: ${now.currentPeriod !== null ? describe(now.currentPeriod, currentEntry) : "授業時間外"}　次: ${now.nextPeriod !== null ? describe(now.nextPeriod, nextEntry) : "本日はこれ以上時限がありません"}`;
    navPanel.appendChild(statusEl);

    if (now.nextPeriod === null) return;
    if (!nextEntry?.location) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "次のコマの教室が登録されていないため、ナビを開けません。";
      navPanel.appendChild(hint);
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
    navPanel.appendChild(link);
  }

  function onGridCellClick(day: number, period: number): void {
    selectedSlot = { day, period };
    const existing = currentSlots().get(entryKey(day, period)) ?? null;
    slotForm.selectSlot(day, period, existing);
    nameForm.setSlotFilter(existing ? null : { day, period });
    refreshEditGrid();
  }

  async function refreshVisibilityPanel(): Promise<void> {
    visibilityPanel.replaceChildren();
    let settings;
    try {
      settings = await api.getSnapshotSettings(currentGrade, currentTerm);
    } catch {
      return; // 表示できなくても致命的ではないので静かに諦める
    }

    const label = document.createElement("label");
    label.className = "visibility-label";
    label.textContent = "公開範囲";
    const select = document.createElement("select");
    select.className = "visibility-select";
    (Object.keys(VISIBILITY_LABELS) as Visibility[]).forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = VISIBILITY_LABELS[v];
      if (v === settings!.visibility) opt.selected = true;
      select.appendChild(opt);
    });
    label.appendChild(select);
    visibilityPanel.appendChild(label);

    const shareRow = document.createElement("div");
    shareRow.className = "share-row";
    visibilityPanel.appendChild(shareRow);

    function renderShareRow(shareUrl: string | null): void {
      shareRow.replaceChildren();
      if (!shareUrl) return;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "共有リンクをコピー";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          copyBtn.textContent = "コピーしました";
          setTimeout(() => { copyBtn.textContent = "共有リンクをコピー"; }, 2000);
        }).catch(() => {
          prompt("コピーできませんでした。手動でコピーしてください:", shareUrl);
        });
      });
      shareRow.appendChild(copyBtn);
    }
    renderShareRow(settings.share_url);

    select.addEventListener("change", () => {
      void (async () => {
        select.disabled = true;
        try {
          const updated = await api.updateSnapshotSettings(currentGrade, currentTerm, select.value as Visibility);
          renderShareRow(updated.share_url);
        } catch (err) {
          alert(err instanceof ApiError ? err.message : "公開範囲の更新に失敗しました");
          select.value = settings!.visibility;
        } finally {
          select.disabled = false;
        }
      })();
    });
  }

  async function ensureSnapshotLoaded(grade: number, term: Term): Promise<void> {
    const key = snapshotKey(grade, term);
    if (slotsByKey[key]) return;
    const res = await api.getTimetable(grade, term);
    slotsByKey[key] = buildSlotMap(res.entries);
  }

  async function showTerm(term: Term): Promise<void> {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    editTermButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    selectedSlot = null;
    nameForm.setSlotFilter(null);
    await ensureSnapshotLoaded(currentGrade, term);
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
      ensureSnapshotLoaded(grade, "spring"),
      ensureSnapshotLoaded(grade, "fall"),
    ]);
    await showTerm(currentTerm);
  }

  termButtons.forEach((btn) => {
    btn.addEventListener("click", () => void showTerm(btn.dataset.term as Term));
  });
  editTermButtons.forEach((btn) => {
    btn.addEventListener("click", () => void showTerm(btn.dataset.term as Term));
  });

  /**
   * 指定した学年の前期・後期をまとめて保存する。追加・削除のたびに自動保存
   * （scheduleAutoSave）される他、保存ボタンからも即時呼び出される
   * （保存し忘れによる編集内容のロストを防ぐため、手動保存を必須にしない）。
   */
  async function saveGrade(grade: number): Promise<void> {
    saveMessageEl.hidden = true;
    try {
      const [springRes, fallRes] = await Promise.all([
        api.putTimetable(grade, "spring", slotMapToEntries(slotsByKey[snapshotKey(grade, "spring")] ?? new Map())),
        api.putTimetable(grade, "fall", slotMapToEntries(slotsByKey[snapshotKey(grade, "fall")] ?? new Map())),
      ]);
      slotsByKey[snapshotKey(grade, "spring")] = buildSlotMap(springRes.entries);
      slotsByKey[snapshotKey(grade, "fall")] = buildSlotMap(fallRes.entries);
      knownGrades.add(grade);
      refreshGradeTabs();
      if (grade === currentGrade) {
        refreshViewGrid();
        refreshEditGrid();
      }
      void refreshNavPanel();
      saveMessageEl.textContent = `${gradeLabel(grade)}の前期・後期どちらも保存しました`;
      saveMessageEl.className = "message message-ok";
    } catch (err) {
      saveMessageEl.textContent = err instanceof ApiError ? err.message : "保存に失敗しました";
      saveMessageEl.className = "message message-error";
    } finally {
      saveMessageEl.hidden = false;
    }
  }

  // 追加・削除のたびに毎回即保存すると連続操作中に無駄なPUTが増えるので少し間引く。
  // 間引いている間に複数の学年をまたいで編集された場合に備え、保存待ちの学年を集合で持つ。
  const AUTO_SAVE_DEBOUNCE_MS = 600;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  const dirtyGrades = new Set<number>();

  function scheduleAutoSave(grade: number): void {
    dirtyGrades.add(grade);
    if (autoSaveTimer !== null) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      const grades = [...dirtyGrades];
      dirtyGrades.clear();
      for (const g of grades) void saveGrade(g);
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await saveGrade(currentGrade);
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
    const snapKey = snapshotKey(currentGrade, term);
    const slots = slotsByKey[snapKey] ?? new Map();
    slotsByKey[snapKey] = slots;
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
    scheduleAutoSave(currentGrade);
    return true;
  }

  /** 1コマ削除する。何も入っていなければ何もしない */
  function removeSlot(term: Term, day: number, period: number): boolean {
    const key = entryKey(day, period);
    const slots = slotsByKey[snapshotKey(currentGrade, term)];
    if (!slots?.has(key)) return false;
    slots.delete(key);
    if (term === currentTerm) {
      refreshViewGrid();
      refreshEditGrid();
    }
    void refreshNavPanel();
    scheduleAutoSave(currentGrade);
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
