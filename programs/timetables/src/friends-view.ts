import { api, ApiError, type Friend, type FriendRequest, type Term } from "./api";
import { guessCurrentTerm, renderReadonlyGrid, TERM_LABELS } from "./timetable-grid";

export async function renderFriendsPanel(container: HTMLElement): Promise<void> {
  container.replaceChildren();

  const formSection = document.createElement("section");
  formSection.className = "panel";
  formSection.innerHTML = `
    <h2>友達を追加</h2>
    <p class="hint">大学メールアドレスを指定して申請できます。相手が承認すると友達になります。</p>
    <form id="invite-form" class="inline-form">
      <input type="email" id="invite-email" placeholder="example@senshu-u.jp" required>
      <button type="submit" class="btn btn-primary">申請を送る</button>
    </form>
    <p id="invite-message" class="message" hidden></p>
  `;
  container.appendChild(formSection);

  const requestsSection = document.createElement("section");
  requestsSection.className = "panel";
  requestsSection.innerHTML = "<h2>申請</h2>";
  const requestsBody = document.createElement("div");
  requestsSection.appendChild(requestsBody);
  container.appendChild(requestsSection);

  const friendsSection = document.createElement("section");
  friendsSection.className = "panel";
  friendsSection.innerHTML = "<h2>友達一覧</h2>";
  const friendsBody = document.createElement("div");
  friendsSection.appendChild(friendsBody);
  container.appendChild(friendsSection);

  const viewerSection = document.createElement("section");
  viewerSection.className = "panel";
  viewerSection.id = "friend-viewer";
  viewerSection.hidden = true;
  container.appendChild(viewerSection);

  async function reload(): Promise<void> {
    const [{ friends }, { incoming, outgoing }] = await Promise.all([
      api.listFriends(),
      api.listRequests(),
    ]);
    renderRequests(requestsBody, incoming, outgoing, reload);
    renderFriends(friendsBody, friends, viewerSection, reload);
  }

  const form = formSection.querySelector<HTMLFormElement>("#invite-form")!;
  const emailInput = formSection.querySelector<HTMLInputElement>("#invite-email")!;
  const messageEl = formSection.querySelector<HTMLParagraphElement>("#invite-message")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    messageEl.hidden = true;
    try {
      const result = await api.sendFriendRequest(emailInput.value);
      messageEl.textContent = result.status === "auto_accepted"
        ? "相手からの申請と一致したため、すぐに友達になりました。"
        : "申請を送信しました。相手が承認すると友達になります。";
      messageEl.className = "message message-ok";
      messageEl.hidden = false;
      emailInput.value = "";
      await reload();
    } catch (err) {
      messageEl.textContent = err instanceof ApiError ? err.message : "送信に失敗しました";
      messageEl.className = "message message-error";
      messageEl.hidden = false;
    }
  });

  await reload();
}

function renderRequests(
  body: HTMLElement, incoming: FriendRequest[], outgoing: FriendRequest[], reload: () => Promise<void>,
): void {
  body.replaceChildren();

  if (incoming.length === 0 && outgoing.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "現在、保留中の申請はありません。";
    body.appendChild(p);
    return;
  }

  if (incoming.length > 0) {
    const h = document.createElement("h3");
    h.textContent = "届いている申請";
    body.appendChild(h);
    const list = document.createElement("ul");
    list.className = "request-list";
    for (const r of incoming) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${r.from_display_name ?? "?"} (${r.from_email ?? ""})`;
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "btn btn-primary btn-sm";
      acceptBtn.textContent = "承認";
      acceptBtn.addEventListener("click", async () => {
        await api.acceptFriendRequest(r.id);
        await reload();
      });
      const rejectBtn = document.createElement("button");
      rejectBtn.className = "btn btn-ghost btn-sm";
      rejectBtn.textContent = "拒否";
      rejectBtn.addEventListener("click", async () => {
        await api.rejectFriendRequest(r.id);
        await reload();
      });
      li.append(label, acceptBtn, rejectBtn);
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  if (outgoing.length > 0) {
    const h = document.createElement("h3");
    h.textContent = "送信した申請（承認待ち）";
    body.appendChild(h);
    const list = document.createElement("ul");
    list.className = "request-list";
    for (const r of outgoing) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = r.to_email;
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn btn-ghost btn-sm";
      cancelBtn.textContent = "取り消す";
      cancelBtn.addEventListener("click", async () => {
        await api.rejectFriendRequest(r.id);
        await reload();
      });
      li.append(label, cancelBtn);
      list.appendChild(li);
    }
    body.appendChild(list);
  }
}

function renderFriends(
  body: HTMLElement, friends: Friend[], viewerSection: HTMLElement, reload: () => Promise<void>,
): void {
  body.replaceChildren();

  if (friends.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "まだ友達がいません。上のフォームから申請してみましょう。";
    body.appendChild(p);
    return;
  }

  const list = document.createElement("ul");
  list.className = "friend-list";
  for (const f of friends) {
    const li = document.createElement("li");
    const viewBtn = document.createElement("button");
    viewBtn.className = "btn btn-link";
    viewBtn.textContent = f.display_name;
    viewBtn.addEventListener("click", () => showFriendTimetable(f, viewerSection));

    const unfriendBtn = document.createElement("button");
    unfriendBtn.className = "btn btn-ghost btn-sm";
    unfriendBtn.textContent = "解除";
    unfriendBtn.addEventListener("click", async () => {
      if (!confirm(`${f.display_name} さんとの友達関係を解除しますか？`)) return;
      await api.unfriend(f.id);
      viewerSection.hidden = true;
      await reload();
    });

    li.append(viewBtn, unfriendBtn);
    list.appendChild(li);
  }
  body.appendChild(list);
}

async function showFriendTimetable(friend: Friend, viewerSection: HTMLElement): Promise<void> {
  viewerSection.hidden = false;
  viewerSection.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `${friend.display_name} さんの時間割`;
  viewerSection.appendChild(h);

  const termTabs = document.createElement("div");
  termTabs.className = "term-tabs";
  const grid = document.createElement("div");
  const errorEl = document.createElement("p");
  errorEl.className = "message message-error";
  errorEl.hidden = true;

  const termButtons = (["spring", "fall"] as Term[]).map((term) => {
    const btn = document.createElement("button");
    btn.className = "term-tab";
    btn.textContent = TERM_LABELS[term];
    btn.dataset.term = term;
    btn.addEventListener("click", () => void loadTerm(term));
    termTabs.appendChild(btn);
    return btn;
  });

  async function loadTerm(term: Term): Promise<void> {
    termButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.term === term));
    errorEl.hidden = true;
    try {
      const { entries } = await api.getFriendTimetable(friend.id, term);
      renderReadonlyGrid(grid, entries);
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : "時間割を取得できませんでした";
      errorEl.hidden = false;
      grid.replaceChildren();
    }
  }

  viewerSection.append(termTabs, grid, errorEl);
  await loadTerm(guessCurrentTerm());
}
