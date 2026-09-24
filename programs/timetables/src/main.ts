import { api, type Me } from "./api";
import { renderBrowsePanel } from "./browse-view";
import { renderFriendsPanel } from "./friends-view";
import { buildAccountDeleteRow, buildSettingsPanel } from "./settings-view";
import { renderSharedView } from "./shared-view";
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

  appRoot.appendChild(buildSettingsPanel(me, (name) => {
    userNameEl.textContent = `${name} さん`;
  }));
  appRoot.appendChild(buildAccountDeleteRow());

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
