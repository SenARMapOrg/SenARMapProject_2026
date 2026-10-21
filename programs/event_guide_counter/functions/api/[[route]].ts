import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";

import { adminRoutes } from "./_lib/routes/admin";
import { authRoutes } from "./_lib/routes/auth";
import { trackRoutes } from "./_lib/routes/track";
import type { AppEnv } from "./_lib/types";

const app = new Hono<AppEnv>().basePath("/api");

app.route("/auth", authRoutes);
app.route("/admin", adminRoutes);
app.route("/track", trackRoutes);

app.notFound((c) => c.json({ error: "Not Found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "サーバー内部エラーが発生しました" }, 500);
});

export const onRequest = handle(app);
