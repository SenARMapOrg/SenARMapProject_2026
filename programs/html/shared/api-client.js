// ================================================================
// shared/api-client.js — 経路探索API の呼び出しを、ブラウザでの計算と静的データに置き換える
//
// 画面（ナビ・埋め込みマップ・3Dマップ）は fetch(`${API_BASE}/api/...`) の代わりに ikunaviFetch("/api/...") を呼ぶ。
// 返すのは fetch と同じ Response なので、呼び出し側は res.ok・res.status・res.json() をそのまま使える。
//
//   一覧の API（/api/all など）     … Pages のビルドで書き出した /data/*.json を読む
//   経路の API（/api/route など）   … /shared/route-core.mjs でブラウザの中で計算する（サーバーに聞かない）
//   それ以外・上の2つが使えないとき … 今までどおりサーバー（old-api.iku-navi.net の Flask）に聞く
//
// サーバーでの計算に戻すには DEFAULT_ENGINE を "server" にする（全画面が今までの動きに戻る）。
// 1回だけ見比べたいときは、ページの URL に ?engine=server（または ?engine=local）を付ける。
// 移行の段階と仕組みは docs/static_data.md。
// ================================================================
(function () {
  "use strict";

  const DEFAULT_ENGINE = "local";   // "local"（ブラウザで計算）/ "server"（今までどおりサーバーに聞く）

  // サーバー（Flask）。api.iku-navi.net は Pages Functions に移すので、Flask は old-api.iku-navi.net で答える。
  // ローカル開発では同じオリジンの /api/...
  const API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : "https://old-api.iku-navi.net";
  const STATIC_FILES = {
    "/api/all": "all.json",
    "/api/graph": "graph.json",
    "/api/edge_images": "edge_images.json",
    "/api/events": "events.json",
    "/api/cafeterias": "cafeterias.json",
    "/api/facilities": "facilities.json",
  };
  const COMPUTED = new Set([
    "/api/route", "/api/shortest_path", "/api/nearest_toilet", "/api/nearest_cafeteria",
    "/api/nearest_facility", "/api/edges",
  ]);

  const engine = (() => {
    const q = new URLSearchParams(location.search).get("engine");
    return q === "server" || q === "local" ? q : DEFAULT_ENGINE;
  })();

  const serverFetch = (path, search) => fetch(`${API_BASE}${path}${search}`);

  // 経路計算の準備（route-core.mjs と route_data.json）。最初の1回だけ読み、以降は使い回す。
  // 読めなかったときは null（以降はずっとサーバーに聞く。何度も読みに行かない）
  let routerPromise = null;
  function loadRouter() {
    if (!routerPromise) {
      routerPromise = Promise.all([
        import("/shared/route-core.mjs"),
        fetch("/data/route_data.json").then(res => {
          if (!res.ok) throw new Error(`route_data.json: ${res.status}`);
          return res.json();
        }),
      ])
        .then(([core, data]) => core.createRouter(data))
        .catch(err => {
          console.warn("[ikunavi] ブラウザでの経路計算を使えないため、サーバーに聞きます:", err);
          return null;
        });
    }
    return routerPromise;
  }

  async function staticFetch(path, search) {
    try {
      const res = await fetch(`/data/${STATIC_FILES[path]}`);
      if (res.ok) return res;
    } catch { /* 下のサーバーへ */ }
    return serverFetch(path, search);
  }

  async function computedFetch(path, url) {
    const router = await loadRouter();
    if (router) {
      try {
        const { status, body } = router.handle(path, url.searchParams);
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        // 想定外の失敗（Python 側なら 500 になるもの）。サーバーに聞き直す
        console.warn("[ikunavi] ブラウザでの経路計算に失敗したため、サーバーに聞きます:", err);
      }
    }
    return serverFetch(path, url.search);
  }

  /**
   * 経路探索API を呼ぶ（fetch の代わり）。
   * @param {string} pathAndQuery "/api/route?from_room=..." のような API のパスとクエリ
   * @returns {Promise<Response>}
   */
  function ikunaviFetch(pathAndQuery) {
    const url = new URL(pathAndQuery, location.origin);
    const path = url.pathname;
    if (engine === "local") {
      if (Object.prototype.hasOwnProperty.call(STATIC_FILES, path)) return staticFetch(path, url.search);
      if (COMPUTED.has(path)) return computedFetch(path, url);
    }
    return serverFetch(path, url.search);
  }

  // 最初の検索を待たせないよう、経路計算の準備を先に始めておく（ページの読み込み時に呼ぶ）
  function ikunaviPreload() {
    if (engine === "local") loadRouter();
  }

  window.ikunaviFetch = ikunaviFetch;
  window.ikunaviPreload = ikunaviPreload;
  window.IKUNAVI_ENGINE = engine;
})();
