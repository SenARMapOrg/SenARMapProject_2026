// ================================================================
// floormap.js
// 屋内のSVGフロアマップ表示と、パン/ピンチズーム操作。
// ================================================================

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
