// 設定パネル（あだ名・現在の学年・学部学科）とアカウント削除。
//
// 「現在の学年」は今日・次の授業の案内に使う学年で、時間割タブで表示中の学年とは独立。
// 学部・学科は「みんなの時間割を探す」での絞り込み用の自己申告項目。
// いずれも変更した時点でその場で保存する（保存ボタンは置かない）。

import { api, ApiError, type Me } from "./api";
import { loadDepartmentCatalog } from "./course-catalog";
import { gradeLabel } from "./timetable-grid";

const MIN_GRADE = 1;
const MAX_GRADE = 8;

const SETTINGS_HTML = `
    <h2>設定</h2>
    <h3>あだ名</h3>
    <p class="hint">
      友達には本名の代わりにここで設定したあだ名が表示されます（未設定の場合はGoogleアカウントの名前が使われます）。
    </p>
    <form class="inline-form">
      <input type="text" class="nickname-input" maxlength="30" placeholder="あだ名（未設定なら本名を表示）">
      <button type="submit" class="btn btn-primary">保存</button>
    </form>
    <p class="message nickname-message" hidden></p>
    <h3>学年・学部・学科</h3>
    <p class="hint">
      「現在の学年」は今日・次の授業の案内に使われます（表示中に選んでいる学年とは独立です）。
      学部・学科は「みんなの時間割を探す」で自分の公開中の時間割が見つかりやすくなるように
      設定する自己申告の項目です（未設定でも構いません）。
    </p>
    <div class="filters profile-filters">
      <label>現在の学年 <select class="profile-grade"></select></label>
      <label>学部 <select class="profile-faculty"><option value="">未設定</option></select></label>
      <label>学科 <select class="profile-department" disabled><option value="">未設定</option></select></label>
    </div>
    <p class="message profile-message" hidden></p>
`;

function showMessage(el: HTMLElement, text: string, ok: boolean, extraClass: string): void {
  el.textContent = text;
  el.className = `message ${ok ? "message-ok" : "message-error"} ${extraClass}`;
  el.hidden = false;
}

/**
 * 設定パネルを組み立てる。
 * onDisplayNameChange はヘッダーの「〜さん」表示を更新するために呼ばれる。
 */
export function buildSettingsPanel(me: Me, onDisplayNameChange: (name: string) => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel";
  section.innerHTML = SETTINGS_HTML;

  buildNicknameForm(section, me, onDisplayNameChange);
  buildProfileForm(section, me);
  return section;
}

function buildNicknameForm(section: HTMLElement, me: Me, onDisplayNameChange: (name: string) => void): void {
  const form = section.querySelector<HTMLFormElement>("form")!;
  const input = section.querySelector<HTMLInputElement>(".nickname-input")!;
  const messageEl = section.querySelector<HTMLParagraphElement>(".nickname-message")!;
  input.value = me.nickname ?? "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    messageEl.hidden = true;
    try {
      const updated = await api.updateNickname(input.value.trim() || null);
      me.nickname = updated.nickname;
      input.value = updated.nickname ?? "";
      onDisplayNameChange(updated.nickname ?? updated.display_name);
      showMessage(messageEl, "あだ名を保存しました", true, "nickname-message");
    } catch (err) {
      showMessage(messageEl, err instanceof ApiError ? err.message : "保存に失敗しました", false, "nickname-message");
    }
  });
}

function buildProfileForm(section: HTMLElement, me: Me): void {
  const gradeSelect = section.querySelector<HTMLSelectElement>(".profile-grade")!;
  const facultySelect = section.querySelector<HTMLSelectElement>(".profile-faculty")!;
  const departmentSelect = section.querySelector<HTMLSelectElement>(".profile-department")!;
  const messageEl = section.querySelector<HTMLParagraphElement>(".profile-message")!;

  for (let g = MIN_GRADE; g <= MAX_GRADE; g += 1) {
    const opt = document.createElement("option");
    opt.value = String(g);
    opt.textContent = gradeLabel(g);
    if (g === me.current_grade) opt.selected = true;
    gradeSelect.appendChild(opt);
  }

  const departmentsByFaculty: Record<string, string[]> = {};
  void loadDepartmentCatalog().then((catalog) => {
    for (const f of catalog.faculties) {
      const opt = document.createElement("option");
      opt.value = f.name;
      opt.textContent = f.name;
      if (f.name === me.faculty) opt.selected = true;
      facultySelect.appendChild(opt);
      departmentsByFaculty[f.name] = f.departments.map((d) => d.name);
    }
    if (me.faculty) refreshDepartmentOptions(me.faculty, me.department);
  }).catch(() => {
    // 学部/学科データが読み込めなくても、他の設定項目は使えるようにしておく
  });

  function refreshDepartmentOptions(faculty: string, selected: string | null): void {
    departmentSelect.innerHTML = '<option value="">未設定</option>';
    departmentSelect.disabled = !faculty;
    for (const d of departmentsByFaculty[faculty] ?? []) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      if (d === selected) opt.selected = true;
      departmentSelect.appendChild(opt);
    }
  }

  async function save(patch: { faculty?: string | null; department?: string | null; current_grade?: number }): Promise<void> {
    messageEl.hidden = true;
    try {
      const updated = await api.updateProfile(patch);
      me.faculty = updated.faculty;
      me.department = updated.department;
      me.current_grade = updated.current_grade;
      showMessage(messageEl, "設定を保存しました", true, "profile-message");
    } catch (err) {
      showMessage(messageEl, err instanceof ApiError ? err.message : "設定の変更に失敗しました", false, "profile-message");
    }
  }

  gradeSelect.addEventListener("change", () => {
    void save({ current_grade: Number(gradeSelect.value) });
  });
  facultySelect.addEventListener("change", () => {
    refreshDepartmentOptions(facultySelect.value, null);
    void save({ faculty: facultySelect.value || null, department: null });
  });
  departmentSelect.addEventListener("change", () => {
    void save({ department: departmentSelect.value || null });
  });
}

/** アカウント削除ボタン（押すと確認のうえ全データを削除して再読み込みする） */
export function buildAccountDeleteRow(): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-link";
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn-ghost btn-sm";
  deleteBtn.textContent = "アカウントを削除する";
  deleteBtn.addEventListener("click", async () => {
    if (!confirm("アカウントを削除すると、時間割・友達関係を含む全データが完全に削除されます。元に戻せません。よろしいですか？")) {
      return;
    }
    await api.deleteAccount();
    location.reload();
  });
  row.appendChild(deleteBtn);
  return row;
}
