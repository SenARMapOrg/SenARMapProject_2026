// 管理画面（/admin）。登録ユーザーの一覧と件数だけを表示する（時間割の中身は出さない）。
//
// 表示できるかどうかはサーバー（/api/admin/*）が決める。この画面側の出し分けは見た目だけで、
// 管理者でなければ API が 404 を返すのでデータは一切届かない。
// ユーザーが入力したあだ名などをそのまま表示するため、DOM は必ず textContent で組み立てる
// （innerHTML にデータを入れない）。

import { api, ApiError, apiFetch } from "./api";
import {
  auditEventLabel, formatDbTime, matchesFilter,
  type AdminUser, type AdminUsersResponse, type AuditLogEntry,
} from "./admin-format";
import { gradeLabel } from "./timetable-grid";

// 管理APIの呼び出しは、利用者向けの画面のJSに含めないよう、このファイルにだけ置く
/**
 * 管理者以外・未ログインは 404、管理者でもログインから時間が経っていれば 401、
 * 閲覧記録を保存できないときは 503
 */
function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return apiFetch("/api/admin/users");
}

function fetchAuditLog(): Promise<{ entries: AuditLogEntry[] }> {
  return apiFetch("/api/admin/audit-log");
}

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

function renderSummary(summary: AdminUsersResponse["summary"]): HTMLElement {
  const wrap = el("div", { className: "admin-summary" });
  const stats: [string, number][] = [
    ["登録ユーザー", summary.total_users],
    ["時間割を登録している人", summary.users_with_entries],
    ["登録コマ数（合計）", summary.total_entries],
  ];
  for (const [label, value] of stats) {
    const box = el("div", { className: "admin-stat" });
    box.append(el("div", { className: "admin-stat-value", text: value.toLocaleString("ja-JP") }),
      el("div", { className: "admin-stat-label", text: label }));
    wrap.appendChild(box);
  }
  return wrap;
}

const COLUMNS = ["メール", "名前", "あだ名", "学部 / 学科", "現在の学年", "登録コマ数", "登録した学年数", "登録日", "最終ログイン"];

function renderRow(u: AdminUser): HTMLTableRowElement {
  const tr = el("tr");
  if (u.entry_count === 0) tr.className = "is-empty";
  const dept = [u.faculty, u.department].filter(Boolean).join(" / ");
  const cells: [string, string?][] = [
    [u.email],
    [u.display_name],
    [u.nickname ?? "—", u.nickname ? undefined : "muted"],
    [dept || "未設定", dept ? undefined : "muted"],
    [gradeLabel(u.current_grade)],
    [String(u.entry_count), "num"],
    [String(u.grade_count), "num"],
    [formatDbTime(u.created_at)],
    [formatDbTime(u.last_login_at), u.last_login_at ? undefined : "muted"],
  ];
  for (const [text, cls] of cells) tr.appendChild(el("td", { text, className: cls }));
  return tr;
}

function renderUsers(data: AdminUsersResponse): HTMLElement {
  const section = el("section", { className: "panel" });
  section.append(
    el("h1", { text: "登録ユーザー" }),
    el("p", {
      className: "hint",
      text: "時間割の中身（科目名・教室）はここには表示しません。最終ログインは、ログアウトせずに残っているログインのうち最新のものです（ログアウト済みの人は「—」）。",
    }),
    renderSummary(data.summary),
  );

  const filter = el("input", { className: "admin-filter" });
  filter.type = "search";
  filter.placeholder = "メール・名前・あだ名・学部学科で絞り込み";
  const countEl = el("p", { className: "hint" });

  const table = el("table", { className: "admin-table" });
  const headRow = el("tr");
  for (const col of COLUMNS) headRow.appendChild(el("th", { text: col }));
  table.appendChild(el("thead")).appendChild(headRow);
  const tbody = table.appendChild(el("tbody"));

  function refresh(): void {
    const shown = data.users.filter((u) => matchesFilter(u, filter.value));
    tbody.replaceChildren(...shown.map(renderRow));
    countEl.textContent = `${shown.length} / ${data.users.length} 人を表示中`;
  }
  filter.addEventListener("input", refresh);
  refresh();

  const tableWrap = el("div", { className: "admin-table-wrap" });
  tableWrap.appendChild(table);
  section.append(filter, countEl, tableWrap);
  return section;
}

const AUDIT_COLUMNS = ["日時", "種類", "メール", "パス", "接続元IP"];

function renderAuditLog(entries: AuditLogEntry[]): HTMLElement {
  const section = el("section", { className: "panel" });
  section.append(
    el("h2", { text: "閲覧記録（直近100件）" }),
    el("p", {
      className: "hint",
      text: "管理画面で一覧を見た記録と、管理者以外が管理画面・管理APIを開こうとした記録です。1年間保存します。",
    }),
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
    const cells = [formatDbTime(e.created_at), auditEventLabel(e.event), e.email ?? "—", e.path, e.ip ?? "—"];
    for (const text of cells) tr.appendChild(el("td", { text }));
    tbody.appendChild(tr);
  }
  const wrap = el("div", { className: "admin-table-wrap" });
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

async function boot(): Promise<void> {
  // 管理者でなければサーバー（functions/admin.ts）がトップページへ飛ばすので、通常ここには来ない。
  // ページを開いた後にセッションが切れた場合などのための表示
  const me = await api.me();
  if (!me) {
    showMessagePanel("管理画面", "大学のGoogleアカウントでログインしてください。", { label: "Googleでログイン", href: LOGIN_URL });
    return;
  }
  userBox.hidden = false;
  userNameEl.textContent = `${me.nickname ?? me.display_name} さん`;

  try {
    // 一覧を先に取る（ここで閲覧記録が書かれる）。記録の表示はその記録も含めて出す
    const users = await fetchAdminUsers();
    const audit = await fetchAuditLog();
    appRoot.replaceChildren(renderUsers(users), renderAuditLog(audit.entries));
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
    // 管理者でない場合も含め、理由は区別せずに同じ表示にする
    showMessagePanel("このページは表示できません", "このアカウントには表示する権限がありません。");
  }
}

void boot();
