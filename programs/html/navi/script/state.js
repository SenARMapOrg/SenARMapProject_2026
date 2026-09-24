// ================================================================
// state.js
// 設定値・全スクリプト共有の状態・矢印画像のプリフェッチ。
// 他のスクリプトより先に読み込むこと（ここで宣言した定数・変数を全員が参照する）。
// ================================================================

// ================================================================
// State
// ================================================================
// ローカル開発（nginx/Flask 同居）では同一オリジン、本番（Cloudflare Pages）では api サブドメインへ
const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://api.iku-navi.net";

// イベントモード: navi/?event=1 で有効化。
// event.csv に登録されたイベント名（屋台など）を検索候補に加え、イベント名でルート検索できる。
const EVENT_MODE = new URLSearchParams(location.search).get("event") === "1";
// 経路の線・ドットなど、CSS(var(--accent))を参照できないJS描画箇所で使うアクセントカラー
const ACCENT_COLOR = EVENT_MODE ? "#EA580C" : "#3B82F6";
if (EVENT_MODE) {
  document.body.classList.add("event-mode");
  document.getElementById("event-badge").style.display = "inline-flex";
  ["from-input", "to-input", "to-input-gps", "fac-from-input"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.placeholder = "教室名・屋台名";
  });
}

let map;
let mapReady = false;
let _pendingMapCallback = null;

// Google Maps 読み込み完了(initMap)前に地図操作が必要な処理が来た場合は、
// 読み込み完了まで保留してから実行する（教室一覧の表示自体はMapsを待たず即座に行うため）。
function runWhenMapReady(fn) {
  if (mapReady) fn();
  else _pendingMapCallback = fn;
}

function waitForMapReady() {
  return new Promise(resolve => runWhenMapReady(resolve));
}

let searchMode    = "room";
let facSearchMode = "room";
let gpsCoords     = null;
let facGpsCoords  = null;
let allNodes   = [];
let allRooms   = [];        // [{room, display, building, isEvent?}, ...] roomはAPI用の生の名前、displayは表示名
let roomsByBuilding = {};   // {"10": ["101A", ...], ...}
let buildingNames = {};     // {10: "10号館", ...} data/building_name.csv 由来（未登録は "{id}号館"）

let pathCoords  = [];
let pathEdges   = [];  // path_coords[i]→[i+1] に対応する区間情報（type/length/name）。音声案内に使う
let destSide    = "";  // APIが指定した目的地そのものの左右("right"/"left"/"")。dest_side未対応のレスポンスでは""
let destPosition = null;        // その側の教室のうち、手前から数えて何番目か(1始まり)
let destCount     = null;       // その側にある教室の総数
let destDisplay   = "";         // 目的地そのものの表示名
let destNearestDisplay = "";    // 一番手前(先頭)の教室の表示名
let currentStep = 0;

let outdoorPolylines = [];
let stepMarker       = null;
let gpsMarker        = null;
let gpsCircle        = null;

let svgBuilding    = null;
let svgFloor       = null;
let svgOverlay     = null;
let svgOrigViewBox = null;
let svgViewW       = 1400;
let svgViewH       = 1000;

let edgeImages  = {};
let imgByStep = {};  // step_index → <img> DOM element
let svgCache      = {};  // `${building}_${floor}` → SVG text or null (prefetched)
let arrowBlobUrls = {};  // "straight"|"right"|"left" → blob: URL (prefetched)

// ================================================================
// 方向矢印: 閾値設定（後から変更しやすいように定数で管理）
// ================================================================
// 直進と判定する折れ角の上限（絶対値）: 単位は度
// ±STRAIGHT_THRESHOLD_DEG 以内なら直進、それ以上なら左右折とみなす。
// 人間計測データのブレ（廊下直進でも±10〜15度は発生）を考慮すること。
// 推奨範囲: 30（厳しめ） 〜 60（ゆるめ）
const STRAIGHT_THRESHOLD_DEG = 45;  // ← この値を調整してください
// ================================================================

const ARROW_URL = {
  straight: "https://cdn.iku-navi.net/Straight.png",
  right:    "https://cdn.iku-navi.net/right.png",
  left:     "https://cdn.iku-navi.net/left.png",
};

// 矢印画像をblob URLとして事前取得（オフライン時でも表示できるようにメモリに保持）
async function prefetchArrowImages() {
  await Promise.allSettled(
    Object.entries(ARROW_URL).map(async ([key, url]) => {
      try {
        const res = await fetch(url);
        if (res.ok) arrowBlobUrls[key] = URL.createObjectURL(await res.blob());
      } catch {}
    })
  );
}
