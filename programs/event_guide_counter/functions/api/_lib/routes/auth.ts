import { Hono } from "hono";

import { isAdminEmail, parseAdminEmails, sanitizeNextPath } from "../admin";
import { createSession, deleteSession } from "../db";
import {
  buildAuthorizeUrl, codeChallengeFromVerifier, exchangeCodeForIdToken,
  generateCodeVerifier, verifyIdToken,
} from "../google";
import {
  clearSessionCookie, readAndClearOauthCookies, readSessionToken, requireAuth,
  setOauthCookies, setSessionCookie,
} from "../session";
import type { AppEnv } from "../types";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/login", async (c) => {
  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await codeChallengeFromVerifier(codeVerifier);
  // ?next= は許可リストにある自サイト内のパス(/admin)だけ受け付ける。それ以外は無視してトップに戻す
  setOauthCookies(c, state, codeVerifier, sanitizeNextPath(c.req.query("next")));

  const url = buildAuthorizeUrl({
    clientId: c.env.GOOGLE_CLIENT_ID,
    redirectUri: c.env.OAUTH_REDIRECT_URI,
    state,
    codeChallenge,
  });
  return c.redirect(url);
});

authRoutes.get("/callback", async (c) => {
  const query = c.req.query();
  const { state: expectedState, codeVerifier, nextPath } = readAndClearOauthCookies(c);

  if (query.error) {
    return c.redirect(`/admin?login_error=${encodeURIComponent(query.error)}`);
  }
  if (!query.code || !query.state || !expectedState || !codeVerifier || query.state !== expectedState) {
    // Cookieが読めていない場合、ログイン開始時と違うオリジン(例: *.pages.devで開始してカスタム
    // ドメインにコールバックされた等)でCookieが分断されている可能性が高い。
    console.error("oauth callback: invalid_state", {
      hasCode: !!query.code, hasQueryState: !!query.state,
      hasExpectedState: !!expectedState, hasCodeVerifier: !!codeVerifier,
      stateMatches: query.state === expectedState,
    });
    return c.redirect("/admin?login_error=invalid_state");
  }

  let idToken: string;
  try {
    idToken = await exchangeCodeForIdToken({
      code: query.code,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      redirectUri: c.env.OAUTH_REDIRECT_URI,
      codeVerifier,
    });
  } catch (err) {
    console.error("oauth callback: token exchange failed", err);
    return c.redirect("/admin?login_error=token_exchange_failed");
  }

  let payload;
  try {
    payload = await verifyIdToken(idToken, c.env.GOOGLE_CLIENT_ID);
  } catch (err) {
    console.error("oauth callback: id token verification failed", err);
    return c.redirect("/admin?login_error=invalid_token");
  }

  const email = payload.email.toLowerCase();
  // ここが本当のアクセス制限の実体。このアプリには一般ユーザーのログインが無いので、
  // ADMIN_EMAILSに無いメールアドレスにはそもそもセッションを発行しない
  // （/admin側のresolveAdminAccessでの再チェックは、ログイン後にリストから外れた場合の保険）。
  if (!payload.email_verified || !isAdminEmail(email, parseAdminEmails(c.env.ADMIN_EMAILS))) {
    return c.redirect("/admin?login_error=not_admin");
  }

  const session = await createSession(c.env.DB, email);
  setSessionCookie(c, session.token, new Date(session.expiresAt));

  // Cookie に入っている値も改ざんされうるので、戻る直前にもう一度許可リストで確かめる
  return c.redirect(sanitizeNextPath(nextPath) ?? "/admin");
});

authRoutes.post("/logout", requireAuth(), async (c) => {
  const sessionToken = readSessionToken(c);
  if (sessionToken) await deleteSession(c.env.DB, sessionToken);
  clearSessionCookie(c);
  return c.body(null, 204);
});
