// ================================================================
// 経路探索API（GET /api/*）を Pages Functions で答える本体。functions/api/[[path]].js から使う。
//
// これまで VPS の Flask（programs/3D_Graph）が答えていた API を、サーバー無しで同じ形のまま答える。
// ナビなどの画面はブラウザの中で計算する（programs/html/shared/api-client.js）ので、ここを呼ぶのは
// 時間割共有（programs/timetables）や IKU NAVI ツール、外部の利用者など、API として使うものだけ。
//
//   一覧（/api/all など） … Pages のビルドで書き出した /data/*.json をそのまま返す
//   経路（/api/route など）… programs/html/shared/route-core.mjs で計算する（ブラウザと同じ計算）
//
// Flask にしかない /api/rooms・/api/navigate_to_room・/3d は old-api.iku-navi.net（Flask）に残してある。
// 仕組みと移行の段階は docs/static_data.md。
// ================================================================
import { createRouter } from "../../programs/html/shared/route-core.mjs";

// /api/... → /data/... （programs/html/shared/api-client.js の STATIC_FILES と同じ。テストで照合している）
export const STATIC_FILES = {
  "/api/all": "all.json",
  "/api/graph": "graph.json",
  "/api/edge_images": "edge_images.json",
  "/api/events": "events.json",
  "/api/cafeterias": "cafeterias.json",
  "/api/facilities": "facilities.json",
};

// 他のサイトから読んでよいオリジン（Flask の ikunavi/config.py の CORS_ALLOWED_ORIGINS・CORS_ORIGIN_PATTERN と同じ）
const CORS_ALLOWED_ORIGINS = new Set([
  "https://iku-navi.net",
  "https://www.iku-navi.net",
  "https://timetables.iku-navi.net",   // 時間割共有が教室の選択肢を作るために /api/all を読む
]);
const CORS_ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+\.pages\.dev$/;   // Pages のプレビュー

const ROUTE_DATA_PATH = "/data/route_data.json";

// 計算の準備は Workers の同じインスタンスの中で使い回す（毎回 JSON を読み直さない）
let routerPromise = null;

function loadRouter(env, requestUrl) {
  if (!routerPromise) {
    routerPromise = env.ASSETS.fetch(new URL(ROUTE_DATA_PATH, requestUrl))
      .then(res => {
        if (!res.ok) throw new Error(`route_data.json: ${res.status}`);
        return res.json();
      })
      .then(createRouter);
    routerPromise.catch(() => { routerPromise = null; });   // 失敗したら次の問い合わせで読み直す
  }
  return routerPromise;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response, request) {
  const origin = request.headers.get("Origin") || "";
  if (CORS_ALLOWED_ORIGINS.has(origin) || CORS_ORIGIN_PATTERN.test(origin)) {
    const res = new Response(response.body, response);
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.append("Vary", "Origin");
    return res;
  }
  return response;
}

async function answer(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (Object.prototype.hasOwnProperty.call(STATIC_FILES, path)) {
    const asset = await env.ASSETS.fetch(new URL(`/data/${STATIC_FILES[path]}`, url));
    if (!asset.ok) return json({ error: "データを読み込めませんでした" }, 503);
    return new Response(asset.body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  let router;
  try {
    router = await loadRouter(env, url);
  } catch {
    return json({ error: "経路のデータを読み込めませんでした" }, 503);
  }
  if (!router.paths.includes(path)) return json({ error: `${path} はありません` }, 404);
  const { status, body } = router.handle(path, url.searchParams);
  return json(body, status);
}

export async function onRequestGet({ request, env }) {
  let response;
  try {
    response = await answer(request, env);
  } catch (err) {
    console.error("[api]", err);
    response = json({ error: "サーバーの中で問題が起きました" }, 500);
  }
  return withCors(response, request);
}
