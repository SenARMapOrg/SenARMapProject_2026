// ================================================================
// AR Outdoor Integration
// Three.js + カメラ + ジャイロ を #ar-area 内で動かす。
// 屋外ステップ到達時に arShowView()、屋内に戻ったら arHideView() を呼ぶ。
// ================================================================
const AR_THREE_CDN  = "https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js";
const AR_EYE_HEIGHT = 1.6;
const AR_NODE_R     = 0.5;
const AR_EDGE_R     = 0.12;
const AR_NODE_COLOR = 0x22D3EE;
const AR_EDGE_COLOR = 0x3B82F6;
const AR_CAMERA_FOV = 65;
const AR_TILT_DEG   = 5;

// --- 屋外ARの精度 ---
// 端末のコンパスは「磁北」基準だが、地図（緯度経度）は「真北」基準。生田キャンパス付近では磁北が真北より
// 約7.6度西にずれている（国土地理院の地磁気の偏角）。補正しないと、50m先の目印が横に約6.6mずれる。
const AR_MAG_DECLINATION_DEG = 7.6;
// コンパスの細かな揺れを抑える強さ（1フレームごとに新しい値をどれだけ取り入れるか。小さいほど滑らかで遅れる）
const AR_HEADING_SMOOTHING = 0.2;
// これより精度の悪い（±何mの）位置は使わない。建物の陰などで大きく外れた位置で目印が飛ぶのを防ぐ
const AR_GPS_MAX_ACCURACY = 35;
// 位置のなめらかさの調整（歩く速さで1秒あたりに動きうる位置のばらつき、m²/秒）
const AR_GPS_WALK_VARIANCE = 2.0;
// 予測から大きく外れた位置が何回続いたら、外れ値ではなく本当に移動したとみなすか
const AR_GPS_MAX_OUTLIERS = 3;
// なめらかにした位置が今の区間の線からこれ以内（m）なら、線の上に寄せて目印を置く（道から外れて見えないように）
const AR_SNAP_MAX_M = 15;

// --- 歩いた向きでのコンパスの補正 ---
// コンパスは鉄骨の建物などの近くで10〜30度狂う。経路に沿ってまっすぐ歩いているときは、カメラも経路の向きを
// 向いているはずなので、その差をコンパスのずれとして覚え、カメラの向きから引く。
const AR_HEADING_MIN_WALK_M = 12;     // これだけまっすぐ歩いたら補正する
const AR_HEADING_WINDOW_MS  = 20000;  // 何ミリ秒前までの位置を使うか
const AR_HEADING_MAX_BEND_M = 3;      // 歩いた線からこれ以上外れた位置があれば、まっすぐではないとみなす
const AR_HEADING_ROUTE_TOL  = 25;     // 歩いた向きと経路の向きの差がこれ以内（度）なら、経路に沿って歩いたとみなす
const AR_HEADING_MAX_OFFSET = 45;     // これより大きいずれ（度）は、横を見ながら歩いていたとみなして使わない
const AR_HEADING_LEARN      = 0.3;    // 新しく求めたずれをどれだけ取り入れるか

// --- 目印を出す範囲 ---
// 今のステップから何区間先までの経路を出すか（距離で絞ると、地点の間が長い屋外では1区間しか出なくなるため、区間の数で決める）
const AR_VISIBLE_STEPS = 5;
// 区間の線を何mごとに分けて置くか（長い区間でも、範囲の外の部分だけを隠せるように）
const AR_EDGE_CHUNK_M = 5;

// --- 屋外ステップの自動送り ---
// 次の地点を「通過した」と判定された位置が何回続いたら次のステップへ進むか（1回だけの揺れで進まないように）
const AR_AUTO_CONFIRM = 2;
// ボタンで手動でステップを動かしたあと、自動送りを止めておく時間（戻した直後に勝手に進み直さないように）
const AR_MANUAL_PAUSE_MS = 15000;

// --- GPS が取れなくなったときの案内 ---
// 屋外ARを出してから、使える位置（精度 AR_GPS_MAX_ACCURACY 以内）がこの時間（ミリ秒）届かなければ、
// 自動送りでは進めないので、右の矢印で手順を進めるよう画面に出す
const AR_GPS_LOST_MS = 15000;

let arPermissionsRequested = false;
let arCamWanted      = false;  // カメラストリームを保持してよいか（解放後の遅延取得を防ぐ）
let arCamRequesting  = false;  // getUserMedia 実行中フラグ（二重取得を防ぐ）
let arOrientAttached = false;
let arHaveAbsolute   = false;
let arGOrient        = null;

let arStream       = null;
let arRenderer     = null;
let arScene3       = null;
let arCamera3      = null;
let arWorldGroup   = null;
let arRefLat       = null;
let arRefLng       = null;
let arUserLat      = null;
let arUserLng      = null;
let arGpsWatchId   = null;
let arRunning      = false;
let arBooting      = false;
let arMarkersBuilt = false;

let arGpsFilter       = null;  // 位置のなめらか化の状態（arFilterGpsFix 参照）
let arHeadingSmoothed = null;  // なめらかにした向き（度、alpha と同じ向き）
let arAutoConfirmed   = 0;     // 「通過した」と判定された位置が続いた回数
let arAutoPausedUntil = 0;     // この時刻（ミリ秒）までは自動送りしない
let arHeadingTrack    = [];    // 補正用に覚えておく最近の位置とカメラの向き（arLearnHeading 参照）
let arHeadingOffset   = 0;     // コンパスのずれの推定（度。方位＝時計回りで「真の方位 − コンパスの方位」）
let arViewActive      = false; // 屋外のステップでARを出しているか（arShowView〜arHideView）
let arViewShownAt     = 0;     // ARを出した時刻（ミリ秒）
let arGoodFixAt       = 0;     // 最後に使える位置が届いた時刻（ミリ秒）
let arGpsDenied       = false; // 位置情報の利用が許可されていない
let arGpsLostTimer    = null;

let _arMeshes = [];   // { mesh, mat, type: "node"|"edge", idx, x, z } — ステップごとの色・範囲による表示の切り替え

let _arZee, _arEuler, _arQ0, _arQ1;

function arLoadThree() {
  return new Promise((resolve, reject) => {
    if (typeof THREE !== "undefined") { resolve(); return; }
    const s = document.createElement("script");
    s.src = AR_THREE_CDN;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function arAttachOrientation() {
  if (arOrientAttached) return;
  arOrientAttached = true;
  const onAbsolute = (e) => {
    if (e.alpha == null) return;
    arHaveAbsolute = true;
    arGOrient = e;
  };
  const onRelative = (e) => {
    if (arHaveAbsolute && typeof e.webkitCompassHeading !== "number") return;
    arGOrient = e;
  };
  window.addEventListener("deviceorientationabsolute", onAbsolute);
  window.addEventListener("deviceorientation",         onRelative);
}

// 検索ボタン押下（ユーザー操作コンテキスト）で呼ぶ。
// iOS の DeviceOrientationEvent.requestPermission は同期的に
// ユーザー操作内で呼ばないと許可ダイアログが出ないため、ここで先取りする。
// カメラはこの時点では取得しない（ルート確定後、屋外AR区間がある場合のみ
// arPrefetchCameraIfNeeded() で取得する）。
function arRequestPermissionsEarly() {
  if (arPermissionsRequested) return;
  arPermissionsRequested = true;

  // Three.js を並行ロード（画面切り替え時のもたつきを減らす）
  arLoadThree().catch(() => {});

  // iOS 向け向きセンサー許可（ユーザー操作コンテキスト内で同期呼び出し必須）
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === "granted") arAttachOrientation(); })
      .catch(() => {});
  } else {
    arAttachOrientation();
  }
}

// ルートに屋外AR区間が含まれる場合のみ、GPS の取得を始め、カメラを先取りしてストリームを温める。
// 屋内のみのルートではカメラを一切起動しない。initRoute() から呼ばれる。
function arPrefetchCameraIfNeeded() {
  let hasOutdoorAR = false;
  for (let i = 0; i < pathCoords.length - 1; i++) {  // 最終ステップは到着画面なのでAR不要
    const n = pathCoords[i];
    if (n && n.building === 0 && n.lat != null) { hasOutdoorAR = true; break; }
  }
  if (!hasOutdoorAR) return;

  // GPS は、つかみ始めの位置の精度が悪いので、屋外に出る前（経路を出した時点）から取り続けておく
  arStartGpsWatch();
  arCamWanted = true;
  if (arStream || arCamRequesting) return;
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
  arCamRequesting = true;
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then(stream => {
      arCamRequesting = false;
      // 取得完了前に解放済みならすぐ止める
      if (!arCamWanted) { stream.getTracks().forEach(t => t.stop()); return; }
      arStream = stream;
    })
    .catch(() => { arCamRequesting = false; });
}

function arEnsureRenderer() {
  if (arRenderer || typeof THREE === "undefined") return;

  const canvas = document.getElementById("ar-gl-canvas");
  arRenderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  arRenderer.setClearColor(0x000000, 0);

  arScene3 = new THREE.Scene();
  arCamera3 = new THREE.PerspectiveCamera(AR_CAMERA_FOV, 1, 0.1, 5000);
  arCamera3.position.set(0, AR_EYE_HEIGHT, 0);

  arWorldGroup = new THREE.Group();
  arScene3.add(arWorldGroup);
  arScene3.add(new THREE.AmbientLight(0xffffff, 1.0));

  _arZee  = new THREE.Vector3(0, 0, 1);
  _arEuler = new THREE.Euler();
  _arQ0   = new THREE.Quaternion();
  _arQ1   = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

  window.addEventListener("resize",            arResizeCanvas);
  window.addEventListener("orientationchange", () => setTimeout(arResizeCanvas, 300));
  arResizeCanvas();
}

function arResizeCanvas() {
  if (!arRenderer || !arCamera3) return;
  const area = document.getElementById("ar-area");
  if (!area) return;
  const w = area.clientWidth, h = area.clientHeight;
  if (!w || !h) return;
  arRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  arRenderer.setSize(w, h, false);
  arCamera3.aspect = w / h;
  arCamera3.updateProjectionMatrix();
}

function arEnuFromRef(lat, lng) {
  const north = (lat - arRefLat) * 111320;
  const east  = (lng - arRefLng) * 111320 * Math.cos(arRefLat * Math.PI / 180);
  return { east, north };
}

function arUpdateWorldPosition(lat, lng) {
  if (arRefLat == null || !arWorldGroup) return;
  const { east, north } = arEnuFromRef(lat, lng);
  arWorldGroup.position.set(-east, 0, north);
}

// ================================================================
// 屋外の位置のなめらか化
// GPSの位置は1回ごとに数m揺れ、建物の陰では数十m外れることもある。そのまま使うとARの目印が飛び回り、
// 自動送りも誤って進んでしまうため、精度（±m）で重みを付けて前回までの位置と混ぜる（簡単なカルマンフィルタ）。
//   - 精度の良い位置ほど強く、悪い位置ほど弱く取り入れる
//   - 精度が AR_GPS_MAX_ACCURACY より悪い位置は使わない
//   - 予測から大きく外れた位置は外れ値として捨てる。AR_GPS_MAX_OUTLIERS 回続いたら本当に移動したとみなす
// 状態はメートル単位（最初の位置の緯度で東西の縮尺を決める）で持つ。
// ================================================================
const AR_METERS_PER_DEG = 111320;

/**
 * 位置を1つ取り入れて、新しい状態を返す（引数の状態は書き換えない）。
 * 使わなかった位置のときは accepted: false を返す（state はそのまま、または外れ値の回数だけ増える）。
 */
function arFilterGpsFix(state, lat, lng, accuracy, timeMs) {
  if (!(accuracy > 0) || accuracy > AR_GPS_MAX_ACCURACY) return { state, accepted: false };
  if (!state) {
    const lat0 = lat;
    const kx = AR_METERS_PER_DEG * Math.cos(lat0 * Math.PI / 180);
    return {
      state: { lat0, kx, east: lng * kx, north: lat * AR_METERS_PER_DEG,
               variance: accuracy * accuracy, timeMs, outliers: 0 },
      accepted: true,
    };
  }
  const east  = lng * state.kx;
  const north = lat * AR_METERS_PER_DEG;
  const dt = Math.max(0, (timeMs - state.timeMs) / 1000);
  const predicted = state.variance + AR_GPS_WALK_VARIANCE * dt;  // 前回から歩いて動きうる分だけ不確かさが増える
  const measured  = accuracy * accuracy;
  const gap = Math.hypot(east - state.east, north - state.north);

  // 予測と今回の位置の、両方のばらつきから考えてありえないほど離れていれば外れ値
  if (gap > 3 * Math.sqrt(predicted + measured) + 10) {
    if (state.outliers + 1 < AR_GPS_MAX_OUTLIERS) {
      return { state: { ...state, outliers: state.outliers + 1 }, accepted: false };
    }
    // 外れた位置が続いた → 本当に移動した（または前の位置が間違っていた）とみなして、今回の位置から始め直す
    return { state: { ...state, east, north, variance: measured, timeMs, outliers: 0 }, accepted: true };
  }

  const gain = predicted / (predicted + measured);
  return {
    state: {
      ...state,
      east:  state.east  + gain * (east  - state.east),
      north: state.north + gain * (north - state.north),
      variance: (1 - gain) * predicted,
      timeMs, outliers: 0,
    },
    accepted: true,
  };
}

/** なめらかにした位置（緯度経度）と、そのおおよその精度（m） */
function arFilteredPosition(state) {
  return { lat: state.north / AR_METERS_PER_DEG, lng: state.east / state.kx, accuracy: Math.sqrt(state.variance) };
}

// ================================================================
// 経路の線への吸着
// なめらかにしても位置は数mずれるので、今の区間（と前後の区間）の線から AR_SNAP_MAX_M 以内なら
// 線の上の一番近い点に寄せる。目印の位置合わせにだけ使い、自動送りの判定には寄せる前の位置を使う。
// ================================================================

/** ステップ step の前後の屋外区間を [[a, b], ...] で返す */
function arRouteSegmentsNear(step) {
  const segs = [];
  for (let i = Math.max(0, step - 1); i <= step + 1 && i < pathCoords.length - 1; i++) {
    const a = pathCoords[i], b = pathCoords[i + 1];
    if (a && b && a.building === 0 && b.building === 0 && a.lat != null && b.lat != null) segs.push([a, b]);
  }
  return segs;
}

/**
 * user（{lat, lng, accuracy}）を区間の線に寄せた位置を返す。
 * 寄せたときは snapped: true と、寄せた区間の向き bearing（度、北から時計回り）が付く。
 */
function arSnapToRoute(user, segments) {
  let best = null;
  for (const [a, b] of segments) {
    const kx = AR_METERS_PER_DEG * Math.cos(a.lat * Math.PI / 180);
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * AR_METERS_PER_DEG;
    const ux = (user.lng - a.lng) * kx, uy = (user.lat - a.lat) * AR_METERS_PER_DEG;
    const len2 = bx * bx + by * by;
    if (len2 < 0.01) continue;
    const t = Math.min(1, Math.max(0, (ux * bx + uy * by) / len2));
    const dist = Math.hypot(ux - bx * t, uy - by * t);
    if (!best || dist < best.dist) {
      best = {
        dist,
        lat: a.lat + by * t / AR_METERS_PER_DEG,
        lng: a.lng + bx * t / kx,
        bearing: (Math.atan2(bx, by) * 180 / Math.PI + 360) % 360,
      };
    }
  }
  if (!best || best.dist > AR_SNAP_MAX_M) return { ...user, snapped: false };
  return { lat: best.lat, lng: best.lng, accuracy: user.accuracy, snapped: true, bearing: best.bearing };
}

// ================================================================
// 屋外ステップの自動送り
// ステップ i は「地点 i から地点 i+1 へ向かう区間」なので、地点 i+1 を通過したらステップ i+1 に進める。
// ================================================================

/**
 * 地点 b（次の地点）を通過したか。a は今の区間の始点（屋内の出口などで座標が無ければ null）。
 *   - b の近く（精度に応じて6〜15m以内）に来た、または
 *   - a→b の向きで b より先まで進んでいて、区間の線から大きく外れていない（近くを通らずに追い越した場合）
 * 区間が短くても（数m）、b の近くに来た時点で通過とみなす。
 */
function arStepPassed(user, a, b) {
  if (!b || b.lat == null) return false;
  const kx = AR_METERS_PER_DEG * Math.cos(b.lat * Math.PI / 180);
  const toB = (p) => ({ x: (p.lng - b.lng) * kx, y: (p.lat - b.lat) * AR_METERS_PER_DEG });
  const u = toB(user);
  const radius = Math.min(15, Math.max(6, 4 + 0.6 * (user.accuracy || 0)));
  if (Math.hypot(u.x, u.y) <= radius) return true;

  if (!a || a.lat == null) return false;
  const p = toB(a);                       // b から見た a の位置
  const ab = { x: -p.x, y: -p.y };        // a→b の向き
  const len = Math.hypot(ab.x, ab.y);
  if (len < 1) return false;
  const au = { x: u.x - p.x, y: u.y - p.y };
  const along = (au.x * ab.x + au.y * ab.y) / (len * len);       // 0 = a、1 = b
  const cross = Math.abs(ab.x * au.y - ab.y * au.x) / len;        // 区間の線からの離れ具合（m）
  return along >= 1 && cross <= Math.max(12, user.accuracy || 0);
}

/** 位置が更新されるたびに呼ぶ。屋外の区間で次の地点を通過していたら、次のステップへ進める */
function arCheckAutoAdvance(user) {
  if (Date.now() < arAutoPausedUntil) return;
  const step = currentStep;
  if (step >= pathCoords.length - 2) return;   // 最後のステップ（「この辺です」）より先には進めない
  const a = pathCoords[step];
  const b = pathCoords[step + 1];
  if (!b || b.building !== 0 || b.lat == null) { arAutoConfirmed = 0; return; }  // 次が屋内なら位置で判定できない

  if (!arStepPassed(user, a && a.lat != null ? a : null, b)) { arAutoConfirmed = 0; return; }
  if (++arAutoConfirmed < AR_AUTO_CONFIRM) return;
  arAutoConfirmed = 0;
  goToStep(step + 1, { announce: true });
}

/** ボタンでステップを動かしたときに呼ぶ（route.js の prevStep / nextStep）。しばらく自動送りを止める */
function arPauseAutoAdvance() {
  arAutoConfirmed = 0;
  arAutoPausedUntil = Date.now() + AR_MANUAL_PAUSE_MS;
}

/** 新しいルートを始めるときに呼ぶ（route.js の initRoute） */
function arResetAutoAdvance() {
  arAutoConfirmed = 0;
  arAutoPausedUntil = 0;
}

// ================================================================
// GPS が取れなくなったときの案内
// 建物のそばなどで精度が悪い位置しか届かなくなると、自動送りが止まって最後まで進めなくなる。
// そのときは、右の矢印（＞）で手順を進めるよう、AR の画面に出す。使える位置がまた届いたら消す。
// ================================================================

/** GPS が取れなくなったとみなすか。shownAtMs: ARを出した時刻、goodFixAtMs: 最後に使える位置が届いた時刻 */
function arGpsLost(nowMs, shownAtMs, goodFixAtMs, denied) {
  if (denied) return true;
  return nowMs - Math.max(shownAtMs, goodFixAtMs) > AR_GPS_LOST_MS;
}

function arUpdateGpsLostNotice() {
  const el = typeof document !== "undefined" && document.getElementById("ar-gps-lost");
  if (!el) return;
  el.hidden = !(arViewActive && arGpsLost(Date.now(), arViewShownAt, arGoodFixAt, arGpsDenied));
}

function arOnGpsFix(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  const timeMs = pos.timestamp || Date.now();
  const result = arFilterGpsFix(arGpsFilter, latitude, longitude, accuracy, timeMs);
  arGpsFilter = result.state;
  arGpsDenied = false;
  if (!result.accepted) return;
  arGoodFixAt = Date.now();
  arUpdateGpsLostNotice();
  const user  = arFilteredPosition(arGpsFilter);
  const shown = arSnapToRoute(user, arRouteSegmentsNear(currentStep));
  arUserLat = shown.lat;
  arUserLng = shown.lng;
  arUpdateWorldPosition(arUserLat, arUserLng);
  arUpdateVisibility();
  arLearnHeading(arGpsFilter, shown, timeMs);
  arCheckAutoAdvance(user);
}

// ================================================================
// 向き（コンパス）の補正
// ================================================================

/**
 * DeviceOrientation の alpha（北から反時計回りの度）を、磁北基準から真北基準に直す。
 * 方位が磁北基準で取れている（absolute）ときだけ補正する。基準の無い相対的な向きには補正しない。
 * 方位（時計回り）で見ると「真の方位 = 磁気の方位 − 偏角」なので、反時計回りの alpha では偏角を足す。
 */
function arTrueNorthAlpha(alphaDeg, absolute) {
  const a = absolute ? alphaDeg + AR_MAG_DECLINATION_DEG : alphaDeg;
  return ((a % 360) + 360) % 360;
}

/** 角度を少しずつ新しい値に近づける。359度→1度のような0度をまたぐ変化でも、近い向きへ回す */
function arSmoothAngle(prevDeg, nextDeg, factor) {
  if (prevDeg == null) return nextDeg;
  const diff = ((nextDeg - prevDeg + 540) % 360) - 180;   // -180〜180 の最短の差
  return ((prevDeg + diff * factor) % 360 + 360) % 360;
}

/** to − from の最短の差（度、-180〜180） */
function arAngleDiff(to, from) {
  return ((to - from + 540) % 360) - 180;
}

/**
 * 最近の位置とカメラの向き（track: [{east, north, cam}, ...]、古い順。cam は補正前のカメラの方位）から、
 * コンパスのずれ（度、真の方位 − コンパスの方位）を求める。求められないときは null。
 *   - routeBearing（寄せた区間の向き）が無い＝経路から外れているときは求めない
 *   - 一番新しい位置まで、AR_HEADING_MIN_WALK_M 以上まっすぐ歩いた部分だけを使う（曲がる前の位置は捨てる）
 *   - 歩いた向きが経路の向きと合っていれば、経路の向きを本当の向きとみなす（GPS の歩いた向きより正確なため）
 */
function arEstimateHeadingOffset(track, routeBearing) {
  if (routeBearing == null) return null;
  for (let s = 0; s <= track.length - 3; s++) {
    const sub = track.slice(s);
    const first = sub[0], last = sub[sub.length - 1];
    const dx = last.east - first.east, dy = last.north - first.north;
    const walked = Math.hypot(dx, dy);
    if (walked < AR_HEADING_MIN_WALK_M) return null;
    const straight = sub.every(p =>
      Math.abs(dx * (p.north - first.north) - dy * (p.east - first.east)) / walked <= AR_HEADING_MAX_BEND_M);
    if (!straight) continue;   // 曲がる前の位置が混じっている → 古い位置を1つ捨ててもう一度

    const course = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    if (Math.abs(arAngleDiff(routeBearing, course)) > AR_HEADING_ROUTE_TOL) return null;
    // カメラの向きの平均（角度はそのまま平均できないので、向きのベクトルにして平均する）
    let sx = 0, sy = 0;
    for (const p of sub) { sx += Math.sin(p.cam * Math.PI / 180); sy += Math.cos(p.cam * Math.PI / 180); }
    const cam = (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
    const offset = arAngleDiff(routeBearing, cam);
    return Math.abs(offset) <= AR_HEADING_MAX_OFFSET ? offset : null;
  }
  return null;
}

/**
 * 位置が更新されるたびに、その位置とカメラの向きを覚え、コンパスのずれを少しずつ学ぶ。
 * AR を見ていて、端末を立てて持っている（カメラが前を向いている）ときだけ使う。
 */
function arLearnHeading(filterState, shown, timeMs) {
  const e = arGOrient;
  if (!arRunning || !e || arHeadingSmoothed == null || !(e.beta >= 50 && e.beta <= 130)) {
    arHeadingTrack = [];
    return;
  }
  arHeadingTrack.push({ east: filterState.east, north: filterState.north, timeMs,
                        cam: (360 - arHeadingSmoothed) % 360 });
  arHeadingTrack = arHeadingTrack.filter(p => timeMs - p.timeMs <= AR_HEADING_WINDOW_MS);
  const offset = arEstimateHeadingOffset(arHeadingTrack, shown.snapped ? shown.bearing : null);
  if (offset != null) arHeadingOffset += AR_HEADING_LEARN * (offset - arHeadingOffset);
}

/**
 * 目印 m（_arMeshes の要素）を出すか。今のステップ step から AR_VISIBLE_STEPS 区間先までを出し、通り過ぎた所は出さない。
 *   - 区間（edge）: idx が step 〜 step + AR_VISIBLE_STEPS - 1
 *   - 地点（node）: idx が step 〜 step + AR_VISIBLE_STEPS（その区間の両端）
 */
function arMarkerVisible(m, step) {
  const last = m.type === "node" ? step + AR_VISIBLE_STEPS : step + AR_VISIBLE_STEPS - 1;
  return m.idx >= step && m.idx <= last;
}

/** 今のステップの先の目印だけを出す（ステップが変わったときなどに呼ぶ） */
function arUpdateVisibility() {
  _arMeshes.forEach(m => { m.mesh.visible = arMarkerVisible(m, currentStep); });
}

// pathCoords から屋外区間のノード・エッジを Three.js シーンに配置する
function arBuildRouteMarkers() {
  if (!arWorldGroup || typeof THREE === "undefined") return;
  while (arWorldGroup.children.length) arWorldGroup.remove(arWorldGroup.children[0]);
  _arMeshes = [];

  const outdoorNodes = pathCoords.filter(
    n => n.building === 0 && n.lat != null && n.lng != null
  );
  if (!outdoorNodes.length) return;

  arRefLat = outdoorNodes[0].lat;
  arRefLng = outdoorNodes[0].lng;

  const pos       = {};
  const sphereGeo = new THREE.SphereGeometry(AR_NODE_R, 24, 16);

  outdoorNodes.forEach((n, localIdx) => {
    const globalIdx = pathCoords.indexOf(n);
    const { east, north } = arEnuFromRef(n.lat, n.lng);
    const x = east, z = -north;
    pos[n.id] = { x, z };
    const mat    = new THREE.MeshBasicMaterial({ color: AR_NODE_COLOR });
    const sphere = new THREE.Mesh(sphereGeo, mat);
    sphere.position.set(x, 0, z);
    arWorldGroup.add(sphere);
    _arMeshes.push({ mesh: sphere, mat, type: "node", idx: globalIdx, x, z });
  });

  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const a = pathCoords[i], b = pathCoords[i + 1];
    if (a.building !== 0 || b.building !== 0 || a.lat == null || b.lat == null) continue;
    const pa = pos[a.id], pb = pos[b.id];
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    // AR_EDGE_CHUNK_M ごとに分けて置き、自分から遠い部分だけを隠せるようにする
    const chunks = Math.max(1, Math.ceil(len / AR_EDGE_CHUNK_M));
    const geo = new THREE.CylinderGeometry(AR_EDGE_R, AR_EDGE_R, len / chunks, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: AR_EDGE_COLOR, transparent: true, opacity: 0.85
    });
    const dir = new THREE.Vector3(dx, 0, dz).normalize();
    for (let k = 0; k < chunks; k++) {
      const t = (k + 0.5) / chunks;
      const cyl = new THREE.Mesh(geo, mat);
      cyl.position.set(pa.x + dx * t, 0, pa.z + dz * t);
      cyl.quaternion.setFromUnitVectors(up, dir);
      arWorldGroup.add(cyl);
      _arMeshes.push({ mesh: cyl, mat, type: "edge", idx: i, x: cyl.position.x, z: cyl.position.z });
    }
  }

  if (arUserLat != null) arUpdateWorldPosition(arUserLat, arUserLng);
  arUpdateVisibility();
  arMarkersBuilt = true;
}

// 現在ステップに合わせてノード・エッジを通過済み(グレー) / これから(青) に塗り替える
function arUpdateRouteColors(step) {
  const PASSED_NODE = 0x9E9E9E;
  const AHEAD_NODE  = AR_NODE_COLOR;     // 0x22D3EE
  const PASSED_EDGE = 0x9E9E9E;
  const AHEAD_EDGE  = AR_EDGE_COLOR;     // 0x3B82F6
  const PASSED_OPACITY = 0.35;
  const AHEAD_OPACITY  = 0.85;

  _arMeshes.forEach(({ mat, type, idx }) => {
    const passed = idx < step;
    if (type === "node") {
      mat.color.setHex(passed ? PASSED_NODE : AHEAD_NODE);
    } else {
      mat.color.setHex(passed ? PASSED_EDGE : AHEAD_EDGE);
      mat.opacity = passed ? PASSED_OPACITY : AHEAD_OPACITY;
    }
  });
  arUpdateVisibility();
}

function arScreenAngle() {
  const a = screen.orientation && screen.orientation.angle;
  return ((a != null ? a : window.orientation) || 0) * Math.PI / 180;
}

function arUpdateCameraOrientation() {
  const e = arGOrient;
  if (!e || !arCamera3) return;

  let headingDeg;
  let absolute;
  if (typeof e.webkitCompassHeading === "number") {
    headingDeg = 360 - e.webkitCompassHeading;   // iOS: 磁北基準のコンパス方位
    absolute = true;
  } else {
    headingDeg = e.alpha || 0;
    absolute = arHaveAbsolute;                   // Android: deviceorientationabsolute なら磁北基準
  }
  arHeadingSmoothed = arSmoothAngle(arHeadingSmoothed, arTrueNorthAlpha(headingDeg, absolute), AR_HEADING_SMOOTHING);

  // 歩いた向きで学んだコンパスのずれを引く（方位のずれを、反時計回りの alpha に直して引く）
  const alpha  = (arHeadingSmoothed - arHeadingOffset) * Math.PI / 180;
  const beta   = ((e.beta  || 0) + AR_TILT_DEG) * Math.PI / 180;
  const gamma  = (e.gamma  || 0) * Math.PI / 180;
  const orient = arScreenAngle();

  _arEuler.set(beta, alpha, -gamma, "YXZ");
  const q = arCamera3.quaternion;
  q.setFromEuler(_arEuler);
  q.multiply(_arQ1);
  q.multiply(_arQ0.setFromAxisAngle(_arZee, -orient));
}

function arAnimate() {
  if (!arRunning) return;
  requestAnimationFrame(arAnimate);
  arUpdateCameraOrientation();
  arRenderer.render(arScene3, arCamera3);
}

// 屋外の位置の継続追跡（AR の目印の位置合わせと、ステップの自動送りに使う）。初回だけ開始する。
// AR 表示（Three.js・カメラ）が使えない端末でも自動送りは動くよう、AR の準備とは別に始める
function arStartGpsWatch() {
  if (arGpsWatchId != null || !navigator.geolocation) return;
  arGpsWatchId = navigator.geolocation.watchPosition(
    arOnGpsFix,
    (err) => {
      // 許可されていないときはすぐ案内を出す（時間切れなどは、AR_GPS_LOST_MS たてば出る）
      if (err && err.code === 1) { arGpsDenied = true; arUpdateGpsLostNotice(); }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 27000 }
  );
}

async function arShowView() {
  arStartGpsWatch();
  if (!arViewActive) {
    arViewActive = true;
    arViewShownAt = Date.now();
    arGpsLostTimer = setInterval(arUpdateGpsLostNotice, 1000);
  }
  arUpdateGpsLostNotice();
  if (arRunning || arBooting) return;
  arCamWanted = true;
  arBooting = true;

  try {
    await arLoadThree();
  } catch {
    arBooting = false;
    return;
  }
  if (!arBooting) return;

  arEnsureRenderer();

  const video = document.getElementById("ar-bg-video");
  if (!video.srcObject) {
    if (arStream) {
      video.srcObject = arStream;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia(
          { video: { facingMode: "environment" } }
        );
        if (!arBooting) { s.getTracks().forEach(t => t.stop()); return; }
        arStream = s;
        video.srcObject = s;
      } catch { /* カメラ利用不可 */ }
    }
  }
  if (!arBooting) return;

  document.getElementById("ar-bg-video").style.display = "block";
  document.getElementById("ar-gl-canvas").style.display = "block";

  if (!arMarkersBuilt) arBuildRouteMarkers();
  arResizeCanvas();

  arRunning = true;
  arBooting = false;
  arAnimate();
}

function arHideView() {
  arViewActive = false;
  if (arGpsLostTimer != null) { clearInterval(arGpsLostTimer); arGpsLostTimer = null; }
  arUpdateGpsLostNotice();
  arBooting = false;
  if (!arRunning) return;
  arRunning = false;
  document.getElementById("ar-bg-video").style.display = "none";
  document.getElementById("ar-gl-canvas").style.display = "none";
}

// カメラストリームと GPS 監視を完全に停止する。
// 再度屋外区間に入れば arShowView() が取得し直す（許可ダイアログは再表示されない）。
function arReleaseHardware() {
  arCamWanted = false;
  arHideView();
  if (arStream) {
    arStream.getTracks().forEach(t => t.stop());
    arStream = null;
  }
  const video = document.getElementById("ar-bg-video");
  if (video.srcObject) video.srcObject = null;
  if (arGpsWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(arGpsWatchId);
    arGpsWatchId = null;
  }
  // 次に屋外に出たときは、屋内にいた間の古い位置を引きずらないよう最初から始める
  arGpsFilter = null;
  arAutoConfirmed = 0;
  arHeadingTrack = [];
  arGoodFixAt = 0;
  arGpsDenied = false;
}
