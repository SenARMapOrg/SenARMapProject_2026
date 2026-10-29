// 管理画面の「相談窓口」。IKU NAVI の利用者（ナビ画面の「？」→「オペレーターにつなぐ」）とチャットする。
//
// SUPPORT_POLL_MS ごとに /api/admin/support/state を呼び、相談の一覧と、開いている相談の新しいメッセージを受け取る。
// この確認がオペレーターが画面を開いている合図にもなる（止まって1分半たつと、利用者の画面からつなげなくなる）。
// オペレーターがほかの作業をしながら待てるよう、タブが裏に回っていても確認を続け、相談が来たら音で知らせる
// （裏のタブではブラウザが確認の間隔を最大1分ほどに延ばすので、受付中とみなす時間を1分半にしている）。

import { formatDbTime, formatWaiting, supportStatusLabel, waitingLevel, waitingMinutes } from "./admin-format";
import { api, ApiError, type SupportConversation, type SupportMessage, type SupportState } from "./api";

const SUPPORT_POLL_MS = 4000;
const MAX_REPLY_CHARS = 500;
const BASE_TITLE = document.title;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

/** 新しい相談・メッセージが来たときの短い音（音声ファイルを置かずに鳴らす） */
function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => { void ctx.close(); };
  } catch {
    // 音が出せない環境では鳴らさない
  }
}

export function createSupportPanel(onAuthError: (err: ApiError) => void): HTMLElement {
  const section = el("section", { className: "panel support-panel" });

  const acceptBtn = el("button", { className: "btn btn-primary" });
  const statusText = el("span", { className: "hint support-status" });
  const head = el("div", { className: "support-head" });
  head.append(el("h1", { text: "相談窓口" }), acceptBtn, statusText);
  const errorText = el("p", { className: "support-error" });
  errorText.hidden = true;

  /** うまくいかなかったことを画面に出す（サーバーのエラーは、DBの表が無いなど設定の漏れのことが多い） */
  function showError(what: string, err: unknown): void {
    const detail = err instanceof ApiError ? `（${err.status}: ${err.message}）` : "（通信できませんでした）";
    const hint = err instanceof ApiError && err.status >= 500
      ? " 本番のDBに相談窓口の表が無い可能性があります。docs/help_chat.md の「使えるようにする手順」を確かめてください。"
      : "";
    errorText.textContent = `${what}${detail}${hint}`;
    errorText.hidden = false;
  }

  const list = el("div", { className: "support-list" });
  const detail = el("div", { className: "support-detail" });
  const body = el("div", { className: "support-body" });
  body.append(list, detail);

  section.append(
    head,
    errorText,
    el("p", {
      className: "hint",
      text: "「受け付ける」にしている間は、IKU NAVI の「？」で AI に質問した人が、オペレーターにつなげるようになります。"
        + "別のタブにしていても受け付けは続き、相談が来ると音が鳴ります。この画面を閉じると、1分半ほどで受け付けが止まります。"
        + "利用者の名前などの個人情報は聞かないでください。",
    }),
    body,
  );

  // ---- 開いている相談 ----
  let state: SupportState | null = null;
  let openId: number | null = null;
  let lastMessageId = 0;
  const messageLog = el("div", { className: "support-log" });
  const replyInput = el("textarea", { className: "support-input" });
  replyInput.rows = 3;
  replyInput.maxLength = MAX_REPLY_CHARS;
  replyInput.placeholder = "返事を書く（Ctrl+Enter / ⌘+Enter で送る）";
  const sendBtn = el("button", { className: "btn btn-primary", text: "送る" });
  const closeBtn = el("button", { className: "btn btn-ghost support-close", text: "相談を終える" });
  const contextBox = el("details", { className: "support-context" });
  const detailTitle = el("h2");
  const replyForm = el("form", { className: "support-form" });
  replyForm.append(replyInput, sendBtn);
  sendBtn.type = "submit";

  function renderDetailEmpty(): void {
    detail.replaceChildren(el("p", { className: "hint", text: "左の一覧から相談を選んでください。" }));
  }

  function openConversation(id: number): void {
    openId = id;
    lastMessageId = 0;
    messageLog.replaceChildren();
    contextBox.replaceChildren();
    detail.replaceChildren(detailTitle, contextBox, messageLog, replyForm, closeBtn);
    void refresh();
  }

  function appendMessages(messages: SupportMessage[]): void {
    for (const m of messages) {
      const item = el("div", { className: `support-msg ${m.sender}` });
      item.append(
        el("div", { className: "support-msg-body", text: m.body }),
        el("div", { className: "support-msg-time", text: formatDbTime(m.created_at) }),
      );
      messageLog.appendChild(item);
      lastMessageId = Math.max(lastMessageId, m.id);
    }
    if (messages.length) messageLog.scrollTop = messageLog.scrollHeight;
  }

  /** 待ち時間の表示（「⏱ 5分待ち」）。返事を待っていなければ null */
  function waitingBadge(c: SupportConversation | undefined, now: string): HTMLElement | null {
    const minutes = waitingMinutes(c?.waiting_since, now);
    if (minutes === null) return null;
    return el("span", { className: `support-waiting ${waitingLevel(minutes)}`, text: `⏱ ${formatWaiting(minutes)}待ち` });
  }

  function renderOpen(
    conversation: SupportConversation, messages: SupportMessage[], summary: SupportConversation | undefined, now: string,
  ): void {
    detailTitle.replaceChildren(`相談 #${conversation.id}（${supportStatusLabel(conversation.status)}）`);
    const badge = waitingBadge(summary, now);
    if (badge) detailTitle.append(" ", badge);
    if (conversation.context && !contextBox.childElementCount) {
      contextBox.append(
        el("summary", { text: "つなぐ前の AI とのやりとり" }),
        el("pre", { className: "support-context-text", text: conversation.context }),
      );
    }
    contextBox.hidden = !conversation.context;
    appendMessages(messages);
    const closed = conversation.status === "closed";
    replyInput.disabled = closed;
    sendBtn.disabled = closed;
    closeBtn.hidden = closed;
  }

  // ---- 一覧 ----
  /** 返事を待っている相談を、長く待っている順に上へ。それ以外はサーバーの順（新しく動いた順）のまま */
  function sortForReply(conversations: SupportConversation[]): SupportConversation[] {
    const waiting = conversations.filter((c) => c.waiting_since)
      .sort((a, b) => (a.waiting_since! < b.waiting_since! ? -1 : a.waiting_since! > b.waiting_since! ? 1 : 0));
    return [...waiting, ...conversations.filter((c) => !c.waiting_since)];
  }

  function renderList(conversations: SupportConversation[], now: string): void {
    if (!conversations.length) {
      list.replaceChildren(el("p", { className: "hint", text: "相談はまだありません。" }));
      return;
    }
    list.replaceChildren(...sortForReply(conversations).map((c) => {
      const item = el("button", { className: `support-item ${c.status}${c.id === openId ? " selected" : ""}` });
      item.type = "button";
      const top = el("div", { className: "support-item-top" });
      top.append(
        el("span", { className: `support-badge ${c.status}`, text: supportStatusLabel(c.status) }),
        el("span", { text: `#${c.id}` }),
        el("span", { className: "support-item-time", text: formatDbTime(c.updated_at) }),
      );
      if (c.user_unread > 0) top.appendChild(el("span", { className: "support-unread", text: String(c.user_unread) }));
      item.append(top, el("div", { className: "support-item-last", text: c.last_body ?? "" }));
      const badge = waitingBadge(c, now);
      if (badge) item.appendChild(badge);
      item.addEventListener("click", () => openConversation(c.id));
      return item;
    }));
  }

  function renderHead(s: SupportState): void {
    acceptBtn.textContent = s.accepting ? "受け付けをやめる" : "受け付ける";
    acceptBtn.className = s.accepting ? "btn btn-ghost" : "btn btn-primary";
    statusText.textContent = s.accepting
      ? `受け付けています（受け付けているオペレーター: ${s.accepting_operators}人）`
      : `受け付けていません（受け付けているオペレーター: ${s.accepting_operators}人）`;
  }

  // ---- 確認 ----
  let unreadBefore = 0;
  let timer: number | null = null;
  let busy = false;

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const requestedId = openId;
      const s = await api.supportState(requestedId, lastMessageId);
      state = s;
      renderHead(s);
      // 返事を待っている相談・未読の数（タブの名前と音で知らせる）
      const unread = s.conversations.reduce(
        (n, c) => n + (c.id === openId ? 0 : c.user_unread), 0,
      );
      if (unread > unreadBefore) beep();
      unreadBefore = unread;
      document.title = unread ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
      // 一覧を描き直す前に確認し直した相談を選び直す（ほかのタブで相談を開き直したとき用）
      if (s.open && requestedId === openId) {
        const hadMessages = lastMessageId;
        const summary = s.conversations.find((c) => c.id === s.open!.conversation.id);
        renderOpen(s.open.conversation, s.open.messages, summary, s.now);
        if (hadMessages && s.open.messages.some((m) => m.sender === "user")) beep();
      }
      renderList(s.conversations, s.now);
      errorText.hidden = true;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 404 || err.status === 503)) {
        stop();
        onAuthError(err);
        return;
      }
      showError("相談窓口の状態を確かめられませんでした", err);
    } finally {
      busy = false;
    }
  }

  function start(): void {
    if (timer !== null) return;
    void refresh();
    timer = window.setInterval(() => { void refresh(); }, SUPPORT_POLL_MS);
  }

  function stop(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  // 裏のタブから戻ったら、待たずにすぐ確かめ直す
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refresh();
  });

  acceptBtn.addEventListener("click", async () => {
    acceptBtn.disabled = true;
    try {
      await api.setSupportAccepting(!(state?.accepting ?? false));
      await refresh();
    } catch (err) {
      showError("受け付けを切り替えられませんでした", err);
    } finally {
      acceptBtn.disabled = false;
    }
  });

  replyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = replyInput.value.trim();
    if (!text || openId === null) return;
    sendBtn.disabled = true;
    try {
      await api.sendSupportMessage(openId, text);
      replyInput.value = "";
      await refresh();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "送れませんでした");
    } finally {
      sendBtn.disabled = false;
      replyInput.focus();
    }
  });
  replyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      replyForm.requestSubmit();
    }
  });

  closeBtn.addEventListener("click", async () => {
    if (openId === null || !confirm("この相談を終えます。利用者の画面にも終了のお知らせが出ます。よろしいですか？")) return;
    await api.closeSupportConversation(openId);
    await refresh();
  });

  renderDetailEmpty();
  start();
  return section;
}
