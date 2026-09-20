// 共有リンク（?shared=token）経由での閲覧画面。ログイン（大学Googleアカウント）は必須
// （main.tsのboot()で、ログイン確認後にだけこの画面を出す）。

import { api, ApiError } from "./api";
import { gradeLabel, renderReadonlyGrid, TERM_LABELS } from "./timetable-grid";

export async function renderSharedView(
  container: HTMLElement, token: string, onBack: () => void,
): Promise<void> {
  container.replaceChildren();

  const section = document.createElement("section");
  section.className = "panel";
  section.innerHTML = `
    <h1>共有された時間割</h1>
    <p class="hint">共有リンク経由で閲覧しています。</p>
  `;

  const backBtn = document.createElement("button");
  backBtn.className = "btn btn-ghost";
  backBtn.textContent = "← 自分の時間割に戻る";
  backBtn.addEventListener("click", onBack);
  section.appendChild(backBtn);

  const grid = document.createElement("div");
  const errorEl = document.createElement("p");
  errorEl.className = "message message-error";
  errorEl.hidden = true;
  section.append(grid, errorEl);
  container.appendChild(section);

  try {
    const { user, grade, term, entries } = await api.viewSharedTimetable(token);
    const h = document.createElement("h2");
    h.textContent = `${user.display_name} さんの${gradeLabel(grade)}${TERM_LABELS[term]}`;
    section.insertBefore(h, grid);
    renderReadonlyGrid(grid, entries);
  } catch (err) {
    errorEl.textContent = err instanceof ApiError ? err.message : "共有リンクが無効です";
    errorEl.hidden = false;
  }
}
