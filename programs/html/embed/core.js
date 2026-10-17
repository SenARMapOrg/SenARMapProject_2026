// ================================================================
// embed/core.js
// 埋め込みフロアマップ（/embed/）の、画面に触らない計算部分。
// URLパラメータの読み取り・教室の特定・経路を「階ごとの区間」に分ける処理・案内文。
// トップレベルでは宣言しかしないので、テスト（programs/html/tests/test_embed.py）から Node の vm で読める。
// ================================================================

const EMBED_SITE = "https://iku-navi.net";

// 階段など、階を移る区間の種類（edge.csv の type）。ナビ画面（navi/script/voice.js）と同じ
const EMBED_VERTICAL_LABELS = { "2": "階段", "3": "エスカレーター", "4": "エレベーター", "5": "エスカレーター", "6": "エスカレーター" };
const EMBED_ENTRANCE_TYPE = "7";   // 建物の入口（屋内と屋外をつなぐ距離0の区間）

/**
 * URLパラメータ → 表示する内容。
 *   道案内:       from(+from_bldg) か from_event と、to(+to_bldg) か to_event
 *   教室の場所:   room(+bldg)。出発地の無い to(+to_bldg) も同じ扱い
 *   フロアマップ: bldg(+floor)
 *   共通:         elevator=0（エレベーターを使わない）・header=0（上の帯を出さない）・floors=0（階の切り替えを出さない）
 * 号館（_bldg）は、教室名が1つの号館にしか無ければ省略できる。
 */
function parseEmbedParams(search) {
  const q = new URLSearchParams(search || "");
  const text = key => (q.get(key) || "").trim();
  const int = key => {
    const v = text(key);
    return /^-?\d+$/.test(v) ? Number(v) : null;
  };
  const from = { room: text("from"), bldg: int("from_bldg") ?? int("from_building"), event: text("from_event") };
  const to   = { room: text("to"),   bldg: int("to_bldg")   ?? int("to_building"),   event: text("to_event") };
  const opts = {
    elevator: text("elevator") !== "0",
    header:   text("header") !== "0",
    floors:   text("floors") !== "0",
  };
  const hasFrom = Boolean(from.room || from.event);
  const hasTo   = Boolean(to.room || to.event);

  if (hasFrom && hasTo) return { view: "route", from, to, ...opts };
  if (text("room") || (hasTo && to.room)) {
    return { view: "room", room: text("room") || to.room, bldg: text("room") ? int("bldg") ?? int("building") : to.bldg, ...opts };
  }
  if (hasTo && to.event) return { view: "error", message: "展示までの道案内には、出発地（from か from_event）も指定してください", ...opts };
  if (int("bldg") != null || int("building") != null) {
    return { view: "floor", bldg: int("bldg") ?? int("building"), floor: int("floor"), ...opts };
  }
  return { view: "empty", ...opts };
}

/**
 * 教室名（API用の生の名前か表示名）と号館から教室を1つに決める。
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

/** 同じ内容を IKU NAVI のナビ画面で開くURL（埋め込みの「IKU NAVI で開く」） */
function fullNaviUrl(p) {
  const q = new URLSearchParams();
  if (p.view === "route") {
    if (p.from.event) q.set("from_event", p.from.event);
    else { q.set("from", p.from.room); if (p.from.bldg != null) q.set("from_bldg", p.from.bldg); }
    if (p.to.event) q.set("to_event", p.to.event);
    else { q.set("to", p.to.room); if (p.to.bldg != null) q.set("to_bldg", p.to.bldg); }
    if (!p.elevator) q.set("elevator", "0");
    return `${EMBED_SITE}/navi/?${q}`;
  }
  if (p.view === "room") {
    q.set("to", p.room);
    if (p.bldg != null) q.set("to_bldg", p.bldg);
    return `${EMBED_SITE}/navi/?${q}`;
  }
  if (p.view === "floor" && p.bldg != null) {
    return `${EMBED_SITE}/campus/${p.bldg}/${p.floor != null ? `#floor-${p.floor}` : ""}`;
  }
  return `${EMBED_SITE}/navi/`;
}

/**
 * 親ページから postMessage で受け取った表示指定を、URLのクエリ文字列にする。
 * 文字列・数値・真偽値の値だけを受け付け、知らないキーは捨てる。
 */
const EMBED_PARAM_KEYS = ["from", "from_bldg", "from_event", "to", "to_bldg", "to_event", "room", "bldg", "floor", "elevator", "header", "floors"];
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
