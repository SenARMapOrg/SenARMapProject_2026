// 管理画面のページ本体（/admin）。このアプリで唯一のページで、ログイン前はログイン画面、
// ログイン後はダッシュボードをJS側（src/admin.ts）が切り替えて表示する。
// 実際にデータを返すかどうかは /api/admin/* が改めて判定するので、このページ自体にアクセスできても
// データは見えない。ログイン済みだが管理者でない（ADMIN_EMAILSに無い）場合だけ、ここで拒否を記録する。
//
// Cloudflare Pages Functions のファイルベースのルーティングで /admin に割り当てられる。
// 管理画面のHTMLは静的ファイルとしては置いておらず（scripts/embed-admin-page.mjs）、常にこのFunction
// 経由で返す。静的ファイルとして置くと、`//admin` や `/%61dmin` のようにURLの書き方を変えるだけで、
// このFunctionを迂回して取得できてしまうため（timetablesの同名ファイルと同じ対策）。

import { ADMIN_SECURITY_HEADERS, readCookie } from "./api/_lib/admin";
import { ADMIN_PAGE_HTML } from "./api/_lib/admin-page.generated";
import { recordDenial, requestMeta, resolveAdminAccess } from "./api/_lib/admin-access";
import { SESSION, cookieName, isHttpsUrl } from "./api/_lib/cookie-names";
import type { Bindings } from "./api/_lib/types";

export const onRequest: PagesFunction<Bindings> = async (context) => {
  const { request, env } = context;
  const sessionId = readCookie(request.headers.get("Cookie"), cookieName(SESSION, isHttpsUrl(request.url)));
  const access = await resolveAdminAccess(env.DB, env.ADMIN_EMAILS, sessionId);

  if (access.kind === "not_admin") {
    await recordDenial(env.DB, "admin_denied", access.email, requestMeta(request));
  }

  return new Response(ADMIN_PAGE_HTML, {
    status: 200,
    headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
};
