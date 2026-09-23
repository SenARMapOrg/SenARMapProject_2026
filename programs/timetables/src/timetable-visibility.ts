// 時間割スナップショット（学年+学期）の公開範囲の選択と、共有リンクのコピー。

import { api, ApiError, type Term, type Visibility, VISIBILITY_LABELS } from "./api";

function buildCopyButton(shareUrl: string): HTMLButtonElement {
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-ghost btn-sm";
  copyBtn.textContent = "共有リンクをコピー";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      copyBtn.textContent = "コピーしました";
      setTimeout(() => { copyBtn.textContent = "共有リンクをコピー"; }, 2000);
    }).catch(() => {
      prompt("コピーできませんでした。手動でコピーしてください:", shareUrl);
    });
  });
  return copyBtn;
}

export async function renderVisibilityPanel(
  panel: HTMLElement, grade: number, term: Term,
): Promise<void> {
  panel.replaceChildren();
  let settings;
  try {
    settings = await api.getSnapshotSettings(grade, term);
  } catch {
    return; // 表示できなくても致命的ではないので静かに諦める
  }

  const label = document.createElement("label");
  label.className = "visibility-label";
  label.textContent = "公開範囲";
  const select = document.createElement("select");
  select.className = "visibility-select";
  (Object.keys(VISIBILITY_LABELS) as Visibility[]).forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = VISIBILITY_LABELS[v];
    if (v === settings!.visibility) opt.selected = true;
    select.appendChild(opt);
  });
  label.appendChild(select);
  panel.appendChild(label);

  const shareRow = document.createElement("div");
  shareRow.className = "share-row";
  panel.appendChild(shareRow);

  function renderShareRow(shareUrl: string | null): void {
    shareRow.replaceChildren();
    if (shareUrl) shareRow.appendChild(buildCopyButton(shareUrl));
  }
  renderShareRow(settings.share_url);

  select.addEventListener("change", () => {
    void (async () => {
      select.disabled = true;
      try {
        const updated = await api.updateSnapshotSettings(grade, term, select.value as Visibility);
        renderShareRow(updated.share_url);
      } catch (err) {
        alert(err instanceof ApiError ? err.message : "公開範囲の更新に失敗しました");
        select.value = settings!.visibility;
      } finally {
        select.disabled = false;
      }
    })();
  });
}
