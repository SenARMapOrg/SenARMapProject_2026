// ================================================================
// photo.js
// AR領域の経路写真と、進行方向の矢印。
// ================================================================

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
  if (nearEl) {
    nearEl.style.display = isFinalSegment ? "block" : "none";
    if (isFinalSegment) nearEl.textContent = buildNearGoalText(pathEdges[step]);
  }
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
