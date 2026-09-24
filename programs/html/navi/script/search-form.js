// ================================================================
// search-form.js
// 検索フォーム（オートコンプリート・教室/設備の切り替え・検索パネルの開閉）。
// ================================================================

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
    await initRoute(data.path_coords, data.path_edges, {
      side: data.dest_side, position: data.dest_position, count: data.dest_count,
      display: data.dest_display, nearestDisplay: data.dest_nearest_display,
    });
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
