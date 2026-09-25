import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { sanitizeNextPath } from "../admin";
import {
  createSession, deleteSession, resolvePendingInvitesForEmail, upsertUser,
} from "../db";
import {
  buildAuthorizeUrl, codeChallengeFromVerifier, exchangeCodeForIdToken,
  generateCodeVerifier, verifyIdToken,
} from "../google";
import {
  clearSessionCookie, readAndClearOauthCookies, requireAuth, SESSION_COOKIE,
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
    hd: c.env.ALLOWED_EMAIL_DOMAIN,
  });
  return c.redirect(url);
});

authRoutes.get("/callback", async (c) => {
  const query = c.req.query();
  const { state: expectedState, codeVerifier, nextPath } = readAndClearOauthCookies(c);

  if (query.error) {
    return c.redirect(`/?login_error=${encodeURIComponent(query.error)}`);
  }
  if (!query.code || !query.state || !expectedState || !codeVerifier || query.state !== expectedState) {
    // Cookieが読めていない場合、ログイン開始時と違うオリジン(例: *.pages.devで開始してカスタム
    // ドメインにコールバックされた等)でCookieが分断されている可能性が高い。
    console.error("oauth callback: invalid_state", {
      hasCode: !!query.code, hasQueryState: !!query.state,
      hasExpectedState: !!expectedState, hasCodeVerifier: !!codeVerifier,
      stateMatches: query.state === expectedState,
    });
    return c.redirect("/?login_error=invalid_state");
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
    return c.redirect("/?login_error=token_exchange_failed");
  }

  let payload;
  try {
    payload = await verifyIdToken(idToken, c.env.GOOGLE_CLIENT_ID);
  } catch (err) {
    console.error("oauth callback: id token verification failed", err);
    return c.redirect("/?login_error=invalid_token");
  }

  // ここがドメイン制限の実体。リクエスト時の hd パラメータ(login側)はUXの絞り込みに過ぎず、
  // 署名付きIDトークンのhdクレームをサーバー側で検証して初めて「大学アカウントである」と保証できる。
  const allowedDomain = c.env.ALLOWED_EMAIL_DOMAIN.toLowerCase();
  if (!payload.email_verified || payload.hd?.toLowerCase() !== allowedDomain) {
    return c.redirect("/?login_error=domain_not_allowed");
  }

  const email = payload.email.toLowerCase();
  const displayName = payload.name?.trim() || email.split("@")[0];
  const user = await upsertUser(c.env.DB, payload.sub, email, displayName);
  await resolvePendingInvitesForEmail(c.env.DB, email, user.id);

  const session = await createSession(c.env.DB, user.id);
  setSessionCookie(c, session.id, new Date(session.expires_at));

  // Cookie に入っている値も改ざんされうるので、戻る直前にもう一度許可リストで確かめる
  return c.redirect(sanitizeNextPath(nextPath) ?? "/");
});

authRoutes.post("/logout", requireAuth(), async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await deleteSession(c.env.DB, sessionId);
  clearSessionCookie(c);
  return c.body(null, 204);
});
