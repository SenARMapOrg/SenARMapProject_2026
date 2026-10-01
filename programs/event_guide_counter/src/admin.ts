// 管理画面（/admin）。案内係ごとの到着・検索人数の確認と、案内係の追加・QR表示・リセット・削除を行う。
//
// 表示できるかどうかはサーバー（/api/admin/*）が決める。この画面側の出し分けは見た目だけで、
// 管理者でなければAPIが404を返すのでデータは一切届かない。

import QRCode from "qrcode";

import { auditEventLabel, buildGuideUrl, formatDbTime } from "./admin-format";
import {
  api, ApiError, type AuditLogEntry, type Guide, type SearchLogEntry,
} from "./api";

const LOGIN_URL = "/api/auth/login?next=/admin";

const appRoot = document.getElementById("app")!;
const userBox = document.getElementById("user-box")!;
const userNameEl = document.getElementById("user-name")!;
const logoutBtn = document.getElementById("logout-btn") as HTMLButtonElement;

logoutBtn.addEventListener("click", async () => {
  await api.logout();
  location.reload();
});

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, opts: { className?: string; text?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

function showMessagePanel(title: string, body: string, action?: { label: string; href: string }): void {
  const section = el("section", { className: "panel" });
  section.append(el("h1", { text: title }), el("p", { className: "hint", text: body }));
  if (action) {
    const link = el("a", { className: "btn btn-primary", text: action.label });
    link.href = action.href;
    section.appendChild(link);
  }
  appRoot.replaceChildren(section);
}

async function showQrModal(naviBaseUrl: string, guide: Guide): Promise<void> {
  const url = buildGuideUrl(naviBaseUrl, guide.ref_code);
  const overlay = el("div", { className: "qr-overlay" });
  const card = el("div", { className: "qr-card" });
  card.append(el("h2", { text: guide.display_name }));
  const img = el("img");
  img.alt = `${guide.display_name} のQRコード`;
  card.appendChild(img);
  const urlEl = el("p", { className: "ref-url", text: url });
  const closeBtn = el("button", { className: "btn btn-ghost", text: "閉じる" });
  card.append(urlEl, closeBtn);
  overlay.appendChild(card);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  closeBtn.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
  img.src = await QRCode.toDataURL(url, { width: 480, margin: 1 });
}

const GUIDE_COLUMNS = ["名前", "到着人数", "検索人数", "追加日", "操作"];

function renderSearchLogRow(entries: SearchLogEntry[]): HTMLTableRowElement {
  const tr = el("tr", { className: "search-log-row" });
  const td = el("td");
  td.colSpan = GUIDE_COLUMNS.length;
  if (entries.length === 0) {
    td.appendChild(el("p", { className: "hint", text: "検索の記録はまだありません。" }));
  } else {
    const table = el("table", { className: "admin-table" });
    const headRow = el("tr");
    for (const col of ["日時", "出発地", "目的地"]) headRow.appendChild(el("th", { text: col }));
    table.appendChild(el("thead")).appendChild(headRow);
    const tbody = table.appendChild(el("tbody"));
    for (const s of entries) {
      const row = el("tr");
      for (const text of [formatDbTime(s.created_at), s.from_label, s.to_label]) {
        row.appendChild(el("td", { text }));
      }
      tbody.appendChild(row);
    }
    td.appendChild(table);
  }
  tr.appendChild(td);
  return tr;
}

function renderGuideRow(guide: Guide, naviBaseUrl: string, onChange: () => void): HTMLTableRowElement[] {
  const tr = el("tr");
  tr.appendChild(el("td", { text: guide.display_name }));
  tr.appendChild(el("td", { text: String(guide.arrival_count), className: "num" }));
  tr.appendChild(el("td", { text: String(guide.search_count), className: "num" }));
  tr.appendChild(el("td", { text: formatDbTime(guide.created_at) }));

  const actions = el("td", { className: "actions" });
  const qrBtn = el("button", { className: "btn btn-ghost", text: "QR表示" });
  qrBtn.addEventListener("click", () => { void showQrModal(naviBaseUrl, guide); });

  const logBtn = el("button", { className: "btn btn-ghost", text: "検索ログ" });
  let logRow: HTMLTableRowElement | null = null;
  logBtn.addEventListener("click", async () => {
    if (logRow) { logRow.remove(); logRow = null; return; }
    const { searches } = await api.listGuideSearches(guide.id);
    logRow = renderSearchLogRow(searches);
    tr.after(logRow);
  });

  const resetBtn = el("button", { className: "btn btn-ghost", text: "リセット" });
  resetBtn.addEventListener("click", async () => {
    if (!confirm(`${guide.display_name} の記録（到着・検索）をすべて削除します。よろしいですか？`)) return;
    await api.resetGuide(guide.id);
    onChange();
  });

  const deleteBtn = el("button", { className: "btn btn-danger", text: "削除" });
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`${guide.display_name} を削除します。記録（到着・検索）も一緒に消え、QRは使えなくなります。よろしいですか？`)) return;
    await api.deleteGuide(guide.id);
    onChange();
  });

  actions.append(qrBtn, logBtn, resetBtn, deleteBtn);
  tr.appendChild(actions);
  return [tr];
}

function renderGuides(guides: Guide[], naviBaseUrl: string, onChange: () => void): HTMLElement {
  const section = el("section", { className: "panel" });
  section.appendChild(el("h1", { text: "案内係ごとの人数" }));
  section.appendChild(el("p", {
    className: "hint",
    text: "到着人数はQRを読んでIKU NAVIが実際に開いた端末の数、検索人数は実際にルート検索まで進んだ端末の数です（同じ端末で複数回検索しても1人として数えます）。",
  }));

  const addForm = el("form", { className: "add-guide-form" });
  const nameInput = el("input");
  nameInput.type = "text";
  nameInput.placeholder = "案内係の名前（例: 正門担当）";
  nameInput.maxLength = 50;
  const addBtn = el("button", { className: "btn btn-primary", text: "追加" });
  addBtn.type = "submit";
  addForm.append(nameInput, addBtn);
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    addBtn.disabled = true;
    try {
      await api.createGuide(name);
      nameInput.value = "";
      onChange();
    } finally {
      addBtn.disabled = false;
    }
  });
  section.appendChild(addForm);

  if (guides.length === 0) {
    section.appendChild(el("p", { className: "hint", text: "案内係がまだ登録されていません。上のフォームから追加してください。" }));
    return section;
  }

  const table = el("table", { className: "admin-table" });
  const headRow = el("tr");
  for (const col of GUIDE_COLUMNS) headRow.appendChild(el("th", { text: col }));
  table.appendChild(el("thead")).appendChild(headRow);
  const tbody = table.appendChild(el("tbody"));
  for (const guide of guides) tbody.append(...renderGuideRow(guide, naviBaseUrl, onChange));

  const wrap = el("div", { className: "admin-table-wrap" });
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

const AUDIT_COLUMNS = ["日時", "種類", "メール", "パス", "接続元IP"];

function renderAuditLog(entries: AuditLogEntry[]): HTMLElement {
  const section = el("section", { className: "panel" });
  section.append(
    el("h2", { text: "管理画面の閲覧記録（直近100件）" }),
    el("p", { className: "hint", text: "この管理画面を見た記録と、管理者以外がログインを試みた記録です。" }),
  );
  if (entries.length === 0) {
    section.appendChild(el("p", { className: "hint", text: "記録はまだありません。" }));
    return section;
  }
  const table = el("table", { className: "admin-table" });
  const headRow = el("tr");
  for (const col of AUDIT_COLUMNS) headRow.appendChild(el("th", { text: col }));
  table.appendChild(el("thead")).appendChild(headRow);
  const tbody = table.appendChild(el("tbody"));
  for (const e of entries) {
    const tr = el("tr");
    for (const text of [formatDbTime(e.created_at), auditEventLabel(e.event), e.email ?? "—", e.path, e.ip ?? "—"]) {
      tr.appendChild(el("td", { text }));
    }
    tbody.appendChild(tr);
  }
  const wrap = el("div", { className: "admin-table-wrap" });
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

async function renderDashboard(): Promise<void> {
  const [guidesRes, auditRes] = await Promise.all([api.listGuides(), api.listAuditLog()]);
  userBox.hidden = false;
  userNameEl.textContent = guidesRes.admin_email;
  appRoot.replaceChildren(
    renderGuides(guidesRes.guides, guidesRes.navi_base_url, () => { void renderDashboard(); }),
    renderAuditLog(auditRes.entries),
  );
}

const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  not_admin: "このGoogleアカウントには管理画面の権限がありません。",
  invalid_state: "ログイン処理に失敗しました。もう一度お試しください。",
  token_exchange_failed: "Googleとの通信に失敗しました。もう一度お試しください。",
  invalid_token: "Googleからの応答を確認できませんでした。もう一度お試しください。",
};

async function boot(): Promise<void> {
  const loginError = new URLSearchParams(location.search).get("login_error");
  if (loginError) {
    showMessagePanel(
      "ログインできませんでした",
      LOGIN_ERROR_MESSAGES[loginError] ?? "ログインに失敗しました。もう一度お試しください。",
      { label: "Googleでログイン", href: LOGIN_URL },
    );
    return;
  }
  try {
    await renderDashboard();
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      showMessagePanel("表示できません", err.message);
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      showMessagePanel(
        "再ログインが必要です",
        "管理画面は、ログインしてから12時間以内のみ表示できます。もう一度ログインしてください。",
        { label: "再ログイン", href: LOGIN_URL },
      );
      return;
    }
    // 未ログイン・管理者でない場合も含め、理由は区別せずに同じ表示にする
    showMessagePanel("鳳祭 案内人数集計 管理画面", "Googleアカウントでログインしてください。", { label: "Googleでログイン", href: LOGIN_URL });
  }
}

void boot();
