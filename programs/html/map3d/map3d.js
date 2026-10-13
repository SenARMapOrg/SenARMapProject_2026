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
  photo: 0x14B8D0,     // 写真モードで、写真のある通路
  viewing: 0xFFB000,   // 写真モードで、いま写真を見ている通路
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
  floor: null,            // 寄っている建物で、教室名を出す階（null = 全部の階）
  showLabels: true,
  nodeById: new Map(),    // すべての点（番号 -> 点）
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
const photoGroup = new THREE.Group();   // 写真モードで見ている通路の目印
scene.add(photoGroup);
const edgeSegments = [];  // 描いた線（通路・階段など）。写真モードで、タップした場所に近い線を探すのに使う

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
  sprite.userData.text = text;   // 札の文字（画像になるので、あとから確かめられるよう残す）
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
    photo: new THREE.MeshStandardMaterial({ color: COLOR.photo, emissive: COLOR.photo, emissiveIntensity: 0.3, roughness: 0.6 }),
  };
  edgeSegments.length = 0;
  const verticalMats = {};
  for (const e of state.graph.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const type = Number(e.type);
    const pa = toScene(a), pb = toScene(b);
    let mesh = null, dimmed = false;
    // 写真モードでは、写真のある線（どちらかの向きだけでも）を色を変えて目立たせる
    const withPhoto = photo.on && hasPhoto(e.from, e.to);
    if (a.building === 0 || b.building === 0 || type === 7) {
      mesh = tubeBetween(pa, pb, 0.7, withPhoto ? mats.photo : mats.outdoor);
    } else if (VERTICAL_STYLE[type] && a.floor !== b.floor) {
      dimmed = state.focus !== null && state.focus !== a.building;
      const key = `${type}_${dimmed}`;
      verticalMats[key] ??= new THREE.MeshStandardMaterial({
        color: VERTICAL_STYLE[type].color, emissive: VERTICAL_STYLE[type].color, emissiveIntensity: 0.25,
        transparent: dimmed, opacity: dimmed ? 0.2 : 1,
      });
      mesh = tubeBetween(pa, pb, 0.38, verticalMats[key]);
    } else if (WALK_TYPES.has(type) || a.floor === b.floor) {
      // 寄っている建物では、選んだ階以外の通路も薄くして、選んだ階が見やすいようにする
      dimmed = state.focus !== null && (state.focus !== a.building || (state.floor !== null && a.floor !== state.floor));
      mesh = tubeBetween(pa, pb, CORRIDOR_R, dimmed ? mats.corridorDim : withPhoto ? mats.photo : mats.corridor);
    }
    if (mesh) {
      world.add(mesh);
      edgeSegments.push({ e, pa, pb, dimmed });
    }
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
  drawPhotoMarker();   // 高さの強調などで作り直したら、見ている通路の目印も描き直す
}

// 線（from → to）の left・right に書かれた教室を、通路の左右に分けて、書かれている順番どおりに from から to へ並べる。
// left・right が無い線の name だけの教室は、通路の上に並べる。同じ階で近くに同じ名前がある場合だけ1回にまとめる
// （left・right で書かれた方を優先）。
// 左右は、鏡写しを直した換算（sceneXZ）のあとの実際の東西南北で決める（データを入れた人が見た建物の左右とそろう）。
const ROOM_SIDE_OFFSET = 3.2;   // 通路の中心から、左右の教室名の札までの距離（m）
// 同じ名前の札がこの距離（m、上から見た距離）より近くに既にあれば出さない。同じ教室が隣り合う複数の線に
// 書かれている場合の重複を除くため。離れた場所の同じ名前（別々のトイレなど）は、それぞれ出す
const ROOM_SAME_DISTANCE = 8;
const ROOM_LABEL_STYLE = {
  M_Toilet: { bg: "#2F7FE0", fg: "#FFFFFF" },
  F_Toilet: { bg: "#E2508E", fg: "#FFFFFF" },
  C_Toilet: { bg: "#2FB36D", fg: "#FFFFFF" },
};

function splitRooms(value) {
  return String(value || "").split(";").map(s => s.trim()).filter(Boolean);
}

function addRoomLabels(byId) {
  const placed = new Map();   // "階:名前" -> 置いた位置の一覧
  const nearSame = (key, p) => (placed.get(key) || []).some(q => Math.hypot(p.x - q.x, p.z - q.z) < ROOM_SAME_DISTANCE);
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
    // 書かれている順に from → to へ並べる。近くに同じ名前が既にあるものは除いてから間隔を決める
    const mid = pa.clone().lerp(pb, 0.5);
    const list = rooms.filter(raw => !nearSame(`${a.floor}:${raw}`, mid));
    list.forEach((raw, k) => {
      const base = pa.clone().lerp(pb, (k + 1) / (list.length + 1));
      const key = `${a.floor}:${raw}`;
      if (!placed.has(key)) placed.set(key, []);
      placed.get(key).push(base);
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

// 寄っている建物の階の選択肢。「全部」（state.floor = null）は全部の階の教室名を出し、どの階も薄くしない。
// 階を選ぶと、その階の教室名だけを出し、ほかの階の床と通路を薄くする。寄った直後は「全部」
function fillFloorChips(b) {
  const row = $("floor-row"), wrap = $("floor-chips");
  wrap.replaceChildren();
  state.floor = null;
  if (b === null) { row.hidden = true; return; }
  const floors = [...new Set(state.graph.nodes.filter(n => n.building === b).map(n => n.floor))].sort((p, q) => p - q);
  for (const f of [null, ...floors]) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (f === state.floor ? " active" : "");
    chip.dataset.floor = f === null ? "all" : String(f);
    chip.textContent = f === null ? "全部" : floorName(f);
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
  document.querySelectorAll("#building-chips .chip").forEach(chip => chip.classList.toggle("active", chip.dataset.building === String(b ?? "all")));
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
  updateViewOffset();
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
  if (hit) { focusBuilding(hit.object.userData.building); return; }
  if (photo.on) {
    const seg = pickEdge(e.clientX, e.clientY, e.pointerType === "mouse" ? PICK_RADIUS.mouse : PICK_RADIUS.touch);
    if (seg) openEdgeFromTap(seg.e);
  }
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

// ---------------------------------------------------------------- 写真モード（ストリートビューのように通路の写真を見る）
// 写真は線の向きごとにある（edge_image.csv。from → to の写真は from に立って to の方を向いて撮ったもの）。
// いま見ている向きの線（from → to）を基準に、矢印で隣の線へ移る:
//   前へ   … to から先へ、いちばんまっすぐ続く線（先が曲がり角で1本しか無ければ、曲がってその線へ）
//   後ろへ … from より手前の、まっすぐ後ろにある線（向きはそのまま、後ずさりする）
//   左・右 … この先の分かれ道（to）で左・右に曲がる線。to に無ければ、立っている from で曲がる線
//   上・下 … from か to にある階段・エレベーター・エスカレーターで、上・下の階へ
//   振り返る … 同じ線の反対向き
// 左右は、鏡写しを直したあとの実際の東西南北で決める（教室名の左右と同じ）。データも API も変えず、読むだけ
const photo = {
  on: false,
  images: null,       // /api/edge_images（{"from_to": 写真のURL}）。写真モードを初めて使うときに読む
  adjacency: null,    // 点の番号 -> [{ to: 点の番号, e: 線 }]
  from: null, to: null,
  heading: null,      // いま向いている水平の向き（階段・エレベーターのように水平の長さが無い線では、直前の向きを引き継ぐ）
};
const STRAIGHT_LIMIT = 60;      // 前へ・後ろへで「まっすぐ」とみなす曲がりの角度（度）
const TURN_RANGE = [30, 150];   // 左・右とみなす曲がりの角度（度）
const PICK_RADIUS = { mouse: 16, touch: 30 };   // タップした場所から何ピクセル以内の線を選ぶか（指はマウスより大きく取る）
const PICK_NO_PHOTO = 10;       // 写真の無い線は、この分だけ遠いものとして選ぶ（写真のある通路を選びやすくする）
const SWIPE_MIN = 40;           // 写真の上で何ピクセル以上指を動かしたら、スワイプとして移るか
// パソコン（広い画面でマウスを使う）では、前後左右の写真も周りに並べる。スマートフォンでは真ん中の1枚だけ
// （通信量を抑えるため、周りの写真はパソコンのときだけ読む）。map3d.css の同じ条件と合わせる
const WIDE_PHOTO = window.matchMedia("(min-width: 900px) and (hover: hover) and (pointer: fine)");

function hasPhoto(from, to) {
  return !!photo.images && !!(photo.images[`${from}_${to}`] || photo.images[`${to}_${from}`]);
}

function nodeById(id) {
  return state.nodeById.get(id);
}

// 上から見た向き（鏡写しを直したあとの東西の x・南北の z）
function flatDir(a, b) {
  const pa = sceneXZ(a.x, a.y), pb = sceneXZ(b.x, b.y);
  const v = { x: pb.x - pa.x, z: pb.z - pa.z };
  const len = Math.hypot(v.x, v.z);
  return len < 0.5 ? null : { x: v.x / len, z: v.z / len };
}

// h から c への曲がりの角度（度）。右が正、左が負
function turnAngle(h, c) {
  return Math.atan2(h.x * c.z - h.z * c.x, h.x * c.x + h.z * c.z) * 180 / Math.PI;
}

function isVertical(a, b) {
  return a.building !== 0 && a.building === b.building && a.floor !== b.floor;
}

function buildAdjacency() {
  photo.adjacency = new Map();
  const add = (p, q, e) => {
    if (!photo.adjacency.has(p)) photo.adjacency.set(p, []);
    if (!photo.adjacency.get(p).some(x => x.to === q)) photo.adjacency.get(p).push({ to: q, e });
  };
  for (const e of state.graph.edges) {
    if (!nodeById(e.from) || !nodeById(e.to) || e.from === e.to) continue;
    add(e.from, e.to, e);
    add(e.to, e.from, e);
  }
}

function neighbors(id) {
  return (photo.adjacency.get(id) || []).filter(x => {
    const n = nodeById(x.to);
    return n && (n.building === 0 || state.shownBuildings.has(n.building));
  });
}

// 候補のうち、写真のある向きを優先して1つ選ぶ（score が小さいほど良い）
function best(cands) {
  cands.sort((p, q) => (p.photo === q.photo ? p.score - q.score : p.photo ? -1 : 1));
  return cands[0] || null;
}

function candidate(from, to, score) {
  return { from, to, score, photo: !!photo.images[`${from}_${to}`] };
}

// 矢印ごとの行き先（{from, to}）。行けなければ null
function photoMoves() {
  const u = photo.from, v = photo.to;
  const nu = nodeById(u), nv = nodeById(v);
  const h = photo.heading;
  const flat = (p, q) => !isVertical(nodeById(p), nodeById(q)) && flatDir(nodeById(p), nodeById(q));
  const moves = {};

  // 前へ: to から先へ。いま階段などの上なら向きの決まりが無いので、また先が曲がり角（続く線が1本だけ）なら、
  // どの向きでも一番まっすぐなものへ
  const onVertical = isVertical(nu, nv) || !flatDir(nu, nv);
  const ahead = neighbors(v).filter(x => x.to !== u && flat(v, x.to));
  moves.forward = best(ahead.map(x => {
    const a = h ? Math.abs(turnAngle(h, flatDir(nv, nodeById(x.to)))) : 0;
    return (onVertical || ahead.length === 1 || a <= STRAIGHT_LIMIT) ? candidate(v, x.to, a) : null;
  }).filter(Boolean));

  // 後ろへ: from から真後ろへ延びる線を、同じ向きのまま（手前の点 → from）たどる
  moves.back = h ? best(neighbors(u).filter(x => x.to !== v && flat(u, x.to)).map(x => {
    const a = 180 - Math.abs(turnAngle(h, flatDir(nu, nodeById(x.to))));
    return a <= STRAIGHT_LIMIT ? candidate(x.to, u, a) : null;
  }).filter(Boolean)) : null;

  // 左・右: この先の分かれ道（to）で曲がる。to に無ければ、立っている場所（from）で向きを変える。
  // 前へで曲がり角を曲がる場合（続く線が1本だけ）は、同じ線を左右にも出さない
  const turns = (p, np, skip, sign) => neighbors(p).filter(x => x.to !== skip && flat(p, x.to)).map(x => {
    const a = turnAngle(h, flatDir(np, nodeById(x.to))) * sign;
    return a > TURN_RANGE[0] && a < TURN_RANGE[1] ? candidate(p, x.to, Math.abs(a - 90)) : null;
  }).filter(Boolean);
  for (const [name, sign] of [["left", -1], ["right", 1]]) {
    if (!h) { moves[name] = null; continue; }
    const atV = onVertical ? [] : turns(v, nv, u, sign).filter(c => !(moves.forward && c.to === moves.forward.to && c.from === moves.forward.from));
    moves[name] = best(atV.length ? atV : turns(u, nu, v, sign));
  }

  // 上・下: from と to にある、階をまたぐ線。from にあるものを優先する
  for (const [name, sign] of [["up", 1], ["down", -1]]) {
    const cands = [];
    [u, v].forEach((p, k) => {
      const np = nodeById(p);
      for (const x of neighbors(p)) {
        if (x.to === u || x.to === v) continue;
        const nq = nodeById(x.to);
        if (isVertical(np, nq) && (nq.floor - np.floor) * sign > 0) cands.push(candidate(p, x.to, k));
      }
    });
    moves[name] = best(cands);
  }

  moves.flip = candidate(v, u, 0);
  return moves;
}

// 線の両端に建物の点があれば、その建物の名前と階
function placeName(a, b) {
  const n = a.building !== 0 ? a : b.building !== 0 ? b : null;
  if (!n) return "屋外";
  const bn = state.buildingNames[n.building] || `${n.building}号館`;
  if (isVertical(a, b)) return `${bn} ${floorName(a.floor)} → ${floorName(b.floor)}`;
  return `${bn} ${floorName(n.floor)}${a.building === 0 || b.building === 0 ? "（出入口）" : ""}`;
}

function edgeBetween(p, q) {
  const hit = (photo.adjacency.get(p) || []).find(x => x.to === q);
  return hit ? hit.e : null;
}

// 見ている向きでの、左右の教室（データの left・right は from → to の向きで書かれている）
function sideRooms(e, from) {
  const forward = e.from === from;
  const left = splitRooms(forward ? e.left : e.right).map(r => roomLabelText(e.building, r));
  const right = splitRooms(forward ? e.right : e.left).map(r => roomLabelText(e.building, r));
  const name = splitRooms(e.name).map(r => roomLabelText(e.building, r));
  return { left, right, name };
}

// 寄っている建物・選んでいる階と違う場所へ移ったら、そこが見えるように合わせる
function followPlace(n) {
  if (state.focus === null || n.building === 0) return false;
  let changed = false;
  if (state.focus !== n.building) {
    state.focus = n.building;
    fillFloorChips(n.building);
    document.querySelectorAll("#building-chips .chip").forEach(chip => chip.classList.toggle("active", chip.dataset.building === String(n.building)));
    changed = true;
  }
  if (state.floor !== null && state.floor !== n.floor) {
    state.floor = n.floor;
    document.querySelectorAll("#floor-chips .chip").forEach(chip => chip.classList.toggle("active", chip.dataset.floor === String(n.floor)));
    changed = true;
  }
  return changed;
}

function drawPhotoMarker() {
  disposeGroup(photoGroup);
  if (!photo.on || photo.from === null) return;
  const a = nodeById(photo.from), b = nodeById(photo.to);
  if (!a || !b) return;
  const lift = new THREE.Vector3(0, 0.6, 0);
  const pa = toScene(a).add(lift), pb = toScene(b).add(lift);
  const mat = new THREE.MeshBasicMaterial({ color: COLOR.viewing, depthTest: false, transparent: true, opacity: 0.95 });
  const tube = tubeBetween(pa, pb, 0.9, mat);
  if (tube) { tube.renderOrder = 5; photoGroup.add(tube); }
  // 立っている場所（from）の丸と、向いている方（to）を指す矢印
  const dot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 20, 14), mat);
  dot.position.copy(pa);
  dot.renderOrder = 6;
  const dir = new THREE.Vector3().subVectors(pb, pa);
  const len = dir.length();
  if (len > 0.01) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3.6, 20), mat);
    cone.position.copy(pa).addScaledVector(dir, Math.max(0.5, 1 - 2.5 / len));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    cone.renderOrder = 6;
    photoGroup.add(cone);
  }
  photoGroup.add(dot);
}

// 立っている場所の少し後ろ・上から、向いている方を見下ろす
function flyToPhoto() {
  const a = nodeById(photo.from), b = nodeById(photo.to);
  const pa = toScene(a), pb = toScene(b);
  const h = photo.heading || { x: 0, z: -1 };
  const target = pa.clone().lerp(pb, 0.5);
  const pos = pa.clone().add(new THREE.Vector3(-h.x * 30, 26, -h.z * 30));
  flyTo(target, pos, 650);
}

let photoToken = 0;
function showEdge(from, to, { fly = true } = {}) {
  const a = nodeById(from), b = nodeById(to);
  if (!a || !b) return;
  photo.from = from; photo.to = to;
  photo.heading = flatDir(a, b) || photo.heading;
  if (followPlace(a.building !== 0 ? a : b)) buildWorld(); else drawPhotoMarker();
  if (fly) flyToPhoto();

  const e = edgeBetween(from, to);
  const url = photo.images[`${from}_${to}`];
  const reverse = photo.images[`${to}_${from}`];
  $("photo-viewer").hidden = false;
  $("photo-title").textContent = placeName(a, b);
  const rooms = e ? sideRooms(e, from) : { left: [], right: [], name: [] };
  const parts = [];
  if (rooms.left.length) parts.push(`左: ${rooms.left.join("・")}`);
  if (rooms.right.length) parts.push(`右: ${rooms.right.join("・")}`);
  if (!parts.length && rooms.name.length) parts.push(rooms.name.join("・"));
  $("photo-rooms").textContent = parts.join("　");

  const img = $("photo-img"), empty = $("photo-empty");
  const token = ++photoToken;
  if (url) {
    empty.hidden = true;
    img.classList.add("loading");
    img.onload = () => { if (token === photoToken) img.classList.remove("loading"); };
    img.onerror = () => {
      if (token !== photoToken) return;
      img.removeAttribute("src");
      empty.textContent = "写真を読み込めませんでした";
      empty.hidden = false;
    };
    img.src = url;
    img.alt = `${placeName(a, b)}の通路の写真`;
  } else {
    img.removeAttribute("src");
    img.alt = "";
    empty.textContent = reverse ? "この向きの写真はまだありません（「振り返る」で反対向きの写真を見られます）" : "この通路の写真はまだありません";
    empty.hidden = false;
  }

  // 矢印: 行ける方向だけ押せるようにし、写真のある行き先には印を付ける。行き先の写真は先に読んでおく
  const moves = photoMoves();
  photo.moves = moves;
  document.querySelectorAll("#photo-viewer [data-move]").forEach(btn => {
    const m = moves[btn.dataset.move];
    btn.disabled = !m;
    btn.classList.toggle("has-photo", !!(m && m.photo));
    if (m && m.photo) new Image().src = photo.images[`${m.from}_${m.to}`];
  });
  fillPhotoThumbs();
  updateViewOffset();
}

// パソコンで、前後左右の行き先の写真を周りに並べる（行き先が無ければ枠を薄く、写真が無ければ「写真なし」）
function fillPhotoThumbs() {
  document.querySelectorAll("#photo-viewer [data-thumb]").forEach(btn => {
    const m = photo.moves && photo.moves[btn.dataset.thumb];
    const img = btn.querySelector("img");
    const show = WIDE_PHOTO.matches && !$("photo-viewer").classList.contains("expanded");   // 大きく表示中は並べない
    const url = show && m && m.photo ? photo.images[`${m.from}_${m.to}`] : null;
    if (url) img.src = url; else img.removeAttribute("src");
    btn.classList.toggle("no-photo", !!m && !m.photo);
  });
}

function movePhoto(name) {
  const m = photo.moves && photo.moves[name];
  if (m) showEdge(m.from, m.to);
}

// スマートフォンでは写真が画面の下半分を覆うので、そのあいだは3Dの中心を写真より上の見えている部分に寄せる
// （見ている通路の目印が写真の裏に隠れないように）
function updateViewOffset() {
  const w = window.innerWidth, h = window.innerHeight, v = $("photo-viewer");
  const cover = !v.hidden && !v.classList.contains("expanded") && w <= 600 ? v.getBoundingClientRect().height : 0;
  if (cover) camera.setViewOffset(w, h, 0, cover / 2, w, h); else camera.clearViewOffset();
}

function setPhotoExpanded(on) {
  $("photo-viewer").classList.toggle("expanded", on);
  $("photo-expand").setAttribute("aria-pressed", String(on));
  $("photo-expand-label").textContent = on ? "小さく" : "大きく";
  fillPhotoThumbs();
  updateViewOffset();
}

function closePhoto() {
  photo.from = photo.to = null;
  photo.moves = null;
  setPhotoExpanded(false);
  $("photo-viewer").hidden = true;
  $("photo-img").removeAttribute("src");
  updateViewOffset();
  disposeGroup(photoGroup);
}

// タップした場所（画面のピクセル）に一番近い線。薄く描いている線（ほかの階など）は近くに濃い線が無いときだけ、
// 写真の無い線は近くに写真のある線が無いときだけ選ぶ
function pickEdge(cx, cy, radius = PICK_RADIUS.mouse) {
  const w = window.innerWidth, h = window.innerHeight;
  let found = null, bestScore = Infinity;
  const toPx = v => { const p = v.clone().project(camera); return { x: (p.x + 1) / 2 * w, y: (1 - p.y) / 2 * h, z: p.z }; };
  for (const s of edgeSegments) {
    const a = toPx(s.pa), b = toPx(s.pb);
    if (a.z > 1 || b.z > 1) continue;   // カメラの後ろ
    const d = distToSegment(cx, cy, a.x, a.y, b.x, b.y);
    const score = d + (s.dimmed ? radius : 0) + (hasPhoto(s.e.from, s.e.to) ? 0 : PICK_NO_PHOTO) + (a.z + b.z);   // 同じくらい近ければ手前の線
    if (d <= radius && score < bestScore) { bestScore = score; found = s; }
  }
  return found;
}

// タップした線は、カメラの向きに近い方の向きで見る（その向きの写真が無く、反対向きにあれば反対向き）
function openEdgeFromTap(e) {
  const a = nodeById(e.from), b = nodeById(e.to);
  const look = new THREE.Vector3().subVectors(controls.target, camera.position);
  const d = flatDir(a, b);
  let [from, to] = !d || d.x * look.x + d.z * look.z >= 0 ? [e.from, e.to] : [e.to, e.from];
  if (!photo.images[`${from}_${to}`] && photo.images[`${to}_${from}`]) [from, to] = [to, from];
  photo.heading = null;
  showEdge(from, to);
}

async function setPhotoMode(on) {
  photo.on = on;
  const btn = $("photo-mode");
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  $("photo-mode-label").textContent = on ? "写真モードを終える" : "写真で見る";
  $("legend-photo").hidden = !on;
  if (!on) {
    closePhoto();
    buildWorld();
    return;
  }
  if (!photo.images) {
    setStatus("写真の一覧を読み込んでいます…");
    try {
      const res = await fetch(`${API_BASE}/api/edge_images`);
      photo.images = res.ok ? await res.json() : {};
    } catch {
      photo.images = {};
    }
    if (!photo.on) return;   // 読み込み中にオフにされた
  }
  if (!photo.adjacency) buildAdjacency();
  buildWorld();
  const count = Object.keys(photo.images).length;
  // 全体を見ているときは、写真のある通路が見えるところまで寄る（細い通路を遠くからタップするのは難しいため）
  if (count && state.focus === null && !state.route) {
    const points = edgeSegments.filter(sg => hasPhoto(sg.e.from, sg.e.to)).flatMap(sg => [sg.pa, sg.pb]);
    if (points.length) fitTo(points, 0.9);
  }
  setStatus(count ? "水色の通路をタップすると、その場所の写真が出ます" : "写真の一覧を読み込めませんでした", !count, 4000);
}

function setupPhotoMode() {
  $("photo-mode").addEventListener("click", () => setPhotoMode(!photo.on));
  $("photo-close").addEventListener("click", closePhoto);
  $("photo-expand").addEventListener("click", () => setPhotoExpanded(!$("photo-viewer").classList.contains("expanded")));
  // 写真の上でスワイプしても移れる（指を左へ動かすと右を向く、上へ動かすと前へ進む）
  const frame = $("photo-frame");
  let swipe = null;
  frame.addEventListener("pointerdown", e => { swipe = e.target.closest("button") ? null : { x: e.clientX, y: e.clientY }; });
  frame.addEventListener("pointercancel", () => { swipe = null; });
  frame.addEventListener("pointerup", e => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_MIN) return;
    if (Math.abs(dx) > Math.abs(dy)) movePhoto(dx < 0 ? "right" : "left");
    else movePhoto(dy < 0 ? "forward" : "back");
  });
  document.querySelectorAll("#photo-viewer [data-move]").forEach(btn => btn.addEventListener("click", () => movePhoto(btn.dataset.move)));
  WIDE_PHOTO.addEventListener("change", fillPhotoThumbs);   // 窓の大きさを変えたとき
  // パソコンでは矢印キーでも動ける（↑前へ ↓後ろへ ←→左右、PageUp/PageDown で上下の階、Escで閉じる）
  const keys = { ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right", PageUp: "up", PageDown: "down" };
  window.addEventListener("keydown", e => {
    if ($("photo-viewer").hidden || (e.target instanceof Element && e.target.closest("select, input, textarea"))) return;
    if (e.key === "Escape") {
      if ($("photo-viewer").classList.contains("expanded")) setPhotoExpanded(false); else closePhoto();
      return;
    }
    if (keys[e.key]) { e.preventDefault(); movePhoto(keys[e.key]); }
  });
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
  state.nodeById = new Map(graph.nodes.map(n => [n.id, n]));
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
  setupPhotoMode();

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
