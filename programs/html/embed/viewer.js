// ================================================================
// embed/viewer.js
// 埋め込みフロアマップ（/embed/）の画面。core.js の計算を使って、
// フロアマップ・教室の場所・道案内（ARなし。階ごとの区間を順に見せる）を表示する。
//
// 親ページとのやり取り（postMessage。詳しくは docs/API_Embed.md）
//   送る:   { source: "ikunavi-embed", type: "ready" | "segment" | "error", ... }
//   受ける: { type: "ikunavi:show", params: {...URLパラメータと同じ} } で表示を差し替える
//           { type: "ikunavi:segment", index: n } で道案内の n 番目（0始まり）の区間を見せる
// ================================================================

// ローカル開発（Flask 同居）では同一オリジン、本番は api サブドメイン（ナビ画面の state.js と同じ）
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";
const SVG_NS = "http://www.w3.org/2000/svg";
const EMBEDDED = window.self !== window.top;   // iframe の中か（直接開いたときは1本指でも地図を動かせる）
const MAX_ZOOM = 8;
// 地図に描く線・印の色（embed.css の --accent・--transit-blue・--ink-faint と同じ）
const COLOR = { accent: "#E8501E", blue: "#1B3A6B", faint: "#8A919C" };

const $ = id => document.getElementById(id);

let campus = null;          // /api/all の中身と索引
let svgCache = {};          // "10_3" → SVG の文字列 / null（無い）
let params = null;          // parseEmbedParams の結果
let route = null;           // 道案内の /api/route の結果
let segments = [];
let segIndex = 0;
let renderToken = 0;        // 表示の差し替え中に古い読み込みが終わっても描かないための番号

// 地図の表示範囲
let svgEl = null, overlay = null, fullBox = null, homeBox = null;

// ================================================================
// 親ページへの通知
// ================================================================
function notifyParent(type, detail = {}) {
  if (!EMBEDDED) return;
  try { window.parent.postMessage({ source: "ikunavi-embed", type, ...detail }, "*"); } catch {}
}

// ================================================================
// データ
// ================================================================
async function loadCampus() {
  if (campus) return campus;
  const res = await fetch(`${API_BASE}/api/all`);
  if (!res.ok) throw new Error("教室の一覧を読み込めませんでした。時間をおいて開き直してください。");
  const data = await res.json();
  const names = {};
  (data.buildings || []).forEach(b => { names[Number(b.id)] = b.display_name; });
  const nodes = {};
  (data.nodes || []).forEach(n => { nodes[n.id] = n; });
  campus = { rooms: data.rooms || [], nodes, names };
  return campus;
}

async function loadSvgText(building, floor) {
  const key = `${building}_${floor}`;
  if (svgCache[key] === undefined) {
    try {
      const res = await fetch(`/svg/${building}_${floor}F.svg`);
      svgCache[key] = res.ok ? await res.text() : null;
    } catch {
      svgCache[key] = null;
    }
  }
  return svgCache[key];
}

/** その建物で経路データのある階（下から順） */
function floorsOf(building) {
  const set = new Set(Object.values(campus.nodes).filter(n => n.building === building).map(n => n.floor));
  return [...set].sort((a, b) => a - b);
}

// ================================================================
// 画面の部品
// ================================================================
function setBar(plate, title) {
  $("bar-plate").hidden = !plate;
  $("bar-plate").textContent = plate || "";
  $("bar-title").textContent = title;
  $("map").setAttribute("aria-label", [plate, title].filter(Boolean).join(" "));
}

function showNotice(title, desc = "") {
  const box = $("notice");
  box.replaceChildren();
  const t = document.createElement("p");
  t.className = "notice-title";
  t.textContent = title;
  box.append(t);
  if (desc) {
    const d = document.createElement("p");
    d.className = "notice-desc";
    d.textContent = desc;
    box.append(d);
  }
  box.hidden = false;
}

function hideNotice() { $("notice").hidden = true; }

function showError(title, desc = "") {
  clearMap();
  setBar("", title);
  showNotice(title, desc);
  $("steps").hidden = true;
  $("floors").hidden = true;
  notifyParent("error", { message: title });
}

function showBanner(text) {
  $("banner").textContent = text;
  $("banner").hidden = false;
}

function clearMap() {
  $("map").replaceChildren();
  $("banner").hidden = true;
  svgEl = overlay = fullBox = homeBox = null;
  $("zoom").hidden = true;
}

/** 階の切り替えボタン。current の階を選んだ状態にする */
function renderFloorChips(building, current, onPick) {
  const nav = $("floors");
  const floors = floorsOf(building);
  nav.replaceChildren();
  if (!params.floors || floors.length < 2) { nav.hidden = true; return; }
  floors.forEach(f => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = f <= 0 ? `B${1 - f}` : `${f}`;
    b.setAttribute("aria-label", embedFloorLabel(f));
    b.setAttribute("aria-pressed", String(f === current));
    b.addEventListener("click", () => onPick(f));
    nav.append(b);
  });
  nav.hidden = false;
}

// ================================================================
// フロアマップの表示
// ================================================================
/** SVG を読み込んで地図に置く。無ければ案内を出して false */
async function mountFloor(building, floor, token) {
  const text = await loadSvgText(building, floor);
  if (token !== renderToken) return false;
  clearMap();
  hideNotice();
  if (!text) {
    showNotice(`${embedBldgLabel(campus.names, building)} ${embedFloorLabel(floor)}のフロアマップはまだありません`,
      "経路のデータはあるので、IKU NAVI で開くと写真で道順を確かめられます。");
    return false;
  }
  const holder = $("map");
  holder.innerHTML = text;
  svgEl = holder.querySelector("svg");
  if (!svgEl) return false;
  const vb = svgEl.viewBox.baseVal;
  fullBox = { x: 0, y: 0, w: vb.width || 2481, h: vb.height || 1748 };
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgEl.setAttribute("overflow", "visible");
  svgEl.setAttribute("aria-hidden", "true");
  overlay = document.createElementNS(SVG_NS, "g");
  overlay.setAttribute("pointer-events", "none");
  svgEl.append(overlay);
  $("zoom").hidden = false;
  return true;
}

/** 地図の枠の縦横比（幅÷高さ） */
function stageAspect() {
  const r = $("map").getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r.width / r.height : 4 / 3;
}

/**
 * 表示範囲を決める。枠の縦横比に合わせて広げ（こうすると画面の1pxが常に同じ長さになり、
 * ドラッグ・ピンチの計算がずれない）、拡大しすぎ・縮小しすぎを止め、地図の外へ出すぎないように寄せる。
 */
function setView(box) {
  if (!svgEl) return;
  const a = stageAspect();
  const W = fullBox.w, H = fullBox.h;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let w = Math.max(box.w, box.h * a);
  w = Math.min(Math.max(w, W / MAX_ZOOM), Math.max(W, H * a));
  const h = w / a;
  const clamp = (c, size, full) => size >= full ? (full - size) / 2 : Math.max(0, Math.min(c - size / 2, full - size));
  svgEl.setAttribute("viewBox", `${clamp(cx, w, W)} ${clamp(cy, h, H)} ${w} ${h}`);
}

function currentView() {
  const vb = svgEl.viewBox.baseVal;
  return { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
}

/** 画面上の点 (px, py) の下にある地点を動かさずに、factor 倍の範囲を表示する（factor < 1 で拡大） */
function zoomAround(v, factor, px, py) {
  const rect = $("map").getBoundingClientRect();
  const fx = px == null ? 0.5 : (px - rect.left) / rect.width;
  const fy = py == null ? 0.5 : (py - rect.top) / rect.height;
  const w = v.w * factor, h = v.h * factor;
  return { x: v.x + v.w * fx - w * fx, y: v.y + v.h * fy - h * fy, w, h };
}

function zoomAt(factor, px, py) {
  if (svgEl) setView(zoomAround(currentView(), factor, px, py));
}

function svgEls(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

/** 目的地のピン（先が地点を指す形）。size は SVG 座標での高さ */
function drawPin(x, y, size, label) {
  const s = size;
  const g = svgEls("g", { transform: `translate(${x},${y})`, class: "pin" });
  g.append(svgEls("path", {
    d: `M0 0 C ${-s * 0.12} ${-s * 0.35} ${-s * 0.38} ${-s * 0.5} ${-s * 0.38} ${-s * 0.72} A ${s * 0.38} ${s * 0.38} 0 1 1 ${s * 0.38} ${-s * 0.72} C ${s * 0.38} ${-s * 0.5} ${s * 0.12} ${-s * 0.35} 0 0 Z`,
    fill: COLOR.accent, stroke: "#fff", "stroke-width": s * 0.06,
  }));
  g.append(svgEls("circle", { cx: 0, cy: -s * 0.72, r: s * 0.15, fill: "#fff" }));
  if (label) {
    const t = svgEls("text", { x: 0, y: -s * 1.22, "text-anchor": "middle", "font-size": s * 0.34, class: "pin-label" });
    t.textContent = label;
    g.append(t);
  }
  overlay.append(g);
}

/** 経路の線と、区間の出発点・終点の印 */
function drawRouteOnFloor(seg) {
  const coords = route.path_coords;
  const size = Math.max(fullBox.w, fullBox.h);
  const sw = size / 160;
  // 同じ階を前後でも通るなら、その部分は薄く出す（どの順に歩くかが分かるように）
  segments.forEach((other, k) => {
    if (k === segIndex || other.building !== seg.building || other.floor !== seg.floor) return;
    const pts = coords.slice(other.start, other.end + 1).filter(n => n.svg_x != null);
    if (pts.length > 1) overlay.append(svgEls("polyline", {
      points: pts.map(n => `${n.svg_x},${n.svg_y}`).join(" "),
      fill: "none", stroke: COLOR.faint, "stroke-width": sw * 0.7, "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-dasharray": `${sw * 1.5} ${sw * 1.5}`,
    }));
  });
  const pts = coords.slice(seg.start, seg.end + 1).filter(n => n.svg_x != null);
  if (!pts.length) return [];
  if (pts.length > 1) {
    const line = pts.map(n => `${n.svg_x},${n.svg_y}`).join(" ");
    overlay.append(svgEls("polyline", { points: line, fill: "none", stroke: "#fff", "stroke-width": sw * 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    overlay.append(svgEls("polyline", { points: line, fill: "none", stroke: COLOR.accent, "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round", class: "route-line" }));
  }
  const first = pts[0], last = pts[pts.length - 1];
  overlay.append(svgEls("circle", { cx: first.svg_x, cy: first.svg_y, r: sw * 1.4, fill: "#fff", stroke: COLOR.blue, "stroke-width": sw * 0.8 }));
  const isGoal = segIndex === segments.length - 1;
  if (isGoal) {
    // 目的地は最後の通路の真ん中あたり（ナビ画面の「この辺です」と同じ区間）
    const a = coords[coords.length - 2], b = coords[coords.length - 1];
    const goal = a && b && a.svg_x != null && b.svg_x != null && a.building === b.building && a.floor === b.floor
      ? { svg_x: (a.svg_x + b.svg_x) / 2, svg_y: (a.svg_y + b.svg_y) / 2 } : last;
    drawPin(goal.svg_x, goal.svg_y, sw * 9, route.dest_display || "");
    return [...pts, { svg_x: goal.svg_x, svg_y: goal.svg_y - sw * 9 }];
  }
  overlay.append(svgEls("circle", { cx: last.svg_x, cy: last.svg_y, r: sw * 1.6, fill: COLOR.blue, stroke: "#fff", "stroke-width": sw * 0.6 }));
  return pts;
}

// ================================================================
// 屋外の区間（フロアマップが無いので、歩く道の形と距離だけ見せる）
// ================================================================
function drawOutdoorSketch(seg) {
  clearMap();
  hideNotice();
  const pts = route.path_coords.slice(seg.start, seg.end + 1).filter(n => n.lat != null && n.lng != null);
  const holder = $("map");
  if (pts.length < 2) return;
  // 緯度経度をメートルに直して、北を上にした小さな図にする
  const lat0 = pts[0].lat, cos = Math.cos(lat0 * Math.PI / 180);
  const xy = pts.map(p => ({ x: (p.lng - pts[0].lng) * 111320 * cos, y: -(p.lat - lat0) * 111320 }));
  const xs = xy.map(p => p.x), ys = xy.map(p => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 40);
  const m = span * 0.25;
  const vb = `${Math.min(...xs) - m} ${Math.min(...ys) - m} ${Math.max(...xs) - Math.min(...xs) + m * 2} ${Math.max(...ys) - Math.min(...ys) + m * 2}`;
  const svg = svgEls("svg", { viewBox: vb, class: "outdoor", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
  const sw = span / 60;
  const line = xy.map(p => `${p.x},${p.y}`).join(" ");
  svg.append(svgEls("polyline", { points: line, fill: "none", stroke: "#fff", "stroke-width": sw * 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  svg.append(svgEls("polyline", { points: line, fill: "none", stroke: COLOR.accent, "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round", class: "route-line" }));
  const a = xy[0], b = xy[xy.length - 1];
  svg.append(svgEls("circle", { cx: a.x, cy: a.y, r: sw * 1.5, fill: "#fff", stroke: COLOR.blue, "stroke-width": sw * 0.8 }));
  svg.append(svgEls("circle", { cx: b.x, cy: b.y, r: sw * 1.7, fill: COLOR.blue, stroke: "#fff", "stroke-width": sw * 0.6 }));
  const prev = segments[segIndex - 1], next = segments[segIndex + 1];
  const label = (p, text, below) => {
    if (!text) return;
    const t = svgEls("text", { x: p.x, y: p.y + (below ? sw * 5 : -sw * 3.2), "text-anchor": "middle", "font-size": sw * 3.2, class: "pin-label" });
    t.textContent = text;
    svg.append(t);
  };
  const startBelow = a.y <= b.y;
  label(a, prev ? embedBldgLabel(campus.names, prev.building) : "出発", !startBelow);
  label(b, next ? embedBldgLabel(campus.names, next.building) : "到着", startBelow);
  const north = svgEls("text", { x: Math.max(...xs) + m * 0.6, y: Math.min(...ys) - m * 0.4, "text-anchor": "middle", "font-size": sw * 3, class: "north" });
  north.textContent = "↑北";
  svg.append(north);
  holder.append(svg);
}

// ================================================================
// 表示の種類ごと
// ================================================================
async function showFloorView(building, floor, token, mark) {
  const floors = floorsOf(building);
  if (!floors.length) return showError(`${embedBldgLabel(campus.names, building)}のデータが見つかりません`, "bldg に号館の番号（10号館なら 10）を指定してください。");
  if (floor == null || !floors.includes(floor)) floor = floors.includes(1) ? 1 : floors[0];
  setBar(embedBldgLabel(campus.names, building), mark ? `${embedFloorLabel(floor)} ・ ${mark.display}` : embedFloorLabel(floor));
  renderFloorChips(building, floor, f => {
    // 教室の場所を出しているときに別の階を選んだら、ただのフロアマップにする
    params = { ...params, view: "floor", bldg: building, floor: f };
    $("open-full").href = fullNaviUrl(params);
    showFloorView(building, f, ++renderToken, null);
  });
  if (!(await mountFloor(building, floor, token))) return;
  homeBox = fullBox;
  if (mark) {
    const a = campus.nodes[mark.from], b = campus.nodes[mark.to];
    if (a?.svg_x != null && b?.svg_x != null) {
      const x = (a.svg_x + b.svg_x) / 2, y = (a.svg_y + b.svg_y) / 2;
      const size = Math.max(fullBox.w, fullBox.h) / 18;
      overlay.append(svgEls("line", { x1: a.svg_x, y1: a.svg_y, x2: b.svg_x, y2: b.svg_y, stroke: COLOR.accent, "stroke-width": size / 9, "stroke-linecap": "round", opacity: "0.35" }));
      drawPin(x, y, size, mark.display);
      homeBox = fitViewBox([{ x, y }, { x, y: y - size * 1.4 }], fullBox.w, fullBox.h, { min: Math.min(fullBox.w, 900) });
    } else {
      showBanner(`${mark.display}は${embedFloorLabel(floor)}にあります（この建物は、地図上の教室の位置をまだ登録していません）`);
    }
  }
  setView(homeBox);
  notifyParent("ready", { view: mark ? "room" : "floor", building, floor });
}

async function showRoomView(token) {
  const hit = findRoom(campus.rooms, params.room, params.bldg);
  if (hit === "ambiguous") return showError(`「${params.room}」は複数の号館にあります`, "bldg に号館の番号を指定してください。");
  if (!hit) return showError(`「${params.room}」が見つかりません`, "教室名は IKU NAVI の教室検索と同じ書き方で指定してください（例: 10301）。");
  await showFloorView(hit.building, hit.floor, token, hit);
}

async function showRouteView(token) {
  const q = new URLSearchParams();
  q.set("use_elevator", params.elevator ? "1" : "0");
  for (const [side, p] of [["from", params.from], ["to", params.to]]) {
    if (p.event) { q.set(`${side}_event`, p.event); continue; }
    const hit = findRoom(campus.rooms, p.room, p.bldg);
    const what = side === "from" ? "出発地" : "目的地";
    if (hit === "ambiguous") return showError(`${what}の「${p.room}」は複数の号館にあります`, `${side}_bldg に号館の番号を指定してください。`);
    if (!hit) return showError(`${what}の「${p.room}」が見つかりません`, "教室名は IKU NAVI の教室検索と同じ書き方で指定してください（例: 10301）。");
    q.set(`${side}_room`, hit.room);
    q.set(`${side}_building`, hit.building);
  }
  const res = await fetch(`${API_BASE}/api/route?${q}`);
  const data = await res.json().catch(() => ({}));
  if (token !== renderToken) return;
  if (!res.ok) return showError("道順が見つかりませんでした", data.error || "時間をおいて開き直してください。");
  route = data;
  segments = splitRouteSegments(route.path_coords || [], route.path_edges || []);
  if (!segments.length) return showError("道順が見つかりませんでした");
  $("floors").hidden = true;
  $("steps").hidden = false;
  const fromName = params.from.event || findRoom(campus.rooms, params.from.room, params.from.bldg)?.display || params.from.room;
  const toName = route.dest_display || params.to.event || findRoom(campus.rooms, params.to.room, params.to.bldg)?.display || params.to.room;
  setBar("", `${fromName} → ${toName}`);
  $("map").dataset.route = `${fromName}から${toName}への道順`;
  notifyParent("ready", { view: "route", segments: segments.length, total_length: Math.round(segments.reduce((s, x) => s + x.length, 0)) });
  await showSegment(0, token);
}

async function showSegment(k, token = renderToken) {
  if (!route || k < 0 || k >= segments.length) return;
  segIndex = k;
  const seg = segments[k];
  $("seg-count").textContent = `${k + 1}/${segments.length}`;
  $("seg-title").textContent = segmentTitle(seg, campus.names);
  $("seg-dist").textContent = seg.kind === "outdoor" || seg.length >= 10 ? distanceText(seg.length) : "";
  $("seg-next").textContent = segmentNextText(route, segments, k, campus.names);
  $("seg-prev").disabled = k === 0;
  $("seg-next-btn").disabled = k === segments.length - 1;
  $("map").setAttribute("aria-label", `${$("map").dataset.route}。${k + 1}番目の区間、${segmentTitle(seg, campus.names)}`);
  notifyParent("segment", { index: k, total: segments.length, kind: seg.kind, building: seg.building, floor: seg.floor, title: segmentTitle(seg, campus.names) });

  if (seg.kind === "outdoor") return drawOutdoorSketch(seg);
  if (!(await mountFloor(seg.building, seg.floor, token)) || token !== renderToken || segIndex !== k) return;
  const pts = drawRouteOnFloor(seg);
  if (!pts.length) showBanner("この建物は、地図上の道順をまだ登録していません。下の案内を見てください。");
  homeBox = fitViewBox(pts.map(n => ({ x: n.svg_x, y: n.svg_y })), fullBox.w, fullBox.h, { min: Math.min(fullBox.w, 800) });
  setView(homeBox);
}

async function render(search) {
  const token = ++renderToken;
  params = parseEmbedParams(search);
  route = null; segments = [];
  document.body.classList.toggle("no-header", !params.header);
  $("open-full").href = fullNaviUrl(params);
  $("steps").hidden = true;
  $("floors").hidden = true;
  hideNotice();
  try {
    if (params.view === "error") return showError(params.message);
    if (params.view === "empty") {
      return showError("表示する場所が指定されていません", "埋め込みコードは https://iku-navi.net/embed/builder/ で作れます。");
    }
    await loadCampus();
    if (token !== renderToken) return;
    if (params.view === "floor") return await showFloorView(params.bldg, params.floor, token, null);
    if (params.view === "room") return await showRoomView(token);
    if (params.view === "route") return await showRouteView(token);
  } catch (e) {
    if (token === renderToken) showError("地図を読み込めませんでした", e.message || "通信できる場所で開き直してください。");
  }
}

// ================================================================
// 操作（ボタン・キー・マウス・指）
// ================================================================
$("seg-prev").addEventListener("click", () => showSegment(segIndex - 1));
$("seg-next-btn").addEventListener("click", () => showSegment(segIndex + 1));
$("zoom-in").addEventListener("click", () => zoomAt(1 / 1.5));
$("zoom-out").addEventListener("click", () => zoomAt(1.5));
$("zoom-fit").addEventListener("click", () => { if (homeBox) setView(homeBox); });
document.addEventListener("keydown", e => {
  if (!route || e.target.closest("a")) return;
  if (e.key === "ArrowRight") showSegment(segIndex + 1);
  if (e.key === "ArrowLeft") showSegment(segIndex - 1);
});

let hintTimer = null;
function flashHint(text) {
  const h = $("hint");
  h.textContent = text;
  h.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove("show"), 1400);
}

const stage = $("map");
if (!EMBEDDED) document.body.classList.add("standalone");

// マウス: ドラッグで動かす。ホイールはページのスクロールに使わせ、Ctrl（トラックパッドのピンチ）のときだけ拡大縮小
let drag = null;
stage.addEventListener("pointerdown", e => {
  if (!svgEl || e.pointerType === "touch") return;   // 指は下の touch イベントで扱う
  drag = { x: e.clientX, y: e.clientY, v: currentView() };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("dragging");
});
stage.addEventListener("pointermove", e => {
  if (!drag || !svgEl) return;
  const k = drag.v.w / stage.getBoundingClientRect().width;
  setView({ ...drag.v, x: drag.v.x - (e.clientX - drag.x) * k, y: drag.v.y - (e.clientY - drag.y) * k });
});
const endDrag = () => { drag = null; stage.classList.remove("dragging"); };
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
stage.addEventListener("wheel", e => {
  if (!svgEl) return;
  if (EMBEDDED && !e.ctrlKey) { flashHint("Ctrl キーを押しながらスクロールで拡大・縮小"); return; }
  e.preventDefault();
  zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
}, { passive: false });

// 指: 埋め込みでは1本指はページのスクロールに使わせ、2本指で動かす・拡大縮小する（直接開いたときは1本指でも動かせる）
let touch = null;
const touchPoints = e => [...e.touches].slice(0, 2).map(t => ({ x: t.clientX, y: t.clientY }));
const touchStartState = e => ({ pts: touchPoints(e), v: currentView() });
stage.addEventListener("touchstart", e => {
  if (!svgEl) return;
  if (e.touches.length === 1 && EMBEDDED) { touch = null; flashHint("2本の指で地図を動かせます"); return; }
  e.preventDefault();
  touch = touchStartState(e);
}, { passive: false });
stage.addEventListener("touchmove", e => {
  if (!touch || !svgEl) return;
  const pts = touchPoints(e);
  if (pts.length !== touch.pts.length) { touch = touchStartState(e); return; }
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const k = touch.v.w / rect.width;
  const mid = p => p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0];
  const m0 = mid(touch.pts), m1 = mid(pts);
  let f = 1;
  if (pts.length > 1) {
    const d0 = Math.hypot(touch.pts[0].x - touch.pts[1].x, touch.pts[0].y - touch.pts[1].y);
    const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d0 > 1 && d1 > 1) f = d0 / d1;
  }
  // 指の真ん中の下にあった地点が、動かしたあとの指の真ん中に来るように
  const sx = touch.v.x + (m0.x - rect.left) * k, sy = touch.v.y + (m0.y - rect.top) * k;
  const w = touch.v.w * f, h = touch.v.h * f;
  setView({ x: sx - (m1.x - rect.left) * k * f, y: sy - (m1.y - rect.top) * k * f, w, h });
}, { passive: false });
const endTouch = e => { touch = e.touches.length && (e.touches.length > 1 || !EMBEDDED) ? touchStartState(e) : null; };
stage.addEventListener("touchend", endTouch);
stage.addEventListener("touchcancel", endTouch);

// 枠の大きさが変わったら（iframe の幅が変わる・画面を回すなど）、見ていた範囲を合わせ直す
new ResizeObserver(() => { if (svgEl) setView(currentView()); }).observe(stage);

// 親ページからの指示
window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ikunavi:show") render(messageToSearch(msg.params));
  if (msg.type === "ikunavi:segment" && Number.isInteger(msg.index)) showSegment(msg.index);
});

render(location.search);
