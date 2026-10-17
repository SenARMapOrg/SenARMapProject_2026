// ================================================================
// embed/viewer.js
// 埋め込みフロアマップ（/embed/）の画面。core.js の計算を使って、
// フロアマップ・場所（教室・通路・地点）・道順（ARなし。建物・階ごとの区間を順に見せる）を表示する。
//
// 地図の線と印は、拡大縮小しても画面上の太さ・大きさが変わらないように描く（線は non-scaling-stroke、
// 印は表示範囲が変わるたびに倍率を掛け直す）。iframe がどんな大きさでも、スマホでも同じ見え方になる。
//
// 親ページとのやり取り（postMessage。詳しくは docs/API_Embed.md）
//   送る:   { source: "ikunavi-embed", type: "ready" | "segment" | "error", ... }
//   受ける: { type: "ikunavi:show", params: {...URLパラメータと同じ} } で表示を差し替える
//           { type: "ikunavi:segment", index: n } で道順の n 番目（0始まり）の区間を見せる
// ================================================================

// ローカル開発（Flask 同居）では同一オリジン、本番は api サブドメイン（ナビ画面の state.js と同じ）
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";
const SVG_NS = "http://www.w3.org/2000/svg";
const EMBEDDED = window.self !== window.top;   // iframe の中か
const MAX_ZOOM = 8;
// 地図に描く線・印の色（embed.css の --accent・--transit-blue・--ink-faint と同じ）
const COLOR = { accent: "#E8501E", blue: "#1B3A6B", faint: "#8A919C" };
// 線の太さ・印の大きさ（画面上の px）
const PX = { route: 5, casing: 9, other: 3, place: 14, pin: 38, dot: 7, label: 13 };

const $ = id => document.getElementById(id);

let campus = null;          // /api/all の中身と索引
let svgCache = {};          // "10_3" → SVG の文字列 / null（無い）
let params = null;          // parseEmbedParams の結果
let route = null;           // 道順の /api/route の結果
let routeLabels = null;     // { from, to } 見出し・印に出す名前
let segments = [];
let segIndex = 0;
let renderToken = 0;        // 表示の差し替え中に古い読み込みが終わっても描かないための番号

// 地図: 表示中の svg と、印を描く層・地図全体の範囲・最初に見せる範囲
let svgEl = null, overlay = null, fullBox = null, homeBox = null;

/** 1本指で地図を動かすか（直接開いたとき・全画面のとき）。埋め込みでは1本指はページのスクロールに使わせる */
const oneFingerPan = () => !EMBEDDED || Boolean(document.fullscreenElement);

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

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
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

class PlaceError extends Error {
  constructor(title, desc) { super(title); this.desc = desc; }
}

/**
 * 場所の指定（core.js の parsePlace）→ 地図に出す場所。
 * 戻り値: { building, floor, a, b（通路の両端のノード。地点なら b は null）, label, apiRoom（/api/route に名前で渡すとき） }
 * what は「出発地の」など、エラー文の頭に付ける言葉。
 */
async function resolvePlace(pl, what = "") {
  const named = (building, floor, a, b, label, apiRoom) => ({ building, floor, a, b, label: pl.label || label, apiRoom });
  if (pl.node != null) {
    const n = campus.nodes[globalNodeId(pl.node, pl.bldg)];
    if (!n) throw new PlaceError(`${what}地点 ${pl.node} が見つかりません`, "node には node.csv の id と号館（bldg）か、グローバルなノードIDを指定してください。");
    return named(n.building, n.floor, n, null, "指定した地点");
  }
  if (pl.edge != null) {
    const { ok, data } = await fetchJson(`/api/edges?id=${globalEdgeId(pl.edge, pl.bldg)}`);
    if (!ok || !data.length) throw new PlaceError(`${what}通路 ${pl.edge} が見つかりません`, "edge には edge.csv の id と号館（bldg）か、グローバルなエッジIDを指定してください。");
    const e = data[0];
    return named(e.building, e.floor, campus.nodes[e.from], campus.nodes[e.to], e.display || "指定した通路");
  }
  // 名前: まず教室一覧、無ければトイレなど教室一覧に出ない名前も引く
  const hit = findRoom(campus.rooms, pl.room, pl.bldg);
  const ambiguous = () => new PlaceError(`${what}「${pl.room}」は複数の号館にあります`, "号館の番号（bldg・from_bldg・to_bldg）を指定してください。");
  if (hit === "ambiguous") throw ambiguous();
  if (hit) return named(hit.building, hit.floor, campus.nodes[hit.from], campus.nodes[hit.to], hit.display, hit.room);
  const q = new URLSearchParams({ name: pl.room });
  if (pl.bldg != null) q.set("building", pl.bldg);
  const { ok, data } = await fetchJson(`/api/edges?${q}`);
  const found = ok && Array.isArray(data) ? data : [];
  if (new Set(found.map(e => e.building)).size > 1) throw ambiguous();
  if (!found.length) throw new PlaceError(`${what}「${pl.room}」が見つかりません`, "教室名は IKU NAVI の教室検索と同じ書き方で指定してください（例: 10301）。");
  const e = found[0];
  return named(e.building, e.floor, campus.nodes[e.from], campus.nodes[e.to], e.display || pl.room, pl.room);
}

// ================================================================
// 画面の部品
// ================================================================
function setBar(plate, title) {
  $("bar-plate").hidden = !plate;
  $("bar-plate").textContent = plate || "";
  $("bar-title").textContent = title;
  document.title = `${[plate, title].filter(Boolean).join(" ")} | IKU NAVI`;
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

function showBanner(text) {
  $("banner").textContent = text;
  $("banner").hidden = false;
}

function showError(title, desc = "") {
  clearMap();
  setBar("", title);
  showNotice(title, desc);
  setRouteMode(false);
  $("floors").hidden = true;
  notifyParent("error", { message: title });
}

function clearMap() {
  $("map").replaceChildren();
  $("banner").hidden = true;
  $("north").hidden = true;
  svgEl = overlay = fullBox = homeBox = null;
  $("zoom").hidden = true;
}

function setRouteMode(on) {
  document.body.classList.toggle("route", on);
  $("steps").hidden = !on;
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
  nav.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ================================================================
// 地図（フロアマップの SVG・屋外の図）と表示範囲
// ================================================================
function svgEls(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

/** svg を地図に置き、印を描く層を用意する */
function mountSvg(svg) {
  $("map").replaceChildren(svg);
  svgEl = svg;
  const vb = svgEl.viewBox.baseVal;
  fullBox = { x: vb.x, y: vb.y, w: vb.width || 2481, h: vb.height || 1748 };
  svgEl.removeAttribute("width");
  svgEl.removeAttribute("height");
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgEl.setAttribute("overflow", "visible");
  svgEl.setAttribute("aria-hidden", "true");
  overlay = svgEls("g", { "pointer-events": "none", class: "overlay" });
  svgEl.append(overlay);
  $("zoom").hidden = false;
}

/** フロアマップを読み込んで地図に置く。無ければ案内を出して false */
async function mountFloor(building, floor, token) {
  const text = await loadSvgText(building, floor);
  if (token !== renderToken) return false;
  clearMap();
  hideNotice();
  if (!text) {
    showNotice(`${embedBldgLabel(campus.names, building)} ${embedFloorLabel(floor)}のフロアマップはまだありません`,
      "IKU NAVI で開くと、写真で道順を確かめられます。");
    return false;
  }
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (!svg || svg.nodeName !== "svg") return false;
  mountSvg(document.importNode(svg, true));
  return true;
}

/** 地図の枠の大きさ */
function stageRect() {
  const r = $("map").getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
}

/**
 * 表示範囲を決める。枠の縦横比に合わせて広げ（こうすると画面の1pxが常に同じ長さになり、
 * ドラッグ・ピンチの計算がずれない）、拡大しすぎ・縮小しすぎを止め、地図の外へ出すぎないように寄せる。
 */
function setView(box) {
  if (!svgEl) return;
  const r = stageRect();
  const a = r.width / r.height;
  const W = fullBox.w, H = fullBox.h;
  const whole = Math.max(W, H * a);   // 地図全体が収まる幅
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const w = Math.min(Math.max(box.w, box.h * a, whole / MAX_ZOOM), whole);
  const h = w / a;
  const clamp = (c, size, full, start) => size >= full ? start + (full - size) / 2 : Math.max(start, Math.min(c - size / 2, start + full - size));
  svgEl.setAttribute("viewBox", `${clamp(cx, w, W, fullBox.x)} ${clamp(cy, h, H, fullBox.y)} ${w} ${h}`);
  rescaleMarks(w / r.width);
}

function currentView() {
  const vb = svgEl.viewBox.baseVal;
  return { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
}

/** 画面上の点 (px, py) の下にある地点を動かさずに、factor 倍の範囲を表示する（factor < 1 で拡大） */
function zoomAt(factor, px, py) {
  if (!svgEl) return;
  const v = currentView(), r = stageRect();
  const fx = px == null ? 0.5 : (px - r.left) / r.width;
  const fy = py == null ? 0.5 : (py - r.top) / r.height;
  const w = v.w * factor, h = v.h * factor;
  setView({ x: v.x + v.w * fx - w * fx, y: v.y + v.h * fy - h * fy, w, h });
}

/**
 * 点の集まりと、その周りの印（ピンとその名前・丸）が収まる範囲。
 * 印は画面上の px で大きさが決まるので、余白も px で取る。minSvg は狭すぎる範囲にしないための最小の幅（地図の単位）
 */
function homeAround(points, { minSvg = 0 } = {}) {
  const r = stageRect();
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padPx = { top: PX.pin + 30, side: 36 };
  // 余白を足したあとの範囲で、1px が地図の何単位になるか
  const k = Math.max((x1 - x0) / Math.max(r.width - padPx.side * 2, 40), (y1 - y0) / Math.max(r.height - padPx.top - padPx.side, 40), minSvg / r.width);
  x0 -= padPx.side * k; x1 += padPx.side * k; y0 -= padPx.top * k; y1 += padPx.side * k;
  const w = Math.max(x1 - x0, minSvg);
  return { x: (x0 + x1) / 2 - w / 2, y: y0, w, h: y1 - y0 };
}

// ================================================================
// 印（ピン・丸・名前）。画面上の大きさが変わらないよう、表示範囲が変わるたびに倍率を掛け直す
// ================================================================
/** (x, y) に、px 単位で描いた中身（children）を置く */
function addMark(x, y, children) {
  const g = svgEls("g", { class: "mark" });
  g.dataset.x = x;
  g.dataset.y = y;
  children.forEach(c => g.append(c));
  overlay.append(g);
  return g;
}

function rescaleMarks(k) {
  if (!overlay) return;
  overlay.querySelectorAll(".mark").forEach(g => {
    g.setAttribute("transform", `translate(${g.dataset.x},${g.dataset.y}) scale(${k})`);
  });
}

function labelText(text, y) {
  const t = svgEls("text", { x: 0, y, "text-anchor": "middle", "font-size": PX.label, class: "map-label" });
  t.textContent = text;
  return t;
}

/** 目的地のピン（先が地点を指す形） */
function pinMark(x, y, label) {
  const s = PX.pin;
  const parts = [
    svgEls("path", {
      d: `M0 0 C ${-s * 0.12} ${-s * 0.35} ${-s * 0.38} ${-s * 0.5} ${-s * 0.38} ${-s * 0.72} A ${s * 0.38} ${s * 0.38} 0 1 1 ${s * 0.38} ${-s * 0.72} C ${s * 0.38} ${-s * 0.5} ${s * 0.12} ${-s * 0.35} 0 0 Z`,
      fill: COLOR.accent, stroke: "#fff", "stroke-width": 2,
    }),
    svgEls("circle", { cx: 0, cy: -s * 0.72, r: s * 0.15, fill: "#fff" }),
  ];
  if (label) parts.push(labelText(label, -s * 1.18));
  return addMark(x, y, parts);
}

/** 区間の出発点（白丸）・終点（紺丸） */
function dotMark(x, y, filled, label, labelBelow = false) {
  const parts = [svgEls("circle", filled
    ? { r: PX.dot + 1, fill: COLOR.blue, stroke: "#fff", "stroke-width": 2.5 }
    : { r: PX.dot, fill: "#fff", stroke: COLOR.blue, "stroke-width": 3 })];
  if (label) parts.push(labelText(label, labelBelow ? PX.dot + 17 : -PX.dot - 7));
  return addMark(x, y, parts);
}

/** 線（画面上の太さが変わらない） */
function polyline(points, stroke, width, extra = {}) {
  overlay.append(svgEls("polyline", {
    points: points.map(p => `${p.x},${p.y}`).join(" "), fill: "none", stroke, "stroke-width": width,
    "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke", ...extra,
  }));
}

function routeLine(points) {
  if (points.length < 2) return;
  polyline(points, "#fff", PX.casing);
  polyline(points, COLOR.accent, PX.route, { class: "route-line" });
}

// ================================================================
// 屋外（フロアマップが無いので、北を上にした 10m 方眼の上に道の形を描く）
// ================================================================
/** 緯度経度の点 → 方眼の svg を地図に置く。戻り値は各点の svg 座標（m） */
function mountOutdoor(latlngs) {
  clearMap();
  hideNotice();
  const lat0 = latlngs[0].lat, lng0 = latlngs[0].lng, cos = Math.cos(lat0 * Math.PI / 180);
  const xy = latlngs.map(p => ({ x: (p.lng - lng0) * 111320 * cos, y: -(p.lat - lat0) * 111320 }));
  const xs = xy.map(p => p.x), ys = xy.map(p => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 60);
  const m = span * 0.6;
  const box = { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + m * 2, h: Math.max(...ys) - Math.min(...ys) + m * 2 };
  const svg = svgEls("svg", { viewBox: `${box.x} ${box.y} ${box.w} ${box.h}`, class: "outdoor" });
  const grid = svgEls("pattern", { id: "grid10", width: 10, height: 10, patternUnits: "userSpaceOnUse" });
  grid.append(svgEls("path", { d: "M10 0H0V10", fill: "none", stroke: "#DBDCD4", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }));
  const defs = svgEls("defs", {});
  defs.append(grid);
  svg.append(defs, svgEls("rect", { x: box.x - box.w * 4, y: box.y - box.h * 4, width: box.w * 9, height: box.h * 9, fill: "url(#grid10)" }));
  mountSvg(svg);
  $("north").hidden = false;
  return xy;
}

function drawOutdoorSegment(seg) {
  const pts = route.path_coords.slice(seg.start, seg.end + 1).filter(n => n.lat != null && n.lng != null);
  if (pts.length < 2) { clearMap(); return; }
  const xy = mountOutdoor(pts);
  routeLine(xy);
  const prev = segments[segIndex - 1], next = segments[segIndex + 1];
  const a = xy[0], b = xy[xy.length - 1];
  const startBelow = a.y > b.y;   // 名前は、もう一方の点から離れる側に
  dotMark(a.x, a.y, false, prev ? embedBldgLabel(campus.names, prev.building) : routeLabels.from, startBelow);
  if (next) dotMark(b.x, b.y, true, embedBldgLabel(campus.names, next.building), !startBelow);
  else pinMark(b.x, b.y, routeLabels.to);
  homeBox = homeAround(xy);
  setView(homeBox);
}

// ================================================================
// 表示の種類ごと
// ================================================================
async function showFloorView(building, floor, token, place) {
  const floors = floorsOf(building);
  if (!floors.length) return showError(`${embedBldgLabel(campus.names, building)}のデータが見つかりません`, "bldg に号館の番号（10号館なら 10）を指定してください。");
  if (floor == null || !floors.includes(floor)) floor = floors.includes(1) ? 1 : floors[0];
  setBar(embedBldgLabel(campus.names, building), place ? `${embedFloorLabel(floor)}・${place.label}` : embedFloorLabel(floor));
  renderFloorChips(building, floor, f => {
    // 場所を出しているときに別の階を選んだら、ただのフロアマップにする
    params = { ...params, view: "floor", bldg: building, floor: f };
    $("open-full").href = fullNaviUrl(params);
    showFloorView(building, f, ++renderToken, null);
  });
  if (!(await mountFloor(building, floor, token))) return;
  homeBox = fullBox;
  if (place) {
    const pa = place.a?.svg_x != null ? { x: place.a.svg_x, y: place.a.svg_y } : null;
    const pb = place.b?.svg_x != null ? { x: place.b.svg_x, y: place.b.svg_y } : null;
    if (pa) {
      if (pb) polyline([pa, pb], COLOR.accent, PX.place, { opacity: "0.3" });
      const at = pb ? { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } : pa;
      pinMark(at.x, at.y, place.label);
      homeBox = homeAround(pb ? [pa, pb, at] : [at], { minSvg: fullBox.w * 0.35 });
    } else {
      showBanner(`${place.label}は${embedFloorLabel(floor)}にあります（この建物は、地図上の位置をまだ登録していません）`);
    }
  }
  setView(homeBox);
  notifyParent("ready", { view: place ? "place" : "floor", building, floor });
}

async function showPlaceView(token) {
  let place;
  try {
    place = await resolvePlace(params.place);
  } catch (e) {
    if (e instanceof PlaceError) return showError(e.message, e.desc);
    throw e;
  }
  if (token !== renderToken) return;
  if (place.building !== 0) return showFloorView(place.building, place.floor, token, place);
  // 屋外の通路・地点
  setBar("屋外", place.label);
  $("floors").hidden = true;
  const pts = [place.a, place.b].filter(n => n?.lat != null);
  if (!pts.length) return showError(`${place.label}の位置が分かりません`);
  const xy = mountOutdoor(pts);
  if (xy.length > 1) polyline(xy, COLOR.accent, PX.place, { opacity: "0.3" });
  const at = xy.length > 1 ? { x: (xy[0].x + xy[1].x) / 2, y: (xy[0].y + xy[1].y) / 2 } : xy[0];
  pinMark(at.x, at.y, place.label);
  homeBox = homeAround([...xy, at], { minSvg: 120 });
  setView(homeBox);
  notifyParent("ready", { view: "place", building: 0, floor: place.floor });
}

async function showRouteView(token) {
  const q = new URLSearchParams();
  q.set("use_elevator", params.elevator ? "1" : "0");
  const labels = {};
  for (const [side, pl, what] of [["from", params.from, "出発地の"], ["to", params.to, "目的地の"]]) {
    if (pl.event) { placeRouteParams(q, side, pl); labels[side] = pl.label || pl.event; continue; }
    let place;
    try {
      place = await resolvePlace(pl, what);
    } catch (e) {
      if (e instanceof PlaceError) return showError(e.message, e.desc);
      throw e;
    }
    placeRouteParams(q, side, pl, { room: place.apiRoom, building: place.building });
    labels[side] = place.label;
  }
  const { ok, data } = await fetchJson(`/api/route?${q}`);
  if (token !== renderToken) return;
  if (!ok) return showError("道順が見つかりませんでした", data.error || "時間をおいて開き直してください。");
  route = data;
  // 目的地の名前: 指定した表示名 → API が決めた名前（教室・トイレなど） → 場所の名前
  routeLabels = { from: labels.from, to: params.to.label || route.dest_display || labels.to };
  route.dest_display = routeLabels.to;
  segments = splitRouteSegments(route.path_coords || [], route.path_edges || []);
  if (!segments.length) return showError("道順が見つかりませんでした");
  $("floors").hidden = true;
  setRouteMode(true);
  setBar("", `${routeLabels.from} → ${routeLabels.to}`);
  renderSegmentList();
  notifyParent("ready", { view: "route", segments: segments.length, total_length: Math.round(segments.reduce((s, x) => s + x.length, 0)) });
  await showSegment(0, token);
}

/** 全区間の一覧（横に広い枠では地図の横、それ以外では隠す） */
function renderSegmentList() {
  $("seg-list").replaceChildren(...segments.map((seg, k) => {
    const span = (cls, text) => {
      const s = document.createElement("span");
      s.className = cls;
      s.textContent = text;
      return s;
    };
    const b = document.createElement("button");
    b.type = "button";
    b.append(
      span("li-title", segmentTitle(seg, campus.names)),
      span("li-dist", seg.kind === "outdoor" || seg.length >= 10 ? distanceText(seg.length) : ""),
      span("li-next", segmentNextText(route, segments, k, campus.names)),
    );
    b.addEventListener("click", () => showSegment(k));
    const li = document.createElement("li");
    li.append(b);
    return li;
  }));
}

async function showSegment(k, token = renderToken) {
  if (!route || k < 0 || k >= segments.length) return;
  segIndex = k;
  const seg = segments[k];
  const title = segmentTitle(seg, campus.names);
  $("seg-count").textContent = `${k + 1}/${segments.length}`;
  $("seg-title").textContent = title;
  $("seg-dist").textContent = seg.kind === "outdoor" || seg.length >= 10 ? distanceText(seg.length) : "";
  $("seg-next").textContent = segmentNextText(route, segments, k, campus.names);
  $("seg-prev").disabled = k === 0;
  $("seg-next-btn").disabled = k === segments.length - 1;
  $("seg-list").querySelectorAll("button").forEach((b, i) => {
    if (i === k) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
  });
  const item = $("seg-list").children[k];
  if (item && getComputedStyle($("seg-list")).display !== "none") item.scrollIntoView({ block: "nearest" });
  $("map").setAttribute("aria-label", `${routeLabels.from}から${routeLabels.to}への道順。${k + 1}番目の区間、${title}`);
  notifyParent("segment", { index: k, total: segments.length, kind: seg.kind, building: seg.building, floor: seg.floor, title });

  if (seg.kind === "outdoor") return drawOutdoorSegment(seg);
  if (!(await mountFloor(seg.building, seg.floor, token)) || token !== renderToken || segIndex !== k) return;
  drawFloorSegment(seg);
}

/** 屋内の区間: 経路の線と、区間の出発点・終点の印 */
function drawFloorSegment(seg) {
  const coords = route.path_coords;
  const xy = n => ({ x: n.svg_x, y: n.svg_y });
  // 同じ階を別の区間でも通るなら、その部分は点線で薄く出す（どこをいつ歩くかが分かるように）
  segments.forEach((other, i) => {
    if (i === segIndex || other.building !== seg.building || other.floor !== seg.floor) return;
    const pts = coords.slice(other.start, other.end + 1).filter(n => n.svg_x != null).map(xy);
    if (pts.length > 1) polyline(pts, COLOR.faint, PX.other, { "stroke-dasharray": "6 6" });
  });
  const pts = coords.slice(seg.start, seg.end + 1).filter(n => n.svg_x != null).map(xy);
  if (!pts.length) {
    showBanner("この建物は、地図上の道順をまだ登録していません。案内の文を見てください。");
    homeBox = fullBox;
    return setView(homeBox);
  }
  routeLine(pts);
  const isGoal = segIndex === segments.length - 1;
  dotMark(pts[0].x, pts[0].y, false, segIndex === 0 ? routeLabels.from : "", true);
  let focus = pts;
  if (isGoal) {
    // 目的地は最後の通路の真ん中あたり（ナビ画面の「この辺です」と同じ区間）
    const a = coords[coords.length - 2], b = coords[coords.length - 1];
    const goal = a && b && a.svg_x != null && b.svg_x != null && a.building === b.building && a.floor === b.floor
      ? { x: (a.svg_x + b.svg_x) / 2, y: (a.svg_y + b.svg_y) / 2 } : pts[pts.length - 1];
    pinMark(goal.x, goal.y, routeLabels.to);
    focus = [...pts, goal];
  } else {
    dotMark(pts[pts.length - 1].x, pts[pts.length - 1].y, true, "");
  }
  homeBox = homeAround(focus, { minSvg: fullBox.w * 0.4 });
  setView(homeBox);
}

async function render(search) {
  const token = ++renderToken;
  params = parseEmbedParams(search);
  route = null; segments = [];
  document.body.classList.toggle("no-header", !params.header);
  $("open-full").href = fullNaviUrl(params);
  setRouteMode(false);
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
    if (params.view === "place") return await showPlaceView(token);
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
$("zoom-in").addEventListener("click", () => zoomAt(1 / 1.6));
$("zoom-out").addEventListener("click", () => zoomAt(1.6));
$("zoom-fit").addEventListener("click", () => { if (homeBox) setView(homeBox); });
document.addEventListener("keydown", e => {
  if (e.target.closest("input, textarea, select")) return;
  if (route && e.key === "ArrowRight") showSegment(segIndex + 1);
  if (route && e.key === "ArrowLeft") showSegment(segIndex - 1);
  if (e.key === "+" || e.key === "=") zoomAt(1 / 1.6);
  if (e.key === "-") zoomAt(1.6);
});

// 全画面: 小さな iframe の中でも大きくして見られるように（使えないブラウザ・iPhone ではボタンを出さない）
if (document.fullscreenEnabled) {
  const btn = $("fullscreen");
  btn.hidden = false;
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener("fullscreenchange", () => {
    btn.setAttribute("aria-label", document.fullscreenElement ? "全画面をやめる" : "全画面で見る");
    document.body.classList.toggle("standalone", oneFingerPan());
  });
}

let hintTimer = null;
function flashHint(text) {
  const h = $("hint");
  h.textContent = text;
  h.classList.add("show");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove("show"), 1400);
}

const stage = $("map");
document.body.classList.toggle("standalone", oneFingerPan());

// マウス: ドラッグで動かす・ダブルクリックで拡大（Shift で縮小）。ホイールは、埋め込みではページのスクロールに使わせ、
// Ctrl（トラックパッドのピンチ）のときだけ拡大縮小する
let drag = null;
stage.addEventListener("pointerdown", e => {
  if (!svgEl || e.pointerType === "touch" || e.button !== 0) return;   // 指は下の touch イベントで扱う
  drag = { x: e.clientX, y: e.clientY, v: currentView() };
  stage.setPointerCapture(e.pointerId);
  stage.classList.add("dragging");
});
stage.addEventListener("pointermove", e => {
  if (!drag || !svgEl) return;
  const k = drag.v.w / stageRect().width;
  setView({ ...drag.v, x: drag.v.x - (e.clientX - drag.x) * k, y: drag.v.y - (e.clientY - drag.y) * k });
});
const endDrag = () => { drag = null; stage.classList.remove("dragging"); };
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
stage.addEventListener("dblclick", e => zoomAt(e.shiftKey ? 2 : 0.5, e.clientX, e.clientY));
stage.addEventListener("wheel", e => {
  if (!svgEl) return;
  if (!oneFingerPan() && !e.ctrlKey) { flashHint("Ctrl キーを押しながらスクロールで拡大・縮小"); return; }
  e.preventDefault();
  zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
}, { passive: false });

// 指: 2本指で動かす・拡大縮小（直接開いたとき・全画面では1本指でも動かせる）。ダブルタップで拡大
let touch = null;
let lastTap = null;
const touchPoints = e => [...e.touches].slice(0, 2).map(t => ({ x: t.clientX, y: t.clientY }));
const touchStartState = e => ({ pts: touchPoints(e), v: currentView(), moved: false, t: Date.now() });
stage.addEventListener("touchstart", e => {
  if (!svgEl) return;
  if (e.touches.length === 1 && !oneFingerPan()) {
    touch = { pts: touchPoints(e), moved: false, t: Date.now(), scrollOnly: true };
    return;
  }
  e.preventDefault();
  touch = touchStartState(e);
}, { passive: false });
stage.addEventListener("touchmove", e => {
  if (!touch || !svgEl) return;
  const pts = touchPoints(e);
  if (touch.scrollOnly) {
    if (pts.length < 2) {
      // 1本指のスワイプはページのスクロールに任せ、2本指で動かせることを知らせる
      if (!touch.moved && Math.hypot(pts[0].x - touch.pts[0].x, pts[0].y - touch.pts[0].y) > 12) {
        touch.moved = true;
        flashHint("2本の指で地図を動かせます");
      }
      return;
    }
    touch = touchStartState(e);
  }
  if (pts.length !== touch.pts.length) { touch = touchStartState(e); return; }
  e.preventDefault();
  const r = stageRect();
  const k = touch.v.w / r.width;
  const mid = p => p.length > 1 ? { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 } : p[0];
  const m0 = mid(touch.pts), m1 = mid(pts);
  if (Math.hypot(m1.x - m0.x, m1.y - m0.y) > 6) touch.moved = true;
  let f = 1;
  if (pts.length > 1) {
    const d0 = Math.hypot(touch.pts[0].x - touch.pts[1].x, touch.pts[0].y - touch.pts[1].y);
    const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (d0 > 1 && d1 > 1) { f = d0 / d1; touch.moved = true; }
  }
  // 指の真ん中の下にあった地点が、動かしたあとの指の真ん中に来るように
  const sx = touch.v.x + (m0.x - r.left) * k, sy = touch.v.y + (m0.y - r.top) * k;
  setView({ x: sx - (m1.x - r.left) * k * f, y: sy - (m1.y - r.top) * k * f, w: touch.v.w * f, h: touch.v.h * f });
}, { passive: false });
const endTouch = e => {
  // 動かさずに素早く2回たたいたら、そこを中心に拡大
  if (touch && !touch.moved && e.touches.length === 0 && touch.pts.length === 1 && Date.now() - touch.t < 300) {
    const p = touch.pts[0];
    if (lastTap && Date.now() - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      if (e.cancelable) e.preventDefault();
      zoomAt(0.5, p.x, p.y);
      lastTap = null;
    } else {
      lastTap = { ...p, t: Date.now() };
    }
  }
  touch = e.touches.length > 1 || (e.touches.length === 1 && oneFingerPan()) ? touchStartState(e) : null;
};
stage.addEventListener("touchend", endTouch);
stage.addEventListener("touchcancel", endTouch);

// 道順の帯を左右にスワイプして区間を切り替える（スマホで ◀ ▶ を狙わなくてよいように）
let swipe = null;
$("steps").addEventListener("touchstart", e => {
  swipe = e.touches.length === 1 && !e.target.closest(".seg-list") ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$("steps").addEventListener("touchend", e => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showSegment(segIndex + (dx < 0 ? 1 : -1));
  swipe = null;
});

// 枠の大きさが変わったら（iframe の大きさが変わる・画面を回す・一覧の出し入れなど）、
// 見ていた中心と 1px あたりの長さを保って合わせ直す（枠が広がればそのぶん広く見える）
let lastRect = null;
new ResizeObserver(() => {
  const r = stageRect();
  if (svgEl && lastRect) {
    const v = currentView();
    const k = v.w / lastRect.width;
    setView({ x: v.x + v.w / 2 - (r.width * k) / 2, y: v.y + v.h / 2 - (r.height * k) / 2, w: r.width * k, h: r.height * k });
  }
  lastRect = r;
}).observe(stage);

// 親ページからの指示
window.addEventListener("message", e => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ikunavi:show") render(messageToSearch(msg.params));
  if (msg.type === "ikunavi:segment" && Number.isInteger(msg.index)) showSegment(msg.index);
});

render(location.search);
