// 管理画面のページ本体（/admin）の門番。
//
// 管理者でなければ（ログインしていない人も含めて）ページのHTMLを返さずにトップページへ飛ばす。
// 管理者は、トップページから普段どおりにログインしてから /admin を開けば入れる。
// ログインから時間が経っている管理者にはページを返し、画面側で再ログインを案内する
// （データを返すかどうかは /api/admin/* が改めて判定するので、ここを通っても一覧は見えない）。
//
// Cloudflare Pages Functions のファイルベースのルーティングで /admin に割り当てられる。
// 管理画面のHTMLは静的ファイルとしては置いておらず（scripts/embed-admin-page.mjs）、
// 管理者と確認できたときだけここから返す。静的ファイルとして置くと、`//admin` や `/%61dmin` の
// ようにURLの書き方を変えるだけで、この門番を通らずに取得できてしまうため。

import { ADMIN_SECURITY_HEADERS, readCookie } from "./api/_lib/admin";
import { ADMIN_PAGE_HTML } from "./api/_lib/admin-page.generated";
import { recordDenial, requestMeta, resolveAdminAccess } from "./api/_lib/admin-access";
import { SESSION, cookieName, isHttpsUrl } from "./api/_lib/cookie-names";
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
  const sessionId = readCookie(request.headers.get("Cookie"), cookieName(SESSION, isHttpsUrl(request.url)));
  const access = await resolveAdminAccess(env.DB, env.ADMIN_EMAILS, sessionId);

  if (access.kind === "anonymous") return redirectToTop(request);
  if (access.kind === "not_admin") {
    await recordDenial(env.DB, "admin_page_denied", access.user, requestMeta(request));
    return redirectToTop(request);
  }
  return new Response(ADMIN_PAGE_HTML, {
    status: 200,
    headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
};
