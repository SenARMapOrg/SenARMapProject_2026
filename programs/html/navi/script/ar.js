// ================================================================
// AR Outdoor Integration
// Three.js + カメラ + 向きセンサー + GPS を #ar-area 内で動かす。
// 屋外ステップ到達時に arShowView()、屋内に戻ったら arHideView() を呼ぶ。
//
// 2つの動かし方がある。
//   - 通常モード（すべての端末）: カメラ映像の上に、向きセンサーと GPS で位置を合わせた 3D の目印を重ねる。
//   - 高精度モード（WebXR の immersive-ar が使える端末＝主に Android の Chrome）: 端末が映像から
//     自分の動きを追う（ARCore）ので、目印が地面に貼り付いたまま揺れない。地図との位置合わせは、
//     歩いた軌跡と GPS の軌跡を重ね合わせて求める（arFitAlignment）。ボタンを押したときだけ使う。
//
// ずれを減らすための仕組み（それぞれの関数の説明を参照）
//   1. 画角を映像に合わせる（arVerticalFov）: 画面に映っている映像の範囲と 3D の画角をそろえる
//   2. 向きはジャイロで動かし、コンパスはゆっくり補正するだけに使う（arFeedCompass）
//   3. GPS はなめらかにし（arFilterGpsFix）、経路の線に寄せる（arSnapToRoute）
//   4. 経路に沿って歩いた向きでコンパスのずれを学ぶ（arEstimateHeadingOffset）
//   5. 残ったずれは、画面を左右になぞって手で合わせられる（arOnSwipe）
// ================================================================
const AR_THREE_CDN  = "https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js";
const AR_EYE_HEIGHT = 1.5;    // 通常モードで、スマホを持つ高さ（m）。目印は地面（高さ0）に置く
const AR_EDGE_COLOR = 0x3B82F6;
const AR_BEACON_COLOR = 0xF59E0B;  // 次に向かう地点の柱と、残りの距離の札の色

// --- 見やすさ ---
const AR_PATH_WIDTH     = 1.2;   // 地面に描く経路の帯の幅（m）
const AR_CHEVRON_STEP_M = 1.6;   // 帯の上の矢印（＞）の間隔（m）
const AR_CHEVRON_SPEED  = 1.2;   // 矢印が進む向きに流れる速さ（m/秒）
const AR_BEACON_HEIGHT  = 5;     // 次の地点に立てる柱の高さ（m）。人や車の陰でも見えるように高くする
const AR_LABEL_SCALE    = 0.15;  // 距離の札の大きさ（画面の高さに対する割合。遠くても同じ大きさで見える）

// --- 画角 ---
// スマホの背面カメラ（標準のレンズ）の、映像の長い辺の画角の半分の tan。35mm 換算 26mm 前後の
// レンズでは長い辺の画角が約67度（tan(33.5°) ≒ 0.66）。16:9 の映像は 4:3 のセンサーの短い辺を
// 切って作るので、長い辺の画角は変わらない
const AR_CAM_TAN_HALF_LONG = 0.66;

// --- 屋外ARの精度 ---
// 端末のコンパスは「磁北」基準だが、地図（緯度経度）は「真北」基準。生田キャンパス付近では磁北が真北より
// 約7.6度西にずれている（国土地理院の地磁気の偏角）。補正しないと、50m先の目印が横に約6.6mずれる。
const AR_MAG_DECLINATION_DEG = 7.6;
// コンパスの細かな揺れを抑える強さ（ジャイロが使えない端末だけで使う。小さいほど滑らかで遅れる）
const AR_HEADING_SMOOTHING = 0.2;
// ジャイロの向きをコンパスに寄せる速さ（コンパスの値が届くたびに、差のどれだけを取り入れるか）。
// ジャイロは滑らかだが少しずつずれ、コンパスはずれないが揺れるので、ジャイロで動かしてコンパスでゆっくり直す
const AR_COMPASS_BLEND = 0.02;
// ジャイロとコンパスの差がいつもよりこれ（度）以上大きい値は、鉄骨などで狂った値とみなして使わない
const AR_COMPASS_OUTLIER_DEG = 25;
// 狂った値がこれだけ続いたら、コンパスのほうが正しい（ジャイロがずれた）とみなして合わせ直す（約2秒分）
const AR_COMPASS_MAX_OUTLIERS = 120;
// これより精度の悪い（±何mの）位置は使わない。建物の陰などで大きく外れた位置で目印が飛ぶのを防ぐ
const AR_GPS_MAX_ACCURACY = 35;
// 位置のなめらかさの調整（歩く速さで1秒あたりに動きうる位置のばらつき、m²/秒）
const AR_GPS_WALK_VARIANCE = 2.0;
// 予測から大きく外れた位置が何回続いたら、外れ値ではなく本当に移動したとみなすか
const AR_GPS_MAX_OUTLIERS = 3;
// なめらかにした位置が今の区間の線からこれ以内（m）なら、線の上に寄せて目印を置く（道から外れて見えないように）
const AR_SNAP_MAX_M = 15;
// 新しい位置が届いたとき、目印を何秒かけて動かすか（GPS の更新のたびに目印が飛ばないように）
const AR_POSITION_EASE_S = 0.6;

// --- 歩いた向きでのコンパスの補正 ---
// コンパスは鉄骨の建物などの近くで10〜30度狂う。経路に沿ってまっすぐ歩いているときは、カメラも経路の向きを
// 向いているはずなので、その差をコンパスのずれとして覚え、カメラの向きから引く。
const AR_HEADING_MIN_WALK_M = 12;     // これだけまっすぐ歩いたら補正する
const AR_HEADING_WINDOW_MS  = 20000;  // 何ミリ秒前までの位置を使うか
const AR_HEADING_MAX_BEND_M = 3;      // 歩いた線からこれ以上外れた位置があれば、まっすぐではないとみなす
const AR_HEADING_ROUTE_TOL  = 25;     // 歩いた向きと経路の向きの差がこれ以内（度）なら、経路に沿って歩いたとみなす
const AR_HEADING_MAX_OFFSET = 45;     // これより大きいずれ（度）は、横を見ながら歩いていたとみなして使わない
const AR_HEADING_LEARN      = 0.3;    // 新しく求めたずれをどれだけ取り入れるか
const AR_HEADING_LEARN_AFTER_SWIPE = 0.08;  // 手で合わせた直後は、手で合わせた向きを信じて少しずつしか変えない
const AR_SWIPE_TRUST_MS     = 60000;  // 手で合わせた向きを信じる時間

// --- 高精度モード（WebXR）の地図との位置合わせ ---
const AR_XR_LOCAL_EYE    = 1.4;    // 床の高さが分からない端末で、開始時のスマホの高さとみなす値（m）
const AR_XR_PAIR_WINDOW_MS = 90000; // 何ミリ秒前までの GPS を位置合わせに使うか
const AR_XR_MAX_PAIRS    = 90;
const AR_XR_FIT_MIN_M    = 10;     // GPS の点がこれだけ（m）広がったら、軌跡の重ね合わせで向きも求める
const AR_XR_FIT_FULL_M   = 40;     // これだけ広がったら、コンパスよりも軌跡の重ね合わせを信じる
const AR_XR_EASE         = 0.05;   // 位置合わせの変化を1フレームごとにどれだけ取り入れるか

// --- 目印を出す範囲 ---
// 今のステップから何区間先までの経路を出すか（距離で絞ると、地点の間が長い屋外では1区間しか出なくなるため、区間の数で決める）
const AR_VISIBLE_STEPS = 5;

// --- 屋外ステップの自動送り ---
// 次の地点を「通過した」と判定された位置が何回続いたら次のステップへ進むか（1回だけの揺れで進まないように）
const AR_AUTO_CONFIRM = 2;
// ボタンで手動でステップを動かしたあと、自動送りを止めておく時間（戻した直後に勝手に進み直さないように）
const AR_MANUAL_PAUSE_MS = 5000;

// --- GPS が取れなくなったときの案内 ---
// 屋外ARを出してから、使える位置（精度 AR_GPS_MAX_ACCURACY 以内）がこの時間（ミリ秒）届かなければ、
// 自動送りでは進めないので、右の矢印で手順を進めるよう画面に出す
const AR_GPS_LOST_MS = 15000;

// 屋外の経路で使うカメラ・位置情報・向きの許可。"none"＝まだ聞いていない / "asking"＝お願いの画面を出している /
// "requesting"＝OKが押され、ブラウザの許可ダイアログを順に出している /
// "done"＝聞き終わった（またはすでに許可されていた）。ページを開いている間は一度聞けば聞き直さない
let arPermissionState = "none";
let arCamWanted      = false;  // カメラストリームを保持してよいか（解放後の遅延取得を防ぐ）
let arCamRequesting  = false;  // getUserMedia 実行中フラグ（二重取得を防ぐ）
let arOrientAttached = false;
let arGOrient        = null;   // 最後に届いた向き（beta・gamma は描画にそのまま使う）
let arRelOrient      = null;   // ジャイロの向き（北の基準は無いが滑らか）{ alpha, beta, gamma }
let arAbsOrient      = null;   // コンパスで北を基準にした向き（磁北）{ alpha, beta, gamma }
let arYawOffset      = null;   // ジャイロの方位をコンパス（磁北）の方位に直す差（度、時計回り）
let arYawOutliers    = 0;
let arYawSamples     = [];     // 最初に差を決めるために集める値

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
let arHeadingSmoothed = null;  // 真北を基準にしたカメラの向き（度、alpha と同じ反時計回り）
let arAutoConfirmed   = 0;     // 「通過した」と判定された位置が続いた回数
let arAutoPausedUntil = 0;     // この時刻（ミリ秒）までは自動送りしない
let arHeadingTrack    = [];    // 補正用に覚えておく最近の位置とカメラの向き（arLearnHeading 参照）
let arHeadingOffset   = 0;     // コンパスのずれの推定（度。方位＝時計回りで「真の方位 − コンパスの方位」）
let arSwipedAt        = 0;     // 最後に画面をなぞって向きを合わせた時刻（ミリ秒）
let arViewActive      = false; // 屋外のステップでARを出しているか（arShowView〜arHideView）
let arViewShownAt     = 0;     // ARを出した時刻（ミリ秒）
let arGoodFixAt       = 0;     // 最後に使える位置が届いた時刻（ミリ秒）
let arGpsDenied       = false; // 位置情報の利用が許可されていない
let arGpsLostTimer    = null;

let arWorldTarget = null;      // 通常モードで目印を動かす先（{x, z}、arUpdateWorldPosition 参照）
let arLastFrameMs = 0;
let arVFov        = 45;        // 今の 3D の縦の画角（度）

// 高精度モード（WebXR）
let arXrSupported = null;      // null＝まだ調べていない
let arXrSession   = null;
let arXrGroundY   = 0;
let arXrPose      = null;      // 最後のフレームの端末の位置と向き（XR の座標）{ x, z, fx, fz, timeMs }
let arXrPairs     = [];        // 同じ時刻の「XR の位置」と「地図の位置」の組（arFitAlignment 参照）
let arXrPsiPrior  = null;      // コンパスから求めた XR の座標と地図の回転（度）
let arXrAlign     = null;      // 今使っている位置合わせ { psi, tx, tz }
let arXrManualYaw = 0;         // 高精度モードで、画面をなぞって合わせた分（度）
let arXrFitSpread = 0;

let _arMeshes = [];   // { mesh, mat, type: "node"|"edge", idx, x, z } — ステップごとの色・範囲による表示の切り替え
let _arChevronTextures = [];
let _arBeacon = null; // { group, label, labelCtx, labelTex, text }

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

// 向きセンサーを受け取り始める。
//   - deviceorientation: iOS・Android とも、ジャイロをもとにした滑らかな向き（北の基準は無い）。
//     iOS では webkitCompassHeading にコンパスの方位も入っている
//   - deviceorientationabsolute: Android で、コンパスで北を基準にした向き
function arAttachOrientation() {
  if (arOrientAttached) return;
  arOrientAttached = true;
  const onAbsolute = (e) => {
    if (e.alpha == null) return;
    arAbsOrient = { alpha: e.alpha, beta: e.beta || 0, gamma: e.gamma || 0 };
    if (!arRelOrient) arGOrient = arAbsOrient;
    arFeedCompass(arAbsOrient);
  };
  const onRelative = (e) => {
    if (e.alpha == null) return;
    arRelOrient = { alpha: e.alpha, beta: e.beta || 0, gamma: e.gamma || 0 };
    arGOrient = arRelOrient;
    // iOS: コンパスの方位（磁北から時計回り）。精度が分からない（-1）ときは使わない
    if (typeof e.webkitCompassHeading === "number" && !(e.webkitCompassAccuracy < 0)) {
      arFeedCompass({ alpha: 360 - e.webkitCompassHeading, beta: arRelOrient.beta, gamma: arRelOrient.gamma });
    }
  };
  window.addEventListener("deviceorientationabsolute", onAbsolute);
  window.addEventListener("deviceorientation",         onRelative);
}

// 検索ボタン押下で呼ぶ。Three.js を並行ロードして、屋外ARへの切り替え時のもたつきを減らす。
// 許可はここでは求めない（経路が決まり、屋外を通るときだけ arAskPermissions() で求める）。
function arPreloadThree() {
  arLoadThree().catch(() => {});
}

/** 経路に屋外AR区間があるか（最終ステップは到着画面なのでAR不要） */
function arRouteHasOutdoor() {
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const n = pathCoords[i];
    if (n && n.building === 0 && n.lat != null) return true;
  }
  return false;
}

// ルートに屋外AR区間が含まれる場合のみ、GPS の取得を始め、カメラを先取りしてストリームを温める。
// 屋内のみのルートではカメラを一切起動しない（向きも屋外ARでしか使わないので、許可も求めない）。
// initRoute() から呼ばれる。まだ許可を聞いていなければ、先にお願いの画面を出す。
function arPrefetchCameraIfNeeded() {
  if (!arRouteHasOutdoor()) return;
  if (arPermissionState === "done") arStartHardware();
  else if (arPermissionState === "none") arAskPermissions();
}

// iOS では、向きの許可（DeviceOrientationEvent.requestPermission）は画面のボタンを押した処理の中で
// 呼ばないと許可ダイアログが出ない。経路の取得を待ったあとではボタンを押した扱いが切れているので、
// 先に自前の画面で理由を伝え、その「OK」を押した処理の中でブラウザの許可ダイアログを出す。
// カメラ・位置情報がすでに許可されていて、向きの許可も要らない端末（Android など）では画面を出さない。
async function arAskPermissions() {
  arPermissionState = "asking";
  if (await arAlreadyAllowed()) { arAcceptPermissions(); return; }
  document.getElementById("ar-permission-modal").hidden = false;
}

/** カメラ・位置情報が許可済みで、向きの許可も要らないか（Permissions API が無い・読めない端末では false） */
async function arAlreadyAllowed() {
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") return false;  // iOS: 向きは毎回OKが要る
  try {
    const state = name => navigator.permissions.query({ name }).then(r => r.state);
    const [camera, geolocation] = await Promise.all([state("camera"), state("geolocation")]);
    return camera === "granted" && geolocation === "granted";
  } catch {
    return false;
  }
}

// お願いの画面の「OK」。向き → カメラ → 位置情報の順に、前の答えを待ってから次の許可を求める。
// iOS の Safari は許可ダイアログを一度に1つしか出せず、同時に求めると後のもの（位置情報）が出ないことがある
function arAcceptPermissions() {
  document.getElementById("ar-permission-modal").hidden = true;
  arPermissionState = "requesting";
  arRequestOrientation()
    .then(() => (arRouteHasOutdoor() ? arPrefetchCamera() : null))
    .then(() => {
      arPermissionState = "done";
      if (!arRouteHasOutdoor()) return;
      arStartGpsWatch();
      // ダイアログを出している間に屋外のステップに来ていたら、止めていたARをここで出す
      updateRouteImage(currentStep);
    });
}

// 向きセンサーを使い始める。iOS の許可（requestPermission）はボタンを押した処理の中で同期的に呼ぶ必要がある
function arRequestOrientation() {
  if (typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function") {
    return DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === "granted") arAttachOrientation(); })
      .catch(() => {});
  }
  arAttachOrientation();
  return Promise.resolve();
}

// GPS の取得を始め、カメラを先取りしてストリームを温める（許可を聞き終わったあとの経路で使う）
function arStartHardware() {
  // GPS は、つかみ始めの位置の精度が悪いので、屋外に出る前（経路を出した時点）から取り続けておく
  arStartGpsWatch();
  arPrefetchCamera();
}

// 背面カメラ。解像度を上げると映像がくっきりし、目印との位置関係も分かりやすい
const AR_VIDEO_CONSTRAINTS = { video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } };

/** カメラを先取りする。許可ダイアログに答えるまで待つ Promise を返す（失敗しても resolve する） */
function arPrefetchCamera() {
  arCamWanted = true;
  if (arStream || arCamRequesting) return Promise.resolve();
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return Promise.resolve();
  arCamRequesting = true;
  return navigator.mediaDevices.getUserMedia(AR_VIDEO_CONSTRAINTS)
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
  arCamera3 = new THREE.PerspectiveCamera(arVFov, 1, 0.1, 5000);
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
  const video = document.getElementById("ar-bg-video");
  if (video) video.addEventListener("loadedmetadata", arResizeCanvas);
  arResizeCanvas();
}

// ================================================================
// 画角をカメラ映像に合わせる
// カメラの映像は #ar-area いっぱいに「はみ出す部分を切って」（object-fit: cover）表示している。
// 3D の画角が、画面に実際に映っている範囲の画角と違うと、目印が中心に寄ったり外に広がったりして、
// 横を向くほど大きくずれる（以前は 65度で固定していたが、縦長の画面では実際は 40度前後しかなかった）。
// ================================================================

/**
 * 画面に映っている映像の縦の画角（度）を求める。
 * videoW/H: 映像の大きさ（px）、areaW/H: 表示する場所の大きさ（px）。映像の大きさが分からないときは
 * 縦長（3:4）の映像とみなす。
 */
function arVerticalFov(videoW, videoH, areaW, areaH) {
  if (!(videoW > 0 && videoH > 0)) { videoW = 3; videoH = 4; }
  const tanPerPx = AR_CAM_TAN_HALF_LONG / (Math.max(videoW, videoH) / 2);  // 映像の中心から1px あたりの tan
  const scale = Math.max(areaW / videoW, areaH / videoH);                   // cover で拡大する倍率
  const halfVisible = areaH / (2 * scale);                                  // 画面に映っている縦の半分（映像の px）
  return 2 * Math.atan(halfVisible * tanPerPx) * 180 / Math.PI;
}

function arResizeCanvas() {
  if (!arRenderer || !arCamera3) return;
  if (arXrSession) return;   // 高精度モードでは画面の大きさ・画角を XR が決める
  const area = document.getElementById("ar-area");
  if (!area) return;
  const w = area.clientWidth, h = area.clientHeight;
  if (!w || !h) return;
  const video = document.getElementById("ar-bg-video");
  arVFov = arVerticalFov(video && video.videoWidth, video && video.videoHeight, w, h);
  arRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  arRenderer.setSize(w, h, false);
  arCamera3.fov = arVFov;
  arCamera3.aspect = w / h;
  arCamera3.updateProjectionMatrix();
}

function arEnuFromRef(lat, lng) {
  const north = (lat - arRefLat) * 111320;
  const east  = (lng - arRefLng) * 111320 * Math.cos(arRefLat * Math.PI / 180);
  return { east, north };
}

// 通常モードで、自分が (lat, lng) にいるように目印を動かす（実際に動かすのは毎フレーム少しずつ）
function arUpdateWorldPosition(lat, lng) {
  if (arRefLat == null || !arWorldGroup) return;
  const { east, north } = arEnuFromRef(lat, lng);
  const first = !arWorldTarget;
  arWorldTarget = { x: -east, z: north };
  if (first && !arXrSession) arWorldGroup.position.set(arWorldTarget.x, 0, arWorldTarget.z);
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
  arXrAddPair(shown, timeMs);
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
 * 向き（alpha・beta・gamma、度）のとき、カメラ（背面）が向いている方位（度、北から時計回り）。
 * 端末を寝かせていてカメラが真下を向いているときは、代わりに端末の上の辺が向いている方位を返す。
 * どちらも決められないときは null。
 * （alpha は北から反時計回り、beta は前後の傾き、gamma は左右の傾き。Z-X-Y の順に回した向き）
 */
function arCamHeading(o) {
  const r = Math.PI / 180;
  const sa = Math.sin(o.alpha * r), ca = Math.cos(o.alpha * r);
  const sb = Math.sin(o.beta * r),  cb = Math.cos(o.beta * r);
  const sg = Math.sin(o.gamma * r), cg = Math.cos(o.gamma * r);
  // 背面カメラの向き（端末の −Z 方向）の、東・北の成分
  let x = -ca * sg - sa * sb * cg, y = -sa * sg + ca * sb * cg;
  if (Math.hypot(x, y) < 0.35) {
    // 端末の上の辺（+Y 方向）の、東・北の成分
    x = -sa * cb; y = ca * cb;
    if (Math.hypot(x, y) < 0.35) return null;
  }
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

/**
 * コンパスの向き（磁北基準の alpha・beta・gamma）が届くたびに呼び、ジャイロの向きとの差 arYawOffset を少しずつ直す。
 * ジャイロは滑らかで反応が速いが、時間とともに少しずつずれる。コンパスはずれないが、細かく揺れ、
 * 鉄骨や車のそばで一時的に大きく狂う。そこで描画はジャイロの向きで行い、北の向きだけコンパスでゆっくり合わせる。
 *   - 最初の数回の差の平均で始める
 *   - いつもの差から AR_COMPASS_OUTLIER_DEG 以上離れた値は使わない（狂った値）。ただし長く続けば合わせ直す
 */
function arFeedCompass(abs) {
  const rel = arRelOrient;
  if (!rel) return;
  const hAbs = arCamHeading(abs), hRel = arCamHeading(rel);
  if (hAbs == null || hRel == null) return;
  const d = arAngleDiff(hAbs, hRel);
  if (arYawOffset == null) {
    arYawSamples.push(d);
    if (arYawSamples.length < 5) return;
    arYawOffset = arMeanAngle(arYawSamples);
    arYawSamples = [];
    return;
  }
  const diff = arAngleDiff(d, arYawOffset);
  if (Math.abs(diff) > AR_COMPASS_OUTLIER_DEG) {
    if (++arYawOutliers < AR_COMPASS_MAX_OUTLIERS) return;
    arYawOffset = d;
    arYawOutliers = 0;
    return;
  }
  arYawOutliers = 0;
  arYawOffset = ((arYawOffset + diff * AR_COMPASS_BLEND) % 360 + 360) % 360;
}

/** 角度（度）の平均（0度をまたいでも正しく平均する） */
function arMeanAngle(degs) {
  let sx = 0, sy = 0;
  for (const d of degs) { sx += Math.sin(d * Math.PI / 180); sy += Math.cos(d * Math.PI / 180); }
  return (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
}

/**
 * 今の向き（真北基準）を求めて arHeadingSmoothed に入れ、描画に使う向き（alpha・beta・gamma、度）を返す。
 * ジャイロとコンパスの両方があればジャイロ＋差（arFeedCompass）、コンパスだけならコンパスをなめらかにしたもの、
 * ジャイロだけなら北の基準の無い向きを使う（歩いた向きでの補正・手での合わせで北が決まる）。
 */
function arFusedOrientation() {
  if (arRelOrient && arYawOffset != null) {
    // 方位に arYawOffset を足す ＝ 反時計回りの alpha から引く
    arHeadingSmoothed = arTrueNorthAlpha(arRelOrient.alpha - arYawOffset, true);
    return { alpha: arHeadingSmoothed, beta: arRelOrient.beta, gamma: arRelOrient.gamma };
  }
  if (arAbsOrient && !arRelOrient) {
    arHeadingSmoothed = arSmoothAngle(arHeadingSmoothed, arTrueNorthAlpha(arAbsOrient.alpha, true), AR_HEADING_SMOOTHING);
    return { alpha: arHeadingSmoothed, beta: arAbsOrient.beta, gamma: arAbsOrient.gamma };
  }
  if (arRelOrient) {
    arHeadingSmoothed = arTrueNorthAlpha(arRelOrient.alpha, false);
    return { alpha: arHeadingSmoothed, beta: arRelOrient.beta, gamma: arRelOrient.gamma };
  }
  return null;
}

/** 歩いた向き・手での合わせまで含めた、カメラの真の方位（度、北から時計回り）。分からなければ null */
function arTrueCamHeading() {
  const o = arFusedOrientation();
  if (!o) return null;
  const h = arCamHeading({ alpha: o.alpha - arHeadingOffset, beta: o.beta, gamma: o.gamma });
  return h;
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
    const cam = arMeanAngle(sub.map(p => p.cam));
    const offset = arAngleDiff(routeBearing, cam);
    return Math.abs(offset) <= AR_HEADING_MAX_OFFSET ? offset : null;
  }
  return null;
}

/**
 * 位置が更新されるたびに、その位置とカメラの向きを覚え、コンパスのずれを少しずつ学ぶ。
 * AR を見ていて、端末を立てて持っている（カメラが前を向いている）ときだけ使う。
 * 画面をなぞって手で合わせた直後は、手で合わせた向きを信じて、少しずつしか変えない。
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
  if (offset == null) return;
  const learn = Date.now() - arSwipedAt < AR_SWIPE_TRUST_MS ? AR_HEADING_LEARN_AFTER_SWIPE : AR_HEADING_LEARN;
  arHeadingOffset += learn * arAngleDiff(offset, arHeadingOffset);
}

// ================================================================
// 高精度モード（WebXR）の地図との位置合わせ
// XR の座標（端末が映像から求めた、開始地点を原点とする座標）と、地図の座標（arRefLat/Lng を原点に、
// 東＝+x・北＝−z の m）は、水平の回転 psi と平行移動 t だけ違う：  XR = R(psi)・地図 + t
// 同じ時刻の「XR の位置」と「GPS の位置」の組を集め、重み（GPS の精度）付きで最もよく重なる psi・t を求める。
// 歩き始めで組の広がりが小さいうちは、psi はコンパスの向きから決める。
// 回転 R(psi) は (x, z) 平面で (x cos − z sin, x sin + z cos)。
// ================================================================

/**
 * pairs: [{ ax, az（地図）, bx, bz（XR）, w（重み） }, ...] から、b ≒ R(psi)・a + t となる psi（度）を求める。
 * psiDeg を渡したときはその回転で t だけ求める。spread は地図の点の広がり（m、重心からの距離の2乗平均の平方根の2倍）。
 * 組が無いときは null。
 */
function arFitAlignment(pairs, psiDeg) {
  let sw = 0, cax = 0, caz = 0, cbx = 0, cbz = 0;
  for (const p of pairs) { sw += p.w; cax += p.w * p.ax; caz += p.w * p.az; cbx += p.w * p.bx; cbz += p.w * p.bz; }
  if (!(sw > 0)) return null;
  cax /= sw; caz /= sw; cbx /= sw; cbz /= sw;
  let sDot = 0, sCross = 0, sVar = 0;
  for (const p of pairs) {
    const ax = p.ax - cax, az = p.az - caz, bx = p.bx - cbx, bz = p.bz - cbz;
    sDot   += p.w * (ax * bx + az * bz);
    sCross += p.w * (ax * bz - az * bx);
    sVar   += p.w * (ax * ax + az * az);
  }
  const fitted = Math.atan2(sCross, sDot) * 180 / Math.PI;
  const psi = psiDeg != null ? psiDeg : fitted;
  const r = psi * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return {
    psi, fitted: (fitted + 360) % 360,
    tx: cbx - (cax * c - caz * s),
    tz: cbz - (cax * s + caz * c),
    spread: 2 * Math.sqrt(sVar / sw),
  };
}

/** GPS の位置が届いたとき、高精度モードなら同じ時刻の XR の位置と組にして覚える */
function arXrAddPair(shown, timeMs) {
  if (!arXrSession || !arXrPose || arRefLat == null) return;
  if (Date.now() - arXrPose.timeMs > 500) return;   // 端末の位置が古い（追えていない）ときは使わない
  const { east, north } = arEnuFromRef(shown.lat, shown.lng);
  const acc = Math.max(3, shown.accuracy || 10);
  arXrPairs.push({ ax: east, az: -north, bx: arXrPose.x, bz: arXrPose.z, w: 1 / (acc * acc), timeMs });
  arXrPairs = arXrPairs.filter(p => timeMs - p.timeMs <= AR_XR_PAIR_WINDOW_MS).slice(-AR_XR_MAX_PAIRS);
}

/** 高精度モードで毎フレーム呼ぶ。端末の位置を読み、位置合わせを少しずつ直して目印に反映する */
function arXrUpdate(frame) {
  const pose = frame.getViewerPose(arRenderer.xr.getReferenceSpace());
  if (!pose) return;
  const p = pose.transform.position, o = pose.transform.orientation;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
  arXrPose = { x: p.x, z: p.z, fx: f.x, fz: f.z, timeMs: Date.now() };

  // コンパスから求める回転：カメラの向きが、地図の上でコンパスの方位を向くように
  const h = arTrueCamHeading();
  if (h != null && Math.hypot(f.x, f.z) > 0.3) {
    const r = h * Math.PI / 180;
    const prior = (Math.atan2(f.z, f.x) - Math.atan2(-Math.cos(r), Math.sin(r))) * 180 / Math.PI;
    arXrPsiPrior = arSmoothAngle(arXrPsiPrior, (prior % 360 + 360) % 360, 0.05);
  }
  if (!arXrPairs.length) { arWorldGroup.visible = !!arXrAlign; return; }

  // GPS の点が広がっていれば軌跡の重ね合わせの回転も使う（広がるほど重く）
  const free = arFitAlignment(arXrPairs);
  arXrFitSpread = free.spread;
  let psi = arXrPsiPrior;
  if (free.spread >= AR_XR_FIT_MIN_M) {
    const w = Math.min(1, (free.spread - AR_XR_FIT_MIN_M) / (AR_XR_FIT_FULL_M - AR_XR_FIT_MIN_M));
    psi = psi == null ? free.fitted : arSmoothAngle(psi, free.fitted, w);
  }
  if (psi == null) { arWorldGroup.visible = false; return; }   // 向きが決まるまでは、間違った所に出さない
  arWorldGroup.visible = true;
  const target = arFitAlignment(arXrPairs, psi + arXrManualYaw);

  if (!arXrAlign) arXrAlign = { psi: target.psi, tx: target.tx, tz: target.tz };
  else {
    arXrAlign.psi = arSmoothAngle(arXrAlign.psi, (target.psi % 360 + 360) % 360, AR_XR_EASE);
    arXrAlign.tx += (target.tx - arXrAlign.tx) * AR_XR_EASE;
    arXrAlign.tz += (target.tz - arXrAlign.tz) * AR_XR_EASE;
  }
  // three の rotation.y＝φ は (x, z) を (x cosφ + z sinφ, −x sinφ + z cosφ) に回すので、φ = −psi
  arWorldGroup.rotation.set(0, -arXrAlign.psi * Math.PI / 180, 0);
  arWorldGroup.position.set(arXrAlign.tx, arXrGroundY, arXrAlign.tz);
}

/** 今の自分の位置（地図の座標 {x, z}）。高精度モードでは端末の位置から、通常モードでは GPS から */
function arUserScenePos() {
  if (arXrSession && arXrAlign && arXrPose) {
    const r = -arXrAlign.psi * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const x = arXrPose.x - arXrAlign.tx, z = arXrPose.z - arXrAlign.tz;
    return { x: x * c - z * s, z: x * s + z * c };
  }
  if (arUserLat == null || arRefLat == null) return null;
  const { east, north } = arEnuFromRef(arUserLat, arUserLng);
  return { x: east, z: -north };
}

// 画面の「高精度AR」ボタン。WebXR はボタンを押した処理の中で始める必要がある
async function arStartXr() {
  if (arXrSession || !arRenderer || !navigator.xr) return;
  const area = document.getElementById("ar-area");
  let session;
  try {
    session = await navigator.xr.requestSession("immersive-ar", {
      optionalFeatures: ["local-floor", "dom-overlay"],
      domOverlay: { root: area },
    });
  } catch {
    arSetHint("高精度ARを始められませんでした", 4000);
    return;
  }
  let type = "local-floor";
  try { await session.requestReferenceSpace("local-floor"); } catch { type = "local"; }
  arXrGroundY = type === "local-floor" ? 0 : -AR_XR_LOCAL_EYE;
  try {
    arRenderer.xr.enabled = true;
    arRenderer.xr.setReferenceSpaceType(type);
    await arRenderer.xr.setSession(session);
  } catch {
    arRenderer.xr.enabled = false;
    session.end().catch(() => {});
    arSetHint("高精度ARを始められませんでした", 4000);
    return;
  }
  arXrSession = session;
  arXrPairs = []; arXrAlign = null; arXrPose = null; arXrPsiPrior = null; arXrManualYaw = 0; arXrFitSpread = 0;
  area.classList.add("ar-xr");
  document.getElementById("ar-bg-video").style.display = "none";
  session.addEventListener("end", arOnXrEnd);
  arRenderer.setAnimationLoop(arRenderFrame);
  arUpdateHud();
}

function arOnXrEnd() {
  arXrSession = null;
  arXrAlign = null;
  if (arRenderer) arRenderer.xr.enabled = false;
  const area = document.getElementById("ar-area");
  if (area) area.classList.remove("ar-xr");
  if (arWorldGroup) {
    arWorldGroup.visible = true;
    arWorldGroup.rotation.set(0, 0, 0);
    if (arWorldTarget) arWorldGroup.position.set(arWorldTarget.x, 0, arWorldTarget.z);
  }
  if (arCamera3) arCamera3.position.set(0, AR_EYE_HEIGHT, 0);
  if (arRunning) {
    document.getElementById("ar-bg-video").style.display = "block";
    arResizeCanvas();
    arRenderer.setAnimationLoop(arRenderFrame);
  } else if (arRenderer) {
    arRenderer.setAnimationLoop(null);
  }
  arUpdateHud();
}

async function arCheckXrSupport() {
  if (arXrSupported != null) return;
  arXrSupported = false;
  try {
    if (navigator.xr && navigator.xr.isSessionSupported) {
      arXrSupported = await navigator.xr.isSessionSupported("immersive-ar");
    }
  } catch { arXrSupported = false; }
  arUpdateHud();
}

// ================================================================
// 目印
// ================================================================

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
  arUpdateBeacon();
}

/** 帯の上に描く「＞」の模様（進む向きが上）。色はあとで材質の色を掛けるので、白と灰色で描く */
function arChevronTexture() {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(150,150,150,0.55)";
  g.fillRect(0, 0, 64, 128);
  g.strokeStyle = "#fff";
  g.lineWidth = 14;
  g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath();
  g.moveTo(10, 84); g.lineTo(32, 44); g.lineTo(54, 84);
  g.stroke();
  // 帯の縁を明るくして、地面との境目を分かりやすくする
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fillRect(0, 0, 5, 128); g.fillRect(59, 0, 5, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// pathCoords から屋外区間の経路（地面の帯）と地点を Three.js シーンに配置する
function arBuildRouteMarkers() {
  if (!arWorldGroup || typeof THREE === "undefined") return;
  while (arWorldGroup.children.length) arWorldGroup.remove(arWorldGroup.children[0]);
  _arMeshes = [];
  _arChevronTextures = [];
  _arBeacon = null;
  arXrPairs = [];
  arXrAlign = null;
  arWorldTarget = null;

  const outdoorNodes = pathCoords.filter(
    n => n.building === 0 && n.lat != null && n.lng != null
  );
  if (!outdoorNodes.length) return;

  arRefLat = outdoorNodes[0].lat;
  arRefLng = outdoorNodes[0].lng;

  const pos = {};
  const discGeo = new THREE.CircleGeometry(AR_PATH_WIDTH / 2, 32);
  discGeo.rotateX(-Math.PI / 2);

  outdoorNodes.forEach(n => {
    const globalIdx = pathCoords.indexOf(n);
    const { east, north } = arEnuFromRef(n.lat, n.lng);
    const x = east, z = -north;
    pos[n.id] = { x, z };
    // 曲がり角のつなぎ目（帯と同じ幅の円）
    const mat  = new THREE.MeshBasicMaterial({ color: AR_EDGE_COLOR, transparent: true, opacity: 0.9, depthWrite: false });
    const disc = new THREE.Mesh(discGeo, mat);
    disc.position.set(x, 0.02, z);
    disc.renderOrder = 2;
    arWorldGroup.add(disc);
    _arMeshes.push({ mesh: disc, mat, type: "node", idx: globalIdx, x, z });
  });

  const base = arChevronTexture();
  for (let i = 0; i < pathCoords.length - 1; i++) {
    const a = pathCoords[i], b = pathCoords[i + 1];
    if (a.building !== 0 || b.building !== 0 || a.lat == null || b.lat == null) continue;
    const pa = pos[a.id], pb = pos[b.id];
    if (!pa || !pb) continue;
    const dx = pb.x - pa.x, dz = pb.z - pa.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    // 地面に寝かせた帯。模様の上（+v）が a→b の向きになるように回す
    const geo = new THREE.PlaneGeometry(AR_PATH_WIDTH, len);
    geo.rotateX(-Math.PI / 2);
    const tex = base.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, len / AR_CHEVRON_STEP_M);
    _arChevronTextures.push(tex);
    const mat = new THREE.MeshBasicMaterial({
      color: AR_EDGE_COLOR, map: tex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
    });
    const band = new THREE.Mesh(geo, mat);
    band.position.set(pa.x + dx / 2, 0.01, pa.z + dz / 2);
    band.rotation.y = Math.atan2(-dx, -dz);
    band.renderOrder = 1;
    arWorldGroup.add(band);
    _arMeshes.push({ mesh: band, mat, type: "edge", idx: i, x: band.position.x, z: band.position.z });
  }

  arBuildBeacon();
  if (arUserLat != null) arUpdateWorldPosition(arUserLat, arUserLng);
  arUpdateVisibility();
  arMarkersBuilt = true;
}

// 次に向かう地点に立てる柱と、残りの距離の札（遠くからでも見えるように、札は距離によらず同じ大きさで出す）
function arBuildBeacon() {
  const group = new THREE.Group();
  const pillarMat = new THREE.MeshBasicMaterial({ color: AR_BEACON_COLOR, transparent: true, opacity: 0.55, depthWrite: false });
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, AR_BEACON_HEIGHT, 16, 1, true), pillarMat);
  pillar.position.y = AR_BEACON_HEIGHT / 2;
  group.add(pillar);
  const ringGeo = new THREE.RingGeometry(0.9, 1.25, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: AR_BEACON_COLOR, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.position.y = 0.03;
  ring.renderOrder = 3;
  group.add(ring);

  const c = document.createElement("canvas");
  c.width = 256; c.height = 96;
  const labelTex = new THREE.CanvasTexture(c);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, sizeAttenuation: false, depthTest: false, transparent: true }));
  label.scale.set(AR_LABEL_SCALE * 256 / 96, AR_LABEL_SCALE, 1);
  label.position.y = AR_BEACON_HEIGHT + 0.4;
  label.center.set(0.5, 0);
  label.renderOrder = 10;
  group.add(label);

  group.visible = false;
  arWorldGroup.add(group);
  _arBeacon = { group, ring, label, labelCtx: c.getContext("2d"), labelTex, text: null, target: null };
}

/** 柱を立てる地点（今のステップで向かう屋外の地点）。無ければ null */
function arBeaconTarget(step) {
  const next = pathCoords[step + 1], cur = pathCoords[step];
  if (next && next.building === 0 && next.lat != null) return next;
  if (cur && cur.building === 0 && cur.lat != null) return cur;   // 次が屋内＝今の地点が建物の入口
  return null;
}

/** 残りの距離の表示（10m 未満は 1m 単位、それ以上は 5m 単位） */
function arDistanceText(m) {
  if (m < 10) return `あと ${Math.max(1, Math.round(m))}m`;
  return `あと ${Math.round(m / 5) * 5}m`;
}

function arDrawLabel(text) {
  const g = _arBeacon.labelCtx, w = 256, h = 96;
  g.clearRect(0, 0, w, h);
  g.fillStyle = "rgba(20,24,31,0.85)";
  const r = 22;
  g.beginPath();
  g.moveTo(r, 4); g.lineTo(w - r, 4); g.quadraticCurveTo(w - 4, 4, w - 4, r);
  g.lineTo(w - 4, h - r); g.quadraticCurveTo(w - 4, h - 4, w - r, h - 4);
  g.lineTo(r, h - 4); g.quadraticCurveTo(4, h - 4, 4, h - r);
  g.lineTo(4, r); g.quadraticCurveTo(4, 4, r, 4);
  g.fill();
  g.lineWidth = 5; g.strokeStyle = "#F59E0B"; g.stroke();
  g.fillStyle = "#fff";
  g.font = "bold 46px 'Noto Sans JP', sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 2);
  _arBeacon.labelTex.needsUpdate = true;
}

/** 柱を今の行き先に動かし、距離の札を書き直す */
function arUpdateBeacon() {
  if (!_arBeacon || arRefLat == null) return;
  const t = arBeaconTarget(currentStep);
  if (!t) { _arBeacon.group.visible = false; _arBeacon.target = null; return; }
  const { east, north } = arEnuFromRef(t.lat, t.lng);
  _arBeacon.target = { x: east, z: -north };
  _arBeacon.group.position.set(east, 0, -north);
  _arBeacon.group.visible = true;
  const me = arUserScenePos();
  const text = me ? arDistanceText(Math.hypot(me.x - east, me.z + north)) : "ここへ";
  if (text !== _arBeacon.text) { _arBeacon.text = text; arDrawLabel(text); }
}

// 現在ステップに合わせてノード・エッジを通過済み(グレー) / 今歩いている区間(黄緑) / これから(青) に塗り替える
function arUpdateRouteColors(step) {
  const PASSED_NODE = 0x9E9E9E;
  const AHEAD_NODE  = AR_EDGE_COLOR;
  const PASSED_EDGE = 0x9E9E9E;
  const AHEAD_EDGE  = AR_EDGE_COLOR;     // 0x3B82F6
  const CURRENT_EDGE = parseInt(CURRENT_EDGE_COLOR.slice(1), 16);
  const PASSED_OPACITY = 0.35;
  const AHEAD_OPACITY  = 0.85;

  _arMeshes.forEach(({ mat, type, idx }) => {
    const passed = idx < step;
    if (type === "node") {
      // つなぎ目の円は、そこから出る区間（帯）と同じ色にする
      mat.color.setHex(passed ? PASSED_NODE : idx === step ? CURRENT_EDGE : AHEAD_NODE);
    } else {
      mat.color.setHex(passed ? PASSED_EDGE : idx === step ? CURRENT_EDGE : AHEAD_EDGE);
      mat.opacity = passed ? PASSED_OPACITY : AHEAD_OPACITY;
    }
  });
  arUpdateVisibility();
}

function arScreenAngle() {
  const a = screen.orientation && screen.orientation.angle;
  return ((a != null ? a : window.orientation) || 0) * Math.PI / 180;
}

// 通常モードで、カメラの向きを向きセンサーに合わせる
function arUpdateCameraOrientation() {
  const o = arFusedOrientation();
  if (!o || !arCamera3) return;
  // 歩いた向き・手での合わせで求めたコンパスのずれを引く（方位のずれを、反時計回りの alpha に直して引く）
  const alpha  = (o.alpha - arHeadingOffset) * Math.PI / 180;
  const beta   = o.beta * Math.PI / 180;
  const gamma  = o.gamma * Math.PI / 180;
  const orient = arScreenAngle();

  _arEuler.set(beta, alpha, -gamma, "YXZ");
  const q = arCamera3.quaternion;
  q.setFromEuler(_arEuler);
  q.multiply(_arQ1);
  q.multiply(_arQ0.setFromAxisAngle(_arZee, -orient));
}

// 毎フレームの描画（通常モードは画面の更新ごと、高精度モードは XR のフレームごとに呼ばれる）
function arRenderFrame(timeMs, frame) {
  if (!arRunning) return;
  const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const dt = arLastFrameMs ? Math.min(0.1, (now - arLastFrameMs) / 1000) : 0;
  arLastFrameMs = now;

  if (frame && arXrSession) {
    arXrUpdate(frame);
  } else {
    arCamera3.position.set(0, AR_EYE_HEIGHT, 0);
    arUpdateCameraOrientation();
    // 新しい GPS の位置へ、AR_POSITION_EASE_S 秒くらいかけてなめらかに動かす
    if (arWorldTarget) {
      const k = 1 - Math.exp(-dt / AR_POSITION_EASE_S);
      const p = arWorldGroup.position;
      p.set(p.x + (arWorldTarget.x - p.x) * k, 0, p.z + (arWorldTarget.z - p.z) * k);
    }
  }
  // 帯の「＞」を進む向きに流す
  const shift = dt * AR_CHEVRON_SPEED / AR_CHEVRON_STEP_M;
  for (const t of _arChevronTextures) t.offset.y = (t.offset.y - shift) % 1;
  // 足元のつなぎ目の円は、近づくほど薄くする（真下に大きく映って前が見えにくくならないように）
  const me = arUserScenePos();
  if (me) {
    for (const m of _arMeshes) {
      if (m.type !== "node") continue;
      const d = Math.hypot(m.x - me.x, m.z - me.z);
      m.mat.opacity = 0.9 * Math.min(1, Math.max(0, (d - 2) / 6));
    }
  }
  if (_arBeacon && _arBeacon.group.visible) {
    const s = 1 + 0.15 * Math.sin(now / 300);   // 足元の輪をゆっくり脈打たせて目立たせる
    _arBeacon.ring.scale.set(s, 1, s);
  }
  if (Math.floor(now / 500) !== Math.floor((now - dt * 1000) / 500)) arUpdateBeacon();

  arRenderer.render(arScene3, arCamera3);
  arUpdateOffscreenArrow();
}

// ================================================================
// 画面の案内（ボタン・ヒント・画面外の矢印）
// 10種類のナビ画面で共通に使うので、HTML には書かず、ここで #ar-area の中に作る
// ================================================================
const AR_HUD_CSS = `
#ar-hud { position: absolute; inset: 0; z-index: 15; pointer-events: none; }
#ar-hud[hidden] { display: none; }
#ar-hud-turn { position: absolute; top: 72%; transform: translateY(-50%); display: none; align-items: center; gap: 6px;
  padding: 10px 14px; border-radius: 999px; background: rgba(245,158,11,0.95); color: #14181F;
  font: 700 16px/1 'Noto Sans JP', sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,0.35); }
#ar-hud-turn.left { left: 10px; } #ar-hud-turn.right { right: 10px; }
#ar-hud-turn svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
#ar-hud-bottom { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); width: calc(100% - 120px); max-width: 420px;
  display: flex; flex-direction: column; align-items: center; gap: 8px; }
#ar-hud-hint { padding: 7px 12px; border-radius: 8px; background: rgba(20,24,31,0.78); color: #fff;
  font: 500 13px/1.5 'Noto Sans JP', sans-serif; text-align: center; }
#ar-hud-hint[hidden], #ar-xr-btn[hidden] { display: none; }
#ar-xr-btn { pointer-events: auto; border: none; border-radius: 999px; padding: 9px 16px; background: #fff; color: #14181F;
  font: 700 14px/1 'Noto Sans JP', sans-serif; box-shadow: 0 2px 10px rgba(0,0,0,0.3); cursor: pointer; }
#ar-area.ar-xr { background: transparent !important; }
#ar-area.ar-xr #ar-bg-video, #ar-area.ar-xr #ar-gl-canvas { display: none !important; }
`;

let arHintUntil = 0;
let arHintText  = "";

function arEnsureHud() {
  if (document.getElementById("ar-hud")) return;
  const area = document.getElementById("ar-area");
  if (!area) return;
  const style = document.createElement("style");
  style.textContent = AR_HUD_CSS;
  document.head.appendChild(style);
  const hud = document.createElement("div");
  hud.id = "ar-hud";
  hud.hidden = true;
  hud.innerHTML =
    '<div id="ar-hud-turn" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg><span></span></div>' +
    '<div id="ar-hud-bottom"><div id="ar-hud-hint" role="status" hidden></div>' +
    '<button id="ar-xr-btn" type="button" hidden>高精度ARにする</button></div>';
  area.appendChild(hud);
  document.getElementById("ar-xr-btn").addEventListener("click", () => {
    if (arXrSession) arXrSession.end().catch(() => {});
    else arStartXr();
  });
  arAttachSwipe(area);
}

/** しばらくのあいだ、ヒントを出す（ms を省くと arUpdateHud が決める普段のヒントに戻るまで） */
function arSetHint(text, ms) {
  arHintText = text;
  arHintUntil = Date.now() + (ms || 0);
  arUpdateHud();
}

function arUpdateHud() {
  const hud = typeof document !== "undefined" && document.getElementById("ar-hud");
  if (!hud) return;
  hud.hidden = !arRunning;
  const btn = document.getElementById("ar-xr-btn");
  btn.hidden = !arXrSupported;
  btn.textContent = arXrSession ? "通常のARに戻す" : "高精度ARにする";

  let hint = "";
  if (Date.now() < arHintUntil) hint = arHintText;
  else if (arXrSession && arXrFitSpread < AR_XR_FIT_MIN_M) hint = "少し歩くと、地図との位置がさらに合います";
  else if (arHeadingSmoothed == null) hint = "スマホを立てて、前に向けて持ってください";
  else if (Date.now() - arViewShownAt < 10000 && !arSwipedAt) hint = "線が道からずれていたら、画面を左右になぞって合わせられます";
  const el = document.getElementById("ar-hud-hint");
  el.hidden = !hint;
  el.textContent = hint;
}

/**
 * 次の地点が画面の外にあるとき、左右どちらを向けばよいかを画面の端に出す。
 * 画面内に見えていれば消す。
 */
function arUpdateOffscreenArrow() {
  const el = document.getElementById("ar-hud-turn");
  if (!el) return;
  const show = (side, text) => {
    el.style.display = side ? "flex" : "none";
    if (!side) return;
    el.className = side;
    el.querySelector("svg").style.transform = side === "right" ? "scaleX(-1)" : "";
    el.querySelector("span").textContent = text;
    // 右側は、矢印をテキストの後ろに置く
    el.style.flexDirection = side === "right" ? "row-reverse" : "row";
  };
  if (!_arBeacon || !_arBeacon.group.visible || !arCamera3) { show(null); return; }
  const p = new THREE.Vector3(0, 1.5, 0);
  _arBeacon.group.localToWorld(p);
  // カメラから見た位置（−z が前）。高精度モードでもカメラの位置は matrixWorld に入る
  const cam = p.applyMatrix4(new THREE.Matrix4().copy(arCamera3.matrixWorld).invert());
  const ndc = cam.clone().applyMatrix4(arCamera3.projectionMatrix);
  const inFront = cam.z < 0;
  if (inFront && Math.abs(ndc.x) <= 0.85) { show(null); return; }
  const behind = !inFront && Math.abs(cam.x) < Math.abs(cam.z) * 0.5;
  const side = cam.x >= 0 ? "right" : "left";
  show(side, behind ? "うしろ" : side === "right" ? "右へ" : "左へ");
}

// 画面を左右になぞって、目印の向きを手で合わせる（指の動きに合わせて目印が動く）
function arAttachSwipe(area) {
  let last = null, decided = null;
  area.addEventListener("touchstart", (e) => {
    if (!arRunning || e.touches.length !== 1 || (e.target.closest && e.target.closest("button"))) { last = null; return; }
    last = { x: e.touches[0].clientX, y: e.touches[0].clientY, x0: e.touches[0].clientX, y0: e.touches[0].clientY };
    decided = null;
  }, { passive: true });
  area.addEventListener("touchmove", (e) => {
    if (!last || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (decided == null) {
      const dx = Math.abs(t.clientX - last.x0), dy = Math.abs(t.clientY - last.y0);
      if (dx < 8 && dy < 8) return;
      decided = dx > dy;
    }
    if (!decided) return;
    arOnSwipe(t.clientX - last.x, area.clientWidth || 1);
    last.x = t.clientX; last.y = t.clientY;
  }, { passive: true });
  area.addEventListener("touchend", () => { last = null; }, { passive: true });
}

/**
 * 指が dxPx（右が正）動いたぶん、目印を同じだけ横に動かす。画面の幅が横の画角に当たるので、
 * 動いた割合 × 横の画角 だけ向きを変える。指を右へ動かす ＝ 目印を右へ ＝ カメラの向きを左に回したのと同じ。
 */
function arOnSwipe(dxPx, widthPx) {
  const aspect = arCamera3 ? arCamera3.aspect : 0.75;
  const hFov = 2 * Math.atan(Math.tan(arVFov * Math.PI / 360) * aspect) * 180 / Math.PI;
  const deg = dxPx / widthPx * hFov;
  if (arXrSession) arXrManualYaw += deg;
  else arHeadingOffset -= deg;
  arSwipedAt = Date.now();
  arHeadingTrack = [];   // なぞる前の向きで学んだ途中の記録は捨てる
  arUpdateHud();
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

let arHudTimer = null;

async function arShowView() {
  // お願いの画面・許可ダイアログを出している間は、ダイアログが重ならないようカメラ・GPSに触らない
  // （聞き終わったら arAcceptPermissions() がもう一度ここを呼ぶ）
  if (arPermissionState !== "done") return;
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
  arEnsureHud();
  arCheckXrSupport();

  const video = document.getElementById("ar-bg-video");
  if (!video.srcObject) {
    if (arStream) {
      video.srcObject = arStream;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia(AR_VIDEO_CONSTRAINTS);
        if (!arBooting) { s.getTracks().forEach(t => t.stop()); return; }
        arStream = s;
        video.srcObject = s;
      } catch { /* カメラ利用不可 */ }
    }
  }
  if (!arBooting) return;

  video.style.display = "block";
  document.getElementById("ar-gl-canvas").style.display = "block";

  if (!arMarkersBuilt) arBuildRouteMarkers();
  arResizeCanvas();

  arRunning = true;
  arBooting = false;
  arLastFrameMs = 0;
  arUpdateHud();
  if (arHudTimer == null) arHudTimer = setInterval(arUpdateHud, 1000);
  arRenderer.setAnimationLoop(arRenderFrame);
}

function arHideView() {
  arViewActive = false;
  if (arGpsLostTimer != null) { clearInterval(arGpsLostTimer); arGpsLostTimer = null; }
  arUpdateGpsLostNotice();
  arBooting = false;
  if (!arRunning) return;
  arRunning = false;
  if (arHudTimer != null) { clearInterval(arHudTimer); arHudTimer = null; }
  if (arXrSession) arXrSession.end().catch(() => {});
  if (arRenderer) arRenderer.setAnimationLoop(null);
  document.getElementById("ar-bg-video").style.display = "none";
  document.getElementById("ar-gl-canvas").style.display = "none";
  arUpdateHud();
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
  arWorldTarget = null;
}
