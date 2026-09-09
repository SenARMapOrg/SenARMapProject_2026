import { api } from "./api";
import { renderFriendsPanel } from "./friends-view";
import { renderTimetableTab } from "./timetable-tab";

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

void boot();
