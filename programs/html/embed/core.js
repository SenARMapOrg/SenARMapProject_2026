// ================================================================
// embed/core.js
// 埋め込みフロアマップ（/embed/）の、画面に触らない計算部分。
// URLパラメータの読み取り・場所（教室・通路・地点）の特定・経路を「階ごとの区間」に分ける処理・案内文。
// トップレベルでは宣言しかしないので、テスト（programs/html/tests/test_embed.py）から Node の vm で読める。
// ================================================================

const EMBED_SITE = "https://iku-navi.net";

// 階段など、階を移る区間の種類（edge.csv の type）。ナビ画面（navi/script/voice.js）と同じ
const EMBED_VERTICAL_LABELS = { "2": "階段", "3": "エスカレーター", "4": "エレベーター", "5": "エスカレーター", "6": "エスカレーター" };

// グローバルID = 建物 × ID_OFFSET ＋ CSV の id（屋外のノードは GLOBAL_NODE_OFFSET ＋ id、屋外のエッジは id のまま）。
// programs/3D_Graph/ikunavi/config.py と同じ値
const EMBED_ID_OFFSET = 100000;
const EMBED_GLOBAL_NODE_OFFSET = 9000000;

/** edge.csv の id（と号館）→ グローバルなエッジID。号館が無いか、id が既にグローバルならそのまま */
function globalEdgeId(id, bldg) {
  if (bldg == null || bldg === 0 || id >= EMBED_ID_OFFSET) return id;
  return bldg * EMBED_ID_OFFSET + id;
}

/** node.csv の id（と号館）→ グローバルなノードID。号館が無いか、id が既にグローバルならそのまま */
function globalNodeId(id, bldg) {
  if (bldg == null || id >= EMBED_ID_OFFSET) return id;
  return bldg === 0 ? EMBED_GLOBAL_NODE_OFFSET + id : bldg * EMBED_ID_OFFSET + id;
}

/**
 * 場所の指定を1つ読む。prefix は ""（表示する場所）・"from"（出発地）・"to"（目的地）。
 *   教室・名前の付いた場所: room（from・to はキー名そのものでもよい）。トイレ（M_Toilet）など教室一覧に出ない名前も指定できる
 *   通路:                   edge（edge.csv の id ＋ bldg、またはグローバルなエッジID）
 *   地点:                   node（node.csv の id ＋ bldg、またはグローバルなノードID）
 *   イベントの展示:         event（道順の from_event・to_event のみ）
 *   号館:                   bldg（building でもよい）
 *   表示名:                 label（地図のピンや見出しに出す名前を変える）
 * 戻り値: { room, edge, node, event, bldg, label }。何も指定が無ければ null
 */
function parsePlace(q, prefix) {
  const key = name => prefix ? `${prefix}_${name}` : name;
  const text = k => (q.get(k) || "").trim().slice(0, 100);
  const int = k => {
    const v = text(k);
    return /^\d+$/.test(v) ? Number(v) : null;
  };
  const place = {
    room:  (prefix ? text(prefix) : "") || text(key("room")),
    edge:  int(key("edge")),
    node:  int(key("node")),
    event: prefix ? text(key("event")) : "",
    bldg:  int(key("bldg")) ?? int(key("building")),
    label: text(key("label")),
  };
  return place.room || place.edge != null || place.node != null || place.event ? place : null;
}

/**
 * URLパラメータ → 表示する内容。
 *   道順:         出発地（from_*）と目的地（to_*）の両方
 *   場所:         room・edge・node のどれか（＋bldg）。出発地の無い目的地（to_*）も同じ扱い
 *   フロアマップ: bldg（＋floor）
 *   共通:         elevator=0（エレベーターを使わない）・header=0（上の帯を出さない）・floors=0（階の切り替えを出さない）
 * 教室名は、1つの号館にしか無ければ号館を省略できる。
 */
function parseEmbedParams(search) {
  const q = new URLSearchParams(search || "");
  const text = key => (q.get(key) || "").trim();
  const opts = {
    elevator: text("elevator") !== "0",
    header:   text("header") !== "0",
    floors:   text("floors") !== "0",
  };
  const from = parsePlace(q, "from"), to = parsePlace(q, "to"), place = parsePlace(q, "");

  if (from && to) return { view: "route", from, to, ...opts };
  if (place) return { view: "place", place, ...opts };
  if (to && !to.event) return { view: "place", place: to, ...opts };
  if (to || from) return { view: "error", message: "道順には、出発地（from・from_edge など）と目的地（to・to_edge など）の両方を指定してください", ...opts };
  const bldg = /^\d+$/.test(text("bldg") || text("building")) ? Number(text("bldg") || text("building")) : null;
  if (bldg != null) {
    const floor = /^-?\d+$/.test(text("floor")) ? Number(text("floor")) : null;
    return { view: "floor", bldg, floor, ...opts };
  }
  return { view: "empty", ...opts };
}

/** 場所の指定を、/api/route の from_*・to_* に書く（room は教室を特定済みのものを渡す） */
function placeRouteParams(q, side, place, resolved) {
  if (place.event) q.set(`${side}_event`, place.event);
  else if (place.edge != null) q.set(`${side}_edge`, globalEdgeId(place.edge, place.bldg));
  else if (place.node != null) q.set(`${side}_node`, globalNodeId(place.node, place.bldg));
  else {
    q.set(`${side}_room`, resolved.room);
    q.set(`${side}_building`, resolved.building);
  }
}

/**
 * 教室名（API用の生の名前か表示名）と号館から、教室一覧（/api/all の rooms）の教室を1つに決める。
 * 戻り値: 教室 / "ambiguous"（号館が無いと決まらない） / null（見つからない）
 */
function findRoom(rooms, name, bldg) {
  if (!name) return null;
  const inBldg = r => bldg == null || r.building === bldg;
  for (const key of ["room", "display"]) {
    const hits = rooms.filter(r => r[key] === name && inBldg(r));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return "ambiguous";
  }
  return null;
}

function embedFloorLabel(floor) {
  const f = Number(floor);
  if (!Number.isFinite(f)) return `${floor}階`;
  return f <= 0 ? `地下${1 - f}階` : `${f}階`;
}

function embedBldgLabel(names, b) {
  return names[Number(b)] || (Number(b) === 0 ? "屋外" : `${b}号館`);
}

/**
 * 経路（APIの path_coords / path_edges）を、同じ建物の同じ階にいる間をひとまとまりにした区間に分ける。
 * 階段で何階も上るときに途中の階を一瞬通るだけの区間は、見せても意味が無いので飛ばす。
 * 区間: { kind: "floor"|"outdoor", building, floor, start, end（path_coords の添字。両端を含む）, length（m） }
 */
function splitRouteSegments(coords, edges) {
  const segs = [];
  let start = 0;
  for (let i = 1; i <= coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    if (b && b.building === a.building && b.floor === a.floor) continue;
    segs.push({ start, end: i - 1 });
    start = i;
  }
  const isVertical = i => Boolean(edges[i] && EMBED_VERTICAL_LABELS[String(edges[i].type)]);
  return segs
    .filter((s, k) => {
      // 1点だけの区間で、前後とも階を移る区間なら、階段の途中で通り過ぎるだけの階
      if (s.start !== s.end || k === 0 || k === segs.length - 1) return true;
      return !(isVertical(s.start - 1) && isVertical(s.start));
    })
    .map(s => {
      let length = 0;
      for (let i = s.start; i < s.end; i++) length += Number(edges[i]?.length) || 0;
      const n = coords[s.start];
      return { kind: n.building === 0 ? "outdoor" : "floor", building: n.building, floor: n.floor, start: s.start, end: s.end, length };
    });
}

/**
 * 目的地に着いたときの文。ナビ画面（navi/script/voice.js の buildNearGoalText）と同じ言い方。
 * route は /api/route のレスポンス。
 */
function arrivalText(route) {
  const side = route.dest_side;
  if (side === "right" || side === "left") {
    const sideText = side === "right" ? "右手" : "左手";
    const name = route.dest_display || "目的地";
    if (route.dest_count > 1 && route.dest_position > 1) {
      return `${name}は${sideText}、${route.dest_nearest_display}から数えて${route.dest_position}番目です`;
    }
    return `${name}は${sideText}です`;
  }
  const last = (route.path_edges || [])[route.path_edges.length - 1];
  if (last) {
    const r = last.right_display || "", l = last.left_display || "";
    if (r && !l) return "右手に目的地です";
    if (l && !r) return "左手に目的地です";
  }
  return "この通路沿いが目的地です";
}

/**
 * 区間を歩き終えたあとにすること（区間の説明の2行目）。最後の区間なら到着の文。
 * names は建物ID → 表示名。
 */
function segmentNextText(route, segs, k, names) {
  const seg = segs[k], next = segs[k + 1];
  if (!next) return arrivalText(route);
  const edge = route.path_edges[seg.end];
  const type = String(edge?.type ?? "");
  if (EMBED_VERTICAL_LABELS[type]) {
    return `${EMBED_VERTICAL_LABELS[type]}で${embedFloorLabel(next.floor)}へ`;
  }
  if (next.kind === "outdoor") return "入口から外へ出ます";
  if (seg.kind === "outdoor") return `${embedBldgLabel(names, next.building)}の入口へ`;
  if (next.building === seg.building) return `そのまま${embedFloorLabel(next.floor)}へ`;
  return `${embedBldgLabel(names, next.building)} ${embedFloorLabel(next.floor)}へ`;
}

/** 区間の見出し（「10号館 3階」「屋外」） */
function segmentTitle(seg, names) {
  if (seg.kind === "outdoor") return "屋外";
  return `${embedBldgLabel(names, seg.building)} ${embedFloorLabel(seg.floor)}`;
}

/** 歩く距離の言い方。10m 単位に丸め、短い距離は「すぐ」 */
function distanceText(m) {
  if (!(m >= 10)) return "すぐ";
  return `約${Math.round(m / 10) * 10}m`;
}

/**
 * 点の集まりが収まる viewBox。余白は幅・高さの割合（pad）で取り、小さすぎる範囲は min まで広げる。
 * 戻り値は SVG 全体（W×H）からはみ出さないように寄せる。
 */
function fitViewBox(points, W, H, { pad = 0.6, min = 500 } = {}) {
  if (!points.length) return { x: 0, y: 0, w: W, h: H };
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let w = Math.min(W, Math.max((x1 - x0) * (1 + pad), Math.min(min, W)));
  let h = Math.min(H, Math.max((y1 - y0) * (1 + pad), Math.min(min * H / W, H)));
  const x = Math.max(0, Math.min((x0 + x1) / 2 - w / 2, W - w));
  const y = Math.max(0, Math.min((y0 + y1) / 2 - h / 2, H - h));
  return { x, y, w, h };
}

/**
 * 同じ内容を IKU NAVI で開くURL（埋め込みの「IKU NAVI で開く」）。
 * ナビ画面は教室名と展示でしか呼び出せないので、通路・地点のときは建物の教室一覧（無ければナビ画面のトップ）を開く。
 */
function fullNaviUrl(p) {
  const q = new URLSearchParams();
  const byName = pl => pl && pl.edge == null && pl.node == null;
  if (p.view === "route" && byName(p.from) && byName(p.to)) {
    for (const [side, pl] of [["from", p.from], ["to", p.to]]) {
      if (pl.event) q.set(`${side}_event`, pl.event);
      else { q.set(side, pl.room); if (pl.bldg != null) q.set(`${side}_bldg`, pl.bldg); }
    }
    if (!p.elevator) q.set("elevator", "0");
    return `${EMBED_SITE}/navi/?${q}`;
  }
  if (p.view === "place" && byName(p.place)) {
    q.set("to", p.place.room);
    if (p.place.bldg != null) q.set("to_bldg", p.place.bldg);
    return `${EMBED_SITE}/navi/?${q}`;
  }
  const bldg = p.view === "floor" ? p.bldg : p.view === "place" ? p.place.bldg : null;
  if (bldg) return `${EMBED_SITE}/campus/${bldg}/${p.view === "floor" && p.floor != null ? `#floor-${p.floor}` : ""}`;
  return `${EMBED_SITE}/navi/`;
}

/**
 * 親ページから postMessage で受け取った表示指定を、URLのクエリ文字列にする。
 * 文字列・数値・真偽値の値だけを受け付け、知らないキーは捨てる。
 */
const EMBED_PLACE_KEYS = ["room", "edge", "node", "bldg", "building", "label"];
const EMBED_PARAM_KEYS = [
  "from", "from_event", "to", "to_event",
  ...EMBED_PLACE_KEYS, ...EMBED_PLACE_KEYS.map(k => `from_${k}`), ...EMBED_PLACE_KEYS.map(k => `to_${k}`),
  "floor", "elevator", "header", "floors",
];
function messageToSearch(params) {
  const q = new URLSearchParams();
  if (!params || typeof params !== "object") return "";
  for (const key of EMBED_PARAM_KEYS) {
    let v = params[key];
    if (typeof v === "boolean") v = v ? "1" : "0";
    if (typeof v === "number" && Number.isFinite(v)) v = String(v);
    if (typeof v === "string" && v.trim() && v.length <= 100) q.set(key, v.trim());
  }
  return `?${q}`;
}
