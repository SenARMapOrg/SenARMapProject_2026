// ============================================================
//  Globals
// ============================================================
const Z_SCALE   = 3.0;  // 高さ方向の倍率（建物を厚く見せる）
let graphData   = null;
let currentPath = null;
let startEdge   = null;
let destEdge    = null;
let filterBuilding = 0;
let filterFloor    = 0;
let acStart       = null;
let acGoal        = null;
let acToiletStart = null;

let edgeByPair  = null;  // "from-to" → エッジ（種別の逆引き用）
let pickStart   = null;  // 3Dクリックで選択中の出発ノードID
let pickGoal    = null;  // 3Dクリックで選択中の目的ノードID
let routeZoomed = false; // 「ルートを拡大」中か

// フロアカラーパレット (1F〜8F)
const FLOOR_COLORS = [
  "#FF8C42", "#06D6A0", "#118AB2", "#FFD166",
  "#EF476F", "#9B5DE5", "#00BBF9", "#F15BB5",
];
function floorColor(f) {
  return FLOOR_COLORS[(Math.max(f, 1) - 1) % FLOOR_COLORS.length];
}

// ============================================================
//  Boot
// ============================================================
(async () => {
  try {
    const res = await fetch("/api/graph");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    graphData = await res.json();
  } catch {
    document.getElementById("boot-error").classList.add("show");
    return;
  }
  graphData.nodes.forEach(n => { n.z *= Z_SCALE; });
  graphData.edges.forEach(e => { e.z0 *= Z_SCALE; e.z1 *= Z_SCALE; });

  // エッジ種別の逆引き索引（経路サマリーで使用）
  edgeByPair = new Map();
  graphData.edges.forEach(e => {
    edgeByPair.set(`${e.from}-${e.to}`, e);
    edgeByPair.set(`${e.to}-${e.from}`, e);
  });

  buildLegend();
  updateStats();
  buildFloorFilter();
  applyBuildingFromQueryParam();
  renderMap();
  initNodePicker();
  initMapResize();
  initPinchZoom();
  prefetchRooms();

  acStart = new RoomAutocomplete({
    inputId: "start-room-input", dropdownId: "start-room-dropdown",
    badgeId: "start-room-badge", buildingId: "start-building",
  });
  acGoal = new RoomAutocomplete({
    inputId: "goal-room-input", dropdownId: "goal-room-dropdown",
    badgeId: "goal-room-badge", buildingId: "goal-building",
  });
  acToiletStart = new RoomAutocomplete({
    inputId: "toilet-start-input", dropdownId: "toilet-start-dropdown",
    badgeId: "toilet-start-badge", buildingId: "toilet-start-building",
  });

  initSheet();
  initScrollTopBtn();
})();

async function prefetchRooms() {
  try {
    const res = await fetch("/api/rooms");
    const all = await res.json();
    document.getElementById("stat-rooms").textContent = new Set(all.map(r => r.room)).size;
  } catch { /* 統計表示のみなので失敗しても続行 */ }
}

// ============================================================
//  Sheet (mobile bottom sheet)
// ============================================================
function isMobile() { return window.innerWidth <= 767; }

function openSheet() {
  if (!isMobile()) return;
  document.getElementById("sidebar").classList.add("sheet-open");
  document.getElementById("map-container").classList.add("sheet-open-backdrop");
}
function closeSheet() {
  document.getElementById("sidebar").classList.remove("sheet-open");
  document.getElementById("map-container").classList.remove("sheet-open-backdrop");
}
function toggleSheet(open) {
  if (open) openSheet(); else closeSheet();
}

function initSheet() {
  const handle = document.getElementById("sheet-handle");
  const sidebar = document.getElementById("sidebar");
  const mapEl   = document.getElementById("map-container");

  mapEl.addEventListener("pointerdown", (e) => {
    if (isMobile() && mapEl.classList.contains("sheet-open-backdrop")) {
      closeSheet();
    }
  });

  let dragStartY = 0;
  let sheetOpenAtStart = false;

  handle.addEventListener("touchstart", (e) => {
    dragStartY = e.touches[0].clientY;
    sheetOpenAtStart = sidebar.classList.contains("sheet-open");
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener("touchmove", (e) => {
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - dragStartY;
    if (dy < -20) openSheet();
    else if (dy > 20) closeSheet();
    else toggleSheet(!sheetOpenAtStart);
  });

  handle.addEventListener("click", () => {
    if (isMobile()) toggleSheet(!sidebar.classList.contains("sheet-open"));
  });
}

// ============================================================
//  Tab switching
// ============================================================
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");

  if (isMobile()) openSheet();
}

// ============================================================
//  Legend & Stats
// ============================================================
function buildLegend() {
  const container = document.getElementById("legend-items");
  container.innerHTML = "";
  const floors = [...new Set(graphData.nodes.filter(n=>n.building!==0).map(n=>n.floor))].sort((a,b)=>a-b);
  floors.forEach(f => {
    const div = document.createElement("div");
    div.className = "legend-item";
    const color = floorColor(f);
    div.innerHTML = `<div class="legend-dot" style="background:${color};color:${color}"></div><span>${f}F</span>`;
    container.appendChild(div);
  });
}
function updateStats() {
  const buildings = new Set(graphData.nodes.map(n => n.building));
  document.getElementById("stat-nodes").textContent     = graphData.nodes.length;
  document.getElementById("stat-edges").textContent     = graphData.edges.length;
  document.getElementById("stat-buildings").textContent = buildings.size;
}

// ============================================================
//  RoomAutocomplete
// ============================================================
class RoomAutocomplete {
  constructor({ inputId, dropdownId, badgeId, buildingId }) {
    this.input       = document.getElementById(inputId);
    this.dropdown    = document.getElementById(dropdownId);
    this.badge       = document.getElementById(badgeId);
    this.buildingSel = document.getElementById(buildingId);
    this.roomList    = [];
    this.acIndex     = -1;
    this.selected    = null;

    this.input.addEventListener("input",   () => this._onInput());
    this.input.addEventListener("blur",    () => setTimeout(() => this._hide(), 200));
    this.input.addEventListener("keydown", (e) => this._onKeydown(e));

    this.input.addEventListener("focus", () => {
      if (isMobile()) {
        openSheet();
        setTimeout(() => this.input.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
      }
    });
  }

  onBuildingChange() {
    this.selected = null;
    this.input.value = "";
    this.badge.style.display = "none";
    this._hide();
  }

  async _onInput() {
    const q        = this.input.value.trim();
    const building = parseInt(this.buildingSel.value) || 0;
    this.selected  = null;
    this.badge.style.display = "none";
    if (!q) { this._hide(); return; }
    const url = `/api/rooms?q=${encodeURIComponent(q)}` + (building ? `&building=${building}` : "");
    const res = await fetch(url);
    this.roomList = await res.json();
    this.acIndex  = -1;
    this._render();
  }

  _render() {
    this.dropdown.innerHTML = "";
    if (!this.roomList.length) { this._hide(); return; }
    this.roomList.forEach((r, i) => {
      const div = document.createElement("div");
      div.className = "room-option";
      div.innerHTML = `<span>${r.room}</span><span class="room-meta">B${r.building}·${r.floor}F</span>`;
      div.addEventListener("pointerdown", (e) => { e.preventDefault(); this._select(i); });
      this.dropdown.appendChild(div);
    });
    this.dropdown.style.display = "block";
  }

  _select(i) {
    if (i < 0 || i >= this.roomList.length) return;
    this.selected    = this.roomList[i];
    this.input.value = this.selected.room;
    this.badge.textContent = `✓ ${this.selected.room}（Building ${this.selected.building} / ${this.selected.floor}F）`;
    this.badge.style.display = "block";
    this._hide();
    this.input.blur();
  }

  _hide() { this.dropdown.style.display = "none"; }

  _onKeydown(e) {
    const items = this.dropdown.querySelectorAll(".room-option");
    if      (e.key === "ArrowDown") this.acIndex = Math.min(this.acIndex + 1, items.length - 1);
    else if (e.key === "ArrowUp")   this.acIndex = Math.max(this.acIndex - 1, 0);
    else if (e.key === "Enter") {
      if (this.acIndex >= 0) { this._select(this.acIndex); e.preventDefault(); }
      return;
    } else { return; }
    items.forEach((el, i) => el.classList.toggle("ac-active", i === this.acIndex));
    e.preventDefault();
  }

  reset() {
    this.selected = null;
    this.input.value = "";
    this.badge.style.display = "none";
    this._hide();
  }
}

// ============================================================
//  APIから返った経路データのz値にZ_SCALEを適用
// ============================================================
function scalePathZ(data) {
  if (!data || data.error) return data;
  (data.path_coords || []).forEach(n => { n.z *= Z_SCALE; });
  (data.path_edges  || []).forEach(e => { e.z0 *= Z_SCALE; e.z1 *= Z_SCALE; });
  ['start_edge','destination_edge','from_edge','toilet_edge'].forEach(k => {
    if (data[k]) { data[k].z0 *= Z_SCALE; data[k].z1 *= Z_SCALE; }
  });
  return data;
}

// ============================================================
//  Navigate: 教室 → 教室
// ============================================================
async function navigateToRoom() {
  const box = document.getElementById("room-result-box");
  box.style.display = "none";

  if (!acStart.selected) {
    showResult(box, "error", "出発教室を選択してください"); return;
  }
  if (!acGoal.selected) {
    showResult(box, "error", "目的教室を選択してください"); return;
  }

  const { room: sRoom, building: sBuilding } = acStart.selected;
  const { room: gRoom, building: gBuilding } = acGoal.selected;
  const useElevatorRoom = document.getElementById("chk-elevator-room").checked ? "1" : "0";

  const url = `/api/navigate_to_room` +
    `?room=${encodeURIComponent(gRoom)}&building=${gBuilding}` +
    `&start_room=${encodeURIComponent(sRoom)}&start_building=${sBuilding}` +
    `&use_elevator=${useElevatorRoom}`;

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(url).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge   = data.start_edge       || null;
    destEdge    = data.destination_edge || null;
    showResult(box, "success",
      `<b>出発:</b> ${sRoom}（Building ${sBuilding}）<br>` +
      `<b>目的地:</b> ${gRoom}（Building ${gBuilding}）` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

// ============================================================
//  Navigate: ノード → ノード
// ============================================================
async function findPathByNode() {
  const start = parseInt(document.getElementById("sel-start").value);
  const goal  = parseInt(document.getElementById("sel-goal").value);
  const box   = document.getElementById("result-box");
  box.style.display = "none";

  const useElevatorNode = document.getElementById("chk-elevator-node").checked ? "1" : "0";

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(`/api/shortest_path?start=${start}&goal=${goal}&use_elevator=${useElevatorNode}`).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge = null; destEdge = null;
    showResult(box, "success",
      `<b>出発:</b> Node ${start}　<b>目的:</b> Node ${goal}` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

// ============================================================
//  最寄りトイレ検索
// ============================================================
async function findNearestToilet() {
  const box = document.getElementById("toilet-result-box");
  box.style.display = "none";

  if (!acToiletStart.selected) {
    showResult(box, "error", "現在地の教室を選択してください"); return;
  }

  const { room, building } = acToiletStart.selected;
  const type        = document.getElementById("toilet-type").value;
  const useElevator = document.getElementById("chk-elevator-toilet").checked ? "1" : "0";

  const url = `/api/nearest_toilet` +
    `?from_room=${encodeURIComponent(room)}&from_building=${building}` +
    `&type=${type}&use_elevator=${useElevator}`;

  let data;
  setBusy(true);
  try {
    data = scalePathZ(await fetch(url).then(r => r.json()));
  } catch {
    showResult(box, "error", "サーバーに接続できません。app.py が起動しているか確認してください。");
    return;
  } finally {
    setBusy(false);
  }

  if (data.error) {
    showResult(box, "error", data.error);
    currentPath = null; startEdge = null; destEdge = null;
  } else {
    currentPath = data;
    startEdge   = data.from_edge    || null;
    destEdge    = data.toilet_edge  || null;
    showResult(box, "success",
      `<b>出発:</b> ${room}（Building ${building}）<br>` +
      `<b>最寄り:</b> ${data.toilet_label}（Building ${data.toilet_building} / ${data.toilet_floor}F）` +
      buildJourneyHTML(data)
    );
  }
  renderMap();
}

function clearPath() {
  currentPath = null; startEdge = null; destEdge = null;
  pickStart = null; pickGoal = null;
  updatePickPanel();
  if (routeZoomed) resetRouteZoom();
  acStart?.reset(); acGoal?.reset(); acToiletStart?.reset();
  document.getElementById("room-result-box").style.display   = "none";
  document.getElementById("result-box").style.display        = "none";
  document.getElementById("toilet-result-box").style.display = "none";
  renderMap();
}

function setBusy(on) {
  document.getElementById("busy").classList.toggle("show", on);
}

function showResult(el, type, html) {
  el.className = type;
  el.innerHTML = html;
  el.style.display = "block";
}

// ============================================================
//  Filter
// ============================================================
/**
 * URLの ?building=1 のようなクエリパラメータを見て、初回描画前に「建物で絞り込み」を
 * 適用する（例: /3d/?building=1 で1号館だけを表示した状態で開ける）。
 * 「建物で絞り込み」セレクトに該当する<option>が無い(存在しない建物IDなど)場合は無視する。
 * renderMap()自体はこの関数では呼ばない（boot側で1回だけ呼ぶ想定。初回描画前に
 * filterBuildingをセットしておけば、その1回の描画で最初からその建物にズームされた
 * 状態になる。renderMapは uirevision:"keep" でカメラ位置を保持する作りなので、
 * 2回描画してしまうと2回目でせっかくの初期ズームが打ち消される）。
 */
function applyBuildingFromQueryParam() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("building");
  if (raw === null) return;
  const building = parseInt(raw, 10);
  if (!Number.isInteger(building)) return;

  const sel = document.getElementById("filter-building");
  const hasOption = [...sel.options].some((o) => parseInt(o.value, 10) === building);
  if (!hasOption) return;

  sel.value = String(building);
  filterBuilding = building;
}

function applyFilter() {
  filterBuilding = parseInt(document.getElementById("filter-building").value);
  filterFloor    = parseInt(document.getElementById("filter-floor").value);
  renderMap();
}

function buildFloorFilter() {
  const sel = document.getElementById("filter-floor");
  const floors = [...new Set(
    graphData.nodes.filter(n => n.building !== 0).map(n => n.floor)
  )].sort((a, b) => a - b);
  floors.forEach(f => {
    const o = document.createElement("option");
    o.value = f;
    o.textContent = `${f}F`;
    sel.appendChild(o);
  });
}

// ============================================================
//  座標変換・バウンディングボックス計算
// ============================================================
function getLocalCoords(x, y, cfg) {
  const theta = (cfg?.rot_deg || 0) * Math.PI / 180;
  const tx = cfg?.tx || 0;
  const ty = cfg?.ty || 0;
  const dx = x - tx;
  const dy = y - ty;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const lx = cos * dx + sin * dy;
  const ly = -sin * dx + cos * dy;
  return { lx, ly };
}

function getGlobalCoords(lx, ly, cfg) {
  const theta = (cfg?.rot_deg || 0) * Math.PI / 180;
  const tx = cfg?.tx || 0;
  const ty = cfg?.ty || 0;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const x = cos * lx - sin * ly + tx;
  const y = sin * lx + cos * ly + ty;
  return { x, y };
}

function computeBuildingBounds(nodes) {
  const byBuilding = {};
  nodes.forEach(n => {
    (byBuilding[n.building] = byBuilding[n.building] || []).push(n);
  });

  const bounds = {};
  Object.entries(byBuilding).forEach(([b, bNodes]) => {
    const cfg = graphData.config?.[b] || {};

    const localNodes = bNodes.map(n => {
      const { lx, ly } = getLocalCoords(n.x, n.y, cfg);
      return { ...n, lx, ly };
    });

    const lxs = localNodes.map(n => n.lx);
    const lys = localNodes.map(n => n.ly);
    const zs  = localNodes.map(n => n.z);

    const rangeXY = Math.max(Math.max(...lxs) - Math.min(...lxs), Math.max(...lys) - Math.min(...lys));
    const padXY = Math.max(rangeXY * 0.04, 1);

    let minLx = Math.min(...lxs);
    let maxLx = Math.max(...lxs);
    let minLy = Math.min(...lys);
    let maxLy = Math.max(...lys);

    const doorways = localNodes.filter(n => String(n.type) === "2");

    let lx0 = minLx - padXY;
    let lx1 = maxLx + padXY;
    let ly0 = minLy - padXY;
    let ly1 = maxLy + padXY;

    if (doorways.length > 0) {
      const doorMinLx = Math.min(...doorways.map(n => n.lx));
      const doorMaxLx = Math.max(...doorways.map(n => n.lx));
      const doorMinLy = Math.min(...doorways.map(n => n.ly));
      const doorMaxLy = Math.max(...doorways.map(n => n.ly));

      const EPS = 0.001;
      if (doorMinLx <= minLx + EPS) lx0 = doorMinLx;
      if (doorMaxLx >= maxLx - EPS) lx1 = doorMaxLx;
      if (doorMinLy <= minLy + EPS) ly0 = doorMinLy;
      if (doorMaxLy >= maxLy - EPS) ly1 = doorMaxLy;
    }

    const c0 = getGlobalCoords(lx0, ly0, cfg);
    const c1 = getGlobalCoords(lx1, ly0, cfg);
    const c2 = getGlobalCoords(lx1, ly1, cfg);
    const c3 = getGlobalCoords(lx0, ly1, cfg);
    const center = getGlobalCoords((lx0+lx1)/2, (ly0+ly1)/2, cfg);

    bounds[b] = { c0, c1, c2, c3, center, zs };
  });

  return bounds;
}

// ============================================================
//  案1: 建物バウンディングボックス
// ============================================================
function buildBuildingBoxTraces(nodes, bounds) {
  const traces = [];
  const byBuilding = {};
  nodes.forEach(n => { (byBuilding[n.building] = byBuilding[n.building] || []).push(n); });

  Object.entries(byBuilding).forEach(([b, bNodes]) => {
    const color = graphData.building_colors[(parseInt(b) - 1) % graphData.building_colors.length];
    const bData = bounds[b];
    if (!bData) return;
    const { c0, c1, c2, c3, center, zs } = bData;

    const z0 = Math.min(...zs) - 0.5, z1 = Math.max(...zs) + 0.5;

    // 塗りつぶし面(mesh3d)は使わずワイヤーフレームのみ描画する。塗りつぶしメッシュは
    // Plotlyの3Dピッキングで背後のノードマーカーより手前と判定されクリックを奪ってしまい
    // (hoverinfoの設定では回避できない)、建物に囲まれたノードが選択できなくなるため。
    const ex = [c0.x, c1.x, null, c1.x, c2.x, null, c2.x, c3.x, null, c3.x, c0.x, null,
                c0.x, c1.x, null, c1.x, c2.x, null, c2.x, c3.x, null, c3.x, c0.x, null,
                c0.x, c0.x, null, c1.x, c1.x, null, c2.x, c2.x, null, c3.x, c3.x, null];
    const ey = [c0.y, c1.y, null, c1.y, c2.y, null, c2.y, c3.y, null, c3.y, c0.y, null,
                c0.y, c1.y, null, c1.y, c2.y, null, c2.y, c3.y, null, c3.y, c0.y, null,
                c0.y, c0.y, null, c1.y, c1.y, null, c2.y, c2.y, null, c3.y, c3.y, null];
    const ez = [z0,z0,null, z0,z0,null, z0,z0,null, z0,z0,null,
                z1,z1,null, z1,z1,null, z1,z1,null, z1,z1,null,
                z0,z1,null, z0,z1,null, z0,z1,null, z0,z1,null];
    traces.push({
      type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:1.5}, hoverinfo:"skip", showlegend:false,
    });

    traces.push({
      type:"scatter3d", mode:"text",
      x:[center.x], y:[center.y], z:[z1+0.4],
      text:[`B${b}`],
      textfont:{color, size:14, family:"Arial Black"},
      hoverinfo:"skip", showlegend:false,
    });
  });
  return traces;
}

// ============================================================
//  案2: フロア床面
// ============================================================
function buildFloorPlaneTraces(nodes, bounds) {
  const byKey = {};
  nodes.forEach(n => {
    const k = `${n.building}_${n.floor}`;
    if (!byKey[k]) byKey[k] = { building:n.building, floor:n.floor, ns:[] };
    byKey[k].ns.push(n);
  });

  const traces = [];
  Object.values(byKey).forEach(({ building, floor, ns }) => {
    const color = floorColor(floor);
    const zVal = ns.reduce((s, n) => s + n.z, 0) / ns.length;

    const bData = bounds[building];
    if (!bData) return;
    const { c0, c1, c2, c3 } = bData;

    // 塗りつぶし面(mesh3d)は使わずワイヤーフレームのみ描画する。塗りつぶしメッシュは
    // 各フロアのノードとちょうど同じ高さに広がるため、Plotlyの3Dピッキングで
    // ノードマーカーより手前と判定されクリックを奪ってしまうことがあるため。
    traces.push({
      type:"scatter3d", mode:"lines",
      x:[c0.x, c1.x, c2.x, c3.x, c0.x], y:[c0.y, c1.y, c2.y, c3.y, c0.y],
      z:[zVal,zVal,zVal,zVal,zVal],
      line:{color, width:1, dash:"dot"},
      opacity:0.5,
      hoverinfo:"skip", showlegend:false,
    });

    traces.push({
      type:"scatter3d", mode:"text",
      x:[c1.x], y:[c0.y], z:[zVal],
      text:[`${floor}F`],
      textfont:{color, size:9},
      hoverinfo:"skip", showlegend:false,
    });
  });
  return traces;
}

// ============================================================
//  Render 3D map
// ============================================================
function buildPathEdgeSet() {
  const s = new Set();
  if (!currentPath) return s;
  currentPath.path_edges.forEach(e => { s.add(`${e.from}-${e.to}`); s.add(`${e.to}-${e.from}`); });
  return s;
}
function sameEdge(a, b) {
  return a && b && ((a.from===b.from && a.to===b.to)||(a.from===b.to && a.to===b.from));
}

function renderMap() {
  const indoorNodes = graphData.nodes.filter(n =>
    n.building !== 0 &&
    (!filterBuilding || n.building === filterBuilding) &&
    (!filterFloor    || n.floor    === filterFloor));
  const nodes   = indoorNodes;
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges   = (filterBuilding || filterFloor)
    ? graphData.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)) : graphData.edges;

  const dimmed = !!currentPath;  // ルート表示中は背景要素を淡くしてパスを際立たせる

  const traces = [];
  const bounds = computeBuildingBounds(nodes);
  traces.push(...buildFloorPlaneTraces(nodes, bounds));
  traces.push(...buildBuildingBoxTraces(nodes, bounds));

  // --- 屋外ノード・エッジ (building=0) ---
  const outdoorNodes   = graphData.nodes.filter(n => n.building === 0);
  const outdoorNodeIds = new Set(outdoorNodes.map(n => n.id));
  const outdoorEdges   = graphData.edges.filter(e =>
    outdoorNodeIds.has(e.from) || outdoorNodeIds.has(e.to));
  const outdoorEdgeIds = new Set(outdoorEdges.map(e => e.id));

  if (!filterBuilding && !filterFloor) {
    if (outdoorEdges.length) {
      const ox=[],oy=[],oz=[];
      outdoorEdges.forEach(e=>{ox.push(e.x0,e.x1,null);oy.push(e.y0,e.y1,null);oz.push(e.z0,e.z1,null);});
      traces.push({ type:"scatter3d", mode:"lines", x:ox, y:oy, z:oz,
        line:{color:"#5AFF5A", width:3, dash:"dot"}, hoverinfo:"skip",
        opacity: dimmed ? 0.25 : 1,
        name:"屋外通路", showlegend:true });
    }
    if (outdoorNodes.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:outdoorNodes.map(n=>n.x), y:outdoorNodes.map(n=>n.y), z:outdoorNodes.map(n=>n.z),
        customdata:outdoorNodes.map(n=>n.id),
        marker:{size:7, color:"#5AFF5A", opacity: dimmed ? 0.3 : 0.9, symbol:"square",
                line:{color:"#fff", width:1}},
        text:outdoorNodes.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:"屋外ノード", showlegend:true });
    }
  }
  const pathEdgeSet = buildPathEdgeSet();
  const pathNodeSet = new Set(currentPath ? currentPath.path : []);

  // 屋外エッジは上で専用トレースとして描画済みなので除外（二重描画防止）
  const normalEdges = edges.filter(e =>
    !outdoorEdgeIds.has(e.id) &&
    !pathEdgeSet.has(`${e.from}-${e.to}`) && !pathEdgeSet.has(`${e.to}-${e.from}`) &&
    !sameEdge(e, destEdge) && !sameEdge(e, startEdge));

  const edgesByFloor = {};
  normalEdges.filter(e => String(e.type) === "1").forEach(e => {
    (edgesByFloor[e.floor] = edgesByFloor[e.floor] || []).push(e);
  });
  Object.entries(edgesByFloor).forEach(([f, fEdges]) => {
    const color = floorColor(parseInt(f));
    const ex=[],ey=[],ez=[];
    fEdges.forEach(e=>{ex.push(e.x0,e.x1,null);ey.push(e.y0,e.y1,null);ez.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:3}, opacity: dimmed ? 0.22 : 1,
      hoverinfo:"skip", name:`${f}F 通路`, showlegend:false });
  });

  [["2","#FFB347","階段"], ["3","#00CED1","エスカレーター"], ["4","#DA70D6","EV"], ["5","#00FF88","上りESC"], ["6","#FF4500","下りESC"]].forEach(([t, color, label]) => {
    const typeEdges = normalEdges.filter(e => String(e.type) === t);
    if (!typeEdges.length) return;
    const ex=[],ey=[],ez=[];
    typeEdges.forEach(e=>{ex.push(e.x0,e.x1,null);ey.push(e.y0,e.y1,null);ez.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:ex, y:ey, z:ez,
      line:{color, width:5}, opacity: dimmed ? 0.25 : 1,
      hoverinfo:"skip", name:label, showlegend:false });
  });

  const byFloor = {};
  nodes.forEach(n => { (byFloor[n.floor] = byFloor[n.floor] || []).push(n); });
  Object.entries(byFloor).forEach(([f, fNodes]) => {
    const color   = floorColor(parseInt(f));
    const regular = fNodes.filter(n => !pathNodeSet.has(n.id) && n.type !== 2);
    const entries = fNodes.filter(n => !pathNodeSet.has(n.id) && n.type === 2);
    if (regular.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:regular.map(n=>n.x), y:regular.map(n=>n.y), z:regular.map(n=>n.z),
        customdata:regular.map(n=>n.id),
        marker:{size:5, color, opacity: dimmed ? 0.25 : 0.9, symbol:"circle", line:{color:"rgba(0,0,0,0.3)",width:.5}},
        text:regular.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:`${f}F`, showlegend:true });
    }
    if (entries.length) {
      traces.push({ type:"scatter3d", mode:"markers",
        x:entries.map(n=>n.x), y:entries.map(n=>n.y), z:entries.map(n=>n.z),
        customdata:entries.map(n=>n.id),
        marker:{size:10, color, opacity: dimmed ? 0.3 : 1, symbol:"diamond", line:{color:"#fff",width:1}},
        text:entries.map(n=>n.label), hovertemplate:"%{text}<extra></extra>",
        name:`${f}F 出入口`, showlegend:true });
    }
  });

  if (currentPath?.path_edges.length) {
    const px=[],py=[],pz=[];
    currentPath.path_edges.forEach(e=>{px.push(e.x0,e.x1,null);py.push(e.y0,e.y1,null);pz.push(e.z0,e.z1,null);});
    traces.push({ type:"scatter3d", mode:"lines", x:px, y:py, z:pz,
      line:{color:"#ffd700",width:6}, hoverinfo:"skip", name:"最短経路" });
  }

  if (startEdge) {
    traces.push({ type:"scatter3d", mode:"lines",
      x:[startEdge.x0,startEdge.x1], y:[startEdge.y0,startEdge.y1], z:[startEdge.z0,startEdge.z1],
      line:{color:"#4ade80",width:10},
      hovertemplate:`出発: ${startEdge.name}<extra></extra>`,
      name:`出発: ${acStart?.selected?.room||startEdge.name}` });
  }

  if (destEdge) {
    traces.push({ type:"scatter3d", mode:"lines",
      x:[destEdge.x0,destEdge.x1], y:[destEdge.y0,destEdge.y1], z:[destEdge.z0,destEdge.z1],
      line:{color:"#ff6b2b",width:10},
      hovertemplate:`目的地: ${destEdge.name}<extra></extra>`,
      name:`目的地: ${acGoal?.selected?.room||destEdge.name}` });
  }

  if (currentPath?.path_coords.length) {
    const pn = currentPath.path_coords;
    traces.push({ type:"scatter3d", mode:"markers+text",
      x:pn.map(n=>n.x), y:pn.map(n=>n.y), z:pn.map(n=>n.z),
      marker:{size:10, color:"#ffd700", symbol:"diamond", line:{color:"#fff",width:1}},
      text:pn.map((n,i)=>i===0?"START":i===pn.length-1?"GOAL":String(i)),
      textposition:"top center", textfont:{color:"#ffd700",size:11},
      hovertemplate:"Node %{text}<extra></extra>", name:"経路ノード" });
  }

  // 3Dクリックで選択中のノードを強調表示
  if (pickStart != null || pickGoal != null) {
    const picked = [];
    const ps = graphData.nodes.find(n => n.id === pickStart);
    const pg = graphData.nodes.find(n => n.id === pickGoal);
    if (ps) picked.push({ ...ps, c: "#00d498", t: "出発" });
    if (pg) picked.push({ ...pg, c: "#f2c437", t: "目的" });
    if (picked.length) {
      traces.push({ type:"scatter3d", mode:"markers+text",
        x:picked.map(n=>n.x), y:picked.map(n=>n.y), z:picked.map(n=>n.z),
        marker:{size:12, color:picked.map(n=>n.c), symbol:"circle", line:{color:"#fff", width:2}},
        text:picked.map(n=>n.t), textposition:"top center",
        textfont:{color:"#fff", size:10},
        hoverinfo:"skip", showlegend:false });
    }
  }

  const layout = {
    paper_bgcolor:"#07111d", plot_bgcolor:"#07111d",
    margin:{l:0,r:0,t:0,b:0},
    scene:{
      bgcolor:"#07111d",
      xaxis:axisStyle("X"), yaxis:{...axisStyle("Y"), autorange:"reversed"}, zaxis:axisStyle("階"),
      camera:{eye:{x:1.8,y:1.8,z:1.4}},
      aspectmode:"data",
    },
    legend:{
      x:.01, y:.99,
      bgcolor:"rgba(10,20,34,.85)", bordercolor:"#1e3450", borderwidth:1,
      font:{color:"#d4e8f8",size:11},
    },
    uirevision:"keep",
  };
  Plotly.react("map", traces, layout, { responsive:true });

  // 「ルートを拡大」ボタンの表示状態を同期
  const zoomBtn = document.getElementById("zoom-route-btn");
  zoomBtn.classList.toggle("available", !!(currentPath?.path_coords?.length));
  if (routeZoomed) {
    if (currentPath?.path_coords?.length) applyRouteZoom();
    else resetRouteZoom();
  }
}

function axisStyle(title) {
  return {
    title:{text:title,font:{color:"#3a5878",size:11}},
    gridcolor:"#122030", linecolor:"#1e3450",
    tickcolor:"#3a5878", tickfont:{color:"#3a5878",size:9},
    backgroundcolor:"#07111d", showbackground:true, zerolinecolor:"#1e3450",
  };
}

// #map-container のサイズが変わるたび（初期レイアウト確定・サイドバー開閉・
// ウィンドウリサイズ・フォント読み込み後のリフローなど）にPlotlyの
// WebGLキャンバスを追従させる。初回描画時にコンテナサイズがまだ確定して
// おらず、reloadを繰り返さないと3Dグラフが表示されない問題への対策。
function initMapResize() {
  const mapContainer = document.getElementById("map-container");
  const mapEl = document.getElementById("map");
  const observer = new ResizeObserver(() => {
    Plotly.Plots.resize(mapEl);
  });
  observer.observe(mapContainer);
}

// ============================================================
//  トップへ戻るボタン（モバイル）
// ============================================================
function initScrollTopBtn() {
  const btn        = document.getElementById("scroll-top-btn");
  const scrollArea = document.querySelector(".sheet-scroll-area");

  scrollArea.addEventListener("scroll", () => {
    btn.classList.toggle("visible", scrollArea.scrollTop > 120);
  }, { passive: true });

  btn.addEventListener("click", () => {
    scrollArea.scrollTo({ top: 0, behavior: "smooth" });
  });
}

// ============================================================
//  ノードピッカー — 3D上のノードをクリックして経路を作成
//  1回目のクリック = 出発、2回目 = 目的（そのまま経路探索）
//  3回目は新しい出発として選び直し。Esc または ✕ で解除。
// ============================================================
function initNodePicker() {
  const gd = document.getElementById("map");
  gd.on("plotly_click", ev => {
    const p = ev.points && ev.points[0];
    if (!p || p.customdata == null) return;
    onNodePicked(Number(p.customdata));
  });
  addEventListener("keydown", e => { if (e.key === "Escape") clearPick(); });
}

function onNodePicked(id) {
  if (pickStart == null || pickGoal != null) {
    // 未選択、または経路確定済み → 新しい出発として選び直し
    pickStart = id;
    pickGoal  = null;
    currentPath = null; startEdge = null; destEdge = null;
    document.getElementById("pick-journey").innerHTML = "";
    renderMap();
  } else if (id !== pickStart) {
    pickGoal = id;
    routeFromPick();
  }
  updatePickPanel();
}

async function routeFromPick() {
  const useElevator = document.getElementById("chk-elevator-node").checked ? "1" : "0";
  const journeyEl   = document.getElementById("pick-journey");
  setBusy(true);
  try {
    const data = scalePathZ(await fetch(
      `/api/shortest_path?start=${pickStart}&goal=${pickGoal}&use_elevator=${useElevator}`
    ).then(r => r.json()));
    if (data.error) {
      journeyEl.innerHTML = `<div class="journey-error">${data.error}</div>`;
      currentPath = null; startEdge = null; destEdge = null;
    } else {
      currentPath = data; startEdge = null; destEdge = null;
      journeyEl.innerHTML = buildJourneyHTML(data);
    }
  } catch {
    journeyEl.innerHTML = `<div class="journey-error">サーバーに接続できません</div>`;
  } finally {
    setBusy(false);
    renderMap();
  }
}

function updatePickPanel() {
  const s = document.getElementById("pick-start-chip");
  const g = document.getElementById("pick-goal-chip");
  s.textContent = pickStart != null ? `出発: ${pickStart}` : "出発: 未選択";
  g.textContent = pickGoal  != null ? `目的: ${pickGoal}`  : "目的: 未選択";
  s.className = "pick-chip" + (pickStart != null ? " start" : " empty");
  g.className = "pick-chip" + (pickGoal  != null ? " goal"  : " empty");
}

function clearPick() {
  const hadRoute = pickGoal != null && currentPath != null;
  pickStart = null; pickGoal = null;
  document.getElementById("pick-journey").innerHTML = "";
  updatePickPanel();
  if (hadRoute) {
    currentPath = null; startEdge = null; destEdge = null;
    if (routeZoomed) resetRouteZoom();
  }
  renderMap();
}

// ============================================================
//  経路サマリー — フロア遷移を距離比例の色帯（リボン）で表示
// ============================================================
function buildJourneyHTML(data) {
  const coords = data.path_coords || [];
  const edges  = data.path_edges  || [];
  if (coords.length < 2) return "";

  // 連続する (building, floor) 区間ごとに距離を集計
  const segs = [];
  coords.forEach((n, i) => {
    const key = `${n.building}_${n.floor}`;
    if (!segs.length || segs[segs.length - 1].key !== key) {
      segs.push({ key, building: n.building, floor: n.floor, dist: 0 });
    }
    if (i < edges.length) segs[segs.length - 1].dist += edges[i].length || 0;
  });

  const total    = edges.reduce((s, e) => s + (e.length || 0), 0);
  const colors   = graphData.building_colors || [];
  const segColor = b => b === 0 ? "#5AFF5A" : colors[(b - 1) % colors.length];
  const segLabel = s => s.building === 0 ? "屋外" : `${s.building}-${s.floor}F`;

  const strip = segs.map(s =>
    `<div class="journey-seg" style="flex:${Math.max(s.dist, total * 0.05) || 1} 1 0;` +
    `background:${segColor(s.building)};" title="${segLabel(s)} ${s.dist.toFixed(0)}m">${segLabel(s)}</div>`
  ).join("");

  // 階段・EV などの内訳（グラフのエッジ種別から逆引き）
  const TYPE_LABEL = { "2": "階段", "3": "エスカレーター", "4": "EV", "5": "上りESC", "6": "下りESC", "7": "入口" };
  const typeDist = {};
  edges.forEach(e => {
    const g = edgeByPair && edgeByPair.get(`${e.from}-${e.to}`);
    if (!g) return;
    const t = String(g.type);
    if (TYPE_LABEL[t]) typeDist[t] = (typeDist[t] || 0) + (e.length || 0);
  });

  const chips = [`<span class="meta-chip">合計 ${total.toFixed(0)}m ・ ${coords.length}ノード</span>`];
  Object.entries(typeDist).forEach(([t, d]) => {
    chips.push(`<span class="meta-chip">${TYPE_LABEL[t]} ${d.toFixed(0)}m</span>`);
  });

  return `<div class="journey">
    <div class="journey-strip">${strip}</div>
    <div class="journey-meta">${chips.join("")}</div>
  </div>`;
}

// ============================================================
//  ルートを拡大 — 経路の範囲にシーンをクロップして注視する
// ============================================================
function applyRouteZoom() {
  const cs = currentPath?.path_coords;
  if (!cs?.length) return;
  const pad = a => {
    const mn = Math.min(...a), mx = Math.max(...a);
    const p = Math.max((mx - mn) * 0.15, 6);
    return [mn - p, mx + p];
  };
  const [x0, x1] = pad(cs.map(n => n.x));
  const [y0, y1] = pad(cs.map(n => n.y));
  const [z0, z1] = pad(cs.map(n => n.z));
  Plotly.relayout("map", {
    "scene.xaxis.autorange": false, "scene.xaxis.range": [x0, x1],
    "scene.yaxis.autorange": false, "scene.yaxis.range": [y1, y0],  // Y軸は反転表示
    "scene.zaxis.autorange": false, "scene.zaxis.range": [z0, z1],
  });
}

function toggleRouteZoom() {
  if (routeZoomed) { resetRouteZoom(); return; }
  if (!currentPath?.path_coords?.length) return;
  applyRouteZoom();
  routeZoomed = true;
  const b = document.getElementById("zoom-route-btn");
  b.textContent = "全体に戻す";
  b.classList.add("zoomed");
}

function resetRouteZoom() {
  Plotly.relayout("map", {
    "scene.xaxis.autorange": true,
    "scene.yaxis.autorange": "reversed",
    "scene.zaxis.autorange": true,
  });
  routeZoomed = false;
  const b = document.getElementById("zoom-route-btn");
  b.textContent = "ルートを拡大";
  b.classList.remove("zoomed");
}

// ============================================================
//  カメラズーム — ＋/−ボタン と 2本指ピンチ（タブレット対応）
//  Plotly gl3d のタッチ操作は回転しか効かないため、ピンチは
//  キャプチャ段階で横取りしてカメラの注視点との距離を直接変える。
// ============================================================
const ZOOM_DIST_MIN = 0.25;  // 注視点へ寄れる最小距離（最大ズームイン）
const ZOOM_DIST_MAX = 12;    // 引ける最大距離（最大ズームアウト）

// 現在のカメラ状態を取得（回転中の内部状態を優先し、無ければレイアウト値）
function getLiveCamera() {
  const gd = document.getElementById("map");
  const scene = gd._fullLayout?.scene?._scene;
  if (scene?.getCamera) return scene.getCamera();
  return gd.layout?.scene?.camera || { eye: { x: 1.8, y: 1.8, z: 1.4 } };
}

// factor < 1 で拡大（注視点へ近づく）、> 1 で縮小
function zoomCamera(factor, baseCam) {
  const cam    = baseCam || getLiveCamera();
  const center = cam.center || { x: 0, y: 0, z: 0 };
  const eye    = cam.eye;
  const dx = eye.x - center.x, dy = eye.y - center.y, dz = eye.z - center.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!dist) return;
  const newDist = Math.max(ZOOM_DIST_MIN, Math.min(dist * factor, ZOOM_DIST_MAX));
  const s = newDist / dist;
  Plotly.relayout("map", {
    "scene.camera": {
      eye:    { x: center.x + dx * s, y: center.y + dy * s, z: center.z + dz * s },
      center: { ...center },
      up:     cam.up || { x: 0, y: 0, z: 1 },
    },
  });
}

function initPinchZoom() {
  const mapEl = document.getElementById("map");
  let pinch    = null;   // { d0, cam0 } ピンチ開始時の指間距離とカメラ
  let blocking = false;  // ピンチ中〜全指が離れるまで Plotly へのタッチ伝播を止める

  const touchDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const block = e => { e.preventDefault(); e.stopPropagation(); };

  // capture:true — Plotly がキャンバスで受け取る前に横取りする
  mapEl.addEventListener("touchstart", e => {
    if (e.touches.length >= 2) {
      pinch    = { d0: touchDist(e.touches), cam0: getLiveCamera() };
      blocking = true;
      block(e);
    } else if (blocking) {
      block(e);
    }
  }, { capture: true, passive: false });

  mapEl.addEventListener("touchmove", e => {
    if (pinch && e.touches.length >= 2) {
      const d = touchDist(e.touches);
      if (d >= 1) zoomCamera(pinch.d0 / d, pinch.cam0);
      block(e);
    } else if (blocking) {
      block(e);
    }
  }, { capture: true, passive: false });

  const endTouch = e => {
    if (!blocking) return;
    if (e.touches.length < 2)   pinch = null;
    if (e.touches.length === 0) blocking = false;  // 全指が離れたら通常操作へ復帰
  };
  mapEl.addEventListener("touchend",    endTouch, { capture: true });
  mapEl.addEventListener("touchcancel", endTouch, { capture: true });
}

// ============================================================
//  俯瞰ビュー
// ============================================================
function setTopView() {
  Plotly.relayout("map", {
    "scene.camera": {
      eye:    { x: 0, y: 0, z: 2.5 },
      up:     { x: 0, y: 1, z: 0 },
      center: { x: 0, y: 0, z: 0 },
    }
  });
}

