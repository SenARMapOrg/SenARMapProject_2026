// ================================================================
// State
// ================================================================
// ローカル開発（nginx/Flask 同居）では同一オリジン、本番（Cloudflare Pages）では api サブドメインへ
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";

// イベントモード: navi/?event=1 で有効化。
// event.csv に登録されたイベント名（屋台など）を検索候補に加え、イベント名でルート検索できる。
const EVENT_MODE = new URLSearchParams(location.search).get("event") === "1";
// 経路の線・ドットなど、CSS(var(--accent))を参照できないJS描画箇所で使うアクセントカラー
const ACCENT_COLOR = EVENT_MODE ? "#EA580C" : "#3B82F6";
if (EVENT_MODE) {
  document.body.classList.add("event-mode");
  document.getElementById("event-badge").style.display = "inline-flex";
  ["from-input", "to-input", "to-input-gps", "fac-from-input"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.placeholder = "教室名・屋台名";
  });
}

let map;
let mapReady = false;
let _pendingMapCallback = null;

// Google Maps 読み込み完了(initMap)前に地図操作が必要な処理が来た場合は、
// 読み込み完了まで保留してから実行する（教室一覧の表示自体はMapsを待たず即座に行うため）。
function runWhenMapReady(fn) {
  if (mapReady) fn();
  else _pendingMapCallback = fn;
}

function waitForMapReady() {
  return new Promise(resolve => runWhenMapReady(resolve));
}

let searchMode    = "room";
let facSearchMode = "room";
let gpsCoords     = null;
let facGpsCoords  = null;
let allNodes   = [];
let allRooms   = [];        // [{room, display, building, isEvent?}, ...] roomはAPI用の生の名前、displayは表示名
let roomsByBuilding = {};   // {"10": ["101A", ...], ...}
let buildingNames = {};     // {10: "10号館", ...} data/building_name.csv 由来（未登録は "{id}号館"）

let pathCoords  = [];
let pathEdges   = [];  // path_coords[i]→[i+1] に対応する区間情報（type/length/name）。音声案内に使う
let currentStep = 0;

let outdoorPolylines = [];
let stepMarker       = null;
let gpsMarker        = null;
let gpsCircle        = null;

let svgBuilding    = null;
let svgFloor       = null;
let svgOverlay     = null;
let svgOrigViewBox = null;
let svgViewW       = 1400;
let svgViewH       = 1000;

let edgeImages  = {};
let imgByStep = {};  // step_index → <img> DOM element
let svgCache      = {};  // `${building}_${floor}` → SVG text or null (prefetched)
let arrowBlobUrls = {};  // "straight"|"right"|"left" → blob: URL (prefetched)

// ================================================================
// 方向矢印: 閾値設定（後から変更しやすいように定数で管理）
// ================================================================
// 直進と判定する折れ角の上限（絶対値）: 単位は度
// ±STRAIGHT_THRESHOLD_DEG 以内なら直進、それ以上なら左右折とみなす。
// 人間計測データのブレ（廊下直進でも±10〜15度は発生）を考慮すること。
// 推奨範囲: 30（厳しめ） 〜 60（ゆるめ）
const STRAIGHT_THRESHOLD_DEG = 45;  // ← この値を調整してください
// ================================================================

const ARROW_URL = {
  straight: "https://cdn.iku-navi.net/Straight.png",
  right:    "https://cdn.iku-navi.net/right.png",
  left:     "https://cdn.iku-navi.net/left.png",
};

// 矢印画像をblob URLとして事前取得（オフライン時でも表示できるようにメモリに保持）
async function prefetchArrowImages() {
  await Promise.allSettled(
    Object.entries(ARROW_URL).map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        if (res.ok) arrowBlobUrls[key] = URL.createObjectURL(await res.blob());
      } catch {}
    })
  );
}

// ================================================================
// Google Maps init
// ================================================================
function initMap() {
  map = new google.maps.Map(document.getElementById("map"), {
    zoom: 17,
    center: { lat: 35.61035, lng: 139.55466 },
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    rotateControl: true,
  });
  mapReady = true;
  if (_pendingMapCallback) {
    const fn = _pendingMapCallback;
    _pendingMapCallback = null;
    fn();
  }
}

// ================================================================
// Data loading
// ================================================================
async function loadAllData() {
  prefetchArrowImages(); // ページ読み込み時に矢印画像を事前取得（fire-and-forget）
  try {
    const [dataRes, imgRes, cafRes, evRes] = await Promise.all([
      fetch(`${API_BASE}/api/all`),
      fetch(`${API_BASE}/api/edge_images`),
      fetch(`${API_BASE}/api/cafeterias`),
      EVENT_MODE ? fetch(`${API_BASE}/api/events`) : Promise.resolve(null),
    ]);
    if (dataRes.ok) {
      const data = await dataRes.json();
      allNodes = data.nodes || [];
      initBuildingNames(data.buildings || []);
      initRoomData(data.rooms || []);
    } else {
      console.warn("API unavailable — room autocomplete disabled");
    }
    // イベントモード: イベント名（屋台など）を検索候補プールに追加
    if (evRes && evRes.ok) {
      const events = await evRes.json();
      events.forEach(ev => allRooms.push({
        room: ev.title, display: ev.title, building: ev.building, isEvent: true,
      }));
    }
    if (imgRes.ok) edgeImages = await imgRes.json();
    if (cafRes.ok) {
      const cafList = await cafRes.json();
      const sel = document.getElementById("fac-cafeteria-name");
      cafList.forEach(c => {
        const opt = document.createElement("option");
        opt.value       = c.name;
        opt.textContent = `${c.display_name}(${bldgLabel(c.building)})`;
        sel.appendChild(opt);
      });
    }
  } catch {
    console.warn("API unavailable — room autocomplete disabled");
  }
  applyUrlParams();
}

// Google Maps の読み込み完了（initMap）を待たず、ページ読み込み直後に教室一覧を取得する。
// loadAllData は google.maps を一切参照しないため、Mapsの初期化と切り離して問題ない。
loadAllData();

// ================================================================
// URL パラメータからの検索プリセット（イベント誘導・QRコード用）
//   ?to=131&to_bldg=1                     → 目的地だけ入力済みの状態で開く
//   ?from=101A&from_bldg=10&to=131&to_bldg=1 → 自動でルート検索して表示
//   &elevator=0                           → エレベーター不使用
//   &mode=gps                             → 現在地(屋外)タブで目的地入力済み
// 号館(_bldg)は教室名が1つの号館にしか無い場合は省略可
// ================================================================
function applyUrlParams() {
  const q    = new URLSearchParams(location.search);
  const to   = q.get("to");
  const from = q.get("from");
  if (!to && !from) return;

  const toBldg   = q.get("to_bldg")   || q.get("to_building")   || "";
  const fromBldg = q.get("from_bldg") || q.get("from_building") || "";

  // select は該当 option がある場合のみ反映（API未取得時は空のまま）
  const setSelect = (id, val) => {
    const sel = document.getElementById(id);
    if (!sel || !val) return;
    if ([...sel.options].some(o => o.value === val)) sel.value = val;
  };

  setCategory("room");
  if (q.get("elevator") === "0") document.getElementById("use-elevator").checked = false;

  // 現在地(屋外)モード: 目的地だけ埋めて GPS 取得はユーザー操作に任せる
  if (q.get("mode") === "gps") {
    setMode("gps");
    if (to) {
      document.getElementById("to-input-gps").value = to;
      setSelect("gps-to-bldg", toBldg);
      const info = resolveRoom("to-input-gps", "gps-to-bldg");
      if (info && info !== "ambiguous") setSelect("gps-to-bldg", String(info.building));
    }
    document.getElementById("step-label").textContent = "現在地を取得してルート検索してください";
    if (to) document.getElementById("step-count").textContent = `目的地: ${to}`;
    return;
  }

  setMode("room");
  if (to) {
    document.getElementById("to-input").value = to;
    setSelect("to-bldg", toBldg);
  }
  if (from) {
    document.getElementById("from-input").value = from;
    setSelect("from-bldg", fromBldg);
  }

  // 号館未指定でも教室名から一意に決まる場合は select に反映
  const toInfo   = to   ? resolveRoom("to-input",   "to-bldg")   : null;
  const fromInfo = from ? resolveRoom("from-input", "from-bldg") : null;
  if (toInfo   && toInfo   !== "ambiguous") setSelect("to-bldg",   String(toInfo.building));
  if (fromInfo && fromInfo !== "ambiguous") setSelect("from-bldg", String(fromInfo.building));

  // 出発・目的の両方が確定していれば自動でルート検索
  if (fromInfo && fromInfo !== "ambiguous" && toInfo && toInfo !== "ambiguous") {
    doSearch();
    return;
  }

  // 目的地だけ確定 → 出発教室の入力を促す
  if (to && !from) {
    document.getElementById("step-label").textContent = "出発教室を入力してルート検索してください";
    document.getElementById("step-count").textContent =
      toInfo && toInfo !== "ambiguous" ? `目的地: ${bldgLabel(toInfo.building)} ${toInfo.display}` : `目的地: ${to}`;
  }
}

function bldgLabel(b) {
  return buildingNames[Number(b)] || (Number(b) === 0 ? "屋外" : `${b}号館`);
}

function initBuildingNames(buildings) {
  buildingNames = {};
  buildings.forEach(b => { buildingNames[Number(b.id)] = b.display_name; });
}

function initRoomData(rooms) {
  allRooms = rooms.map(r => ({ room: r.room, display: r.display || r.room, building: r.building }));
  roomsByBuilding = {};
  rooms.forEach(r => {
    const key = String(r.building);
    if (!roomsByBuilding[key]) roomsByBuilding[key] = [];
    roomsByBuilding[key].push(r.room);
  });

  const buildings = Object.keys(roomsByBuilding).sort((a, b) => Number(a) - Number(b));
  ["from-bldg", "to-bldg", "gps-to-bldg", "fac-from-bldg"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    buildings.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b;
      opt.textContent = bldgLabel(b);
      sel.appendChild(opt);
    });
  });

  setupAutocomplete("from-input",   "from-sugg",   "from-bldg");
  setupAutocomplete("to-input",     "to-sugg",     "to-bldg");
  setupAutocomplete("to-input-gps", "gps-to-sugg", "gps-to-bldg");
  setupAutocomplete("fac-from-input", "fac-from-sugg", "fac-from-bldg");

  [["from-bldg", "from-input"], ["to-bldg", "to-input"], ["gps-to-bldg", "to-input-gps"], ["fac-from-bldg", "fac-from-input"]].forEach(([bId, iId]) => {
    const sel = document.getElementById(bId);
    if (sel) sel.addEventListener("change", () => {
      const inp = document.getElementById(iId);
      if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input")); }
    });
  });
}

// ================================================================
// Custom autocomplete
// ================================================================
function setupAutocomplete(inputId, suggId, bldgSelectId) {
  const input = document.getElementById(inputId);
  const sugg  = document.getElementById(suggId);
  const bldg  = document.getElementById(bldgSelectId);
  if (!input || !sugg) return;

  function getMatches(q) {
    const selectedBldg = bldg ? bldg.value : "";
    const query = q.trim().toLowerCase();
    let candidates = selectedBldg
      ? allRooms.filter(r => String(r.building) === selectedBldg)
      : allRooms;
    if (query) candidates = candidates.filter(r =>
      r.room.toLowerCase().includes(query) || r.display.toLowerCase().includes(query));
    return candidates.slice(0, 20);
  }

  function renderSugg(matches) {
    const selectedBldg = bldg ? bldg.value : "";
    sugg.innerHTML = "";
    if (!matches.length) { sugg.style.display = "none"; return; }
    matches.forEach(r => {
      const item = document.createElement("div");
      item.className = "item";
      const label = r.isEvent ? `\u{1F3AA} ${r.display}` : r.display;
      item.textContent = selectedBldg ? label : `${bldgLabel(r.building)} ${label}`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        input.value = r.display;
        if (bldg && !bldg.value) bldg.value = String(r.building);
        sugg.style.display = "none";
      });
      sugg.appendChild(item);
    });
    sugg.style.display = "block";
  }

  input.addEventListener("input", () => {
    if (input.value.length === 0) { sugg.style.display = "none"; return; }
    renderSugg(getMatches(input.value));
  });
  input.addEventListener("focus", () => {
    if (input.value.length >= 1) renderSugg(getMatches(input.value));
  });
  input.addEventListener("blur", () => { sugg.style.display = "none"; });
}

// ================================================================
// Room resolution
// ================================================================
function swapFromTo() {
  const fromBldg = document.getElementById("from-bldg");
  const toBldg   = document.getElementById("to-bldg");
  const fromInp  = document.getElementById("from-input");
  const toInp    = document.getElementById("to-input");
  [fromBldg.value, toBldg.value] = [toBldg.value, fromBldg.value];
  [fromInp.value,  toInp.value]  = [toInp.value,  fromInp.value];
  document.getElementById("from-sugg").style.display = "none";
  document.getElementById("to-sugg").style.display = "none";
}

// ================================================================
function resolveRoom(inputId, bldgSelectId) {
  const inputEl = document.getElementById(inputId);
  const bldgEl  = document.getElementById(bldgSelectId);
  if (!inputEl) return null;
  const roomQuery = inputEl.value.trim();
  const bldgVal   = bldgEl ? bldgEl.value : "";
  if (!roomQuery) return null;
  // 生の名前 (room) と表示名 (display) のどちらで入力されてもマッチさせる
  let matches;
  if (bldgVal) {
    matches = allRooms.filter(r => String(r.building) === bldgVal
      && (r.room === roomQuery || r.display === roomQuery));
  } else {
    matches = allRooms.filter(r => r.room === roomQuery || r.display === roomQuery);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1)   return "ambiguous";
  return matches[0];
}

// ================================================================
// Search mode toggle
// ================================================================
function setMode(mode) {
  if (mode !== searchMode) syncDestination(mode);
  searchMode = mode;
  document.getElementById("panel-room").style.display = mode === "room" ? "block" : "none";
  document.getElementById("panel-gps").style.display  = mode === "gps"  ? "block" : "none";
  document.getElementById("tab-room").classList.toggle("active", mode === "room");
  document.getElementById("tab-gps").classList.toggle("active",  mode === "gps");
  // タブ切り替え時にパネルが閉じていれば自動で開く
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// 「教室→教室」と「現在地→教室」で目的地欄は別 input のため、
// タブ切替時に切替元の値を切替先へコピーして1つの目的地として振る舞わせる
function syncDestination(toMode) {
  const [srcInp, srcBldg, dstInp, dstBldg] = toMode === "gps"
    ? ["to-input", "to-bldg", "to-input-gps", "gps-to-bldg"]
    : ["to-input-gps", "gps-to-bldg", "to-input", "to-bldg"];
  document.getElementById(dstInp).value = document.getElementById(srcInp).value;
  const src = document.getElementById(srcBldg);
  const dst = document.getElementById(dstBldg);
  if ([...dst.options].some(o => o.value === src.value)) dst.value = src.value;
}

function setFacMode(mode) {
  facSearchMode = mode;
  document.getElementById("panel-fac-room").style.display = mode === "room" ? "block" : "none";
  document.getElementById("panel-fac-gps").style.display  = mode === "gps"  ? "block" : "none";
  document.getElementById("fac-tab-room").classList.toggle("active", mode === "room");
  document.getElementById("fac-tab-gps").classList.toggle("active",  mode === "gps");
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// ================================================================
// Category toggle (教室 / 設備検索)
// ================================================================
function setCategory(cat) {
  document.getElementById("cat-content-room").style.display     = cat === "room"     ? "block" : "none";
  document.getElementById("cat-content-facility").style.display = cat === "facility" ? "block" : "none";
  document.getElementById("cat-room").classList.toggle("active",     cat === "room");
  document.getElementById("cat-facility").classList.toggle("active", cat === "facility");
  if (!searchPanelOpen && window.innerWidth < 768) toggleSearchPanel();
}

// ================================================================
// Facility autocomplete
// ================================================================
// facSearchMode ("room"/"gps") から設備検索の出発地点を解決して params に埋め込む。
// 失敗時はエラーを alert して false を返す（呼び出し元はそのまま return する）。
function resolveFacFromParams(params) {
  if (facSearchMode === "room") {
    const fromInfo = resolveRoom("fac-from-input", "fac-from-bldg");
    if (!fromInfo)               { alert("出発教室を入力してください。"); return false; }
    if (fromInfo === "ambiguous") { alert("出発教室が複数の号館に存在します。号館を指定してください。"); return false; }
    if (fromInfo.isEvent) {
      params.set("from_event", fromInfo.room);
    } else {
      params.set("from_room",     fromInfo.room);
      params.set("from_building", fromInfo.building);
    }
  } else {
    if (!facGpsCoords) { alert("GPS位置を先に取得してください。"); return false; }
    const nearest = findNearestNode(facGpsCoords.lat, facGpsCoords.lng);
    if (!nearest) { alert("近くの出発ノードが見つかりません。\nキャンパスから離れすぎている可能性があります。"); return false; }
    params.set("from_node", nearest.id);
  }
  return true;
}

// 検索APIを叩いてルート表示まで行う共通処理（doSearch / doToiletSearch / doCafeteriaSearch で共用）
// 経路描画は屋外区間があると google.maps.Polyline/Marker を使うため、地図の初期化を待つ。
async function fetchRouteAndNavigate(url) {
  await waitForMapReady();
  setLoading(true);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) { alert("エラー: " + data.error); return; }
    await initRoute(data.path_coords, data.path_edges);
  } catch {
    document.getElementById("step-label").textContent = "サーバーに接続できません";
    document.getElementById("step-count").textContent = "app.py が起動しているか確認してください";
  } finally {
    setLoading(false);
  }
}

async function doToiletSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams({
    type:         document.getElementById("fac-toilet-type").value,
    use_elevator: document.getElementById("fac-use-elevator").checked ? "1" : "0",
  });
  if (!resolveFacFromParams(params)) return;
  await fetchRouteAndNavigate(`${API_BASE}/api/nearest_toilet?${params}`);
}

function onFacCategoryChange() {
  const cat = document.getElementById("fac-category").value;
  document.getElementById("fac-toilet-type").style.display    = cat === "toilet"    ? "" : "none";
  document.getElementById("fac-cafeteria-name").style.display = cat === "cafeteria" ? "" : "none";
}

function doFacSearch() {
  const cat = document.getElementById("fac-category").value;
  if (cat === "cafeteria") doCafeteriaSearch();
  else doToiletSearch();
}

async function doCafeteriaSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams({
    use_elevator: document.getElementById("fac-use-elevator").checked ? "1" : "0",
    name:         document.getElementById("fac-cafeteria-name").value,
  });
  if (!resolveFacFromParams(params)) return;
  await fetchRouteAndNavigate(`${API_BASE}/api/nearest_cafeteria?${params}`);
}

// ================================================================
// Search panel slide toggle (mobile only)
// ================================================================
let searchPanelOpen = true;

function toggleSearchPanel() {
  searchPanelOpen = !searchPanelOpen;
  const content = document.getElementById("search-content");
  const inner   = document.querySelector(".search-content-inner");
  const chevron = document.getElementById("search-chevron");

  if (searchPanelOpen) {
    content.classList.add("open");
    chevron.classList.add("open");
    // アニメーション完了後に overflow を解除してサジェストを表示可能にする
    content.addEventListener("transitionend", () => {
      inner.style.overflow = "";
    }, { once: true });
  } else {
    inner.style.overflow = "hidden";
    content.classList.remove("open");
    chevron.classList.remove("open");
  }
}

function collapseSearchPanel() {
  if (!searchPanelOpen || window.innerWidth >= 768) return;
  const content = document.getElementById("search-content");
  const inner   = document.querySelector(".search-content-inner");
  const chevron = document.getElementById("search-chevron");
  inner.style.overflow = "hidden";
  content.classList.remove("open");
  chevron.classList.remove("open");
  searchPanelOpen = false;
}

// ================================================================
// GPS
// ================================================================
function captureGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("gps-text").textContent = "取得中...";
  hideAccuracyWarn();
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      gpsCoords = { lat, lng };
      document.getElementById("gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      showAccuracyWarn(accuracy);
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function captureFacGPS() {
  if (!navigator.geolocation) { alert("位置情報に対応していません。"); return; }
  document.getElementById("fac-gps-text").textContent = "取得中...";
  const warn = document.getElementById("fac-accuracy-warn");
  warn.style.display = "none"; warn.className = "";
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      facGpsCoords = { lat, lng };
      document.getElementById("fac-gps-text").textContent =
        `${lat.toFixed(5)}, ${lng.toFixed(5)}  ±${Math.round(accuracy)}m`;
      if (accuracy > 30) {
        warn.style.display = "block"; warn.className = "warn-low";
        warn.innerHTML = `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>`
          + `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
      }
      renderGpsOnMap(lat, lng, accuracy);
    },
    () => {
      document.getElementById("fac-gps-text").textContent = "取得失敗";
      alert("位置情報を取得できませんでした。\nGPSが有効か確認してください。");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function renderGpsOnMap(lat, lng, accuracy) {
  if (gpsMarker) gpsMarker.setMap(null);
  gpsMarker = new google.maps.Marker({
    position: { lat, lng }, map,
    title: "現在地",
    icon: {
      path: google.maps.SymbolPath.CIRCLE, scale: 9,
      fillColor: "#4285F4", fillOpacity: 1,
      strokeColor: "white", strokeWeight: 2.5,
    },
    zIndex: 5,
  });
  if (gpsCircle) gpsCircle.setMap(null);
  gpsCircle = new google.maps.Circle({
    center: { lat, lng }, radius: accuracy, map,
    fillColor: "#4285F4", fillOpacity: 0.08,
    strokeColor: "#4285F4", strokeOpacity: 0.3, strokeWeight: 1.5,
  });
  switchView("map");
  map.panTo({ lat, lng });
}

function showAccuracyWarn(accuracy) {
  const el = document.getElementById("accuracy-warn");
  if (accuracy <= 30) { hideAccuracyWarn(); return; }
  el.style.display = "block";
  el.className = "warn-low";
  el.innerHTML =
    `GPS精度が低下しています（±${Math.round(accuracy)}m）。屋内の可能性があります。<br>` +
    `近くの<b>部屋番号の案内板</b>を確認して教室名で検索してください。`;
}

function hideAccuracyWarn() {
  const el = document.getElementById("accuracy-warn");
  el.style.display = "none";
  el.className = "";
}

// 最寄り屋外ノードがこの距離[m]より遠い場合はキャンパス外とみなして null を返す
const MAX_GPS_NODE_DIST_M = 500;

function findNearestNode(lat, lng) {
  const outdoor = allNodes.filter(n => n.building === 0 && n.lat != null && n.lng != null);
  if (!outdoor.length) return null;
  let best = null, bestD = Infinity;
  outdoor.forEach(n => {
    const d = haversine({ lat, lng }, { lat: n.lat, lng: n.lng });
    if (d < bestD) { bestD = d; best = n; }
  });
  return bestD <= MAX_GPS_NODE_DIST_M ? best : null;
}

function haversine(a, b) {
  const R = 6371000;
  const dφ = (b.lat - a.lat) * Math.PI / 180;
  const dλ = (b.lng - a.lng) * Math.PI / 180;
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const s  = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// ================================================================
// Route heading
// ================================================================
function calcRouteHeading(step) {
  const cur = pathCoords[step];
  if (!cur || cur.lat == null) return null;
  for (let i = step + 1; i < pathCoords.length; i++) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(cur.lat, cur.lng, n.lat, n.lng);
  }
  for (let i = step - 1; i >= 0; i--) {
    const n = pathCoords[i];
    if (n.lat != null && n.lng != null) return bearingDeg(n.lat, n.lng, cur.lat, cur.lng);
  }
  return null;
}

function bearingDeg(lat1, lng1, lat2, lng2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const dl   = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ================================================================
// Search
// ================================================================
async function doSearch() {
  arRequestPermissionsEarly();
  const params = new URLSearchParams();
  params.set("use_elevator", document.getElementById("use-elevator").checked ? "1" : "0");

  if (searchMode === "room") {
    const fromInfo = resolveRoom("from-input", "from-bldg");
    const toInfo   = resolveRoom("to-input",   "to-bldg");
    if (!fromInfo)              { alert("出発教室を入力してください。"); return; }
    if (fromInfo === "ambiguous") { alert("出発教室が複数の号館に存在します。号館を指定してください。"); return; }
    if (!toInfo)                { alert("目的教室を入力してください。"); return; }
    if (toInfo   === "ambiguous") { alert("目的教室が複数の号館に存在します。号館を指定してください。"); return; }
    if (fromInfo.isEvent) {
      params.set("from_event", fromInfo.room);
    } else {
      params.set("from_room",     fromInfo.room);
      params.set("from_building", fromInfo.building);
    }
    if (toInfo.isEvent) {
      params.set("to_event", toInfo.room);
    } else {
      params.set("to_room",       toInfo.room);
      params.set("to_building",   toInfo.building);
    }
  } else {
    if (!gpsCoords) { alert("GPS位置を先に取得してください。"); return; }
    const toInfo = resolveRoom("to-input-gps", "gps-to-bldg");
    if (!toInfo)              { alert("目的教室を入力してください。"); return; }
    if (toInfo === "ambiguous") { alert("目的教室が複数の号館に存在します。号館を指定してください。"); return; }
    const nearest = findNearestNode(gpsCoords.lat, gpsCoords.lng);
    if (!nearest) { alert("近くの出発ノードが見つかりません。\nキャンパスから離れすぎている可能性があります。"); return; }
    params.set("from_node",   nearest.id);
    if (toInfo.isEvent) {
      params.set("to_event", toInfo.room);
    } else {
      params.set("to_room",     toInfo.room);
      params.set("to_building", toInfo.building);
    }
  }

  await fetchRouteAndNavigate(`${API_BASE}/api/route?${params}`);
}

function setLoading(on) {
  document.getElementById("loading").classList.toggle("show", on);
}

// ================================================================
// Route image (AR area) — active クラスの付け替えで表示切り替え
// 屋外ステップは AR カメラビューを表示、屋内は写真 or プレースホルダー
// ================================================================
function updateRouteImage(step) {
  const label  = document.getElementById("ar-label");
  const phEl   = document.getElementById("ar-placeholder");
  const node   = pathCoords[step];
  const next   = pathCoords[step + 1];
  const isLast = step >= pathCoords.length - 1;
  // 建物内最終ノード（次が屋外ノード＝出口エッジ）も屋外扱いにして、
  // 出口専用の連結写真を用意しなくてもそのままカメラARへ移行する。
  const entersOutdoor = !!next && next.building === 0 && next.lat != null;
  const isOutdoor = node && !isLast &&
    ((node.building === 0 && node.lat != null) || entersOutdoor);

  if (isOutdoor) {
    Object.values(imgByStep).forEach(img => img.classList.remove("active"));
    phEl.style.display  = "none";
    label.style.display = "none";
    document.getElementById("direction-arrow").style.display = "none";
    document.getElementById("near-goal-badge").style.display = "none";
    arShowView();
    return;
  }

  arHideView();
  Object.values(imgByStep).forEach(img => img.classList.remove("active"));

  const img = imgByStep[step];

  if (img && !isLast) {
    img.classList.add("active");
    phEl.style.display  = "none";
    label.style.display = "block";
    phEl.classList.remove("arrival");
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "none");
    phEl.querySelector(".ph-text").style.display = "";
  } else if (isLast) {
    phEl.style.display  = "flex";
    label.style.display = "none";
    phEl.classList.add("arrival");
    phEl.querySelector(".ph-text").style.display = "none";
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "");
  } else {
    phEl.style.display  = "flex";
    label.style.display = "none";
    phEl.classList.remove("arrival");
    phEl.querySelectorAll(".arrival-icon,.arrival-title,.arrival-desc")
        .forEach(el => el.style.display = "none");
    phEl.querySelector(".ph-text").style.display = "";
  }
  updateDirectionArrow(step);
}

// ================================================================
// 方向矢印: ターン方向の計算
// step区間の画像(node[step] → node[step+1])を表示中に、
// node[step+1]到着時の進む方向を計算して矢印を更新する。
// ================================================================
function calcTurnDirection(step) {
  // pathCoords[step+2] が存在しない最終アプローチ区間は直進とみなす
  if (step >= pathCoords.length - 2) return "straight";

  const prev = pathCoords[step];
  const cur  = pathCoords[step + 1];
  const next = pathCoords[step + 2];

  // --- 屋外: 緯度経度から方位角を計算 ---
  if (prev.lat != null && cur.lat != null && next.lat != null) {
    const inBearing  = bearingDeg(prev.lat, prev.lng, cur.lat, cur.lng);
    const outBearing = bearingDeg(cur.lat, cur.lng, next.lat, next.lng);
    const turnDeg = ((outBearing - inBearing + 540) % 360) - 180;
    if (Math.abs(turnDeg) <= STRAIGHT_THRESHOLD_DEG) return "straight";
    return turnDeg > 0 ? "right" : "left";
  }

  // --- 屋内: SVG座標から角度を計算（Y軸は下向き正）---
  // エスカレータ・階段の遷移ノードは svg_x/svg_y が未設定の場合がある。
  // その場合は前後方向にスキャンして有効な座標を持つ最近傍ノードを使う。
  // 有効なノードが見つからなければ直進とみなす（階移動は直進がほぼ確実）。
  let prevIdx = step;
  while (prevIdx >= 0                  && pathCoords[prevIdx].svg_x == null) prevIdx--;
  let curIdx  = step + 1;
  while (curIdx  < pathCoords.length   && pathCoords[curIdx].svg_x  == null) curIdx++;
  let nextIdx = curIdx + 1;
  while (nextIdx < pathCoords.length   && pathCoords[nextIdx].svg_x == null) nextIdx++;

  if (prevIdx < 0 || curIdx >= pathCoords.length || nextIdx >= pathCoords.length) {
    return "straight";
  }

  const p = pathCoords[prevIdx];
  const c = pathCoords[curIdx];
  const n = pathCoords[nextIdx];

  // 異なるフロア・建物間ではSVG座標系が別物なので比較不能 → 直進とみなす
  if (p.building !== c.building || p.floor !== c.floor ||
      c.building !== n.building || c.floor !== n.floor) {
    return "straight";
  }

  const inAngle  = Math.atan2(c.svg_y - p.svg_y, c.svg_x - p.svg_x) * 180 / Math.PI;
  const outAngle = Math.atan2(n.svg_y - c.svg_y, n.svg_x - c.svg_x) * 180 / Math.PI;
  const turnDeg  = ((outAngle - inAngle + 540) % 360) - 180;

  // STRAIGHT_THRESHOLD_DEG 以内なら直進、それ以上は左右折
  if (Math.abs(turnDeg) <= STRAIGHT_THRESHOLD_DEG) return "straight";
  return turnDeg > 0 ? "right" : "left";
}

function updateDirectionArrow(step) {
  const arrowEl = document.getElementById("direction-arrow");
  const nearEl  = document.getElementById("near-goal-badge");
  if (!arrowEl) return;

  // 最終区間（目的地エッジを歩く区間）は矢印だと「まだ先へ進む」と誤解されるため、
  // 矢印の代わりに「目的地周辺です」バッジを表示する
  const isFinalSegment = step === pathCoords.length - 2;
  if (nearEl) nearEl.style.display = isFinalSegment ? "block" : "none";
  if (isFinalSegment) {
    arrowEl.style.display = "none";
    return;
  }

  // 画像が存在する区間でのみ矢印を表示
  const img = imgByStep[step];
  if (!img || step >= pathCoords.length - 1) {
    arrowEl.style.display = "none";
    return;
  }

  const dir = calcTurnDirection(step);
  if (!dir) {
    arrowEl.style.display = "none";
    return;
  }

  arrowEl.src = arrowBlobUrls[dir] || ARROW_URL[dir];
  arrowEl.style.display = "block";
}

// ================================================================
// Route image prefetch — ルート確定時に全画像を DOM に積む。
// HTTP キャッシュ設定に依存しない（同一 DOM 要素を使い回す）。
// ================================================================
function prefetchRouteImages(coords) {
  const container = document.getElementById("ar-cache");
  container.innerHTML = "";
  imgByStep = {};

  for (let i = 0; i < coords.length - 1; i++) {
    const url = edgeImages[`${coords[i].id}_${coords[i + 1].id}`];
    if (!url) continue;
    const img = document.createElement("img");
    img.className = "ar-cached-img";
    img.src = url;
    container.appendChild(img);
    imgByStep[i] = img;
  }
}

// ================================================================
// SVG prefetch — ルート上の全フロアのSVGをまとめて取得してメモリキャッシュ。
// オフライン時でも loadSvg がキャッシュから即座に返せるようにする。
// ================================================================
async function prefetchSvgs(coords) {
  const keys = new Set();
  coords.forEach(n => {
    if (n.building !== 0) keys.add(`${n.building}_${n.floor}`);
  });

  await Promise.allSettled([...keys].map(async key => {
    if (svgCache[key] !== undefined) return; // すでにキャッシュ済み
    const [building, floor] = key.split('_');
    try {
      const res = await fetch(`/svg/${building}_${floor}F.svg`);
      svgCache[key] = res.ok ? await res.text() : null;
    } catch {
      svgCache[key] = null;
    }
  }));
}

// ================================================================
// Route init
// ================================================================
async function initRoute(coords, edges) {
  pathCoords  = coords;
  pathEdges   = edges || [];
  currentStep = 0;
  svgBuilding = null;
  svgFloor    = null;
  svgOverlay  = null;
  arMarkersBuilt = false;
  arHideView();
  arPrefetchCameraIfNeeded();  // 屋外AR区間がある場合のみカメラを先取り
  clearMapOverlays();
  drawFullOutdoorRoute();
  prefetchRouteImages(coords);               // 写真: 並行ダウンロード開始（fire-and-forget）
  await prefetchSvgs(coords);               // SVG:  全フロア一括取得を待機してからナビ開始
  collapseSearchPanel();  // ルート確定後にパネルを収納
  goToStep(0, { announce: true });
}

function clearMapOverlays() {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];
  if (stepMarker) { stepMarker.setMap(null); stepMarker = null; }
}

function drawFullOutdoorRoute() {
  updateOutdoorPolylines(0);
}

function updateOutdoorPolylines(step) {
  outdoorPolylines.forEach(p => p.setMap(null));
  outdoorPolylines = [];

  let seg = [], segIdx = [];

  const flush = () => {
    if (seg.length < 2) { seg = []; segIdx = []; return; }

    let splitAt = -1;
    for (let i = segIdx.length - 1; i >= 0; i--) {
      if (segIdx[i] <= step) { splitAt = i; break; }
    }

    // 通過済み（グレー）
    if (splitAt > 0) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(0, splitAt + 1).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: "#9E9E9E", strokeOpacity: 0.5, strokeWeight: 5, geodesic: true, map,
      }));
    }

    // これから（青）。通過済み末尾ノードを共有して線を繋ぐ
    const aheadFrom = Math.max(0, splitAt);
    if (aheadFrom < seg.length - 1) {
      outdoorPolylines.push(new google.maps.Polyline({
        path: seg.slice(aheadFrom).map(n => ({ lat: n.lat, lng: n.lng })),
        strokeColor: ACCENT_COLOR, strokeOpacity: 0.85, strokeWeight: 5, geodesic: true, map,
      }));
    }

    seg = []; segIdx = [];
  };

  pathCoords.forEach((n, idx) => {
    if (n.building === 0 && n.lat != null) { seg.push(n); segIdx.push(idx); }
    else flush();
  });
  flush();
}

// ================================================================
// Step navigation
// ================================================================
// announce: trueの時だけ音声案内を読み上げる。前進(nextStep/ルート開始直後)のときのみ
// trueにする。戻る操作では「右に曲がってください」等が実際の進行方向と逆で誤りになるため読み上げない。
async function goToStep(step, { announce = false } = {}) {
  currentStep = step;
  const node  = pathCoords[step];
  updateNavBar(node, step, pathCoords.length);
  updateRouteImage(step);
  if (announce) speak(buildStepAnnouncement(step));
  if (!node) return;

  // 現在以降にARを使う屋外区間が残っていなければカメラ・GPSを解放する
  releaseArIfUnneeded(step);

  if (node.building === 0 && node.lat != null) {
    switchView("map");
    moveMapTo(node, step);
  } else if (node.building !== 0) {
    switchView("svg");
    if (node.building !== svgBuilding || node.floor !== svgFloor) {
      svgBuilding = node.building;
      svgFloor    = node.floor;
      await loadSvg(node.building, node.floor);
      drawSvgBaseRoute(node.building, node.floor);
    }
    renderSvgStep(step);
  }

  // Three.js AR のルートカラーを更新
  if (arMarkersBuilt) arUpdateRouteColors(step);

  // 最終ステップ（目的地エッジ上・「この辺です」表示区間）に到達したら
  // 一定時間後に完了モーダルを表示
  if (step === pathCoords.length - 2) {
    clearTimeout(window._completionTimer);
    window._completionTimer = setTimeout(showCompletionModal, 3000); // ← 秒数はここで調整（ミリ秒）
  } else {
    clearTimeout(window._completionTimer);
  }
}

// 最終ノード（画像のない到着ステップ）へは進まない。
// 目的地エッジを歩く「この辺です」区間（length-2）がナビの最終ステップ。
function prevStep() { if (currentStep > 0) goToStep(currentStep - 1); }
function nextStep() { if (currentStep < pathCoords.length - 2) goToStep(currentStep + 1, { announce: true }); }

// ================================================================
// 音声案内
//
// Web Speech API (SpeechSynthesis) をそのまま使う。バックエンドの変更は不要。
// 読み上げ文は「グライスの協調の原理」の4公理に沿うよう、以下の方針で組み立てる：
//   量:   そのステップで実際に必要な情報（曲がる方向・距離・エレベータ等の行き先階）だけを言う。
//         距離がANNOUNCE_DISTANCE_THRESHOLD_M未満など無意味なほど短い直進は何も言わない（言っても情報にならない）。
//   質:   実際のデータ（計算済みの距離・曲がる方向・ノードのfloor）にない内容は言わない。
//         教室名も、値がある場合のみ言う（無ければ言わない。それらしい名前を作らない）。
//   関係: 今のステップの行動に関係ない情報は省く。入口（type 7・距離0）の連結エッジは無音。
//         エレベータ/階段/エスカレータが複数の区間に分かれていても、同じ移動の途中は繰り返さない。
//   様態: 曖昧さを避け（「右」「左」を明言）、簡潔で、毎回同じ語順（方向→距離）で話す。
// ================================================================
let voiceGuideEnabled = localStorage.getItem("navi_voice_guide") === "1";

const VERTICAL_LABELS = { "2": "階段", "3": "エスカレーター", "4": "エレベーター", "5": "エスカレーター", "6": "エスカレーター" };
const ANNOUNCE_DISTANCE_THRESHOLD_M = 10; // これ未満の直進距離は案内しない（曲がる場合は距離を省いて方向だけ言う）

function updateVoiceToggleUI() {
  const btn = document.getElementById("voice-toggle-btn");
  if (!btn) return;
  btn.textContent = voiceGuideEnabled ? "\u{1F50A}" : "\u{1F507}"; // 🔊 / 🔇
  btn.classList.toggle("active", voiceGuideEnabled);
  btn.setAttribute("aria-pressed", String(voiceGuideEnabled));
}
updateVoiceToggleUI();

function toggleVoiceGuide() {
  voiceGuideEnabled = !voiceGuideEnabled;
  localStorage.setItem("navi_voice_guide", voiceGuideEnabled ? "1" : "0");
  updateVoiceToggleUI();
  if (!voiceGuideEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

function speak(text) {
  if (!voiceGuideEnabled || !text) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // 前の発話が残っていたら打ち切ってから話す（読み上げの重複防止）
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  window.speechSynthesis.speak(u);
}

/**
 * edge.right / edge.left（進行方向に対して右手・左手にある教室名、";"区切り）から
 * 「右手に101教室、左手に102教室があります」のような一言を組み立てる。
 * どちらも無ければ空文字（呼び出し側は従来通りの案内文にフォールバックする）。
 */
function buildSidePhrase(edge) {
  const r = (edge.right || "").split(";")[0].trim();
  const l = (edge.left  || "").split(";")[0].trim();
  if (r && l) return `右手に${r}、左手に${l}があります`;
  if (r) return `右手に${r}があります`;
  if (l) return `左手に${l}があります`;
  return "";
}

/**
 * pathCoords[step] → pathCoords[step+1] の区間（pathEdges[step]）についての案内文を組み立てる。
 * 階段/エレベータ/エスカレータは複数の区間にまたがることがあるため、同種の区間が連続する
 * 最初のステップでのみ「○階まで」を案内し、続きのステップでは何も言わない。
 */
function buildStepAnnouncement(step) {
  const edge = pathEdges[step];
  if (!edge) return "";
  const type = String(edge.type ?? "1");
  if (type === "7") return ""; // 屋内外の連結エッジ（距離0）は案内する内容が無い

  if (VERTICAL_LABELS[type]) {
    const prevType = step > 0 ? String(pathEdges[step - 1]?.type ?? "") : null;
    if (prevType === type) return ""; // 同じ階段/EV/ESCの続き番目のステップ：繰り返さない

    let end = step;
    while (end + 1 < pathEdges.length && String(pathEdges[end + 1]?.type ?? "") === type) end += 1;
    const fromFloor = pathCoords[step]?.floor;
    const toFloor   = pathCoords[end + 1]?.floor;
    const label = VERTICAL_LABELS[type];
    if (fromFloor == null || toFloor == null || fromFloor === toFloor) return `${label}で移動します`;
    return toFloor > fromFloor
      ? `${label}で${toFloor}階まで上がってください`
      : `${label}で${toFloor}階まで下りてください`;
  }

  // 最終区間（目的地エッジ上を歩く「この辺です」区間）
  if (step === pathCoords.length - 2) {
    const name = (edge.name || "").split(";")[0].trim();
    return name ? `まもなく到着します。${name}の付近です` : "まもなく目的地に到着します";
  }

  const dir  = calcTurnDirection(step);
  const dist = Math.round(edge.length || 0);
  const side = buildSidePhrase(edge); // right/leftが無ければ""（従来の運用のまま）

  if (dir === "right" || dir === "left") {
    const dirText = dir === "right" ? "右に曲がって" : "左に曲がって";
    const base = dist >= ANNOUNCE_DISTANCE_THRESHOLD_M ? `${dirText}${dist}メートル先です` : `${dirText}ください`;
    return side ? `${base}。${side}` : base;
  }
  if (dist >= ANNOUNCE_DISTANCE_THRESHOLD_M) {
    return side ? `${dist}メートル直進です。${side}` : `${dist}メートル直進です`;
  }
  // 距離が短い直進は従来省略していたが、右左に目印があるなら短くてもそれだけ案内する
  return side;
}

// ================================================================
// AR ハードウェア解放判定
// 屋外→屋内→屋外と続くルートの途中ではストリームを保持して
// シームレスに切り替え、屋外区間を使い切ったら解放する。
// （最終ステップは到着画面なので AR 不要とみなす）
// ================================================================
function releaseArIfUnneeded(step) {
  for (let i = step; i < pathCoords.length - 1; i++) {
    const n = pathCoords[i];
    if (n && n.building === 0 && n.lat != null) return; // まだARを使う
  }
  arReleaseHardware();
}

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

// ================================================================
// Google Maps — step marker + route-direction heading
// ================================================================
function moveMapTo(node, step) {
  const pos = { lat: node.lat, lng: node.lng };
  if (!stepMarker) {
    stepMarker = new google.maps.Marker({
      position: pos, map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE, scale: 10,
        fillColor: "#EF4444", fillOpacity: 1,
        strokeColor: "white", strokeWeight: 2,
      },
      zIndex: 10,
    });
  } else {
    stepMarker.setPosition(pos);
  }
  updateOutdoorPolylines(step);
  const heading = calcRouteHeading(step);
  if (heading != null) map.setHeading(heading);
  map.setCenter(pos);
  map.setZoom(17);
}

// ================================================================
// SVG — load floor plan
// ================================================================
async function loadSvg(building, floor) {
  document.getElementById("floor-badge").textContent = `${bldgLabel(building)} ${floor}階`;
  const container = document.getElementById("svg-container");
  svgOverlay = null;

  const key = `${building}_${floor}`;
  let text = svgCache[key]; // プリフェッチ済みキャッシュを優先使用

  if (text === undefined) {
    // キャッシュ未命中（フォールバック: ネットから取得を試みる）
    try {
      const res = await fetch(`/svg/${building}_${floor}F.svg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      svgCache[key] = text;
    } catch {
      svgCache[key] = null;
      text = null;
    }
  }

  if (!text) {
    container.innerHTML = `
      <div class="err-box">
        <div class="err-title">${bldgLabel(building)} ${floor}階のマップが見つかりません</div>
        <div class="err-desc">このフロアのSVGデータはまだ登録されていません。</div>
        <div class="err-hint">◀ ▶ で他のステップに進んでください</div>
      </div>`;
    return;
  }

  container.innerHTML = text;
  const svgEl = container.querySelector("svg");
  if (!svgEl) return;

  svgOrigViewBox = { width: svgEl.viewBox.baseVal.width, height: svgEl.viewBox.baseVal.height };
  svgEl.style.width    = "100%";
  svgEl.style.height   = "100%";
  svgEl.setAttribute("overflow", "visible");   // オーバーレイ要素がクリップされないように
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");

  svgOverlay = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svgOverlay.id = "route-overlay";
  svgOverlay.setAttribute("pointer-events", "none");
  svgEl.appendChild(svgOverlay);
}

// ================================================================
// SVG — base route (gray) + adaptive zoom
// ================================================================
function drawSvgBaseRoute(building, floor) {
  if (!svgOverlay) return;
  svgOverlay.innerHTML = "";

  const nodes = pathCoords.filter(n =>
    n.building === building && n.floor === floor && n.svg_x != null
  );

  const svgW = svgOrigViewBox?.width  || 2481;
  const svgH = svgOrigViewBox?.height || 1748;
  if (nodes.length >= 1) {
    const xs    = nodes.map(n => n.svg_x);
    const ys    = nodes.map(n => n.svg_y);
    const spanX = Math.max(Math.max(...xs) - Math.min(...xs), 50);
    const spanY = Math.max(Math.max(...ys) - Math.min(...ys), 50);
    svgViewW = Math.min(Math.max(spanX * 2.5, Math.min(900, svgW)), svgW);
    svgViewH = Math.min(Math.max(spanY * 2.5, Math.min(700, svgH)), svgH);
  } else {
    svgViewW = svgW;
    svgViewH = svgH;
  }

  if (nodes.length < 2) return;

  // 同じフロアを複数回通る場合に備え、pathCoords上で連続する区間ごとに
  // polyline を分割する。全ノードを1本に繋ぐと別訪問のノード間に
  // 不正な線が描画されてしまうため。
  const segments = [];
  let seg = [];
  for (const n of pathCoords) {
    if (n.building === building && n.floor === floor && n.svg_x != null) {
      seg.push(n);
    } else if (seg.length) {
      segments.push(seg);
      seg = [];
    }
  }
  if (seg.length) segments.push(seg);

  const sw = Math.round(svgViewW / 70);
  for (const s of segments) {
    if (s.length < 2) continue;
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points",          s.map(n => `${n.svg_x},${n.svg_y}`).join(" "));
    pl.setAttribute("stroke",          "#B0BEC5");
    pl.setAttribute("stroke-width",    sw);
    pl.setAttribute("fill",            "none");
    pl.setAttribute("stroke-linecap",  "round");
    pl.setAttribute("stroke-linejoin", "round");
    svgOverlay.appendChild(pl);
  }
}

// ================================================================
// SVG — current step highlight + direction arrow
// ================================================================
function renderSvgStep(step) {
  if (!svgOverlay) return;
  svgOverlay.querySelectorAll(".dyn").forEach(el => el.remove());

  const curNode = pathCoords[step];
  if (!curNode || curNode.building !== svgBuilding || curNode.floor !== svgFloor) return;

  // 現在ステップが属する「連続した同一フロア区間」だけを対象にする。
  // pathCoords.filter で全件取ると、同じフロアを複数回通るルートで
  // 別訪問のノードまで巻き込んで不正な線・ドットが描画される。
  let segStart = step, segEnd = step;
  while (segStart > 0 &&
         pathCoords[segStart - 1].building === svgBuilding &&
         pathCoords[segStart - 1].floor    === svgFloor) segStart--;
  while (segEnd < pathCoords.length - 1 &&
         pathCoords[segEnd + 1].building === svgBuilding &&
         pathCoords[segEnd + 1].floor    === svgFloor) segEnd++;

  const floorNodes  = pathCoords.slice(segStart, segEnd + 1).filter(n => n.svg_x != null);
  const curFloorIdx = floorNodes.findIndex(n => n.id === curNode.id);
  if (curFloorIdx < 0) return;

  const sz  = svgViewW / 1100;
  const sw  = Math.round(14 * sz);
  const rP  = Math.round(12 * sz);
  const rF  = Math.round(9  * sz);
  const rH  = Math.round(36 * sz);
  const aR  = Math.round(40 * sz);
  const aW  = Math.round(20 * sz);
  const aT  = Math.round(10 * sz);
  const aSW = Math.max(2, Math.round(3 * sz));

  // 通過済み部分はベースのグレーをそのまま見せる（done polyline は描かない）

  // 残り経路（現在地 → 終点）を青で上書き
  if (curFloorIdx < floorNodes.length - 1) {
    const ahead = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    ahead.classList.add("dyn");
    ahead.setAttribute("points",          floorNodes.slice(curFloorIdx).map(n => `${n.svg_x},${n.svg_y}`).join(" "));
    ahead.setAttribute("stroke",          ACCENT_COLOR);
    ahead.setAttribute("stroke-width",    sw);
    ahead.setAttribute("fill",            "none");
    ahead.setAttribute("stroke-linecap",  "round");
    ahead.setAttribute("stroke-linejoin", "round");
    svgOverlay.appendChild(ahead);
  }

  floorNodes.forEach((n, idx) => {
    if (idx === curFloorIdx) return;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.classList.add("dyn");
    c.setAttribute("cx", n.svg_x); c.setAttribute("cy", n.svg_y);
    if (idx < curFloorIdx) {
      // 通過済み: 小さいグレードット
      c.setAttribute("r", rF); c.setAttribute("fill", "#9E9E9E"); c.setAttribute("fill-opacity", "0.6");
    } else {
      // これから: 青ドット
      c.setAttribute("r", rF); c.setAttribute("fill", ACCENT_COLOR); c.setAttribute("fill-opacity", "0.75");
    }
    svgOverlay.appendChild(c);
  });

  const prevNode = curFloorIdx > 0 ? floorNodes[curFloorIdx - 1] : null;
  const nextNode = curFloorIdx < floorNodes.length - 1 ? floorNodes[curFloorIdx + 1] : null;
  let angle = 0;
  if (nextNode) {
    angle = Math.atan2(nextNode.svg_y - curNode.svg_y, nextNode.svg_x - curNode.svg_x) * 180 / Math.PI;
  } else if (prevNode) {
    angle = Math.atan2(curNode.svg_y - prevNode.svg_y, curNode.svg_x - prevNode.svg_x) * 180 / Math.PI;
  } else {
    // このフロアにsvg_xノードが1つだけ — ワールド座標で進行方向を推定
    // ワールド座標系↔SVG座標系の対応: SVG方向 = (world_dy, -world_dx)
    const ahead  = pathCoords.slice(step + 1).find(n => Math.abs(n.x - curNode.x) + Math.abs(n.y - curNode.y) > 0.01);
    const behind = [...pathCoords.slice(0, step)].reverse().find(n => Math.abs(n.x - curNode.x) + Math.abs(n.y - curNode.y) > 0.01);
    const ref = ahead || behind;
    if (ref) {
      const dx = ahead ? ref.x - curNode.x : curNode.x - ref.x;
      const dy = ahead ? ref.y - curNode.y : curNode.y - ref.y;
      angle = Math.atan2(-dx, dy) * 180 / Math.PI;
    }
  }

  // 最終到達点では方向矢印を出さない（現在地ハローのみ中心に表示）
  const isGoal = step >= pathCoords.length - 1;

  const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  halo.classList.add("dyn");
  const haloOffset = isGoal ? 0 : Math.round(12 * sz);
  const angleRad = angle * Math.PI / 180;
  halo.setAttribute("cx", curNode.svg_x + Math.round(Math.cos(angleRad) * haloOffset));
  halo.setAttribute("cy", curNode.svg_y + Math.round(Math.sin(angleRad) * haloOffset));
  halo.setAttribute("r", rH); halo.setAttribute("fill", "#32CD32"); halo.setAttribute("fill-opacity", "0.5");
  svgOverlay.appendChild(halo);

  if (!isGoal) {
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    arrow.classList.add("dyn");
    arrow.setAttribute("points", `0,${-aR} ${-aW},${aT} 0,${-Math.round(aR*0.2)} ${aW},${aT}`);
    arrow.setAttribute("fill",   "#EF4444");
    arrow.setAttribute("stroke", "white");
    arrow.setAttribute("stroke-width", aSW);
    arrow.setAttribute("stroke-linejoin", "round");
    arrow.setAttribute("transform", `translate(${curNode.svg_x},${curNode.svg_y}) rotate(${angle + 90})`);
    svgOverlay.appendChild(arrow);
  }

  if (svgOrigViewBox) panSvgTo(curNode.svg_x, curNode.svg_y);
}

// ================================================================
// SVG — pan viewBox to keep current node centered
// ================================================================
function panSvgTo(cx, cy) {
  const svgEl = document.querySelector("#svg-container svg");
  if (!svgEl || !svgOrigViewBox) return;
  const W = svgViewW, H = svgViewH;
  const x = Math.max(0, Math.min(cx - W / 2, svgOrigViewBox.width  - W));
  const y = Math.max(0, Math.min(cy - H / 2, svgOrigViewBox.height - H));
  svgEl.setAttribute("viewBox", `${x} ${y} ${W} ${H}`);
}

// ================================================================
// SVG — finger/mouse drag to pan + pinch/wheel zoom
// ================================================================
const SVG_MAX_ZOOM = 8;  // 原寸viewBoxに対する最大拡大倍率

let _svgPtrs    = new Map();  // pointerId → {x, y}
let _svgGesture = null;       // ジェスチャ開始時点の viewBox とポインタ位置

// ポインタの本数が変わるたびに基準を取り直す（1本=パン / 2本=ピンチ）
function _svgStartGesture(container) {
  if (_svgPtrs.size === 0) { _svgGesture = null; return; }
  const svgEl = container.querySelector("svg");
  if (!svgEl || !svgOrigViewBox) { _svgGesture = null; return; }
  const vb = svgEl.viewBox.baseVal;
  _svgGesture = {
    vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height,
    pts: [..._svgPtrs.values()].map(p => ({ ...p })),
  };
}

// viewBox を範囲内にクランプして適用し、以後のパン・ステップ移動が
// このズーム倍率を引き継ぐよう svgViewW/H も更新する
function _svgApplyView(svgEl, x, y, w, h) {
  const maxW = svgOrigViewBox.width, maxH = svgOrigViewBox.height;
  w = Math.max(maxW / SVG_MAX_ZOOM, Math.min(w, maxW));
  h = Math.max(maxH / SVG_MAX_ZOOM, Math.min(h, maxH));
  x = Math.max(0, Math.min(x, maxW - w));
  y = Math.max(0, Math.min(y, maxH - h));
  svgViewW = w;
  svgViewH = h;
  svgEl.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
}

// ズーム倍率fを、拡大しすぎ・縮小しすぎにならない範囲へクランプ
function _svgClampFactor(f, w, h) {
  const maxW = svgOrigViewBox.width, maxH = svgOrigViewBox.height;
  f = Math.min(f, maxW / w, maxH / h);
  f = Math.max(f, maxW / SVG_MAX_ZOOM / w, maxH / SVG_MAX_ZOOM / h);
  return f;
}

function initSvgPan() {
  const container = document.getElementById("svg-container");

  container.addEventListener("pointerdown", e => {
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;
    e.preventDefault();
    try { container.setPointerCapture(e.pointerId); } catch {}
    _svgPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    _svgStartGesture(container);
  });

  container.addEventListener("pointermove", e => {
    if (!_svgPtrs.has(e.pointerId) || !_svgGesture) return;
    _svgPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;

    const rect = container.getBoundingClientRect();
    const g    = _svgGesture;
    const pts  = [..._svgPtrs.values()];

    if (pts.length >= 2 && g.pts.length >= 2) {
      // ピンチ: 2本指の距離の比でズームし、指の中点にあった地点を維持する
      const d0 = Math.hypot(g.pts[0].x - g.pts[1].x, g.pts[0].y - g.pts[1].y);
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (d0 < 1 || d1 < 1) return;
      const f    = _svgClampFactor(d0 / d1, g.vbW, g.vbH);
      const newW = g.vbW * f;
      const newH = g.vbH * f;
      const m0x = (g.pts[0].x + g.pts[1].x) / 2, m0y = (g.pts[0].y + g.pts[1].y) / 2;
      const m1x = (pts[0].x + pts[1].x) / 2,     m1y = (pts[0].y + pts[1].y) / 2;
      // ジェスチャ開始時に中点の下にあったSVG座標
      const sx = g.vbX + (m0x - rect.left) * g.vbW / rect.width;
      const sy = g.vbY + (m0y - rect.top)  * g.vbH / rect.height;
      _svgApplyView(svgEl,
        sx - (m1x - rect.left) * newW / rect.width,
        sy - (m1y - rect.top)  * newH / rect.height,
        newW, newH);
    } else if (pts.length === 1 && g.pts.length === 1) {
      // 1本指: パン
      const dx = (pts[0].x - g.pts[0].x) * g.vbW / rect.width;
      const dy = (pts[0].y - g.pts[0].y) * g.vbH / rect.height;
      _svgApplyView(svgEl, g.vbX - dx, g.vbY - dy, g.vbW, g.vbH);
    }
  });

  const dropPointer = e => {
    if (!_svgPtrs.delete(e.pointerId)) return;
    _svgStartGesture(container);  // 残った指を基準にパンへ移行（0本ならnull）
  };
  container.addEventListener("pointerup",     dropPointer);
  container.addEventListener("pointercancel", dropPointer);

  // デスクトップ: ホイール／トラックパッドのピンチ(ctrl+wheel)でズーム
  container.addEventListener("wheel", e => {
    const svgEl = container.querySelector("svg");
    if (!svgEl || !svgOrigViewBox) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const vb   = svgEl.viewBox.baseVal;
    const f    = _svgClampFactor(Math.exp(e.deltaY * 0.002), vb.width, vb.height);
    const newW = vb.width * f;
    const newH = vb.height * f;
    // カーソル位置の下にある地点を維持してズーム
    const sx = vb.x + (e.clientX - rect.left) * vb.width  / rect.width;
    const sy = vb.y + (e.clientY - rect.top)  * vb.height / rect.height;
    _svgApplyView(svgEl,
      sx - (e.clientX - rect.left) * newW / rect.width,
      sy - (e.clientY - rect.top)  * newH / rect.height,
      newW, newH);
  }, { passive: false });
}

// 初期化
initSvgPan();

// プルトゥリフレッシュ防止（overscroll-behavior非対応ブラウザ向けフォールバック）
document.addEventListener("touchstart", e => {
  if (e.touches.length > 1) return; // ピンチ操作は許可
  if (e.touches[0].clientY <= 20) e.preventDefault(); // 画面最上部からのスワイプのみ阻止
}, { passive: false });
