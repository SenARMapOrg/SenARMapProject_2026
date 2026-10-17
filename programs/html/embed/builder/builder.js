// ================================================================
// embed/builder/builder.js
// 埋め込みコードを作るページ。選んだ内容から /embed/ の URL と iframe のコードを作り、見本を出す。
// ================================================================

const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";
// 見本はこのページと同じオリジンの /embed/ を出す（ローカル確認でも動くように）。コードには本番の URL を書く
const PREVIEW_ORIGIN = location.origin;
const $ = id => document.getElementById(id);

let rooms = [];
let names = {};
let floorsByBldg = {};
const roomByOption = new Map();   // 候補の文字列（「10301教室（10号館）」）→ 教室

function roomOption(r) {
  return `${r.display}（${embedBldgLabel(names, r.building)}）`;
}

/** 入力欄の文字 → 教室。候補から選んだもの・教室名・表示名のどれでもよい */
function roomFromInput(id) {
  const v = $(id).value.trim();
  if (!v) return null;
  if (roomByOption.has(v)) return roomByOption.get(v);
  return findRoom(rooms, v, null);
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/all`);
  if (!res.ok) throw new Error();
  const data = await res.json();
  (data.buildings || []).forEach(b => { names[Number(b.id)] = b.display_name; });
  rooms = data.rooms || [];
  (data.nodes || []).forEach(n => {
    if (n.building === 0) return;
    (floorsByBldg[n.building] ||= new Set()).add(n.floor);
  });
  const list = $("room-list");
  rooms.forEach(r => {
    const opt = document.createElement("option");
    opt.value = roomOption(r);
    roomByOption.set(opt.value, r);
    list.append(opt);
  });
  Object.keys(floorsByBldg).map(Number).sort((a, b) => a - b).forEach(b => {
    $("bldg").append(new Option(embedBldgLabel(names, b), b));
  });
  fillFloors();
}

function fillFloors() {
  const sel = $("floor");
  const floors = [...(floorsByBldg[$("bldg").value] || [])].sort((a, b) => a - b);
  sel.replaceChildren(...floors.map(f => new Option(embedFloorLabel(f), f)));
  if (floors.includes(1)) sel.value = "1";
}

function kind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

/** 選んだ内容 → /embed/ のクエリ文字列。足りないときは { error } */
function buildQuery() {
  const q = new URLSearchParams();
  const k = kind();
  if (k === "room") {
    const r = roomFromInput("room");
    if (!r) return { error: "教室を候補から選んでください" };
    if (r === "ambiguous") return { error: "同じ名前の教室が複数の号館にあります。候補から選んでください" };
    q.set("room", r.room);
    q.set("bldg", r.building);
  } else if (k === "route") {
    const from = roomFromInput("from"), to = roomFromInput("to");
    if (!from || from === "ambiguous") return { error: "出発する教室を候補から選んでください" };
    if (!to || to === "ambiguous") return { error: "行き先の教室を候補から選んでください" };
    if (from === to) return { error: "出発する教室と行き先の教室が同じです" };
    q.set("from", from.room); q.set("from_bldg", from.building);
    q.set("to", to.room); q.set("to_bldg", to.building);
    if ($("no-elevator").checked) q.set("elevator", "0");
  } else {
    if (!$("bldg").value) return { error: "号館を選んでください" };
    q.set("bldg", $("bldg").value);
    if ($("floor").value) q.set("floor", $("floor").value);
  }
  if (!$("show-header").checked) q.set("header", "0");
  if (k !== "route" && !$("show-floors").checked) q.set("floors", "0");
  return { query: q.toString() };
}

function iframeCode(src, title) {
  const size = $("size").value;
  const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  if (size === "fluid") {
    return `<iframe src="${esc(src)}" title="${esc(title)}" width="100%" height="480" style="border:0" loading="lazy" allow="fullscreen"></iframe>`;
  }
  const [w, h] = size.split("x");
  return `<iframe src="${esc(src)}" title="${esc(title)}" width="${w}" height="${h}" style="border:0" loading="lazy" allow="fullscreen"></iframe>`;
}

function titleFor() {
  const k = kind();
  if (k === "room") return `${$("room").value.replace(/（.*）$/, "")}の場所（IKU NAVI）`;
  if (k === "route") return `${$("from").value.replace(/（.*）$/, "")}から${$("to").value.replace(/（.*）$/, "")}への道順（IKU NAVI）`;
  return `${$("bldg").selectedOptions[0]?.text || ""} ${$("floor").selectedOptions[0]?.text || ""}のフロアマップ（IKU NAVI）`;
}

let lastSrc = "";
function update() {
  const k = kind();
  document.querySelectorAll(".fields").forEach(el => { el.hidden = el.dataset.kind !== k; });
  $("floors-wrap").hidden = k === "route";
  const { query, error } = buildQuery();
  $("form-error").textContent = error || "";
  $("copy").disabled = Boolean(error);
  if (error) { $("code").value = ""; return; }
  const code = iframeCode(`https://iku-navi.net/embed/?${query}`, titleFor());
  $("code").value = code;
  // 見本: コードと同じ大きさで、このページと同じオリジンの /embed/ を出す（同じ内容なら読み込み直さない）
  const src = `${PREVIEW_ORIGIN}/embed/?${query}`;
  const box = $("preview-box");
  let frame = box.querySelector("iframe");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.style.border = "0";
    box.append(frame);
  }
  const size = $("size").value;
  frame.width = size === "fluid" ? "100%" : size.split("x")[0];
  frame.height = size === "fluid" ? "480" : size.split("x")[1];
  frame.title = titleFor();
  if (src !== lastSrc) { frame.src = src; lastSrc = src; }
}

$("form").addEventListener("input", update);
$("form").addEventListener("change", update);
$("form").addEventListener("submit", e => e.preventDefault());
$("bldg").addEventListener("change", () => { fillFloors(); update(); });
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("code").value);
    $("copied").textContent = "コピーしました";
  } catch {
    $("code").select();
    $("copied").textContent = "選んだ状態にしました。Ctrl+C（Mac は ⌘+C）でコピーしてください";
  }
  setTimeout(() => { $("copied").textContent = ""; }, 2500);
});

loadData()
  .then(() => {
    // 最初の見本: 地図に位置の印を付けられる 10号館の、番号だけの教室を1つ
    const sample = rooms.find(r => r.building === 10 && /^\d+$/.test(r.room)) || rooms[0];
    if (sample) $("room").value = roomOption(sample);
    update();
  })
  .catch(() => { $("form-error").textContent = "教室の一覧を読み込めませんでした。時間をおいて開き直してください。"; });
