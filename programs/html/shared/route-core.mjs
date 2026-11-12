// ================================================================
// route-core.mjs — IKU NAVI の経路計算（JS 版）
//
// 経路探索API（programs/3D_Graph の Flask）の経路系エンドポイントを、そのまま JS に移したもの。
// ブラウザ（ナビ・埋め込みマップ・3Dマップ）と Pages Functions の両方から使う。
// データは Pages のビルドで書き出す /data/route_data.json（programs/3D_Graph/export_static.py）。
//
//   import { createRouter } from "/shared/route-core.mjs";
//   const router = createRouter(await (await fetch("/data/route_data.json")).json());
//   const { status, body } = router.handle("/api/route", new URLSearchParams("from_room=10101&from_building=10&to_room=131&to_building=1"));
//
// handle() の返事は Flask の API と同じ（status と JSON の中身）。引数の読み方・エラーの文言も同じにしてある。
// 一致していることは programs/3D_Graph/tests/test_route_js.py が、実データの数千件の問い合わせで確かめている。
// Python 側（ikunavi/）を直したら、ここも同じように直すこと（テストが落ちて気付ける）。
//
// 対応表（Python → このファイル）
//   graph.py          … buildGraph
//   networkx          … bidirectionalDijkstra（探索の順番まで同じ。同じ長さの経路が複数あっても同じものを選ぶ）
//   search.py         … candidatesFromEdges / candidatesFromEvent / extendToFarEndpoint / bestRoute
//   serialize.py      … edgeToDict / pathResult / destInfo / eventDestInfo
//   naming.py         … displayName / firstDisplayLabel
//   cache.py          … 索引（教室・エッジID・イベント）
//   routes/*.py       … handle（/api/route・/api/shortest_path・/api/nearest_toilet・/api/nearest_cafeteria・/api/nearest_facility・/api/edges）
// ================================================================

export const ROUTE_DATA_VERSION = 1;

const ENTRANCE_PENALTY = 50.0;
const ESCALATOR_UP_EDGE_TYPE = "5";
const ESCALATOR_DOWN_EDGE_TYPE = "6";
const ELEVATOR_EDGE_TYPE = "4";
const ENTRANCE_EDGE_TYPE = "7";
const STEP_EDGE_TYPES = new Set(["2", "3", "5", "6"]);

export const TOILET_LABEL = { M_Toilet: "男子トイレ", F_Toilet: "女子トイレ", C_Toilet: "多目的トイレ" };
const TOILET_TYPE_MAP = {
  M: ["M_Toilet"],
  F: ["F_Toilet"],
  C: ["C_Toilet"],
  ALL: ["M_Toilet", "F_Toilet", "C_Toilet"],
};

// ---------------------------------------------------------------- エラー（errors.py）
class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// 古い iOS の Safari には Object.hasOwn が無いので、同じことをする関数を使う
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// JSON では NaN を null で書いているので戻す
const num = v => (v === null ? NaN : v);

// Python の str.strip() と同じ空白を落とす（JS の trim と同じ範囲で十分）
const strip = s => String(s).trim();

// ";" 区切り → 空要素を落とした配列
const splitNames = raw => String(raw ?? "").split(";").map(n => n.trim()).filter(Boolean);

// ---------------------------------------------------------------- 引数（Flask の request.args）
// request.args.get(name, type=int) と同じ: 無い・整数として読めないときは null
function parsePyInt(value) {
  if (value === null || value === undefined) return null;
  const s = strip(String(value).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(s)) return null;
  return Number(s.replace(/_/g, ""));
}

function argsReader(params) {
  const get = name => {
    const v = params.get(name);
    return v === undefined ? null : v;
  };
  return {
    str: (name, dflt = "") => strip(get(name) ?? dflt),
    raw: (name, dflt) => get(name) ?? dflt,
    int: name => parsePyInt(get(name)),
  };
}

// ---------------------------------------------------------------- グラフ（networkx.DiGraph 相当）
// ノード・隣接の並び順（追加した順）を networkx と同じに保つ。並び順が探索の順番を決める
export class DiGraph {
  constructor() {
    this.nodes = new Map();   // id → 属性
    this.succ = new Map();    // id → Map(隣 → 辺の属性)
    this.pred = new Map();
  }
  hasNode(id) { return this.nodes.has(id); }
  addNode(id, attrs = {}) {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { ...attrs });
      this.succ.set(id, new Map());
      this.pred.set(id, new Map());
    } else {
      Object.assign(this.nodes.get(id), attrs);
    }
  }
  addEdge(u, v, attrs) {
    if (!this.nodes.has(u)) this.addNode(u);
    if (!this.nodes.has(v)) this.addNode(v);
    const existing = this.succ.get(u).get(v);
    if (existing) {
      Object.assign(existing, attrs);   // networkx と同じく属性を上書きし、並び順は変えない
    } else {
      const data = { ...attrs };
      this.succ.get(u).set(v, data);
      this.pred.get(v).set(u, data);
    }
  }
  edge(u, v) { return this.succ.get(u)?.get(v); }
  hasEdge(u, v) { return !!this.edge(u, v); }
}

function nodeZ(G, id) {
  const z = G.nodes.get(id)?.z;
  if (z === undefined) throw new Error(`node ${id} has no z`);   // Python では KeyError（500）
  return z;
}

const reverseOrder = names => splitNames(names).reverse().join(";");
const reversedAttrs = a => ({ ...a, right: reverseOrder(a.left), left: reverseOrder(a.right) });

function edgeAttrs(e, edgeType) {
  return {
    edge_id: e.id,
    name: e.name,
    right: e.right,
    left: e.left,
    building: e.building,
    floor: e.floor,
    weight: num(e.weight) * num(e.length) + (edgeType === ENTRANCE_EDGE_TYPE ? ENTRANCE_PENALTY : 0.0),
    length: num(e.length),
    edge_type: edgeType,
  };
}

function nodeAttrs(n) {
  const a = { x: num(n.x), y: num(n.y), z: num(n.z), building: n.building, floor: n.floor, node_type: n.type };
  if ("lat" in n) a.lat = num(n.lat);
  if ("lng" in n) a.lng = num(n.lng);
  if ("svg_x" in n) { a.svg_x = num(n.svg_x); a.svg_y = num(n.svg_y); }
  return a;
}

// graph.py の build_graph
function buildGraph(data, useElevator = true, stepFree = false) {
  if (stepFree) useElevator = true;
  const G = new DiGraph();
  for (const n of data.nodes) G.addNode(n.id, nodeAttrs(n));
  for (const e of data.edges) {
    const edgeType = strip(e.type);
    if (!useElevator && edgeType === ELEVATOR_EDGE_TYPE) continue;
    if (stepFree && STEP_EDGE_TYPES.has(edgeType)) continue;
    const u = e.from, v = e.to;
    const attrs = edgeAttrs(e, edgeType);
    if (edgeType === ESCALATOR_UP_EDGE_TYPE) {
      // 上り: z が低い → 高い向きだけ（Python では add_edge の前に z を見るので、無いノードはここで落ちる）
      const [lo, hi] = nodeZ(G, u) <= nodeZ(G, v) ? [u, v] : [v, u];
      G.addEdge(lo, hi, lo === u ? attrs : reversedAttrs(attrs));
    } else if (edgeType === ESCALATOR_DOWN_EDGE_TYPE) {
      const [hi, lo] = nodeZ(G, u) >= nodeZ(G, v) ? [u, v] : [v, u];
      G.addEdge(hi, lo, hi === u ? attrs : reversedAttrs(attrs));
    } else {
      G.addEdge(u, v, attrs);
      G.addEdge(v, u, reversedAttrs(attrs));
    }
  }
  return G;
}

// ---------------------------------------------------------------- 最短経路（networkx.bidirectional_dijkstra）
// (距離, 追加した順の番号) の小さい順に取り出すヒープ。番号は重複しないので、取り出す順番は heapq と同じになる
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  static less(x, y) { return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// 戻り値: [距離, 経路] または null（経路なし）
// networkx の実装をそのまま移したもの。ただし networkx は「その点までの経路」を配列で丸ごと持ち、
// 点を更新するたびにコピーしているが、ここでは「どの点から来たか」だけを持ち、経路は必要なときに組み立てる
// （確定した点の来た道は以後変わらないので、組み立てた結果は networkx の配列と同じになる）
export function bidirectionalDijkstra(G, source, target) {
  if (source === target) return [0, [source]];
  const dists = [new Map(), new Map()];
  const prev = [new Map([[source, null]]), new Map([[target, null]])];
  const fringe = [new Heap(), new Heap()];
  const seen = [new Map([[source, 0]]), new Map([[target, 0]])];
  let c = 0;
  fringe[0].push([0, c++, source]);
  fringe[1].push([0, c++, target]);
  const neighs = [G.succ, G.pred];
  const chain = (dir, w) => {
    const out = [];
    for (let n = w; n !== null; n = prev[dir].get(n)) out.push(n);
    return out;   // w から始点（dir=0 は source、1 は target）へ向かう順
  };
  let finalpath = [];
  let finaldist;
  let dir = 1;
  while (fringe[0].size && fringe[1].size) {
    dir = 1 - dir;
    const [dist, , v] = fringe[dir].pop();
    if (dists[dir].has(v)) continue;
    dists[dir].set(v, dist);
    if (dists[1 - dir].has(v)) return [finaldist, finalpath];
    const dv = dist;
    for (const [w, d] of neighs[dir].get(v)) {
      const cost = d.weight === undefined ? 1 : d.weight;
      if (cost === null) continue;
      const vwLength = dv + cost;
      if (dists[dir].has(w)) {
        if (vwLength < dists[dir].get(w)) throw new Error("Contradictory paths found: negative weights?");
      } else if (!seen[dir].has(w) || vwLength < seen[dir].get(w)) {
        seen[dir].set(w, vwLength);
        fringe[dir].push([vwLength, c++, w]);
        prev[dir].set(w, v);
        if (seen[0].has(w) && seen[1].has(w)) {
          const totaldist = seen[0].get(w) + seen[1].get(w);
          if (finalpath.length === 0 || finaldist > totaldist) {
            finaldist = totaldist;
            finalpath = [...chain(0, w).reverse(), ...chain(1, w).slice(1)];
          }
        }
      }
    }
  }
  return null;
}

// 1つの点から、たどり着ける全部の点までの最短距離（候補の絞り込み用。経路の選び方には使わない）
function distancesFrom(G, source) {
  const dist = new Map([[source, 0]]);
  const done = new Set();
  const heap = new Heap();
  let c = 0;
  heap.push([0, c++, source]);
  while (heap.size) {
    const [d, , v] = heap.pop();
    if (done.has(v)) continue;
    done.add(v);
    for (const [w, e] of G.succ.get(v)) {
      const nd = d + (e.weight === undefined ? 1 : e.weight);
      if (!dist.has(w) || nd < dist.get(w)) {
        dist.set(w, nd);
        heap.push([nd, c++, w]);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------- 候補と総当たり（search.py）
function candidatesFromEdges(G, edgeRows, dedupe = false) {
  const seen = new Set(), result = [];
  for (const row of edgeRows) {
    for (const nid of [row.from, row.to]) {
      if (!G.hasNode(nid)) continue;
      if (dedupe) {
        if (seen.has(nid)) continue;
        seen.add(nid);
      }
      result.push([nid, row]);
    }
  }
  return result;
}

function candidatesFromEvent(G, eventCandidates) {
  const seen = new Set(), result = [];
  for (const [nid, row] of eventCandidates) {
    if (G.hasNode(nid) && !seen.has(nid)) {
      seen.add(nid);
      result.push([nid, row]);
    }
  }
  return result;
}

function extendToFarEndpoint(G, path, length, destRow) {
  if (!destRow || !path.length) return [path, length];
  const u = destRow.from, v = destRow.to;
  const last = path[path.length - 1];
  const far = last === u ? v : last === v ? u : null;
  if (far === null) return [path, length];
  if (path.length >= 2 && path[path.length - 2] === far) return [path, length];
  const e = G.edge(last, far);
  if (!e) return [path, length];
  return [[...path, far], length + (e.weight ?? 0.0)];
}

// 総当たりの組み合わせがこれより多いときは、先に候補を絞る（最寄りのトイレなど。教室どうしは 2×2 なので絞らない）
const PRUNE_ABOVE = 8;
// 絞り込みで残す幅。双方向探索と片方向の探索では、足し算の順番の違いで距離の最後の桁がずれることがあるため、
// 一番近い距離よりわずかに長いものまで残し、そこから先は Python と同じ双方向探索で比べる
const PRUNE_SLACK = 1e-6;

function bestRoute(G, starts, dests, allowSameNode = true) {
  let bestPath = null, bestLength = Infinity, bestStart = null, bestDest = null;
  // 絞り込み: 出発候補ごとに全点への距離を1回だけ求め、一番近い距離から大きく離れた組み合わせは調べない
  // （双方向探索の距離も同じ最短距離なので、離れた組み合わせが選ばれることは無い。選び方は変わらない）
  let keep = null;
  if (starts.length * dests.length > PRUNE_ABOVE) {
    const fromStart = new Map();
    for (const [sNode] of starts) {
      if (G.hasNode(sNode) && !fromStart.has(sNode)) fromStart.set(sNode, distancesFrom(G, sNode));
    }
    const approx = (sNode, dNode) => {
      if (sNode === dNode) return allowSameNode ? 0 : Infinity;
      const m = fromStart.get(sNode);
      return m && m.has(dNode) ? m.get(dNode) : Infinity;
    };
    let min = Infinity;
    for (const [sNode] of starts) for (const [dNode] of dests) min = Math.min(min, approx(sNode, dNode));
    if (min === Infinity) return [null, Infinity, null, null];
    const limit = min + PRUNE_SLACK * Math.max(1, min);
    keep = (sNode, dNode) => approx(sNode, dNode) <= limit;
  }
  for (const [sNode, sRow] of starts) {
    for (const [dNode, dRow] of dests) {
      if (keep && !keep(sNode, dNode)) continue;
      let length, path;
      if (sNode === dNode) {
        if (!allowSameNode) continue;
        length = 0.0;
        path = [sNode];
      } else {
        if (!G.hasNode(sNode) || !G.hasNode(dNode)) continue;
        const found = bidirectionalDijkstra(G, sNode, dNode);
        if (!found) continue;
        [length, path] = found;
      }
      if (length < bestLength) {
        bestLength = length; bestPath = path; bestStart = sRow; bestDest = dRow;
      }
    }
  }
  return [bestPath, bestLength, bestStart, bestDest];
}

// ---------------------------------------------------------------- ルーター本体
export function createRouter(data) {
  if (!data || data.version !== ROUTE_DATA_VERSION) {
    throw new Error(`route_data.json の版が違います（${data && data.version} / ${ROUTE_DATA_VERSION}）`);
  }
  const edges = data.edges;

  // 表示名（naming.py）
  const nameMap = new Map();
  for (const [building, name, display] of data.names) nameMap.set(`${building ?? ""}\u0000${name}`, display);
  const displayName = (building, name) =>
    nameMap.get(`${building}\u0000${name}`) || nameMap.get(`\u0000${name}`) || `${name}教室`;
  const firstDisplayLabel = (building, raw) => {
    const first = String(raw ?? "").split(";")[0].trim();
    if (!first) return "";
    if (hasOwn(TOILET_LABEL, first)) return TOILET_LABEL[first];
    return displayName(building, first);
  };

  // 座標（cache.get_node_xyz）
  const nodeXyz = new Map(data.nodes.map(n => [n.id, [num(n.x), num(n.y), num(n.z)]]));

  // 教室索引（cache._build_room_index の索引部分。挿入順を保つ）
  const roomIndex = new Map();   // "room\0building" → [edge, ...]
  for (const e of edges) {
    const rawName = strip(e.name);
    if (!rawName || rawName === "nan") continue;
    for (let room of rawName.split(";")) {
      room = room.trim();
      if (!room) continue;
      const key = `${room}\u0000${e.building}`;
      if (!roomIndex.has(key)) roomIndex.set(key, []);
      roomIndex.get(key).push(e);
    }
  }
  const findEdgesForRoom = (room, building) => roomIndex.get(`${room}\u0000${building}`) || [];
  const edgesByNames = names => {
    const result = [], seenIds = new Set();
    for (const [key, rows] of roomIndex) {
      const name = key.split("\u0000")[0];
      if (!names.includes(name)) continue;
      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        seenIds.add(row.id);
        result.push(row);
      }
    }
    return result;
  };

  // エッジID（cache.find_edge_by_id。同じIDが複数あれば後のもの）
  const edgeById = new Map();
  for (const e of edges) edgeById.set(e.id, e);

  // イベント（cache._build_event_index）
  const eventIndex = new Map(data.events.index.map(([title, cands]) =>
    [title, cands.map(([nid, ref]) => [nid, ref === null ? null : edges[ref]])]));
  const eventPlaces = new Map();
  for (const [title, gid, place] of data.events.places) {
    if (!eventPlaces.has(title)) eventPlaces.set(title, new Map());
    eventPlaces.get(title).set(gid, place);
  }
  const eventLineups = new Map(data.events.lineups.map(([gid, side, titles]) => [`${gid}\u0000${side}`, titles]));
  const eventIds = new Map(data.events.ids);
  const resolveEventTitle = value => {
    value = strip(value ?? "");
    if (!value) return "";
    if (eventIndex.has(value)) return value;
    return eventIds.get(value) ?? value;
  };

  // グラフ（cache.get_graph。条件ごとに作り置く）
  const graphs = new Map();
  const getGraph = (useElevator, stepFree) => {
    const key = stepFree ? "1,1" : `${useElevator ? 1 : 0},0`;
    if (!graphs.has(key)) graphs.set(key, buildGraph(data, stepFree ? true : useElevator, stepFree));
    return graphs.get(key);
  };

  // ---------------- serialize.py
  const edgeToDict = row => {
    const [x0, y0, z0] = nodeXyz.get(row.from);
    const [x1, y1, z1] = nodeXyz.get(row.to);
    return {
      id: row.id, name: row.name, right: row.right, left: row.left,
      from: row.from, to: row.to, building: row.building, floor: row.floor,
      weight: num(row.weight), length: num(row.length), type: row.type,
      x0, y0, z0, x1, y1, z1,
    };
  };

  const pathResult = (G, path, length) => {
    const pathCoords = path.map(id => {
      const n = G.nodes.get(id);
      const c = { id, x: n.x, y: n.y, z: n.z, building: n.building, floor: n.floor };
      if ("lat" in n) c.lat = n.lat;
      if ("lng" in n) c.lng = n.lng;
      if ("svg_x" in n && n.svg_x === n.svg_x) { c.svg_x = n.svg_x; c.svg_y = n.svg_y; }
      return c;
    });
    const pathEdges = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const u = path[i], v = path[i + 1];
      const e = G.edge(u, v);
      const n0 = G.nodes.get(u), n1 = G.nodes.get(v);
      const name = e.name ?? "", right = e.right ?? "", left = e.left ?? "";
      pathEdges.push({
        from: u, to: v, name, right, left,
        name_display: firstDisplayLabel(e.building, name),
        right_display: firstDisplayLabel(e.building, right),
        left_display: firstDisplayLabel(e.building, left),
        length: e.length ?? 0,
        type: e.edge_type ?? "1",
        x0: n0.x, y0: n0.y, z0: n0.z, x1: n1.x, y1: n1.y, z1: n1.z,
      });
    }
    return { path, total_weight: length, path_coords: pathCoords, path_edges: pathEdges };
  };

  const EMPTY_DEST_INFO = { side: "", position: null, count: null, nearest_display: null, dest_display: null };

  const destInfo = (result, roomName) => {
    const pe = result.path_edges || [];
    if (!pe.length || !roomName) return { ...EMPTY_DEST_INFO };
    const last = pe[pe.length - 1];
    roomName = strip(roomName);
    const coords = result.path_coords || [];
    const building = coords.length ? coords[coords.length - 1].building : null;
    for (const side of ["right", "left"]) {
      const names = splitNames(last[side]);
      if (names.includes(roomName)) {
        return {
          side,
          position: names.indexOf(roomName) + 1,
          count: names.length,
          nearest_display: firstDisplayLabel(building, names[0]),
          dest_display: firstDisplayLabel(building, roomName),
        };
      }
    }
    return { ...EMPTY_DEST_INFO };
  };

  const OTHER_SIDE = { right: "left", left: "right" };
  const eventDestInfo = (result, title, destRow) => {
    const pe = result.path_edges || [];
    if (!pe.length || !destRow) return { ...EMPTY_DEST_INFO };
    const last = pe[pe.length - 1];
    const u = destRow.from, v = destRow.to;
    const ends = new Set([last.from, last.to]);
    if (ends.size !== new Set([u, v]).size || !ends.has(u) || !ends.has(v)) return { ...EMPTY_DEST_INFO };
    const place = eventPlaces.get(title)?.get(destRow.id);
    if (!place) return { ...EMPTY_DEST_INFO };
    if (place.room) {
      const info = destInfo(result, place.room);
      if (info.side) info.dest_display = title;
      return info;
    }
    const side = place.side;
    if (!hasOwn(OTHER_SIDE, side)) return { ...EMPTY_DEST_INFO };
    const forward = last.from === u;
    const walkSide = forward ? side : OTHER_SIDE[side];
    let lineup = eventLineups.get(`${destRow.id}\u0000${side}`) || [];
    if (!forward) lineup = [...lineup].reverse();
    if (place.position === null || place.position === undefined || !lineup.includes(title)) {
      return { side: walkSide, position: null, count: null, nearest_display: null, dest_display: title };
    }
    return {
      side: walkSide,
      position: lineup.indexOf(title) + 1,
      count: lineup.length,
      nearest_display: lineup[0],
      dest_display: title,
    };
  };

  const applyInfo = (result, info) => {
    result.dest_side = info.side;
    result.dest_position = info.position;
    result.dest_count = info.count;
    result.dest_nearest_display = info.nearest_display;
    result.dest_display = info.dest_display;
  };

  // ---------------- routes/_common.py
  const graphFromArgs = args => {
    const useElevator = args.raw("use_elevator", "1") !== "0";
    const stepFree = args.raw("step_free", "0") === "1";
    return getGraph(useElevator, stepFree);
  };

  const edgesForRoomOr404 = (room, building, label = "教室") => {
    const rows = findEdgesForRoom(room, building);
    if (!rows.length) throw new ApiError(`建物 ${building} に${label} '${room}' が見つかりません`, 404);
    return rows;
  };

  const edgeOr404 = id => {
    const row = edgeById.get(id);
    if (!row) throw new ApiError(`エッジ ${id} が存在しません`, 404);
    return row;
  };

  const fromSpec = args => ({
    room: args.str("from_room"),
    building: args.int("from_building"),
    nodeId: args.int("from_node"),
    event: resolveEventTitle(args.raw("from_event", "")),
    edgeId: args.int("from_edge"),
  });

  const requireFrom = spec => {
    if (!spec.room && !spec.event && spec.edgeId === null && spec.nodeId === null) {
      throw new ApiError("from_room（＋from_building）・from_event・from_edge・from_node のいずれかを指定してください");
    }
  };

  const fromCandidates = (spec, G) => {
    if (spec.event) {
      const result = candidatesFromEvent(G, eventIndex.get(spec.event) || []);
      if (!result.length) throw new ApiError(`イベント '${spec.event}' が見つかりません`, 404);
      return result;
    }
    if (spec.room) {
      if (spec.building === null) throw new ApiError("from_building を指定してください");
      return candidatesFromEdges(G, edgesForRoomOr404(spec.room, spec.building), true);
    }
    if (spec.edgeId !== null) return candidatesFromEdges(G, [edgeOr404(spec.edgeId)], true);
    if (!G.hasNode(spec.nodeId)) throw new ApiError(`ノード ${spec.nodeId ?? "None"} が存在しません`, 404);
    return [[spec.nodeId, null]];
  };

  const annotateFrom = (spec, result, startRow) => {
    if (spec.event) result.from_event = spec.event;
    if (startRow) {
      if (spec.room) result.from_room = spec.room;
      result.from_edge = edgeToDict(startRow);
    }
    return result;
  };

  // ---------------- routes/navigation.py
  const destCandidates = (G, toRoom, toBuilding, toNode, toEvent, toEdge) => {
    if (toEvent) {
      const c = candidatesFromEvent(G, eventIndex.get(toEvent) || []);
      if (!c.length) throw new ApiError(`イベント '${toEvent}' が見つかりません`, 404);
      return c;
    }
    if (toRoom) {
      if (toBuilding === null) throw new ApiError("to_building を指定してください");
      return candidatesFromEdges(G, edgesForRoomOr404(toRoom, toBuilding));
    }
    if (toEdge !== null) return candidatesFromEdges(G, [edgeOr404(toEdge)]);
    if (!G.hasNode(toNode)) throw new ApiError(`ノード ${toNode ?? "None"} が存在しません`, 404);
    return [[toNode, null]];
  };

  function apiRoute(args) {
    const spec = fromSpec(args);
    const toRoom = args.str("to_room");
    const toBuilding = args.int("to_building");
    const toNode = args.int("to_node");
    const toEvent = resolveEventTitle(args.raw("to_event", ""));
    const toEdge = args.int("to_edge");

    requireFrom(spec);
    if (!toRoom && !toEvent && toEdge === null && toNode === null) {
      throw new ApiError("to_room（＋to_building）・to_event・to_edge・to_node のいずれかを指定してください");
    }
    const G = graphFromArgs(args);
    const starts = fromCandidates(spec, G);
    const dests = destCandidates(G, toRoom, toBuilding, toNode, toEvent, toEdge);

    let [path, length, startRow, destRow] = bestRoute(G, starts, dests);
    if (path === null) throw new ApiError("指定された出発点から目的地への経路が見つかりません", 404);
    [path, length] = extendToFarEndpoint(G, path, length, destRow);
    const result = pathResult(G, path, length);
    if (toEvent) result.to_event = toEvent;
    annotateFrom(spec, result, startRow);
    if (destRow) {
      if (toRoom) result.to_room = toRoom;
      result.to_edge = edgeToDict(destRow);
      applyInfo(result, toEvent ? eventDestInfo(result, toEvent, destRow) : destInfo(result, toRoom));
      if (!toRoom && !toEvent) {
        const names = String(destRow.name ?? "").split(";").filter(n => n.trim());
        if (names.length === 1) result.dest_display = firstDisplayLabel(destRow.building, names[0]);
      }
    }
    return result;
  }

  function apiShortestPath(args) {
    const start = args.int("start"), goal = args.int("goal");
    if (start === null || goal === null) throw new ApiError("start と goal のノードIDを指定してください");
    const G = graphFromArgs(args);
    if (!G.hasNode(start)) throw new ApiError(`ノード ${start} が存在しません`, 404);
    if (!G.hasNode(goal)) throw new ApiError(`ノード ${goal} が存在しません`, 404);
    const [path, length] = bestRoute(G, [[start, null]], [[goal, null]]);
    if (path === null) throw new ApiError(`ノード ${start} から ${goal} への経路が見つかりません`, 404);
    return pathResult(G, path, length);
  }

  // ---------------- routes/facilities.py
  const routeToFacility = (G, starts, facilityEdges, noPathError) => {
    const dests = candidatesFromEdges(G, facilityEdges);
    let [path, length, startRow, destRow] = bestRoute(G, starts, dests, false);
    if (path === null) throw new ApiError(noPathError, 404);
    [path, length] = extendToFarEndpoint(G, path, length, destRow);
    return [pathResult(G, path, length), startRow, destRow];
  };
  const namesIn = row => String(row.name).split(";").map(n => n.trim());

  function apiNearestToilet(args) {
    const toiletType = args.str("type", "all").toUpperCase();
    const spec = fromSpec(args);
    requireFrom(spec);
    const targets = hasOwn(TOILET_TYPE_MAP, toiletType) ? TOILET_TYPE_MAP[toiletType] : TOILET_TYPE_MAP.ALL;
    const G = graphFromArgs(args);
    const starts = fromCandidates(spec, G);
    const toiletEdges = edgesByNames(targets);
    if (!toiletEdges.length) throw new ApiError("該当するトイレがデータ内に見つかりません", 404);
    const [result, startRow, row] = routeToFacility(G, starts, toiletEdges,
      "指定された出発点から該当するトイレへの経路が見つかりません");
    const tNames = namesIn(row);
    const foundKey = TOILET_TYPE_MAP.ALL.find(t => tNames.includes(t)) || "";
    result.toilet_type = foundKey ? foundKey.split("_")[0] : "";
    result.toilet_name = foundKey;
    result.toilet_label = hasOwn(TOILET_LABEL, foundKey) ? TOILET_LABEL[foundKey] : "トイレ";
    result.toilet_building = row.building;
    result.toilet_floor = row.floor;
    result.toilet_edge = edgeToDict(row);
    applyInfo(result, destInfo(result, foundKey));
    annotateFrom(spec, result, startRow);
    return result;
  }

  function apiNearestCafeteria(args) {
    const spec = fromSpec(args);
    requireFrom(spec);
    const cafeteriaNames = data.cafeteria_names;
    if (!cafeteriaNames.length) throw new ApiError("cafeteria_edge.csv が見つかりません", 500);
    const cafName = args.str("name", "all");
    const targets = cafName !== "all" ? [cafName] : cafeteriaNames;
    const G = graphFromArgs(args);
    const starts = fromCandidates(spec, G);
    const cafEdges = edgesByNames(targets);
    if (!cafEdges.length) throw new ApiError("食堂エッジがデータ内に見つかりません", 404);
    const [result, startRow, row] = routeToFacility(G, starts, cafEdges, "食堂への経路が見つかりません");
    const matched = targets.find(t => namesIn(row).includes(t)) || "";
    result.cafeteria_building = row.building;
    result.cafeteria_floor = row.floor;
    result.cafeteria_edge = edgeToDict(row);
    applyInfo(result, destInfo(result, matched));
    annotateFrom(spec, result, startRow);
    return result;
  }

  function apiNearestFacility(args) {
    const category = args.str("category");
    if (!category) throw new ApiError("category（設備の種類）を指定してください");
    const spec = fromSpec(args);
    requireFrom(spec);
    const facilities = data.facilities.filter(f => f.category === category);
    if (!facilities.length) throw new ApiError(`「${category}」は facility.csv に登録されていません`, 404);
    const byName = new Map(facilities.map(f => [f.name, f]));
    const G = graphFromArgs(args);
    const starts = fromCandidates(spec, G);
    const facilityEdges = edgesByNames([...byName.keys()]);
    if (!facilityEdges.length) throw new ApiError(`「${category}」のエッジがデータ内に見つかりません`, 404);
    const [result, startRow, row] = routeToFacility(G, starts, facilityEdges, `「${category}」への経路が見つかりません`);
    const matched = [...byName.keys()].find(n => namesIn(row).includes(n)) || "";
    result.facility_category = category;
    result.facility_name = matched;
    result.facility_display = matched ? byName.get(matched).display_name : category;
    result.facility_building = row.building;
    result.facility_floor = row.floor;
    result.facility_edge = edgeToDict(row);
    applyInfo(result, destInfo(result, matched));
    annotateFrom(spec, result, startRow);
    return result;
  }

  // ---------------- routes/rooms.py の /api/edges（埋め込みマップが通路を引くのに使う）
  const edgePlace = (row, labelName = null) => {
    const names = String(row.name || "").split(";").map(n => n.trim()).filter(Boolean);
    if (labelName === null && names.length === 1) labelName = names[0];
    return {
      id: row.id, building: row.building, floor: row.floor, from: row.from, to: row.to,
      type: row.type, length: num(row.length), name: String(row.name || ""),
      display: labelName ? firstDisplayLabel(row.building, labelName) : "",
    };
  };

  function apiEdges(args) {
    const edgeId = args.int("id");
    const name = args.str("name");
    const building = args.int("building");
    if (edgeId !== null) return [edgePlace(edgeOr404(edgeId))];
    if (!name) throw new ApiError("id か name を指定してください");
    const result = [];
    for (const [key, rows] of roomIndex) {
      const [n, b] = key.split("\u0000");
      if (n !== name || (building !== null && Number(b) !== building)) continue;
      for (const row of rows) result.push(edgePlace(row, name));
    }
    return result;
  }

  const HANDLERS = {
    "/api/edges": apiEdges,
    "/api/route": apiRoute,
    "/api/shortest_path": apiShortestPath,
    "/api/nearest_toilet": apiNearestToilet,
    "/api/nearest_cafeteria": apiNearestCafeteria,
    "/api/nearest_facility": apiNearestFacility,
  };

  /**
   * API と同じ問い合わせに答える。
   * @param {string} path  "/api/route" など
   * @param {URLSearchParams|{get(name:string):string|null}} params  クエリ
   * @returns {{status:number, body:object}}  Flask の API と同じ status と JSON
   */
  function handle(path, params) {
    const handler = hasOwn(HANDLERS, path) ? HANDLERS[path] : null;
    if (!handler) return { status: 404, body: { error: `${path} はありません` } };
    try {
      return { status: 200, body: handler(argsReader(params)) };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
      throw err;
    }
  }

  return { handle, paths: Object.keys(HANDLERS) };
}
