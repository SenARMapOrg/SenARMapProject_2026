// ================================================================
// help.js
// 使い方の案内（「？」ボタン）。よくある質問（faq.json）と、Gemini に質問できるチャット、
// 解決しないときに人（オペレーター）とやりとりできる相談窓口。
//
// - AI: 同じサイトの /api/help-chat（リポジトリ直下の functions/api/help-chat.js）が Gemini を呼ぶ
// - オペレーター: 集計システム（programs/event_guide_counter）の /api/support/* に、数秒ごとに新しい
//   メッセージを取りに行く。オペレーターは集計システムの管理画面（/admin の「相談窓口」）で返事をする
// 設定と仕組みは docs/help_chat.md。
//
// ほかのスクリプトの変数・関数は使わず、画面の部品もここで作る（navi1〜9 にそのまま足せるように）。
// ================================================================
(function () {
  const FAQ_URL  = "faq.json";
  const CHAT_URL = "/api/help-chat";
  const MAX_CHARS = 400;   // 1回の質問の長さ（functions/api/help-chat.js と同じ値）
  const MAX_TURNS = 10;    // サーバーへ送る、これまでのやりとりの数（同上）

  // 相談窓口（集計システム）。track.js の TRACK_API_BASE と同じ決め方
  const SUPPORT_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://localhost:8788" : "https://event-guide-counter.iku-navi.net";
  const SUPPORT_MAX_CHARS = 500;          // event_guide_counter の support-guard.ts と同じ値
  const SUPPORT_POLL_OPEN_MS   = 3000;    // パネルを開いているときに返事を確かめる間隔
  const SUPPORT_POLL_CLOSED_MS = 10000;   // パネルを閉じているとき（返事が来たら「？」に印を付ける）
  const SUPPORT_TOKEN_KEY = "navi_support_token";

  const history = [];      // AI とのやりとり [{ role: "user" | "model", text }]
  let faqLoaded = false;
  let sending = false;
  let mode = "ai";         // "ai" | "operator"

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    children.forEach(c => e.append(c));
    return e;
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch { /* 保存できない環境では、ページを開いている間だけ続ける */ }
  }

  // ---- 画面 ----
  const faqList = el("div", { className: "help-faq" });
  const chatTitle = el("h3", { className: "help-sub", textContent: "AIに質問する" });
  const chatNote = el("p", { className: "help-note" });
  const log     = el("div", { className: "help-log", ariaLive: "polite" });
  const input   = el("textarea", { className: "help-input", rows: 2 });
  input.setAttribute("aria-label", "質問");
  const sendBtn = el("button", { className: "help-send", type: "submit", textContent: "送る" });
  const form    = el("form", { className: "help-form" }, [input, sendBtn]);
  const closeBtn = el("button", { className: "help-close", type: "button", textContent: "閉じる" });

  // AI のあとに出す「オペレーターにつなぐ」
  const operatorBtn = el("button", { className: "help-operator-btn", type: "button", textContent: "オペレーター（人）につなぐ" });
  const operatorOffer = el("div", { className: "help-operator-offer", hidden: true }, [
    el("p", { className: "help-note", textContent: "AIの答えで解決しないときは、オペレーターに相談できます。" }),
    operatorBtn,
  ]);
  // オペレーターとやりとりしている間の「相談を終える」
  const endBtn = el("button", { className: "help-end-btn", type: "button", textContent: "相談を終える", hidden: true });
  // 終わったあとの「AIに戻る」
  const backBtn = el("button", { className: "help-end-btn", type: "button", textContent: "AIへの質問に戻る", hidden: true });

  const panel = el("div", { className: "help-panel", id: "help-panel" }, [
    el("div", { className: "help-head" }, [
      el("h2", { className: "help-title", textContent: "使い方" }),
      closeBtn,
    ]),
    el("div", { className: "help-body" }, [
      el("h3", { className: "help-sub", textContent: "よくある質問" }),
      faqList,
      chatTitle,
      chatNote,
      log,
      form,
      operatorOffer,
      endBtn,
      backBtn,
    ]),
  ]);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "使い方");
  const backdrop = el("div", { className: "help-backdrop" }, [panel]);

  function setMode(next) {
    mode = next;
    const operator = next === "operator";
    chatTitle.textContent = operator ? "オペレーターに相談する" : "AIに質問する";
    chatNote.textContent = operator
      ? "大学祭のスタッフが、順番に返事をします。返事まで少し時間がかかることがあります。名前・学籍番号などの個人情報は書かないでください。"
      : "上にない質問は、AI（Google の Gemini）が答えます。AIの答えは間違っていることがあります。名前・学籍番号などの個人情報は書かないでください。";
    input.maxLength = operator ? SUPPORT_MAX_CHARS : MAX_CHARS;
    input.placeholder = operator ? "相談したいことを書いてください" : "例: 4号館のゼミ44Aへの行き方は？";
    operatorOffer.hidden = true;
    backBtn.hidden = true;
    form.hidden = false;
  }

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

  function addMessage(role, text) {
    const m = el("div", { className: `help-msg ${role}`, textContent: text });
    log.append(m);
    m.scrollIntoView({ block: "nearest" });
    return m;
  }

  // ---- AIに質問 ----
  async function askAi(question) {
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
    }
    offerOperator();
  }

  // ---- オペレーター ----
  let supportToken = storageGet(SUPPORT_TOKEN_KEY);
  let supportLastId = 0;
  let supportTimer = null;
  let supportStatus = null;     // "waiting" | "open" | "closed"
  let waitingNote = null;       // 「返事を待っています」の表示
  let lastAvailabilityCheck = 0;
  let operatorAvailable = false;

  function supportPost(path, payload) {
    // text/plain で送り、独自のヘッダを付けない（ブラウザの事前確認を起こさないため）
    return fetch(`${SUPPORT_API_BASE}/api/support/${path}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async function checkOperatorAvailable() {
    // 何度も確かめないよう、30秒以内に確かめた結果は使い回す
    if (Date.now() - lastAvailabilityCheck < 30000) return operatorAvailable;
    lastAvailabilityCheck = Date.now();
    try {
      const res = await fetch(`${SUPPORT_API_BASE}/api/support/status`);
      const data = await res.json();
      operatorAvailable = res.ok && data.available === true;
    } catch {
      operatorAvailable = false;
    }
    return operatorAvailable;
  }

  async function offerOperator() {
    if (mode !== "ai") return;
    operatorOffer.hidden = !(await checkOperatorAvailable()) || mode !== "ai";
  }

  /** AI とのやりとりを、オペレーターが読める文にする */
  function aiContext() {
    return history.map(h => `${h.role === "user" ? "利用者" : "AI"}: ${h.text}`).join("\n");
  }

  function startOperatorMode() {
    setMode("operator");
    addMessage("system", "オペレーターにつなぎます。相談したいことを書いて送ってください。");
    input.focus();
  }

  function renderSupportMessages(messages) {
    for (const m of messages) {
      supportLastId = Math.max(supportLastId, m.id);
      if (m.sender === "user") addMessage("user", m.body);
      else if (m.sender === "operator") addMessage("operator", m.body);
      else addMessage("system", m.body);
    }
  }

  function updateWaitingNote() {
    const waiting = supportStatus === "waiting";
    if (waiting && !waitingNote) waitingNote = addMessage("system pending", "オペレーターの返事を待っています…");
    if (!waiting && waitingNote) { waitingNote.remove(); waitingNote = null; }
    if (waitingNote) log.append(waitingNote);   // いつも一番下に置く
  }

  function finishSupport() {
    stopSupportPolling();
    supportToken = null;
    storageSet(SUPPORT_TOKEN_KEY, null);
    supportStatus = "closed";
    updateWaitingNote();
    form.hidden = true;
    endBtn.hidden = true;
    backBtn.hidden = false;
    markHelpButton(false);
  }

  async function pollSupport() {
    if (!supportToken) return;
    try {
      const res = await supportPost("poll", { token: supportToken, after: supportLastId });
      if (res.status === 404) {
        addMessage("system", "相談が見つかりませんでした。もう一度つないでください。");
        finishSupport();
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const hadOperatorReply = data.messages.some(m => m.sender === "operator");
      renderSupportMessages(data.messages);
      supportStatus = data.status;
      updateWaitingNote();
      if (hadOperatorReply && !backdrop.classList.contains("open")) markHelpButton(true);
      if (data.status === "closed") finishSupport();
    } catch {
      // 電波が悪いときは、次の確認でもう一度取りに行く
    }
  }

  function scheduleSupportPolling() {
    stopSupportPolling();
    if (!supportToken || document.hidden) return;
    const interval = backdrop.classList.contains("open") ? SUPPORT_POLL_OPEN_MS : SUPPORT_POLL_CLOSED_MS;
    supportTimer = setInterval(pollSupport, interval);
  }

  function stopSupportPolling() {
    if (supportTimer) clearInterval(supportTimer);
    supportTimer = null;
  }

  async function sendToOperator(text) {
    if (!supportToken) {
      // 1通目で相談を始める
      const res = await supportPost("start", { text, context: aiContext() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        addMessage("error", data.error || "オペレーターにつなげませんでした。時間をおいてもう一度試してください。");
        if (data.code === "unavailable") {
          operatorAvailable = false;
          setMode("ai");
        }
        return;
      }
      supportToken = data.token;
      storageSet(SUPPORT_TOKEN_KEY, supportToken);
      endBtn.hidden = false;
    } else {
      const res = await supportPost("send", { token: supportToken, text });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        addMessage("error", data.error || "送れませんでした。もう一度試してください。");
        if (res.status === 404 || data.code === "closed") finishSupport();
        return;
      }
    }
    await pollSupport();   // 送ったメッセージをサーバーの順番どおりに出す
    scheduleSupportPolling();
  }

  /** ページを開き直したとき、続いている相談があればオペレーターとのやりとりに戻る */
  function resumeSupport() {
    if (!supportToken) return;
    setMode("operator");
    endBtn.hidden = false;
    pollSupport();
    scheduleSupportPolling();
  }

  endBtn.addEventListener("click", async () => {
    if (!supportToken || !confirm("オペレーターとの相談を終えますか？")) return;
    try {
      await supportPost("close", { token: supportToken });
    } catch { /* 終わりにできなくても、この端末ではやりとりを終える */ }
    await pollSupport();
    if (supportToken) {
      addMessage("system", "相談を終了しました。");
      finishSupport();
    }
  });

  backBtn.addEventListener("click", () => {
    supportLastId = 0;
    supportStatus = null;
    endBtn.hidden = true;
    setMode("ai");
    addMessage("system", "AIへの質問に戻りました。");
  });

  operatorBtn.addEventListener("click", startOperatorMode);

  // ---- 送る ----
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || sending) return;
    input.value = "";
    sending = true;
    sendBtn.disabled = true;
    try {
      if (mode === "operator") {
        await sendToOperator(q.slice(0, SUPPORT_MAX_CHARS));
      } else {
        await askAi(q.slice(0, MAX_CHARS));
      }
    } catch {
      addMessage("error", "送れませんでした。電波の良い場所でもう一度試してください。");
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  });
  // Enter で送る（Shift+Enter は改行。日本語の変換中の Enter では送らない）
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  // ---- 開く・閉じる ----
  const helpBtn = document.getElementById("help-btn");
  function markHelpButton(on) {
    if (helpBtn) helpBtn.classList.toggle("has-reply", on);
  }

  let opener = null;
  function openHelp() {
    opener = document.activeElement;
    backdrop.classList.add("open");
    markHelpButton(false);
    loadFaq();
    if (mode === "ai" && history.length) offerOperator();
    scheduleSupportPolling();
    if (supportToken) pollSupport();
    closeBtn.focus();
  }
  function closeHelp() {
    backdrop.classList.remove("open");
    scheduleSupportPolling();
    if (opener && opener.focus) opener.focus();
  }
  closeBtn.addEventListener("click", closeHelp);
  backdrop.addEventListener("click", e => { if (e.target === backdrop) closeHelp(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && backdrop.classList.contains("open")) closeHelp();
  });
  // 画面を見ていない間は確認を止める
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopSupportPolling();
    else { scheduleSupportPolling(); pollSupport(); }
  });

  setMode("ai");
  document.body.append(backdrop);
  if (helpBtn) helpBtn.addEventListener("click", openHelp);
  resumeSupport();
})();
