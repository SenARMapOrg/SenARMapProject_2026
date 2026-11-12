// Cloudflare Pages Functions: GET /api/*（経路探索API。/api/help-chat は help-chat.js が答える）
// 中身は functions/_lib/api-handler.mjs（手元の node でもテストできるよう分けている）。docs/static_data.md
import { handleApiGet } from "../_lib/api-handler.mjs";

export const onRequestGet = handleApiGet;
