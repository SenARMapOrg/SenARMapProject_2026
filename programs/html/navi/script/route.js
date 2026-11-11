// ================================================================
// route.js
// ルート検索の実行と、ステップ送り（ナビゲーションの中心）。
// ================================================================

// ================================================================
// Search
// ================================================================
// restore: URL から自動で検索したとき（data.js の applyUrlParams）に渡す。startStep のステップから始める
async function doSearch(restore = {}) {
  arPreloadThree();
  const params = new URLSearchParams();
  const useElevator = document.getElementById("use-elevator").checked;
  params.set("use_elevator", useElevator ? "1" : "0");
  // 再読み込みしても同じ検索をし直せるよう、URL に書き込む条件（data.js の saveSearchToUrl）
  const pageParams = new URLSearchParams();
  if (useElevator) pageParams.set("elevator", "1");
  if (isStepFree("step-free")) {
    params.set("step_free", "1");
    pageParams.set("step_free", "1");
  }
  // 鳳祭の案内人数集計に記録する出発地・目的地の表示名（track.js 参照）
  let fromLabel = "";
  let toLabel   = "";

  if (searchMode === "room") {
    const fromInfo = resolveRoom("from-input", "from-bldg");
    const toInfo   = resolveRoom("to-input",   "to-bldg");
    if (!fromInfo)              { alert("出発教室を入力してください。"); return; }
    if (fromInfo === "ambiguous") { alert("出発教室が複数の号館に存在します。号館を指定してください。"); return; }
    if (!toInfo)                { alert("目的教室を入力してください。"); return; }
    if (toInfo   === "ambiguous") { alert("目的教室が複数の号館に存在します。号館を指定してください。"); return; }
    fromLabel = fromInfo.display || fromInfo.room;
    toLabel   = toInfo.display   || toInfo.room;
    setPlaceUrlParam(pageParams, "from", fromInfo);
    setPlaceUrlParam(pageParams, "to",   toInfo);
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
    fromLabel = "現在地";
    toLabel   = toInfo.display || toInfo.room;
    // 現在地は URL に残さない（再読み込みしたら、目的地が入った状態で位置の取得からやり直す）
    pageParams.set("mode", "gps");
    setPlaceUrlParam(pageParams, "to", toInfo);
    if (toInfo.isEvent) {
      params.set("to_event", toInfo.room);
    } else {
      params.set("to_room",     toInfo.room);
      params.set("to_building", toInfo.building);
    }
  }

  await fetchRouteAndNavigate(`${API_BASE}/api/route?${params}`, fromLabel, toLabel, pageParams, restore);
}

function setLoading(on) {
  document.getElementById("loading").classList.toggle("show", on);
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
// startStep: 最初に出すステップ（再読み込みで途中から続けるとき。範囲外なら最後のステップにする）
async function initRoute(coords, edges, destInfo = {}, startStep = 0) {
  pathCoords  = coords;
  pathEdges   = edges || [];
  destSide          = destInfo.side || "";
  destPosition       = destInfo.position ?? null;
  destCount          = destInfo.count ?? null;
  destDisplay        = destInfo.display || "";
  destNearestDisplay = destInfo.nearestDisplay || "";
  currentStep = 0;
  svgBuilding = null;
  svgFloor    = null;
  svgOverlay  = null;
  arMarkersBuilt = false;
  arResetAutoAdvance();
  arHideView();
  arPrefetchCameraIfNeeded();  // 屋外AR区間がある場合のみカメラを先取り
  clearMapOverlays();
  drawFullOutdoorRoute();
  prefetchRouteImages(coords);               // 写真: 並行ダウンロード開始（fire-and-forget）
  await prefetchSvgs(coords);               // SVG:  全フロア一括取得を待機してからナビ開始
  collapseSearchPanel();  // ルート確定後にパネルを収納
  goToStep(Math.min(Math.max(startStep, 0), Math.max(coords.length - 2, 0)), { announce: true });
}

// ================================================================
// Step navigation
// ================================================================
// announce: trueの時だけ音声案内を読み上げる。前進(nextStep/ルート開始直後)のときのみ
// trueにする。戻る操作では「右に曲がってください」等が実際の進行方向と逆で誤りになるため読み上げない。
async function goToStep(step, { announce = false } = {}) {
  currentStep = step;
  saveStepToUrl(step);  // 再読み込みしても同じステップから続けられるように
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
// ボタンで動かしたときは、屋外の自動送り（ar.js）をしばらく止める（戻した直後に勝手に進み直さないように）
function prevStep() {
  if (currentStep > 0) { arPauseAutoAdvance(); goToStep(currentStep - 1); }
}
function nextStep() {
  if (currentStep < pathCoords.length - 2) { arPauseAutoAdvance(); goToStep(currentStep + 1, { announce: true }); }
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
