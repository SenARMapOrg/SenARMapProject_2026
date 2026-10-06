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
// 床の形（computeFloorOutline）の決め方
const FLOOR_CELL = 1;          // 形を計算するマス目の大きさ（m）
const FLOOR_REACH = 5;         // 通路から何mまでを床とみなすか（両側の教室ぶん）
const FLOOR_CLOSE = 4;         // 何マスぶんの細い隙間・くぼみを埋めて、建物らしい形にするか
const FLOOR_SPIKE = 1;         // 削ったあとに残る、何マスぶんの細い出っ張りを取るか
const FLOOR_SMOOTH = 1.2;      // 輪郭のギザギザをならす強さ（何マスぶんまでのずれを、まっすぐな線にまとめるか）
const AXIS_TOLERANCE = 0.18;   // 通路が建物の向きから何ラジアン以内なら「建物の向きにそろった通路」とみなすか
const OUTDOOR_CLEAR = 2;       // 屋外の道から何mまでは床から削るか
const CORRIDOR_KEEP = 1.5;     // 通路から何mまでは、屋外の道と重なっても必ず床に残すか（データのずれで重なる場所がある）
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
  spread: 1.8,            // 高さの強調（すべての点の高さをこの倍率で描く）
  focus: null,            // 寄っている建物（null = 全体）
  floor: null,            // 寄っている建物で、教室名を出す階
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

const world = new THREE.Group();        // 建物・通路・屋外の道（高さの強調を変えたら作り直す）
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

// 高さは、建物の中も屋外もすべて同じ倍率（spread）で強調する。建物の中だけを強調すると、上の階の出入口と
// 屋外の点の高さの関係が崩れて、つなぐ線が垂直に落ちたように見えてしまうため（データ上は差が2m程度でも）。
function toScene(n) {
  const up = (n.z - state.baseZ) * state.spread;
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

// ---------------------------------------------------------------- 床の形
// 各階の床を「その階の点をすべて囲む長方形」にすると、L字の建物や離れた棟のある建物で、何もない所まで
// 床になってしまう。そこで、建物の向きにそろえた1m角のマス目の上で
//   1. その階の通路から FLOOR_REACH m 以内のマスを床にする（両側の教室ぶん）
//   2. 細い隙間・くぼみを埋める（広げてから縮める）
//   3. 屋外の道から OUTDOOR_CLEAR m 以内のマスを削る（建物の外の道に床がかぶらないように）
//   4. 通路から CORRIDOR_KEEP m 以内のマスは必ず残す（データのずれで屋外の道と重なっていても通路は床の上に）
// とし、床のマスの輪郭をなぞって多角形（穴あり）にする。座標はデータの x・y のまま返す。
const floorOutlineCache = new Map();

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// マス目の上で、線分（点だけなら長さ0の線分）から r 以内のマスに value を書く。
// boxy なら、建物の向きにそろった通路は「通路を r だけ広げた長方形」で塗る（円で測ると角が丸くなり、縁がでこぼこするため）
function paintNearSegments(grid, segs, r, value, boxy = false) {
  const { w, h, u0, v0 } = grid;
  for (const [au, av, bu, bv] of segs) {
    const ang = Math.atan2(Math.abs(bv - av), Math.abs(bu - au));
    const aligned = boxy && (ang <= AXIS_TOLERANCE || ang >= Math.PI / 2 - AXIS_TOLERANCE || (au === bu && av === bv));
    const i0 = Math.max(0, Math.floor((Math.min(au, bu) - r - u0) / FLOOR_CELL));
    const i1 = Math.min(w - 1, Math.floor((Math.max(au, bu) + r - u0) / FLOOR_CELL));
    const j0 = Math.max(0, Math.floor((Math.min(av, bv) - r - v0) / FLOOR_CELL));
    const j1 = Math.min(h - 1, Math.floor((Math.max(av, bv) + r - v0) / FLOOR_CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cu = u0 + (i + 0.5) * FLOOR_CELL, cv = v0 + (j + 0.5) * FLOOR_CELL;
        if (aligned || distToSegment(cu, cv, au, av, bu, bv) <= r) grid.cells[j * w + i] = value;
      }
    }
  }
}

// 広げる（床のマスの r マス以内を床に）／縮める（床でないマスの r マス以内を床でなく）。
// square なら正方形の範囲で見る（角が丸くならず、四角い形のまま広げ縮めできる）
function morph(grid, r, grow, square = false) {
  const { w, h, cells } = grid;
  const out = new Uint8Array(cells.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let hit = !grow;
      for (let dj = -r; dj <= r && hit !== grow; dj++) {
        for (let di = -r; di <= r; di++) {
          if (!square && di * di + dj * dj > r * r) continue;
          const x = i + di, y = j + dj;
          const filled = x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === 1;
          if (grow ? filled : !filled) { hit = grow; break; }
        }
      }
      out[j * w + i] = hit ? 1 : 0;
    }
  }
  grid.cells = out;
}

// 床のマスの輪郭を、床を左手に見ながら一周する線の集まりにする（外周は反時計回り、穴は時計回り）
function traceLoops(grid) {
  const { w, h, cells } = grid;
  const filled = (i, j) => i >= 0 && j >= 0 && i < w && j < h && cells[j * w + i] === 1;
  const out = new Map();   // 始点 "i,j" -> 境界の辺 [i0, j0, i1, j1] の一覧
  const add = (i0, j0, i1, j1) => {
    const k = `${i0},${j0}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([i0, j0, i1, j1]);
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!filled(i, j)) continue;
      if (!filled(i, j - 1)) add(i, j, i + 1, j);
      if (!filled(i + 1, j)) add(i + 1, j, i + 1, j + 1);
      if (!filled(i, j + 1)) add(i + 1, j + 1, i, j + 1);
      if (!filled(i - 1, j)) add(i, j + 1, i, j);
    }
  }
  // 辺を1本ずつたどって一周させる（各辺は1回だけ使う）
  const loops = [];
  for (const list of out.values()) {
    while (list.length) {
      let edge = list.pop();
      const start = [edge[0], edge[1]];
      const loop = [start];
      while (edge[2] !== start[0] || edge[3] !== start[1]) {
        const next = out.get(`${edge[2]},${edge[3]}`);
        if (!next || !next.length) break;   // 念のため（閉じない線は無いはず）
        // 2本以上の候補がある角（斜めに接するマス）では、左に曲がる辺を優先して、形を正しく分ける
        const dx = edge[2] - edge[0], dy = edge[3] - edge[1];
        next.sort((p, q) => turnRank(dx, dy, p) - turnRank(dx, dy, q));
        edge = next.shift();
        loop.push([edge[0], edge[1]]);
      }
      loops.push(smoothLoop(simplifyLoop(loop), FLOOR_SMOOTH));
    }
  }
  return loops.filter(l => l.length >= 3);
}

function turnRank(dx, dy, e) {
  const ex = e[2] - e[0], ey = e[3] - e[1];
  const cross = dx * ey - dy * ex;
  return cross > 0 ? 0 : cross === 0 ? 1 : 2;   // 左折 → 直進 → 右折 の順
}

// 一直線に並んだ途中の点を除く
function simplifyLoop(loop) {
  const n = loop.length;
  return loop.filter((p, k) => {
    const a = loop[(k - 1 + n) % n], b = loop[(k + 1) % n];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
}

// 閉じた輪郭を、tol マス以内のずれは無視してまっすぐな線にまとめる（ダグラス・ポイカー法）。
// 斜めに削った所の1マスずつの階段が、なめらかな斜めの線になる
function smoothLoop(loop, tol) {
  if (loop.length <= 4) return loop;
  const rdp = (pts) => {
    if (pts.length <= 2) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
    let worst = 0, at = 0;
    for (let k = 1; k < pts.length - 1; k++) {
      const d = distToSegment(pts[k][0], pts[k][1], ax, ay, bx, by);
      if (d > worst) { worst = d; at = k; }
    }
    if (worst <= tol) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, at + 1)).slice(0, -1), ...rdp(pts.slice(at))];
  };
  // 一番離れた2点で輪郭を2つに分け、それぞれをならしてつなぐ
  let far = 0, fd = -1;
  for (let k = 1; k < loop.length; k++) {
    const d = Math.hypot(loop[k][0] - loop[0][0], loop[k][1] - loop[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  const a = rdp(loop.slice(0, far + 1));
  const b = rdp([...loop.slice(far), loop[0]]);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : loop;
}

function loopArea(loop) {
  let s = 0;
  for (let k = 0; k < loop.length; k++) {
    const [x1, y1] = loop[k], [x2, y2] = loop[(k + 1) % loop.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function pointInLoop(x, y, loop) {
  let inside = false;
  for (let k = 0, m = loop.length - 1; k < loop.length; m = k++) {
    const [xi, yi] = loop[k], [xj, yj] = loop[m];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 建物 b の階 floor の床の形。[{ outer: [[x,y],...], holes: [[[x,y],...], ...] }]（データの x・y） */
function computeFloorOutline(b, floor) {
  const key = `${b}_${floor}`;
  if (floorOutlineCache.has(key)) return floorOutlineCache.get(key);

  const rot = ((state.config[String(b)] || {}).rot_deg || 0) * Math.PI / 180;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const toUV = (x, y) => [c * x - s * y, s * x + c * y];
  const fromUV = (u, v) => [Math.cos(rot) * u - Math.sin(rot) * v, Math.sin(rot) * u + Math.cos(rot) * v];

  const nodes = state.graph.nodes;
  const byId = new Map(nodes.map(n => [n.id, n]));
  const floorNodes = nodes.filter(n => n.building === b && n.floor === floor);
  // その階の通路（同じ階の中の線）。線の無い点（階段の踊り場など）は長さ0の線として扱う
  const corridor = [];
  const onEdge = new Set();
  for (const e of state.graph.edges) {
    const p = byId.get(e.from), q = byId.get(e.to);
    if (!p || !q || p.building !== b || q.building !== b || p.floor !== floor || q.floor !== floor) continue;
    corridor.push([...toUV(p.x, p.y), ...toUV(q.x, q.y)]);
    onEdge.add(p.id); onEdge.add(q.id);
  }
  for (const n of floorNodes) if (!onEdge.has(n.id)) corridor.push([...toUV(n.x, n.y), ...toUV(n.x, n.y)]);
  if (!corridor.length) { floorOutlineCache.set(key, []); return []; }

  // 屋外の道（上から見て重ならないようにする。建物と屋外をつなぐ入口の線は除く）
  const outdoor = [];
  for (const e of state.graph.edges) {
    const p = byId.get(e.from), q = byId.get(e.to);
    if (!p || !q || p.building !== 0 || q.building !== 0 || Number(e.type) === 7) continue;
    outdoor.push([...toUV(p.x, p.y), ...toUV(q.x, q.y)]);
  }

  const margin = FLOOR_REACH + FLOOR_CLOSE + 2;
  const us = corridor.flatMap(sg => [sg[0], sg[2]]), vs = corridor.flatMap(sg => [sg[1], sg[3]]);
  const u0 = Math.min(...us) - margin, v0 = Math.min(...vs) - margin;
  const w = Math.ceil((Math.max(...us) + margin - u0) / FLOOR_CELL);
  const h = Math.ceil((Math.max(...vs) + margin - v0) / FLOOR_CELL);
  const grid = { w, h, u0, v0, cells: new Uint8Array(w * h) };

  paintNearSegments(grid, corridor, FLOOR_REACH, 1, true);
  morph(grid, FLOOR_CLOSE, true, true);    // 隙間・くぼみを埋める（広げてから縮める）
  morph(grid, FLOOR_CLOSE, false, true);
  paintNearSegments(grid, outdoor, OUTDOOR_CLEAR, 0);
  morph(grid, FLOOR_SPIKE, false, true);   // 削ったあとに残る細い出っ張りを取る（縮めてから広げる）
  morph(grid, FLOOR_SPIKE, true, true);
  paintNearSegments(grid, corridor, CORRIDOR_KEEP, 1);

  // 輪郭（マス目の座標）→ データの x・y。外周に穴を割り当てる
  const toXY = loop => loop.map(([i, j]) => fromUV(u0 + i * FLOOR_CELL, v0 + j * FLOOR_CELL));
  const loops = traceLoops(grid);
  const outers = loops.filter(l => loopArea(l) > 0).map(l => ({ grid: l, outer: toXY(l), holes: [] }));
  for (const hole of loops.filter(l => loopArea(l) < 0)) {
    const [hi, hj] = hole[0];
    const owner = outers.find(o => pointInLoop(hi + 0.5, hj + 0.5, o.grid) || pointInLoop(hi - 0.5, hj - 0.5, o.grid));
    if (owner) owner.holes.push(toXY(hole));
  }
  const result = outers.map(({ outer, holes }) => ({ outer, holes }));
  floorOutlineCache.set(key, result);
  return result;
}

// 床の形（データの x・y）を、高さ y の薄い板にする
function floorSlabGeometry(outline, y) {
  const shapes = outline.map(({ outer, holes }) => {
    // Three.js の形は x・y 平面で作り、あとで寝かせる。寝かせたあと (X, Z) になるよう (X, -Z) で書く
    const toV2 = ([x, yy]) => { const p = sceneXZ(x, yy); return new THREE.Vector2(p.x, -p.z); };
    const shape = new THREE.Shape(outer.map(toV2));
    for (const hole of holes) shape.holes.push(new THREE.Path(hole.map(toV2)));
    return shape;
  });
  const geo = new THREE.ExtrudeGeometry(shapes, { depth: 0.35, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);   // (x, y, z) → (x, z, -y)：形が地面と平行になり、厚みが上向きになる
  geo.translate(0, y, 0);
  return geo;
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

  // 各階の床の板（通路の形に沿った形。computeFloorOutline 参照）
  const floors = new Map();   // "建物_階" -> 点の一覧
  for (const n of nodes) {
    if (n.building === 0) continue;
    const key = `${n.building}_${n.floor}`;
    if (!floors.has(key)) floors.set(key, []);
    floors.get(key).push(n);
  }
  const buildingTop = {};     // 建物名の札を置く高さ
  const buildingCenter = {};
  for (const list of floors.values()) {
    const b = list[0].building, floor = list[0].floor;
    const dimmed = state.focus !== null && state.focus !== b;
    const selected = state.focus === b && state.floor === floor;
    const otherFloor = state.focus === b && state.floor !== null && !selected;
    const outline = computeFloorOutline(b, floor);
    const zs = list.map(n => n.z).sort((p, q) => p - q);
    const floorY = toScene({ building: b, x: list[0].x, y: list[0].y, z: zs[Math.floor(zs.length / 2)] }).y;
    const color = buildingColor(b);
    if (outline.length) {
      const geo = floorSlabGeometry(outline, floorY - 0.4);
      world.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color, transparent: true, opacity: dimmed ? 0.07 : selected ? 0.55 : otherFloor ? 0.12 : 0.3, depthWrite: false, side: THREE.DoubleSide,
      })));
      world.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: dimmed ? 0.12 : 0.65 })));
    }
    buildingTop[b] = Math.max(buildingTop[b] ?? -Infinity, floorY);
    if (!buildingCenter[b]) buildingCenter[b] = { x: 0, z: 0, n: 0 };
    for (const n of list) {
      const p = toScene(n);
      buildingCenter[b].x += p.x; buildingCenter[b].z += p.z; buildingCenter[b].n += 1;
    }
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
      // 寄っている建物では、選んだ階以外の通路も薄くして、選んだ階が見やすいようにする
      const dimmed = state.focus !== null && (state.focus !== a.building || (state.floor !== null && a.floor !== state.floor));
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
  if (state.showLabels && state.focus !== null) addRoomLabels(byId);
}

// 線（from → to）の left・right に書かれた教室を、通路の左右に分けて、書かれている順番どおりに from から to へ並べる。
// left・right が無い線の name だけの教室は、通路の上に並べる。同じ階の同じ教室は1回だけ（left・right で書かれた方を優先）。
// 左右は、鏡写しを直した換算（sceneXZ）のあとの実際の東西南北で決める（データを入れた人が見た建物の左右とそろう）。
const ROOM_SIDE_OFFSET = 3.2;   // 通路の中心から、左右の教室名の札までの距離（m）
const ROOM_LABEL_STYLE = {
  M_Toilet: { bg: "#2F7FE0", fg: "#FFFFFF" },
  F_Toilet: { bg: "#E2508E", fg: "#FFFFFF" },
  C_Toilet: { bg: "#2FB36D", fg: "#FFFFFF" },
};

function splitRooms(value) {
  return String(value || "").split(";").map(s => s.trim()).filter(Boolean);
}

function addRoomLabels(byId) {
  const seen = new Set();
  const pinMat = new THREE.LineBasicMaterial({ color: 0x55606E, transparent: true, opacity: 0.55 });
  const pins = [];
  const edges = state.graph.edges.filter(e => {
    if (e.building !== state.focus) return false;
    const a = byId.get(e.from), b = byId.get(e.to);
    return a && b && a.floor === b.floor && (state.floor === null || a.floor === state.floor);
  });
  const hasSides = e => splitRooms(e.left).length || splitRooms(e.right).length;

  const place = (e, rooms, side) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    const pa = toScene(a), pb = toScene(b);
    const dir = new THREE.Vector3(pb.x - pa.x, 0, pb.z - pa.z);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const left = new THREE.Vector3(dir.z, 0, -dir.x);   // 上から見て進行方向の左（東向きなら北）
    const list = rooms.filter(raw => !seen.has(`${a.floor}:${raw}`));
    list.forEach((raw, k) => {
      seen.add(`${a.floor}:${raw}`);
      const base = pa.clone().lerp(pb, (k + 1) / (list.length + 1));   // 書かれている順に from → to へ
      const foot = base.clone().addScaledVector(left, side * ROOM_SIDE_OFFSET);
      const top = foot.clone().add(new THREE.Vector3(0, side === 0 ? 1.6 + (k % 2) * 1.6 : 2.2, 0));
      const label = makeLabel(roomLabelText(e.building, raw), { size: 1.5, ...(ROOM_LABEL_STYLE[raw] || {}) });
      label.position.copy(top).add(new THREE.Vector3(0, 0.75, 0));
      labelGroup.add(label);
      if (side !== 0) pins.push(foot.x, foot.y, foot.z, top.x, top.y, top.z);   // 札から床までの細い線（どちら側かを分かりやすく）
    });
  };

  for (const e of edges.filter(hasSides)) {
    place(e, splitRooms(e.left), 1);
    place(e, splitRooms(e.right), -1);
  }
  for (const e of edges.filter(e => !hasSides(e))) place(e, splitRooms(e.name), 0);

  if (pins.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pins, 3));
    labelGroup.add(new THREE.LineSegments(geo, pinMat));
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

function floorName(f) {
  return f <= 0 ? `地下${1 - f}階` : `${f}階`;
}

// 寄っている建物の階の選択肢。最初は一番下の地上階（1階。無ければ一番下の階）を選ぶ
function fillFloorChips(b) {
  const row = $("floor-row"), wrap = $("floor-chips");
  wrap.replaceChildren();
  if (b === null) { row.hidden = true; state.floor = null; return; }
  const floors = [...new Set(state.graph.nodes.filter(n => n.building === b).map(n => n.floor))].sort((p, q) => p - q);
  state.floor = floors.includes(1) ? 1 : floors[0];
  for (const f of floors) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (f === state.floor ? " active" : "");
    chip.textContent = floorName(f);
    chip.addEventListener("click", () => {
      state.floor = f;
      wrap.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
      buildWorld();
    });
    wrap.appendChild(chip);
  }
  row.hidden = false;
}

function focusBuilding(b) {
  state.focus = b;
  fillFloorChips(b);
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
