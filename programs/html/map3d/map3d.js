// ================================================================
// 3Dキャンパスマップ（/map3d/）
// 経路探索API（programs/3D_Graph）の点・線のデータを読み、建物の各階を半透明の床として積み重ね、
// 通路・階段・エレベーター・屋外の道を3Dで描く。教室を2つ選ぶと、道順を光る線と動く点で見せる。
// データは読むだけで、APIやデータには何も書き込まない。
// ================================================================
"use strict";

const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";

// エッジ種別（docs/XYZ_Design.md）
const WALK_TYPES = new Set([1, 3, 5, 6]);
const VERTICAL_STYLE = {
  2: { color: 0x2FB36D, label: "階段" },
  3: { color: 0x9B51E0, label: "エスカレーター" },
  4: { color: 0x2F7FE0, label: "エレベーター" },
  5: { color: 0x9B51E0, label: "エスカレーター" },
  6: { color: 0x9B51E0, label: "エスカレーター" },
};
const TOILET_LABEL = { M_Toilet: "男子トイレ", F_Toilet: "女子トイレ", C_Toilet: "多目的トイレ" };
const COLOR = {
  corridor: 0xF2F5FA,
  outdoor: 0x9AA4B2,
  route: 0xFF6A00,
  start: 0x2FB36D,
  goal: 0xE5484D,
  ground: 0xA9C79A,
};
const FLOOR_PAD = 3;        // 床の板を、その階の点の範囲より何mはみ出させるか
const CORRIDOR_R = 0.45;    // 通路の太さ（半径m）

const $ = (id) => document.getElementById(id);

const state = {
  graph: null,            // /api/graph
  rooms: [],              // /api/all の rooms
  buildingNames: {},      // {建物番号: "10号館"}
  config: {},             // 建物ごとの座標変換（回転角 rot_deg を床の向きに使う）
  shownBuildings: new Set(),
  center: { x: 0, y: 0 },
  baseZ: 0,
  buildingBaseZ: {},
  spread: 1.8,
  focus: null,            // 寄っている建物（null = 全体）
  showLabels: true,
  route: null,            // { points: Vector3[], ... }
};

// ---------------------------------------------------------------- Three.js の準備
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xDCE7F2);
scene.fog = new THREE.Fog(0xDCE7F2, 700, 1800);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
camera.position.set(-160, 220, 260);

const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;   // 地面の下には回り込まない
controls.minDistance = 15;
controls.maxDistance = 900;
controls.autoRotateSpeed = 0.6;

scene.add(new THREE.HemisphereLight(0xFFFFFF, 0x6E7F66, 0.7));
const sun = new THREE.DirectionalLight(0xFFF6E8, 0.55);
sun.position.set(-200, 400, 150);
scene.add(sun);

const world = new THREE.Group();        // 建物・通路・屋外の道（階の間隔を変えたら作り直す）
const routeGroup = new THREE.Group();   // 道順
const labelGroup = new THREE.Group();   // 建物名・教室名
scene.add(world, routeGroup, labelGroup);

let walker = null;        // 道順の上を動く点
let walkerT = 0;
const clickTargets = [];  // タップで建物に寄るための、建物名の札

// ---------------------------------------------------------------- 座標
// データの x・y は東西南北に対して鏡写しになっている（docs/XYZ_Design.md の定義が「X: 山を登る方向、
// Y: X の右向き」で、上から見ると普通の地図と左右が逆になる）。屋外ノードの緯度経度と比べると、
// おおよそ「東 = -y」「北 = -x」になる。これを Three.js（x: 東, y: 上, z: 南）に直す。
//   Three.x = 東 = -y、Three.z = 南 = -北 = x
function sceneXZ(x, y) {
  return { x: -(y - state.center.y), z: x - state.center.x };
}

// データの向き（x・y の平面での角度 rad）を、Three.js の y 軸まわりの回転角に直す。
// データの向き (cos, sin) は sceneXZ で (-sin, cos) に移るので、それが +x になる回転角を求める
function sceneRotationY(dataAngle) {
  return Math.atan2(-Math.cos(dataAngle), -Math.sin(dataAngle));
}

// 建物の中は、その建物の一番低い点を基準に高さを spread 倍して、階の間を見やすく広げる。
function toScene(n) {
  const b = n.building;
  let up;
  if (b === 0 || !(b in state.buildingBaseZ)) {
    up = n.z - state.baseZ;
  } else {
    const base = state.buildingBaseZ[b];
    up = (base - state.baseZ) + (n.z - base) * state.spread;
  }
  const p = sceneXZ(n.x, n.y);
  return new THREE.Vector3(p.x, up, p.z);
}

function buildingColor(b) {
  const colors = state.graph.building_colors;
  return new THREE.Color(colors[b % colors.length]);
}

// ---------------------------------------------------------------- 文字の札（スプライト）
// fixed: true なら距離によらず画面上で同じ大きさ（size は画面の高さに対する割合）、false なら近いほど大きく見える（size はm）
function makeLabel(text, { size = 2.2, bg = "rgba(255,255,255,0.92)", fg = "#1C2333", bold = false, fixed = false } = {}) {
  const font = `${bold ? 800 : 600} 44px -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  const h = 64;
  c.width = w; c.height = h;
  ctx.font = font;
  ctx.fillStyle = bg;
  const r = 18;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 18, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.encoding = THREE.sRGBEncoding;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true, sizeAttenuation: !fixed,
  }));
  sprite.scale.set(size * w / h, size, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function roomLabelText(building, raw) {
  if (TOILET_LABEL[raw]) return TOILET_LABEL[raw];
  const hit = state.rooms.find(r => r.building === building && r.room === raw);
  return hit ? (hit.display || hit.room) : raw;
}

// ---------------------------------------------------------------- 形
function tubeBetween(a, b, radius, material) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 0.01) return null;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10, 1), material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  group.clear();
}

// ---------------------------------------------------------------- キャンパスを組み立てる
function buildWorld() {
  disposeGroup(world);
  disposeGroup(labelGroup);
  clickTargets.length = 0;

  const nodes = state.graph.nodes.filter(n => n.building === 0 || state.shownBuildings.has(n.building));
  const byId = new Map(nodes.map(n => [n.id, n]));

  // 地面（一番低い点より少し下）
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(700, 64),
    new THREE.MeshStandardMaterial({ color: COLOR.ground, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  world.add(ground);
  const grid = new THREE.GridHelper(1400, 70, 0xFFFFFF, 0xFFFFFF);
  grid.material.opacity = 0.18;
  grid.material.transparent = true;
  grid.position.y = -1.45;
  world.add(grid);

  // 各階の床の板（建物の向きにそろえた長方形）
  const floors = new Map();   // "建物_階" -> 点の一覧
  for (const n of nodes) {
    if (n.building === 0) continue;
    const key = `${n.building}_${n.floor}`;
    if (!floors.has(key)) floors.set(key, []);
    floors.get(key).push(n);
  }
  const buildingTop = {};     // 建物名の札を置く高さ
  const buildingCenter = {};
  for (const [key, list] of floors) {
    const b = list[0].building;
    const dimmed = state.focus !== null && state.focus !== b;
    const rot = ((state.config[String(b)] || {}).rot_deg || 0) * Math.PI / 180;
    const cos = Math.cos(-rot), sin = Math.sin(-rot);
    // 建物の向きに合わせた座標（データの x・y のまま）で範囲を求める
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const n of list) {
      const u = cos * n.x - sin * n.y, v = sin * n.x + cos * n.y;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
    const cx = Math.cos(rot) * cu - Math.sin(rot) * cv, cy = Math.sin(rot) * cu + Math.cos(rot) * cv;
    const zs = list.map(n => n.z).sort((p, q) => p - q);
    const floorZ = zs[Math.floor(zs.length / 2)];
    const p = toScene({ building: b, x: cx, y: cy, z: floorZ });
    const w = maxU - minU + FLOOR_PAD * 2, d = maxV - minV + FLOOR_PAD * 2;
    const color = buildingColor(b);
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.35, d),
      new THREE.MeshStandardMaterial({ color, transparent: true, opacity: dimmed ? 0.07 : 0.3, depthWrite: false }),
    );
    slab.position.set(p.x, p.y - 0.4, p.z);
    slab.rotation.y = sceneRotationY(rot);
    world.add(slab);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(slab.geometry),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: dimmed ? 0.12 : 0.65 }),
    );
    outline.position.copy(slab.position);
    outline.rotation.copy(slab.rotation);
    world.add(outline);
    buildingTop[b] = Math.max(buildingTop[b] ?? -Infinity, p.y);
    if (!buildingCenter[b]) buildingCenter[b] = { x: 0, z: 0, n: 0 };
    buildingCenter[b].x += p.x; buildingCenter[b].z += p.z; buildingCenter[b].n += 1;
  }

  // 通路・階段・エレベーター・屋外の道
  const mats = {
    corridor: new THREE.MeshStandardMaterial({ color: COLOR.corridor, emissive: 0x334455, emissiveIntensity: 0.12, roughness: 0.6 }),
    corridorDim: new THREE.MeshStandardMaterial({ color: COLOR.corridor, transparent: true, opacity: 0.25 }),
    outdoor: new THREE.MeshStandardMaterial({ color: COLOR.outdoor, roughness: 0.9 }),
  };
  const verticalMats = {};
  for (const e of state.graph.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const type = Number(e.type);
    const pa = toScene(a), pb = toScene(b);
    let mesh = null;
    if (a.building === 0 || b.building === 0 || type === 7) {
      mesh = tubeBetween(pa, pb, 0.7, mats.outdoor);
    } else if (VERTICAL_STYLE[type] && a.floor !== b.floor) {
      const dimmed = state.focus !== null && state.focus !== a.building;
      const key = `${type}_${dimmed}`;
      verticalMats[key] ??= new THREE.MeshStandardMaterial({
        color: VERTICAL_STYLE[type].color, emissive: VERTICAL_STYLE[type].color, emissiveIntensity: 0.25,
        transparent: dimmed, opacity: dimmed ? 0.2 : 1,
      });
      mesh = tubeBetween(pa, pb, 0.38, verticalMats[key]);
    } else if (WALK_TYPES.has(type) || a.floor === b.floor) {
      const dimmed = state.focus !== null && state.focus !== a.building;
      mesh = tubeBetween(pa, pb, CORRIDOR_R, dimmed ? mats.corridorDim : mats.corridor);
    }
    if (mesh) world.add(mesh);
  }

  // 建物名の札（タップでその建物に寄る）
  for (const b of state.shownBuildings) {
    const c = buildingCenter[b];
    if (!c) continue;
    const label = makeLabel(state.buildingNames[b] || `${b}号館`, {
      size: 0.045, fixed: true, bold: true, bg: `#${buildingColor(b).getHexString()}`, fg: "#FFFFFF",
    });
    label.position.set(c.x / c.n, buildingTop[b] + 12, c.z / c.n);
    label.userData.building = b;
    labelGroup.add(label);
    clickTargets.push(label);
  }

  // 教室名（寄っている建物だけ。全体表示では多すぎて読めないため）
  if (state.showLabels && state.focus !== null) {
    const seen = new Set();
    for (const e of state.graph.edges) {
      if (e.building !== state.focus) continue;
      const a = byId.get(e.from), b = byId.get(e.to);
      if (!a || !b || a.floor !== b.floor) continue;
      const names = [e.left, e.right, e.name].join(";").split(";").map(s => s.trim()).filter(Boolean);
      const mid = toScene(a).lerp(toScene(b), 0.5);
      names.forEach((raw, k) => {
        const key = `${a.floor}:${raw}`;
        if (seen.has(key)) return;   // 同じ階の同じ教室は1回だけ
        seen.add(key);
        const label = makeLabel(roomLabelText(e.building, raw), { size: 1.5 });
        label.position.set(mid.x, mid.y + 1.6 + k * 1.7, mid.z);
        labelGroup.add(label);
      });
    }
  }
}

// ---------------------------------------------------------------- 道順
function clearRoute() {
  disposeGroup(routeGroup);
  walker = null;
  state.route = null;
}

function drawRoute(pathCoords) {
  clearRoute();
  const points = pathCoords.map(toScene);
  if (points.length < 2) return;
  const path = new THREE.CurvePath();
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i].clone().add(new THREE.Vector3(0, 0.9, 0));
    const b = points[i + 1].clone().add(new THREE.Vector3(0, 0.9, 0));
    if (a.distanceTo(b) > 0.01) path.add(new THREE.LineCurve3(a, b));
  }
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(path, Math.max(64, points.length * 12), 0.75, 10, false),
    new THREE.MeshBasicMaterial({ color: COLOR.route }),   // 光の当たり方で色が薄くならないよう、照明の影響を受けない素材にする
  );
  routeGroup.add(tube);

  const start = new THREE.Mesh(new THREE.SphereGeometry(1.8, 24, 16),
    new THREE.MeshStandardMaterial({ color: COLOR.start, emissive: COLOR.start, emissiveIntensity: 0.4 }));
  start.position.copy(points[0]).add(new THREE.Vector3(0, 1.8, 0));
  const goal = new THREE.Mesh(new THREE.ConeGeometry(1.8, 5, 24),
    new THREE.MeshStandardMaterial({ color: COLOR.goal, emissive: COLOR.goal, emissiveIntensity: 0.4 }));
  goal.rotation.x = Math.PI;   // 下向きの目印
  goal.position.copy(points[points.length - 1]).add(new THREE.Vector3(0, 4.5, 0));
  routeGroup.add(start, goal);

  walker = new THREE.Mesh(new THREE.SphereGeometry(1.1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xFFFFFF }));
  walker.userData.path = path;
  routeGroup.add(walker);
  walkerT = 0;

  state.route = { pathCoords, points };
  fitTo(points, 1.25);
}

function summarizeRoute(res) {
  const length = (res.path_edges || []).reduce((sum, e) => sum + (Number(e.length) || 0), 0);
  const coords = res.path_coords;
  const buildings = [];
  for (const n of coords) {
    const label = n.building === 0 ? "屋外" : (state.buildingNames[n.building] || `${n.building}号館`);
    if (buildings[buildings.length - 1] !== label) buildings.push(label);
  }
  let floorChanges = 0;
  for (let i = 1; i < coords.length; i++) {
    if (coords[i].building === coords[i - 1].building && coords[i].building !== 0 && coords[i].floor !== coords[i - 1].floor) floorChanges++;
  }
  const minutes = Math.max(1, Math.round(length / 70 + floorChanges * 0.3));   // 歩く速さ 約70m/分
  return `約${Math.round(length)}m・徒歩約${minutes}分　${buildings.join(" → ")}`;
}

async function searchRoute(fromValue, toValue, useElevator) {
  const [fromB, fromRoom] = fromValue.split("|");
  const [toB, toRoom] = toValue.split("|");
  const params = new URLSearchParams({
    from_room: fromRoom, from_building: fromB, to_room: toRoom, to_building: toB, use_elevator: useElevator ? "1" : "0",
  });
  setStatus("道順を探しています…");
  try {
    const res = await fetch(`${API_BASE}/api/route?${params}`).then(r => r.json());
    if (res.error) { setStatus(res.error, true); return; }
    // 道順が通る建物に、まだ表示していない建物があれば（位置が未設定など）、その区間は描けない
    drawRoute(res.path_coords.filter(n => n.building === 0 || state.shownBuildings.has(n.building)));
    const summary = $("route-summary");
    summary.textContent = summarizeRoute(res);
    summary.hidden = false;
    setStatus("ドラッグで回して、道順を見てください", false, 2500);
  } catch {
    setStatus("経路探索サーバーに接続できませんでした", true);
  }
}

// ---------------------------------------------------------------- カメラ
let flight = null;

function flyTo(target, position, duration = 900) {
  flight = {
    fromTarget: controls.target.clone(), toTarget: target,
    fromPos: camera.position.clone(), toPos: position,
    start: performance.now(), duration,
  };
}

function fitTo(points, margin = 1.3) {
  const box = new THREE.Box3().setFromPoints(points);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, size.y * 1.5, 30) * margin;
  const dir = new THREE.Vector3(-0.55, 0.75, 0.9).normalize();
  flyTo(center, center.clone().addScaledVector(dir, radius));
}

function focusBuilding(b) {
  state.focus = b;
  document.querySelectorAll(".chip").forEach(chip => chip.classList.toggle("active", chip.dataset.building === String(b ?? "all")));
  buildWorld();
  const nodes = state.graph.nodes.filter(n => (b === null ? state.shownBuildings.has(n.building) || n.building === 0 : n.building === b));
  fitTo(nodes.map(toScene), b === null ? 1.0 : 1.6);
}

// ---------------------------------------------------------------- 画面
let statusTimer = null;
function setStatus(text, isError = false, hideAfter = 0) {
  const el = $("status");
  el.textContent = text;
  el.style.background = isError ? "rgba(200, 50, 50, 0.9)" : "";
  el.classList.remove("hidden");
  clearTimeout(statusTimer);
  if (hideAfter) statusTimer = setTimeout(() => el.classList.add("hidden"), hideAfter);
}

function fillRoomSelects() {
  const byBuilding = new Map();
  for (const r of state.rooms) {
    if (!state.shownBuildings.has(r.building)) continue;
    if (!byBuilding.has(r.building)) byBuilding.set(r.building, []);
    byBuilding.get(r.building).push(r);
  }
  const collator = new Intl.Collator("ja", { numeric: true });
  for (const select of [$("from-room"), $("to-room")]) {
    for (const b of [...byBuilding.keys()].sort((p, q) => p - q)) {
      const group = document.createElement("optgroup");
      group.label = state.buildingNames[b] || `${b}号館`;
      for (const r of byBuilding.get(b).sort((p, q) => collator.compare(p.display || p.room, q.display || q.room))) {
        const opt = document.createElement("option");
        opt.value = `${b}|${r.room}`;
        opt.textContent = r.display || r.room;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  }
}

function fillBuildingChips() {
  const wrap = $("building-chips");
  const make = (value, text, color) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (value === "all" ? " active" : "");
    chip.dataset.building = value;
    if (color) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      chip.appendChild(dot);
    }
    chip.appendChild(document.createTextNode(text));
    chip.addEventListener("click", () => focusBuilding(value === "all" ? null : Number(value)));
    wrap.appendChild(chip);
  };
  make("all", "全体");
  for (const b of [...state.shownBuildings].sort((p, q) => p - q)) {
    make(String(b), state.buildingNames[b] || `${b}号館`, `#${buildingColor(b).getHexString()}`);
  }
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// 建物名の札をタップしたら、その建物に寄る（ドラッグとは区別する）
const raycaster = new THREE.Raycaster();
let pointerDown = null;
canvas.addEventListener("pointerdown", e => { pointerDown = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("pointerup", e => {
  if (!pointerDown || Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 6) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(clickTargets)[0];
  if (hit) focusBuilding(hit.object.userData.building);
});

function animate(now) {
  requestAnimationFrame(animate);
  if (flight) {
    const t = Math.min(1, (now - flight.start) / flight.duration);
    const k = 1 - Math.pow(1 - t, 3);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
    if (t >= 1) flight = null;
  }
  if (walker) {
    const path = walker.userData.path;
    const speed = 22 / Math.max(path.getLength(), 1);   // 約22m/秒で道順をなぞる
    walkerT = (walkerT + speed / 60) % 1;
    walker.position.copy(path.getPointAt(walkerT));
  }
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- 起動
async function init() {
  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(animate);

  $("panel-toggle").addEventListener("click", () => {
    const panel = $("panel");
    const collapsed = panel.classList.toggle("collapsed");
    $("panel-toggle").textContent = collapsed ? "開く" : "閉じる";
    $("panel-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  if (window.innerWidth < 600) $("panel-toggle").click();   // スマホでは最初は畳んで3Dを広く見せる

  let graph, all;
  try {
    [graph, all] = await Promise.all([
      fetch(`${API_BASE}/api/graph`).then(r => r.json()),
      fetch(`${API_BASE}/api/all`).then(r => r.json()),
    ]);
  } catch {
    setStatus("経路探索サーバーに接続できませんでした", true);
    return;
  }
  state.graph = graph;
  state.config = graph.config || {};
  state.rooms = all.rooms || [];
  for (const b of all.buildings || []) state.buildingNames[Number(b.id)] = b.display_name;

  // 位置合わせ（anchors.csv など）が設定されている建物だけを表示する。未設定の建物は座標が原点付近に
  // 重なってしまい、ほかの建物と同じ場所に描かれるため
  const unplaced = new Set();
  for (const n of graph.nodes) {
    if (n.building === 0) continue;
    if (String(n.building) in state.config) state.shownBuildings.add(n.building);
    else unplaced.add(n.building);
  }
  const shownNodes = graph.nodes.filter(n => n.building === 0 || state.shownBuildings.has(n.building));
  state.center.x = shownNodes.reduce((s, n) => s + n.x, 0) / shownNodes.length;
  state.center.y = shownNodes.reduce((s, n) => s + n.y, 0) / shownNodes.length;
  state.baseZ = Math.min(...shownNodes.map(n => n.z));
  for (const n of shownNodes) {
    if (n.building === 0) continue;
    state.buildingBaseZ[n.building] = Math.min(state.buildingBaseZ[n.building] ?? Infinity, n.z);
  }

  fillRoomSelects();
  fillBuildingChips();
  buildWorld();
  fitTo(shownNodes.map(toScene), 1.0);
  const note = unplaced.size ? `（${[...unplaced].map(b => state.buildingNames[b] || `${b}号館`).join("・")}は位置が未設定のため表示していません）` : "";
  setStatus(`読み込みました${note}`, false, note ? 6000 : 2000);

  $("route-form").addEventListener("submit", e => {
    e.preventDefault();
    const from = $("from-room").value, to = $("to-room").value;
    if (!from || !to) return;
    if (from === to) { setStatus("出発と目的地が同じです", true, 2500); return; }
    searchRoute(from, to, $("use-elevator").checked);
  });
  $("spread").addEventListener("input", e => {
    state.spread = Number(e.target.value);
    buildWorld();
    if (state.route) drawRoute(state.route.pathCoords);
  });
  $("show-labels").addEventListener("change", e => { state.showLabels = e.target.checked; buildWorld(); });
  $("auto-rotate").addEventListener("change", e => { controls.autoRotate = e.target.checked; });

  // ナビ画面と同じURLの形（?from=101&from_bldg=10&to=225&to_bldg=2）で開いたら、すぐ道順を出す
  const q = new URLSearchParams(location.search);
  if (q.get("from") && q.get("to")) {
    const pick = (room, bldg) => {
      const hit = state.rooms.find(r => (r.room === room || r.display === room) && (!bldg || String(r.building) === bldg));
      return hit ? `${hit.building}|${hit.room}` : "";
    };
    const from = pick(q.get("from"), q.get("from_bldg")), to = pick(q.get("to"), q.get("to_bldg"));
    if (from && to) {
      $("from-room").value = from;
      $("to-room").value = to;
      searchRoute(from, to, q.get("elevator") !== "0");
    }
  }
}

init();
