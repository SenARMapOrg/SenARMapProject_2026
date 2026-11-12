// ================================================================
// data.js
// 起動時のデータ取得（教室・ノード・画像・食堂・その他の設備・イベント）とURLパラメータによる検索プリセット。
// ================================================================

// ================================================================
// Data loading
// ================================================================
async function loadAllData() {
  prefetchArrowImages(); // ページ読み込み時に矢印画像を事前取得（fire-and-forget）
  ikunaviPreload();      // 経路計算（shared/api-client.js）の準備を先に始め、最初の検索を待たせない
  try {
    const [dataRes, imgRes, cafRes, facRes, evRes] = await Promise.all([
      ikunaviFetch("/api/all"),
      ikunaviFetch("/api/edge_images"),
      ikunaviFetch("/api/cafeterias"),
      ikunaviFetch("/api/facilities").catch(() => null),
      EVENT_MODE ? ikunaviFetch("/api/events") : Promise.resolve(null),
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
        room: ev.title, display: ev.title, building: ev.building, isEvent: true, eventId: ev.id || "",
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
    initOtherFacilities(facRes && facRes.ok ? await facRes.json() : []);
  } catch {
    console.warn("API unavailable — room autocomplete disabled");
  }
  applyUrlParams();
}

// その他の設備（facility.csv。コンビニ・教務課など）の種類を「探す」の選択肢に入れる。
// 同じ種類が複数あっても選択肢は1つ（検索ではその中で一番近いものへ案内する）。
// 1件も登録されていなければ「その他」自体を出さない。
function initOtherFacilities(facilities) {
  const categories = [...new Set(facilities.map(f => f.category).filter(Boolean))];
  if (!categories.length) {
    document.querySelector('#fac-category option[value="other"]')?.remove();
    return;
  }
  const sel = document.getElementById("fac-other-name");
  categories.forEach(c => {
    const opt = document.createElement("option");
    opt.value       = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}

// Google Maps の読み込み完了（initMap）を待たず、ページ読み込み直後に教室一覧を取得する。
// loadAllData は google.maps を一切参照しないため、Mapsの初期化と切り離して問題ない。
loadAllData();

// ================================================================
// URL パラメータからの検索プリセット（イベント誘導・QRコード用）
//   ?to=131&to_bldg=1                     → 目的地だけ入力済みの状態で開く
//   ?from=101A&from_bldg=10&to=131&to_bldg=1 → 自動でルート検索して表示
//   &elevator=0                           → エレベーター不使用
//   &step_free=1                          → 階段・エスカレーターを使わない（エレベーターは必ず使う）
//   &mode=gps                             → 現在地(屋外)タブで目的地入力済み
//   ?to_event=<id>・?from_event=<id>      → イベント設定で付けた id で展示を呼び出す（展示名が入る。
//                                            イベントモードも自動で有効。id の代わりに展示名でもよい）
//   ?fac=toilet&fac_type=<種類>             → 「施設を探す」（トイレ）。食堂は fac=cafeteria&fac_name=<名前>、
//                                            その他の設備は fac=other&fac_category=<種類>。出発地は from と同じ
//   &step=<n>                             → 経路を出したあと、n 番目のステップから始める
// 号館(_bldg)は教室名が1つの号館にしか無い場合は省略可
//
// 検索するたびに、その条件をこの形で URL に書き込む（saveSearchToUrl。ページは読み込み直さない）。
// 再読み込みしても、同じ経路の同じステップから続けられる。
// ================================================================

// 検索条件として URL に書き込むキー。これ以外（ref・event など）は書き込むときも残す
const NAV_URL_KEYS = [
  "from", "from_bldg", "from_building", "from_event", "to", "to_bldg", "to_building", "to_event",
  "elevator", "step_free", "mode", "step", "fac", "fac_type", "fac_name", "fac_category",
];

/** 教室・展示を URL の値にする（prefix は "from" か "to"） */
function setPlaceUrlParam(params, prefix, info) {
  if (info.isEvent) {
    params.set(`${prefix}_event`, info.eventId || info.room);
  } else {
    params.set(prefix, info.room);
    params.set(`${prefix}_bldg`, String(info.building));
  }
}

function replaceUrlQuery(q) {
  const query = q.toString();
  try {
    history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash);
  } catch { /* URL を書き換えられなくても案内は続ける */ }
}

/** 検索が成功したときに、その条件を URL に書き込む（履歴は増やさない） */
function saveSearchToUrl(searchParams) {
  if (!searchParams) return;
  const q = new URLSearchParams(location.search);
  NAV_URL_KEYS.forEach(k => q.delete(k));
  searchParams.forEach((v, k) => q.set(k, v));
  replaceUrlQuery(q);
}

/** ステップを動かすたびに、今のステップを URL に書き込む（最初のステップのときは付けない） */
function saveStepToUrl(step) {
  const q = new URLSearchParams(location.search);
  if (step > 0) q.set("step", String(step));
  else q.delete("step");
  replaceUrlQuery(q);
}

/** ページを再読み込みして開いたか（再読み込みで同じ検索をし直したときは、案内人数に数え直さない） */
function pageWasReloaded() {
  try {
    return performance.getEntriesByType("navigation")[0]?.type === "reload";
  } catch {
    return false;
  }
}

// select は該当 option がある場合のみ反映（API未取得時は空のまま）
function setSelectIfOption(id, val) {
  const sel = document.getElementById(id);
  if (!sel || !val) return;
  if ([...sel.options].some(o => o.value === val)) sel.value = val;
}

/** event.csv の id（または展示名）→ 展示。見つからなければ null */
function findEventByIdOrTitle(value) {
  if (!value) return null;
  const events = allRooms.filter(r => r.isEvent);
  return events.find(r => r.eventId && r.eventId === value)
    || events.find(r => r.room === value) || null;
}

function applyUrlParams() {
  const q    = new URLSearchParams(location.search);
  const toEvent   = findEventByIdOrTitle(q.get("to_event"));
  const fromEvent = findEventByIdOrTitle(q.get("from_event"));
  const to   = toEvent?.room   || q.get("to");
  const from = fromEvent?.room || q.get("from");

  // 展示は建物で絞らずに名前だけで決まるので、号館は展示の号館を入れる
  const toBldg   = toEvent   ? String(toEvent.building)   : q.get("to_bldg")   || q.get("to_building")   || "";
  const fromBldg = fromEvent ? String(fromEvent.building) : q.get("from_bldg") || q.get("from_building") || "";
  // 自動で検索するときに渡す。step があればそのステップから始める
  const restore = { startStep: Math.max(0, parseInt(q.get("step"), 10) || 0), fromUrl: true };

  if (q.get("fac")) { applyFacilityUrlParams(q, from, fromBldg, restore); return; }
  if (!to && !from) return;
  const setSelect = setSelectIfOption;

  setCategory("room");
  // 「エレベーターを使う」ははじめはオフ。?elevator=1 でオンにして開ける（?elevator=0 は前と同じくオフ）
  if (q.get("elevator") === "1") document.getElementById("use-elevator").checked = true;
  if (q.get("elevator") === "0") document.getElementById("use-elevator").checked = false;
  if (q.get("step_free") === "1") setStepFree("step-free", true);

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
    doSearch(restore);
    return;
  }

  // 目的地だけ確定 → 出発教室の入力を促す
  if (to && !from) {
    document.getElementById("step-label").textContent = "出発教室を入力してルート検索してください";
    document.getElementById("step-count").textContent =
      toInfo && toInfo !== "ambiguous" ? `目的地: ${bldgLabel(toInfo.building)} ${toInfo.display}` : `目的地: ${to}`;
  }
}

// 「施設を探す」の URL（?fac=...）。出発教室が決まれば自動で検索し、現在地のときは位置の取得を待つ
function applyFacilityUrlParams(q, from, fromBldg, restore) {
  const cat = q.get("fac");
  const sub = {
    toilet:    ["fac-toilet-type",    "fac_type"],
    cafeteria: ["fac-cafeteria-name", "fac_name"],
    other:     ["fac-other-name",     "fac_category"],
  }[cat];
  if (!sub) return;
  setCategory("facility");
  setSelectIfOption("fac-category", cat);
  onFacCategoryChange();
  setSelectIfOption(sub[0], q.get(sub[1]));
  if (q.get("elevator") === "1") document.getElementById("fac-use-elevator").checked = true;
  if (q.get("step_free") === "1") setStepFree("fac-step-free", true);

  if (q.get("mode") === "gps") { setFacMode("gps"); return; }
  setFacMode("room");
  if (!from) return;
  document.getElementById("fac-from-input").value = from;
  setSelectIfOption("fac-from-bldg", fromBldg);
  const fromInfo = resolveRoom("fac-from-input", "fac-from-bldg");
  if (!fromInfo || fromInfo === "ambiguous") return;
  setSelectIfOption("fac-from-bldg", String(fromInfo.building));
  // 選んだ種類が選択肢に無い（データから消えた）ときは、別のものを勝手に探さない
  if (document.getElementById(sub[0]).value !== q.get(sub[1])) return;
  doFacSearch(restore);
}

function bldgLabel(b) {
  return buildingNames[Number(b)] || (Number(b) === 0 ? "屋外" : `${b}号館`);
}

// 階の表示名。経路データでは地下1階を 0、地下2階を -1 …と整数で持っている
// （SVG のファイル名も 7_0F.svg のように同じ値を使う）ので、表示と読み上げのときだけ「地下◯階」に直す。
function floorLabel(floor) {
  const f = Number(floor);
  if (!Number.isFinite(f)) return `${floor}階`;
  return f <= 0 ? `地下${1 - f}階` : `${f}階`;
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
