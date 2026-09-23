// ================================================================
// page.js
// 画面共通の小物（完了モーダル・ナビバー・表示切り替え・プルトゥリフレッシュ防止）。
// ================================================================

// ================================================================
// Completion modal
// ================================================================
function showCompletionModal() {
  document.getElementById("completion-modal").classList.add("show");
  speak("到着しました");
}
function closeCompletionModal() {
  document.getElementById("completion-modal").classList.remove("show");
}

// 背景クリックで閉じる
document.getElementById("completion-modal").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeCompletionModal();
});

function updateNavBar(node, step, total) {
  let label = "—";
  if (node) label = node.building === 0 ? "屋外を移動中" : `${bldgLabel(node.building)} ${node.floor}階`;
  document.getElementById("step-label").textContent = label;
  document.getElementById("step-count").textContent = total ? `${step + 1} / ${total - 1}` : "";
  document.getElementById("prev-btn").disabled = step <= 0;
  document.getElementById("next-btn").disabled = step >= total - 2;
}

// ================================================================
// View switching
// ================================================================
function switchView(view) {
  document.getElementById("map").style.display      = view === "map" ? "block" : "none";
  document.getElementById("svg-area").style.display = view === "svg" ? "block" : "none";
  if (view === "map" && map) google.maps.event.trigger(map, "resize");
}

// プルトゥリフレッシュ防止（overscroll-behavior非対応ブラウザ向けフォールバック）
document.addEventListener("touchstart", e => {
  if (e.touches.length > 1) return; // ピンチ操作は許可
  if (e.touches[0].clientY <= 20) e.preventDefault(); // 画面最上部からのスワイプのみ阻止
}, { passive: false });
