import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUER_CANDIDATES = ["https://accounts.google.com", "accounts.google.com"];

// jose の createRemoteJWKSet は内部でキャッシュするが、モジュールスコープに置くことで
// Worker のisolateが生きている間はリクエストをまたいで鍵セットを使い回せる。
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function exchangeCodeForIdToken(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    // Googleのエラー応答本体(error/error_description)には invalid_client(client_secret違い)・
    // redirect_uri_mismatch・invalid_grant(コード再利用/期限切れ)など原因の手がかりが入っているため、
    // デバッグ用に必ずログへ残す(呼び出し元でconsole.errorされる想定)。
    const detail = await res.text().catch(() => "");
    throw new Error(`Googleトークン交換に失敗しました (HTTP ${res.status}): ${detail}`);
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) {
    throw new Error("Googleのレスポンスに id_token が含まれていません");
  }
  return data.id_token;
}

/**
 * IDトークンの署名・issuer・audienceを検証し、ペイロードを返す。
 * 呼び出し側は必ず email_verified もチェックすること（未検証のメールアドレスをADMIN_EMAILSと
 * 比較しても、本人のものである保証にならない）。
 */
export async function verifyIdToken(idToken: string, clientId: string): Promise<GoogleIdTokenPayload> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: ISSUER_CANDIDATES,
    audience: clientId,
  });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("IDトークンの内容が不正です");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: payload.email_verified === true,
    hd: typeof payload.hd === "string" ? payload.hd : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

// --- PKCE ---

export function generateCodeVerifier(): string {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr);
}

export async function codeChallengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
