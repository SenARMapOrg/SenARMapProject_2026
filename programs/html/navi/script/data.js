// ================================================================
// data.js
// 起動時のデータ取得（教室・ノード・画像・食堂・その他の設備・イベント）とURLパラメータによる検索プリセット。
// ================================================================

// ================================================================
// Data loading
// ================================================================
async function loadAllData() {
  prefetchArrowImages(); // ページ読み込み時に矢印画像を事前取得（fire-and-forget）
  try {
    const [dataRes, imgRes, cafRes, facRes, evRes] = await Promise.all([
      fetch(`${API_BASE}/api/all`),
      fetch(`${API_BASE}/api/edge_images`),
      fetch(`${API_BASE}/api/cafeterias`),
      fetch(`${API_BASE}/api/facilities`).catch(() => null),
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
//   &mode=gps                             → 現在地(屋外)タブで目的地入力済み
//   ?to_event=<id>・?from_event=<id>      → イベント設定で付けた id で展示を呼び出す（展示名が入る。
//                                            イベントモードも自動で有効。id の代わりに展示名でもよい）
// 号館(_bldg)は教室名が1つの号館にしか無い場合は省略可
// ================================================================

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
  if (!to && !from) return;

  // 展示は建物で絞らずに名前だけで決まるので、号館は展示の号館を入れる
  const toBldg   = toEvent   ? String(toEvent.building)   : q.get("to_bldg")   || q.get("to_building")   || "";
  const fromBldg = fromEvent ? String(fromEvent.building) : q.get("from_bldg") || q.get("from_building") || "";

  // select は該当 option がある場合のみ反映（API未取得時は空のまま）
  const setSelect = (id, val) => {
    const sel = document.getElementById(id);
    if (!sel || !val) return;
    if ([...sel.options].some(o => o.value === val)) sel.value = val;
  };

  setCategory("room");
  // 「エレベーターを使う」ははじめはオフ。?elevator=1 でオンにして開ける（?elevator=0 は前と同じくオフ）
  if (q.get("elevator") === "1") document.getElementById("use-elevator").checked = true;
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
