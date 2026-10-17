// ================================================================
// embed/builder/builder.js
// 埋め込みコードを作るページ。選んだ内容から /embed/ の URL と iframe のコードを作り、見本を出す。
// 場所は「名前で選ぶ」（教室・トイレ・食堂）か、通路・地点の ID（IKU NAVI ツールのマップ編集で見られる番号）で指定する。
// ================================================================

const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";
// 見本はこのページと同じオリジンの /embed/ を出す（ローカル確認でも動くように）。コードには本番の URL を書く
const PREVIEW_ORIGIN = location.origin;
const TOILETS = { M_Toilet: "男子トイレ", F_Toilet: "女子トイレ", C_Toilet: "多目的トイレ" };
const $ = id => document.getElementById(id);

let rooms = [];
let names = {};
let floorsByBldg = {};
const placeByOption = new Map();   // 候補の文字列（「10301教室（10号館）」）→ 場所の指定 { room, edge, bldg }

function addOption(text, spec) {
  if (placeByOption.has(text)) return;
  placeByOption.set(text, spec);
  const opt = document.createElement("option");
  opt.value = text;
  $("place-list").append(opt);
}

async function loadData() {
  const res = await fetch(`${API_BASE}/api/all`);
  if (!res.ok) throw new Error();
  const data = await res.json();
  (data.buildings || []).forEach(b => { names[Number(b.id)] = b.display_name; });
  rooms = data.rooms || [];
  (data.nodes || []).forEach(n => { (floorsByBldg[n.building] ||= new Set()).add(n.floor); });
  rooms.forEach(r => addOption(`${r.display}（${embedBldgLabel(names, r.building)}）`, { room: r.room, bldg: r.building }));

  // トイレ・食堂も名前で選べるように（教室一覧には出ない）
  const extra = await Promise.allSettled([
    ...Object.keys(TOILETS).map(t => fetch(`${API_BASE}/api/edges?name=${t}`).then(r => r.json())),
    fetch(`${API_BASE}/api/cafeterias`).then(r => r.json()),
  ]);
  extra.slice(0, -1).forEach(res => {
    if (res.status !== "fulfilled" || !Array.isArray(res.value)) return;
    res.value
      .sort((a, b) => a.building - b.building || a.floor - b.floor)
      .forEach(e => addOption(`${e.display}（${embedBldgLabel(names, e.building)} ${embedFloorLabel(e.floor)}）`, { edge: e.id }));
  });
  const caf = extra[extra.length - 1];
  if (caf.status === "fulfilled" && Array.isArray(caf.value)) {
    caf.value.forEach(c => addOption(`${c.display_name}（${embedBldgLabel(names, c.building)}）`, { room: c.name, bldg: Number(c.building) }));
  }

  const bldgs = Object.keys(floorsByBldg).map(Number).sort((a, b) => a - b);
  bldgs.filter(b => b !== 0).forEach(b => $("bldg").append(new Option(embedBldgLabel(names, b), b)));
  document.querySelectorAll(".place-field select.id-bldg").forEach(sel => {
    bldgs.forEach(b => sel.append(new Option(embedBldgLabel(names, b), b)));
    sel.value = "10";
  });
  fillFloors();
}

function fillFloors() {
  const sel = $("floor");
  const floors = [...(floorsByBldg[$("bldg").value] || [])].sort((a, b) => a - b);
  sel.replaceChildren(...floors.map(f => new Option(embedFloorLabel(f), f)));
  if (floors.includes(1)) sel.value = "1";
}

// ---------------------------------------------------------------- 場所の入力欄（場所・出発地・行き先で同じもの）
function buildPlaceField(box) {
  const label = box.dataset.label;
  box.innerHTML = `
    <div class="field-head">
      <span class="field-name"></span>
      <select class="how" aria-label="">
        <option value="name">名前で選ぶ</option>
        <option value="edge">通路の id</option>
        <option value="node">地点の id</option>
      </select>
    </div>
    <input class="name" list="place-list" placeholder="例: 10301教室・男子トイレ" aria-label="">
    <div class="field-row ids" hidden>
      <select class="id-bldg" aria-label="号館"></select>
      <input class="id" inputmode="numeric" pattern="[0-9]*" placeholder="例: 74" aria-label="">
    </div>
    <input class="label-input" placeholder="地図に出す名前（省略できます）" aria-label="">`;
  box.querySelector(".field-name").textContent = label;
  box.querySelector(".how").setAttribute("aria-label", `${label}の指定のしかた`);
  box.querySelector(".name").setAttribute("aria-label", `${label}の名前`);
  box.querySelector(".id").setAttribute("aria-label", `${label}の id`);
  box.querySelector(".label-input").setAttribute("aria-label", `${label}として地図に出す名前`);
  box.querySelector(".how").addEventListener("change", e => {
    const byName = e.target.value === "name";
    box.querySelector(".name").hidden = !byName;
    box.querySelector(".ids").hidden = byName;
  });
}

/** 入力欄 → 場所の指定 { room | edge | node, bldg, label }。足りなければ { error } */
function readPlace(box) {
  const what = box.dataset.label;
  const how = box.querySelector(".how").value;
  const label = box.querySelector(".label-input").value.trim();
  if (how === "name") {
    const v = box.querySelector(".name").value.trim();
    if (!v) return { error: `${what}を入れてください` };
    if (placeByOption.has(v)) return { ...placeByOption.get(v), label };
    const hit = findRoom(rooms, v, null);
    if (hit === "ambiguous") return { error: `${what}: 同じ名前の教室が複数の号館にあります。候補から選んでください` };
    if (hit) return { room: hit.room, bldg: hit.building, label };
    return { room: v, label };   // 候補に無い名前もそのまま渡す（地図の側で探す）
  }
  const id = box.querySelector(".id").value.trim();
  if (!/^\d+$/.test(id)) return { error: `${what}の id を数字で入れてください` };
  return { [how]: Number(id), bldg: Number(box.querySelector(".id-bldg").value), label };
}

function writePlace(q, prefix, p) {
  const key = name => prefix ? `${prefix}_${name}` : name;
  if (p.room != null) q.set(prefix || "room", p.room);
  if (p.edge != null) q.set(key("edge"), p.edge);
  if (p.node != null) q.set(key("node"), p.node);
  if (p.bldg != null && !(p.edge != null && p.edge >= EMBED_ID_OFFSET)) q.set(key("bldg"), p.bldg);
  if (p.label) q.set(key("label"), p.label);
}

/** 地図のタイトル（iframe の title）に使う、場所の呼び名 */
function placeName(box, p) {
  if (p.label) return p.label;
  if (box.querySelector(".how").value === "name") return box.querySelector(".name").value.replace(/（.*）$/, "").trim();
  return `${p.edge != null ? "通路" : "地点"} ${p.edge ?? p.node}`;
}

// ---------------------------------------------------------------- URL とコード
function kind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

/** 選んだ内容 → { query, title }。足りないときは { error } */
function buildQuery() {
  const q = new URLSearchParams();
  const k = kind();
  let title;
  if (k === "place") {
    const box = document.querySelector('.place-field[data-prefix=""]');
    const p = readPlace(box);
    if (p.error) return p;
    writePlace(q, "", p);
    title = `${placeName(box, p)}の場所`;
  } else if (k === "route") {
    const boxes = ["from", "to"].map(pr => document.querySelector(`.place-field[data-prefix="${pr}"]`));
    const [from, to] = boxes.map(readPlace);
    if (from.error) return from;
    if (to.error) return to;
    writePlace(q, "from", from);
    writePlace(q, "to", to);
    if ($("no-elevator").checked) q.set("elevator", "0");
    title = `${placeName(boxes[0], from)}から${placeName(boxes[1], to)}への道順`;
  } else {
    if (!$("bldg").value) return { error: "号館を選んでください" };
    q.set("bldg", $("bldg").value);
    if ($("floor").value) q.set("floor", $("floor").value);
    title = `${$("bldg").selectedOptions[0]?.text || ""} ${$("floor").selectedOptions[0]?.text || ""}のフロアマップ`;
  }
  if (!$("show-header").checked) q.set("header", "0");
  if (k !== "route" && !$("show-floors").checked) q.set("floors", "0");
  return { query: q.toString(), title: `${title}（IKU NAVI）` };
}

/** 大きさの選択 → iframe の属性と style */
function sizeAttrs() {
  const size = $("size").value;
  const ratio = size.match(/^ratio-(\d+)-(\d+)$/);
  if (ratio) return { width: "100%", height: null, style: `border:0;width:100%;aspect-ratio:${ratio[1]}/${ratio[2]}` };
  if (size === "fluid") return { width: "100%", height: "480", style: "border:0" };
  const [w, h] = size.split("x");
  return { width: w, height: h, style: "border:0;max-width:100%" };
}

function iframeCode(src, title) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const a = sizeAttrs();
  return `<iframe src="${esc(src)}" title="${esc(title)}" width="${a.width}"${a.height ? ` height="${a.height}"` : ""} style="${a.style}" loading="lazy" allow="fullscreen"></iframe>`;
}

let lastSrc = "";
function update() {
  const k = kind();
  document.querySelectorAll(".fields").forEach(el => { el.hidden = el.dataset.kind !== k; });
  $("floors-wrap").hidden = k === "route";
  const { query, title, error } = buildQuery();
  $("form-error").textContent = error || "";
  $("copy").disabled = Boolean(error);
  if (error) { $("code").value = ""; return; }
  $("code").value = iframeCode(`https://iku-navi.net/embed/?${query}`, title);
  // 見本: コードと同じ大きさで、このページと同じオリジンの /embed/ を出す（同じ内容なら読み込み直さない）
  const src = `${PREVIEW_ORIGIN}/embed/?${query}`;
  let frame = $("preview-box").querySelector("iframe");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.allow = "fullscreen";
    $("preview-box").append(frame);
  }
  const a = sizeAttrs();
  frame.setAttribute("style", a.style);
  frame.width = a.width;
  if (a.height) frame.height = a.height; else frame.removeAttribute("height");
  frame.title = title;
  if (src !== lastSrc) { frame.src = src; lastSrc = src; }
}

document.querySelectorAll(".place-field").forEach(buildPlaceField);
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
    if (sample) document.querySelector('.place-field[data-prefix=""] .name').value = `${sample.display}（${embedBldgLabel(names, sample.building)}）`;
    update();
  })
  .catch(() => { $("form-error").textContent = "教室の一覧を読み込めませんでした。時間をおいて開き直してください。"; });
