// ================================================================
// 3Dグラフ（programs/3D_Graph の /3d）に、ツールから差し込む「動画撮影用」の操作。
// ページ（static/script.js）は変えず、Plotly のカメラを外から動かすだけ。データには何も書き込まない。
//
// ツール（graph3d/window.py）は、ページを読み込むたびにこのファイルを runJavaScript で流し込み、
// window.__ikuVideo.set({...}) で設定を渡す。何度流し込んでも1回分しか動かない。
// ================================================================
(function () {
  "use strict";
  if (window.__ikuVideo) return;

  const ZOOM_DIST_MIN = 0.25;   // ページの「＋」「−」と同じ、寄れる・引ける範囲
  const ZOOM_DIST_MAX = 12;
  const BOB_AMPLITUDE = 0.22;   // 高さを変えながら回るときの、見下ろす角度の揺れ幅（ラジアン）

  const opts = {
    rotate: false,     // 自動で回る
    period: 40,        // 1周にかける秒数
    dir: 1,            // 1 = 左回り（上から見て反時計回り）、-1 = 右回り
    bob: false,        // 見下ろす角度をゆっくり上下させる
    zoom: 0,           // 1 = ゆっくり寄る、-1 = ゆっくり離れる、0 = 止める
    zoomSpeed: 0.05,   // 1秒あたりに距離を何割変えるか
    clean: false,      // ページの操作パネル・ヒント・ホバーの表示を隠す
    hideLegend: false, // 凡例を隠す
    hideAxes: false,   // 軸・目盛り・背景の箱を隠す
  };

  const gd = () => document.getElementById("map");
  const ready = () => !!(window.Plotly && gd() && gd()._fullLayout && gd()._fullLayout.scene);

  function liveCamera() {
    const s = gd()._fullLayout.scene._scene;
    if (s && s.getCamera) return s.getCamera();
    return (gd().layout.scene || {}).camera;
  }

  // ---------------------------------------------------------------- 凡例・軸を隠す
  // ページは経路を出すたびに Plotly.react でレイアウトを作り直すので、その入口で上書きする
  function overrideLayout(layout) {
    if (!layout) return layout;
    const out = { ...layout };
    if (opts.hideLegend) out.showlegend = false;
    if (opts.hideAxes && out.scene) {
      const scene = { ...out.scene };
      for (const ax of ["xaxis", "yaxis", "zaxis"]) scene[ax] = { ...(scene[ax] || {}), visible: false };
      out.scene = scene;
    }
    return out;
  }
  function hookReact() {
    if (!window.Plotly || Plotly.__ikuHooked) return;
    const react = Plotly.react;
    Plotly.react = function (el, data, layout, config) {
      return react.call(this, el, data, overrideLayout(layout), config);
    };
    Plotly.__ikuHooked = true;
  }
  function applyLayoutOptions() {
    if (!ready()) return;
    Plotly.relayout(gd(), {
      showlegend: !opts.hideLegend,
      "scene.xaxis.visible": !opts.hideAxes,
      "scene.yaxis.visible": !opts.hideAxes,
      "scene.zaxis.visible": !opts.hideAxes,
    });
  }

  // ---------------------------------------------------------------- 操作パネルを隠す
  const style = document.createElement("style");
  style.id = "iku-video-style";
  style.textContent = `
    body.iku-clean > header, body.iku-clean .sidebar, body.iku-clean #map-tools,
    body.iku-clean .map-hint, body.iku-clean #pick-panel, body.iku-clean #scroll-top-btn,
    body.iku-clean .modebar-container, body.iku-clean .hoverlayer { display: none !important; }
    body.iku-clean #map-container { position: absolute !important; inset: 0 !important; }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------- カメラを動かす
  // マウスで回している間は止め、離したらその向きから続ける
  let dragging = false;
  let baseElevation = null;   // 高さを変えながら回るときの、真ん中の見下ろす角度
  let phase = 0;
  let busy = false;           // 前の relayout が終わるまで次を出さない（重いときに溜めない）
  let last = null;

  window.addEventListener("pointerdown", e => { if (gd() && gd().contains(e.target)) dragging = true; }, true);
  window.addEventListener("pointerup", () => { if (dragging) { dragging = false; baseElevation = null; } }, true);
  window.addEventListener("wheel", () => { baseElevation = null; }, true);

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!dt || busy || dragging || !ready() || (!opts.rotate && !opts.zoom)) return;
    const cam = liveCamera();
    if (!cam || !cam.eye) return;

    const c = cam.center || { x: 0, y: 0, z: 0 };
    const u = cam.up || { x: 0, y: 0, z: 1 };
    let dx = cam.eye.x - c.x, dy = cam.eye.y - c.y, dz = cam.eye.z - c.z;
    let ux = u.x, uy = u.y;

    if (opts.rotate) {
      // 上下の軸（z）のまわりに回す。真上から見ているときは up も一緒に回す（画面の中で地図が回る）
      const a = opts.dir * 2 * Math.PI * dt / Math.max(opts.period, 1);
      const cs = Math.cos(a), sn = Math.sin(a);
      [dx, dy] = [dx * cs - dy * sn, dx * sn + dy * cs];
      [ux, uy] = [ux * cs - uy * sn, ux * sn + uy * cs];

      const r = Math.hypot(dx, dy);
      if (opts.bob && r > 1e-6) {
        const dist = Math.hypot(r, dz);
        if (baseElevation === null) { baseElevation = Math.atan2(dz, r); phase = 0; }
        phase += dt;
        const el = Math.max(0.05, Math.min(1.45,
          baseElevation + BOB_AMPLITUDE * Math.sin(2 * Math.PI * phase / Math.max(opts.period * 0.75, 1))));
        const k = dist * Math.cos(el) / r;
        dx *= k; dy *= k; dz = dist * Math.sin(el);
      }
    }
    if (opts.zoom) {
      const dist = Math.hypot(dx, dy, dz);
      const next = Math.max(ZOOM_DIST_MIN, Math.min(ZOOM_DIST_MAX, dist * Math.exp(-opts.zoom * opts.zoomSpeed * dt)));
      const s = next / dist;
      dx *= s; dy *= s; dz *= s;
    }

    busy = true;
    Promise.resolve(Plotly.relayout(gd(), {
      "scene.camera": {
        eye: { x: c.x + dx, y: c.y + dy, z: c.z + dz },
        center: { ...c },
        up: { x: ux, y: uy, z: u.z },
      },
    })).catch(() => {}).finally(() => { busy = false; });
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- 視点
  const VIEWS = {
    oblique: { eye: { x: 1.8, y: 1.8, z: 1.4 }, up: { x: 0, y: 0, z: 1 } },   // ページを開いたときの向き
    top:     { eye: { x: 0, y: 0, z: 2.5 },     up: { x: 0, y: 1, z: 0 } },   // ページの「俯瞰」と同じ
    side:    { eye: { x: 2.5, y: 0, z: 0.35 },  up: { x: 0, y: 0, z: 1 } },
  };
  function view(name) {
    const v = VIEWS[name];
    if (!v || !ready()) return;
    baseElevation = null;
    Plotly.relayout(gd(), { "scene.camera": { eye: { ...v.eye }, up: { ...v.up }, center: { x: 0, y: 0, z: 0 } } });
  }

  window.__ikuVideo = {
    set(next) {
      const before = { ...opts };
      Object.assign(opts, next);
      if (opts.bob !== before.bob || opts.rotate !== before.rotate) baseElevation = null;
      document.body.classList.toggle("iku-clean", !!opts.clean);
      if (opts.clean !== before.clean) window.dispatchEvent(new Event("resize"));
      if (opts.hideLegend !== before.hideLegend || opts.hideAxes !== before.hideAxes) applyLayoutOptions();
    },
    view,
    ready,
    options: () => ({ ...opts }),
  };

  // Plotly が読み込まれ、最初の描画が終わったら、凡例・軸の設定を効かせる
  (function waitPlot() {
    if (window.Plotly) hookReact();
    if (ready()) { applyLayoutOptions(); return; }
    setTimeout(waitPlot, 200);
  })();
})();
