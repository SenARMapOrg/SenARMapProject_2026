import { api, ApiError, type Me } from "./api";
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
  userNameEl.textContent = `${me.nickname ?? me.display_name} さん`;
  renderAppView(me);
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
  tabs.append(tabTimetable, tabFriends);
  appRoot.appendChild(tabs);

  const content = document.createElement("div");
  content.className = "app-tab-content";
  appRoot.appendChild(content);

  const nicknameSection = document.createElement("section");
  nicknameSection.className = "panel";
  nicknameSection.innerHTML = `
    <h2>あだ名</h2>
    <p class="hint">
      友達には本名の代わりにここで設定したあだ名が表示されます（未設定の場合はGoogleアカウントの名前が使われます）。
    </p>
    <form class="inline-form">
      <input type="text" class="nickname-input" maxlength="30" placeholder="あだ名（未設定なら本名を表示）">
      <button type="submit" class="btn btn-primary">保存</button>
    </form>
    <p class="message nickname-message" hidden></p>
  `;
  const nicknameForm = nicknameSection.querySelector<HTMLFormElement>("form")!;
  const nicknameInput = nicknameSection.querySelector<HTMLInputElement>(".nickname-input")!;
  const nicknameMessageEl = nicknameSection.querySelector<HTMLParagraphElement>(".nickname-message")!;
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
  appRoot.appendChild(nicknameSection);

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
