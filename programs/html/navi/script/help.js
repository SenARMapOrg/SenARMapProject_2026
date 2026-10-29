// ================================================================
// help.js
// 使い方の案内（「？」ボタン）。よくある質問（faq.json）と、Gemini に質問できるチャット。
// チャットは同じサイトの /api/help-chat（リポジトリ直下の functions/api/help-chat.js）を通して
// Gemini を呼ぶ。API キーはサーバー側にだけ置く。設定は docs/help_chat.md。
//
// ほかのスクリプトの変数・関数は使わず、画面の部品もここで作る（navi1〜9 にそのまま足せるように）。
// ================================================================
(function () {
  const FAQ_URL  = "faq.json";
  const CHAT_URL = "/api/help-chat";
  const MAX_CHARS = 400;   // 1回の質問の長さ（functions/api/help-chat.js と同じ値）
  const MAX_TURNS = 10;    // サーバーへ送る、これまでのやりとりの数（同上）

  const history = [];      // [{ role: "user" | "model", text }]
  let faqLoaded = false;
  let sending = false;

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    children.forEach(c => e.append(c));
    return e;
  }

  // ---- 画面 ----
  const faqList = el("div", { className: "help-faq" });
  const log     = el("div", { className: "help-log", ariaLive: "polite" });
  const input   = el("textarea", {
    className: "help-input", rows: 2, maxLength: MAX_CHARS,
    placeholder: "例: 4号館のゼミ44Aへの行き方は？",
  });
  input.setAttribute("aria-label", "AIへの質問");
  const sendBtn = el("button", { className: "help-send", type: "submit", textContent: "送る" });
  const form    = el("form", { className: "help-form" }, [input, sendBtn]);
  const closeBtn = el("button", { className: "help-close", type: "button", textContent: "閉じる" });

  const panel = el("div", { className: "help-panel", id: "help-panel" }, [
    el("div", { className: "help-head" }, [
      el("h2", { className: "help-title", textContent: "使い方" }),
      closeBtn,
    ]),
    el("div", { className: "help-body" }, [
      el("h3", { className: "help-sub", textContent: "よくある質問" }),
      faqList,
      el("h3", { className: "help-sub", textContent: "AIに質問する" }),
      el("p", {
        className: "help-note",
        textContent: "上にない質問は、AI（Google の Gemini）が答えます。AIの答えは間違っていることがあります。"
          + "名前・学籍番号などの個人情報は書かないでください。",
      }),
      log,
      form,
    ]),
  ]);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "使い方");
  const backdrop = el("div", { className: "help-backdrop" }, [panel]);

  // ---- よくある質問 ----
  async function loadFaq() {
    if (faqLoaded) return;
    try {
      const res = await fetch(FAQ_URL);
      if (!res.ok) throw new Error(res.status);
      const items = await res.json();
      faqList.replaceChildren(...items.map(item =>
        el("details", { className: "help-item" }, [
          el("summary", { textContent: item.q }),
          el("p", { textContent: item.a }),
        ])
      ));
      faqLoaded = true;
    } catch {
      faqList.replaceChildren(el("p", { className: "help-note", textContent: "よくある質問を読み込めませんでした。" }));
    }
  }

  // ---- AIに質問 ----
  function addMessage(role, text) {
    const m = el("div", { className: `help-msg ${role}`, textContent: text });
    log.append(m);
    m.scrollIntoView({ block: "nearest" });
    return m;
  }

  async function ask(question) {
    sending = true;
    sendBtn.disabled = true;
    addMessage("user", question);
    history.push({ role: "user", text: question });
    const pending = addMessage("model pending", "考えています…");
    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_TURNS) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.answer) throw new Error(data.error || "");
      pending.className = "help-msg model";
      pending.textContent = data.answer;
      history.push({ role: "model", text: data.answer });
    } catch (e) {
      history.pop();   // 答えが無い質問は、次の質問のやりとりに含めない
      pending.className = "help-msg error";
      // 通信できなかったとき（TypeError）の英語のメッセージは見せない
      const serverMessage = e instanceof TypeError ? "" : e.message;
      pending.textContent = serverMessage || "AIに質問できませんでした。時間をおいてもう一度試してください。";
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || sending) return;
    input.value = "";
    ask(q.slice(0, MAX_CHARS));
  });
  // Enter で送る（Shift+Enter は改行。日本語の変換中の Enter では送らない）
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ---- 開く・閉じる ----
  let opener = null;
  function openHelp() {
    opener = document.activeElement;
    backdrop.classList.add("open");
    loadFaq();
    closeBtn.focus();
  }
  function closeHelp() {
    backdrop.classList.remove("open");
    if (opener && opener.focus) opener.focus();
  }
  closeBtn.addEventListener("click", closeHelp);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeHelp(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && backdrop.classList.contains("open")) closeHelp();
  });

  document.body.append(backdrop);
  const btn = document.getElementById("help-btn");
  if (btn) btn.addEventListener("click", openHelp);
})();
