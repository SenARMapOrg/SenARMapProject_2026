// 管理画面（/admin）。登録ユーザーの一覧と件数だけを表示する（時間割の中身は出さない）。
//
// 表示できるかどうかはサーバー（/api/admin/*）が決める。この画面側の出し分けは見た目だけで、
// 管理者でなければ API が 404 を返すのでデータは一切届かない。
// ユーザーが入力したあだ名などをそのまま表示するため、DOM は必ず textContent で組み立てる
// （innerHTML にデータを入れない）。

import { api, ApiError, apiFetch } from "./api";
import { formatDbTime, matchesFilter, type AdminUser, type AdminUsersResponse } from "./admin-format";
import { gradeLabel } from "./timetable-grid";

// 管理APIの呼び出しは、利用者向けの画面のJSに含めないよう、このファイルにだけ置く
/** 管理者以外・未ログインは 404、管理者でもログインから時間が経っていれば 401 */
function fetchAdminUsers(): Promise<AdminUsersResponse> {
  return apiFetch("/api/admin/users");
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

function renderUsers(data: AdminUsersResponse): void {
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
  appRoot.replaceChildren(section);
}

async function boot(): Promise<void> {
  const me = await api.me();
  if (!me) {
    showMessagePanel("管理画面", "大学のGoogleアカウントでログインしてください。", { label: "Googleでログイン", href: LOGIN_URL });
    return;
  }
  userBox.hidden = false;
  userNameEl.textContent = `${me.nickname ?? me.display_name} さん`;

  try {
    renderUsers(await fetchAdminUsers());
  } catch (err) {
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
