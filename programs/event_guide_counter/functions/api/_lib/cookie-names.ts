// Cookie の名前。本番（https）では __Host- を付ける。
//
// __Host- 付きの Cookie は、ブラウザが「Secure 付き・Path=/・Domain 指定なし」でしか保存しないため、
// iku-navi.net の別のサブドメイン（本体サイト・APIなど）から同じ名前の Cookie を上書きされない
// （Cookie tossing。ログイン中のセッションや OAuth の state をすり替える攻撃）。
// ローカル開発（http://localhost）では Secure な Cookie を保存できないので付けない。

export const SESSION = "session";
export const OAUTH_STATE = "oauth_state";
export const OAUTH_VERIFIER = "oauth_verifier";
export const OAUTH_NEXT = "oauth_next";

export function cookieName(base: string, https: boolean): string {
  return https ? `__Host-${base}` : base;
}

export function isHttpsUrl(url: string): boolean {
  return new URL(url).protocol === "https:";
}
