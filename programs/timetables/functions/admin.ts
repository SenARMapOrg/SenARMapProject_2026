// 管理画面のページ本体（/admin）の門番。
//
// 管理者でなければ（ログインしていない人も含めて）ページのHTMLを返さずにトップページへ飛ばす。
// 管理者は、トップページから普段どおりにログインしてから /admin を開けば入れる。
// ログインから時間が経っている管理者にはページを返し、画面側で再ログインを案内する
// （データを返すかどうかは /api/admin/* が改めて判定するので、ここを通っても一覧は見えない）。
//
// Cloudflare Pages Functions のファイルベースのルーティングで /admin に割り当てられる。
// context.next() で、ビルド済みの静的ファイル（dist/admin.html）の配信に処理を渡す。

import { readCookie } from "./api/_lib/admin";
import { recordDenial, requestMeta, resolveAdminAccess } from "./api/_lib/admin-access";
import { SESSION_COOKIE } from "./api/_lib/session";
import type { Bindings } from "./api/_lib/types";

function redirectToTop(request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL("/", request.url).toString(),
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export const onRequest: PagesFunction<Bindings> = async (context) => {
  const { request, env } = context;
  const sessionId = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  const access = await resolveAdminAccess(env.DB, env.ADMIN_EMAILS, sessionId);

  if (access.kind === "anonymous") return redirectToTop(request);
  if (access.kind === "not_admin") {
    await recordDenial(env.DB, "admin_page_denied", access.user, requestMeta(request));
    return redirectToTop(request);
  }
  return context.next();
};
