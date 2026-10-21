import { Hono } from "hono";
import { handle } from "hono/cloudflare-pages";

import { adminRoutes } from "./_lib/routes/admin";
import { authRoutes } from "./_lib/routes/auth";
import { friendsRoutes } from "./_lib/routes/friends";
import { meRoutes } from "./_lib/routes/me";
import { timetableRoutes } from "./_lib/routes/timetable";
import type { AppEnv } from "./_lib/types";

const app = new Hono<AppEnv>().basePath("/api");

app.route("/auth", authRoutes);
app.route("/me", meRoutes);
app.route("/timetable", timetableRoutes);
app.route("/friends", friendsRoutes);
app.route("/admin", adminRoutes);

app.notFound((c) => c.json({ error: "Not Found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "サーバー内部エラーが発生しました" }, 500);
});

export const onRequest = handle(app);
