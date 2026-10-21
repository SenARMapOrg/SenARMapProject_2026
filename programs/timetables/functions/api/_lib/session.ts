import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

import * as names from "./cookie-names";
import { findValidSession } from "./db";
import type { AppEnv } from "./types";

/**
 * ローカル開発(http://localhost)ではSecure Cookieがブラウザに保存されないため、
 * リクエストのプロトコルを見てSecureフラグを切り替える。本番(Cloudflare Pages)は常にhttpsなので影響しない。
 */
function isHttps(c: Context): boolean {
  return names.isHttpsUrl(c.req.url);
}

/** この環境での Cookie 名（本番の https では __Host- 付き。cookie-names.ts 参照） */
function nameOf(c: Context, base: string): string {
  return names.cookieName(base, isHttps(c));
}

/** Cookie に入っているセッショントークン（無ければ undefined） */
export function readSessionToken(c: Context): string | undefined {
  return getCookie(c, nameOf(c, names.SESSION));
}

export function baseCookieOptions(c: Context): CookieOptions {
  return {
    httpOnly: true,
    secure: isHttps(c),
    // Google からのリダイレクトで戻ってくる際にトップレベルGETナビゲーションとして
    // Cookieが送られる必要があるため Strict ではなく Lax を使う。
    sameSite: "Lax",
    path: "/",
  };
}

/** 削除用の Set-Cookie も、__Host- 付きの Cookie は Secure・Path=/ が無いとブラウザに無視される */
function deleteCookieOptions(c: Context): CookieOptions {
  return { path: "/", secure: isHttps(c) };
}

export function setSessionCookie(c: Context, sessionToken: string, expiresAt: Date): void {
  setCookie(c, nameOf(c, names.SESSION), sessionToken, { ...baseCookieOptions(c), expires: expiresAt });
  // __Host- を付ける前の名前で残っている古い Cookie を消す（もう使われないが、ブラウザに残らないように）
  if (isHttps(c) && getCookie(c, names.SESSION) !== undefined) {
    deleteCookie(c, names.SESSION, { path: "/" });
  }
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, nameOf(c, names.SESSION), deleteCookieOptions(c));
}

/**
 * nextPath はログイン後の戻り先。呼び出し側で sanitizeNextPath() を通した値だけを渡すこと
 * （ここでは検証しない）。戻り先が無い場合は前回の値が残らないよう削除する。
 */
export function setOauthCookies(c: Context, state: string, codeVerifier: string, nextPath: string | null = null): void {
  // stateとPKCE検証用の値は認可フロー中(数分)だけ必要なので短い有効期限にする
  const opts = { ...baseCookieOptions(c), maxAge: 10 * 60 };
  setCookie(c, nameOf(c, names.OAUTH_STATE), state, opts);
  setCookie(c, nameOf(c, names.OAUTH_VERIFIER), codeVerifier, opts);
  if (nextPath) {
    setCookie(c, nameOf(c, names.OAUTH_NEXT), nextPath, opts);
  } else {
    deleteCookie(c, nameOf(c, names.OAUTH_NEXT), deleteCookieOptions(c));
  }
}

export function readAndClearOauthCookies(c: Context): { state?: string; codeVerifier?: string; nextPath?: string } {
  const state = getCookie(c, nameOf(c, names.OAUTH_STATE));
  const codeVerifier = getCookie(c, nameOf(c, names.OAUTH_VERIFIER));
  const nextPath = getCookie(c, nameOf(c, names.OAUTH_NEXT));
  for (const base of [names.OAUTH_STATE, names.OAUTH_VERIFIER, names.OAUTH_NEXT]) {
    deleteCookie(c, nameOf(c, base), deleteCookieOptions(c));
  }
  return { state, codeVerifier, nextPath };
}

/**
 * ログイン必須のAPIに付けるミドルウェア。有効なセッションが無ければ401を返す。
 * 状態を変更するリクエスト(GET以外)は、Cookie(SameSite=Lax)だけに頼らない多層防御として
 * Originヘッダが自サイトと一致するかも確認する(簡易CSRF対策)。
 */
export function requireAuth() {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("Origin");
      if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: "不正なリクエスト元です" }, 403);
      }
    }

    const sessionToken = readSessionToken(c);
    if (!sessionToken) {
      return c.json({ error: "ログインが必要です" }, 401);
    }
    const user = await findValidSession(c.env.DB, sessionToken);
    if (!user) {
      clearSessionCookie(c);
      return c.json({ error: "ログインが必要です" }, 401);
    }
    c.set("user", user);
    await next();
  };
}
