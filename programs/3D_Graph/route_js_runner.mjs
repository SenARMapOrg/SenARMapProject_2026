// JS の経路計算（programs/html/shared/route-core.mjs）に、問い合わせをまとめて答えさせる。
// route_js_check.py から呼ぶ（Python の API と答えが同じかを比べるため）。
//
//   node route_js_runner.mjs <route_data.json> <queries.json> <answers.json>
//     queries.json: [{"path": "/api/route", "query": "from_room=...&..."}, ...]
//     answers.json: [{"status": 200, "body": {...}}, ...]（同じ順番）
import { readFileSync, writeFileSync } from "node:fs";
import { createRouter } from "../html/shared/route-core.mjs";

const [dataPath, queriesPath, answersPath] = process.argv.slice(2);
const router = createRouter(JSON.parse(readFileSync(dataPath, "utf-8")));
const queries = JSON.parse(readFileSync(queriesPath, "utf-8"));

const answers = queries.map(({ path, query }) => {
  try {
    return router.handle(path, new URLSearchParams(query));
  } catch (err) {
    return { status: 500, body: { error: String(err && err.stack || err) } };
  }
});
writeFileSync(answersPath, JSON.stringify(answers));
