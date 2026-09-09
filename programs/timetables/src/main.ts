import { api, ApiError, type Term, type TimetableEntry } from "./api";
import { renderFriendsPanel } from "./friends-view";
import { coursesMapToEntries, guessCurrentTerm, renderEditableGrid, TERM_LABELS } from "./timetable-grid";

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

  const me = await api.me();
  if (!me) {
    renderLoginView(loginError);
    userBox.hidden = true;
    return;
  }
  userBox.hidden = false;
  userNameEl.textContent = `${me.display_name} さん`;
  renderAppView();
}

function renderLoginView(loginError: string | null): void {
  appRoot.replaceChildren();
  const section = document.createElement("section");
  section.className = "panel login-panel";
  section.innerHTML = `
    <h1>時間割共有</h1>
    <p>大学のGoogleアカウントでログインすると、時間割の登録と友達との共有ができます。</p>
    <a class="btn btn-primary" href="/api/auth/login">Googleでログイン</a>
    ${loginError ? `<p class="message message-error">${describeLoginError(loginError)}</p>` : ""}
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

function renderAppView(): void {
  appRoot.replaceChildren();

  const tabs = document.createElement("div");
  tabs.className = "tabs";
  const tabTimetable = document.createElement("button");
  tabTimetable.className = "tab active";
  tabTimetable.textContent = "自分の時間割";
  const tabFriends = document.createElement("button");
  tabFriends.className = "tab";
  tabFriends.textContent = "友達";
  tabs.append(tabTimetable, tabFriends);
  appRoot.appendChild(tabs);

  const content = document.createElement("div");
  content.className = "app-tab-content";
  appRoot.appendChild(content);

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
    void renderTimetableTab(content);
  };
  const showFriendsTab = () => {
    tabFriends.classList.add("active");
    tabTimetable.classList.remove("active");
    void renderFriendsPanel(content);
  };

  tabTimetable.addEventListener("click", showTimetableTab);
  tabFriends.addEventListener("click", showFriendsTab);

  showTimetableTab();
}

async function renderTimetableTab(content: HTMLElement): Promise<void> {
  content.replaceChildren();
  let currentTerm: Term = guessCurrentTerm();

  const section = document.createElement("section");
  section.className = "panel";
  section.innerHTML = "<h2>自分の時間割</h2><p class=\"hint\">科目名を入力すると自動的に保存対象になります。空欄にするとそのコマは削除されます。</p>";

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
  section.appendChild(termTabs);

  const grid = document.createElement("div");
  section.appendChild(grid);

  const saveRow = document.createElement("div");
  saveRow.className = "save-row";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "保存";
  const messageEl = document.createElement("span");
  messageEl.className = "message";
  messageEl.hidden = true;
  saveRow.append(saveBtn, messageEl);
  section.appendChild(saveRow);

  content.appendChild(section);

  let courses = new Map<string, { course_name: string; location: string }>();

  async function loadTerm(term: Term): Promise<void> {
    currentTerm = term;
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    messageEl.hidden = true;
    courses = new Map();
    const { entries } = await api.getTimetable(term);
    renderEditableGrid(grid, entries, courses);
  }

  termButtons.forEach((btn) => {
    btn.addEventListener("click", () => void loadTerm(btn.dataset.term as Term));
  });

  await loadTerm(currentTerm);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    messageEl.hidden = true;
    try {
      const payload: TimetableEntry[] = coursesMapToEntries(courses);
      await api.putTimetable(currentTerm, payload);
      messageEl.textContent = "保存しました";
      messageEl.className = "message message-ok";
    } catch (err) {
      messageEl.textContent = err instanceof ApiError ? err.message : "保存に失敗しました";
      messageEl.className = "message message-error";
    } finally {
      messageEl.hidden = false;
      saveBtn.disabled = false;
    }
  });
}

void boot();
