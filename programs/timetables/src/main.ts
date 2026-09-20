import { api, ApiError, type Me } from "./api";
import { renderBrowsePanel } from "./browse-view";
import { loadDepartmentCatalog } from "./course-catalog";
import { renderFriendsPanel } from "./friends-view";
import { renderSharedView } from "./shared-view";
import { gradeLabel } from "./timetable-grid";
import { renderTimetableTab } from "./timetable-tab";

const MIN_GRADE = 1;
const MAX_GRADE = 8;

const appRoot = document.getElementById("app")!;
const userBox = document.getElementById("user-box")!;
const userNameEl = document.getElementById("user-name")!;
const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;

logoutBtn.addEventListener("click", async () => {
  await api.logout();
  location.reload();
});

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const loginError = params.get("login_error");
  const sharedToken = params.get("shared");

  const me = await api.me();
  if (!me) {
    // 共有リンクで来た未ログインの人にも、ログインすれば見られることが伝わるようにする
    // （リダイレクト後の自動復帰は今回は対応しない。ログイン後もう一度リンクを開いてもらう想定）。
    renderLoginView(loginError, sharedToken !== null);
    userBox.hidden = true;
    return;
  }
  userBox.hidden = false;
  userNameEl.textContent = `${me.nickname ?? me.display_name} さん`;

  if (sharedToken) {
    void renderSharedView(appRoot, sharedToken, () => {
      history.replaceState(null, "", location.pathname);
      renderAppView(me);
    });
    return;
  }
  renderAppView(me);
}

function renderLoginView(loginError: string | null, hasSharedLink: boolean): void {
  appRoot.replaceChildren();
  const section = document.createElement("section");
  section.className = "panel login-panel";
  section.innerHTML = `
    <h1>時間割共有</h1>
    <p>大学のGoogleアカウントでログインすると、時間割の登録と友達との共有ができます。</p>
    <a class="btn btn-primary" href="/api/auth/login">Googleでログイン</a>
    ${loginError ? `<p class="message message-error">${describeLoginError(loginError)}</p>` : ""}
    ${hasSharedLink ? '<p class="hint">共有リンクを見るにはログインが必要です。ログイン後、もう一度リンクを開いてください。</p>' : ""}
    <p class="hint">大学発行のメールアドレス以外ではログインできません。</p>
  `;
  appRoot.appendChild(section);
}

function describeLoginError(code: string): string {
  switch (code) {
    case "domain_not_allowed":
      return "大学発行のGoogleアカウントでログインしてください。";
    case "invalid_state":
    case "invalid_token":
    case "token_exchange_failed":
      return "ログインに失敗しました。もう一度お試しください。";
    default:
      return "ログインがキャンセルされました。";
  }
}

function renderAppView(me: Me): void {
  appRoot.replaceChildren();

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const tabTimetable = document.createElement("button");
  tabTimetable.className = "tab active";
  tabTimetable.textContent = "自分の時間割";
  const tabFriends = document.createElement("button");
  tabFriends.className = "tab";
  tabFriends.textContent = "友達";
  const tabBrowse = document.createElement("button");
  tabBrowse.className = "tab";
  tabBrowse.textContent = "みんなの時間割";
  tabs.append(tabTimetable, tabFriends, tabBrowse);
  appRoot.appendChild(tabs);

  const content = document.createElement("div");
  content.className = "app-tab-content";
  appRoot.appendChild(content);

  const settingsSection = document.createElement("section");
  settingsSection.className = "panel";
  settingsSection.innerHTML = `
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
  const nicknameForm = settingsSection.querySelector<HTMLFormElement>("form")!;
  const nicknameInput = settingsSection.querySelector<HTMLInputElement>(".nickname-input")!;
  const nicknameMessageEl = settingsSection.querySelector<HTMLParagraphElement>(".nickname-message")!;
  nicknameInput.value = me.nickname ?? "";
  nicknameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    nicknameMessageEl.hidden = true;
    try {
      const updated = await api.updateNickname(nicknameInput.value.trim() || null);
      me.nickname = updated.nickname;
      nicknameInput.value = updated.nickname ?? "";
      userNameEl.textContent = `${updated.nickname ?? updated.display_name} さん`;
      nicknameMessageEl.textContent = "あだ名を保存しました";
      nicknameMessageEl.className = "message message-ok nickname-message";
    } catch (err) {
      nicknameMessageEl.textContent = err instanceof ApiError ? err.message : "保存に失敗しました";
      nicknameMessageEl.className = "message message-error nickname-message";
    } finally {
      nicknameMessageEl.hidden = false;
    }
  });

  const gradeSelect = settingsSection.querySelector<HTMLSelectElement>(".profile-grade")!;
  const facultySelect = settingsSection.querySelector<HTMLSelectElement>(".profile-faculty")!;
  const departmentSelect = settingsSection.querySelector<HTMLSelectElement>(".profile-department")!;
  const profileMessageEl = settingsSection.querySelector<HTMLParagraphElement>(".profile-message")!;

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

  async function saveProfile(patch: { faculty?: string | null; department?: string | null; current_grade?: number }): Promise<void> {
    profileMessageEl.hidden = true;
    try {
      const updated = await api.updateProfile(patch);
      me.faculty = updated.faculty;
      me.department = updated.department;
      me.current_grade = updated.current_grade;
      profileMessageEl.textContent = "設定を保存しました";
      profileMessageEl.className = "message message-ok profile-message";
    } catch (err) {
      profileMessageEl.textContent = err instanceof ApiError ? err.message : "設定の変更に失敗しました";
      profileMessageEl.className = "message message-error profile-message";
    } finally {
      profileMessageEl.hidden = false;
    }
  }

  gradeSelect.addEventListener("change", () => {
    void saveProfile({ current_grade: Number(gradeSelect.value) });
  });
  facultySelect.addEventListener("change", () => {
    refreshDepartmentOptions(facultySelect.value, null);
    void saveProfile({ faculty: facultySelect.value || null, department: null });
  });
  departmentSelect.addEventListener("change", () => {
    void saveProfile({ department: departmentSelect.value || null });
  });

  appRoot.appendChild(settingsSection);

  const settings = document.createElement("div");
  settings.className = "settings-link";
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
  settings.appendChild(deleteBtn);
  appRoot.appendChild(settings);

  const showTimetableTab = () => {
    tabTimetable.classList.add("active");
    tabFriends.classList.remove("active");
    tabBrowse.classList.remove("active");
    void renderTimetableTab(content, me);
  };
  const showFriendsTab = () => {
    tabFriends.classList.add("active");
    tabTimetable.classList.remove("active");
    tabBrowse.classList.remove("active");
    void renderFriendsPanel(content);
  };
  const showBrowseTab = () => {
    tabBrowse.classList.add("active");
    tabTimetable.classList.remove("active");
    tabFriends.classList.remove("active");
    void renderBrowsePanel(content);
  };

  tabTimetable.addEventListener("click", showTimetableTab);
  tabFriends.addEventListener("click", showFriendsTab);
  tabBrowse.addEventListener("click", showBrowseTab);

  showTimetableTab();
}

void boot();
