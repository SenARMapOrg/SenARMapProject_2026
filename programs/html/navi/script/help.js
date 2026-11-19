// ================================================================
// help.js
// 使い方の案内（「？」ボタン）。よくある質問（faq.json）を開いて読めるパネルを出す。
// サーバーには何も送らない（faq.json を読むだけ）。説明は docs/help_chat.md。
//
// ほかのスクリプトの変数・関数は使わず、画面の部品もここで作る（navi1〜9 にそのまま足せるように）。
// ================================================================
(function () {
  const FAQ_URL = "faq.json";
  let faqLoaded = false;

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    children.forEach(c => e.append(c));
    return e;
  }

  // ---- 画面 ----
  const faqList  = el("div", { className: "help-faq" });
  const closeBtn = el("button", { className: "help-close", type: "button", textContent: "閉じる" });

  const panel = el("div", { className: "help-panel", id: "help-panel" }, [
    el("div", { className: "help-head" }, [
      el("h2", { className: "help-title", textContent: "使い方" }),
      closeBtn,
    ]),
    el("div", { className: "help-body" }, [
      el("h3", { className: "help-sub", textContent: "よくある質問" }),
      faqList,
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
  const helpBtn = document.getElementById("help-btn");
  if (helpBtn) helpBtn.addEventListener("click", openHelp);
})();
